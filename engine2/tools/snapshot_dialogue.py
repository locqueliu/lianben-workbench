"""冻结原文台词台账（零模型）。

从原始 docx 抽取每一句台词（无论是否带标签），写入 work/meta/source_dialogue.tsv。
台账只生成一次，之后由 tools/audit_dialogue.py 读取对账，不得覆盖。

用法：
  python tools/snapshot_dialogue.py
  python tools/snapshot_dialogue.py --docx 测试/xxx.docx --root <临时目录>
"""
import argparse
import csv
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C

HEADER = ["ep", "no", "scene", "speaker", "tag", "lang", "text", "hash", "para", "sub"]


def build(root, docx):
    docx = Path(docx)
    units, px, xml = C.extract_source_units(docx)
    prepared, stats = C.prepare_source_units(units)
    texts = [u["text"] for u in prepared]
    eps = C.locate_episodes(texts)
    if not eps:
        raise ValueError("未识别到任何集标题（支持 第N集 / 第N话 / EP N / Episode N / 中文数字）")

    records = []
    by_ep = {}
    for k, (i, n, _title) in enumerate(eps):
        j = eps[k + 1][0] if k + 1 < len(eps) else len(texts)
        scene = ""
        no = 0
        for idx in range(i, j):
            s = texts[idx]
            if not s:
                continue
            m = re.match(r"^(\d+[-－]\d+)\s", s)
            if m:
                scene = m.group(1).replace("－", "-")
                continue
            rec = C.parse_dialogue_line(s)
            if not rec:
                continue
            no += 1
            u = prepared[idx]
            records.append({
                "ep": n,
                "no": no,
                "scene": scene,
                "speaker": rec["speaker"],
                "tag": rec["label"],
                "lang": rec["lang"],
                "text": rec["text"],
                "hash": rec["hash"],
                "para": u["para"],
                "sub": u["sub"],
            })
        by_ep[str(n)] = no

    warnings = []
    br = len(re.findall(r"<w:br[ >/]", xml))
    if br:
        warnings.append(f"段内换行 {br} 处，已拆为独立行；回写时会按段落映射")
    tbl = len(re.findall(r"<w:tbl[ >]", xml))
    tbx = len(re.findall(r"<w:txbxContent[ >]", xml))
    if tbl or tbx:
        warnings.append(f"检测到表格 {tbl} 个、文本框 {tbx} 个；正文若在其中会被漏读，建议改为纯段落")
    if stats.get("toc_skipped"):
        warnings.append(f"目录/集纲行 {stats['toc_skipped']} 条已跳过（长「第N集：……」行不当作集标题）")
    shots = sum(1 for t in texts if re.match(r"^镜头\s*\d+", t))
    if shots:
        warnings.append(f"检测到镜头块 {shots} 个，疑似导演执行稿；请确认它确实是源剧本")

    meta_dir = Path(root) / "work" / "meta"
    meta_dir.mkdir(parents=True, exist_ok=True)
    tsv = meta_dir / "source_dialogue.tsv"
    with tsv.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter="\t", lineterminator="\n")
        w.writerow(HEADER)
        for r in records:
            row = [str(r[h]) if h not in ("text", "speaker") else r[h].replace("\t", " ").replace("\n", " ")
                   for h in HEADER]
            w.writerow(row)

    meta = {
        "source": docx.name,
        "source_path": str(docx),
        "sha256": hashlib.sha256(docx.read_bytes()).hexdigest(),
        "episodes": len(eps),
        "dialogue_lines": len(records),
        "tagged": sum(1 for r in records if r["tag"]),
        "untagged": sum(1 for r in records if not r["tag"]),
        "tag_counts": {t: sum(1 for r in records if r["tag"] == t) for t in ("对白", "VO", "OS")},
        "by_ep": by_ep,
        "normalized": stats,
        "warnings": warnings,
    }
    C.save_json(meta_dir / "source_dialogue.meta.json", meta)
    return tsv, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docx", default=None)
    ap.add_argument("--root", default=None)
    args = ap.parse_args()
    root = Path(args.root) if args.root else C.ROOT
    docx = Path(args.docx) if args.docx else None
    if docx is None:
        docx = C.resolve_docx(root)
    if not docx:
        print("[FAIL] 没有找到源 docx（请放入 剧本输入/）")
        return 1
    try:
        tsv, meta = build(root, docx)
    except Exception as e:
        print(f"[FAIL] snapshot: {e}")
        return 1
    print(f"[OK] dialogue ledger: episodes={meta['episodes']} lines={meta['dialogue_lines']} "
          f"tagged={meta['tagged']} untagged={meta['untagged']} -> {tsv}")
    for w in meta["warnings"]:
        print(f"[WARN] {w}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
