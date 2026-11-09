"""Error model and exit-code contract.

Exit codes (fixed CLI contract):
    0 success
    1 fatal (bad usage / unexpected failure; stdout {"ok":false,"error":...})
    2 needs_confirm (low detection confidence / 0 episodes; stdout carries detection)
    3 docx locked or IO error
"""
from __future__ import annotations


class EngineError(Exception):
    exit_code = 1
    kind = "FATAL"

    def __init__(self, message: str, details: dict | None = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}

    def to_dict(self) -> dict:
        d = {"code": self.kind, "message": self.message}
        if self.details:
            d["details"] = self.details
        return d


class FatalError(EngineError):
    exit_code = 1
    kind = "FATAL"


class NeedsConfirm(EngineError):
    exit_code = 2
    kind = "NEEDS_CONFIRM"

    def __init__(self, message: str, detection: dict):
        super().__init__(message, {"detection": detection})
        self.detection = detection


class IOProblem(EngineError):
    exit_code = 3
    kind = "IO"
