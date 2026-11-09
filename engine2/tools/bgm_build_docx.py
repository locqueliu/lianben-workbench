#!/usr/bin/env python3
"""Markdown 成品 → Word：集标题 Heading 1（导航窗格可跳）、栏目 Heading 2、场景块 Heading 3。"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bgm_common as C

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

RE_EPISODE = re.compile(r"^第\s*\d+\s*集\s*[｜|]")
RE_BRACKET = re.compile(r"^【.+】$")
RE_SCENE = re.compile(r"^(\d{1,3})\s*[-－]\s*(\d{1,3})\s+(\S.*)$")
RE_FIELD = re.compile(r"^\*\*([^*]+?[:：])\*\*\s*(.*)$")
RE_BULLET = re.compile(r"^[-*]\s+(.+)$")
RE_LABEL = re.compile(r"^(情绪音|场景配乐|节奏\s*[／/]\s*调性)\s*[：:]\s*(.*)$")


def set_style_font(style, name: str, size=None, bold=None, color=None) -> None:
    style.font.name = name
    if size is not None:
        style.font.size = Pt(size)
    if bold is not None:
        style.font.bold = bold
    if color is not None:
        style.font.color.rgb = color
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    for attr in ("w:ascii", "w:hAnsi", "w:eastAsia"):
        rfonts.set(qn(attr), name)


def add_field_paragraph(doc, label: str, value: str):
    p = doc.add_paragraph()
    run = p.add_run(label)
    run.bold = True
    if value:
        p.add_run(value)
    return p


def build(md_text: str, docx_path: Path) -> tuple[int, int]:
    lines = md_text.splitlines()
    doc = Document()
    normal = doc.styles["Normal"]
    set_style_font(normal, "微软雅黑", 10.5)
    set_style_font(doc.styles["Heading 1"], "微软雅黑", 16, True, RGBColor(0x1F, 0x1F, 0x1F))
    set_style_font(doc.styles["Heading 2"], "微软雅黑", 13, True, RGBColor(0x33, 0x33, 0x33))
    set_style_font(doc.styles["Heading 3"], "微软雅黑", 11.5, True, RGBColor(0x44, 0x44, 0x44))

    title_done = False
    expected_h1 = 0
    seen_h1 = 0
    for raw in lines:
        ln = raw.rstrip()
        s = ln.strip()
        if not s:
            continue
        if s.startswith("# "):
            if not title_done:
                p = doc.add_paragraph()
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                run = p.add_run(s[2:].strip())
                run.bold = True
                run.font.size = Pt(20)
                run.font.name = "微软雅黑"
                title_done = True
            continue
        if s.startswith(">"):
            p = doc.add_paragraph()
            run = p.add_run(s.lstrip("> ").strip())
            run.italic = True
            run.font.size = Pt(9)
            run.font.color.rgb = RGBColor(0x80, 0x80, 0x80)
            continue
        if s == "---":
            doc.add_page_break()
            continue
        if s.startswith("## "):
            doc.add_heading(s[3:].strip(), level=1)
            expected_h1 += 1
            continue
        if RE_EPISODE.match(s):
            p = doc.add_heading(s, level=1)
            p.paragraph_format.page_break_before = True
            expected_h1 += 1
            continue
        if RE_BRACKET.match(s):
            doc.add_heading(s, level=2)
            continue
        if RE_SCENE.match(s):
            doc.add_heading(s, level=3)
            continue
        m_label = RE_LABEL.match(s)
        if m_label:
            label = re.sub(r"\s+", "", m_label.group(1)).replace("/", "／") + "："
            add_field_paragraph(doc, label, m_label.group(2))
            continue
        f = RE_FIELD.match(s)
        if f:
            add_field_paragraph(doc, f.group(1), f.group(2))
            continue
        b = RE_BULLET.match(s)
        if b:
            doc.add_paragraph(b.group(1), style="List Bullet")
            continue
        doc.add_paragraph(s)

    for p in doc.paragraphs:
        if p.style.name == "Heading 1":
            seen_h1 += 1
    if seen_h1 != expected_h1:
        raise RuntimeError(f"Word 标题数校验失败：期望 {expected_h1}，实际 {seen_h1}")

    docx_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        doc.save(str(docx_path))
    except PermissionError:
        fallback = docx_path.with_name(docx_path.stem + "_new" + docx_path.suffix)
        doc.save(str(fallback))
        print(f"[WARN] 目标文件被占用（可能已在 Word 中打开），已另存为：{fallback}")
    return expected_h1, seen_h1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow-partial", action="store_true")
    args = ap.parse_args()

    index = C.load_json(C.META_DIR / "bgm_index.json")
    if not index:
        print("[FAIL] 未找到 bgm_index.json")
        return 1
    stem = index.get("stem") or "剧本"
    normal = C.OUTPUT_DIR / f"{stem}_配乐方案.md"
    partial = C.OUTPUT_DIR / f"{stem}_配乐方案_部分完成.md"
    if normal.exists():
        md_path = normal
    elif partial.exists():
        md_path = partial
    else:
        print("[FAIL] 未找到合并稿，请先运行 merge.py")
        return 1

    md_text = C.read_text(md_path)
    docx_path = md_path.with_suffix(".docx")
    expected, seen = build(md_text, docx_path)
    if "_部分完成" not in md_path.stem:
        stale = C.OUTPUT_DIR / f"{stem}_配乐方案_部分完成.docx"
        if stale.exists():
            stale.unlink()
    print(f"[OK] Word 已生成：{docx_path}（Heading 1 共 {seen}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
