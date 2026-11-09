#!/usr/bin/env python3
"""0-token 确定性校验：四行结构、场次覆盖、触发/参数完整性、禁令、长度、占位词等。

对应《完整规划》第 5.2 节 17 项规则（三段式格式）。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bgm_common as C

RE_TITLE = re.compile(r"^第\s*(\d+)\s*集\s*([｜|：:])\s*(.+)$")
RE_SFX = re.compile(r"^情绪音\s*[：:]\s*(.+)$")
RE_SCENE = re.compile(r"^场景配乐\s*[：:]\s*(.+)$")
RE_RHYTHM = re.compile(r"^节奏\s*[／/]\s*调性\s*[：:]\s*(.+)$")
RE_SCENE_ID = re.compile(r"(\d{1,3})\s*[-－]\s*(\d{1,3})")

PLACEHOLDERS = ("同上", "待定", "TODO", "todo", "自行发挥", "略）", "(略")
RE_LONE_LUE = re.compile(r"(?:^|[，。；、\s])略(?:$|[，。；、\s])")
RE_CROSS = re.compile(r"(?:下一集|上一集|见前文|见后文|后文|前文|后续集|见后续)")
RE_EP_ANY = re.compile(r"第\s*(\d+)\s*集")
RE_KEY = re.compile(r"(?:升|降)?[A-Ga-g]\s*[大小]调|无调性")
RE_BPM = re.compile(r"(?:\d{2,3}\s*(?:BPM|bpm))|(?:(?:BPM|bpm)\s*\d{2,3})")

CLICHE = ("高潮处", "适时", "配合画面", "烘托气氛", "情绪起伏", "逐渐变化")
TRIGGER_WORDS = ("转场", "眼神", "特写", "动作", "台词", "落点")
DIALOG_STRAT = ("对白", "VO", "旁白", "台词", "人声区")
ENDING_STRAT = ("收尾", "结尾", "悬", "骤停", "留白", "渐退", "硬切", "定格", "未解决", "重击收")
RETREAT_WORDS = ("压低", "让位", "不抢", "撤", "降为", "只留", "留白", "让出", "抽空")
HEAVY_TERMS = ("四踩", "EDM", "密集鼓", "密集打击", "强律动", "强节拍", "洗脑", "劲爆",
               "鼓点主导", "旋律主导", "大旋律", "主题旋律展开", "全程渐强", "轰鸣")

INSTRUMENTS = (
    "弦乐", "提琴", "钢琴", "贝斯", "低音管", "单簧管", "长笛", "长号", "圆号", "小号",
    "铜管", "木管", "定音鼓", "大鼓", "军鼓", "鼓刷", "鼓", "镲", "颤音琴", "钟琴",
    "风琴", "竖琴", "吉他", "合成器", "合成", "电子", "脉冲", "失真",
    "工业", "金属", "敲击", "心跳", "噪声", "白噪", "环境", "钟摆", "摩尔斯",
    "sub", "bass", "boom", "drop", "impact",
)


def parse_draft(text: str):
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    info = {
        "title": "", "ep": None, "keywords": "",
        "sfx": "", "scene": "", "rhythm": "",
        "sfx_head": False, "scene_head": False, "rhythm_head": False,
        "order_ok": True, "raw_lines": lines, "md_headings": [],
    }
    seq: list[str] = []
    for ln in lines:
        if ln.startswith("#"):
            info["md_headings"].append(ln[:40])
            continue
        if not info["title"]:
            m = RE_TITLE.match(ln)
            if m:
                info["title"] = ln
                info["ep"] = int(m.group(1))
                info["keywords"] = m.group(3).strip()
                continue
        m = RE_SFX.match(ln)
        if m and not info["sfx_head"]:
            info["sfx_head"] = True
            info["sfx"] = m.group(1).strip()
            seq.append("sfx")
            continue
        m = RE_SCENE.match(ln)
        if m and not info["scene_head"]:
            info["scene_head"] = True
            info["scene"] = m.group(1).strip()
            seq.append("scene")
            continue
        m = RE_RHYTHM.match(ln)
        if m and not info["rhythm_head"]:
            info["rhythm_head"] = True
            info["rhythm"] = m.group(1).strip()
            seq.append("rhythm")
            continue
    info["order_ok"] = seq == ["sfx", "scene", "rhythm"]
    return info


PUNCT = re.compile(r"[\s，。；：、！？…—·\"'“”‘’（）()【】《》〈〉\-—→]")

def core_text(s: str) -> str:
    return PUNCT.sub("", s or "")


def is_anchored(text: str, src_core: str) -> bool:
    c = core_text(text)
    if len(c) < 3:
        return False
    for n in (12, 10, 8, 6, 5, 4, 3):
        for i in range(0, len(c) - n + 1):
            if c[i:i + n] in src_core:
                return True
    return False


def check_ep(ep: int, src_text: str, draft_text: str,
             expected_scenes: list[str], expected_names: list[str], banned: list[str]):
    fails: list[str] = []
    warns: list[str] = []
    stats: dict = {}

    if not draft_text.strip():
        return ["no_draft_file"], [], {}
    info = parse_draft(draft_text)
    src_core = core_text(src_text)

    # 1-2 标题
    if not info["title"]:
        fails.append("missing_title")
    else:
        if info["ep"] != ep:
            fails.append(f"title_ep:{info['ep']}")
        if not info["title"].startswith(f"第{ep}集｜"):
            warns.append("title_separator")
        parts = [p for p in re.split(r"[、，,]", info["keywords"]) if p.strip()]
        if len(parts) < 2 and "与" in info["keywords"]:
            parts = [p for p in info["keywords"].split("与") if p.strip()]
        if not (2 <= len(parts) <= 4):
            warns.append(f"title_keywords:{len(parts)}")
        if len(info["keywords"]) > 30:
            warns.append(f"title_too_long:{len(info['keywords'])}")

    # 3 四行结构与顺序
    for key, name in (("sfx_head", "情绪音"), ("scene_head", "场景配乐"), ("rhythm_head", "节奏／调性")):
        if not info[key]:
            fails.append(f"section_missing:{name}")
    if info["sfx_head"] and info["scene_head"] and info["rhythm_head"] and not info["order_ok"]:
        fails.append("section_order")
    for key, name in (("sfx", "情绪音"), ("scene", "场景配乐"), ("rhythm", "节奏／调性")):
        if info[key] and len(info[key]) < 10:
            fails.append(f"section_short:{name}")
    n_lines = len(info["raw_lines"])
    if n_lines > 4:
        warns.append(f"extra_lines:{n_lines}")

    # 4 情绪音
    sfx = info["sfx"]
    if sfx:
        n_use = sfx.count("用")
        n_colon = sfx.count("：") + sfx.count(":")
        stats["sfx_groups"] = max(n_use, n_colon)
        if max(n_use, n_colon) < 2:
            warns.append("sfx_mapping_few")
        if not re.search(r"(?:≤|<=|≦)?\s*1\.?0?\s*秒", sfx):
            warns.append("sfx_duration_missing")
        if not any(w in sfx for w in TRIGGER_WORDS):
            warns.append("sfx_trigger_missing")
        n_cliche = sum(1 for w in CLICHE if w in sfx)
        if n_cliche >= 2:
            fails.append("sfx_cliche")
        elif n_cliche == 1:
            warns.append("sfx_cliche")
        if not is_anchored(sfx, src_core):
            warns.append("sfx_unanchored")

    # 5-7 场景配乐
    scene = info["scene"]
    if scene:
        if "纯器乐" not in scene:
            warns.append("no_pure_instrumental")
        base = scene.split("。", 1)[0]
        if len(core_text(base)) < 4:
            warns.append("no_style_base")
        if "：" not in scene and ":" not in scene:
            fails.append("scene_entry_missing")
        if not any((w.lower() in scene.lower()) for w in INSTRUMENTS):
            fails.append("no_instrument")
        tail = scene.split("。", 1)[1] if "。" in scene else scene
        for seg in re.split(r"[；;]", tail):
            parts = re.split(r"[：:]", seg, 1)
            if len(parts) == 2:
                items = [x for x in re.split(r"[、，,]", parts[1]) if x.strip()]
                if len(items) > 5:
                    warns.append(f"instruments_heavy:{len(items)}")
                    break
        found_ids = {f"{m.group(1)}-{m.group(2)}" for m in RE_SCENE_ID.finditer(scene)}
        stats["scenes_found"] = sorted(found_ids)
        if expected_scenes:
            missing = []
            for i, sid in enumerate(expected_scenes):
                if sid in found_ids:
                    continue
                nm = expected_names[i] if i < len(expected_names) else ""
                if nm and len(nm) >= 2 and (nm in scene or nm.replace(" ", "") in scene.replace(" ", "")):
                    continue
                missing.append(sid)
            if missing:
                fails.append(f"scene_missing:{','.join(missing)}")
            extra = [s for s in found_ids if s not in expected_scenes]
            if extra:
                warns.append(f"scene_extra:{','.join(sorted(extra))}")
        else:
            warns.append("no_scene_index")

    # 8-12 节奏／调性
    rhythm = info["rhythm"]
    if rhythm:
        if RE_KEY.search(rhythm) is None:
            fails.append("key_missing")
        else:
            stats["key"] = RE_KEY.search(rhythm).group(0)
        if RE_BPM.search(rhythm) is None:
            fails.append("bpm_missing")
        if not any(w in rhythm for w in DIALOG_STRAT):
            warns.append("no_dialog_strategy")
        if not any(w in rhythm for w in ENDING_STRAT):
            warns.append("no_ending_strategy")
        if not any(w in rhythm for w in RETREAT_WORDS):
            fails.append("retreat_missing")
        bpm_nums: list[int] = []
        for m in re.finditer(r"\d{2,3}(?:\s*[→\-~至]\s*\d{2,3})*\s*(?:BPM|bpm)", rhythm):
            bpm_nums += [int(x) for x in re.findall(r"\d{2,3}", m.group(0))]
        for m in re.finditer(r"(?:BPM|bpm)\s*(\d{2,3})", rhythm):
            bpm_nums.append(int(m.group(1)))
        if bpm_nums:
            stats["bpm_max"] = max(bpm_nums)
            if max(bpm_nums) > 140:
                fails.append(f"bpm_too_high:{max(bpm_nums)}")
            elif max(bpm_nums) > 122:
                warns.append(f"bpm_high:{max(bpm_nums)}")

    # 14 占位词
    for token in PLACEHOLDERS:
        if token in draft_text:
            fails.append(f"placeholder:{token}")
    if RE_LONE_LUE.search(draft_text):
        fails.append("placeholder:略")

    # 13 禁用词（否定语境行跳过）
    for term in banned:
        for ln in info["raw_lines"]:
            if term in ln and not re.search(r"(禁用|禁止|不用|避免|勿|不使用)", ln):
                fails.append(f"banned:{term}")
                break

    # 13b 喧宾夺主禁令（旋律/节奏过重；否定语境行跳过）
    for term in HEAVY_TERMS:
        for ln in info["raw_lines"]:
            if term in ln and not re.search(r"(禁用|禁止|不用|避免|不使用|不写|不得|不可|勿)", ln):
                fails.append(f"heavy:{term}")
                break

    # 17 长度
    chars = C.cjk_count(draft_text)
    stats["chars"] = chars
    if chars < 80:
        fails.append(f"too_short:{chars}")
    elif chars < 100:
        warns.append(f"length:{chars}")
    elif chars > 500:
        warns.append(f"length:{chars}")

    # 15 串集引用
    body = "\n".join(ln for ln in info["raw_lines"] if ln != info["title"])
    for m in RE_EP_ANY.finditer(body):
        if int(m.group(1)) != ep:
            warns.append(f"cross_ref:{m.group(0)}")
            break
    if RE_CROSS.search(body):
        warns.append("cross_phrase")

    # 16 井号标题
    if info["md_headings"]:
        fails.append(f"md_heading:{info['md_headings'][0]}")

    stats["title"] = info["title"]
    return fails, warns, stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--eps", default="")
    ap.add_argument("--no-progress", action="store_true")
    args = ap.parse_args()

    index = C.load_json(C.META_DIR / "bgm_index.json")
    if not index:
        print("[FAIL] 未找到 work/meta/bgm_index.json，请先运行 python tools/bgm_prepare.py")
        return 2
    scenes_map = {e["ep"]: e for e in index["episodes"]}
    eps = ([int(x) for x in args.eps.replace(" ", "").split(",") if x]
           if args.eps else sorted(scenes_map))
    banned = C.banned_terms()
    progress = C.load_json(C.META_DIR / "bgm_progress.json", {"episodes": {}})

    total_fail = 0
    for ep in eps:
        src_path = C.SRC_DIR / f"ep{ep:02d}.md"
        draft_path = C.DRAFT_DIR / f"ep{ep:02d}.md"
        src_text = C.read_text(src_path) if src_path.exists() else ""
        draft_text = C.read_text(draft_path) if draft_path.exists() else ""
        meta = scenes_map.get(ep, {})
        fails, warns, stats = check_ep(
            ep, src_text, draft_text,
            meta.get("scenes", []), meta.get("scene_names", []), banned)
        verdict = "pass" if not fails else "fail"
        if fails:
            total_fail += 1
        C.save_json(C.REPORT_DIR / f"bgm_check_ep{ep:02d}.json", {
            "ep": ep, "verdict": verdict, "fails": fails, "warnings": warns, "stats": stats,
        })
        if not args.no_progress:
            pe = progress.setdefault("episodes", {}).setdefault(str(ep), {})
            pe["status"] = "passed" if verdict == "pass" else "failed"
            pe["reasons"] = fails
            pe["checked_at"] = C.now_iso()
            C.save_json(C.META_DIR / "bgm_progress.json", progress)
        tag = "ok" if verdict == "pass" else "; ".join(C.ascii_safe(f) for f in fails[:4])
        print(f"[{'PASS' if verdict == 'pass' else 'FAIL'}] ep{ep:02d} {tag}"
              + (f" warns={len(warns)}" if warns else ""))
    print(f"[OK] checked={len(eps)} failed={total_fail}")
    return 1 if total_fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
