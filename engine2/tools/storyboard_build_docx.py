import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C
from analysis_build_docx import build_docx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--md", default="")
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    root = C.ROOT
    meta = C.load_json(root / "work" / "meta" / "ep_index.json", {}) or {}
    stem = Path(meta.get("docx") or "剧本").stem or "剧本"
    md = Path(args.md) if args.md else (root / "output" / f"{stem}_竖屏分镜稿.md")
    if not md.exists():
        print(f"[FAIL] 未找到分镜稿：{md}")
        return 1
    out = Path(args.out) if args.out else (root / "output" / f"{stem}_竖屏分镜稿.docx")
    build_docx(C.read_text(md), out)
    print(f"[OK] {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
