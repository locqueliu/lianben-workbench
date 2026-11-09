#!/usr/bin/env python3
"""Rebuild engine/bgm_fixtures/project from engine/refine_fixtures/project.

Dev helper only (no LLM).  The mock/ files are static, hand-maintained fixtures.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

FIXTURE_DIR = Path(__file__).resolve().parent
ENGINE_DIR = FIXTURE_DIR.parent
SRC = ENGINE_DIR / "refine_fixtures" / "project"
DST = FIXTURE_DIR / "project"


def main() -> int:
    if not SRC.is_dir():
        print(f"[FAIL] source fixture missing: {SRC}", file=sys.stderr)
        return 2
    if DST.exists():
        shutil.rmtree(DST)
    shutil.copytree(SRC, DST)
    print(json.dumps({
        "ok": True,
        "source": str(SRC),
        "target": str(DST),
        "files": sum(1 for p in DST.rglob("*") if p.is_file()),
    }, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
