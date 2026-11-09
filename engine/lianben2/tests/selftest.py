"""M1 engine selftest: build a 2-episode docx, run the CLI, assert contract + artifacts.

Run with the bundled python:
    <python> -m lianben2.tests.selftest [--keep] [--json]

It prints one JSON line and exits 0 on success / 1 on failure.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent.parent.parent
PKG_PARENT = ENGINE_DIR
# Keep test projects inside the package dir: the DSH sandbox allows workspace
# writes but may deny arbitrary %TEMP% writes for spawned python.
TMP_ROOT = PKG_PARENT / "lianben2" / ".selftest-tmp"
DOCX_ENV = {
    "PYTHONUTF8": "1",
    "PYTHONIOENCODING": "utf-8",
}

EN_WORDS = (
    "the fog is wrong tonight and the dock is empty",
    "we should check the bollard before the tide comes in",
    "there is a mark on the rope that was not there yesterday",
    "keep your voice down or the whole harbor will hear us",
    "the camera by the gate has been offline for two hours",
    "somebody knows exactly what happened on this pier last night",
    "do not touch anything until the forensic team arrives here",
    "the report will be ready before the morning shift begins",
    "i saw a man in a grey coat walking toward the old warehouse",
    "he dropped something near the water and then he disappeared",
    "we need to find that object before the police seal the area",
)


def _make_docx(path: Path) -> None:
    from docx import Document

    doc = Document()
    lines: list[str] = [
        "《雾港》",
        "人物小传",
        "林砚：男，刑警，三十岁。",
        "苏晚：女，法医，二十八岁。",
        "术语：缆桩 = 码头系船柱。",
        "",
        "第1集《雾港》",
        'Episode 1: "Mist Harbor"',
        "1-1 夜 外 港区码头",
        "人物：林砚 苏晚",
        "△ 浓雾压着码头，远处货轮的灯光在水面碎成一片抖动。",
        "林砚（对白）：这雾不对。",
        "LIN YAN (DIALOGUE): This fog is wrong.",
        "苏晚（对白）：看缆桩。",
        "SU WAN (DIALOGUE): Look at the bollard.",
        "苏晚（VO）：海风里有一股铁锈味。",
        "SU WAN (VO): There is a smell of rust in the sea breeze.",
        "△ 林砚蹲下，指尖抹过缆桩上一道暗红痕迹。",
        "林砚（OS）：不是锈。",
        "LIN YAN (OS): Not rust.",
        "1-2 夜 内 港区值班室",
        "人物：林砚",
        "△ 老式挂钟的分针指向三点，监控屏幕泛着冷蓝。",
        "林砚（对白）：调昨晚三点的监控。",
        "LIN YAN (DIALOGUE): Pull up the footage from three last night.",
    ]
    # pad English spoken words to land inside 100-350 for episode 1
    for idx, words in enumerate(EN_WORDS):
        lines.append("林砚（对白）：我们把这条线索记下来。")
        lines.append(f"LIN YAN (DIALOGUE): {words}.")
    lines += [
        "",
        "第2集《暗流》",
        'Episode 2: "Undercurrent"',
        "2-1 日 内 法医实验室",
        "人物：苏晚 林砚",
        "△ 冷白灯下，解剖台上的证物袋排成一线。",
        "苏晚（对白）：缆桩上的痕迹是血。",
        "SU WAN (DIALOGUE): The mark on the bollard is blood.",
        "林砚（对白）：谁的血。",
        "LIN YAN (DIALOGUE): Whose blood?",
        "苏晚（VO）：报告要三小时。",
        "SU WAN (VO): The report needs three hours.",
        "△ 林砚翻开记录本，纸上有一道被水泡开的墨迹。",
        "林砚（对白）：把昨晚的值班表找出来。",
        "LIN YAN (DIALOGUE): Find the duty roster from last night.",
        "苏晚（对白）：值班表在储藏室。",
        "SU WAN (DIALOGUE): The roster is in the storage room.",
        "2-2 日 内 储藏室",
        "人物：林砚 苏晚",
        "△ 铁架上的档案盒积着薄灰，最上层缺了一盒。",
        "林砚（对白）：有人先来过。",
        "LIN YAN (DIALOGUE): Someone was here before us.",
    ]
    for idx, words in enumerate(EN_WORDS[:8]):
        lines.append("苏晚（对白）：这一页被人撕掉了。")
        lines.append(f"SU WAN (DIALOGUE): {words}.")
    for line in lines:
        doc.add_paragraph(line)
    doc.save(str(path))


def _run_cli(argv: list[str]) -> tuple[int, str, str, float]:
    env = dict(os.environ)
    env.update(DOCX_ENV)
    env["PYTHONPATH"] = str(PKG_PARENT) + os.pathsep + env.get("PYTHONPATH", "")
    started = time.time()
    proc = subprocess.run(
        [sys.executable, "-m", "lianben2", *argv],
        cwd=str(ENGINE_DIR),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )
    return proc.returncode, proc.stdout, proc.stderr, (time.time() - started) * 1000


def _one_json_line(stdout: str) -> dict:
    lines = [ln for ln in stdout.splitlines() if ln.strip()]
    if len(lines) != 1:
        raise AssertionError(f"stdout 必须恰好一行 JSON，实际 {len(lines)} 行")
    return json.loads(lines[0])


def _make_tmp() -> Path:
    TMP_ROOT.mkdir(parents=True, exist_ok=True)
    # NOTE: do not use tempfile.mkdtemp here — under the DSH sandbox such dirs
    # can end up non-writable for the spawned python. Plain mkdir works.
    run_dir = TMP_ROOT / ("run-" + uuid.uuid4().hex[:10])
    run_dir.mkdir(parents=False, exist_ok=False)
    return run_dir


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="keep temp project for inspection")
    ap.add_argument("--json", action="store_true", help="print JSON only (default)")
    args = ap.parse_args(argv)

    results: list[dict] = []
    phases: list[str] = []
    ep_events: list[dict] = []
    events: list[dict] = []
    payload4: dict = {}
    payload5: dict = {}
    eff: dict = {}

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append({"name": name, "ok": bool(ok), "detail": detail})
        if not ok:
            print(f"[FAIL] {name}: {detail}", file=sys.stderr)

    tmp = _make_tmp()
    project = tmp / "wugang"
    docx = tmp / "雾港.docx"
    started = time.time()
    try:
        _make_docx(docx)

        code, out, err, ms = _run_cli(["version"])
        try:
            payload = _one_json_line(out)
            check("version.exit", code == 0, f"exit={code}")
            check("version.schema", payload.get("schema") == "lianben2/engine/1", str(payload))
            check("version.version", payload.get("version") == "1.0.0", str(payload))
            check("version.ok", payload.get("ok") is True, str(payload))
        except Exception as exc:
            check("version.stdout", False, f"{exc}; stdout={out!r}; stderr={err[-800:]!r}")

        code, out, err, ms = _run_cli(["preflight", "--root", str(project), "--source", str(docx)])
        payload = {}
        try:
            payload = _one_json_line(out)
        except Exception as exc:
            check("preflight.stdout", False, f"{exc}; stdout={out[:500]!r}; stderr={err[-1500:]!r}")
        check("preflight.exit", code == 0, f"exit={code}; stderr={err[-800:]!r}")
        check("preflight.ok", payload.get("ok") is True, str(payload)[:300])
        check("preflight.schema", payload.get("schema") == "lianben2/engine/1", str(payload.get("schema")))
        check("preflight.version", payload.get("version") == "1.0.0", str(payload.get("version")))
        project_meta = payload.get("project") or {}
        check("project.episodes", project_meta.get("episodes") == 2, str(project_meta))
        detection = payload.get("detection") or {}
        check("detection.mode", detection.get("mode") == "A", str(detection))
        check("detection.confidence", float(detection.get("confidence") or 0) >= 0.65, str(detection))
        checks = payload.get("checks") or {}
        for cid in ("spoken_words", "punctuation", "pacing", "protagonist", "culture"):
            check(f"checks.{cid}", isinstance(checks.get(cid), dict), str(checks)[:200])
        episodes = payload.get("episodes") or []
        check("stdout.episode_rows", len(episodes) == 2, str(len(episodes)))
        if episodes:
            ep = episodes[0]
            for key in ("ep", "title", "status", "cjk", "scenes", "dialogue_lines",
                        "atom_lines", "blocked", "checks"):
                check(f"episode.field.{key}", key in ep, str(ep)[:300])
            for cid in ("spoken_words", "punctuation", "pacing", "protagonist", "culture"):
                check(f"episode.checks.{cid}", cid in (ep.get("checks") or {}), str(ep)[:300])
        report = payload.get("report") or {}
        for key in ("md", "docx"):
            rel = report.get(key) or ""
            check(f"report.{key}", bool(rel) and (project / rel).exists(), f"{rel!r}")
        files = payload.get("files") or {}
        for key, rel in (("source", "work/source"),
                         ("preflightIndex", "work/preflight/index.json"),
                         ("preflightReport", "work/preflight/report.json")):
            check(f"files.{key}", (project / rel).exists(), rel)
        check("ai_used", payload.get("ai_used") is False, str(payload.get("ai_used")))

        required = [
            "work/meta/paragraphs.txt", "work/meta/paragraphs.jsonl", "work/meta/ep_index.json",
            "work/meta/format.json", "work/meta/format_rules.md", "work/meta/facts_lock.md",
            "work/meta/handoff.json", "work/meta/progress.json", "work/meta/protagonist.json",
            "work/source/ep01.md", "work/source/ep02.md",
            "work/preflight/index.json", "work/preflight/report.json", "work/preflight/report.md",
            "work/preflight/checks/spoken_words.json", "work/preflight/checks/punctuation.json",
            "work/preflight/checks/pacing.json", "work/preflight/checks/protagonist.json",
            "work/preflight/checks/culture.json", "work/preflight/spoken_words.json",
            "work/preflight/punctuation.json", "work/preflight/atom_pacing.json",
            "work/preflight/dialogue_density.json", "work/preflight/culture.json",
            "work/preflight/protagonist.json", "project.json",
            "report/雾港_前置质检报告.md", "report/雾港_前置质检报告.docx",
        ]
        for rel in required:
            check(f"file.{rel}", (project / rel).exists(), rel)

        # paragraph/line contract smoke checks
        paragraphs_txt = (project / "work/meta/paragraphs.txt").read_text(encoding="utf-8")
        check("paragraphs.txt.nonempty", bool(paragraphs_txt.strip()), "")
        ep1 = (project / "work/source/ep01.md").read_text(encoding="utf-8")
        check("ep01.starts_with_title", ep1.splitlines()[0].startswith("第1集"), ep1.splitlines()[0] if ep1 else "")
        idx = json.loads((project / "work/preflight/index.json").read_text(encoding="utf-8"))
        check("index.schema", idx.get("schema") == "lianben/preflight_index/1", str(idx.get("schema")))

        # idempotent rerun (with --force archives previous work and still succeeds)
        code2, out2, err2, _ms2 = _run_cli(
            ["preflight", "--root", str(project), "--force"]
        )
        payload2 = {}
        try:
            payload2 = _one_json_line(out2)
        except Exception as exc:
            check("rerun.stdout", False, f"{exc}; stdout={out2[:400]!r}")
        check("rerun.exit", code2 == 0, f"exit={code2}; stderr={err2[-800:]!r}")
        check("rerun.episodes", (payload2.get("project") or {}).get("episodes") == 2, str(payload2)[:300])
        check("rerun.no_source_arg", (project / "剧本输入/雾港.docx").exists(), "")

        # ---- M2: --events JSONL on stderr, stdout stays one line ----
        events_project = tmp / "wugang_events"
        code3, out3, err3, _ms3 = _run_cli(
            ["preflight", "--root", str(events_project), "--source", str(docx), "--events"])
        payload3 = {}
        try:
            payload3 = _one_json_line(out3)
        except Exception as exc:
            check("events.stdout", False, f"{exc}; stdout={out3[:400]!r}")
        check("events.exit", code3 == 0, f"exit={code3}; stderr={err3[-800:]!r}")
        check("events.ok", payload3.get("ok") is True, str(payload3)[:300])
        check("events.stdout_single_line", len([x for x in out3.splitlines() if x.strip()]) == 1,
              repr(out3[-200:]))
        events: list[dict] = []
        bad_event_lines = []
        for line in err3.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                events.append(json.loads(line))
            except Exception:
                bad_event_lines.append(line[:120])
        check("events.jsonl_parse", not bad_event_lines and len(events) > 0,
              f"n={len(events)} bad={bad_event_lines[:2]}")
        phases = [e.get("phase") for e in events if e.get("event") == "phase"]
        check("events.phase_sequence",
              phases == ["extract", "detect", "split", "normalize",
                         "protagonist", "checks", "report"], str(phases))
        check("events.phase_index",
              [(e.get("index"), e.get("total")) for e in events if e.get("event") == "phase"]
              == [(i, 7) for i in range(7)], "")
        ep_events = [e for e in events if e.get("event") == "episode"]
        check("events.episode_count", len(ep_events) == 2, str(len(ep_events)))
        check("events.episode_done",
              [e.get("done") for e in ep_events] == [1, 2]
              and all(e.get("total") == 2 for e in ep_events), str(ep_events))
        check("events.episode_ids", sorted(e.get("ep") for e in ep_events) == [1, 2],
              str(ep_events))
        check("events.log_present", any(e.get("event") == "log" for e in events), "")
        check("events.event_field",
              all(isinstance(e, dict) and "event" in e for e in events), "")
        check("events.off_no_jsonl",
              not any(ln.strip().startswith('{"event"') for ln in err2.splitlines()), "")
        check("events.effective_profile", payload3.get("checkProfileSource") == "default",
              str(payload3.get("checkProfileSource")))

        # ---- M2: project-level check-profile.json overrides ----
        cp_project = tmp / "wugang_cp"
        cp_project.mkdir(parents=True, exist_ok=True)
        (cp_project / "check-profile.json").write_text(json.dumps({
            "schema": "lianben/check-profile/1",
            "spoken_words": {"min": 300, "max": 400},
            "pacing": {"dup_similarity": 0.0, "max_dup_pairs": 0},
            "culture": {"forbid_cn_elements": False, "allowed_terms": ["筷子"]},
        }, ensure_ascii=False), encoding="utf-8")
        code4, out4, err4, _ms4 = _run_cli(
            ["preflight", "--root", str(cp_project), "--source", str(docx)])
        payload4 = {}
        try:
            payload4 = _one_json_line(out4)
        except Exception as exc:
            check("cp.stdout", False, f"{exc}; stdout={out4[:400]!r}")
        check("cp.exit", code4 == 0, f"exit={code4}; stderr={err4[-800:]!r}")
        eff = payload4.get("effectiveCheckProfile") or {}
        check("cp.source", payload4.get("checkProfileSource") == "project",
              str(payload4.get("checkProfileSource")))
        check("cp.spoken_min", (eff.get("spoken_words") or {}).get("min") == 300, str(eff))
        check("cp.spoken_max", (eff.get("spoken_words") or {}).get("max") == 400, str(eff))
        check("cp.pacing_dup", (eff.get("pacing") or {}).get("dup_similarity") == 0.0, str(eff))
        check("cp.culture_forbid", (eff.get("culture") or {}).get("forbid_cn_elements") is False,
              str(eff))
        check("cp.warnings_empty", not payload4.get("warnings"), str(payload4.get("warnings")))
        cp_checks = payload4.get("checks") or {}
        check("cp.spoken_risk", (cp_checks.get("spoken_words") or {}).get("status") == "RISK",
              str(cp_checks.get("spoken_words")))
        cp_eps = payload4.get("episodes") or []
        check("cp.spoken_fail_below",
              bool(cp_eps) and all(
                  (e.get("checks") or {}).get("spoken_words", {}).get("status") == "FAIL_BELOW"
                  for e in cp_eps), str([e.get("checks", {}).get("spoken_words") for e in cp_eps]))
        try:
            idx4 = json.loads((cp_project / "work/preflight/index.json")
                              .read_text(encoding="utf-8"))
            check("cp.index_source", idx4.get("checkProfileSource") == "project", "")
            check("cp.index_effective",
                  (idx4.get("effectiveCheckProfile") or {}).get("spoken_words", {}).get("min") == 300,
                  "")
            rep4 = json.loads((cp_project / "work/preflight/report.json")
                              .read_text(encoding="utf-8"))
            check("cp.report_effective",
                  (rep4.get("effectiveCheckProfile") or {}).get("pacing", {}).get("max_dup_pairs") == 0,
                  "")
            pace4 = json.loads((cp_project / "work/preflight/checks/pacing.json")
                               .read_text(encoding="utf-8"))
            check("cp.pacing_threshold",
                  pace4.get("subchecks", {}).get("atom_pacing", {}).get("thresholds", {})
                  .get("dup_similarity") == 0.0, "")
            md4 = (cp_project / "report/雾港_前置质检报告.md").read_text(encoding="utf-8")
            check("cp.report_md",
                  "检查阈值来源" in md4 and "project" in md4, "")
        except Exception as exc:
            check("cp.artifacts", False, f"{exc}")

        # ---- M2: invalid check-profile values fall back to defaults + warning ----
        bad_project = tmp / "wugang_bad"
        bad_project.mkdir(parents=True, exist_ok=True)
        (bad_project / "check-profile.json").write_text(json.dumps({
            "schema": "lianben/check-profile/1",
            "spoken_words": {"min": "abc", "max": 50},
            "pacing": {"max_atom_run": 0},
        }, ensure_ascii=False), encoding="utf-8")
        code5, out5, err5, _ms5 = _run_cli(
            ["preflight", "--root", str(bad_project), "--source", str(docx)])
        payload5 = {}
        try:
            payload5 = _one_json_line(out5)
        except Exception as exc:
            check("bad.stdout", False, f"{exc}; stdout={out5[:400]!r}")
        check("bad.exit", code5 == 0, f"exit={code5}; stderr={err5[-800:]!r}")
        eff5 = payload5.get("effectiveCheckProfile") or {}
        check("bad.source", payload5.get("checkProfileSource") == "default",
              str(payload5.get("checkProfileSource")))
        check("bad.spoken_defaults",
              (eff5.get("spoken_words") or {}).get("min") == 100
              and (eff5.get("spoken_words") or {}).get("max") == 350, str(eff5))
        check("bad.pacing_default",
              (eff5.get("pacing") or {}).get("max_atom_run") == 4, str(eff5))
        check("bad.warnings", bool(payload5.get("warnings")),
              str(payload5.get("warnings")))
        check("bad.warning_text",
              any("spoken_words.min" in str(w) or "max_atom_run" in str(w)
                  for w in (payload5.get("warnings") or [])),
              str(payload5.get("warnings")))
        try:
            idx5 = json.loads((bad_project / "work/preflight/index.json")
                              .read_text(encoding="utf-8"))
            check("bad.index_warnings", bool(idx5.get("warnings")), "")
        except Exception as exc:
            check("bad.artifacts", False, f"{exc}")

        # ---- M2: max_atom_run=12 must change the pacing risk set on the 20-ep fixture ----
        fixture20 = ENGINE_DIR / "fixtures" / "sample-20eps.docx"
        if fixture20.exists():
            base_project = tmp / "wugang_pace_base"
            risk_project = tmp / "wugang_pace_override"
            base_project.mkdir(parents=True, exist_ok=True)
            risk_project.mkdir(parents=True, exist_ok=True)
            (risk_project / "check-profile.json").write_text(json.dumps({
                "schema": "lianben/check-profile/1",
                "pacing": {"max_atom_run": 12},
            }, ensure_ascii=False), encoding="utf-8")
            code6, out6, err6, _ms6 = _run_cli(
                ["preflight", "--root", str(base_project), "--source", str(fixture20)])
            payload6 = {}
            try:
                payload6 = _one_json_line(out6)
            except Exception as exc:
                check("pace20.base_stdout", False, f"{exc}; stderr={err6[-600:]!r}")
            check("pace20.base_exit", code6 == 0, f"exit={code6}; stderr={err6[-600:]!r}")
            base_atom = ((json.loads((base_project / "work/preflight/checks/pacing.json")
                                     .read_text(encoding="utf-8"))
                          .get("subchecks", {}).get("atom_pacing", {})))
            check("pace20.base_risky_has_5", 5 in (base_atom.get("risky_eps") or []),
                  str(base_atom.get("risky_eps")))
            code7, out7, err7, _ms7 = _run_cli(
                ["preflight", "--root", str(risk_project), "--source", str(fixture20)])
            payload7 = {}
            try:
                payload7 = _one_json_line(out7)
            except Exception as exc:
                check("pace20.override_stdout", False, f"{exc}; stderr={err7[-600:]!r}")
            check("pace20.override_exit", code7 == 0, f"exit={code7}; stderr={err7[-600:]!r}")
            check("pace20.override_source", payload7.get("checkProfileSource") == "project",
                  str(payload7.get("checkProfileSource")))
            eff7 = payload7.get("effectiveCheckProfile") or {}
            check("pace20.effective_max_atom_run",
                  (eff7.get("pacing") or {}).get("max_atom_run") == 12, str(eff7.get("pacing")))
            try:
                pace7 = json.loads((risk_project / "work/preflight/checks/pacing.json")
                                   .read_text(encoding="utf-8"))
                atom7 = pace7.get("subchecks", {}).get("atom_pacing", {})
                check("pace20.override_risky_empty", (atom7.get("risky_eps") or []) == [],
                      str(atom7.get("risky_eps")))
                check("pace20.threshold_recorded",
                      (atom7.get("thresholds") or {}).get("max_atom_run") == 12, "")
                check("pace20.override_episodes",
                      (payload7.get("project") or {}).get("episodes") == 20, "")
            except Exception as exc:
                check("pace20.override_artifacts", False, f"{exc}")

        elapsed_ms = int((time.time() - started) * 1000)
        failed = [r for r in results if not r["ok"]]
        summary = {
            "ok": not failed,
            "python": sys.version.split()[0],
            "engine_dir": str(ENGINE_DIR),
            "project": str(project),
            "checks": len(results),
            "passed": len(results) - len(failed),
            "failed": len(failed),
            "failed_names": [r["name"] for r in failed],
            "durationMs": elapsed_ms,
            "m2": {
                "events": {"phases": phases, "jsonl_events": len(events),
                           "episode_events": len(ep_events)},
                "check_profile": {"source": payload4.get("checkProfileSource"),
                                  "spoken_words": (eff or {}).get("spoken_words")},
                "invalid_check_profile": {"source": payload5.get("checkProfileSource"),
                                          "warnings": payload5.get("warnings")},
            },
            "cli": {
                "version": _one_json_line(
                    _run_cli(["version"])[1]
                ),
                "preflight": {
                    "ok": payload.get("ok"),
                    "episodes": project_meta.get("episodes"),
                    "detection": detection,
                    "check_status": {k: (v or {}).get("status") for k, v in (checks or {}).items()},
                    "report": report,
                },
            },
        }
        print(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))
        return 0 if not failed else 1
    finally:
        if args.keep:
            print(f"[keep] {tmp}", file=sys.stderr)
        else:
            shutil.rmtree(tmp, ignore_errors=True)
            try:
                TMP_ROOT.rmdir()
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
