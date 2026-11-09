"""lianben2 — deterministic preflight engine (M1).

CLI contract (must not change):
    python -m lianben2 version
    python -m lianben2 preflight --root <projectDir> [--source <docx>] [--force]

0 LLM / 0 network. Only stdlib + python-docx.
"""

VERSION = "1.0.0"
SCHEMA_ENGINE = "lianben2/engine/1"
SCHEMA_PROJECT = "lianben/project/1"
SCHEMA_INDEX = "lianben/preflight_index/1"
SCHEMA_CHECK = "lianben/check/1"

__all__ = ["VERSION", "SCHEMA_ENGINE", "SCHEMA_PROJECT", "SCHEMA_INDEX", "SCHEMA_CHECK"]
