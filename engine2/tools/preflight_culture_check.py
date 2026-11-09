"""前置文化背景检查（0 token）：扫描 SOURCE 中的中式元素/文化符号。

只报告、不阻断；命中项写入 work/preflight/culture.json，并合并进
work/preflight/report.json 的 culture_issues 与 report.md。
是否作为 must_fix 由 culture-profile.json 的 forbid_cn_elements 控制。

用法：python tools/preflight_culture_check.py
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C

# 高置信中式文化符号：出现即说明作者明确写了中式元素。
HARD_TERMS = (
    "筷子", "筷架", "一筷之礼", "筷礼",
    "拱手", "作揖", "跪拜", "拂袖", "抱拳",
    "旗袍", "长衫", "汉服", "唐装", "绣花鞋",
    "青砖", "瓦檐", "纸窗", "灯笼", "屏风", "太师椅",
    "客栈", "茶楼", "衙门", "祠堂", "四合院",
    "春节", "中秋", "饺子", "茶道",
    "皇上", "王爷", "银两", "铜钱",
    "古筝", "琵琶", "二胡", "古琴", "笛子", "唢呐", "京剧",
)

# 可能是合法译法/架空设定，也可能只是中文习惯；先列为 suspected，交人工判断。
AMBIGUOUS_TERMS = (
    "中式", "古装", "宫廷",
    "家主", "老爷", "师父", "师兄", "掌柜", "店小二",
    "胡同", "弄堂", "书院", "科举", "镖局", "江湖",
)

DEFAULT_PROFILE = {
    "market": "auto",
    "setting": "",
    "forbid_cn_elements": False,
    "allowed_terms": [],
}


def load_profile(root: Path):
    for path in (root / "culture-profile.json", root / "work" / "meta" / "culture_profile.json"):
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception as exc:
            print(f"[WARN] 读取文化配置失败，使用默认值：{path} ({exc})")
            continue
        prof = dict(DEFAULT_PROFILE)
        if isinstance(data, dict):
            prof.update(data)
        if not isinstance(prof.get("allowed_terms"), list):
            prof["allowed_terms"] = []
        prof["forbid_cn_elements"] = bool(prof.get("forbid_cn_elements"))
        return prof, str(path)
    return dict(DEFAULT_PROFILE), ""


def kind_of(line: str) -> str:
    s = C.normalize_line(line)
    if not s:
        return "empty"
    if s.startswith("△"):
        return "action"
    if C.is_structural_line(s):
        return "structure"
    pair = C.split_speaker(s)
    if pair and C.detect_tag(pair[0]):
        return "dialogue"
    return "other"


def suggestion_for(term: str, kind: str, fixable: bool) -> str:
    if not fixable:
        if kind == "dialogue":
            return "台词逐字锁定，不能自动改；需人工修改源稿，或由用户授权调整。"
        return "锁行/结构行，不能自动改；需人工修改源稿。"
    if "礼" in term or term in ("拱手", "作揖", "跪拜", "拂袖", "抱拳"):
        return "删除文化礼仪命名或动作，改为文化中性的可拍行为。"
    if term in ("筷子", "筷架", "筷礼") or "筷" in term:
        return "不命名 SOURCE 未指定的餐具；改为“分菜/放进碟中/收回手”等中性动作。"
    if term in ("家主", "老爷", "师父", "师兄", "掌柜", "店小二"):
        return "删除或改用 SOURCE 已建立的称谓；不得新增身份/头衔。"
    return "改为文化中性写法；不得新增 SOURCE 未建立的器物、礼仪、服饰、建筑或称谓。"


def scan(root: Path):
    report_path = root / "work" / "preflight" / "report.json"
    paras_path = root / "work" / "meta" / "paragraphs.txt"
    if not report_path.exists() or not paras_path.exists():
        print("[FAIL] 缺少 work/preflight/report.json 或 work/meta/paragraphs.txt，请先运行前置质检")
        return 2

    report = json.loads(report_path.read_text(encoding="utf-8-sig"))
    paragraphs = paras_path.read_text(encoding="utf-8-sig").splitlines()
    episodes = report.get("episodes") or []
    if not episodes:
        print("[FAIL] report.json 中没有 episodes 边界")
        return 2

    profile, profile_path = load_profile(root)
    allowed = {str(x).strip() for x in profile.get("allowed_terms", []) if str(x).strip()}
    hard = tuple(t for t in HARD_TERMS if t not in allowed)
    ambiguous = tuple(t for t in AMBIGUOUS_TERMS if t not in allowed)

    results = []
    seen = set()
    for item in sorted(episodes, key=lambda x: int(x["ep"])):
        ep = int(item["ep"])
        start = int(item.get("start_paragraph", -1))
        end = int(item.get("end_paragraph_exclusive", -1))
        if start < 0 or end <= start or end > len(paragraphs):
            print(f"[WARN] EP{ep:02d} 段落范围无效：{start}:{end}")
            continue
        for idx in range(start, end):
            raw = paragraphs[idx]
            line = C.normalize_line(raw)
            if not line:
                continue
            kind = kind_of(line)
            fixable = kind == "action"
            for term in hard + ambiguous:
                if term not in line:
                    continue
                key = (ep, idx, term)
                if key in seen:
                    continue
                seen.add(key)
                if profile.get("forbid_cn_elements"):
                    severity = "must_fix" if term in hard else "suspected"
                else:
                    severity = "info"
                results.append({
                    "ep": ep,
                    "paragraph": idx + 1,
                    "line_index": idx,
                    "term": term,
                    "kind": kind,
                    "severity": severity,
                    "fixable": fixable,
                    "context": line[:120],
                    "suggestion": suggestion_for(term, kind, fixable),
                })

    must_fix = [r for r in results if r["severity"] == "must_fix"]
    suspected = [r for r in results if r["severity"] == "suspected"]
    info = [r for r in results if r["severity"] == "info"]
    risky_eps = sorted({r["ep"] for r in must_fix + suspected})
    status = "RISK" if must_fix or suspected else "OK"
    summary = {
        "status": status,
        "must_fix": len(must_fix),
        "suspected": len(suspected),
        "info": len(info),
        "risky_eps": risky_eps,
    }
    check = {
        "version": 1,
        "profile": profile,
        "profile_path": profile_path,
        "rule": "SOURCE 未建立的中式元素/文化符号不得作为新增内容；台词锁定项只报告，不自动改。",
        "blocking": False,
        "summary": summary,
        "results": results,
    }

    preflight_dir = root / "work" / "preflight"
    preflight_dir.mkdir(parents=True, exist_ok=True)
    C.save_json(preflight_dir / "culture.json", check)
    report["culture_check"] = check
    report["culture_issues"] = results
    C.save_json(report_path, report)

    report_md = preflight_dir / "report.md"
    if report_md.exists():
        base = report_md.read_text(encoding="utf-8-sig")
        marker = "## 中式元素/文化背景检查（自动）"
        if marker in base:
            base = base.split(marker, 1)[0].rstrip() + "\n"
        lines = ["", marker, "",
                 "规则（信息项，不阻断）：SOURCE 是文化/地域/时代的唯一依据。"
                 "命中中式元素时，动作行可由优化器改为文化中性写法；台词/锁行只报告，不自动改。"
                 f"当前配置：market={profile.get('market')}，forbid_cn_elements={profile.get('forbid_cn_elements')}。", ""]
        if results:
            lines += ["| 集数 | 段落 | 类型 | 命中词 | 级别 | 可自动修复 | 上下文 / 建议 |",
                      "|---|---:|---|---|---|---|---|"]
            for r in results:
                lines.append(
                    f"| EP{r['ep']:02d} | {r['paragraph']} | {r['kind']} | {r['term']} | "
                    f"{r['severity']} | {'是' if r['fixable'] else '否'} | "
                    f"{r['context'].replace('|', '｜')} / {r['suggestion'].replace('|', '｜')} |"
                )
            if must_fix:
                lines += ["", f"结论：RISK，must_fix {len(must_fix)} 项；风险集：{', '.join(f'EP{x:02d}' for x in risky_eps)}。"]
            else:
                lines += ["", f"结论：{'RISK' if suspected else 'OK'}，suspected {len(suspected)} 项；风险集：{', '.join(f'EP{x:02d}' for x in risky_eps) or '无'}。"]
        else:
            lines += ["未发现中式元素/文化符号。"]
        C.write_text(report_md, base + "\n".join(lines) + "\n")

    print(f"[{status}] culture check: must_fix={len(must_fix)} suspected={len(suspected)} info={len(info)}")
    for r in (must_fix + suspected)[:20]:
        print(f"  EP{r['ep']:02d} p{r['paragraph']} {r['kind']} {r['term']} {r['severity']} fixable={r['fixable']}")
    print(f"[OK] -> {preflight_dir / 'culture.json'}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="")
    args = ap.parse_args()
    root = Path(args.root) if args.root else C.ROOT
    return scan(root)


if __name__ == "__main__":
    raise SystemExit(main())
