"""台词逐字锁定校验：比对源段落与优化存档 work/source/epNN.md 的台词行。

规范化仅容忍纯格式差异（空白、弯引号、全半角冒号/括号）；任何文字增删改、顺序变化都会判 FAIL。
"""
import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C


def canon(s):
    s = re.sub(r"\s+", "", s or "")
    s = (s.replace("\u201c", '"').replace("\u201d", '"')
          .replace("\u2018", "'").replace("\u2019", "'"))
    s = (s.replace("：", ":").replace("（", "(").replace("）", ")")
          .replace("［", "[").replace("］", "]"))
    return s


def dialogue_lines(lines):
    out = []
    for raw in lines:
        s = C.normalize_line(raw)
        if not s:
            continue
        if s.startswith("\u25b3") or C.is_structural_line(s):
            continue
        pair = C.split_speaker(s)
        if not pair:
            continue
        if not C.detect_tag(pair[0]):
            continue
        out.append((pair[0], pair[1]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    root = C.ROOT
    report_path = root / "work" / "preflight" / "report.json"
    paras_path = root / "work" / "meta" / "paragraphs.txt"
    if not report_path.exists() or not paras_path.exists():
        print("[FAIL] 缺少 report.json 或 paragraphs.txt，请先运行前置检查")
        return 2
    report = C.load_json(report_path, {}) or {}
    episodes = report.get("episodes") or []
    if not episodes:
        print("[FAIL] report.json 中没有 episodes 边界")
        return 2
    paras = paras_path.read_text(encoding="utf-8-sig").splitlines()
    results = []
    failed = []
    for item in sorted(episodes, key=lambda x: int(x["ep"])):
        n = int(item["ep"])
        start = int(item["start_paragraph"])
        end = int(item["end_paragraph_exclusive"])
        out_path = root / "work" / "source" / f"ep{n:02d}.md"
        if not out_path.exists():
            results.append({"ep": n, "status": "FAIL", "detail": "missing work/source file"})
            failed.append(n)
            continue
        src = [(canon(p), canon(t)) for p, t in dialogue_lines(paras[start:end])]
        out = [(canon(p), canon(t)) for p, t in dialogue_lines(out_path.read_text(encoding="utf-8-sig").splitlines())]
        src_raw = "\n".join(paras[start:end])
        out_raw = out_path.read_text(encoding="utf-8-sig")
        culture = C.culture_added_errors(src_raw, out_raw)
        if src == out and not culture:
            results.append({"ep": n, "status": "PASS", "dialogue_lines": len(src)})
        else:
            detail = f"dialogue lines differ: src={len(src)} out={len(out)}"
            for i in range(min(len(src), len(out))):
                if src[i] != out[i]:
                    detail += f" | first diff #{i + 1}: src={src[i][0]}：{src[i][1][:40]} / out={out[i][0]}：{out[i][1][:40]}"
                    break
            if culture:
                detail += " | " + ", ".join(culture)
            results.append({"ep": n, "status": "FAIL", "detail": detail})
            failed.append(n)
    out = Path(args.out) if args.out else (root / "work" / "report" / "verify_optimized.json")
    C.save_json(out, {"checked": len(results), "failed_eps": failed, "results": results})
    for r in results:
        tag = "ok" if r["status"] == "PASS" else r.get("detail", "")
        print(f"[{r['status']}] ep{r['ep']:02d} {tag}")
    print(f"[OK] checked={len(results)} failed={len(failed)} -> {out}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
