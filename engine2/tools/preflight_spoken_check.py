"""Deterministic preflight gate for per-episode spoken-word volume."""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C

MIN_WORDS = 100
MAX_WORDS = 300
STRUCTURAL_RE = re.compile(
    r"^(?:第\s*\d+\s*集|(?i:episode)\s*\d+|\d+[-－]\d+\s|"
    r"(?:人物|出场人物)\s*[：:]|【|△)"
)
META_PREFIX_RE = re.compile(r"^(?:场景|地点|时间|备注|说明|注)\s*[：:]")
TAG_RE = re.compile(r"[（(]\s*(对白|VO|OS|DIALOGUE|DIALOG)(?=[，,、：:）)\s]|$)", re.I)


def split_colon(line):
    depth = 0
    for i, ch in enumerate(line):
        if ch in "（(":
            depth += 1
        elif ch in "）)":
            depth = max(0, depth - 1)
        elif ch in "：:" and depth == 0:
            left, right = line[:i].strip(), line[i + 1:].strip()
            if left and right:
                return left, right
    return None


def language(text):
    cjk = len(re.findall(r"[\u4e00-\u9fff]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    if cjk and not latin:
        return "cn"
    if latin and not cjk:
        return "en"
    if cjk and latin:
        return "cn" if cjk * 2 >= latin else "en"
    return "other"


def units(text):
    """Count English words only; Chinese, digits and punctuation are excluded."""
    return len(re.findall(r"(?<![A-Za-z0-9])[A-Za-z]+(?:['’\-][A-Za-z]+)*(?![A-Za-z0-9])", text))


def spoken_records(lines):
    records = []
    for raw in lines:
        line = C.normalize_line(raw)
        if not line or STRUCTURAL_RE.match(line) or META_PREFIX_RE.match(line):
            continue
        pair = split_colon(line)
        if not pair:
            continue
        prefix, text = pair
        # Classify tags only inside annotations, never from the character name.
        match = TAG_RE.search(prefix)
        tag = match.group(1).upper() if match else "other"
        tag = "对白" if tag in ("DIALOGUE", "DIALOG", "对白") else tag
        records.append({"prefix": prefix, "text": text, "lang": language(text),
                        "tag": tag})
    return records


def count_episode(lines):
    records = spoken_records(lines)
    total = 0
    by_tag = {"对白": 0, "VO": 0, "OS": 0, "other": 0}
    english_lines = 0
    for rec in records:
        if rec["lang"] != "en":
            continue
        value = units(rec["text"])
        english_lines += 1
        total += value
        by_tag[rec["tag"]] += value
    return {"count": total, "by_tag": by_tag, "spoken_lines": len(records),
            "english_spoken_lines": english_lines}


def main(root=None):
    root = Path(root) if root is not None else C.ROOT
    report_path = root / "work" / "preflight" / "report.json"
    paras_path = root / "work" / "meta" / "paragraphs.txt"
    if not report_path.exists() or not paras_path.exists():
        print("[FAIL] preflight report or extracted paragraphs missing")
        return 2
    try:
        report = json.loads(report_path.read_text(encoding="utf-8-sig"))
        paragraphs = paras_path.read_text(encoding="utf-8-sig").splitlines()
        episodes = report.get("episodes") or []
        if not episodes:
            raise ValueError("report has no episodes")
        results = []
        failed = []
        seen = set()
        ranges = []
        for item in sorted(episodes, key=lambda x: int(x["ep"])):
            n = int(item["ep"])
            start = int(item["start_paragraph"])
            end = int(item["end_paragraph_exclusive"])
            if start < 0 or end <= start or end > len(paragraphs):
                raise ValueError(f"invalid episode range ep{n:02d}: {start}:{end}")
            if n in seen or any(start < b and end > a for a, b in ranges):
                raise ValueError(f"duplicate episode or overlapping range ep{n:02d}")
            seen.add(n)
            ranges.append((start, end))
            stats = count_episode(paragraphs[start:end])
            status = "PASS" if MIN_WORDS <= stats["count"] <= MAX_WORDS else "FAIL"
            reason = "within_range" if status == "PASS" else (
                "below_minimum" if stats["count"] < MIN_WORDS else "above_maximum")
            row = {"ep": n, "count": stats["count"], "min": MIN_WORDS,
                   "max": MAX_WORDS, "status": status, "reason": reason,
                   "by_tag": stats["by_tag"], "spoken_lines": stats["spoken_lines"],
                   "english_spoken_lines": stats["english_spoken_lines"]}
            results.append(row)
            if status == "FAIL":
                failed.append(n)
        check = {
            "rule": f"{MIN_WORDS} <= english_spoken_words <= {MAX_WORDS} per episode",
            "unit_definition": "English dialogue lines only; Chinese dialogue lines, digits, punctuation and speaker names are excluded. Contractions and hyphenated words count as one word. Every English spoken line counts once, including repeated performances.",
            "min": MIN_WORDS, "max": MAX_WORDS,
            "failed_eps": failed, "results": results,
            "status": "FAIL" if failed else "PASS",
        }
        report["spoken_word_check"] = check
        report["entry_gate"] = "FAIL" if failed or report.get("rating") in ("B", "C") else "PASS"
        C.save_json(report_path, report)
        C.save_json(root / "work" / "preflight" / "spoken_words.json", check)
        report_md = root / "work" / "preflight" / "report.md"
        if report_md.exists():
            base = report_md.read_text(encoding="utf-8-sig")
            marker = "## 有声台词字数检查（自动）"
            if marker in base:
                base = base.split(marker, 1)[0].rstrip() + "\n"
            lines = ["", marker, "", f"规则：每集所有有声英文台词合计必须在 {MIN_WORDS}—{MAX_WORDS} 个英文单词之间（含上下限）。",
                     "计数：只统计英文单词；中文、数字、标点和说话人姓名不计；相邻中英台词对只计英文行一次。", "",
                     "| 集数 | 计数 | 结果 | 原因 |", "|---|---:|---|---|"]
            for row in results:
                reason_text = {"within_range": "合格", "below_minimum": f"低于{MIN_WORDS}词，不合格",
                               "above_maximum": f"超过{MAX_WORDS}词，不合格"}[row["reason"]]
                lines.append(f"| EP{row['ep']:02d} | {row['count']} | {row['status']} | {reason_text} |")
            if failed:
                lines += ["", f"结论：FAIL，未通过集数：{', '.join(f'EP{x:02d}' for x in failed)}。"]
            else:
                lines += ["", "结论：PASS，所有集数均在范围内。"]
            C.write_text(report_md, base + "\n".join(lines) + "\n")
        print(f"[{'FAIL' if failed else 'PASS'}] spoken words {len(results)} episodes; failed={failed}")
        for row in results:
            if row["status"] == "FAIL":
                reason = f"低于{MIN_WORDS}词" if row["count"] < MIN_WORDS else f"超过{MAX_WORDS}词"
                print(f"[不合格] 第{row['ep']}集：英文有声台词 {row['count']} 词，{reason}")
        return 0  # 字数不合格只作为报告信息，不阻断后续流程；崩溃时 except 分支返回 2
    except Exception as e:
        print(f"[FAIL] spoken-word check: {e}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
