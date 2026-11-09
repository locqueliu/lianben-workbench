#!/usr/bin/env python3
"""Migrate a legacy lianben project (no project.json) into the new project store.

Legacy layout (as produced by the old opencode workflow):
    剧本输入/<one>.docx
    work/{source,meta,preflight,report,draft,bgm,logs}/...
    output/ tools/ 参考资料/  (+ legacy root configs)

New layout: <projects-root>/<id>/ with project.json (lianben/project/1) and
work/meta/ep_index.json#docx rewritten to a project-relative path.

Usage:
    python tools/migrate_legacy.py --source <legacy-project> --projects-root <dir>
        [--title T] [--id ID] [--dry-run] [--json]

Safety:
- never writes to --source (read-only copy);
- refuses if the target directory already exists or target == source;
- on copy failure the partial target is removed, source is untouched;
- --dry-run validates and prints the plan without creating anything.

Exit codes: 0 ok (incl. dry-run); 2 invalid args/source or target exists;
            3 write/copy failure.

0 LLM, stdlib only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_PROJECT = "lianben/project/1"
COPY_DIRS = ("剧本输入", "work", "output", "tools", "参考资料")
EXCLUDE_DOCX_NAME_PARTS = ("导演执行版", "配乐方案", "质检报告")
PROJECT_ID_RE = re.compile(r"^p-[a-z0-9]+-[a-z0-9]{4,12}$")
EP_RE = re.compile(r"^#?\s*第\s*(\d+)\s*集")
EN_EP_RE = re.compile(r"(?i:episode)\s*\d+")
SCENE_RE = re.compile(r"^\d{1,3}\s*[-－]\s*\d{1,3}\s")


class MigrateError(Exception):
    def __init__(self, message: str, code: int = 2):
        super().__init__(message)
        self.message = message
        self.code = code

    def to_dict(self) -> dict:
        return {"ok": False, "error": self.message,
                "code": "INVALID" if self.code == 2 else "WRITE_FAILED"}


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_json(path: Path, default=None):
    try:
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError):
        return default


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(obj, ensure_ascii=False, indent=1) + "\n")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def cjk_count(text: str) -> int:
    return len(re.findall(r"[\u4e00-\u9fff]", text or ""))


def is_inside(parent: Path, child: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except (ValueError, OSError):
        return False


def gen_id() -> str:
    stamp = time.strftime("%Y%m%d%H%M%S")
    return f"p-mig{stamp}-{secrets.token_hex(2)}"


def dir_plan(path: Path) -> dict:
    files = 0
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            files += 1
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return {"files": files, "bytes": total}


# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------
def validate_source(source: Path) -> dict:
    if not source.exists():
        raise MigrateError(f"--source 不存在：{source}")
    if not source.is_dir():
        raise MigrateError(f"--source 不是目录：{source}")
    inbox = source / "剧本输入"
    if not inbox.is_dir():
        raise MigrateError(f"源项目缺少 剧本输入/：{inbox}")
    docx_list = []
    for p in sorted(inbox.glob("*.docx"), key=lambda x: x.name.lower()):
        name = p.name
        if name.startswith("~$"):
            continue
        if any(part in name for part in EXCLUDE_DOCX_NAME_PARTS):
            continue
        docx_list.append(p)
    if not docx_list:
        raise MigrateError("源项目 剧本输入/ 中没有可用 docx（忽略 ~$ 与成品）")
    if len(docx_list) > 1:
        names = "、".join(p.name for p in docx_list)
        raise MigrateError(f"源项目有多个可用 docx，请只保留一个：{names}")
    ep_files = sorted((source / "work" / "source").glob("ep*.md"),
                      key=lambda p: p.name)
    if not ep_files:
        raise MigrateError("源项目缺少 work/source/epNN.md，无法迁移")
    return {"docx": docx_list[0], "ep_files": ep_files,
            "source": source.resolve()}


def plan_dirs(source: Path) -> list[dict]:
    plan = []
    for name in COPY_DIRS:
        p = source / name
        if p.is_dir():
            info = dir_plan(p)
            plan.append({"name": name, "present": True, **info})
        else:
            plan.append({"name": name, "present": False, "files": 0, "bytes": 0})
    return plan


# ---------------------------------------------------------------------------
# legacy metadata -> new project
# ---------------------------------------------------------------------------
def _risky_eps(check: dict) -> list[int]:
    out = []
    for value in check.get("risky_eps") or []:
        try:
            out.append(int(value))
        except (TypeError, ValueError):
            continue
    return sorted(set(out))


def _blocked_eps(prot: dict) -> list[int]:
    out = []
    for value in prot.get("blocked_eps") or []:
        try:
            out.append(int(value))
        except (TypeError, ValueError):
            continue
    return sorted(set(out))


def derive_summary(target: Path, project_id: str, title: str,
                   ep_index: dict, options: dict, check_profile: dict) -> dict:
    episodes = list(ep_index.get("episodes") or [])
    eps = []
    for e in episodes:
        try:
            eps.append(int(e.get("ep", 0)))
        except (TypeError, ValueError):
            continue
    eps = sorted(set(eps))
    pre = target / "work" / "preflight"
    spoken = load_json(pre / "spoken_words.json", {}) or {}
    punct = load_json(pre / "punctuation.json", {}) or {}
    atom = load_json(pre / "atom_pacing.json", {}) or {}
    dialogue = load_json(pre / "dialogue_density.json", {}) or {}
    culture = load_json(pre / "culture.json", {}) or {}
    prot = load_json(pre / "protagonist.json", {}) or {}
    report = load_json(pre / "report.json", {}) or {}

    blocked = _blocked_eps(prot)
    spoken_failed = [int(x) for x in (spoken.get("failed_eps") or [])
                     if str(x).isdigit()]
    punct_risky = _risky_eps(punct)
    atom_risky = _risky_eps(atom)
    dlg_risky = _risky_eps(dialogue)
    pacing_risky = sorted(set(atom_risky + dlg_risky))
    culture_risky = _risky_eps(culture)
    if not culture_risky:
        culture_risky = sorted({int(r.get("ep")) for r in (culture.get("results") or [])
                                if isinstance(r, dict)
                                and r.get("severity") in ("must_fix", "suspected")
                                and str(r.get("ep", "")).isdigit()})
    punct_rows = {}
    for r in (spoken.get("results") or []):
        if isinstance(r, dict) and str(r.get("ep", "")).isdigit():
            punct_rows[int(r["ep"])] = r
    prot_status = {}
    for r in (prot.get("episodes") or []):
        if isinstance(r, dict) and str(r.get("ep", "")).isdigit():
            prot_status[int(r["ep"])] = str(r.get("status") or "OK")
    ep_by_no = {int(e.get("ep", 0)): e for e in episodes
                if str(e.get("ep", "")).isdigit()}

    ep_rows = []
    risk_any = False
    for ep in eps:
        meta = ep_by_no.get(ep, {})
        ep_spoken = punct_rows.get(ep) or {}
        spoken_status = str(ep_spoken.get("status") or
                            ("RISK" if ep in spoken_failed else "OK"))
        ep_punct = "RISK" if ep in punct_risky else "OK"
        ep_pacing = "RISK" if ep in pacing_risky else "OK"
        pro_status = prot_status.get(ep) or ("BLOCKED" if ep in blocked else "OK")
        if pro_status in ("NO_PROTAGONIST", "LOW_PROTAGONIST"):
            pro_status = "BLOCKED"
        ep_culture = "RISK" if ep in culture_risky else "OK"
        is_blocked = ep in blocked
        any_risk = (str(ep_spoken.get("status", "")).startswith("FAIL")
                    or ep_punct == "RISK" or ep_pacing == "RISK"
                    or ep_culture == "RISK" or pro_status in ("BLOCKED", "BORDERLINE"))
        status = "BLOCKED" if is_blocked else ("RISK" if any_risk else "OK")
        if status != "OK":
            risk_any = True
        ep_rows.append({
            "ep": ep,
            "title": str(meta.get("title") or ""),
            "status": status,
            "blocked": bool(is_blocked),
            "cjk": int(meta.get("cjk") or 0),
            "scenes": int(meta.get("scenes") or 0),
            "dialogue_lines": int(meta.get("dialogue_lines") or 0),
            "atom_lines": int(meta.get("atoms") or meta.get("atom_lines") or 0),
            "checks": {
                "spoken_words": {"status": spoken_status,
                                 "value": int(ep_spoken.get("count") or 0)},
                "punctuation": {"status": ep_punct},
                "pacing": {"status": ep_pacing},
                "protagonist": {"status": pro_status},
                "culture": {"status": ep_culture},
            },
        })

    checks = {
        "spoken_words": {"status": "RISK" if spoken_failed else "OK",
                         "risky_eps": spoken_failed},
        "punctuation": {"status": "RISK" if punct_risky else "OK",
                        "risky_eps": punct_risky},
        "pacing": {"status": "RISK" if pacing_risky else "OK",
                   "risky_eps": pacing_risky},
        "protagonist": {"status": "BLOCKED" if blocked else "OK",
                        "blocked_eps": blocked, "risky_eps": blocked},
        "culture": {"status": "RISK" if culture_risky else "OK",
                    "risky_eps": culture_risky},
    }
    cjk = sum(int(e.get("cjk") or 0) for e in episodes)
    episodes_count = len(eps)
    summary = {
        "schema": "lianben2/engine/1",
        "version": "1.0.0",
        "project": {
            "id": project_id,
            "title": title,
            "episodes": episodes_count,
            "cjk": cjk,
            "blocked_eps": blocked,
            "durationMs": None,
        },
        "detection": {
            "mode": "A" if episodes_count >= 2 else "B",
            "confidence": 1.0,
            "episode_count": episodes_count,
        },
        "checks": checks,
        "episodes": ep_rows,
        "report": {"md": "work/preflight/report.md", "docx": None},
        "effectiveCheckProfile": check_profile,
        "checkProfileSource": "default",
        "ai_used": False,
        "migrated": True,
        "legacy": {
            "rating": report.get("rating"),
            "entry_gate": report.get("entry_gate"),
            "must_fix": len(report.get("must_fix") or []),
            "suspected": len(report.get("suspected") or []),
            "reviewed_at": report.get("reviewed_at"),
        },
        "status": "RISK" if (risk_any or blocked) else "OK",
        "options": options,
    }
    return summary


def default_check_profile(options: dict) -> dict:
    return {
        "schema": "lianben/check-profile/1",
        "source": "default",
        "effective": {
            "spoken_words": {"min": int(options["min_words"]),
                             "max": int(options["max_words"])},
            "pacing": {
                "max_atom_run": 4,
                "max_atoms_per_spoken": 3.0,
                "dup_similarity": 0.5,
                "max_dup_pairs": 1,
                "max_spoken_run": 8,
                "min_atoms_per_spoken": 0.5,
                "spoken_floor": 10,
            },
            "culture": {
                "forbid_cn_elements": bool(options.get("forbid_cn_elements")),
                "allowed_terms": list(options.get("allowed_terms") or []),
            },
        },
        "warnings": [],
    }


def build_options(source: Path) -> dict:
    culture = load_json(source / "culture-profile.json", {}) or {}
    if not isinstance(culture, dict):
        culture = {}
    return {
        "min_words": 100,
        "max_words": 350,
        "forbid_cn_elements": bool(culture.get("forbid_cn_elements", False)),
        "allowed_terms": list(culture.get("allowed_terms") or []),
        "standardize": "M0",
        "ai_assist": {
            "enabled": False,
            "max_calls": 2,
            "max_input_tokens": 8000,
            "max_output_tokens": 1500,
            "auto_accept_confidence": 0.85,
        },
        "entry_gate": {"include_spoken_fail": False},
        "check_overrides": {},
        "legacy_market": culture.get("market", "auto"),
        "legacy_setting": culture.get("setting", ""),
    }


# ---------------------------------------------------------------------------
# ep_index rebuild / fix
# ---------------------------------------------------------------------------
def rebuild_ep_index(target: Path, docx_rel: str, docx_sha: str) -> dict:
    source_dir = target / "work" / "source"
    episodes = []
    total_lines = 0
    for p in sorted(source_dir.glob("ep*.md"), key=lambda x: x.name):
        lines = [x.strip() for x in read_text(p).splitlines() if x.strip()]
        if not lines:
            continue
        m = EP_RE.match(lines[0])
        if not m:
            continue
        ep = int(m.group(1))
        title_en = ""
        if len(lines) > 1 and EN_EP_RE.search(lines[1]):
            title_en = lines[1]
        body = lines[1:]
        episodes.append({
            "ep": ep,
            "title": lines[0],
            "title_en": title_en,
            "para_start": -1,
            "para_end": -1,
            "lines": len(lines),
            "cjk": cjk_count("\n".join(lines)),
            "atoms": sum(1 for x in body if x.startswith("△")),
            "scenes": sum(1 for x in body if SCENE_RE.match(x)),
        })
        total_lines += len(lines)
    paragraphs_txt = target / "work" / "meta" / "paragraphs.txt"
    total_paragraphs = len(paragraphs_txt.read_text(encoding="utf-8-sig").splitlines()) \
        if paragraphs_txt.exists() else total_lines
    data = {
        "docx": docx_rel,
        "source_sha256": docx_sha,
        "total_paragraphs": total_paragraphs,
        "episodes": episodes,
        "generated_at": now_iso(),
        "rebuilt": True,
    }
    write_json(target / "work" / "meta" / "ep_index.json", data)
    return data


def fix_ep_index(target: Path, docx_rel: str, docx_sha: str) -> tuple[dict, str]:
    epi_path = target / "work" / "meta" / "ep_index.json"
    data = load_json(epi_path, None)
    if not isinstance(data, dict):
        return rebuild_ep_index(target, docx_rel, docx_sha), "rebuilt"
    data["docx"] = docx_rel
    data["source_sha256"] = docx_sha
    data["migrated_at"] = now_iso()
    write_json(epi_path, data)
    return data, "fixed"


# ---------------------------------------------------------------------------
# migration
# ---------------------------------------------------------------------------
def migrate(source_arg: str, projects_root_arg: str, title: str | None = None,
            dry_run: bool = False, project_id: str | None = None) -> dict:
    source = Path(source_arg).expanduser()
    projects_root = Path(projects_root_arg).expanduser()
    info = validate_source(source)
    source = info["source"]
    docx_src: Path = info["docx"]
    ep_files: list[Path] = info["ep_files"]

    if project_id is not None:
        if not PROJECT_ID_RE.match(project_id):
            raise MigrateError(
                f"--id 不符合 Host 项目 id 规则 {PROJECT_ID_RE.pattern}：{project_id}")
        target = projects_root / project_id
    else:
        target = projects_root / gen_id()
        tries = 0
        while target.exists() and tries < 5:
            target = projects_root / gen_id()
            tries += 1
    project_id = target.name
    if not PROJECT_ID_RE.match(project_id):
        raise MigrateError(f"生成的项目 id 不合法：{project_id}")

    if target.resolve() == source.resolve():
        raise MigrateError("source 与 target 相同，拒绝迁移")
    if is_inside(source, target) or is_inside(target, source):
        raise MigrateError("target 与 source 相互包含，拒绝迁移（避免递归复制）")

    dirs_plan = plan_dirs(source)
    title_final = (title or "").strip() or docx_src.stem
    status = "preflight_done" if (source / "work" / "preflight" / "report.json").exists() \
        else "imported"

    if dry_run:
        return {
            "ok": True,
            "dryRun": True,
            "id": project_id,
            "projectId": project_id,
            "path": str(target),
            "projectDir": str(target),
            "source": str(source),
            "projectsRoot": str(projects_root),
            "title": title_final,
            "status": status,
            "episodes": len(ep_files),
            "docx": docx_src.name,
            "plan": dirs_plan,
            "wouldCreate": str(target),
            "noWrites": True,
        }

    if projects_root.exists() and not projects_root.is_dir():
        raise MigrateError(f"--projects-root 不是目录：{projects_root}", code=3)
    try:
        projects_root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise MigrateError(f"无法创建 projects-root：{exc}", code=3) from exc
    if target.exists():
        raise MigrateError(f"目标项目已存在，拒绝覆盖：{target}")

    copied = []
    try:
        target.mkdir(parents=False, exist_ok=False)
        for name in COPY_DIRS:
            src_dir = source / name
            if not src_dir.is_dir():
                continue
            shutil.copytree(src_dir, target / name, symlinks=False)
            copied.append(name)
    except FileExistsError as exc:
        shutil.rmtree(target, ignore_errors=True)
        raise MigrateError(f"目标项目已存在，拒绝覆盖：{target}") from exc
    except OSError as exc:
        shutil.rmtree(target, ignore_errors=True)
        raise MigrateError(f"复制失败（已回滚部分目标，源项目未改动）：{exc}",
                           code=3) from exc

    try:
        docx_rel = f"剧本输入/{docx_src.name}"
        docx_target = target / docx_rel
        if not docx_target.exists():
            raise MigrateError(f"复制后目标 docx 缺失：{docx_target}", code=3)
        docx_sha = sha256_file(docx_target)
        docx_bytes = docx_target.stat().st_size
        ep_index, ep_index_status = fix_ep_index(target, docx_rel, docx_sha)
        options = build_options(source)
        check_profile = default_check_profile(options)
        episodes = list(ep_index.get("episodes") or [])
        eps = sorted(int(e["ep"]) for e in episodes if str(e.get("ep", "")).isdigit())
        blocked = _blocked_eps(load_json(target / "work/preflight/protagonist.json", {}) or {})
        summary = derive_summary(target, project_id, title_final, ep_index,
                                 options, check_profile)
        stats = {
            "episodes": len(eps),
            "paragraphs": int(ep_index.get("total_paragraphs") or 0),
            "cjk": sum(int(e.get("cjk") or 0) for e in episodes),
            "atoms": sum(int(e.get("atoms") or 0) for e in episodes),
            "scenes": sum(int(e.get("scenes") or 0) for e in episodes),
            "dialogue_lines": sum(int(e.get("dialogue_lines") or 0) for e in episodes),
        }
        created = now_iso()
        project = {
            "schema": SCHEMA_PROJECT,
            "id": project_id,
            "project_id": project_id,
            "title": title_final,
            "createdAt": created,
            "created_at": created,
            "updatedAt": created,
            "updated_at": created,
            "status": status,
            "migrated_from": str(source),
            "migratedAt": created,
            "migrated_at": created,
            "pipeline": {"preflight": "1.0", "refine": "1.0", "bgm": "1.0"},
            "pipeline_version": "1.0.0",
            "engine_version": "1.0.0",
            "components": {"preflight": "1.0.0", "refine": "1.0.0", "bgm": "1.0.0"},
            "source": {
                "file": docx_rel,
                "name": docx_src.name,
                "sha256": docx_sha,
                "bytes": docx_bytes,
            },
            "input": {
                "mode": "A" if len(eps) >= 2 else "B",
                "files": [{
                    "name": docx_src.name,
                    "rel_path": docx_rel,
                    "sha256": docx_sha,
                    "bytes": docx_bytes,
                }],
                "source_sha256": docx_sha,
                "docx": docx_rel,
                "paragraphs": "work/meta/paragraphs.txt",
            },
            "source_sha256": docx_sha,
            "options": options,
            "checkProfile": check_profile,
            "episodes": {
                "count": len(eps),
                "first": eps[0] if eps else 0,
                "last": eps[-1] if eps else 0,
                "index": "work/meta/ep_index.json",
            },
            "blocked_eps": blocked,
            "stats": stats,
            "last_run_id": None,
            "config_hash": None,
            "content_hash": None,
            "preflight": {
                "status": "MIGRATED",
                "startedAt": (summary.get("legacy") or {}).get("reviewed_at"),
                "finishedAt": created,
                "durationMs": None,
                "engineVersion": "1.0.0",
                "reportMd": "work/preflight/report.md"
                if (target / "work/preflight/report.md").exists() else None,
                "reportDocx": None,
                "summary": summary,
                "checkProfileSource": "default",
                "effectiveCheckProfile": check_profile["effective"],
            },
        }
        write_json(target / "project.json", project)
    except MigrateError:
        shutil.rmtree(target, ignore_errors=True)
        raise
    except OSError as exc:
        shutil.rmtree(target, ignore_errors=True)
        raise MigrateError(f"写入新项目失败（已回滚目标，源项目未改动）：{exc}",
                           code=3) from exc
    except Exception as exc:  # keep source intact, report as write failure
        shutil.rmtree(target, ignore_errors=True)
        raise MigrateError(f"迁移失败（已回滚目标，源项目未改动）：{exc}",
                           code=3) from exc

    return {
        "ok": True,
        "dryRun": False,
        "id": project_id,
        "projectId": project_id,      # Host /api/lianben/migrate-legacy contract
        "path": str(target),
        "projectDir": str(target),
        "source": str(source),
        "projectsRoot": str(projects_root),
        "title": title_final,
        "status": status,
        "episodes": len(eps),
        "epIndex": ep_index_status,
        "copied": copied,
        "stats": stats,
        "blocked_eps": blocked,
        "docx": {"name": docx_src.name, "rel_path": docx_rel,
                 "sha256": docx_sha, "bytes": docx_bytes},
        "checkProfileSource": "default",
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _print_result(result: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return
    if not result.get("ok"):
        print(f"[FAIL] {result.get('error')}")
        return
    if result.get("dryRun"):
        print(f"[DRY-RUN] would create {result['wouldCreate']}")
        print(f"  title={result['title']} episodes={result['episodes']} docx={result['docx']}")
        for row in result.get("plan") or []:
            print(f"  - {row['name']}: present={row['present']} "
                  f"files={row['files']} bytes={row['bytes']}")
        return
    print(f"[OK] migrated {result['source']}")
    print(f"  -> {result['path']} (id={result['id']}, title={result['title']}, "
          f"episodes={result['episodes']}, status={result['status']}, "
          f"epIndex={result['epIndex']})")
    print(f"  copied: {', '.join(result.get('copied') or [])}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="迁移旧 lianben 项目（无 project.json）到新项目库")
    ap.add_argument("--source", required=True, help="旧项目绝对路径（只读）")
    ap.add_argument("--projects-root", required=True, help="新项目库目录")
    ap.add_argument("--title", default=None, help="项目标题（默认取 docx 文件名）")
    ap.add_argument("--id", default=None,
                    help=f"可选：指定项目 id（需匹配 {PROJECT_ID_RE.pattern}；供测试/重跑）")
    ap.add_argument("--dry-run", action="store_true", help="只校验并打印迁移计划")
    ap.add_argument("--json", action="store_true", help="输出单行 JSON")
    args = ap.parse_args(argv)
    try:
        result = migrate(args.source, args.projects_root, title=args.title,
                         dry_run=args.dry_run, project_id=args.id)
    except MigrateError as exc:
        payload = exc.to_dict()
        _print_result(payload, args.json)
        return exc.code
    except Exception as exc:  # defensive: never traceback-crash a Host call
        payload = {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                   "code": "INTERNAL"}
        _print_result(payload, args.json)
        return 3
    _print_result(result, args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
