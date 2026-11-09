#!/usr/bin/env python3
"""Deterministic builder for engine/refine_fixtures.

Source fixture: workspace `work/m2/acceptance/latest` (20-episode weak-QC
preflight project).  Output:
  engine/refine_fixtures/project/              # trimmed 1-episode project
  engine/refine_fixtures/mock-director-output.txt

The mock director output uses the sentinel section format consumed by
tests/refine_tools_smoke.py:
  ===== DRAFT EP01 =====
  ===== REPORT EP01 JSON =====
  ===== PRODUCTION NOTES EP01 =====

This script is a dev/reproducibility helper; the generated fixture is what the
smoke test actually consumes.  It never calls an LLM.

Usage:
    <bundled-python> engine/refine_fixtures/build_fixture.py [--source <proj>]
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

FIXTURE_DIR = Path(__file__).resolve().parent
ENGINE_DIR = FIXTURE_DIR.parent
WS = ENGINE_DIR.parents[2]
DEFAULT_SOURCE = WS / "work" / "m2" / "acceptance" / "latest"
TARGET = FIXTURE_DIR / "project"
MOCK_TXT = FIXTURE_DIR / "mock-director-output.txt"

SCENES_TEXT = {
    "1-1": ("【SPECTACLE】浓雾压着码头，货轮探照灯把水面切成一片抖动的冷蓝，镜头低角度缓慢横移，"
            "湿亮的缆桩与铁链在画面右缘一层层退进雾里。",
            "【景别·中景·摄影机缓慢横移·建立空间】",
            "【人物站位】林砚位于画面左前，苏晚位于右后，背景是码头入口与集装箱吊臂。"),
    "1-2": ("【景别·近景·镜头轻推·聚焦线索】",),
    "1-3": ("【景别·中景·手持跟拍·逼近冲突】",),
}
EXPANSIONS = {
    "1-1": [
        "△ 雾粒贴着镜头缓慢飘过，远处吊臂的轮廓在灰白里只余一道细线，码头木板被潮气浸得发暗。",
        "△ 缆桩上的铁链随浪轻轻碰响，声音被雾气吞掉一半，只留下低而闷的余音。",
    ],
    "1-2": [
        "△ 值班室的灯管闪了一下，冷白的光在桌面文件边缘拉出细窄的亮线，尘埃在光柱里悬着不动。",
        "△ 监控屏幕的蓝光映在林砚下颌，他指节在桌沿轻轻一扣，停住。",
    ],
    "1-3": [
        "△ 实验台的不锈钢面反着冷光，证物袋被灯照得半透明，水痕在塑封边缘缓慢下移。",
        "△ 走廊尽头的门缝透进一线灰光，脚步声从远处压过来，又在门口停住。",
    ],
}
SCENE_HEADER_RE_LINE = ("1-1", "1-2", "1-3")


def _read_docx_lines(path: Path) -> list[str]:
    from docx import Document

    doc = Document(str(path))
    return [p.text or "" for p in doc.paragraphs]


def _write_single_ep_docx(src_docx: Path, out_docx: Path, ep: int = 1) -> int:
    from docx import Document

    lines = _read_docx_lines(src_docx)
    start = next((i for i, x in enumerate(lines) if x.strip().startswith(f"第{ep}集")), None)
    if start is None:
        raise SystemExit(f"episode {ep} header not found in {src_docx}")
    end = None
    for i in range(start + 1, len(lines)):
        if lines[i].strip().startswith(f"第{ep + 1}集"):
            end = i
            break
    if end is None:
        end = len(lines)
    kept = lines[:end]
    doc = Document()
    for line in kept:
        doc.add_paragraph(line)
    out_docx.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out_docx))
    return len(kept)


def _dialogue_shots(draft_lines: list[str]) -> list[dict]:
    shots = []
    scene = "1-1"
    for line in draft_lines:
        s = line.strip()
        if not s:
            continue
        if s[:1].isdigit() and "-" in s.split(" ")[0]:
            head = s.split(" ", 1)[0]
            if head in SCENE_HEADER_RE_LINE:
                scene = head
                continue
        if s.startswith("【") and not s.startswith(("【人物站位", "【音效", "【制作", "【全局")):
            no = len(shots) + 1
            if no == 1:
                rel, anchor, subject = "P", "face", "protagonist"
            elif no % 3 == 0:
                rel, anchor, subject = "P", "action", "protagonist"
            else:
                rel, anchor, subject = "R", "observe", "support"
            shots.append({"no": no, "scene": scene, "subject_type": subject,
                          "relation": rel, "anchor": anchor})
    return shots


def _build_draft(lines: list[str]) -> list[str]:
    out: list[str] = []
    scene_no = 0
    for raw in lines:
        s = raw.strip()
        if not s:
            continue
        out.append(s)
        if s.startswith(f"第1集"):
            continue
        parts = s.split(" ")
        head = parts[0] if parts else ""
        if head in SCENE_HEADER_RE_LINE:
            scene_no += 1
            scene = head
            texts = SCENES_TEXT.get(scene, ())
            for t in texts:
                if t.startswith("【"):
                    out.append(t)
                    if t.startswith("【景别"):
                        out.append("【人物站位】林砚左前，苏晚右后，背景是码头入口。")
            for extra in EXPANSIONS.get(scene, []):
                out.append(extra)
            continue
        if s.startswith("人物："):
            out.append("【景别·近景·镜头轻推·交代人物】")
            out.append("【人物站位】林砚位于画面左前，苏晚位于画面右后，背景留出码头纵深。")
    return out


def _build_mock(lines: list[str]) -> str:
    draft = _build_draft(lines)
    shots = _dialogue_shots(draft)
    report = {
        "schema": "lianben/report/1",
        "ep": 1,
        "shot_plan": {
            "shots": shots,
            "stats": {
                "shot_total": len(shots),
                "shot_related_ratio": 1.0,
                "shot_protagonist_ratio": round(sum(1 for s in shots if s["relation"] == "P") / max(1, len(shots)), 3),
            },
        },
    }
    notes = (
        "# EP01 制作说明（mock）\n\n"
        "本文件为无 LLM 联调用的确定性 mock director 输出，仅用于验证写盘→check_ep→"
        "merge→writeback→报告链；不追求内容质量。\n\n"
        "- 已保留 SOURCE 全部锁行与中英台词；\n"
        "- 已补全套镜头块哨兵 `【景别…】`+`【人物站位…】` 与 `SPECTACLE` 标记；\n"
        "- 追加内容仅用于满足字数与原子覆盖，不含新增文化元素。\n"
    )
    return (
        "===== DRAFT EP01 =====\n"
        + "\n".join(draft) + "\n\n"
        + "===== REPORT EP01 JSON =====\n"
        + json.dumps(report, ensure_ascii=False, indent=1) + "\n\n"
        + "===== PRODUCTION NOTES EP01 =====\n"
        + notes
    )


def _trim_json(path: Path, ep: int = 1) -> None:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if isinstance(data.get("episodes"), list):
        data["episodes"] = [e for e in data["episodes"] if int(e.get("ep", -1)) == ep]
    if isinstance(data.get("blocked_eps"), list):
        data["blocked_eps"] = [n for n in data["blocked_eps"] if int(n) == ep]
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n",
                    encoding="utf-8", newline="\n")


def build(source: Path) -> dict:
    if not (source / "work" / "meta" / "ep_index.json").exists():
        raise SystemExit(f"source project not found or incomplete: {source}")
    if TARGET.exists():
        shutil.rmtree(TARGET)
    TARGET.mkdir(parents=True)
    # copy project skeleton
    for name in ("project.json", "work", "剧本输入"):
        src = source / name
        if not src.exists():
            continue
        if src.is_dir():
            shutil.copytree(src, TARGET / name)
        else:
            shutil.copy2(src, TARGET / name)
    for rel in ("work/archive", "work/logs", "work/draft", "work/bgm", "work/report"):
        shutil.rmtree(TARGET / rel, ignore_errors=True)
    for rel in ("work/draft", "work/bgm", "work/report"):
        (TARGET / rel).mkdir(parents=True, exist_ok=True)
    # source: only ep01
    for f in (TARGET / "work" / "source").glob("ep*.md"):
        if f.name != "ep01.md":
            f.unlink()
    # docx: build single-episode docx from the original source docx
    src_docx = next((TARGET / "剧本输入").glob("*.docx"))
    new_docx = TARGET / "剧本输入" / "sample-1ep.docx"
    para_count = _write_single_ep_docx(src_docx, new_docx)
    if src_docx.name != new_docx.name:
        src_docx.unlink()
    # trim metadata JSON
    for rel in ("work/meta/ep_index.json", "work/preflight/report.json",
                "work/preflight/protagonist.json", "work/preflight/index.json"):
        p = TARGET / rel
        if p.exists():
            _trim_json(p)
    # ep_index docx path / paragraph count
    epi_path = TARGET / "work/meta/ep_index.json"
    epi = json.loads(epi_path.read_text(encoding="utf-8-sig"))
    epi["docx"] = "剧本输入/sample-1ep.docx"
    epi["total_paragraphs"] = para_count
    epi_path.write_text(json.dumps(epi, ensure_ascii=False, indent=1) + "\n",
                        encoding="utf-8", newline="\n")
    # trim paragraphs / handoff to the single episode so the fixture stays small
    report_path = TARGET / "work/preflight/report.json"
    report = json.loads(report_path.read_text(encoding="utf-8-sig")) if report_path.exists() else {}
    end_para = 0
    for e in (report.get("episodes") or []):
        if int(e.get("ep", -1)) == 1:
            end_para = int(e.get("end_paragraph_exclusive", 0))
    paras_txt = TARGET / "work/meta/paragraphs.txt"
    if paras_txt.exists() and end_para > 0:
        all_lines = paras_txt.read_text(encoding="utf-8-sig").splitlines()[:end_para]
        paras_txt.write_text("\n".join(all_lines) + "\n", encoding="utf-8", newline="\n")
    paras_jsonl = TARGET / "work/meta/paragraphs.jsonl"
    if paras_jsonl.exists() and end_para > 0:
        jlines = paras_jsonl.read_text(encoding="utf-8-sig").splitlines()[:end_para]
        paras_jsonl.write_text("\n".join(jlines) + "\n", encoding="utf-8", newline="\n")
    (TARGET / "work/meta/handoff.json").write_text(
        json.dumps({"1": {"prev_tail": [], "next_head": []}}, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8", newline="\n")
    # progress: only ep01 pending
    progress = {
        "schema": "lianben/progress/1",
        "episodes": {"1": {"status": "pending", "attempts": 0, "reasons": [],
                           "title": epi["episodes"][0]["title"]}},
        "updated": "fixture",
    }
    (TARGET / "work/meta/progress.json").write_text(
        json.dumps(progress, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8", newline="\n")
    # project.json: retitle to a 1-episode fixture
    proj_path = TARGET / "project.json"
    proj = json.loads(proj_path.read_text(encoding="utf-8-sig"))
    docx_sha = __import__("hashlib").sha256(new_docx.read_bytes()).hexdigest()
    proj["title"] = "refine-fixture-1ep"
    proj["id"] = "refine-fixture"
    proj["slug"] = "refine-fixture"
    proj["episodes"] = {"count": 1, "first": 1, "last": 1,
                        "index": "work/meta/ep_index.json"}
    proj["blocked_eps"] = []
    proj["source"] = {"file": "剧本输入/sample-1ep.docx", "name": "sample-1ep.docx",
                      "sha256": docx_sha, "bytes": new_docx.stat().st_size}
    if isinstance(proj.get("input"), dict):
        proj["input"]["files"] = [{"name": "sample-1ep.docx",
                                   "rel_path": "剧本输入/sample-1ep.docx",
                                   "sha256": docx_sha,
                                   "bytes": new_docx.stat().st_size}]
        proj["input"]["source_sha256"] = docx_sha
        proj["input"]["docx"] = "剧本输入/sample-1ep.docx"
    proj["source_sha256"] = docx_sha
    proj_path.write_text(json.dumps(proj, ensure_ascii=False, indent=1) + "\n",
                         encoding="utf-8", newline="\n")
    # shot-profile.json so legacy tools get deterministic shot config
    defaults = ENGINE_DIR / "defaults" / "shot-profile.json"
    if defaults.exists():
        shutil.copy2(defaults, TARGET / "shot-profile.json")
    # mock director output from ep01 archive
    src_lines = (TARGET / "work/source/ep01.md").read_text(encoding="utf-8").splitlines()
    MOCK_TXT.write_text(_build_mock(src_lines), encoding="utf-8", newline="\n")
    return {"target": str(TARGET), "mock": str(MOCK_TXT), "paragraphs": para_count}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=str(DEFAULT_SOURCE))
    args = ap.parse_args(argv)
    info = build(Path(args.source))
    print(json.dumps({"ok": True, **info}, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
