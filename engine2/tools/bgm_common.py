#!/usr/bin/env python3
"""BGM 配乐工作流共用工具：路径、JSON、哈希、docx 读取。"""

from __future__ import annotations

import hashlib
import html
import json
import re
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "work"
SRC_DIR = WORK / "source"
DRAFT_DIR = WORK / "bgm"
REPORT_DIR = WORK / "report"
META_DIR = WORK / "meta"
LOGS_DIR = WORK / "logs"
OUTPUT_DIR = ROOT / "output"
REFS_DIR = ROOT / "参考资料" / "bgm配乐规则"
GLOBAL_STYLE = REFS_DIR / "global-style.md"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


# ---------- IO ----------

def read_text(path) -> str:
    p = Path(path)
    raw = p.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def write_text(path, text: str) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def load_json(path, default=None):
    p = Path(path)
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return default


def save_json(path, obj) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(p)


# ---------- hash / text ----------

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path) -> str:
    return sha256_bytes(Path(path).read_bytes())


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def cjk_count(s: str) -> int:
    return len(re.findall(r"[\u4e00-\u9fff]", s or ""))


def ascii_safe(s: str) -> str:
    return re.sub(r"[^\x00-\x7F]+", "?", str(s)).strip()


def norm_line(s: str) -> str:
    s = (s or "").replace("\ufeff", "").replace("\u3000", " ")
    return re.sub(r"\s+", " ", s).strip()


# ---------- docx ----------

def docx_paragraphs(path) -> list[str]:
    """用标准库读取 docx 段落文本；无外部依赖。"""
    p = Path(path)
    with zipfile.ZipFile(p) as z:
        xml = z.read("word/document.xml").decode("utf-8", errors="replace")
    xml = re.sub(r"<w:tab[^>]*/>", "\t", xml)
    xml = re.sub(r"<w:(?:br|cr)[^>]*/>", "\n", xml)
    xml = xml.replace("</w:p>", "\n" + "</w:p>")
    text = re.sub(r"<[^>]+>", "", xml)
    text = html.unescape(text)
    lines = [ln.rstrip() for ln in text.split("\n")]
    return [ln for ln in lines if ln.strip()]


# ---------- project files ----------

def ref_files() -> list[Path]:
    if not REFS_DIR.exists():
        return []
    return sorted(p for p in REFS_DIR.glob("*.md") if p.is_file())


def banned_terms() -> list[str]:
    text = read_text(GLOBAL_STYLE) if GLOBAL_STYLE.exists() else ""
    terms: list[str] = []
    in_section = False
    for line in text.splitlines():
        s = line.strip()
        if re.match(r"^#{1,6}\s*禁用清单", s):
            in_section = True
            continue
        if in_section:
            if re.match(r"^#{1,6}\s+", s):
                break
            m = re.match(r"^[-*]\s+(.+)$", s)
            if m:
                terms.append(m.group(1).strip())
    return terms


def safe_stem(path) -> str:
    stem = Path(path).stem
    return re.sub(r'[\\/:*?"<>|\s]+', "-", stem).strip("-") or "剧本"
