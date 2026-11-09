"""Preflight pipeline orchestration: scaffold -> extract -> detect -> split -> checks -> report."""
from __future__ import annotations

import shutil
import time
from pathlib import Path

from . import SCHEMA_PROJECT, VERSION
from .check_profile import load_check_profile
from .checks import (
    check_culture,
    check_pacing,
    check_protagonist,
    check_punctuation,
    check_spoken_words,
)
from .detect import detect
from .docx_io import extract_paragraphs
from .errors import FatalError, IOProblem, NeedsConfirm
from .events import EventEmitter
from .profiles import load_culture_profile, load_shot_profile, resolve_source_docx
from .report import (
    build_index,
    build_stdout,
    write_check_files,
    write_reports,
)
from .split import (
    anomalies_for,
    build_episodes,
    write_ep_index,
    write_facts_and_handoff,
    write_format_files,
    write_paragraph_files,
    write_progress,
    write_source_episodes,
)
from .util import (
    DEFAULTS_DIR,
    hash_obj,
    load_json_safe,
    now_iso,
    project_id,
    run_id,
    sha256_file,
    write_json,
    write_text,
)

PRECHECK_VERSION = "1.0"
CHECK_VERSIONS = {
    "spoken_words": "1.0",
    "punctuation": "1.0",
    "pacing": "1.0",
    "protagonist": "1.0",
    "culture": "1.0",
}


# ---------------------------------------------------------------------------
# paths / scaffold
# ---------------------------------------------------------------------------
def build_paths(root: Path) -> dict:
    root = Path(root)
    work = root / "work"
    meta = work / "meta"
    preflight = work / "preflight"
    return {
        "project_root": root,
        "inbox": root / "剧本输入",
        "work": work,
        "source_dir": work / "source",
        "meta": meta,
        "preflight": preflight,
        "checks_dir": preflight / "checks",
        "preflight_index": preflight / "index.json",
        "preflight_report_json": preflight / "report.json",
        "preflight_report_md": preflight / "report.md",
        "work_report_dir": work / "report",
        "logs": work / "logs",
        "archive": work / "archive",
        "draft_dir": work / "draft",
        "bgm_dir": work / "bgm",
        "output": root / "output",
        "report_out": root / "report",
        "paragraphs_txt": meta / "paragraphs.txt",
        "paragraphs_jsonl": meta / "paragraphs.jsonl",
        "ep_index": meta / "ep_index.json",
        "format_json": meta / "format.json",
        "format_rules": meta / "format_rules.md",
        "facts_lock": meta / "facts_lock.md",
        "handoff": meta / "handoff.json",
        "progress": meta / "progress.json",
        "import_json": meta / "import.json",
        "steps_json": meta / "steps.json",
        "engine_json": meta / "engine.json",
        "protagonist_meta": meta / "protagonist.json",
        "project_json": root / "project.json",
    }


def ensure_dirs(paths: dict) -> None:
    for key in ("inbox", "source_dir", "meta", "checks_dir", "work_report_dir",
                "logs", "archive", "draft_dir", "bgm_dir", "output", "report_out"):
        Path(paths[key]).mkdir(parents=True, exist_ok=True)


def _slug(text: str) -> str:
    out = "".join(ch.lower() if ch.isalnum() and ch.isascii() else "-" for ch in text)
    out = "-".join(part for part in out.split("-") if part)
    return (out or "project")[:64]


def _skeleton_project(paths: dict, docx: Path, source_sha: str, source_bytes: int,
                      options: dict, rid: str) -> dict:
    root: Path = paths["project_root"]
    rel = f"剧本输入/{docx.name}"
    now = now_iso()
    title = docx.stem
    return {
        "schema": SCHEMA_PROJECT,
        "project_id": project_id(),
        "id": root.name,
        "slug": _slug(root.name),
        "title": title,
        "created_at": now,
        "createdAt": now,
        "updated_at": now,
        "updatedAt": now,
        "pipeline": {"preflight": PRECHECK_VERSION},
        "pipeline_version": VERSION,
        "engine_version": VERSION,
        "components": {
            "preflight": VERSION,
            "refine": "1.0.0",
            "bgm": "1.0.0",
            "checks": dict(CHECK_VERSIONS),
        },
        "input": {
            "mode": "A",
            "files": [{
                "name": docx.name, "rel_path": rel,
                "sha256": source_sha, "bytes": source_bytes,
            }],
            "source_sha256": source_sha,
            "docx": rel,
            "paragraphs": "work/meta/paragraphs.jsonl",
        },
        "source": {"file": rel, "name": docx.name, "sha256": source_sha, "bytes": source_bytes},
        "options": options,
        "episodes": {"count": 0, "first": 0, "last": 0, "index": "work/meta/ep_index.json"},
        "blocked_eps": [],
        "status": "importing",
        "last_run_id": rid,
        "check_basis": "standardized",
        "source_sha256": source_sha,
        "config_hash": None,
        "content_hash": None,
    }


def _build_options(project_root: Path) -> tuple[dict, dict, dict, dict, str, list[str]]:
    culture = load_culture_profile(project_root)
    shot = load_shot_profile(project_root)
    check_profile, check_source, profile_warnings, _file_present = load_check_profile(
        project_root, culture)
    effective_culture = check_profile.get("culture") or {}
    effective_spoken = check_profile.get("spoken_words") or {}
    options = {
        "min_words": int(effective_spoken.get("min", 100)),
        "max_words": int(effective_spoken.get("max", 350)),
        "forbid_cn_elements": bool(effective_culture.get("forbid_cn_elements",
                                                          culture.get("forbid_cn_elements"))),
        "allowed_terms": list(effective_culture.get("allowed_terms",
                                                    culture.get("allowed_terms") or [])),
        "standardize": "M0",
        "ai_assist": {
            "enabled": False,
            "max_calls": 2,
            "max_input_tokens": 8000,
            "max_output_tokens": 1500,
            "auto_accept_confidence": 0.85,
        },
        "entry_gate": {"include_spoken_fail": False},
    }
    return options, culture, shot, check_profile, check_source, profile_warnings


def _config_hash(options: dict, culture: dict, shot: dict, check_profile: dict) -> str:
    return hash_obj({
        "options": options,
        "culture": {"forbid": culture.get("forbid_cn_elements"),
                    "allowed": culture.get("allowed_terms")},
        "shot": shot.get("coverage"),
        "check_profile": check_profile,
        "checks": CHECK_VERSIONS,
    })


def _archive_previous(paths: dict, rid: str) -> None:
    dest = paths["archive"] / f"run_{rid}_previous"
    moved = []
    for key in ("source_dir", "meta", "preflight", "work_report_dir"):
        src = Path(paths[key])
        if src.exists():
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                if dest.exists():
                    shutil.rmtree(dest, ignore_errors=True)
                dest.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dest / src.name))
                moved.append(src.name)
            except OSError:
                pass
    if moved:
        for key in ("source_dir", "meta", "checks_dir", "work_report_dir"):
            Path(paths[key]).mkdir(parents=True, exist_ok=True)


def _write_engine_meta(paths: dict, rid: str) -> None:
    write_json(paths["engine_json"], {
        "schema": "lianben/engine/1",
        "version": VERSION,
        "pipeline_version": VERSION,
        "bundle_version": "0.1.0-m1",
        "run_id": rid,
        "python_engine": "lianben2",
        "copied_at": now_iso(),
        "defaults": sorted(p.name for p in DEFAULTS_DIR.glob("*")) if DEFAULTS_DIR.exists() else [],
    })


# ---------------------------------------------------------------------------
# checks orchestration
# ---------------------------------------------------------------------------
def _run_one(ctx: dict, cid: str, fn) -> dict:
    try:
        return fn(ctx)
    except Exception as exc:  # isolation: one broken check must not kill the report
        import sys
        import traceback
        print(f"[WARN] check {cid} failed: {exc}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return {
            "schema": "lianben/check/1",
            "check": cid,
            "version": CHECK_VERSIONS[cid],
            "run_id": ctx["run_id"],
            "generated_at": ctx["generated_at"],
            "check_basis": "standardized",
            "source_sha256": ctx["source_sha256"],
            "config_hash": ctx["config_hash"],
            "status": "ERROR",
            "blocking": cid == "protagonist",
            "summary": {"status": "ERROR", "error": str(exc)},
            "results": [],
            "compat": {"legacy_file": ""},
            "risky_eps": [],
            "blocked_eps": [],
        }


def _apply_progress(paths: dict, ctx: dict, protagonist: dict) -> list[int]:
    progress = ctx.get("progress") or {"episodes": {}}
    progress.setdefault("episodes", {})
    updates = protagonist.get("progress_blocked") or {}
    row_by_ep = {r["ep"]: r for r in protagonist.get("results", [])}
    for ep in ctx["episodes"]:
        key = str(ep["ep"])
        cur = progress["episodes"].setdefault(key, {"status": "pending", "attempts": 0, "reasons": []})
        blocked = bool(updates.get(ep["ep"]))
        if blocked:
            row = row_by_ep.get(ep["ep"], {})
            cur["status"] = "blocked"
            cur["reasons"] = [f"protagonist:{row.get('status', 'BLOCKED')}", row.get("reason", "")]
        elif cur.get("status") == "blocked":
            cur["status"] = "pending"
            cur["reasons"] = []
    progress["updated"] = now_iso()
    write_json(paths["progress"], progress)
    return protagonist.get("blocked_eps", [])


# ---------------------------------------------------------------------------
# main entry
# ---------------------------------------------------------------------------
def run_preflight(root_arg: str, source_arg: str | None = None, force: bool = False,
                  events: bool = False) -> dict:
    started = time.time()
    emitter = EventEmitter(events)
    root = Path(root_arg).expanduser()
    try:
        root = root.resolve()
    except OSError as exc:
        raise IOProblem(f"项目路径无效：{root_arg}: {exc}") from exc
    if root.exists() and not root.is_dir():
        raise FatalError(f"--root 不是目录：{root}")
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise IOProblem(f"无法创建项目目录：{exc}") from exc

    paths = build_paths(root)
    ensure_dirs(paths)
    rid = run_id()

    try:
        docx = resolve_source_docx(root, source_arg)
    except FatalError:
        raise
    except (OSError, PermissionError) as exc:
        raise IOProblem(f"读取源 docx 失败：{exc}") from exc

    source_sha = sha256_file(docx)
    source_bytes = docx.stat().st_size
    options, culture, shot, check_profile, check_source, profile_warnings = _build_options(root)
    cfg_hash = _config_hash(options, culture, shot, check_profile)
    emitter.info("preflight started")
    for warning in profile_warnings:
        emitter.warn(warning)

    if force:
        _archive_previous(paths, rid)

    project = load_json_safe(paths["project_json"], None)
    if not isinstance(project, dict) or project.get("schema") != SCHEMA_PROJECT:
        project = _skeleton_project(paths, docx, source_sha, source_bytes, options, rid)
    project["last_run_id"] = rid
    project["updated_at"] = now_iso()
    project["updatedAt"] = project["updated_at"]
    project["options"] = options
    project["checkProfile"] = {
        "schema": "lianben/check-profile/1",
        "source": check_source,
        "effective": check_profile,
        "warnings": list(profile_warnings),
        "file": "check-profile.json",
    }
    project["source"] = {"file": f"剧本输入/{docx.name}", "name": docx.name,
                         "sha256": source_sha, "bytes": source_bytes}
    project["source_sha256"] = source_sha
    project["config_hash"] = cfg_hash
    project["status"] = "running"
    write_json(paths["project_json"], project)

    _write_engine_meta(paths, rid)

    # ---- extract ----
    emitter.phase("extract")
    try:
        paragraphs = extract_paragraphs(docx)
    except FatalError:
        raise
    except (OSError, PermissionError) as exc:
        raise IOProblem(f"docx 读取失败（可能被占用）：{exc}") from exc
    if not paragraphs:
        raise FatalError("docx 未抽取到任何段落")
    write_paragraph_files(paths, paragraphs)

    # ---- detect ----
    emitter.phase("detect")
    det_result = detect(paragraphs)
    detection = det_result["detection"]
    fmt = det_result["format"]
    fmt["source_sha256"] = source_sha
    write_format_files(paths, fmt, source_sha)

    if detection["needs_confirm"]:
        write_json(paths["import_json"], {
            "schema": "lianben/import/1",
            "run_id": rid,
            "mode": detection["mode"],
            "confidence": detection["confidence"],
            "score_breakdown": detection["components"],
            "needs_confirm": True,
            "reject_reason": (detection["reasons"] or [None])[0],
            "files": [{"name": docx.name, "sha256": source_sha, "bytes": source_bytes}],
            "g0": {"extractable": True, "episodes_found": detection["episode_count"],
                   "unique": False, "ascending": False},
            "g2": {"status": "SKIP", "failed_eps": []},
            "format_provenance": "machine",
        })
        project["status"] = "needs_confirm"
        project["updated_at"] = now_iso()
        project["updatedAt"] = project["updated_at"]
        write_json(paths["project_json"], project)
        emitter.warn("格式识别置信度不足，needs_confirm："
                     + "；".join(detection.get("reasons") or []))
        raise NeedsConfirm("格式识别置信度不足，需人工确认", detection)

    # ---- split + M0 ----
    emitter.phase("split")
    episodes = build_episodes(paragraphs, detection)
    emitter.phase("normalize")
    write_source_episodes(paths, episodes, emitter)
    ep_index = write_ep_index(paths, episodes, paragraphs, source_sha, docx.name)
    write_facts_and_handoff(paths, episodes, paragraphs)
    progress = write_progress(paths, episodes)
    _write_engine_meta(paths, rid)
    write_json(paths["import_json"], {
        "schema": "lianben/import/1",
        "run_id": rid,
        "mode": detection["mode"],
        "confidence": detection["confidence"],
        "score_breakdown": detection["components"],
        "needs_confirm": False,
        "reject_reason": None,
        "files": [{"name": docx.name, "sha256": source_sha, "bytes": source_bytes}],
        "g0": {"extractable": True, "episodes_found": len(episodes),
               "unique": True, "ascending": True},
        "g2": {"status": "PASS", "failed_eps": []},
        "format_provenance": "machine",
    })

    generated_at = now_iso()
    ctx = {
        "project_root": root,
        "paths": paths,
        "project": project,
        "episodes": episodes,
        "ep_index": ep_index,
        "paragraphs": paragraphs,
        "format": fmt,
        "detection": detection,
        "options": options,
        "culture_profile": culture,
        "shot_profile": shot,
        "progress": progress,
        "run_id": rid,
        "generated_at": generated_at,
        "source_name": docx.name,
        "source_sha256": source_sha,
        "config_hash": cfg_hash,
        "check_profile": check_profile,
        "check_profile_source": check_source,
        "check_profile_warnings": list(profile_warnings),
        "emitter": emitter,
    }

    # ---- checks: protagonist gate first, then the other four ----
    emitter.phase("protagonist")
    checks: dict[str, dict] = {
        "protagonist": _run_one(ctx, "protagonist", check_protagonist),
    }
    emitter.phase("checks")
    for cid, fn in (("spoken_words", check_spoken_words),
                    ("punctuation", check_punctuation),
                    ("pacing", check_pacing),
                    ("culture", check_culture)):
        checks[cid] = _run_one(ctx, cid, fn)

    # ---- protagonist hard gate -> progress ----
    blocked_eps = _apply_progress(paths, ctx, checks["protagonist"])
    project["blocked_eps"] = blocked_eps
    project["episodes"] = {"count": len(episodes), "first": episodes[0]["ep"] if episodes else 0,
                           "last": episodes[-1]["ep"] if episodes else 0,
                           "index": "work/meta/ep_index.json"}
    project["stats"] = ep_index.get("statistics", {})
    project["config_hash"] = cfg_hash

    # ---- reports ----
    emitter.phase("report")
    write_json(paths["meta"] / "check_profile.json", {
        "schema": "lianben/check-profile/1",
        "source": check_source,
        "effective": check_profile,
        "warnings": list(profile_warnings),
    })
    write_check_files(paths, checks)
    index = build_index(ctx, checks)
    report_paths = write_reports(paths, ctx, checks, index)

    project["content_hash"] = index["content_hash"]
    project["status"] = "preflight_done"
    project["updated_at"] = now_iso()
    project["updatedAt"] = project["updated_at"]
    write_json(paths["project_json"], project)

    duration_ms = int((time.time() - started) * 1000)
    write_text(paths["logs"] / f"preflight_{rid}.log",
               f"run_id={rid}\nepisodes={len(episodes)} confidence={detection['confidence']}\n"
               f"blocked_eps={blocked_eps}\ncheck_profile_source={check_source}\n"
               f"duration_ms={duration_ms}\n")

    emitter.info(f"preflight done: episodes={len(episodes)} blocked={blocked_eps} "
                 f"duration_ms={duration_ms}")
    return build_stdout(ctx, checks, index, report_paths, duration_ms)
