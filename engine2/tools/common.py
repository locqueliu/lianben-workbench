import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


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


def save_json(path, obj):
    write_text(path, json.dumps(obj, ensure_ascii=False, indent=1) + "\n")


# ---------------------------------------------------------------------------
# 文化背景硬锁：SOURCE 未出现的中国/东方文化符号，不得由富化阶段新增。
# 该表是确定性安全网，只覆盖高置信度词；语义判断仍以 director/optimizer 规则为准。
# ---------------------------------------------------------------------------
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
)


def culture_added_errors(src_text, draft_text):
    """Return terms present in draft but absent from source (source-aware check)."""
    src = src_text or ""
    draft = draft_text or ""
    errors = []
    if "筷" in draft and "筷" not in src:
        errors.append("culture_added:筷")
    for term in CULTURE_TERMS:
        if term in draft and term not in src:
            errors.append(f"culture_added:{term}")
    return errors


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


CN_DIGITS = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}


def cn_number(text):
    """Convert a simple Chinese numeral (一…一百九十九) to int; return None if invalid."""
    s = (text or "").strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    if s == "十":
        return 10
    if "十" in s:
        left, _, right = s.partition("十")
        tens = CN_DIGITS.get(left, 1) if left else 1
        ones = CN_DIGITS.get(right, 0) if right else 0
        return tens * 10 + ones
    if len(s) == 1:
        return CN_DIGITS.get(s)
    return None


def _episode_tail_ok(s, tail):
    if not tail:
        return True
    if re.match(r"^(?:\s|《|（|\(|\[|【|[-—])", tail):
        return True
    if tail.startswith(("：", ":")):
        return len(s) <= 30 and not re.search(r"[。，！？；,;!?]", tail)
    return False


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
    """Return the episode number for a header line.

    Tolerant by design: Arabic or Chinese numerals, 第N集/第N话 and EP/Episode.
    A long ``第N集：剧情梗概`` line is treated as a TOC entry, not a header.
    """
    s = normalize_line(line)
    m = episode_re().match(s)
    if m:
        tail = s[m.end():].lstrip()
        if not _episode_tail_ok(s, tail):
            return None
        for gi in range(1, (m.re.groups or 0) + 1):
            value = m.group(gi)
            if value and value.strip().isdigit():
                return int(value)
    m = re.match(r"^第\s*(\d+)\s*[集话]", s)
    if m:
        tail = s[m.end():].lstrip()
        if not _episode_tail_ok(s, tail):
            return None
        return int(m.group(1))
    m = re.match(r"^第\s*([零〇一二三四五六七八九十两]+)\s*[集话]", s)
    if m:
        tail = s[m.end():].lstrip()
        if not _episode_tail_ok(s, tail):
            return None
        value = cn_number(m.group(1))
        if value:
            return value
    m = re.match(r"(?i:episode|ep)\s*(\d+)", s)
    if m:
        return int(m.group(1))
    if re.match(r"^(\d+)\s*[集话]\s*$", s):
        return int(re.match(r"^(\d+)", s).group(1))
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


def _xml_unescape(s):
    return (s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
             .replace("&apos;", "'").replace("&amp;", "&"))


def paragraph_text(p_xml):
    # Only <w:t> / <w:t ...>, never <w:tab>, <w:tabs>, <w:tbl>, <w:textAlignment>.
    parts = re.findall(r"<w:t(?![A-Za-z])(?:\s[^>]*)?>(.*?)</w:t>", p_xml, re.S)
    return _xml_unescape("".join(parts))


def paragraph_text_lines(p_xml):
    """Extract visible lines from one paragraph, honoring <w:br/> and <w:tab/>."""
    body = re.sub(r"<w:tab[^>]*/>", " ", p_xml)
    body = re.sub(r"<w:br[^>]*/>", "\n", body)
    body = re.sub(r"<w:cr[^>]*/>", "\n", body)
    parts = re.findall(r"<w:t(?![A-Za-z])(?:\s[^>]*)?>(.*?)</w:t>", body, re.S)
    return _xml_unescape("".join(parts)).split("\n")


def extract_source_units(docx_path):
    """Return (units, paragraph_xmls, document_xml); one unit per visible line."""
    with zipfile.ZipFile(docx_path) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    px = extract_paragraph_xmls(xml)
    units = []
    for pi, p in enumerate(px):
        for si, line in enumerate(paragraph_text_lines(p)):
            units.append({"text": line, "para": pi, "sub": si})
    return units, px, xml


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


def total_char_count(s):
    """总字符数口径：包含所有标点、空格与换行。"""
    return len(s)


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


_EP_HEAD_PREFIX_RES = (
    re.compile(r"^第\s*[0-9零〇一二三四五六七八九十百两]+\s*[集话]"),
    re.compile(r"(?i:episode|ep)\s*\d+"),
)


def _is_bare_episode_header(s):
    """True when the line is only an episode header, with no title/summary after it."""
    for pat in _EP_HEAD_PREFIX_RES:
        m = pat.match(s)
        if m:
            return not s[m.end():].strip()
    return False


def locate_episodes(texts):
    cands = []
    for i, t in enumerate(texts):
        s = t.strip()
        n = episode_number(s)
        if n is None:
            continue
        cands.append((i, n, s))
    # 前置分集大纲常写成「第N集（剧情摘要）」，与正文集标题「第N集」重号。
    # 同号时优先采用不带标题的正文集标题行，避免正文全部被并入最后一集。
    chosen = {}
    for i, n, s in cands:
        cur = chosen.get(n)
        if cur is None:
            chosen[n] = (i, n, s)
            continue
        new_bare = _is_bare_episode_header(s)
        cur_bare = _is_bare_episode_header(cur[2])
        if new_bare and not cur_bare:
            chosen[n] = (i, n, s)
        elif new_bare and cur_bare:
            chosen[n] = (i, n, s)
    return sorted(chosen.values(), key=lambda x: x[0])


QUOTE_CHARS = "「」『』“”‘’\"'"


def is_structural_line(s):
    s = normalize_line(s)
    if struct_re().match(s):
        return True
    return episode_number(s) is not None


def strip_quotes(s):
    return s.translate({ord(c): None for c in QUOTE_CHARS})


def spoken_norm(s):
    return re.sub(r"\s+", "", strip_quotes(s))


ATOM_MARKS = "△▲●◆■▪▶►"


def normalize_episode_header_text(s):
    """第X集（中文数字）→ 第N集，保留后续标题文字。"""
    m = re.match(r"^第\s*([零〇一二三四五六七八九十两]+)\s*([集话])(.*)$", s)
    if not m:
        return s
    value = cn_number(m.group(1))
    if not value:
        return s
    return f"第{value}{m.group(2)}{m.group(3)}"


def _looks_like_scene(body):
    b = (body or "").strip()
    if not b or len(b) > 80:
        return False
    if re.search(r"[：:]", b):
        return False
    toks = b.replace("\u3000", " ").split()
    if any(x in toks for x in ("内", "外", "内外", "内/外", "内景", "外景")):
        return True
    return bool(toks and re.match(r"^(日|夜|晨|黄昏|傍晚|清晨|深夜|中午|下午|上午|凌晨|白天|雨|雪)", toks[0]))


def prepare_source_units(units):
    """Format-only normalization on ingest.

    Only touches atom markers, episode headers, scene numbering and the [EN]
    language prefix. Dialogue text, speakers and labels are never changed.
    """
    stats = {"header_normalized": 0, "atom_normalized": 0,
             "scene_normalized": 0, "en_prefix_stripped": 0, "toc_skipped": 0}
    texts = []
    for u in units:
        raw = u.get("text") or ""
        t = normalize_line(raw)
        if not t:
            texts.append("")
            continue
        new = normalize_episode_header_text(t)
        if new != t:
            stats["header_normalized"] += 1
            t = new
        if t[0] in ATOM_MARKS and t[0] != "△":
            t = "△" + t[1:].lstrip()
            stats["atom_normalized"] += 1
        m = re.match(r"^[\[【]\s*(?:EN|英|英文)\s*[\]】]\s*[：:]?\s*", t, re.I)
        if m:
            t = t[m.end():]
            stats["en_prefix_stripped"] += 1
        texts.append(t)

    eps = locate_episodes(texts)
    for k, (i, n, _title) in enumerate(eps):
        j = eps[k + 1][0] if k + 1 < len(eps) else len(texts)
        for idx in range(i, j):
            t = texts[idx]
            if not t:
                continue
            m = re.match(r"^(\d+)\s*[.、]\s*(\S.*)$", t)
            if m and _looks_like_scene(m.group(2)):
                texts[idx] = f"{n}-{m.group(1)} {m.group(2)}"
                stats["scene_normalized"] += 1

    stats["toc_skipped"] = sum(
        1 for t in texts if re.match(r"^第\s*\d+\s*集\s*[：:]", t) and len(t) > 30)
    return [{"text": t, "para": u["para"], "sub": u["sub"]}
            for u, t in zip(units, texts)], stats


def prepare_source_lines(texts):
    units = [{"text": t, "para": i, "sub": 0} for i, t in enumerate(texts)]
    prepared, _stats = prepare_source_units(units)
    return [u["text"] for u in prepared]


def detect_tag(s):
    # Canonical values are the source-language labels used by the checker.
    if re.search(r"[（(]\s*O\.S\.(?=[，,、：:）)\s]|$)", s, re.I):
        return "OS"
    for tag in speaker_labels():
        if re.search(r"[（(]" + re.escape(tag) + r"(?:[，,、：:）)]|\s|$)", s):
            return {"对白": "对白", "VO": "VO", "OS": "OS"}.get(tag, tag)
    for tag, canonical in (("DIALOGUE", "对白"), ("DIALOG", "对白"),
                           ("VO", "VO"), ("OS", "OS")):
        if re.search(r"[（(]" + tag + r"(?:[，,、：:)]|\s|$)", s, re.I):
            return canonical
    return None


def raw_label(prefix):
    """Return the label exactly as written in the source prefix, or ''."""
    if re.search(r"[（(]\s*O\.S\.(?=[，,、：:）)\s]|$)", prefix, re.I):
        return "O.S."
    for lab in ("对白", "VO", "OS"):
        if re.search(r"[（(]\s*" + re.escape(lab) + r"(?=[，,、：:）)\s]|$)", prefix):
            return lab
    for lab in ("DIALOGUE", "DIALOG"):
        if re.search(r"[（(]\s*" + lab + r"(?=[，,、：:)]|\s|$)", prefix, re.I):
            return lab
    return ""


def canonical_label(raw):
    if raw in ("对白", "DIALOGUE", "DIALOG"):
        return "对白"
    if raw == "O.S.":
        return "OS"
    return raw or ""


def canon_dialogue_text(s):
    s = normalize_line(s)
    s = s.replace("：", ":").replace("（", "(").replace("）", ")")
    return re.sub(r"\s+", "", s)


def dialogue_hash(s):
    return hashlib.sha1(canon_dialogue_text(s).encode("utf-8")).hexdigest()[:10]


META_PREFIXES = ("镜头", "转场", "插入帧", "片长", "时长", "时间", "地点", "场景",
                 "备注", "说明", "注", "字幕", "集数", "剧名", "题材", "关键词",
                 "空间起点", "画面范围", "画外锁定", "声音设计", "声音", "禁止",
                 "硬性禁止", "画面", "姿态", "位置", "分镜", "本分镜", "高光",
                 "环境", "人物", "出场人物", "空间")


def parse_storyboard_dialogue(line):
    """Parse a source or storyboard line as dialogue, excluding layout fields."""
    s = normalize_line(line)
    if not s or s.startswith("△"):
        return None
    if episode_number(s) is not None or is_structural_line(s):
        return None
    if re.match(r"^\d+[-－]\d+\s", s):
        return None
    if re.match(r"^(?:人物|出场人物)\s*[：:]", s):
        return None
    if s.startswith("【") or re.match(r"^(?:SPECTACLE|VFX|HERO)\b", s):
        return None
    sp = split_speaker(s)
    if not sp:
        return None
    prefix, body = sp
    if re.match(r"^[\d\s.、\-－]+$", prefix):
        return None
    if any(prefix.startswith(p) for p in META_PREFIXES):
        return None
    # Camera prose has punctuation/length before any parenthetical; a speaker name
    # followed by a performance/OS annotation is legitimate even when the annotation is long.
    speaker = re.split(r"[（(]", prefix, 1)[0].strip().strip("[]【】").strip()
    if not speaker:
        return None
    if len(speaker) > 24 or re.search(r"[。！？；，,;!?]", speaker):
        return None
    # Leading parenthetical inside the body is a performance hint, not dialogue text.
    pm = re.match(r"^([（(][^）)]*[）)])\s*(.*)$", body)
    if pm:
        body = pm.group(2).strip()
    if not body:
        return None
    raw = raw_label(prefix)
    return {
        "speaker": speaker,
        "label_raw": raw,
        "label": canonical_label(raw),
        "text": body,
        "hash": dialogue_hash(body),
        "lang": spoken_lang(s) or "",
    }


def parse_dialogue_line(line):
    return parse_storyboard_dialogue(line)


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
    for needle, lang, raw in src_entries:
        if not needle or not streams[lang]:
            continue
        # Search independently per source line. A per-language cursor would
        # hide a cross-language/order swap by simply failing to find the later
        # line after the output had moved it earlier.
        pos = streams[lang].find(needle)
        if pos < 0:
            continue
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
