import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow-partial", action="store_true")
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    root = C.ROOT
    meta = C.load_json(root / "work" / "meta" / "ep_index.json")
    if not meta:
        print("[FAIL] run split_docx.py first")
        return 2
    progress = C.load_json(root / "work" / "meta" / "progress.json", {"episodes": {}})
    passed, missing, blocked = [], [], []
    for e in meta["episodes"]:
        st = progress["episodes"].get(str(e["ep"]), {}).get("status", "pending")
        (passed if st in ("passed", "passed-with-issues") else missing).append(e["ep"])
        if st == "blocked":
            blocked.append(e["ep"])
    blocked = sorted(set(blocked) | set(C.blocked_episode_numbers()))
    blocked = [n for n in blocked
               if progress["episodes"].get(str(n), {}).get("status")
               not in ("passed", "passed-with-issues")]
    if blocked:
        print(f"[WARN] blocked episodes not refined: {blocked}")
    if missing and not args.allow_partial:
        print(f"[FAIL] not all passed: missing={missing}")
        if blocked:
            print("[FAIL] blocked episodes must be fixed in source or merged with --allow-partial")
        return 1
    stem = Path(meta["docx"]).stem
    header = (
        f"# {stem} 导演执行版\n\n"
        "> 生成规格：无 BGM·有音效·无字幕·画面无新增文字 | 台词中英对照 | 写实电影质感 | "
        "Arri Alexa 65 × Panavision Sphero 65 × Phase One 12K | Redshift 体积光 | 长焦浅景深\n\n"
    )
    parts = [header]
    for n in passed:
        p = root / "work" / "draft" / f"ep{n:02d}.md"
        if p.exists():
            parts.append(C.read_text(p).rstrip() + "\n\n")
    out = Path(args.out) if args.out else (root / "output" / f"{stem}_导演执行版.md")
    C.write_text(out, "".join(parts).rstrip() + "\n")
    print(f"[OK] merged {len(passed)} episodes -> {out}")
    if missing:
        print(f"[WARN] missing episodes: {missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
