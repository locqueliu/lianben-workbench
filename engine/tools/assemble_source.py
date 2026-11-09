"""由优化产物一步生成全部存档（0 token）：
校验 work/preflight/optimized/epNN.md → 回写源 docx（含备份）→ 合并生成 work/source/epNN.md
→ 生成 work/meta/{ep_index.json, handoff.json, facts_lock.md, progress.json, format.json, format_rules.md}

--rebuild：不回写、不改 source，仅从现有 work/source 重建索引与格式规则。
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import re
import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def extract_templates(p_xml):
    mp = re.search(r"<w:pPr>.*?</w:pPr>", p_xml, re.S)
    mr = re.search(r"<w:rPr>.*?</w:rPr>", p_xml, re.S)
    return (mp.group(0) if mp else ""), (mr.group(0) if mr else "")


def make_paragraph(text, ppr, rpr):
    if not text:
        return f"<w:p>{ppr}</w:p>"
    return (f"<w:p>{ppr}<w:r>{rpr}"
            f'<w:t xml:space="preserve">{C.escape_xml(text)}</w:t></w:r></w:p>')


def read_ep_file(path: Path):
    lines = [C.normalize_line(x) for x in C.read_text(path).splitlines() if C.normalize_line(x)]
    if not lines:
        raise ValueError(f"empty file: {path}")
    if any(x.startswith("```") for x in lines):
        raise ValueError(f"markdown fence found in {path}")
    return lines


def writeback_docx(root: Path, episodes: list, opt_dir: Path):
    source = C.resolve_docx(root)
    if not source:
        raise ValueError("no source docx found in 剧本输入/")
    with zipfile.ZipFile(source) as zin:
        xml = zin.read("word/document.xml").decode("utf-8")
        entries = zin.infolist()
        payloads = {item.filename: zin.read(item.filename) for item in entries
                    if item.filename != "word/document.xml"}
    px = C.extract_paragraph_xmls(xml)
    spans = [m.span() for m in re.finditer(r"<w:p[ >].*?</w:p>", xml, re.S)]
    if len(px) != len(spans):
        raise ValueError("could not map document paragraphs")
    heading_ids = C.load_heading_style_ids(source)

    replacements = []
    seen = set()
    manifest_eps = []
    for item in sorted(episodes, key=lambda x: int(x.get("start_paragraph", -1))):
        n = int(item["ep"])
        start = int(item["start_paragraph"])
        end = int(item["end_paragraph_exclusive"])
        if n in seen:
            raise ValueError(f"duplicate episode {n} in preflight report")
        seen.add(n)
        if start < 0 or end <= start or end > len(px):
            raise ValueError(f"invalid paragraph range for ep{n:02d}: {start}:{end}")
        out_path = opt_dir / f"ep{n:02d}.md"
        if not out_path.exists():
            raise ValueError(f"missing optimized output: {out_path}")
        lines = read_ep_file(out_path)
        if C.episode_number(lines[0]) != n:
            raise ValueError(f"first line of optimized ep{n:02d} is not its episode header")
        title_ppr, title_rpr = extract_templates(px[start])
        body_ppr, body_rpr = C.find_body_templates(px, start, end, heading_ids)
        parts = []
        for idx, line in enumerate(lines):
            if idx == 0:
                parts.append(make_paragraph(line, title_ppr, title_rpr))
            else:
                parts.append(make_paragraph(line, body_ppr, body_rpr))
        replacement = "".join(parts)
        replacements.append((spans[start][0], spans[end - 1][1], replacement))
        manifest_eps.append({"ep": n, "source_paragraphs": end - start,
                             "optimized_paragraphs": len(lines),
                             "path": str(out_path)})

    new_xml = xml
    for begin, finish, replacement in reversed(replacements):
        new_xml = new_xml[:begin] + replacement + new_xml[finish:]

    preflight_dir = root / "work" / "preflight"
    preflight_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    temp = preflight_dir / f"{source.stem}_优化版_{stamp}.docx"
    with zipfile.ZipFile(temp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in entries:
            data = new_xml.encode("utf-8") if item.filename == "word/document.xml" else payloads[item.filename]
            zout.writestr(item, data)

    backup_dir = preflight_dir / "original"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir / f"{source.stem}_{stamp}.docx"
    shutil.copy2(source, backup)
    try:
        shutil.copy2(temp, source)
    except PermissionError:
        raise ValueError(f"源 docx 被占用（请在 Word/WPS 中关闭后重跑）: {source}")
    C.save_json(preflight_dir / "optimization_manifest.json", {
        "status": "APPLIED",
        "source": str(source),
        "backup": str(backup),
        "episodes": manifest_eps,
    })
    return source


def read_eps_from_source(source_dir: Path):
    items = []
    for p in sorted(source_dir.glob("ep*.md"), key=lambda x: x.name):
        lines = read_ep_file(p)
        n = C.episode_number(lines[0])
        if n is None:
            raise ValueError(f"first line of {p.name} is not an episode header: {lines[0][:40]}")
        items.append({"ep": n, "lines": lines})
    if not items:
        raise ValueError("work/source 中没有 epNN.md")
    return items


def build_format_rules(items):
    has_en = any(len(it["lines"]) > 1 and C.is_episode_en_header(it["lines"][1]) for it in items)
    en_pat = "(?i:episode)\\s*\\d+" if has_en else ""
    locked = ["^第\\s*\\d+\\s*集"]
    if has_en:
        locked.append("(?i:episode)\\s*\\d+")
    locked += [
        "^\\d+\\s*[-－]\\s*\\d+",
        "^(?:出场人物|人物)\\s*[：:]",
        "^(?:SPECTACLE|VFX|HERO)\\b",
        "^【",
    ]
    profile = {
        "version": 1,
        "episode": {"header_pattern": "^第\\s*(\\d+)\\s*集", "en_pattern": en_pat},
        "locked_line_patterns": locked,
        "speaker": {"colon": "[：:]", "labels": ["对白", "VO", "OS"]},
        "atom": {"prefixes": ["△"]},
    }
    rules = [
        "# 剧本格式规则（由 tools/assemble_source.py 依据标准格式自动生成；可人工修订 work/meta/format.json）",
        "",
        "## 行类型与锁行（命中 locked_line_patterns 的行成品必须逐字原样保留）",
        "",
        "- 集标题：`第N集《标题》`（锁行）",
    ]
    if has_en:
        rules.append("- 英文集标题：`Episode N: \"...\"`（锁行，紧跟中文标题下一行）")
    rules += [
        "- 场次行：`N-N 时间 内外 地点`（锁行）",
        "- 人物/出场行：`人物：姓名 姓名`（锁行）",
        "- 结构块：`【…】`（锁行）",
        "- 叙事原子：`△ 描述`（非台词正文，成品扩写挂载点）",
        "- 台词行：`说话人（对白/VO/OS）：正文`；英文行 `SPEAKER (DIALOGUE/VO/OS): text`",
        "",
        "## 台词规则",
        "",
        "- 中英台词相邻成对，顺序锁定；拆分须等量交替 `CN1→EN1→CN2→EN2`",
        "- 标签严格沿用原文，不补标签、不改分类；英文行括号内不得出现中文标签",
        "- 台词文字与句读标点逐字不可动（仅允许冒号/引号/括号/空格的纯格式统一）",
        "",
    ]
    return profile, "\n".join(rules)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true",
                    help="从现有 work/source 重建索引与格式规则（不回写 docx）")
    args = ap.parse_args()
    root = C.ROOT
    opt_dir = root / "work" / "preflight" / "optimized"
    source_dir = root / "work" / "source"
    meta_dir = root / "work" / "meta"
    source_dir.mkdir(parents=True, exist_ok=True)
    meta_dir.mkdir(parents=True, exist_ok=True)

    report = C.load_json(root / "work" / "preflight" / "report.json", {}) or {}
    report_eps = report.get("episodes") or []
    prev_index = C.load_json(meta_dir / "ep_index.json", {}) or {}

    if args.rebuild:
        try:
            items = read_eps_from_source(source_dir)
        except ValueError as e:
            print(f"[FAIL] {e}")
            return 1
        mode = "rebuild"
    else:
        if not report_eps:
            print("[FAIL] 缺少 work/preflight/report.json 的 episodes 边界，请先运行前置质检")
            return 2
        items = []
        errors = []
        paras_path = root / "work" / "meta" / "paragraphs.txt"
        paragraphs = C.read_text(paras_path).splitlines() if paras_path.exists() else []
        for item in sorted(report_eps, key=lambda x: int(x["ep"])):
            n = int(item["ep"])
            out = opt_dir / f"ep{n:02d}.md"
            if not out.exists():
                errors.append(f"ep{n:02d}: missing {out}")
                continue
            try:
                lines = read_ep_file(out)
            except ValueError as e:
                errors.append(f"ep{n:02d}: {e}")
                continue
            if C.episode_number(lines[0]) != n:
                errors.append(f"ep{n:02d}: first line is not its episode header")
                continue
            start = int(item.get("start_paragraph", -1))
            end = int(item.get("end_paragraph_exclusive", -1))
            if paragraphs and 0 <= start < end <= len(paragraphs):
                culture = C.culture_added_errors("\n".join(paragraphs[start:end]), "\n".join(lines))
                if culture:
                    errors.append(f"ep{n:02d}: " + ", ".join(culture))
                    continue
            items.append({"ep": n, "lines": lines, "path": out,
                          "para_start": start,
                          "para_end": end})
        if errors:
            print("[FAIL] 优化产物校验未通过：\n- " + "\n- ".join(errors))
            return 1
        nums = [e["ep"] for e in items]
        if nums != sorted(nums) or len(nums) != len(set(nums)):
            print(f"[FAIL] 集号异常或重复：{nums}")
            return 1
        try:
            writeback_docx(root, report_eps, opt_dir)
        except (ValueError, OSError, zipfile.BadZipFile) as e:
            print(f"[FAIL] 源 docx 回写失败：{e}")
            return 1
        for e in items:
            C.write_text(source_dir / f"ep{e['ep']:02d}.md", "\n".join(e["lines"]) + "\n")
        mode = "assemble"

    docx = C.resolve_docx(root)
    docx_path = str(docx) if docx else (prev_index.get("docx") or "")
    docx_sha = ""
    if docx:
        try:
            docx_sha = hashlib.sha256(docx.read_bytes()).hexdigest()
        except OSError:
            docx_sha = ""

    ep_index = []
    shas: list[str] = []
    for e in items:
        n = e["ep"]
        lines = e["lines"]
        text = "\n".join(lines) + "\n"
        body = lines[1:]
        title = lines[0]
        title_en = lines[1] if len(lines) > 1 and C.is_episode_en_header(lines[1]) else ""
        scenes = sum(1 for t in body if re.match(r"^\d+-\d+\s", t))
        atoms = sum(1 for t in body if t.startswith("\u25b3"))
        ep_index.append({
            "ep": n,
            "title": title,
            "title_en": title_en,
            "para_start": e.get("para_start", -1),
            "para_end": e.get("para_end", -1),
            "lines": len(lines),
            "cjk": C.cjk_count(text),
            "atoms": atoms,
            "scenes": scenes,
        })
        shas.append(sha256_bytes(text.encode("utf-8")))

    C.save_json(meta_dir / "ep_index.json", {
        "docx": docx_path,
        "source_sha256": docx_sha,
        "total_paragraphs": sum(e["lines"] for e in ep_index),
        "episodes": ep_index,
    })

    handoff = {}
    for k, e in enumerate(items):
        prev_tail, next_head = [], []
        if k > 0:
            prev_tail = items[k - 1]["lines"][-6:]
        if k + 1 < len(items):
            next_head = items[k + 1]["lines"][:8]
        handoff[str(e["ep"])] = {"prev_tail": prev_tail, "next_head": next_head}
    C.save_json(meta_dir / "handoff.json", handoff)

    first_start = ep_index[0].get("para_start", -1) if ep_index else -1
    paras_path = meta_dir / "paragraphs.txt"
    prologue = []
    if paras_path.exists() and first_start and first_start > 0:
        paras = paras_path.read_text(encoding="utf-8-sig").splitlines()
        prologue = [t for t in paras[:first_start] if t.strip()]
    C.write_text(meta_dir / "facts_lock.md",
                 "# 全局锁定事实（原文档前置信息）\n\n"
                 "> 仅用于跨集一致性核对：人物名、术语、道具、时间线以此为准；不得据此新增剧情事实，不得写入正文引用。\n\n"
                 + "\n".join(prologue) + "\n")

    profile, rules_md = build_format_rules(items)
    C.save_json(meta_dir / "format.json", profile)
    C.write_text(meta_dir / "format_rules.md", rules_md)

    fingerprint = sha256_bytes("".join(shas).encode("ascii"))
    progress_path = meta_dir / "progress.json"
    progress = C.load_json(progress_path, None) or {"episodes": {}}
    reset_note = ""
    if progress.get("fingerprint") != fingerprint:
        progress = {
            "fingerprint": fingerprint,
            "updated": datetime.datetime.now().isoformat(timespec="seconds"),
            "episodes": {str(e["ep"]): {"status": "pending", "attempts": 0, "reasons": []}
                         for e in ep_index},
        }
        reset_note = "（存档变化，已重置进度）"
    else:
        known = set(progress.get("episodes", {}))
        current = {str(e["ep"]) for e in ep_index}
        for old in known - current:
            progress["episodes"].pop(old, None)
        for e in ep_index:
            progress["episodes"].setdefault(str(e["ep"]),
                                            {"status": "pending", "attempts": 0, "reasons": []})
    progress["updated"] = datetime.datetime.now().isoformat(timespec="seconds")
    C.save_json(progress_path, progress)

    total_cjk = sum(e["cjk"] for e in ep_index)
    total_atoms = sum(e["atoms"] for e in ep_index)
    print(f"[OK] {mode}: episodes={len(ep_index)} cjk={total_cjk} atoms={total_atoms}{reset_note}")
    print("[OK] wrote work/source/ep*.md + work/meta/{ep_index.json,handoff.json,facts_lock.md,progress.json,format.json,format_rules.md}")
    if mode == "assemble":
        print("[OK] 源 docx 已回写为优化版（原稿备份在 work/preflight/original/）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
