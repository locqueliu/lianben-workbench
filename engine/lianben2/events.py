"""JSONL progress events for `preflight --events` (stderr only).

Contract:
    {"event":"phase","phase":"extract|detect|split|normalize|protagonist|checks|report",
     "index":0,"total":7}
    {"event":"episode","ep":1,"done":1,"total":20}
    {"event":"log","level":"info","message":"..."}

stdout stays a single final JSON line; without --events this module is a no-op
and never writes to stderr.
"""
from __future__ import annotations

import json
import sys

PHASES = ("extract", "detect", "split", "normalize", "protagonist", "checks", "report")
TOTAL_PHASES = len(PHASES)


class EventEmitter:
    def __init__(self, enabled: bool = False):
        self.enabled = bool(enabled)

    def _write(self, payload: dict) -> None:
        if not self.enabled:
            return
        print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
              file=sys.stderr, flush=True)

    def phase(self, name: str) -> None:
        if not self.enabled:
            return
        index = PHASES.index(name)
        self._write({"event": "phase", "phase": name, "index": index, "total": TOTAL_PHASES})

    def episode(self, ep: int, done: int, total: int) -> None:
        self._write({"event": "episode", "ep": int(ep), "done": int(done), "total": int(total)})

    def log(self, level: str, message: str) -> None:
        self._write({"event": "log", "level": str(level), "message": str(message)})

    def warn(self, message: str) -> None:
        self.log("warn", message)

    def info(self, message: str) -> None:
        self.log("info", message)
