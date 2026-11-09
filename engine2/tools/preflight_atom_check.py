"""确定性前置检查：△/对白密度与节奏（双向），只报告、不阻断。

与「有声台词字数检查」同级：不作为错误、不影响是否进入炼本、不自动修改正文。
检测两个方向的风险：
  A. △ 过多（动作过密/偏慢）：连续无台词 △ 段过长、△/台词比过高、相邻 △ 近似重复。
     优化方式为「合并」——把一段连续 △ 合并为 1 条或少量完整 △，保留全部事实与表演动作，只减少 △ 条数。
  B. 对白过多 / 动作不足：连续对白段过长（段间无 △/换场）、△/台词比过低。
     本检查项只检测与报告，不做任何补写（补写涉及新增内容，不在本阶段处理）。

结果写入：
  work/preflight/atom_pacing.json（A）
  work/preflight/dialogue_density.json（B）
并分别追加到 work/preflight/report.md。

用法：python tools/preflight_atom_check.py
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C

# ---- 阈值（可人工调整）----
MAX_ATOM_RUN = 4            # 一段内连续 △（中间无任何有声台词）的最大允许条数
MAX_ATOMS_PER_SPOKEN = 3.0  # 全集 △ 条数 / 有声台词行数 的最大允许比值
DUP_SIMILARITY = 0.5        # 相邻原子近似（bigram Jaccard）判定阈值
MAX_DUP_PAIRS = 1           # 允许的相邻近似原子对数；超过即计风险

# ---- 反向阈值：对白过多 / 动作不足（信息项，只报告）----
MAX_SPOKEN_RUN = 8          # 连续对白段（段间无任何 △ 与换场）允许的最大台词行数
MIN_ATOMS_PER_SPOKEN = 0.5  # 全集 △ 条数 / 有声台词行数 的最低比值（低于则动作偏少）
SPOKEN_FLOOR = 10           # 低于该台词行数不评估比值，避免小样本误报

STRUCT_RE = re.compile(
    r"^(?:第\s*\d+\s*集|(?i:episode)\s*\d+|\d+[-－]\d+\s|"
    r"(?:人物|出场人物)\s*[：:]|【)"
)
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


def is_spoken(line):
    # Count any speaker line (tag optional); metadata/atoms/scenes are excluded
    # by the shared parser, so untagged scripts no longer report 0 dialogue.
    return C.parse_dialogue_line(line) is not None


def jaccard(a, b):
    ga, gb = C.bigrams(a), C.bigrams(b)
    if not ga or not gb:
        return 0.0
    return len(ga & gb) / len(ga | gb)


def analyze(lines):
    body = [C.normalize_line(x) for x in lines if C.normalize_line(x)]
    atoms = 0
    spoken = 0
    atom_texts = []
    runs = []       # (start_index, length)：连续 △ 段
    run_start = None
    sp_runs = []    # (start_index, length)：连续对白段（段间无 △/换场）
    sp_start = None
    for i, s in enumerate(body):
        is_atom = s.startswith("△")
        sp = is_spoken(s)
        st = bool(STRUCT_RE.match(s))
        if is_atom:
            if run_start is None:
                run_start = i
            atoms += 1
            atom_texts.append(s[1:].strip())
            if sp_start is not None:            # △ 断开连续对白段
                sp_runs.append((sp_start, i - sp_start))
                sp_start = None
            continue
        if sp or st:
            if run_start is not None:            # 台词/换场 断开连续 △ 段
                runs.append((run_start, i - run_start))
                run_start = None
        if sp:
            spoken += 1
            if sp_start is None:
                sp_start = i
        elif st:
            if sp_start is not None:             # 换场 断开连续对白段
                sp_runs.append((sp_start, i - sp_start))
                sp_start = None
    if run_start is not None:
        runs.append((run_start, len(body) - run_start))
    if sp_start is not None:
        sp_runs.append((sp_start, len(body) - sp_start))

    max_run = max((r[1] for r in runs), default=0)
    max_sp_run = max((r[1] for r in sp_runs), default=0)
    ratio = (atoms / spoken) if spoken else float(atoms)

    dups = []
    for k in range(1, len(atom_texts)):
        sim = jaccard(atom_texts[k - 1], atom_texts[k])
        if sim >= DUP_SIMILARITY:
            dups.append({"prev": atom_texts[k - 1][:40],
                         "cur": atom_texts[k][:40],
                         "similarity": round(sim, 2)})

    reasons = []
    if max_run >= MAX_ATOM_RUN:
        reasons.append(f"连续无台词 △ 段达 {max_run} 条（上限 {MAX_ATOM_RUN}）")
    if ratio > MAX_ATOMS_PER_SPOKEN:
        reasons.append(f"△/台词比 {ratio:.1f}（上限 {MAX_ATOMS_PER_SPOKEN}）")
    if len(dups) > MAX_DUP_PAIRS:
        reasons.append(f"相邻近重复 △ 对 {len(dups)} 处（上限 {MAX_DUP_PAIRS}）")

    # 反向：对白过多 / 动作不足
    dialogue_reasons = []
    if max_sp_run >= MAX_SPOKEN_RUN:
        dialogue_reasons.append(f"连续对白段达 {max_sp_run} 条（上限 {MAX_SPOKEN_RUN}，段间无 △/换场）")
    if spoken >= SPOKEN_FLOOR and ratio < MIN_ATOMS_PER_SPOKEN:
        dialogue_reasons.append(f"△/台词比 {ratio:.2f}（低于下限 {MIN_ATOMS_PER_SPOKEN}，动作偏少）")

    long_runs = [{"start": st, "length": ln, "preview": body[st][:40]}
                 for st, ln in runs if ln >= MAX_ATOM_RUN]
    merge_targets = [{"start": st, "length": ln, "preview": body[st][:40]}
                     for st, ln in runs if ln >= 2]
    dialogue_runs = [{"start": st, "length": ln, "preview": body[st][:40]}
                     for st, ln in sp_runs if ln >= MAX_SPOKEN_RUN]
    return {
        "atoms": atoms,
        "spoken": spoken,
        "ratio": round(ratio, 2),
        "max_atom_run": max_run,
        "duplicate_pairs": len(dups),
        "long_runs": long_runs,
        "merge_targets": merge_targets,
        "merge_hint": "把每段连续 △ 合并为 1 条或少量完整 △，完整保留全部事实与表演动作，只减少 △ 条数（不删减内容）。",
        "duplicates": dups,
        "status": "RISK" if reasons else "OK",
        "reasons": reasons,
        "max_spoken_run": max_sp_run,
        "dialogue_runs": dialogue_runs,
        "dialogue_note": "对白过多/动作不足只检测与报告，本阶段不补写动作。",
        "dialogue_status": "RISK" if dialogue_reasons else "OK",
        "dialogue_reasons": dialogue_reasons,
    }


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
        risky = []
        dialogue_risky = []
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
            stats = analyze(paragraphs[start:end])
            row = {"ep": n, "min": MAX_ATOM_RUN, "max_ratio": MAX_ATOMS_PER_SPOKEN, **stats}
            results.append(row)
            if stats["status"] == "RISK":
                risky.append(n)
            if stats["dialogue_status"] == "RISK":
                dialogue_risky.append(n)
        check = {
            "rule": "非阻断信息项：连续无台词 △ 段 <= {r} 且 △/台词比 <= {ratio} 且 相邻近重复 △ 对 <= {dup}。命中后由用户决定是否将连续 △ 段合并为少量完整 △（保留全部事实与表演动作）。".format(
                r=MAX_ATOM_RUN, ratio=MAX_ATOMS_PER_SPOKEN, dup=MAX_DUP_PAIRS),
            "merge_semantics": "合并 = 将连续 △ 段合并为 1 条或少量完整 △，完整保留全部事实与表演动作，只减少 △ 条数，不删减内容。",
            "thresholds": {"max_atom_run": MAX_ATOM_RUN,
                           "max_atoms_per_spoken": MAX_ATOMS_PER_SPOKEN,
                           "dup_similarity": DUP_SIMILARITY,
                           "max_dup_pairs": MAX_DUP_PAIRS},
            "blocking": False,
            "risky_eps": risky,
            "results": results,
            "status": "RISK" if risky else "OK",
        }
        report["atom_pacing_check"] = check
        C.save_json(report_path, report)
        C.save_json(root / "work" / "preflight" / "atom_pacing.json", check)

        # 反向：对白过多 / 动作不足（只检测与报告，不补写）
        dcheck = {
            "rule": "非阻断信息项：连续对白段 <= {r} 且 △/台词比不低于 {ratio}（台词行 >= {floor} 时才评估比值）。本项只检测与报告，本阶段不补写动作。".format(
                r=MAX_SPOKEN_RUN, ratio=MIN_ATOMS_PER_SPOKEN, floor=SPOKEN_FLOOR),
            "note": "对白过多/动作不足为信息项，不阻断流程，也不在本阶段自动补写动作（补写涉及新增内容）。",
            "thresholds": {"max_spoken_run": MAX_SPOKEN_RUN,
                           "min_atoms_per_spoken": MIN_ATOMS_PER_SPOKEN,
                           "spoken_floor": SPOKEN_FLOOR},
            "blocking": False,
            "risky_eps": dialogue_risky,
            "results": results,
            "status": "RISK" if dialogue_risky else "OK",
        }
        report["dialogue_density_check"] = dcheck
        C.save_json(report_path, report)
        C.save_json(root / "work" / "preflight" / "dialogue_density.json", dcheck)

        report_md = root / "work" / "preflight" / "report.md"
        if report_md.exists():
            base = report_md.read_text(encoding="utf-8-sig")
            marker = "## △ 原子密度/节奏检查（自动）"
            if marker in base:
                base = base.split(marker, 1)[0].rstrip() + "\n"
            lines = ["", marker, "",
                     f"规则（信息项，不阻断）：连续无台词 △ 段 <= {MAX_ATOM_RUN} 条；△/有声台词行比 <= {MAX_ATOMS_PER_SPOKEN}；相邻近重复 △ 对 <= {MAX_DUP_PAIRS}。",
                     "本项与台词字数检查同级：只报告、不作为错误、不影响是否进入炼本。优化方式为「合并」：把连续 △ 段合并为 1 条或少量完整 △，完整保留全部事实与表演动作，只减少 △ 条数；是否合并由用户在会话中决定。", "",
                     "| 集数 | △ 数 | 有声台词行 | △/台词 | 最长无台词△段 | 近似△对 | 结果 |",
                     "|---|---:|---:|---:|---:|---:|---|"]
            for row in results:
                lines.append(f"| EP{row['ep']:02d} | {row['atoms']} | {row['spoken']} | "
                             f"{row['ratio']} | {row['max_atom_run']} | {row['duplicate_pairs']} | {row['status']} |")
            if risky:
                lines += ["", "### 风险集明细", ""]
                for row in results:
                    if row["status"] != "RISK":
                        continue
                    lines.append(f"- EP{row['ep']:02d}：" + "；".join(row["reasons"]))
                    for run in row["merge_targets"]:
                        lines.append(f"  - 合并目标：本集第 {run['start'] + 1} 行起连续 {run['length']} 条 △ → 合并为 1 条或少量完整 △（保留全部事实与动作）：{run['preview']}…")
                    for dup in row["duplicates"]:
                        lines.append(f"  - 近似 △ 对（相似度 {dup['similarity']}）：{dup['prev']}… / {dup['cur']}…")
                lines += ["", f"结论：RISK，风险集数：{', '.join(f'EP{x:02d}' for x in risky)}。可经用户同意后按「合并」处理（保留全部事实与表演动作）。"]
            else:
                lines += ["", "结论：OK，未检测到 △ 密度/冗余节奏风险。"]
            C.write_text(report_md, base + "\n".join(lines) + "\n")

        if report_md.exists():
            base = report_md.read_text(encoding="utf-8-sig")
            marker = "## 对白密集/动作不足检查（自动）"
            if marker in base:
                base = base.split(marker, 1)[0].rstrip() + "\n"
            lines = ["", marker, "",
                     f"规则（信息项，不阻断）：连续对白段 <= {MAX_SPOKEN_RUN} 行（段间无 △/换场）；台词行 >= {SPOKEN_FLOOR} 时 △/台词比不低于 {MIN_ATOMS_PER_SPOKEN}。",
                     "本项只检测与报告，不作为错误、不影响是否进入炼本，也不在本阶段补写动作（补写涉及新增内容，留待炼本阶段处理）。", "",
                     "| 集数 | △ 数 | 有声台词行 | △/台词 | 最长连续对白段 | 结果 |",
                     "|---|---:|---:|---:|---:|---|"]
            for row in results:
                lines.append(f"| EP{row['ep']:02d} | {row['atoms']} | {row['spoken']} | "
                             f"{row['ratio']} | {row['max_spoken_run']} | {row['dialogue_status']} |")
            if dialogue_risky:
                lines += ["", "### 风险集明细", ""]
                for row in results:
                    if row["dialogue_status"] != "RISK":
                        continue
                    lines.append(f"- EP{row['ep']:02d}：" + "；".join(row["dialogue_reasons"]))
                    for run in row["dialogue_runs"]:
                        lines.append(f"  - 连续对白段：本集第 {run['start'] + 1} 行起连续 {run['length']} 行台词（段间无 △/换场）：{run['preview']}…")
                lines += ["", f"结论：RISK，对白密集/动作不足集数：{', '.join(f'EP{x:02d}' for x in dialogue_risky)}。仅报告，本阶段不补写动作。"]
            else:
                lines += ["", "结论：OK，未检测到对白密集/动作不足风险。"]
            C.write_text(report_md, base + "\n".join(lines) + "\n")

        print(f"[{'RISK' if risky else 'OK'}] atom pacing {len(results)} episodes; risky={risky}")
        for row in results:
            if row["status"] == "RISK":
                print(f"[节奏风险·△过多] 第{row['ep']}集：△={row['atoms']} 台词行={row['spoken']} "
                      f"△/台词={row['ratio']} 最长无台词△段={row['max_atom_run']} 近似对={row['duplicate_pairs']}")
        print(f"[{'RISK' if dialogue_risky else 'OK'}] dialogue density {len(results)} episodes; risky={dialogue_risky}")
        for row in results:
            if row["dialogue_status"] == "RISK":
                print(f"[节奏风险·对白过密/动作不足] 第{row['ep']}集：△={row['atoms']} 台词行={row['spoken']} "
                      f"△/台词={row['ratio']} 最长连续对白段={row['max_spoken_run']}")
        return 0  # 信息项：不阻断后续流程；崩溃时 except 分支返回 2
    except Exception as e:
        print(f"[FAIL] atom pacing check: {e}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
