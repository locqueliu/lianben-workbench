import argparse
import datetime
import hashlib
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C


def dump_raw(root, texts):
    meta = root / "work" / "meta"
    meta.mkdir(parents=True, exist_ok=True)
    C.write_text(meta / "paragraphs.txt", "\n".join(texts) + "\n")
    nonempty = [t for t in texts if t.strip()]
    head = nonempty[:160]
    starts = [i for i, t in enumerate(texts) if C.episode_number(t) is not None]
    samples = []
    if starts:
        step = max(1, len(starts) // 5)
        for si in starts[::step][:6]:
            samples += [x for x in texts[si:si + 14]] + ["……"]
    sample = (
        "# 剧本格式样本（仅供人工查看，禁止改写本文件）\n\n"
        "## 开头若干段\n" + "\n".join(head) +
        "\n\n## 各集片段\n" + "\n".join(samples) + "\n"
    )
    C.write_text(meta / "_format_sample.md", sample)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docx", default=None)
    ap.add_argument("--root", default=None)
    ap.add_argument("--extract-only", action="store_true",
                    help="只导出原始段落与格式样本，不做分集")
    args = ap.parse_args()
    root = Path(args.root) if args.root else C.ROOT
    docx = Path(args.docx) if args.docx else None
    if docx is None:
        try:
            docx = C.resolve_docx(root)
        except ValueError as e:
            print(f"[FAIL] {e}")
            return 1
        if not docx:
            print("[FAIL] no source docx found in project root")
            return 1
    with zipfile.ZipFile(docx) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    px = C.extract_paragraph_xmls(xml)
    units = []
    for pi, p in enumerate(px):
        for si, line in enumerate(C.paragraph_text_lines(p)):
            units.append({"text": line, "para": pi, "sub": si})
    prepared, prep_stats = C.prepare_source_units(units)
    texts = [u["text"] for u in prepared]
    (root / "work" / "meta").mkdir(parents=True, exist_ok=True)
    C.save_json(root / "work" / "meta" / "line_map.json", {
        "source": str(docx),
        "paragraphs": len(px),
        "lines": [{"line": i, "para": u["para"], "sub": u["sub"]}
                  for i, u in enumerate(prepared)],
        "stats": prep_stats,
    })
    dump_raw(root, texts)
    print(f"[OK] extracted paras={len(texts)} (docx-p={len(px)}) -> work/meta/{{paragraphs.txt,_format_sample.md,line_map.json}}")
    if any(prep_stats.values()):
        print("[OK] normalized: " + ", ".join(f"{k}={v}" for k, v in prep_stats.items() if v))
    if args.extract_only:
        return 0
    eps = C.locate_episodes(texts)
    if not eps:
        print("[FAIL] no episodes found (expect headers like 第1集《标题》)")
        return 1
    source_dir = root / "work" / "source"
    meta_dir = root / "work" / "meta"
    source_dir.mkdir(parents=True, exist_ok=True)
    meta_dir.mkdir(parents=True, exist_ok=True)
    for sub in ("draft", "report", "logs"):
        (root / "work" / sub).mkdir(parents=True, exist_ok=True)
    (root / "output").mkdir(parents=True, exist_ok=True)
    ep_index = []
    for k, (i, n, title_cn) in enumerate(eps):
        j = eps[k + 1][0] if k + 1 < len(eps) else len(texts)
        body = texts[i:j]
        C.write_text(source_dir / f"ep{n:02d}.md", "\n".join(body).rstrip() + "\n")
        ep_index.append({
            "ep": n,
            "title": title_cn,
            "title_en": texts[i + 1].strip() if i + 1 < j else "",
            "para_start": i,
            "para_end": j,
            "lines": len(body),
            "cjk": C.cjk_count("\n".join(body)),
            "atoms": sum(1 for t in body if t.strip().startswith("△")),
            "scenes": sum(1 for t in body if re.match(r"^\d+-\d+\s", t.strip())),
        })
    index_path = meta_dir / "ep_index.json"
    previous_index = C.load_json(index_path, {}) or {}
    source_sha256 = hashlib.sha256(docx.read_bytes()).hexdigest()
    C.save_json(index_path, {
        "docx": str(docx),
        "source_sha256": source_sha256,
        "total_paragraphs": len(texts),
        "episodes": ep_index,
    })
    handoff = {}
    for k, e in enumerate(ep_index):
        prev_tail, next_head = [], []
        if k > 0:
            pl = [x for x in C.read_text(source_dir / f"ep{ep_index[k-1]['ep']:02d}.md").split("\n") if x.strip()]
            prev_tail = pl[-6:]
        if k + 1 < len(ep_index):
            nl = [x for x in C.read_text(source_dir / f"ep{ep_index[k+1]['ep']:02d}.md").split("\n") if x.strip()]
            next_head = nl[:8]
        handoff[str(e["ep"])] = {"prev_tail": prev_tail, "next_head": next_head}
    C.save_json(meta_dir / "handoff.json", handoff)
    prologue = [t for t in texts[:eps[0][0]] if t.strip()]
    prologue = [t for t in prologue
                if not (re.match(r"^第\s*\d+\s*集\s*[：:]", t) and len(t) > 30)]
    C.write_text(meta_dir / "facts_lock.md",
                 "# 全局锁定事实（原文档前置信息）\n\n"
                 "> 仅用于跨集一致性核对：人物名、术语、道具、时间线以此为准；不得据此新增剧情事实，不得写入正文引用。\n\n"
                 + "\n".join(prologue) + "\n")
    progress_path = meta_dir / "progress.json"
    progress = C.load_json(progress_path, None) or {"episodes": {}}
    if previous_index and previous_index.get("source_sha256") != source_sha256:
        print("[WARN] source docx changed; resetting episode progress", flush=True)
        progress = {"episodes": {}}
    for e in ep_index:
        key = str(e["ep"])
        cur = progress["episodes"].get(key, {})
        cur.setdefault("status", "pending")
        cur.setdefault("attempts", 0)
        cur.setdefault("reasons", [])
        cur["title"] = e["title"]
        progress["episodes"][key] = cur
    progress["updated"] = datetime.datetime.now().isoformat(timespec="seconds")
    C.save_json(progress_path, progress)
    total_cjk = sum(e["cjk"] for e in ep_index)
    total_atoms = sum(e["atoms"] for e in ep_index)
    print(f"[OK] split: docx={docx.name} episodes={len(ep_index)} paras={len(texts)} cjk={total_cjk} atoms={total_atoms}")
    print("[OK] wrote work/source/ep*.md and work/meta/{ep_index.json,handoff.json,facts_lock.md,progress.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
