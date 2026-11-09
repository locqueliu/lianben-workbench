"""逐句台词对账（零模型）。

读取 work/meta/source_dialogue.tsv，与成品（md/docx）或分集稿逐句比对：
  - 原文台词是否被改动
  - 对白 / VO / OS 标签是否被改动、丢失或新增
  - 是否有漏句、多句、说话人错位

默认只出报告、不阻断；需要卡交付时加 --fail-on-diff。

用法：
  python tools/audit_dialogue.py
  python tools/audit_dialogue.py --draft
  python tools/audit_dialogue.py --final output/xxx_竖屏分镜稿.docx
  python tools/audit_dialogue.py --dir work/source
"""
import argparse
import csv
import datetime
import difflib
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C

FAIL_STATUSES = ("文本改动", "说话人改动", "标签改动", "标签丢失", "漏句", "多句", "语种改动")


def load_ledger(root):
    tsv = Path(root) / "work" / "meta" / "source_dialogue.tsv"
    meta_path = Path(root) / "work" / "meta" / "source_dialogue.meta.json"
    if not tsv.exists():
        raise ValueError("缺少 work/meta/source_dialogue.tsv，请先运行 tools/snapshot_dialogue.py")
    rows = []
    with tsv.open("r", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f, delimiter="\t"):
            r["ep"] = int(r["ep"])
            r["no"] = int(r["no"])
            r["label"] = r.get("tag", "") or ""
            rows.append(r)
    meta = C.load_json(meta_path, {}) or {}
    return rows, meta


def read_lines(path):
    path = Path(path)
    if path.suffix.lower() == ".docx":
        units, _px, _xml = C.extract_source_units(path)
        lines = [C.normalize_line(u["text"]) for u in units]
    else:
        lines = [C.normalize_line(x) for x in C.read_text(path).splitlines()]
    return C.prepare_source_lines(lines)


def collect_records(lines):
    records = []
    scene = ""
    for idx, raw in enumerate(lines):
        s = C.normalize_line(raw)
        if not s:
            continue
        m = re.match(r"^(\d+[-－]\d+)\s", s)
        if m:
            scene = m.group(1).replace("－", "-")
            continue
        rec = C.parse_dialogue_line(s)
        if rec:
            rec["scene"] = scene
            rec["line"] = idx
            records.append(rec)
    return records


def text_status(src, out):
    if src == out:
        return "OK"
    if C.canon_dialogue_text(src) == C.canon_dialogue_text(out):
        return "格式差异"
    return "文本改动"


def label_status(src_tag, out_tag):
    if not src_tag:
        if not out_tag:
            return "OK"
        return "补标-对白" if out_tag == "对白" else "补标-需确认"
    if not out_tag:
        return "标签丢失"
    if src_tag != out_tag:
        return "标签改动"
    return "OK"


def make_row(ep, no, scene, speaker, src_tag, out_tag, src_text, out_text, statuses, notes):
    fails = [s for s in statuses if s in FAIL_STATUSES]
    infos = [s for s in statuses if s and s != "OK" and s not in FAIL_STATUSES]
    if fails:
        status = "；".join(dict.fromkeys(fails + infos))
    elif infos:
        status = "；".join(dict.fromkeys(infos))
    else:
        status = "OK"
    return {
        "集": ep,
        "序号": no,
        "场次": scene,
        "说话人": speaker,
        "原标签": src_tag,
        "成品标签": out_tag,
        "原文台词": src_text,
        "成品台词": out_text,
        "状态": status,
        "说明": "；".join(n for n in notes if n),
    }


def compare_records(ep, src, out):
    scene = (src or {}).get("scene") or (out or {}).get("scene") or ""
    src_text = (src or {}).get("text", "")
    out_text = (out or {}).get("text", "")
    src_tag = (src or {}).get("label", "") or (src or {}).get("tag", "")
    out_tag = (out or {}).get("label", "") or (out or {}).get("tag", "")
    src_speaker = (src or {}).get("speaker", "")
    out_speaker = (out or {}).get("speaker", "")
    no = (src or {}).get("no", "") or (out or {}).get("line", "")
    statuses, notes = [], []
    if src_text and out_text:
        statuses.append(text_status(src_text, out_text))
        if C.spoken_norm(src_speaker) != C.spoken_norm(out_speaker):
            statuses.append("说话人改动")
            notes.append(f"说话人 {src_speaker}→{out_speaker}")
        statuses.append(label_status(src_tag, out_tag))
        if src_tag != out_tag:
            notes.append(f"标签 {src_tag or '无'}→{out_tag or '无'}")
    elif src_text and not out_text:
        statuses.append("漏句")
        notes.append("成品缺少该台词")
    else:
        statuses.append("多句")
        notes.append("成品新增该台词")
    return [make_row(ep, no, scene, src_speaker or out_speaker,
                     src_tag, out_tag, src_text, out_text, statuses, notes)]


def align_by_lang_chunks(ep, src_records, out_records):
    """Match source lines to one or more consecutive same-language output chunks.

    This is the normal case for compliant long-line splitting: CN and EN streams are
    consumed independently, so interleaved CN/EN chunks still map back to source.
    Returns None when a real text change/order shift is detected, letting the
    hash-based matcher handle it.
    """
    pools = {}
    for r in out_records:
        lang = r.get("lang") or ""
        if lang not in ("cn", "en"):
            return None
        pools.setdefault(lang, []).append(r)
    cursor = {k: 0 for k in pools}
    rows = []
    for s in src_records:
        lang = s.get("lang") or ""
        if lang not in ("cn", "en"):
            return None
        target = C.canon_dialogue_text(s.get("text", ""))
        if not target:
            return None
        pool = pools.get(lang, [])
        pos = cursor.get(lang, 0)
        chunks = []
        concat = ""
        while pos < len(pool):
            rec = pool[pos]
            concat += C.canon_dialogue_text(rec.get("text", ""))
            chunks.append(rec)
            pos += 1
            if concat == target:
                break
            if not target.startswith(concat):
                return None
        if concat != target or not chunks:
            return None
        cursor[lang] = pos
        statuses = [text_status(s.get("text", ""), "".join(r.get("text", "") for r in chunks))]
        notes = []
        if len(chunks) > 1:
            statuses.append("拆分-允许")
            notes.append(f"{lang.upper()} 长句拆为 {len(chunks)} 段")
        src_tag = s.get("label", "") or s.get("tag", "")
        tags = [(r.get("label") or r.get("tag") or "") for r in chunks]
        explicit = [t for t in tags if t]
        if src_tag:
            if not explicit:
                statuses.append("标签丢失")
            elif any(t != src_tag for t in explicit):
                statuses.append("标签改动")
        else:
            if any(t in ("VO", "OS") for t in explicit):
                statuses.append("补标-需确认")
            elif any(t == "对白" for t in explicit):
                statuses.append("补标-对白")
        if any(C.spoken_norm(r.get("speaker", "")) != C.spoken_norm(s.get("speaker", ""))
               for r in chunks):
            statuses.append("说话人改动")
        out_text = "".join(r.get("text", "") for r in chunks) if lang == "cn" \
            else " ".join(r.get("text", "") for r in chunks)
        rows.append(make_row(ep, s.get("no", ""), s.get("scene", ""), s.get("speaker", ""),
                             src_tag, explicit[0] if explicit else "", s.get("text", ""),
                             out_text, statuses, notes))
    if any(cursor.get(k, 0) < len(v) for k, v in pools.items()):
        return None
    return rows


def align_episode(ep, src_records, out_records):
    by_chunks = align_by_lang_chunks(ep, src_records, out_records)
    if by_chunks is not None:
        return by_chunks
    events = []
    sm = difflib.SequenceMatcher(None, [r.get("hash", "") for r in src_records],
                                 [r.get("hash", "") for r in out_records], autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                events.append(("pair", src_records[i1 + k], out_records[j1 + k]))
        elif tag == "replace":
            n = min(i2 - i1, j2 - j1)
            for k in range(n):
                events.append(("pair", src_records[i1 + k], out_records[j1 + k]))
            for k in range(i1 + n, i2):
                events.append(("missing", src_records[k], None))
            for k in range(j1 + n, j2):
                events.append(("added", None, out_records[k]))
        elif tag == "delete":
            for k in range(i1, i2):
                events.append(("missing", src_records[k], None))
        elif tag == "insert":
            for k in range(j1, j2):
                events.append(("added", None, out_records[k]))
    return resolve_splits(ep, events)


def make_split_row(ep, src, chunks):
    lang = src.get("lang", "")
    parts = [r.get("text", "") for r in chunks]
    out_text = " ".join(p.strip() for p in parts) if lang == "en" else "".join(parts)
    statuses = [text_status(src.get("text", ""), out_text), "拆分-允许"]
    notes = [f"{lang.upper() or '台词'} 长句拆为 {len(chunks)} 段"]
    src_tag = src.get("label", "") or src.get("tag", "")
    tags = [(r.get("label") or r.get("tag") or "") for r in chunks]
    explicit = [t for t in tags if t]
    if src_tag:
        if not explicit:
            statuses.append("标签丢失")
        elif any(t != src_tag for t in explicit):
            statuses.append("标签改动")
    else:
        if any(t in ("VO", "OS") for t in explicit):
            statuses.append("补标-需确认")
        elif any(t == "对白" for t in explicit):
            statuses.append("补标-对白")
    out_tag = explicit[0] if explicit else ""
    return make_row(ep, src.get("no", ""), src.get("scene", ""),
                    src.get("speaker", ""), src_tag, out_tag,
                    src.get("text", ""), out_text, statuses, notes)


def resolve_splits(ep, events):
    """Recognise compliant long-line splits (CN/EN chunks) instead of reporting 漏句/多句."""
    added_by_lang = {}
    for idx, e in enumerate(events):
        if e[0] == "added":
            added_by_lang.setdefault(e[2].get("lang", ""), []).append((idx, e[2]))
    used = set()
    split_rows = {}

    def completion(lang, start_idx, target, prefix):
        pool = added_by_lang.get(lang, [])
        concat = prefix
        chosen = []
        for idx, rec in pool:
            if idx <= start_idx or idx in used:
                continue
            concat += C.canon_dialogue_text(rec.get("text", ""))
            chosen.append(rec)
            if concat == target:
                return chosen
            if not target.startswith(concat):
                return None
        return None

    for i, e in enumerate(events):
        kind, src, out = e
        if kind == "pair" and src and out:
            src_c = C.canon_dialogue_text(src.get("text", ""))
            out_c = C.canon_dialogue_text(out.get("text", ""))
            if out_c and src_c != out_c and src_c.startswith(out_c):
                chunks = completion(src.get("lang", ""), i, src_c, out_c)
                if chunks and all(
                        C.spoken_norm(r.get("speaker", "")) == C.spoken_norm(src.get("speaker", ""))
                        for r in chunks):
                    for r in chunks:
                        for idx2, rec2 in added_by_lang.get(src.get("lang", ""), []):
                            if rec2 is r:
                                used.add(idx2)
                    split_rows[i] = make_split_row(ep, src, [out] + chunks)
                    continue
        if kind != "missing":
            continue
        src = e[1]
        lang = src.get("lang", "")
        target = C.canon_dialogue_text(src.get("text", ""))
        if len(target) < 8:
            continue
        chunks = completion(lang, i, target, "")
        if chunks and len(chunks) >= 2 and all(
                C.spoken_norm(r.get("speaker", "")) == C.spoken_norm(src.get("speaker", ""))
                for r in chunks):
            for r in chunks:
                for idx2, rec2 in added_by_lang.get(lang, []):
                    if rec2 is r:
                        used.add(idx2)
            split_rows[i] = make_split_row(ep, src, chunks)

    rows = []
    for i, e in enumerate(events):
        if i in split_rows:
            rows.append(split_rows[i])
            continue
        kind, src, out = e
        if kind == "pair":
            rows += compare_records(ep, src, out)
        elif kind == "missing":
            rows += compare_records(ep, src, None)
        else:
            if i in used:
                continue
            rows += compare_records(ep, None, out)
    return rows


def split_final(root, final_arg, mode):
    """Return [(ep, lines)] for the target output."""
    root = Path(root)
    if final_arg:
        path = Path(final_arg)
        lines = read_lines(path)
        eps = C.locate_episodes(lines)
        if not eps:
            raise ValueError(f"成品没有集标题：{path}")
        out = []
        for k, (i, n, _t) in enumerate(eps):
            j = eps[k + 1][0] if k + 1 < len(eps) else len(lines)
            out.append((n, lines[i:j]))
        return out
    if mode in ("source", "draft"):
        folder = root / "work" / ("source" if mode == "source" else "draft")
        files = sorted(folder.glob("ep*.md"))
        if not files:
            raise ValueError(f"{folder} 下没有 ep*.md")
        out = []
        for p in files:
            lines = read_lines(p)
            n = C.episode_number(lines[0]) if lines else None
            if n is None:
                m = re.search(r"ep(\d+)", p.stem)
                n = int(m.group(1)) if m else None
            if n is None:
                raise ValueError(f"无法确定集号：{p}")
            out.append((n, lines))
        return out
    # default: final product, md first then docx
    meta = C.load_json(root / "work" / "meta" / "source_dialogue.meta.json", {}) or {}
    stem = Path(meta.get("source", "剧本")).stem
    for cand in (root / "output" / f"{stem}_竖屏分镜稿.md",
                 root / "output" / f"{stem}_竖屏分镜稿.docx"):
        if cand.exists():
            return split_final(root, cand, mode)
    raise ValueError("未找到成品；请先运行 /炼剧本，或使用 --source/--draft/--final")


def build_report(rows, meta):
    by_ep = {}
    for r in rows:
        by_ep.setdefault(r["集"], []).append(r)
    summary = []
    for ep in sorted(by_ep):
        rs = by_ep[ep]
        fails = sum(1 for r in rs if r["状态"].split("；")[0] in FAIL_STATUSES
                    or any(s in r["状态"] for s in FAIL_STATUSES))
        tagged = sum(1 for r in rs if r["原标签"])
        untagged = len(rs) - tagged
        summary.append({
            "ep": ep,
            "rows": len(rs),
            "tagged": tagged,
            "untagged": untagged,
            "ok": sum(1 for r in rs if r["状态"] == "OK"),
            "labeled": sum(1 for r in rs if r["状态"] == "补标-对白"),
            "confirm": sum(1 for r in rs if "补标-需确认" in r["状态"]),
            "format": sum(1 for r in rs if "格式差异" in r["状态"]),
            "fails": fails,
        })
    total_fails = sum(s["fails"] for s in summary)
    return summary, total_fails


def write_audit(root, meta, rows, summary, total_fails, missing_eps=None):
    """Write machine-readable audit result; the final QC report consumes it."""
    missing_eps = missing_eps or []
    report = {
        "generated": datetime.datetime.now().isoformat(timespec="seconds"),
        "source": meta,
        "totals": {
            "rows": len(rows),
            "fails": total_fails,
            "auto_labeled": sum(1 for r in rows if "补标-对白" in r["状态"]),
            "confirm": sum(1 for r in rows if "补标-需确认" in r["状态"]),
            "format_only": sum(1 for r in rows if "格式差异" in r["状态"]),
            "split": sum(1 for r in rows if "拆分-允许" in r["状态"]),
            "missing_eps": missing_eps,
        },
        "summary": summary,
        "rows": rows,
    }
    path = Path(root) / "work" / "report" / "dialogue_audit.json"
    C.save_json(path, report)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=None)
    ap.add_argument("--final", default=None)
    ap.add_argument("--source", action="store_true", help="对账 work/source/ep*.md")
    ap.add_argument("--draft", action="store_true", help="对账 work/draft/ep*.md")
    ap.add_argument("--dir", default=None, help="对账指定目录下的 ep*.md")
    ap.add_argument("--include-missing", action="store_true",
                    help="把台账中未出现在目标里的集按漏句处理（默认跳过）")
    ap.add_argument("--fail-on-diff", action="store_true")
    args = ap.parse_args()
    root = Path(args.root) if args.root else C.ROOT
    try:
        ledger, meta = load_ledger(root)
        mode = "source" if args.source else ("draft" if args.draft else "final")
        if args.dir:
            folder = Path(args.dir)
            files = sorted(folder.glob("ep*.md"))
            targets = []
            for p in files:
                lines = read_lines(p)
                n = C.episode_number(lines[0]) if lines else None
                if n is None:
                    m = re.search(r"ep(\d+)", p.stem)
                    n = int(m.group(1)) if m else None
                if n is None:
                    raise ValueError(f"无法确定集号：{p}")
                targets.append((n, lines))
        else:
            targets = split_final(root, args.final, mode)
    except Exception as e:
        print(f"[FAIL] audit: {e}")
        return 2

    ledger_by_ep = {}
    for r in ledger:
        ledger_by_ep.setdefault(r["ep"], []).append(r)

    rows = []
    target_eps = {n for n, _ in targets}
    for ep, lines in sorted(targets):
        src_rows = ledger_by_ep.get(ep, [])
        rows += align_episode(ep, src_rows, collect_records(lines))
    missing_eps = sorted(set(ledger_by_ep) - target_eps)
    if missing_eps and args.include_missing:
        for ep in missing_eps:
            rows += align_episode(ep, ledger_by_ep[ep], [])

    summary, total_fails = build_report(rows, meta)
    audit_path = write_audit(root, meta, rows, summary, total_fails, missing_eps)
    if missing_eps:
        print(f"[WARN] 未覆盖集 {missing_eps}（默认跳过；需要按漏句统计请加 --include-missing）")
    for s in summary:
        if not (s["fails"] or s["confirm"] or s["labeled"]):
            continue
        print(f"EP{s['ep']:02d} 行{s['rows']}｜OK {s['ok']}｜补标(对白) {s['labeled']}｜"
              f"需确认 {s['confirm']}｜格式 {s['format']}｜失败 {s['fails']}")
    print(f"[{'FAIL' if total_fails else 'PASS'}] dialogue audit rows={len(rows)} fails={total_fails}")
    print(f"[OK] {audit_path}（供交付核对，不单独生成输出文件）")
    if args.fail_on_diff and total_fails:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
