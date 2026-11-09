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
    meta = C.load_json(root / "work" / "meta" / "ep_index.json", {}) or {}
    if not meta:
        print("[FAIL] run /前置检查 first")
        return 2
    stem = Path(meta.get("docx") or "剧本").stem or "剧本"
    eps = sorted(e["ep"] for e in meta.get("episodes", []))
    files = {int(p.stem[2:]): p for p in (root / "work" / "storyboard").glob("ep*.md")}
    missing = [n for n in eps if n not in files]
    if missing and not args.allow_partial:
        print(f"[FAIL] missing episodes: {missing}")
        return 1
    parts = []
    for n in eps:
        p = files.get(n)
        if p and p.exists():
            parts.append(C.read_text(p).rstrip() + "\n\n")
    out = Path(args.out) if args.out else (root / "output" / f"{stem}_竖屏分镜稿.md")
    C.write_text(out, "".join(parts).rstrip() + "\n")
    print(f"[OK] merged {len(parts)} episodes -> {out}")
    if missing:
        print(f"[WARN] missing episodes: {missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
