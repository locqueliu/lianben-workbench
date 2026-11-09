"""前置主角覆盖检查（0 token）。

只在前置质检阶段判定：无主角 / 主角戏份极少的集标记为 blocked，不进入炼本。
已经进入炼本（已有 draft 或 passed/passed-with-issues/failed 状态）的集不回判。

用法：
    python tools/preflight_protagonist_check.py
    python tools/preflight_protagonist_check.py --mark-blocked

输出：
    work/preflight/protagonist.json
"""
from __future__ import annotations

import argparse
import datetime
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C
import protagonist_profile as PP

DEFAULT_COVERAGE = {
    "min_scene_ratio": 0.40,
    "min_dialogue_ratio": 0.20,
    "borderline_scene_ratio": 0.55,
    "borderline_dialogue_ratio": 0.35,
    "borderline_coverage_score": 0.45,
}


def load_profile(root: Path):
    data = C.load_json_safe(root / "shot-profile.json", {}) or {}
    if not isinstance(data, dict):
        data = {}
    coverage = dict(DEFAULT_COVERAGE)
    coverage.update(data.get("coverage") or {})
    return {
        "enabled": bool(data.get("enabled", True)),
        "coverage": coverage,
    }


def load_protagonist(root: Path):
    path = root / "work" / "meta" / "protagonist.json"
    data = C.load_json_safe(path, {}) or {}
    if not isinstance(data, dict):
        data = {}
    source_dir = root / "work" / "source"
    newest_source = max((p.stat().st_mtime for p in source_dir.glob("ep*.md")),
                        default=0) if source_dir.is_dir() else 0
    if data.get("protagonist") and path.exists() and newest_source > path.stat().st_mtime:
        data = {}  # source changed after the profile was written; re-detect
    if not data.get("protagonist"):
        data = PP.collect(root)
        if data:
            PP.write_profile(root, data)
    return data


def episode_files(root: Path):
    source_dir = root / "work" / "source"
    if not source_dir.is_dir():
        return []
    return sorted(source_dir.glob("ep*.md"), key=lambda p: p.name)


def read_episodes(root: Path):
    out = []
    for path in episode_files(root):
        try:
            lines = [C.normalize_line(x) for x in C.read_text(path).splitlines()
                     if C.normalize_line(x)]
        except OSError:
            continue
        if not lines:
            continue
        n = C.episode_number(lines[0])
        if n is None:
            continue
        out.append((n, lines))
    return out


def scene_blocks(lines):
    starts = [i for i, line in enumerate(lines) if C.SCENE_HEADER_RE.match(line)]
    if not starts:
        return [{"scene": "1-1", "lines": lines}]
    out = []
    for k, start in enumerate(starts):
        end = starts[k + 1] if k + 1 < len(starts) else len(lines)
        scene = C.normalize_line(lines[start]).split(" ", 1)[0]
        out.append({"scene": scene, "lines": lines[start:end]})
    return out


def names_for(profile: dict):
    names = [profile.get("protagonist", "")]
    names.extend(profile.get("aliases") or [])
    return [x for x in names if x]


def analyze_episode(n: int, lines, profile: dict):
    names = names_for(profile)
    blocks = scene_blocks(lines)
    total_dialogue = 0
    protagonist_dialogue = 0
    total_action = 0
    protagonist_action = 0
    scene_map = []

    for block in blocks:
        blines = block["lines"]
        evidence = set()
        has_protagonist = False

        for line in blines:
            for name in C.cast_names(line):
                if C.has_name(name, names):
                    has_protagonist = True
                    evidence.add("人物")

        for line in blines:
            if not line.startswith("△"):
                continue
            total_action += 1
            if C.has_name(line, names):
                protagonist_action += 1
                has_protagonist = True
                evidence.add("△")

        for line in blines:
            if line.startswith("△") or C.is_structural_line(line):
                continue
            pair = C.split_speaker(line)
            if not pair:
                continue
            prefix = pair[0]
            tag = C.detect_tag(prefix)
            if not tag:
                continue
            total_dialogue += 1
            if C.has_name(C.speaker_name(prefix), names):
                protagonist_dialogue += 1
                has_protagonist = True
                evidence.add(tag)

        scene_map.append({
            "scene": block["scene"],
            "has_protagonist": has_protagonist,
            "evidence": sorted(evidence),
        })

    scenes = len(scene_map)
    protagonist_scenes = sum(1 for s in scene_map if s["has_protagonist"])
    scene_ratio = protagonist_scenes / scenes if scenes else 0.0
    dialogue_ratio = protagonist_dialogue / total_dialogue if total_dialogue else 0.0
    action_ratio = protagonist_action / total_action if total_action else 0.0

    if total_dialogue and total_action:
        coverage_score = 0.5 * scene_ratio + 0.3 * dialogue_ratio + 0.2 * action_ratio
    elif total_dialogue:
        coverage_score = 0.7 * scene_ratio + 0.3 * dialogue_ratio
    elif total_action:
        coverage_score = 0.7 * scene_ratio + 0.3 * action_ratio
    else:
        coverage_score = scene_ratio

    return {
        "ep": n,
        "scenes": scenes,
        "protagonist_scenes": protagonist_scenes,
        "scene_ratio": round(scene_ratio, 3),
        "dialogue_lines": total_dialogue,
        "protagonist_dialogue_lines": protagonist_dialogue,
        "dialogue_ratio": round(dialogue_ratio, 3),
        "action_lines": total_action,
        "protagonist_action_lines": protagonist_action,
        "action_ratio": round(action_ratio, 3),
        "coverage_score": round(coverage_score, 3),
        "scene_map": scene_map,
    }


def classify(rec: dict, coverage: dict):
    if rec["protagonist_scenes"] == 0 and rec["protagonist_dialogue_lines"] == 0:
        return "NO_PROTAGONIST", "主角未出场且无台词"

    reasons = []
    if rec["scene_ratio"] < coverage["min_scene_ratio"]:
        reasons.append(f"scene_ratio {rec['scene_ratio']:.3f} < {coverage['min_scene_ratio']}")
    if rec["dialogue_lines"] > 0 and rec["dialogue_ratio"] < coverage["min_dialogue_ratio"]:
        reasons.append(f"dialogue_ratio {rec['dialogue_ratio']:.3f} < {coverage['min_dialogue_ratio']}")
    if reasons:
        return "LOW_PROTAGONIST", "；".join(reasons)

    borderline = []
    if rec["scene_ratio"] < coverage["borderline_scene_ratio"]:
        borderline.append(f"scene_ratio {rec['scene_ratio']:.3f} < {coverage['borderline_scene_ratio']}")
    if rec["dialogue_lines"] > 0 and rec["dialogue_ratio"] < coverage["borderline_dialogue_ratio"]:
        borderline.append(
            f"dialogue_ratio {rec['dialogue_ratio']:.3f} < {coverage['borderline_dialogue_ratio']}")
    if rec["coverage_score"] < coverage["borderline_coverage_score"]:
        borderline.append(
            f"coverage_score {rec['coverage_score']:.3f} < {coverage['borderline_coverage_score']}")
    if borderline:
        return "BORDERLINE", "；".join(borderline)

    return "OK", ""


def load_progress(root: Path):
    data = C.load_json_safe(root / "work" / "meta" / "progress.json",
                            {"episodes": {}}) or {"episodes": {}}
    return data if isinstance(data, dict) else {"episodes": {}}


def mark_blocked(root: Path, data: dict):
    progress = load_progress(root)
    progress.setdefault("episodes", {})
    blocked_eps = []

    for rec in data["episodes"]:
        n = rec["ep"]
        key = str(n)
        pe = progress["episodes"].setdefault(
            key, {"status": "pending", "attempts": 0, "reasons": []})
        draft_path = root / "work" / "draft" / f"ep{n:02d}.md"
        has_draft = draft_path.exists() and draft_path.stat().st_size > 0
        entered = (has_draft
                   or pe.get("status") in ("passed", "passed-with-issues", "failed"))
        rec["entered"] = entered

        if rec["status"] in ("NO_PROTAGONIST", "LOW_PROTAGONIST"):
            if entered:
                rec["blocked"] = False
                if pe.get("status") == "blocked":
                    pe["status"] = "pending"
                    pe["reasons"] = []
            else:
                pe["status"] = "blocked"
                pe["reasons"] = [f"protagonist:{rec['status']}", rec["reason"]]
                rec["blocked"] = True
                blocked_eps.append(n)
        else:
            rec["blocked"] = False
            if pe.get("status") == "blocked":
                pe["status"] = "pending"
                pe["reasons"] = []

    data["blocked_eps"] = blocked_eps
    progress["updated"] = datetime.datetime.now().isoformat(timespec="seconds")
    C.save_json(root / "work" / "meta" / "progress.json", progress)
    return blocked_eps


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mark-blocked", action="store_true",
                    help="把 NO/LOW 集写入 progress.json 的 blocked 状态")
    args = ap.parse_args()
    root = C.ROOT

    profile = load_protagonist(root)
    if not profile.get("protagonist"):
        print("[FAIL] 无法识别主角：work/source 不存在或为空；请先运行 /前置检查")
        return 2

    config = load_profile(root)
    if not config["enabled"]:
        print("[SKIP] shot-profile.json enabled=false")
        return 0

    episodes = read_episodes(root)
    if not episodes:
        print("[FAIL] no work/source/ep*.md; run /前置检查 first")
        return 2

    records = []
    for n, lines in episodes:
        rec = analyze_episode(n, lines, profile)
        status, reason = classify(rec, config["coverage"])
        rec["status"] = status
        rec["reason"] = reason
        records.append(rec)

    data = {
        "protagonist": profile.get("protagonist", ""),
        "aliases": profile.get("aliases") or [],
        "profile_source": profile.get("source", "auto"),
        "coverage": config["coverage"],
        "episodes": records,
        "blocked_eps": [],
    }

    if args.mark_blocked:
        mark_blocked(root, data)
    else:
        data["blocked_eps"] = [r["ep"] for r in records
                               if r["status"] in ("NO_PROTAGONIST", "LOW_PROTAGONIST")]

    out = root / "work" / "preflight" / "protagonist.json"
    C.save_json(out, data)

    print(f"[OK] protagonist={data['protagonist']} aliases={data['aliases']}")
    for rec in records:
        tag = rec["status"]
        extra = " BLOCKED" if rec.get("blocked") else ""
        print(f"[{tag}]{extra} ep{rec['ep']:02d} "
              f"scenes={rec['scenes']} pscenes={rec['protagonist_scenes']} "
              f"scene={rec['scene_ratio']:.2f} dialogue={rec['dialogue_ratio']:.2f} "
              f"action={rec['action_ratio']:.2f} score={rec['coverage_score']:.2f}"
              + (f" | {rec['reason']}" if rec["reason"] else ""))
    print(f"[OK] -> {out}")
    if data["blocked_eps"]:
        print(f"[BLOCKED] {data['blocked_eps']} 不进入炼本")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
