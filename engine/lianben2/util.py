"""Shared helpers: text normalization, canonical compare, hashing, atomic IO."""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import secrets
import tempfile
import unicodedata
from pathlib import Path

from . import VERSION

ENGINE_DIR = Path(__file__).resolve().parent.parent          # <bundle>/engine
DEFAULTS_DIR = ENGINE_DIR / "defaults"
TOOLS_DIR = ENGINE_DIR / "tools"

INBOX_DIRNAME = "剧本输入"
EXCLUDED_NAME_PARTS = ("导演执行版", "配乐方案", "质检报告")

QUOTE_CHARS = "\"\"''「」『』“”‘’"


# ---------------------------------------------------------------------------
# time / ids
# ---------------------------------------------------------------------------
def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec="seconds")


def run_id() -> str:
    return datetime.datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + secrets.token_hex(2)


_ULID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"


def project_id() -> str:
    return "p_" + "".join(secrets.choice(_ULID_ALPHABET) for _ in range(26))


# ---------------------------------------------------------------------------
# hashing
# ---------------------------------------------------------------------------
def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def hash_obj(obj) -> str:
    canonical = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256_text(canonical)


# ---------------------------------------------------------------------------
# text
# ---------------------------------------------------------------------------
def read_text(path: Path) -> str:
    return Path(path).read_text(encoding="utf-8-sig")


def load_json_safe(path: Path, default=None):
    try:
        p = Path(path)
        if not p.exists():
            return default
        return json.loads(p.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError):
        return default


def norm_line(s: str) -> str:
    """Matching-only normalization (never persisted as content)."""
    s = (s or "").replace("\ufeff", "").replace("\u3000", " ")
    s = (s.replace("\u201c", '"').replace("\u201d", '"')
         .replace("\u2018", "'").replace("\u2019", "'"))
    return re.sub(r"\s+", " ", s).strip()


def raw_strip(s: str) -> str:
    """Only trim line edges (keeps inner full-width spaces)."""
    return (s or "").replace("\ufeff", "").strip()


def cjk_count(s: str) -> int:
    return len(re.findall(r"[\u4e00-\u9fff]", s))


def latin_letter_count(s: str) -> int:
    return len(re.findall(r"[A-Za-z]", s))


def canon(s: str) -> str:
    """Canonical text for lossless (G2) comparison.

    NFKC folds full-width punctuation/space; then whitespace and quotes are
    removed. Same rule as the old verify_optimized.canon but extended with
    NFKC (docs/03 M0 whitelist)."""
    s = unicodedata.normalize("NFKC", s or "")
    s = re.sub(r"\s+", "", s)
    for ch in QUOTE_CHARS:
        s = s.replace(ch, "")
    return s


# ---------------------------------------------------------------------------
# atomic writes
# ---------------------------------------------------------------------------
def write_text(path: Path, text: str) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=p.name + ".", suffix=".tmp", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_json(path: Path, obj) -> None:
    write_text(path, json.dumps(obj, ensure_ascii=False, indent=1) + "\n")


def dumps_line(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
