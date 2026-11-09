"""Split + M0 lossless normalization + project metadata files."""
from __future__ import annotations

import datetime
import re
import unicodedata
from pathlib import Path

from . import SCHEMA_PROJECT
from .detect import (
    EN_EP_RE,
    SCENE_RE,
    cn_num_to_int,
    detect_tag,
    dialogue_parts,
    is_atom_line,
    is_cast_line,
    is_scene_line,
    is_structure_line,
    is_structural_line,
    raw_strip,
    split_speaker,
    text_language,
)
from .errors import FatalError
from .util import (
    cjk_count,
    load_json_safe,
    now_iso,
    sha256_text,
    write_json,
    write_text,
)

WORD_RE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]+(?:['’\-][A-Za-z]+)*(?![A-Za-z0-9])")
CAST_NAMES_RE = re.compile(r"^(?:人物|出场人物|角色)\s*[：:]\s*(.*)$")
PROTAG_ALIAS_LANGS = {"cn", "en"}


# ---------------------------------------------------------------------------
# M0 normalization (docs/03 §2.4; lead M1 contract)
# ---------------------------------------------------------------------------
def normalize_archive_line(line: str) -> str:
    """Trim line edges; for dialogue lines NFKC-normalize the prefix only."""
    s = raw_strip(line)
    if not s:
        return ""
    pair = split_speaker(s)
    if pair and detect_tag(pair[0]):
        # first colon outside parens: normalize everything before it
        depth = 0
        for i, ch in enumerate(s):
            if ch in "（(":
                depth += 1
            elif ch in "）)":
                depth = max(0, depth - 1)
            elif ch in "：:" and depth == 0:
                prefix = unicodedata.normalize("NFKC", s[:i])
                return prefix + s[i:]
    return s


def canon_paragraphs(texts: list[str]) -> str:
    return "\n".join(t for t in texts if t.strip())


# ---------------------------------------------------------------------------
# build episodes
# ---------------------------------------------------------------------------
def build_episodes(paragraphs: list[dict], detection: dict) -> list[dict]:
    raw = [p.get("text", "") or "" for p in paragraphs]
    candidates = sorted(detection["candidates"], key=lambda c: c["start"])
    episodes: list[dict] = []
    for k, c in enumerate(candidates):
        start = c["start"]
        end = candidates[k + 1]["start"] if k + 1 < len(candidates) else len(raw)
        src_lines = raw[start:end]
        src_nonempty = [raw_strip(t) for t in src_lines if raw_strip(t)]
        archive: list[str] = []
        for text in src_lines:
            line = normalize_archive_line(text)
            if line:
                archive.append(line)
        # ---- G2: paragraph count / order / text lossless ----
        if len(src_nonempty) != len(archive):
            raise FatalError(
                f"G2 无损校验失败：EP{c['ep']} 段落数不一致 "
                f"src={len(src_nonempty)} archive={len(archive)}"
            )
        for a, b in zip(src_nonempty, archive):
            if _canon(a) != _canon(b):
                raise FatalError(
                    f"G2 无损校验失败：EP{c['ep']} 文本差异 "
                    f"src={a[:40]!r} archive={b[:40]!r}"
                )
        episodes.append({
            "ep": c["ep"],
            "title": c["title"],
            "title_en": c.get("title_en", "") or "",
            "start": start,
            "end": end,
            "lines": archive,
        })
    return episodes


def _canon(s: str) -> str:
    from .util import canon
    return canon(s)


# ---------------------------------------------------------------------------
# stats
# ---------------------------------------------------------------------------
def _dialogue_records(lines: list[str]) -> list[dict]:
    out = []
    for i, line in enumerate(lines):
        parts = dialogue_parts(line)
        if not parts:
            continue
        _prefix, text, tag = parts
        out.append({"line": i, "text": text, "tag": tag, "lang": text_language(text)})
    return out


def episode_stats(lines: list[str]) -> dict:
    text_join = "\n".join(lines)
    dialogue = _dialogue_records(lines)
    lang_mix = {"cn": 0, "en": 0, "mixed": 0}
    for rec in dialogue:
        text = rec["text"]
        has_cjk = cjk_count(text) > 0
        has_latin = bool(re.search(r"[A-Za-z]", text))
        if has_cjk and has_latin:
            lang_mix["mixed"] += 1
        elif has_cjk:
            lang_mix["cn"] += 1
        elif has_latin:
            lang_mix["en"] += 1
    latin_words = 0
    for rec in dialogue:
        if rec["lang"] == "en":
            latin_words += len(WORD_RE.findall(rec["text"]))
    counts: dict[str, int] = {}
    for line in lines:
        m = CAST_NAMES_RE.match(line)
        if m:
            for name in re.split(r"[\s、，,/／]+", m.group(1)):
                name = name.strip()
                if name:
                    counts[name] = counts.get(name, 0) + 2
        parts = dialogue_parts(line)
        if parts:
            speaker = re.split(r"[（(]", parts[0], 1)[0].strip()
            if speaker:
                counts[speaker] = counts.get(speaker, 0) + 1
    top = [n for n, _c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:5]]
    stats = {
        "lines": len(lines),
        "cjk": cjk_count(text_join),
        "atoms": sum(1 for line in lines if is_atom_line(line)),
        "scenes": sum(1 for line in lines if is_scene_line(line)),
        "dialogue_lines": len(dialogue),
        "latin_words": latin_words,
        "lang_mix": lang_mix,
        "top_characters": top,
        "unknown_lines": sum(1 for line in lines if _is_unknown(line)),
    }
    return stats


def _is_unknown(line: str) -> bool:
    from .detect import classify_line
    return classify_line(line) == "other"


def anomalies_for(stats: dict, ep: int, total_eps: int) -> list[str]:
    out: list[str] = []
    if stats["scenes"] == 0:
        out.append("NO_SCENE")
    if stats["dialogue_lines"] == 0:
        out.append("NO_DIALOGUE")
    if stats["atoms"] == 0:
        out.append("NO_ATOM")
    if stats["cjk"] < 300:
        out.append("SHORT_CJK")
    if stats["lines"] and stats["unknown_lines"] / stats["lines"] > 0.20:
        out.append("UNKNOWN_LINES")
    if total_eps == 1:
        out.append("SINGLE_EPISODE")
    return out


# ---------------------------------------------------------------------------
# metadata writers
# ---------------------------------------------------------------------------
def write_paragraph_files(paths: dict, paragraphs: list[dict]) -> None:
    paragraphs_txt = "\n".join(p.get("text", "") for p in paragraphs)
    write_text(paths["paragraphs_txt"], paragraphs_txt + ("\n" if paragraphs_txt else ""))
    lines = []
    for p in paragraphs:
        lines.append({
            "file": p.get("file", ""),
            "idx": p.get("idx", 0),
            "text": p.get("text", ""),
            "style": p.get("style", ""),
            "heading": bool(p.get("heading", False)),
        })
    write_text(paths["paragraphs_jsonl"],
               "\n".join(__import__("json").dumps(obj, ensure_ascii=False) for obj in lines) + "\n")


def write_format_files(paths: dict, fmt: dict, source_sha: str) -> None:
    data = dict(fmt)
    data["generated_at"] = now_iso()
    data["source_sha256"] = source_sha
    write_json(paths["format_json"], data)
    rules = [
        "# 剧本格式规则（由 lianben2 机器识别生成，0 token；可人工修订 format.json）",
        "",
        "## 行类型与锁行（命中 locked_line_patterns 的行成品必须逐字原样保留）",
        "",
        f"- 集标题：`第N集《标题》`（锁行），header_pattern=`{fmt['episode']['header_pattern']}`",
    ]
    if fmt["episode"].get("en_pattern"):
        rules.append("- 英文集标题：`Episode N: \"...\"`（锁行，紧跟中文标题下一行）")
    rules += [
        "- 场次行：`N-N 时间 内外 地点`（锁行）",
        "- 人物/出场行：`人物：姓名 姓名`（锁行）",
        "- 结构块：`【…】`（锁行）",
        "- 叙事原子：`△ 描述`（非台词正文，成品扩写挂载点）",
        "- 台词行：`说话人（对白/VO/OS）：正文`；英文行 `SPEAKER (DIALOGUE/VO/OS): text`",
        "",
        "## 台词规则",
        "",
        "- 中英台词相邻成对，顺序锁定；标签严格沿用原文",
        "- 英文台词正文使用半角 ASCII 标点",
        "- 台词行 prefix 在 M0 阶段做 NFKC 全角→半角归一，正文逐字不变",
        "",
    ]
    write_text(paths["format_rules"], "\n".join(rules))


def write_ep_index(paths: dict, episodes: list[dict], paragraphs: list[dict],
                   source_sha: str, source_name: str) -> dict:
    total_eps = len(episodes)
    eps_meta = []
    for i, ep in enumerate(episodes):
        stats = episode_stats(ep["lines"])
        ep["stats"] = stats
        anomalies = anomalies_for(stats, ep["ep"], total_eps)
        text = "\n".join(ep["lines"]) + "\n"
        eps_meta.append({
            "ep": ep["ep"],
            "title": ep["title"],
            "title_en": ep["title_en"],
            "para_start": ep["start"],
            "para_end": ep["end"],
            "lines": stats["lines"],
            "cjk": stats["cjk"],
            "atoms": stats["atoms"],
            "scenes": stats["scenes"],
            "dialogue_lines": stats["dialogue_lines"],
            "latin_words": stats["latin_words"],
            "lang_mix": stats["lang_mix"],
            "top_characters": stats["top_characters"],
            "anomalies": anomalies,
            "sha256": sha256_text(text),
        })
    series_stats = {
        "episodes": total_eps,
        "paragraphs": len(paragraphs),
        "cjk": sum(e["cjk"] for e in eps_meta),
        "atoms": sum(e["atoms"] for e in eps_meta),
        "dialogue_lines": sum(e["dialogue_lines"] for e in eps_meta),
        "language_ratio": _language_ratio(eps_meta),
    }
    data = {
        "docx": f"剧本输入/{source_name}",
        "source_sha256": source_sha,
        "total_paragraphs": len(paragraphs),
        "episodes": eps_meta,
        "statistics": series_stats,
        "generated_at": now_iso(),
    }
    write_json(paths["ep_index"], data)
    return data


def _language_ratio(eps_meta: list[dict]) -> dict:
    cn = sum(e["lang_mix"]["cn"] for e in eps_meta)
    en = sum(e["lang_mix"]["en"] for e in eps_meta)
    mixed = sum(e["lang_mix"]["mixed"] for e in eps_meta)
    total = cn + en + mixed
    return {
        "cn": round(cn / total, 3) if total else 0.0,
        "en": round(en / total, 3) if total else 0.0,
        "mixed": round(mixed / total, 3) if total else 0.0,
    }


def write_facts_and_handoff(paths: dict, episodes: list[dict], paragraphs: list[dict]) -> None:
    first_start = episodes[0]["start"] if episodes else 0
    prologue = [raw_strip(p.get("text", "")) for p in paragraphs[:first_start]]
    prologue = [t for t in prologue if t]
    facts = [
        "# 全局锁定事实（原文档前置信息）",
        "",
        "> 仅用于跨集一致性核对：人物名、术语、道具、时间线以此为准；不得据此新增剧情事实，不得写入正文引用。",
        "",
    ] + prologue
    write_text(paths["facts_lock"], "\n".join(facts) + "\n")

    handoff = {}
    for k, ep in enumerate(episodes):
        prev_tail: list[str] = []
        next_head: list[str] = []
        if k > 0:
            prev = [ln for ln in episodes[k - 1]["lines"] if ln.strip()]
            prev_tail = prev[-6:]
        if k + 1 < len(episodes):
            nxt = [ln for ln in episodes[k + 1]["lines"] if ln.strip()]
            next_head = nxt[:8]
        handoff[str(ep["ep"])] = {"prev_tail": prev_tail, "next_head": next_head}
    write_json(paths["handoff"], handoff)


def write_progress(paths: dict, episodes: list[dict], force_reset: bool = False) -> dict:
    existing = load_json_safe(paths["progress"], None) or {}
    shas = [sha256_text("\n".join(ep["lines"]) + "\n") for ep in episodes]
    fingerprint = sha256_text("".join(shas))
    same = (not force_reset and isinstance(existing, dict)
            and existing.get("fingerprint") == fingerprint)
    if same:
        progress = existing
        progress.setdefault("episodes", {})
    else:
        progress = {"episodes": {}}
    progress["schema"] = "lianben/progress/1"
    progress["fingerprint"] = fingerprint
    progress["updated"] = now_iso()
    for ep in episodes:
        key = str(ep["ep"])
        cur = progress["episodes"].get(key, {}) if isinstance(progress.get("episodes"), dict) else {}
        cur.setdefault("status", "pending")
        cur.setdefault("attempts", 0)
        cur.setdefault("reasons", [])
        cur["title"] = ep["title"]
        progress["episodes"][key] = cur
    # drop stale keys
    valid = {str(ep["ep"]) for ep in episodes}
    progress["episodes"] = {k: v for k, v in progress["episodes"].items() if k in valid}
    write_json(paths["progress"], progress)
    return progress


def write_source_episodes(paths: dict, episodes: list[dict], emitter=None) -> None:
    total = len(episodes)
    for done, ep in enumerate(episodes, start=1):
        write_text(paths["source_dir"] / f"ep{ep['ep']:02d}.md",
                   "\n".join(ep["lines"]) + "\n")
        if emitter is not None:
            emitter.episode(ep["ep"], done, total)


def write_engine_meta(paths: dict, fmt: dict, detection: dict, run_id: str,
                      source_sha: str, config_hash: str) -> None:
    from . import VERSION
    import_data = {
        "schema": "lianben/import/1",
        "run_id": run_id,
        "mode": detection["mode"],
        "confidence": detection["confidence"],
        "score_breakdown": detection["components"],
        "needs_confirm": detection["needs_confirm"],
        "reject_reason": (detection["reasons"] or [None])[0],
        "files": [],
        "g0": {
            "extractable": True,
            "episodes_found": detection["episode_count"],
            "unique": not detection["reasons"],
            "ascending": True,
        },
        "g2": {"status": "PASS", "failed_eps": []},
        "format_provenance": fmt.get("provenance", "machine"),
    }
    write_json(paths["import_json"], import_data)
    write_json(paths["steps_json"], {
        "schema": "lianben/steps/1",
        "source_sha256": source_sha,
        "config_hash": config_hash,
        "steps": {
            "import": {"step_key": "import", "status": "ok"},
            "extract": {"step_key": "extract", "status": "ok"},
            "profile": {"step_key": "profile", "status": "ok"},
            "split": {"step_key": "split", "status": "ok"},
            "checks": {"step_key": "checks", "status": "ok"},
            "report": {"step_key": "report", "status": "ok"},
        },
    })
