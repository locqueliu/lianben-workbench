"""Project config defaults / profile loading / docx resolution."""
from __future__ import annotations

from pathlib import Path

from .errors import FatalError
from .util import DEFAULTS_DIR, EXCLUDED_NAME_PARTS, INBOX_DIRNAME, load_json_safe

DEFAULT_CULTURE = {
    "market": "auto",
    "setting": "",
    "forbid_cn_elements": False,
    "allowed_terms": [],
}

DEFAULT_SHOT = {
    "enabled": True,
    "mode": "warn",
    "coverage": {
        "min_scene_ratio": 0.40,
        "min_dialogue_ratio": 0.20,
        "borderline_scene_ratio": 0.55,
        "borderline_dialogue_ratio": 0.35,
        "borderline_coverage_score": 0.45,
    },
}


def _default(name: str):
    return load_json_safe(DEFAULTS_DIR / name, None)


def load_culture_profile(project_root: Path) -> dict:
    data = None
    p = Path(project_root) / "culture-profile.json"
    if p.exists():
        data = load_json_safe(p, None)
    if not isinstance(data, dict):
        data = _default("culture-profile.json")
    prof = dict(DEFAULT_CULTURE)
    if isinstance(data, dict):
        prof.update(data)
    if not isinstance(prof.get("allowed_terms"), list):
        prof["allowed_terms"] = []
    prof["forbid_cn_elements"] = bool(prof.get("forbid_cn_elements"))
    return prof


def load_shot_profile(project_root: Path) -> dict:
    data = None
    p = Path(project_root) / "shot-profile.json"
    if p.exists():
        data = load_json_safe(p, None)
    if not isinstance(data, dict):
        data = _default("shot-profile.json")
    prof = {"enabled": True, "mode": "warn", "coverage": dict(DEFAULT_SHOT["coverage"])}
    if isinstance(data, dict):
        prof["enabled"] = bool(data.get("enabled", True))
        prof["mode"] = data.get("mode", "warn")
        cov = data.get("coverage")
        if isinstance(cov, dict):
            prof["coverage"].update({k: v for k, v in cov.items() if isinstance(v, (int, float))})
    return prof


def resolve_source_docx(project_root: Path, source_arg: str | None) -> Path:
    """Fixed CLI contract:
    - if --source given and inbox has no eligible docx -> copy source into inbox;
    - otherwise use the single eligible docx in inbox.
    """
    root = Path(project_root)
    inbox = root / INBOX_DIRNAME
    inbox.mkdir(parents=True, exist_ok=True)
    eligible = _eligible_docx(inbox)

    if source_arg:
        src = Path(source_arg)
        if not src.is_absolute():
            src = (Path.cwd() / src).resolve()
        if not src.exists():
            raise FatalError(f"--source 不存在：{source_arg}")
        if not eligible:
            try:
                dest = inbox / src.name
                if dest.exists():
                    dest.unlink()
                dest.write_bytes(src.read_bytes())
            except (OSError, PermissionError) as exc:
                raise FatalError(f"复制源 docx 到 剧本输入/ 失败：{exc}") from exc
            eligible = _eligible_docx(inbox)
        # if inbox already had docx, keep it (contract: use the one in the dir)

    if not eligible:
        raise FatalError("缺少源剧本：请把唯一一个 .docx 放入 剧本输入/ 或使用 --source")
    if len(eligible) > 1:
        names = "、".join(p.name for p in eligible)
        raise FatalError(f"剧本输入/ 中存在多个 docx，请只保留一个（当前：{names}）")
    return eligible[0]


def _eligible_docx(inbox: Path) -> list[Path]:
    out = []
    for p in sorted(inbox.glob("*.docx"), key=lambda x: x.name.lower()):
        name = p.name
        if name.startswith("~$"):
            continue
        if any(part in name for part in EXCLUDED_NAME_PARTS):
            continue
        out.append(p)
    return out
