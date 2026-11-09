"""把全剧分析 Markdown 转成 Word：output/<stem>_全剧分析.md -> .docx

用法：
  python tools/analysis_build_docx.py
  python tools/analysis_build_docx.py --md output/xxx_全剧分析.md --out output/xxx_全剧分析.docx
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C


def add_runs_with_bold(paragraph, text: str):
    text = text.replace("`", "")
    parts = re.split(r"(\*\*.*?\*\*)", text)
    for part in parts:
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            run = paragraph.add_run(part[2:-2])
            run.bold = True
        else:
            paragraph.add_run(part)


def flush_table(doc, rows):
    rows = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows]
    rows = [r for r in rows if not all(re.fullmatch(r":?-{2,}:?", c or "-") for c in r)]
    if not rows:
        return
    cols = max(len(r) for r in rows)
    table = doc.add_table(rows=0, cols=cols)
    table.style = "Table Grid"
    for r in rows:
        cells = table.add_row().cells
        for i in range(cols):
            cells[i].text = r[i] if i < len(r) else ""
            for p in cells[i].paragraphs:
                for run in p.runs:
                    run.font.name = "微软雅黑"
                    run.font.size = _pt(9)


def _pt(n):
    from docx.shared import Pt
    return Pt(n)


def build_docx(md_text: str, out_path: Path):
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import RGBColor

    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "微软雅黑"
    normal.font.size = _pt(10.5)

    table_buf = []
    for raw in md_text.splitlines():
        s = raw.rstrip()
        if s.strip().startswith("|"):
            table_buf.append(s)
            continue
        if table_buf:
            flush_table(doc, table_buf)
            table_buf = []
        if not s.strip() or re.fullmatch(r"-{3,}", s.strip()):
            continue

        if s.startswith("# "):
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = p.add_run(s[2:].strip())
            run.bold = True
            run.font.size = _pt(18)
        elif s.startswith("### "):
            p = doc.add_paragraph()
            add_runs_with_bold(p, s[4:].strip())
            for run in p.runs:
                run.bold = True
                run.font.size = _pt(12)
        elif s.startswith("## "):
            p = doc.add_paragraph()
            add_runs_with_bold(p, s[3:].strip())
            for run in p.runs:
                run.bold = True
                run.font.size = _pt(15)
        elif s.startswith(">"):
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = _pt(12)
            add_runs_with_bold(p, s.lstrip("> ").strip())
            for run in p.runs:
                run.italic = True
                run.font.color.rgb = RGBColor(0x55, 0x55, 0x55)
        elif re.match(r"^[-*]\s+", s.strip()):
            p = doc.add_paragraph(style="List Bullet")
            add_runs_with_bold(p, re.sub(r"^[-*]\s+", "", s.strip()))
        elif re.match(r"^\d+\.\s+", s.strip()):
            p = doc.add_paragraph(style="List Number")
            add_runs_with_bold(p, re.sub(r"^\d+\.\s+", "", s.strip()))
        else:
            p = doc.add_paragraph()
            add_runs_with_bold(p, s.strip())

    if table_buf:
        flush_table(doc, table_buf)

    out_path.parent.mkdir(parents=True, exist_ok=True)
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
    ap.add_argument("--md", default="")
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    root = C.ROOT

    if args.md:
        md_path = Path(args.md)
        if not md_path.is_absolute():
            md_path = root / md_path
    else:
        found = sorted((root / "output").glob("*_全剧分析.md"))
        if not found:
            print("[FAIL] 未找到 output/*_全剧分析.md，请先运行 story-analyst")
            return 2
        if len(found) > 1:
            print("[FAIL] 找到多个全剧分析文件，请用 --md 指定：")
            for p in found:
                print(f"  - {p}")
            return 2
        md_path = found[0]

    if not md_path.exists():
        print(f"[FAIL] 文件不存在：{md_path}")
        return 2

    out_path = Path(args.out) if args.out else md_path.with_suffix(".docx")
    if not out_path.is_absolute():
        out_path = root / out_path

    md_text = C.read_text(md_path)
    result = build_docx(md_text, out_path)
    print(f"[OK] 全剧分析 Word：{result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
