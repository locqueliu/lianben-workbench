"""自动识别全剧唯一主角（单主角，不做双主角）。

数据源：work/source/epNN.md（/前置检查 生成的优化存档）。
输出：work/meta/protagonist.json。

用法：
    python tools/protagonist_profile.py
    python tools/protagonist_profile.py --force
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C


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


def collect(root: Path):
    """Return a single-protagonist profile or None when no source exists."""
    episodes = read_episodes(root)
    if not episodes:
        return None

    counts: dict[str, int] = {}
    per_episode: dict[int, set[str]] = {}
    first_votes: dict[str, int] = {}
    first_billed = ""

    for n, lines in episodes:
        per_episode.setdefault(n, set())
        first_cast_done = False
        for line in lines:
            names = C.cast_names(line)
            if names and not first_cast_done:
                first_votes[names[0]] = first_votes.get(names[0], 0) + 1
                first_cast_done = True
            for name in names:
                if not first_billed:
                    first_billed = name
                counts.setdefault(name, 0)
                per_episode[n].add(name)
            speaker = C.dialogue_speaker(line)
            if speaker:
                counts[speaker] = counts.get(speaker, 0) + 1
                per_episode[n].add(speaker)

    if not counts:
        return None

    top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    top_count = top[0][1]

    if top_count == 0 and first_billed:
        chosen = first_billed
    else:
        # 主角通常稳定出现在每集人物行首位；用“首位票数”压制话多的配角/旁白。
        def score(item):
            name, count = item
            coverage = sum(1 for names in per_episode.values() if name in names)
            opening_bonus = 4 if name == first_billed else 0
            return count + 8 * first_votes.get(name, 0) + 0.5 * coverage + opening_bonus

        chosen = max(counts.items(), key=lambda kv: (score(kv), kv[1], kv[0]))[0]
        if chosen not in counts and first_billed:
            chosen = first_billed

    aliases = set()
    for _, lines in episodes:
        for i, line in enumerate(lines):
            if C.dialogue_speaker(line) != chosen:
                continue
            for j in (i - 1, i + 1):
                if not (0 <= j < len(lines)):
                    continue
                other = C.dialogue_speaker(lines[j])
                if not other or other == chosen:
                    continue
                pair_langs = {C.spoken_lang(line), C.spoken_lang(lines[j])}
                if pair_langs == {"cn", "en"}:
                    aliases.add(other)

    return {
        "protagonist": chosen,
        "aliases": sorted(aliases),
        "source": "auto",
        "confidence": round(counts.get(chosen, 0) / max(1, top_count), 2),
        "evidence": {
            "dialogue_lines": counts.get(chosen, 0),
            "episodes": sum(1 for names in per_episode.values() if chosen in names),
            "first_billed": first_billed,
            "first_votes": first_votes.get(chosen, 0),
            "top_speakers": top[:5],
        },
    }


def write_profile(root: Path, data: dict):
    path = root / "work" / "meta" / "protagonist.json"
    C.save_json(path, data)
    return path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true",
                    help="覆盖已存在的 work/meta/protagonist.json")
    args = ap.parse_args()
    root = C.ROOT

    existing_path = root / "work" / "meta" / "protagonist.json"
    source_dir = root / "work" / "source"
    newest_source = max((p.stat().st_mtime for p in source_dir.glob("ep*.md")),
                        default=0) if source_dir.is_dir() else 0
    if existing_path.exists() and not args.force:
        existing = C.load_json_safe(existing_path, {}) or {}
        if isinstance(existing, dict) and existing.get("protagonist") \
                and existing_path.stat().st_mtime >= newest_source:
            print(f"[OK] protagonist={existing['protagonist']} (existing) -> {existing_path}")
            return 0

    data = collect(root)
    if not data:
        print("[FAIL] no work/source/ep*.md; run /前置检查 first")
        return 2

    write_profile(root, data)
    print(f"[OK] protagonist={data['protagonist']} confidence={data['confidence']} "
          f"episodes={data['evidence']['episodes']} -> {existing_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
