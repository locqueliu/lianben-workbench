"""Fixed CLI contract for the DSH host.

    python -m lianben2 version
    python -m lianben2 preflight --root <projectDir> [--source <docxPath>] [--force]

stdout: exactly one JSON line. diagnostics -> stderr.
exit: 0 ok | 1 fatal | 2 needs_confirm | 3 docx locked / IO
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback

from . import SCHEMA_ENGINE, VERSION
from .errors import EngineError, IOProblem, NeedsConfirm
from .pipeline import run_preflight
from .util import dumps_line


class _Parser(argparse.ArgumentParser):
    def error(self, message: str):  # usage errors -> exit 1 + JSON on stdout
        print(dumps_line({
            "ok": False,
            "schema": SCHEMA_ENGINE,
            "version": VERSION,
            "error": {"code": "USAGE", "message": message},
        }))
        raise SystemExit(1)


def _emit(payload: dict) -> None:
    print(dumps_line(payload))


def _error_payload(exc: EngineError, code: int) -> dict:
    payload = {
        "ok": False,
        "schema": SCHEMA_ENGINE,
        "version": VERSION,
        "code": code,
        "error": exc.to_dict(),
    }
    if isinstance(exc, NeedsConfirm):
        payload["detection"] = exc.detection
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = _Parser(prog="lianben2")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("version", help="print engine version JSON")

    p_pre = sub.add_parser("preflight", help="run deterministic preflight pipeline")
    p_pre.add_argument("--root", required=True, help="project directory (auto-scaffolded)")
    p_pre.add_argument("--source", default=None, help="source docx (copied into 剧本输入/ if empty)")
    p_pre.add_argument("--force", action="store_true", help="archive previous work/ and rerun")
    p_pre.add_argument("--events", action="store_true",
                       help="emit JSONL progress events on stderr (stdout stays one JSON line)")

    args = parser.parse_args(argv)

    if args.cmd == "version":
        _emit({"ok": True, "version": VERSION, "schema": SCHEMA_ENGINE})
        return 0

    if args.cmd == "preflight":
        try:
            payload = run_preflight(args.root, args.source, force=args.force,
                                    events=bool(getattr(args, "events", False)))
            _emit(payload)
            return 0
        except NeedsConfirm as exc:
            _emit(_error_payload(exc, 2))
            return 2
        except IOProblem as exc:
            _emit(_error_payload(exc, 3))
            return 3
        except EngineError as exc:
            _emit(_error_payload(exc, 1))
            return 1
        except (OSError, PermissionError) as exc:
            _emit({
                "ok": False, "schema": SCHEMA_ENGINE, "version": VERSION,
                "error": {"code": "IO", "message": str(exc)},
            })
            return 3
        except Exception as exc:  # last-resort guard: single JSON line on stdout
            traceback.print_exc(file=sys.stderr)
            _emit({
                "ok": False, "schema": SCHEMA_ENGINE, "version": VERSION,
                "error": {"code": "FATAL", "message": f"{type(exc).__name__}: {exc}"},
            })
            return 1

    parser.print_usage(sys.stderr)
    _emit({"ok": False, "schema": SCHEMA_ENGINE, "version": VERSION,
           "error": {"code": "USAGE", "message": "missing command (version|preflight)"}})
    return 1


if __name__ == "__main__":
    sys.exit(main())
