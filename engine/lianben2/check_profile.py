"""Project-level check profile (`<project>/check-profile.json`).

Schema: lianben/check-profile/1
Supports overriding:
- spoken_words{min,max}
- pacing{max_atom_run,max_atoms_per_spoken,dup_similarity,max_dup_pairs,
         max_spoken_run,min_atoms_per_spoken,spoken_floor}
- culture{forbid_cn_elements,allowed_terms}

Defaults are the legacy-script thresholds (see checks.py source comments).
Invalid values fall back to defaults per field and produce warnings.
"""
from __future__ import annotations

from pathlib import Path

from .checks import (
    DUP_SIMILARITY,
    MAX_ATOMS_PER_SPOKEN,
    MAX_ATOM_RUN,
    MAX_DUP_PAIRS,
    MAX_SPOKEN_RUN,
    MIN_ATOMS_PER_SPOKEN,
    MIN_WORDS,
    MAX_WORDS,
    SPOKEN_FLOOR,
)
from .util import load_json_safe

SCHEMA = "lianben/check-profile/1"

DEFAULT_PROFILE = {
    "spoken_words": {"min": MIN_WORDS, "max": MAX_WORDS},
    "pacing": {
        "max_atom_run": MAX_ATOM_RUN,
        "max_atoms_per_spoken": MAX_ATOMS_PER_SPOKEN,
        "dup_similarity": DUP_SIMILARITY,
        "max_dup_pairs": MAX_DUP_PAIRS,
        "max_spoken_run": MAX_SPOKEN_RUN,
        "min_atoms_per_spoken": MIN_ATOMS_PER_SPOKEN,
        "spoken_floor": SPOKEN_FLOOR,
    },
}


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_num(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _valid_int(value, lo: int, hi: int | None = None) -> bool:
    if not _is_int(value):
        return False
    if value < lo:
        return False
    if hi is not None and value > hi:
        return False
    return True


def _valid_num(value, lo: float, hi: float | None = None) -> bool:
    if not _is_num(value):
        return False
    if value < lo:
        return False
    if hi is not None and value > hi:
        return False
    return True


def load_check_profile(project_root: Path, culture_profile: dict) -> tuple[dict, str, list[str], bool]:
    """Return (effective_profile, source, warnings, file_present).

    source = "project" when at least one valid override was applied, else "default".
    """
    effective = {
        "spoken_words": dict(DEFAULT_PROFILE["spoken_words"]),
        "pacing": dict(DEFAULT_PROFILE["pacing"]),
        "culture": {
            "forbid_cn_elements": bool((culture_profile or {}).get("forbid_cn_elements")),
            "allowed_terms": list((culture_profile or {}).get("allowed_terms") or []),
        },
    }
    warnings: list[str] = []
    base_effective = {
        "spoken_words": dict(DEFAULT_PROFILE["spoken_words"]),
        "pacing": dict(DEFAULT_PROFILE["pacing"]),
        "culture": {
            "forbid_cn_elements": bool((culture_profile or {}).get("forbid_cn_elements")),
            "allowed_terms": list((culture_profile or {}).get("allowed_terms") or []),
        },
    }
    path = Path(project_root) / "check-profile.json"
    if not path.exists():
        return effective, "default", warnings, False

    data = load_json_safe(path, None)
    if not isinstance(data, dict):
        warnings.append("check-profile.json 不是合法 JSON 对象，已回退默认阈值")
        return effective, "default", warnings, True
    if data.get("schema") != SCHEMA:
        warnings.append(
            f"check-profile.json schema 应为 {SCHEMA}（实际 {data.get('schema')!r}），已回退默认阈值")
        return effective, "default", warnings, True

    applied = False

    def warn(msg: str) -> None:
        warnings.append("check-profile." + msg)

    # ---- spoken_words ----
    sp = data.get("spoken_words")
    if sp is not None:
        if not isinstance(sp, dict):
            warn("spoken_words 不是对象，已回退默认值")
        else:
            min_v = sp.get("min", None)
            max_v = sp.get("max", None)
            ok_min = min_v is None or _valid_int(min_v, 0, 100000)
            ok_max = max_v is None or _valid_int(max_v, 0, 100000)
            cand_min = DEFAULT_PROFILE["spoken_words"]["min"] if min_v is None else min_v
            cand_max = DEFAULT_PROFILE["spoken_words"]["max"] if max_v is None else max_v
            if not ok_min:
                warn(f"spoken_words.min 非法值 {min_v!r}，已回退 {DEFAULT_PROFILE['spoken_words']['min']}")
                cand_min = DEFAULT_PROFILE["spoken_words"]["min"]
            if not ok_max:
                warn(f"spoken_words.max 非法值 {max_v!r}，已回退 {DEFAULT_PROFILE['spoken_words']['max']}")
                cand_max = DEFAULT_PROFILE["spoken_words"]["max"]
            if _valid_int(cand_min, 0, 100000) and _valid_int(cand_max, 0, 100000) and cand_min > cand_max:
                warn(f"spoken_words.min({cand_min}) > max({cand_max})，已整体回退默认值")
                cand_min = DEFAULT_PROFILE["spoken_words"]["min"]
                cand_max = DEFAULT_PROFILE["spoken_words"]["max"]
            if (min_v is not None and ok_min) or (max_v is not None and ok_max):
                applied = True
            effective["spoken_words"] = {"min": int(cand_min), "max": int(cand_max)}

    # ---- pacing ----
    pace = data.get("pacing")
    if pace is not None:
        if not isinstance(pace, dict):
            warn("pacing 不是对象，已回退默认值")
        else:
            rules = {
                "max_atom_run": ("int", 1, None),
                "max_atoms_per_spoken": ("num", 0.0001, None),
                "dup_similarity": ("num", 0.0, 1.0),
                "max_dup_pairs": ("int", 0, None),
                "max_spoken_run": ("int", 1, None),
                "min_atoms_per_spoken": ("num", 0.0, None),
                "spoken_floor": ("int", 0, None),
            }
            for key, (kind, lo, hi) in rules.items():
                if key not in pace:
                    continue
                value = pace[key]
                ok = (_valid_int(value, int(lo), hi) if kind == "int"
                      else _valid_num(value, float(lo), hi))
                if ok:
                    effective["pacing"][key] = value
                    applied = True
                else:
                    warn(f"pacing.{key} 非法值 {value!r}，已回退 {DEFAULT_PROFILE['pacing'][key]}")
            # cross-field sanity: min_atoms_per_spoken should not exceed ratio cap
            if (effective["pacing"]["min_atoms_per_spoken"]
                    > effective["pacing"]["max_atoms_per_spoken"]):
                warn("pacing.min_atoms_per_spoken > max_atoms_per_spoken，已回退默认值")
                for key, value in DEFAULT_PROFILE["pacing"].items():
                    effective["pacing"][key] = value

    # ---- culture ----
    cul = data.get("culture")
    if cul is not None:
        if not isinstance(cul, dict):
            warn("culture 不是对象，已回退 culture-profile.json 默认值")
        else:
            if "forbid_cn_elements" in cul:
                if isinstance(cul["forbid_cn_elements"], bool):
                    effective["culture"]["forbid_cn_elements"] = cul["forbid_cn_elements"]
                    applied = True
                else:
                    warn("culture.forbid_cn_elements 非法值，已回退 culture-profile.json")
            if "allowed_terms" in cul:
                terms = cul["allowed_terms"]
                if isinstance(terms, list) and all(isinstance(x, str) for x in terms):
                    effective["culture"]["allowed_terms"] = [
                        str(x).strip() for x in terms if str(x).strip()]
                    applied = True
                else:
                    warn("culture.allowed_terms 非法值，已回退 culture-profile.json")

    # source reflects whether the effective profile actually differs from the
    # legacy defaults / culture-profile baseline.
    source = "project" if effective != base_effective else "default"
    return effective, source, warnings, True
