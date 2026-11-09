#!/usr/bin/env python3
"""脚本层终检：缺集、场次覆盖、禁令、长度、主题一致性，并汇总代理终检结论。"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bgm_common as C

RE_EP = re.compile(r"^第\s*(\d+)\s*集\s*[｜|]")
RE_SCENE = re.compile(r"(\d{1,3})\s*[-－]\s*(\d{1,3})")


def episode_blocks(md_text: str) -> list[tuple[int, str]]:
    blocks: list[tuple[int, str]] = []
    cur_ep, cur_lines = None, []
    for ln in md_text.splitlines():
        m = RE_EP.match(ln.strip())
        if m:
            if cur_ep is not None:
                blocks.append((cur_ep, "\n".join(cur_lines)))
            cur_ep, cur_lines = int(m.group(1)), [ln]
        elif cur_ep is not None:
            cur_lines.append(ln)
    if cur_ep is not None:
        blocks.append((cur_ep, "\n".join(cur_lines)))
    return blocks


def main() -> int:
    index = C.load_json(C.META_DIR / "bgm_index.json", {}) or {}
    episodes = sorted(index.get("episodes", []), key=lambda x: x["ep"])
    stem = index.get("stem") or "剧本"
    candidates = [C.OUTPUT_DIR / f"{stem}_配乐方案.md", C.OUTPUT_DIR / f"{stem}_配乐方案_部分完成.md"]
    md_path = next((p for p in candidates if p.exists()), None)

    fails: list[str] = []
    warns: list[str] = []
    lines = ["# BGM 配乐工作流终检报告", "", f"- 检查时间：{C.now_iso()}"]

    if not md_path:
        lines += ["", "## 结论", "", "- FAIL：未找到合并稿（merge.py 尚未产出）。"]
        C.write_text(C.OUTPUT_DIR / "配乐终检报告.md", "\n".join(lines) + "\n")
        print("[FAIL] 未找到合并稿")
        return 1

    md_text = C.read_text(md_path)
    blocks = episode_blocks(md_text)
    by_ep = {ep: body for ep, body in blocks}
    placeholder_eps = [ep for ep, body in blocks
                       if "（待补）" in body or "未通过自动校验" in body]
    if placeholder_eps:
        warns.append(f"placeholder_episodes:{placeholder_eps}")
    lines += [f"- 合成稿：`{md_path.name}`", ""]

    # 集完整性
    lines += ["## 集完整性", ""]
    missing = [e["ep"] for e in episodes if e["ep"] not in by_ep]
    if missing:
        fails.append(f"missing_episodes:{missing}")
        lines.append(f"- FAIL：缺集 {missing}")
    else:
        lines.append(f"- OK：{len(episodes)} 集齐全")
    titles = [ln.strip() for ln in md_text.splitlines() if RE_EP.match(ln.strip())]
    if len(set(titles)) != len(titles):
        fails.append("duplicate_titles")
        lines.append("- FAIL：存在重复集标题")
    lines.append("")

    # 三段结构
    lines += ["## 三段结构", ""]
    struct_bad = []
    for e in episodes:
        if e["ep"] in placeholder_eps:
            continue
        body = (by_ep.get(e["ep"], "") or "").replace("/", "／").replace(":", "：")
        miss = [x for x in ("情绪音：", "场景配乐：", "节奏／调性：") if x not in body]
        if miss:
            struct_bad.append((e["ep"], miss))
    if struct_bad:
        fails.append("structure_missing")
        for ep, miss in struct_bad:
            lines.append(f"- FAIL：第{ep}集缺段 {miss}")
    else:
        lines.append("- OK：全部集三段齐全")
    lines.append("")

    # 场次覆盖
    lines += ["## 场次覆盖", ""]
    if placeholder_eps:
        lines.append(f"- WARN：待补集（未通过自动校验，跳过场次核对）：{placeholder_eps}")
    scene_bad = []
    for e in episodes:
        if e["ep"] in placeholder_eps:
            continue
        body = by_ep.get(e["ep"], "")
        found = {f"{m.group(1)}-{m.group(2)}" for m in RE_SCENE.finditer(body)}
        expecting = e.get("scenes", [])
        miss = [s for s in expecting if s not in found]
        if expecting and miss:
            scene_bad.append((e["ep"], miss))
    if scene_bad:
        fails.append("scene_missing")
        for ep, miss in scene_bad:
            lines.append(f"- FAIL：第{ep}集缺场次 {miss}")
    else:
        lines.append("- OK：全部集场次覆盖一致")
    lines.append("")

    # 禁令与占位
    lines += ["## 禁令扫描", ""]
    banned = C.banned_terms()
    hits = []
    scan_text = "\n".join(by_ep.values())
    for term in banned:
        if re.search(re.escape(term), scan_text):
            hits.append(term)
    placeholders = [t for t in ("同上", "待定", "TODO", "自行发挥") if t in scan_text]
    if hits:
        fails.append(f"banned:{','.join(hits)}")
        lines.append(f"- FAIL：出现禁用词 {hits}")
    else:
        lines.append("- OK：无禁用词")
    if placeholders:
        warns.append(f"placeholders:{placeholders}")
        lines.append(f"- WARN：出现占位词 {placeholders}")
    lines.append("")

    # 长度统计
    lines += ["## 长度统计", ""]
    sizes = []
    for e in episodes:
        if e["ep"] in placeholder_eps:
            continue
        body = by_ep.get(e["ep"], "")
        n = C.cjk_count(body)
        sizes.append((e["ep"], n))
    if sizes:
        nums = [n for _, n in sizes]
        lines.append(f"- 每集中文字数 min/avg/max = {min(nums)}/{sum(nums)//len(nums)}/{max(nums)}")
        short = [ep for ep, n in sizes if 0 < n < 100]
        if short:
            warns.append(f"short_episodes:{short}")
            lines.append(f"- WARN：偏短集 {short}")
        long = [ep for ep, n in sizes if n > 500]
        if long:
            warns.append(f"long_episodes:{long}")
            lines.append(f"- WARN：偏长集 {long}")
    lines.append("")

    # 主题一致性
    lines += ["## 主题一致性", ""]
    theme_map = C.load_json(C.META_DIR / "theme-map.json", {}) or {}
    themes = [t.get("name", "") for t in theme_map.get("themes", []) if t.get("name")]
    if themes:
        used = [t for t in themes if t in md_text]
        lines.append(f"- 参考：总纲主题名在成品中出现 {len(used)}/{len(themes)}"
                     "（紧凑格式不要求逐一点名，仅供核对）")
    else:
        lines.append("- WARN：未找到 theme-map.json 或主题表为空")
    lines.append("")

    # 代理终检结论
    lines += ["## 代理终检结论", ""]
    audit = C.load_json(C.REPORT_DIR / "audit_agent.json", None)
    if audit:
        lines.append(f"- status={audit.get('status')}，issues={len(audit.get('issues', []))}")
        for i in audit.get("issues", [])[:20]:
            lines.append(f"  - 第{i.get('ep')}集 [{i.get('type')}] {i.get('detail')}")
        if audit.get("status") == "FIX":
            warns.append("auditor_issues")
    else:
        lines.append("- WARN：未找到代理终检结果 audit_agent.json")
    lines.append("")

    # 结论
    lines += ["## 结论", ""]
    if fails:
        lines.append(f"- FAIL：{fails}")
    else:
        lines.append("- PASS：无阻断项" + (f"（{len(warns)} 项警告）" if warns else ""))
    lines.append("")

    C.write_text(C.OUTPUT_DIR / "配乐终检报告.md", "\n".join(lines))
    print(f"[OK] 终检完成：PASS" if not fails else f"[FAIL] 终检发现阻断项：{fails}")
    print(f"[report] {C.OUTPUT_DIR / '配乐终检报告.md'}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
