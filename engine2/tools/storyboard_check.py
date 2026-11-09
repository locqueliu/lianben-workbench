"""竖屏分镜稿硬校验（0 token）。

校验目标：分镜组时长、镜头时间轴、单镜/组/集上限、空间起点、声音/禁止字段、
台词标签（含 O.S./VO/OS）、禁用旧字段与占位词。

用法：
  python tools/storyboard_check.py --docx 测试/目标稿.docx
  python tools/storyboard_check.py --dir work/storyboard
  python tools/storyboard_check.py --eps 1,2 --report-only
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C

GROUP_RE = re.compile(r"^分镜\s*(\d+)\s*[（(]\s*时长\s*[：:]\s*([0-9]+(?:\.[0-9]+)?)\s*秒\s*[）)]")
GROUP_SOP_RE = re.compile(r"^分镜\s*(\d+)\s*[｜|]\s*预计\s*([0-9]+(?:\.[0-9]+)?)\s*秒")
SHOT_RE = re.compile(r"^镜头\s*(\d+)\s*[（(]\s*([0-9]+(?:\.[0-9]+)?)\s*[—\-–~]\s*([0-9]+(?:\.[0-9]+)?)\s*秒\s*[）)]")
SCENE_RE = re.compile(r"^(\d+)[-－](\d+)\s+")
CAST_RE = re.compile(r"^(?:人物|出场人物)\s*[：:]")


def new_ep(no):
    return {"no": no, "scenes": [], "groups": [], "raw": []}


def new_scene(heading):
    return {"heading": heading, "cast": []}


def new_group(no, duration):
    return {"no": no, "duration": duration, "space_start": "", "sound": "",
            "prohibit": "", "shots": [], "tags": [], "action": [], "dialogues": []}


def new_shot(no, start, end):
    return {"no": no, "start": start, "end": end, "frame_range": "", "offscreen": "",
            "tags": [], "action": [], "dialogues": []}


def parse(lines, profile):
    episodes = []
    ep = None
    scene = None
    group = None
    shot = None
    for raw in lines:
        s = C.normalize_line(raw)
        if not s:
            continue
        n = C.episode_number(s)
        if n is not None:
            ep = new_ep(n)
            episodes.append(ep)
            scene = group = shot = None
            ep["raw"].append(s)
            continue
        if ep is None:
            continue
        ep["raw"].append(s)
        if SCENE_RE.match(s):
            scene = new_scene(s)
            ep["scenes"].append(scene)
            group = shot = None
            continue
        if CAST_RE.match(s):
            if scene is not None:
                scene["cast"] = [x.strip() for x in re.split(r"[、,，\s]+", s.split("：", 1)[-1].split(":", 1)[-1]) if x.strip()]
            continue
        m = GROUP_RE.match(s) or GROUP_SOP_RE.match(s)
        if m:
            group = new_group(int(m.group(1)), float(m.group(2)))
            ep["groups"].append(group)
            shot = None
            continue
        m = SHOT_RE.match(s)
        if m:
            if group is not None:
                shot = new_shot(int(m.group(1)), float(m.group(2)), float(m.group(3)))
                group["shots"].append(shot)
            continue
        if re.match(r"^空间(?:起点)?\s*[：:]", s) and group is not None:
            group["space_start"] = re.sub(r"^空间(?:起点)?\s*[：:]\s*", "", s)
            continue
        if s.startswith("画面范围") and shot is not None:
            shot["frame_range"] = re.sub(r"^画面范围\s*[：:]\s*", "", s)
            continue
        if s.startswith("画外锁定") and shot is not None:
            shot["offscreen"] = re.sub(r"^画外锁定[^：:]*[：:]\s*", "", s)
            continue
        if re.match(r"^(?:声音设计|声音)\s*[：:]", s) and group is not None:
            group["sound"] = re.sub(r"^(?:声音设计|声音)\s*[：:]\s*", "", s)
            continue
        if re.match(r"^(?:硬性禁止|禁止)\s*[：:]", s) and group is not None:
            group["prohibit"] = re.sub(r"^(?:硬性禁止|禁止)\s*[：:]\s*", "", s)
            continue
        if s.startswith("【"):
            (shot or group or ep).setdefault("tags", []).append(s)
            continue
        rec = C.parse_storyboard_dialogue(s)
        if rec:
            rec["line"] = s
            (shot or group or ep).setdefault("dialogues", []).append(rec)
            continue
        (shot or group or ep).setdefault("action", []).append(s)
    return episodes


def check_ep(ep, profile):
    fails, warns = [], []
    tol = float(profile.get("time_tolerance", 0.06))
    groups = ep["groups"]
    if not groups:
        fails.append("没有分镜组")
        return fails, warns
    for i, g in enumerate(groups, 1):
        if g["no"] != i:
            fails.append(f"分镜编号不连续：第{i}组写作分镜{g['no']}")
        if not g["space_start"]:
            fails.append(f"分镜{g['no']} 缺空间起点")
        else:
            if len(g["space_start"]) < 10:
                fails.append(f"分镜{g['no']} 空间起点过短")
            for phrase in profile.get("space_forbid_phrases", []):
                if phrase in g["space_start"]:
                    fails.append(f"分镜{g['no']} 空间起点含省略词「{phrase}」")
        if not g["sound"]:
            fails.append(f"分镜{g['no']} 缺声音设计/声音")
        if not g["prohibit"]:
            fails.append(f"分镜{g['no']} 缺禁止项")
        dur = g["duration"]
        if dur <= 0 or dur > float(profile["group_max"]) + tol:
            fails.append(f"分镜{g['no']} 时长 {dur} 超出组上限 {profile['group_max']}")
        shots = g["shots"]
        if not shots:
            fails.append(f"分镜{g['no']} 没有镜头")
            continue
        expected = 0.0
        total = 0.0
        for j, sh in enumerate(shots, 1):
            if sh["no"] != j:
                fails.append(f"分镜{g['no']} 镜头编号不连续：第{j}镜写作镜头{sh['no']}")
            if abs(sh["start"] - expected) > tol:
                fails.append(f"分镜{g['no']} 镜头{sh['no']} 起点 {sh['start']} ≠ 上一镜终点 {round(expected, 2)}")
            d = sh["end"] - sh["start"]
            if d <= 0:
                fails.append(f"分镜{g['no']} 镜头{sh['no']} 时长非法")
            if d > float(profile["shot_max"]) + tol:
                fails.append(f"分镜{g['no']} 镜头{sh['no']} 时长 {round(d, 2)} 超出单镜上限 {profile['shot_max']}")
            if not sh["action"] and not sh["dialogues"]:
                warns.append(f"分镜{g['no']} 镜头{sh['no']} 没有动作或台词")
            expected = sh["end"]
            total += d
        if abs(total - dur) > tol:
            fails.append(f"分镜{g['no']} 镜头时长合计 {round(total, 2)} ≠ 组时长 {dur}")
        if len(shots) < int(profile["shots_per_group"][0]) or len(shots) > int(profile["shots_per_group"][1]):
            warns.append(f"分镜{g['no']} 镜头数 {len(shots)} 不在建议范围 {profile['shots_per_group']}")
    total_dur = sum(g["duration"] for g in groups)
    if total_dur > float(profile["episode_max"]) + tol:
        fails.append(f"单集时长 {round(total_dur, 1)} 超出上限 {profile['episode_max']}")
    if not ep["scenes"]:
        fails.append("没有场次行")
    else:
        for sc in ep["scenes"]:
            if not sc["cast"]:
                warns.append(f"场次 {sc['heading'][:20]} 缺人物/出场人物行")
    for token in profile.get("forbid_tokens", []):
        if token == "△":
            if any(x.startswith("△") for x in ep["raw"]):
                fails.append("出现禁用符号 △")
        elif token in "\n".join(ep["raw"]):
            fails.append(f"出现禁用字段/标记：{token}")
    if profile.get("language") == "english":
        cn = sum(1 for g in groups for sh in g.get("shots", [])
                 for d in sh.get("dialogues", []) if d.get("lang") == "cn")
        if cn:
            fails.append(f"A profile 出现 {cn} 行中文台词（只保留英文）")
    cjk = C.cjk_count("\n".join(ep["raw"]))
    shots = sum(len(g["shots"]) for g in groups)
    g_lo, g_hi = int(profile["groups_per_ep"][0]), int(profile["groups_per_ep"][1])
    s_lo, s_hi = int(profile["shots_per_ep"][0]), int(profile["shots_per_ep"][1])
    c_lo, c_hi = int(profile["cjk_per_ep"][0]), int(profile["cjk_per_ep"][1])
    t_target = int(profile.get("total_chars_target", 9000))
    t_hi = int(profile.get("total_chars_per_ep", 10000))
    if len(groups) > g_hi:
        fails.append(f"分镜组数 {len(groups)} 超出目标上限 {g_hi}（150s 是上限，不是目标）")
    elif len(groups) < g_lo:
        warns.append(f"分镜组数 {len(groups)} 低于目标下限 {g_lo}")
    if shots > s_hi:
        fails.append(f"镜头数 {shots} 超出目标上限 {s_hi}")
    elif shots < s_lo:
        warns.append(f"镜头数 {shots} 低于目标下限 {s_lo}")
    if cjk > c_hi:
        warns.append(f"中文字数 {cjk} 超过目标上限 {c_hi}，仅作提示，不作为失败条件")
    elif cjk < c_lo:
        warns.append(f"中文字数 {cjk} 低于目标下限 {c_lo}")
    total = C.total_char_count(ep.get("source_text") or "\n".join(ep["raw"]))
    if total > t_hi:
        fails.append(f"单集总字符数 {total} 超出硬上限 {t_hi}（含标点/空格/换行），必须打回压缩")
    elif total > t_target:
        warns.append(f"单集总字符数 {total} 超过目标 {t_target}，建议压缩")
    if total_dur > float(profile.get("episode_warn_above", 145.0)):
        warns.append(f"单集时长 {round(total_dur, 1)}s 贴近 150s 上限，确认是否必要")
    return fails, warns


def check_plan(plan, profile):
    fails, warns = [], []
    tol = float(profile.get("time_tolerance", 0.06))
    ep = int(plan.get("ep") or 0)
    if not ep:
        fails.append("计划缺 ep")
    total_dur = 0.0
    groups = []
    for sc in plan.get("scenes") or []:
        for g in sc.get("groups") or []:
            groups.append(g)
    if not groups:
        fails.append("计划没有分镜组")
        return fails, warns
    shots_total = 0
    for g in groups:
        no = g.get("no")
        dur = float(g.get("duration") or 0)
        total_dur += dur
        if not g.get("space_start"):
            fails.append(f"计划分镜{no} 缺空间起点")
        else:
            for phrase in profile.get("space_forbid_phrases", []):
                if phrase in g["space_start"]:
                    fails.append(f"计划分镜{no} 空间起点含「{phrase}」")
        if not g.get("sound"):
            fails.append(f"计划分镜{no} 缺 sound")
        if not g.get("prohibit"):
            fails.append(f"计划分镜{no} 缺 prohibit")
        if dur <= 0 or dur > float(profile["group_max"]) + tol:
            fails.append(f"计划分镜{no} 时长 {dur} 超限")
        expected = 0.0
        total = 0.0
        for sh in g.get("shots") or []:
            shots_total += 1
            st, en = float(sh.get("start") or 0), float(sh.get("end") or 0)
            if abs(st - expected) > tol:
                fails.append(f"计划分镜{no} 镜头{sh.get('no')} 起点不连续")
            if en - st <= 0 or en - st > float(profile["shot_max"]) + tol:
                fails.append(f"计划分镜{no} 镜头{sh.get('no')} 时长非法")
            expected, total = en, total + (en - st)
            for d in sh.get("dialogue") or []:
                if not d.get("sid") or not d.get("text"):
                    fails.append(f"计划分镜{no} 镜头{sh.get('no')} 台词缺 sid/text")
        if not g.get("shots"):
            fails.append(f"计划分镜{no} 没有镜头")
        elif abs(total - dur) > tol:
            fails.append(f"计划分镜{no} 镜头时长合计 {round(total, 2)} ≠ {dur}")
    if total_dur > float(profile["episode_max"]) + tol:
        fails.append(f"计划单集时长 {round(total_dur, 1)} 超限")
    if total_dur > float(profile.get("episode_warn_above", 145.0)):
        warns.append(f"计划单集时长 {round(total_dur, 1)}s 贴近 150s 上限，确认是否必要")
    g_lo, g_hi = int(profile["groups_per_ep"][0]), int(profile["groups_per_ep"][1])
    s_lo, s_hi = int(profile["shots_per_ep"][0]), int(profile["shots_per_ep"][1])
    if len(groups) > g_hi:
        fails.append(f"计划分镜组数 {len(groups)} 超出目标上限 {g_hi}")
    elif len(groups) < g_lo:
        warns.append(f"计划分镜组数 {len(groups)} 低于目标下限 {g_lo}")
    if shots_total > s_hi:
        fails.append(f"计划镜头数 {shots_total} 超出目标上限 {s_hi}")
    elif shots_total < s_lo:
        warns.append(f"计划镜头数 {shots_total} 低于目标下限 {s_lo}")
    return fails, warns


def read_lines(path):
    path = Path(path)
    if path.suffix.lower() == ".docx":
        units, _px, _xml = C.extract_source_units(path)
        return [C.normalize_line(u["text"]) for u in units]
    return [C.normalize_line(x) for x in C.read_text(path).splitlines()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docx", default=None)
    ap.add_argument("--dir", default=None)
    ap.add_argument("--plans", default=None)
    ap.add_argument("--eps", default="")
    ap.add_argument("--profile", default=None)
    ap.add_argument("--report-only", action="store_true")
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    root = C.ROOT
    profile_data = C.load_json(root / "storyboard-profile.json", {}) or {}
    if not profile_data:
        print("[FAIL] 缺少 storyboard-profile.json")
        return 2
    profile_name = args.profile or profile_data.get("active") or "B_bilingual_full"
    profile = (profile_data.get("profiles") or {}).get(profile_name)
    if not profile:
        print(f"[FAIL] 未知 profile：{profile_name}")
        return 2

    if args.plans:
        pfiles = sorted(Path(args.plans).glob("ep*_plan.json"))
        if args.eps:
            wanted = {int(x) for x in re.findall(r"\d+", args.eps)}
            pfiles = [p for p in pfiles if int(re.search(r"ep(\d+)", p.stem).group(1)) in wanted]
        if not pfiles:
            print("[FAIL] 未找到 ep*_plan.json")
            return 2
        results = []
        total_fails = 0
        for p in pfiles:
            plan = C.load_json(p, {}) or {}
            fails, warns = check_plan(plan, profile)
            total_fails += len(fails)
            epno = int(plan.get("ep") or 0)
            results.append({"ep": epno, "fails": fails, "warns": warns, "plan": str(p)})
            print(f"PLAN EP{epno:02d}｜失败{len(fails)}｜警告{len(warns)}")
            for f in fails[:6]:
                print(f"  [FAIL] {f}")
        print(f"[{'FAIL' if total_fails else 'PASS'}] plan check: eps={len(results)} fails={total_fails} profile={profile_name}")
        out = Path(args.out) if args.out else (root / "work" / "report" / "storyboard_plan_check.json")
        C.save_json(out, {"profile": profile_name, "results": results, "fails": total_fails})
        print(f"[OK] {out}")
        if args.report_only:
            return 0
        return 1 if total_fails else 0

    files = []
    if args.docx:
        files = [Path(args.docx)]
    elif args.dir:
        files = sorted(Path(args.dir).glob("ep*.md"))
    if not files:
        print("[FAIL] 未找到待校验文件（--docx 或 --dir）")
        return 2
    if args.eps:
        wanted = {int(x) for x in re.findall(r"\d+", args.eps)}
        files = [p for p in files if (int(re.search(r"ep(\d+)", p.stem).group(1)) if re.search(r"ep(\d+)", p.stem) else -1) in wanted]

    episodes = []
    for p in files:
        eps = parse(read_lines(p), profile)
        if p.suffix.lower() != ".docx":
            raw_text = C.read_text(p)
            for ep in eps:
                ep["source_text"] = raw_text
        episodes.extend(eps)
    if not episodes:
        print("[FAIL] 未解析到任何集")
        return 2

    results = []
    total_fails = 0
    for ep in sorted(episodes, key=lambda x: x["no"]):
        fails, warns = check_ep(ep, profile)
        total_fails += len(fails)
        groups = ep["groups"]
        shots = sum(len(g["shots"]) for g in groups)
        cjk = C.cjk_count("\n".join(ep["raw"]))
        total = C.total_char_count(ep.get("source_text") or "\n".join(ep["raw"]))
        results.append({"ep": ep["no"], "groups": len(groups), "shots": shots,
                        "duration": round(sum(g["duration"] for g in groups), 2),
                        "cjk": cjk, "total": total, "fails": fails, "warns": warns})
        print(f"EP{ep['no']:02d} 组{len(groups)}｜镜{shots}｜{round(sum(g['duration'] for g in groups), 1)}s｜"
              f"中文{cjk}｜总字符{total}｜失败{len(fails)}｜警告{len(warns)}")
        for f in fails[:6]:
            print(f"  [FAIL] {f}")
    print(f"[{'FAIL' if total_fails else 'PASS'}] storyboard check: eps={len(results)} fails={total_fails} profile={profile_name}")
    out = Path(args.out) if args.out else (root / "work" / "report" / "storyboard_check.json")
    C.save_json(out, {"profile": profile_name, "files": [str(p) for p in files],
                      "results": results, "fails": total_fails})
    print(f"[OK] {out}")
    if args.report_only:
        return 0
    return 1 if total_fails else 0


if __name__ == "__main__":
    raise SystemExit(main())

