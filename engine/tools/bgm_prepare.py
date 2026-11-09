#!/usr/bin/env python3
"""配乐流程预处理器（0 token）：读取 work/source 分集存档，生成配乐索引、总纲摘要与进度文件。

产出：work/meta/bgm_index.json、work/meta/bgm_digest.md、work/meta/bgm_progress.json、work/meta/bgm_manifest.json
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bgm_common as C

RE_EP_TITLE = re.compile(r"^#?\s*第\s*(\d+)\s*集")
RE_SCENE = re.compile(r"^\s*(?:\*\*)?(\d{1,3})\s*[-－]\s*(\d{1,3})\s*[：:]?\s*(.*?)(?:\*\*)?\s*$")
RE_SPEAK = re.compile(r"^\s*(?:\*\*)?([^：:\n]{1,24})[：:]\s*\S")
RE_CAST = re.compile(r"^(?:Characters|出场人物|人物)\s*[：:]\s*(.+)$", re.IGNORECASE)
SPEAK_STOP = ("场景", "地点", "时间", "内景", "外景", "备注", "镜头", "画面", "字幕",
              "音效", "音乐", "配乐", "集", "场", "第", "标题", "简介", "梗概", "旁白",
              "Characters", "Episode", "Scene", "INT", "EXT", "NIGHT", "DAY",
              "人物", "出场人物", "Tags", "标签", "Cast", "VO", "OS")


def extract_scenes(ep: int, lines: list[str]):
    cands = []
    for ln in lines:
        m = RE_SCENE.match(ln)
        if not m:
            continue
        cands.append((int(m.group(1)), int(m.group(2)), (m.group(3) or "").strip(" 　:：")))
    matched = [c for c in cands if c[0] == ep]
    use = matched if matched else cands
    ids, names = [], []
    for g1, g2, name in use:
        sid = f"{g1}-{g2}"
        if sid in ids:
            continue
        ids.append(sid)
        names.append(name)
    return ids, names


def extract_characters(lines: list[str]) -> list[str]:
    counter: Counter[str] = Counter()
    for ln in lines:
        s = ln.strip()
        m = RE_CAST.match(s)
        if m:
            for nm in re.split(r"[、,，;；/]", m.group(1)):
                nm = nm.strip(" 　")
                if nm:
                    counter[nm] += 3
            continue
        m = RE_SPEAK.match(s)
        if not m:
            continue
        name = re.sub(r"[（(].*?[）)]", " ", m.group(1))
        name = re.sub(r"[（(].*$", "", name).strip()
        if not re.fullmatch(r"[\u4e00-\u9fff·A-Za-z0-9 ]{1,12}", name):
            continue
        if any(x in name for x in SPEAK_STOP):
            continue
        if name.endswith(("音", "声", "响")):
            continue
        counter[name.strip()] += 1
    return [n for n, _ in counter.most_common(12)]


def find_source_stem() -> str:
    meta = C.load_json(C.META_DIR / "ep_index.json", {}) or {}
    docx = meta.get("docx") or ""
    if docx:
        return C.safe_stem(docx)
    return "剧本"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not C.SRC_DIR.exists():
        print("[FAIL] work/source 不存在，请先运行 /前置检查")
        return 2
    eps_files = sorted((p for p in C.SRC_DIR.glob("ep*.md")), key=lambda p: p.name)
    if not eps_files:
        print("[FAIL] work/source 中没有 epNN.md，请先运行 /前置检查")
        return 2

    for d in (C.DRAFT_DIR, C.REPORT_DIR, C.META_DIR, C.LOGS_DIR, C.OUTPUT_DIR):
        d.mkdir(parents=True, exist_ok=True)

    stem = find_source_stem()
    index = []
    digest_lines = [
        "# 全剧分集摘要（供配乐总纲代理）",
        "",
        f"- 剧本：{stem}",
        f"- 集数：{len(eps_files)}",
        "",
    ]
    shas: list[str] = []
    for p in eps_files:
        text = C.read_text(p)
        lines = [C.norm_line(x) for x in text.splitlines() if C.norm_line(x)]
        if not lines:
            print(f"[FAIL] {p.name} 为空")
            return 2
        m = RE_EP_TITLE.match(lines[0])
        if not m:
            print(f"[FAIL] {p.name} 首行不是集标题：{lines[0][:40]}")
            return 2
        ep = int(m.group(1))
        title_line = lines[0]
        body = lines[1:]
        scenes, scene_names = extract_scenes(ep, body)
        chars = extract_characters(body)
        head = body[0][:130] if body else ""
        tail = body[-1][:130] if body else ""
        ep_sha = C.sha256_bytes(text.encode("utf-8"))
        shas.append(ep_sha)
        index.append({
            "ep": ep,
            "title": title_line,
            "scenes": scenes,
            "scene_names": scene_names,
            "characters": chars,
            "chars": len(text),
            "sha256": ep_sha,
        })
        digest_lines += [
            f"## {title_line}",
            f"- 场次：{'、'.join(scenes) if scenes else '（未识别，按单场处理）'}",
            f"- 人物：{'、'.join(chars) if chars else '（未识别）'}",
            f"- 开头：{head}",
            f"- 结尾：{tail}",
            "",
        ]

    ep_nums = [e["ep"] for e in index]
    if ep_nums != sorted(ep_nums):
        print(f"[FAIL] 集号顺序异常：{ep_nums}")
        return 2

    C.save_json(C.META_DIR / "bgm_index.json", {
        "stem": stem,
        "source_dir": str(C.SRC_DIR),
        "generated": C.now_iso(),
        "episode_count": len(index),
        "episodes": index,
    })
    C.write_text(C.META_DIR / "bgm_digest.md", "\n".join(digest_lines))

    fingerprint = C.sha256_bytes("".join(shas).encode("ascii"))
    progress_path = C.META_DIR / "bgm_progress.json"
    progress = C.load_json(progress_path, None)
    reset_note = ""
    if not progress or progress.get("fingerprint") != fingerprint:
        progress = {
            "fingerprint": fingerprint,
            "updated": C.now_iso(),
            "episodes": {str(e["ep"]): {"status": "pending", "attempts": 0, "reasons": []}
                         for e in index},
        }
        C.save_json(progress_path, progress)
        reset_note = "（源存档变化，已重置进度）"
    else:
        known = set(progress.get("episodes", {}))
        current = {str(e["ep"]) for e in index}
        for old in known - current:
            progress["episodes"].pop(old, None)
        for e in index:
            progress["episodes"].setdefault(str(e["ep"]),
                                            {"status": "pending", "attempts": 0, "reasons": []})
        C.save_json(progress_path, progress)

    C.save_json(C.META_DIR / "bgm_manifest.json", {
        "stem": stem,
        "fingerprint": fingerprint,
        "episode_count": len(index),
        "generated": C.now_iso(),
    })

    if not args.quiet:
        no_scene = [e["ep"] for e in index if not e["scenes"]]
        print(f"[OK] 配乐素材就绪：{len(index)} 集（{stem}）{reset_note}")
        print("[OK] work/meta/{bgm_index.json,bgm_digest.md,bgm_progress.json,bgm_manifest.json}")
        if no_scene:
            print(f"[WARN] 未识别场次行的集：{no_scene}（配乐按叙事段落拆条）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
