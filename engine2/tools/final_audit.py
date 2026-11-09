import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C
import check_ep as CE


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow-partial", action="store_true")
    args = ap.parse_args()
    root = C.ROOT
    meta = C.load_json(root / "work" / "meta" / "ep_index.json")
    if not meta:
        print("[FAIL] run split_docx.py first")
        return 2
    progress = C.load_json(root / "work" / "meta" / "progress.json", {"episodes": {}})
    total = len(meta["episodes"])
    passed, missing = [], []
    for e in meta["episodes"]:
        st = progress["episodes"].get(str(e["ep"]), {}).get("status", "pending")
        (passed if st in ("passed", "passed-with-issues") else missing).append(e["ep"])
    stem = Path(meta["docx"]).stem
    merged = root / "output" / f"{stem}_导演执行版.md"
    docx = root / "output" / f"{stem}_导演执行版.docx"
    report = {"total": total, "passed": len(passed), "missing": missing,
              "merged_md": str(merged), "merged_docx": str(docx)}
    ok = True
    if missing and not args.allow_partial:
        print(f"[FAIL] missing episodes: {missing}")
        ok = False
    if not merged.exists():
        print("[FAIL] merged md missing")
        ok = False
    else:
        mt = C.read_text(merged)
        absent = [n for n in passed
                  if not any(C.episode_number(line) == n for line in mt.splitlines())]
        if absent:
            print(f"[FAIL] merged md missing episode headers: {absent}")
            ok = False
        lines = mt.splitlines()
        first_header = next((i for i, line in enumerate(lines)
                             if C.episode_number(line) is not None), 0)
        scan = "\n".join(lines[first_header:])
        src_total = "\n".join(C.read_text(root / "work" / "source" / f"ep{n:02d}.md") for n in passed)
        for pat in CE.BANNED_PATTERNS:
            mc, sc = scan.count(pat), src_total.count(pat)
            if mc > sc:
                print(f"[FAIL] merged banned added: {pat} +{mc - sc}")
                ok = False
    if not docx.exists():
        print("[FAIL] merged docx missing")
        ok = False
    else:
        rt = C.load_json(root / "work" / "report" / "roundtrip.json", {})
        results = rt.get("results", [])
        rt_bad = [r for r in results if r["verdict"] != "PASS"]
        if rt_bad:
            print(f"[FAIL] roundtrip failures: {[r['ep'] for r in rt_bad]}")
            ok = False
        if len(results) < len(passed):
            print(f"[WARN] roundtrip covered {len(results)}/{len(passed)} eps")
    stats = {"cjk_src": 0, "cjk_draft": 0, "atoms_src": 0, "atoms_out": 0, "spectacle": 0}
    bilingual_errors = []
    culture_errors = []
    for n in passed:
        src = C.read_text(root / "work" / "source" / f"ep{n:02d}.md")
        dp = root / "work" / "draft" / f"ep{n:02d}.md"
        if dp.exists():
            dt = C.read_text(dp)
            _, _, s = C.core_checks(n, src, dt)
            bilingual_errors.extend(C.bilingual_alignment_errors(src, dt))
            bilingual_errors.extend(C.english_label_errors(dt))
            bilingual_errors.extend(C.spoken_order_errors(src, dt))
            bilingual_errors.extend(C.added_spoken_errors(src, dt))
            bilingual_errors.extend(C.label_added_errors(src, dt))
            bilingual_errors.extend(C.scene_speech_errors(src, dt))
            culture_errors.extend(C.culture_added_errors(src, dt))
            stats["cjk_src"] += s.get("cjk_src", 0)
            stats["cjk_draft"] += s.get("cjk_draft", 0)
            stats["atoms_src"] += s.get("atoms_src", 0)
            stats["atoms_out"] += s.get("atoms_out", 0)
            stats["spectacle"] += dt.count("SPECTACLE")
    report["stats"] = stats
    report["bilingual_errors"] = bilingual_errors
    report["culture_errors"] = culture_errors
    if bilingual_errors:
        print(f"[FAIL] bilingual/English-label errors: {bilingual_errors[:6]}")
        ok = False
    if culture_errors:
        print(f"[FAIL] culture-lock errors: {culture_errors[:6]}")
        ok = False
    C.save_json(root / "work" / "report" / "final_audit.json", report)
    print(f"[{'PASS' if ok else 'FAIL'}] final audit passed={len(passed)}/{total} "
          f"cjk={stats['cjk_src']}->{stats['cjk_draft']} atoms={stats['atoms_src']}->{stats['atoms_out']} "
          f"spectacle_tags={stats['spectacle']}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
