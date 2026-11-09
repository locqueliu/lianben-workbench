"""生成最终质检报告：剧情修改情况 + 台词变动核查（前置/炼本两段）。

输出：output/<剧名>_质检报告.md 与 .docx（word 由 python-docx 生成）。
用法：python tools/generate_qc_report.py
"""
from __future__ import annotations

import argparse
import datetime
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C
from verify_optimized import canon, canon_prefix, dialogue_lines

MAX_DRAFT_CJK = 10000


def read_dialogue_pairs(path: Path):
    lines = C.read_text(path).splitlines()
    return [(canon(p), canon(t)) for p, t in dialogue_lines(lines)]


def spoken_stream(path: Path):
    return "".join(t for _, t in read_dialogue_pairs(path))


def first_diff(a: str, b: str):
    n = min(len(a), len(b))
    i = next((k for k in range(n) if a[k] != b[k]), n)
    lo, hi = max(0, i - 10), i + 15
    return i, a[lo:hi], b[lo:hi]


def check_preflight(root: Path, eps, paras):
    report = C.load_json(root / "work" / "preflight" / "report.json", {}) or {}
    bounds = {int(e["ep"]): (int(e["start_paragraph"]), int(e["end_paragraph_exclusive"]))
              for e in report.get("episodes") or []}
    out = {}
    for n in eps:
        out_path = root / "work" / "source" / f"ep{n:02d}.md"
        if n not in bounds or not paras or not out_path.exists():
            out[n] = {"status": "SKIP", "detail": "缺少源段落边界或存档文件"}
            continue
        s, e = bounds[n]
        src = [(canon_prefix(p), canon(t)) for p, t in dialogue_lines(paras[s:e])]
        dst = read_dialogue_pairs(out_path)
        if src == dst:
            out[n] = {"status": "PASS", "lines": len(src)}
        else:
            detail = f"台词行/文字不一致（源 {len(src)} 行 / 存档 {len(dst)} 行）"
            for i in range(min(len(src), len(dst))):
                if src[i] != dst[i]:
                    detail += f"；首个差异 #{i + 1}：{src[i][0]}：{src[i][1][:30]} → {dst[i][0]}：{dst[i][1][:30]}"
                    break
            out[n] = {"status": "FAIL", "detail": detail}
    return out


def check_refined(root: Path, eps):
    out = {}
    for n in eps:
        sp = root / "work" / "source" / f"ep{n:02d}.md"
        dp = root / "work" / "draft" / f"ep{n:02d}.md"
        if not sp.exists() or not dp.exists() or not C.read_text(dp).strip():
            out[n] = {"status": "SKIP", "detail": "未执行炼本"}
            continue
        a, b = spoken_stream(sp), spoken_stream(dp)
        if a == b:
            out[n] = {"status": "PASS", "chars": len(a)}
        else:
            i, sa, sb = first_diff(a, b)
            out[n] = {"status": "FAIL",
                      "detail": f"台词文字流不一致（首个差异位置 #{i}：…{sa}… → …{sb}…）"}
    return out


def cell(s):
    return str(s).replace("|", "｜").replace("\n", " ").strip()


def build_markdown(stem, eps, per_ep, pre, post, words, has_draft, pacing=None, culture=None,
                   punctuation=None, protagonist=None, shot_plans=None, shot_issues=None):
    culture = culture or []
    punctuation = punctuation or []
    protagonist = protagonist if isinstance(protagonist, dict) else {}
    shot_plans = shot_plans or {}
    shot_issues = shot_issues or {}
    prot_eps = [e for e in (protagonist.get("episodes") or []) if isinstance(e, dict) and "ep" in e]
    prot_map = {int(e["ep"]): e for e in prot_eps}
    blocked_eps = [int(e["ep"]) for e in prot_eps
                   if e.get("status") in ("NO_PROTAGONIST", "LOW_PROTAGONIST")
                   and not e.get("entered")]
    lines = [f"# 《{stem}》质检报告", "",
             f"- 生成时间：{datetime.datetime.now().isoformat(timespec='seconds')}",
             f"- 集数：{len(eps)}", ""]

    fix_eps = [n for n in eps if per_ep[n]["fixes"]]
    unify_eps = [n for n in eps if per_ep[n]["unify"]]
    enrich_eps = [n for n in eps if per_ep[n]["enrich"]]
    merge_eps = [n for n in eps if per_ep[n]["merge"]]
    pre_fail = [n for n in eps if pre.get(n, {}).get("status") == "FAIL"]
    post_fail = [n for n in eps if post.get(n, {}).get("status") == "FAIL"]
    ap_res = (pacing or {}).get("atom", {}) or {}
    dd_res = (pacing or {}).get("dialogue", {}) or {}
    atoms_before = (pacing or {}).get("before", {}) or {}
    atoms_after = (pacing or {}).get("after", {}) or {}
    risk_eps = [n for n in eps if (ap_res.get(n) or {}).get("status") == "RISK"]
    dlg_eps = [n for n in eps if (dd_res.get(n) or {}).get("dialogue_status") == "RISK"]
    culture_must = [r for r in culture if isinstance(r, dict) and r.get("severity") == "must_fix"]
    culture_sus = [r for r in culture if isinstance(r, dict) and r.get("severity") == "suspected"]
    culture_eps = sorted({int(r["ep"]) for r in culture if isinstance(r, dict) and "ep" in r})
    punct = [r for r in punctuation if isinstance(r, dict)]
    punct_must = [r for r in punct if r.get("severity") == "must_fix"]
    punct_warn = [r for r in punct if r.get("severity") == "warn"]
    punct_eps = sorted({int(r["ep"]) for r in punct if "ep" in r})

    lines += ["## 总览", "", "| 项目 | 结果 |", "|---|---|"]
    if fix_eps:
        lines.append(f"| 较大剧情修改 | 有：共 {len(fix_eps)} 集包含逻辑修复（{'、'.join(f'EP{n:02d}' for n in fix_eps)}），明细见下文 |")
    else:
        lines.append("| 较大剧情修改 | 无（仅动作丰富与格式整理） |")
    lines.append(f"| 场景名称统一 | {'共 ' + str(len(unify_eps)) + ' 集：' + '、'.join(f'EP{n:02d}' for n in unify_eps) if unify_eps else '无'} |")
    lines.append(f"| 动作丰富（导演层填充，不改变剧情事实） | {'共 ' + str(len(enrich_eps)) + ' 集' if enrich_eps else '无'} |")
    if merge_eps:
        lines.append(f"| △ 原子合并（用户授权，内容保真） | 有：共 {len(merge_eps)} 集（{'、'.join(f'EP{n:02d}' for n in merge_eps)}），明细见下文 |")
    else:
        lines.append("| △ 原子合并（用户授权，内容保真） | 无 |")
    lines.append(f"| △/对白密度检测（信息项，不阻断） | △ 过多 {len(risk_eps)} 集；对白过密/动作不足 {len(dlg_eps)} 集（明细见第四节）|")
    if culture:
        lines.append(f"| 文化背景审查（信息项，SOURCE 唯一依据） | must_fix {len(culture_must)} 项；suspected {len(culture_sus)} 项；涉及 {len(culture_eps)} 集（明细见第五节）|")
    else:
        lines.append("| 文化背景审查（信息项，SOURCE 唯一依据） | 未执行或未命中 |")
    if protagonist:
        if blocked_eps:
            lines.append(f"| 主角覆盖（前置硬门槛） | blocked {len(blocked_eps)} 集：{'、'.join(f'EP{n:02d}' for n in blocked_eps)}（不进入炼本，明细见第七节）|")
        else:
            lines.append("| 主角覆盖（前置硬门槛） | 无 blocked 集 |")
    else:
        lines.append("| 主角覆盖（前置硬门槛） | 未执行 |")
    planned = [n for n in eps if shot_plans.get(n)]
    low_related = []
    for n in planned:
        try:
            if float(shot_plans[n].get("shot_related_ratio", 1.0)) < 0.70:
                low_related.append(n)
        except (TypeError, ValueError):
            continue
    if planned:
        lines.append(f"| 主角镜头规划（炼本阶段） | 已规划 {len(planned)}/{len(eps)} 集；关联占比 <70% 共 {len(low_related)} 集（明细见第八节）|")
    else:
        lines.append("| 主角镜头规划（炼本阶段） | 未规划或未执行炼本 |")
    if punct:
        lines.append(f"| 英文台词标点审查（信息项，只报告） | must_fix {sum(r.get('count', 1) for r in punct_must)} 项；warn {sum(r.get('count', 1) for r in punct_warn)} 项；涉及 {len(punct_eps)} 集（明细见第六节）|")
    else:
        lines.append("| 英文台词标点审查（信息项，只报告） | 未执行或未命中 |")
    if pre_fail:
        lines.append(f"| 前置阶段台词变动（源稿→优化存档） | 有：{'、'.join(f'EP{n:02d}' for n in pre_fail)} |")
    else:
        lines.append("| 前置阶段台词变动（源稿→优化存档） | 无变动（全部逐字锁定校验通过） |")
    if not has_draft:
        lines.append("| 炼本阶段台词变动（优化存档→导演执行稿） | 未执行炼本 |")
    elif post_fail:
        lines.append(f"| 炼本阶段台词变动（优化存档→导演执行稿） | 有：{'、'.join(f'EP{n:02d}' for n in post_fail)} |")
    else:
        lines.append("| 炼本阶段台词变动（优化存档→导演执行稿） | 无变动 |")
    over_eps = [n for n in eps if words.get(n, {}).get("over")]
    if not has_draft:
        lines.append(f"| 炼本单集字数（上限 {MAX_DRAFT_CJK} 字） | 未执行炼本 |")
    elif over_eps:
        lines.append(f"| 炼本单集字数（上限 {MAX_DRAFT_CJK} 字） | 有超标：{'、'.join(f'EP{n:02d}' for n in over_eps)} |")
    else:
        lines.append(f"| 炼本单集字数（上限 {MAX_DRAFT_CJK} 字） | 全部合格 |")
    lines.append("")

    lines += ["## 一、剧情修改情况", "",
              "说明：剧情修改仅来自前置修复优化（修复逻辑 bug 与前后矛盾、统一场景名、适度丰富动作）；台词逐字锁定，不新增剧情事件、不改变动作结果。", ""]

    lines += ["### 逻辑修复明细（必须修改 must_fix / 疑似问题 suspected）", ""]
    rows = []
    for n in eps:
        for f in per_ep[n]["fixes"]:
            rows.append(f"| EP{n:02d} | {cell(f.get('type', ''))} | {cell(f.get('problem', ''))} | {cell(f.get('action', ''))} |")
    if rows:
        lines += ["| 集 | 类型 | 问题 | 处理 |", "|---|---|---|---|", *rows, ""]
    else:
        lines += ["无逻辑修复。", ""]

    kept_rows = []
    for n in eps:
        for f in per_ep[n]["kept"]:
            kept_rows.append(f"| EP{n:02d} | {cell(f.get('problem', ''))} | 无法确认，保留原文 |")
    if kept_rows:
        lines += ["### 保留未改的疑似问题", "", "| 集 | 问题 | 处理 |", "|---|---|---|", *kept_rows, ""]

    if unify_eps:
        lines += ["### 场景名称统一", ""]
        for n in unify_eps:
            for u in per_ep[n]["unify"]:
                lines.append(f"- EP{n:02d}：{cell(u.get('problem', ''))} → {cell(u.get('action', ''))}")
        lines.append("")

    if enrich_eps:
        lines += ["### 动作丰富统计", "", "| 集 | 丰富项数 |", "|---|---:|"]
        for n in enrich_eps:
            lines.append(f"| EP{n:02d} | {len(per_ep[n]['enrich'])} |")
        lines.append("")

    lines += ["## 二、台词变动核查", "",
              "- 前置阶段为行级逐字比对（说话人、标签、台词文字、句读标点；仅容忍冒号/引号/括号/空格的纯格式统一）。",
              "- 炼本阶段为台词文字流比对（容忍按分镜拆分为 CN1→EN1→CN2→EN2，文字与顺序必须一致）。", ""]

    lines += ["### 前置阶段（源稿 → 优化存档）", "", "| 集 | 结果 | 明细 |", "|---|---|---|"]
    for n in eps:
        r = pre.get(n, {"status": "SKIP", "detail": ""})
        note = f"{r.get('lines', '')} 行" if r["status"] == "PASS" else r.get("detail", "")
        lines.append(f"| EP{n:02d} | {r['status']} | {cell(note)} |")
    lines.append("")

    lines += ["### 炼本阶段（优化存档 → 导演执行稿）", "", "| 集 | 结果 | 明细 |", "|---|---|---|"]
    for n in eps:
        r = post.get(n, {"status": "SKIP", "detail": "未执行炼本"})
        note = f"文字流 {r.get('chars', '')} 字" if r["status"] == "PASS" else r.get("detail", "")
        lines.append(f"| EP{n:02d} | {r['status']} | {cell(note)} |")
    lines.append("")

    lines += ["## 三、炼本字数检测", "",
              f"上限：单集中文（CJK）字数不超过 {MAX_DRAFT_CJK} 字（超出会被炼本校验打回重炼）。", "",
              "| 集 | 源存档字数 | 炼本成品字数 | 结果 |", "|---|---:|---:|---|"]
    for n in eps:
        w = words.get(n, {})
        cnt = w.get("count")
        srcv = w.get("src")
        srcv = srcv if srcv is not None else "—"
        if cnt is None:
            lines.append(f"| EP{n:02d} | {srcv} | — | 未执行炼本 |")
        else:
            lines.append(f"| EP{n:02d} | {srcv} | {cnt} | {'超标' if w.get('over') else '合格'} |")
    lines.append("")

    lines += ["## 四、动作/对白密度检测与处理记录", "",
              "说明：前置检查的 △/对白密度检测为**信息项**（只报告、不作为错误、不阻断流程）。",
              "- △ 过多：经用户授权后由 episode-optimizer 合并连续 △（内容保真——完整保留全部事实与表演动作，只减少 △ 条数）。",
              "- 对白过密/动作不足：仅检测与报告，本流程不补写动作。",
              "",
              f"- △ 检测命中（RISK）集：{'、'.join(f'EP{n:02d}' for n in risk_eps) if risk_eps else '无'}；",
              f"- 对白过密/动作不足命中集：{'、'.join(f'EP{n:02d}' for n in dlg_eps) if dlg_eps else '无'}。",
              "",
              "| 集 | △/台词比 | 最长△段 | △检测 | 最长连续对白段 | 对白检测 | 合并前△ | 合并后△ | 合并条数 |",
              "|---|---:|---:|---|---:|---|---:|---:|---:|"]
    for n in eps:
        a = ap_res.get(n) or {}
        d = dd_res.get(n) or {}
        b = atoms_before.get(n)
        af = atoms_after.get(n)
        lines.append(f"| EP{n:02d} | {a.get('ratio', '—')} | {a.get('max_atom_run', '—')} | {a.get('status', '—')} | "
                     f"{d.get('max_spoken_run', '—')} | {d.get('dialogue_status', '—')} | "
                     f"{b if b is not None else '—'} | {af if af is not None else '—'} | {len(per_ep[n]['merge'])} |")
    lines.append("")

    if merge_eps:
        lines += ["### △ 原子合并明细（用户授权，内容保真）", "",
                  "合并**完整保留全部事实与表演动作**，只减少 △ 条数；台词与锁行逐字不变。", ""]
        mrows = []
        for n in merge_eps:
            for it in per_ep[n]["merge"]:
                mrows.append(f"| EP{n:02d} | {cell(it.get('type', ''))} | {cell(it.get('problem', ''))} | {cell(it.get('action', ''))} |")
        lines += ["| 集 | 类型 | 位置/涉及原子 | 处理 |", "|---|---|---|---|", *mrows, ""]

    lines += ["## 五、文化背景审查", "",
              "说明：本项由 `tools/preflight_culture_check.py` 扫描 SOURCE 生成，目标文化由 `culture-profile.json` 控制。",
              "- `must_fix`：与既定文化背景冲突的高置信中式元素；动作行可交优化器中性化，台词/锁行只报告。",
              "- `suspected`：歧义或上下文不足，交人工判断。",
              "- `info`：`forbid_cn_elements=false` 时的报告项，不阻断。", ""]
    if culture:
        lines += ["| 集 | 段落 | 类型 | 命中词 | 级别 | 可自动修复 | 上下文 / 建议 |",
                  "|---|---:|---|---|---|---|---|"]
        for r in culture:
            if not isinstance(r, dict):
                continue
            lines.append(
                f"| EP{int(r.get('ep', 0)):02d} | {r.get('paragraph', '—')} | {cell(r.get('kind', ''))} | "
                f"{cell(r.get('term', ''))} | {cell(r.get('severity', ''))} | {'是' if r.get('fixable') else '否'} | "
                f"{cell(r.get('context', ''))} / {cell(r.get('suggestion', ''))} |"
            )
        lines.append("")
    else:
        lines += ["未执行文化背景检查，或未发现中式元素。", ""]

    culture_fix_eps = [n for n in eps if per_ep[n].get("culture")]
    if culture_fix_eps:
        lines += ["### 优化器文化问题处理记录", "",
                  "| 集 | 位置/问题 | 处理 |", "|---|---|---|"]
        for n in culture_fix_eps:
            for it in per_ep[n]["culture"]:
                lines.append(f"| EP{n:02d} | {cell(it.get('problem', ''))} | {cell(it.get('action', ''))} |")
        lines.append("")

    lines += ["## 六、英文台词标点审查", "",
              "说明：本项由 `tools/preflight_punctuation_check.py` 扫描 SOURCE 中的英文台词正文生成，**只报告、不自动修改**。",
              "- 检查范围：带 DIALOGUE/VO/OS 标签的英文台词正文（冒号后的 text）。",
              "- 重点：中文全角标点、全角空格、全角分隔冒号，以及明显的空格问题。",
              "- 中文表演提示不在本项范围内。", ""]
    if punct:
        lines += ["| 集 | 段落 | 问题 | 次数 | 级别 | 上下文 / 建议 |",
                  "|---|---:|---|---:|---|---|"]
        for r in punct:
            lines.append(
                f"| EP{int(r.get('ep', 0)):02d} | {r.get('paragraph', '—')} | {cell(r.get('char', ''))} | "
                f"{r.get('count', 1)} | {cell(r.get('severity', ''))} | "
                f"{cell(r.get('context', ''))} / {cell(r.get('suggestion', ''))} |"
            )
        lines.append("")
    else:
        lines += ["未执行英文台词标点检查，或未发现问题。", ""]

    lines += ["## 七、主角覆盖与未进入炼本", ""]
    if prot_eps:
        lines += [
            "说明：主角覆盖检查是**前置硬门槛**，只在前置阶段判定；已进入炼本的集不回判。",
            "`NO_PROTAGONIST` / `LOW_PROTAGONIST` 集标记为 blocked，不进入炼本。",
            "",
            "| 集 | 场次 | 主角场次 | 场次占比 | 主角台词/总台词 | 台词占比 | 覆盖分 | 状态 | 处理 |",
            "|---|---:|---:|---:|---:|---:|---:|---|---|",
        ]
        for n in eps:
            r = prot_map.get(n)
            if not r:
                lines.append(f"| EP{n:02d} | — | — | — | — | — | — | 未检查 | — |")
                continue
            status = r.get("status", "—")
            entered = bool(r.get("entered"))
            blocked = status in ("NO_PROTAGONIST", "LOW_PROTAGONIST") and not entered
            if blocked:
                action = "blocked，不进入炼本"
            elif entered:
                action = "已进入炼本，不回判"
            elif status == "BORDERLINE":
                action = "提示，可进入炼本"
            else:
                action = "正常进入炼本"
            lines.append(
                f"| EP{n:02d} | {r.get('scenes', '—')} | {r.get('protagonist_scenes', '—')} | "
                f"{r.get('scene_ratio', '—')} | {r.get('protagonist_dialogue_lines', '—')}/"
                f"{r.get('dialogue_lines', '—')} | {r.get('dialogue_ratio', '—')} | "
                f"{r.get('coverage_score', '—')} | {status} | {action} |")
        if blocked_eps:
            lines += ["", f"- blocked 集：{'、'.join(f'EP{n:02d}' for n in blocked_eps)}；需修改源稿后重跑 `/前置检查`。"]
        lines.append("")
    else:
        lines += ["未执行主角覆盖检查，或 `work/preflight/protagonist.json` 不存在。", ""]

    lines += ["## 八、主角镜头规划", "",
              "说明：`shot_plan` 由 `work/report/epNN.json` 提供；P=主角镜，R=主角关系镜，N=非主角镜。",
              "目标：关联占比 ≥70%，主角本人镜 ≥35%，纯 N ≤30%，连续 N ≤2，连续配角互动 N ≤2。",
              "",
              "| 集 | 镜头 | P | R | N | 关联占比 | 主角占比 | 最长N段 | 最长配角段 | 主角特写 | 场次缺失 | 校验 |",
              "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|"]
    for n in eps:
        s = shot_plans.get(n) or {}
        if not s:
            lines.append(f"| EP{n:02d} | — | — | — | — | — | — | — | — | — | — | 未规划 |")
            continue
        issues = [str(x) for x in (shot_issues.get(n) or [])][:3]
        issue_text = cell("; ".join(issues)) if issues else "OK"
        missing = s.get("shot_scene_missing") or []
        lines.append(
            f"| EP{n:02d} | {s.get('shot_total', '—')} | {s.get('shot_p', '—')} | "
            f"{s.get('shot_r', '—')} | {s.get('shot_n', '—')} | "
            f"{s.get('shot_related_ratio', '—')} | {s.get('shot_protagonist_ratio', '—')} | "
            f"{s.get('shot_max_n_run', '—')} | {s.get('shot_max_support_run', '—')} | "
            f"{s.get('shot_closeup_share', '—')} | {','.join(missing) if missing else '—'} | {issue_text} |")
    lines.append("")
    lines += ["## 九、结论", ""]
    if not fix_eps and not pre_fail and not post_fail:
        lines.append("- 剧情：无较大剧情修改，仅动作丰富与格式整理。")
    elif fix_eps:
        lines.append(f"- 剧情：存在 {len(fix_eps)} 集逻辑修复（详见第一节），均未改动台词与剧情走向。")
    else:
        lines.append("- 剧情：无较大剧情修改。")
    if merge_eps:
        lines.append(f"- △ 原子：{'、'.join(f'EP{n:02d}' for n in merge_eps)} 集经用户授权合并连续 △（保留全部事实与表演动作，未改动台词与剧情事实）。")
    if risk_eps or dlg_eps:
        lines.append(f"- 密度检测：△ 过多命中 {len(risk_eps)} 集、对白过密/动作不足命中 {len(dlg_eps)} 集（信息项）；其中 {len(merge_eps)} 集已按用户授权合并连续 △。")
    else:
        lines.append("- 密度检测：未检测到 △/对白密度风险。")
    if culture_must or culture_sus:
        lines.append(f"- 文化背景：must_fix {len(culture_must)} 项、suspected {len(culture_sus)} 项；动作行已交优化器中性化，台词/锁行需人工复核（详见第五节）。")
    else:
        lines.append("- 文化背景：未检测到需处理的中式元素。")
    if punct_must or punct_warn:
        lines.append(f"- 英文台词标点：must_fix {sum(r.get('count', 1) for r in punct_must)} 项、warn {sum(r.get('count', 1) for r in punct_warn)} 项；仅报告，未自动修改（详见第六节）。")
    else:
        lines.append("- 英文台词标点：未检测到中文标点或空格问题。")
    if pre_fail or post_fail:
        lines.append(f"- 台词：检测到变动集（前置：{pre_fail or '无'}；炼本：{post_fail or '无'}），请人工复核对应明细。")
    else:
        lines.append("- 台词：全部阶段逐字锁定，无变动。")
    if blocked_eps:
        lines.append(f"- 主角覆盖：{'、'.join(f'EP{n:02d}' for n in blocked_eps)} 未进入炼本（主角戏份不足），需修改源稿后重跑 `/前置检查`。")
    elif protagonist:
        lines.append("- 主角覆盖：无 blocked 集。")
    if has_draft:
        if over_eps:
            lines.append(f"- 字数：{'、'.join(f'EP{n:02d}' for n in over_eps)} 超出单集上限 {MAX_DRAFT_CJK} 字，请核查。")
        else:
            lines.append(f"- 字数：全部集数在单集上限（{MAX_DRAFT_CJK} 字）以内。")
    if not has_draft:
        lines.append("- 备注：本报告生成时未执行炼本（/炼剧本），炼本阶段核查为未执行。")
    lines.append("")
    return "\n".join(lines)


def build_docx(md_text, out_path: Path):
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt, RGBColor

    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "微软雅黑"
    normal.font.size = Pt(10.5)

    def flush_table(buf):
        rows = []
        for raw in buf:
            cells = [c.strip() for c in raw.strip().strip("|").split("|")]
            if all(re.fullmatch(r":?-{2,}:?", c or "-") or c == "" for c in cells):
                continue
            rows.append(cells)
        if not rows:
            return
        cols = max(len(r) for r in rows)
        table = doc.add_table(rows=0, cols=cols)
        table.style = "Table Grid"
        for r in rows:
            cells = table.add_row().cells
            for i in range(cols):
                text = r[i] if i < len(r) else ""
                cells[i].text = text
                for p in cells[i].paragraphs:
                    for run in p.runs:
                        run.font.size = Pt(9)
                        run.font.name = "微软雅黑"

    tbuf = []
    for raw in md_text.splitlines():
        s = raw.rstrip()
        if s.strip().startswith("|"):
            tbuf.append(s)
            continue
        if tbuf:
            flush_table(tbuf)
            tbuf = []
        if not s.strip():
            continue
        if s.startswith("# "):
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = p.add_run(s[2:].strip())
            run.bold = True
            run.font.size = Pt(18)
        elif s.startswith("### "):
            p = doc.add_paragraph()
            run = p.add_run(s[4:].strip())
            run.bold = True
            run.font.size = Pt(12)
        elif s.startswith("## "):
            p = doc.add_paragraph()
            run = p.add_run(s[3:].strip())
            run.bold = True
            run.font.size = Pt(15)
        elif s.startswith("- "):
            doc.add_paragraph(s[2:].strip(), style="List Bullet")
        else:
            doc.add_paragraph(s)
    if tbuf:
        flush_table(tbuf)
    try:
        doc.save(str(out_path))
    except PermissionError:
        fallback = out_path.with_name(out_path.stem + "_new" + out_path.suffix)
        doc.save(str(fallback))
        print(f"[WARN] 目标文件被占用，已另存为：{fallback}")
        return fallback
    return out_path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default="")
    args = ap.parse_args()
    root = C.ROOT
    ep_index = C.load_json(root / "work" / "meta" / "ep_index.json", {}) or {}
    if not ep_index:
        print("[FAIL] 缺少 work/meta/ep_index.json，请先完成 /前置检查")
        return 2
    eps = sorted(e["ep"] for e in ep_index.get("episodes", []))
    stem = Path(ep_index.get("docx") or "剧本").stem or "剧本"

    per_ep = {}
    for n in eps:
        rec = C.load_json(root / "work" / "preflight" / "optimized" / f"ep{n:02d}.json", {}) or {}
        items = [i for i in (rec.get("items") or []) if isinstance(i, dict)]
        per_ep[n] = {
            "fixes": [i for i in items if i.get("type") in ("must_fix", "suspected")
                      and "无法确认" not in str(i.get("action", ""))],
            "kept": [i for i in items if "无法确认" in str(i.get("action", ""))],
            "unify": [i for i in items if i.get("type") == "scene_unify"],
            "enrich": [i for i in items if i.get("type") == "enrich"],
            "merge": [i for i in items if i.get("type") == "atom_merge"],
            "culture": [i for i in items if i.get("type") == "culture_issue"],
        }

    paras_path = root / "work" / "meta" / "paragraphs.txt"
    paras = paras_path.read_text(encoding="utf-8-sig").splitlines() if paras_path.exists() else []
    pre = check_preflight(root, eps, paras)
    has_draft = any((root / "work" / "draft" / f"ep{n:02d}.md").exists() for n in eps)
    post = check_refined(root, eps)
    words = {}
    for n in eps:
        src_p = root / "work" / "source" / f"ep{n:02d}.md"
        drf_p = root / "work" / "draft" / f"ep{n:02d}.md"
        words[n] = {
            "src": C.cjk_count(C.read_text(src_p)) if src_p.exists() else None,
            "count": C.cjk_count(C.read_text(drf_p)) if drf_p.exists() else None,
        }
        words[n]["over"] = bool(words[n]["count"] is not None and words[n]["count"] > MAX_DRAFT_CJK)

    ap = C.load_json(root / "work" / "preflight" / "atom_pacing.json", {}) or {}
    dd = C.load_json(root / "work" / "preflight" / "dialogue_density.json", {}) or {}
    ap_res = {int(r["ep"]): r for r in ap.get("results", []) if isinstance(r, dict) and "ep" in r}
    dd_res = {int(r["ep"]): r for r in dd.get("results", []) if isinstance(r, dict) and "ep" in r}
    report = C.load_json(root / "work" / "preflight" / "report.json", {}) or {}
    bounds = {int(e["ep"]): (int(e["start_paragraph"]), int(e["end_paragraph_exclusive"]))
              for e in report.get("episodes", []) if "ep" in e}
    atoms_before, atoms_after = {}, {}
    for n in eps:
        if n in bounds and paras:
            s, e = bounds[n]
            atoms_before[n] = sum(1 for x in paras[s:e] if C.normalize_line(x).startswith("△"))
        else:
            atoms_before[n] = None
        sp = root / "work" / "source" / f"ep{n:02d}.md"
        atoms_after[n] = (sum(1 for x in C.read_text(sp).splitlines() if C.normalize_line(x).startswith("△"))
                          if sp.exists() else None)
    pacing = {"atom": ap_res, "dialogue": dd_res, "before": atoms_before, "after": atoms_after}
    culture_data = C.load_json(root / "work" / "preflight" / "culture.json", {}) or {}
    culture = culture_data.get("results", []) or []
    punct_data = C.load_json(root / "work" / "preflight" / "punctuation.json", {}) or {}
    punctuation = punct_data.get("results", []) or []
    protagonist = C.load_json(root / "work" / "preflight" / "protagonist.json", {}) or {}
    if not isinstance(protagonist, dict):
        protagonist = {}
    for rec in protagonist.get("episodes") or []:
        if not isinstance(rec, dict) or "ep" not in rec or "entered" in rec:
            continue
        try:
            n = int(rec["ep"])
        except (TypeError, ValueError):
            continue
        draft = root / "work" / "draft" / f"ep{n:02d}.md"
        rec["entered"] = draft.exists() and draft.stat().st_size > 0

    shot_plans, shot_issues = {}, {}
    for n in eps:
        rec = C.load_json(root / "work" / "report" / f"ep{n:02d}.json", {}) or {}
        check = C.load_json(root / "work" / "report" / f"check_ep{n:02d}.json", {}) or {}
        stats = check.get("stats") or ((rec.get("shot_plan") or {}).get("stats") or {})
        shot_plans[n] = stats if any(str(k).startswith("shot_") for k in stats) else {}
        shot_issues[n] = [x for x in (check.get("fails") or []) + (check.get("warns") or [])
                          if "protagonist" in str(x) or str(x).startswith("shot:")]

    md = build_markdown(stem, eps, per_ep, pre, post, words, has_draft, pacing, culture,
                        punctuation, protagonist, shot_plans, shot_issues)
    out_dir = Path(args.out_dir) if args.out_dir else (root / "output")
    out_dir.mkdir(parents=True, exist_ok=True)
    md_path = out_dir / f"{stem}_质检报告.md"
    C.write_text(md_path, md)
    docx_path = build_docx(md, out_dir / f"{stem}_质检报告.docx")

    fix_eps = [n for n in eps if per_ep[n]["fixes"]]
    merge_eps = [n for n in eps if per_ep[n]["merge"]]
    pre_fail = [n for n in eps if pre.get(n, {}).get("status") == "FAIL"]
    post_fail = [n for n in eps if post.get(n, {}).get("status") == "FAIL"]
    over_eps = [n for n in eps if words[n]["over"]]
    print(f"[OK] 质检报告：{md_path}")
    print(f"[OK] 质检报告：{docx_path}")
    print(f"[OK] 逻辑修复集={fix_eps or '无'}；△合并集={merge_eps or '无'}；前置台词变动={pre_fail or '无'}；炼本台词变动={post_fail or '无'}；字数超标={over_eps or '无'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
