"""把 work/ 的运行产物归档到 work/archive/<时间戳>/，供重新开始新的剧本流程。"""
import shutil
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "work"
TARGETS = ("meta", "preflight", "source", "draft", "bgm", "report", "logs")


def main():
    if not WORK.exists():
        print("[OK] work/ 不存在，无需归档")
        return 0
    items = [WORK / t for t in TARGETS if (WORK / t).exists()]
    if not items:
        print("[OK] work/ 无历史产物，无需归档")
        return 0
    stamp = time.strftime("%Y%m%d_%H%M%S")
    dest = WORK / "archive" / stamp
    dest.mkdir(parents=True, exist_ok=True)
    moved = []
    for d in items:
        shutil.move(str(d), str(dest / d.name))
        moved.append(d.name)
    print(f"[OK] 已归档 {len(moved)} 个目录（{', '.join(moved)}） -> work/archive/{stamp}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
