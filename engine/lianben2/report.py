"""Report/index/compat rendering + stdout payload assembly."""
from __future__ import annotations

import json
from pathlib import Path

from . import SCHEMA_CHECK, SCHEMA_INDEX, SCHEMA_PROJECT, VERSION
from .docx_io import build_report_docx
from .util import dumps_line, hash_obj, now_iso, write_json, write_text

CHECK_IDS = ["spoken_words", "punctuation", "pacing", "protagonist", "culture"]
CHECK_RISK_FIELDS = {
    "spoken_words": "risky_eps",
    "punctuation": "risky_eps",
    "pacing": "risky_eps",
    "protagonist": "blocked_eps",
    "culture": "risky_eps",
}


# ---------------------------------------------------------------------------
# check files + legacy projections
# ---------------------------------------------------------------------------
def write_check_files(paths: dict, checks: dict[str, dict]) -> None:
    checks_dir: Path = paths["checks_dir"]
    for cid, chk in checks.items():
        write_json(checks_dir / f"{cid}.json", chk)

    spoken = checks["spoken_words"]
    write_json(paths["preflight"] / "spoken_words.json", {
        "rule": f"{spoken['summary']['min']} <= english_spoken_words <= {spoken['summary']['max']} per episode",
        "unit_definition": spoken.get("unit_definition", ""),
        "min": spoken["summary"]["min"],
        "max": spoken["summary"]["max"],
        "failed_eps": spoken["summary"]["failed_eps"],
        "results": spoken["results"],
        "status": "FAIL" if spoken["summary"]["failed_eps"] else "PASS",
    })

    punct = checks["punctuation"]
    write_json(paths["preflight"] / "punctuation.json", {
        "version": 1,
        "rule": "英文台词正文使用半角 ASCII 标点；不得出现中文全角标点或全角空格。只报告，不自动修改。",
        "scope": "带 DIALOGUE/VO/OS 标签的英文台词正文；不检查中文表演提示。",
        "blocking": False,
        "summary": punct["summary"],
        "results": punct["results"],
    })

    pacing = checks["pacing"]
    atom = pacing["subchecks"]["atom_pacing"]
    write_json(paths["preflight"] / "atom_pacing.json", {
        "rule": "非阻断信息项：连续无台词 △ 段 <= 4 且 △/台词比 <= 3.0 且 相邻近重复 △ 对 <= 1。",
        "merge_semantics": "合并=将连续 △ 段合并为 1 条或少量完整 △，完整保留全部事实与表演动作，只减少 △ 条数，不删减内容。",
        "thresholds": atom["thresholds"],
        "blocking": False,
        "risky_eps": atom["risky_eps"],
        "results": atom["results"],
        "status": atom["status"],
    })
    dialogue = pacing["subchecks"]["dialogue_density"]
    write_json(paths["preflight"] / "dialogue_density.json", {
        "rule": "非阻断信息项：连续对白段 <= 8 且 △/台词比不低于 0.5（台词行 >= 10 时才评估比值）。本项只检测与报告。",
        "note": "对白过多/动作不足为信息项，不阻断流程，也不自动补写动作。",
        "thresholds": dialogue["thresholds"],
        "blocking": False,
        "risky_eps": dialogue["risky_eps"],
        "results": dialogue["results"],
        "status": dialogue["status"],
    })

    culture = checks["culture"]
    write_json(paths["preflight"] / "culture.json", {
        "version": 1,
        "profile": culture.get("profile", {}),
        "profile_path": "culture-profile.json",
        "rule": "SOURCE 未建立的中式元素、东方动作/礼仪（跪礼、叩首、拱手等）不得作为新增内容；台词锁定项只报告。",
        "blocking": False,
        "summary": culture["summary"],
        "results": culture["results"],
    })

    protagonist = checks["protagonist"]
    if protagonist.get("profile"):
        profile = protagonist["profile"]
        write_json(paths["preflight"] / "protagonist.json", {
            "protagonist": profile["protagonist"],
            "aliases": profile["aliases"],
            "profile_source": profile.get("source", "auto"),
            "coverage": protagonist["summary"].get("coverage", {}),
            "episodes": protagonist["results"],
            "blocked_eps": protagonist.get("blocked_eps", []),
        })
        write_json(paths["protagonist_meta"], {
            "schema": "lianben/protagonist/1",
            "protagonist": profile["protagonist"],
            "aliases": profile["aliases"],
            "source": profile.get("source", "auto"),
            "confidence": profile.get("confidence", 0.0),
            "evidence": profile.get("evidence", {}),
            "updated_at": now_iso(),
        })
    else:
        write_json(paths["preflight"] / "protagonist.json", {
            "protagonist": "", "aliases": [], "profile_source": "auto",
            "coverage": {}, "episodes": [], "blocked_eps": [],
        })


# ---------------------------------------------------------------------------
# index
# ---------------------------------------------------------------------------
def build_index(ctx: dict, checks: dict[str, dict]) -> dict:
    episodes = ctx["episodes"]
    ep_rows = []
    for ep in episodes:
        statuses = {}
        for cid in CHECK_IDS:
            if cid == "spoken_words":
                row = _find(checks[cid]["results"], ep["ep"])
                statuses[cid] = row["status"] if row else "SKIP"
            elif cid in ("punctuation", "culture"):
                risky = ep["ep"] in checks[cid].get("risky_eps", [])
                statuses[cid] = "RISK" if risky else "OK"
            elif cid == "pacing":
                risky = ep["ep"] in checks[cid].get("risky_eps", [])
                statuses[cid] = "RISK" if risky else "OK"
            else:
                row = _find(checks[cid]["results"], ep["ep"])
                statuses[cid] = row["status"] if row else "SKIP"
        blocked = ep["ep"] in checks["protagonist"].get("blocked_eps", [])
        ep_rows.append({"ep": ep["ep"], "blocked": blocked, "status": statuses})

    blocked_eps = checks["protagonist"].get("blocked_eps", [])
    checks_risky = sum(1 for cid in CHECK_IDS if checks[cid]["status"] == "RISK")
    must_fix = int(checks["culture"]["summary"].get("must_fix", 0))
    suspected = int(checks["culture"]["summary"].get("suspected", 0))
    status = "BLOCKED" if blocked_eps else ("RISK" if checks_risky else "OK")
    summary = {
        "status": status,
        "degraded": False,
        "blocked_eps": blocked_eps,
        "checks_risky": checks_risky,
        "must_fix": must_fix,
        "suspected": suspected,
        "needs_confirm": False,
        "checks_error": 0,
    }
    entry_gate = {
        "status": "BLOCKED" if blocked_eps else "PASS",
        "reasons": [f"protagonist blocked: EP{x:02d}" for x in blocked_eps],
    }
    check_rows = []
    for cid in CHECK_IDS:
        chk = checks[cid]
        counts = {"pass": 0, "risk": 0, "blocked": 0, "error": 0, "skip": 0}
        if chk["status"] == "RISK":
            counts["risk"] = 1
        elif chk["status"] == "BLOCKED":
            counts["blocked"] = 1
        elif chk["status"] == "SKIP":
            counts["skip"] = 1
        elif chk["status"] == "ERROR":
            counts["error"] = 1
        else:
            counts["pass"] = 1
        check_rows.append({
            "id": cid,
            "version": chk.get("version", "1.0"),
            "blocking": bool(chk.get("blocking")),
            "status": chk["status"],
            "risky_eps": list(chk.get("risky_eps") or []),
            "counts": counts,
            "duration_ms": 0,
            "ai_used": False,
            "result": f"checks/{cid}.json",
        })
    return {
        "schema": SCHEMA_INDEX,
        "run_id": ctx["run_id"],
        "generated_at": ctx["generated_at"],
        "source_sha256": ctx["source_sha256"],
        "config_hash": ctx["config_hash"],
        "content_hash": content_hash(ctx, checks),
        "check_basis": "standardized",
        "effectiveCheckProfile": ctx.get("check_profile") or {},
        "checkProfileSource": ctx.get("check_profile_source", "default"),
        "summary": summary,
        "entry_gate": entry_gate,
        "checks": check_rows,
        "episodes": ep_rows,
        "warnings": list(ctx.get("check_profile_warnings") or []),
    }


def content_hash(ctx: dict, checks: dict[str, dict]) -> str:
    payload = {
        "source_sha256": ctx["source_sha256"],
        "config_hash": ctx["config_hash"],
        "checks": {cid: {"status": c["status"], "summary": c["summary"],
                         "results": c["results"]} for cid, c in checks.items()},
    }
    return hash_obj(payload)


def _find(rows: list[dict], ep: int) -> dict | None:
    for r in rows:
        if r.get("ep") == ep:
            return r
    return None


# ---------------------------------------------------------------------------
# legacy report.json + report.md
# ---------------------------------------------------------------------------
def build_report_json(ctx: dict, checks: dict[str, dict], index: dict) -> dict:
    episodes = [{
        "ep": ep["ep"],
        "title": ep["title"],
        "start_paragraph": ep["start"],
        "end_paragraph_exclusive": ep["end"],
    } for ep in ctx["episodes"]]
    culture = checks["culture"]
    punct = checks["punctuation"]
    pacing = checks["pacing"]
    out = {
        "version": 1,
        "schema": "lianben/preflight_report/1",
        "project_id": ctx["project"].get("project_id", ""),
        "generated_at": ctx["generated_at"],
        "rating": None,
        "entry_gate": index["entry_gate"]["status"],
        "must_fix": [],
        "suspected": [],
        "scene_unify": [],
        "top_actions": [],
        "culture_notes": [],
        "culture_issues": culture["results"],
        "punctuation_issues": punct["results"],
        "spoken_word_check": {
            "status": "FAIL" if checks["spoken_words"]["summary"]["failed_eps"] else "PASS",
            "failed_eps": checks["spoken_words"]["summary"]["failed_eps"],
            "results": checks["spoken_words"]["results"],
        },
        "spoken_words_check": checks["spoken_words"]["summary"],
        "punctuation_check": punct["summary"],
        "atom_pacing_check": pacing["subchecks"]["atom_pacing"],
        "dialogue_density_check": pacing["subchecks"]["dialogue_density"],
        "culture_check": culture["summary"],
        "protagonist_check": checks["protagonist"]["summary"],
        "blocked_eps": checks["protagonist"].get("blocked_eps", []),
        "effectiveCheckProfile": ctx.get("check_profile") or {},
        "checkProfileSource": ctx.get("check_profile_source", "default"),
        "checkProfileWarnings": list(ctx.get("check_profile_warnings") or []),
        "episodes": episodes,
        "checks_index": "work/preflight/index.json",
    }
    return out


def build_report_md(ctx: dict, checks: dict[str, dict], index: dict) -> list[str]:
    eps = ctx["episodes"]
    lines: list[str] = []
    lines.append(f"# 《{ctx['project'].get('title', '')}》前置质检报告")
    lines.append("")
    lines.append(f"- 生成时间：{ctx['generated_at']}")
    lines.append(f"- 源文件：{ctx['source_name']}（sha256 {ctx['source_sha256'][:12]}…）")
    lines.append(f"- 集数：{len(eps)}；检测模式：{ctx['detection']['mode']}；置信度：{ctx['detection']['confidence']}")
    lines.append(f"- 总状态：{index['summary']['status']}；blocked 集：{index['summary']['blocked_eps'] or '无'}")
    profile = ctx.get("check_profile") or {}
    profile_source = ctx.get("check_profile_source", "default")
    lines.append(f"- 检查阈值来源：{profile_source}")
    lines.append("")
    lines.append("## 检查阈值（effectiveCheckProfile）")
    lines.append("")
    lines.append(f"- 来源：{profile_source}（default=旧脚本阈值；project=项目 check-profile.json）")
    sp_cfg = profile.get("spoken_words") or {}
    pace = profile.get("pacing") or {}
    cul = profile.get("culture") or {}
    lines.append(f"- spoken_words：min={sp_cfg.get('min')}，max={sp_cfg.get('max')}")
    lines.append(f"- pacing：max_atom_run={pace.get('max_atom_run')}，"
                 f"max_atoms_per_spoken={pace.get('max_atoms_per_spoken')}，"
                 f"dup_similarity={pace.get('dup_similarity')}，"
                 f"max_dup_pairs={pace.get('max_dup_pairs')}，"
                 f"max_spoken_run={pace.get('max_spoken_run')}，"
                 f"min_atoms_per_spoken={pace.get('min_atoms_per_spoken')}，"
                 f"spoken_floor={pace.get('spoken_floor')}")
    lines.append(f"- culture：forbid_cn_elements={cul.get('forbid_cn_elements')}，"
                 f"allowed_terms={cul.get('allowed_terms')}")
    for w in ctx.get("check_profile_warnings") or []:
        lines.append(f"- ⚠ 阈值配置告警：{w}")
    lines.append("")
    lines.append("## 总览")
    lines.append("")
    lines.append("| 项目 | 结果 |")
    lines.append("|---|---|")
    sw = checks["spoken_words"]["summary"]
    lines.append(f"| 英文有声台词词数（{sw['min']}–{sw['max']}/集） | PASS {sw['pass']} 集；FAIL {len(sw['failed_eps'])} 集（{sw['failed_eps'] or '无'}） |")
    pu = checks["punctuation"]["summary"]
    lines.append(f"| 英文台词标点（信息项） | must_fix {pu['must_fix']} 项；warn {pu['warn']} 项；风险集 {pu['risky_eps'] or '无'} |")
    pa = checks["pacing"]["subchecks"]
    lines.append(f"| △/对白密度（信息项） | △ 风险集 {pa['atom_pacing']['risky_eps'] or '无'}；对白风险集 {pa['dialogue_density']['risky_eps'] or '无'} |")
    pr = checks["protagonist"]["summary"]
    lines.append(f"| 主角覆盖（硬门槛） | 主角：{pr.get('protagonist') or '未识别'}；blocked 集 {pr.get('blocked_eps') or '无'}；borderline {pr.get('borderline_eps') or '无'} |")
    cu = checks["culture"]["summary"]
    lines.append(f"| 文化背景（信息项） | must_fix {cu['must_fix']} 项；suspected {cu['suspected']} 项；info {cu['info']} 项 |")
    lines.append("")

    lines.append("## 五检矩阵")
    lines.append("")
    lines.append("| 集 | 词数 | 标点 | 节奏 | 主角 | 文化 | blocked |")
    lines.append("|---|---|---|---|---|---|---|")
    for ep in eps:
        row = _find(checks["spoken_words"]["results"], ep["ep"]) or {}
        p = "RISK" if ep["ep"] in checks["punctuation"].get("risky_eps", []) else "OK"
        pac = "RISK" if ep["ep"] in checks["pacing"].get("risky_eps", []) else "OK"
        pro = (_find(checks["protagonist"]["results"], ep["ep"]) or {}).get("status", "SKIP")
        cul = "RISK" if ep["ep"] in checks["culture"].get("risky_eps", []) else "OK"
        blocked = "是" if ep["ep"] in checks["protagonist"].get("blocked_eps", []) else "否"
        lines.append(f"| EP{ep['ep']:02d} | {row.get('status', '-')}({row.get('count', '-')}) | {p} | {pac} | {pro} | {cul} | {blocked} |")
    lines.append("")

    lines.append("## 逐项明细")
    lines.append("")
    lines.append("### 1. 英文有声台词词数")
    lines.append("")
    lines.append("| 集 | 词数 | 结果 | 原因 | 英文行 | 中文行 | mixed |")
    lines.append("|---|---:|---|---|---:|---:|---:|")
    for r in checks["spoken_words"]["results"]:
        lines.append(f"| EP{r['ep']:02d} | {r['count']} | {r['status']} | {r['reason']} | "
                     f"{r['english_spoken_lines']} | {r['cn_spoken_lines']} | {r['mixed_lines']} |")
    lines.append("")

    lines.append("### 2. 英文台词标点")
    lines.append("")
    if checks["punctuation"]["results"]:
        lines.append("| 集 | 段落 | 字符 | 级别 | 次数 | 上下文 / 建议 |")
        lines.append("|---|---:|---|---|---:|---|")
        for r in checks["punctuation"]["results"]:
            ctx_text = str(r["context"]).replace("|", "｜")
            lines.append(f"| EP{r['ep']:02d} | {r['paragraph']} | {r['char']} | {r['severity']} | {r['count']} | {ctx_text} / {r['suggestion']} |")
    else:
        lines.append("未发现英文台词标点问题。")
    lines.append("")

    lines.append("### 3. △/对白密度与节奏")
    lines.append("")
    lines.append("| 集 | △数 | 台词行 | △/台词 | 最长△段 | 近似对 | 最长对白段 | 状态 |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---|")
    for r in pa["atom_pacing"]["results"]:
        d = _find(pa["dialogue_density"]["results"], r["ep"]) or {}
        status = "RISK" if r["ep"] in checks["pacing"].get("risky_eps", []) else "OK"
        lines.append(f"| EP{r['ep']:02d} | {r['atoms']} | {r['spoken']} | {r['ratio']} | "
                     f"{r['max_atom_run']} | {r['duplicate_pairs']} | {d.get('max_spoken_run', '-')} | {status} |")
    lines.append("")

    lines.append("### 4. 主角覆盖")
    lines.append("")
    lines.append("| 集 | 场次 | 主角场次 | 场次占比 | 台词占比 | 动作占比 | 覆盖分 | 状态 | 原因 |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---|---|")
    for r in checks["protagonist"]["results"]:
        lines.append(f"| EP{r['ep']:02d} | {r['scenes']} | {r['protagonist_scenes']} | {r['scene_ratio']} | "
                     f"{r['dialogue_ratio']} | {r['action_ratio']} | {r['coverage_score']} | {r['status']} | {r['reason'] or '-'} |")
    lines.append("")

    lines.append("### 5. 文化背景")
    lines.append("")
    if checks["culture"]["results"]:
        lines.append("| 集 | 段落 | 类型 | 命中词 | 分类 | 级别 | 可修复 | 上下文 / 建议 |")
        lines.append("|---|---:|---|---|---|---|---|---|")
        for r in checks["culture"]["results"]:
            ctx_text = str(r["context"]).replace("|", "｜")
            lines.append(f"| EP{r['ep']:02d} | {r['paragraph']} | {r['kind']} | {r['term']} | {r['category']} | "
                         f"{r['severity']} | {'是' if r['fixable'] else '否'} | {ctx_text} / {r['suggestion']} |")
    else:
        lines.append("未发现中式元素/文化符号。")
    lines.append("")

    lines.append("## blocked 集")
    lines.append("")
    if checks["protagonist"].get("blocked_eps"):
        for epn in checks["protagonist"]["blocked_eps"]:
            row = _find(checks["protagonist"]["results"], epn) or {}
            lines.append(f"- EP{epn:02d}：{row.get('status', '')} — {row.get('reason', '')}（不进入炼本）")
    else:
        lines.append("无。")
    lines.append("")

    lines.append("## 格式合规与异常集")
    lines.append("")
    anomalies = []
    for ep_meta in ctx["ep_index"]["episodes"]:
        if ep_meta.get("anomalies"):
            anomalies.append(f"EP{ep_meta['ep']:02d}: " + ", ".join(ep_meta["anomalies"]))
    lines.append("- 识别模式：" + ctx["detection"]["mode"] + f"；置信度：{ctx['detection']['confidence']}")
    lines.append("- 异常集：" + ("；".join(anomalies) if anomalies else "无"))
    lines.append("")

    lines.append("## AI 审计")
    lines.append("")
    lines.append("本阶段未调用 AI（0 LLM / 0 网络，ai_used=false）。")
    lines.append("")
    lines.append("## 下一步")
    lines.append("")
    lines.append("- 确认/修复 blocked 集或文化 must_fix 后重跑前置。")
    lines.append("- 进入炼本阶段前，请确保源稿中台词与结构行保持锁定。")
    return lines


def write_reports(paths: dict, ctx: dict, checks: dict[str, dict], index: dict) -> dict:
    write_json(paths["preflight_index"], index)
    report_json = build_report_json(ctx, checks, index)
    write_json(paths["preflight_report_json"], report_json)
    md_lines = build_report_md(ctx, checks, index)
    md_text = "\n".join(md_lines) + "\n"
    write_text(paths["preflight_report_md"], md_text)
    stem = Path(ctx["source_name"]).stem
    out_md = paths["report_out"] / f"{stem}_前置质检报告.md"
    out_docx = paths["report_out"] / f"{stem}_前置质检报告.docx"
    write_text(out_md, md_text)
    try:
        build_report_docx(f"《{ctx['project'].get('title', stem)}》前置质检报告", md_lines, out_docx)
    except Exception as exc:  # report docx failure must not corrupt JSON results
        import sys
        print(f"[WARN] report docx render failed: {exc}", file=sys.stderr)
        out_docx = Path("")
    return {
        "md": str(out_md.relative_to(paths["project_root"])).replace("\\", "/"),
        "docx": str(out_docx.relative_to(paths["project_root"])).replace("\\", "/") if out_docx else "",
    }


# ---------------------------------------------------------------------------
# stdout payload (fixed host contract)
# ---------------------------------------------------------------------------
def build_stdout(ctx: dict, checks: dict[str, dict], index: dict, report_paths: dict,
                 duration_ms: int) -> dict:
    eps = ctx["episodes"]
    blocked_eps = checks["protagonist"].get("blocked_eps", [])
    top_checks = {}
    for cid in CHECK_IDS:
        chk = checks[cid]
        if cid == "protagonist":
            top_checks[cid] = {"status": chk["status"], "blocked_eps": blocked_eps}
        else:
            top_checks[cid] = {
                "status": chk["status"],
                "risky_eps": list(chk.get("risky_eps") or []),
            }
    ep_out = []
    for ep in eps:
        sp = _find(checks["spoken_words"]["results"], ep["ep"]) or {}
        pu_risk = ep["ep"] in checks["punctuation"].get("risky_eps", [])
        pa_risk = ep["ep"] in checks["pacing"].get("risky_eps", [])
        pro = _find(checks["protagonist"]["results"], ep["ep"]) or {}
        cul_risk = ep["ep"] in checks["culture"].get("risky_eps", [])
        blocked = ep["ep"] in blocked_eps
        statuses = [sp.get("status", "SKIP") if sp else "SKIP"]
        ep_status = "BLOCKED" if blocked else (
            "RISK" if ("RISK" in statuses or pu_risk or pa_risk or cul_risk) else "OK")
        ep_out.append({
            "ep": ep["ep"],
            "title": ep["title"],
            "status": ep_status,
            "cjk": ep.get("stats", {}).get("cjk", 0),
            "scenes": ep.get("stats", {}).get("scenes", 0),
            "dialogue_lines": ep.get("stats", {}).get("dialogue_lines", 0),
            "atom_lines": ep.get("stats", {}).get("atoms", 0),
            "blocked": blocked,
            "checks": {
                "spoken_words": {"status": sp.get("status", "SKIP"), "value": sp.get("count", 0)},
                "punctuation": {"status": "RISK" if pu_risk else "OK",
                                "count": sum(r["count"] for r in checks["punctuation"]["results"]
                                             if r["ep"] == ep["ep"])},
                "pacing": {"status": "RISK" if pa_risk else "OK"},
                "protagonist": {"status": _short_protagonist(pro.get("status", "SKIP"))},
                "culture": {"status": "RISK" if cul_risk else "OK",
                            "count": sum(1 for r in checks["culture"]["results"]
                                         if r["ep"] == ep["ep"]
                                         and r["severity"] in ("must_fix", "suspected"))},
            },
        })
    project = ctx["project"]
    return {
        "ok": True,
        "schema": "lianben2/engine/1",
        "version": VERSION,
        "project": {
            "id": project.get("id") or project.get("slug") or paths_name(ctx),
            "title": project.get("title", ""),
            "episodes": len(eps),
            "blocked_eps": blocked_eps,
            "durationMs": duration_ms,
        },
        "detection": {
            "mode": ctx["detection"]["mode"],
            "confidence": ctx["detection"]["confidence"],
            "episode_count": ctx["detection"]["episode_count"],
        },
        "effectiveCheckProfile": ctx.get("check_profile") or {},
        "checkProfileSource": ctx.get("check_profile_source", "default"),
        "warnings": list(ctx.get("check_profile_warnings") or []),
        "checks": top_checks,
        "episodes": ep_out,
        "report": report_paths,
        "files": {
            "source": "work/source",
            "preflightIndex": "work/preflight/index.json",
            "preflightReport": "work/preflight/report.json",
        },
        "ai_used": False,
    }


def _short_protagonist(status: str) -> str:
    return {
        "NO_PROTAGONIST": "NO",
        "LOW_PROTAGONIST": "LOW",
        "BORDERLINE": "BORDERLINE",
        "OK": "OK",
        "SKIP": "OK",
    }.get(status, status)


def paths_name(ctx: dict) -> str:
    try:
        return Path(ctx["project_root"]).name
    except Exception:
        return ""
