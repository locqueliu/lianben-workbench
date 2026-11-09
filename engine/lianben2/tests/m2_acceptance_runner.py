"""Run the shared 20-episode acceptance script (workspace/tests/acceptance_m1.py)
against THIS bundle's engine (M2), without touching the original script.

Usage:
    <python> -m lianben2.tests.m2_acceptance_runner
    <python> lianben2/tests/m2_acceptance_runner.py --json

The acceptance module hardcodes the M1 engine path; this runner patches its
module globals (ENGINE/FIXTURE/EXPECTED/WORK/ACCEPT) and then executes the very
same checks, so M2 acceptance == M1 acceptance assertions.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

ENGINE = Path(__file__).resolve().parent.parent.parent   # <plugin>/engine
BUNDLE = ENGINE.parent
PLUGIN = BUNDLE.parent
WS = PLUGIN.parent
ACCEPTANCE = WS / "tests" / "acceptance_m1.py"
TMP_ROOT = ENGINE / "lianben2" / ".selftest-tmp"
WORK = TMP_ROOT / "acceptance-m2"


def _load_module(path: Path):
    spec = importlib.util.spec_from_file_location("m1_acceptance_shared", str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--keep-tmp", action="store_true")
    args = ap.parse_args(argv)

    if not ACCEPTANCE.exists():
        print(json.dumps({"ok": False, "error": f"missing {ACCEPTANCE}"},
                         ensure_ascii=False, separators=(",", ":")))
        return 1
    if not (ENGINE / "lianben2" / "__main__.py").exists():
        print(json.dumps({"ok": False, "error": f"engine incomplete: {ENGINE}"},
                         ensure_ascii=False, separators=(",", ":")))
        return 1

    WORK.mkdir(parents=True, exist_ok=True)
    mod = _load_module(ACCEPTANCE)
    mod.ENGINE = ENGINE
    mod.FIXTURE = ENGINE / "fixtures" / "sample-20eps.docx"
    mod.EXPECTED = ENGINE / "fixtures" / "expected-20eps.json"
    mod.WORK = WORK
    mod.ACCEPT = WORK / "acceptance.json"

    ns = SimpleNamespace(fixture="", python="", timeout=180, keep_tmp=args.keep_tmp)
    record = mod.run_acceptance(ns)
    record = mod.finalize_record(record)
    WORK.mkdir(parents=True, exist_ok=True)
    record = mod.write_record(record)
    summary = record.get("summary") or {}
    out = {
        "ok": record.get("status") != "FAIL",
        "status": record.get("status"),
        "engine": str(ENGINE),
        "fixture": str(mod.FIXTURE),
        "pass": summary.get("pass"),
        "fail": summary.get("fail"),
        "skip": summary.get("skip"),
        "warn": summary.get("warn"),
        "elapsed_ms": record.get("elapsed_ms"),
        "checks": [{"id": c.get("id"), "status": c.get("status"),
                    "actual": c.get("actual")} for c in record.get("checks", [])],
        "acceptance_json": str(mod.ACCEPT),
    }
    print(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
