"""Five deterministic checks (0 LLM). Thresholds ported from reference tools.

Source of truth for thresholds:
- spoken_words: preflight_spoken_check.py:10-11, :34-48
- punctuation: preflight_punctuation_check.py:25-47
- pacing: preflight_atom_check.py:26-34
- protagonist: preflight_protagonist_check.py:24-30, protagonist_profile.py:44-120
- culture: preflight_culture_check.py:21-51, :162-165
"""
from __future__ import annotations

import re
from pathlib import Path

from . import SCHEMA_CHECK, VERSION
from .detect import (
    dialogue_parts,
    is_atom_line,
    is_cast_line,
    is_scene_line,
    is_structural_line,
    raw_strip,
    split_speaker,
    text_language,
)
from .lexicon import UNIQUE_TERMS, match_terms
from .util import cjk_count, latin_letter_count, load_json_safe, now_iso

# ---------------- spoken_words thresholds (preflight_spoken_check.py:10-11)
MIN_WORDS = 100
MAX_WORDS = 350
WORD_RE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]+(?:['’\-][A-Za-z]+)*(?![A-Za-z0-9])")
META_PREFIX_RE = re.compile(r"^(?:场景|地点|时间|备注|说明|注)\s*[：:]")
NEAR_BAND = 10

# ---------------- punctuation (preflight_punctuation_check.py:25-47)
ZH_PUNCT = "，。！？；：、（）【】《》「」『』～"
SUGGEST = {
    "，": "改为半角逗号「,」", "。": "改为半角句号「.」", "！": "改为半角感叹号「!」",
    "？": "改为半角问号「?」", "；": "改为半角分号「;」", "：": "改为半角冒号「:」",
    "、": "改为半角逗号「,」或删除", "（": "改为半角左括号「(」", "）": "改为半角右括号「)」",
    "【": "改为半角左方括号「[」", "】": "改为半角右方括号「]」",
    "《": "改为引号或斜体书名", "》": "改为引号或斜体书名",
    "「": "改为英文引号", "」": "改为英文引号", "『": "改为英文引号", "』": "改为英文引号",
    "～": "改为半角波浪号「~」",
}
SPACE_BEFORE_PUNCT_RE = re.compile(r"\s+([,.;:!?])")
MULTI_SPACE_RE = re.compile(r" {2,}")

# ---------------- pacing (preflight_atom_check.py:26-34)
MAX_ATOM_RUN = 4
MAX_ATOMS_PER_SPOKEN = 3.0
DUP_SIMILARITY = 0.5
MAX_DUP_PAIRS = 1
MAX_SPOKEN_RUN = 8
MIN_ATOMS_PER_SPOKEN = 0.5
SPOKEN_FLOOR = 10

# ---------------- protagonist (preflight_protagonist_check.py:24-30)
DEFAULT_COVERAGE = {
    "min_scene_ratio": 0.40,
    "min_dialogue_ratio": 0.20,
    "borderline_scene_ratio": 0.55,
    "borderline_dialogue_ratio": 0.35,
    "borderline_coverage_score": 0.45,
}


# ===========================================================================
# helpers
# ===========================================================================
def _envelope(ctx: dict, check: str, blocking: bool, status: str, summary: dict,
              results: list[dict], legacy: str) -> dict:
    return {
        "schema": SCHEMA_CHECK,
        "check": check,
        "version": "1.0",
        "run_id": ctx.get("run_id", ""),
        "generated_at": ctx.get("generated_at") or now_iso(),
        "check_basis": "standardized",
        "source_sha256": ctx.get("source_sha256", ""),
        "config_hash": ctx.get("config_hash", ""),
        "status": status,
        "blocking": blocking,
        "summary": summary,
        "results": results,
        "compat": {"legacy_file": legacy},
    }


def _speaker_name(prefix: str) -> str:
    return re.split(r"[（(]", prefix, 1)[0].strip()


def _has_name(text: str, names: list[str]) -> bool:
    for name in names or []:
        if not name:
            continue
        if re.search(r"[A-Za-z]", name) and cjk_count(name) == 0:
            if re.search(rf"(?<![A-Za-z]){re.escape(name)}(?![A-Za-z])", text, re.I):
                return True
        elif name in text:
            return True
    return False


def _cast_names(line: str) -> list[str]:
    m = re.match(r"^(?:人物|出场人物|角色)\s*[：:]\s*(.*)$", raw_strip(line))
    if not m:
        return []
    return [x.strip() for x in re.split(r"[\s、，,/／]+", m.group(1)) if x.strip()]


def _bigrams(text: str) -> set[str]:
    s = text.lower()
    out: set[str] = set()
    for i in range(len(s) - 1):
        a, b = s[i], s[i + 1]
        if re.match(r"[\u4e00-\u9fffa-z0-9]", a) and re.match(r"[\u4e00-\u9fffa-z0-9]", b):
            out.add(a + b)
    return out


def _jaccard(a: str, b: str) -> float:
    ga, gb = _bigrams(a), _bigrams(b)
    if not ga or not gb:
        return 0.0
    return len(ga & gb) / len(ga | gb)


# ===========================================================================
# 1) spoken_words
# ===========================================================================
def strip_parentheticals(text: str) -> tuple[str, int]:
    out: list[str] = []
    depth = 0
    removed = 0
    for ch in text:
        if ch in "（(":
            depth += 1
            removed += 1
            continue
        if ch in "）)":
            if depth > 0:
                depth -= 1
                removed += 1
                continue
        if depth > 0:
            removed += 1
            continue
        out.append(ch)
    return "".join(out), removed


def _classify_language(text: str) -> str | None:
    cjk = cjk_count(text)
    latin = latin_letter_count(text)
    if cjk and not latin:
        return "cn"
    if latin and not cjk:
        return "en"
    if cjk and latin:
        return "cn" if cjk * 2 >= latin else "en"
    return None


def check_spoken_words(ctx: dict) -> dict:
    check_cfg = (ctx.get("check_profile") or {}).get("spoken_words") or {}
    min_words = int(check_cfg.get("min", MIN_WORDS))
    max_words = int(check_cfg.get("max", MAX_WORDS))
    results: list[dict] = []
    failed: list[int] = []
    near: list[int] = []
    pass_n = below = above = 0
    for ep in ctx["episodes"]:
        count = 0
        spoken_lines = 0
        en_lines = 0
        cn_lines = 0
        mixed_lines = 0
        paren_removed = 0
        by_tag = {"对白": 0, "VO": 0, "OS": 0, "other": 0}
        for line in ep["lines"]:
            parts = dialogue_parts(line)
            if not parts:
                continue
            prefix, text, tag = parts
            spoken_lines += 1
            stripped, removed = strip_parentheticals(text)
            paren_removed += removed
            lang = _classify_language(stripped)
            if lang == "cn":
                cn_lines += 1
                continue
            if lang != "en":
                continue
            has_cjk = cjk_count(stripped) > 0
            has_latin = bool(re.search(r"[A-Za-z]", stripped))
            if has_cjk and has_latin:
                mixed_lines += 1
            words = len(WORD_RE.findall(stripped))
            count += words
            en_lines += 1
            key = tag if tag in by_tag else "other"
            by_tag[key] += words
        if min_words <= count <= max_words:
            status = "PASS"
            reason = "within_range"
            pass_n += 1
        elif count < min_words:
            status = "FAIL_BELOW"
            reason = "below_minimum"
            below += 1
            failed.append(ep["ep"])
        else:
            status = "FAIL_ABOVE"
            reason = "above_maximum"
            above += 1
            failed.append(ep["ep"])
        nb = (min_words <= count < min_words + NEAR_BAND) or (
            max_words - NEAR_BAND < count <= max_words)
        if nb:
            near.append(ep["ep"])
        results.append({
            "ep": ep["ep"],
            "count": count,
            "min": min_words,
            "max": max_words,
            "status": status,
            "reason": reason,
            "by_tag": by_tag,
            "spoken_lines": spoken_lines,
            "english_spoken_lines": en_lines,
            "cn_spoken_lines": cn_lines,
            "mixed_lines": mixed_lines,
            "parenthetical_removed": paren_removed,
            "near_boundary": bool(nb),
        })
    status = "RISK" if failed else "OK"
    summary = {
        "status": status,
        "pass": pass_n,
        "fail_below": below,
        "fail_above": above,
        "failed_eps": failed,
        "near_boundary_eps": near,
        "min": min_words,
        "max": max_words,
    }
    out = _envelope(ctx, "spoken_words", False, status, summary, results,
                    "work/preflight/spoken_words.json")
    out["unit_definition"] = (
        "只统计英文有声台词（对白/VO/OS/DIALOGUE/DIALOG）正文的英文单词；"
        "中文台词与锁行/△ 不计；连字符与撇号=1 词、全大写缩写=1 词、纯数字不计、"
        "a.m.=2 词；成对括号表演提示不计；重复演出按发声次数累计。"
    )
    out["risky_eps"] = failed
    return out


# ===========================================================================
# 2) punctuation
# ===========================================================================
def _separator_char(line: str) -> str | None:
    depth = 0
    for ch in line:
        if ch in "（(":
            depth += 1
        elif ch in "）)":
            depth = max(0, depth - 1)
        elif ch in "：:" and depth == 0:
            return ch
    return None


def check_punctuation(ctx: dict) -> dict:
    rows: dict[tuple, dict] = {}

    def add(ep: int, paragraph: int, line_index: int, line: str, ch: str,
            kind: str, severity: str, count: int = 1, suggestion: str = "") -> None:
        key = (ep, paragraph, ch, kind)
        if key in rows:
            rows[key]["count"] += count
            return
        rows[key] = {
            "ep": ep,
            "paragraph": paragraph,
            "line_index": line_index,
            "kind": kind,
            "char": ch,
            "severity": severity,
            "count": count,
            "context": line[:140],
            "suggestion": suggestion or SUGGEST.get(ch, "改为英文半角标点"),
        }

    for ep in ctx["episodes"]:
        for i, line in enumerate(ep["lines"]):
            parts = dialogue_parts(line)
            if not parts:
                continue
            prefix, text, _tag = parts
            if text_language(text) != "en":
                continue
            paragraph = ep["start"] + i + 1
            if _separator_char(line) == "：":
                add(ep["ep"], paragraph, i, line, "：", "separator", "must_fix",
                    suggestion="英文台词分隔符改为半角冒号「:」")
            if "\u3000" in text:
                add(ep["ep"], paragraph, i, line, "\u3000", "dialogue_text", "must_fix",
                    suggestion="全角空格改为半角空格")
            for ch in text:
                if ch in ZH_PUNCT:
                    add(ep["ep"], paragraph, i, line, ch, "dialogue_text", "must_fix")
            if "……" in text:
                add(ep["ep"], paragraph, i, line, "……", "dialogue_text", "warn",
                    suggestion="中文省略号建议改为英文「...」")
            for _m in SPACE_BEFORE_PUNCT_RE.finditer(text):
                add(ep["ep"], paragraph, i, line, "标点前空格", "spacing", "warn",
                    suggestion="删除标点前的空格")
            for _m in MULTI_SPACE_RE.finditer(text):
                add(ep["ep"], paragraph, i, line, "连续空格", "spacing", "warn",
                    suggestion="压缩为一个半角空格")
            if cjk_count(text) > 0:
                add(ep["ep"], paragraph, i, line, "CJK", "dialogue_text", "info",
                    suggestion="英文台词正文混入中文字符，请确认")

    results = sorted(rows.values(), key=lambda r: (r["ep"], r["paragraph"], r["char"]))
    must = [r for r in results if r["severity"] == "must_fix"]
    warn = [r for r in results if r["severity"] == "warn"]
    risky_eps = sorted({r["ep"] for r in must + warn})
    status = "RISK" if (must or warn) else "OK"
    summary = {
        "status": status,
        "issues": len(results),
        "must_fix": sum(r["count"] for r in must),
        "warn": sum(r["count"] for r in warn),
        "risky_eps": risky_eps,
    }
    out = _envelope(ctx, "punctuation", False, status, summary, results,
                    "work/preflight/punctuation.json")
    out["risky_eps"] = risky_eps
    return out


# ===========================================================================
# 3) pacing (atom_pacing + dialogue_density)
# ===========================================================================
def _analyze_pacing(lines: list[str], thresholds: dict | None = None) -> dict:
    cfg = thresholds or {}
    max_atom_run = int(cfg.get("max_atom_run", MAX_ATOM_RUN))
    max_atoms_per_spoken = float(cfg.get("max_atoms_per_spoken", MAX_ATOMS_PER_SPOKEN))
    dup_similarity = float(cfg.get("dup_similarity", DUP_SIMILARITY))
    max_dup_pairs = int(cfg.get("max_dup_pairs", MAX_DUP_PAIRS))
    max_spoken_run = int(cfg.get("max_spoken_run", MAX_SPOKEN_RUN))
    min_atoms_per_spoken = float(cfg.get("min_atoms_per_spoken", MIN_ATOMS_PER_SPOKEN))
    spoken_floor = int(cfg.get("spoken_floor", SPOKEN_FLOOR))
    body = [raw_strip(x) for x in lines if raw_strip(x)]
    atoms = 0
    spoken = 0
    atom_texts: list[str] = []
    runs: list[tuple[int, int]] = []
    sp_runs: list[tuple[int, int]] = []
    run_start: int | None = None
    sp_start: int | None = None
    for i, s in enumerate(body):
        is_atom = is_atom_line(s)
        parts = dialogue_parts(s)
        is_sp = parts is not None
        is_struct = is_structural_line(s)
        if is_atom:
            if run_start is None:
                run_start = i
            atoms += 1
            atom_texts.append(s[1:].strip())
            if sp_start is not None:
                sp_runs.append((sp_start, i - sp_start))
                sp_start = None
            continue
        if is_sp or is_struct:
            if run_start is not None:
                runs.append((run_start, i - run_start))
                run_start = None
        if is_sp:
            spoken += 1
            if sp_start is None:
                sp_start = i
        elif is_struct:
            if sp_start is not None:
                sp_runs.append((sp_start, i - sp_start))
                sp_start = None
    if run_start is not None:
        runs.append((run_start, len(body) - run_start))
    if sp_start is not None:
        sp_runs.append((sp_start, len(body) - sp_start))

    max_run = max((r[1] for r in runs), default=0)
    max_sp_run = max((r[1] for r in sp_runs), default=0)
    ratio = (atoms / spoken) if spoken else float(atoms)
    dups: list[dict] = []
    for k in range(1, len(atom_texts)):
        sim = _jaccard(atom_texts[k - 1], atom_texts[k])
        if sim >= dup_similarity:
            dups.append({"prev": atom_texts[k - 1][:40],
                         "cur": atom_texts[k][:40],
                         "similarity": round(sim, 2)})
    reasons: list[str] = []
    if max_run >= max_atom_run:
        reasons.append(f"连续无台词 △ 段达 {max_run} 条（上限 {max_atom_run}）")
    if ratio > max_atoms_per_spoken:
        reasons.append(f"△/台词比 {ratio:.1f}（上限 {max_atoms_per_spoken}）")
    if len(dups) > max_dup_pairs:
        reasons.append(f"相邻近重复 △ 对 {len(dups)} 处（上限 {max_dup_pairs}）")
    dialogue_reasons: list[str] = []
    if max_sp_run >= max_spoken_run:
        dialogue_reasons.append(
            f"连续对白段达 {max_sp_run} 条（上限 {max_spoken_run}，段间无 △/换场）")
    if spoken >= spoken_floor and ratio < min_atoms_per_spoken:
        dialogue_reasons.append(
            f"△/台词比 {ratio:.2f}（低于下限 {min_atoms_per_spoken}，动作偏少）")
    long_runs = [{"start": st, "length": ln, "preview": body[st][:40]}
                 for st, ln in runs if ln >= max_atom_run]
    merge_targets = [{"start": st, "length": ln, "preview": body[st][:40]}
                     for st, ln in runs if ln >= 2]
    dialogue_runs = [{"start": st, "length": ln, "preview": body[st][:40]}
                     for st, ln in sp_runs if ln >= max_spoken_run]
    return {
        "atoms": atoms, "spoken": spoken, "ratio": round(ratio, 2),
        "max_atom_run": max_run, "duplicate_pairs": len(dups),
        "long_runs": long_runs, "merge_targets": merge_targets,
        "duplicates": dups, "reasons": reasons,
        "status": "RISK" if reasons else "OK",
        "max_spoken_run": max_sp_run, "dialogue_runs": dialogue_runs,
        "dialogue_reasons": dialogue_reasons,
        "dialogue_status": "RISK" if dialogue_reasons else "OK",
        "body": body,
    }


def check_pacing(ctx: dict) -> dict:
    pace_cfg = (ctx.get("check_profile") or {}).get("pacing") or {}
    thresholds = {
        "max_atom_run": int(pace_cfg.get("max_atom_run", MAX_ATOM_RUN)),
        "max_atoms_per_spoken": float(pace_cfg.get("max_atoms_per_spoken", MAX_ATOMS_PER_SPOKEN)),
        "dup_similarity": float(pace_cfg.get("dup_similarity", DUP_SIMILARITY)),
        "max_dup_pairs": int(pace_cfg.get("max_dup_pairs", MAX_DUP_PAIRS)),
        "max_spoken_run": int(pace_cfg.get("max_spoken_run", MAX_SPOKEN_RUN)),
        "min_atoms_per_spoken": float(
            pace_cfg.get("min_atoms_per_spoken", MIN_ATOMS_PER_SPOKEN)),
        "spoken_floor": int(pace_cfg.get("spoken_floor", SPOKEN_FLOOR)),
    }
    atom_results: list[dict] = []
    dialogue_results: list[dict] = []
    atom_risky: list[int] = []
    dialogue_risky: list[int] = []
    merge_proposal: list[dict] = []
    for ep in ctx["episodes"]:
        st = _analyze_pacing(ep["lines"], thresholds)
        body = st.pop("body")
        atom_results.append({"ep": ep["ep"], **{k: st[k] for k in (
            "atoms", "spoken", "ratio", "max_atom_run", "duplicate_pairs",
            "long_runs", "merge_targets", "duplicates", "reasons")}})
        dialogue_results.append({"ep": ep["ep"], **{k: st[k] for k in (
            "atoms", "spoken", "ratio", "max_spoken_run", "dialogue_runs",
            "dialogue_reasons")}})
        if st["status"] == "RISK":
            atom_risky.append(ep["ep"])
        if st["dialogue_status"] == "RISK":
            dialogue_risky.append(ep["ep"])
        for run in st["merge_targets"]:
            merge_proposal.append({
                "ep": ep["ep"],
                "start_para": ep["start"] + run["start"] + 1,
                "end_para_exclusive": ep["start"] + run["start"] + run["length"] + 1,
                "atom_lines": run["length"],
                "preview": run["preview"],
                "suggestion": "连续 △ 合并为 1 条或少量完整 △（保留全部事实与动作，只减条数）；仅建议，不自动改文",
            })
    summary = {
        "status": "RISK" if (atom_risky or dialogue_risky) else "OK",
        "atom_risky_eps": atom_risky,
        "dialogue_risky_eps": dialogue_risky,
    }
    results = {
        "subchecks": {
            "atom_pacing": {
                "status": "RISK" if atom_risky else "OK",
                "thresholds": {
                    "max_atom_run": thresholds["max_atom_run"],
                    "max_atoms_per_spoken": thresholds["max_atoms_per_spoken"],
                    "dup_similarity": thresholds["dup_similarity"],
                    "max_dup_pairs": thresholds["max_dup_pairs"],
                },
                "risky_eps": atom_risky,
                "results": atom_results,
            },
            "dialogue_density": {
                "status": "RISK" if dialogue_risky else "OK",
                "thresholds": {
                    "max_spoken_run": thresholds["max_spoken_run"],
                    "min_atoms_per_spoken": thresholds["min_atoms_per_spoken"],
                    "spoken_floor": thresholds["spoken_floor"],
                },
                "risky_eps": dialogue_risky,
                "results": dialogue_results,
            },
        },
    }
    out = _envelope(ctx, "pacing", False, summary["status"], summary, [],
                    "work/preflight/atom_pacing.json")
    out["subchecks"] = results["subchecks"]
    out["merge_proposal"] = merge_proposal
    out["merge_hint"] = "合并=连续△并为1条或少量完整△，保留全部事实与表演动作，只减条数"
    out["risky_eps"] = sorted(set(atom_risky + dialogue_risky))
    return out


# ===========================================================================
# 4) protagonist
# ===========================================================================
def _collect_profile(episodes: list[dict]) -> dict | None:
    counts: dict[str, int] = {}
    per_episode: dict[int, set[str]] = {}
    first_votes: dict[str, int] = {}
    first_billed = ""
    for ep in episodes:
        per_episode.setdefault(ep["ep"], set())
        first_cast_done = False
        for line in ep["lines"]:
            names = _cast_names(line)
            if names and not first_cast_done:
                first_votes[names[0]] = first_votes.get(names[0], 0) + 1
                first_cast_done = True
            for name in names:
                if not first_billed:
                    first_billed = name
                counts.setdefault(name, 0)
                per_episode[ep["ep"]].add(name)
            parts = dialogue_parts(line)
            if parts:
                speaker = _speaker_name(parts[0])
                if speaker:
                    counts[speaker] = counts.get(speaker, 0) + 1
                    per_episode[ep["ep"]].add(speaker)
    if not counts:
        return None
    top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    top_count = top[0][1]

    def score(item) -> float:
        name, count = item
        coverage = sum(1 for names in per_episode.values() if name in names)
        opening_bonus = 4 if name == first_billed else 0
        return count + 8 * first_votes.get(name, 0) + 0.5 * coverage + opening_bonus

    chosen = max(counts.items(), key=lambda kv: (score(kv), kv[1], kv[0]))[0]
    aliases: set[str] = set()
    # Alias rule (narrowed from old protagonist_profile.py:93-106): only the
    # *paired* line may contribute an alias. Both-directions scanning wrongly
    # absorbed neighbouring characters (e.g. 苏晚's EN line preceding 林砚's CN
    # line), which made every support character an "alias" of the protagonist.
    for ep in episodes:
        lines = ep["lines"]
        for i, line in enumerate(lines):
            parts = dialogue_parts(line)
            if not parts or _speaker_name(parts[0]) != chosen:
                continue
            lang = text_language(parts[1])
            if lang == "cn":
                j = i + 1
                if j < len(lines):
                    other_parts = dialogue_parts(lines[j])
                    if other_parts and text_language(other_parts[1]) == "en":
                        other = _speaker_name(other_parts[0])
                        if other and other != chosen:
                            aliases.add(other)
            elif lang == "en":
                j = i - 1
                if j >= 0:
                    other_parts = dialogue_parts(lines[j])
                    if other_parts and text_language(other_parts[1]) == "cn":
                        other = _speaker_name(other_parts[0])
                        if other and other != chosen:
                            aliases.add(other)
    confidence = round(counts.get(chosen, 0) / max(1, top_count), 2)
    return {
        "protagonist": chosen,
        "aliases": sorted(aliases),
        "source": "auto",
        "confidence": confidence,
        "evidence": {
            "dialogue_lines": counts.get(chosen, 0),
            "episodes": sum(1 for names in per_episode.values() if chosen in names),
            "first_billed": first_billed,
            "first_votes": first_votes.get(chosen, 0),
            "top_speakers": top[:5],
        },
    }


def _scene_blocks(lines: list[str]) -> list[dict]:
    starts = [i for i, line in enumerate(lines) if is_scene_line(line)]
    if not starts:
        return [{"scene": "1-1", "lines": lines}]
    out = []
    for k, start in enumerate(starts):
        end = starts[k + 1] if k + 1 < len(starts) else len(lines)
        raw = raw_strip(lines[start])
        scene = raw.split(" ", 1)[0] if raw else f"scene-{k + 1}"
        out.append({"scene": scene, "lines": lines[start:end]})
    return out


def _analyze_episode(ep: dict, names: list[str], coverage_cfg: dict) -> dict:
    blocks = _scene_blocks(ep["lines"])
    total_dialogue = protagonist_dialogue = 0
    total_action = protagonist_action = 0
    scene_map: list[dict] = []
    for block in blocks:
        evidence: set[str] = set()
        has_protagonist = False
        for line in block["lines"]:
            for name in _cast_names(line):
                if _has_name(name, names):
                    has_protagonist = True
                    evidence.add("人物")
        for line in block["lines"]:
            if not is_atom_line(line):
                continue
            total_action += 1
            if _has_name(line, names):
                protagonist_action += 1
                has_protagonist = True
                evidence.add("△")
        for line in block["lines"]:
            if is_atom_line(line) or is_structural_line(line):
                continue
            parts = dialogue_parts(line)
            if not parts:
                continue
            speaker = _speaker_name(parts[0])
            total_dialogue += 1
            if _has_name(speaker, names):
                protagonist_dialogue += 1
                has_protagonist = True
                evidence.add(parts[2])
        scene_map.append({
            "scene": block["scene"],
            "has_protagonist": has_protagonist,
            "evidence": sorted(evidence),
        })
    scenes = len(scene_map)
    protagonist_scenes = sum(1 for s in scene_map if s["has_protagonist"])
    scene_ratio = protagonist_scenes / scenes if scenes else 0.0
    dialogue_ratio = protagonist_dialogue / total_dialogue if total_dialogue else 0.0
    action_ratio = protagonist_action / total_action if total_action else 0.0
    if total_dialogue and total_action:
        coverage_score = 0.5 * scene_ratio + 0.3 * dialogue_ratio + 0.2 * action_ratio
    elif total_dialogue:
        coverage_score = 0.7 * scene_ratio + 0.3 * dialogue_ratio
    elif total_action:
        coverage_score = 0.7 * scene_ratio + 0.3 * action_ratio
    else:
        coverage_score = scene_ratio
    status, reason = _classify({
        "protagonist_scenes": protagonist_scenes,
        "protagonist_dialogue_lines": protagonist_dialogue,
        "scene_ratio": scene_ratio,
        "dialogue_lines": total_dialogue,
        "dialogue_ratio": dialogue_ratio,
        "coverage_score": coverage_score,
    }, coverage_cfg)
    return {
        "ep": ep["ep"],
        "scenes": scenes,
        "protagonist_scenes": protagonist_scenes,
        "scene_ratio": round(scene_ratio, 3),
        "dialogue_lines": total_dialogue,
        "protagonist_dialogue_lines": protagonist_dialogue,
        "dialogue_ratio": round(dialogue_ratio, 3),
        "action_lines": total_action,
        "protagonist_action_lines": protagonist_action,
        "action_ratio": round(action_ratio, 3),
        "coverage_score": round(coverage_score, 3),
        "status": status,
        "reason": reason,
        "scene_map": scene_map,
    }


def _classify(rec: dict, cfg: dict) -> tuple[str, str]:
    if rec["protagonist_scenes"] == 0 and rec["protagonist_dialogue_lines"] == 0:
        return "NO_PROTAGONIST", "主角未出场且无台词"
    reasons: list[str] = []
    if rec["scene_ratio"] < cfg["min_scene_ratio"]:
        reasons.append(f"scene_ratio {rec['scene_ratio']:.3f} < {cfg['min_scene_ratio']}")
    if rec["dialogue_lines"] > 0 and rec["dialogue_ratio"] < cfg["min_dialogue_ratio"]:
        reasons.append(
            f"dialogue_ratio {rec['dialogue_ratio']:.3f} < {cfg['min_dialogue_ratio']}")
    if reasons:
        return "LOW_PROTAGONIST", "；".join(reasons)
    borderline: list[str] = []
    if rec["scene_ratio"] < cfg["borderline_scene_ratio"]:
        borderline.append(
            f"scene_ratio {rec['scene_ratio']:.3f} < {cfg['borderline_scene_ratio']}")
    if rec["dialogue_lines"] > 0 and rec["dialogue_ratio"] < cfg["borderline_dialogue_ratio"]:
        borderline.append(
            f"dialogue_ratio {rec['dialogue_ratio']:.3f} < {cfg['borderline_dialogue_ratio']}")
    if rec["coverage_score"] < cfg["borderline_coverage_score"]:
        borderline.append(
            f"coverage_score {rec['coverage_score']:.3f} < {cfg['borderline_coverage_score']}")
    if borderline:
        return "BORDERLINE", "；".join(borderline)
    return "OK", ""


def _entered(ep: int, ctx: dict) -> bool:
    draft = ctx["paths"]["draft_dir"] / f"ep{ep:02d}.md"
    try:
        if draft.exists() and draft.stat().st_size > 0:
            return True
    except OSError:
        pass
    prog = ctx.get("progress") or {}
    status = (((prog.get("episodes") or {}).get(str(ep)) or {}).get("status"))
    return status in ("passed", "passed-with-issues", "failed")


def check_protagonist(ctx: dict) -> dict:
    shot = ctx.get("shot_profile") or {}
    if not shot.get("enabled", True):
        return _envelope(ctx, "protagonist", True, "SKIP",
                         {"status": "SKIP", "protagonist": "", "aliases": [],
                          "blocked_eps": [], "borderline_eps": [], "skipped": True},
                         [], "work/preflight/protagonist.json")
    coverage_cfg = dict(DEFAULT_COVERAGE)
    for k, v in (shot.get("coverage") or {}).items():
        if isinstance(v, (int, float)):
            coverage_cfg[k] = float(v)
    profile = _collect_profile(ctx["episodes"])
    if not profile:
        return _envelope(ctx, "protagonist", True, "SKIP",
                         {"status": "SKIP", "protagonist": "", "aliases": [],
                          "blocked_eps": [], "borderline_eps": [], "skipped": True},
                         [], "work/preflight/protagonist.json")
    names = [profile["protagonist"]] + list(profile["aliases"])
    results: list[dict] = []
    blocked: list[int] = []
    borderline: list[int] = []
    progress_blocked: dict[int, bool] = {}
    for ep in ctx["episodes"]:
        rec = _analyze_episode(ep, names, coverage_cfg)
        entered = _entered(ep["ep"], ctx)
        is_blocked = rec["status"] in ("NO_PROTAGONIST", "LOW_PROTAGONIST") and not entered
        rec["entered"] = entered
        rec["blocked"] = is_blocked
        if is_blocked:
            blocked.append(ep["ep"])
        elif rec["status"] == "BORDERLINE":
            borderline.append(ep["ep"])
        progress_blocked[ep["ep"]] = is_blocked
        results.append(rec)
    status = "BLOCKED" if blocked else "OK"
    summary = {
        "status": status,
        "protagonist": profile["protagonist"],
        "aliases": profile["aliases"],
        "blocked_eps": blocked,
        "borderline_eps": borderline,
        "skipped": False,
        "coverage": coverage_cfg,
        "confidence": profile["confidence"],
    }
    out = _envelope(ctx, "protagonist", True, status, summary, results,
                    "work/preflight/protagonist.json")
    out["blocked_eps"] = blocked
    out["risky_eps"] = blocked
    out["profile"] = profile
    out["progress_blocked"] = progress_blocked
    return out


# ===========================================================================
# 5) culture
# ===========================================================================
def _culture_kind(line: str) -> str:
    if is_atom_line(line):
        return "action"
    if is_structural_line(line):
        return "structure"
    if dialogue_parts(line):
        return "dialogue"
    return "other"


def _culture_suggestion(term: str, kind: str, fixable: bool) -> str:
    if not fixable:
        if kind == "dialogue":
            return "台词逐字锁定，不能自动改；需人工修改源稿或由用户授权调整。"
        return "锁行/结构行，不能自动改；需人工修改源稿。"
    if any(k in term for k in ("跪", "叩", "磕", "稽首", "顿首", "打千", "跪安")):
        return "确认是否为 SOURCE 已建立的跪礼；若未建立，改为单膝、蹲下、后退、低头等中性动作。"
    if term in ("合十", "五体投地"):
        return "确认是否为 SOURCE 已建立的礼仪；若未建立，改为低头、后退、握手等中性动作。"
    return "删除东方礼仪命名或动作，改为点头、欠身、后退、握手等文化中性行为。"


def check_culture(ctx: dict) -> dict:
    # effective culture values: project check-profile override > culture-profile.json
    profile = dict(ctx.get("culture_profile") or {})
    cp = ((ctx.get("check_profile") or {}).get("culture")) or {}
    if "forbid_cn_elements" in cp:
        profile["forbid_cn_elements"] = bool(cp["forbid_cn_elements"])
    if "allowed_terms" in cp:
        profile["allowed_terms"] = list(cp["allowed_terms"])
    forbid = bool(profile.get("forbid_cn_elements"))
    allowed = {str(x).strip() for x in (profile.get("allowed_terms") or []) if str(x).strip()}
    results: list[dict] = []
    seen: set[tuple] = set()
    for ep in ctx["episodes"]:
        for i, line in enumerate(ep["lines"]):
            if not line.strip():
                continue
            kind = _culture_kind(line)
            fixable = kind == "action"
            for entry in match_terms(line, allowed):
                term = entry["term"]
                key = (ep["ep"], i, term)
                if key in seen:
                    continue
                seen.add(key)
                if forbid:
                    severity = "must_fix" if entry["confidence"] == "hard" else "suspected"
                else:
                    severity = "info"
                results.append({
                    "ep": ep["ep"],
                    "paragraph": ep["start"] + i + 1,
                    "line_index": i,
                    "term": term,
                    "category": entry["category"],
                    "kind": kind,
                    "severity": severity,
                    "fixable": fixable,
                    "context": line[:120],
                    "suggestion": _culture_suggestion(term, kind, fixable),
                })
    must = [r for r in results if r["severity"] == "must_fix"]
    suspected = [r for r in results if r["severity"] == "suspected"]
    info = [r for r in results if r["severity"] == "info"]
    risky_eps = sorted({r["ep"] for r in must + suspected})
    status = "RISK" if (must or suspected) else "OK"
    summary = {
        "status": status,
        "must_fix": len(must),
        "suspected": len(suspected),
        "info": len(info),
        "risky_eps": risky_eps,
    }
    out = _envelope(ctx, "culture", False, status, summary, results,
                    "work/preflight/culture.json")
    out["profile"] = profile
    out["risky_eps"] = risky_eps
    return out
