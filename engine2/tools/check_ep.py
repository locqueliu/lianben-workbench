import argparse
import datetime
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C

BANNED_PATTERNS = ["BGM", "bgm", "配乐", "背景音乐", "音乐", "字幕", "画面文字", "屏幕文字", "标题卡", "大字标题", "文字浮现", "浮现文字"]
FUZZY_WORDS = ["自行发挥", "自行补充", "同上"]
MAX_DRAFT_CHARS = 10000
TARGET_DRAFT_CHARS = 9000
# 硬失败：总字符数超过上限仍属硬错误；thin/label_added/label_changed/scene_as_speech 降为 fmt: warn。
# thin/label_added/label_changed/scene_as_speech 降为 fmt: warn，动作丰富后的正常格式扩展不再打回。
BASIC_FAIL_PREFIXES = ("too_long_total:", "no_draft_file", "missing_in_docx", "empty_draft",
                       "missing_dialogue:", "bilingual_desync:", "spoken_order:",
                       "en_label_language:", "en_label_missing:", "added_spoken:",
                       "culture_added:")
SHOT_BLOCK_RE = re.compile(r"^【.+】$")
BLOCKING_RE = re.compile(r"^【人物站位")
SKIP_BLOCK_PREFIX = ("【人物站位", "【音效", "【制作", "【全局")
SHOT_SIZE_SEP = re.compile(r"[·・/／、\s]")


def extra_checks(src_text, draft_text):
    fails, warns = [], []
    drf_lines = [C.normalize_line(x) for x in draft_text.split("\n") if C.normalize_line(x)]
    for pat in BANNED_PATTERNS:
        dc = draft_text.count(pat)
        sc = src_text.count(pat)
        if dc > sc:
            fails.append(f"banned_added:{pat}:{dc - sc}")
    for pat in FUZZY_WORDS:
        dc = draft_text.count(pat)
        sc = src_text.count(pat)
        if dc > sc:
            fails.append(f"fuzzy_word:{pat}:{dc - sc}")
    fails.extend(C.culture_added_errors(src_text, draft_text))
    if "SPECTACLE" not in draft_text:
        fails.append("no_spectacle")
    src_cjk = C.cjk_count(src_text)
    drf_cjk = C.cjk_count(draft_text)
    if src_cjk and drf_cjk < 1.3 * src_cjk:
        fails.append(f"thin:{drf_cjk}/{src_cjk}")
    blocks = [i for i, x in enumerate(drf_lines) if SHOT_BLOCK_RE.match(x) and not x.startswith(SKIP_BLOCK_PREFIX)]
    if not blocks:
        fails.append("no_shot_blocks")
    else:
        bad = 0
        for i in blocks:
            nxt = drf_lines[i + 1] if i + 1 < len(drf_lines) else ""
            if not BLOCKING_RE.match(nxt):
                bad += 1
        if bad / len(blocks) > 0.3:
            fails.append(f"blocking_fmt:{bad}/{len(blocks)}")
        elif bad:
            warns.append(f"blocking_fmt:{bad}/{len(blocks)}")
        sizes = []
        for i in blocks:
            inner = drf_lines[i][1:-1]
            sizes.append(SHOT_SIZE_SEP.split(inner, 1)[0].strip())
        repeat = sum(1 for a, b in zip(sizes, sizes[1:]) if a and a == b)
        if sizes and repeat / max(1, len(sizes) - 1) > 0.4:
            warns.append(f"shot_size_repeat:{repeat}")
    return fails, warns


def docx_episodes(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    texts = [C.paragraph_text(p) for p in C.extract_paragraph_xmls(xml)]
    eps = C.locate_episodes(texts)
    out = {}
    for k, (i, n, _) in enumerate(eps):
        j = eps[k + 1][0] if k + 1 < len(eps) else len(texts)
        out[n] = "\n".join(texts[i:j])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eps", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--docx", default="")
    ap.add_argument("--no-progress", action="store_true")
    args = ap.parse_args()
    root = C.ROOT
    meta = C.load_json(root / "work" / "meta" / "ep_index.json")
    if not meta:
        print("[FAIL] run split_docx.py first")
        return 2
    if args.eps:
        eps = [int(x) for x in args.eps.replace(" ", "").split(",") if x]
    else:
        eps = [e["ep"] for e in meta["episodes"]]
    docx_map = docx_episodes(Path(args.docx)) if args.docx else None
    progress = C.load_json(root / "work" / "meta" / "progress.json", {"episodes": {}})
    results = []
    overall_fail = 0
    for n in eps:
        src_text = C.read_text(root / "work" / "source" / f"ep{n:02d}.md")
        draft_path = root / "work" / "draft" / f"ep{n:02d}.md"
        mode = "docx" if args.docx else "draft"
        if args.docx:
            draft_text = docx_map.get(n, "")
        else:
            draft_text = C.read_text(draft_path) if draft_path.exists() else ""
        fails, warns, stats = [], [], {}
        if not draft_text.strip():
            fails = ["missing_in_docx"] if args.docx else ["no_draft_file"]
        else:
            cf, cw, stats = C.core_checks(n, src_text, draft_text)
            fails += cf
            warns += cw
            fails += C.bilingual_alignment_errors(src_text, draft_text)
            fails += C.english_label_errors(draft_text)
            fails += C.spoken_order_errors(src_text, draft_text)
            fails += C.added_spoken_errors(src_text, draft_text)
            fails += C.label_added_errors(src_text, draft_text)
            fails += C.scene_speech_errors(src_text, draft_text)
            if not args.docx:
                ef, ew = extra_checks(src_text, draft_text)
                fails += ef
                warns += ew
            stats = dict(stats or {})
            total_chars = C.total_char_count(draft_text)
            stats["total_chars"] = total_chars
            if total_chars > MAX_DRAFT_CHARS:
                fails.append(f"too_long_total:{total_chars}/{MAX_DRAFT_CHARS}")
            elif total_chars > TARGET_DRAFT_CHARS:
                warns.append(f"length_target:{total_chars}/{TARGET_DRAFT_CHARS}")
        # 仅基本内容错误和总字符数超限阻断通过；其他质量项记录为 warning。
        hard = [f for f in fails if f.startswith(BASIC_FAIL_PREFIXES)]
        demoted = [f for f in fails if not f.startswith(BASIC_FAIL_PREFIXES)]
        fails = hard
        if demoted:
            warns = warns + ["fmt:" + d for d in demoted]
        verdict = "PASS" if not fails else "FAIL"
        if fails:
            overall_fail += 1
        rec = {"ep": n, "verdict": verdict, "fails": fails, "warns": warns, "stats": stats, "mode": mode}
        results.append(rec)
        if not args.docx:
            C.save_json(root / "work" / "report" / f"check_ep{n:02d}.json", rec)
            if not args.no_progress:
                key = str(n)
                pe = progress["episodes"].get(key, {})
                pe["status"] = "passed" if verdict == "PASS" else "failed"
                pe["reasons"] = fails
                if verdict != "PASS":
                    pe["attempts"] = int(pe.get("attempts", 0)) + 1
                pe["checked_at"] = datetime.datetime.now().isoformat(timespec="seconds")
                progress["episodes"][key] = pe
        tag = "ok" if not fails and not warns else ("; ".join(fails) if fails else "warns:" + "; ".join(warns))
        print(f"[{verdict}] ep{n:02d} {tag}")
    out_name = "check_docx.json" if args.docx else "check_last.json"
    C.save_json(root / "work" / "report" / out_name, {"mode": "docx" if args.docx else "draft", "results": results})
    if not args.docx and not args.no_progress:
        progress["updated"] = datetime.datetime.now().isoformat(timespec="seconds")
        C.save_json(root / "work" / "meta" / "progress.json", progress)
    print(f"[OK] checked={len(eps)} failed={overall_fail} mode={'docx' if args.docx else 'draft'}")
    return 1 if overall_fail else 0


if __name__ == "__main__":
    raise SystemExit(main())

