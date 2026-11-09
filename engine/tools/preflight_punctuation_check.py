"""前置英文台词标点检查（0 token）：只报告，不自动修改。

检查范围：带 DIALOGUE/VO/OS 标签的英文台词正文（冒号后的 text）。
重点：英文台词中是否混入中文全角标点、全角空格、英文分隔符是否写成全角冒号，
以及明显的空格问题。

输出：
  work/preflight/punctuation.json
  work/preflight/report.json → punctuation_check / punctuation_issues
  work/preflight/report.md → 「英文台词标点检查（自动）」

用法：python tools/preflight_punctuation_check.py
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C

ZH_PUNCT = "，。！？；：、（）【】《》「」『』～"
SUGGEST = {
    "，": "改为半角逗号「,」",
    "。": "改为半角句号「.」",
    "！": "改为半角感叹号「!」",
    "？": "改为半角问号「?」",
    "；": "改为半角分号「;」",
    "：": "改为半角冒号「:」",
    "、": "改为半角逗号「,」或删除",
    "（": "改为半角左括号「(」",
    "）": "改为半角右括号「)」",
    "【": "改为半角左方括号「[」",
    "】": "改为半角右方括号「]」",
    "《": "改为引号或斜体书名",
    "》": "改为引号或斜体书名",
    "「": "改为英文引号",
    "」": "改为英文引号",
    "『": "改为英文引号",
    "』": "改为英文引号",
    "～": "改为半角波浪号「~」",
}
SPACE_BEFORE_PUNCT_RE = re.compile(r"\s+([,.;:!?])")
MULTI_SPACE_RE = re.compile(r" {2,}")


def separator_char(line: str):
    """Return the first colon outside parentheses, or None."""
    depth = 0
    for ch in line:
        if ch in "（(":
            depth += 1
        elif ch in "）)":
            depth = max(0, depth - 1)
        elif ch in "：:" and depth == 0:
            return ch
    return None


def add_issue(rows, ep, idx, line, ch, kind, severity, count=1, suggestion=""):
    key = (ep, idx, ch, kind)
    if key in rows:
        rows[key]["count"] += count
        return
    rows[key] = {
        "ep": ep,
        "paragraph": idx + 1,
        "line_index": idx,
        "kind": kind,
        "char": ch,
        "severity": severity,
        "count": count,
        "context": line[:140],
        "suggestion": suggestion or SUGGEST.get(ch, "改为英文半角标点"),
    }


def scan(root: Path):
    report_path = root / "work" / "preflight" / "report.json"
    paras_path = root / "work" / "meta" / "paragraphs.txt"
    if not report_path.exists() or not paras_path.exists():
        print("[FAIL] 缺少 work/preflight/report.json 或 work/meta/paragraphs.txt，请先运行前置质检")
        return 2

    report = json.loads(report_path.read_text(encoding="utf-8-sig"))
    paras = paras_path.read_text(encoding="utf-8-sig").splitlines()
    episodes = report.get("episodes") or []
    if not episodes:
        print("[FAIL] report.json 中没有 episodes 边界")
        return 2

    rows = {}
    for item in sorted(episodes, key=lambda x: int(x["ep"])):
        ep = int(item["ep"])
        start = int(item.get("start_paragraph", -1))
        end = int(item.get("end_paragraph_exclusive", -1))
        if start < 0 or end <= start or end > len(paras):
            print(f"[WARN] EP{ep:02d} 段落范围无效：{start}:{end}")
            continue
        for idx in range(start, end):
            raw = paras[idx]
            line = C.normalize_line(raw)
            if not line or line.startswith("△") or C.is_structural_line(line):
                continue
            pair = C.split_speaker(line)
            if not pair:
                continue
            prefix, text = pair
            if not C.detect_tag(prefix) or C.spoken_lang(line) != "en":
                continue
            raw_pair = C.split_speaker(raw)
            raw_text = raw_pair[1] if raw_pair else text

            sep = separator_char(line)
            if sep == "：":
                add_issue(rows, ep, idx, line, "：", "separator", "must_fix",
                          suggestion="英文台词分隔符改为半角冒号「:」")

            if "\u3000" in raw_text:
                add_issue(rows, ep, idx, raw, "　", "dialogue_text", "must_fix",
                          suggestion="全角空格改为半角空格")

            for ch in text:
                if ch in ZH_PUNCT:
                    add_issue(rows, ep, idx, line, ch, "dialogue_text", "must_fix")

            if "……" in raw_text:
                add_issue(rows, ep, idx, raw, "……", "dialogue_text", "warn",
                          suggestion="中文省略号建议改为英文「...」")

            for m in SPACE_BEFORE_PUNCT_RE.finditer(raw_text):
                add_issue(rows, ep, idx, raw, "标点前空格", "spacing", "warn",
                          suggestion="删除标点前的空格")
            for m in MULTI_SPACE_RE.finditer(raw_text):
                add_issue(rows, ep, idx, raw, "连续空格", "spacing", "warn",
                          suggestion="压缩为一个半角空格")

    results = sorted(rows.values(), key=lambda r: (r["ep"], r["line_index"], r["char"]))
    must = [r for r in results if r["severity"] == "must_fix"]
    warn = [r for r in results if r["severity"] == "warn"]
    risky_eps = sorted({r["ep"] for r in must + warn})
    summary = {
        "status": "RISK" if must or warn else "OK",
        "issues": len(results),
        "must_fix": sum(r["count"] for r in must),
        "warn": sum(r["count"] for r in warn),
        "risky_eps": risky_eps,
    }
    check = {
        "version": 1,
        "rule": "英文台词正文使用半角 ASCII 标点；不得出现中文全角标点或全角空格。只报告，不自动修改。",
        "scope": "带 DIALOGUE/VO/OS 标签的英文台词正文；不检查中文表演提示。",
        "blocking": False,
        "summary": summary,
        "results": results,
    }

    preflight_dir = root / "work" / "preflight"
    C.save_json(preflight_dir / "punctuation.json", check)
    report["punctuation_check"] = check
    report["punctuation_issues"] = results
    C.save_json(report_path, report)

    report_md = preflight_dir / "report.md"
    if report_md.exists():
        base = report_md.read_text(encoding="utf-8-sig")
        marker = "## 英文台词标点检查（自动）"
        if marker in base:
            base = base.split(marker, 1)[0].rstrip() + "\n"
        lines = ["", marker, "",
                 "规则（信息项，不阻断）：英文台词正文使用半角 ASCII 标点；不得出现中文全角标点或全角空格。只报告，不自动修改。", ""]
        if results:
            lines += ["| 集数 | 段落 | 问题 | 次数 | 级别 | 上下文 / 建议 |",
                      "|---|---:|---|---:|---|---|"]
            for r in results:
                lines.append(
                    f"| EP{r['ep']:02d} | {r['paragraph']} | {r['char']} | {r['count']} | "
                    f"{r['severity']} | {r['context'].replace('|', '｜')} / {r['suggestion']} |"
                )
            lines += ["", f"结论：{'RISK' if must or warn else 'OK'}，must_fix {summary['must_fix']} 项、warn {summary['warn']} 项；风险集：{', '.join(f'EP{x:02d}' for x in risky_eps) or '无'}。"]
        else:
            lines += ["未发现英文台词标点问题。"]
        C.write_text(report_md, base + "\n".join(lines) + "\n")

    print(f"[{summary['status']}] punctuation check: must_fix={summary['must_fix']} warn={summary['warn']} issues={summary['issues']}")
    for r in results[:20]:
        print(f"  EP{r['ep']:02d} p{r['paragraph']} {r['char']} {r['severity']} x{r['count']}")
    print(f"[OK] -> {preflight_dir / 'punctuation.json'}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="")
    args = ap.parse_args()
    root = Path(args.root) if args.root else C.ROOT
    return scan(root)


if __name__ == "__main__":
    raise SystemExit(main())
