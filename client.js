/**
 * Lianben Workbench — M3 (Client half).
 *
 * Single-file plain-JS React (no JSX, no build step). Registers the global
 * sidebar entry (`sidebar.panellist`, id `lianben`, order 30) and the matching
 * main page (`main`, key `lianben`).
 *
 * Views are switched by component state only (no router):
 *   library | import | progress | project(preflight|refine tab) | options | settings | diagnostics
 *
 * Host API (exact authenticated Fetch routes, query params only):
 *   GET  /api/lianben/health
 *   GET  /api/lianben/projects?query=&sort=updated|title|episodes
 *   POST /api/lianben/import?name=&title=          body = .docx bytes -> 202 {project, job}
 *        (?sync=1 compatibility mode -> 200 {project, snapshot})
 *   GET  /api/lianben/job?id=<jobId>
 *   GET  /api/lianben/events?jobId=<jobId>         SSE (job/phase/episode/log/token/done/error)
 *   POST /api/lianben/job/cancel                   {jobId}
 *   GET  /api/lianben/project?id=
 *   GET  /api/lianben/project/report?id=&format=md
 *   GET  /api/lianben/project/episode?id=&ep=
 *   GET  /api/lianben/project/refine?id=           refine detail (state/progress/episodes/artifacts/tokens/job)
 *   GET  /api/lianben/project/draft?id=&ep=        single-episode draft + check + notes
 *   POST /api/lianben/project/action               {id, action, episodes?, concurrency?}
 *                                                  (rerun-preflight / run-refine -> 202 {job})
 *   POST /api/lianben/project/options              {id, options}
 *   GET  /api/lianben/file?id=&path=
 *   GET  /api/lianben/selfcheck | POST /api/lianben/run-selfcheck
 *
 * Styling uses only the 14 measured `--dsw-*` theme tokens.
 */

window.__ModuleLoader__.load({
  id: '@local/lianben-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/api/lianben'
    const PANEL_ID = 'lianben'
    const MAX_UPLOAD_BYTES = 64 * 1024 * 1024
    let lastClientErrorAt = 0

    function reportClientError(kind, error) {
      try {
        const now = Date.now()
        if (now - lastClientErrorAt < 1500) return
        lastClientErrorAt = now
        const payload = {
          schema: 'lianben/m3/client-error/1',
          at: new Date(now).toISOString(),
          kind: String(kind || 'error'),
          message: String((error && (error.message || error.reason || error)) || 'unknown client error'),
          stack: String((error && error.stack) || ''),
          href: typeof location !== 'undefined' ? location.href : null,
          language: typeof navigator !== 'undefined' ? navigator.language : null,
        }
        void fetch(`${API}/m3/client-report`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {})
      } catch {
        // diagnostics must never break the page
      }
    }

    const CHECK_KEYS = ['spokenWords', 'punctuation', 'pacing', 'protagonist', 'culture']
    const ENGINE_CHECK_IDS = {
      spokenWords: 'spoken_words',
      punctuation: 'punctuation',
      pacing: 'pacing',
      protagonist: 'protagonist',
      culture: 'culture',
    }
    const CHECK_ALIASES = {
      spokenWords: ['spokenWords', 'spoken_words', 'spoken'],
      punctuation: ['punctuation', 'punct'],
      pacing: ['pacing', 'atom_pacing', 'dialogue_density'],
      protagonist: ['protagonist', 'lead'],
      culture: ['culture'],
    }
    const RISK_STATUSES = {
      RISK: true,
      FAIL: true,
      FAIL_BELOW: true,
      FAIL_ABOVE: true,
      ERROR: true,
      WARN: true,
    }
    const OK_STATUSES = {
      OK: true,
      PASS: true,
      PASSED: true,
      INFO: true,
      SKIP: true,
      BORDERLINE: true,
    }
    const JOB_PHASES = ['extract', 'detect', 'split', 'normalize', 'protagonist', 'checks', 'report']
    const REFINE_PHASES = ['prepare', 'write', 'check', 'retry', 'merge', 'writeback', 'audit', 'report']
    const REFINE2_PHASES = ['prepare', 'plan', 'plan_check', 'write', 'check', 'retry', 'audit', 'merge', 'build', 'report']
    const PHASES_BY_KIND = {
      'import-preflight': JOB_PHASES,
      'rerun-preflight': JOB_PHASES,
      refine: REFINE_PHASES,
      refine2: REFINE2_PHASES,
      storyboard: REFINE2_PHASES,
    }
    const MODE_1 = 'lianben-1.0'
    const MODE_2 = 'yanyi-2.0'
    const DEFAULT_MODES = [
      { id: MODE_1, label: '1.0 解说剧', description: '弱质检 + director 逐集写作（现有 1.0 流程）' },
      { id: MODE_2, label: '2.0 演绎剧', description: '竖屏分镜演绎：planner/writer 双阶段 + 台词台账 + 轻度 LLM 纠正' },
    ]
    const DEFAULT_PRICING = {
      model: 'deepseek-flash',
      currency: 'CNY',
      unit: 1000000,
      rates: {
        peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
        idle: { inputMiss: 1, inputHit: 0.02, output: 4 },
      },
      idleWindow: { startMinutes: 30, endMinutes: 510, label: '00:30–08:30', timeZone: 'Asia/Shanghai' },
      current: null,
    }
    const LIVE_FLUSH_MS = 200
    const LIVE_SCROLL_THRESHOLD = 40
    const BGM_PHASES = ['prepare', 'architect', 'write', 'check', 'qc', 'merge', 'build', 'audit', 'report']
    const BGM_EP_STATES = ['pending', 'writing', 'machine_checking', 'qc_pending', 'qc_running', 'passed', 'retry_wait', 'failed']
    const REFINE_TERMINAL_STATES = {
      passed: true,
      'passed-with-issues': true,
      failed: true,
      blocked: true,
    }
    const JOB_RUNNING_STATES = { queued: true, running: true }
    const JOB_TERMINAL_STATES = {
      succeeded: true,
      failed: true,
      cancelled: true,
      needs_confirm: true,
      interrupted: true,
    }
    const PAGE_SIZE = 20
    const SORT_OPTIONS = ['updated', 'title', 'episodes']

    // -----------------------------------------------------------------------
    // Styles (only --dsw-* tokens; no hard-coded colours)
    // -----------------------------------------------------------------------
    const CSS = `
      .lb-root { box-sizing: border-box; height: 100%; overflow: auto; padding: 24px 28px 56px;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        font-size: 13px; line-height: 1.55; }
      .lb-root * { box-sizing: border-box; }
      .lb-header { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
      .lb-header-icon { flex: 0 0 auto; width: 42px; height: 42px; border-radius: 12px;
        display: flex; align-items: center; justify-content: center;
        color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l1); }
      .lb-header-text { min-width: 0; }
      .lb-title { margin: 0; font-size: 18px; font-weight: 600; }
      .lb-subtitle { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .lb-actions { margin-left: auto; display: flex; flex-wrap: wrap; gap: 8px; }
      .lb-btn { height: 30px; padding: 0 12px; border-radius: 8px; font: inherit; font-size: 12px;
        cursor: pointer; color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); }
      .lb-btn:hover { background: var(--dsw-alias-bg-layer-2); }
      .lb-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .lb-btn:disabled { color: var(--dsw-alias-label-secondary); cursor: default; opacity: .6; }
      .lb-btn-primary { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
      .lb-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .lb-btn-ghost { border-color: transparent; background: transparent; }
      .lb-link { background: none; border: 0; padding: 0; font: inherit; cursor: pointer;
        color: var(--dsw-alias-brand-primary); }
      .lb-link:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .lb-banner { margin-top: 16px; padding: 10px 12px; border-radius: 8px; font-size: 12px;
        color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-state-error-primary); display: flex; gap: 10px;
        align-items: flex-start; flex-wrap: wrap; }
      .lb-banner-text { flex: 1 1 240px; min-width: 0; word-break: break-word; }
      .lb-info { margin-top: 16px; padding: 10px 12px; border-radius: 8px; font-size: 12px;
        color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1); }
      .lb-section { margin-top: 20px; padding: 16px; border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
      .lb-section-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .lb-section-title { margin: 0; font-size: 14px; font-weight: 600; }
      .lb-section-actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
      .lb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin-top: 12px; }
      .lb-card { min-width: 0; padding: 14px; border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
      .lb-card-top { display: flex; align-items: flex-start; gap: 8px; }
      .lb-card-title { margin: 0; font-size: 14px; font-weight: 600; flex: 1; min-width: 0;
        word-break: break-word; }
      .lb-card-meta { margin-top: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .lb-card-checks { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
      .lb-card-foot { display: flex; align-items: center; gap: 10px; margin-top: 12px;
        padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
      .lb-card-foot-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; flex: 1; min-width: 0; }
      .lb-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px;
        border-radius: 999px; font-size: 11px; line-height: 1.7; white-space: nowrap;
        border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-bg-layer-2); }
      .lb-badge-success { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .lb-badge-risk { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .lb-badge-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .lb-badge-idle { color: var(--dsw-alias-state-idle-primary); border-color: var(--dsw-alias-state-idle-primary); }
      .lb-badge-brand { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
      .lb-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px;
        border-radius: 6px; font-size: 11px; white-space: nowrap;
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
        color: var(--dsw-alias-label-secondary); }
      .lb-chip-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .lb-chip-risk { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .lb-chip-blocked { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .lb-dropzone { margin-top: 16px; padding: 32px 20px; border-radius: 12px; text-align: center;
        background: var(--dsw-alias-bg-layer-1); border: 2px dashed var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-secondary); cursor: pointer; }
      .lb-dropzone:hover { background: var(--dsw-alias-bg-layer-2); }
      .lb-dropzone-active { border-color: var(--dsw-alias-brand-primary);
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .lb-dropzone:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .lb-dropzone-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; }
      .lb-dropzone-hint { margin-top: 6px; font-size: 12px; }
      .lb-file-input { position: absolute; width: 1px; height: 1px; overflow: hidden;
        clip: rect(0 0 0 0); white-space: nowrap; }
      .lb-progress { margin-top: 16px; }
      .lb-progress-track { height: 8px; border-radius: 999px; overflow: hidden;
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
      .lb-progress-fill { height: 100%; background: var(--dsw-alias-brand-primary);
        transition: width 200ms ease; }
      .lb-progress-label { margin-top: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .lb-stages { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
      .lb-stage { display: flex; align-items: center; gap: 6px; font-size: 12px;
        color: var(--dsw-alias-label-secondary); }
      .lb-stage-dot { width: 9px; height: 9px; border-radius: 999px; flex: 0 0 auto;
        background: var(--dsw-alias-state-idle-primary); }
      .lb-stage-done .lb-stage-dot { background: var(--dsw-alias-state-success-primary); }
      .lb-stage-run .lb-stage-dot { background: var(--dsw-alias-brand-primary); }
      .lb-stage-fail .lb-stage-dot { background: var(--dsw-alias-state-error-primary); }
      .lb-stage-label { white-space: nowrap; }
      .lb-stage-sep { color: var(--dsw-alias-border-l2); }
      .lb-stage-note { font-size: 11px; color: var(--dsw-alias-state-idle-primary); }
      .lb-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: 10px; margin-top: 12px; }
      .lb-stat { padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l1); min-width: 0; }
      .lb-stat-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .lb-stat-value { margin-top: 2px; font-size: 16px; font-weight: 600; }
      .lb-stat-value-risk { color: var(--dsw-alias-state-warn-primary); }
      .lb-stat-value-error { color: var(--dsw-alias-state-error-primary); }
      .lb-table-wrap { margin-top: 12px; overflow: auto; border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l1); }
      .lb-table { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 820px; }
      .lb-table th { position: sticky; top: 0; z-index: 1; text-align: left; font-weight: 600;
        padding: 8px 10px; background: var(--dsw-alias-bg-layer-2);
        border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap;
        color: var(--dsw-alias-label-primary); }
      .lb-table td { padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1);
        vertical-align: top; }
      .lb-table tbody tr:hover td { background: var(--dsw-alias-bg-layer-2); }
      .lb-table-num { text-align: right; font-variant-numeric: tabular-nums; }
      .lb-table-ep { white-space: nowrap; font-variant-numeric: tabular-nums; }
      .lb-table-title { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .lb-ep-detail { padding: 12px 14px; background: var(--dsw-alias-bg-layer-2); }
      .lb-ep-detail-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .lb-pre { margin: 8px 0 0; padding: 12px; max-height: 380px; overflow: auto;
        border-radius: 8px; font-size: 12px; line-height: 1.6; white-space: pre-wrap;
        word-break: break-word; color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .lb-kv { display: grid; grid-template-columns: minmax(120px, max-content) 1fr;
        gap: 6px 14px; margin-top: 10px; font-size: 12px; }
      .lb-kv-key { color: var(--dsw-alias-label-secondary); }
      .lb-kv-value { word-break: break-word; }
      .lb-toast { position: fixed; right: 20px; bottom: 20px; z-index: 20; max-width: 360px;
        padding: 10px 14px; border-radius: 8px; font-size: 12px;
        background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
        border: 1px solid var(--dsw-alias-border-l2); }
      .lb-toast-success { border-color: var(--dsw-alias-state-success-primary); }
      .lb-toast-error { border-color: var(--dsw-alias-state-error-primary); }
      .lb-empty { margin-top: 16px; padding: 40px 20px; text-align: center;
        border-radius: 12px; border: 1px dashed var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-secondary); }
      .lb-empty-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; }
      .lb-empty-desc { margin-top: 6px; font-size: 12px; }
      .lb-empty-action { margin-top: 14px; }
      .lb-loading { margin-top: 16px; padding: 24px; text-align: center;
        color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .lb-confirm { margin-top: 12px; padding: 10px 12px; border-radius: 8px;
        background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2);
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
      .lb-confirm-text { flex: 1 1 260px; min-width: 0; color: var(--dsw-alias-label-primary); }
      .lb-hint { margin-top: 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .lb-subheader { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
      .lb-subheader-title { margin: 0; font-size: 14px; font-weight: 600; }
      .lb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
      .lb-jobbar { margin-top: 16px; padding: 12px 14px; border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
        display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
      .lb-jobbar-main { flex: 1 1 260px; min-width: 0; }
      .lb-jobbar-title { font-weight: 600; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .lb-jobbar-meta { margin-top: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .lb-stepper { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 14px; }
      .lb-step { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
        font-size: 12px; color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
      .lb-step-done { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .lb-step-active { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
      .lb-step-fail { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .lb-step-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--dsw-alias-state-idle-primary); }
      .lb-step-done .lb-step-dot { background: var(--dsw-alias-state-success-primary); }
      .lb-step-active .lb-step-dot { background: var(--dsw-alias-brand-primary); }
      .lb-step-fail .lb-step-dot { background: var(--dsw-alias-state-error-primary); }
      .lb-progress-meta { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 12px; font-size: 12px; }
      .lb-progress-meta-key { color: var(--dsw-alias-label-secondary); }
      .lb-progress-meta-value { font-weight: 600; }
      .lb-log { margin-top: 12px; max-height: 220px; overflow: auto; border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
        padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
      .lb-log-line { padding: 2px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); word-break: break-word; }
      .lb-log-line:last-child { border-bottom: 0; }
      .lb-log-time { color: var(--dsw-alias-label-secondary); margin-right: 8px; }
      .lb-log-error { color: var(--dsw-alias-state-error-primary); }
      .lb-log-done { color: var(--dsw-alias-state-success-primary); }
      .lb-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
      .lb-input { height: 30px; padding: 0 10px; border-radius: 8px; font: inherit; font-size: 12px;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l2); }
      .lb-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .lb-input-search { flex: 1 1 220px; min-width: 160px; max-width: 360px; }
      .lb-input-number { width: 120px; }
      .lb-input-wide { width: 100%; max-width: 520px; height: auto; min-height: 70px; padding: 8px 10px; }
      .lb-pagination { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px;
        font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .lb-page-current { color: var(--dsw-alias-label-primary); font-weight: 600; }
      .lb-findings { margin-top: 10px; }
      .lb-finding { display: flex; gap: 10px; padding: 8px 10px; border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
        margin-top: 6px; font-size: 12px; }
      .lb-finding-severity { flex: 0 0 auto; font-weight: 600; }
      .lb-finding-body { min-width: 0; word-break: break-word; }
      .lb-finding-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 2px; }
      .lb-finding-snippet { margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
      .lb-sev-must { color: var(--dsw-alias-state-error-primary); }
      .lb-sev-suspected { color: var(--dsw-alias-state-warn-primary); }
      .lb-sev-info { color: var(--dsw-alias-label-secondary); }
      .lb-toc { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      .lb-report-section { margin-top: 14px; }
      .lb-report-heading { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
      .lb-form { display: grid; gap: 12px; margin-top: 12px; max-width: 680px; }
      .lb-form-row { display: grid; grid-template-columns: 220px 1fr; gap: 10px; align-items: start; }
      .lb-form-label { font-size: 12px; color: var(--dsw-alias-label-secondary); padding-top: 7px; }
      .lb-form-actions { display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
      .lb-form-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
      .lb-check-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
      .lb-job-badge { margin-top: 8px; display: inline-flex; align-items: center; gap: 6px; font-size: 11px;
        color: var(--dsw-alias-brand-primary); }
      .lb-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 16px;
        border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .lb-tab { height: 30px; padding: 0 14px; border-radius: 8px 8px 0 0; border: 1px solid transparent;
        border-bottom: 0; background: transparent; color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 12px; cursor: pointer; }
      .lb-tab:hover { background: var(--dsw-alias-bg-layer-2); }
      .lb-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
      .lb-tab-active { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1);
        border-color: var(--dsw-alias-border-l2); font-weight: 600; }
      .lb-inline-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
      .lb-inline-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .lb-token-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: 10px; margin-top: 10px; }
      .lb-artifact-list { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      .lb-link-btn { display: inline-flex; align-items: center; justify-content: center; height: 28px;
        padding: 0 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); font-size: 12px;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); text-decoration: none; }
      .lb-link-btn:hover { background: var(--dsw-alias-bg-layer-2); }
      .lb-link-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .lb-table-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .lb-draft { margin-top: 12px; padding: 12px 14px; border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
      .lb-draft-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .lb-subsection-title { margin: 14px 0 0; font-size: 13px; font-weight: 600; }
      .lb-ep-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
      .lb-live-console { margin-top: 12px; height: 460px; overflow: auto; border-radius: 10px;
        background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2);
        padding: 12px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px; line-height: 1.65; white-space: pre-wrap; word-break: break-word;
        color: var(--dsw-alias-label-primary); }
      .lb-live-thinking { color: var(--dsw-alias-label-secondary); animation: lb-blink 1.2s ease-in-out infinite; }
      @keyframes lb-blink { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
      .lb-live-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; max-height: 96px; overflow: auto; }
      .lb-live-chip { height: 26px; padding: 0 10px; border-radius: 999px; font: inherit; font-size: 11px;
        cursor: pointer; background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
      .lb-live-chip:hover { background: var(--dsw-alias-bg-layer-2); }
      .lb-live-chip-active { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); font-weight: 600; }
      .lb-live-chip-done { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .lb-live-chip-fail { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .lb-live-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
      .lb-live-meta { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px;
        color: var(--dsw-alias-label-secondary); margin-top: 8px; }
      .lb-cost-card { margin-top: 12px; padding: 12px 14px; border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
      .lb-cost-main { margin: 2px 0 0; font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .lb-cost-row { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 6px;
        font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .lb-cost-pill { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px; border-radius: 999px;
        font-size: 11px; line-height: 1.7; border: 1px solid var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-secondary); }
      .lb-cost-pill-idle { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .lb-cost-pill-peak { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .lb-cost-note { margin-top: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .lb-rental-clock { font-variant-numeric: tabular-nums; }
      .lb-budget { margin-top: 12px; padding: 12px 14px; border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
      .lb-budget-warning { border-color: var(--dsw-alias-state-warn-primary); }
      .lb-budget-exceeded { border-color: var(--dsw-alias-state-error-primary); }
      .lb-budget-head { display: flex; align-items: center; justify-content: space-between;
        gap: 12px; flex-wrap: wrap; }
      .lb-budget-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .lb-budget-value { font-size: 12px; font-variant-numeric: tabular-nums;
        color: var(--dsw-alias-label-secondary); }
      .lb-budget-stage { margin-top: 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .lb-banner { margin-top: 12px; padding: 12px 14px; border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-state-warn-primary); }
      .lb-banner-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .lb-mode-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
      .lb-mode-bar-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .lb-mode-option { height: 28px; padding: 0 12px; border-radius: 999px; font: inherit; font-size: 12px;
        cursor: pointer; background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
      .lb-mode-option:hover { background: var(--dsw-alias-bg-layer-2); }
      .lb-mode-option-active { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); font-weight: 600; }
      .lb-mode-option:disabled { opacity: 0.6; cursor: default; }
      .lb-mode-option:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .lb-card-badges { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .lb-merge-notes { margin-top: 8px; display: flex; flex-direction: column; gap: 2px; }
      .lb-merge-warn { margin: 2px 0 0; font-size: 12px; color: var(--dsw-alias-state-warn-primary); }
      .lb-merge-stale { margin-top: 10px; padding: 10px 12px; border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-state-warn-primary); }
      .lb-merge-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px;
        max-height: 280px; overflow: auto; }
      .lb-merge-item { display: flex; align-items: center; gap: 8px; padding: 4px 8px;
        border-radius: 8px; background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
      .lb-merge-item-merged { opacity: 0.7; }
      .lb-merge-preview { margin-top: 12px; padding: 12px 14px; border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); }
      .lb-merge-preview-ep { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
      .lb-merge-preview-head { display: flex; align-items: center; gap: 8px; font-size: 12px; }
      .lb-merge-target { margin-top: 6px; padding: 6px 8px; border-radius: 8px;
        background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
        color: var(--dsw-alias-label-secondary); }
      .lb-merge-toggle { display: inline-flex; align-items: center; gap: 8px; margin-top: 10px;
        font-size: 12px; color: var(--dsw-alias-label-primary); cursor: pointer; }
      .lb-merge-llm { margin-top: 10px; padding: 10px 12px; border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-state-warn-primary); }
    `

    // -----------------------------------------------------------------------
    // Locale dictionaries (namespace `lianben`)
    // -----------------------------------------------------------------------
    const ZH = {
      panel: { label: '炼本工作台' },
      app: {
        title: '炼本工作台',
        subtitle: '前置弱质检 + 炼本流水线 · M3',
      },
      nav: {
        refresh: '刷新',
        import: '导入剧本',
        settings: '设置',
        diagnostics: '诊断',
        back: '返回项目库',
      },
      common: {
        loading: '加载中…',
        retry: '重试',
        cancel: '取消',
        confirm: '确认',
        close: '关闭',
        empty: '暂无数据',
        yes: '是',
        no: '否',
        unknown: '未知',
        copyHint: '原始数据',
      },
      error: {
        network: '网络连接失败，请检查后重试。',
        auth: '登录已失效或无权限，请刷新页面后重试。',
        notFound: '请求的资源不存在。',
        server: '服务端处理失败，请查看诊断信息。',
        badInput: '输入不合法：{reason}',
        generic: '操作失败：{reason}',
        code: '错误码：{code}',
      },
      library: {
        title: '项目库',
        subtitle: '导入 .docx 剧本后自动完成格式识别、拆分与五项 0-token 检查。',
        emptyTitle: '还没有项目',
        emptyDesc: '导入一个 .docx 剧本开始；格式识别 → 拆分 → 五项机器检查全自动完成。',
        emptyAction: '导入剧本',
        loading: '正在加载项目…',
        count: '共 {n} 个项目',
        refresh: '刷新',
        searchPlaceholder: '搜索项目标题',
        sortLabel: '排序',
        sortUpdated: '更新时间',
        sortTitle: '标题',
        sortEpisodes: '集数',
        searchEmpty: '没有匹配的项目',
        jobRunning: '任务进行中：{phase}',
        jobFailed: '上次任务失败',
        jobNeedsConfirm: '识别待确认',
        jobCancelled: '上次任务已取消',
        jobInterrupted: '上次任务已中断',
      },
      card: {
        episodes: '{n} 集',
        cjk: '{n} 字',
        blocked: '{n} 集阻塞',
        noBlocked: '无阻塞集',
        updated: '更新于 {time}',
        open: '打开',
        checks: '五检摘要',
      },
      check: {
        spokenWords: '词数',
        punctuation: '标点',
        pacing: '密度',
        protagonist: '主角',
        culture: '文化',
        ok: '通过',
        risk: '风险',
        blocked: '阻塞',
        na: '—',
        pending: '待检查',
      },
      status: {
        preflight_done: '前置完成',
        preflight_failed: '前置失败',
        preflight_running: '前置运行中',
        importing: '导入中',
        needs_confirm: '待确认',
        new: '新建',
        unknown: '未知状态',
        ok: '正常',
        risk: '风险',
        blocked: '阻塞',
        fail: '不通过',
        fail_below: '台词偏少',
        fail_above: '台词偏多',
        warn: '留意',
        low: '主角偏少',
        no: '缺少主角',
        borderline: '接近临界',
        skip: '跳过',
        refine_done: '炼本完成',
        refine_partial: '炼本部分完成',
        refine_failed: '炼本失败',
        refine_cancelled: '炼本已取消',
        refine_running: '炼本运行中',
      },
      import: {
        title: '导入剧本',
        subtitle: '上传 .docx 原始字节，Host 侧流式落盘并立即运行 0-token 前置质检。',
        drop: '拖拽 .docx 到这里，或点击选择文件',
        hint: '仅支持 .docx；单文件 ≤64 MiB；文件名自动作为项目标题（可后续在项目中查看）。',
        choose: '选择文件',
        uploading: '正在上传并运行前置质检：{pct}%',
        processing: '上传完成，正在运行前置质检…',
        success: '导入成功：{title}',
        invalidExt: '仅支持 .docx 文件。',
        tooLarge: '文件超过 64 MiB 限制。',
        empty: '文件内容为空，请重新选择。',
        failed: '导入失败：{reason}',
        retry: '重试',
        back: '返回项目库',
        done: '打开项目',
        needsConfirmHelp: '识别置信度不足或集边界异常：请检查源 docx 的集标题与场次格式后重新导入。',
        correctionToggle: '启用低程度 LLM 纠正（默认关闭）',
        correctionDesc: '仅 2.0 演绎剧：不限制优化集数，每集最多 2 次纠正调用；台词锁校验失败会回滚。默认关闭，按需在导入前开启。',
      },
      project: {
        stage: {
          import: '导入',
          preflight: '前置',
          refine: '炼本',
          bgm: '配乐',
          notAvailable: 'M4 未开放',
        },
        overview: '概览',
        checks: '五检矩阵',
        episodes: '逐集结果',
        report: '前置报告',
        settingsAction: '项目设置',
        actions: '操作',
        refresh: '刷新快照',
        back: '返回项目库',
        rerun: '重跑前置',
        archive: '归档',
        delete: '删除',
        rerunConfirm: '重跑前置会先归档当前 work/，再重新识别、拆分并运行五项检查。确认继续？',
        archiveConfirm: '归档会把项目目录移动到 projectsRoot/.archive 并移出项目库。确认归档？',
        deleteConfirm: '删除会永久移除项目目录，操作不可恢复。确认删除？',
        actionsBusy: '操作进行中…',
        reportLoading: '正在加载报告…',
        reportEmpty: '报告暂未生成。',
        reportMissing: '未找到前置报告文件。',
        reportError: '报告加载失败：{reason}',
        noEpisodes: '暂无可展示的集',
        noEpisodesDesc: '该项目尚未完成前置质检，或尚未产生逐集结果。',
        epDetail: '集详情',
        epDetailLoading: '正在加载集详情…',
        epSource: '标准化存档（work/source）',
        epChecksTitle: '本集检查结果',
        created: '创建于 {time}',
        updated: '更新于 {time}',
        id: '项目 ID',
        engine: '引擎版本',
        duration: '前置耗时',
        sourceName: '源文件',
        preflightStatus: '前置状态',
        blockedEps: '阻塞集：{eps}',
        reportGenerated: '报告已生成',
        reportNotGenerated: '报告未生成',
      },
      matrix: {
        title: '五项机器检查',
        check: '检查项',
        state: '结果',
        riskEps: '风险集',
        none: '无风险',
        hint: '五项机器检查只报告问题，不会自动改稿；只有“主角戏份不足”会阻塞本集。',
        aiUsed: 'AI 未参与',
      },
      table: {
        ep: '集',
        title: '标题',
        status: '状态',
        words: '词数',
        punct: '标点',
        pacing: '密度',
        protagonist: '主角',
        culture: '文化',
        cjk: '字数',
        blocked: '阻塞',
        detail: '详情',
        expand: '展开',
        collapse: '收起',
        filterLabel: '筛选',
        filterAll: '全部',
        filterBlocked: '仅看阻塞',
        filterRisk: '仅看风险',
        filterCheckRisk: '仅看有问题的检查',
        jumpLabel: '跳转到集',
        jumpGo: '跳转',
        pageInfo: '第 {page}/{pages} 页',
        prev: '上一页',
        next: '下一页',
        noMatch: '没有匹配的集',
      },
      stats: {
        episodes: '集数',
        cjk: '总字数',
        scenes: '场次',
        dialogues: '台词行',
        atoms: '△ 行',
        blocked: 'blocked',
        duration: '前置耗时',
      },
      settings: {
        title: '设置',
        subtitle: 'M2 项目根目录与运行环境（当前页面只读展示，项目级配置在项目详情内编辑）。',
        projectsRoot: '项目根目录（projectsRoot）',
        python: '宿主 Python',
        engine: '前置引擎',
        workspace: '工作区',
        bundle: '插件版本',
        readonlyNote: 'M2 的项目级检查配置在「项目详情 → 项目设置」中编辑；projectsRoot / pythonPath 仍在 cordis.patch.yml 的插件 config 中调整。',
        back: '返回项目库',
        available: '可用',
        unavailable: '不可用',
      },
      diag: {
        title: '诊断',
        subtitle: '查看 Host 健康状态与 M2 自检结果（Python / 引擎 / 20 集夹具验收）。',
        health: '健康状态',
        selfcheck: '宿主自检',
        loadHealth: '刷新健康状态',
        loadSelfcheck: '读取宿主自检',
        runSelfcheck: '运行宿主自检',
        routes: '已注册路由',
        raw: '原始数据',
        back: '返回项目库',
        loading: '正在加载…',
        selfcheckHint: '「运行宿主自检」会调用 Python 引擎跑一次 20 集夹具验收，可能需要几十秒。',
        failed: '加载失败：{reason}',
      },
      toast: {
        imported: '已导入「{title}」',
        actionDone: '操作完成',
        refreshed: '已刷新',
      },
      boundary: {
        title: '页面渲染出错',
        desc: '炼本工作台页面遇到未预期的错误，请刷新页面或改用诊断视图查看状态。',
        reload: '刷新页面',
      },
      job: {
        title: '前置任务',
        queued: '排队中',
        running: '运行中',
        succeeded: '已完成',
        failed: '失败',
        cancelled: '已取消',
        needsConfirm: '待确认',
        interrupted: '已中断',
        phase: '阶段',
        episodes: '集进度',
        percent: '进度',
        elapsed: '耗时',
        startedAt: '开始于 {time}',
        cancel: '取消任务',
        cancelConfirm: '确认取消当前前置任务？已完成阶段的产物会保留，可稍后重跑。',
        viewProgress: '查看进度',
        failureKind: {
          word_locked: '输出文件被占用',
          budget: '预算超限',
        },
        noJob: '暂无任务',
        kindImport: '导入并前置质检',
        kindRerun: '重跑前置质检',
      },
      progress: {
        title: '前置质检进度',
        subtitle: '异步任务运行中；关闭页面不会中断 Host 任务，重新打开可继续查看。',
        connectionOpen: 'SSE 已连接',
        connectionRetry: 'SSE 重连中…',
        connectionPolling: '已降级为轮询',
        connectionClosed: '连接已关闭',
        log: '日志',
        logEmpty: '暂无日志',
        doneTitle: '前置质检完成',
        doneDesc: '{eps} 集 · 用时 {duration}',
        failedTitle: '前置质检失败',
        cancelledTitle: '任务已取消',
        needsConfirmTitle: '识别结果需要确认',
        needsConfirmDesc: '检测置信度不足或集数异常。请检查源 docx 的集标题/场次格式后重新导入。',
        interruptedDesc: '任务已中断（页面刷新或 Host 重启）。可重新导入，或在项目详情中重跑前置。',
        detection: '识别详情',
        openProject: '打开项目',
        reimport: '重新导入',
        back: '返回',
        retry: '重新导入',
        phaseLabel: {
          extract: '抽取',
          detect: '识别',
          split: '拆分',
          normalize: '标准化',
          protagonist: '主角',
          checks: '五检',
          report: '报告',
          prepare: '准备',
          plan: '规划',
          plan_check: '规划校验',
          correction: '轻度纠正',
          ledger: '台词台账',
          write: '逐集写作',
          check: '机检',
          retry: '重试',
          merge: '合并',
          writeback: '回写',
          audit: '终检',
          architect: '总纲',
          qc: '质检',
          build: '构建',
        },
      },
      findings: {
        title: '问题定位',
        none: '本集无问题项',
        check: '检查',
        severity: '级别',
        location: '位置',
        paragraph: '段落',
        line: '行',
        snippet: '片段',
        suggestion: '建议',
        mustFix: '必须修复',
        suspected: '疑似',
        risk: '风险',
        blocked: '阻塞',
        info: '提示',
        kindCoverage: '主角覆盖',
        kindAtomPacing: '连续动作',
        kindDialogueDensity: '台词密度',
        kindEpisode: '整集',
        kindDialogueText: '台词',
        kindOther: '其他',
        more: '还有 {n} 条',
      },
      options: {
        title: '项目配置',
        subtitle: '修改检查阈值与豁免词表；保存后需重跑前置质检才会生效。',
        general: '词数与豁免',
        minWords: '英文台词词数下限',
        maxWords: '英文台词词数上限',
        forbidCn: '禁止中式元素',
        allowedTerms: '豁免词表（每行或用逗号分隔）',
        pacing: '节奏覆盖（留空即用引擎默认阈值）',
        maxAtomRun: '连续 △ 上限',
        maxAtomsPerSpoken: '△ 与台词比上限',
        maxSpokenRun: '连续对白上限',
        save: '保存配置',
        saving: '保存中…',
        saved: '配置已保存',
        requiresRerun: '配置已保存，需重跑前置质检后生效',
        rerunNow: '立即重跑前置',
        reset: '重置为当前值',
        invalid: '配置不合法：{reason}',
        invalidNumber: '请输入有效数字',
        minMax: '词数下限必须小于上限',
        readonlyHint: '这些值写入项目 project.json 的 options；引擎按项目级配置执行。',
        engine: '生效引擎',
        profileSource: '检查配置来源',
        effectiveProfile: '生效阈值',
        back: '返回项目',
      },
      tab: {
        preflight: '前置质检',
        refine: '炼本',
        live: '实时输出',
        bgm: '配乐',
      },
      refine: {
        title: '炼本（director）',
        subtitle: '规则注入 → 逐集写作 → check_ep 门禁 → 重试 → 合并/回写/终检/报告。',
        state: {
          idle: '未开始',
          pending: '待开始',
          running: '运行中',
          paused: '已暂停',
          done: '已完成',
          succeeded: '已完成',
          partial: '部分完成',
          failed: '失败',
          cancelled: '已取消',
          blocked: '有阻塞',
          needs_confirm: '待处理',
        },
        start: '开始炼本',
        startSample: '小样本集号（可选，逗号分隔，如 1,2,3 或 3-5）',
        concurrency: '并发数',
        startHint: '留空＝全部可炼本集；需先完成前置质检，blocked 集不参与。建议先跑 2–3 集校准。',
        retryEpisode: '重跑本集',
        retryFailed: '重跑失败/问题集',
        refresh: '刷新炼本详情',
        tokenTitle: 'Token 账本',
        tokenInput: '输入',
        tokenOutput: '输出',
        tokenCacheRead: '缓存读',
        tokenTotal: '合计',
        wave: '波次',
        elapsed: '耗时',
        artifacts: '产物',
        artifactDirector: '导演执行版',
        artifactQc: '质检报告',
        artifactSummary: '总修改说明',
        artifactMissing: '产物尚未生成',
        download: '下载',
        draftTitle: '单集草稿与机检',
        draftLoading: '正在加载草稿…',
        draftEmpty: '该集暂无草稿',
        draftSource: '草稿正文（work/draft）',
        draftCheck: '机检结果',
        draftNotes: '修改说明',
        viewDraft: '查看草稿',
        closeDraft: '收起草稿',
        colEp: '集',
        colTitle: '标题',
        colState: '状态',
        colAttempts: '尝试',
        colReason: '失败原因',
        colArtifacts: '产物',
        colActions: '操作',
        colTokens: 'Tokens',
        noEpisodes: '暂无可炼集',
        noEpisodesDesc: '请先完成前置质检；blocked 集不会被炼本。',
        needsPreflight: '需先完成前置质检后才能开始炼本。',
        busy: '炼本进行中…',
        started: '已开始炼本任务',
        loadFailed: '炼本详情加载失败：{reason}',
        counts: {
          pending: '待跑',
          running: '运行中',
          passed: '通过',
          issues: '有问题',
          blocked: '阻塞',
          failed: '失败',
        },
        epState: {
          pending: '待跑',
          running: '运行中',
          passed: '通过',
          'passed-with-issues': '有问题通过',
          failed: '失败',
          blocked: '阻塞',
        },
        passRate: 'check_ep 一次通过率 {pct}%',
        epArtifact: {
          draft: '草稿',
          report: '报告',
          notes: '说明',
        },
        jobKind: '炼本任务',
        doneTitle: '炼本完成',
        progressTitle: '炼本进度',
        costTitle: '实时成本',
        costTotal: '成本',
        costInput: '输入',
        costCacheRead: '缓存读',
        costOutput: '输出',
        costCalls: '{n} 次调用',
        costEstimate: '估算',
        costNote: '按每次模型调用结束时的系统时间计价；00:30–08:30 空闲价，其余高峰价。',
        costRates: '单价（CNY/百万 tokens）：输入 ¥{miss}（缓存 ¥{hit}）· 输出 ¥{out}',
        tariffPeak: '高峰',
        tariffIdle: '空闲',
        tariffNow: '当前{tariff}价 · 北京时间 {time}',
      },
      live: {
        title: '实时输出',
        subtitle: 'director 逐集流式输出；并发多集按 EP 分桶显示，成本按调用实时累计。',
        followLatest: '跟随最新',
        following: '当前跟随',
        thinking: '模型推理中…',
        waiting: '等待流式输出…',
        completed: '已完成',
        streaming: '输出中',
        attempt: '第 {n} 次',
        chars: '{n} 字符',
        promptChars: '提示 {n} 字符',
        scrollBottom: '回到底部',
        pausedScroll: '已暂停自动滚动',
        consoleTitle: '实时输出',
        noJob: '当前没有运行中的炼本任务',
        latestDraft: '最近完成集草稿',
        runSummary: '运行摘要',
        loadFailed: '实时输出加载失败：{reason}',
        loading: '正在加载实时状态…',
        connectionOpen: '已连接',
        connectionRetry: '重连中…',
        connectionPolling: '轮询模式',
        connectionClosed: '已断开',
        draftEmpty: '该集暂无草稿内容',
        epLabel: 'EP{ep}',
        episodes: '集进度',
        phase: '阶段',
        elapsed: '耗时',
        historyHint: '无运行任务：显示最近完成集草稿与运行摘要。',
      },
      bgm: {
        title: '配乐（BGM）',
        subtitle: '配乐方案：系列总纲 → 逐集四行三段式 → 机检/QC → 合并/导出/终检/报告。',
        jobTitle: '配乐任务状态',
        jobKind: '配乐任务',
        start: '开始配乐',
        startSample: '小样本集号',
        concurrency: '并发数',
        startHint: '留空＝全部可配乐集；需先完成前置（2.0）或炼本（1.0），blocked 集不参与。建议先跑 2–3 集校准。',
        needsRefine: '需先完成前置（2.0）或炼本（1.0）后才能开始配乐。',
        started: '已开始配乐任务',
        refresh: '刷新配乐',
        terminalFailed: '配乐失败',
        noJob: '暂无配乐任务',
        noJobDesc: '设置小样本集号/并发后点击「开始配乐」；完成后结果会保留在本页。',
        countsTitle: '逐集状态计数',
        episodesTitle: '逐集配乐状态',
        artifactsTitle: '配乐产物',
        retryFailed: '重跑失败集',
        retryEpisode: '重跑本集',
        viewDraft: '查看草案',
        closeDraft: '收起',
        draftTitle: '单集配乐草案',
        draftEmpty: '该集暂无配乐草案',
        draftCheck: '机检结果',
        draftQc: 'QC 结论',
        draftReport: '写作报告',
        artifactMissing: '产物尚未生成（配乐完成后出现）',
        assetEmpty: '内容为空',
        viewSeriesBible: '查看 Series Bible',
        viewThemeMap: '查看 Theme Map',
        seriesBible: 'Series Bible',
        themeMap: 'Theme Map',
        loadFailed: '配乐详情加载失败：{reason}',
        noEpisodes: '暂无配乐集',
        noEpisodesDesc: '需先完成前置（2.0）或炼本（1.0）；blocked 集不参与配乐。',
        historyEp: '最近完成集输出',
        colTitle: '标题',
        colState: '状态',
        colAttempts: '尝试',
        colCheck: '机检',
        colQc: 'QC',
        colTokens: 'Tokens',
        colCost: '成本',
        colArtifacts: '产物',
        colActions: '操作',
        epState: {
          pending: '待跑',
          writing: '写作中',
          machine_checking: '机检中',
          qc_pending: '待质检',
          qc_running: '质检中',
          passed: '通过',
          retry_wait: '等待重试',
          failed: '失败',
        },
        role: {
          architect: '总纲',
          worker: '逐集写作',
          qc: '质检',
          auditor: '终检',
          model: '模型',
        },
        artifact: {
          plan: '配乐方案',
          audit: '配乐终检报告',
        },
        epArtifact: {
          bgm: '配乐方案',
          report: '报告',
          check: '机检',
        },
      },
      budget: {
        title: 'Token 预算',
        normal: '正常',
        warning: '接近上限',
        exceeded: '预算超限',
        stage: '阶段：{stage}',
        spentLine: '已用 {spent} / {limit} tokens',
        exceededDesc: '预算上限 {limit} tokens 已用尽，任务已停止；已完成产物保留可下载。',
      },
      needsConfirm: {
        budgetTitle: '预算超限，已停止',
        wordLockedTitle: '输出文件被占用',
        budget: 'Token 预算超限，任务已停止；已完成产物保留。',
        wordLocked: '输出 docx 被 Word/WPS 占用，关闭后重试。',
        retry: '重试',
        keepArtifacts: '已完成集与产物已保留。',
      },
      migrate: {
        open: '迁移旧项目',
        title: '迁移旧项目',
        desc: '把旧工程目录迁移到当前项目库（默认 lianben-projects）。',
        source: '旧项目路径',
        sourcePlaceholder: 'C:\\path\\to\\old-project',
        titleField: '标题（可选）',
        titlePlaceholder: '留空则沿用旧目录名',
        submit: '开始迁移',
        submitting: '迁移中…',
        failed: '迁移失败：{reason}',
        success: '已迁移：{title}',
        close: '关闭',
      },
      merge: {
        title: '按建议合并（连续 △）',
        refresh: '刷新建议',
        badgeDeterministic: '确定性 · 0 token',
        badgeZeroToken: '0 token',
        noteDeterministic: '确定性规则合并：同一输入结果可复现，不调用模型。',
        noteZeroToken: '0 token、0 成本：只做文本行合并。',
        noteScope: '只合并连续的 △ 动作行；台词与事实不变。',
        noteRestore: '合并前原文自动备份到 work/merge/original，可一键恢复。',
        sumTotal: '可合并集',
        sumRecommended: '建议集',
        sumMerged: '已合并集',
        sumRuns: '合并点',
        sumAtoms: '合并前 △ 行',
        selectTitle: '选择要合并的集',
        noSuggestions: '当前没有可合并的集。',
        atoms: '△ 行',
        runs: '合并点',
        recommendedBadge: '建议合并',
        mergedBadge: '已合并',
        selectedCount: '已选 {n} 集',
        noSelection: '请勾选至少一集可合并的集。',
        preview: '预览合并',
        previewing: '预览中…',
        previewTitle: '合并预览',
        previewSummary: '合计 △ {before} → {after}，减少 {removed} 行',
        previewEpLine: '△ {before} → {after}（减少 {removed}）· 合并点 {targets}',
        targetMeta: '位置 {start} · 连续 {n} 行',
        beforeLabel: '合并前',
        afterLabel: '合并后',
        apply: '应用合并',
        applying: '应用中…',
        applyConfirm: '确认应用合并？将改写所选集源文件（已自动备份，可恢复），并把前置报告标记为过期。',
        confirmApply: '确认应用合并',
        restore: '恢复合并前原文',
        restoring: '恢复中…',
        restoreConfirm: '确认恢复合并前原文？合并后的源稿将被备份覆盖。',
        confirmRestore: '确认恢复',
        appliedToast: '已合并 {n} 集（0 token，确定性）',
        restoredToast: '已恢复合并前原文',
        staleWarning: '合并已应用：前置报告仍是合并前基线；炼本读取的是合并后的源稿。',
        rerunBlocked: '项目源稿已按建议合并；请先在前置检查点「恢复合并前原文」再重跑前置检查。',
        failed: '合并操作失败：{reason}',
        loadFailed: '合并建议加载失败：{reason}',
        llmToggle: '使用 LLM 优化合并（可选，默认关闭）',
        llmOnBadge: 'LLM 已开启',
        llmOffBadge: '确定性合并',
        llmWarning: '已开启 LLM 优化：会调用模型并产生额外 token 费用；默认关闭。',
        llmNote: '只优化所选集的连续 △ 段；台词与事实不预设改动，应用前请核对预览。',
        llmModelLine: '模型：{model} · 一次最多 {max} 集；超出请分批或改用确定性合并。',
        llmCostLine: '费用：按实际模型用量另计；生成预览时产生，应用不会再次调用模型。',
        llmNoAuto: 'LLM 不会自动执行：必须先生成预览并二次确认应用。',
        llmScope: '预览不会写入源稿；应用使用该预览结果，可随时恢复合并前原文。',
        llmTooMany: 'LLM 优化一次最多 {n} 集（当前已选 {selected} 集）；请减少选集或改用确定性合并。',
        previewBlocked: '预览合并（需先减少到 {n} 集内）',
        deterministicAll: '关闭 LLM，改用确定性合并',
        llmUnavailable: '当前环境 LLM 不可用，请使用确定性合并。',
        llmPreviewBadge: 'LLM 优化预览',
        llmModel: '模型',
        llmCalls: '调用次数',
        llmTokens: 'tokens',
        llmCost: '费用',
        llmCoverage: 'EP{ep} 字符覆盖 {pct}%',
        llmEpCoverage: 'EP{ep} 字符覆盖 {pct}%',
        llmPreviewNoWrite: 'LLM 预览未写入源稿；应用将直接使用该预览结果，不会重新调用模型。',
        llmPreviewId: '预览 ID：{id}',
        llmNeedPreview: '请先生成 LLM 预览，再应用。',
        llmWarningsTitle: 'LLM 覆盖/保真警告',
        applyConfirmLlm: '确认应用 LLM 合并预览？将改写所选集源文件（已自动备份，可恢复），并把前置报告标记为过期；不会再次调用模型。',
        noPreview: '请先生成预览，再应用。',
        batchPreview: '批量合并（全部 {n} 集）',
        batchPreviewing: '批量预览中…',
        batchProgress: '批量预览：第 {batch}/{total} 批 · 已处理 {processed}/{count} 集',
        batchFailed: '批量预览失败：第 {batch}/{total} 批 — {reason}；未写入源稿，可重试。',
        batchMissingId: '该批预览未返回 previewId',
        batchNeedPreview: '请先生成批量预览，再应用。',
        batchPreviewBadge: 'LLM 批量预览',
        batchPreviewNoWrite: '批量预览未写入源稿；应用会一次合并所有批次并一次写入，可一次恢复。',
        batchChunks: '共 {n} 批预览',
        applyConfirmBatch: '确认应用全部 {n} 批 LLM 预览？将一次写入所选集源稿（已自动备份，可一次恢复），并把前置报告标记为过期；不会再次调用模型。',
        batchAppliedToast: '已合并 {n} 集（{batches} 批 LLM 预览）',
      },
      mode: {
        switchLabel: '项目模式',
        name1: '1.0 解说剧',
        name2: '2.0 演绎剧',
        badge1: '1.0',
        badge2: '2.0',
        hint1: '当前：1.0 解说剧（弱质检 + director 逐集写作）。',
        hint2: '当前：2.0 演绎剧（竖屏分镜 + 台词台账 + 轻度 LLM 纠正）；配乐适配中。',
        switched: '已切换到 {mode}',
        switchFailed: '模式切换失败：{reason}',
        tabRefine2: '分镜演绎',
        stageRefine2: '分镜',
        stageBgm2: '配乐',
        bgmTitle: '2.0 配乐',
        bgmBadge: '适配中',
        bgmUnavailable: '2.0 配乐已启用：基于 2.0 前置后的 work/source 生成，使用 2.0 配乐规则包。',
        ledgerTitle: '台词台账',
        ledgerReady: '已就绪',
        ledgerUnavailableBadge: '未启用',
        ledgerUnavailable: '当前没有台词台账数据（2.0 导入/前置后生成）。',
        ledgerLines: '台词行',
        ledgerTagged: '已标注',
        ledgerUntagged: '未标注',
        ledgerDesc: '台账用于对账台词与分镜：未标注行会在对账阶段提示。',
        correctionTitle: '轻度 LLM 纠正',
        correctionOn: '已启用',
        correctionOff: '未启用',
        correctionDone: '已完成',
        correctionSkipped: '已跳过',
        correctionFailed: '失败',
        correctionUnknown: '未知',
        correctionCalls: '调用次数',
        correctionEpisodes: '纠正集数',
        correctionLimit: '上限',
        correctionLimitValue: '最多 {n} 集 / {calls} 次',
        correctionLimitPerEpisode: '每集最多 {calls} 次（不限集数）',
        correctionDesc: '仅对高置信度问题做轻度纠正，不会改写台词内容。',
        correctionScope: '范围：导入开关默认关闭；开启后不限集数，每集最多 2 次；其余问题保留在弱质检报告中。',
        correctionEnable: '启用轻度纠正',
        correctionDisable: '关闭轻度纠正',
        correctionToggleHint: '修改后需重新运行前置检查才生效（只影响后续 2.0 前置）。',
      },
      story: {
        title: '竖屏分镜演绎',
        subtitle: '2.0 流程：planner 拆镜 → 规划校验 → writer 写分镜 → 机检/对账 → 审计 → 合并/构建/报告。',
        jobKind: '竖屏分镜任务',
        refresh: '刷新分镜',
        start: '开始分镜演绎',
        startSample: '小样本集号',
        concurrency: '并发数',
        started: '已开始竖屏分镜任务',
        retryFailed: '重跑失败集',
        retryEpisode: '重跑本集',
        retryLast: '重试上次参数',
        attempts: '尝试',
        failedHint: '任务失败：{reason}',
        loadFailed: '分镜数据加载失败：{reason}',
        summaryTitle: '分镜摘要',
        sumTotal: '总集数',
        sumPlanned: '已规划',
        sumWritten: '已写作',
        sumPassed: '已通过',
        sumFailed: '失败',
        episodesTitle: '逐集分镜状态',
        noEpisodes: '暂无分镜集',
        noEpisodesDesc: '2.0 项目在开始分镜演绎后产生 planner/writer 逐集数据。',
        colTitle: '标题',
        colPlanner: 'Planner',
        colWriter: 'Writer',
        colRetry: '重试',
        colCheck: '机检',
        colAudit: '对账/审计',
        colTokens: 'Tokens',
        colCost: '成本',
        colArtifacts: '产物',
        colActions: '操作',
        artifactsTitle: '分镜产物',
        artifact: {
          storyboard: '竖屏分镜稿',
          dialogueAudit: '台词对账',
          plan: '分镜规划',
          check: '机检',
        },
        stage: {
          pending: '待跑',
          planned: '已规划',
          planning: '规划中',
          plan_check: '规划校验',
          running: '运行中',
          writing: '写作中',
          checking: '机检中',
          auditing: '审计中',
          retry_wait: '等待重试',
          passed: '通过',
          done: '完成',
          succeeded: '成功',
          failed: '失败',
          blocked: '阻塞',
          issues: '有问题',
        },
      },
    }

    const EN = {
      panel: { label: 'Lianben Workbench' },
      app: {
        title: 'Lianben Workbench',
        subtitle: 'Preflight + refine pipeline · M3',
      },
      nav: {
        refresh: 'Refresh',
        import: 'Import script',
        settings: 'Settings',
        diagnostics: 'Diagnostics',
        back: 'Back to projects',
      },
      common: {
        loading: 'Loading…',
        retry: 'Retry',
        cancel: 'Cancel',
        confirm: 'Confirm',
        close: 'Close',
        empty: 'No data',
        yes: 'Yes',
        no: 'No',
        unknown: 'Unknown',
        copyHint: 'Raw data',
      },
      error: {
        network: 'Network request failed. Check your connection and retry.',
        auth: 'Session expired or not permitted. Refresh the page and retry.',
        notFound: 'The requested resource was not found.',
        server: 'The host failed to handle the request. See diagnostics.',
        badInput: 'Invalid input: {reason}',
        generic: 'Operation failed: {reason}',
        code: 'Error code: {code}',
      },
      library: {
        title: 'Projects',
        subtitle: 'Import a .docx script; format detection, splitting and the five zero-token checks run automatically.',
        emptyTitle: 'No projects yet',
        emptyDesc: 'Import a .docx script to start. Detection, splitting and the five machine checks are fully automatic.',
        emptyAction: 'Import script',
        loading: 'Loading projects…',
        count: '{n} projects',
        refresh: 'Refresh',
        searchPlaceholder: 'Search projects by title',
        sortLabel: 'Sort',
        sortUpdated: 'Updated',
        sortTitle: 'Title',
        sortEpisodes: 'Episodes',
        searchEmpty: 'No matching projects',
        jobRunning: 'Job running: {phase}',
        jobFailed: 'Last job failed',
        jobNeedsConfirm: 'Detection needs review',
        jobCancelled: 'Last job cancelled',
        jobInterrupted: 'Last job interrupted',
      },
      card: {
        episodes: '{n} episodes',
        cjk: '{n} chars',
        blocked: '{n} blocked',
        noBlocked: 'No blocked episodes',
        updated: 'Updated {time}',
        open: 'Open',
        checks: 'Check summary',
      },
      check: {
        spokenWords: 'Words',
        punctuation: 'Punctuation',
        pacing: 'Pacing',
        protagonist: 'Protagonist',
        culture: 'Culture',
        ok: 'OK',
        risk: 'Risk',
        blocked: 'Blocked',
        na: '—',
        pending: 'Pending',
      },
      status: {
        preflight_done: 'Preflight done',
        preflight_failed: 'Preflight failed',
        preflight_running: 'Preflight running',
        importing: 'Importing',
        needs_confirm: 'Needs review',
        new: 'New',
        unknown: 'Unknown',
        ok: 'OK',
        risk: 'RISK',
        blocked: 'BLOCKED',
        skip: 'SKIP',
        refine_done: 'Refine done',
        refine_partial: 'Refine partial',
        refine_failed: 'Refine failed',
        refine_cancelled: 'Refine cancelled',
        refine_running: 'Refine running',
      },
      import: {
        title: 'Import script',
        subtitle: 'Upload raw .docx bytes; the host streams it to disk and runs the zero-token preflight immediately.',
        correctionToggle: 'Enable light LLM correction (default off)',
        correctionDesc: '2.0 staged drama only: at most 2 correction calls per episode, unlimited episodes; dialogue-lock audit failures roll back. Off by default; enable before import.',
        drop: 'Drop a .docx here, or click to choose a file',
        hint: 'Only .docx; up to 64 MiB. The file name becomes the project title.',
        choose: 'Choose file',
        uploading: 'Uploading and running preflight: {pct}%',
        processing: 'Upload finished, running preflight…',
        success: 'Imported: {title}',
        invalidExt: 'Only .docx files are supported.',
        tooLarge: 'File exceeds the 64 MiB limit.',
        empty: 'The file is empty; choose another file.',
        failed: 'Import failed: {reason}',
        retry: 'Retry',
        back: 'Back to projects',
        done: 'Open project',
        needsConfirmHelp: 'Low detection confidence or ambiguous episode boundaries. Check the .docx episode headings and scene format, then import again.',
      },
      project: {
        stage: {
          import: 'Import',
          preflight: 'Preflight',
          refine: 'Refine',
          bgm: 'BGM',
          notAvailable: 'M4 not available',
        },
        overview: 'Overview',
        checks: 'Check matrix',
        episodes: 'Episodes',
        report: 'Preflight report',
        settingsAction: 'Project options',
        actions: 'Actions',
        refresh: 'Refresh snapshot',
        back: 'Back to projects',
        rerun: 'Re-run preflight',
        archive: 'Archive',
        delete: 'Delete',
        rerunConfirm: 'Re-running archives the current work/ first, then detects, splits and checks again. Continue?',
        archiveConfirm: 'Archiving moves the project directory into projectsRoot/.archive and removes it from the library. Continue?',
        deleteConfirm: 'Deleting permanently removes the project directory. This cannot be undone. Continue?',
        actionsBusy: 'Operation in progress…',
        reportLoading: 'Loading report…',
        reportEmpty: 'No report yet.',
        reportMissing: 'Preflight report file not found.',
        reportError: 'Failed to load the report: {reason}',
        noEpisodes: 'No episodes to show',
        noEpisodesDesc: 'This project has no preflight results yet.',
        epDetail: 'Episode details',
        epDetailLoading: 'Loading episode…',
        epSource: 'Standardized source (work/source)',
        epChecksTitle: 'Episode checks',
        created: 'Created {time}',
        updated: 'Updated {time}',
        id: 'Project ID',
        engine: 'Engine version',
        duration: 'Preflight duration',
        sourceName: 'Source file',
        preflightStatus: 'Preflight status',
        blockedEps: 'Blocked episodes: {eps}',
        reportGenerated: 'Report available',
        reportNotGenerated: 'No report',
      },
      matrix: {
        title: 'Five machine checks',
        check: 'Check',
        state: 'Result',
        riskEps: 'Risky eps',
        none: 'No risks',
        hint: 'The five machine checks only report issues and never rewrite your script. Only a weak protagonist presence blocks an episode.',
        aiUsed: 'No AI involved',
      },
      table: {
        ep: 'Ep',
        title: 'Title',
        status: 'Status',
        words: 'Words',
        punct: 'Punct',
        pacing: 'Pacing',
        protagonist: 'Lead',
        culture: 'Culture',
        cjk: 'Words',
        blocked: 'Blocked',
        detail: 'Details',
        expand: 'Expand',
        collapse: 'Collapse',
        filterLabel: 'Filter',
        filterAll: 'All',
        filterBlocked: 'Blocked only',
        filterRisk: 'Status RISK',
        filterCheckRisk: 'Checks with issues',
        jumpLabel: 'Go to episode',
        jumpGo: 'Go',
        pageInfo: 'Page {page}/{pages}',
        prev: 'Previous',
        next: 'Next',
        noMatch: 'No matching episodes',
      },
      stats: {
        episodes: 'Episodes',
        cjk: 'Total CJK',
        scenes: 'Scenes',
        dialogues: 'Dialogue lines',
        atoms: '△ lines',
        blocked: 'Blocked',
        duration: 'Preflight time',
      },
      settings: {
        title: 'Settings',
        subtitle: 'M2 project root and runtime (read-only here; per-project options are edited from the project page).',
        projectsRoot: 'Projects root',
        python: 'Hosted Python',
        engine: 'Preflight engine',
        workspace: 'Workspace',
        bundle: 'Bundle version',
        readonlyNote: 'M2 per-project check options live under "Project details → Project options"; change projectsRoot / pythonPath in the plugin config in cordis.patch.yml.',
        back: 'Back to projects',
        available: 'Available',
        unavailable: 'Unavailable',
      },
      diag: {
        title: 'Diagnostics',
        subtitle: 'Host health and M2 self-check (Python / engine / 20-episode fixture acceptance).',
        health: 'Health',
        selfcheck: 'Host self-check',
        loadHealth: 'Refresh health',
        loadSelfcheck: 'Read host self-check',
        runSelfcheck: 'Run host self-check',
        routes: 'Registered routes',
        raw: 'Raw data',
        back: 'Back to projects',
        loading: 'Loading…',
        selfcheckHint: '"Run host self-check" executes the Python engine over the 20-episode fixture; it can take a while.',
        failed: 'Load failed: {reason}',
      },
      toast: {
        imported: 'Imported "{title}"',
        actionDone: 'Done',
        refreshed: 'Refreshed',
      },
      boundary: {
        title: 'Page render error',
        desc: 'The workbench hit an unexpected render error. Reload the page or open diagnostics.',
        reload: 'Reload page',
      },
      job: {
        title: 'Preflight job',
        queued: 'Queued',
        running: 'Running',
        succeeded: 'Done',
        failed: 'Failed',
        cancelled: 'Cancelled',
        needsConfirm: 'Needs review',
        interrupted: 'Interrupted',
        phase: 'Phase',
        episodes: 'Episodes',
        percent: 'Progress',
        elapsed: 'Elapsed',
        startedAt: 'Started {time}',
        cancel: 'Cancel job',
        cancelConfirm: 'Cancel the current preflight job? Products from finished phases are kept and you can rerun later.',
        viewProgress: 'View progress',
        failureKind: {
          word_locked: 'Output file busy',
          budget: 'Budget exceeded',
        },
        noJob: 'No job',
        kindImport: 'Import + preflight',
        kindRerun: 'Re-run preflight',
      },
      progress: {
        title: 'Preflight progress',
        subtitle: 'Async job running. Closing the page does not stop the host job; reopen to resume watching.',
        connectionOpen: 'SSE connected',
        connectionRetry: 'SSE reconnecting…',
        connectionPolling: 'Fell back to polling',
        connectionClosed: 'Connection closed',
        log: 'Log',
        logEmpty: 'No log yet',
        doneTitle: 'Preflight finished',
        doneDesc: '{eps} episodes · {duration}',
        failedTitle: 'Preflight failed',
        cancelledTitle: 'Job cancelled',
        needsConfirmTitle: 'Detection needs review',
        needsConfirmDesc: 'Confidence is too low or the episode count looks wrong. Check the .docx episode-heading/scene format and import it again.',
        interruptedDesc: 'The job was interrupted (page refresh or host restart). Import again, or re-run preflight from the project.',
        detection: 'Detection details',
        openProject: 'Open project',
        reimport: 'Import again',
        back: 'Back',
        retry: 'Import again',
        phaseLabel: {
          extract: 'Extract',
          detect: 'Detect',
          split: 'Split',
          normalize: 'Normalize',
          protagonist: 'Protagonist',
          checks: 'Checks',
          report: 'Report',
          prepare: 'Prepare',
          plan: 'Plan',
          plan_check: 'Plan check',
          correction: 'Correction',
          ledger: 'Dialogue ledger',
          write: 'Write',
          check: 'Check',
          retry: 'Retry',
          merge: 'Merge',
          writeback: 'Writeback',
          audit: 'Audit',
          architect: 'Architect',
          qc: 'QC',
          build: 'Build',
        },
      },
      findings: {
        title: 'Findings',
        none: 'No findings for this episode',
        check: 'Check',
        severity: 'Severity',
        location: 'Location',
        paragraph: 'Paragraph',
        line: 'Line',
        snippet: 'Snippet',
        suggestion: 'Suggestion',
        mustFix: 'Must fix',
        suspected: 'Suspected',
        risk: 'Risk',
        blocked: 'Blocked',
        info: 'Info',
        kindCoverage: 'Protagonist coverage',
        kindAtomPacing: 'Consecutive action',
        kindDialogueDensity: 'Dialogue density',
        kindEpisode: 'Whole episode',
        kindDialogueText: 'Dialogue',
        kindOther: 'Other',
        more: '{n} more',
      },
      options: {
        title: 'Project options',
        subtitle: 'Edit check thresholds and allowed terms. Re-run preflight to apply them.',
        general: 'Words and exemptions',
        minWords: 'Spoken-word minimum',
        maxWords: 'Spoken-word maximum',
        forbidCn: 'Forbid Chinese elements',
        allowedTerms: 'Allowed terms (one per line or comma-separated)',
        pacing: 'Pacing overrides (leave empty for engine defaults)',
        maxAtomRun: 'Max consecutive △ lines',
        maxAtomsPerSpoken: 'Max △ to dialogue ratio',
        maxSpokenRun: 'Max consecutive dialogue lines',
        save: 'Save options',
        saving: 'Saving…',
        saved: 'Options saved',
        requiresRerun: 'Options saved; re-run preflight to apply',
        rerunNow: 'Re-run preflight now',
        reset: 'Reset to current',
        invalid: 'Invalid options: {reason}',
        invalidNumber: 'Enter a valid number',
        minMax: 'Minimum must be lower than maximum',
        readonlyHint: 'These values are written into the project project.json options; the engine applies project-level overrides.',
        engine: 'Active engine',
        profileSource: 'Check profile source',
        effectiveProfile: 'Effective thresholds',
        back: 'Back to project',
      },
      tab: {
        preflight: 'Preflight',
        refine: 'Refine',
        live: 'Live output',
        bgm: 'BGM',
      },
      refine: {
        title: 'Refine (director)',
        subtitle: 'Rule injection → per-episode writing → check_ep gate → retry → merge/writeback/audit/report.',
        state: {
          idle: 'Not started',
          pending: 'Pending',
          running: 'Running',
          paused: 'Paused',
          done: 'Done',
          succeeded: 'Done',
          partial: 'Partial',
          failed: 'Failed',
          cancelled: 'Cancelled',
          blocked: 'Blocked',
          needs_confirm: 'Needs review',
        },
        start: 'Start refine',
        startSample: 'Sample episodes (optional, comma separated, e.g. 1,2,3 or 3-5)',
        concurrency: 'Concurrency',
        startHint: 'Empty = all refinable episodes (preflight blocked episodes are skipped). Run 2–3 episodes first to calibrate quality and cost.',
        retryEpisode: 'Re-run episode',
        retryFailed: 'Re-run failed/issue episodes',
        refresh: 'Refresh refine',
        tokenTitle: 'Token ledger',
        tokenInput: 'Input',
        tokenOutput: 'Output',
        tokenCacheRead: 'Cache read',
        tokenTotal: 'Total',
        wave: 'Wave',
        elapsed: 'Elapsed',
        artifacts: 'Artifacts',
        artifactDirector: 'Director cut',
        artifactQc: 'QC report',
        artifactSummary: 'Production summary',
        artifactMissing: 'No artifacts yet',
        download: 'Download',
        draftTitle: 'Episode draft & check',
        draftLoading: 'Loading draft…',
        draftEmpty: 'No draft for this episode',
        draftSource: 'Draft body (work/draft)',
        draftCheck: 'Check result',
        draftNotes: 'Production notes',
        viewDraft: 'View draft',
        closeDraft: 'Hide draft',
        colEp: 'Ep',
        colTitle: 'Title',
        colState: 'State',
        colAttempts: 'Tries',
        colReason: 'Failure reason',
        colArtifacts: 'Artifacts',
        colActions: 'Actions',
        colTokens: 'Tokens',
        noEpisodes: 'No refinable episodes',
        noEpisodesDesc: 'Finish preflight first; blocked episodes are never refined.',
        needsPreflight: 'Preflight must finish before refine can start.',
        busy: 'Refine is running…',
        started: 'Refine job started',
        loadFailed: 'Failed to load refine details: {reason}',
        counts: {
          pending: 'Pending',
          running: 'Running',
          passed: 'Passed',
          issues: 'Issues',
          blocked: 'Blocked',
          failed: 'Failed',
        },
        epState: {
          pending: 'Pending',
          running: 'Running',
          passed: 'Passed',
          'passed-with-issues': 'Passed w/ issues',
          failed: 'Failed',
          blocked: 'Blocked',
        },
        passRate: 'check_ep pass rate {pct}%',
        epArtifact: {
          draft: 'Draft',
          report: 'Report',
          notes: 'Notes',
        },
        jobKind: 'Refine job',
        doneTitle: 'Refine finished',
        progressTitle: 'Refine progress',
        costTitle: 'Live cost',
        costTotal: 'Cost',
        costInput: 'Input',
        costCacheRead: 'Cache read',
        costOutput: 'Output',
        costCalls: '{n} calls',
        costEstimate: 'estimate',
        costNote: 'Priced at the system time when each model call finished; 00:30–08:30 is the idle tariff, all other hours are peak.',
        costRates: 'Rate (CNY per million tokens): input ¥{miss} (cache ¥{hit}) · output ¥{out}',
        tariffPeak: 'Peak',
        tariffIdle: 'Idle',
        tariffNow: 'Current {tariff} tariff · Beijing {time}',
      },
      live: {
        title: 'Live output',
        subtitle: 'Director streams per episode; concurrent episodes are bucketed by EP and cost accrues per call in real time.',
        followLatest: 'Follow latest',
        following: 'Following',
        thinking: 'Model is thinking…',
        waiting: 'Waiting for the stream…',
        completed: 'Completed',
        streaming: 'Streaming',
        attempt: 'Attempt {n}',
        chars: '{n} chars',
        promptChars: 'prompt {n} chars',
        scrollBottom: 'Back to bottom',
        pausedScroll: 'Auto-scroll paused',
        consoleTitle: 'Live output',
        noJob: 'No refine job is running',
        latestDraft: 'Latest finished episode draft',
        runSummary: 'Run summary',
        loadFailed: 'Failed to load live state: {reason}',
        loading: 'Loading live state…',
        connectionOpen: 'Connected',
        connectionRetry: 'Reconnecting…',
        connectionPolling: 'Polling',
        connectionClosed: 'Disconnected',
        draftEmpty: 'No draft content for this episode',
        epLabel: 'EP{ep}',
        episodes: 'Episodes',
        phase: 'Phase',
        elapsed: 'Elapsed',
        historyHint: 'No running job: showing the latest finished episode draft and run summary.',
      },
      bgm: {
        title: 'BGM (music plan)',
        subtitle: 'Series bible → per-episode four-line/three-segment plan → machine check/QC → merge/export/final audit/report.',
        jobTitle: 'BGM job status',
        jobKind: 'BGM job',
        start: 'Start BGM',
        startSample: 'Sample episodes',
        concurrency: 'Concurrency',
        startHint: 'Leave empty for all BGM-ready episodes; complete preflight (2.0) or refine (1.0) first. Blocked episodes are skipped. Start with 2–3 episodes for calibration.',
        needsRefine: 'Finish preflight (2.0) or refine (1.0) before starting BGM.',
        started: 'BGM job started',
        refresh: 'Refresh BGM',
        terminalFailed: 'BGM failed',
        noJob: 'No BGM job',
        noJobDesc: 'Set sample episodes/concurrency and click "Start BGM"; the result stays on this tab.',
        countsTitle: 'Episode state counts',
        episodesTitle: 'Episode BGM states',
        artifactsTitle: 'BGM artifacts',
        retryFailed: 'Retry failed episodes',
        retryEpisode: 'Retry episode',
        viewDraft: 'View draft',
        closeDraft: 'Collapse',
        draftTitle: 'Episode BGM draft',
        draftEmpty: 'No BGM draft for this episode',
        draftCheck: 'Machine check',
        draftQc: 'QC verdict',
        draftReport: 'Writing report',
        artifactMissing: 'Artifacts not generated yet (they appear after BGM finishes)',
        assetEmpty: 'Content is empty',
        viewSeriesBible: 'View series bible',
        viewThemeMap: 'View theme map',
        seriesBible: 'Series bible',
        themeMap: 'Theme map',
        loadFailed: 'Failed to load BGM state: {reason}',
        noEpisodes: 'No BGM episodes yet',
        noEpisodesDesc: 'Finish refine first; blocked episodes are skipped.',
        historyEp: 'Latest finished episode output',
        colTitle: 'Title',
        colState: 'State',
        colAttempts: 'Attempts',
        colCheck: 'Check',
        colQc: 'QC',
        colTokens: 'Tokens',
        colCost: 'Cost',
        colArtifacts: 'Artifacts',
        colActions: 'Actions',
        epState: {
          pending: 'Pending',
          writing: 'Writing',
          machine_checking: 'Machine check',
          qc_pending: 'QC pending',
          qc_running: 'QC running',
          passed: 'Passed',
          retry_wait: 'Retry wait',
          failed: 'Failed',
        },
        role: {
          architect: 'Architect',
          worker: 'Writer',
          qc: 'QC',
          auditor: 'Auditor',
          model: 'Model',
        },
        artifact: {
          plan: 'BGM plan',
          audit: 'BGM final audit',
        },
        epArtifact: {
          bgm: 'BGM plan',
          report: 'Report',
          check: 'Check',
        },
      },
      budget: {
        title: 'Token budget',
        normal: 'Normal',
        warning: 'Near limit',
        exceeded: 'Budget exceeded',
        stage: 'Stage: {stage}',
        spentLine: 'Used {spent} / {limit} tokens',
        exceededDesc: 'The {limit}-token budget is exhausted and the job stopped; finished artifacts are kept and downloadable.',
      },
      needsConfirm: {
        budgetTitle: 'Budget exceeded, job stopped',
        wordLockedTitle: 'Output file is busy',
        budget: 'The token budget was exceeded and the job stopped; finished artifacts are kept.',
        wordLocked: 'The output docx is open in Word/WPS. Close it and retry.',
        retry: 'Retry',
        keepArtifacts: 'Finished episodes and artifacts are kept.',
      },
      migrate: {
        open: 'Migrate legacy project',
        title: 'Migrate legacy project',
        desc: 'Migrate an old project directory into the current project library (default: lianben-projects).',
        source: 'Legacy project path',
        sourcePlaceholder: 'C:\\path\\to\\old-project',
        titleField: 'Title (optional)',
        titlePlaceholder: 'Leave empty to reuse the directory name',
        submit: 'Start migration',
        submitting: 'Migrating…',
        failed: 'Migration failed: {reason}',
        success: 'Migrated: {title}',
        close: 'Close',
      },
      merge: {
        title: 'Merge suggestions (consecutive △)',
        refresh: 'Refresh suggestions',
        badgeDeterministic: 'Deterministic · 0 token',
        badgeZeroToken: '0 token',
        noteDeterministic: 'Deterministic rule-based merge: the same input reproduces the same result, no model call.',
        noteZeroToken: '0 token, 0 cost: text-line merge only.',
        noteScope: 'Only consecutive △ action lines are merged; dialogue and facts are unchanged.',
        noteRestore: 'Original sources are backed up to work/merge/original and can be restored anytime.',
        sumTotal: 'Mergeable episodes',
        sumRecommended: 'Recommended',
        sumMerged: 'Merged',
        sumRuns: 'Merge points',
        sumAtoms: '△ lines before',
        selectTitle: 'Select episodes to merge',
        noSuggestions: 'No mergeable episodes right now.',
        atoms: '△ lines',
        runs: 'merge points',
        recommendedBadge: 'Recommended',
        mergedBadge: 'Merged',
        selectedCount: '{n} selected',
        noSelection: 'Select at least one mergeable episode.',
        preview: 'Preview merge',
        previewing: 'Previewing…',
        previewTitle: 'Merge preview',
        previewSummary: 'Total △ {before} → {after}, {removed} lines removed',
        previewEpLine: '△ {before} → {after} ({removed} removed) · {targets} merge points',
        targetMeta: 'at {start} · {n} consecutive lines',
        beforeLabel: 'Before',
        afterLabel: 'After',
        apply: 'Apply merge',
        applying: 'Applying…',
        applyConfirm: 'Apply the merge? Selected source files will be rewritten (backed up and restorable) and the preflight report will be marked stale.',
        confirmApply: 'Confirm apply',
        restore: 'Restore original sources',
        restoring: 'Restoring…',
        restoreConfirm: 'Restore the original sources? The merged sources will be replaced by the backups.',
        confirmRestore: 'Confirm restore',
        appliedToast: 'Merged {n} episode(s) (0 token, deterministic)',
        restoredToast: 'Original sources restored',
        staleWarning: 'Merge applied: the preflight report is still based on the pre-merge baseline; refine reads the merged sources.',
        rerunBlocked: 'The project sources were merged; restore the original sources in Preflight before rerunning preflight.',
        failed: 'Merge action failed: {reason}',
        loadFailed: 'Failed to load merge suggestions: {reason}',
        llmToggle: 'Use LLM to optimize merge (optional, off by default)',
        llmOnBadge: 'LLM on',
        llmOffBadge: 'Deterministic',
        llmWarning: 'LLM optimization is on: it calls the model and incurs extra token cost; off by default.',
        llmNote: 'Only consecutive △ runs of the selected episodes are optimized; dialogue and facts are not presumed to change — review the preview before applying.',
        llmModelLine: 'Model: {model} · up to {max} episodes per run; split larger selections or use deterministic merge.',
        llmCostLine: 'Cost: billed by actual model usage; incurred when generating the preview — applying does not call the model again.',
        llmNoAuto: 'LLM never runs automatically: you must generate a preview and confirm apply.',
        llmScope: 'The preview does not write source files; apply uses that preview and the originals remain restorable.',
        llmTooMany: 'LLM optimization allows at most {n} episodes (currently {selected} selected); reduce the selection or use deterministic merge.',
        previewBlocked: 'Preview merge (reduce to {n} episodes first)',
        deterministicAll: 'Turn off LLM, use deterministic merge',
        llmUnavailable: 'LLM is unavailable in this environment; use deterministic merge.',
        llmPreviewBadge: 'LLM preview',
        llmModel: 'Model',
        llmCalls: 'Calls',
        llmTokens: 'tokens',
        llmCost: 'Cost',
        llmCoverage: 'EP{ep} char coverage {pct}%',
        llmEpCoverage: 'EP{ep} char coverage {pct}%',
        llmPreviewNoWrite: 'The LLM preview did not write source files; apply reuses this preview without calling the model again.',
        llmPreviewId: 'Preview ID: {id}',
        llmNeedPreview: 'Generate an LLM preview before applying.',
        llmWarningsTitle: 'LLM coverage / fidelity warnings',
        applyConfirmLlm: 'Apply this LLM merge preview? Selected source files will be rewritten (backed up and restorable) and preflight is marked stale; the model will not be called again.',
        noPreview: 'Generate a preview before applying.',
        batchPreview: 'Batch merge (all {n} episodes)',
        batchPreviewing: 'Batch previewing…',
        batchProgress: 'Batch preview: batch {batch}/{total} · processed {processed}/{count} episodes',
        batchFailed: 'Batch preview failed at batch {batch}/{total} — {reason}. No source files were written; you can retry.',
        batchMissingId: 'This batch preview did not return a previewId',
        batchNeedPreview: 'Generate a batch preview before applying.',
        batchPreviewBadge: 'LLM batch preview',
        batchPreviewNoWrite: 'The batch preview did not write source files; applying merges every batch and writes sources once, so one restore covers all.',
        batchChunks: '{n} preview batches',
        applyConfirmBatch: 'Apply all {n} LLM preview batches? Selected source files will be written once (backed up and restorable in one step) and preflight is marked stale; the model will not be called again.',
        batchAppliedToast: 'Merged {n} episode(s) ({batches} LLM preview batches)',
      },
      mode: {
        switchLabel: 'Project mode',
        name1: '1.0 Narrated drama',
        name2: '2.0 Staged drama',
        badge1: '1.0',
        badge2: '2.0',
        hint1: 'Current: 1.0 narrated drama (weak QC + per-episode director writing).',
        hint2: 'Current: 2.0 staged drama (vertical storyboard + dialogue ledger + light LLM correction); BGM is being adapted.',
        switched: 'Switched to {mode}',
        switchFailed: 'Mode switch failed: {reason}',
        tabRefine2: 'Storyboard',
        stageRefine2: 'Storyboard',
        stageBgm2: 'BGM',
        bgmTitle: '2.0 BGM',
        bgmBadge: 'Adapting',
        bgmUnavailable: '2.0 BGM is enabled: it uses 2.0 preflight work/source and the 2.0 BGM rule pack.',
        ledgerTitle: 'Dialogue ledger',
        ledgerReady: 'Ready',
        ledgerUnavailableBadge: 'Not enabled',
        ledgerUnavailable: 'No dialogue ledger data yet (generated after 2.0 import/preflight).',
        ledgerLines: 'Dialogue lines',
        ledgerTagged: 'Tagged',
        ledgerUntagged: 'Untagged',
        ledgerDesc: 'The ledger reconciles dialogue with the storyboard; untagged lines are flagged during reconciliation.',
        correctionTitle: 'Light LLM correction',
        correctionOn: 'Enabled',
        correctionOff: 'Disabled',
        correctionDone: 'Done',
        correctionSkipped: 'Skipped',
        correctionFailed: 'Failed',
        correctionUnknown: 'Unknown',
        correctionCalls: 'Calls',
        correctionEpisodes: 'Corrected episodes',
        correctionLimit: 'Limit',
        correctionLimitValue: 'up to {n} episodes / {calls} calls',
        correctionLimitPerEpisode: 'up to {calls} calls per episode (unlimited episodes)',
        correctionDesc: 'Only high-confidence issues are corrected; dialogue content is not rewritten.',
        correctionScope: 'Scope: import switch defaults off; when on, unlimited episodes with at most 2 calls per episode; remaining issues stay in the weak-QC report.',
        correctionEnable: 'Enable light correction',
        correctionDisable: 'Disable light correction',
        correctionToggleHint: 'Rerun preflight to apply this change (affects future 2.0 preflight only).',
      },
      story: {
        title: 'Vertical storyboard staging',
        subtitle: '2.0 flow: planner breakdown → plan check → writer storyboard → machine check/reconciliation → audit → merge/build/report.',
        jobKind: 'Storyboard job',
        refresh: 'Refresh storyboard',
        start: 'Start storyboard staging',
        startSample: 'Sample episodes',
        concurrency: 'Concurrency',
        started: 'Storyboard job started',
        retryFailed: 'Retry failed episodes',
        retryEpisode: 'Retry episode',
        retryLast: 'Retry last parameters',
        attempts: 'Attempts',
        failedHint: 'Job failed: {reason}',
        loadFailed: 'Failed to load storyboard data: {reason}',
        summaryTitle: 'Storyboard summary',
        sumTotal: 'Episodes',
        sumPlanned: 'Planned',
        sumWritten: 'Written',
        sumPassed: 'Passed',
        sumFailed: 'Failed',
        episodesTitle: 'Per-episode storyboard state',
        noEpisodes: 'No storyboard episodes yet',
        noEpisodesDesc: '2.0 projects produce planner/writer per-episode data after storyboard staging starts.',
        colTitle: 'Title',
        colPlanner: 'Planner',
        colWriter: 'Writer',
        colRetry: 'Retry',
        colCheck: 'Check',
        colAudit: 'Audit',
        colTokens: 'Tokens',
        colCost: 'Cost',
        colArtifacts: 'Artifacts',
        colActions: 'Actions',
        artifactsTitle: 'Storyboard artifacts',
        artifact: {
          storyboard: 'Storyboard draft',
          dialogueAudit: 'Dialogue audit',
          plan: 'Plan',
          check: 'Check',
        },
        stage: {
          pending: 'Pending',
          planned: 'Planned',
          planning: 'Planning',
          plan_check: 'Plan check',
          running: 'Running',
          writing: 'Writing',
          checking: 'Checking',
          auditing: 'Auditing',
          retry_wait: 'Retry wait',
          passed: 'Passed',
          done: 'Done',
          succeeded: 'Succeeded',
          failed: 'Failed',
          blocked: 'Blocked',
          issues: 'Issues',
        },
      },
    }

    // -----------------------------------------------------------------------
    // Small helpers
    // -----------------------------------------------------------------------
    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function asNumber(value, fallback) {
      const parsed = typeof value === 'number' ? value : Number(value)
      if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed
      return fallback === undefined ? 0 : fallback
    }

    function asString(value, fallback) {
      if (typeof value === 'string') return value
      if (value === null || value === undefined) return fallback === undefined ? '' : fallback
      return String(value)
    }

    function pickValue(object, keys) {
      if (!isObject(object)) return undefined
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]
        if (object[key] !== undefined && object[key] !== null) return object[key]
      }
      return undefined
    }

    function lookupPath(dict, key) {
      const segments = String(key).split('.')
      let current = dict
      for (let index = 0; index < segments.length; index += 1) {
        if (!isObject(current)) return undefined
        current = current[segments[index]]
      }
      return current
    }

    function formatText(template, vars) {
      if (typeof template !== 'string') return template
      if (!vars) return template
      return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
      )
    }

    function createTranslate(translate, fallbackDict) {
      return function t(key, vars) {
        let value
        if (typeof translate === 'function') {
          try {
            value = translate(key)
          } catch {
            value = undefined
          }
        }
        if (typeof value !== 'string' || value === key) {
          const fallback = lookupPath(fallbackDict, key)
          if (typeof fallback === 'string') value = fallback
        }
        if (typeof value !== 'string') value = String(key)
        return formatText(value, vars)
      }
    }

    function numberOf(value) {
      const n = asNumber(value, 0)
      try {
        return n.toLocaleString()
      } catch {
        return String(n)
      }
    }

    function formatTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      try {
        return date.toLocaleString(undefined, {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      } catch {
        return date.toISOString()
      }
    }

    function formatDuration(ms) {
      const value = asNumber(ms, 0)
      if (!value) return '—'
      if (value < 1000) return `${Math.round(value)} ms`
      return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`
    }

    // -----------------------------------------------------------------------
    // Pricing & cost helpers
    // -----------------------------------------------------------------------
    function normalizePricing(raw) {
      const value = isObject(raw) ? raw : {}
      const rates = isObject(value.rates) ? value.rates : {}
      const peak = isObject(rates.peak) ? rates.peak : DEFAULT_PRICING.rates.peak
      const idle = isObject(rates.idle) ? rates.idle : DEFAULT_PRICING.rates.idle
      const idleWindow = isObject(value.idleWindow) ? value.idleWindow : DEFAULT_PRICING.idleWindow
      return {
        model: asString(value.model, DEFAULT_PRICING.model),
        currency: asString(value.currency, DEFAULT_PRICING.currency),
        unit: asNumber(value.unit, DEFAULT_PRICING.unit),
        rates: {
          peak: {
            inputMiss: asNumber(peak.inputMiss, DEFAULT_PRICING.rates.peak.inputMiss),
            inputHit: asNumber(peak.inputHit, DEFAULT_PRICING.rates.peak.inputHit),
            output: asNumber(peak.output, DEFAULT_PRICING.rates.peak.output),
          },
          idle: {
            inputMiss: asNumber(idle.inputMiss, DEFAULT_PRICING.rates.idle.inputMiss),
            inputHit: asNumber(idle.inputHit, DEFAULT_PRICING.rates.idle.inputHit),
            output: asNumber(idle.output, DEFAULT_PRICING.rates.idle.output),
          },
        },
        idleWindow: {
          startMinutes: asNumber(idleWindow.startMinutes, DEFAULT_PRICING.idleWindow.startMinutes),
          endMinutes: asNumber(idleWindow.endMinutes, DEFAULT_PRICING.idleWindow.endMinutes),
          label: asString(idleWindow.label, DEFAULT_PRICING.idleWindow.label),
          timeZone: asString(idleWindow.timeZone, DEFAULT_PRICING.idleWindow.timeZone),
        },
        current: isObject(value.current) ? value.current : null,
      }
    }

    function beijingNow() {
      const now = new Date()
      let minutes = now.getHours() * 60 + now.getMinutes()
      let hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      let seconds = now.getSeconds()
      try {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Shanghai',
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(now)
        const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(parts)
        if (match) {
          const hour = Number(match[1])
          const minute = Number(match[2])
          minutes = hour * 60 + minute
          seconds = Number(match[3] || 0)
          hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
        }
      } catch {
        // fall through to the local clock
      }
      return { minutes, clock: `${hhmm}:${String(seconds).padStart(2, '0')}`, hhmm }
    }

    function tariffFor(pricing, minutes) {
      const idleWindow = normalizePricing(pricing).idleWindow
      const start = idleWindow.startMinutes
      const end = idleWindow.endMinutes
      const inIdle = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
      return inIdle ? 'idle' : 'peak'
    }

    function normalizeCost(raw) {
      const value = isObject(raw) ? raw : {}
      const input = asNumber(pickValue(value, ['input']), 0)
      const cacheRead = asNumber(pickValue(value, ['cacheRead']), 0)
      const output = asNumber(pickValue(value, ['output']), 0)
      return {
        currency: asString(pickValue(value, ['currency']), DEFAULT_PRICING.currency),
        tariff: asString(pickValue(value, ['tariff']), ''),
        total: asNumber(pickValue(value, ['total']), input + cacheRead + output),
        input,
        cacheRead,
        output,
        calls: asNumber(pickValue(value, ['calls']), 0),
        inputTokens: asNumber(pickValue(value, ['inputTokens']), 0),
        cacheReadTokens: asNumber(pickValue(value, ['cacheReadTokens']), 0),
        outputTokens: asNumber(pickValue(value, ['outputTokens']), 0),
      }
    }

    function estimateCost(tokens, pricing, tariff) {
      const normalizedPricing = normalizePricing(pricing)
      const normalizedTokens = isObject(tokens) ? tokens : {}
      const rate = normalizedPricing.rates[tariff] || normalizedPricing.rates.peak
      const unit = normalizedPricing.unit || 1
      const input = (asNumber(normalizedTokens.input, 0) / unit) * rate.inputMiss
      const cacheRead = (asNumber(normalizedTokens.cacheRead, 0) / unit) * rate.inputHit
      const output = (asNumber(normalizedTokens.output, 0) / unit) * rate.output
      return {
        currency: normalizedPricing.currency,
        tariff,
        input,
        cacheRead,
        output,
        total: input + cacheRead + output,
        calls: asNumber(normalizedTokens.calls, 0),
        inputTokens: asNumber(normalizedTokens.input, 0),
        cacheReadTokens: asNumber(normalizedTokens.cacheRead, 0),
        outputTokens: asNumber(normalizedTokens.output, 0),
      }
    }

    function resolveCost(options) {
      const opts = isObject(options) ? options : {}
      const pricing = normalizePricing(opts.pricing)
      const tariff = tariffFor(pricing, beijingNow().minutes)
      if (isObject(opts.cost)) {
        const cost = normalizeCost(opts.cost)
        if (!cost.tariff) cost.tariff = tariff
        return cost
      }
      return estimateCost(opts.tokens, pricing, tariff)
    }

    function formatYuan(value) {
      const amount = asNumber(value, 0)
      if (!Number.isFinite(amount)) return '¥0.0000'
      return `¥${amount.toFixed(4)}`
    }

    function formatNumberish(value) {
      return numberOf(asNumber(value, 0))
    }

    function truncate(text, max) {
      const value = asString(text)
      if (value.length <= max) return value
      return `${value.slice(0, max)}…`
    }

    // -----------------------------------------------------------------------
    // HTTP helpers
    // -----------------------------------------------------------------------
    function withQuery(path, params) {
      const search = new URLSearchParams()
      Object.keys(params || {}).forEach((key) => {
        const value = params[key]
        if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
      })
      const query = search.toString()
      return query ? `${path}?${query}` : path
    }

    async function requestJson(path, init) {
      const options = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, init || {})
      const response = await fetch(path, options)
      let text = ''
      try {
        text = await response.text()
      } catch {
        text = ''
      }
      let data = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          data = null
        }
      }
      return { ok: response.ok, status: response.status, data, text }
    }

    function errorInfoFromResponse(response, fallbackMessage) {
      const data = isObject(response.data) ? response.data : null
      const code = data && (data.code || data.errorCode) ? asString(data.code || data.errorCode) : ''
      const detail = data ? asString(data.detail || data.message || data.error, '') : ''
      return {
        status: response.status,
        code,
        message: detail || fallbackMessage,
      }
    }

    function errorInfoFromException(error, fallbackMessage) {
      return {
        status: 0,
        code: '',
        message: asString(error && error.message, fallbackMessage),
      }
    }

    function describeError(info, t) {
      const status = info && info.status
      let message
      if (!status) message = t('error.network')
      else if (status === 401 || status === 403) message = t('error.auth')
      else if (status === 404) message = t('error.notFound')
      else if (status >= 500) message = t('error.server')
      else message = asString(info && info.message) || t('error.generic', { reason: t('common.unknown') })
      if (info && info.code) message = `${message} · ${t('error.code', { code: info.code })}`
      return message
    }

    const api = {
      async health() {
        return requestJson(`${API}/health`)
      },
      async pricing() {
        return requestJson(`${API}/pricing`)
      },
      async projects(params) {
        return requestJson(withQuery(`${API}/projects`, params || {}))
      },
      async project(id) {
        return requestJson(withQuery(`${API}/project`, { id }))
      },
      async report(id) {
        // M2 contract: GET .../report?id=&format=md -> text/markdown.
        // Tolerate an M1-style JSON body as a fallback.
        const response = await fetch(withQuery(`${API}/project/report`, { id, format: 'md' }), {
          credentials: 'same-origin',
          cache: 'no-store',
        })
        let text = ''
        try {
          text = await response.text()
        } catch {
          text = ''
        }
        if (!response.ok) {
          let data = null
          try {
            data = text ? JSON.parse(text) : null
          } catch {
            data = null
          }
          return { ok: false, status: response.status, data, text }
        }
        let markdown = text
        const trimmed = text.trim()
        if (trimmed.charAt(0) === '{') {
          try {
            const parsed = JSON.parse(trimmed)
            if (isObject(parsed) && parsed.ok && typeof parsed.markdown === 'string') markdown = parsed.markdown
          } catch {
            markdown = text
          }
        }
        return { ok: true, status: response.status, markdown, text }
      },
      async episode(id, ep) {
        return requestJson(withQuery(`${API}/project/episode`, { id, ep }))
      },
      async action(id, action, payload) {
        return requestJson(`${API}/project/action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({ id, action }, payload || {})),
        })
      },
      async refine(id) {
        return requestJson(withQuery(`${API}/project/refine`, { id }))
      },
      async draft(id, ep) {
        return requestJson(withQuery(`${API}/project/draft`, { id, ep }))
      },
      async migrateLegacy(source, title) {
        const payload = { source }
        if (title) payload.title = title
        return requestJson(`${API}/migrate-legacy`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      },
      async merge(id) {
        return requestJson(withQuery(`${API}/project/merge`, { id }))
      },
      async mergeAction(id, action, payload) {
        const body = Object.assign({ id, action }, payload || {})
        return requestJson(`${API}/project/merge`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      },
      async mode() {
        return requestJson(`${API}/mode`)
      },
      async setMode(mode) {
        return requestJson(`${API}/mode`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode }),
        })
      },
      async bgm(id) {
        return requestJson(withQuery(`${API}/project/bgm`, { id }))
      },
      async bgmDraft(id, ep) {
        return requestJson(withQuery(`${API}/project/bgm-draft`, { id, ep }))
      },
      async job(id) {
        return requestJson(withQuery(`${API}/job`, { id }))
      },
      async cancelJob(jobId) {
        return requestJson(`${API}/job/cancel`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobId }),
        })
      },
      async updateOptions(id, options) {
        return requestJson(`${API}/project/options`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, options }),
        })
      },
      eventsUrl(jobId) {
        return withQuery(`${API}/events`, { jobId })
      },
      async selfcheck() {
        return requestJson(`${API}/selfcheck`)
      },
      async runSelfcheck() {
        return requestJson(`${API}/run-selfcheck`, { method: 'POST' })
      },
      fileUrl(id, relativePath) {
        return withQuery(`${API}/file`, { id, path: relativePath })
      },
    }

    function importDocx(file, title, onProgress, llmCorrection) {
      return new Promise((resolve) => {
        let settled = false
        const finish = (value) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        let xhr
        try {
          xhr = new XMLHttpRequest()
        } catch (error) {
          finish({ ok: false, status: 0, data: null, error: errorInfoFromException(error, 'XMLHttpRequest unavailable') })
          return
        }
        const url = withQuery(`${API}/import`, { name: file.name, title, correction: llmCorrection ? '1' : undefined })
        xhr.open('POST', url, true)
        xhr.withCredentials = true
        xhr.setRequestHeader('Content-Type', 'application/octet-stream')
        xhr.upload.onprogress = (event) => {
          if (typeof onProgress !== 'function') return
          if (event.lengthComputable && event.total > 0) {
            onProgress(Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))))
          } else {
            onProgress(-1)
          }
        }
        xhr.onerror = () => finish({ ok: false, status: 0, data: null, error: { status: 0, code: '', message: 'network error' } })
        xhr.onabort = () => finish({ ok: false, status: 0, data: null, error: { status: 0, code: 'ABORTED', message: 'aborted' } })
        xhr.onload = () => {
          let data = null
          try {
            data = xhr.responseText ? JSON.parse(xhr.responseText) : null
          } catch {
            data = null
          }
          const response = { ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data }
          if (response.ok && isObject(data) && data.ok === true) {
            finish({ ok: true, response })
          } else if (response.ok && isObject(data)) {
            finish({ ok: false, response, error: { status: 200, code: asString(data.code), message: asString(data.error, 'import failed') } })
          } else {
            finish({ ok: false, response, error: errorInfoFromResponse(response, 'import failed') })
          }
        }
        try {
          xhr.send(file)
        } catch (error) {
          finish({ ok: false, status: 0, data: null, error: errorInfoFromException(error, 'upload failed') })
        }
      })
    }

    // -----------------------------------------------------------------------
    // Normalisation (Host DTO tolerant: handles engine summary variants)
    // -----------------------------------------------------------------------
    const CHECK_ALIAS_MAP = (() => {
      const map = {}
      CHECK_KEYS.forEach((key) => {
        CHECK_ALIASES[key].forEach((alias) => {
          map[alias.toLowerCase()] = key
        })
      })
      return map
    })()

    function readCheckRaw(episode, canonicalKey) {
      const source = isObject(episode) && isObject(episode.checks) ? episode.checks : null
      if (!source) return undefined
      const aliases = CHECK_ALIASES[canonicalKey] || [canonicalKey]
      for (let index = 0; index < aliases.length; index += 1) {
        const alias = aliases[index]
        if (source[alias] !== undefined) return source[alias]
      }
      const lowerKeys = Object.keys(source)
      for (let index = 0; index < lowerKeys.length; index += 1) {
        const mapped = CHECK_ALIAS_MAP[lowerKeys[index].toLowerCase()]
        if (mapped === canonicalKey) return source[lowerKeys[index]]
      }
      return undefined
    }

    function checkStateFromValue(value) {
      if (value === null || value === undefined) return 'na'
      if (typeof value === 'boolean') return value ? 'risk' : 'ok'
      if (typeof value === 'string') return checkStateFromStatus(value)
      if (isObject(value)) {
        if (value.blocked === true) return 'blocked'
        if (value.risk === true || value.risky === true) return 'risk'
        const riskyEps = asArray(value.risky_eps)
        const blockedEps = asArray(value.blocked_eps)
        if (blockedEps.length > 0) return 'blocked'
        if (riskyEps.length > 0) return 'risk'
        const status = pickValue(value, ['status', 'verdict', 'state', 'result'])
        if (status !== undefined) {
          const state = checkStateFromStatus(status)
          if (state !== 'na') return state
        }
        if (value.ok === true) return 'ok'
        if (value.ok === false) return 'risk'
        return 'na'
      }
      return 'na'
    }

    function checkStateFromStatus(status) {
      if (status === null || status === undefined) return 'na'
      const text = String(status).trim().toUpperCase()
      if (!text) return 'na'
      if (text === 'BLOCKED' || text === 'NO' || text === 'LOW' || text === 'NO_PROTAGONIST' || text.indexOf('LOW_PROTAGONIST') >= 0) return 'blocked'
      if (text === 'SKIP') return 'ok'
      if (RISK_STATUSES[text]) return 'risk'
      if (OK_STATUSES[text]) return 'ok'
      if (text.indexOf('BORDERLINE') >= 0) return 'ok'
      if (text.indexOf('BLOCK') >= 0) return 'blocked'
      if (text.indexOf('FAIL') >= 0 || text.indexOf('RISK') >= 0 || text.indexOf('ERROR') >= 0) return 'risk'
      if (text.indexOf('PASS') >= 0 || text.indexOf('OK') >= 0) return 'ok'
      return 'na'
    }

    function episodeCheckState(episode, canonicalKey) {
      return checkStateFromValue(readCheckRaw(episode, canonicalKey))
    }

    function episodeWordCount(episode) {
      const raw = readCheckRaw(episode, 'spokenWords')
      if (isObject(raw)) {
        const value = pickValue(raw, ['count', 'words', 'wordCount', 'value', 'total'])
        if (value !== undefined) return asNumber(value, null)
      }
      const direct = pickValue(episode, ['words', 'wordCount', 'latinWords', 'latin_words'])
      if (direct !== undefined) return asNumber(direct, null)
      return null
    }

    function normalizeEpisode(row, index) {
      const ep = asNumber(pickValue(row, ['ep', 'episode', 'episodeNumber', 'number']), index + 1)
      const checks = isObject(row) && isObject(row.checks) ? row.checks : {}
      return {
        ep,
        title: asString(pickValue(row, ['title', 'titleEn', 'name']), ''),
        status: asString(pickValue(row, ['status', 'state']), 'OK'),
        blocked: (isObject(row) && row.blocked === true) || checkStateFromValue(readCheckRaw(row, 'protagonist')) === 'blocked',
        cjk: asNumber(pickValue(row, ['cjk', 'characters']), 0),
        scenes: asNumber(pickValue(row, ['scenes', 'sceneCount']), 0),
        dialogueLines: asNumber(pickValue(row, ['dialogueLines', 'dialogue_lines']), 0),
        atomLines: asNumber(pickValue(row, ['atomLines', 'atom_lines']), 0),
        checks,
        wordCount: episodeWordCount(row),
        raw: row,
      }
    }

    // -----------------------------------------------------------------------
    // BGM (M4) normalizers and helpers
    // -----------------------------------------------------------------------
    function normalizeBgmEpisode(raw) {
      const value = isObject(raw) ? raw : {}
      const checkValue = isObject(value.check) ? value.check : {}
      const qcValue = isObject(value.qc) ? value.qc : {}
      const artifactsValue = isObject(value.artifacts) ? value.artifacts : {}
      return {
        ep: asNumber(pickValue(value, ['ep']), 0),
        title: asString(pickValue(value, ['title']), ''),
        state: asString(pickValue(value, ['state', 'status']), 'pending').toLowerCase(),
        attempts: asNumber(pickValue(value, ['attempts', 'attempt']), 0),
        check: {
          fails: asArray(pickValue(checkValue, ['fails', 'hardFails', 'failures'])).map((entry) => asString(entry)),
          warns: asArray(pickValue(checkValue, ['warns', 'warnings'])).map((entry) => asString(entry)),
          verdict: asString(pickValue(checkValue, ['verdict']), ''),
          raw: checkValue,
        },
        qc: {
          verdict: asString(pickValue(qcValue, ['verdict', 'result']), asString(pickValue(value, ['qcVerdict']), '')),
          raw: qcValue,
        },
        tokens: normalizeTokens(value.tokens),
        cost: normalizeCost(value.cost),
        artifacts: {
          bgm: asString(pickValue(artifactsValue, ['bgm', 'bgmMd', 'markdown', 'md']), ''),
          report: asString(pickValue(artifactsValue, ['report', 'reportMd']), ''),
          check: asString(pickValue(artifactsValue, ['check', 'checkJson']), ''),
        },
        error: asString(pickValue(value, ['error', 'failureReason']), ''),
        raw: value,
      }
    }

    function normalizeBgm(raw) {
      const value = isObject(raw) ? raw : {}
      const job = normalizeJob(value.job)
      const episodes = asArray(value.episodes)
        .map(normalizeBgmEpisode)
        .sort((left, right) => left.ep - right.ep)
      const rawProgress = isObject(value.progress) ? value.progress : {}
      const countOf = (key) => {
        if (typeof rawProgress[key] === 'number') return rawProgress[key]
        return episodes.filter((entry) => entry.state === key).length
      }
      const progress = {}
      BGM_EP_STATES.forEach((key) => {
        progress[key] = countOf(key)
      })
      progress.total = asNumber(rawProgress.total, episodes.length)
      const artifactsValue = isObject(value.artifacts) ? value.artifacts : {}
      const planValue = isObject(artifactsValue.plan) ? artifactsValue.plan : {}
      const artifacts = {
        planMd: asString(pickValue(artifactsValue, ['planMd']), asString(pickValue(planValue, ['md']), '')),
        planDocx: asString(pickValue(artifactsValue, ['planDocx']), asString(pickValue(planValue, ['docx']), '')),
        auditReport: asString(pickValue(artifactsValue, ['auditReport', 'audit', 'report']), ''),
        outputs: asArray(artifactsValue.outputs).filter((entry) => typeof entry === 'string'),
        seriesBible: asString(pickValue(artifactsValue, ['seriesBible']), ''),
        themeMap: asString(pickValue(artifactsValue, ['themeMap']), ''),
      }
      return {
        schema: asString(value.schema, 'lianben/bgm_state/1'),
        jobId: asString(value.jobId, ''),
        state: asString(value.state, 'pending').toLowerCase(),
        progress,
        episodes,
        artifacts,
        tokens: normalizeTokens(value.tokens),
        cost: normalizeCost(value.cost),
        budget: normalizeBudget(value.budget) || (job && job.budget) || null,
        job,
        pricing: isObject(value.pricing) ? value.pricing : null,
        seriesBible: value.seriesBible !== undefined ? value.seriesBible : null,
        themeMap: value.themeMap !== undefined ? value.themeMap : null,
        checkPassRate: asNumber(pickValue(value, ['checkPassRate']), 0),
        refineReady: typeof value.refineReady === 'boolean' ? value.refineReady : null,
        raw: value,
      }
    }

    function bgmEpisodeStateKind(state) {
      const text = asString(state).toLowerCase()
      if (text === 'passed') return 'success'
      if (text === 'failed') return 'error'
      if (text === 'writing' || text === 'machine_checking' || text === 'qc_running') return 'brand'
      if (text === 'qc_pending' || text === 'retry_wait') return 'risk'
      return 'idle'
    }

    function bgmEpisodeStateLabel(state, t) {
      const text = asString(state).toLowerCase()
      if (BGM_EP_STATES.indexOf(text) === -1) return t('common.unknown')
      return t(`bgm.epState.${text}`)
    }

    function bgmStateKind(state) {
      const text = asString(state).toLowerCase()
      if (text === 'succeeded' || text === 'done') return 'success'
      if (text === 'partial') return 'risk'
      if (text === 'running') return 'brand'
      if (text === 'needs_confirm') return 'risk'
      if (text === 'failed' || text === 'blocked') return 'error'
      return 'idle'
    }

    function bgmStateLabel(state, t) {
      const text = asString(state, 'pending').toLowerCase()
      const key = `refine.state.${text === 'done' ? 'succeeded' : text}`
      const label = t(key)
      return label === key ? t('common.unknown') : label
    }

    function bgmRoleLabel(role, t) {
      const text = asString(role).toLowerCase().replace(/^bgm-/, '')
      if (text === 'architect' || text === 'arch') return t('bgm.role.architect')
      if (text === 'worker' || text === 'write' || text === 'director') return t('bgm.role.worker')
      if (text === 'qc' || text === 'reviewer') return t('bgm.role.qc')
      if (text === 'auditor' || text === 'audit' || text === 'final') return t('bgm.role.auditor')
      return text ? `${t('bgm.role.model')} ${text}` : t('bgm.role.model')
    }

    function bgmArtifactLinks(artifacts, t) {
      const links = []
      const source = isObject(artifacts) ? artifacts : {}
      if (source.planMd) links.push({ label: `${t('bgm.artifact.plan')} · Markdown`, path: source.planMd })
      if (source.planDocx) links.push({ label: `${t('bgm.artifact.plan')} · Word`, path: source.planDocx })
      if (source.auditReport) links.push({ label: t('bgm.artifact.audit'), path: source.auditReport })
      const seen = {}
      links.forEach((entry) => {
        seen[entry.path] = true
      })
      asArray(source.outputs).forEach((entry) => {
        if (typeof entry !== 'string' || !entry || seen[entry]) return
        if (/_配乐.*方案|_配乐.*终检/.test(entry)) return
        links.push({ label: entry.split('/').pop(), path: entry })
        seen[entry] = true
      })
      return links
    }

    function normalizeTextAsset(value) {
      if (value === null || value === undefined) return null
      if (typeof value === 'string') {
        const text = value.trim()
        if (!text) return null
        const looksLikePath = text.length < 240 && text.indexOf('\n') === -1 && /\.(md|txt|json|ya?ml|mjs|js)$/i.test(text)
        return { text: looksLikePath ? '' : value, path: looksLikePath ? text : '' }
      }
      if (isObject(value)) {
        if (typeof value.markdown === 'string') return { text: value.markdown, path: '' }
        if (typeof value.content === 'string') return { text: value.content, path: '' }
        if (typeof value.path === 'string') return { text: '', path: value.path }
        if (typeof value.md === 'string') return { text: '', path: value.md }
        return { text: JSON.stringify(value, null, 2), path: '' }
      }
      return null
    }

    // -----------------------------------------------------------------------
    // Merge suggestions (M6) normalizers
    // -----------------------------------------------------------------------
    function normalizeMergeEpisode(raw) {
      const value = isObject(raw) ? raw : {}
      return {
        ep: asNumber(pickValue(value, ['ep']), 0),
        title: asString(pickValue(value, ['title']), ''),
        recommended: Boolean(value.recommended),
        merged: Boolean(value.merged),
        atoms: asNumber(pickValue(value, ['atoms']), 0),
        ratio: Number.isFinite(Number(value.ratio)) ? Number(value.ratio) : null,
        targets: asArray(value.targets).map((target) => ({
          start: asNumber(pickValue(target, ['start']), 0),
          length: asNumber(pickValue(target, ['length']), 0),
          preview: asString(pickValue(target, ['preview']), ''),
        })),
        targetCount: asNumber(pickValue(value, ['targetCount']), asArray(value.targets).length),
        raw: value,
      }
    }

    function normalizeMerge(raw) {
      const value = isObject(raw) ? raw : {}
      const summaryValue = isObject(value.summary) ? value.summary : {}
      const episodes = asArray(value.episodes)
        .map(normalizeMergeEpisode)
        .sort((left, right) => left.ep - right.ep)
      const selectable = asArray(value.selectable)
        .map((entry) => (isObject(entry) ? asNumber(pickValue(entry, ['ep']), 0) : asNumber(entry, 0)))
        .filter((entry) => entry > 0)
      return {
        merge: isObject(value.merge) ? value.merge : null,
        preflightStale: Boolean(value.preflightStale),
        episodes,
        selectable,
        summary: {
          totalTargetEpisodes: asNumber(
            pickValue(summaryValue, ['totalTargetEpisodes']),
            episodes.filter((entry) => entry.targetCount > 0).length,
          ),
          recommendedEpisodes: asArray(summaryValue.recommendedEpisodes)
            .map((entry) => asNumber(entry, 0))
            .filter((entry) => entry > 0),
          mergedEpisodes: asArray(summaryValue.mergedEpisodes)
            .map((entry) => asNumber(entry, 0))
            .filter((entry) => entry > 0),
          targetRuns: asNumber(
            pickValue(summaryValue, ['targetRuns']),
            episodes.reduce((sum, entry) => sum + (entry.merged ? 0 : entry.targetCount), 0),
          ),
          atomsBefore: asNumber(pickValue(summaryValue, ['atomsBefore']), 0),
        },
        llmMode: {
          available: isObject(value.llmMode) ? value.llmMode.available !== false : true,
          default: isObject(value.llmMode) ? Boolean(value.llmMode.default) : false,
          maxEpisodes: isObject(value.llmMode) ? asNumber(pickValue(value.llmMode, ['maxEpisodes']), 5) : 5,
          note: isObject(value.llmMode) ? asString(pickValue(value.llmMode, ['note']), '') : '',
        },
        warnings: asArray(value.warnings)
          .map((entry) => asString(entry))
          .filter(Boolean),
        raw: value,
      }
    }

    function normalizeMergePreview(raw) {
      const value = isObject(raw) ? raw : {}
      return {
        mode: asString(pickValue(value, ['mode']), value.aiUsed === true ? 'llm' : 'deterministic'),
        previewId: asString(pickValue(value, ['previewId']), ''),
        previewIds: asArray(value.previewIds)
          .map((id) => asString(id))
          .filter(Boolean),
        model: asString(pickValue(value, ['model']), ''),
        tokens: normalizeTokens(value.tokens),
        cost: normalizeCost(value.cost),
        calls: asNumber(pickValue(value, ['calls']), 0),
        episodes: asArray(value.episodes)
          .map((entry) => {
            const item = isObject(entry) ? entry : {}
            return {
              ep: asNumber(pickValue(item, ['ep']), 0),
              title: asString(pickValue(item, ['title']), ''),
              sourceFile: asString(pickValue(item, ['sourceFile']), ''),
              atomsBefore: asNumber(pickValue(item, ['atomsBefore']), 0),
              atomsAfter: asNumber(pickValue(item, ['atomsAfter']), 0),
              removed: asNumber(pickValue(item, ['removed']), 0),
              coverage: Number.isFinite(Number(item.coverage)) ? Number(item.coverage) : null,
              warnings: asArray(item.warnings)
                .map((line) => asString(line))
                .filter(Boolean),
              targetCount: asNumber(pickValue(item, ['targetCount']), 0),
              targets: asArray(item.targets).map((target) => ({
                start: asNumber(pickValue(target, ['start']), 0),
                length: asNumber(pickValue(target, ['length']), 0),
                before: asArray(pickValue(target, ['before'])).map((line) => asString(line)),
                after: asString(pickValue(target, ['after']), ''),
              })),
              raw: item,
            }
          })
          .sort((left, right) => left.ep - right.ep),
        atomsBefore: asNumber(pickValue(value, ['atomsBefore']), 0),
        atomsAfter: asNumber(pickValue(value, ['atomsAfter']), 0),
        removed: asNumber(pickValue(value, ['removed']), 0),
        warnings: asArray(value.warnings)
          .map((line) => asString(line))
          .filter(Boolean),
        deterministic: value.deterministic !== false,
        aiUsed: Boolean(value.aiUsed),
        raw: value,
      }
    }

    function truncateMergeLine(text, max) {
      const value = asString(text)
      if (value.length <= max) return value
      return `${value.slice(0, max)}…`
    }

    function mergeTokensSum(left, right) {
      const a = normalizeTokens(left)
      const b = normalizeTokens(right)
      return {
        input: a.input + b.input,
        output: a.output + b.output,
        cacheRead: a.cacheRead + b.cacheRead,
        cacheWrite: a.cacheWrite + b.cacheWrite,
        total: a.total + b.total,
        calls: asNumber(a.calls, 0) + asNumber(b.calls, 0),
      }
    }

    function mergeCostSum(left, right) {
      const a = normalizeCost(left)
      const b = normalizeCost(right)
      return normalizeCost({
        currency: a.currency || b.currency,
        tariff: a.tariff || b.tariff,
        input: a.input + b.input,
        cacheRead: a.cacheRead + b.cacheRead,
        output: a.output + b.output,
        total: a.total + b.total,
        calls: a.calls + b.calls,
        inputTokens: a.inputTokens + b.inputTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
        outputTokens: a.outputTokens + b.outputTokens,
      })
    }

    function emptyMergeBatchPreview() {
      return {
        mode: 'llm-batch',
        previewId: '',
        previewIds: [],
        model: '',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, calls: 0 },
        cost: normalizeCost({}),
        calls: 0,
        episodes: [],
        atomsBefore: 0,
        atomsAfter: 0,
        removed: 0,
        warnings: [],
        deterministic: false,
        aiUsed: true,
        raw: {},
      }
    }

    // -----------------------------------------------------------------------
    // Dual-mode (1.0 / 2.0) helpers and normalizers
    // -----------------------------------------------------------------------
    function normalizeModeId(mode) {
      const text = asString(mode).toLowerCase()
      if (text === MODE_2 || text.indexOf('2.0') >= 0 || text === '2') return MODE_2
      return MODE_1
    }

    function isMode2(mode) {
      return normalizeModeId(mode) === MODE_2
    }

    function modeLabel(mode, t) {
      return isMode2(mode) ? t('mode.name2') : t('mode.name1')
    }

    function normalizeLedger(raw) {
      if (!isObject(raw)) return null
      return {
        available: raw.available !== false,
        lines: asNumber(pickValue(raw, ['lines']), 0),
        tagged: asNumber(pickValue(raw, ['tagged']), 0),
        untagged: asNumber(pickValue(raw, ['untagged']), 0),
        raw,
      }
    }

    function normalizeLlmCorrection(raw) {
      if (!isObject(raw)) return null
      const episodesValue = raw.episodes
      return {
        enabled: raw.enabled !== false,
        calls: asNumber(pickValue(raw, ['calls']), 0),
        episodes: Array.isArray(episodesValue) ? episodesValue.length : asNumber(episodesValue, 0),
        maxEpisodes: asNumber(pickValue(raw, ['maxEpisodes']), 0),
        maxCalls: asNumber(pickValue(raw, ['maxCalls']), 0),
        maxCallsPerEpisode: asNumber(pickValue(raw, ['maxCallsPerEpisode']), 2),
        status: asString(pickValue(raw, ['status']), ''),
        note: asString(pickValue(raw, ['note']), ''),
        raw,
      }
    }

    function normalizeStoryboardStage(raw) {
      if (raw === null || raw === undefined) return null
      if (typeof raw === 'boolean') return { state: raw ? 'done' : 'failed', attempts: 0, note: '', verdict: '', fails: [], warns: [], raw }
      if (typeof raw === 'string') return { state: raw.toLowerCase(), attempts: 0, note: '', verdict: '', fails: [], warns: [], raw }
      const value = isObject(raw) ? raw : {}
      return {
        state: asString(pickValue(value, ['state', 'status']), 'pending').toLowerCase(),
        attempts: asNumber(pickValue(value, ['attempts', 'attempt']), 0),
        note: asString(pickValue(value, ['note', 'message', 'error']), ''),
        verdict: asString(pickValue(value, ['verdict']), ''),
        fails: asArray(pickValue(value, ['fails', 'hardFails'])).map((entry) => asString(entry)),
        warns: asArray(pickValue(value, ['warns', 'warnings'])).map((entry) => asString(entry)),
        raw: value,
      }
    }

    function normalizeStoryboardArtifacts(raw) {
      const value = isObject(raw) ? raw : {}
      const storyboard = isObject(value.storyboard) ? value.storyboard : {}
      return {
        storyboardMd: asString(
          pickValue(storyboard, ['md']),
          asString(pickValue(value, ['storyboardMd', 'storyboard', 'planMd']), ''),
        ),
        storyboardDocx: asString(
          pickValue(storyboard, ['docx']),
          asString(pickValue(value, ['storyboardDocx', 'planDocx']), ''),
        ),
        plan: asString(pickValue(value, ['plan', 'planMd', 'planJson']), asString(value.storyboardDir, '')),
        dialogueAudit: asString(pickValue(value, ['dialogueAudit', 'dialogue_audit', 'audit']), ''),
        check: asString(pickValue(value, ['check', 'checkJson', 'checkReport']), ''),
      }
    }

    function normalizeStoryboardEpisode(raw) {
      const value = isObject(raw) ? raw : {}
      const artifactsValue = isObject(value.artifacts) ? value.artifacts : {}
      const mergedArtifacts = Object.assign(
        {
          plan: asString(pickValue(value, ['plan']), ''),
          storyboard: asString(pickValue(value, ['storyboard', 'storyboardMd']), ''),
          dialogueAudit: asString(pickValue(value, ['dialogueAudit', 'dialogue_audit']), ''),
          check: asString(pickValue(value, ['check', 'checkJson']), ''),
        },
        artifactsValue,
      )
      return {
        ep: asNumber(pickValue(value, ['ep']), 0),
        title: asString(pickValue(value, ['title']), ''),
        planner: normalizeStoryboardStage(pickValue(value, ['planner', 'plan'])),
        writer: normalizeStoryboardStage(pickValue(value, ['writer', 'write'])),
        check: normalizeStoryboardStage(pickValue(value, ['check'])),
        audit: normalizeStoryboardStage(pickValue(value, ['audit'])),
        retry: asNumber(pickValue(value, ['retry', 'retries', 'retryCount']), 0),
        state: asString(pickValue(value, ['state', 'status']), 'pending').toLowerCase(),
        attempts: asNumber(pickValue(value, ['attempts', 'attempt']), 0),
        tokens: normalizeTokens(value.tokens),
        cost: normalizeCost(value.cost),
        artifacts: normalizeStoryboardArtifacts(mergedArtifacts),
        error: asString(pickValue(value, ['error', 'failureReason']), ''),
        raw: value,
      }
    }

    function normalizeStoryboard(raw) {
      const value = isObject(raw) ? raw : {}
      const episodes = asArray(pickValue(value, ['episodes', 'rows']))
        .map(normalizeStoryboardEpisode)
        .filter((entry) => entry.ep > 0)
        .sort((left, right) => left.ep - right.ep)
      const summaryValue = isObject(value.summary) ? value.summary : {}
      return {
        episodes,
        phases: asArray(value.phases).map((entry) => asString(entry)),
        summary: {
          total: asNumber(pickValue(summaryValue, ['total']), episodes.length),
          planned: asNumber(pickValue(summaryValue, ['planned']), episodes.filter((entry) => entry.planner && entry.planner.state !== 'pending').length),
          written: asNumber(pickValue(summaryValue, ['written']), episodes.filter((entry) => entry.writer && entry.writer.state !== 'pending').length),
          passed: asNumber(pickValue(summaryValue, ['passed']), episodes.filter((entry) => entry.state === 'passed').length),
          failed: asNumber(pickValue(summaryValue, ['failed']), episodes.filter((entry) => entry.state === 'failed').length),
        },
        artifacts: normalizeStoryboardArtifacts(value.artifacts),
        raw: value,
      }
    }

    function storyboardFromRefine(refine) {
      if (!refine) return normalizeStoryboard({})
      const episodes = asArray(refine.episodes).map((entry) => {
        const artifacts = isObject(entry.artifacts) ? entry.artifacts : {}
        return normalizeStoryboardEpisode({
          ep: entry.ep,
          title: entry.title,
          state: entry.state,
          retry: entry.attempts,
          check: entry.check,
          tokens: entry.tokens,
          cost: entry.cost,
          artifacts: {
            storyboard: { md: asString(artifacts.draft, '') },
            dialogueAudit: asString(artifacts.notes, ''),
            plan: asString(artifacts.report, ''),
          },
        })
      })
      return normalizeStoryboard({ episodes })
    }

    function normalizeRefine2(raw) {
      const value = isObject(raw) ? raw : {}
      const refine = normalizeRefine(isObject(value.refine) ? value.refine : value)
      const storyboardRaw = isObject(value.storyboard)
        ? value.storyboard
        : refine && isObject(refine.raw && refine.raw.storyboard)
          ? refine.raw.storyboard
          : null
      const storyboard =
        storyboardRaw && asArray(storyboardRaw.episodes).length > 0 ? normalizeStoryboard(storyboardRaw) : storyboardFromRefine(refine)
      return {
        refine,
        storyboard,
        job: normalizeJob(isObject(value.job) ? value.job : refine && refine.job) || null,
        raw: value,
      }
    }

    function storyStageKind(stage) {
      if (!stage) return 'idle'
      const text = asString(stage.state).toLowerCase()
      if (text === 'passed' || text === 'done' || text === 'succeeded') return 'success'
      if (text === 'failed' || text === 'blocked') return 'error'
      if (text === 'running' || text === 'planning' || text === 'writing' || text === 'checking' || text === 'auditing') return 'brand'
      if (text === 'retry_wait' || text === 'needs_confirm' || text === 'issues') return 'risk'
      return 'idle'
    }

    function storyStageLabel(stage, t) {
      if (!stage) return t('story.stage.pending')
      const text = asString(stage.state).toLowerCase()
      if (!text) return t('story.stage.pending')
      const key = `story.stage.${text}`
      const translated = t(key)
      return translated === key ? t('story.stage.pending') : translated
    }

    function normalizeSnapshot(raw) {
      const snapshot = isObject(raw) ? raw : {}
      const project = isObject(snapshot.project) ? snapshot.project : {}
      const stats = isObject(snapshot.stats) ? snapshot.stats : {}
      const risky = isObject(stats.risky) ? stats.risky : {}
      const episodes = asArray(snapshot.episodes).map(normalizeEpisode)
      const phase = isObject(snapshot.phase) ? snapshot.phase : {}
      const blockedEps = asArray(project.blocked_eps)
      const mode = normalizeModeId(project.mode || snapshot.mode)
      const preflightValue = isObject(snapshot.preflight) ? snapshot.preflight : {}
      const summaryValue = isObject(snapshot.summary) ? snapshot.summary : {}
      return {
        project: {
          id: asString(project.id, ''),
          title: asString(project.title, ''),
          status: asString(project.status, 'unknown'),
          mode,
          createdAt: project.createdAt || null,
          updatedAt: project.updatedAt || null,
          sourceName: asString(project.sourceName, ''),
          engineVersion: asString(project.engineVersion, ''),
          durationMs: asNumber(project.durationMs, 0),
        },
        stats: {
          episodes: asNumber(stats.episodes, episodes.length),
          cjk: asNumber(stats.cjk, episodes.reduce((sum, ep) => sum + ep.cjk, 0)),
          scenes: asNumber(stats.scenes, episodes.reduce((sum, ep) => sum + ep.scenes, 0)),
          dialogueLines: asNumber(stats.dialogueLines, episodes.reduce((sum, ep) => sum + ep.dialogueLines, 0)),
          atomLines: asNumber(stats.atomLines, episodes.reduce((sum, ep) => sum + ep.atomLines, 0)),
          blocked: asNumber(stats.blocked, blockedEps.length || episodes.filter((ep) => ep.blocked).length),
          durationMs: asNumber(project.durationMs, 0),
          risky,
        },
        phase: { preflight: asString(phase.preflight, asString(project.status, 'unknown')) },
        mode,
        ledger: normalizeLedger(snapshot.ledger || summaryValue.ledger),
        llmCorrection: normalizeLlmCorrection(preflightValue.llmCorrection || snapshot.llmCorrection || summaryValue.llmCorrection),
        episodes,
        checks: isObject(snapshot.checks) ? snapshot.checks : {},
        detection: snapshot.detection || null,
        report: isObject(snapshot.report) ? snapshot.report : {},
        refine: isObject(snapshot.refine) ? normalizeRefineSummary(snapshot.refine) : null,
        bgm: isObject(snapshot.bgm)
          ? { state: asString(snapshot.bgm.state, 'pending'), progress: isObject(snapshot.bgm.progress) ? snapshot.bgm.progress : null }
          : null,
        job: normalizeJob(snapshot.job),
        options: normalizeOptions(snapshot.options),
        engine: isObject(snapshot.engine)
          ? {
              version: asString(snapshot.engine.version, ''),
              checkProfileSource: asString(snapshot.engine.checkProfileSource, ''),
              effectiveCheckProfile: isObject(snapshot.engine.effectiveCheckProfile)
                ? snapshot.engine.effectiveCheckProfile
                : null,
            }
          : null,
        raw: snapshot,
      }
    }

    function normalizeCard(card) {
      const item = isObject(card) ? card : {}
      const checksSummary = isObject(item.checksSummary) ? item.checksSummary : {}
      return {
        id: asString(item.id, ''),
        title: asString(item.title, asString(item.id, '')),
        mode: normalizeModeId(item.mode),
        episodeCount: asNumber(item.episodeCount, 0),
        cjk: asNumber(item.cjk, 0),
        status: asString(item.status, 'unknown'),
        blockedCount: asNumber(item.blockedCount, 0),
        updatedAt: item.updatedAt || item.createdAt || null,
        createdAt: item.createdAt || null,
        checksSummary,
        lastDurationMs: asNumber(item.lastDurationMs, 0),
        job: normalizeJob(item.job),
      }
    }

    function normalizeJob(raw) {
      if (!isObject(raw)) return null
      const episodes = isObject(raw.episodes) ? raw.episodes : {}
      const result = isObject(raw.result) ? raw.result : null
      return {
        schema: asString(raw.schema, ''),
        id: asString(raw.id, ''),
        projectId: asString(raw.projectId, ''),
        kind: asString(raw.kind, ''),
        state: asString(raw.state, 'unknown').toLowerCase(),
        phase: asString(raw.phase, ''),
        phaseIndex: asNumber(raw.phaseIndex, -1),
        phases:
          asArray(raw.phases).length > 0
            ? asArray(raw.phases).map((entry) => asString(entry))
            : (PHASES_BY_KIND[asString(raw.kind, '')] || JOB_PHASES).slice(),
        episodes: {
          total: asNumber(episodes.total, 0),
          done: asNumber(episodes.done, 0),
        },
        error: asString(raw.error, ''),
        failureKind: asString(raw.failureKind, ''),
        budget: normalizeBudget(raw.budget) || (result ? normalizeBudget(result.budget) : null),
        result: result
          ? {
              status: asString(result.status, ''),
              episodes: asNumber(result.episodes, 0),
              blockedEps: asArray(result.blockedEps).map((entry) => asNumber(entry, 0)),
              durationMs: asNumber(result.durationMs, 0),
              detection: isObject(result.detection) ? result.detection : null,
              budget: normalizeBudget(result.budget),
              cost: isObject(result.cost) ? normalizeCost(result.cost) : null,
              checkPassRate: asNumber(result.checkPassRate, 0),
            }
          : null,
        startedAt: raw.startedAt || null,
        updatedAt: raw.updatedAt || null,
        finishedAt: raw.finishedAt || null,
        seq: asNumber(raw.seq, 0),
        detection: isObject(raw.detection) ? raw.detection : null,
        raw,
      }
    }

    function normalizeBudget(raw) {
      if (!isObject(raw)) return null
      const limitTokens = asNumber(pickValue(raw, ['limitTokens', 'limit']), 0)
      const spentTokens = asNumber(pickValue(raw, ['spentTokens', 'spent']), 0)
      const computedRatio = limitTokens > 0 ? spentTokens / limitTokens : 0
      const ratio = asNumber(pickValue(raw, ['ratio']), computedRatio)
      return {
        limitTokens,
        spentTokens,
        ratio: Math.max(0, Math.min(2, ratio)),
        warning: typeof raw.warning === 'boolean' ? raw.warning : ratio >= 0.8,
        exceeded: typeof raw.exceeded === 'boolean' ? raw.exceeded : ratio >= 1,
        stage: asString(pickValue(raw, ['stage']), ''),
        raw,
      }
    }

    function needsConfirmKind(job) {
      if (!job) return ''
      const kind = asString(job.failureKind).toLowerCase()
      if (kind === 'budget' || kind === 'word_locked') return kind
      if (job.state === 'needs_confirm') return 'needs_confirm'
      return ''
    }

    function jobIsRunning(job) {
      return Boolean(job && JOB_RUNNING_STATES[job.state])
    }

    function jobIsTerminal(job) {
      return Boolean(job && JOB_TERMINAL_STATES[job.state])
    }

    function jobPercent(job) {
      if (!job) return 0
      if (job.state === 'succeeded') return 100
      const phases = job.phases.length > 0 ? job.phases : JOB_PHASES
      const total = phases.length
      const index = job.phaseIndex >= 0 ? job.phaseIndex : phases.indexOf(job.phase)
      if (index < 0) return job.state === 'queued' ? 2 : 0
      let value = Math.round(((index + 1) / total) * 100)
      if (job.state === 'queued') value = Math.min(value, 5)
      return Math.max(0, Math.min(100, value))
    }

    function jobStateKind(state) {
      const text = asString(state).toLowerCase()
      if (text === 'succeeded') return 'success'
      if (text === 'failed' || text === 'interrupted') return 'error'
      if (text === 'cancelled') return 'idle'
      if (text === 'needs_confirm') return 'risk'
      return 'brand'
    }

    function jobStateLabel(job, t) {
      const text = asString(job && job.state).toLowerCase()
      if (text === 'queued') return t('job.queued')
      if (text === 'running') return t('job.running')
      if (text === 'succeeded') return t('job.succeeded')
      if (text === 'failed') return t('job.failed')
      if (text === 'cancelled') return t('job.cancelled')
      if (text === 'needs_confirm') return t('job.needsConfirm')
      if (text === 'interrupted') return t('job.interrupted')
      return text || t('common.unknown')
    }

    function phaseLabel(phase, t) {
      const key = `progress.phaseLabel.${asString(phase).toLowerCase()}`
      const translated = t(key)
      return translated === key ? asString(phase) || '—' : translated
    }

    function checkLabelById(checkId, t) {
      const raw = asString(checkId)
      if (!raw) return '—'
      for (let index = 0; index < CHECK_KEYS.length; index += 1) {
        const canonical = CHECK_KEYS[index]
        if (ENGINE_CHECK_IDS[canonical] === raw || canonical.toLowerCase() === raw.toLowerCase()) {
          return t(`check.${canonical}`)
        }
        if (CHECK_ALIASES[canonical].indexOf(raw.toLowerCase()) >= 0) return t(`check.${canonical}`)
      }
      return raw
    }

    function normalizeOptions(raw) {
      const options = isObject(raw) ? raw : {}
      const overrides = isObject(options.check_overrides) ? options.check_overrides : {}
      const pacing = isObject(overrides.pacing) ? overrides.pacing : {}
      return {
        min_words: asNumber(options.min_words, 100),
        max_words: asNumber(options.max_words, 350),
        forbid_cn_elements: options.forbid_cn_elements !== false,
        allowed_terms: asArray(options.allowed_terms).map((entry) => asString(entry)).filter(Boolean),
        check_overrides: {
          pacing: {
            max_atom_run: pacing.max_atom_run !== undefined ? asNumber(pacing.max_atom_run, 4) : null,
            max_atoms_per_spoken: pacing.max_atoms_per_spoken !== undefined ? asNumber(pacing.max_atoms_per_spoken, 3) : null,
            max_spoken_run: pacing.max_spoken_run !== undefined ? asNumber(pacing.max_spoken_run, 8) : null,
          },
        },
        raw: options,
      }
    }

    function normalizeTokens(raw) {
      const value = isObject(raw) ? raw : {}
      const input = asNumber(pickValue(value, ['input', 'inputTokens']), 0)
      const output = asNumber(pickValue(value, ['output', 'outputTokens']), 0)
      const cacheRead = asNumber(pickValue(value, ['cacheRead', 'cacheReadTokens']), 0)
      const cacheWrite = asNumber(pickValue(value, ['cacheWrite', 'cacheWriteTokens']), 0)
      const total = asNumber(pickValue(value, ['total', 'totalTokens']), input + output + cacheRead + cacheWrite)
      return { input, output, cacheRead, cacheWrite, total }
    }

    function normalizeCheckInfo(raw) {
      const value = isObject(raw) ? raw : {}
      const hardFails = asArray(value.hardFails || value.hard_fails || value.fails)
      const warns = asArray(value.warns || value.warnings)
      return {
        hardFails,
        warns,
        verdict: asString(pickValue(value, ['verdict', 'status']), ''),
        raw: value,
      }
    }

    function normalizeRefineEpisode(row) {
      const item = isObject(row) ? row : {}
      const artifacts = isObject(item.artifacts) ? item.artifacts : {}
      return {
        ep: asNumber(pickValue(item, ['ep', 'episode']), 0),
        title: asString(item.title, ''),
        state: asString(pickValue(item, ['state', 'status']), 'pending').toLowerCase(),
        attempts: asNumber(item.attempts, 0),
        check: normalizeCheckInfo(item.check),
        artifacts: {
          draft: asString(artifacts.draft, ''),
          report: asString(artifacts.report, ''),
          notes: asString(artifacts.notes, ''),
        },
        tokens: normalizeTokens(item.tokens),
        cost: normalizeCost(item.cost),
        raw: item,
      }
    }

    function normalizeRefineSummary(raw) {
      const value = isObject(raw) ? raw : {}
      const counts = isObject(value.counts) ? value.counts : isObject(value.progress) ? value.progress : {}
      return {
        state: asString(value.state, 'idle'),
        counts: {
          total: asNumber(counts.total, 0),
          pending: asNumber(counts.pending, 0),
          running: asNumber(counts.running, 0),
          passed: asNumber(counts.passed, 0),
          issues: asNumber(counts.issues, 0),
          blocked: asNumber(counts.blocked, 0),
          failed: asNumber(counts.failed, 0),
        },
        artifacts: isObject(value.artifacts) ? value.artifacts : null,
        cost: isObject(value.cost) ? normalizeCost(value.cost) : null,
      }
    }

    function normalizeRefine(raw) {
      const value = isObject(raw) ? raw : {}
      const progress = isObject(value.progress) ? value.progress : {}
      const artifacts = isObject(value.artifacts) ? value.artifacts : {}
      const job = normalizeJob(value.job)
      return {
        state: asString(value.state, 'idle'),
        progress: {
          total: asNumber(progress.total, 0),
          pending: asNumber(progress.pending, 0),
          running: asNumber(progress.running, 0),
          passed: asNumber(progress.passed, 0),
          issues: asNumber(progress.issues, 0),
          blocked: asNumber(progress.blocked, 0),
          failed: asNumber(progress.failed, 0),
        },
        episodes: asArray(value.episodes).map(normalizeRefineEpisode),
        artifacts: {
          director: artifacts.director || null,
          qcReport: artifacts.qcReport || null,
          summary: artifacts.summary || null,
        },
        tokens: normalizeTokens(value.tokens),
        cost: normalizeCost(value.cost),
        budget: normalizeBudget(value.budget) || (job && job.budget) || null,
        job,
        raw: value,
      }
    }

    function refineStateKind(state) {
      const text = asString(state).toLowerCase()
      if (text === 'done' || text === 'succeeded') return 'success'
      if (text === 'partial') return 'risk'
      if (text === 'running') return 'brand'
      if (text === 'needs_confirm') return 'risk'
      if (text === 'failed' || text === 'blocked') return 'error'
      if (text === 'cancelled' || text === 'paused') return 'idle'
      return 'idle'
    }

    function refineStateLabel(state, t) {
      const text = asString(state).toLowerCase() || 'idle'
      const key = `refine.state.${text}`
      const translated = t(key)
      return translated === key ? text : translated
    }

    function refineEpisodeStateKind(state) {
      const text = asString(state).toLowerCase()
      if (text === 'passed') return 'success'
      if (text === 'passed-with-issues') return 'risk'
      if (text === 'running') return 'brand'
      if (text === 'failed' || text === 'blocked') return 'error'
      return 'idle'
    }

    function refineEpisodeStateLabel(state, t) {
      const text = asString(state).toLowerCase() || 'pending'
      const key = `refine.epState.${text}`
      const translated = t(key)
      return translated === key ? text : translated
    }

    function formatCheckReason(check) {
      if (!check) return ''
      const hardFails = Array.isArray(check.hardFails) ? check.hardFails : []
      const warns = Array.isArray(check.warns) ? check.warns : []
      const parts = []
      if (hardFails.length > 0) parts.push(hardFails.slice(0, 3).join(', '))
      if (warns.length > 0 && parts.length === 0) parts.push(warns.slice(0, 2).join(', '))
      return parts.join('; ')
    }

    function cardRiskState(card, key) {
      const summary = isObject(card && card.checksSummary) ? card.checksSummary[key] : undefined
      const value = isObject(summary) ? summary : summary
      if (isObject(value)) {
        if (value.blocked === true) return 'blocked'
        if (value.risk === true) return 'risk'
        if (value.status !== undefined) return checkStateFromStatus(value.status)
        return 'na'
      }
      if (value === true) return key === 'protagonist' ? 'risk' : 'risk'
      if (value === false) return 'ok'
      return 'na'
    }

    function readSummaryCheck(snapshot, canonicalKey) {
      const checks = isObject(snapshot && snapshot.checks) ? snapshot.checks : {}
      const engineId = ENGINE_CHECK_IDS[canonicalKey]
      const raw = checks[engineId] !== undefined ? checks[engineId] : checks[canonicalKey]
      return isObject(raw) ? raw : null
    }

    function toEpisodeNumbers(value) {
      return asArray(value)
        .map((entry) => asNumber(entry, null))
        .filter((entry) => entry !== null)
    }

    function deriveCheckMatrix(snapshot) {
      const episodes = snapshot.episodes || []
      return CHECK_KEYS.map((key) => {
        const summary = readSummaryCheck(snapshot, key)
        const summaryStatus = summary ? checkStateFromStatus(summary.status) : 'na'
        const riskyFromSummary = toEpisodeNumbers(summary && summary.risky_eps)
        const blockedFromSummary = toEpisodeNumbers(summary && summary.blocked_eps)
        const derivedRisky = []
        const derivedBlocked = []
        let hasData = false
        episodes.forEach((ep) => {
          const raw = readCheckRaw(ep, key)
          if (raw !== undefined) hasData = true
          const state = checkStateFromValue(raw)
          if (state === 'blocked') derivedBlocked.push(ep.ep)
          else if (state === 'risk') derivedRisky.push(ep.ep)
        })
        const blockedEps = blockedFromSummary.length > 0 ? blockedFromSummary : derivedBlocked
        const riskyEps = (riskyFromSummary.length > 0 ? riskyFromSummary : derivedRisky).filter(
          (ep) => blockedEps.indexOf(ep) === -1,
        )
        const statRisk = Boolean(snapshot.stats && snapshot.stats.risky && snapshot.stats.risky[key])
        let state = 'ok'
        if (blockedEps.length > 0 || summaryStatus === 'blocked') state = 'blocked'
        else if (riskyEps.length > 0 || summaryStatus === 'risk' || (!hasData && statRisk)) state = 'risk'
        return { key, state, riskyEps, blockedEps, hasData }
      })
    }

    function statusKind(status) {
      const text = asString(status).toLowerCase()
      if (text === 'preflight_done' || text === 'ok' || text === 'pass' || text === 'passed' || text === 'done') return 'success'
      if (text === 'refine_done') return 'success'
      if (text === 'refine_partial') return 'risk'
      if (text === 'refine_running') return 'brand'
      if (text === 'refine_failed') return 'error'
      if (text === 'refine_cancelled') return 'idle'
      if (
        text === 'blocked' ||
        text === 'no' ||
        text === 'low' ||
        text === 'no_protagonist' ||
        text === 'low_protagonist' ||
        text === 'preflight_failed' ||
        text === 'failed' ||
        text === 'error'
      ) {
        return 'error'
      }
      if (
        text === 'risk' ||
        text === 'warn' ||
        text === 'borderline' ||
        text === 'needs_confirm' ||
        text === 'preflight_running' ||
        text === 'importing'
      ) {
        return 'risk'
      }
      return 'idle'
    }

    function statusLabel(status, t) {
      const text = asString(status)
      const key = `status.${text.toLowerCase()}`
      const translated = t(key)
      return translated === key ? text || t('common.unknown') : translated
    }

    function checkStateLabel(state, t) {
      if (state === 'ok') return t('check.ok')
      if (state === 'risk') return t('check.risk')
      if (state === 'blocked') return t('check.blocked')
      return t('check.na')
    }

    function checkChipClass(state) {
      if (state === 'ok') return 'lb-chip lb-chip-ok'
      if (state === 'risk') return 'lb-chip lb-chip-risk'
      if (state === 'blocked') return 'lb-chip lb-chip-blocked'
      return 'lb-chip'
    }

    function badgeClassForKind(kind) {
      if (kind === 'success') return 'lb-badge lb-badge-success'
      if (kind === 'risk') return 'lb-badge lb-badge-risk'
      if (kind === 'error') return 'lb-badge lb-badge-error'
      if (kind === 'brand') return 'lb-badge lb-badge-brand'
      return 'lb-badge lb-badge-idle'
    }

    // -----------------------------------------------------------------------
    // Icons
    // -----------------------------------------------------------------------
    function Icon(props) {
      const size = (props && props.size) || 24
      const active = Boolean(props && (props.active || props.selected))
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: {
            display: 'block',
            color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
          },
        },
        h('path', { d: 'M5 4.5h9.5A2.5 2.5 0 0 1 17 7v12.5H7.5A2.5 2.5 0 0 1 5 17V4.5Z' }),
        h('path', { d: 'M17 7h2v12.5h-2' }),
        h('path', { d: 'M8.5 8.5h4.5M8.5 11.5h4.5M8.5 14.5h2.5' }),
        h('path', { d: 'M19 19.5 21 18' }),
      )
    }

    function PanelIcon(props) {
      const size = (props && props.size) || 20
      return h(Icon, { size, active: Boolean(props && (props.active || props.selected)) })
    }

    // -----------------------------------------------------------------------
    // Small presentational components
    // -----------------------------------------------------------------------
    function Button(props) {
      const className = ['lb-btn']
      if (props.variant === 'primary') className.push('lb-btn-primary')
      else if (props.variant === 'danger') className.push('lb-btn-danger')
      else if (props.variant === 'ghost') className.push('lb-btn-ghost')
      if (props.className) className.push(props.className)
      return h(
        'button',
        {
          type: 'button',
          className: className.join(' '),
          onClick: props.onClick,
          disabled: Boolean(props.disabled),
          title: props.title || undefined,
          'aria-label': props.ariaLabel || undefined,
        },
        props.children,
      )
    }

    function Badge(props) {
      return h('span', { className: badgeClassForKind(props.kind) }, props.children)
    }

    function CheckChip(props) {
      return h(
        'span',
        { className: checkChipClass(props.state), title: props.title || undefined },
        h('span', null, props.label),
        h('span', { className: 'lb-mono' }, checkStateLabel(props.state, props.t)),
      )
    }

    function ErrorBlock(props) {
      return h(
        'div',
        { className: 'lb-banner', role: 'alert' },
        h('span', { className: 'lb-banner-text' }, props.message || props.t('error.generic', { reason: props.t('common.unknown') })),
        props.onRetry
          ? h(Button, { onClick: props.onRetry, variant: 'ghost' }, props.retryLabel || props.t('common.retry'))
          : null,
      )
    }

    function LoadingBlock(props) {
      return h('div', { className: 'lb-loading', role: 'status' }, props.label || props.t('common.loading'))
    }

    function EmptyState(props) {
      return h(
        'div',
        { className: 'lb-empty' },
        h('div', { className: 'lb-empty-title' }, props.title || props.t('common.empty')),
        props.desc ? h('div', { className: 'lb-empty-desc' }, props.desc) : null,
        props.actionLabel && props.onAction
          ? h('div', { className: 'lb-empty-action' }, h(Button, { variant: 'primary', onClick: props.onAction }, props.actionLabel))
          : null,
      )
    }

    function ProgressBar(props) {
      const pct = asNumber(props.value, 0)
      const width = `${Math.max(0, Math.min(100, pct))}%`
      return h(
        'div',
        { className: 'lb-progress' },
        h(
          'div',
          {
            className: 'lb-progress-track',
            role: 'progressbar',
            'aria-valuenow': Math.max(0, Math.min(100, pct)),
            'aria-valuemin': 0,
            'aria-valuemax': 100,
          },
          h('div', { className: 'lb-progress-fill', style: { width } }),
        ),
        props.label ? h('div', { className: 'lb-progress-label' }, props.label) : null,
      )
    }

    function Section(props) {
      return h(
        'section',
        { className: 'lb-section' },
        h(
          'div',
          { className: 'lb-section-head' },
          h('h2', { className: 'lb-section-title' }, props.title),
          props.actions ? h('div', { className: 'lb-section-actions' }, props.actions) : null,
        ),
        props.children,
      )
    }

    function StatBox(props) {
      const valueClass = props.tone === 'risk' ? 'lb-stat-value lb-stat-value-risk' : props.tone === 'error' ? 'lb-stat-value lb-stat-value-error' : 'lb-stat-value'
      return h(
        'div',
        { className: 'lb-stat' },
        h('div', { className: 'lb-stat-label' }, props.label),
        h('div', { className: valueClass }, props.value),
      )
    }

    function Toast(props) {
      if (!props.toast) return null
      const kind = props.toast.kind === 'error' ? 'lb-toast lb-toast-error' : props.toast.kind === 'success' ? 'lb-toast lb-toast-success' : 'lb-toast'
      return h('div', { className: kind, role: 'status', 'aria-live': 'polite' }, props.toast.message)
    }

    function CostCard(props) {
      const t = props.t
      const pricing = normalizePricing(props.pricing)
      const [clock, setClock] = useState(() => beijingNow())
      useEffect(() => {
        const timer = setInterval(() => setClock(beijingNow()), 1000)
        return () => clearInterval(timer)
      }, [])
      const tariff = tariffFor(pricing, clock.minutes)
      const tariffLabel = tariff === 'idle' ? t('refine.tariffIdle') : t('refine.tariffPeak')
      const cost = resolveCost({ cost: props.cost, tokens: props.tokens, pricing })
      const rates = pricing.rates[tariff] || pricing.rates.peak
      const tokens = isObject(props.tokens) ? props.tokens : {}
      const inputTokens = asNumber(cost.inputTokens, 0) || asNumber(tokens.input, 0)
      const cacheTokens = asNumber(cost.cacheReadTokens, 0) || asNumber(tokens.cacheRead, 0)
      const outputTokens = asNumber(cost.outputTokens, 0) || asNumber(tokens.output, 0)
      const estimate = !isObject(props.cost)
      return h(
        'section',
        { className: 'lb-cost-card' },
        h(
          'div',
          { className: 'lb-section-head' },
          h('h3', { className: 'lb-section-title' }, t('refine.costTitle')),
          h(
            'span',
            { className: tariff === 'idle' ? 'lb-cost-pill lb-cost-pill-idle' : 'lb-cost-pill lb-cost-pill-peak' },
            `${tariffLabel} · ${clock.clock}`,
          ),
          estimate ? h('span', { className: 'lb-cost-pill' }, t('refine.costEstimate')) : null,
        ),
        h('p', { className: 'lb-cost-main' }, formatYuan(cost.total)),
        h(
          'div',
          { className: 'lb-cost-row' },
          h('span', null, `${t('refine.costInput')} ${formatYuan(cost.input)}`),
          h('span', null, `${t('refine.costCacheRead')} ${formatYuan(cost.cacheRead)}`),
          h('span', null, `${t('refine.costOutput')} ${formatYuan(cost.output)}`),
        ),
        h(
          'div',
          { className: 'lb-cost-row' },
          h(
            'span',
            null,
            `${t('refine.tokenInput')} ${formatNumberish(inputTokens)} · ${t('refine.tokenCacheRead')} ${formatNumberish(cacheTokens)} · ${t('refine.tokenOutput')} ${formatNumberish(outputTokens)}`,
          ),
          asNumber(cost.calls, 0) > 0 ? h('span', null, t('refine.costCalls', { n: numberOf(cost.calls) })) : null,
        ),
        h('p', { className: 'lb-cost-note' }, t('refine.costNote')),
        h('p', { className: 'lb-cost-note' }, t('refine.costRates', { miss: rates.inputMiss, hit: rates.inputHit, out: rates.output })),
      )
    }

    function BudgetBar(props) {
      const t = props.t
      const budget = isObject(props.budget) ? props.budget : null
      if (!budget) return null
      const limit = asNumber(budget.limitTokens, 0)
      const spent = asNumber(budget.spentTokens, 0)
      const ratio = asNumber(budget.ratio, limit > 0 ? spent / limit : 0)
      const exceeded = Boolean(budget.exceeded) || ratio >= 1
      const warning = !exceeded && (Boolean(budget.warning) || ratio >= 0.8)
      const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100)
      const stageText = budget.stage
        ? budget.stage === 'refine'
          ? t('project.stage.refine')
          : budget.stage === 'bgm'
            ? t('project.stage.bgm')
            : phaseLabel(budget.stage, t)
        : ''
      const className = exceeded ? 'lb-budget lb-budget-exceeded' : warning ? 'lb-budget lb-budget-warning' : 'lb-budget'
      return h(
        'section',
        { className },
        h(
          'div',
          { className: 'lb-budget-head' },
          h('span', { className: 'lb-budget-title' }, t('budget.title')),
          h('span', { className: 'lb-budget-value' }, `${formatNumberish(spent)} / ${formatNumberish(limit)}`),
          h(
            Badge,
            { kind: exceeded ? 'error' : warning ? 'risk' : 'idle' },
            exceeded ? t('budget.exceeded') : warning ? t('budget.warning') : t('budget.normal'),
          ),
        ),
        h(ProgressBar, { value: percent, label: `${percent}%` }),
        budget.stage ? h('p', { className: 'lb-budget-stage' }, t('budget.stage', { stage: stageText })) : null,
        exceeded ? h('p', { className: 'lb-form-error' }, t('budget.exceededDesc', { limit: formatNumberish(limit) })) : null,
      )
    }

    function FailureBanner(props) {
      const t = props.t
      const job = props.job
      const kind = needsConfirmKind(job)
      if (!kind) return null
      const budget = job && job.budget
      const title =
        kind === 'word_locked'
          ? t('needsConfirm.wordLockedTitle')
          : kind === 'budget'
            ? t('needsConfirm.budgetTitle')
            : t('progress.needsConfirmTitle')
      const desc =
        kind === 'word_locked'
          ? t('needsConfirm.wordLocked')
          : kind === 'budget'
            ? t('needsConfirm.budget')
            : t('progress.needsConfirmDesc')
      return h(
        'section',
        { className: 'lb-banner' },
        h(
          'div',
          { className: 'lb-banner-head' },
          h('strong', null, title),
          h(Badge, { kind: kind === 'budget' ? 'error' : 'risk' }, t('job.needsConfirm')),
        ),
        h('p', { className: 'lb-hint', style: { marginTop: '0' } }, desc),
        kind === 'budget' && budget
          ? h(
              'p',
              { className: 'lb-hint', style: { marginTop: '0' } },
              t('budget.spentLine', { spent: formatNumberish(budget.spentTokens), limit: formatNumberish(budget.limitTokens) }),
            )
          : null,
        kind === 'budget' ? h('p', { className: 'lb-hint', style: { marginTop: '0' } }, t('needsConfirm.keepArtifacts')) : null,
        kind === 'word_locked'
          ? h(
              'div',
              { className: 'lb-actions', style: { marginLeft: '0' } },
              h(Button, { variant: 'primary', disabled: props.busy, onClick: props.onRetry }, t('needsConfirm.retry')),
            )
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // Dual-mode cards (1.0 / 2.0)
    // -----------------------------------------------------------------------
    function ModeBadge(props) {
      const t = props.t
      return h(Badge, { kind: isMode2(props.mode) ? 'brand' : 'idle' }, modeLabel(props.mode, t))
    }

    function LedgerCard(props) {
      const t = props.t
      const ledger = isObject(props.ledger) ? props.ledger : null
      if (!ledger) {
        return h(
          'section',
          { className: 'lb-section' },
          h('h3', { className: 'lb-section-title' }, t('mode.ledgerTitle')),
          h('p', { className: 'lb-hint' }, t('mode.ledgerUnavailable')),
        )
      }
      return h(
        'section',
        { className: 'lb-section' },
        h(
          'div',
          { className: 'lb-section-head' },
          h('h3', { className: 'lb-section-title' }, t('mode.ledgerTitle')),
          h(Badge, { kind: ledger.available ? 'success' : 'idle' }, ledger.available ? t('mode.ledgerReady') : t('mode.ledgerUnavailableBadge')),
        ),
        h(
          'div',
          { className: 'lb-token-grid' },
          h(StatBox, { label: t('mode.ledgerLines'), value: numberOf(ledger.lines) }),
          h(StatBox, { label: t('mode.ledgerTagged'), value: numberOf(ledger.tagged) }),
          h(StatBox, {
            label: t('mode.ledgerUntagged'),
            value: numberOf(ledger.untagged),
            tone: ledger.untagged > 0 ? 'risk' : undefined,
          }),
        ),
        h('p', { className: 'lb-hint' }, t('mode.ledgerDesc')),
      )
    }

    function LlmCorrectionCard(props) {
      const t = props.t
      const correction = isObject(props.correction) ? props.correction : null
      const settings = isObject(props.settings) ? props.settings : null
      const enabled = settings && settings.enabled !== undefined
        ? settings.enabled === true
        : correction
          ? correction.enabled !== false
          : true
      const maxCallsPerEpisode = Number(settings && settings.maxCallsPerEpisode) || Number(correction && correction.maxCallsPerEpisode) || 2
      const [busy, setBusy] = useState(false)
      const stateKey = correction ? asString(correction.status).toLowerCase() : ''
      const toggleCorrection = async () => {
        if (busy || !props.projectId) return
        setBusy(true)
        try {
          const next = !enabled
          const response = await api.updateOptions(props.projectId, {
            llmCorrection: { enabled: next, maxCallsPerEpisode },
          })
          if (response.ok && isObject(response.data) && response.data.ok) {
            if (props.notify) props.notify({ kind: 'success', message: t('toast.actionDone') })
            if (typeof props.onRefresh === 'function') props.onRefresh()
          } else if (props.notify) {
            props.notify({ kind: 'error', message: describeError(errorInfoFromResponse(response, t('common.unknown')), t) })
          }
        } catch (err) {
          if (props.notify) props.notify({ kind: 'error', message: describeError(errorInfoFromException(err, ''), t) })
        } finally {
          setBusy(false)
        }
      }
      const badgeKind =
        !correction || !enabled
          ? 'idle'
          : stateKey === 'failed' || stateKey === 'error'
            ? 'error'
            : stateKey === 'done' || stateKey === 'succeeded' || stateKey === 'passed'
              ? 'success'
              : stateKey === 'skipped' || stateKey === 'disabled'
                ? 'idle'
                : 'risk'
      return h(
        'section',
        { className: 'lb-section' },
        h(
          'div',
          { className: 'lb-section-head' },
          h('h3', { className: 'lb-section-title' }, t('mode.correctionTitle')),
          h(
            Badge,
            { kind: badgeKind },
            !correction
              ? t('mode.correctionUnknown')
              : !enabled
                ? t('mode.correctionOff')
                : stateKey === 'done' || stateKey === 'succeeded' || stateKey === 'passed'
                  ? t('mode.correctionDone')
                  : stateKey === 'skipped'
                    ? t('mode.correctionSkipped')
                    : stateKey === 'failed' || stateKey === 'error'
                      ? t('mode.correctionFailed')
                      : t('mode.correctionOn'),
          ),
          h(
            Button,
            { onClick: () => void toggleCorrection(), disabled: busy },
            busy ? t('common.loading') : enabled ? t('mode.correctionDisable') : t('mode.correctionEnable'),
          ),
        ),
        h('p', { className: 'lb-hint' }, t('mode.correctionToggleHint')),
        correction
          ? h(
              'div',
              { className: 'lb-token-grid' },
              h(StatBox, { label: t('mode.correctionCalls'), value: numberOf(correction.calls) }),
              h(StatBox, { label: t('mode.correctionEpisodes'), value: numberOf(correction.episodes) }),
              h(StatBox, { label: t('mode.correctionLimit'), value: t('mode.correctionLimitPerEpisode', { calls: numberOf(maxCallsPerEpisode) }) }),
            )
          : null,
        h('p', { className: 'lb-hint' }, correction && correction.note ? correction.note : t('mode.correctionDesc')),
        h('p', { className: 'lb-hint' }, t('mode.correctionScope')),
      )
    }

    // -----------------------------------------------------------------------
    // Library
    // -----------------------------------------------------------------------
    function ProjectCardView(props) {
      const card = props.card
      const t = props.t
      return h(
        'article',
        { className: 'lb-card' },
        h(
          'div',
          { className: 'lb-card-top' },
          h('h3', { className: 'lb-card-title', title: card.title }, card.title || card.id),
          h(
            'div',
            { className: 'lb-card-badges' },
            h(ModeBadge, { t, mode: card.mode }),
            h(Badge, { kind: statusKind(card.status) }, statusLabel(card.status, t)),
          ),
        ),
        h(
          'div',
          { className: 'lb-card-meta' },
          `${t('card.episodes', { n: numberOf(card.episodeCount) })} · ${t('card.cjk', { n: numberOf(card.cjk) })}`,
        ),
        card.job
          ? h(
              'div',
              { className: 'lb-job-badge' },
              h(Badge, { kind: jobStateKind(card.job.state) }, jobStateLabel(card.job, t)),
              jobIsRunning(card.job)
                ? h('span', null, t('library.jobRunning', { phase: phaseLabel(card.job.phase, t) }))
                : card.job.state === 'failed'
                  ? h('span', null, t('library.jobFailed'))
                  : card.job.state === 'needs_confirm'
                    ? h('span', null, t('library.jobNeedsConfirm'))
                    : card.job.state === 'cancelled'
                      ? h('span', null, t('library.jobCancelled'))
                      : card.job.state === 'interrupted'
                        ? h('span', null, t('library.jobInterrupted'))
                        : null,
            )
          : null,
        h(
          'div',
          { className: 'lb-card-checks', title: t('card.checks') },
          CHECK_KEYS.map((key) =>
            h(CheckChip, {
              key,
              label: t(`check.${key}`),
              state: cardRiskState(card, key),
              t,
            }),
          ),
        ),
        h(
          'div',
          { className: 'lb-card-foot' },
          h(
            'span',
            { className: 'lb-card-foot-meta' },
            card.blockedCount > 0
              ? t('card.blocked', { n: numberOf(card.blockedCount) })
              : t('card.noBlocked'),
            card.updatedAt ? ` · ${t('card.updated', { time: formatTime(card.updatedAt) })}` : '',
          ),
          h(Button, { variant: 'primary', onClick: () => props.onOpen(card.id) }, t('card.open')),
        ),
      )
    }

    function LibraryView(props) {
      const t = props.t
      const [migrateOpen, setMigrateOpen] = useState(false)
      const [migrateSource, setMigrateSource] = useState('')
      const [migrateTitle, setMigrateTitle] = useState('')
      const [migrating, setMigrating] = useState(false)
      const [migrateError, setMigrateError] = useState(null)

      const closeMigrate = () => {
        if (migrating) return
        setMigrateOpen(false)
        setMigrateError(null)
      }

      const submitMigrate = useCallback(async () => {
        const source = asString(migrateSource).trim()
        if (!source || migrating) return
        setMigrating(true)
        setMigrateError(null)
        try {
          const response = await api.migrateLegacy(source, asString(migrateTitle).trim() || undefined)
          if (response.ok && isObject(response.data) && response.data.ok) {
            setMigrating(false)
            setMigrateOpen(false)
            setMigrateSource('')
            setMigrateTitle('')
            if (typeof props.onMigrated === 'function') props.onMigrated(response.data.project || null)
          } else {
            setMigrating(false)
            setMigrateError(describeError(errorInfoFromResponse(response, t('migrate.failed', { reason: t('common.unknown') })), t))
          }
        } catch (err) {
          setMigrating(false)
          setMigrateError(describeError(errorInfoFromException(err, ''), t))
        }
      }, [migrateSource, migrateTitle, migrating, props, t])

      return h(
        'div',
        null,
        h(
          'header',
          { className: 'lb-header' },
          h('div', { className: 'lb-header-icon' }, h(Icon, { size: 24 })),
          h(
            'div',
            { className: 'lb-header-text' },
            h('h1', { className: 'lb-title' }, t('app.title')),
            h('p', { className: 'lb-subtitle' }, t('library.subtitle')),
          ),
          h(
            'div',
            { className: 'lb-actions' },
            h(Button, { onClick: props.onRefresh, disabled: props.loading }, t('library.refresh')),
            h(Button, { onClick: () => setMigrateOpen((open) => !open) }, t('migrate.open')),
            h(Button, { variant: 'primary', onClick: props.onImport }, t('nav.import')),
            h(Button, { onClick: props.onSettings }, t('nav.settings')),
            h(Button, { onClick: props.onDiagnostics }, t('nav.diagnostics')),
          ),
        ),
        h(
          'div',
          { className: 'lb-mode-bar', role: 'group', 'aria-label': t('mode.switchLabel') },
          h('span', { className: 'lb-mode-bar-label' }, t('mode.switchLabel')),
          (Array.isArray(props.modes) && props.modes.length > 0 ? props.modes : DEFAULT_MODES).map((item) =>
            h(
              'button',
              {
                key: item.id,
                type: 'button',
                className:
                  normalizeModeId(item.id) === normalizeModeId(props.mode)
                    ? 'lb-mode-option lb-mode-option-active'
                    : 'lb-mode-option',
                'aria-pressed': normalizeModeId(item.id) === normalizeModeId(props.mode),
                disabled: Boolean(props.modeLoading),
                onClick: () => props.onModeChange && props.onModeChange(normalizeModeId(item.id)),
              },
              item.label || modeLabel(item.id, t),
            ),
          ),
          h(
            'span',
            { className: 'lb-hint', style: { marginTop: '0' } },
            isMode2(props.mode) ? t('mode.hint2') : t('mode.hint1'),
          ),
        ),
        h(
          'div',
          { className: 'lb-toolbar' },
          h('input', {
            className: 'lb-input lb-input-search',
            type: 'search',
            placeholder: t('library.searchPlaceholder'),
            value: props.search || '',
            'aria-label': t('library.searchPlaceholder'),
            onChange: (event) => props.onSearchChange(event.target.value),
          }),
          h('span', { className: 'lb-hint', style: { marginTop: '0' } }, t('library.sortLabel')),
          h(
            'select',
            {
              className: 'lb-input',
              value: props.sort || 'updated',
              'aria-label': t('library.sortLabel'),
              onChange: (event) => props.onSortChange(event.target.value),
            },
            SORT_OPTIONS.map((value) =>
              h(
                'option',
                { key: value, value },
                value === 'updated' ? t('library.sortUpdated') : value === 'title' ? t('library.sortTitle') : t('library.sortEpisodes'),
              ),
            ),
          ),
        ),
        migrateOpen
          ? h(
              'section',
              { className: 'lb-section', style: { marginTop: '12px' } },
              h('div', { className: 'lb-section-head' }, h('h3', { className: 'lb-section-title' }, t('migrate.title'))),
              h('p', { className: 'lb-hint', style: { marginTop: '0' } }, t('migrate.desc')),
              h(
                'div',
                { className: 'lb-inline-form' },
                h('input', {
                  className: 'lb-input lb-input-search',
                  type: 'text',
                  value: migrateSource,
                  disabled: migrating,
                  placeholder: t('migrate.sourcePlaceholder'),
                  'aria-label': t('migrate.source'),
                  onChange: (event) => setMigrateSource(event.target.value),
                }),
                h('input', {
                  className: 'lb-input lb-input-search',
                  type: 'text',
                  value: migrateTitle,
                  disabled: migrating,
                  placeholder: t('migrate.titlePlaceholder'),
                  'aria-label': t('migrate.titleField'),
                  onChange: (event) => setMigrateTitle(event.target.value),
                }),
                h(
                  Button,
                  { variant: 'primary', disabled: migrating || !asString(migrateSource).trim(), onClick: () => void submitMigrate() },
                  migrating ? t('migrate.submitting') : t('migrate.submit'),
                ),
                h(Button, { onClick: closeMigrate, disabled: migrating }, t('common.cancel')),
              ),
              migrating ? h(LoadingBlock, { t, label: t('migrate.submitting') }) : null,
              migrateError ? h(ErrorBlock, { message: migrateError, t }) : null,
            )
          : null,
        props.error ? h(ErrorBlock, { message: props.error, onRetry: props.onRefresh, t }) : null,
        props.loading && props.projects.length === 0 ? h(LoadingBlock, { t, label: t('library.loading') }) : null,
        !props.loading && props.projects.length === 0 && !props.error
          ? props.search
            ? h(EmptyState, { title: t('library.searchEmpty'), t })
            : h(EmptyState, {
                title: t('library.emptyTitle'),
                desc: t('library.emptyDesc'),
                actionLabel: t('library.emptyAction'),
                onAction: props.onImport,
                t,
              })
          : null,
        props.projects.length > 0
          ? h(
              'div',
              null,
              h('p', { className: 'lb-hint' }, t('library.count', { n: numberOf(props.projects.length) })),
              h(
                'div',
                { className: 'lb-grid' },
                props.projects.map((card) => h(ProjectCardView, { key: card.id, card, t, onOpen: props.onOpen })),
              ),
            )
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // Import wizard
    // -----------------------------------------------------------------------
    function ImportView(props) {
      const t = props.t
      const inputRef = useRef(null)
      const dragDepth = useRef(0)
      const [dragActive, setDragActive] = useState(false)
      const [status, setStatus] = useState('idle') // idle | uploading | done | error
      const [progress, setProgress] = useState(0)
      const [fileName, setFileName] = useState('')
      const [error, setError] = useState(null)
      const [imported, setImported] = useState(null)
      const [llmCorrection, setLlmCorrection] = useState(false)
      const importMode2 = props.mode === MODE_2

      const reset = useCallback(() => {
        setStatus('idle')
        setProgress(0)
        setFileName('')
        setError(null)
        setImported(null)
        setLlmCorrection(false)
      }, [])

      const startUpload = useCallback(
        async (file) => {
          setError(null)
          setFileName(file.name)
          if (!/\.docx$/i.test(file.name)) {
            setStatus('error')
            setError(t('import.invalidExt'))
            return
          }
          if (file.size === 0) {
            setStatus('error')
            setError(t('import.empty'))
            return
          }
          if (file.size > MAX_UPLOAD_BYTES) {
            setStatus('error')
            setError(t('import.tooLarge'))
            return
          }
          const title = file.name.replace(/\.docx$/i, '')
          setStatus('uploading')
          setProgress(0)
          const result = await importDocx(file, title, (pct) => {
            setProgress(pct < 0 ? 0 : pct)
          }, llmCorrection)
          if (result.ok) {
            const data = result.response && result.response.data ? result.response.data : {}
            const project = isObject(data.project) ? data.project : {}
            const importedProject = {
              id: asString(project.id, ''),
              title: asString(project.title, title),
              snapshot: data.snapshot || null,
            }
            setStatus('done')
            setImported(importedProject)
            const job = normalizeJob(data.job)
            if (job && job.id) {
              // Async M2 contract (202): continue in the progress view.
              props.onJobStarted({ job, projectId: importedProject.id, title: importedProject.title, origin: 'import' })
              return
            }
            if (importedProject.id) {
              // Synchronous compatibility mode (?sync=1): the snapshot is ready.
              props.onImported(importedProject)
            }
            return
          }
          setStatus('error')
          const info = result.error || { status: 0, code: '', message: '' }
          const reason = asString(info.message) || describeError(info, t)
          const responseData = result.response && isObject(result.response.data) ? result.response.data : null
          if (responseData && responseData.ok === false) {
            const code = asString(responseData.code)
            if (code === 'NEEDS_CONFIRM') setError(t('import.needsConfirmHelp'))
            else setError(describeError({ status: result.response.status, code, message: asString(responseData.error) }, t))
          } else {
            setError(t('import.failed', { reason }))
          }
        },
        [t, llmCorrection],
      )

      const handleFiles = useCallback(
        (fileList) => {
          const files = fileList ? Array.from(fileList) : []
          if (files.length === 0) return
          void startUpload(files[0])
        },
        [startUpload],
      )

      const onDrop = useCallback(
        (event) => {
          event.preventDefault()
          dragDepth.current = 0
          setDragActive(false)
          if (status === 'uploading') return
          handleFiles(event.dataTransfer && event.dataTransfer.files)
        },
        [handleFiles, status],
      )

      const onDragEnter = useCallback((event) => {
        event.preventDefault()
        dragDepth.current += 1
        setDragActive(true)
      }, [])

      const onDragLeave = useCallback((event) => {
        event.preventDefault()
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragActive(false)
      }, [])

      const onDragOver = useCallback((event) => {
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      }, [])

      const uploading = status === 'uploading'
      return h(
        'div',
        null,
        h(
          'header',
          { className: 'lb-header' },
          h('div', { className: 'lb-header-icon' }, h(Icon, { size: 24 })),
          h(
            'div',
            { className: 'lb-header-text' },
            h('h1', { className: 'lb-title' }, t('import.title')),
            h('p', { className: 'lb-subtitle' }, t('import.subtitle')),
          ),
          h('div', { className: 'lb-actions' }, h(Button, { onClick: props.onBack }, t('nav.back'))),
        ),
        h('input', {
          ref: inputRef,
          className: 'lb-file-input',
          type: 'file',
          accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          tabIndex: -1,
          onChange: (event) => {
            handleFiles(event.target.files)
            event.target.value = ''
          },
        }),
        importMode2
          ? h(
              'section',
              { className: 'lb-section' },
              h(
                'label',
                { className: 'lb-mode-bar', style: { cursor: uploading ? 'default' : 'pointer' } },
                h('input', {
                  type: 'checkbox',
                  checked: llmCorrection,
                  disabled: uploading,
                  onChange: (event) => setLlmCorrection(Boolean(event.target.checked)),
                }),
                h('span', { className: 'lb-mode-bar-label' }, t('import.correctionToggle')),
              ),
              h('p', { className: 'lb-hint' }, t('import.correctionDesc')),
            )
          : null,
        status === 'done' && imported
          ? h(
              'section',
              { className: 'lb-section' },
              h(
                'div',
                { className: 'lb-section-head' },
                h('h2', { className: 'lb-section-title' }, t('import.success', { title: imported.title })),
              ),
              h('p', { className: 'lb-hint' }, t('toast.imported', { title: imported.title })),
              h(
                'div',
                { className: 'lb-actions', style: { marginTop: '12px', marginLeft: '0' } },
                h(Button, { variant: 'primary', onClick: () => props.onImported(imported) }, t('import.done')),
                h(Button, { onClick: reset }, t('import.choose')),
                h(Button, { onClick: props.onBack }, t('import.back')),
              ),
            )
          : h(
              'div',
              {
                className: dragActive ? 'lb-dropzone lb-dropzone-active' : 'lb-dropzone',
                role: 'button',
                tabIndex: 0,
                'aria-label': t('import.drop'),
                onClick: () => {
                  if (uploading) return
                  if (inputRef.current) inputRef.current.click()
                },
                onKeyDown: (event) => {
                  if (uploading) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    if (inputRef.current) inputRef.current.click()
                  }
                },
                onDrop,
                onDragEnter,
                onDragLeave,
                onDragOver,
              },
              h('div', { className: 'lb-dropzone-title' }, t('import.drop')),
              h('div', { className: 'lb-dropzone-hint' }, t('import.hint')),
            ),
        uploading || status === 'done'
          ? h(ProgressBar, {
              value: status === 'done' ? 100 : progress,
              label:
                status === 'done'
                  ? t('import.success', { title: fileName })
                  : progress >= 100
                    ? t('import.processing')
                    : t('import.uploading', { pct: progress }),
            })
          : null,
        status === 'error' && error
          ? h(ErrorBlock, { message: error, onRetry: reset, retryLabel: t('import.retry'), t })
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // Async job progress (SSE + 1s polling fallback)
    // -----------------------------------------------------------------------
    function ProgressView(props) {
      const t = props.t
      const [job, setJob] = useState(normalizeJob(props.initialJob))
      const [logs, setLogs] = useState([])
      const [conn, setConn] = useState('connecting')
      const [error, setError] = useState(null)
      const [cancelling, setCancelling] = useState(false)
      const [tokens, setTokens] = useState(null)
      const [cost, setCost] = useState(null)
      const [episodeStates, setEpisodeStates] = useState({})
      const finishedRef = useRef(false)
      const episodeStatesRef = useRef({})
      const logRef = useRef(null)
      const sourceRef = useRef(null)
      const projectIdRef = useRef(props.projectId || '')
      const jobRef = useRef(job)

      const applyJob = useCallback((nextJob) => {
        if (!nextJob) return
        jobRef.current = nextJob
        if (nextJob.projectId) projectIdRef.current = nextJob.projectId
        setJob(nextJob)
      }, [])

      const appendLog = useCallback((entry) => {
        setLogs((previous) => {
          const next = previous.concat([entry])
          return next.length > 300 ? next.slice(next.length - 300) : next
        })
      }, [])

      const refreshJob = useCallback(async () => {
        if (!props.jobId) return null
        try {
          const response = await api.job(props.jobId)
          if (response.ok && isObject(response.data) && response.data.ok) {
            const next = normalizeJob(response.data.job)
            if (next) {
              applyJob(next)
              return next
            }
          } else if (!finishedRef.current) {
            setError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
          }
        } catch (err) {
          if (!finishedRef.current) setError(describeError(errorInfoFromException(err, ''), t))
        }
        return null
      }, [props.jobId, applyJob, t])

      useEffect(() => {
        void refreshJob()
      }, [refreshJob])

      useEffect(() => {
        if (!job || finishedRef.current || !jobIsTerminal(job)) return undefined
        finishedRef.current = true
        if (sourceRef.current) {
          try {
            sourceRef.current.close()
          } catch {
            // ignore
          }
          sourceRef.current = null
        }
        if (job.state === 'succeeded' && projectIdRef.current && typeof props.onDone === 'function') {
          const timer = setTimeout(() => props.onDone(projectIdRef.current), 800)
          return () => clearTimeout(timer)
        }
        return undefined
        // Only react to job transitions; handlers are stable root callbacks.
      }, [job])

      useEffect(() => {
        const node = logRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [logs.length])

      useEffect(() => {
        if (!props.jobId) return undefined
        if (finishedRef.current) return undefined
        let disposed = false
        let source = null
        let pollTimer = null
        let watchdog = null
        let lastEventAt = Date.now()
        let sseErrors = 0

        const stopPolling = () => {
          if (pollTimer) {
            clearInterval(pollTimer)
            pollTimer = null
          }
        }
        const startPolling = () => {
          if (disposed || pollTimer) return
          setConn('polling')
          if (source) {
            try {
              source.close()
            } catch {
              // ignore
            }
            source = null
          }
          pollTimer = setInterval(() => {
            void refreshJob().then((next) => {
              if (next && jobIsTerminal(next)) stopPolling()
            })
          }, 1000)
        }
        const mergeFlat = (patch) => {
          setJob((previous) => {
            const base = previous || normalizeJob({})
            const next = Object.assign({}, base, patch)
            if (patch.episodes) {
              next.episodes = {
                total: asNumber(patch.episodes.total, base.episodes.total),
                done: asNumber(patch.episodes.done, base.episodes.done),
              }
            }
            jobRef.current = next
            return next
          })
        }
        const handlePayload = (payload) => {
          if (!isObject(payload)) return
          const type = asString(payload.type)
          if (type === 'log') {
            appendLog({
              id: `${Date.now()}-${Math.random()}`,
              ts: payload.ts || new Date().toISOString(),
              level: asString(payload.level, 'info'),
              phase: asString(payload.phase, ''),
              message: asString(payload.message || payload.text || payload.line, ''),
            })
            return
          }
          if (isObject(payload.job)) {
            applyJob(normalizeJob(payload.job))
            return
          }
          if (type === 'phase') {
            mergeFlat({
              phase: asString(payload.phase || payload.name, jobRef.current ? jobRef.current.phase : ''),
              phaseIndex:
                payload.phaseIndex !== undefined
                  ? asNumber(payload.phaseIndex, -1)
                  : payload.index !== undefined
                    ? asNumber(payload.index, -1)
                    : jobRef.current
                      ? jobRef.current.phaseIndex
                      : -1,
            })
            return
          }
          if (type === 'episode') {
            const epNumber = asNumber(payload.ep, 0)
            const rawState = asString(payload.state, '')
            if (rawState) {
              const stateLower = rawState.toLowerCase()
              const checkInfo = normalizeCheckInfo(payload.check)
              const entry = {
                ep: epNumber,
                state: stateLower,
                attempts: asNumber(payload.attempts, episodeStatesRef.current[epNumber] ? episodeStatesRef.current[epNumber].attempts : 0),
                check: checkInfo,
              }
              episodeStatesRef.current = Object.assign({}, episodeStatesRef.current, { [epNumber]: entry })
              setEpisodeStates(episodeStatesRef.current)
              const reason = formatCheckReason(checkInfo)
              const level = stateLower === 'failed' || stateLower === 'blocked' ? 'error' : stateLower === 'passed' ? 'done' : 'info'
              appendLog({
                id: `${Date.now()}-${Math.random()}`,
                ts: new Date().toISOString(),
                level,
                phase: '',
                message: `EP${epNumber} → ${refineEpisodeStateLabel(stateLower, t)}${entry.attempts ? ` · ${t('refine.colAttempts')} ${entry.attempts}` : ''}${reason ? ` · ${reason}` : ''}`,
              })
              setJob((previous) => {
                const base = previous || normalizeJob({})
                const states = episodeStatesRef.current
                const doneCount = Object.keys(states).filter((key) => {
                  const item = states[key]
                  return Boolean(item && REFINE_TERMINAL_STATES[asString(item.state).toLowerCase()])
                }).length
                const nextTotal = Math.max(base.episodes.total, epNumber, doneCount)
                const next = Object.assign({}, base, { episodes: { total: nextTotal, done: doneCount } })
                jobRef.current = next
                return next
              })
            } else {
              mergeFlat({ episodes: isObject(payload.episodes) ? payload.episodes : { total: payload.total, done: payload.done } })
            }
            return
          }
          if (type === 'token') {
            const usage = normalizeTokens(payload.usage || payload)
            setTokens((previous) => {
              const base = previous || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
              const next = {
                input: base.input + usage.input,
                output: base.output + usage.output,
                cacheRead: base.cacheRead + usage.cacheRead,
                cacheWrite: base.cacheWrite + usage.cacheWrite,
              }
              next.total = next.input + next.output + next.cacheRead + next.cacheWrite
              return next
            })
            if (isObject(payload.costTotal)) {
              setCost(normalizeCost(payload.costTotal))
            } else if (isObject(payload.cost)) {
              const numericTotal =
                typeof payload.costTotal === 'number' && Number.isFinite(payload.costTotal) ? payload.costTotal : null
              const delta = normalizeCost(payload.cost)
              setCost((previous) => {
                const base = previous || normalizeCost({})
                const input = base.input + delta.input
                const cacheRead = base.cacheRead + delta.cacheRead
                const output = base.output + delta.output
                return normalizeCost({
                  currency: delta.currency || base.currency,
                  tariff: delta.tariff || base.tariff,
                  input,
                  cacheRead,
                  output,
                  total: numericTotal !== null ? numericTotal : input + cacheRead + output,
                  calls: base.calls + 1,
                  inputTokens: base.inputTokens + delta.inputTokens,
                  cacheReadTokens: base.cacheReadTokens + delta.cacheReadTokens,
                  outputTokens: base.outputTokens + delta.outputTokens,
                })
              })
            }
            return
          }
          if (type === 'done' || type === 'error' || payload.state) {
            const merged = normalizeJob(
              Object.assign({}, jobRef.current && jobRef.current.raw ? jobRef.current.raw : {}, payload, {
                state: payload.state || (type === 'done' ? 'succeeded' : type === 'error' ? 'failed' : jobRef.current ? jobRef.current.state : 'running'),
              }),
            )
            if (merged) {
              if ((type === 'error' || merged.state === 'failed') && !merged.error) merged.error = asString(payload.error || payload.message, '')
              applyJob(merged)
              if (type === 'error') setError(asString(payload.error || payload.message, '') || t('progress.failedTitle'))
            }
          }
        }
        const connect = () => {
          if (disposed || finishedRef.current) return
          try {
            if (typeof EventSource === 'undefined') {
              startPolling()
              return
            }
            source = new EventSource(api.eventsUrl(props.jobId))
            sourceRef.current = source
            source.onopen = () => {
              if (disposed) return
              setConn('open')
              lastEventAt = Date.now()
              sseErrors = 0
            }
            source.onmessage = (event) => {
              if (disposed) return
              lastEventAt = Date.now()
              if (typeof event.data !== 'string' || event.data.length === 0) return
              try {
                handlePayload(JSON.parse(event.data))
              } catch {
                // ignore malformed SSE payloads
              }
            }
            source.onerror = () => {
              if (disposed) return
              sseErrors += 1
              if (!source || source.readyState === 2 || sseErrors >= 3) startPolling()
              else setConn('retry')
            }
          } catch {
            startPolling()
          }
        }
        connect()
        watchdog = setInterval(() => {
          if (disposed) return
          if (Date.now() - lastEventAt > 30000) startPolling()
        }, 5000)
        return () => {
          disposed = true
          stopPolling()
          if (watchdog) clearInterval(watchdog)
          if (source) {
            try {
              source.close()
            } catch {
              // ignore
            }
          }
          if (sourceRef.current === source) sourceRef.current = null
        }
      }, [props.jobId, applyJob, appendLog, refreshJob, t])

      const cancel = useCallback(async () => {
        if (!props.jobId || cancelling) return
        setCancelling(true)
        setError(null)
        try {
          const response = await api.cancelJob(props.jobId)
          if (response.ok && isObject(response.data) && response.data.ok) {
            const next = normalizeJob(response.data.job)
            if (next) applyJob(next)
            else void refreshJob()
          } else {
            setError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
          }
        } catch (err) {
          setError(describeError(errorInfoFromException(err, ''), t))
        } finally {
          setCancelling(false)
        }
      }, [props.jobId, cancelling, applyJob, refreshJob, t])

      const current = job
      const running = Boolean(current && jobIsRunning(current))
      const terminal = Boolean(current && jobIsTerminal(current))
      const percent = jobPercent(current)
      const phases = current && current.phases.length > 0 ? current.phases : JOB_PHASES
      const activeIndex = current ? (current.phaseIndex >= 0 ? current.phaseIndex : phases.indexOf(current.phase)) : -1
      const failedPhase = Boolean(current && (current.state === 'failed' || current.state === 'needs_confirm' || current.state === 'interrupted'))
      const detection = current ? current.detection || (current.result && current.result.detection ? current.result.detection : null) : null
      const isRefineJob = Boolean(current && (current.kind === 'refine' || current.kind === 'refine2' || current.kind === 'storyboard'))
      const connKey =
        conn === 'open' ? 'progress.connectionOpen' : conn === 'polling' ? 'progress.connectionPolling' : conn === 'retry' ? 'progress.connectionRetry' : 'progress.connectionClosed'
      const connKind = conn === 'open' ? 'success' : conn === 'polling' ? 'risk' : 'idle'
      const displayCost = resolveCost({
        cost: cost || (current && isObject(current.result) ? current.result.cost : null),
        tokens,
        pricing: props.pricing,
      })

      const stepper = h(
        'div',
        { className: 'lb-stepper' },
        phases.map((phase, index) => {
          let className = 'lb-step'
          if (current && current.state === 'succeeded') className += ' lb-step-done'
          else if (failedPhase && index === Math.max(0, activeIndex)) className += ' lb-step-fail'
          else if (index < activeIndex) className += ' lb-step-done'
          else if (index === activeIndex) className += ' lb-step-active'
          return h(
            'span',
            { key: phase, className },
            h('span', { className: 'lb-step-dot', 'aria-hidden': true }),
            phaseLabel(phase, t),
          )
        }),
      )

      const terminalActions = h(
        'div',
        { className: 'lb-actions', style: { marginLeft: '0', marginTop: '12px' } },
        projectIdRef.current
          ? h(Button, { variant: 'primary', onClick: () => props.onDone(projectIdRef.current) }, t('progress.openProject'))
          : null,
        h(Button, { onClick: props.onReimport }, t('progress.reimport')),
        h(Button, { onClick: props.onBack }, t('progress.back')),
      )

      let terminalPanel = null
      if (current && terminal) {
        if (current.state === 'succeeded') {
          const result = current.result || {}
          const resultEpisodes = isObject(result.episodes)
            ? asNumber(
                result.episodes.total,
                asNumber(result.episodes.passed, 0) + asNumber(result.episodes.issues, 0) + asNumber(result.episodes.failed, 0),
              )
            : asNumber(result.episodes, current.episodes.done)
          const finishedMs =
            current.startedAt && current.finishedAt
              ? Math.max(0, new Date(current.finishedAt).getTime() - new Date(current.startedAt).getTime())
              : 0
          const elapsedMs = asNumber(result.durationMs, 0) || finishedMs
          terminalPanel = h(
            Section,
            { title: isRefineJob ? t('refine.doneTitle') : t('progress.doneTitle'), actions: h(Badge, { kind: 'success' }, jobStateLabel(current, t)) },
            h('p', { className: 'lb-hint' }, t('progress.doneDesc', { eps: numberOf(resultEpisodes), duration: formatDuration(elapsedMs) })),
            isRefineJob && result.checkPassRate !== undefined && result.checkPassRate !== null
              ? h('p', { className: 'lb-hint' }, t('refine.passRate', { pct: Math.round(asNumber(result.checkPassRate, 0) * 100) }))
              : null,
            isRefineJob ? null : h('p', { className: 'lb-hint' }, `${t('stats.blocked')}: ${numberOf((result.blockedEps || []).length)}`),
            tokens && tokens.total > 0
              ? h(
                  'div',
                  { className: 'lb-token-grid' },
                  h(StatBox, { label: t('refine.tokenInput'), value: numberOf(tokens.input) }),
                  h(StatBox, { label: t('refine.tokenOutput'), value: numberOf(tokens.output) }),
                  h(StatBox, { label: t('refine.tokenCacheRead'), value: numberOf(tokens.cacheRead) }),
                  h(StatBox, { label: t('refine.tokenTotal'), value: numberOf(tokens.total) }),
                  h(StatBox, { label: t('refine.costTotal'), value: formatYuan(displayCost.total) }),
                )
              : null,
            (tokens && tokens.total > 0) || cost
              ? h(CostCard, {
                  t,
                  pricing: props.pricing,
                  cost: cost || (current && isObject(current.result) ? current.result.cost : null),
                  tokens,
                })
              : null,
            terminalActions,
          )
        } else if (current.state === 'needs_confirm') {
          terminalPanel = h(
            Section,
            {
              title:
                needsConfirmKind(current) === 'word_locked'
                  ? t('needsConfirm.wordLockedTitle')
                  : needsConfirmKind(current) === 'budget'
                    ? t('needsConfirm.budgetTitle')
                    : t('progress.needsConfirmTitle'),
              actions: h(
                Badge,
                { kind: needsConfirmKind(current) === 'budget' ? 'error' : 'risk' },
                jobStateLabel(current, t),
              ),
            },
            h(
              'p',
              { className: 'lb-hint' },
              needsConfirmKind(current) === 'word_locked'
                ? t('needsConfirm.wordLocked')
                : needsConfirmKind(current) === 'budget'
                  ? t('needsConfirm.budget')
                  : t('progress.needsConfirmDesc'),
            ),
            needsConfirmKind(current) === 'budget' ? h('p', { className: 'lb-hint' }, t('needsConfirm.keepArtifacts')) : null,
            current.error ? h('p', { className: 'lb-form-error' }, current.error) : null,
            detection ? h('div', null, h('h3', { className: 'lb-report-heading' }, t('progress.detection')), h(PrettyJson, { value: detection })) : null,
            terminalActions,
          )
        } else if (current.state === 'cancelled') {
          terminalPanel = h(
            Section,
            { title: t('progress.cancelledTitle'), actions: h(Badge, { kind: 'idle' }, jobStateLabel(current, t)) },
            current.error ? h('p', { className: 'lb-form-error' }, current.error) : null,
            terminalActions,
          )
        } else {
          terminalPanel = h(
            Section,
            { title: t('progress.failedTitle'), actions: h(Badge, { kind: 'error' }, jobStateLabel(current, t)) },
            h('p', { className: 'lb-form-error' }, current.error || t('progress.interruptedDesc')),
            detection ? h('div', null, h('h3', { className: 'lb-report-heading' }, t('progress.detection')), h(PrettyJson, { value: detection })) : null,
            terminalActions,
          )
        }
      }

      return h(
        'div',
        null,
        h(
          'header',
          { className: 'lb-header' },
          h('div', { className: 'lb-header-icon' }, h(Icon, { size: 24 })),
          h(
            'div',
            { className: 'lb-header-text' },
            h('h1', { className: 'lb-title' }, isRefineJob ? t('refine.progressTitle') : t('progress.title')),
            h('p', { className: 'lb-subtitle' }, isRefineJob ? t('refine.subtitle') : t('progress.subtitle')),
          ),
          h(
            'div',
            { className: 'lb-actions' },
            h(Badge, { kind: connKind }, t(connKey)),
            running ? h(Button, { variant: 'danger', onClick: () => void cancel(), disabled: cancelling }, cancelling ? t('project.actionsBusy') : t('job.cancel')) : null,
            h(Button, { onClick: props.onBack }, t('progress.back')),
          ),
        ),
        error ? h(ErrorBlock, { message: error, t }) : null,
        terminalPanel
          ? terminalPanel
          : h(
              Section,
              {
                title: t('job.title'),
                actions: h(Badge, { kind: current ? jobStateKind(current.state) : 'brand' }, current ? jobStateLabel(current, t) : t('job.queued')),
              },
              h(ProgressBar, { value: percent, label: `${t('job.percent')} ${percent}%` }),
              stepper,
              h(
                'div',
                { className: 'lb-progress-meta' },
                h('span', null, `${t('job.phase')}: `, h('strong', null, current ? phaseLabel(current.phase, t) : '—')),
                h('span', null, `${t('job.episodes')}: `, h('strong', null, current ? `${current.episodes.done}/${current.episodes.total}` : '0/0')),
                h('span', null, `${t('job.percent')}: `, h('strong', null, `${percent}%`)),
                current && current.startedAt ? h('span', null, t('job.startedAt', { time: formatTime(current.startedAt) })) : null,
              ),
              tokens && tokens.total > 0
                ? h(
                    'div',
                    { className: 'lb-token-grid' },
                    h(StatBox, { label: t('refine.tokenInput'), value: numberOf(tokens.input) }),
                    h(StatBox, { label: t('refine.tokenOutput'), value: numberOf(tokens.output) }),
                    h(StatBox, { label: t('refine.tokenCacheRead'), value: numberOf(tokens.cacheRead) }),
                    h(StatBox, { label: t('refine.tokenTotal'), value: numberOf(tokens.total) }),
                    h(StatBox, { label: t('refine.costTotal'), value: formatYuan(displayCost.total) }),
                  )
                : null,
              (tokens && tokens.total > 0) || cost
                ? h(CostCard, {
                    t,
                    pricing: props.pricing,
                    cost: cost || (current && isObject(current.result) ? current.result.cost : null),
                    tokens,
                  })
                : null,
              Object.keys(episodeStates).length > 0
                ? h(
                    'div',
                    { className: 'lb-ep-chips' },
                    Object.keys(episodeStates)
                      .map((key) => episodeStates[key])
                      .sort((left, right) => left.ep - right.ep)
                      .slice(-24)
                      .map((entry) =>
                        h(
                          Badge,
                          { key: `ep-chip-${entry.ep}`, kind: refineEpisodeStateKind(entry.state) },
                          `EP${entry.ep} · ${refineEpisodeStateLabel(entry.state, t)}`,
                        ),
                      ),
                  )
                : null,
              h('h3', { className: 'lb-report-heading' }, t('progress.log')),
              h(
                'div',
                { className: 'lb-log', ref: logRef, role: 'log', 'aria-live': 'off' },
                logs.length === 0
                  ? h('div', { className: 'lb-hint', style: { marginTop: '0' } }, t('progress.logEmpty'))
                  : logs.map((entry) =>
                      h(
                        'div',
                        {
                          key: entry.id,
                          className:
                            entry.level === 'error' ? 'lb-log-line lb-log-error' : entry.level === 'done' ? 'lb-log-line lb-log-done' : 'lb-log-line',
                        },
                        h('span', { className: 'lb-log-time' }, formatTime(entry.ts)),
                        entry.phase ? h('span', { className: 'lb-log-time' }, `[${phaseLabel(entry.phase, t)}] `) : null,
                        entry.message,
                      ),
                    ),
              ),
              detection ? h('div', null, h('h3', { className: 'lb-report-heading' }, t('progress.detection')), h(PrettyJson, { value: detection })) : null,
            ),
      )
    }

    // -----------------------------------------------------------------------
    // Project detail
    // -----------------------------------------------------------------------
    function StageBar(props) {
      const t = props.t
      const preflight = asString(props.preflightStatus, 'unknown').toLowerCase()
      const preflightDoneStage = statusKind(preflight) === 'success' || preflight.indexOf('refine_') === 0
      const refine = asString(props.refineState, 'idle').toLowerCase()
      const refineStage =
        refine === 'running'
          ? 'run'
          : refine === 'done' || refine === 'partial' || refine === 'succeeded'
            ? 'done'
            : refine === 'needs_confirm'
              ? 'fail'
              : refine === 'failed' || refine === 'blocked'
                ? 'fail'
                : 'idle'
      const bgm = asString(props.bgmState, 'idle').toLowerCase()
      const bgmStage =
        bgm === 'running'
          ? 'run'
          : bgm === 'needs_confirm'
            ? 'fail'
            : bgm === 'failed'
              ? 'fail'
              : bgm === 'succeeded' || bgm === 'done' || bgm === 'partial'
                ? 'done'
                : 'idle'
      const stages = [
        { key: 'import', state: 'done' },
        {
          key: 'preflight',
          state: preflightDoneStage ? 'done' : statusKind(preflight) === 'error' ? 'fail' : statusKind(preflight) === 'risk' ? 'run' : 'idle',
        },
        { key: 'refine', state: refineStage },
        { key: 'bgm', state: isMode2(props.mode) ? 'idle' : bgmStage, note: isMode2(props.mode) },
      ]
      return h(
        'div',
        { className: 'lb-stages', 'aria-label': t('project.overview') },
        stages.map((stage, index) =>
          h(
            React.Fragment,
            { key: stage.key },
            index > 0 ? h('span', { className: 'lb-stage-sep', 'aria-hidden': true }, '→') : null,
            h(
              'span',
              { className: `lb-stage lb-stage-${stage.state}` },
              h('span', { className: 'lb-stage-dot', 'aria-hidden': true }),
              h(
                'span',
                { className: 'lb-stage-label' },
                stage.key === 'refine' && isMode2(props.mode) ? t('mode.stageRefine2') : t(`project.stage.${stage.key}`),
              ),
              stage.note
                ? h(
                    'span',
                    { className: 'lb-stage-note' },
                    stage.key === 'bgm' && isMode2(props.mode) ? t('mode.stageBgm2') : t('project.stage.notAvailable'),
                  )
                : null,
            ),
          ),
        ),
      )
    }

    function JobBar(props) {
      const t = props.t
      const [confirming, setConfirming] = useState(false)
      const job = props.job
      if (!job) return null
      const running = jobIsRunning(job)
      const kindText =
        job.kind === 'rerun-preflight'
          ? t('job.kindRerun')
          : job.kind === 'import-preflight'
            ? t('job.kindImport')
            : job.kind === 'refine'
              ? t('refine.jobKind')
              : job.kind === 'refine2' || job.kind === 'storyboard'
                ? t('story.jobKind')
                : job.kind === 'bgm'
                  ? t('bgm.jobKind')
                  : ''
      return h(
        'section',
        { className: 'lb-jobbar' },
        h(
          'div',
          { className: 'lb-jobbar-main' },
          h(
            'div',
            { className: 'lb-jobbar-title' },
            h(
              Badge,
              { kind: job.failureKind === 'budget' ? 'error' : jobStateKind(job.state) },
              jobStateLabel(job, t),
            ),
            h('span', null, `${t('job.title')}${kindText ? ` · ${kindText}` : ''}`),
          ),
          h(
            'div',
            { className: 'lb-jobbar-meta' },
            `${t('job.phase')}: ${phaseLabel(job.phase, t)}${job.phaseIndex >= 0 ? ` (${job.phaseIndex + 1}/${job.phases.length})` : ''} · ${t('job.episodes')}: ${job.episodes.done}/${job.episodes.total}`,
            job.startedAt ? ` · ${t('job.startedAt', { time: formatTime(job.startedAt) })}` : '',
            job.failureKind === 'word_locked'
              ? ` · ${t('job.failureKind.word_locked')}`
              : job.failureKind === 'budget'
                ? ` · ${t('job.failureKind.budget')}`
                : '',
            job.result && job.result.blockedEps && job.result.blockedEps.length > 0
              ? ` · ${t('card.blocked', { n: job.result.blockedEps.length })}`
              : '',
            job.error ? ` · ${job.error}` : '',
          ),
        ),
        running
          ? confirming
            ? h(
                React.Fragment,
                null,
                h('span', { className: 'lb-confirm-text' }, t('job.cancelConfirm')),
                h(Button, { variant: 'danger', onClick: props.onCancel, disabled: props.cancelling }, t('common.confirm')),
                h(Button, { onClick: () => setConfirming(false) }, t('common.cancel')),
              )
            : h(Button, { onClick: () => setConfirming(true) }, t('job.cancel'))
          : null,
        h(Button, { variant: 'primary', onClick: props.onViewProgress }, t('job.viewProgress')),
      )
    }

    function CheckMatrix(props) {
      const t = props.t
      const matrix = props.matrix
      return h(
        Section,
        {
          title: t('matrix.title'),
          actions: h(Badge, { kind: 'brand' }, t('matrix.aiUsed')),
        },
        h(
          'div',
          { className: 'lb-table-wrap' },
          h(
            'table',
            { className: 'lb-table', style: { minWidth: '560px' } },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col' }, t('matrix.check')),
                h('th', { scope: 'col' }, t('matrix.state')),
                h('th', { scope: 'col' }, t('matrix.riskEps')),
              ),
            ),
            h(
              'tbody',
              null,
              matrix.map((row) =>
                h(
                  'tr',
                  { key: row.key },
                  h('td', null, t(`check.${row.key}`)),
                  h('td', null, h('span', { className: checkChipClass(row.state) }, checkStateLabel(row.state, t))),
                  h(
                    'td',
                    null,
                    row.blockedEps.length > 0
                      ? t('card.blocked', { n: row.blockedEps.length })
                      : row.riskyEps.length > 0
                        ? row.riskyEps.join(', ')
                        : t('matrix.none'),
                  ),
                ),
              ),
            ),
          ),
        ),
        h('p', { className: 'lb-hint' }, t('matrix.hint')),
      )
    }

    function FindingsList(props) {
      const t = props.t
      const findings = asArray(props.findings)
      if (findings.length === 0) return h('p', { className: 'lb-hint' }, t('findings.none'))
      return h(
        'div',
        { className: 'lb-findings' },
        h('div', { className: 'lb-subheader-title' }, t('findings.title')),
        findings.slice(0, 100).map((finding, index) => {
          const item = isObject(finding) ? finding : {}
          const severity = asString(item.severity).toLowerCase()
          const blockedSeverity = severity === 'blocked' || severity === 'block' || severity === 'low' || severity === 'no'
          const severityClass =
            blockedSeverity || severity === 'must_fix' || severity === 'must-fix'
              ? 'lb-sev-must'
              : severity === 'suspected' || severity === 'risk' || severity === 'warn'
                ? 'lb-sev-suspected'
                : 'lb-sev-info'
          const severityLabel =
            blockedSeverity
              ? t('findings.blocked')
              : severityClass === 'lb-sev-must'
                ? t('findings.mustFix')
                : severity === 'suspected'
                  ? t('findings.suspected')
                  : severity === 'risk' || severity === 'warn'
                    ? t('findings.risk')
                    : t('findings.info')
          const locationParts = []
          if (item.ep !== undefined && item.ep !== null) locationParts.push(`EP${asNumber(item.ep, '')}`)
          if (item.paragraph !== undefined && item.paragraph !== null) locationParts.push(`${t('findings.paragraph')} ${asNumber(item.paragraph, '')}`)
          if (item.line !== undefined && item.line !== null) locationParts.push(`${t('findings.line')} ${asNumber(item.line, '')}`)
          const findingKindKey = {
            coverage: 'findings.kindCoverage',
            atom_pacing: 'findings.kindAtomPacing',
            dialogue_density: 'findings.kindDialogueDensity',
            episode: 'findings.kindEpisode',
            dialogue_text: 'findings.kindDialogueText',
          }[asString(item.kind)]
          if (findingKindKey) locationParts.push(t(findingKindKey))
          else if (item.kind && asString(item.kind) !== 'other') locationParts.push(t('findings.kindOther'))
          return h(
            'div',
            { className: 'lb-finding', key: `${severity}-${index}` },
            h('span', { className: `lb-finding-severity ${severityClass}` }, severityLabel),
            h(
              'div',
              { className: 'lb-finding-body' },
              h('div', null, `${checkLabelById(item.check, t)}${locationParts.length ? ` · ${locationParts.join(' · ')}` : ''}`),
              item.snippet ? h('div', { className: 'lb-finding-snippet' }, truncate(asString(item.snippet), 240)) : null,
              item.suggestion ? h('div', { className: 'lb-finding-meta' }, `${t('findings.suggestion')}: ${asString(item.suggestion)}`) : null,
            ),
          )
        }),
        findings.length > 100
          ? h('p', { className: 'lb-hint' }, t('findings.more', { n: findings.length - 100 }))
          : null,
      )
    }

    function EpisodeDetailRow(props) {
      const t = props.t
      const detail = props.detail
      if (props.loading) {
        return h('tr', null, h('td', { colSpan: 11 }, h('div', { className: 'lb-ep-detail' }, t('project.epDetailLoading'))))
      }
      if (props.error) {
        return h(
          'tr',
          null,
          h('td', { colSpan: 11 }, h('div', { className: 'lb-ep-detail' }, h(ErrorBlock, { message: props.error, t }))),
        )
      }
      const episode = isObject(detail) ? detail : {}
      const markdown = asString(episode.markdown, '')
      const findings = asArray(episode.findings)
      return h(
        'tr',
        null,
        h(
          'td',
          { colSpan: 11 },
          h(
            'div',
            { className: 'lb-ep-detail' },
            h(
              'div',
              { className: 'lb-ep-detail-head' },
              h('strong', null, `${t('project.epDetail')} · EP${episode.ep !== undefined ? episode.ep : props.ep}`),
              episode.status ? h(Badge, { kind: statusKind(episode.status) }, statusLabel(episode.status, t)) : null,
              h('span', { className: 'lb-hint', style: { margin: 0 } }, t('project.epChecksTitle')),
              CHECK_KEYS.map((key) =>
                h(CheckChip, {
                  key,
                  label: t(`check.${key}`),
                  state: episodeCheckState(episode, key),
                  t,
                }),
              ),
            ),
            h(FindingsList, { t, findings }),
            h('div', { className: 'lb-hint' }, t('project.epSource')),
            markdown ? h('pre', { className: 'lb-pre' }, markdown) : h('p', { className: 'lb-hint' }, t('common.empty')),
          ),
        ),
      )
    }

    function EpisodeTable(props) {
      const t = props.t
      const episodes = props.episodes
      const [expandedEp, setExpandedEp] = useState(null)
      const [detail, setDetail] = useState(null)
      const [detailLoading, setDetailLoading] = useState(false)
      const [detailError, setDetailError] = useState(null)
      const [filter, setFilter] = useState('all')
      const [page, setPage] = useState(1)
      const [jumpValue, setJumpValue] = useState('')
      const cacheRef = useRef({})

      useEffect(() => {
        setPage(1)
      }, [filter, episodes.length])

      const loadEpisode = useCallback(
        async (ep) => {
          setDetailError(null)
          if (cacheRef.current[ep]) {
            setDetail(cacheRef.current[ep])
            return
          }
          setDetail(null)
          setDetailLoading(true)
          try {
            const response = await api.episode(props.projectId, ep)
            if (response.ok && isObject(response.data) && response.data.ok) {
              const value = isObject(response.data.episode) ? response.data.episode : {}
              cacheRef.current[ep] = value
              setDetail(value)
            } else {
              setDetailError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
            }
          } catch (error) {
            setDetailError(describeError(errorInfoFromException(error, ''), t))
          } finally {
            setDetailLoading(false)
          }
        },
        [props.projectId, t],
      )

      const toggle = useCallback(
        (ep) => {
          if (expandedEp === ep) {
            setExpandedEp(null)
            return
          }
          setExpandedEp(ep)
          void loadEpisode(ep)
        },
        [expandedEp, loadEpisode],
      )

      const hasCheckRisk = (episode) =>
        CHECK_KEYS.some((key) => {
          const state = episodeCheckState(episode, key)
          return state === 'risk' || state === 'blocked'
        })
      const filtered = episodes.filter((episode) => {
        if (filter === 'blocked') return Boolean(episode.blocked)
        if (filter === 'risk') return asString(episode.status).toUpperCase() === 'RISK'
        if (filter === 'issues') return Boolean(episode.blocked) || asString(episode.status).toUpperCase() === 'RISK' || hasCheckRisk(episode)
        return true
      })
      const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
      const currentPage = Math.min(page, pageCount)
      const start = (currentPage - 1) * PAGE_SIZE
      const visible = filtered.slice(start, start + PAGE_SIZE)

      const jumpToEpisode = () => {
        const target = asNumber(jumpValue, 0)
        if (!target) return
        let index = filtered.findIndex((episode) => episode.ep === target)
        if (index < 0) {
          const allIndex = episodes.findIndex((episode) => episode.ep === target)
          if (allIndex < 0) return
          setFilter('all')
          index = allIndex
        }
        setPage(Math.floor(index / PAGE_SIZE) + 1)
        if (expandedEp !== target) {
          setExpandedEp(target)
          void loadEpisode(target)
        }
      }

      if (episodes.length === 0) {
        return h(
          Section,
          { title: t('project.episodes') },
          h(EmptyState, { title: t('project.noEpisodes'), desc: t('project.noEpisodesDesc'), t }),
        )
      }

      const bodyRows =
        visible.length > 0
          ? visible.map((episode) =>
              h(
                React.Fragment,
                { key: episode.ep },
                h(
                  'tr',
                  null,
                  h('td', { className: 'lb-table-ep' }, `EP${episode.ep}`),
                  h('td', { className: 'lb-table-title', title: episode.title }, episode.title || '—'),
                  h('td', null, h(Badge, { kind: statusKind(episode.status) }, statusLabel(episode.status, t))),
                  h('td', { className: 'lb-table-num' }, episode.wordCount === null ? '—' : numberOf(episode.wordCount)),
                  h('td', null, h('span', { className: checkChipClass(episodeCheckState(episode, 'punctuation')) }, checkStateLabel(episodeCheckState(episode, 'punctuation'), t))),
                  h('td', null, h('span', { className: checkChipClass(episodeCheckState(episode, 'pacing')) }, checkStateLabel(episodeCheckState(episode, 'pacing'), t))),
                  h('td', null, h('span', { className: checkChipClass(episodeCheckState(episode, 'protagonist')) }, checkStateLabel(episodeCheckState(episode, 'protagonist'), t))),
                  h('td', null, h('span', { className: checkChipClass(episodeCheckState(episode, 'culture')) }, checkStateLabel(episodeCheckState(episode, 'culture'), t))),
                  h('td', { className: 'lb-table-num' }, numberOf(episode.cjk)),
                  h('td', null, episode.blocked ? h(Badge, { kind: 'error' }, t('common.yes')) : h('span', { className: 'lb-hint' }, t('common.no'))),
                  h(
                    'td',
                    null,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'lb-link',
                        'aria-expanded': expandedEp === episode.ep,
                        onClick: () => toggle(episode.ep),
                      },
                      expandedEp === episode.ep ? t('table.collapse') : t('table.expand'),
                    ),
                  ),
                ),
                expandedEp === episode.ep
                  ? h(EpisodeDetailRow, {
                      key: `detail-${episode.ep}`,
                      t,
                      ep: episode.ep,
                      detail,
                      loading: detailLoading,
                      error: detailError,
                    })
                  : null,
              ),
            )
          : h('tr', null, h('td', { colSpan: 11 }, h('p', { className: 'lb-hint' }, t('table.noMatch'))))

      return h(
        Section,
        {
          title: t('project.episodes'),
          actions: h(Badge, { kind: 'idle' }, t('card.episodes', { n: numberOf(episodes.length) })),
        },
        h(
          'div',
          { className: 'lb-toolbar', style: { marginTop: '0' } },
          h('span', { className: 'lb-hint', style: { marginTop: '0' } }, t('table.filterLabel')),
          h(
            'select',
            {
              className: 'lb-input',
              value: filter,
              'aria-label': t('table.filterLabel'),
              onChange: (event) => setFilter(event.target.value),
            },
            [
              ['all', t('table.filterAll')],
              ['issues', t('table.filterCheckRisk')],
              ['risk', t('table.filterRisk')],
              ['blocked', t('table.filterBlocked')],
            ].map((entry) => h('option', { key: entry[0], value: entry[0] }, entry[1])),
          ),
          h('span', { className: 'lb-hint', style: { marginTop: '0' } }, t('table.jumpLabel')),
          h('input', {
            className: 'lb-input lb-input-number',
            type: 'number',
            min: 1,
            value: jumpValue,
            'aria-label': t('table.jumpLabel'),
            onChange: (event) => setJumpValue(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') jumpToEpisode()
            },
          }),
          h(Button, { onClick: jumpToEpisode }, t('table.jumpGo')),
        ),
        h(
          'div',
          { className: 'lb-table-wrap' },
          h(
            'table',
            { className: 'lb-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'col' }, t('table.ep')),
                h('th', { scope: 'col' }, t('table.title')),
                h('th', { scope: 'col' }, t('table.status')),
                h('th', { scope: 'col', className: 'lb-table-num' }, t('table.words')),
                h('th', { scope: 'col' }, t('table.punct')),
                h('th', { scope: 'col' }, t('table.pacing')),
                h('th', { scope: 'col' }, t('table.protagonist')),
                h('th', { scope: 'col' }, t('table.culture')),
                h('th', { scope: 'col', className: 'lb-table-num' }, t('table.cjk')),
                h('th', { scope: 'col' }, t('table.blocked')),
                h('th', { scope: 'col' }, t('table.detail')),
              ),
            ),
            h('tbody', null, bodyRows),
          ),
        ),
        h(
          'div',
          { className: 'lb-pagination' },
          h('span', null, t('table.pageInfo', { page: currentPage, pages: pageCount })),
          h(Button, { onClick: () => setPage(Math.max(1, currentPage - 1)), disabled: currentPage <= 1 }, t('table.prev')),
          h(Button, { onClick: () => setPage(Math.min(pageCount, currentPage + 1)), disabled: currentPage >= pageCount }, t('table.next')),
        ),
      )
    }

    function splitReportSections(markdown) {
      const lines = asString(markdown).split(/\r?\n/)
      const sections = []
      let current = { title: '', level: 0, lines: [] }
      lines.forEach((line) => {
        const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
        if (match) {
          if (current.title || current.lines.some((entry) => entry.trim())) sections.push(current)
          current = { title: match[2], level: match[1].length, lines: [] }
          return
        }
        current.lines.push(line)
      })
      if (current.title || current.lines.some((entry) => entry.trim())) sections.push(current)
      return sections
    }

    function ReportPanel(props) {
      const t = props.t
      const [loading, setLoading] = useState(false)
      const [text, setText] = useState('')
      const [error, setError] = useState(null)
      const loadedRef = useRef(false)
      const sectionRefs = useRef({})

      const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          const response = await api.report(props.projectId)
          if (response.ok) {
            setText(asString(response.markdown, ''))
            loadedRef.current = true
          } else if (response.status === 404) {
            setError(t('project.reportMissing'))
          } else {
            const info = response.data
              ? { status: response.status, code: asString(response.data.code), message: asString(response.data.error) }
              : { status: response.status, code: '', message: '' }
            setError(t('project.reportError', { reason: describeError(info, t) }))
          }
        } catch (err) {
          setError(t('project.reportError', { reason: describeError(errorInfoFromException(err, ''), t) }))
        } finally {
          setLoading(false)
        }
      }, [props.projectId, t])

      useEffect(() => {
        if (props.open && !loadedRef.current) void load()
      }, [props.open, load])

      if (!props.open) return null
      const sections = splitReportSections(text)
      const tocSections = sections
        .map((section, index) => ({ section, index }))
        .filter((entry) => Boolean(entry.section.title))
      return h(
        Section,
        {
          title: t('project.report'),
          actions: h(Button, { onClick: () => void load(), disabled: loading }, t('library.refresh')),
        },
        loading ? h(LoadingBlock, { t, label: t('project.reportLoading') }) : null,
        error ? h(ErrorBlock, { message: error, onRetry: () => void load(), t }) : null,
        !loading && !error
          ? text
            ? h(
                'div',
                null,
                tocSections.length > 1
                  ? h(
                      'nav',
                      { className: 'lb-toc', 'aria-label': t('project.report') },
                      tocSections.map((entry) =>
                        h(
                          Button,
                          {
                            key: `toc-${entry.index}`,
                            onClick: () => {
                              const node = sectionRefs.current[entry.index]
                              if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' })
                            },
                          },
                          entry.section.title,
                        ),
                      ),
                    )
                  : null,
                sections.map((section, index) =>
                  h(
                    'div',
                    {
                      key: `section-${index}`,
                      className: 'lb-report-section',
                      ref: (node) => {
                        sectionRefs.current[index] = node
                      },
                    },
                    section.title ? h('h3', { className: 'lb-report-heading' }, section.title) : null,
                    section.lines.some((line) => line.trim())
                      ? h('pre', { className: 'lb-pre' }, section.lines.join('\n').replace(/^\n+|\n+$/g, ''))
                      : null,
                  ),
                ),
              )
            : h(EmptyState, { title: t('project.reportEmpty'), t })
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // Merge suggestions card (M6, deterministic △ merge)
    // -----------------------------------------------------------------------
    function MergeCard(props) {
      const t = props.t
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [selected, setSelected] = useState([])
      const [previewing, setPreviewing] = useState(false)
      const [preview, setPreview] = useState(null)
      const [confirmingApply, setConfirmingApply] = useState(false)
      const [applying, setApplying] = useState(false)
      const [confirmingRestore, setConfirmingRestore] = useState(false)
      const [restoring, setRestoring] = useState(false)
      const [actionError, setActionError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [llmMode, setLlmMode] = useState(false)
      const [batchStatus, setBatchStatus] = useState(null)
      const modeInitializedRef = useRef(false)

      const load = useCallback(
        async (silent) => {
          if (!silent) setLoading(true)
          setError(null)
          try {
            const response = await api.merge(props.projectId)
            if (response.ok && isObject(response.data) && response.data.ok) {
              const next = normalizeMerge(response.data)
              setData(next)
              if (!modeInitializedRef.current) {
                modeInitializedRef.current = true
                setLlmMode(Boolean(next.llmMode.default))
              }
              setSelected(
                next.summary.recommendedEpisodes.filter((ep) =>
                  next.episodes.some((entry) => entry.ep === ep && !entry.merged && entry.targetCount > 0),
                ),
              )
              setPreview(null)
              setConfirmingApply(false)
              setConfirmingRestore(false)
              setBatchStatus(null)
              return next
            }
            if (!silent) {
              setError(t('merge.loadFailed', { reason: describeError(errorInfoFromResponse(response, t('common.unknown')), t) }))
            }
          } catch (err) {
            if (!silent) setError(t('merge.loadFailed', { reason: describeError(errorInfoFromException(err, ''), t) }))
          } finally {
            if (!silent) setLoading(false)
          }
          return null
        },
        [props.projectId, t],
      )

      useEffect(() => {
        setData(null)
        setSelected([])
        setPreview(null)
        setActionError(null)
        setNotice(null)
        modeInitializedRef.current = false
        setLlmMode(false)
        setBatchStatus(null)
        void load(false)
      }, [load])

      const toggleEp = (ep) => {
        setSelected((previous) =>
          previous.indexOf(ep) >= 0 ? previous.filter((value) => value !== ep) : previous.concat(ep),
        )
        setPreview(null)
        setConfirmingApply(false)
        setBatchStatus(null)
      }

      const toggleLlm = () => {
        setLlmMode((previous) => !previous)
        setPreview(null)
        setConfirmingApply(false)
        setBatchStatus(null)
        setActionError(null)
        setNotice(null)
      }

      const runPreview = useCallback(async () => {
        if (previewing || selected.length === 0) return
        const llmConfig = data ? data.llmMode : { available: true, maxEpisodes: 5 }
        const llmMax = asNumber(llmConfig.maxEpisodes, 5)
        if (llmMode && (llmConfig.available === false || selected.length > llmMax)) return
        setPreviewing(true)
        setActionError(null)
        setConfirmingApply(false)
        setBatchStatus(null)
        try {
          const payload = llmMode ? { episodes: selected, mode: 'llm' } : { episodes: selected }
          const response = await api.mergeAction(props.projectId, 'preview', payload)
          if (response.ok && isObject(response.data) && response.data.ok) {
            const body = response.data
            const normalized = normalizeMergePreview(body.preview)
            if (!normalized.previewId && body.previewId) normalized.previewId = asString(body.previewId)
            if (body.mode) normalized.mode = asString(body.mode)
            if (body.model && !normalized.model) normalized.model = asString(body.model)
            if (body.tokens) normalized.tokens = normalizeTokens(body.tokens)
            if (body.cost) normalized.cost = normalizeCost(body.cost)
            if (body.calls !== undefined) normalized.calls = asNumber(body.calls, normalized.calls)
            if (body.aiUsed !== undefined) normalized.aiUsed = Boolean(body.aiUsed)
            setPreview(normalized)
          } else {
            setActionError(t('merge.failed', { reason: describeError(errorInfoFromResponse(response, t('common.unknown')), t) }))
          }
        } catch (err) {
          setActionError(t('merge.failed', { reason: describeError(errorInfoFromException(err, ''), t) }))
        } finally {
          setPreviewing(false)
        }
      }, [data, llmMode, previewing, props.projectId, selected, t])

      const runBatchPreview = useCallback(async () => {
        if (!llmMode || previewing || applying || selected.length === 0) return
        const llmConfig = data ? data.llmMode : { available: true, maxEpisodes: 5 }
        if (llmConfig.available === false) return
        const eps = selected.slice().sort((left, right) => left - right)
        const chunkSize = Math.max(1, asNumber(llmConfig.maxEpisodes, 5))
        const chunks = []
        for (let index = 0; index < eps.length; index += chunkSize) chunks.push(eps.slice(index, index + chunkSize))
        const total = eps.length
        const batchTotal = chunks.length
        setPreviewing(true)
        setActionError(null)
        setConfirmingApply(false)
        setNotice(null)
        setPreview(null)
        setBatchStatus({ phase: 'previewing', batchIndex: 0, batchTotal, processed: 0, total, error: null })
        const aggregate = emptyMergeBatchPreview()
        let currentIndex = 0
        try {
          for (let index = 0; index < chunks.length; index += 1) {
            currentIndex = index
            setBatchStatus({ phase: 'previewing', batchIndex: index + 1, batchTotal, processed: index * chunkSize, total, error: null })
            const response = await api.mergeAction(props.projectId, 'preview', { episodes: chunks[index], mode: 'llm' })
            if (!response.ok || !isObject(response.data) || !response.data.ok) {
              const reason = describeError(errorInfoFromResponse(response, t('common.unknown')), t)
              setBatchStatus({ phase: 'error', batchIndex: index + 1, batchTotal, processed: index * chunkSize, total, error: reason })
              setActionError(
                t('merge.batchFailed', {
                  batch: numberOf(index + 1),
                  total: numberOf(batchTotal),
                  reason,
                }),
              )
              setPreview(null)
              return
            }
            const body = response.data
            const batch = normalizeMergePreview(body.preview)
            const previewId = batch.previewId || asString(body.previewId)
            if (!previewId) {
              const reason = t('merge.batchMissingId')
              setBatchStatus({ phase: 'error', batchIndex: index + 1, batchTotal, processed: index * chunkSize, total, error: reason })
              setActionError(
                t('merge.batchFailed', {
                  batch: numberOf(index + 1),
                  total: numberOf(batchTotal),
                  reason,
                }),
              )
              setPreview(null)
              return
            }
            aggregate.previewIds.push(previewId)
            if (!aggregate.model) aggregate.model = batch.model || asString(body.model, '')
            aggregate.tokens = mergeTokensSum(aggregate.tokens, batch.tokens)
            aggregate.cost = mergeCostSum(aggregate.cost, batch.cost)
            aggregate.calls += batch.calls > 0 ? batch.calls : asNumber(body.calls, 0) || chunks[index].length
            aggregate.episodes = aggregate.episodes.concat(batch.episodes)
            aggregate.atomsBefore += batch.atomsBefore
            aggregate.atomsAfter += batch.atomsAfter
            aggregate.removed += batch.removed
            aggregate.warnings = aggregate.warnings.concat(batch.warnings)
            setPreview(
              Object.assign({}, aggregate, {
                episodes: aggregate.episodes.slice(),
                previewIds: aggregate.previewIds.slice(),
                warnings: aggregate.warnings.slice(),
                tokens: Object.assign({}, aggregate.tokens),
                cost: Object.assign({}, aggregate.cost),
              }),
            )
            setBatchStatus({
              phase: 'previewing',
              batchIndex: index + 1,
              batchTotal,
              processed: Math.min(total, index * chunkSize + chunks[index].length),
              total,
              error: null,
            })
          }
          setPreview(
            Object.assign({}, aggregate, {
              episodes: aggregate.episodes.slice(),
              previewIds: aggregate.previewIds.slice(),
              warnings: aggregate.warnings.slice(),
              tokens: Object.assign({}, aggregate.tokens),
              cost: Object.assign({}, aggregate.cost),
            }),
          )
          setBatchStatus({ phase: 'ready', batchIndex: batchTotal, batchTotal, processed: total, total, error: null })
        } catch (err) {
          const reason = describeError(errorInfoFromException(err, ''), t)
          setBatchStatus({
            phase: 'error',
            batchIndex: currentIndex + 1,
            batchTotal,
            processed: currentIndex * chunkSize,
            total,
            error: reason,
          })
          setActionError(
            t('merge.batchFailed', {
              batch: numberOf(currentIndex + 1),
              total: numberOf(batchTotal),
              reason,
            }),
          )
          setPreview(null)
        } finally {
          setPreviewing(false)
        }
      }, [applying, data, llmMode, previewing, props.projectId, selected, t])

      const runApply = useCallback(async () => {
        if (applying || selected.length === 0) return
        if (!preview) {
          setActionError(llmMode ? t('merge.llmNeedPreview') : t('merge.noPreview'))
          return
        }
        const batchPreview = preview.mode === 'llm-batch'
        const llmPreview = preview.mode === 'llm' || preview.mode === 'llm-batch' || preview.aiUsed
        if (llmMode && !batchPreview && (!llmPreview || !preview.previewId)) {
          setActionError(t('merge.llmNeedPreview'))
          return
        }
        if (batchPreview && (!Array.isArray(preview.previewIds) || preview.previewIds.length === 0)) {
          setActionError(t('merge.batchNeedPreview'))
          return
        }
        setApplying(true)
        setActionError(null)
        try {
          let payload
          let actionName = 'apply'
          if (batchPreview) {
            actionName = 'apply-batch'
            payload = { mode: 'llm', previewIds: preview.previewIds.slice(), confirm: true }
          } else if (llmMode) {
            payload = { episodes: selected, mode: 'llm', previewId: preview.previewId, confirm: true }
          } else {
            payload = { episodes: selected, confirm: true }
          }
          const response = await api.mergeAction(props.projectId, actionName, payload)
          if (response.ok && isObject(response.data) && response.data.ok) {
            const appliedCount =
              isObject(response.data.result) && Array.isArray(response.data.result.applied)
                ? response.data.result.applied.length
                : selected.length
            const message = batchPreview
              ? t('merge.batchAppliedToast', { n: numberOf(appliedCount), batches: numberOf(preview.previewIds.length) })
              : t('merge.appliedToast', { n: numberOf(appliedCount) })
            setNotice(message)
            if (typeof props.notify === 'function') props.notify({ kind: 'success', message })
            setPreview(null)
            setConfirmingApply(false)
            setBatchStatus(null)
            await load(true)
            if (typeof props.onRefresh === 'function') props.onRefresh()
          } else {
            setActionError(t('merge.failed', { reason: describeError(errorInfoFromResponse(response, t('common.unknown')), t) }))
          }
        } catch (err) {
          setActionError(t('merge.failed', { reason: describeError(errorInfoFromException(err, ''), t) }))
        } finally {
          setApplying(false)
        }
      }, [applying, llmMode, load, preview, props, selected, t])

      const runRestore = useCallback(async () => {
        if (restoring) return
        setRestoring(true)
        setActionError(null)
        try {
          const response = await api.mergeAction(props.projectId, 'restore', { confirm: true })
          if (response.ok && isObject(response.data) && response.data.ok) {
            const message = t('merge.restoredToast')
            setNotice(message)
            if (typeof props.notify === 'function') props.notify({ kind: 'success', message })
            setConfirmingRestore(false)
            setPreview(null)
            setBatchStatus(null)
            await load(true)
            if (typeof props.onRefresh === 'function') props.onRefresh()
          } else {
            setActionError(t('merge.failed', { reason: describeError(errorInfoFromResponse(response, t('common.unknown')), t) }))
          }
        } catch (err) {
          setActionError(t('merge.failed', { reason: describeError(errorInfoFromException(err, ''), t) }))
        } finally {
          setRestoring(false)
        }
      }, [load, props, restoring, t])

      const episodes = data ? data.episodes : []
      const mergedEpisodes = episodes.filter((entry) => entry.merged)
      const hasMerge = Boolean(data && data.merge)
      const visible = Boolean(data && (episodes.length > 0 || hasMerge || data.preflightStale))
      const summary = data ? data.summary : null
      const warnings = data ? data.warnings : []
      const llmConfig = data ? data.llmMode : { available: true, default: false, maxEpisodes: 5, note: '' }
      const llmMaxEpisodes = asNumber(llmConfig.maxEpisodes, 5)
      const llmAvailable = llmConfig.available !== false
      const llmTooMany = Boolean(llmMode && selected.length > llmMaxEpisodes)
      const mergeModel = normalizePricing(props.pricing).model
      const previewIsLlm = Boolean(preview && (preview.mode === 'llm' || preview.mode === 'llm-batch' || preview.aiUsed))
      const previewIsBatch = Boolean(preview && preview.mode === 'llm-batch')

      if (!data && !error) return null
      if (!data) return h(ErrorBlock, { message: error, onRetry: () => void load(false), t })
      if (!visible) return null

      return h(
        'section',
        { className: 'lb-section' },
        h(
          'div',
          { className: 'lb-section-head' },
          h('h3', { className: 'lb-section-title' }, t('merge.title')),
          h(
            'div',
            { className: 'lb-section-actions' },
            h(Badge, { kind: llmMode ? 'risk' : 'brand' }, llmMode ? t('merge.llmOnBadge') : t('merge.badgeDeterministic')),
            h(Button, { onClick: () => void load(false), disabled: loading || applying || restoring }, t('merge.refresh')),
          ),
        ),
        h(
          'div',
          { className: 'lb-merge-notes' },
          h('p', { className: 'lb-hint', style: { marginTop: '0' } }, t('merge.noteDeterministic')),
          h('p', { className: 'lb-hint', style: { marginTop: '0' } }, t('merge.noteZeroToken')),
          h('p', { className: 'lb-hint', style: { marginTop: '0' } }, t('merge.noteScope')),
          h('p', { className: 'lb-hint', style: { marginTop: '0' } }, t('merge.noteRestore')),
        ),
        h(
          'label',
          { className: 'lb-merge-toggle' },
          h('input', {
            type: 'checkbox',
            checked: llmMode,
            disabled: !llmAvailable || previewing || applying || restoring,
            onChange: () => toggleLlm(),
          }),
          h('span', null, t('merge.llmToggle')),
          h(Badge, { kind: llmMode ? 'risk' : 'idle' }, llmMode ? t('merge.llmOnBadge') : t('merge.llmOffBadge')),
        ),
        llmMode
          ? h(
              'div',
              { className: 'lb-merge-llm' },
              h('p', { className: 'lb-merge-warn' }, t('merge.llmWarning')),
              h('p', { className: 'lb-hint', style: { marginTop: '0' } }, t('merge.llmNote')),
              h(
                'p',
                { className: 'lb-hint', style: { marginTop: '0' } },
                t('merge.llmModelLine', { model: mergeModel, max: numberOf(llmMaxEpisodes) }),
              ),
              h('p', { className: 'lb-hint', style: { marginTop: '0' } }, t('merge.llmCostLine')),
              h('p', { className: 'lb-hint', style: { marginTop: '0' } }, t('merge.llmNoAuto')),
              h('p', { className: 'lb-hint', style: { marginTop: '0' } }, t('merge.llmScope')),
              llmTooMany
                ? h(
                    'div',
                    { className: 'lb-merge-llm-limit' },
                    h(
                      'p',
                      { className: 'lb-merge-warn' },
                      t('merge.llmTooMany', { n: numberOf(llmMaxEpisodes), selected: numberOf(selected.length) }),
                    ),
                    h(
                      Button,
                      { onClick: () => setLlmMode(false), disabled: previewing || applying || restoring },
                      t('merge.deterministicAll'),
                    ),
                  )
                : null,
              !llmAvailable ? h('p', { className: 'lb-merge-warn' }, t('merge.llmUnavailable')) : null,
            )
          : null,
        data.preflightStale
          ? h(
              'div',
              { className: 'lb-merge-stale' },
              h('p', { className: 'lb-merge-warn' }, t('merge.staleWarning')),
              hasMerge
                ? h(
                    Button,
                    { variant: 'primary', onClick: () => setConfirmingRestore(true), disabled: restoring || applying },
                    t('merge.restore'),
                  )
                : null,
            )
          : null,
        warnings.length > 0
          ? h(
              'div',
              { className: 'lb-merge-notes' },
              warnings.map((warning, index) =>
                h('p', { key: `merge-warning-${index}`, className: 'lb-merge-warn' }, warning),
              ),
            )
          : null,
        summary
          ? h(
              'div',
              { className: 'lb-token-grid' },
              h(StatBox, { label: t('merge.sumTotal'), value: numberOf(summary.totalTargetEpisodes) }),
              h(StatBox, { label: t('merge.sumRecommended'), value: numberOf(summary.recommendedEpisodes.length) }),
              h(StatBox, { label: t('merge.sumMerged'), value: numberOf(mergedEpisodes.length) }),
              h(StatBox, { label: t('merge.sumRuns'), value: numberOf(summary.targetRuns) }),
              h(StatBox, { label: t('merge.sumAtoms'), value: numberOf(summary.atomsBefore) }),
            )
          : null,
        h('h4', { className: 'lb-report-heading' }, t('merge.selectTitle')),
        episodes.length === 0
          ? h('p', { className: 'lb-hint' }, t('merge.noSuggestions'))
          : h(
              'div',
              { className: 'lb-merge-list' },
              episodes.map((entry) => {
                const isMerged = entry.merged
                const isSelectable = !isMerged && entry.targetCount > 0
                const isChecked = selected.indexOf(entry.ep) >= 0
                return h(
                  'label',
                  { key: `merge-ep-${entry.ep}`, className: isMerged ? 'lb-merge-item lb-merge-item-merged' : 'lb-merge-item' },
                  h('input', {
                    type: 'checkbox',
                    checked: isChecked,
                    disabled: !isSelectable || previewing || applying || restoring,
                    onChange: () => toggleEp(entry.ep),
                  }),
                  h('span', { className: 'lb-table-ep' }, `EP${entry.ep}`),
                  h('span', { className: 'lb-table-title', title: entry.title }, entry.title || '—'),
                  entry.recommended ? h(Badge, { kind: 'risk' }, t('merge.recommendedBadge')) : null,
                  isMerged ? h(Badge, { kind: 'success' }, t('merge.mergedBadge')) : null,
                  h(
                    'span',
                    { className: 'lb-hint', style: { marginTop: '0' } },
                    `${t('merge.atoms')} ${numberOf(entry.atoms)} · ${t('merge.runs')} ${numberOf(entry.targetCount)}`,
                  ),
                )
              }),
            ),
        selected.length === 0
          ? h('p', { className: 'lb-hint' }, t('merge.noSelection'))
          : h('p', { className: 'lb-hint' }, t('merge.selectedCount', { n: numberOf(selected.length) })),
        h(
          'div',
          { className: 'lb-actions', style: { marginLeft: '0' } },
          h(
            Button,
            {
              variant: 'primary',
              disabled: previewing || selected.length === 0 || applying || !llmAvailable || llmTooMany,
              onClick: () => void runPreview(),
              title: llmTooMany
                ? t('merge.llmTooMany', { n: numberOf(llmMaxEpisodes), selected: numberOf(selected.length) })
                : !llmAvailable
                  ? t('merge.llmUnavailable')
                  : undefined,
            },
            previewing
              ? t('merge.previewing')
              : llmTooMany
                ? t('merge.previewBlocked', { n: numberOf(llmMaxEpisodes) })
                : t('merge.preview'),
          ),
          llmMode
            ? h(
                Button,
                {
                  disabled: previewing || selected.length === 0 || applying || !llmAvailable,
                  onClick: () => void runBatchPreview(),
                },
                t(
                  batchStatus && batchStatus.phase === 'previewing'
                    ? 'merge.batchPreviewing'
                    : 'merge.batchPreview',
                  { n: numberOf(selected.length) },
                ),
              )
            : null,
          hasMerge
            ? h(Button, { onClick: () => setConfirmingRestore(true), disabled: restoring || applying }, t('merge.restore'))
            : null,
        ),
        llmMode && batchStatus && batchStatus.phase === 'previewing'
          ? h(
              'p',
              { className: 'lb-hint' },
              t('merge.batchProgress', {
                batch: numberOf(batchStatus.batchIndex),
                total: numberOf(batchStatus.batchTotal),
                processed: numberOf(batchStatus.processed),
                count: numberOf(batchStatus.total),
              }),
            )
          : null,
        confirmingRestore
          ? h(
              'div',
              { className: 'lb-confirm' },
              h('span', { className: 'lb-confirm-text' }, t('merge.restoreConfirm')),
              h(
                Button,
                { variant: 'danger', disabled: restoring, onClick: () => void runRestore() },
                restoring ? t('merge.restoring') : t('merge.confirmRestore'),
              ),
              h(Button, { onClick: () => setConfirmingRestore(false), disabled: restoring }, t('common.cancel')),
            )
          : null,
        actionError ? h(ErrorBlock, { message: actionError, t }) : null,
        notice ? h('p', { className: 'lb-hint' }, notice) : null,
        preview
          ? h(
              'div',
              { className: 'lb-merge-preview' },
              h(
                'div',
                { className: 'lb-section-head' },
                h('h4', { className: 'lb-report-heading', style: { marginTop: '0' } }, t('merge.previewTitle')),
                previewIsBatch
                  ? h(Badge, { kind: 'risk' }, t('merge.batchPreviewBadge'))
                  : previewIsLlm
                    ? h(Badge, { kind: 'risk' }, t('merge.llmPreviewBadge'))
                    : h(Badge, { kind: 'brand' }, t('merge.badgeDeterministic')),
                previewIsLlm ? null : h(Badge, { kind: 'idle' }, t('merge.badgeZeroToken')),
              ),
              h(
                'p',
                { className: 'lb-hint' },
                t('merge.previewSummary', {
                  before: numberOf(preview.atomsBefore),
                  after: numberOf(preview.atomsAfter),
                  removed: numberOf(preview.removed),
                }),
              ),
              previewIsLlm
                ? h(
                    'div',
                    { className: 'lb-merge-llm' },
                    h(
                      'p',
                      { className: 'lb-merge-warn' },
                      previewIsBatch ? t('merge.batchPreviewNoWrite') : t('merge.llmPreviewNoWrite'),
                    ),
                    previewIsBatch && preview.previewIds.length > 0
                      ? h(
                          'p',
                          { className: 'lb-hint', style: { marginTop: '0' } },
                          t('merge.batchChunks', { n: numberOf(preview.previewIds.length) }),
                        )
                      : null,
                    h(
                      'div',
                      { className: 'lb-live-meta' },
                      h('span', null, `${t('merge.llmModel')}: ${preview.model || mergeModel}`),
                      h('span', null, `${t('merge.llmCalls')}: ${numberOf(preview.calls)}`),
                      h('span', null, `${t('merge.llmTokens')}: ${numberOf(preview.tokens.total)}`),
                      h('span', null, `${t('merge.llmCost')}: ${formatYuan(preview.cost.total)}`),
                      preview.previewId ? h('span', null, t('merge.llmPreviewId', { id: preview.previewId })) : null,
                    ),
                    h('p', { className: 'lb-merge-warn' }, t('merge.llmWarningsTitle')),
                    preview.warnings.length > 0
                      ? preview.warnings.map((warning, index) =>
                          h('p', { key: `merge-llm-warning-${index}`, className: 'lb-merge-warn' }, warning),
                        )
                      : null,
                    preview.episodes
                      .filter((entry) => entry.coverage !== null)
                      .map((entry) =>
                        h(
                          'p',
                          { key: `merge-coverage-${entry.ep}`, className: entry.coverage < 0.98 ? 'lb-merge-warn' : 'lb-hint' },
                          t('merge.llmCoverage', { ep: numberOf(entry.ep), pct: Math.round(entry.coverage * 100) }),
                        ),
                      ),
                  )
                : null,
              preview.episodes.map((entry) =>
                h(
                  'div',
                  { key: `merge-preview-${entry.ep}`, className: 'lb-merge-preview-ep' },
                  h(
                    'div',
                    { className: 'lb-merge-preview-head' },
                    h('strong', null, `EP${entry.ep}`),
                    h('span', null, entry.title || ''),
                  ),
                  h(
                    'p',
                    { className: 'lb-hint', style: { marginTop: '0' } },
                    t('merge.previewEpLine', {
                      before: numberOf(entry.atomsBefore),
                      after: numberOf(entry.atomsAfter),
                      removed: numberOf(entry.removed),
                      targets: numberOf(entry.targetCount),
                    }),
                  ),
                  entry.coverage !== null
                    ? h(
                        'p',
                        { className: entry.coverage < 0.98 ? 'lb-merge-warn' : 'lb-hint', style: { marginTop: '0' } },
                        t('merge.llmEpCoverage', { ep: numberOf(entry.ep), pct: Math.round(entry.coverage * 100) }),
                      )
                    : null,
                  entry.warnings.map((warning, index) =>
                    h('p', { key: `merge-ep-warning-${entry.ep}-${index}`, className: 'lb-merge-warn' }, warning),
                  ),
                  entry.targets.map((target, index) =>
                    h(
                      'div',
                      { key: `merge-target-${entry.ep}-${index}`, className: 'lb-merge-target' },
                      h('div', null, `#${index + 1} ${t('merge.targetMeta', { start: numberOf(target.start), n: numberOf(target.length) })}`),
                      h('div', null, `△ ${t('merge.beforeLabel')}：${truncateMergeLine(target.before.join(' / '), 240) || '—'}`),
                      h('div', null, `△ ${t('merge.afterLabel')}：${truncateMergeLine(target.after, 240) || '—'}`),
                    ),
                  ),
                ),
              ),
              confirmingApply
                ? h(
                    'div',
                    { className: 'lb-confirm' },
                    h(
                      'span',
                      { className: 'lb-confirm-text' },
                      previewIsBatch
                        ? t('merge.applyConfirmBatch', { n: numberOf(preview.previewIds.length) })
                        : previewIsLlm
                          ? t('merge.applyConfirmLlm')
                          : t('merge.applyConfirm'),
                    ),
                    h(
                      Button,
                      {
                        variant: 'danger',
                        disabled:
                          applying ||
                          (previewIsLlm && !previewIsBatch && !preview.previewId) ||
                          (previewIsBatch && preview.previewIds.length === 0),
                        onClick: () => void runApply(),
                      },
                      applying ? t('merge.applying') : t('merge.confirmApply'),
                    ),
                    h(Button, { onClick: () => setConfirmingApply(false), disabled: applying }, t('common.cancel')),
                  )
                : h(
                    'div',
                    { className: 'lb-actions', style: { marginLeft: '0' } },
                    h(Button, { variant: 'primary', disabled: applying, onClick: () => setConfirmingApply(true) }, t('merge.apply')),
                    h(Button, { onClick: () => setPreview(null) }, t('common.cancel')),
                  ),
            )
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // Storyboard tab (2.0 refine)
    // -----------------------------------------------------------------------
    function StoryboardTab(props) {
      const t = props.t
      const [refine2, setRefine2] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [actionError, setActionError] = useState(null)
      const [sampleInput, setSampleInput] = useState('')
      const [concurrencyInput, setConcurrencyInput] = useState('')
      const [lastParams, setLastParams] = useState(null)
      const [budget, setBudget] = useState(null)

      const load = useCallback(
        async (silent) => {
          if (!silent) setLoading(true)
          setError(null)
          try {
            const response = await api.refine(props.projectId)
            if (response.ok && isObject(response.data) && response.data.ok) {
              const next = normalizeRefine2(response.data)
              setRefine2(next)
              if (next.refine && next.refine.budget) setBudget(next.refine.budget)
              return next
            }
            if (!silent) {
              setError(t('story.loadFailed', { reason: describeError(errorInfoFromResponse(response, t('common.unknown')), t) }))
            }
          } catch (err) {
            if (!silent) setError(t('story.loadFailed', { reason: describeError(errorInfoFromException(err, ''), t) }))
          } finally {
            if (!silent) setLoading(false)
          }
          return null
        },
        [props.projectId, t],
      )

      useEffect(() => {
        setRefine2(null)
        setActionError(null)
        setBudget(null)
        setLoading(true)
        void load(false)
      }, [load])

      const refine = refine2 ? refine2.refine : null
      const storyboard = refine2 ? refine2.storyboard : normalizeStoryboard({})
      const job = refine2 && refine2.job ? refine2.job : refine ? refine.job : null
      const jobRunning = Boolean(job && (jobIsRunning(job) || asString(job.state) === 'queued'))
      const pollId = job && job.id ? job.id : ''
      const pollState = job ? job.state : ''
      useEffect(() => {
        if (!pollId || !jobRunning) return undefined
        const timer = setInterval(() => {
          void load(true)
        }, 3000)
        return () => clearInterval(timer)
      }, [pollId, jobRunning, pollState, load])

      const startStoryboard = useCallback(
        async (episodes, overrides) => {
          if (busy) return
          setBusy(true)
          setActionError(null)
          try {
            const payload = {}
            const list = episodes && episodes.length > 0 ? episodes : parseEpisodeList(sampleInput)
            if (list && list.length > 0) payload.episodes = list
            const concurrency =
              overrides && overrides.concurrency !== undefined ? asNumber(overrides.concurrency, 0) : asNumber(concurrencyInput, 0)
            if (concurrency > 0) payload.concurrency = concurrency
            setLastParams({ episodes: list && list.length > 0 ? list.slice() : null, concurrency: concurrency > 0 ? concurrency : null })
            const response = await api.action(props.projectId, 'run-refine', payload)
            if (response.ok && isObject(response.data) && response.data.ok) {
              const nextJob = normalizeJob(response.data.job)
              if (nextJob && nextJob.id) {
                if (typeof props.notify === 'function') props.notify({ kind: 'success', message: t('story.started') })
                if (typeof props.onJobStarted === 'function') {
                  props.onJobStarted({ job: nextJob, projectId: props.projectId, origin: 'refine' })
                } else {
                  void load(true)
                }
                return
              }
              void load()
            } else {
              setActionError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
            }
          } catch (err) {
            setActionError(describeError(errorInfoFromException(err, ''), t))
          } finally {
            setBusy(false)
          }
        },
        [busy, concurrencyInput, load, props, sampleInput, t],
      )

      const cancelStoryboard = useCallback(async () => {
        if (!job || !job.id || busy) return
        setBusy(true)
        setActionError(null)
        try {
          const response = await api.cancelJob(job.id)
          if (response.ok && isObject(response.data) && response.data.ok) {
            if (typeof props.notify === 'function') props.notify({ kind: 'success', message: t('toast.actionDone') })
            void load(true)
          } else {
            setActionError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
          }
        } catch (err) {
          setActionError(describeError(errorInfoFromException(err, ''), t))
        } finally {
          setBusy(false)
        }
      }, [busy, job, load, props, t])

      const retryLast = () => {
        const params = lastParams || { episodes: null, concurrency: null }
        void startStoryboard(params.episodes, { concurrency: params.concurrency || 0 })
      }

      const phases = job && job.phases && job.phases.length > 0 ? job.phases : REFINE2_PHASES
      const activePhaseIndex = job ? (job.phaseIndex >= 0 ? job.phaseIndex : phases.indexOf(job.phase)) : -1
      const derivedPlanner = (entry) => {
        if (entry.planner) return entry.planner
        const hasPlan = Boolean(entry.artifacts && entry.artifacts.plan)
        if (entry.state === 'planning') {
          return { state: 'planning', attempts: entry.attempts, note: entry.error, verdict: '', fails: [], warns: [], raw: {} }
        }
        if (hasPlan && entry.state !== 'failed') {
          return { state: 'passed', attempts: entry.attempts || 1, note: '', verdict: '', fails: [], warns: [], raw: {} }
        }
        if (entry.state === 'failed' && !hasPlan) {
          return { state: 'failed', attempts: entry.attempts, note: entry.error, verdict: '', fails: [], warns: [], raw: {} }
        }
        return null
      }
      const derivedWriter = (entry) => {
        if (entry.writer) return entry.writer
        const hasPlan = Boolean(entry.artifacts && entry.artifacts.plan)
        if (entry.state === 'writing') {
          return { state: 'writing', attempts: entry.attempts, note: '', verdict: '', fails: [], warns: [], raw: {} }
        }
        if (entry.state === 'passed') {
          return { state: 'passed', attempts: entry.attempts, note: '', verdict: '', fails: [], warns: [], raw: {} }
        }
        if (entry.state === 'failed' && hasPlan) {
          return { state: 'failed', attempts: entry.attempts, note: entry.error, verdict: '', fails: [], warns: [], raw: {} }
        }
        return null
      }
      const derivedCheck = (entry) => {
        if (entry.check) return entry.check
        if (entry.state === 'passed') {
          return { state: 'passed', attempts: entry.attempts, note: '', verdict: 'PASS', fails: [], warns: [], raw: {} }
        }
        if (entry.state === 'failed') {
          return { state: 'failed', attempts: entry.attempts, note: entry.error, verdict: '', fails: [], warns: [], raw: {} }
        }
        return null
      }
      const derivedAudit = (entry) => {
        if (entry.audit) return entry.audit
        if (entry.state === 'passed') {
          return { state: 'passed', attempts: 1, note: '', verdict: 'PASS', fails: [], warns: [], raw: {} }
        }
        return null
      }
      const episodes = storyboard.episodes.map((entry) =>
        Object.assign({}, entry, {
          artifacts: entry.artifacts || { storyboardMd: '', storyboardDocx: '', plan: '', dialogueAudit: '', check: '' },
          tokens: entry.tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: entry.cost || normalizeCost({}),
          planner: derivedPlanner(entry),
          writer: derivedWriter(entry),
          check: derivedCheck(entry),
          audit: derivedAudit(entry),
        }),
      )
      const progressValue = refine && isObject(refine.progress) ? refine.progress : null
      const summary = {
        total: (progressValue && progressValue.total) || storyboard.summary.total || episodes.length,
        planned: Math.max(storyboard.summary.planned, episodes.filter((entry) => entry.planner).length),
        written: Math.max(storyboard.summary.written, episodes.filter((entry) => entry.writer).length),
        passed:
          progressValue && typeof progressValue.passed === 'number' ? progressValue.passed : storyboard.summary.passed,
        failed:
          progressValue && typeof progressValue.failed === 'number' ? progressValue.failed : storyboard.summary.failed,
      }
      const tokens = refine ? refine.tokens : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      const displayCost = resolveCost({ cost: refine ? refine.cost : null, tokens, pricing: props.pricing })
      const budgetState = budget || (job && job.budget) || (refine && refine.budget) || null
      const confirmKind = needsConfirmKind(job)
      const retryableEps = episodes
        .filter((entry) => entry.state === 'failed' || (entry.writer && entry.writer.state === 'failed') || (entry.audit && entry.audit.state === 'failed'))
        .map((entry) => entry.ep)
      const needsRetry = Boolean(job && (job.state === 'failed' || job.state === 'needs_confirm'))
      const overviewLinks = storyboard.artifacts
        ? [
            storyboard.artifacts.storyboardMd
              ? { label: `${t('story.artifact.storyboard')} · Markdown`, path: storyboard.artifacts.storyboardMd }
              : null,
            storyboard.artifacts.storyboardDocx
              ? { label: `${t('story.artifact.storyboard')} · Word`, path: storyboard.artifacts.storyboardDocx }
              : null,
            storyboard.artifacts.dialogueAudit ? { label: t('story.artifact.dialogueAudit'), path: storyboard.artifacts.dialogueAudit } : null,
          ].filter(Boolean)
        : []
      const artifactLink = (label, path) =>
        path ? h('a', { key: `${label}-${path}`, className: 'lb-link-btn', href: api.fileUrl(props.projectId, path), download: true }, label) : null
      const stageText = (stage) => {
        if (!stage) return '—'
        const parts = [storyStageLabel(stage, t)]
        if (stage.attempts > 0) parts.push(`${t('story.attempts')} ${numberOf(stage.attempts)}`)
        if (stage.fails.length > 0) parts.push(truncateMergeLine(stage.fails.slice(0, 2).join(' | '), 80))
        else if (stage.warns.length > 0) parts.push(truncateMergeLine(stage.warns.slice(0, 2).join(' | '), 80))
        else if (stage.verdict) parts.push(stage.verdict)
        else if (stage.note) parts.push(truncateMergeLine(stage.note, 80))
        return parts.join(' · ')
      }

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'lb-section-head' },
          h('h3', { className: 'lb-section-title' }, t('story.title')),
          h(
            'div',
            { className: 'lb-section-actions' },
            h(ModeBadge, { t, mode: props.mode }),
            h(Button, { onClick: () => void load(false), disabled: loading || busy }, t('story.refresh')),
            jobRunning ? h(Button, { variant: 'danger', onClick: () => void cancelStoryboard(), disabled: busy }, t('job.cancel')) : null,
          ),
        ),
        h('p', { className: 'lb-hint', style: { marginTop: '0' } }, t('story.subtitle')),
        job
          ? h(JobBar, {
              t,
              job,
              cancelling: busy,
              onCancel: () => void cancelStoryboard(),
              onViewProgress: () => props.onViewJob && props.onViewJob(job),
            })
          : null,
        h(
          'div',
          { className: 'lb-inline-form' },
          h('span', { className: 'lb-inline-label' }, t('story.startSample')),
          h('input', {
            className: 'lb-input lb-input-search',
            type: 'text',
            value: sampleInput,
            disabled: jobRunning || busy,
            placeholder: '1,2,3 / 3-5',
            'aria-label': t('story.startSample'),
            onChange: (event) => setSampleInput(event.target.value),
          }),
          h('span', { className: 'lb-inline-label' }, t('story.concurrency')),
          h('input', {
            className: 'lb-input lb-input-num',
            type: 'number',
            min: 1,
            max: 20,
            value: concurrencyInput,
            disabled: jobRunning || busy,
            'aria-label': t('story.concurrency'),
            onChange: (event) => setConcurrencyInput(event.target.value),
          }),
          h(Button, { variant: 'primary', disabled: jobRunning || busy, onClick: () => void startStoryboard(null) }, t('story.start')),
          retryableEps.length > 0
            ? h(Button, { disabled: jobRunning || busy, onClick: () => void startStoryboard(retryableEps) }, t('story.retryFailed'))
            : null,
        ),
        confirmKind ? h(FailureBanner, { t, job, busy, onRetry: retryLast }) : null,
        needsRetry && !confirmKind
          ? h(
              'div',
              { className: 'lb-form-error' },
              h('span', null, t('story.failedHint', { reason: truncateMergeLine(job.error || t('common.unknown'), 160) })),
              h(Button, { variant: 'primary', disabled: busy, onClick: retryLast }, t('story.retryLast')),
            )
          : null,
        actionError ? h(ErrorBlock, { message: actionError, t }) : null,
        error ? h(ErrorBlock, { message: error, onRetry: () => void load(false), t }) : null,
        loading ? h(LoadingBlock, { t, label: t('common.loading') }) : null,
        !loading
          ? h(
              'div',
              null,
              budgetState ? h(BudgetBar, { t, budget: budgetState }) : null,
              h(CostCard, {
                t,
                pricing: props.pricing,
                cost: refine ? refine.cost : null,
                tokens: refine ? refine.tokens : null,
              }),
              h(
                'section',
                { className: 'lb-section', style: { marginTop: '12px' } },
                h('h3', { className: 'lb-section-title' }, t('story.summaryTitle')),
                h(
                  'div',
                  { className: 'lb-token-grid' },
                  h(StatBox, { label: t('story.sumTotal'), value: numberOf(summary.total) }),
                  h(StatBox, { label: t('story.sumPlanned'), value: numberOf(summary.planned) }),
                  h(StatBox, { label: t('story.sumWritten'), value: numberOf(summary.written) }),
                  h(StatBox, { label: t('story.sumPassed'), value: numberOf(summary.passed) }),
                  h(StatBox, { label: t('story.sumFailed'), value: numberOf(summary.failed), tone: summary.failed > 0 ? 'error' : undefined }),
                  h(StatBox, { label: t('live.elapsed'), value: job ? formatDuration((job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now()) - (job.startedAt ? new Date(job.startedAt).getTime() : Date.now())) : '—' }),
                ),
              ),
              h(
                'section',
                { className: 'lb-section', style: { marginTop: '12px' } },
                h(
                  'div',
                  { className: 'lb-section-head' },
                  h('h3', { className: 'lb-section-title' }, t('story.episodesTitle')),
                  activePhaseIndex >= 0 && job ? h(Badge, { kind: 'brand' }, phaseLabel(phases[activePhaseIndex], t)) : null,
                ),
                episodes.length === 0
                  ? h(EmptyState, { title: t('story.noEpisodes'), desc: t('story.noEpisodesDesc'), t })
                  : h(
                      'div',
                      { className: 'lb-table-wrap' },
                      h(
                        'table',
                        { className: 'lb-table' },
                        h(
                          'thead',
                          null,
                          h(
                            'tr',
                            null,
                            h('th', null, t('refine.colEp')),
                            h('th', null, t('story.colTitle')),
                            h('th', null, t('story.colPlanner')),
                            h('th', null, t('story.colWriter')),
                            h('th', null, t('story.colRetry')),
                            h('th', null, t('story.colCheck')),
                            h('th', null, t('story.colAudit')),
                            h('th', null, t('story.colTokens')),
                            h('th', null, t('story.colCost')),
                            h('th', null, t('story.colArtifacts')),
                            h('th', null, t('story.colActions')),
                          ),
                        ),
                        h(
                          'tbody',
                          null,
                          episodes.map((entry) =>
                            h(
                              'tr',
                              { key: entry.ep },
                              h('td', { className: 'lb-table-ep' }, `EP${entry.ep}`),
                              h('td', { className: 'lb-table-title', title: entry.title }, entry.title || '—'),
                              h('td', null, h(Badge, { kind: storyStageKind(entry.planner) }, stageText(entry.planner))),
                              h('td', null, h(Badge, { kind: storyStageKind(entry.writer) }, stageText(entry.writer))),
                              h('td', { className: 'lb-table-num' }, `${numberOf(entry.retry)}/2`),
                              h('td', { className: 'lb-table-title', title: stageText(entry.check) }, stageText(entry.check)),
                              h('td', { className: 'lb-table-title', title: stageText(entry.audit) }, stageText(entry.audit)),
                              h('td', { className: 'lb-table-num' }, entry.tokens.total > 0 ? numberOf(entry.tokens.total) : '—'),
                              h('td', { className: 'lb-table-num' }, entry.cost && entry.cost.total > 0 ? formatYuan(entry.cost.total) : '—'),
                              h(
                                'td',
                                null,
                                h(
                                  'div',
                                  { className: 'lb-table-actions' },
                                  artifactLink('MD', entry.artifacts.storyboardMd),
                                  artifactLink('Word', entry.artifacts.storyboardDocx),
                                  artifactLink(t('story.artifact.dialogueAudit'), entry.artifacts.dialogueAudit),
                                  artifactLink(t('story.artifact.plan'), entry.artifacts.plan),
                                  artifactLink(t('story.artifact.check'), entry.artifacts.check),
                                ),
                              ),
                              h(
                                'td',
                                null,
                                h(
                                  'div',
                                  { className: 'lb-table-actions' },
                                  h(Button, { disabled: jobRunning || busy, onClick: () => void startStoryboard([entry.ep]) }, t('story.retryEpisode')),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
              ),
              overviewLinks.length > 0
                ? h(
                    'section',
                    { className: 'lb-section', style: { marginTop: '12px' } },
                    h('h3', { className: 'lb-section-title' }, t('story.artifactsTitle')),
                    h(
                      'div',
                      { className: 'lb-artifact-list' },
                      overviewLinks.map((link) =>
                        h(
                          'a',
                          { key: `story-artifact-${link.path}`, className: 'lb-link-btn', href: api.fileUrl(props.projectId, link.path), download: true },
                          `${link.label} · ${t('refine.download')}`,
                        ),
                      ),
                    ),
                  )
                : null,
              job
                ? h(LiveOutputTab, {
                    t,
                    projectId: props.projectId,
                    initialJobId: job ? job.id : props.initialJobId,
                    pricing: props.pricing,
                    onPricingRefresh: props.onPricingRefresh,
                    onBudgetChange: setBudget,
                    embedded: true,
                  })
                : null,
            )
          : null,
      )
    }

    function ProjectView(props) {
      const t = props.t
      const [snapshot, setSnapshot] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [actionError, setActionError] = useState(null)
      const [pendingAction, setPendingAction] = useState(null)
      const [reportOpen, setReportOpen] = useState(false)
      const reportRef = useRef(null)
      const [cancelling, setCancelling] = useState(false)
      const [tab, setTab] = useState(
        props.initialTab === 'bgm'
          ? 'bgm'
          : props.initialTab === 'refine' || props.initialTab === 'live'
            ? 'refine'
            : 'preflight',
      )

      const load = useCallback(
        async (silent) => {
          if (!silent) {
            setLoading(true)
            setError(null)
          }
          try {
            const response = await api.project(props.id)
            if (response.ok && isObject(response.data) && response.data.ok) {
              setSnapshot(normalizeSnapshot(response.data.snapshot))
            } else if (!silent) {
              setError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
            }
          } catch (err) {
            if (!silent) setError(describeError(errorInfoFromException(err, ''), t))
          } finally {
            if (!silent) setLoading(false)
          }
        },
        [props.id, t],
      )

      useEffect(() => {
        setSnapshot(null)
        setReportOpen(false)
        setPendingAction(null)
        setActionError(null)
        setTab(
          props.initialTab === 'bgm'
            ? 'bgm'
            : props.initialTab === 'refine' || props.initialTab === 'live'
              ? 'refine'
              : 'preflight',
        )
        void load()
      }, [load])

      useEffect(() => {
        if ((tab === 'refine' || tab === 'bgm') && typeof props.onPricingRefresh === 'function') props.onPricingRefresh()
        // Only refresh pricing when switching to a cost-bearing tab.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tab])

      const activeJob = snapshot && snapshot.job ? snapshot.job : null
      const activeJobRunning = Boolean(activeJob && jobIsRunning(activeJob))
      const activeJobId = activeJob ? activeJob.id : ''
      const activeJobState = activeJob ? activeJob.state : ''
      useEffect(() => {
        if (!activeJobId || !activeJobRunning) return undefined
        const timer = setInterval(() => {
          void load(true)
        }, 3000)
        return () => clearInterval(timer)
      }, [activeJobId, activeJobRunning, activeJobState, load])

      const runAction = useCallback(
        async (action) => {
          setBusy(true)
          setActionError(null)
          try {
            const response = await api.action(props.id, action)
            if (response.ok && isObject(response.data) && response.data.ok) {
              setPendingAction(null)
              if (action === 'rerun-preflight') {
                const job = normalizeJob(response.data.job)
                if (job && job.id) {
                  props.onJobStarted({ job, projectId: props.id, origin: 'rerun' })
                  return
                }
                if (isObject(response.data.snapshot)) setSnapshot(normalizeSnapshot(response.data.snapshot))
                else void load()
                props.notify({ kind: 'success', message: t('toast.actionDone') })
              } else if (action === 'archive') {
                props.notify({ kind: 'success', message: t('toast.actionDone') })
                props.onBack(true)
              } else if (action === 'delete') {
                props.notify({ kind: 'success', message: t('toast.actionDone') })
                props.onBack(true)
              }
            } else {
              const code = isObject(response.data) ? asString(response.data.code, '') : ''
              setActionError(
                code === 'MERGED_SOURCE'
                  ? t('merge.rerunBlocked')
                  : describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t),
              )
              setPendingAction(null)
            }
          } catch (err) {
            setActionError(describeError(errorInfoFromException(err, ''), t))
            setPendingAction(null)
          } finally {
            setBusy(false)
          }
        },
        [props, t, load],
      )

      const cancelJob = useCallback(async () => {
        const job = snapshot && snapshot.job ? snapshot.job : null
        if (!job || !job.id || cancelling) return
        setCancelling(true)
        setActionError(null)
        try {
          const response = await api.cancelJob(job.id)
          if (response.ok && isObject(response.data) && response.data.ok) {
            const next = normalizeJob(response.data.job)
            if (next) setSnapshot((previous) => (previous ? Object.assign({}, previous, { job: next }) : previous))
            else void load(true)
            props.notify({ kind: 'success', message: t('toast.actionDone') })
          } else {
            setActionError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
          }
        } catch (err) {
          setActionError(describeError(errorInfoFromException(err, ''), t))
        } finally {
          setCancelling(false)
        }
      }, [snapshot, cancelling, props, t, load])

      if (loading) {
        return h('div', null, h(LoadingBlock, { t, label: t('common.loading') }))
      }
      const data = snapshot || normalizeSnapshot(null)
      const project = data.project
      const matrix = deriveCheckMatrix(data)
      const blockedEps = data.episodes.filter((ep) => ep.blocked).map((ep) => ep.ep)
      const confirmText =
        pendingAction === 'rerun' ? t('project.rerunConfirm') : pendingAction === 'archive' ? t('project.archiveConfirm') : t('project.deleteConfirm')
      const projectMode = normalizeModeId((project && project.mode) || props.mode)
      const mode2 = isMode2(projectMode)

      return h(
        'div',
        null,
        h(
          'header',
          { className: 'lb-header' },
          h('div', { className: 'lb-header-icon' }, h(Icon, { size: 24 })),
          h(
            'div',
            { className: 'lb-header-text' },
            h('h1', { className: 'lb-title' }, project.title || project.id || props.id),
            h(
              'p',
              { className: 'lb-subtitle' },
              `${t('project.id')}: ${project.id || props.id}${project.sourceName ? ` · ${t('project.sourceName')}: ${project.sourceName}` : ''}`,
            ),
            h(StageBar, {
              t,
              mode: projectMode,
              preflightStatus: data.phase.preflight || project.status,
              refineState:
                activeJob && (activeJob.kind === 'refine' || activeJob.kind === 'refine2' || activeJob.kind === 'storyboard') && jobIsRunning(activeJob)
                  ? 'running'
                  : data.refine
                    ? data.refine.state
                    : activeJob && (activeJob.kind === 'refine' || activeJob.kind === 'refine2' || activeJob.kind === 'storyboard')
                      ? activeJob.state
                      : 'idle',
              bgmState:
                activeJob && activeJob.kind === 'bgm' && jobIsRunning(activeJob)
                  ? 'running'
                  : data.bgm
                    ? data.bgm.state
                    : activeJob && activeJob.kind === 'bgm'
                      ? activeJob.state
                      : 'idle',
            }),
          ),
          h(
            'div',
            { className: 'lb-actions' },
            h(ModeBadge, { t, mode: projectMode }),
            h(Button, { onClick: () => void load(), disabled: busy }, t('project.refresh')),
            h(Button, { onClick: () => props.onOptions(props.id) }, t('project.settingsAction')),
            tab === 'preflight' ? h(
              Button,
              {
                onClick: () => {
                  const next = !reportOpen
                  setReportOpen(next)
                  if (next) {
                    setTimeout(() => {
                      const node = reportRef.current
                      if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }, 80)
                  }
                },
                'aria-expanded': reportOpen,
              },
              reportOpen ? t('common.close') : t('project.report'),
            ) : null,
            h(Button, { onClick: () => props.onBack(false) }, t('nav.back')),
          ),
        ),
        h(
          'div',
          { className: 'lb-tabs', role: 'tablist' },
          [
            ['preflight', t('tab.preflight')],
            ['refine', mode2 ? t('mode.tabRefine2') : t('tab.refine')],
            ['bgm', t('tab.bgm')],
          ].map((entry) =>
            h(
              'button',
              {
                key: entry[0],
                type: 'button',
                role: 'tab',
                'aria-selected': tab === entry[0],
                className: tab === entry[0] ? 'lb-tab lb-tab-active' : 'lb-tab',
                onClick: () => setTab(entry[0]),
              },
              entry[1],
            ),
          ),
        ),
        error ? h(ErrorBlock, { message: error, onRetry: () => void load(), t }) : null,
        actionError ? h(ErrorBlock, { message: actionError, t }) : null,
        tab === 'bgm'
          ? h(BgmTab, {
              t,
              projectId: props.id,
              mode: projectMode,
              snapshot: data,
              pricing: props.pricing,
              onPricingRefresh: props.onPricingRefresh,
              notify: props.notify,
            })
          : tab === 'refine'
            ? mode2
              ? h(StoryboardTab, {
                  t,
                  projectId: props.id,
                  mode: projectMode,
                  initialJobId: props.initialJobId,
                  snapshot: data,
                  pricing: props.pricing,
                  onPricingRefresh: props.onPricingRefresh,
                  notify: props.notify,
                  onJobStarted: props.onJobStarted,
                  onViewJob: props.onViewJob,
                })
              : h(RefineTab, {
                  t,
                  projectId: props.id,
                  initialJobId: props.initialJobId,
                  snapshot: data,
                  pricing: props.pricing,
                  onPricingRefresh: props.onPricingRefresh,
                  notify: props.notify,
                  onJobStarted: props.onJobStarted,
                  onViewJob: props.onViewJob,
                })
            : h(
              React.Fragment,
              null,
              activeJob && activeJob.kind !== 'refine'
                ? h(JobBar, {
                    t,
                    job: activeJob,
                    cancelling,
                    onCancel: () => void cancelJob(),
                    onViewProgress: () => props.onViewJob(activeJob),
                  })
                : null,
              h(
                Section,
                {
                  title: t('project.overview'),
                  actions: h(Badge, { kind: statusKind(project.status) }, statusLabel(project.status, t)),
                },
                h(
                  'div',
                  { className: 'lb-stats' },
                  h(StatBox, { label: t('stats.episodes'), value: numberOf(data.stats.episodes) }),
                  h(StatBox, { label: t('stats.cjk'), value: numberOf(data.stats.cjk) }),
                  h(StatBox, { label: t('stats.scenes'), value: numberOf(data.stats.scenes) }),
                  h(StatBox, { label: t('stats.dialogues'), value: numberOf(data.stats.dialogueLines) }),
                  h(StatBox, { label: t('stats.atoms'), value: numberOf(data.stats.atomLines) }),
                  h(StatBox, {
                    label: t('stats.blocked'),
                    value: numberOf(data.stats.blocked),
                    tone: data.stats.blocked > 0 ? 'error' : undefined,
                  }),
                  h(StatBox, { label: t('stats.duration'), value: formatDuration(data.stats.durationMs) }),
                ),
                h(
                  'div',
                  { className: 'lb-kv' },
                  h('span', { className: 'lb-kv-key' }, t('project.engine')),
                  h('span', { className: 'lb-kv-value' }, project.engineVersion || '—'),
                  h('span', { className: 'lb-kv-key' }, t('project.created')),
                  h('span', { className: 'lb-kv-value' }, project.createdAt ? formatTime(project.createdAt) : '—'),
                  h('span', { className: 'lb-kv-key' }, t('project.updated')),
                  h('span', { className: 'lb-kv-value' }, project.updatedAt ? formatTime(project.updatedAt) : '—'),
                  h('span', { className: 'lb-kv-key' }, t('project.duration')),
                  h('span', { className: 'lb-kv-value' }, formatDuration(project.durationMs)),
                  blockedEps.length > 0 ? h('span', { className: 'lb-kv-key' }, t('stats.blocked')) : null,
                  blockedEps.length > 0
                    ? h('span', { className: 'lb-kv-value' }, t('project.blockedEps', { eps: blockedEps.join(', ') }))
                    : null,
                ),
              ),
              h(CheckMatrix, { t, matrix }),
              mode2
                ? h(
                    React.Fragment,
                    null,
                    h(LedgerCard, { t, ledger: data.ledger }),
                    h(LlmCorrectionCard, { t, correction: data.llmCorrection, settings: data.options && data.options.raw ? data.options.raw.llmCorrection : null, projectId: props.id, notify: props.notify, onRefresh: () => void load() }),
                  )
                : h(MergeCard, {
                    t,
                    projectId: props.id,
                    pricing: props.pricing,
                    notify: props.notify,
                    onRefresh: () => void load(),
                  }),
              h(EpisodeTable, { t, episodes: data.episodes, projectId: props.id }),
              h('div', { ref: reportRef, id: 'lb-report-panel' }, h(ReportPanel, { t, projectId: props.id, open: reportOpen })),
              h(
                Section,
                { title: t('project.actions'), actions: busy ? h(Badge, { kind: 'risk' }, t('project.actionsBusy')) : null },
                h(
                  'div',
                  { className: 'lb-actions', style: { marginLeft: '0' } },
                  h(Button, { variant: 'primary', onClick: () => setPendingAction('rerun'), disabled: busy }, t('project.rerun')),
                  h(Button, { onClick: () => setPendingAction('archive'), disabled: busy }, t('project.archive')),
                  h(Button, { variant: 'danger', onClick: () => setPendingAction('delete'), disabled: busy }, t('project.delete')),
                ),
                pendingAction
                  ? h(
                      'div',
                      { className: 'lb-confirm' },
                      h('span', { className: 'lb-confirm-text' }, confirmText),
                      h(
                        Button,
                        {
                          variant: pendingAction === 'delete' ? 'danger' : 'primary',
                          disabled: busy,
                          onClick: () => void runAction(pendingAction === 'rerun' ? 'rerun-preflight' : pendingAction),
                        },
                        t('common.confirm'),
                      ),
                      h(Button, { onClick: () => setPendingAction(null), disabled: busy }, t('common.cancel')),
                    )
                  : null,
              ),
            ),
      )
    }

    // -----------------------------------------------------------------------
    // Refine tab (M3)
    // -----------------------------------------------------------------------
    function parseEpisodeList(text) {
      const raw = asString(text).trim()
      if (!raw) return []
      const result = []
      raw
        .split(/[\s,，;；]+/)
        .filter(Boolean)
        .forEach((token) => {
          const range = /^(\d+)\s*[-~–]\s*(\d+)$/.exec(token)
          if (range) {
            const start = asNumber(range[1], 0)
            const end = asNumber(range[2], 0)
            if (start > 0 && end >= start && end - start <= 300) {
              for (let value = start; value <= end; value += 1) result.push(value)
            }
            return
          }
          const single = asNumber(token, 0)
          if (single > 0) result.push(single)
        })
      return Array.from(new Set(result)).sort((left, right) => left - right)
    }

    function artifactDownloadLinks(artifacts, t) {
      const links = []
      const source = isObject(artifacts) ? artifacts : {}
      const push = (label, value) => {
        if (!value) return
        if (typeof value === 'string') links.push({ label, path: value })
        else if (isObject(value)) {
          if (value.md) links.push({ label: `${label} · Markdown`, path: value.md })
          if (value.docx) links.push({ label: `${label} · Word`, path: value.docx })
          if (value.path) links.push({ label, path: value.path })
        }
      }
      push(t('refine.artifactDirector'), source.director)
      push(t('refine.artifactQc'), source.qcReport)
      push(t('refine.artifactSummary'), source.summary || source.productionSummary)
      const seen = {}
      links.forEach((entry) => {
        seen[entry.path] = true
      })
      asArray(source.outputs).forEach((entry) => {
        if (typeof entry !== 'string' || !entry || seen[entry]) return
        if (/_导演执行版|_质检报告/.test(entry)) return
        links.push({ label: entry.split('/').pop(), path: entry })
        seen[entry] = true
      })
      return links
    }

    function RefineTab(props) {
      const t = props.t
      const [refine, setRefine] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [actionError, setActionError] = useState(null)
      const [sampleInput, setSampleInput] = useState('')
      const [concurrencyInput, setConcurrencyInput] = useState('')
      const [draftState, setDraftState] = useState(null)
      const [budget, setBudget] = useState(null)
      const [lastParams, setLastParams] = useState(null)

      const load = useCallback(
        async (silent) => {
          if (!silent) setLoading(true)
          setError(null)
          try {
            const response = await api.refine(props.projectId)
            if (response.ok && isObject(response.data) && response.data.ok) {
              const next = normalizeRefine(response.data.refine)
              setRefine(next)
              setBudget(next.budget || null)
            } else if (!silent) {
              setError(t('refine.loadFailed', { reason: describeError(errorInfoFromResponse(response, t('common.unknown')), t) }))
            }
          } catch (err) {
            if (!silent) setError(t('refine.loadFailed', { reason: describeError(errorInfoFromException(err, ''), t) }))
          } finally {
            if (!silent) setLoading(false)
          }
        },
        [props.projectId, t],
      )

      useEffect(() => {
        setRefine(null)
        setDraftState(null)
        setActionError(null)
        setBudget(null)
        setLastParams(null)
        void load()
      }, [load])

      const job = refine && refine.job ? refine.job : null
      const jobRunning = Boolean(job && jobIsRunning(job))
      const pollJobId = job ? job.id : ''
      const pollJobState = job ? job.state : ''
      useEffect(() => {
        if (!pollJobId || !jobRunning) return undefined
        const timer = setInterval(() => {
          void load(true)
        }, 3000)
        return () => clearInterval(timer)
      }, [pollJobId, jobRunning, pollJobState, load])

      const startRefine = useCallback(
        async (episodes, overrides) => {
          if (busy) return
          setBusy(true)
          setActionError(null)
          try {
            const payload = {}
            const list = episodes && episodes.length > 0 ? episodes : null
            if (list) payload.episodes = list
            const concurrency =
              overrides && overrides.concurrency !== undefined ? asNumber(overrides.concurrency, 0) : asNumber(concurrencyInput, 0)
            if (concurrency > 0) payload.concurrency = concurrency
            setLastParams({ episodes: list ? list.slice() : null, concurrency: concurrency > 0 ? concurrency : null })
            const response = await api.action(props.projectId, 'run-refine', payload)
            if (response.ok && isObject(response.data) && response.data.ok) {
              const nextJob = normalizeJob(response.data.job)
              if (nextJob && nextJob.id) {
                if (typeof props.notify === 'function') props.notify({ kind: 'success', message: t('refine.started') })
                props.onJobStarted({ job: nextJob, projectId: props.projectId, origin: 'refine' })
                return
              }
              void load()
            } else {
              setActionError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
            }
          } catch (err) {
            setActionError(describeError(errorInfoFromException(err, ''), t))
          } finally {
            setBusy(false)
          }
        },
        [busy, concurrencyInput, props, t, load],
      )

      const cancelRefine = useCallback(async () => {
        const active = refine && refine.job ? refine.job : null
        if (!active || !active.id) return
        setBusy(true)
        setActionError(null)
        try {
          const response = await api.cancelJob(active.id)
          if (response.ok && isObject(response.data) && response.data.ok) {
            const next = normalizeJob(response.data.job)
            if (next) setRefine((previous) => (previous ? Object.assign({}, previous, { job: next }) : previous))
            else void load(true)
            if (typeof props.notify === 'function') props.notify({ kind: 'success', message: t('toast.actionDone') })
          } else {
            setActionError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
          }
        } catch (err) {
          setActionError(describeError(errorInfoFromException(err, ''), t))
        } finally {
          setBusy(false)
        }
      }, [refine, props, t, load])

      const openDraft = useCallback(
        async (ep) => {
          if (draftState && draftState.ep === ep) {
            setDraftState(null)
            return
          }
          setDraftState({ ep, loading: true, error: null, markdown: '', check: null, notes: '' })
          try {
            const response = await api.draft(props.projectId, ep)
            if (response.ok && isObject(response.data) && response.data.ok) {
              const payload = isObject(response.data.episode) ? response.data.episode : response.data
              setDraftState({
                ep,
                loading: false,
                error: null,
                markdown: asString(payload.draftMarkdown, ''),
                check: payload.check || null,
                notes: asString(payload.notes, ''),
              })
            } else {
              setDraftState({
                ep,
                loading: false,
                error: describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t),
                markdown: '',
                check: null,
                notes: '',
              })
            }
          } catch (err) {
            setDraftState({ ep, loading: false, error: describeError(errorInfoFromException(err, ''), t), markdown: '', check: null, notes: '' })
          }
        },
        [draftState, props.projectId, t],
      )

      const preflightStatusRaw = asString(props.snapshot && props.snapshot.phase ? props.snapshot.phase.preflight : '').toLowerCase()
      const preflightDone = Boolean(
        props.snapshot && props.snapshot.phase && (statusKind(preflightStatusRaw) === 'success' || preflightStatusRaw.indexOf('refine_') === 0),
      )
      const refineBusy = Boolean(refine && asString(refine.state).toLowerCase() === 'running')
      const canStart = preflightDone && !jobRunning && !refineBusy && !busy
      const episodes = refine ? refine.episodes : []
      const progress = refine ? refine.progress : { total: 0, pending: 0, running: 0, passed: 0, issues: 0, blocked: 0, failed: 0 }
      const tokens = refine ? refine.tokens : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      const cost = resolveCost({ cost: refine ? refine.cost : null, tokens, pricing: props.pricing })
      const links = refine ? artifactDownloadLinks(refine.artifacts, t) : []
      const budgetState = budget || (job && job.budget) || (refine && refine.budget) || null
      const confirmKind = needsConfirmKind(job)
      const retryLast = () => {
        const params = lastParams || { episodes: null, concurrency: null }
        void startRefine(params.episodes, { concurrency: params.concurrency || 0 })
      }
      const retryableEps = episodes
        .filter((entry) => entry.state === 'failed' || entry.state === 'passed-with-issues')
        .map((entry) => entry.ep)
      const sampleEpisodes = parseEpisodeList(sampleInput)
      const elapsedMs = (() => {
        const startedAt = job && job.startedAt ? job.startedAt : refine && refine.raw && refine.raw.startedAt ? refine.raw.startedAt : null
        const finishedAt = job && job.finishedAt ? job.finishedAt : refine && refine.raw && refine.raw.finishedAt ? refine.raw.finishedAt : null
        if (!startedAt) return 0
        const start = new Date(startedAt).getTime()
        const end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
        return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0
      })()

      const episodeRows = episodes.map((entry) => {
        const epArtifacts = entry.artifacts && typeof entry.artifacts === 'object' ? entry.artifacts : {}
        const artifactLinks = []
        if (epArtifacts.draft) artifactLinks.push({ label: t('refine.epArtifact.draft'), path: epArtifacts.draft })
        if (epArtifacts.report) artifactLinks.push({ label: t('refine.epArtifact.report'), path: epArtifacts.report })
        if (epArtifacts.notes) artifactLinks.push({ label: t('refine.epArtifact.notes'), path: epArtifacts.notes })
        return h(
          'tr',
          { key: entry.ep },
          h('td', { className: 'lb-table-ep' }, `EP${entry.ep}`),
          h('td', { className: 'lb-table-title', title: entry.title }, entry.title || '—'),
          h('td', null, h(Badge, { kind: refineEpisodeStateKind(entry.state) }, refineEpisodeStateLabel(entry.state, t))),
          h('td', { className: 'lb-table-num' }, numberOf(entry.attempts)),
          h('td', { className: 'lb-table-title', title: formatCheckReason(entry.check) }, formatCheckReason(entry.check) || '—'),
          h('td', { className: 'lb-table-num' }, entry.tokens.total > 0 ? numberOf(entry.tokens.total) : '—'),
          h(
            'td',
            null,
            artifactLinks.length > 0
              ? h(
                  'div',
                  { className: 'lb-table-actions' },
                  artifactLinks.map((link) =>
                    h(
                      'a',
                      {
                        key: link.path,
                        className: 'lb-link-btn',
                        href: api.fileUrl(props.projectId, link.path),
                        download: true,
                      },
                      link.label,
                    ),
                  ),
                )
              : '—',
          ),
          h(
            'td',
            null,
            h(
              'div',
              { className: 'lb-table-actions' },
              epArtifacts.draft ? h(Button, { onClick: () => void openDraft(entry.ep) }, t('refine.viewDraft')) : null,
              h(
                Button,
                {
                  onClick: () => void startRefine([entry.ep]),
                  disabled: busy || jobRunning || !preflightDone || entry.state === 'blocked',
                },
                t('refine.retryEpisode'),
              ),
            ),
          ),
        )
      })

      return h(
        Section,
        {
          title: t('refine.title'),
          actions: [h(Button, { key: 'refresh', onClick: () => void load(), disabled: loading || busy }, t('refine.refresh'))],
        },
        h('p', { className: 'lb-hint', style: { marginTop: '0' } }, t('refine.subtitle')),
        job
          ? h(JobBar, {
              t,
              job,
              cancelling: busy,
              onCancel: () => void cancelRefine(),
              onViewProgress: () => props.onViewJob(job),
            })
          : null,
        confirmKind ? h(FailureBanner, { t, job, busy, onRetry: retryLast }) : null,
        budgetState ? h(BudgetBar, { t, budget: budgetState }) : null,
        job || refine || props.initialJobId
          ? h(LiveOutputTab, {
              t,
              projectId: props.projectId,
              initialJobId: job ? job.id : props.initialJobId,
              pricing: props.pricing,
              onPricingRefresh: props.onPricingRefresh,
              onBudgetChange: setBudget,
              embedded: true,
            })
          : null,
        !preflightDone ? h('p', { className: 'lb-form-error' }, t('refine.needsPreflight')) : null,
        actionError ? h(ErrorBlock, { message: actionError, t }) : null,
        error ? h(ErrorBlock, { message: error, onRetry: () => void load(), t }) : null,
        loading ? h(LoadingBlock, { t, label: t('common.loading') }) : null,
        !loading
          ? h(
              'div',
              { className: 'lb-inline-form' },
              h('span', { className: 'lb-inline-label' }, t('refine.startSample')),
              h('input', {
                className: 'lb-input lb-input-search',
                type: 'text',
                value: sampleInput,
                disabled: jobRunning || busy,
                placeholder: '1,2,3 / 3-5',
                'aria-label': t('refine.startSample'),
                onChange: (event) => setSampleInput(event.target.value),
              }),
              h('span', { className: 'lb-inline-label' }, t('refine.concurrency')),
              h('input', {
                className: 'lb-input lb-input-number',
                type: 'number',
                min: 1,
                max: 20,
                value: concurrencyInput,
                disabled: jobRunning || busy,
                'aria-label': t('refine.concurrency'),
                onChange: (event) => setConcurrencyInput(event.target.value),
              }),
              h(
                Button,
                { variant: 'primary', onClick: () => void startRefine(sampleEpisodes), disabled: !canStart },
                t('refine.start'),
              ),
              retryableEps.length > 0
                ? h(Button, { onClick: () => void startRefine(retryableEps), disabled: !canStart }, t('refine.retryFailed'))
                : null,
            )
          : null,
        h('p', { className: 'lb-hint' }, t('refine.startHint')),
        !loading && refine
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'lb-token-grid' },
                h(StatBox, { label: t('refine.counts.pending'), value: numberOf(progress.pending) }),
                h(StatBox, { label: t('refine.counts.running'), value: numberOf(progress.running) }),
                h(StatBox, { label: t('refine.counts.passed'), value: numberOf(progress.passed) }),
                h(StatBox, { label: t('refine.counts.issues'), value: numberOf(progress.issues), tone: progress.issues > 0 ? 'risk' : undefined }),
                h(StatBox, { label: t('refine.counts.blocked'), value: numberOf(progress.blocked), tone: progress.blocked > 0 ? 'error' : undefined }),
                h(StatBox, { label: t('refine.counts.failed'), value: numberOf(progress.failed), tone: progress.failed > 0 ? 'error' : undefined }),
                h(StatBox, { label: t('refine.counts.total'), value: numberOf(progress.total) }),
              ),
              h(
                'div',
                { className: 'lb-token-grid' },
                h(StatBox, { label: t('refine.tokenInput'), value: numberOf(tokens.input) }),
                h(StatBox, { label: t('refine.tokenOutput'), value: numberOf(tokens.output) }),
                h(StatBox, { label: t('refine.tokenCacheRead'), value: numberOf(tokens.cacheRead) }),
                h(StatBox, { label: t('refine.tokenTotal'), value: numberOf(tokens.total) }),
                h(StatBox, { label: t('refine.costTotal'), value: formatYuan(cost.total) }),
                h(StatBox, { label: t('refine.elapsed'), value: formatDuration(elapsedMs) }),
              ),
              h('h3', { className: 'lb-report-heading' }, t('refine.artifacts')),
              links.length > 0
                ? h(
                    'div',
                    { className: 'lb-artifact-list' },
                    links.map((link) =>
                      h(
                        'a',
                        { key: link.path, className: 'lb-link-btn', href: api.fileUrl(props.projectId, link.path), download: true },
                        `${link.label} · ${t('refine.download')}`,
                      ),
                    ),
                  )
                : h('p', { className: 'lb-hint' }, t('refine.artifactMissing')),
            )
          : null,
        !loading
          ? h(
              'div',
              null,
              h('h3', { className: 'lb-report-heading' }, t('refine.title')),
              episodes.length === 0
                ? h(EmptyState, { title: t('refine.noEpisodes'), desc: t('refine.noEpisodesDesc'), t })
                : h(
                    'div',
                    { className: 'lb-table-wrap' },
                    h(
                      'table',
                      { className: 'lb-table', style: { minWidth: '980px' } },
                      h(
                        'thead',
                        null,
                        h(
                          'tr',
                          null,
                          h('th', { scope: 'col' }, t('refine.colEp')),
                          h('th', { scope: 'col' }, t('refine.colTitle')),
                          h('th', { scope: 'col' }, t('refine.colState')),
                          h('th', { scope: 'col', className: 'lb-table-num' }, t('refine.colAttempts')),
                          h('th', { scope: 'col' }, t('refine.colReason')),
                          h('th', { scope: 'col', className: 'lb-table-num' }, t('refine.colTokens')),
                          h('th', { scope: 'col' }, t('refine.colArtifacts')),
                          h('th', { scope: 'col' }, t('refine.colActions')),
                        ),
                      ),
                      h('tbody', null, episodeRows),
                    ),
                  ),
              draftState
                ? h(
                    'div',
                    { className: 'lb-draft' },
                    h(
                      'div',
                      { className: 'lb-draft-head' },
                      h('strong', null, `${t('refine.draftTitle')} · EP${draftState.ep}`),
                      h(Button, { onClick: () => setDraftState(null) }, t('refine.closeDraft')),
                    ),
                    draftState.loading ? h(LoadingBlock, { t, label: t('refine.draftLoading') }) : null,
                    draftState.error ? h(ErrorBlock, { message: draftState.error, t }) : null,
                    !draftState.loading && !draftState.error
                      ? h(
                          React.Fragment,
                          null,
                          h('p', { className: 'lb-hint' }, t('refine.draftSource')),
                          draftState.markdown
                            ? h('pre', { className: 'lb-pre' }, draftState.markdown)
                            : h('p', { className: 'lb-hint' }, t('refine.draftEmpty')),
                          draftState.check
                            ? h(
                                'div',
                                null,
                                h('h3', { className: 'lb-subsection-title' }, t('refine.draftCheck')),
                                h(PrettyJson, { value: draftState.check }),
                              )
                            : null,
                          draftState.notes
                            ? h(
                                'div',
                                null,
                                h('h3', { className: 'lb-subsection-title' }, t('refine.draftNotes')),
                                h('pre', { className: 'lb-pre' }, draftState.notes),
                              )
                            : null,
                        )
                      : null,
                  )
                : null,
            )
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // Live output tab (M3.1: director stream + live cost)
    // -----------------------------------------------------------------------
    function blankLiveStream(ep) {
      return {
        ep,
        text: '',
        attempt: 0,
        promptChars: 0,
        chars: 0,
        finish: '',
        started: false,
        completed: false,
        updatedAt: 0,
      }
    }

    function LiveOutputTab(props) {
      const t = props.t
      const [refine, setRefine] = useState(null)
      const [job, setJob] = useState(null)
      const [streams, setStreams] = useState({})
      const [followedEp, setFollowedEp] = useState(null)
      const [followLatest, setFollowLatest] = useState(true)
      const [conn, setConn] = useState('connecting')
      const [terminal, setTerminal] = useState('')
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [now, setNow] = useState(Date.now())
      const [scrollPaused, setScrollPaused] = useState(false)
      const [cost, setCost] = useState(null)
      const [draft, setDraft] = useState(null)
      const streamsRef = useRef({})
      const pendingRef = useRef({})
      const jobRef = useRef(null)
      const followLatestRef = useRef(true)
      const consoleRef = useRef(null)
      const autoScrollRef = useRef(true)
      const lastSeqRef = useRef(0)
      const finishedRef = useRef(false)
      const sourceRef = useRef(null)
      const costFromStreamRef = useRef(false)

      const applyJob = useCallback((nextJob) => {
        if (!nextJob) return
        jobRef.current = nextJob
        setJob(nextJob)
      }, [])

      const flushStreams = useCallback(() => {
        const pending = pendingRef.current
        const keys = Object.keys(pending)
        if (keys.length === 0) return
        const next = Object.assign({}, streamsRef.current)
        keys.forEach((key) => {
          const ep = Number(key)
          if (!Number.isFinite(ep)) return
          const base = next[ep] || blankLiveStream(ep)
          next[ep] = Object.assign({}, base, { text: pending[key] })
        })
        pendingRef.current = {}
        streamsRef.current = next
        setStreams(next)
      }, [])

      const commitStreams = useCallback(() => {
        setStreams(Object.assign({}, streamsRef.current))
      }, [])

      const refreshRefine = useCallback(
        async (silent) => {
          try {
            const response = await api.refine(props.projectId)
            if (response.ok && isObject(response.data) && response.data.ok) {
              const next = normalizeRefine(response.data.refine)
              setRefine(next)
              if (next.job) {
                applyJob(next.job)
                if (jobIsTerminal(next.job)) setTerminal(next.job.state)
              }
              if (!costFromStreamRef.current && next.cost && next.cost.total > 0) {
                setCost(next.cost)
              }
              return next
            }
            if (!silent) {
              setError(t('live.loadFailed', { reason: describeError(errorInfoFromResponse(response, ''), t) }))
            }
          } catch (err) {
            if (!silent) setError(t('live.loadFailed', { reason: describeError(errorInfoFromException(err, ''), t) }))
          }
          return null
        },
        [props.projectId, applyJob, t],
      )

      useEffect(() => {
        setRefine(null)
        setJob(null)
        jobRef.current = null
        setStreams({})
        streamsRef.current = {}
        pendingRef.current = {}
        lastSeqRef.current = 0
        setFollowedEp(null)
        setFollowLatest(true)
        followLatestRef.current = true
        autoScrollRef.current = true
        setScrollPaused(false)
        setTerminal('')
        setError(null)
        setCost(null)
        setDraft(null)
        costFromStreamRef.current = false
        finishedRef.current = false
        setLoading(true)
        if (props.initialJobId) {
          applyJob(
            normalizeJob({
              id: props.initialJobId,
              kind: 'refine',
              state: 'queued',
              phases: REFINE_PHASES,
              episodes: { total: 0, done: 0 },
              projectId: props.projectId,
            }),
          )
        }
        if (typeof props.onPricingRefresh === 'function') props.onPricingRefresh()
        void refreshRefine(false).finally(() => setLoading(false))
        // Only re-initialize when the project/job changes; pricing refresh is a stable callback.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [props.projectId, props.initialJobId, applyJob, refreshRefine])

      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [])

      useEffect(() => {
        const timer = setInterval(() => flushStreams(), LIVE_FLUSH_MS)
        return () => clearInterval(timer)
      }, [flushStreams])

      const jobId = job && job.id ? job.id : ''

      useEffect(() => {
        if (!jobId) return undefined
        let disposed = false
        let source = null
        let pollTimer = null
        let watchdog = null
        let lastEventAt = Date.now()
        let sseErrors = 0

        const stopPolling = () => {
          if (pollTimer) {
            clearInterval(pollTimer)
            pollTimer = null
          }
        }
        const startPolling = () => {
          if (disposed || pollTimer) return
          setConn('polling')
          if (source) {
            try {
              source.close()
            } catch {
              // ignore
            }
            source = null
          }
          pollTimer = setInterval(() => {
            void refreshRefine(true)
          }, 2000)
        }
        const mergeJobField = (patch) => {
          setJob((previous) => {
            const next = Object.assign({}, previous || {}, patch)
            jobRef.current = next
            return next
          })
        }
        const handlePayload = (payload) => {
          if (!isObject(payload)) return
          const seq = asNumber(payload.seq, 0)
          if (seq > 0) {
            if (seq <= lastSeqRef.current) return
            lastSeqRef.current = seq
          }
          const type = asString(payload.type)
          const ep = asNumber(payload.ep, 0)
          if (type === 'budget') {
            const source = isObject(payload.budget) ? payload.budget : payload
            if (
              isObject(source) &&
              (source.limitTokens !== undefined || source.spentTokens !== undefined || source.ratio !== undefined || source.exceeded !== undefined)
            ) {
              const nextBudget = normalizeBudget(source)
              if (nextBudget && typeof props.onBudgetChange === 'function') props.onBudgetChange(nextBudget)
            }
            return
          }
          if (type === 'director-start') {
            const entry = Object.assign(blankLiveStream(ep), {
              attempt: asNumber(payload.attempt, 1),
              promptChars: asNumber(payload.promptChars, 0),
              started: true,
              updatedAt: Date.now(),
            })
            streamsRef.current = Object.assign({}, streamsRef.current, { [ep]: entry })
            pendingRef.current[ep] = ''
            commitStreams()
            if (followLatestRef.current) setFollowedEp(ep)
            return
          }
          if (type === 'director-delta') {
            const delta = asString(payload.delta, '')
            if (!delta) return
            const base = streamsRef.current[ep] || blankLiveStream(ep)
            const current = pendingRef.current[ep] !== undefined ? pendingRef.current[ep] : base.text
            pendingRef.current[ep] = current + delta
            streamsRef.current = Object.assign({}, streamsRef.current, {
              [ep]: Object.assign({}, base, {
                started: true,
                attempt: asNumber(payload.attempt, base.attempt) || base.attempt,
                updatedAt: Date.now(),
              }),
            })
            return
          }
          if (type === 'director-end') {
            const base = streamsRef.current[ep] || blankLiveStream(ep)
            const text = pendingRef.current[ep] !== undefined ? pendingRef.current[ep] : base.text
            const entry = Object.assign({}, base, {
              text,
              chars: asNumber(payload.chars, text.length),
              finish: asString(payload.finish, ''),
              started: true,
              completed: true,
              updatedAt: Date.now(),
            })
            delete pendingRef.current[ep]
            streamsRef.current = Object.assign({}, streamsRef.current, { [ep]: entry })
            commitStreams()
            return
          }
          if (type === 'storyboard-start') {
            const entry = Object.assign(blankLiveStream(ep), {
              attempt: asNumber(payload.attempt, 1),
              started: true,
              updatedAt: Date.now(),
            })
            streamsRef.current = Object.assign({}, streamsRef.current, { [ep]: entry })
            pendingRef.current[ep] = ''
            commitStreams()
            if (followLatestRef.current) setFollowedEp(ep)
            return
          }
          if (type === 'storyboard-delta') {
            const delta = asString(payload.text || payload.delta, '')
            if (!delta) return
            const base = streamsRef.current[ep] || blankLiveStream(ep)
            const current = pendingRef.current[ep] !== undefined ? pendingRef.current[ep] : base.text
            pendingRef.current[ep] = current + delta
            streamsRef.current = Object.assign({}, streamsRef.current, {
              [ep]: Object.assign({}, base, { started: true, updatedAt: Date.now() }),
            })
            return
          }
          if (type === 'storyboard-end') {
            const base = streamsRef.current[ep] || blankLiveStream(ep)
            const text = pendingRef.current[ep] !== undefined ? pendingRef.current[ep] : base.text
            const entry = Object.assign({}, base, {
              text,
              chars: asNumber(payload.chars, text.length),
              finish: asString(payload.finish, ''),
              started: true,
              completed: true,
              updatedAt: Date.now(),
            })
            delete pendingRef.current[ep]
            streamsRef.current = Object.assign({}, streamsRef.current, { [ep]: entry })
            commitStreams()
            return
          }
          if (type === 'token') {
            const numericTotal =
              typeof payload.costTotal === 'number' && Number.isFinite(payload.costTotal) ? payload.costTotal : null
            if (isObject(payload.costTotal)) {
              costFromStreamRef.current = true
              setCost(normalizeCost(payload.costTotal))
            } else if (isObject(payload.cost)) {
              const delta = normalizeCost(payload.cost)
              costFromStreamRef.current = true
              setCost((previous) => {
                const base = previous || normalizeCost({})
                const input = base.input + delta.input
                const cacheRead = base.cacheRead + delta.cacheRead
                const output = base.output + delta.output
                return normalizeCost({
                  currency: delta.currency || base.currency,
                  tariff: delta.tariff || base.tariff,
                  input,
                  cacheRead,
                  output,
                  total: numericTotal !== null ? numericTotal : input + cacheRead + output,
                  calls: base.calls + 1,
                  inputTokens: base.inputTokens + delta.inputTokens,
                  cacheReadTokens: base.cacheReadTokens + delta.cacheReadTokens,
                  outputTokens: base.outputTokens + delta.outputTokens,
                })
              })
            }
            if (isObject(payload.budget) && typeof props.onBudgetChange === 'function') {
              props.onBudgetChange(normalizeBudget(payload.budget))
            }
            return
          }
          if (type === 'job' && isObject(payload.job)) {
            const nextJob = normalizeJob(payload.job)
            applyJob(nextJob)
            if (nextJob && nextJob.budget && typeof props.onBudgetChange === 'function') props.onBudgetChange(nextJob.budget)
            return
          }
          if (type === 'phase') {
            mergeJobField({
              phase: asString(payload.phase || payload.name, ''),
              phaseIndex:
                payload.phaseIndex !== undefined
                  ? asNumber(payload.phaseIndex, -1)
                  : payload.index !== undefined
                    ? asNumber(payload.index, -1)
                    : -1,
            })
            return
          }
          if (type === 'episode') {
            const state = asString(payload.state, '')
            if (state) {
              setJob((previous) => {
                const base = previous || {}
                const episodes = Object.assign({}, base.episodes)
                const doneStates = ['passed', 'passed-with-issues', 'failed', 'blocked']
                const currentDone = asNumber(episodes.done, 0)
                const next = Object.assign({}, base, {
                  episodes: {
                    total: Math.max(asNumber(episodes.total, 0), ep),
                    done: doneStates.indexOf(state.toLowerCase()) >= 0 ? Math.max(currentDone, currentDone + 1) : currentDone,
                  },
                })
                jobRef.current = next
                return next
              })
            }
            return
          }
          if (type === 'done' || type === 'error') {
            if (isObject(payload.job)) {
              const next = normalizeJob(payload.job)
              applyJob(next)
              if (next && jobIsTerminal(next)) setTerminal(next.state)
              if (next && next.budget && typeof props.onBudgetChange === 'function') props.onBudgetChange(next.budget)
            }
            if (type === 'error') {
              setTerminal('failed')
              setError(asString(payload.error || payload.message, '') || t('progress.failedTitle'))
            }
            return
          }
        }
        const connect = () => {
          if (disposed || finishedRef.current) return
          try {
            if (typeof EventSource === 'undefined') {
              startPolling()
              return
            }
            source = new EventSource(api.eventsUrl(jobId))
            sourceRef.current = source
            source.onopen = () => {
              if (disposed) return
              setConn('open')
              lastEventAt = Date.now()
              sseErrors = 0
            }
            source.onmessage = (event) => {
              if (disposed) return
              lastEventAt = Date.now()
              if (typeof event.data !== 'string' || event.data.length === 0) return
              try {
                handlePayload(JSON.parse(event.data))
              } catch {
                // ignore malformed payloads
              }
            }
            source.onerror = () => {
              if (disposed) return
              sseErrors += 1
              if (!source || source.readyState === 2 || sseErrors >= 3) startPolling()
              else setConn('retry')
            }
          } catch {
            startPolling()
          }
        }
        connect()
        watchdog = setInterval(() => {
          if (disposed) return
          if (Date.now() - lastEventAt > 30000) startPolling()
        }, 5000)
        return () => {
          disposed = true
          stopPolling()
          if (watchdog) clearInterval(watchdog)
          if (source) {
            try {
              source.close()
            } catch {
              // ignore
            }
          }
          if (sourceRef.current === source) sourceRef.current = null
        }
      }, [jobId, applyJob, commitStreams, refreshRefine, t])

      useEffect(() => {
        if (!job || finishedRef.current || !jobIsTerminal(job)) return undefined
        finishedRef.current = true
        setTerminal(job.state)
        flushStreams()
        if (sourceRef.current) {
          try {
            sourceRef.current.close()
          } catch {
            // ignore
          }
          sourceRef.current = null
        }
        void refreshRefine(true)
        return undefined
        // Only react to terminal job transitions.
      }, [job, flushStreams, refreshRefine])

      const running = Boolean(job && jobIsRunning(job))
      const streamEntries = Object.keys(streams)
        .map((key) => streams[key])
        .filter(Boolean)
        .sort((left, right) => left.ep - right.ep)
      const latestActive =
        streamEntries
          .filter((entry) => entry.started && !entry.completed)
          .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))[0] ||
        (streamEntries.length > 0 ? streamEntries[streamEntries.length - 1] : null)
      const followTarget = followLatest && latestActive ? latestActive.ep : followedEp
      const currentStream = followTarget !== null && followTarget !== undefined ? streams[followTarget] : null

      useEffect(() => {
        const node = consoleRef.current
        if (!node || !autoScrollRef.current) return
        node.scrollTop = node.scrollHeight
      }, [streams, followTarget, terminal])

      useEffect(() => {
        if (running) return undefined
        const episodes = refine ? refine.episodes : []
        let candidate = null
        for (let index = 0; index < episodes.length; index += 1) {
          if (episodes[index].artifacts && episodes[index].artifacts.draft) candidate = episodes[index].ep
        }
        if (candidate === null) {
          const completed = streamEntries.filter((entry) => entry.completed)
          if (completed.length > 0) candidate = completed[completed.length - 1].ep
        }
        if (candidate === null) {
          setDraft(null)
          return undefined
        }
        let cancelled = false
        setDraft({ ep: candidate, loading: true, markdown: '', notes: '', error: null })
        void api
          .draft(props.projectId, candidate)
          .then((response) => {
            if (cancelled) return
            if (response.ok && isObject(response.data) && response.data.ok) {
              const payload = isObject(response.data.episode) ? response.data.episode : response.data
              setDraft({
                ep: candidate,
                loading: false,
                markdown: asString(payload.draftMarkdown, ''),
                notes: asString(payload.notes, ''),
                error: null,
              })
            } else {
              setDraft({ ep: candidate, loading: false, markdown: '', notes: '', error: t('live.loadFailed', { reason: '' }) })
            }
          })
          .catch((err) => {
            if (!cancelled) setDraft({ ep: candidate, loading: false, markdown: '', notes: '', error: asString(err && err.message, '') })
          })
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [running, refine, streamEntries.length, props.projectId, t])

      const elapsedMs = (() => {
        const startedAt = job && job.startedAt ? new Date(job.startedAt).getTime() : 0
        if (!startedAt) return 0
        const finishedAt = job && job.finishedAt ? new Date(job.finishedAt).getTime() : now
        return Math.max(0, finishedAt - startedAt)
      })()
      const phases = job && job.phases && job.phases.length > 0 ? job.phases : REFINE_PHASES
      const activePhaseIndex = job ? (job.phaseIndex >= 0 ? job.phaseIndex : phases.indexOf(job.phase)) : -1
      const connKey =
        conn === 'open'
          ? 'live.connectionOpen'
          : conn === 'polling'
            ? 'live.connectionPolling'
            : conn === 'retry'
              ? 'live.connectionRetry'
              : 'live.connectionClosed'
      const connKind = conn === 'open' ? 'success' : conn === 'polling' ? 'risk' : 'idle'
      const latestEpNumber = streamEntries.length > 0 ? streamEntries[streamEntries.length - 1].ep : 0
      const attemptValue = currentStream ? currentStream.attempt : 0
      const phasesStepper = h(
        'div',
        { className: 'lb-stepper' },
        phases.map((phase, index) => {
          let className = 'lb-step'
          if (terminal === 'succeeded') className += ' lb-step-done'
          else if (terminal === 'failed' && index === Math.max(0, activePhaseIndex)) className += ' lb-step-fail'
          else if (index < activePhaseIndex) className += ' lb-step-done'
          else if (index === activePhaseIndex) className += ' lb-step-active'
          return h('span', { key: phase, className }, h('span', { className: 'lb-step-dot', 'aria-hidden': true }), phaseLabel(phase, t))
        }),
      )
      const consoleText = currentStream ? currentStream.text : ''
      const showThinking = Boolean(running && (!currentStream || (currentStream.started && !currentStream.completed && !currentStream.text)))
      const showCompleted = Boolean(currentStream && currentStream.completed)
      const scrollToBottom = () => {
        const node = consoleRef.current
        if (node) node.scrollTop = node.scrollHeight
        autoScrollRef.current = true
        setScrollPaused(false)
      }

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'lb-section-head' },
          h('h3', { className: 'lb-section-title' }, t('live.title')),
          h('span', { className: 'lb-hint', style: { marginTop: '0' } }, t('live.subtitle')),
          h('div', { className: 'lb-section-actions' }, h(Badge, { kind: connKind }, t(connKey))),
        ),
        loading ? h(LoadingBlock, { t, label: t('live.loading') }) : null,
        error ? h(ErrorBlock, { message: error, t }) : null,
        !loading
          ? h(
              'section',
              { className: 'lb-section', style: { marginTop: '12px' } },
              phasesStepper,
              h(
                'div',
                { className: 'lb-live-meta' },
                h('span', null, `${t('live.phase')}: `, h('strong', null, job ? phaseLabel(job.phase, t) : '—')),
                h('span', null, `${t('refine.colEp')}: `, h('strong', null, latestEpNumber > 0 ? `EP${latestEpNumber}` : '—')),
                h('span', null, `${t('live.episodes')}: `, h('strong', null, job ? `${job.episodes.done}/${job.episodes.total}` : '0/0')),
                h('span', null, `${t('live.attempt')}: `, h('strong', null, numberOf(attemptValue))),
                h('span', null, `${t('live.elapsed')}: `, h('strong', null, formatDuration(elapsedMs))),
                h('span', null, `${t('job.title')}: `, h('strong', null, job ? jobStateLabel(job, t) : t('live.noJob'))),
              ),
              running
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { className: 'lb-live-toolbar' },
                      h(
                        Button,
                        {
                          variant: followLatest ? 'primary' : undefined,
                          onClick: () => {
                            const next = !followLatest
                            setFollowLatest(next)
                            followLatestRef.current = next
                            if (next && latestActive) setFollowedEp(latestActive.ep)
                          },
                        },
                        t('live.followLatest'),
                      ),
                      currentStream
                        ? h('span', { className: 'lb-hint', style: { marginTop: '0' } }, `${t('live.following')}: EP${currentStream.ep} · ${currentStream.completed ? t('live.completed') : t('live.streaming')}`)
                        : null,
                      currentStream && currentStream.promptChars > 0
                        ? h('span', { className: 'lb-hint', style: { marginTop: '0' } }, t('live.promptChars', { n: numberOf(currentStream.promptChars) }))
                        : null,
                      currentStream && currentStream.completed
                        ? h('span', { className: 'lb-hint', style: { marginTop: '0' } }, t('live.chars', { n: numberOf(currentStream.chars || currentStream.text.length) }))
                        : null,
                    ),
                    streamEntries.length > 0
                      ? h(
                          'div',
                          { className: 'lb-live-chips' },
                          streamEntries.map((entry) => {
                            const active = entry.ep === followTarget
                            const className = active
                              ? 'lb-live-chip lb-live-chip-active'
                              : entry.completed
                                ? 'lb-live-chip lb-live-chip-done'
                                : 'lb-live-chip'
                            return h(
                              'button',
                              {
                                key: `live-chip-${entry.ep}`,
                                type: 'button',
                                className,
                                onClick: () => {
                                  setFollowLatest(false)
                                  followLatestRef.current = false
                                  setFollowedEp(entry.ep)
                                },
                              },
                              t('live.epLabel', { ep: entry.ep }),
                              entry.attempt > 1 ? ` · ${t('live.attempt', { n: entry.attempt })}` : '',
                            )
                          }),
                        )
                      : null,
                    h(
                      'div',
                      {
                        className: 'lb-live-console',
                        ref: consoleRef,
                        role: 'log',
                        'aria-live': 'off',
                        onScroll: (event) => {
                          const node = event.currentTarget
                          const distance = node.scrollHeight - node.scrollTop - node.clientHeight
                          const paused = distance > LIVE_SCROLL_THRESHOLD
                          autoScrollRef.current = !paused
                          setScrollPaused(paused)
                        },
                      },
                      showThinking ? h('span', { className: 'lb-live-thinking' }, t('live.thinking')) : null,
                      showCompleted ? h('span', null, '') : null,
                      consoleText
                        ? consoleText
                        : showThinking
                          ? null
                          : h('span', { className: 'lb-live-thinking' }, t('live.waiting')),
                    ),
                    scrollPaused
                      ? h(
                          'div',
                          { className: 'lb-live-toolbar' },
                          h('span', { className: 'lb-hint', style: { marginTop: '0' } }, t('live.pausedScroll')),
                          h(Button, { onClick: scrollToBottom }, t('live.scrollBottom')),
                        )
                      : null,
                  )
                : h(
                    'div',
                    null,
                    h('p', { className: 'lb-hint' }, t('live.historyHint')),
                    refine
                      ? h(
                          'div',
                          { className: 'lb-live-meta' },
                          h('span', null, `${t('live.runSummary')}: `, h('strong', null, refineStateLabel(refine.state, t))),
                          h(
                            'span',
                            null,
                            `${t('refine.counts.passed')} ${numberOf(refine.progress.passed)}/${numberOf(refine.progress.total)}`,
                          ),
                          h('span', null, `${t('refine.counts.failed')} ${numberOf(refine.progress.failed)}`),
                          h('span', null, `${t('refine.costTotal')} ${formatYuan((refine.cost && refine.cost.total) || 0)}`),
                        )
                      : null,
                    streamEntries.length > 0
                      ? h(
                          'div',
                          { className: 'lb-live-chips' },
                          streamEntries.map((entry) =>
                            h(
                              'button',
                              {
                                key: `live-hist-${entry.ep}`,
                                type: 'button',
                                className: entry.ep === followTarget ? 'lb-live-chip lb-live-chip-active' : 'lb-live-chip',
                                onClick: () => {
                                  setFollowLatest(false)
                                  followLatestRef.current = false
                                  setFollowedEp(entry.ep)
                                },
                              },
                              `EP${entry.ep}`,
                            ),
                          ),
                        )
                      : null,
                    consoleText
                      ? h(
                          'div',
                          { className: 'lb-live-console', ref: consoleRef, role: 'log', 'aria-live': 'off' },
                          consoleText,
                        )
                      : null,
                    draft
                      ? h(
                          'div',
                          { className: 'lb-draft' },
                          h(
                            'div',
                            { className: 'lb-draft-head' },
                            h('strong', null, `${t('live.latestDraft')} · EP${draft.ep}`),
                            draft.ep === followTarget ? h(Badge, { kind: 'brand' }, t('live.following')) : null,
                          ),
                          draft.loading ? h(LoadingBlock, { t, label: t('refine.draftLoading') }) : null,
                          draft.error ? h(ErrorBlock, { message: draft.error, t }) : null,
                          !draft.loading && !draft.error
                            ? draft.markdown
                              ? h('pre', { className: 'lb-pre' }, draft.markdown)
                              : h('p', { className: 'lb-hint' }, t('live.draftEmpty'))
                            : null,
                          draft.notes ? h('pre', { className: 'lb-pre' }, draft.notes) : null,
                        )
                      : null,
                  ),
              h(CostCard, {
                t,
                pricing: props.pricing,
                cost: cost || (refine ? refine.cost : null),
                tokens: refine ? refine.tokens : null,
              }),
            )
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // BGM tab (M4)
    // -----------------------------------------------------------------------
    function blankBgmStream(ep, role) {
      const normalizedRole = asString(role, 'worker') || 'worker'
      return {
        key: `${normalizedRole}:${ep}`,
        ep,
        role: normalizedRole,
        text: '',
        attempt: 0,
        chars: 0,
        finish: '',
        started: false,
        completed: false,
        updatedAt: 0,
      }
    }

    function BgmTab(props) {
      const t = props.t
      const [bgm, setBgm] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [actionError, setActionError] = useState(null)
      const [sampleInput, setSampleInput] = useState('')
      const [concurrencyInput, setConcurrencyInput] = useState('')
      const [startedJobId, setStartedJobId] = useState('')
      const [streams, setStreams] = useState({})
      const [followedKey, setFollowedKey] = useState(null)
      const [followLatest, setFollowLatest] = useState(true)
      const [conn, setConn] = useState('connecting')
      const [terminal, setTerminal] = useState('')
      const [cost, setCost] = useState(null)
      const [now, setNow] = useState(Date.now())
      const [scrollPaused, setScrollPaused] = useState(false)
      const [episodeOverrides, setEpisodeOverrides] = useState({})
      const [draftState, setDraftState] = useState(null)
      const [assetState, setAssetState] = useState(null)
      const [historyDraft, setHistoryDraft] = useState(null)
      const [budget, setBudget] = useState(null)
      const [lastParams, setLastParams] = useState(null)
      const streamsRef = useRef({})
      const pendingRef = useRef({})
      const jobRef = useRef(null)
      const followLatestRef = useRef(true)
      const consoleRef = useRef(null)
      const autoScrollRef = useRef(true)
      const lastSeqRef = useRef(0)
      const finishedRef = useRef(false)
      const sourceRef = useRef(null)
      const costFromStreamRef = useRef(false)

      const applyJob = useCallback((nextJob) => {
        if (!nextJob) return
        jobRef.current = nextJob
        setBgm((previous) => (previous ? Object.assign({}, previous, { job: nextJob }) : previous))
      }, [])

      const flushStreams = useCallback(() => {
        const pending = pendingRef.current
        const keys = Object.keys(pending)
        if (keys.length === 0) return
        const next = Object.assign({}, streamsRef.current)
        keys.forEach((key) => {
          const base = next[key]
          if (!base) return
          next[key] = Object.assign({}, base, { text: pending[key] })
        })
        pendingRef.current = {}
        streamsRef.current = next
        setStreams(next)
      }, [])

      const commitStreams = useCallback(() => {
        setStreams(Object.assign({}, streamsRef.current))
      }, [])

      const loadBgm = useCallback(
        async (silent) => {
          if (!silent) {
            setLoading(true)
            setError(null)
          }
          try {
            const response = await api.bgm(props.projectId)
            if (response.ok && isObject(response.data) && response.data.ok) {
              const next = normalizeBgm(response.data.bgm)
              setBgm(next)
              setBudget(next.budget || null)
              if (next.job) {
                jobRef.current = next.job
                if (jobIsTerminal(next.job)) setTerminal(next.job.state)
              }
              if (!costFromStreamRef.current && next.cost && next.cost.total > 0) setCost(next.cost)
              if (next.job && jobIsTerminal(next.job)) setEpisodeOverrides({})
              return next
            }
            if (!silent) setError(t('bgm.loadFailed', { reason: describeError(errorInfoFromResponse(response, t('common.unknown')), t) }))
          } catch (err) {
            if (!silent) setError(t('bgm.loadFailed', { reason: describeError(errorInfoFromException(err, ''), t) }))
          } finally {
            if (!silent) setLoading(false)
          }
          return null
        },
        [props.projectId, t],
      )

      useEffect(() => {
        setBgm(null)
        setError(null)
        setActionError(null)
        setLoading(true)
        setStartedJobId('')
        setStreams({})
        streamsRef.current = {}
        pendingRef.current = {}
        lastSeqRef.current = 0
        setFollowedKey(null)
        setFollowLatest(true)
        followLatestRef.current = true
        autoScrollRef.current = true
        setScrollPaused(false)
        setConn('connecting')
        setTerminal('')
        setCost(null)
        setEpisodeOverrides({})
        setDraftState(null)
        setAssetState(null)
        setHistoryDraft(null)
        setBudget(null)
        setLastParams(null)
        costFromStreamRef.current = false
        finishedRef.current = false
        if (typeof props.onPricingRefresh === 'function') props.onPricingRefresh()
        void loadBgm(false)
      }, [loadBgm])

      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [])

      useEffect(() => {
        const timer = setInterval(() => flushStreams(), LIVE_FLUSH_MS)
        return () => clearInterval(timer)
      }, [flushStreams])

      const job = bgm && bgm.job ? bgm.job : null
      const jobId = (job && job.id) || startedJobId
      const jobRunning = Boolean(job && (jobIsRunning(job) || asString(job.state).toLowerCase() === 'queued'))

      useEffect(() => {
        if (!jobId || !jobRunning) return undefined
        const timer = setInterval(() => {
          void loadBgm(true)
        }, 3000)
        return () => clearInterval(timer)
      }, [jobId, jobRunning, loadBgm])

      useEffect(() => {
        if (!jobId || !jobRunning) return undefined
        let disposed = false
        let source = null
        let pollTimer = null
        let watchdog = null
        let lastEventAt = Date.now()
        let sseErrors = 0
        const stopPolling = () => {
          if (pollTimer) {
            clearInterval(pollTimer)
            pollTimer = null
          }
        }
        const startPolling = () => {
          if (disposed || pollTimer) return
          setConn('polling')
          if (source) {
            try {
              source.close()
            } catch {
              // ignore
            }
            source = null
          }
          pollTimer = setInterval(() => {
            void loadBgm(true)
          }, 2000)
        }
        const setJobPatch = (patch) => {
          setBgm((previous) => {
            if (!previous) return previous
            const base = previous.job || {}
            const next = Object.assign({}, base, patch)
            jobRef.current = next
            return Object.assign({}, previous, { job: next })
          })
        }
        const handlePayload = (payload) => {
          if (!isObject(payload)) return
          const seq = asNumber(payload.seq, 0)
          if (seq > 0) {
            if (seq <= lastSeqRef.current) return
            lastSeqRef.current = seq
          }
          const type = asString(payload.type)
          const ep = asNumber(payload.ep, 0)
          if (type === 'budget') {
            const source = isObject(payload.budget) ? payload.budget : payload
            if (
              isObject(source) &&
              (source.limitTokens !== undefined || source.spentTokens !== undefined || source.ratio !== undefined || source.exceeded !== undefined)
            ) {
              setBudget(normalizeBudget(source))
            }
            return
          }
          if (type === 'bgm-start') {
            const entry = blankBgmStream(ep, payload.role)
            entry.attempt = asNumber(payload.attempt, 1)
            entry.started = true
            entry.updatedAt = Date.now()
            streamsRef.current = Object.assign({}, streamsRef.current, { [entry.key]: entry })
            pendingRef.current[entry.key] = ''
            commitStreams()
            if (followLatestRef.current) setFollowedKey(entry.key)
            return
          }
          if (type === 'bgm-delta') {
            const delta = asString(payload.delta, '')
            if (!delta) return
            const key = `${asString(payload.role, 'worker') || 'worker'}:${ep}`
            const base = streamsRef.current[key] || blankBgmStream(ep, payload.role)
            const current = pendingRef.current[key] !== undefined ? pendingRef.current[key] : base.text
            pendingRef.current[key] = current + delta
            streamsRef.current = Object.assign({}, streamsRef.current, {
              [key]: Object.assign({}, base, {
                started: true,
                attempt: asNumber(payload.attempt, base.attempt) || base.attempt,
                updatedAt: Date.now(),
              }),
            })
            return
          }
          if (type === 'bgm-end') {
            const key = `${asString(payload.role, 'worker') || 'worker'}:${ep}`
            const base = streamsRef.current[key] || blankBgmStream(ep, payload.role)
            const text = pendingRef.current[key] !== undefined ? pendingRef.current[key] : base.text
            const entry = Object.assign({}, base, {
              text,
              chars: asNumber(payload.chars, text.length),
              finish: asString(payload.finish, ''),
              started: true,
              completed: true,
              updatedAt: Date.now(),
            })
            delete pendingRef.current[key]
            streamsRef.current = Object.assign({}, streamsRef.current, { [key]: entry })
            commitStreams()
            return
          }
          if (type === 'token') {
            const numericTotal =
              typeof payload.costTotal === 'number' && Number.isFinite(payload.costTotal) ? payload.costTotal : null
            if (isObject(payload.costTotal)) {
              costFromStreamRef.current = true
              setCost(normalizeCost(payload.costTotal))
            } else if (isObject(payload.cost)) {
              const delta = normalizeCost(payload.cost)
              costFromStreamRef.current = true
              setCost((previous) => {
                const base = previous || normalizeCost({})
                const input = base.input + delta.input
                const cacheRead = base.cacheRead + delta.cacheRead
                const output = base.output + delta.output
                return normalizeCost({
                  currency: delta.currency || base.currency,
                  tariff: delta.tariff || base.tariff,
                  input,
                  cacheRead,
                  output,
                  total: numericTotal !== null ? numericTotal : input + cacheRead + output,
                  calls: base.calls + 1,
                  inputTokens: base.inputTokens + delta.inputTokens,
                  cacheReadTokens: base.cacheReadTokens + delta.cacheReadTokens,
                  outputTokens: base.outputTokens + delta.outputTokens,
                })
              })
            }
            if (isObject(payload.budget)) setBudget(normalizeBudget(payload.budget))
            return
          }
          if (type === 'job' && isObject(payload.job)) {
            const nextJob = normalizeJob(payload.job)
            applyJob(nextJob)
            if (nextJob && nextJob.budget) setBudget(nextJob.budget)
            return
          }
          if (type === 'phase') {
            setJobPatch({
              phase: asString(payload.phase || payload.name, ''),
              phaseIndex:
                payload.phaseIndex !== undefined
                  ? asNumber(payload.phaseIndex, -1)
                  : payload.index !== undefined
                    ? asNumber(payload.index, -1)
                    : -1,
            })
            return
          }
          if (type === 'episode') {
            if (ep > 0) {
              const override = {}
              if (payload.state) override.state = asString(payload.state).toLowerCase()
              if (payload.attempts !== undefined) override.attempts = asNumber(payload.attempts, 0)
              if (isObject(payload.check)) {
                override.check = {
                  fails: asArray(payload.check.fails || payload.check.hardFails).map((entry) => asString(entry)),
                  warns: asArray(payload.check.warns).map((entry) => asString(entry)),
                  verdict: asString(payload.check.verdict, ''),
                  raw: payload.check,
                }
              }
              if (isObject(payload.qc)) {
                override.qc = {
                  verdict: asString(payload.qc.verdict || payload.qc.result, ''),
                  raw: payload.qc,
                }
              }
              if (isObject(payload.cost)) override.cost = normalizeCost(payload.cost)
              setEpisodeOverrides((previous) => Object.assign({}, previous, { [ep]: Object.assign({}, previous[ep] || {}, override) }))
            }
            return
          }
          if (type === 'done' || type === 'error') {
            if (isObject(payload.job)) {
              const next = normalizeJob(payload.job)
              applyJob(next)
              if (next && jobIsTerminal(next)) setTerminal(next.state)
              if (next && next.budget) setBudget(next.budget)
            } else {
              setTerminal(type === 'error' ? 'failed' : 'succeeded')
            }
            if (type === 'error') {
              setActionError(asString(payload.error || payload.message, '') || t('progress.failedTitle'))
            }
            finishedRef.current = true
            commitStreams()
            void loadBgm(true)
            return
          }
        }
        const connect = () => {
          if (disposed || finishedRef.current) return
          try {
            if (typeof EventSource === 'undefined') {
              startPolling()
              return
            }
            source = new EventSource(api.eventsUrl(jobId))
            sourceRef.current = source
            source.onopen = () => {
              if (disposed) return
              setConn('open')
              lastEventAt = Date.now()
              sseErrors = 0
            }
            source.onmessage = (event) => {
              if (disposed) return
              lastEventAt = Date.now()
              if (typeof event.data !== 'string' || event.data.length === 0) return
              try {
                handlePayload(JSON.parse(event.data))
              } catch {
                // ignore malformed payloads
              }
            }
            source.onerror = () => {
              if (disposed) return
              sseErrors += 1
              if (!source || source.readyState === 2 || sseErrors >= 3) startPolling()
              else setConn('retry')
            }
          } catch {
            startPolling()
          }
        }
        connect()
        watchdog = setInterval(() => {
          if (disposed) return
          if (Date.now() - lastEventAt > 30000) startPolling()
        }, 5000)
        return () => {
          disposed = true
          stopPolling()
          if (watchdog) clearInterval(watchdog)
          if (source) {
            try {
              source.close()
            } catch {
              // ignore
            }
          }
          if (sourceRef.current === source) sourceRef.current = null
        }
      }, [jobId, jobRunning, applyJob, commitStreams, loadBgm, t])

      useEffect(() => {
        if (!job || finishedRef.current || !jobIsTerminal(job)) return undefined
        finishedRef.current = true
        setTerminal(job.state)
        flushStreams()
        if (sourceRef.current) {
          try {
            sourceRef.current.close()
          } catch {
            // ignore
          }
          sourceRef.current = null
        }
        void loadBgm(true)
        return undefined
      }, [job, flushStreams, loadBgm])

      const startBgm = useCallback(
        async (episodesList, overrides) => {
          if (busy) return
          setBusy(true)
          setActionError(null)
          try {
            const payload = {}
            const list = Array.isArray(episodesList) ? episodesList : parseEpisodeList(sampleInput)
            if (list && list.length > 0) payload.episodes = list
            const concurrency =
              overrides && overrides.concurrency !== undefined ? asNumber(overrides.concurrency, 0) : asNumber(concurrencyInput, 0)
            if (concurrency > 0) payload.concurrency = concurrency
            setLastParams({ episodes: list && list.length > 0 ? list.slice() : null, concurrency: concurrency > 0 ? concurrency : null })
            const response = await api.action(props.projectId, 'run-bgm', payload)
            if (response.ok && isObject(response.data) && response.data.ok) {
              const nextJob = normalizeJob(response.data.job)
              if (nextJob && nextJob.id) {
                finishedRef.current = false
                setTerminal('')
                setStartedJobId(nextJob.id)
                jobRef.current = nextJob
                setBgm((previous) => (previous ? Object.assign({}, previous, { job: nextJob }) : previous))
                setStreams({})
                streamsRef.current = {}
                pendingRef.current = {}
                lastSeqRef.current = 0
                setFollowedKey(null)
                setFollowLatest(true)
                followLatestRef.current = true
                setCost(null)
                setEpisodeOverrides({})
                costFromStreamRef.current = false
                if (typeof props.notify === 'function') props.notify({ kind: 'success', message: t('bgm.started') })
                void loadBgm(true)
                return
              }
              void loadBgm()
            } else {
              setActionError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
            }
          } catch (err) {
            setActionError(describeError(errorInfoFromException(err, ''), t))
          } finally {
            setBusy(false)
          }
        },
        [busy, concurrencyInput, loadBgm, props, sampleInput, t],
      )

      const cancelBgm = useCallback(async () => {
        if (!jobId || busy) return
        setBusy(true)
        setActionError(null)
        try {
          const response = await api.cancelJob(jobId)
          if (response.ok && isObject(response.data) && response.data.ok) {
            const next = normalizeJob(response.data.job)
            if (next) {
              applyJob(next)
              if (jobIsTerminal(next)) setTerminal(next.state)
            }
            if (typeof props.notify === 'function') props.notify({ kind: 'success', message: t('toast.actionDone') })
          } else {
            setActionError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
          }
        } catch (err) {
          setActionError(describeError(errorInfoFromException(err, ''), t))
        } finally {
          setBusy(false)
        }
      }, [applyJob, busy, jobId, props, t])

      const openDraft = useCallback(
        async (ep) => {
          if (draftState && draftState.ep === ep && !draftState.loading) {
            setDraftState(null)
            return
          }
          setDraftState({ ep, loading: true, markdown: '', report: null, check: null, qc: null, error: null })
          try {
            const response = await api.bgmDraft(props.projectId, ep)
            if (response.ok && isObject(response.data) && response.data.ok) {
              const payload = isObject(response.data.episode) ? response.data.episode : response.data
              setDraftState({
                ep,
                loading: false,
                markdown: asString(payload.markdown || payload.bgmMarkdown || payload.draftMarkdown, ''),
                report: payload.report || null,
                check: payload.check || null,
                qc: payload.qc || null,
                error: null,
              })
            } else {
              setDraftState({
                ep,
                loading: false,
                markdown: '',
                report: null,
                check: null,
                qc: null,
                error: t('bgm.loadFailed', { reason: describeError(errorInfoFromResponse(response, t('common.unknown')), t) }),
              })
            }
          } catch (err) {
            setDraftState({ ep, loading: false, markdown: '', report: null, check: null, qc: null, error: asString(err && err.message, '') })
          }
        },
        [draftState, props.projectId, t],
      )

      const openAsset = useCallback(
        async (kind) => {
          const source = kind === 'seriesBible' ? (bgm && bgm.seriesBible) : (bgm && bgm.themeMap)
          const asset = normalizeTextAsset(source)
          if (!asset) return
          if (asset.text) {
            setAssetState({ kind, loading: false, text: asset.text, path: '', error: null })
            return
          }
          setAssetState({ kind, loading: true, text: '', path: asset.path, error: null })
          try {
            const response = await fetch(api.fileUrl(props.projectId, asset.path), { credentials: 'same-origin', cache: 'no-store' })
            let text = ''
            if (response.ok) text = await response.text()
            setAssetState({
              kind,
              loading: false,
              text,
              path: asset.path,
              error: response.ok ? null : t('bgm.loadFailed', { reason: `HTTP ${response.status}` }),
            })
          } catch (err) {
            setAssetState({ kind, loading: false, text: '', path: asset.path, error: asString(err && err.message, '') })
          }
        },
        [bgm, props.projectId, t],
      )

      useEffect(() => {
        if (jobRunning) return undefined
        const list = bgm ? bgm.episodes : []
        if (!list || list.length === 0) {
          setHistoryDraft(null)
          return undefined
        }
        const withArtifacts = list.filter((entry) => entry.artifacts && entry.artifacts.bgm)
        const candidate = withArtifacts.length > 0 ? withArtifacts[withArtifacts.length - 1] : null
        if (!candidate) {
          setHistoryDraft(null)
          return undefined
        }
        let cancelled = false
        setHistoryDraft({ ep: candidate.ep, loading: true, text: '', error: null })
        void api
          .bgmDraft(props.projectId, candidate.ep)
          .then((response) => {
            if (cancelled) return
            if (response.ok && isObject(response.data) && response.data.ok) {
              const payload = isObject(response.data.episode) ? response.data.episode : response.data
              setHistoryDraft({ ep: candidate.ep, loading: false, text: asString(payload.markdown, ''), error: null })
            } else {
              setHistoryDraft({ ep: candidate.ep, loading: false, text: '', error: asString(response.data && response.data.error, '') })
            }
          })
          .catch((err) => {
            if (!cancelled) setHistoryDraft({ ep: candidate.ep, loading: false, text: '', error: asString(err && err.message, '') })
          })
        return () => {
          cancelled = true
        }
      }, [jobRunning, bgm, props.projectId, t])

      const running = Boolean(job && jobIsRunning(job))
      const budgetState = budget || (job && job.budget) || (bgm && bgm.budget) || null
      const confirmKind = needsConfirmKind(job)
      const retryLast = () => {
        const params = lastParams || { episodes: null, concurrency: null }
        void startBgm(params.episodes, { concurrency: params.concurrency || 0 })
      }
      const phases = job && job.phases && job.phases.length > 0 ? job.phases : BGM_PHASES
      const activePhaseIndex = job ? (job.phaseIndex >= 0 ? job.phaseIndex : phases.indexOf(job.phase)) : -1
      const entries = Object.keys(streams)
        .map((key) => streams[key])
        .filter(Boolean)
        .sort((left, right) => left.ep - right.ep || String(left.role).localeCompare(String(right.role)))
      const latestActive =
        entries
          .filter((entry) => entry.started && !entry.completed)
          .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))[0] ||
        (entries.length > 0 ? entries[entries.length - 1] : null)
      const followTarget = followLatest && latestActive ? latestActive.key : followedKey
      const currentStream = followTarget ? streams[followTarget] : null
      const consoleText = currentStream ? currentStream.text : ''
      const showThinking = Boolean(running && (!currentStream || (currentStream.started && !currentStream.completed && !currentStream.text)))
      const elapsedMs = (() => {
        const startedAt = job && job.startedAt ? new Date(job.startedAt).getTime() : 0
        if (!startedAt) return 0
        const finishedAt = job && job.finishedAt ? new Date(job.finishedAt).getTime() : now
        return Math.max(0, finishedAt - startedAt)
      })()
      const episodes = (bgm ? bgm.episodes : []).map((entry) =>
        Object.assign({}, entry, episodeOverrides[entry.ep] || {}),
      )
      const counts = {}
      BGM_EP_STATES.forEach((key) => {
        counts[key] = 0
      })
      episodes.forEach((entry) => {
        if (counts[entry.state] !== undefined) counts[entry.state] += 1
      })
      counts.total = episodes.length
      if (episodes.length === 0 && bgm) {
        BGM_EP_STATES.forEach((key) => {
          if (bgm.progress[key]) counts[key] = bgm.progress[key]
        })
        counts.total = bgm.progress.total
      }
      const tokens = bgm ? bgm.tokens : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      const displayCost = resolveCost({ cost: cost || (bgm ? bgm.cost : null), tokens, pricing: props.pricing })
      const links = bgm ? bgmArtifactLinks(bgm.artifacts, t) : []
      const retryableEps = episodes.filter((entry) => entry.state === 'failed').map((entry) => entry.ep)
      const snapshot = props.snapshot || {}
      const refineState = snapshot.refine ? asString(snapshot.refine.state).toLowerCase() : ''
      const projectStatus = snapshot.project ? asString(snapshot.project.status).toLowerCase() : ''
      const refineReady =
        bgm && typeof bgm.refineReady === 'boolean'
          ? bgm.refineReady
          : ['done', 'partial', 'succeeded'].indexOf(refineState) >= 0 || /^refine_(done|partial)/.test(projectStatus)
      const canStart = refineReady && !jobRunning && !busy
      const maxAttempts = Math.max(
        episodes.reduce((max, entry) => Math.max(max, asNumber(entry.attempts, 0)), 0),
        currentStream ? asNumber(currentStream.attempt, 0) : 0,
      )
      const connKey =
        conn === 'open'
          ? 'live.connectionOpen'
          : conn === 'polling'
            ? 'live.connectionPolling'
            : conn === 'retry'
              ? 'live.connectionRetry'
              : 'live.connectionClosed'
      const connKind = conn === 'open' ? 'success' : conn === 'polling' ? 'risk' : 'idle'
      const displayJob = job
        ? Object.assign({}, job, {
            episodes:
              job.episodes && (job.episodes.total > 0 || job.episodes.done > 0)
                ? job.episodes
                : { total: counts.total, done: counts.passed + counts.failed },
          })
        : null
      const stepper = h(
        'div',
        { className: 'lb-stepper' },
        phases.map((phase, index) => {
          let className = 'lb-step'
          if (displayJob && displayJob.state === 'succeeded') className += ' lb-step-done'
          else if (displayJob && (displayJob.state === 'failed' || displayJob.state === 'cancelled') && index === Math.max(0, activePhaseIndex))
            className += ' lb-step-fail'
          else if (index < activePhaseIndex) className += ' lb-step-done'
          else if (index === activePhaseIndex) className += ' lb-step-active'
          return h('span', { key: phase, className }, h('span', { className: 'lb-step-dot', 'aria-hidden': true }), phaseLabel(phase, t))
        }),
      )
      const scrollToBottom = () => {
        const node = consoleRef.current
        if (node) node.scrollTop = node.scrollHeight
        autoScrollRef.current = true
        setScrollPaused(false)
      }
      useEffect(() => {
        const node = consoleRef.current
        if (!node || !autoScrollRef.current) return
        node.scrollTop = node.scrollHeight
      }, [streams, followTarget, terminal])

      const seriesAsset = bgm ? normalizeTextAsset(bgm.seriesBible || (bgm.artifacts && bgm.artifacts.seriesBible)) : null
      const themeAsset = bgm ? normalizeTextAsset(bgm.themeMap || (bgm.artifacts && bgm.artifacts.themeMap)) : null
      const showAssetViewer = Boolean(assetState)

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'lb-section-head' },
          h('h3', { className: 'lb-section-title' }, t('bgm.title')),
          h('div', { className: 'lb-section-actions' }, h(Badge, { kind: connKind }, t(connKey))),
        ),
        h('p', { className: 'lb-hint', style: { marginTop: '0' } }, t('bgm.subtitle')),
        !refineReady ? h('p', { className: 'lb-form-error' }, t('bgm.needsRefine')) : null,
        h(
          'div',
          { className: 'lb-inline-form' },
          h('span', { className: 'lb-inline-label' }, t('bgm.startSample')),
          h('input', {
            className: 'lb-input lb-input-search',
            type: 'text',
            value: sampleInput,
            disabled: jobRunning || busy,
            placeholder: '1,2,3 / 3-5',
            'aria-label': t('bgm.startSample'),
            onChange: (event) => setSampleInput(event.target.value),
          }),
          h('span', { className: 'lb-inline-label' }, t('bgm.concurrency')),
          h('input', {
            className: 'lb-input lb-input-num',
            type: 'number',
            min: 1,
            max: 20,
            value: concurrencyInput,
            disabled: jobRunning || busy,
            'aria-label': t('bgm.concurrency'),
            onChange: (event) => setConcurrencyInput(event.target.value),
          }),
          h(Button, { variant: 'primary', disabled: !canStart, onClick: () => void startBgm(null) }, t('bgm.start')),
          refineReady
            ? h(Button, { disabled: !canStart || retryableEps.length === 0, onClick: () => void startBgm(retryableEps) }, t('bgm.retryFailed'))
            : null,
          h(Button, { onClick: () => void loadBgm(false), disabled: loading }, t('bgm.refresh')),
          jobRunning ? h(Button, { variant: 'danger', onClick: () => void cancelBgm(), disabled: busy }, t('job.cancel')) : null,
        ),
        h('p', { className: 'lb-hint' }, t('bgm.startHint')),
        actionError ? h(ErrorBlock, { message: actionError, t }) : null,
        error ? h(ErrorBlock, { message: error, onRetry: () => void loadBgm(false), t }) : null,
        loading ? h(LoadingBlock, { t, label: t('common.loading') }) : null,
        !loading
          ? h(
              'div',
              null,
              h(
                'section',
                { className: 'lb-section', style: { marginTop: '12px' } },
                h(
                  'div',
                  { className: 'lb-section-head' },
                  h('h3', { className: 'lb-section-title' }, t('bgm.jobTitle')),
                  displayJob
                    ? h(Badge, { kind: bgmStateKind(displayJob.state) }, bgmStateLabel(displayJob.state, t))
                    : h(Badge, { kind: 'idle' }, t('bgm.noJob')),
                  terminal === 'failed' ? h(Badge, { kind: 'error' }, t('bgm.terminalFailed')) : null,
                ),
                displayJob
                  ? h(
                      'div',
                      { className: 'lb-jobbar-meta' },
                      `${t('job.phase')}: ${phaseLabel(displayJob.phase, t)}${
                        activePhaseIndex >= 0 ? ` (${activePhaseIndex + 1}/${phases.length})` : ''
                      } · ${t('job.episodes')}: ${displayJob.episodes.done}/${displayJob.episodes.total} · ${t('live.attempt')}: ${numberOf(
                        maxAttempts,
                      )} · ${t('live.elapsed')}: ${formatDuration(elapsedMs)}`,
                    )
                  : h('p', { className: 'lb-hint' }, t('bgm.noJobDesc')),
                stepper,
                h(
                  'div',
                  { className: 'lb-live-toolbar' },
                  h(
                    Button,
                    {
                      variant: followLatest ? 'primary' : undefined,
                      onClick: () => {
                        const next = !followLatest
                        setFollowLatest(next)
                        followLatestRef.current = next
                        if (next && latestActive) setFollowedKey(latestActive.key)
                      },
                    },
                    t('live.followLatest'),
                  ),
                  currentStream
                    ? h(
                        'span',
                        { className: 'lb-hint', style: { marginTop: '0' } },
                        `${t('live.following')}: ${bgmRoleLabel(currentStream.role, t)} · EP${currentStream.ep} · ${
                          currentStream.completed ? t('live.completed') : t('live.streaming')
                        }`,
                      )
                    : null,
                  currentStream && currentStream.completed
                    ? h(
                        'span',
                        { className: 'lb-hint', style: { marginTop: '0' } },
                        t('live.chars', { n: numberOf(currentStream.chars || currentStream.text.length) }),
                      )
                    : null,
                  !running && historyDraft && historyDraft.ep
                    ? h('span', { className: 'lb-hint', style: { marginTop: '0' } }, `${t('bgm.historyEp')}: EP${historyDraft.ep}`)
                    : null,
                ),
                entries.length > 0
                  ? h(
                      'div',
                      { className: 'lb-live-chips' },
                      entries.map((entry) => {
                        const active = entry.key === followTarget
                        const className = active
                          ? 'lb-live-chip lb-live-chip-active'
                          : entry.completed
                            ? 'lb-live-chip lb-live-chip-done'
                            : 'lb-live-chip'
                        return h(
                          'button',
                          {
                            key: `bgm-chip-${entry.key}`,
                            type: 'button',
                            className,
                            onClick: () => {
                              setFollowLatest(false)
                              followLatestRef.current = false
                              setFollowedKey(entry.key)
                            },
                          },
                          `${bgmRoleLabel(entry.role, t)} · EP${entry.ep}`,
                          entry.attempt > 1 ? ` · ${t('live.attempt', { n: entry.attempt })}` : '',
                        )
                      }),
                    )
                  : null,
                h(
                  'div',
                  {
                    className: 'lb-live-console',
                    ref: consoleRef,
                    role: 'log',
                    'aria-live': 'off',
                    onScroll: (event) => {
                      const node = event.currentTarget
                      const distance = node.scrollHeight - node.scrollTop - node.clientHeight
                      const paused = distance > LIVE_SCROLL_THRESHOLD
                      autoScrollRef.current = !paused
                      setScrollPaused(paused)
                    },
                  },
                  showThinking ? h('span', { className: 'lb-live-thinking' }, t('live.thinking')) : null,
                  !running && historyDraft && historyDraft.loading
                    ? h('span', { className: 'lb-live-thinking' }, t('common.loading'))
                    : null,
                  consoleText
                    ? consoleText
                    : !running && historyDraft && historyDraft.text
                      ? historyDraft.text
                      : showThinking || (!running && historyDraft && historyDraft.loading)
                        ? null
                        : h('span', { className: 'lb-live-thinking' }, t('live.waiting')),
                ),
                scrollPaused
                  ? h(
                      'div',
                      { className: 'lb-live-toolbar' },
                      h('span', { className: 'lb-hint', style: { marginTop: '0' } }, t('live.pausedScroll')),
                      h(Button, { onClick: scrollToBottom }, t('live.scrollBottom')),
                    )
                  : null,
              ),
              confirmKind ? h(FailureBanner, { t, job, busy, onRetry: retryLast }) : null,
              budgetState ? h(BudgetBar, { t, budget: budgetState }) : null,
              h(CostCard, {
                t,
                pricing: props.pricing,
                cost: cost || (bgm ? bgm.cost : null),
                tokens: bgm ? bgm.tokens : null,
              }),
              h(
                'section',
                { className: 'lb-section', style: { marginTop: '12px' } },
                h('h3', { className: 'lb-section-title' }, t('bgm.countsTitle')),
                h(
                  'div',
                  { className: 'lb-token-grid' },
                  BGM_EP_STATES.map((key) =>
                    h(StatBox, {
                      key,
                      label: t(`bgm.epState.${key}`),
                      value: numberOf(counts[key]),
                      tone: key === 'failed' && counts[key] > 0 ? 'error' : key === 'retry_wait' && counts[key] > 0 ? 'risk' : undefined,
                    }),
                  ),
                  h(StatBox, { label: t('refine.counts.total'), value: numberOf(counts.total) }),
                ),
                h(
                  'div',
                  { className: 'lb-token-grid' },
                  h(StatBox, { label: t('refine.tokenInput'), value: numberOf(tokens.input) }),
                  h(StatBox, { label: t('refine.tokenOutput'), value: numberOf(tokens.output) }),
                  h(StatBox, { label: t('refine.tokenCacheRead'), value: numberOf(tokens.cacheRead) }),
                  h(StatBox, { label: t('refine.tokenTotal'), value: numberOf(tokens.total) }),
                  h(StatBox, { label: t('refine.costTotal'), value: formatYuan(displayCost.total) }),
                  h(StatBox, { label: t('live.elapsed'), value: formatDuration(elapsedMs) }),
                ),
              ),
              h(
                'section',
                { className: 'lb-section', style: { marginTop: '12px' } },
                h(
                  'div',
                  { className: 'lb-section-head' },
                  h('h3', { className: 'lb-section-title' }, t('bgm.episodesTitle')),
                  retryableEps.length > 0
                    ? h(Button, { disabled: !canStart, onClick: () => void startBgm(retryableEps) }, t('bgm.retryFailed'))
                    : null,
                ),
                episodes.length === 0
                  ? h(EmptyState, { title: t('bgm.noEpisodes'), desc: t('bgm.noEpisodesDesc'), t })
                  : h(
                      'div',
                      { className: 'lb-table-wrap' },
                      h(
                        'table',
                        { className: 'lb-table' },
                        h(
                          'thead',
                          null,
                          h(
                            'tr',
                            null,
                            h('th', null, t('refine.colEp')),
                            h('th', null, t('bgm.colTitle')),
                            h('th', null, t('bgm.colState')),
                            h('th', null, t('bgm.colAttempts')),
                            h('th', null, t('bgm.colCheck')),
                            h('th', null, t('bgm.colQc')),
                            h('th', null, t('bgm.colTokens')),
                            h('th', null, t('bgm.colCost')),
                            h('th', null, t('bgm.colArtifacts')),
                            h('th', null, t('bgm.colActions')),
                          ),
                        ),
                        h(
                          'tbody',
                          null,
                          episodes.map((entry) => {
                            const checkFails = entry.check ? entry.check.fails : []
                            const checkWarns = entry.check ? entry.check.warns : []
                            const checkText = [].concat(checkFails, checkWarns).filter(Boolean).join(' | ')
                            const qcVerdict = entry.qc ? asString(entry.qc.verdict, '') : ''
                            const artifactLinks = []
                            if (entry.artifacts.bgm) artifactLinks.push({ label: t('bgm.epArtifact.bgm'), path: entry.artifacts.bgm })
                            if (entry.artifacts.report) artifactLinks.push({ label: t('bgm.epArtifact.report'), path: entry.artifacts.report })
                            if (entry.artifacts.check) artifactLinks.push({ label: t('bgm.epArtifact.check'), path: entry.artifacts.check })
                            return h(
                              'tr',
                              { key: entry.ep },
                              h('td', { className: 'lb-table-ep' }, `EP${entry.ep}`),
                              h('td', { className: 'lb-table-title', title: entry.title }, entry.title || '—'),
                              h('td', null, h(Badge, { kind: bgmEpisodeStateKind(entry.state) }, bgmEpisodeStateLabel(entry.state, t))),
                              h('td', { className: 'lb-table-num' }, numberOf(entry.attempts)),
                              h('td', { className: 'lb-table-title', title: checkText }, checkText || '—'),
                              h('td', null, qcVerdict || '—'),
                              h('td', { className: 'lb-table-num' }, entry.tokens.total > 0 ? numberOf(entry.tokens.total) : '—'),
                              h('td', { className: 'lb-table-num' }, entry.cost && entry.cost.total > 0 ? formatYuan(entry.cost.total) : '—'),
                              h(
                                'td',
                                null,
                                artifactLinks.length > 0
                                  ? h(
                                      'div',
                                      { className: 'lb-table-actions' },
                                      artifactLinks.map((link) =>
                                        h(
                                          'a',
                                          {
                                            key: link.path,
                                            className: 'lb-link-btn',
                                            href: api.fileUrl(props.projectId, link.path),
                                            download: true,
                                          },
                                          link.label,
                                        ),
                                      ),
                                    )
                                  : '—',
                              ),
                              h(
                                'td',
                                null,
                                h(
                                  'div',
                                  { className: 'lb-table-actions' },
                                  h(Button, { onClick: () => void openDraft(entry.ep) }, t('bgm.viewDraft')),
                                  h(Button, { disabled: !canStart, onClick: () => void startBgm([entry.ep]) }, t('bgm.retryEpisode')),
                                ),
                              ),
                            )
                          }),
                        ),
                      ),
                    ),
              ),
              draftState
                ? h(
                    'div',
                    { className: 'lb-draft' },
                    h(
                      'div',
                      { className: 'lb-draft-head' },
                      h('strong', null, `${t('bgm.draftTitle')} · EP${draftState.ep}`),
                      h(Button, { onClick: () => setDraftState(null) }, t('bgm.closeDraft')),
                    ),
                    draftState.loading ? h(LoadingBlock, { t, label: t('common.loading') }) : null,
                    draftState.error ? h(ErrorBlock, { message: draftState.error, t }) : null,
                    !draftState.loading && !draftState.error
                      ? h(
                          React.Fragment,
                          null,
                          draftState.markdown
                            ? h('pre', { className: 'lb-pre' }, draftState.markdown)
                            : h('p', { className: 'lb-hint' }, t('bgm.draftEmpty')),
                          draftState.check
                            ? h(React.Fragment, null, h('h3', { className: 'lb-report-heading' }, t('bgm.draftCheck')), h(PrettyJson, { value: draftState.check }))
                            : null,
                          draftState.qc
                            ? h(React.Fragment, null, h('h3', { className: 'lb-report-heading' }, t('bgm.draftQc')), h(PrettyJson, { value: draftState.qc }))
                            : null,
                          draftState.report
                            ? h(React.Fragment, null, h('h3', { className: 'lb-report-heading' }, t('bgm.draftReport')), h(PrettyJson, { value: draftState.report }))
                            : null,
                        )
                      : null,
                  )
                : null,
              h(
                'section',
                { className: 'lb-section', style: { marginTop: '12px' } },
                h('h3', { className: 'lb-section-title' }, t('bgm.artifactsTitle')),
                links.length > 0
                  ? h(
                      'div',
                      { className: 'lb-artifact-list' },
                      links.map((link) =>
                        h(
                          'a',
                          {
                            key: link.path,
                            className: 'lb-link-btn',
                            href: api.fileUrl(props.projectId, link.path),
                            download: true,
                          },
                          `${link.label} · ${t('refine.download')}`,
                        ),
                      ),
                    )
                  : h('p', { className: 'lb-hint' }, t('bgm.artifactMissing')),
                seriesAsset || themeAsset
                  ? h(
                      'div',
                      { className: 'lb-actions', style: { marginLeft: '0' } },
                      seriesAsset ? h(Button, { onClick: () => void openAsset('seriesBible') }, t('bgm.viewSeriesBible')) : null,
                      themeAsset ? h(Button, { onClick: () => void openAsset('themeMap') }, t('bgm.viewThemeMap')) : null,
                    )
                  : null,
                showAssetViewer
                  ? h(
                      'div',
                      { className: 'lb-draft' },
                      h(
                        'div',
                        { className: 'lb-draft-head' },
                        h(
                          'strong',
                          null,
                          assetState.kind === 'seriesBible' ? t('bgm.seriesBible') : t('bgm.themeMap'),
                        ),
                        h(Button, { onClick: () => setAssetState(null) }, t('bgm.closeDraft')),
                      ),
                      assetState.loading ? h(LoadingBlock, { t, label: t('common.loading') }) : null,
                      assetState.error ? h(ErrorBlock, { message: assetState.error, t }) : null,
                      !assetState.loading && !assetState.error
                        ? assetState.text
                          ? h('pre', { className: 'lb-pre' }, assetState.text)
                          : h('p', { className: 'lb-hint' }, t('bgm.assetEmpty'))
                        : null,
                    )
                  : null,
              ),
            )
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // Project options editor
    // -----------------------------------------------------------------------
    function OptionsEditorView(props) {
      const t = props.t
      const [snapshot, setSnapshot] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [saving, setSaving] = useState(false)
      const [saveError, setSaveError] = useState(null)
      const [saved, setSaved] = useState(false)
      const [requiresRerun, setRequiresRerun] = useState(false)
      const [form, setForm] = useState({
        minWords: '100',
        maxWords: '350',
        forbidCn: true,
        allowedTermsText: '',
        maxAtomRun: '',
        maxAtomsPerSpoken: '',
        maxSpokenRun: '',
      })

      const applyOptions = useCallback((raw) => {
        const options = normalizeOptions(raw)
        const pacing = options.check_overrides.pacing
        setForm({
          minWords: String(options.min_words),
          maxWords: String(options.max_words),
          forbidCn: Boolean(options.forbid_cn_elements),
          allowedTermsText: options.allowed_terms.join('\n'),
          maxAtomRun: pacing.max_atom_run === null ? '' : String(pacing.max_atom_run),
          maxAtomsPerSpoken: pacing.max_atoms_per_spoken === null ? '' : String(pacing.max_atoms_per_spoken),
          maxSpokenRun: pacing.max_spoken_run === null ? '' : String(pacing.max_spoken_run),
        })
      }, [])

      const load = useCallback(
        async (silent) => {
          if (!silent) setLoading(true)
          setError(null)
          try {
            const response = await api.project(props.id)
            if (response.ok && isObject(response.data) && response.data.ok) {
              const next = normalizeSnapshot(response.data.snapshot)
              setSnapshot(next)
              applyOptions(next.options)
            } else {
              setError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
            }
          } catch (err) {
            setError(describeError(errorInfoFromException(err, ''), t))
          } finally {
            if (!silent) setLoading(false)
          }
        },
        [props.id, applyOptions, t],
      )

      useEffect(() => {
        setSaved(false)
        setRequiresRerun(false)
        setSaveError(null)
        void load()
      }, [load])

      const startRerun = useCallback(async () => {
        try {
          const response = await api.action(props.id, 'rerun-preflight')
          if (response.ok && isObject(response.data) && response.data.ok) {
            const job = normalizeJob(response.data.job)
            if (job && job.id) {
              props.onJobStarted({ job, projectId: props.id, origin: 'rerun' })
              return
            }
            if (typeof props.notify === 'function') props.notify({ kind: 'success', message: t('toast.actionDone') })
            void load(true)
          } else {
            setSaveError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
          }
        } catch (err) {
          setSaveError(describeError(errorInfoFromException(err, ''), t))
        }
      }, [props, t, load])

      const save = useCallback(
        async (rerunAfter) => {
          if (saving) return
          const minRaw = asString(form.minWords).trim()
          const maxRaw = asString(form.maxWords).trim()
          if (!minRaw || !maxRaw) {
            setSaveError(t('options.invalidNumber'))
            return
          }
          const minWords = asNumber(minRaw, NaN)
          const maxWords = asNumber(maxRaw, NaN)
          if (!Number.isFinite(minWords) || !Number.isFinite(maxWords)) {
            setSaveError(t('options.invalidNumber'))
            return
          }
          if (minWords >= maxWords) {
            setSaveError(t('options.minMax'))
            return
          }
          const pacing = {}
          const pacingMap = { maxAtomRun: 'max_atom_run', maxAtomsPerSpoken: 'max_atoms_per_spoken', maxSpokenRun: 'max_spoken_run' }
          const pacingKeys = Object.keys(pacingMap)
          for (let index = 0; index < pacingKeys.length; index += 1) {
            const formKey = pacingKeys[index]
            const raw = asString(form[formKey]).trim()
            if (!raw) continue
            const value = asNumber(raw, NaN)
            if (!Number.isFinite(value)) {
              setSaveError(t('options.invalidNumber'))
              return
            }
            pacing[pacingMap[formKey]] = value
          }
          const options = {
            min_words: minWords,
            max_words: maxWords,
            forbid_cn_elements: Boolean(form.forbidCn),
            allowed_terms: asString(form.allowedTermsText)
              .split(/[\n,，]+/)
              .map((entry) => entry.trim())
              .filter(Boolean),
            check_overrides: { pacing },
          }
          setSaving(true)
          setSaveError(null)
          try {
            const response = await api.updateOptions(props.id, options)
            if (response.ok && isObject(response.data) && response.data.ok) {
              setSaved(true)
              setRequiresRerun(response.data.requiresRerun !== false)
              if (isObject(response.data.options)) applyOptions(response.data.options)
              if (rerunAfter) await startRerun()
              else if (typeof props.notify === 'function') props.notify({ kind: 'success', message: t('options.saved') })
            } else {
              setSaveError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
            }
          } catch (err) {
            setSaveError(describeError(errorInfoFromException(err, ''), t))
          } finally {
            setSaving(false)
          }
        },
        [saving, form, props, t, applyOptions, startRerun],
      )

      const updateField = (key, value) => setForm((previous) => Object.assign({}, previous, { [key]: value }))
      const engineInfo = snapshot && snapshot.engine ? snapshot.engine : null

      return h(
        'div',
        null,
        h(
          'header',
          { className: 'lb-header' },
          h('div', { className: 'lb-header-icon' }, h(Icon, { size: 24 })),
          h(
            'div',
            { className: 'lb-header-text' },
            h('h1', { className: 'lb-title' }, t('options.title')),
            h('p', { className: 'lb-subtitle' }, t('options.subtitle')),
          ),
          h('div', { className: 'lb-actions' }, h(Button, { onClick: props.onBack }, t('options.back'))),
        ),
        error ? h(ErrorBlock, { message: error, onRetry: () => void load(), t }) : null,
        loading ? h(LoadingBlock, { t, label: t('common.loading') }) : null,
        !loading
          ? h(
              Section,
              { title: t('options.general') },
              h(
                'div',
                { className: 'lb-form' },
                h(
                  'div',
                  { className: 'lb-form-row' },
                  h('label', { className: 'lb-form-label', htmlFor: 'lb-opt-min' }, t('options.minWords')),
                  h('input', {
                    id: 'lb-opt-min',
                    className: 'lb-input lb-input-number',
                    type: 'number',
                    min: 0,
                    value: form.minWords,
                    onChange: (event) => updateField('minWords', event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'lb-form-row' },
                  h('label', { className: 'lb-form-label', htmlFor: 'lb-opt-max' }, t('options.maxWords')),
                  h('input', {
                    id: 'lb-opt-max',
                    className: 'lb-input lb-input-number',
                    type: 'number',
                    min: 0,
                    value: form.maxWords,
                    onChange: (event) => updateField('maxWords', event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'lb-form-row' },
                  h('span', { className: 'lb-form-label' }, t('options.forbidCn')),
                  h(
                    'label',
                    { className: 'lb-check-row' },
                    h('input', {
                      type: 'checkbox',
                      checked: Boolean(form.forbidCn),
                      'aria-label': t('options.forbidCn'),
                      onChange: (event) => updateField('forbidCn', event.target.checked),
                    }),
                    form.forbidCn ? t('common.yes') : t('common.no'),
                  ),
                ),
                h(
                  'div',
                  { className: 'lb-form-row' },
                  h('label', { className: 'lb-form-label', htmlFor: 'lb-opt-terms' }, t('options.allowedTerms')),
                  h('textarea', {
                    id: 'lb-opt-terms',
                    className: 'lb-input lb-input-wide',
                    value: form.allowedTermsText,
                    onChange: (event) => updateField('allowedTermsText', event.target.value),
                  }),
                ),
                h('div', { className: 'lb-subheader-title' }, t('options.pacing')),
                h(
                  'div',
                  { className: 'lb-form-row' },
                  h('label', { className: 'lb-form-label', htmlFor: 'lb-opt-atom-run' }, t('options.maxAtomRun')),
                  h('input', {
                    id: 'lb-opt-atom-run',
                    className: 'lb-input lb-input-number',
                    type: 'number',
                    min: 0,
                    value: form.maxAtomRun,
                    onChange: (event) => updateField('maxAtomRun', event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'lb-form-row' },
                  h('label', { className: 'lb-form-label', htmlFor: 'lb-opt-atom-ratio' }, t('options.maxAtomsPerSpoken')),
                  h('input', {
                    id: 'lb-opt-atom-ratio',
                    className: 'lb-input lb-input-number',
                    type: 'number',
                    min: 0,
                    step: '0.1',
                    value: form.maxAtomsPerSpoken,
                    onChange: (event) => updateField('maxAtomsPerSpoken', event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'lb-form-row' },
                  h('label', { className: 'lb-form-label', htmlFor: 'lb-opt-spoken-run' }, t('options.maxSpokenRun')),
                  h('input', {
                    id: 'lb-opt-spoken-run',
                    className: 'lb-input lb-input-number',
                    type: 'number',
                    min: 0,
                    value: form.maxSpokenRun,
                    onChange: (event) => updateField('maxSpokenRun', event.target.value),
                  }),
                ),
              ),
              saveError ? h('p', { className: 'lb-form-error' }, saveError) : null,
              saved
                ? h(
                    'p',
                    { className: 'lb-hint' },
                    requiresRerun ? t('options.requiresRerun') : t('options.saved'),
                  )
                : null,
              h(
                'div',
                { className: 'lb-form-actions' },
                h(Button, { variant: 'primary', onClick: () => void save(false), disabled: saving }, saving ? t('options.saving') : t('options.save')),
                h(Button, { onClick: () => void save(true), disabled: saving }, t('options.rerunNow')),
                h(Button, { onClick: () => void load(), disabled: saving }, t('options.reset')),
              ),
              h('p', { className: 'lb-hint' }, t('options.readonlyHint')),
              engineInfo
                ? h(
                    'div',
                    { className: 'lb-kv' },
                    h('span', { className: 'lb-kv-key' }, t('options.engine')),
                    h('span', { className: 'lb-kv-value' }, engineInfo.version || '—'),
                    h('span', { className: 'lb-kv-key' }, t('options.profileSource')),
                    h('span', { className: 'lb-kv-value' }, engineInfo.checkProfileSource || '—'),
                    h('span', { className: 'lb-kv-key' }, t('options.effectiveProfile')),
                    h('span', { className: 'lb-kv-value' }, h(PrettyJson, { value: engineInfo.effectiveCheckProfile })),
                  )
                : null,
            )
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // Settings / diagnostics
    // -----------------------------------------------------------------------
    function SettingsView(props) {
      const t = props.t
      const health = props.health || {}
      const python = isObject(health.python) ? health.python : {}
      const engine = isObject(health.engine) ? health.engine : {}
      return h(
        'div',
        null,
        h(
          'header',
          { className: 'lb-header' },
          h('div', { className: 'lb-header-icon' }, h(Icon, { size: 24 })),
          h(
            'div',
            { className: 'lb-header-text' },
            h('h1', { className: 'lb-title' }, t('settings.title')),
            h('p', { className: 'lb-subtitle' }, t('settings.subtitle')),
          ),
          h('div', { className: 'lb-actions' }, h(Button, { onClick: props.onBack }, t('settings.back'))),
        ),
        props.healthError ? h(ErrorBlock, { message: props.healthError, onRetry: props.onRefreshHealth, t }) : null,
        h(
          Section,
          { title: t('settings.title') },
          h(
            'div',
            { className: 'lb-kv' },
            h('span', { className: 'lb-kv-key' }, t('settings.projectsRoot')),
            h('span', { className: 'lb-kv-value lb-mono' }, asString(health.projectsRoot, '—')),
            h('span', { className: 'lb-kv-key' }, t('settings.workspace')),
            h('span', { className: 'lb-kv-value lb-mono' }, asString(health.workspace, '—')),
            h('span', { className: 'lb-kv-key' }, t('settings.bundle')),
            h('span', { className: 'lb-kv-value' }, `${asString(health.bundle, '—')} ${asString(health.version, '')}`.trim() || '—'),
            h('span', { className: 'lb-kv-key' }, t('settings.python')),
            h(
              'span',
              { className: 'lb-kv-value' },
              python.ok
                ? `${t('settings.available')} · ${asString(python.python, '')}`
                : `${t('settings.unavailable')}${python.error ? ` · ${asString(python.error)}` : ''}`,
            ),
            h('span', { className: 'lb-kv-key' }, t('settings.engine')),
            h(
              'span',
              { className: 'lb-kv-value' },
              engine.available
                ? `${t('settings.available')} · ${asString(engine.version, '')}`
                : `${t('settings.unavailable')}${engine.error ? ` · ${asString(engine.error)}` : ''}`,
            ),
          ),
          h('p', { className: 'lb-hint' }, t('settings.readonlyNote')),
        ),
      )
    }

    function PrettyJson(props) {
      let text
      try {
        text = JSON.stringify(props.value, null, 2)
      } catch {
        text = String(props.value)
      }
      if (!text) return null
      return h('pre', { className: 'lb-pre' }, truncate(text, 24000))
    }

    function DiagnosticsView(props) {
      const t = props.t
      const [selfcheck, setSelfcheck] = useState(null)
      const [selfcheckLoading, setSelfcheckLoading] = useState(false)
      const [selfcheckError, setSelfcheckError] = useState(null)

      const loadSelfcheck = useCallback(async () => {
        setSelfcheckLoading(true)
        setSelfcheckError(null)
        try {
          const response = await api.selfcheck()
          if (response.ok && isObject(response.data)) {
            setSelfcheck(response.data)
          } else {
            setSelfcheckError(t('diag.failed', { reason: describeError(errorInfoFromResponse(response, ''), t) }))
          }
        } catch (err) {
          setSelfcheckError(t('diag.failed', { reason: describeError(errorInfoFromException(err, ''), t) }))
        } finally {
          setSelfcheckLoading(false)
        }
      }, [t])

      const runSelfcheck = useCallback(async () => {
        setSelfcheckLoading(true)
        setSelfcheckError(null)
        try {
          const response = await api.runSelfcheck()
          if (response.ok && isObject(response.data)) {
            setSelfcheck(response.data)
          } else {
            setSelfcheckError(t('diag.failed', { reason: describeError(errorInfoFromResponse(response, ''), t) }))
          }
        } catch (err) {
          setSelfcheckError(t('diag.failed', { reason: describeError(errorInfoFromException(err, ''), t) }))
        } finally {
          setSelfcheckLoading(false)
        }
      }, [t])

      useEffect(() => {
        void loadSelfcheck()
      }, [loadSelfcheck])

      const health = props.health
      return h(
        'div',
        null,
        h(
          'header',
          { className: 'lb-header' },
          h('div', { className: 'lb-header-icon' }, h(Icon, { size: 24 })),
          h(
            'div',
            { className: 'lb-header-text' },
            h('h1', { className: 'lb-title' }, t('diag.title')),
            h('p', { className: 'lb-subtitle' }, t('diag.subtitle')),
          ),
          h(
            'div',
            { className: 'lb-actions' },
            h(Button, { onClick: props.onRefreshHealth, disabled: props.healthLoading }, t('diag.loadHealth')),
            h(Button, { onClick: () => void loadSelfcheck(), disabled: selfcheckLoading }, t('diag.loadSelfcheck')),
            h(Button, { variant: 'primary', onClick: () => void runSelfcheck(), disabled: selfcheckLoading }, t('diag.runSelfcheck')),
            h(Button, { onClick: props.onBack }, t('diag.back')),
          ),
        ),
        props.healthError ? h(ErrorBlock, { message: props.healthError, onRetry: props.onRefreshHealth, t }) : null,
        h(
          Section,
          { title: t('diag.health') },
          props.healthLoading && !health
            ? h(LoadingBlock, { t, label: t('diag.loading') })
            : health
              ? h(PrettyJson, { value: health })
              : h(EmptyState, { title: t('common.empty'), t }),
        ),
        h(
          Section,
          { title: t('diag.selfcheck'), actions: [
            h(Button, { key: 'read', onClick: () => void loadSelfcheck(), disabled: selfcheckLoading }, t('diag.loadSelfcheck')),
            h(Button, { key: 'run', variant: 'primary', onClick: () => void runSelfcheck(), disabled: selfcheckLoading }, t('diag.runSelfcheck')),
          ] },
          h('p', { className: 'lb-hint' }, t('diag.selfcheckHint')),
          selfcheckLoading ? h(LoadingBlock, { t, label: t('diag.loading') }) : null,
          selfcheckError ? h(ErrorBlock, { message: selfcheckError, onRetry: () => void runSelfcheck(), t }) : null,
          selfcheck ? h(PrettyJson, { value: selfcheck }) : null,
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Error boundary (never white-screen on render errors)
    // -----------------------------------------------------------------------
    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        try {
          console.error('[lianben-workbench] render error:', error)
        } catch {
          // ignore
        }
        reportClientError('render-error', error)
      }

      render() {
        if (!this.state.error) return this.props.children
        const t = this.props.t
        return h(
          'div',
          { className: 'lb-root' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'lb-empty' },
            h('div', { className: 'lb-empty-title' }, t('boundary.title')),
            h('div', { className: 'lb-empty-desc' }, t('boundary.desc')),
            h(
              'div',
              { className: 'lb-empty-action' },
              h(
                Button,
                {
                  variant: 'primary',
                  onClick: () => {
                    try {
                      window.location.reload()
                    } catch {
                      // ignore
                    }
                  },
                },
                t('boundary.reload'),
              ),
            ),
            h('pre', { className: 'lb-pre' }, String((this.state.error && this.state.error.message) || this.state.error)),
          ),
        )
      }
    }

    // -----------------------------------------------------------------------
    // Root application
    // -----------------------------------------------------------------------
    function WorkbenchApp(props) {
      const t = props.t
      const [view, setView] = useState({ name: 'library' })
      const [projects, setProjects] = useState([])
      const [projectsLoading, setProjectsLoading] = useState(true)
      const [projectsError, setProjectsError] = useState(null)
      const [projectsQuery, setProjectsQuery] = useState('')
      const [projectsSort, setProjectsSort] = useState('updated')
      const [health, setHealth] = useState(null)
      const [healthLoading, setHealthLoading] = useState(false)
      const [healthError, setHealthError] = useState(null)
      const [pricing, setPricing] = useState(null)
      const [appMode, setAppMode] = useState(MODE_1)
      const [modes, setModes] = useState(DEFAULT_MODES)
      const [modeLoading, setModeLoading] = useState(false)
      const [toast, setToast] = useState(null)
      const toastTimer = useRef(null)
      const searchTimer = useRef(null)

      const notify = useCallback((value) => {
        if (!value) return
        setToast(value)
        if (toastTimer.current) {
          clearTimeout(toastTimer.current)
          toastTimer.current = null
        }
        toastTimer.current = setTimeout(() => {
          setToast(null)
          toastTimer.current = null
        }, 3200)
      }, [])

      useEffect(
        () => () => {
          if (toastTimer.current) clearTimeout(toastTimer.current)
          if (searchTimer.current) clearTimeout(searchTimer.current)
        },
        [],
      )

      const loadProjects = useCallback(
        async (silent, params) => {
          if (!silent) {
            setProjectsLoading(true)
            setProjectsError(null)
          }
          try {
            const query = params && params.query !== undefined ? params.query : undefined
            const sort = params && params.sort !== undefined ? params.sort : undefined
            const response = await api.projects({ query, sort })
            if (response.ok && isObject(response.data) && response.data.ok) {
              setProjects(asArray(response.data.projects).map(normalizeCard))
              setProjectsError(null)
            } else {
              setProjectsError(describeError(errorInfoFromResponse(response, t('error.generic', { reason: t('common.unknown') })), t))
            }
          } catch (error) {
            setProjectsError(describeError(errorInfoFromException(error, ''), t))
          } finally {
            setProjectsLoading(false)
          }
        },
        [t],
      )

      const loadHealth = useCallback(async () => {
        setHealthLoading(true)
        setHealthError(null)
        try {
          const response = await api.health()
          if (response.ok && isObject(response.data) && response.data.ok) {
            setHealth(response.data)
            setHealthError(null)
          } else {
            setHealthError(describeError(errorInfoFromResponse(response, t('diag.failed', { reason: t('common.unknown') })), t))
          }
        } catch (error) {
          setHealthError(describeError(errorInfoFromException(error, ''), t))
        } finally {
          setHealthLoading(false)
        }
      }, [t])

      const loadPricing = useCallback(async () => {
        try {
          const response = await api.pricing()
          if (response.ok && isObject(response.data) && response.data.ok) {
            setPricing(normalizePricing(response.data.pricing))
          }
        } catch {
          // pricing is best effort; the client falls back to the built-in table
        }
      }, [])

      const loadMode = useCallback(async () => {
        try {
          const response = await api.mode()
          if (response.ok && isObject(response.data) && response.data.ok) {
            if (response.data.mode) setAppMode(normalizeModeId(response.data.mode))
            if (Array.isArray(response.data.modes) && response.data.modes.length > 0) {
              setModes(
                response.data.modes.map((entry) => {
                  const item = isObject(entry) ? entry : {}
                  const id = normalizeModeId(item.id)
                  return {
                    id,
                    label: asString(item.label, modeLabel(id, t)),
                    description: asString(item.description, ''),
                  }
                }),
              )
            }
          }
        } catch {
          // mode discovery is best effort; 1.0 remains the default
        }
      }, [t])

      useEffect(() => {
        void loadProjects(false, { query: '', sort: 'updated' })
        void loadHealth()
        void loadPricing()
        void loadMode()
      }, [loadProjects, loadHealth, loadPricing, loadMode])

      const openLibrary = useCallback(
        (refreshed) => {
          setView({ name: 'library' })
          void loadProjects(Boolean(refreshed), { query: projectsQuery, sort: projectsSort })
        },
        [loadProjects, projectsQuery, projectsSort],
      )

      const openProject = useCallback((id) => {
        if (!id) return
        setView({ name: 'project', id })
      }, [])

      const onImported = useCallback(
        (result) => {
          notify({ kind: 'success', message: t('toast.imported', { title: result.title || result.id }) })
          void loadProjects(true, { query: projectsQuery, sort: projectsSort })
          if (result.id) setView({ name: 'project', id: result.id, tab: 'preflight' })
          else setView({ name: 'library' })
        },
        [loadProjects, notify, projectsQuery, projectsSort, t],
      )

      const onMigrated = useCallback(
        (project) => {
          const title = project && project.title ? project.title : project && project.id ? project.id : ''
          notify({ kind: 'success', message: t('migrate.success', { title }) })
          void loadProjects(true, { query: projectsQuery, sort: projectsSort })
        },
        [loadProjects, notify, projectsQuery, projectsSort, t],
      )

      const onJobStarted = useCallback((payload) => {
        if (!payload || !payload.job) return
        const projectId = payload.projectId || payload.job.projectId || ''
        if (
          (payload.origin === 'refine' ||
            payload.job.kind === 'refine' ||
            payload.job.kind === 'refine2' ||
            payload.job.kind === 'storyboard') &&
          projectId
        ) {
          setView({ name: 'project', id: projectId, tab: 'refine', jobId: payload.job.id })
          return
        }
        setView({
          name: 'progress',
          jobId: payload.job.id,
          projectId,
          title: payload.title || '',
          origin: payload.origin || 'rerun',
          jobKind: payload.job.kind || '',
          initialJob: payload.job.raw || payload.job,
        })
      }, [])

      const onSearchChange = useCallback(
        (value) => {
          setProjectsQuery(value)
          if (searchTimer.current) clearTimeout(searchTimer.current)
          searchTimer.current = setTimeout(() => {
            void loadProjects(true, { query: value, sort: projectsSort })
          }, 350)
        },
        [loadProjects, projectsSort],
      )

      const onSortChange = useCallback(
        (value) => {
          setProjectsSort(value)
          void loadProjects(true, { query: projectsQuery, sort: value })
        },
        [loadProjects, projectsQuery],
      )

      const onModeChange = useCallback(
        async (mode) => {
          const next = normalizeModeId(mode)
          if (next === normalizeModeId(appMode) || modeLoading) return
          setModeLoading(true)
          try {
            const response = await api.setMode(next)
            if (response.ok && isObject(response.data) && response.data.ok) {
              setAppMode(next)
              notify({ kind: 'success', message: t('mode.switched', { mode: modeLabel(next, t) }) })
              void loadProjects(true, { query: projectsQuery, sort: projectsSort })
            } else {
              notify({
                kind: 'error',
                message: describeError(errorInfoFromResponse(response, t('mode.switchFailed', { reason: t('common.unknown') })), t),
              })
            }
          } catch (err) {
            notify({
              kind: 'error',
              message: describeError(errorInfoFromException(err, ''), t),
            })
          } finally {
            setModeLoading(false)
          }
        },
        [appMode, loadProjects, modeLoading, notify, projectsQuery, projectsSort, t],
      )

      let content = null
      if (view.name === 'library') {
        content = h(LibraryView, {
          t,
          projects,
          loading: projectsLoading,
          error: projectsError,
          search: projectsQuery,
          sort: projectsSort,
          mode: appMode,
          modes,
          modeLoading,
          onModeChange,
          onSearchChange,
          onSortChange,
          onRefresh: () => void loadProjects(false, { query: projectsQuery, sort: projectsSort }),
          onMigrated,
          onImport: () => setView({ name: 'import' }),
          onOpen: openProject,
          onSettings: () => setView({ name: 'settings' }),
          onDiagnostics: () => setView({ name: 'diagnostics' }),
        })
      } else if (view.name === 'import') {
        content = h(ImportView, {
          t,
          mode: appMode,
          onBack: () => openLibrary(true),
          onImported,
          onJobStarted,
        })
      } else if (view.name === 'progress') {
        content = h(ProgressView, {
          t,
          jobId: view.jobId,
          projectId: view.projectId,
          initialJob: view.initialJob,
          pricing,
          onDone: (projectId) => {
            if (projectId)
              setView({
                name: 'project',
                id: projectId,
                tab: view.jobKind === 'refine' || view.jobKind === 'refine2' || view.jobKind === 'storyboard' ? 'refine' : 'preflight',
              })
            else openLibrary(true)
            void loadProjects(true, { query: projectsQuery, sort: projectsSort })
          },
          onBack: () => {
            if (view.origin === 'import') openLibrary(true)
            else if (view.projectId) {
              setView({
                name: 'project',
                id: view.projectId,
                tab:
                  view.jobKind === 'refine' || view.jobKind === 'refine2' || view.jobKind === 'storyboard' || view.origin === 'refine'
                    ? 'refine'
                    : 'preflight',
              })
            } else openLibrary(true)
          },
          onReimport: () => setView({ name: 'import' }),
        })
      } else if (view.name === 'project') {
        content = h(ProjectView, {
          t,
          id: view.id,
          initialTab: view.tab,
          initialJobId: view.jobId,
          mode: appMode,
          pricing,
          onPricingRefresh: () => void loadPricing(),
          notify,
          onBack: openLibrary,
          onJobStarted,
          onOptions: (id) => setView({ name: 'options', id }),
          onViewJob: (job) =>
            job && (job.kind === 'refine' || job.kind === 'refine2' || job.kind === 'storyboard')
              ? setView({ name: 'project', id: view.id, tab: 'refine', jobId: job.id })
              : job && job.kind === 'bgm'
                ? setView({ name: 'project', id: view.id, tab: 'bgm', jobId: job.id })
                : setView({
                  name: 'progress',
                  jobId: job.id,
                  projectId: job.projectId || view.id,
                  origin: 'rerun',
                  jobKind: job.kind || '',
                  initialJob: job.raw || job,
                }),
        })
      } else if (view.name === 'options') {
        content = h(OptionsEditorView, {
          t,
          id: view.id,
          notify,
          onBack: () => setView({ name: 'project', id: view.id }),
          onJobStarted,
        })
      } else if (view.name === 'settings') {
        content = h(SettingsView, {
          t,
          health,
          healthError,
          onRefreshHealth: () => void loadHealth(),
          onBack: () => openLibrary(false),
        })
      } else if (view.name === 'diagnostics') {
        content = h(DiagnosticsView, {
          t,
          health,
          healthLoading,
          healthError,
          onRefreshHealth: () => void loadHealth(),
          onBack: () => openLibrary(false),
        })
      }

      return h(
        'div',
        { className: 'lb-root' },
        h('style', null, CSS),
        content,
        h(Toast, { toast }),
      )
    }

    // -----------------------------------------------------------------------
    // Plugin apply()
    // -----------------------------------------------------------------------
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const registerDictionary = (localeId, dictionary) => {
          try {
            return ctx.locale.register('lianben', localeId, dictionary)
          } catch (error) {
            console.error('[lianben-workbench] locale registration failed:', error)
            return null
          }
        }

        try {
          ctx.effect(() => registerDictionary('zh', ZH), 'lianben-m3: zh dictionary')
        } catch (error) {
          console.error('[lianben-workbench] zh dictionary effect failed:', error)
        }
        try {
          ctx.effect(() => registerDictionary('en', EN), 'lianben-m3: en dictionary')
        } catch (error) {
          console.error('[lianben-workbench] en dictionary effect failed:', error)
        }

        let translate = null
        try {
          translate = ctx.locale.bind('lianben')
        } catch (error) {
          console.error('[lianben-workbench] locale bind failed:', error)
          translate = null
        }
        const t = createTranslate(translate, ZH)

        const Page = function LianbenWorkbenchPage() {
          return h(ErrorBoundary, { t }, h(WorkbenchApp, { t }))
        }

        try {
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 30,
                label: () => t('panel.label'),
              },
              PanelIcon,
            ),
          )
        } catch (error) {
          console.error('[lianben-workbench] sidebar.panellist registration failed:', error)
        }

        try {
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, Page),
          )
        } catch (error) {
          console.error('[lianben-workbench] main registration failed:', error)
        }

        try {
          const onWindowError = (event) => reportClientError('window-error', event.error || event.message)
          const onUnhandledRejection = (event) => reportClientError('unhandled-rejection', event.reason)
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('error', onWindowError)
            window.addEventListener('unhandledrejection', onUnhandledRejection)
            ctx.effect(
              () => () => {
                window.removeEventListener('error', onWindowError)
                window.removeEventListener('unhandledrejection', onUnhandledRejection)
              },
              'lianben-m3: client error reporters',
            )
          }
        } catch {
          // diagnostics only
        }

        // Diagnostic boot receipt (same pattern as M0): lets the Host verify the
        // page bundle actually booted without browser automation. Best effort.
        try {
          setTimeout(() => {
            try {
              void fetch(`${API}/m3/client-report`, {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  schema: 'lianben/m3/client-report/1',
                  bootAt: new Date().toISOString(),
                  href: typeof location !== 'undefined' ? location.href : null,
                  language: typeof navigator !== 'undefined' ? navigator.language : null,
                  api: API,
                  panelId: PANEL_ID,
                }),
              }).catch(() => {})
            } catch {
              // ignore: boot receipt is best effort
            }
          }, 2000)
        } catch {
          // ignore: timers unavailable
        }

        console.log('[lianben-workbench] client half active; api base =', API)
      },
    }
  },
})
