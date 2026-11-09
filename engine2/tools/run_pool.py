import argparse
import datetime
import hashlib
import json
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C

BASE_PROMPT = (
    "Process episode ep{n:02d} strictly per .opencode/agents/director.md. "
    "Read every required file listed there (all .md files under 参考资料/炼本细则/, global-style.md, work/meta/facts_lock.md, "
    "work/meta/handoff.json entry, work/source/ep{n:02d}.md), enrich the episode into a director's shooting script, "
    "then write work/draft/ep{n:02d}.md, work/report/ep{n:02d}.json and work/report/ep{n:02d}_production_notes.md. Reply with one status line only."
)
RETRY_SUFFIX = (
    " This is retry attempt. The previous automated check failed; read work/meta/retry_ep{n:02d}.txt "
    "for the exact failure list, fix every listed issue, and rewrite the complete episode."
)


def ascii_safe(s):
    return re.sub(r"[^\x00-\x7F]+", " ", s).strip()


def run_worker(n, attempt, args):
    # A failed or empty worker must never be credited with a previous draft.
    for path in (C.ROOT / "work" / "draft" / f"ep{n:02d}.md",
                 C.ROOT / "work" / "report" / f"ep{n:02d}.json"):
        path.unlink(missing_ok=True)
    log = args.logdir / f"ep{n:02d}_att{attempt}.log"
    suffix = RETRY_SUFFIX.format(n=n) if attempt > 1 else ""
    msg = BASE_PROMPT.format(n=n) + suffix
    cmd = ["cmd", "/c", "opencode", "run", "--agent", "director", "--auto"]
    # V2：--variant 已移除，variant 必须写成 --model provider/model#variant
    if args.model:
        model = f"{args.model}#{args.variant}" if args.variant else args.model
        cmd += ["--model", model]
    elif args.variant:
        print(f"[WARN] 已忽略 --variant={args.variant}：V2 需写成 --model provider/model#variant，但未提供 --model；改用 agent 默认模型/挡位", flush=True)
    cmd.append(msg)
    t0 = time.time()
    with open(log, "w", encoding="utf-8") as f:
        try:
            p = subprocess.run(cmd, cwd=str(C.ROOT), stdout=f, stderr=subprocess.STDOUT, timeout=args.timeout)
            code = p.returncode
        except subprocess.TimeoutExpired:
            code = -999
    return code, round(time.time() - t0, 1)


def check_one(n):
    cmd = [sys.executable, str(C.ROOT / "tools" / "check_ep.py"), "--eps", str(n), "--no-progress"]
    p = subprocess.run(cmd, cwd=str(C.ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace")
    rec = C.load_json(C.ROOT / "work" / "report" / f"check_ep{n:02d}.json", {})
    return p.returncode == 0, rec


def episode_task(n, args):
    for attempt in range(1, args.retries + 2):
        code, secs = run_worker(n, attempt, args)
        ok, rec = check_one(n)
        if ok:
            return {"ep": n, "result": "pass", "attempt": attempt, "secs": secs}
        fails = "; ".join(rec.get("fails", []) or [f"exit={code}"])
        C.write_text(C.ROOT / "work" / "meta" / f"retry_ep{n:02d}.txt",
                     f"ep{n:02d} attempt {attempt} failed checks:\n{fails}\n")
        print(f"[retry] ep{n:02d} attempt={attempt} exit={code} {secs}s fails={ascii_safe(fails)[:120]}", flush=True)
    print(f"[FAIL] ep{n:02d} reached retry limit={args.retries}; leaving draft failed", flush=True)
    return {"ep": n, "result": "failed", "attempt": args.retries + 1, "fails": fails}


def ensure_profile(args):
    """Extract the current source, refresh stale format rules, then split."""
    root = C.ROOT
    logs = root / "work" / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    prof = root / "work" / "meta" / "format.json"
    extracted = subprocess.run([sys.executable, str(root / "tools" / "split_docx.py"), "--extract-only"],
                               cwd=str(root))
    if extracted.returncode != 0:
        print("[FAIL] source extraction failed; aborting pool run", flush=True)
        return False
    source = C.resolve_docx(root)
    previous_index = C.load_json(root / "work" / "meta" / "ep_index.json", {}) or {}
    previous_hash = previous_index.get("source_sha256")
    current_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    rules = root / "work" / "meta" / "format_rules.md"
    stale = bool(previous_hash and previous_hash != current_hash)
    if prof.exists() and not stale:
        try:
            data = json.loads(prof.read_text(encoding="utf-8-sig"))
            pattern = data["episode"]["header_pattern"]
            if re.compile(pattern).groups < 1 or not isinstance(data["locked_line_patterns"], list):
                raise ValueError("missing episode number capture or locked_line_patterns")
        except (OSError, ValueError, KeyError, TypeError, re.error) as e:
            print(f"[profile] invalid format.json: {e}", flush=True)
            stale = True
    if prof.exists() and not rules.exists():
        print("[profile] format_rules.md missing", flush=True)
        stale = True
    if stale:
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        for path in (prof, rules):
            if path.exists():
                path.rename(path.with_name(f"{path.name}.{stamp}.bak"))
        print("[profile] saved old rules and will re-profile", flush=True)
    if not prof.exists() or not rules.exists():
        print("[profile] format rules missing; rebuilding via assemble_source.py --rebuild ...", flush=True)
        r = subprocess.run([sys.executable, str(root / "tools" / "assemble_source.py"), "--rebuild"],
                           cwd=str(root), capture_output=True, text=True, encoding="utf-8", errors="replace")
        out = ((r.stdout or "") + (r.stderr or "")).strip()
        C.write_text(logs / "profile_rebuild.log", out + "\n")
        if r.returncode != 0 or not prof.exists() or not rules.exists():
            print("[FAIL] 无法生成格式规则（请先运行 /前置检查 完成存档）；see work/logs/profile_rebuild.log")
            return False
        print("[profile] format rules rebuilt", flush=True)
    split = subprocess.run([sys.executable, str(root / "tools" / "split_docx.py")], cwd=str(root))
    if split.returncode != 0:
        print("[FAIL] split_docx.py failed; aborting pool run", flush=True)
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eps", default="")
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--retries", type=int, choices=(0, 1, 2), default=2,
                    help="重试次数上限（不含首次生成），最多2次")
    ap.add_argument("--timeout", type=int, default=1500)
    ap.add_argument("--variant", default="")
    ap.add_argument("--model", default="")
    args = ap.parse_args()
    root = C.ROOT
    args.logdir = root / "work" / "logs"
    args.logdir.mkdir(parents=True, exist_ok=True)
    if not ensure_profile(args):
        return 2
    meta = C.load_json(root / "work" / "meta" / "ep_index.json")
    if not meta:
        print("[FAIL] run split_docx.py first")
        return 2
    progress = C.load_json(root / "work" / "meta" / "progress.json", {"episodes": {}})
    if args.eps:
        targets = list(dict.fromkeys(int(x) for x in args.eps.replace(" ", "").split(",") if x))
    else:
        targets = [e["ep"] for e in meta["episodes"]
                   if progress["episodes"].get(str(e["ep"]), {}).get("status") != "passed"]
    if not targets:
        print("[OK] nothing to do")
        return 0
    print(f"[pool] targets={len(targets)} k={args.k} eps={targets}")
    results = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.k) as ex:
        futs = {ex.submit(episode_task, n, args): n for n in targets}
        for fut in as_completed(futs):
            n = futs[fut]
            try:
                rec = fut.result()
            except Exception as e:
                rec = {"ep": n, "result": "failed", "fails": str(e)[:200]}
            results.append(rec)
            key = str(n)
            pe = progress["episodes"].get(key, {})
            pe["status"] = "passed" if rec["result"] == "pass" else "failed"
            pe["pool_result"] = rec
            progress["episodes"][key] = pe
            progress["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            C.save_json(root / "work" / "meta" / "progress.json", progress)
            print(f"[done] ep{n:02d} {rec['result']} attempt={rec.get('attempt')} secs={rec.get('secs','-')}", flush=True)
    C.save_json(root / "work" / "report" / "pool_run.json", {"results": results})
    passed = sum(1 for r in results if r["result"] == "pass")
    failed = [r["ep"] for r in results if r["result"] != "pass"]
    print(f"[pool] done passed={passed}/{len(targets)} failed={failed} elapsed={round(time.time()-t0,1)}s")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

