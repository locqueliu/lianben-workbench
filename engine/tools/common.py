import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCENE_HEADER_RE = re.compile(r"^\d+\s*[-－]\s*\d+\s")


def read_text(path):
    return Path(path).read_text(encoding="utf-8-sig")


def write_text(path, text):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def load_json(path, default=None):
    p = Path(path)
    if not p.exists():
        return default
    return json.loads(p.read_text(encoding="utf-8-sig"))


def load_json_safe(path, default=None):
    try:
        return load_json(path, default)
    except (OSError, ValueError, TypeError):
        return default


def save_json(path, obj):
    write_text(path, json.dumps(obj, ensure_ascii=False, indent=1) + "\n")


# ---------------------------------------------------------------------------
# 文化背景硬锁：SOURCE 未出现的中国/东方文化符号，不得由富化阶段新增。
# 覆盖器物、服饰、称谓、节庆，以及动作/礼仪类东方元素（跪礼、叩首、拱手、万福等）。
# 该表是确定性安全网，只覆盖高置信度词；语义判断仍以 director/optimizer 规则为准。
# ---------------------------------------------------------------------------
CULTURE_ACTION_TERMS = (
    "双膝跪地", "双膝下跪", "双膝跪倒", "三跪九叩", "跪地叩首",
    "叩首", "磕头", "行跪礼", "跪礼", "跪叩",
    "稽首", "顿首", "打千", "跪安", "道万福", "万福礼", "敛衽",
    "拱手礼", "作揖礼", "抱拳礼",
    "跪地", "长跪", "跪伏", "伏地跪", "跪坐", "正坐",
    "五体投地", "合十", "请安",
)

CULTURE_TERMS = (
    "中式", "筷子", "筷架", "一筷之礼", "筷礼",
    "拱手", "作揖", "跪拜", "拂袖", "抱拳",
    "旗袍", "长衫", "汉服", "唐装", "绣花鞋",
    "青砖", "瓦檐", "纸窗", "灯笼", "屏风", "太师椅",
    "客栈", "茶楼", "衙门", "祠堂", "四合院",
    "春节", "中秋", "饺子", "茶道",
    "皇上", "王爷", "银两", "铜钱",
    "古筝", "琵琶", "二胡", "古琴", "笛子", "唢呐", "京剧",
    "家主", "老爷", "师父", "师兄",
) + CULTURE_ACTION_TERMS


def culture_added_errors(src_text, draft_text):
    """Return terms present in draft but absent from source (source-aware check)."""
    src = src_text or ""
    draft = draft_text or ""
    matched = [term for term in CULTURE_TERMS if term in draft and term not in src]
    if "筷" in draft and "筷" not in src:
        matched.append("筷")
    # Drop redundant substrings: 双膝跪地 already covers 跪地, 筷子 already covers 筷.
    kept = []
    for term in sorted(set(matched), key=len, reverse=True):
        if any(term in other for other in kept):
            continue
        kept.append(term)
    return [f"culture_added:{term}" for term in kept]


# ---------------------------------------------------------------------------
# Format profile: 由 tools/assemble_source.py 依据标准格式自动生成 work/meta/format.json。
# 文件缺失时回退到内置默认（保证不整体崩溃）。
# ---------------------------------------------------------------------------

DEFAULT_PROFILE = {
    "version": 1,
    "episode": {
        "header_pattern": r"^第\s*(\d+)\s*集",
        "en_pattern": r"(?i:episode)\s*\d+",
    },
    "locked_line_patterns": [
        r"^第\s*\d+\s*集",
        r"(?i:episode)\s*\d+",
        r"^\d+[-－]\d+",
        r"^(?:出场人物|人物)\s*[：:]",
        r"^(?:SPECTACLE|VFX|HERO)\b",
        r"^【",
    ],
    "speaker": {"colon": "[：:]", "labels": ["对白", "VO", "OS"]},
    "atom": {"prefixes": ["△"]},
}

_PROFILE = None


def profile_path():
    return ROOT / "work" / "meta" / "format.json"


def load_profile(reload=False):
    global _PROFILE
    if _PROFILE is not None and not reload:
        return _PROFILE
    prof = None
    p = profile_path()
    if p.exists():
        try:
            prof = json.loads(p.read_text(encoding="utf-8-sig"))
        except Exception:
            prof = None
    if not isinstance(prof, dict):
        prof = {}
    for k, v in DEFAULT_PROFILE.items():
        prof.setdefault(k, v)
    _PROFILE = prof
    return prof


def _compile(pattern):
    return re.compile(pattern)


def _safe_compile(pattern, fallback, what):
    try:
        return re.compile(pattern)
    except re.error as e:
        print(f"[WARN] invalid {what} regex in format.json ({e}); fallback to default", flush=True)
        return re.compile(fallback)


def episode_re():
    pat = (load_profile().get("episode", {}) or {}).get("header_pattern")
    if not pat:
        pat = DEFAULT_PROFILE["episode"]["header_pattern"]
    return _safe_compile(pat, DEFAULT_PROFILE["episode"]["header_pattern"], "episode")


def episode_en_re():
    pat = (load_profile().get("episode", {}) or {}).get("en_pattern")
    if not pat:
        return None
    return _safe_compile(pat, DEFAULT_PROFILE["episode"]["en_pattern"], "episode English")


def episode_number(line):
    """Return the episode number captured by the configured header pattern."""
    m = episode_re().match(normalize_line(line))
    if not m:
        return None
    for gi in range(1, (m.re.groups or 0) + 1):
        value = m.group(gi)
        if value and value.strip().isdigit():
            return int(value)
    return None


def is_episode_en_header(line):
    er = episode_en_re()
    return bool(er and er.search(normalize_line(line)))


def struct_re():
    pats = load_profile().get("locked_line_patterns") or DEFAULT_PROFILE["locked_line_patterns"]
    try:
        return re.compile("(?:" + "|".join(pats) + ")")
    except re.error as e:
        print(f"[WARN] invalid locked_line_patterns in format.json ({e}); fallback to default", flush=True)
        return re.compile("(?:" + "|".join(DEFAULT_PROFILE["locked_line_patterns"]) + ")")


def speaker_labels():
    labs = load_profile().get("speaker", {}).get("labels")
    return labs if labs else DEFAULT_PROFILE["speaker"]["labels"]


def extract_paragraph_xmls(xml):
    return re.findall(r"<w:p[ >].*?</w:p>", xml, re.S)


def paragraph_text(p_xml):
    parts = re.findall(r"<w:t[^>]*>(.*?)</w:t>", p_xml, re.S)
    s = "".join(parts)
    return (s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
             .replace("&apos;", "'").replace("&amp;", "&"))


def escape_xml(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def load_heading_style_ids(docx_path):
    """读取 docx 的 styles.xml，返回标题类样式（名称含 heading/标题）的 styleId 集合。"""
    ids = set()
    try:
        with zipfile.ZipFile(docx_path) as z:
            st = z.read("word/styles.xml").decode("utf-8", errors="replace")
    except (KeyError, OSError, zipfile.BadZipFile):
        return ids
    for m in re.finditer(r'<w:style [^>]*w:styleId="([^"]+)"[^>]*>(.*?)</w:style>', st, re.S):
        sid, body = m.group(1), m.group(2)
        nm = re.search(r'<w:name w:val="([^"]*)"', body)
        if nm and re.search(r"(?i)heading|标题", nm.group(1)):
            ids.add(sid)
    return ids


def is_heading_ppr(ppr, heading_ids):
    """段落属性是否带标题特征（标题类样式或 0-8 级大纲）。"""
    if not ppr:
        return False
    for m in re.finditer(r'<w:pStyle\s+w:val="([^"]+)"', ppr):
        if m.group(1) in heading_ids:
            return True
    return bool(re.search(r'<w:outlineLvl[^>]*w:val="[0-8]"[^>]*/>', ppr))


def strip_heading_ppr(ppr, heading_ids):
    """清洗段落属性：移除大纲级别与标题类样式引用，得到正文级 pPr。"""
    if not ppr:
        return ppr
    ppr = re.sub(r"<w:outlineLvl[^>]*/>", "", ppr)
    ppr = re.sub(r'<w:pStyle\s+w:val="([^"]+)"\s*/>',
                 lambda m: "" if m.group(1) in heading_ids else m.group(0), ppr)
    return ppr


def find_body_templates(px, i, j, heading_ids):
    """在段落范围 [i, j) 内寻找正文模板，跳过带标题特征的段落，返回清洗后的 (ppr, rpr)。

    找不到合适正文段时回退第一段并清洗标题属性，保证不会把标题样式扩散到全篇。
    """
    def _extract(p):
        mp = re.search(r"<w:pPr>.*?</w:pPr>", p, re.S)
        mr = re.search(r"<w:rPr>.*?</w:rPr>", p, re.S)
        return (mp.group(0) if mp else ""), (mr.group(0) if mr else "")

    fallback = ("", "")
    for k in range(i, min(j, len(px))):
        if not paragraph_text(px[k]).strip():
            continue
        ppr, rpr = _extract(px[k])
        if not fallback[0] and not fallback[1]:
            fallback = (ppr, rpr)
        if is_heading_ppr(ppr, heading_ids):
            continue
        return strip_heading_ppr(ppr, heading_ids), rpr
    ppr, rpr = fallback
    return strip_heading_ppr(ppr, heading_ids), rpr


def normalize_line(s):
    s = s.replace("\ufeff", "")
    s = s.replace("\u3000", " ")
    s = s.replace("\u201c", '"').replace("\u201d", '"')
    s = s.replace("\u2018", "'").replace("\u2019", "'")
    return re.sub(r"\s+", " ", s).strip()


def cjk_count(s):
    return len(re.findall(r"[\u4e00-\u9fff]", s))


def bigrams(s):
    s = s.lower()
    out = set()
    for i in range(len(s) - 1):
        a, b = s[i], s[i + 1]
        if re.match(r"[\u4e00-\u9fffa-z0-9]", a) and re.match(r"[\u4e00-\u9fffa-z0-9]", b):
            out.add(a + b)
    return out


def resolve_docx(root):
    root = Path(root)
    inbox = root / "剧本输入"
    search_dirs = [inbox, root] if inbox.is_dir() else [root]
    for d in search_dirs:
        cands = [p for p in d.glob("*.docx")
                 if not p.name.startswith("~$")
                 and "导演执行版" not in p.name and "配乐方案" not in p.name]
        if cands:
            if len(cands) > 1:
                names = ", ".join(p.name for p in sorted(cands, key=lambda p: p.name.lower()))
                raise ValueError(f"multiple source docx files found in {d.name}: {names}; keep only one")
            return cands[0]
    return None


def locate_episodes(texts):
    starts = []
    seen = set()
    for i, t in enumerate(texts):
        s = t.strip()
        n = episode_number(s)
        if n is None:
            continue
        if n in seen:
            continue
        seen.add(n)
        starts.append((i, n, s))
    return starts


QUOTE_CHARS = "「」『』“”‘’\"'"


def is_structural_line(s):
    return bool(struct_re().match(s))


def strip_quotes(s):
    return s.translate({ord(c): None for c in QUOTE_CHARS})


def spoken_norm(s):
    return re.sub(r"\s+", "", strip_quotes(s))


def detect_tag(s):
    # Canonical values are the source-language labels used by the checker.
    for tag in speaker_labels():
        if re.search(r"[（(]" + re.escape(tag) + r"(?:[，,、：:）)]|\s|$)", s):
            return {"对白": "对白", "VO": "VO", "OS": "OS"}.get(tag, tag)
    for tag, canonical in (("DIALOGUE", "对白"), ("DIALOG", "对白"),
                           ("VO", "VO"), ("OS", "OS")):
        if re.search(r"[（(]" + tag + r"(?:[，,、：:)]|\s|$)", s, re.I):
            return canonical
    return None


def is_latin_dominant(s):
    return len(re.findall(r"[A-Za-z]", s)) > cjk_count(s)


def is_cjk_dominant(s):
    return cjk_count(s) > len(re.findall(r"[A-Za-z]", s))


def split_speaker(line):
    depth = 0
    for i, ch in enumerate(line):
        if ch in "（(":
            depth += 1
        elif ch in "）)":
            depth = max(0, depth - 1)
        elif ch in "：:" and depth == 0:
            prefix, text = line[:i].strip(), line[i + 1:].strip()
            return (prefix, text) if prefix and text else None
    return None


def split_src_spoken(line):
    sp = split_speaker(line)
    if sp:
        return "dialogue", sp[0], sp[1]
    return "narration", "", line


def parse_draft_spoken(lines):
    records = []
    for ln in lines:
        if is_structural_line(ln) or ln.startswith("△"):
            continue
        sp = split_speaker(ln)
        if not sp:
            records.append({"raw": ln, "ok": False, "prefix": "", "text": ln, "tag": None, "annot": False})
            continue
        prefix, text = sp
        annot = ("（" in prefix and "）" in prefix) or ("(" in prefix and ")" in prefix)
        records.append({"raw": ln, "ok": True, "prefix": prefix, "text": text,
                        "tag": detect_tag(prefix), "annot": annot,
                        "lang": spoken_lang(ln)})
    return records


def speaker_name(prefix):
    return re.split(r"[（(]", prefix, 1)[0].strip()


def cast_names(line):
    """Parse a 人物/出场人物 line into names."""
    m = re.match(r"^(?:人物|出场人物)\s*[：:]\s*(.*)$", normalize_line(line))
    if not m:
        return []
    return [x.strip() for x in re.split(r"[\s、，,/／]+", m.group(1)) if x.strip()]


def dialogue_speaker(line):
    """Return the speaker of a labelled dialogue line, else None."""
    s = normalize_line(line)
    if not s or s.startswith("△") or is_structural_line(s):
        return None
    pair = split_speaker(s)
    if not pair:
        return None
    prefix = pair[0]
    if not detect_tag(prefix):
        return None
    return speaker_name(prefix)


def has_name(text, names):
    """Case-insensitive Latin word match + substring match for CJK names."""
    for name in names or []:
        if not name:
            continue
        if re.search(r"[A-Za-z]", name) and cjk_count(name) == 0:
            if re.search(rf"(?<![A-Za-z]){re.escape(name)}(?![A-Za-z])", text, re.I):
                return True
        elif name in text:
            return True
    return False


def spoken_lang(s):
    """按台词正文判定语种，与说话人名/前缀无关（前缀可能是英文名或带中文标注）。"""
    sp = split_speaker(s)
    if not sp:
        return None
    text = strip_quotes(sp[1])
    cjk = cjk_count(text)
    latin = len(re.findall(r"[A-Za-z]", text))
    if cjk and not latin:
        return "cn"
    if latin and not cjk:
        return "en"
    if cjk and latin:
        return "cn" if cjk * 2 >= latin else "en"
    return None


def is_en_spoken(s):
    return spoken_lang(s) == "en"


def is_cn_spoken(s):
    return spoken_lang(s) == "cn"


def source_bilingual_pairs(src_text):
    """Return adjacent CN/EN source dialogue pairs as immutable text units."""
    lines = [normalize_line(x) for x in src_text.split("\n") if normalize_line(x)]
    records = []
    for line in lines:
        if line.startswith("△") or is_structural_line(line):
            continue
        sp = split_speaker(line)
        if not sp:
            continue
        prefix, text = sp
        lang = spoken_lang(line)
        if lang in ("cn", "en"):
            records.append({"raw": line, "prefix": prefix, "text": text,
                            "lang": lang, "tag": detect_tag(prefix)})
    pairs = []
    for a, b in zip(records, records[1:]):
        if a["lang"] == "cn" and b["lang"] == "en":
            pairs.append(a | {"en_text": b["text"], "en_prefix": b["prefix"],
                              "en_tag": b["tag"]})
    return pairs


def source_spoken_segments(src_text):
    """Build per-language source speech streams and source-label spans."""
    streams = {"cn": "", "en": ""}
    segments = {"cn": [], "en": []}
    for raw in [normalize_line(x) for x in src_text.split("\n") if normalize_line(x)]:
        if raw.startswith("△") or is_structural_line(raw):
            continue
        sp = split_speaker(raw)
        text = sp[1] if sp else raw
        lang = _line_lang(raw, text)
        if not lang or not text:
            continue
        piece = spoken_norm(text)
        start = len(streams[lang])
        streams[lang] += piece
        segments[lang].append({"start": start, "end": len(streams[lang]),
                                "raw": raw, "tag": detect_tag(sp[0]) if sp else None})
    return streams, segments


def _consume_bilingual_pair(pair, records, start):
    """Match one source CN+EN pair against split draft records."""
    remaining = {"cn": spoken_norm(pair["text"]),
                 "en": spoken_norm(pair["en_text"])}
    chunks = {"cn": 0, "en": 0}
    sequence = []
    idx = start
    while idx < len(records) and (remaining["cn"] or remaining["en"]):
        rec = records[idx]
        lang = rec["lang"]
        if lang not in remaining:
            return None
        piece = spoken_norm(rec["text"])
        if not piece or not remaining[lang].startswith(piece):
            return None
        remaining[lang] = remaining[lang][len(piece):]
        chunks[lang] += 1
        sequence.append(lang)
        idx += 1
    if remaining["cn"] or remaining["en"] or not sequence or sequence[0] != "cn":
        return None
    alternating = all(a != b for a, b in zip(sequence, sequence[1:]))
    if chunks["cn"] != chunks["en"] or not alternating:
        return {"end": idx, "cn_chunks": chunks["cn"], "en_chunks": chunks["en"],
                "reason": "chunk_count"}
    return {"end": idx, "cn_chunks": chunks["cn"], "en_chunks": chunks["en"]}


def bilingual_alignment_errors(src_text, draft_text):
    """Detect unsynchronised CN/EN splitting while allowing 1:1 paired chunks."""
    pairs = source_bilingual_pairs(src_text)
    if not pairs:
        return []
    lines = [normalize_line(x) for x in draft_text.split("\n") if normalize_line(x)]
    records = [r for r in parse_draft_spoken(lines) if r["ok"] and r.get("lang") in ("cn", "en")]
    errors = []
    cursor = 0
    for pair in pairs:
        found = None
        for i in range(cursor, len(records)):
            if records[i]["lang"] != "cn":
                continue
            piece = spoken_norm(records[i]["text"])
            if not piece or not spoken_norm(pair["text"]).startswith(piece):
                continue
            result = _consume_bilingual_pair(pair, records, i)
            if result:
                found = result | {"start": i}
                cursor = result["end"]
                break
        if found is None:
            errors.append(f"bilingual_desync:{pair['prefix']}")
        elif found.get("reason") == "chunk_count":
            errors.append(f"bilingual_desync:{pair['prefix']}:cn={found['cn_chunks']},en={found['en_chunks']}")
    return errors


def english_label_errors(draft_text):
    lines = [normalize_line(x) for x in draft_text.split("\n") if normalize_line(x)]
    errors = []
    for rec in parse_draft_spoken(lines):
        if not rec["ok"] or rec.get("lang") != "en":
            continue
        prefix = rec["prefix"]
        if re.search(r"[（(][^）)]*(?:对白|对话|旁白)[^）)]*[）)]", prefix):
            errors.append(f"en_label_language:{rec['raw']}")
    return errors


def _line_lang(line, text=None):
    lang = spoken_lang(line)
    if lang:
        return lang
    value = text if text is not None else line
    cjk = cjk_count(value)
    latin = len(re.findall(r"[A-Za-z]", value))
    if cjk and not latin:
        return "cn"
    if latin and not cjk:
        return "en"
    return None


def spoken_order_errors(src_text, draft_text):
    """Check that spoken source lines keep their original order in the draft."""
    src_entries = []
    for raw in [normalize_line(x) for x in src_text.split("\n") if normalize_line(x)]:
        if raw.startswith("△") or is_structural_line(raw):
            continue
        sp = split_speaker(raw)
        text = sp[1] if sp else raw
        if text and _line_lang(raw, text):
            src_entries.append((spoken_norm(text), _line_lang(raw, text), raw))
    lines = [normalize_line(x) for x in draft_text.split("\n") if normalize_line(x)]
    draft_records = [r for r in parse_draft_spoken(lines) if r["ok"] and r.get("lang") in ("cn", "en")]
    streams = {"cn": "", "en": ""}
    segments = {"cn": [], "en": []}
    for record_index, rec in enumerate(draft_records):
        lang = rec["lang"]
        piece = spoken_norm(rec["text"])
        start = len(streams[lang])
        streams[lang] += piece
        segments[lang].append((start, len(streams[lang]), record_index))
    positions = []
    # M3 patch: occurrence-aware lookup. The legacy code searched each source
    # line with str.find() from position 0, so a source that legitimately
    # repeats the same dialogue text (e.g. a phrase said twice) mapped every
    # occurrence to the FIRST draft occurrence, producing a false
    # `spoken_order:` error even when src and draft are byte-identical. Keep
    # the same order-swap detection but map the k-th source occurrence to the
    # k-th draft occurrence (sequential per-language cursor).
    seen: dict[tuple[str, str], int] = {}
    cursor: dict[tuple[str, str], int] = {}
    for needle, lang, raw in src_entries:
        if not needle or not streams[lang]:
            continue
        key = (lang, needle)
        seen[key] = seen.get(key, 0) + 1
        pos = streams[lang].find(needle, cursor.get(key, 0))
        if pos < 0:  # duplicate text moved beyond the cursor: fall back once
            pos = streams[lang].find(needle)
        if pos < 0:
            continue
        cursor[key] = pos + len(needle)
        record_index = next((ri for start, end, ri in segments[lang] if start <= pos < end), None)
        if record_index is not None:
            positions.append((record_index, raw))
    errors = []
    for (prev_idx, prev_raw), (cur_idx, cur_raw) in zip(positions, positions[1:]):
        if cur_idx < prev_idx:
            errors.append(f"spoken_order:{prev_raw} -> {cur_raw}")
            break
    return errors


def added_spoken_errors(src_text, draft_text):
    """Reject annotated draft speech that is not a sequential source-text slice."""
    source_streams, _ = source_spoken_segments(src_text)

    lines = [normalize_line(x) for x in draft_text.split("\n") if normalize_line(x)]
    records = parse_draft_spoken(lines)
    cursors = {"cn": 0, "en": 0}
    errors = []
    for rec in records:
        # Only labelled speech is treated as a speech claim. Camera/action
        # prose with a colon remains outside this whitelist check.
        if not rec["ok"] or not rec.get("annot") or rec.get("lang") not in ("cn", "en"):
            continue
        piece = spoken_norm(rec["text"])
        if not piece:
            continue
        lang = rec["lang"]
        pos = source_streams[lang].find(piece, cursors[lang])
        if pos < 0:
            errors.append(f"added_spoken:{rec['raw']}")
            continue
        cursors[lang] = pos + len(piece)
    return errors


def label_added_errors(src_text, draft_text):
    """Reject adding a speech label where SOURCE had no speech label."""
    source_streams, source_segments = source_spoken_segments(src_text)
    lines = [normalize_line(x) for x in draft_text.split("\n") if normalize_line(x)]
    records = parse_draft_spoken(lines)
    cursors = {"cn": 0, "en": 0}
    errors = []
    for rec in records:
        if not rec["ok"] or not rec.get("annot") or rec.get("lang") not in ("cn", "en"):
            continue
        piece = spoken_norm(rec["text"])
        lang = rec["lang"]
        pos = source_streams[lang].find(piece, cursors[lang])
        if pos < 0:
            continue
        cursors[lang] = pos + len(piece)
        segment = next((seg for seg in source_segments[lang]
                        if seg["start"] <= pos < seg["end"]), None)
        if segment is not None and segment["tag"] is None:
            errors.append(f"label_added:{rec['raw']}")
    return errors


def scene_speech_errors(src_text, draft_text):
    """Reject labelled speech copied from △ scene/action descriptions."""
    atoms = [spoken_norm(normalize_line(x)[1:].strip())
             for x in src_text.split("\n")
             if normalize_line(x).startswith("△")]
    atoms = [a for a in atoms if len(a) >= 8]
    if not atoms:
        return []
    source_streams, _ = source_spoken_segments(src_text)
    lines = [normalize_line(x) for x in draft_text.split("\n") if normalize_line(x)]
    errors = []
    for rec in parse_draft_spoken(lines):
        if not rec["ok"] or not rec.get("annot") or rec.get("lang") not in ("cn", "en"):
            continue
        piece = spoken_norm(rec["text"])
        if len(piece) < 8:
            continue
        if piece in source_streams[rec["lang"]]:
            continue
        if any(piece in atom or atom in piece for atom in atoms):
            errors.append(f"scene_as_speech:{rec['raw']}")
    return errors


def strip_cn_spoken(text):
    lines = text.split("\n")
    out = []
    for i, raw in enumerate(lines):
        s = normalize_line(raw)
        if s and not s.startswith("△") and not is_structural_line(s) and is_cn_spoken(s):
            nxt = ""
            for j in range(i + 1, len(lines)):
                t = normalize_line(lines[j])
                if t:
                    nxt = t
                    break
            if is_en_spoken(nxt):
                continue
        out.append(raw)
    return "\n".join(out)


def draft_docx_checks(ep, draft_text, docx_text):
    fails, stats = [], {}
    d_lines = [normalize_line(x) for x in draft_text.split("\n") if normalize_line(x)]
    dx_lines = [normalize_line(x) for x in docx_text.split("\n") if normalize_line(x)]
    if not dx_lines:
        return ["missing_in_docx"], stats
    if episode_number(dx_lines[0]) != ep:
        fails.append("missing_header")
    from collections import Counter
    available = Counter(dx_lines)
    missing = []
    for line in d_lines:
        if available[line]:
            available[line] -= 1
        else:
            missing.append(line)
    if missing:
        fails.append(f"missing_lines:{len(missing)}:{' || '.join(missing[:2])[:120]}")
    stats["lines_draft"] = len(d_lines)
    stats["lines_docx"] = len(dx_lines)
    stats["cjk_draft"] = cjk_count(draft_text)
    stats["cjk_docx"] = cjk_count(docx_text)
    return fails, stats


# ---------------------------------------------------------------------------
# 主角镜头规划（shot_plan）：P=主角镜，R=主角关系镜，N=非主角镜。
# ---------------------------------------------------------------------------
SHOT_BLOCK_LINE_RE = re.compile(r"^【.+】$")
SHOT_SKIP_PREFIXES = ("【人物站位", "【音效", "【制作", "【全局")
SHOT_SUBJECT_TYPES = {"protagonist", "support", "environment", "prop", "spectacle"}
SHOT_ANCHOR_P = {"face", "eyes", "body", "action", "hand", "pov", "voice", "reaction", "decision"}
SHOT_ANCHOR_R = {"pov", "ots", "foreground", "frame", "observe", "object", "hand",
                 "voice", "reaction", "cause", "sound", "reflection", "shadow"}
SHOT_ANCHOR_N = {"none"}
SHOT_ANCHOR_MARKERS = {
    "pov": ("POV", "主观", "视点", "第一视角"),
    "ots": ("过肩", "肩后", "前景肩"),
    "foreground": ("前景", "画左前", "画右前", "虚焦前景", "前虚"),
    "frame": ("门框", "窗框", "画框", "框内", "缝隙", "门缝", "窗格"),
    "observe": ("看着", "望向", "注视", "观察", "视线", "盯"),
    "object": ("手", "指", "物件", "道具", "手机", "照片", "信", "刀", "杯", "钥匙", "门把"),
    "hand": ("手", "指", "掌", "腕"),
    "voice": ("VO", "OS", "画外", "旁白", "内心"),
    "reaction": ("反应", "脸色", "眼神", "呼吸", "下颌", "喉结", "眉", "眼睑", "嘴角"),
    "cause": ("因为", "于是", "随即", "下一刻", "话音", "动作", "反手", "回头"),
    "sound": ("脚步", "呼吸", "敲", "响", "声音", "闷响", "摩擦"),
    "reflection": ("反光", "倒影", "玻璃", "水面", "镜面"),
    "shadow": ("影子", "阴影", "投在"),
}
SHOT_DEFAULTS = {
    "related_ratio_min": 0.70,
    "related_ratio_target": 0.80,
    "protagonist_share_min": 0.35,
    "n_ratio_max": 0.30,
    "n_run_max": 2,
    "support_run_max": 2,
    "protagonist_closeup_share_min": 0.30,
    "anchor_variety_min": 3,
    "observe_share_max": 0.30,
    "anchor_missing_max": 0.20,
}


def blocked_episode_numbers():
    """Preflight protagonist blocks, independent of progress.json."""
    data = load_json_safe(ROOT / "work" / "preflight" / "protagonist.json", {}) or {}
    if not isinstance(data, dict):
        data = {}
    out = []
    for value in data.get("blocked_eps") or []:
        try:
            out.append(int(value))
        except (TypeError, ValueError):
            continue
    return out


def load_shot_profile():
    data = load_json_safe(ROOT / "shot-profile.json", {}) or {}
    if not isinstance(data, dict):
        data = {}
    prof = dict(SHOT_DEFAULTS)
    for key, value in (data.get("shots") or {}).items():
        if key in prof:
            prof[key] = value
    prof["enabled"] = bool(data.get("enabled", True))
    prof["mode"] = str(data.get("mode", "warn"))
    return prof


def scene_blocks(lines):
    starts = [i for i, line in enumerate(lines) if SCENE_HEADER_RE.match(line)]
    if not starts:
        return [{"scene": "1-1", "lines": lines}]
    out = []
    for k, start in enumerate(starts):
        end = starts[k + 1] if k + 1 < len(starts) else len(lines)
        scene = normalize_line(lines[start]).split(" ", 1)[0]
        out.append({"scene": scene, "lines": lines[start:end]})
    return out


def scene_protagonist_map(src_text, names):
    lines = [normalize_line(x) for x in (src_text or "").split("\n") if normalize_line(x)]
    out = []
    for block in scene_blocks(lines):
        evidence = set()
        for line in block["lines"]:
            if line.startswith("△") and has_name(line, names):
                evidence.add("△")
            for name in cast_names(line):
                if has_name(name, names):
                    evidence.add("人物")
            speaker = dialogue_speaker(line)
            if speaker and has_name(speaker, names):
                pair = split_speaker(line)
                tag = detect_tag(pair[0]) if pair else None
                evidence.add(tag or "对白")
        out.append({
            "scene": block["scene"],
            "has_protagonist": bool(evidence),
            "evidence": sorted(evidence),
        })
    return out


def draft_shots(draft_text):
    """Split a draft into shot segments. One 【...】 block (excluding metadata) = one shot."""
    lines = [normalize_line(x) for x in (draft_text or "").split("\n") if normalize_line(x)]
    shots = []
    scene = "1-1"
    current = None
    for line in lines:
        if SCENE_HEADER_RE.match(line):
            if current is not None:
                shots.append(current)
                current = None
            scene = line.split(" ", 1)[0]
            continue
        if SHOT_BLOCK_LINE_RE.match(line) and not line.startswith(SHOT_SKIP_PREFIXES):
            if current is not None:
                shots.append(current)
            current = {"header": line, "scene": scene, "lines": [line]}
            continue
        if current is not None:
            current["lines"].append(line)
    if current is not None:
        shots.append(current)

    for shot in shots:
        visual, prefixes = [], []
        for line in shot["lines"]:
            if line.startswith("【") or line.startswith("△"):
                visual.append(line)
            else:
                pair = split_speaker(line)
                if pair:
                    prefixes.append(pair[0])
        shot["visual_text"] = "\n".join(visual)
        shot["prefix_text"] = "\n".join(prefixes)
    return shots


def _episode_scene_map(ep, src_text, names):
    data = load_json_safe(ROOT / "work" / "preflight" / "protagonist.json", {}) or {}
    if not isinstance(data, dict):
        data = {}
    for rec in data.get("episodes") or []:
        try:
            if int(rec.get("ep", -1)) == int(ep) and rec.get("scene_map"):
                return rec["scene_map"]
        except (TypeError, ValueError):
            continue
    return scene_protagonist_map(src_text, names)


def protagonist_shot_errors(ep, src_text, draft_text, report):
    """Validate work/report/epNN.json#shot_plan against the draft shots.

    Returns (fails, warns, stats). Hard failures are only emitted when
    shot-profile.json mode == "enforce"; in "warn" mode everything is a warning.
    """
    prof = load_shot_profile()
    if not prof.get("enabled"):
        return [], [], {}
    if not isinstance(report, dict):
        report = {}

    enforce = prof.get("mode") == "enforce"
    fails, warns = [], []

    def add(message, when=True, hard=False):
        if not when:
            return
        if hard and enforce:
            fails.append(message)
        else:
            warns.append(message if message.startswith("shot:") else "shot:" + message)

    protagonist = load_json_safe(ROOT / "work" / "meta" / "protagonist.json", {}) or {}
    if not isinstance(protagonist, dict):
        protagonist = {}
    names = [protagonist.get("protagonist", "")]
    names.extend(protagonist.get("aliases") or [])
    names = [x for x in names if x]
    if not names:
        add("protagonist_profile_missing", hard=True)
        return fails, warns, {}

    plan = (report or {}).get("shot_plan") or {}
    plan_shots = plan.get("shots")
    draft = draft_shots(draft_text)
    if not isinstance(plan_shots, list) or not plan_shots:
        add("protagonist_plan_missing", hard=True)
        return fails, warns, {"shot_total": len(draft)}

    if len(plan_shots) != len(draft):
        add(f"protagonist_shot_count_mismatch:{len(plan_shots)}/{len(draft)}", hard=True)

    normalized = []
    for i, item in enumerate(plan_shots):
        if not isinstance(item, dict):
            add(f"protagonist_plan_invalid:shot{i + 1}", hard=True)
            continue
        relation = str(item.get("relation", "")).strip().upper()
        anchor = str(item.get("anchor", "")).strip().lower()
        subject_type = str(item.get("subject_type", "")).strip().lower()
        if relation not in ("P", "R", "N"):
            add(f"protagonist_plan_invalid:shot{i + 1}:relation={relation}", hard=True)
            continue
        if subject_type not in SHOT_SUBJECT_TYPES:
            add(f"protagonist_plan_invalid:shot{i + 1}:subject_type={subject_type}", hard=True)
            continue
        allowed = SHOT_ANCHOR_P if relation == "P" else (
            SHOT_ANCHOR_R if relation == "R" else SHOT_ANCHOR_N)
        if anchor not in allowed:
            add(f"protagonist_plan_invalid:shot{i + 1}:anchor={anchor}", hard=True)
            continue
        try:
            no = int(item.get("no"))
        except (TypeError, ValueError):
            no = -1
        if no != i + 1:
            add(f"protagonist_plan_invalid:shot{i + 1}:no={item.get('no')}", hard=True)
        normalized.append({
            "no": i + 1,
            "scene": str(item.get("scene", "")).strip(),
            "subject_type": subject_type,
            "relation": relation,
            "anchor": anchor,
        })

    total = len(normalized)
    if not total:
        add("protagonist_plan_empty", hard=True)
        return fails, warns, {"shot_total": len(draft)}

    p = sum(1 for x in normalized if x["relation"] == "P")
    r = sum(1 for x in normalized if x["relation"] == "R")
    n = sum(1 for x in normalized if x["relation"] == "N")
    related = p + r
    related_ratio = related / total
    protagonist_ratio = p / total
    n_ratio = n / total

    max_n_run = cur_n = 0
    max_support_run = cur_support = 0
    for item in normalized:
        if item["relation"] == "N":
            cur_n += 1
            max_n_run = max(max_n_run, cur_n)
            if item["subject_type"] == "support":
                cur_support += 1
                max_support_run = max(max_support_run, cur_support)
            else:
                cur_support = 0
        else:
            cur_n = 0
            cur_support = 0

    plan_scenes = {}
    for item in normalized:
        if item["relation"] in ("P", "R") and item["scene"]:
            plan_scenes[item["scene"]] = plan_scenes.get(item["scene"], 0) + 1
    scene_map = _episode_scene_map(ep, src_text, names)
    scene_missing = [s["scene"] for s in scene_map
                     if s.get("has_protagonist") and plan_scenes.get(s["scene"], 0) == 0]

    closeup_total = 0
    p_closeup = 0
    for shot, item in zip(draft, normalized):
        header = shot["header"]
        if "特写" in header or "近景" in header:
            closeup_total += 1
            if item["relation"] == "P":
                p_closeup += 1
    closeup_share = p_closeup / closeup_total if closeup_total else 0.0

    anchor_missing = []
    for i, (shot, item) in enumerate(zip(draft, normalized)):
        if item["relation"] == "N":
            continue
        visual = shot["visual_text"]
        prefix = shot["prefix_text"]
        joined = visual + "\n" + prefix
        name_visual = has_name(visual, names)
        name_prefix = has_name(prefix, names)
        anchor = item["anchor"]
        markers = SHOT_ANCHOR_MARKERS.get(anchor, ())
        marker = any(m.lower() in joined.lower() for m in markers)
        if item["relation"] == "P":
            if anchor in ("pov", "voice"):
                ok = marker
            else:
                ok = name_visual
        elif anchor == "voice":
            ok = ((name_prefix and any(m in prefix for m in ("VO", "OS", "画外", "旁白", "内心")))
                  or (name_visual and any(m in visual for m in ("VO", "OS", "画外", "旁白", "内心"))))
        elif anchor == "pov":
            ok = marker
        else:
            ok = name_visual and marker
        if not ok:
            anchor_missing.append(f"S{i + 1}:{anchor}")

    anchors = {x["anchor"] for x in normalized if x["relation"] in ("P", "R") and x["anchor"]}
    anchor_variety = len(anchors)
    observe_share = (sum(1 for x in normalized
                         if x["relation"] == "R" and x["anchor"] == "observe") / related
                     if related else 0.0)

    add(f"protagonist_ratio_low:{related_ratio:.2f}/{prof['related_ratio_min']}",
        related_ratio < prof["related_ratio_min"], hard=True)
    if prof["related_ratio_target"] and related_ratio < prof["related_ratio_target"]:
        add(f"protagonist_ratio_below_target:{related_ratio:.2f}/{prof['related_ratio_target']}")
    add(f"protagonist_share_low:{protagonist_ratio:.2f}/{prof['protagonist_share_min']}",
        protagonist_ratio < prof["protagonist_share_min"], hard=True)
    add(f"protagonist_n_ratio_high:{n_ratio:.2f}/{prof['n_ratio_max']}",
        n_ratio > prof["n_ratio_max"], hard=True)
    add(f"protagonist_n_run:{max_n_run}/{prof['n_run_max']}",
        max_n_run > prof["n_run_max"], hard=True)
    add(f"protagonist_support_run:{max_support_run}/{prof['support_run_max']}",
        max_support_run > prof["support_run_max"], hard=True)
    if scene_missing:
        add(f"protagonist_scene_missing:{','.join(scene_missing[:4])}", hard=True)
    if closeup_total:
        add(f"protagonist_closeup_low:{closeup_share:.2f}/{prof['protagonist_closeup_share_min']}",
            closeup_share < prof["protagonist_closeup_share_min"])
    add(f"protagonist_anchor_variety:{anchor_variety}/{prof['anchor_variety_min']}",
        anchor_variety < prof["anchor_variety_min"])
    add(f"protagonist_observe_high:{observe_share:.2f}/{prof['observe_share_max']}",
        observe_share > prof["observe_share_max"])
    if related and len(anchor_missing) / related > prof["anchor_missing_max"]:
        add(f"protagonist_anchor_missing:{len(anchor_missing)}/{related}:"
            + ",".join(anchor_missing[:4]))

    stats = {
        "shot_total": total,
        "shot_p": p,
        "shot_r": r,
        "shot_n": n,
        "shot_related_ratio": round(related_ratio, 3),
        "shot_protagonist_ratio": round(protagonist_ratio, 3),
        "shot_n_ratio": round(n_ratio, 3),
        "shot_max_n_run": max_n_run,
        "shot_max_support_run": max_support_run,
        "shot_closeup_share": round(closeup_share, 3),
        "shot_anchor_variety": anchor_variety,
        "shot_scene_missing": scene_missing,
        "shot_anchor_missing": anchor_missing[:8],
    }
    return fails, warns, stats


def core_checks(ep, src_text, draft_text):
    fails, warns, stats = [], [], {}
    src_lines = [normalize_line(x) for x in src_text.split("\n") if normalize_line(x)]
    drf_lines = [normalize_line(x) for x in draft_text.split("\n") if normalize_line(x)]
    if not drf_lines:
        return ["empty_draft"], warns, stats
    if episode_number(drf_lines[0]) != ep:
        fails.append("missing_header")

    src_body = [x for x in src_lines if not x.startswith("△")]
    locked = [x for x in src_body if is_structural_line(x)]
    spoken_src = [x for x in src_body if not is_structural_line(x)]
    drf_norm = "\n".join(drf_lines)
    missing = [x for x in locked if x not in drf_norm]
    if missing:
        fails.append(f"missing_locked:{len(missing)}:{' || '.join(missing[:2])[:120]}")

    records = parse_draft_spoken(drf_lines)
    stream = "".join(spoken_norm(r["text"]) for r in records)
    missing_spoken, label_changed = [], []
    for line in spoken_src:
        kind, prefix, text = split_src_spoken(line)
        need = spoken_norm(text)
        if not need:
            continue
        if need not in stream:
            missing_spoken.append(line)
            continue
        rec = next((r for r in records if need in spoken_norm(r["text"])), None)
        if rec is None:
            continue
        src_tag = detect_tag(prefix)
        if src_tag and rec["tag"] != src_tag:
            label_changed.append(line)
    if missing_spoken:
        fails.append(f"missing_dialogue:{len(missing_spoken)}:{' || '.join(missing_spoken[:2])[:120]}")
    if label_changed:
        fails.append(f"label_changed:{len(label_changed)}:{' || '.join(label_changed[:2])[:120]}")

    en_mismatch = []
    for i in range(1, len(records)):
        a, b = records[i - 1], records[i]
        if not (a["ok"] and b["ok"]):
            continue
        if is_cjk_dominant(a["text"]) and is_latin_dominant(b["text"]):
            if (a["tag"] or "对白") != (b["tag"] or "对白"):
                en_mismatch.append(b["raw"])
    if en_mismatch:
        fails.append(f"en_label_mismatch:{len(en_mismatch)}:{' || '.join(en_mismatch[:2])[:120]}")

    bad_label = [r for r in records if not r["ok"] or not r["annot"]]
    serious = [r for r in bad_label if len(spoken_norm(r["text"])) >= 5]
    soft = [r for r in bad_label if len(spoken_norm(r["text"])) < 5]
    if serious:
        fails.append(f"dialogue_unlabeled:{len(serious)}:{' || '.join(r['raw'] for r in serious[:2])[:120]}")
    if soft:
        warns.append(f"unlabeled_short:{len(soft)}")

    atoms = [x[1:].strip() for x in src_lines if x.startswith("△")]
    long_atoms = [a for a in atoms if cjk_count(a) >= 6]
    stats["atoms_src"] = len(atoms)
    stats["atoms_long"] = len(long_atoms)
    if long_atoms:
        bg_d = bigrams(draft_text)
        recalls = [len(bigrams(a) & bg_d) / max(1, len(bigrams(a))) for a in long_atoms]
        avg = sum(recalls) / len(recalls)
        bad = sum(1 for r in recalls if r < 0.35) / len(recalls)
        stats["atoms_recall_avg"] = round(avg, 3)
        stats["atoms_recall_bad_share"] = round(bad, 3)
        if avg < 0.55:
            fails.append(f"atoms_recall_avg:{avg:.2f}")
        if bad > 0.15:
            fails.append(f"atoms_recall_bad:{bad:.2f}")
    stats["cjk_src"] = cjk_count(src_text)
    stats["cjk_draft"] = cjk_count(draft_text)
    stats["atoms_out"] = sum(1 for x in drf_lines if x.startswith("△"))
    stats["spoken_src"] = len(spoken_src)
    stats["spoken_out"] = len(records)
    return fails, warns, stats
