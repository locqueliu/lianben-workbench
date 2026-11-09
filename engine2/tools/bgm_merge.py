#!/usr/bin/env python3
"""合并通过的集为成品 Markdown（含全局风格头与主题动机表）。"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bgm_common as C


def style_block() -> list[str]:
    lines = ["## 全局风格与禁令", ""]
    text = C.read_text(C.GLOBAL_STYLE) if C.GLOBAL_STYLE.exists() else ""
    # 统一风格段落
    style = []
    retreat = []
    in_style = False
    in_ban = False
    in_retreat = False
    bans = []
    for ln in text.splitlines():
        s = ln.strip()
        if re.match(r"^#{1,6}\s*统一风格", s):
            in_style, in_ban, in_retreat = True, False, False
            continue
        if re.match(r"^#{1,6}\s*配乐让位原则", s):
            in_style, in_ban, in_retreat = False, False, True
            continue
        if re.match(r"^#{1,6}\s*禁用清单", s):
            in_style, in_ban, in_retreat = False, True, False
            continue
        if re.match(r"^#{1,6}\s+", s):
            if in_style or in_ban or in_retreat:
                in_style, in_ban, in_retreat = False, False, False
            continue
        if in_style and s:
            style.append(s)
        if in_retreat and s:
            retreat.append(s)
        if in_ban and s.startswith("- "):
            bans.append(s[2:].strip())
    lines += style
    if retreat:
        lines.append("")
        lines.append("配乐让位原则（旋律与节奏克制）：")
        lines += retreat
    if bans:
        lines.append("")
        lines.append("制作禁令：不使用 " + "、".join(bans) + "；不写人声歌词；对白期间避让中高频。")
    lines.append("")
    return lines


def theme_block() -> list[str]:
    bible = C.META_DIR / "series-bible.md"
    if not bible.exists():
        return []
    text = C.read_text(bible)
    m = re.search(r"(?ms)^##\s*主题动机表\s*$(.*?)(?=^##\s|\Z)", text)
    if not m:
        return []
    body = m.group(1).strip()
    if not body:
        return []
    return ["## 主题动机表", "", body, ""]


def write_if_changed(path: Path, text: str) -> None:
    if path.exists() and C.read_text(path) == text:
        return
    if path.exists():
        archive = C.OUTPUT_DIR / "archive"
        archive.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        shutil.copy2(path, archive / f"{path.stem}_{stamp}{path.suffix}")
    C.write_text(path, text)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow-partial", action="store_true")
    args = ap.parse_args()

    index = C.load_json(C.META_DIR / "bgm_index.json")
    if not index:
        print("[FAIL] 未找到 bgm_index.json，请先运行 python tools/bgm_prepare.py")
        return 1
    progress = C.load_json(C.META_DIR / "bgm_progress.json", {"episodes": {}})
    stem = index.get("stem") or "剧本"
    episodes = sorted(index["episodes"], key=lambda x: x["ep"])

    passed, missing = [], []
    for e in episodes:
        status = progress.get("episodes", {}).get(str(e["ep"]), {}).get("status")
        draft = C.DRAFT_DIR / f"ep{e['ep']:02d}.md"
        if status == "passed" and draft.exists():
            passed.append(e)
        else:
            missing.append(e)

    if missing and not args.allow_partial:
        print(f"[FAIL] 有 {len(missing)} 集未通过：{', '.join('第%d集' % e['ep'] for e in missing)}。"
              "如接受部分交付请加 --allow-partial")
        return 2

    lines = [
        f"# 《{stem}》配乐方案（BGM 生成提示词）",
        "",
        f"> 生成时间：{C.now_iso()} · 共 {len(episodes)} 集 · 通过 {len(passed)} 集"
        + (f" · 待补 {len(missing)} 集" if missing else ""),
        "",
        *style_block(),
        *theme_block(),
        "---",
        "",
    ]
    for e in episodes:
        ep = e["ep"]
        draft = C.DRAFT_DIR / f"ep{ep:02d}.md"
        if any(e["ep"] == m["ep"] for m in missing):
            title = e.get("title", "")
            lines += [f"第{ep}集｜（待补）", "",
                      f"本集未通过自动校验，暂未收录。可在会话中运行 /配乐 定点重跑该集。", ""]
        else:
            lines += [C.read_text(draft).strip(), ""]

    suffix = "_部分完成" if missing else ""
    out = C.OUTPUT_DIR / f"{stem}_配乐方案{suffix}.md"
    C.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    write_if_changed(out, "\n".join(lines).rstrip() + "\n")
    stale = C.OUTPUT_DIR / f"{stem}_配乐方案{'' if suffix else '_部分完成'}.md"
    if stale.exists():
        stale.unlink()
    print(f"[OK] 合并完成：{out}（通过 {len(passed)}/{len(episodes)}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
