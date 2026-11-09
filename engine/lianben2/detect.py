"""Format detection: line classifiers, episode boundaries, confidence score.

Ported regexes / conventions from reference tools:
- common.py:12 scene header, common.py:268 normalize_line semantics
- preflight_spoken_check.py:12-17 structural/meta/tag regexes
- preflight_atom_check.py:36-40 structural regex
- docs/03 §3.1, docs/11 §3.5
"""
from __future__ import annotations

import re

from .util import cjk_count, latin_letter_count, norm_line, raw_strip

# --- regexes (drafts frozen in docs/03 §3.1) --------------------------------
CN_EP_RE = re.compile(
    r"^第\s*(\d{1,4}|[一二三四五六七八九十百零〇]{1,6})\s*集\s*(?:[《〈【](.{0,60}?)[》〉】])?"
)
EN_EP_RE = re.compile(r"^(?:Episode|EP)\s*0*(\d{1,4})\b[^\n]{0,60}$", re.I)
SCENE_RE = re.compile(r"^(\d{1,3})\s*[-－—–]\s*(\d{1,3})\s+(?=\S)")
SCENE_VAR_RE = re.compile(r"^场\s*(\d{1,3})\s*[-－]\s*(\d{1,3})")
SCENE_CN_RE = re.compile(r"^场\s*(\d{1,3})\s*[｜|]")
CAST_RE = re.compile(r"^(?:人物|出场人物|角色|CHARACTERS)\s*[：:]")
STRUCTURE_RE = re.compile(r"^【[^】\n]{1,24}】")
ATOM_RE = re.compile(r"^[△▲▽]\s*")
META_PREFIX_RE = re.compile(r"^(?:场景|地点|时间|备注|说明|注)\s*[：:]")
SPECTACLE_RE = re.compile(r"^(?:SPECTACLE|VFX|HERO)\b")
CN_DIALOGUE_RE = re.compile(
    r"^(?P<who>[^：:（）()]{1,40})\s*[（(]\s*"
    r"(?P<label>对白|台词|对话|VO|V\.O\.|OS|O\.S\.|画外音|旁白)"
    r"[^）)]*[）)]\s*[：:]\s*(?P<text>.+)$"
)
EN_DIALOGUE_RE = re.compile(
    r"^(?P<who>[A-Z][A-Z0-9 .'\-]{1,40})\s*\(\s*"
    r"(?P<label>DIALOGUE|DIALOG|VO|OS|V\.O\.|O\.S\.)\s*\)\s*[：:]\s*(?P<text>.+)$",
    re.I,
)
TAG_RE = re.compile(
    r"[（(]\s*(对白|台词|对话|VO|V\.O\.|OS|O\.S\.|DIALOGUE|DIALOG|画外音|旁白)"
    r"(?=[，,、：:）)\s]|$)",
    re.I,
)
STRUCTURAL_SKIP_RE = re.compile(
    r"^(?:第\s*\d+\s*集|(?i:episode)\s*\d+|\d{1,3}\s*[-－—–]\s*\d{1,3}\s|"
    r"(?:人物|出场人物|角色)\s*[：:]|【|(?:SPECTACLE|VFX|HERO)\b)"
)

DEFAULT_LOCKED = [
    r"^第\s*\d+\s*集",
    r"(?i:episode)\s*\d+",
    r"^\d+\s*[-－]\s*\d+",
    r"^(?:出场人物|人物)\s*[：:]",
    r"^(?:SPECTACLE|VFX|HERO)\b",
    r"^【",
]

_CN_DIGITS = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}


def cn_num_to_int(token: str) -> int | None:
    """Only unambiguous 1-99 CJK numerals (docs/03 §3.1); else None."""
    token = token.strip()
    if not token:
        return None
    if token.isdigit():
        try:
            return int(token)
        except ValueError:
            return None
    if any(ch not in _CN_DIGITS and ch != "十" for ch in token):
        return None
    if "十" not in token:
        if len(token) != 1:
            return None
        return _CN_DIGITS[token]
    if token == "十":
        return 10
    if token.startswith("十") and len(token) == 2:
        return 10 + _CN_DIGITS.get(token[1], 0) if token[1] in _CN_DIGITS else None
    if token.endswith("十") and len(token) == 2:
        return _CN_DIGITS[token[0]] * 10 if token[0] in _CN_DIGITS else None
    if len(token) == 3 and token[1] == "十":
        if token[0] in _CN_DIGITS and token[2] in _CN_DIGITS:
            return _CN_DIGITS[token[0]] * 10 + _CN_DIGITS[token[2]]
    return None


# --- line classifiers -------------------------------------------------------
def is_scene_line(line: str) -> bool:
    s = raw_strip(line)
    return bool(SCENE_RE.match(s) or SCENE_VAR_RE.match(s) or SCENE_CN_RE.match(s))


def is_cast_line(line: str) -> bool:
    return bool(CAST_RE.match(raw_strip(line)))


def is_structure_line(line: str) -> bool:
    s = raw_strip(line)
    return bool(STRUCTURE_RE.match(s) or SPECTACLE_RE.match(s))


def is_atom_line(line: str) -> bool:
    return bool(ATOM_RE.match(raw_strip(line)))


def is_structural_line(line: str) -> bool:
    """Locked/structural line (old common.is_structural_line semantics)."""
    return bool(STRUCTURAL_SKIP_RE.match(raw_strip(line)))


def split_speaker(line: str) -> tuple[str, str] | None:
    """First colon outside parentheses (common.py:356-366)."""
    depth = 0
    for i, ch in enumerate(line):
        if ch in "（(":
            depth += 1
        elif ch in "）)":
            depth = max(0, depth - 1)
        elif ch in "：:" and depth == 0:
            prefix, text = line[:i].strip(), line[i + 1:].strip()
            if prefix and text:
                return prefix, text
            return None
    return None


def detect_tag(prefix: str) -> str | None:
    """Canonical tag values: 对白 / VO / OS (common.py:336-345)."""
    m = TAG_RE.search(prefix or "")
    if not m:
        return None
    tag = m.group(1).upper()
    if tag in ("DIALOGUE", "DIALOG", "对白", "台词", "对话"):
        return "对白"
    if tag in ("VO", "V.O."):
        return "VO"
    if tag in ("OS", "O.S."):
        return "OS"
    if tag == "画外音":
        return "VO"
    if tag == "旁白":
        return "VO"
    return None


def dialogue_parts(line: str) -> tuple[str, str, str] | None:
    """Return (prefix, text, tag) for a tagged dialogue line, else None."""
    s = raw_strip(line)
    pair = split_speaker(s)
    if not pair:
        return None
    prefix, text = pair
    tag = detect_tag(prefix)
    if not tag:
        return None
    return prefix, text, tag


def text_language(text: str) -> str | None:
    cjk = cjk_count(text)
    latin = latin_letter_count(text)
    if cjk and not latin:
        return "cn"
    if latin and not cjk:
        return "en"
    if cjk and latin:
        return "cn" if cjk * 2 >= latin else "en"
    return None


def classify_line(line: str, preinfo: bool = False) -> str:
    s = raw_strip(line)
    if not s:
        return "empty"
    if is_atom_line(s):
        return "atom"
    if CN_EP_RE.match(s):
        return "episode"
    if EN_EP_RE.match(s):
        return "episode_en"
    if is_scene_line(s):
        return "scene"
    if is_cast_line(s):
        return "cast"
    if is_structure_line(s):
        return "structure"
    if dialogue_parts(s):
        return "dialogue"
    if META_PREFIX_RE.match(s):
        return "other"
    return "front" if preinfo else "other"


# --- detection --------------------------------------------------------------
def detect(paragraphs: list[dict]) -> dict:
    raw = [p.get("text", "") or "" for p in paragraphs]
    candidates: list[dict] = []
    for i, text in enumerate(raw):
        s = raw_strip(text)
        if not s:
            continue
        m = CN_EP_RE.match(s)
        if not m:
            continue
        ep = cn_num_to_int(m.group(1))
        if ep is None:
            continue
        title_en = ""
        if i + 1 < len(raw):
            nxt = raw_strip(raw[i + 1])
            if nxt and EN_EP_RE.match(nxt):
                title_en = nxt
        candidates.append({
            "ep": ep, "start": i, "title": s, "title_en": title_en,
            "family": "cn", "cjk_numeral": not m.group(1).isdigit(),
        })

    # Some production scripts use only `EP1《...》` / `Episode 1` headers
    # without Chinese 第N集 lines. Accept that convention as a fallback when
    # no Chinese candidates exist; mixed CN/EN files still use CN as primary.
    if not candidates:
        for i, text in enumerate(raw):
            s = raw_strip(text)
            if not s:
                continue
            m = EN_EP_RE.match(s)
            if not m:
                continue
            try:
                ep = int(m.group(1))
            except ValueError:
                continue
            candidates.append({
                "ep": ep, "start": i, "title": s, "title_en": "",
                "family": "en", "cjk_numeral": False,
            })

    candidates_sorted = sorted(candidates, key=lambda c: c["start"])
    eps_in_order = [c["ep"] for c in candidates_sorted]
    seen: dict[int, int] = {}
    for e in eps_in_order:
        seen[e] = seen.get(e, 0) + 1
    duplicates = sorted(e for e, n in seen.items() if n > 1)
    ascending = eps_in_order == sorted(eps_in_order) and len(set(eps_in_order)) == len(eps_in_order)
    gaps = False
    if eps_in_order and not duplicates and ascending:
        gaps = eps_in_order != list(range(eps_in_order[0], eps_in_order[0] + len(eps_in_order)))

    first_start = candidates_sorted[0]["start"] if candidates_sorted else len(raw)
    counts = {k: 0 for k in ("episode", "episode_en", "scene", "cast", "structure",
                             "atom", "dialogue", "other", "front", "empty")}
    for i, text in enumerate(raw):
        kind = classify_line(text, preinfo=i < first_start)
        counts[kind] = counts.get(kind, 0) + 1
    nonempty = len(raw) - counts["empty"]
    classified = nonempty - counts["other"]
    coverage = (classified / nonempty) if nonempty else 0.0

    tagged = untagged = 0
    records: list[dict] = []
    for i, text in enumerate(raw):
        s = raw_strip(text)
        if not s or is_structural_line(s) or is_atom_line(s):
            continue
        pair = split_speaker(s)
        if not pair:
            continue
        tag = detect_tag(pair[0])
        if tag:
            tagged += 1
            records.append({"i": i, "lang": text_language(pair[1]), "tag": tag})
        else:
            untagged += 1
    colon_lines = tagged + untagged
    tag_consistency = (tagged / colon_lines) if colon_lines else 0.6

    cn_dlg = [r for r in records if r["lang"] == "cn"]
    en_dlg = [r for r in records if r["lang"] == "en"]
    if cn_dlg and en_dlg:
        pairs = 0
        for k in range(len(records) - 1):
            if records[k]["lang"] == "cn" and records[k + 1]["lang"] == "en":
                pairs += 1
        bilingual = min(1.0, pairs / len(cn_dlg))
    elif records:
        bilingual = 1.0
    else:
        bilingual = 0.5

    episode_score = 1.0
    if not candidates_sorted:
        episode_score = 0.0
    if duplicates:
        episode_score -= 0.5
    if not ascending:
        episode_score -= 0.4
    if gaps:
        episode_score -= 0.15
    episode_score = max(0.0, min(1.0, episode_score))

    monotonic = 1.0 if (candidates_sorted and not duplicates and ascending and not gaps) else (
        0.2 if (duplicates or not ascending) else 0.6)

    scene_score = 1.0 if counts["scene"] > 0 else 0.6

    components = {
        "ep_header_clarity": round(episode_score, 3),
        "line_type_coverage": round(min(1.0, coverage), 3),
        "scene_consistency": round(scene_score, 3),
        "dialogue_tag_consistency": round(min(1.0, tag_consistency), 3),
        "bilingual_pair_rate": round(min(1.0, bilingual), 3),
        "monotonic_ep": round(min(1.0, monotonic), 3),
    }
    confidence = round(
        0.30 * components["ep_header_clarity"]
        + 0.20 * components["line_type_coverage"]
        + 0.15 * components["scene_consistency"]
        + 0.15 * components["dialogue_tag_consistency"]
        + 0.10 * components["bilingual_pair_rate"]
        + 0.10 * components["monotonic_ep"],
        3,
    )

    reasons: list[str] = []
    if not candidates_sorted:
        reasons.append("未识别到任何集标题")
    if duplicates:
        reasons.append(f"集号重复：{duplicates}")
    if candidates_sorted and not ascending:
        reasons.append("集标题顺序非递增")
    if confidence < 0.65:
        reasons.append(f"格式识别置信度偏低（{confidence} < 0.65）")
    needs_confirm = bool(reasons)

    episode_count = len(candidates_sorted)
    mode = "A" if episode_count >= 2 else "B"
    en_pattern = "(?i:episode)\\s*\\d+" if any(c["title_en"] for c in candidates_sorted) else ""

    fmt = {
        "version": 1,
        "schema": "lianben/format/1",
        "provenance": "machine",
        "confidence": confidence,
        "episode": {
            "header_pattern": r"^(?:Episode|EP)\s*(\d+)" if candidates_sorted and all(c.get("family") == "en" for c in candidates_sorted) else r"^第\s*(\d+)\s*集",
            "en_pattern": en_pattern,
        },
        "scene_pattern": SCENE_RE.pattern,
        "dialogue_patterns": {
            "cn": CN_DIALOGUE_RE.pattern,
            "en": EN_DIALOGUE_RE.pattern,
        },
        "locked_line_patterns": list(DEFAULT_LOCKED),
        "speaker": {"colon": "[：:]", "labels": ["对白", "VO", "OS"]},
        "atom": {"prefixes": ["△"]},
    }
    detection = {
        "mode": mode,
        "confidence": confidence,
        "episode_count": episode_count,
        "components": components,
        "candidates": candidates_sorted,
        "needs_confirm": needs_confirm,
        "reasons": reasons,
        "line_type_counts": counts,
    }
    return {"detection": detection, "format": fmt, "counts": counts}
