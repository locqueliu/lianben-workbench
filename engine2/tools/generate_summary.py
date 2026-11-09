"""
生成炼本总修改优化说明文件 work/report/production_summary.md。
合并全部集数的制作说明、炼本前置修改记录、前置质检报告摘要和降级通过问题清单，
输出一份独立总文件。
用法：python tools/generate_summary.py
"""
import datetime
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C


def read_safe(path):
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def strip_h1(text):
    """Remove the first line if it is a Markdown H1 heading."""
    lines = text.splitlines()
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
    return "\n".join(lines).strip()


def repair_rows(root, eps):
    """
    Read work/preflight/optimized/epNN.json for every episode and return a list of
    dicts ready for the repair table:
      {"ep": n, "type": "must_fix"|"suspected", "item": str, "action": str}
    """
    rows = []
    for n in eps:
        rec = C.load_json(root / "work" / "preflight" / "optimized" / f"ep{n:02d}.json", {})
        items = rec.get("items", [])
        for item in items:
            if isinstance(item, dict):
                row_type = item.get("type", "must_fix")
                problem  = item.get("problem", item.get("item", str(item)))
                action   = item.get("action", item.get("repair", "—"))
            else:
                row_type = "must_fix"
                problem  = str(item)
                action   = "（已修复，见修复文件）"
            rows.append({"ep": n, "type": row_type, "problem": problem, "action": action})
    return rows


def main():
    root = C.ROOT
    progress  = C.load_json(root / "work" / "meta" / "progress.json", {"episodes": {}})
    ep_index  = C.load_json(root / "work" / "meta" / "ep_index.json", {})

    if not ep_index:
        print("[FAIL] ep_index.json not found; run split_docx.py first")
        return 2

    eps = sorted(e["ep"] for e in ep_index.get("episodes", []))
    if not eps:
        print("[FAIL] no episodes in ep_index.json")
        return 2

    ep_statuses = {int(k): v for k, v in progress.get("episodes", {}).items()}

    passed     = [n for n in eps if ep_statuses.get(n, {}).get("status") == "passed"]
    issues     = [n for n in eps if ep_statuses.get(n, {}).get("status") == "passed-with-issues"]
    not_passed = [n for n in eps if ep_statuses.get(n, {}).get("status") not in ("passed", "passed-with-issues")]

    out = []

    # ── Header ──────────────────────────────────────────────────────────────
    out.append("# 炼本总修改优化说明\n")
    out.append(f"生成时间：{datetime.datetime.now().isoformat(timespec='seconds')}\n")
    out.append(f"剧集范围：EP{eps[0]:02d}–EP{eps[-1]:02d}（共 {len(eps)} 集）\n\n")

    # ── Overview table ───────────────────────────────────────────────────────
    out.append("## 总览\n\n")
    out.append("| 状态 | 集数 | 集号 |\n")
    out.append("|------|:----:|------|\n")
    out.append(f"| 通过 | {len(passed)} | {', '.join(f'EP{n:02d}' for n in passed) or '—'} |\n")
    out.append(f"| 降级通过（含问题） | {len(issues)} | {', '.join(f'EP{n:02d}' for n in issues) or '—'} |\n")
    out.append(f"| 未通过 | {len(not_passed)} | {', '.join(f'EP{n:02d}' for n in not_passed) or '—'} |\n\n")

    # ── Pre-flight report summary ────────────────────────────────────────────
    preflight = root / "work" / "preflight" / "report.md"
    if preflight.exists():
        content = read_safe(preflight).strip()
        if content:
            out.append("## 前置质检报告摘要\n\n")
            out.append(strip_h1(content))
            out.append("\n\n")

    # ── Pre-enrichment repair table ──────────────────────────────────────────
    out.append("## 炼本前置修改说明\n\n")
    out.append("以下为阶段 1（episode-optimizer 修复优化）在炼本前对全部集数执行的修改，"
               "涵盖前置质检报告中的已确认问题（must_fix）、疑似问题（suspected）与动作丰富。\n\n")

    rows = repair_rows(root, eps)
    must_rows      = [r for r in rows if r["type"] != "suspected"]
    suspected_rows = [r for r in rows if r["type"] == "suspected"]

    if must_rows:
        out.append("### 已确认问题修复（must_fix）\n\n")
        out.append("| 集号 | 问题描述 | 修复说明 |\n")
        out.append("|------|---------|----------|\n")
        for r in must_rows:
            prob = r["problem"].replace("|", "｜").replace("\n", " ")
            act  = r["action"].replace("|", "｜").replace("\n", " ")
            out.append(f"| EP{r['ep']:02d} | {prob} | {act} |\n")
        out.append("\n")
    else:
        out.append("### 已确认问题修复（must_fix）\n\n_无已确认修复记录_\n\n")

    if suspected_rows:
        out.append("### 疑似问题处理（suspected）\n\n")
        out.append("| 集号 | 疑似问题描述 | 处理说明 |\n")
        out.append("|------|------------|----------|\n")
        for r in suspected_rows:
            prob = r["problem"].replace("|", "｜").replace("\n", " ")
            act  = r["action"].replace("|", "｜").replace("\n", " ")
            out.append(f"| EP{r['ep']:02d} | {prob} | {act} |\n")
        out.append("\n")
    else:
        out.append("### 疑似问题处理（suspected）\n\n_无疑似问题处理记录_\n\n")

    # ── Per-episode production notes ─────────────────────────────────────────
    out.append("## 各集炼本修改优化说明\n\n")
    for n in eps:
        notes_path = root / "work" / "report" / f"ep{n:02d}_production_notes.md"
        status     = ep_statuses.get(n, {}).get("status", "unknown")
        status_tag = "" if status == "passed" else f"（{status}）"
        out.append(f"### EP{n:02d}{status_tag}\n\n")
        notes = read_safe(notes_path).strip()
        if notes:
            out.append(strip_h1(notes))
        else:
            out.append("_制作说明文件未找到_")
        out.append("\n\n---\n\n")

    # ── Passed-with-issues detail ────────────────────────────────────────────
    if issues:
        out.append("## 降级通过集问题说明\n\n")
        for n in issues:
            issue_path = root / "work" / "report" / f"ep{n:02d}_issue.md"
            out.append(f"### EP{n:02d} 问题明细\n\n")
            issue_text = read_safe(issue_path).strip()
            if issue_text:
                out.append(strip_h1(issue_text))
            else:
                out.append("_问题说明文件未找到_")
            out.append("\n\n---\n\n")

    # ── Write ────────────────────────────────────────────────────────────────
    out_path = root / "work" / "report" / "production_summary.md"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("".join(out), encoding="utf-8")

    repair_count = len(rows)
    print(f"[OK] production_summary.md written — "
          f"{len(eps)} eps | passed={len(passed)} issues={len(issues)} failed={len(not_passed)} "
          f"repair_items={repair_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
