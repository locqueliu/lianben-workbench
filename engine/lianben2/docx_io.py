"""docx extraction (python-docx) and report docx rendering."""
from __future__ import annotations

from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Pt

from .errors import FatalError, IOProblem


def _style_maps(doc) -> tuple[dict[str, str], set[str]]:
    """Build styleId->name and heading styleId set once per document.

    Accessing `paragraph.style.name` per paragraph is very slow on large docs
    (measured ~1.5ms/paragraph for 20-ep fixtures); resolving w:pStyle against
    this map keeps extraction linear and fast.
    """
    style_map: dict[str, str] = {}
    heading_ids: set[str] = set()
    try:
        styles = doc.styles
    except Exception:
        return style_map, heading_ids
    for st in styles:
        try:
            sid = getattr(st, "style_id", None) or ""
            name = getattr(st, "name", "") or ""
        except Exception:
            continue
        if not sid:
            continue
        style_map[sid] = name
        low = name.lower()
        if (low.startswith("heading") or low.startswith("title")
                or "标题" in name or name in ("Title", "Subtitle")):
            heading_ids.add(sid)
    return style_map, heading_ids


def _heading_from_ppr(ppr, heading_ids: set[str]) -> tuple[str, bool]:
    """Return (style_id, is_heading) using raw paragraph properties only."""
    if ppr is None:
        return "", False
    style_id = ""
    try:
        el = ppr.find(qn("w:pStyle"))
        if el is not None:
            style_id = el.get(qn("w:val")) or ""
    except Exception:
        style_id = ""
    heading = style_id in heading_ids
    if not heading:
        try:
            ol = ppr.find(qn("w:outlineLvl"))
            if ol is not None:
                heading = int(ol.get(qn("w:val")) or 9) <= 8
        except (TypeError, ValueError):
            heading = False
    return style_id, heading


def extract_paragraphs(docx_path: Path) -> list[dict]:
    """Return every w:p as one record, in document order (empty paragraphs kept)."""
    try:
        doc = Document(str(docx_path))
    except Exception as exc:  # python-docx raises many exception types
        raise FatalError(f"无法解析 docx：{docx_path.name}: {exc}") from exc
    style_map, heading_ids = _style_maps(doc)
    out: list[dict] = []
    for i, p in enumerate(doc.paragraphs):
        text = p.text or ""
        style_id, heading = _heading_from_ppr(p._p.pPr, heading_ids)
        name = style_map.get(style_id, "")
        if not heading and name:
            low = name.lower()
            heading = (low.startswith("heading") or low.startswith("title")
                       or "标题" in name or name in ("Title", "Subtitle"))
        out.append({
            "file": Path(docx_path).name,
            "idx": i,
            "text": text,
            "style": name,
            "heading": bool(heading),
        })
    return out


def build_report_docx(title: str, lines: list[str], out_path: Path) -> None:
    """Deterministic-ish report docx built from a simple markdown-ish line list.

    Supports: '# ' / '## ' headings, '| ... |' tables -> Word table, '- ' bullets,
    everything else -> normal paragraph. No images/network.
    """
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "Microsoft YaHei"
    style.font.size = Pt(10.5)
    doc.add_heading(title, level=0)
    table_buf: list[list[str]] = []

    def flush_table() -> None:
        nonlocal table_buf
        rows = [r for r in table_buf if not set("".join(r)) <= {"-", " ", ":"}]
        table_buf = []
        if not rows:
            return
        cols = max(len(r) for r in rows)
        table = doc.add_table(rows=0, cols=cols)
        table.style = "Table Grid"
        for row in rows:
            cells = table.add_row().cells
            for j in range(cols):
                cells[j].text = row[j] if j < len(row) else ""
                for p in cells[j].paragraphs:
                    for run in p.runs:
                        run.font.size = Pt(9)

    for raw in lines:
        line = raw.rstrip()
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            table_buf.append(cells)
            continue
        flush_table()
        if line.startswith("### "):
            doc.add_heading(line[4:], level=3)
        elif line.startswith("## "):
            doc.add_heading(line[3:], level=2)
        elif line.startswith("# "):
            doc.add_heading(line[2:], level=1)
        elif line.startswith("- "):
            doc.add_paragraph(line[2:], style="List Bullet")
        elif line.strip() == "":
            continue
        else:
            doc.add_paragraph(line)
    flush_table()
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        doc.save(str(out_path))
    except (OSError, PermissionError) as exc:
        raise IOProblem(f"报告 docx 写入失败（可能被 Word 占用）：{exc}") from exc
