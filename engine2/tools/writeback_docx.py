import argparse
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C


def with_bold(rpr):
    if "<w:b/>" in rpr or "<w:b " in rpr:
        return rpr
    if rpr.startswith("<w:rPr>"):
        inner = rpr[len("<w:rPr>"):-len("</w:rPr>")]
    else:
        inner = ""
    m = re.match(r"<w:rFonts[^>]*?/>", inner)
    if m:
        inner = inner[:m.end()] + "<w:b/><w:bCs/>" + inner[m.end():]
    else:
        inner = "<w:b/><w:bCs/>" + inner
    return "<w:rPr>" + inner + "</w:rPr>"


def ppr_with(ppr, outline=None, page_break=False):
    if not ppr:
        inner = "<w:pageBreakBefore/>" if page_break else ""
        if outline is not None:
            inner += f'<w:outlineLvl w:val="{outline}"/>'
        return "<w:pPr>" + inner + "</w:pPr>" if inner else ""
    new = ppr
    if page_break and "pageBreakBefore" not in new:
        m = re.match(r"<w:pPr[^>]*>", new)
        pos = m.end() if m else 0
        for pat in (r"\s*<w:pStyle[^>]*/>", r"\s*<w:keepNext[^>]*/>", r"\s*<w:keepLines[^>]*/>"):
            mm = re.match(pat, new[pos:])
            if mm:
                pos += mm.end()
        new = new[:pos] + "<w:pageBreakBefore/>" + new[pos:]
    if outline is not None and "outlineLvl" not in new:
        m = re.search(r"<w:rPr>.*?</w:rPr>", new, re.S)
        pos = m.start() if m else len(new) - len("</w:pPr>")
        new = new[:pos] + f'<w:outlineLvl w:val="{outline}"/>' + new[pos:]
    return new


def with_outline(p_xml, outline=None, page_break=False):
    m = re.search(r"<w:pPr>.*?</w:pPr>", p_xml, re.S)
    if m:
        new_ppr = ppr_with(m.group(0), outline, page_break)
        return p_xml[:m.start()] + new_ppr + p_xml[m.end():]
    props = ppr_with("", outline, page_break)
    if not props:
        return p_xml
    return re.sub(r"^(<w:p[^>]*>)", lambda mm: mm.group(1) + props, p_xml, count=1)


def make_paragraph(text, ppr, rpr):
    if not text:
        return f"<w:p>{ppr}</w:p>"
    return (f"<w:p>{ppr}<w:r>{rpr}"
            f'<w:t xml:space="preserve">{C.escape_xml(text)}</w:t></w:r></w:p>')


def is_bold_line(s):
    if re.match(r"^\d+-\d+\s", s):
        return True
    if s.startswith("【") and s.endswith("】") and not s.startswith(("【人物站位", "【音效", "【制作", "【全局")):
        return True
    return False


def roundtrip(out, root, replaced):
    with zipfile.ZipFile(out) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    texts = [C.paragraph_text(p) for p in C.extract_paragraph_xmls(xml)]
    eps = C.locate_episodes(texts)
    mapping = {}
    for k, (i, n, _) in enumerate(eps):
        j = eps[k + 1][0] if k + 1 < len(eps) else len(texts)
        mapping[n] = "\n".join(texts[i:j])
    results = []
    bad = 0
    for n in replaced:
        draft = C.read_text(root / "work" / "draft" / f"ep{n:02d}.md")
        fails, stats = C.draft_docx_checks(n, draft, mapping.get(n, ""))
        if fails:
            bad += 1
        results.append({"ep": n, "verdict": "PASS" if not fails else "FAIL", "fails": fails, "stats": stats})
        tag = "ok" if not fails else "; ".join(fails)
        print(f"[{'PASS' if not fails else 'FAIL'}] roundtrip ep{n:02d} {tag}")
    C.save_json(root / "work" / "report" / "roundtrip.json", {"docx": str(out), "results": results})
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docx", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--allow-partial", action="store_true")
    args = ap.parse_args()
    root = C.ROOT
    meta = C.load_json(root / "work" / "meta" / "ep_index.json")
    if not meta:
        print("[FAIL] run split_docx.py first")
        return 2
    progress = C.load_json(root / "work" / "meta" / "progress.json", {"episodes": {}})
    docx = Path(args.docx) if args.docx else Path(meta["docx"])
    passed = [e for e in meta["episodes"]
              if progress["episodes"].get(str(e["ep"]), {}).get("status") in ("passed", "passed-with-issues")]
    if not passed:
        print("[FAIL] no passed episodes")
        return 1
    if len(passed) < len(meta["episodes"]) and not args.allow_partial:
        print(f"[FAIL] only {len(passed)}/{len(meta['episodes'])} passed; use --allow-partial")
        return 1
    with zipfile.ZipFile(docx) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    spans = [m.span() for m in re.finditer(r"<w:p[ >].*?</w:p>", xml, re.S)]
    px = [xml[s:e] for s, e in spans]
    texts = [C.paragraph_text(p) for p in px]
    heading_ids = C.load_heading_style_ids(docx)
    eps = C.locate_episodes(texts)
    eps_map = {}
    for k, (i, n, _) in enumerate(eps):
        j = eps[k + 1][0] if k + 1 < len(eps) else len(texts)
        eps_map[n] = (i, j)
    replacements = []
    replaced = []
    for e in passed:
        n = e["ep"]
        if n not in eps_map:
            print(f"[FAIL] source docx has no episode {n}; rerun split_docx.py")
            return 1
        i, j = eps_map[n]
        draft = C.read_text(root / "work" / "draft" / f"ep{n:02d}.md")
        header_cn = C.normalize_line(texts[i])
        has_header_en = i + 1 < j and C.is_episode_en_header(texts[i + 1])
        header_en = C.normalize_line(texts[i + 1]) if has_header_en else ""
        ppr, rpr = C.find_body_templates(px, i, j, heading_ids)
        parts = [with_outline(px[i], outline=0, page_break=True)]
        if has_header_en:
            parts.append(px[i + 1])
        skipped_cn = skipped_en = False
        for line in draft.split("\n"):
            s = C.normalize_line(line)
            if not s:
                continue
            if not skipped_cn and s == header_cn:
                skipped_cn = True
                continue
            if has_header_en and not skipped_en and s == header_en:
                skipped_en = True
                continue
            rr = with_bold(rpr) if is_bold_line(s) else rpr
            line_ppr = ppr_with(ppr, outline=1) if (re.match(r"^\d+-\d+\s", s) and C.cjk_count(s)) else ppr
            parts.append(make_paragraph(line.strip(), line_ppr, rr))
        replacements.append((spans[i][0], spans[j - 1][1], "".join(parts)))
        replaced.append(n)
    for start, end, new_xml in reversed(replacements):
        xml = xml[:start] + new_xml + xml[end:]
    out = Path(args.out) if args.out else (root / "output" / f"{Path(meta['docx']).stem}_导演执行版.docx")
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        zout = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)
    except PermissionError:
        print(f"[FAIL] output locked (close the docx in Word/WPS and rerun): {out}")
        return 3
    with zipfile.ZipFile(docx) as zin, zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/document.xml":
                data = xml.encode("utf-8")
            zout.writestr(item, data)
    print(f"[OK] writeback: {out} replaced={len(replaced)} eps")
    bad = roundtrip(out, root, replaced)
    if bad:
        print(f"[FAIL] roundtrip mismatches={bad}")
        return 1
    print("[OK] roundtrip all pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
