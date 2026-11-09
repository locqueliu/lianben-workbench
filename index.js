/**
 * Lianben Workbench v1.0 (Host half).
 *
 * M3 adds the refine (director) stage on top of M2's job/SSE platform:
 *  - project-local old toolchain copy (`<project>/tools`) for check_ep/merge/writeback/reports
 *  - per-episode director workers driven by ctx.llm.stream (prompt assets in ./prompts)
 *  - check_ep gate + content retries (<=2) + --allow-issue-pass degradation
 *  - blocked episodes excluded; waves with configurable concurrency (<=20)
 *  - refine job kind + SSE (phase/episode/log/token/done/error), token ledger
 *  - merge -> writeback_docx -> final_audit -> generate_summary -> generate_qc_report
 *  - project/refine, project/draft routes; `lianben_workbench` agent tool
 *
 * All routes are exact Fetch routes on the authenticated Connection bridge.
 */

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  buildDirectorPrompt,
  buildRetryInstruction,
  loadDirectorContext,
  parseDirectorOutput,
} from './prompts/director.mjs'
import { addCost, costForTokenLedger, costForUsage, emptyCost, pricingSnapshot } from './lib/pricing.mjs'
import { buildMergePlan } from './lib/merge_atoms.mjs'
import { buildMergeLlmPrompt, parseMergeLlmOutput } from './prompts/merge_llm.mjs'
import {
  buildStoryboardPlannerPrompt,
  buildStoryboardWriterPrompt,
  buildStoryboardRetryInstruction,
  parseStoryboardPlan,
  parseStoryboardMarkdown,
} from './prompts/storyboard2.mjs'
import { buildPreflightCorrectionPrompt, parseCorrectedEpisode } from './prompts/preflight2_correct.mjs'
import {
  buildBgmArchitectPrompt,
  buildBgmAuditorPrompt,
  buildBgmQcPrompt,
  buildBgmRetryInstruction,
  buildBgmWorkerPrompt,
  loadBgmContext,
  parseBgmArchitectOutput,
  parseBgmAuditorOutput,
  parseBgmQcOutput,
  parseBgmWorkerOutput,
} from './prompts/bgm.mjs'

const BUNDLE = '@local/lianben-workbench'
const VERSION = '1.0.0'
const API = '/api/lianben'
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024
const PREFLIGHT_TIMEOUT_MS = 180_000
const ENGINE_VERSION_TIMEOUT_MS = 30_000
const JOB_WAIT_TIMEOUT_MS = 180_000
const DIRECTOR_TIMEOUT_MS = 300_000
const DIRECTOR_MAX_TOKENS = 49_152
const SCRIPT_TIMEOUT_MS = 120_000
const TOOLCHAIN_REVISION = 'm4-tools-20261107'
const TOOLCHAIN2_REVISION = 't2-engine2-20261109'
const MODE_10 = 'lianben-1.0'
const MODE_20 = 'yanyi-2.0'
const MODES = [ { id: MODE_10, label: '1.0 解说剧', description: '当前稳定解说剧工作流' }, { id: MODE_20, label: '2.0 演绎剧', description: '竖屏分镜/表演调度演绎剧工作流' } ]
const PROJECT_ID_RE = /^p-[a-z0-9]+-[a-z0-9]{4,12}$/
const JOB_ID_RE = /^job-[a-z0-9]+-[a-z0-9]{4,12}$/
const DOWNLOAD_EXTENSIONS = new Set(['.md', '.docx', '.json', '.txt', '.log', '.ndjson', '.csv'])
const JOB_PHASES = ['extract', 'detect', 'split', 'normalize', 'protagonist', 'checks', 'report']
const REFINE_PHASES = ['prepare', 'write', 'check', 'retry', 'merge', 'writeback', 'audit', 'report']
const PREFLIGHT2_PHASES = ['extract', 'checks', 'ledger', 'correction', 'report']
const STORYBOARD_PHASES = ['prepare', 'plan', 'plan_check', 'write', 'check', 'retry', 'audit', 'merge', 'build', 'report']
const BGM_PHASES = ['prepare', 'architect', 'write', 'check', 'qc', 'merge', 'build', 'audit', 'report']
const BGM_ASSET_REVISION = 'm4-bgm-rules-20261107'
const BGM_ASSET_REVISION_2 = 't2-bgm-rules-20261109'
const BGM_LLM = Object.freeze({
  worker: { maxTokens: 2048, temperature: 0.5, timeoutMs: 300_000 },
  qc: { maxTokens: 1024, temperature: 0.1, timeoutMs: 180_000 },
  architect: { maxTokens: 4096, temperature: 0.4, timeoutMs: 180_000 },
  auditor: { maxTokens: 4096, temperature: 0.1, timeoutMs: 300_000 },
})
const BGM_MAX_ATTEMPTS = 3
const BGM_WORKER_SCRIPT_TIMEOUT_MS = 120_000
const REFINE_BUDGET_PER_EP = 60_000
const STORYBOARD_BUDGET_PER_EP = 120_000
const BGM_BUDGET_PER_EP = 32_000
const WORD_LOCK_RETRY_ATTEMPTS = 3
const WORD_LOCK_RETRY_MS = 30_000
const MAX_LLM_MERGE_EPS = 5
const MERGE_LLM_MAX_TOKENS = 4096
const TERMINAL_JOB_STATES = new Set(['succeeded', 'failed', 'cancelled', 'needs_confirm', 'interrupted'])

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_DIR = path.join(MODULE_DIR, 'engine')
const ENGINE2_DIR = path.join(MODULE_DIR, 'engine2')
const FIXTURES_DIR = path.join(ENGINE_DIR, 'fixtures')

export const inject = ['connection']

// ---------------------------------------------------------------------------
// Small helpers (no ctx dependency)
// ---------------------------------------------------------------------------

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function textResponse(text, status = 200, contentType = 'text/plain; charset=utf-8') {
  return new Response(text, {
    status,
    headers: { 'content-type': contentType, 'cache-control': 'no-store' },
  })
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || 'script.docx')).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
  const trimmed = base.slice(-160)
  return trimmed.length > 0 ? trimmed : 'script.docx'
}

function sanitizeTitle(title) {
  const raw = String(title || '').replace(/\s+/g, ' ').trim()
  return raw.length > 0 ? raw.slice(0, 120) : '未命名剧本'
}

function resolveWorkspace(ctx, config) {
  if (config && typeof config.workspace === 'string' && config.workspace.length > 0) {
    return path.resolve(config.workspace)
  }
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory && typeof workingDirectory.defaultDirectory === 'string' && workingDirectory.defaultDirectory) {
    return workingDirectory.defaultDirectory
  }
  return process.cwd()
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isTerminalState(state) {
  return TERMINAL_JOB_STATES.has(state)
}

async function readJsonFile(file, fallback = null) {
  try {
    const text = await fs.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  let lastError = null
  // Windows: replacing an existing target can transiently fail with EPERM/EBUSY
  // while antivirus/indexer or a concurrent writer holds the file. Retry before
  // falling back to a remove+rename.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (error) {
      lastError = error
      const code = String((error && error.code) || '')
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(code)) break
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)))
    }
  }
  try {
    await fs.rm(file, { force: true })
    await fs.rename(tmp, file)
    return
  } catch (error) {
    lastError = error
  }
  try {
    await fs.rm(tmp, { force: true })
  } catch {
    // ignore cleanup
  }
  throw lastError || new Error(`cannot write ${file}`)
}

async function appendLine(file, line) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, line, 'utf8')
}

async function readJsonBody(request) {
  try {
    return await request.json()
  } catch {
    return null
  }
}

async function sha256File(file) {
  const hash = createHash('sha256')
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

function parseLastJsonLine(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      // keep scanning earlier lines
    }
  }
  return null
}

function readCollected(handle, streamName) {
  try {
    const reader = handle.collected && handle.collected[streamName]
    if (!reader) return ''
    const read = reader.readFrom(0)
    return read && typeof read.text === 'string' ? read.text : ''
  } catch {
    return ''
  }
}

function riskOf(check) {
  if (!check) return false
  const status = String(check.status || '').toUpperCase()
  if (status === 'RISK' || status === 'BLOCKED' || status === 'ERROR') return true
  const risky = Array.isArray(check.risky_eps) ? check.risky_eps : []
  const blocked = Array.isArray(check.blocked_eps) ? check.blocked_eps : []
  return risky.length > 0 || blocked.length > 0
}

function contentDisposition(name) {
  const safe = String(name || 'download')
  return `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`
}

function publicJob(job) {
  if (!job) return null
  return {
    schema: job.schema,
    id: job.id,
    projectId: job.projectId,
    kind: job.kind,
    state: job.state,
    phase: job.phase,
    phaseIndex: job.phaseIndex,
    phases: job.phases,
    episodes: job.episodes,
    error: job.error,
    result: job.result,
    seq: job.seq,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    failureKind: job.failureKind || null,
    detection: job.detection || null,
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const workspace = resolveWorkspace(ctx, config)
  const projectsRoot = path.resolve(config.projectsRoot || path.join(workspace, 'lianben-projects'))
  const dataDir = path.join(workspace, 'work', 'm5')
  const stateDir = path.join(dataDir, 'state')
  const tmpDir = path.join(dataDir, 'tmp')
  const routePaths = []

  let pythonCache = null
  let engineProbeCache = { at: 0, value: null }
  let lastSelfCheck = null
  let selfCheckInFlight = null
  let recoveryPromise = null
  const modeFile = path.join(dataDir, 'mode.json')
  let activeMode = MODE_10
  let modeLoaded = false

  function modeOf(meta) {
    return meta && meta.mode === MODE_20 ? MODE_20 : MODE_10
  }

  async function ensureModeLoaded() {
    if (modeLoaded) return activeMode
    modeLoaded = true
    const saved = await readJsonFile(modeFile, null).catch(() => null)
    if (saved && (saved.mode === MODE_10 || saved.mode === MODE_20)) activeMode = saved.mode
    return activeMode
  }

  async function setActiveMode(mode) {
    if (mode !== MODE_10 && mode !== MODE_20) throw new Error(`unknown mode: ${String(mode)}`)
    activeMode = mode
    modeLoaded = true
    await fs.mkdir(dataDir, { recursive: true })
    await writeJsonAtomic(modeFile, { schema: 'lianben/mode/1', mode, updatedAt: new Date().toISOString() })
    return activeMode
  }

  /** @type {Map<string, JobRecord>} */
  const jobs = new Map()
  /** @type {Set<string>} per-project explicit merge in-flight guard */
  const mergeActive = new Set()
  /** @type {Map<string, string>} projectId -> active jobId */
  const projectActive = new Map()

  // -------------------------------------------------------------------------
  // Python discovery + engine invocation
  // -------------------------------------------------------------------------

  async function locatePythonCandidates() {
    const subprocess = ctx.get('subprocess')
    const candidates = []
    const add = (value) => {
      if (typeof value !== 'string' || value.length === 0) return
      if (!candidates.includes(value)) candidates.push(value)
    }
    add(config.pythonPath)
    add(process.env.LIANBEN_PYTHON)
    add(process.env.DSH_PYTHON)
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    try {
      const runtimes = await fs.readdir(path.join(dshHome, 'dsh-runtimes'), { withFileTypes: true })
      for (const runtime of runtimes) {
        if (!runtime.isDirectory()) continue
        const base = path.join(dshHome, 'dsh-runtimes', runtime.name, 'dependencies', 'python')
        add(path.join(base, 'python.exe'))
        add(path.join(base, 'bin', 'python3'))
      }
    } catch {
      // ignore
    }
    if (subprocess) {
      try {
        add(await subprocess.resolveExecutable('python'))
      } catch {
        // ignore
      }
    }
    add('python')
    return candidates
  }

  async function probePython(force = false) {
    if (pythonCache && !force) return pythonCache
    const subprocess = ctx.get('subprocess')
    if (!subprocess) {
      pythonCache = { ok: false, error: 'subprocess service unavailable' }
      return pythonCache
    }
    const candidates = await locatePythonCandidates()
    const code = 'import json,sys\nmods={}\nfor name in ("docx","lxml"):\n    try:\n        __import__(name);mods[name]=True\n    except Exception:\n        mods[name]=False\nprint(json.dumps({"python":sys.version.split()[0],"executable":sys.executable,"modules":mods}))'
    const attempts = []
    for (const candidate of candidates) {
      try {
        const result = await runPython(candidate, code, 20_000)
        attempts.push({ candidate, ...result })
        if (result.ok && result.parsed && result.parsed.modules && result.parsed.modules.docx === true) {
          pythonCache = { ok: true, python: candidate, result: result.parsed, attempts }
          return pythonCache
        }
      } catch (error) {
        attempts.push({ candidate, ok: false, error: String((error && error.message) || error) })
      }
    }
    pythonCache = { ok: false, attempts, error: 'no Python interpreter with python-docx found' }
    return pythonCache
  }

  async function runPython(executable, script, timeoutMs) {
    const subprocess = ctx.get('subprocess')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('python timeout')), timeoutMs)
    try {
      const handle = subprocess.spawn({
        argv: [executable, '-c', script],
        cwd: workspace,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 1024 * 1024 } },
        graceMs: 2000,
        signal: controller.signal,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      })
      const outcome = await handle.done
      const stdout = readCollected(handle, 'stdout')
      const stderr = readCollected(handle, 'stderr')
      let parsed = null
      try {
        parsed = stdout ? JSON.parse(stdout.trim().split(/\r?\n/).pop()) : null
      } catch {
        parsed = null
      }
      return { ok: outcome.exitCode === 0 && parsed !== null, exitCode: outcome.exitCode, stdout, stderr, parsed }
    } finally {
      clearTimeout(timer)
    }
  }

  async function engineSpawn(args, options = {}) {
    const subprocess = ctx.get('subprocess')
    const python = await probePython()
    if (!python.ok) return { error: python.error, python }
    const controller = options.controller || new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('engine timeout')), options.timeoutMs || PREFLIGHT_TIMEOUT_MS)
    const startedAt = Date.now()
    try {
      const handle = subprocess.spawn({
        argv: [python.python, '-m', 'lianben2', ...args],
        cwd: ENGINE_DIR,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 32 * 1024 * 1024 },
          stderr: 'pipe',
        },
        graceMs: 3000,
        signal: controller.signal,
        env: { ...process.env, PYTHONPATH: ENGINE_DIR, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      })
      return { handle, python: python.python, controller, timer, startedAt }
    } catch (error) {
      clearTimeout(timer)
      return { error: String((error && error.message) || error), python }
    }
  }

  async function runEngine(args, options = {}) {
    const spawned = await engineSpawn(args, options)
    if (spawned.error) return { ok: false, exitCode: null, json: null, error: spawned.error, python: spawned.python }
    const stderrChunks = []
    try {
      if (spawned.handle.stderr) {
        spawned.handle.stderr.on('data', (chunk) => {
          stderrChunks.push(chunk.toString('utf8'))
          if (stderrChunks.length > 200) stderrChunks.shift()
        })
      }
    } catch {
      // stderr may be unavailable in a custom provider
    }
    try {
      const outcome = await spawned.handle.done
      const stdout = readCollected(spawned.handle, 'stdout')
      const json = parseLastJsonLine(stdout)
      const stderr = stderrChunks.join('').slice(-4000)
      return {
        ok: outcome.exitCode === 0 && json !== null && json.ok !== false,
        exitCode: outcome.exitCode,
        json,
        stdout,
        stderr,
        durationMs: Date.now() - spawned.startedAt,
        python: spawned.python,
      }
    } finally {
      clearTimeout(spawned.timer)
    }
  }

  async function engineInfo(force = false) {
    const now = Date.now()
    if (!force && engineProbeCache.value && now - engineProbeCache.at < 10_000) {
      return engineProbeCache.value
    }
    const entry = path.join(ENGINE_DIR, 'lianben2', '__main__.py')
    let packagePresent = false
    try {
      await fs.access(entry)
      packagePresent = true
    } catch {
      packagePresent = false
    }
    if (!packagePresent) {
      const value = { available: false, version: null, error: 'engine package not installed (engine/lianben2/__main__.py missing)' }
      engineProbeCache = { at: now, value }
      return value
    }
    const result = await runEngine(['version'], { timeoutMs: ENGINE_VERSION_TIMEOUT_MS })
    const value = {
      available: result.ok,
      version: result.json ? result.json.version || null : null,
      engineDir: ENGINE_DIR,
      python: result.python || null,
      error: result.ok ? null : result.json ? result.json.error || 'engine version check failed' : result.error || `exit ${result.exitCode}`,
    }
    engineProbeCache = { at: now, value }
    return value
  }

  // -------------------------------------------------------------------------
  // Project store
  // -------------------------------------------------------------------------

  async function ensureProjectsRoot() {
    await fs.mkdir(projectsRoot, { recursive: true })
    await fs.mkdir(stateDir, { recursive: true })
    await fs.mkdir(tmpDir, { recursive: true })
  }

  function projectDirFor(id) {
    if (!PROJECT_ID_RE.test(String(id || ''))) return null
    const dir = path.join(projectsRoot, id)
    return isInside(projectsRoot, dir) ? dir : null
  }

  async function readProject(id) {
    await ensureModeLoaded()
    const dir = projectDirFor(id)
    if (!dir) return null
    const meta = await readJsonFile(path.join(dir, 'project.json'))
    if (!meta) return null
    if (modeOf(meta) !== activeMode) return null
    // T2 migration: early 2.0 projects were created before the import-page
    // switch existed and defaulted llmCorrection.enabled=true with a legacy
    // maxEpisodes/maxCalls quota. Treat that legacy shape as the new "off by
    // default" setting; a user-enabled value always carries maxCallsPerEpisode.
    if (modeOf(meta) === MODE_20 && meta.options && meta.options.llmCorrection && typeof meta.options.llmCorrection === 'object') {
      const legacy = meta.options.llmCorrection
      if (legacy.enabled === true && legacy.maxCallsPerEpisode === undefined) {
        meta.options = {
          ...meta.options,
          llmCorrection: { enabled: false, maxCallsPerEpisode: 2 },
        }
      }
    }
    if (modeOf(meta) === MODE_20 && meta.pipeline && meta.pipeline.bgm !== '2.0') {
      meta.pipeline = { ...meta.pipeline, bgm: '2.0' }
    }
    return { id, dir, meta }
  }

  async function writeMeta(project, mutate) {
    const latest = await readJsonFile(path.join(project.dir, 'project.json'), project.meta)
    const base = latest && typeof latest === 'object' ? latest : project.meta
    const next = mutate({ ...base })
    next.updatedAt = new Date().toISOString()
    await writeJsonAtomic(path.join(project.dir, 'project.json'), next)
    project.meta = next
    return next
  }

  function summaryFromMeta(meta) {
    const summary = meta && meta.preflight && meta.preflight.summary ? meta.preflight.summary : null
    return summary
  }

  function cardFromMeta(id, meta) {
    const summary = summaryFromMeta(meta) || {}
    const project = summary.project || {}
    const checks = summary.checks || {}
    const episodes = Array.isArray(summary.episodes) ? summary.episodes : []
    const blockedEps = Array.isArray(project.blocked_eps)
      ? project.blocked_eps
      : episodes.filter((episode) => episode.blocked).map((episode) => episode.ep)
    const cjk = Number(project.cjk || 0) || episodes.reduce((sum, episode) => sum + (Number(episode.cjk) || 0), 0)
    return {
      id,
      title: meta.title || project.title || id,
      mode: modeOf(meta),
      episodeCount: Number(project.episodes || episodes.length || 0),
      cjk,
      status: meta.status || 'unknown',
      blockedCount: blockedEps.length,
      checksSummary: {
        spokenWords: riskOf(checks.spoken_words),
        punctuation: riskOf(checks.punctuation),
        pacing: riskOf(checks.pacing),
        protagonist: riskOf(checks.protagonist),
        culture: riskOf(checks.culture),
      },
      updatedAt: meta.updatedAt || meta.createdAt || null,
      createdAt: meta.createdAt || null,
      lastDurationMs: meta.preflight ? meta.preflight.durationMs || null : null,
    }
  }

  async function listProjects(url) {
    await ensureProjectsRoot()
    await ensureModeLoaded()
    const query = (url.searchParams.get('query') || '').trim().toLowerCase()
    const sort = url.searchParams.get('sort') || 'updated'
    let entries = []
    try {
      entries = await fs.readdir(projectsRoot, { withFileTypes: true })
    } catch {
      return []
    }
    const projects = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const meta = await readJsonFile(path.join(projectsRoot, entry.name, 'project.json'))
      if (!meta) continue
      if (modeOf(meta) !== activeMode) continue
      const card = cardFromMeta(entry.name, meta)
      const latestJob = await readJsonFile(path.join(projectsRoot, entry.name, 'work', 'meta', 'host_job.json'), null)
      card.job = latestJob ? publicJob(latestJob) : null
      const refineState = await readJsonFile(path.join(projectsRoot, entry.name, 'work', 'meta', 'refine_state.json'), null)
      card.refine = refineSummary(refineState)
      if (modeOf(meta) === MODE_20) {
        const storyboardState = await readJsonFile(path.join(projectsRoot, entry.name, 'work', 'meta', 'storyboard_state.json'), null)
        card.storyboard = storyboardSummary(storyboardState)
        card.refine = card.refine || card.storyboard
      }
      const bgmState = await readJsonFile(path.join(projectsRoot, entry.name, 'work', 'meta', 'bgm_state.json'), null)
      card.bgm = bgmSummary(bgmState)
      if (query && !String(card.title).toLowerCase().includes(query)) continue
      projects.push(card)
    }
    projects.sort((left, right) => {
      if (sort === 'title') return String(left.title).localeCompare(String(right.title), 'zh-CN')
      if (sort === 'episodes') return (right.episodeCount || 0) - (left.episodeCount || 0)
      return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
    })
    return projects
  }

  function deriveOverallStatus(summary) {
    const blocked = summary && summary.project && Array.isArray(summary.project.blocked_eps) ? summary.project.blocked_eps : []
    if (blocked.length > 0) return 'BLOCKED'
    const checks = (summary && summary.checks) || {}
    for (const check of Object.values(checks)) {
      if (!check || typeof check !== 'object') continue
      const status = String(check.status || '').toUpperCase()
      if (status === 'RISK' || status === 'ERROR') return 'RISK'
    }
    return 'OK'
  }

  function normalizeEngineSummary(summary, id) {
    const project = summary.project || {}
    const episodes = Array.isArray(summary.episodes) ? summary.episodes : []
    const blockedEps = Array.isArray(project.blocked_eps)
      ? project.blocked_eps
      : episodes.filter((episode) => episode.blocked).map((episode) => episode.ep)
    const cjk = Number(project.cjk || 0) || episodes.reduce((sum, episode) => sum + (Number(episode.cjk) || 0), 0)
    return {
      schema: summary.schema || 'lianben2/engine/1',
      version: summary.version || null,
      project: {
        id: project.id || id,
        title: project.title || '',
        episodes: Number(project.episodes || episodes.length || 0),
        cjk,
        blocked_eps: blockedEps,
        durationMs: project.durationMs || summary.durationMs || null,
      },
      detection: summary.detection || null,
      checks: summary.checks || {},
      episodes,
      report: summary.report || null,
      files: summary.files || null,
      effectiveCheckProfile: summary.effectiveCheckProfile || null,
      checkProfileSource: summary.checkProfileSource || 'default',
      ai_used: false,
    }
  }

  function buildSnapshot(id, meta, jobOverride) {
    const summary = summaryFromMeta(meta) || {}
    const project = summary.project || {}
    const checks = summary.checks || {}
    const episodes = Array.isArray(summary.episodes)
      ? summary.episodes.map((episode) => ({
          ep: Number(episode.ep) || 0,
          title: episode.title || '',
          status: episode.status || 'OK',
          blocked: Boolean(episode.blocked),
          cjk: Number(episode.cjk) || 0,
          scenes: Number(episode.scenes) || 0,
          dialogueLines: Number(episode.dialogue_lines || episode.dialogueLines) || 0,
          atomLines: Number(episode.atom_lines || episode.atomLines) || 0,
          checks: episode.checks || {},
        }))
      : []
    const blockedEps = Array.isArray(project.blocked_eps)
      ? project.blocked_eps
      : episodes.filter((episode) => episode.blocked).map((episode) => episode.ep)
    const stats = {
      episodes: Number(project.episodes || episodes.length || 0),
      cjk: Number(project.cjk || 0) || episodes.reduce((sum, episode) => sum + episode.cjk, 0),
      scenes: episodes.reduce((sum, episode) => sum + episode.scenes, 0),
      dialogueLines: episodes.reduce((sum, episode) => sum + episode.dialogueLines, 0),
      atomLines: episodes.reduce((sum, episode) => sum + episode.atomLines, 0),
      blocked: blockedEps.length,
      risky: {
        spokenWords: riskOf(checks.spoken_words),
        punctuation: riskOf(checks.punctuation),
        pacing: riskOf(checks.pacing),
        protagonist: riskOf(checks.protagonist),
        culture: riskOf(checks.culture),
      },
    }
    const preflight = meta.preflight || {}
    return {
      phase: { preflight: meta.status || 'unknown' },
      project: {
        id,
        mode: modeOf(meta),
        title: meta.title || project.title || id,
        status: meta.status || 'unknown',
        createdAt: meta.createdAt || null,
        updatedAt: meta.updatedAt || null,
        episodes: stats.episodes,
        cjk: stats.cjk,
        sourceName: meta.source ? meta.source.name || null : null,
        engineVersion: preflight.engineVersion || null,
        durationMs: preflight.durationMs || null,
        aiUsed: false,
      },
      stats,
      checks,
      episodes,
      detection: summary.detection || null,
      ledger: preflight.ledger || null,
      llmCorrection: preflight.llmCorrection || null,
      merge: meta.merge || null,
      preflightStale: Boolean(meta.preflightStale),
      report: {
        md: preflight.reportMd || null,
        docx: preflight.reportDocx || null,
      },
      job: publicJob(jobOverride !== undefined ? jobOverride : (meta.hostJob || null)),
      options: meta.options || null,
      checkProfile: meta.checkProfile || null,
      engine: {
        version: preflight.engineVersion || null,
        checkProfileSource: summary.checkProfileSource || 'default',
        effectiveCheckProfile: summary.effectiveCheckProfile || null,
      },
    }
  }

  async function getSnapshot(id) {
    const project = await readProject(id)
    if (!project) return null
    const job = await readJsonFile(path.join(project.dir, 'work', 'meta', 'host_job.json'), null)
    const snapshot = buildSnapshot(id, project.meta, job)
    const refineState = await readRefineState(project)
    snapshot.refine = refineSummary(refineState)
    if (modeOf(project.meta) === MODE_20) {
      const storyboardState = await readStoryboardState(project)
      snapshot.storyboard = storyboardSummary(storyboardState)
    }
    const bgmState = await readBgmState(project)
    snapshot.bgm = bgmSummary(bgmState)
    snapshot.pricing = pricingSnapshot()
    return snapshot
  }

  // -------------------------------------------------------------------------
  // Scaffolding + synchronous preflight (M1 compat)
  // -------------------------------------------------------------------------

  async function scaffoldProject({ stagedPath, originalName, title, mode: requestedMode, llmCorrection: requestedLlmCorrection }) {
    await ensureProjectsRoot()
    await ensureModeLoaded()
    const mode = requestedMode || activeMode
    if (mode !== MODE_10 && mode !== MODE_20) throw new Error(`unknown mode: ${String(mode)}`)
    const now = new Date().toISOString()
    const id = `p-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 6)}`
    const dir = path.join(projectsRoot, id)
    const safeName = sanitizeFileName(originalName)
    const targetDir = path.join(dir, '剧本输入')
    await fs.mkdir(targetDir, { recursive: true })
    const target = path.join(targetDir, safeName)
    await fs.copyFile(stagedPath, target)
    const stats = await fs.stat(target)
    const sha256 = await sha256File(target)
    const cultureDefault = await readJsonFile(path.join(ENGINE_DIR, 'defaults', 'culture-profile.json'), {})
    const is20 = mode === MODE_20
    const meta = {
      schema: 'lianben/project/1',
      id,
      mode,
      title: sanitizeTitle(title || safeName.replace(/\.docx$/i, '')),
      source: { file: `剧本输入/${safeName}`, name: safeName, sha256, bytes: stats.size },
      pipeline: is20 ? { preflight: '2.0', refine: '2.0', bgm: '2.0' } : { preflight: '1.0', refine: '0.0', bgm: '0.0' },
      options: is20
        ? {
            min_words: 100,
            max_words: 350,
            forbid_cn_elements: Boolean(cultureDefault && cultureDefault.forbid_cn_elements),
            allowed_terms: Array.isArray(cultureDefault && cultureDefault.allowed_terms) ? cultureDefault.allowed_terms : [],
            check_overrides: {},
            storyboardProfile: 'B_bilingual_full',
            llmCorrection: { enabled: Boolean(requestedLlmCorrection), maxCallsPerEpisode: 2 },
          }
        : {
            min_words: 100,
            max_words: 350,
            forbid_cn_elements: Boolean(cultureDefault && cultureDefault.forbid_cn_elements),
            allowed_terms: Array.isArray(cultureDefault && cultureDefault.allowed_terms) ? cultureDefault.allowed_terms : [],
            check_overrides: {},
          },
      createdAt: now,
      updatedAt: now,
      status: 'importing',
      preflight: null,
    }
    await writeJsonAtomic(path.join(dir, 'project.json'), meta)
    for (const fileName of ['culture-profile.json', 'shot-profile.json']) {
      const from = path.join(ENGINE_DIR, 'defaults', fileName)
      const to = path.join(dir, fileName)
      try {
        await fs.copyFile(from, to)
      } catch {
        // optional defaults
      }
    }
    if (is20) {
      try {
        await fs.copyFile(path.join(ENGINE2_DIR, 'defaults', 'storyboard-profile.json'), path.join(dir, 'storyboard-profile.json'))
      } catch {
        // engine2 assets are deployed with the bundle; a missing default is reported by 2.0 preflight
      }
    }
    return { id, dir, meta }
  }

  async function commitPreflightSuccess(project, summaryRaw, durationMs) {
    const normalized = normalizeEngineSummary(summaryRaw, project.id)
    const status = deriveOverallStatus(normalized)
    await writeMeta(project, (meta) => ({
      ...meta,
      status: 'preflight_done',
      preflight: {
        status,
        startedAt: meta.preflight ? meta.preflight.startedAt : new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: durationMs || (normalized.project && normalized.project.durationMs) || null,
        engineVersion: normalized.version || null,
        reportMd: normalized.report ? normalized.report.md || null : null,
        reportDocx: normalized.report ? normalized.report.docx || null : null,
        summary: normalized,
        checkProfileSource: normalized.checkProfileSource || 'default',
        effectiveCheckProfile: normalized.effectiveCheckProfile || null,
      },
    }))
    await writeJsonAtomic(path.join(project.dir, 'work', 'meta', 'host_summary.json'), normalized).catch(() => {})
    return normalized
  }

  async function commitPreflightFailure(project, error, detail) {
    await writeMeta(project, (meta) => ({
      ...meta,
      status: detail && detail.code === 'NEEDS_CONFIRM' ? 'needs_confirm' : 'preflight_failed',
      preflight: {
        status: 'FAILED',
        finishedAt: new Date().toISOString(),
        durationMs: null,
        engineVersion: null,
        error: String(error),
        summary: null,
      },
    }))
  }

  async function runPreflightForProject(project, options = {}) {
    const startedAt = new Date().toISOString()
    await writeMeta(project, (meta) => ({ ...meta, status: 'preflight_running' }))
    const result = await runEngine(['preflight', '--root', project.dir], {
      timeoutMs: options.timeoutMs || PREFLIGHT_TIMEOUT_MS,
    })
    if (!result.ok) {
      const error =
        (result.json && (result.json.error && result.json.error.message ? result.json.error.message : result.json.error)) ||
        result.error ||
        `engine exit ${result.exitCode}`
      const code = result.exitCode === 2 ? 'NEEDS_CONFIRM' : 'PREFLIGHT_FAILED'
      await commitPreflightFailure(project, error, { code, detection: result.json ? result.json.detection : null })
      return {
        ok: false,
        error: `preflight failed: ${typeof error === 'string' ? error : JSON.stringify(error)}`,
        engine: result,
        code,
        detail: result.json || null,
        startedAt,
      }
    }
    const normalized = await commitPreflightSuccess(project, result.json || {}, result.durationMs)
    return { ok: true, summary: normalized, engine: result, startedAt }
  }

  // -------------------------------------------------------------------------
  // 2.0 preflight: 1.0-style weak QC + frozen dialogue ledger + bounded LLM correction
  // -------------------------------------------------------------------------

  function preflight2Phase(index) {
    return PREFLIGHT2_PHASES[Math.max(0, Math.min(index, PREFLIGHT2_PHASES.length - 1))]
  }

  async function advancePreflight2(record, index, message) {
    if (!record) return
    const phase = preflight2Phase(index)
    record.job.phase = phase
    record.job.phaseIndex = index
    record.job.phases = PREFLIGHT2_PHASES.slice()
    emitJob(record, { type: 'phase', phase, index, total: PREFLIGHT2_PHASES.length })
    if (message) emitJob(record, { type: 'log', level: 'info', message })
    await updateJob(record, { phase, phaseIndex: index }, { persist: false })
  }

  async function runPreflight2ForProject(project, record = null, options = {}) {
    const startedAt = new Date().toISOString()
    const preflight2Options = project.meta && project.meta.options ? JSON.parse(JSON.stringify(project.meta.options)) : {}
    await writeMeta(project, (meta) => ({ ...meta, status: 'preflight_running' }))
    try {
      await advancePreflight2(record, 0, '2.0 preflight: base weak QC')
      const result = await runEngine(['preflight', '--root', project.dir], {
        timeoutMs: options.timeoutMs || PREFLIGHT_TIMEOUT_MS,
      })
      if (!result.ok) {
        const error =
          (result.json && (result.json.error && result.json.error.message ? result.json.error.message : result.json.error)) ||
          result.error ||
          `engine exit ${result.exitCode}`
        const code = result.exitCode === 2 ? 'NEEDS_CONFIRM' : 'PREFLIGHT_FAILED'
        await commitPreflightFailure(project, error, { code, detection: result.json ? result.json.detection : null })
        if (record) {
          await updateJob(record, {
            state: code === 'NEEDS_CONFIRM' ? 'needs_confirm' : 'failed',
            failureKind: code === 'NEEDS_CONFIRM' ? 'needs_confirm' : 'engine',
            error: String(error),
            finishedAt: new Date().toISOString(),
          }, { persist: false })
          await flushRecord(record)
          emitJob(record, { type: 'error', error: String(error), job: publicJob(record.job) })
        }
        return { ok: false, error: String(error), code, detail: result.json || null, startedAt }
      }
      await advancePreflight2(record, 1, '2.0 preflight: weak-QC checks committed')
      const normalized = await commitPreflightSuccess(project, result.json || {}, result.durationMs)

      // The base 1.0 engine rewrites project.json; restore the 2.0 mode and
      // project options before correction/ledger so llmCorrection switches and
      // future storyboard runs keep their mode-specific configuration.
      await writeMeta(project, (meta) => ({
        ...meta,
        mode: MODE_20,
        options: { ...(meta.options || {}), ...preflight2Options },
      }))
      await advancePreflight2(record, 2, '2.0 preflight: freeze dialogue ledger')
      await ensureProjectToolchain(project)
      const ledgerRun = await runProjectScript(project, 'snapshot_dialogue.py', [], { timeoutMs: SCRIPT_TIMEOUT_MS })
      const ledgerMeta = await readJsonFile(path.join(project.dir, 'work', 'meta', 'source_dialogue.meta.json'), null)
      const ledger = {
        available: ledgerRun.exitCode === 0 && Boolean(ledgerMeta),
        exitCode: ledgerRun.exitCode,
        episodes: ledgerMeta ? Number(ledgerMeta.episodes) || 0 : 0,
        lines: ledgerMeta ? Number(ledgerMeta.dialogue_lines) || 0 : 0,
        tagged: ledgerMeta ? Number(ledgerMeta.tagged) || 0 : 0,
        untagged: ledgerMeta ? Number(ledgerMeta.untagged) || 0 : 0,
        warnings: ledgerMeta && Array.isArray(ledgerMeta.warnings) ? ledgerMeta.warnings : [],
        error: ledgerRun.exitCode === 0 ? null : String(ledgerRun.stderr || ledgerRun.stdout || 'snapshot_dialogue failed').slice(-2000),
      }
      if (!ledger.available) {
        const message = `台词台账生成失败：${ledger.error || 'unknown'}`
        await commitPreflightFailure(project, message, { code: 'LEDGER_FAILED' })
        if (record) {
          await updateJob(record, { state: 'failed', failureKind: 'ledger', error: message, finishedAt: new Date().toISOString() }, { persist: false })
          await flushRecord(record)
          emitJob(record, { type: 'error', error: message, job: publicJob(record.job) })
        }
        return { ok: false, error: message, code: 'LEDGER_FAILED', startedAt }
      }

      await advancePreflight2(record, 3, '2.0 preflight: optional bounded LLM correction')
      const correction = await runPreflight2Correction(project, record)
      await advancePreflight2(record, 4, '2.0 preflight: report')
      const nextMeta = await writeMeta(project, (meta) => ({
        ...meta,
        preflight: {
          ...(meta.preflight || {}),
          mode: MODE_20,
          ledger,
          llmCorrection: correction.summary || null,
        },
      }))
      const resultSummary = {
        status: nextMeta.status,
        episodes: normalized.project ? normalized.project.episodes : 0,
        blockedEps: normalized.project ? normalized.project.blocked_eps || [] : [],
        checks: normalized.checks || {},
        ledger,
        llmCorrection: correction.summary || null,
      }
      if (record) {
        await updateJob(record, {
          state: 'succeeded',
          result: resultSummary,
          error: null,
          failureKind: null,
          finishedAt: new Date().toISOString(),
        }, { persist: false })
        await flushRecord(record)
        emitJob(record, { type: 'done', job: publicJob(record.job), result: resultSummary })
      }
      return { ok: true, summary: normalized, ledger, correction, snapshot: await getSnapshot(project.id).catch(() => null), startedAt }
    } catch (error) {
      const message = String((error && error.message) || error)
      await commitPreflightFailure(project, message, { code: 'PREFLIGHT2_FAILED' }).catch(() => {})
      if (record) {
        await updateJob(record, { state: 'failed', failureKind: 'host', error: message, finishedAt: new Date().toISOString() }, { persist: false }).catch(() => {})
        await flushRecord(record).catch(() => {})
        emitJob(record, { type: 'error', error: message, job: publicJob(record.job) })
      }
      return { ok: false, error: message, code: 'PREFLIGHT2_FAILED', startedAt }
    }
  }

  async function collectPreflight2Issues(project) {
    const checksDir = path.join(project.dir, 'work', 'preflight', 'checks')
    const issues = []
    const culture = await readJsonFile(path.join(checksDir, 'culture.json'), null)
    if (culture && Array.isArray(culture.results)) {
      for (const row of culture.results) {
        const severity = String(row.severity || (culture.summary && culture.summary.status === 'RISK' ? 'suspected' : 'info'))
        if (severity === 'info' || row.fixable === false) continue
        issues.push({
          type: 'culture',
          ep: Number(row.ep) || 0,
          severity,
          fixable: row.fixable !== false,
          problem: row.context || row.reason || row.note || row.word || 'culture hit',
          suggestion: row.suggestion || '改为文化中性写法，不加新器物/礼仪',
          location: row.paragraph || row.line_index || null,
        })
      }
    }
    const punctuation = await readJsonFile(path.join(checksDir, 'punctuation.json'), null)
    if (punctuation && Array.isArray(punctuation.results)) {
      for (const row of punctuation.results) {
        const severity = String(row.severity || 'suspected')
        if (severity === 'info' || row.fixable === false) continue
        issues.push({
          type: 'punctuation',
          ep: Number(row.ep) || 0,
          severity,
          fixable: row.fixable !== false,
          problem: row.reason || row.context || '标点/格式问题',
          suggestion: row.suggestion || '只修正纯格式标点，不改台词文字',
          location: row.paragraph || row.line_index || null,
        })
      }
    }
    const pacing = await readJsonFile(path.join(checksDir, 'pacing.json'), null)
    const pacingRows = pacing && pacing.subchecks && pacing.subchecks.atom_pacing && Array.isArray(pacing.subchecks.atom_pacing.results)
      ? pacing.subchecks.atom_pacing.results : []
    for (const row of pacingRows) {
      const reasons = Array.isArray(row.reasons) ? row.reasons : []
      if (reasons.length === 0) continue
      if (!Array.isArray(row.merge_targets) || row.merge_targets.length === 0) continue
      issues.push({
        type: 'pacing',
        ep: Number(row.ep) || 0,
        severity: 'suspected',
        fixable: true,
        problem: reasons.join('；'),
        suggestion: `仅合并连续 △ 段（${row.merge_targets.length} 处），完整保留全部事实与表演动作，只减少 △ 条数`,
        location: 'atom_pacing',
      })
    }
    return issues.filter((issue) => Number(issue.ep) > 0)
  }

  async function runPreflight2Correction(project, record) {
    const options = project.meta && project.meta.options ? project.meta.options : {}
    const correctionOptions = options.llmCorrection && typeof options.llmCorrection === 'object' ? options.llmCorrection : {}
    // New imports default OFF; existing projects keep their stored enabled value.
    const enabled = correctionOptions.enabled === true
    const maxCallsPerEpisode = Math.max(1, Math.min(2, Number(correctionOptions.maxCallsPerEpisode) || 2))
    const summary = {
      enabled,
      status: enabled ? 'skipped' : 'disabled',
      calls: 0,
      episodes: [],
      corrections: [],
      maxCallsPerEpisode,
      tokens: emptyTokens(),
      cost: emptyCost(),
      note: enabled ? '没有可低程度纠正的问题' : '导入时未启用低程度 LLM 纠正（默认关闭）',
    }
    if (!enabled) return { summary }
    const issues = await collectPreflight2Issues(project)
    const byEp = new Map()
    for (const issue of issues) {
      if (!byEp.has(issue.ep)) byEp.set(issue.ep, [])
      byEp.get(issue.ep).push(issue)
    }
    const selectedEps = Array.from(byEp.keys()).sort((a, b) => a - b)
    if (selectedEps.length === 0) return { summary }
    const backupDir = path.join(project.dir, 'work', 'preflight', '2.0-backup')
    await fs.mkdir(backupDir, { recursive: true })
    const epIndex = (await readEpIndex(project)) || { episodes: [] }
    const entries = Array.isArray(epIndex.episodes) ? epIndex.episodes : []
    for (const ep of selectedEps) {
      const sourceFile = epSourceFile(project, ep)
      let sourceText = ''
      try {
        sourceText = await fs.readFile(sourceFile, 'utf8')
      } catch {
        summary.corrections.push({ ep, status: 'skipped', reason: 'source missing' })
        continue
      }
      const backupFile = path.join(backupDir, `ep${String(ep).padStart(2, '0')}.md`)
      await writeTextAtomic(backupFile, sourceText)
      const issueList = byEp.get(ep) || []
      let applied = false
      let lastError = ''
      for (let attempt = 1; attempt <= maxCallsPerEpisode; attempt += 1) {
        summary.calls += 1
        if (record) emitJob(record, { type: 'log', level: 'info', message: `2.0 LLM correction: EP${ep} attempt ${attempt}/${maxCallsPerEpisode} (${issueList.length} issues)` })
        try {
          const prompt = buildPreflightCorrectionPrompt({
            ep,
            title: (entries.find((entry) => Number(entry.ep) === ep) || {}).title || `第${ep}集`,
            source: sourceText,
            issues: issueList,
          })
          if (lastError) {
            prompt.messages.push({
              role: 'user',
              content: [{ type: 'text', text: `上一次尝试未通过校验：${lastError}\n请只做最小修正，严格保留全部台词/锁行/场次，输出完整集正文。` }],
            })
          }
          const answer = await callDirector(prompt, null, record ? (text) => emitJob(record, { type: 'correction-delta', ep, text }) : null)
          if (answer.usage) addTokens(summary.tokens, answer.usage)
          const callCost = costForUsage(answer.usage || {}, new Date())
          addCost(summary.cost, callCost)
          await appendTokenLog(project, {
            at: new Date().toISOString(),
            stage: 'preflight2-correction',
            ep,
            attempt,
            usage: answer.usage || null,
            cost: callCost,
          }).catch(() => {})
          const parsed = parseCorrectedEpisode(answer.text, { ep })
          if (!parsed.ok) {
            lastError = parsed.errors.join('；')
            continue
          }
          await writeTextAtomic(sourceFile, parsed.text)
          const audit = await runProjectScript(project, 'audit_dialogue.py', ['--source', '--fail-on-diff'], { timeoutMs: SCRIPT_TIMEOUT_MS })
          if (audit.exitCode !== 0) {
            await writeTextAtomic(sourceFile, sourceText)
            lastError = '台词台账校验失败（已回滚）'
            continue
          }
          const correctedSha = await sha256File(sourceFile)
          const entry = entries.find((item) => Number(item.ep) === ep)
          if (entry) {
            entry.lines = parsed.text.split(/\r?\n/).length
            entry.atoms = (parsed.text.match(/^△/gm) || []).length
            entry.cjk = (parsed.text.match(/[\u4e00-\u9fff]/g) || []).length
            entry.sha256 = correctedSha
          }
          await fs.mkdir(path.join(project.dir, 'work', 'preflight', 'optimized'), { recursive: true })
          await writeTextAtomic(path.join(project.dir, 'work', 'preflight', 'optimized', `ep${String(ep).padStart(2, '0')}.md`), parsed.text)
          await writeJsonAtomic(path.join(project.dir, 'work', 'preflight', 'optimized', `ep${String(ep).padStart(2, '0')}.json`), {
            ep,
            schema: 'lianben/preflight2_correction/1',
            at: new Date().toISOString(),
            attempts: attempt,
            issues: issueList,
            status: 'applied',
            dialogueAudit: 'passed',
          })
          summary.corrections.push({ ep, status: 'applied', attempts: attempt, issues: issueList.length, sha256: correctedSha })
          applied = true
          break
        } catch (error) {
          lastError = String((error && error.message) || error)
          await writeTextAtomic(sourceFile, sourceText).catch(() => {})
        }
      }
      if (!applied) {
        summary.corrections.push({ ep, status: 'rejected', attempts: maxCallsPerEpisode, reason: lastError || '未通过校验' })
        await writeTextAtomic(sourceFile, sourceText).catch(() => {})
      }
    }
    await writeJsonAtomic(path.join(project.dir, 'work', 'meta', 'ep_index.json'), epIndex)
    const applied = summary.corrections.filter((entry) => entry.status === 'applied')
    summary.episodes = applied.map((entry) => entry.ep)
    summary.status = applied.length > 0 ? 'applied' : (summary.calls > 0 ? 'no_change' : 'skipped')
    summary.note = applied.length > 0
      ? `已应用 ${applied.length} 集低程度纠正（共 ${summary.calls} 次调用，每集最多 ${maxCallsPerEpisode} 次）`
      : '未应用纠正（校验失败或无可用问题）'
    return { summary }
  }

  async function createProjectFromDocx({ stagedPath, originalName, title, mode, llmCorrection }) {
    const project = await scaffoldProject({ stagedPath, originalName, title, mode, llmCorrection })
    if (modeOf(project.meta) === MODE_20) {
      const result = await runPreflight2ForProject(project)
      if (!result.ok) {
        return { ok: false, project: cardFromMeta(project.id, project.meta), ...result }
      }
      return { ok: true, project: cardFromMeta(project.id, project.meta), snapshot: buildSnapshot(project.id, project.meta) }
    }
    const result = await runPreflightForProject(project)
    if (!result.ok) {
      return { ok: false, project: cardFromMeta(project.id, project.meta), ...result }
    }
    return { ok: true, project: cardFromMeta(project.id, project.meta), snapshot: buildSnapshot(project.id, project.meta) }
  }

  async function archiveProjectWork(dir) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const archiveDir = path.join(dir, 'archive', timestamp)
    await fs.mkdir(archiveDir, { recursive: true })
    for (const name of ['work', 'report']) {
      const from = path.join(dir, name)
      try {
        await fs.access(from)
      } catch {
        continue
      }
      const to = path.join(archiveDir, name)
      try {
        await fs.rename(from, to)
      } catch {
        await fs.cp(from, to, { recursive: true, force: true }).catch(() => {})
      }
    }
    return archiveDir
  }

  // -------------------------------------------------------------------------
  // Job model
  // -------------------------------------------------------------------------

  function jobMetaDir(dir) {
    return path.join(dir, 'work', 'meta', 'jobs')
  }
  function jobEventsDir(dir) {
    return path.join(dir, 'work', 'logs', 'jobs')
  }
  function latestJobFile(dir) {
    return path.join(dir, 'work', 'meta', 'host_job.json')
  }
  function perJobFile(dir, jobId) {
    return path.join(jobMetaDir(dir), `${jobId}.json`)
  }
  function jobEventsFile(dir, jobId) {
    return path.join(jobEventsDir(dir), `${jobId}.ndjson`)
  }

  async function persistJob(record) {
    await writeJsonAtomic(perJobFile(record.dir, record.job.id), record.job)
    await writeJsonAtomic(latestJobFile(record.dir), record.job)
  }

  function makeRecord(dir, job, options = {}) {
    return {
      job,
      dir,
      eventsFile: jobEventsFile(dir, job.id),
      listeners: new Set(),
      writeChain: Promise.resolve(),
      live: Boolean(options.live),
      controller: options.controller || null,
      cancelRequested: false,
    }
  }

  async function findJob(jobId) {
    if (!JOB_ID_RE.test(String(jobId || ''))) return null
    if (jobs.has(jobId)) return jobs.get(jobId)
    let entries = []
    try {
      entries = await fs.readdir(projectsRoot, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = path.join(projectsRoot, entry.name)
      const job = await readJsonFile(perJobFile(dir, jobId), null)
      if (job) {
        const record = makeRecord(dir, job)
        jobs.set(jobId, record)
        return record
      }
    }
    return null
  }

  async function findLatestJobForProject(projectId) {
    const dir = projectDirFor(projectId)
    if (!dir) return null
    return readJsonFile(latestJobFile(dir), null)
  }

  function emitJob(record, frame) {
    const seq = Number(record.job.seq || 0) + 1
    record.job.seq = seq
    record.job.updatedAt = new Date().toISOString()
    const payload = { seq, ...frame }
    record.writeChain = record.writeChain
      .then(() => appendLine(record.eventsFile, `${JSON.stringify(payload)}\n`))
      .catch(() => {})
    for (const listener of [...record.listeners]) {
      try {
        listener.send(payload)
      } catch {
        // listener crashed: drop it
        record.listeners.delete(listener)
      }
      if (payload.type === 'done' || payload.type === 'error') {
        try {
          listener.close()
        } catch {
          // ignore
        }
        record.listeners.delete(listener)
      }
    }
    return payload
  }

  async function updateJob(record, patch, options = {}) {
    Object.assign(record.job, patch)
    record.job.updatedAt = new Date().toISOString()
    if (options.persist !== false) await persistJob(record)
  }

  async function readJobEvents(record, afterSeq) {
    try {
      const text = await fs.readFile(record.eventsFile, 'utf8')
      const frames = []
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const frame = JSON.parse(line)
          if (typeof frame.seq === 'number' && frame.seq > afterSeq) frames.push(frame)
        } catch {
          // skip malformed
        }
      }
      return frames
    } catch {
      return []
    }
  }

  function waitJobTerminal(record, timeoutMs = JOB_WAIT_TIMEOUT_MS) {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      const timer = setTimeout(() => resolve({ timeout: true, job: record.job }), timeoutMs)
      const poll = () => {
        if (isTerminalState(record.job.state)) {
          clearTimeout(timer)
          resolve({ timeout: false, job: record.job })
          return
        }
        if (Date.now() - startedAt > timeoutMs) {
          clearTimeout(timer)
          resolve({ timeout: true, job: record.job })
          return
        }
        setTimeout(poll, 150)
      }
      poll()
    })
  }

  function startJob(kind, project) {
    if (projectActive.has(project.id)) {
      return { ok: false, error: 'project is busy', code: 'BUSY' }
    }
    const mergeInfo = project && project.meta ? project.meta.merge : null
    if (kind.includes('preflight') && mergeInfo && Array.isArray(mergeInfo.episodes) && mergeInfo.episodes.length > 0) {
      return {
        ok: false,
        error: '项目源稿已按建议合并；重跑前置会用 docx 覆盖合并结果。请先在「前置检查」恢复合并前原文，再重跑前置检查。',
        code: 'MERGED_SOURCE',
      }
    }
    const id = `job-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 6)}`
    if (!JOB_ID_RE.test(id)) return { ok: false, error: 'job id generation failed', code: 'INTERNAL' }
    const job = {
      schema: 'lianben/job/1',
      id,
      projectId: project.id,
      kind,
      state: 'queued',
      phase: null,
      phaseIndex: -1,
      phases: modeOf(project.meta) === MODE_20 && kind.includes('preflight') ? PREFLIGHT2_PHASES.slice() : JOB_PHASES.slice(),
      episodes: { total: 0, done: 0 },
      error: null,
      result: null,
      seq: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      failureKind: null,
      detection: null,
    }
    const controller = new AbortController()
    const record = makeRecord(project.dir, job, { live: true, controller })
    jobs.set(id, record)
    projectActive.set(project.id, id)
    void persistJob(record)
    emitJob(record, { type: 'job', job: publicJob(job) })

    const run = async () => {
      try {
        await updateJob(record, { state: 'running', startedAt: new Date().toISOString() }, { persist: false })
        await writeMeta(project, (meta) => ({ ...meta, status: 'preflight_running' }))
        emitJob(record, { type: 'log', level: 'info', message: `job ${kind} started` })
        if (modeOf(project.meta) === MODE_20) {
          await runPreflight2ForProject(project, record)
          return
        }
        emitJob(record, { type: 'phase', phase: 'extract', index: 0, total: JOB_PHASES.length })
        await updateJob(record, { phase: 'extract', phaseIndex: 0 })

        const spawned = await engineSpawn(['preflight', '--root', project.dir, '--events'], {
          controller: record.controller,
          timeoutMs: PREFLIGHT_TIMEOUT_MS,
        })
        if (spawned.error) throw new Error(spawned.error)
        const stderrChunks = []
        let lineBuffer = ''
        const handle = spawned.handle
        if (handle.stderr) {
          handle.stderr.on('data', (chunk) => {
            const text = chunk.toString('utf8')
            stderrChunks.push(text)
            if (stderrChunks.length > 200) stderrChunks.shift()
            lineBuffer += text
            while (lineBuffer.includes('\n')) {
              const newline = lineBuffer.indexOf('\n')
              const line = lineBuffer.slice(0, newline).trim()
              lineBuffer = lineBuffer.slice(newline + 1)
              if (!line.startsWith('{')) continue
              let event = null
              try {
                event = JSON.parse(line)
              } catch {
                continue
              }
              if (!event || typeof event.event !== 'string') continue
              if (event.event === 'phase') {
                const index = typeof event.index === 'number' ? event.index : JOB_PHASES.indexOf(event.phase)
                record.job.phase = event.phase
                record.job.phaseIndex = Number.isFinite(index) ? index : record.job.phaseIndex
                emitJob(record, { type: 'phase', phase: event.phase, index: record.job.phaseIndex, total: event.total || JOB_PHASES.length })
                void persistJob(record)
              } else if (event.event === 'episode') {
                const done = Number(event.done || 0)
                const total = Number(event.total || 0)
                record.job.episodes = { done, total: total || record.job.episodes.total }
                emitJob(record, { type: 'episode', ep: event.ep, done, total: total || record.job.episodes.total })
                if (done % 5 === 0) void persistJob(record)
              } else if (event.event === 'log') {
                emitJob(record, { type: 'log', level: event.level || 'info', message: String(event.message || '') })
              }
            }
          })
        }

        const outcome = await handle.done
        clearTimeout(spawned.timer)
        const stdout = readCollected(handle, 'stdout')
        const json = parseLastJsonLine(stdout)
        const stderrTail = stderrChunks.join('').slice(-4000)
        const aborted = record.cancelRequested || record.controller.signal.aborted

        if (aborted) {
          await updateJob(record, {
            state: 'cancelled',
            failureKind: 'cancelled',
            error: 'cancelled by user',
            finishedAt: new Date().toISOString(),
          }, { persist: false })
          await commitPreflightFailure(project, 'cancelled by user', { code: 'CANCELLED' })
          await flushJob(record)
          emitJob(record, { type: 'error', error: 'cancelled', job: publicJob(record.job) })
          return
        }
        if (outcome.exitCode === 0 && json && json.ok !== false) {
          const normalized = await commitPreflightSuccess(project, json, spawned ? Date.now() - spawned.startedAt : null)
          const result = {
            status: deriveOverallStatus(normalized),
            episodes: normalized.project.episodes,
            blockedEps: normalized.project.blocked_eps,
            durationMs: normalized.project.durationMs || json.durationMs || null,
            checks: Object.fromEntries(
              Object.entries(normalized.checks || {}).map(([key, value]) => [key, value && value.status ? value.status : 'OK']),
            ),
          }
          record.job.phase = 'report'
          record.job.phaseIndex = JOB_PHASES.length - 1
          record.job.episodes = { total: result.episodes, done: result.episodes }
          await updateJob(record, {
            state: 'succeeded',
            result,
            error: null,
            finishedAt: new Date().toISOString(),
            failureKind: null,
          }, { persist: false })
          await flushJob(record)
          emitJob(record, { type: 'done', job: publicJob(record.job), result })
          return
        }
        const exitCode = outcome.exitCode
        const needsConfirm = exitCode === 2 || (json && json.code === 2)
        const errorMessage =
          (json && json.error && (json.error.message || json.error)) ||
          (json && json.message) ||
          stderrTail ||
          `engine exited with ${exitCode}`
        record.job.detection = json ? json.detection || null : null
        await updateJob(record, {
          state: needsConfirm ? 'needs_confirm' : 'failed',
          failureKind: needsConfirm ? 'needs_confirm' : 'engine',
          error: typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage),
          finishedAt: new Date().toISOString(),
        }, { persist: false })
        await commitPreflightFailure(project, record.job.error, { code: needsConfirm ? 'NEEDS_CONFIRM' : 'PREFLIGHT_FAILED', detection: record.job.detection })
        await flushJob(record)
        emitJob(record, { type: 'error', error: record.job.error, job: publicJob(record.job) })
      } catch (error) {
        const message = String((error && error.message) || error)
        if (record.cancelRequested || record.controller.signal.aborted) {
          await updateJob(record, { state: 'cancelled', failureKind: 'cancelled', error: 'cancelled by user', finishedAt: new Date().toISOString() }, { persist: false })
          emitJob(record, { type: 'error', error: 'cancelled', job: publicJob(record.job) })
        } else {
          await updateJob(record, { state: 'failed', failureKind: 'host', error: message, finishedAt: new Date().toISOString() }, { persist: false })
          emitJob(record, { type: 'error', error: message, job: publicJob(record.job) })
        }
        await flushJob(record)
      } finally {
        projectActive.delete(project.id)
        try {
          record.controller.abort()
        } catch {
          // ignore
        }
      }
    }

    async function flushJob(recordToFlush) {
      try {
        await recordToFlush.writeChain
      } catch {
        // ignore
      }
      try {
        await persistJob(recordToFlush)
      } catch {
        // ignore
      }
    }

    void run()
    return { ok: true, job: publicJob(record.job) }
  }

  async function cancelJob(jobId) {
    const record = await findJob(jobId)
    if (!record) return { ok: false, error: 'job not found', code: 'NOT_FOUND' }
    if (isTerminalState(record.job.state)) return { ok: false, error: 'job already finished', code: 'FINISHED', job: publicJob(record.job) }
    record.cancelRequested = true
    try {
      record.controller.abort(new Error('cancelled by user'))
    } catch {
      // ignore
    }
    emitJob(record, { type: 'log', level: 'warn', message: 'cancel requested' })
    return { ok: true, cancelled: true, job: publicJob(record.job) }
  }

  async function recoverInterruptedJobs() {
    if (recoveryPromise) return recoveryPromise
    recoveryPromise = (async () => {
      const recovered = []
      let entries = []
      try {
        entries = await fs.readdir(projectsRoot, { withFileTypes: true })
      } catch {
        return recovered
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const dir = path.join(projectsRoot, entry.name)
        const latest = await readJsonFile(latestJobFile(dir), null)
        if (!latest || !latest.id) continue
        if (isTerminalState(latest.state)) continue
        const record = makeRecord(dir, latest)
        latest.state = 'interrupted'
        latest.failureKind = 'host-restart'
        latest.error = 'Host restarted before the job finished'
        latest.finishedAt = new Date().toISOString()
        latest.updatedAt = latest.finishedAt
        await persistJob(record)
        await writeMeta({ id: entry.name, dir, meta: await readJsonFile(path.join(dir, 'project.json'), {}) }, (meta) => ({
          ...meta,
          status: 'preflight_failed',
        })).catch(() => {})
        recovered.push({ projectId: entry.name, jobId: latest.id })
      }
      if (recovered.length > 0) console.log(`[${BUNDLE}] marked interrupted jobs:`, recovered)
      return recovered
    })()
    return recoveryPromise
  }

  // -------------------------------------------------------------------------
  // Findings + options
  // -------------------------------------------------------------------------

  async function readCheckFile(dir, name) {
    return readJsonFile(path.join(dir, 'work', 'preflight', 'checks', `${name}.json`), null)
  }

  async function buildEpisodeFindings(dir, ep) {
    const findings = []
    const spoken = await readCheckFile(dir, 'spoken_words')
    if (spoken && Array.isArray(spoken.results)) {
      const row = spoken.results.find((entry) => Number(entry.ep) === ep)
      if (row && typeof row.status === 'string' && row.status.startsWith('FAIL')) {
        const low = String(row.reason || '').includes('below')
        findings.push({
          check: 'spoken_words',
          severity: 'WARN',
          ep,
          paragraph: null,
          line: null,
          kind: 'episode',
          snippet: `本集英文有声台词约 ${row.count} 词，参考范围是 ${row.min ?? 100}–${row.max ?? 350} 词。`,
          suggestion: low
            ? '台词偏少，可能是动作或旁白太多；可以让人物多承担一些关键信息，再重跑前置。'
            : '台词偏多，注意不要为了凑时长删改台词；可先检查是否有重复或可合并的对白。',
        })
      }
    }
    const punctuation = await readCheckFile(dir, 'punctuation')
    if (punctuation && Array.isArray(punctuation.results)) {
      for (const row of punctuation.results.filter((entry) => Number(entry.ep) === ep)) {
        findings.push({
          check: 'punctuation',
          severity: row.severity || 'must_fix',
          ep,
          paragraph: row.paragraph ?? null,
          line: row.line_index ?? null,
          kind: 'dialogue_text',
          snippet: row.context || '这一行标点格式不统一。',
          suggestion: row.suggestion || '请把标点统一成中文剧本格式，不改台词文字。',
          term: row.char || null,
        })
      }
    }
    const pacing = await readCheckFile(dir, 'pacing')
    if (pacing && pacing.subchecks) {
      for (const [subName, sub] of Object.entries(pacing.subchecks)) {
        if (!sub || !Array.isArray(sub.results)) continue
        const row = sub.results.find((entry) => Number(entry.ep) === ep)
        if (!row) continue
        const reasons = subName === 'atom_pacing' ? row.reasons : row.dialogue_reasons
        if (!Array.isArray(reasons) || reasons.length === 0) continue
        if (subName === 'atom_pacing') {
          findings.push({
            check: 'pacing',
            severity: 'WARN',
            ep,
            paragraph: null,
            line: null,
            kind: 'atom_pacing',
            snippet: `本集连续动作段偏多（${reasons.length} 处），画面可能显得偏碎。`,
            suggestion: '可以把连续动作合并成一组，减少镜头切换；这里只提示，不会自动改稿。',
          })
        } else {
          findings.push({
            check: 'pacing',
            severity: 'WARN',
            ep,
            paragraph: null,
            line: null,
            kind: 'dialogue_density',
            snippet: '本集台词偏少、动作偏多，画面可能偏安静。',
            suggestion: '可以增加人物对话或关键动作；这里只提示，不会自动改稿。',
          })
        }
      }
    }
    const protagonist = await readCheckFile(dir, 'protagonist')
    if (protagonist && Array.isArray(protagonist.results)) {
      const row = protagonist.results.find((entry) => Number(entry.ep) === ep)
      if (row && row.status && row.status !== 'OK') {
        const scenePct = Math.round((row.scene_ratio || 0) * 100)
        const dialoguePct = Math.round((row.dialogue_ratio || 0) * 100)
        const statusText = String(row.status).toUpperCase()
        const label = statusText.includes('BORDERLINE')
          ? '主角戏份接近临界'
          : statusText.includes('NO') || statusText === 'NO_PROTAGONIST'
            ? '本集几乎没有主角'
            : statusText.includes('LOW')
              ? '主角戏份偏少'
              : '主角戏份不足'
        const blocked = !statusText.includes('BORDERLINE')
        findings.push({
          check: 'protagonist',
          severity: blocked ? 'BLOCKED' : 'WARN',
          ep,
          paragraph: null,
          line: null,
          kind: 'coverage',
          snippet: `${label}：出场场次占 ${scenePct}%，台词占 ${dialoguePct}%。`,
          suggestion: blocked
            ? '主角需要参与本集核心冲突或承担关键台词；调整后再重跑前置。'
            : '已经接近标准，建议再增加一点主角戏份。',
        })
      }
    }
    const culture = await readCheckFile(dir, 'culture')
    if (culture && Array.isArray(culture.results)) {
      for (const row of culture.results.filter((entry) => Number(entry.ep) === ep)) {
        findings.push({
          check: 'culture',
          severity: row.severity || 'info',
          ep,
          paragraph: row.paragraph ?? null,
          line: row.line_index ?? null,
          kind: row.kind || 'other',
          snippet: row.context || '这一处可能不符合目标地区的文化语境。',
          suggestion: row.suggestion || '请改为文化中性的表达，不要新增原文没有的文化元素。',
          term: row.term || null,
          category: row.category || null,
          fixable: Boolean(row.fixable),
        })
      }
    }
    return findings
  }

  function sanitizeOptions(input) {
    const source = input && typeof input === 'object' ? input : {}
    const result = {}
    const num = (value, min, max) => {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return undefined
      return Math.min(max, Math.max(min, Math.round(parsed)))
    }
    const minWords = num(source.min_words, 10, 2000)
    const maxWords = num(source.max_words, 10, 5000)
    if (minWords !== undefined) result.min_words = minWords
    if (maxWords !== undefined) result.max_words = maxWords
    if (typeof source.forbid_cn_elements === 'boolean') result.forbid_cn_elements = source.forbid_cn_elements
    if (Array.isArray(source.allowed_terms)) {
      result.allowed_terms = source.allowed_terms
        .filter((term) => typeof term === 'string' && term.trim().length > 0)
        .map((term) => term.trim())
        .slice(0, 200)
    }
    if (source.llmCorrection && typeof source.llmCorrection === 'object') {
      const enabled = source.llmCorrection.enabled === true
      const maxCallsPerEpisode = num(source.llmCorrection.maxCallsPerEpisode, 1, 2)
      result.llmCorrection = {
        enabled,
        ...(maxCallsPerEpisode !== undefined ? { maxCallsPerEpisode } : {}),
      }
    }
    const overrides = source.check_overrides && typeof source.check_overrides === 'object' ? source.check_overrides : null
    if (overrides) {
      const pacing = overrides.pacing && typeof overrides.pacing === 'object' ? overrides.pacing : null
      if (pacing) {
        const cleaned = {}
        const mapping = {
          max_atom_run: [2, 50],
          max_atoms_per_spoken: [0.5, 20],
          dup_similarity: [0.1, 1],
          max_dup_pairs: [0, 50],
          max_spoken_run: [2, 100],
          min_atoms_per_spoken: [0, 10],
          spoken_floor: [1, 100],
        }
        for (const [key, [min, max]] of Object.entries(mapping)) {
          const raw = pacing[key]
          if (raw === undefined || raw === null) continue
          const parsed = Number(raw)
          if (!Number.isFinite(parsed)) continue
          const value = max <= 1 ? Math.min(max, Math.max(min, parsed)) : Math.round(Math.min(max, Math.max(min, parsed)))
          cleaned[key] = value
        }
        // An explicit `pacing: {}` means "clear overrides"; keep it in the patch
        // so the merge below can distinguish it from an omitted field.
        result.check_overrides = { pacing: cleaned }
      }
    }
    return result
  }

  async function writeCheckProfile(project, options) {
    const profile = {
      schema: 'lianben/check-profile/1',
      updatedAt: new Date().toISOString(),
      spoken_words: { min: Number(options.min_words) || 100, max: Number(options.max_words) || 350 },
      pacing: (options.check_overrides && options.check_overrides.pacing) || {},
      culture: {
        forbid_cn_elements: options.forbid_cn_elements !== false,
        allowed_terms: Array.isArray(options.allowed_terms) ? options.allowed_terms : [],
      },
    }
    const file = path.join(project.dir, 'check-profile.json')
    await writeJsonAtomic(file, profile)
    return profile
  }

  // -------------------------------------------------------------------------
  // M3 refine helpers
  // -------------------------------------------------------------------------

  async function writeTextAtomic(file, text) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await fs.writeFile(tmp, text, 'utf8')
    let lastError = null
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await fs.rename(tmp, file)
        return
      } catch (error) {
        lastError = error
        const code = String((error && error.code) || '')
        if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(code)) break
        await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)))
      }
    }
    try {
      await fs.rm(file, { force: true })
      await fs.rename(tmp, file)
      return
    } catch (error) {
      lastError = error
    }
    try {
      await fs.rm(tmp, { force: true })
    } catch {
      // ignore cleanup
    }
    throw lastError || new Error(`cannot write ${file}`)
  }

  // -------------------------------------------------------------------------
  // Explicit, deterministic "merge per suggestion" (M6)
  // -------------------------------------------------------------------------

  function mergeBackupDir(project) {
    return path.join(project.dir, 'work', 'merge', 'original')
  }

  function mergeStateFile(project) {
    return path.join(project.dir, 'work', 'merge', 'state.json')
  }

  function epSourceFile(project, ep) {
    return path.join(project.dir, 'work', 'source', `ep${String(Number(ep)).padStart(2, '0')}.md`)
  }

  function cjkCount(text) {
    const matches = String(text || '').match(/[\u4e00-\u9fff]/g)
    return matches ? matches.length : 0
  }

  async function readPacingRows(project) {
    const pacing = await readJsonFile(path.join(project.dir, 'work', 'preflight', 'checks', 'pacing.json'))
    const sub = pacing && pacing.subchecks && pacing.subchecks.atom_pacing
    return {
      pacing,
      rows: sub && Array.isArray(sub.results) ? sub.results : [],
      riskyEps: Array.isArray(pacing && pacing.risky_eps) ? pacing.risky_eps.map(Number) : [],
    }
  }

  async function readEpIndex(project) {
    return readJsonFile(path.join(project.dir, 'work', 'meta', 'ep_index.json'))
  }

  function mergedEpisodeSet(meta) {
    const merge = meta && meta.merge
    if (!merge || !Array.isArray(merge.episodes)) return new Set()
    return new Set(merge.episodes.map((entry) => Number(typeof entry === 'object' ? entry.ep : entry)).filter(Boolean))
  }

  async function mergeSuggestions(project) {
    const meta = (await readProject(project.id))?.meta || project.meta || {}
    const { rows, riskyEps } = await readPacingRows(project)
    const epIndex = await readEpIndex(project)
    const titles = new Map()
    if (epIndex && Array.isArray(epIndex.episodes)) {
      for (const entry of epIndex.episodes) titles.set(Number(entry.ep), entry.title || '')
    }
    const mergedSet = mergedEpisodeSet(meta)
    const episodes = []
    for (const row of rows) {
      const ep = Number(row.ep)
      const targets = Array.isArray(row.merge_targets) ? row.merge_targets : []
      if (!ep || (targets.length === 0 && !mergedSet.has(ep))) continue
      let sourceExists = false
      try {
        await fs.access(epSourceFile(project, ep))
        sourceExists = true
      } catch {
        sourceExists = false
      }
      if (!sourceExists) continue
      episodes.push({
        ep,
        title: titles.get(ep) || `第${ep}集`,
        recommended: riskyEps.includes(ep),
        merged: mergedSet.has(ep),
        atoms: Number(row.atoms) || 0,
        ratio: Number.isFinite(Number(row.ratio)) ? Number(row.ratio) : null,
        targets: targets.map((target) => ({
          start: Number(target.start),
          length: Number(target.length),
          preview: String(target.preview || ''),
        })),
        targetCount: targets.length,
      })
    }
    episodes.sort((left, right) => left.ep - right.ep)
    const selectable = episodes.filter((entry) => entry.targetCount > 0 && !entry.merged)
    const refineState = await readRefineState(project)
    const bgmState = await readBgmState(project)
    const warnings = []
    if (meta.preflightStale) warnings.push('合并后的前置报告仍是合并前基线；炼本读取的是合并后的 work/source。')
    if (refineState && refineState.state && refineState.state !== 'failed' && refineState.state !== 'cancelled') warnings.push('项目已有炼本状态/产物；合并源稿后需在炼本 tab 重跑才会反映合并结果。')
    if (bgmState && bgmState.state && bgmState.state !== 'failed' && bgmState.state !== 'cancelled') warnings.push('项目已有配乐状态/产物；配乐基于炼本产物，合并后应先重跑炼本再决定配乐。')
    return {
      ok: true,
      merge: meta.merge || null,
      preflightStale: Boolean(meta.preflightStale),
      episodes,
      selectable,
      summary: {
        totalTargetEpisodes: episodes.filter((entry) => entry.targetCount > 0).length,
        recommendedEpisodes: episodes.filter((entry) => entry.recommended && entry.targetCount > 0 && !entry.merged).map((entry) => entry.ep),
        mergedEpisodes: episodes.filter((entry) => entry.merged).map((entry) => entry.ep),
        targetRuns: episodes.filter((entry) => !entry.merged).reduce((sum, entry) => sum + entry.targetCount, 0),
        atomsBefore: episodes.filter((entry) => !entry.merged).reduce((sum, entry) => sum + entry.atoms, 0),
      },
      llmMode: {
        available: true,
        default: false,
        maxEpisodes: MAX_LLM_MERGE_EPS,
        note: '可选：调用 LLM 优化合并句面；默认关闭，必须预览+确认，成本按模型用量另计',
      },
      warnings,
    }
  }

  async function buildMergePlans(project, selectedEpisodes) {
    const meta = (await readProject(project.id))?.meta || project.meta || {}
    const mergedSet = mergedEpisodeSet(meta)
    const { rows } = await readPacingRows(project)
    const rowByEp = new Map(rows.map((row) => [Number(row.ep), row]))
    const requested = Array.isArray(selectedEpisodes)
      ? Array.from(new Set(selectedEpisodes.map(Number).filter((ep) => Number.isInteger(ep) && ep > 0)))
      : []
    const episodes = requested.length > 0
      ? requested
      : rows
        .filter((row) => Array.isArray(row.merge_targets) && row.merge_targets.length > 0 && !mergedSet.has(Number(row.ep)))
        .map((row) => Number(row.ep))
    if (episodes.length === 0) throw new Error('没有可合并的集（no merge targets selected）')
    if (episodes.length > 60) throw new Error('一次最多合并 60 集')
    const alreadyMerged = episodes.filter((ep) => mergedSet.has(ep))
    if (alreadyMerged.length > 0) throw new Error(`这些集已经合并过，请先恢复原文：${alreadyMerged.join(', ')}`)
    const epIndex = await readEpIndex(project)
    const titles = new Map()
    if (epIndex && Array.isArray(epIndex.episodes)) {
      for (const entry of epIndex.episodes) titles.set(Number(entry.ep), entry.title || '')
    }
    const plans = []
    for (const ep of episodes) {
      const row = rowByEp.get(ep)
      if (!row) throw new Error(`第${ep}集没有前置 pacing 结果`)
      const targets = Array.isArray(row.merge_targets) ? row.merge_targets : []
      if (targets.length === 0) throw new Error(`第${ep}集没有可合并的连续 △ 段`)
      const file = epSourceFile(project, ep)
      let originalText = ''
      try {
        originalText = await fs.readFile(file, 'utf8')
      } catch {
        throw new Error(`第${ep}集源稿不存在：${path.relative(project.dir, file)}`)
      }
      const plan = buildMergePlan(originalText, targets)
      if (!plan.ok) {
        throw new Error(`第${ep}集合并校验失败：${plan.errors.join('；')}`)
      }
      plans.push({
        ep,
        title: titles.get(ep) || `第${ep}集`,
        sourceFile: path.relative(project.dir, file).replace(/\\/g, '/'),
        originalText,
        newText: plan.text,
        atomsBefore: plan.beforeAtoms,
        atomsAfter: plan.afterAtoms,
        removed: plan.removed,
        targets: plan.targets.map((target) => ({
          start: target.start,
          length: target.length,
          rawStart: target.rawStart,
          rawEnd: target.rawEnd,
          before: target.before,
          after: target.merged,
        })),
      })
    }
    return plans
  }

  function mergePreview(plans) {
    return {
      episodes: plans.map((plan) => ({
        ep: plan.ep,
        title: plan.title,
        sourceFile: plan.sourceFile,
        atomsBefore: plan.atomsBefore,
        atomsAfter: plan.atomsAfter,
        removed: plan.removed,
        targetCount: plan.targets.length,
        targets: plan.targets.map((target) => ({
          start: target.start,
          length: target.length,
          before: target.before,
          after: target.after.length > 300 ? `${target.after.slice(0, 300)}…` : target.after,
        })),
      })),
      atomsBefore: plans.reduce((sum, plan) => sum + plan.atomsBefore, 0),
      atomsAfter: plans.reduce((sum, plan) => sum + plan.atomsAfter, 0),
      removed: plans.reduce((sum, plan) => sum + plan.removed, 0),
      deterministic: true,
      aiUsed: false,
    }
  }

  function mergeStagingDir(project) {
    return path.join(project.dir, 'work', 'merge', 'staging')
  }

  function charCoverage(originalContent, mergedContent) {
    const counts = new Map()
    let total = 0
    for (const ch of originalContent) {
      if (/\s/.test(ch)) continue
      counts.set(ch, (counts.get(ch) || 0) + 1)
      total += 1
    }
    if (total === 0) return 1
    let kept = 0
    for (const ch of mergedContent) {
      const count = counts.get(ch) || 0
      if (count > 0) {
        counts.set(ch, count - 1)
        kept += 1
      }
    }
    return Number((kept / total).toFixed(4))
  }

  function buildLlmReplacementText(originalText, planTargets, runs) {
    const byId = new Map(runs.map((run) => [Number(run.id), run.lines]))
    const rawLines = String(originalText == null ? '' : originalText).split(/\r?\n/)
    const replacements = []
    for (let id = 0; id < planTargets.length; id += 1) {
      const target = planTargets[id]
      const lines = byId.get(id)
      if (!Array.isArray(lines) || lines.length === 0) throw new Error(`LLM 目标块 ${id} 缺少合并行`)
      replacements.push({ ...target, lines: lines.map((line) => String(line).trim()) })
    }
    const outputLines = rawLines.slice()
    for (const replacement of replacements.slice().sort((left, right) => right.rawStart - left.rawStart)) {
      outputLines.splice(replacement.rawStart, replacement.rawEnd - replacement.rawStart + 1, ...replacement.lines)
    }
    const text = outputLines.join('\n')
    const beforeAtoms = (originalText.match(/^△/gm) || []).length
    const afterAtoms = (text.match(/^△/gm) || []).length
    if (afterAtoms >= beforeAtoms) throw new Error('LLM 合并后 △ 条数没有减少')
    const originalNonAtoms = rawLines.filter((line) => !line.trim().startsWith('△'))
    const newNonAtoms = outputLines.filter((line) => !line.trim().startsWith('△'))
    if (originalNonAtoms.length !== newNonAtoms.length || originalNonAtoms.some((line, index) => line !== newNonAtoms[index])) {
      throw new Error('LLM 输出改动了非 △ 行')
    }
    const originalContent = planTargets
      .map((target) => target.before.map((line) => line.replace(/^△\s*/, '').trim()).join(''))
      .join('')
    const mergedContent = replacements
      .map((replacement) => replacement.lines.map((line) => line.replace(/^△\s*/, '').trim()).join(''))
      .join('')
    const coverage = charCoverage(originalContent, mergedContent)
    if (coverage < 0.8) throw new Error(`LLM 合并内容保真度不足（字符覆盖 ${Math.round(coverage * 100)}% < 80%）`)
    return {
      text,
      beforeAtoms,
      afterAtoms,
      removed: beforeAtoms - afterAtoms,
      coverage,
      warnings: coverage < 0.98 ? [`LLM 合并字符覆盖 ${Math.round(coverage * 100)}%，请逐块核对事实`] : [],
      replacements,
    }
  }

  async function pruneMergeStaging(project, keep = 20) {
    const dir = mergeStagingDir(project)
    let names = []
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    const files = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = path.join(dir, name)
      try {
        files.push({ file, mtime: (await fs.stat(file)).mtimeMs })
      } catch {
        // ignore
      }
    }
    files.sort((left, right) => right.mtime - left.mtime)
    for (const entry of files.slice(keep)) {
      await fs.rm(entry.file, { force: true }).catch(() => {})
    }
  }

  async function buildLlmMergePreview(project, selectedEpisodes) {
    if (projectActive.has(project.id)) throw new Error('project is busy')
    const plans = await buildMergePlans(project, selectedEpisodes)
    if (plans.length > MAX_LLM_MERGE_EPS) {
      throw new Error(`LLM 优化一次最多 ${MAX_LLM_MERGE_EPS} 集（已选 ${plans.length} 集）；其余建议可用确定性合并`)
    }
    const previewId = `mv-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 6)}`
    const tokens = emptyTokens()
    const cost = emptyCost()
    let model = null
    const episodes = []
    for (const plan of plans) {
      const prompt = buildMergeLlmPrompt({
        ep: plan.ep,
        title: plan.title,
        targets: plan.targets.map((target) => ({ lines: target.before, length: target.length })),
      })
      const answer = await callDirector(prompt, null)
      if (answer.model) model = answer.model
      if (answer.usage) addTokens(tokens, answer.usage)
      const callCost = costForUsage(answer.usage || {}, new Date())
      addCost(cost, callCost)
      await appendTokenLog(project, {
        at: new Date().toISOString(),
        stage: 'merge-llm',
        ep: plan.ep,
        provider: answer.provider || null,
        model: answer.model || null,
        usage: answer.usage || null,
        cost: callCost,
      }).catch(() => {})
      const parsed = parseMergeLlmOutput(answer.text, plan.targets)
      if (!parsed.ok) throw new Error(`第${plan.ep}集 LLM 输出无效：${parsed.errors.join('；')}`)
      const built = buildLlmReplacementText(plan.originalText, plan.targets, parsed.runs)
      const sourceSha = await sha256File(epSourceFile(project, plan.ep))
      episodes.push({
        ep: plan.ep,
        title: plan.title,
        sourceFile: plan.sourceFile,
        sourceSha,
        originalText: plan.originalText,
        newText: built.text,
        atomsBefore: built.beforeAtoms,
        atomsAfter: built.afterAtoms,
        removed: built.removed,
        coverage: built.coverage,
        warnings: built.warnings,
        targets: built.replacements.map((replacement) => ({
          start: replacement.start,
          length: replacement.length,
          before: replacement.before,
          after: replacement.lines,
        })),
      })
    }
    const staging = {
      schema: 'lianben/merge_staging/1',
      previewId,
      projectId: project.id,
      mode: 'llm',
      at: new Date().toISOString(),
      model,
      tokens,
      cost,
      episodes,
    }
    await fs.mkdir(mergeStagingDir(project), { recursive: true })
    await writeJsonAtomic(path.join(mergeStagingDir(project), `${previewId}.json`), staging)
    await pruneMergeStaging(project)
    return {
      ok: true,
      dryRun: true,
      mode: 'llm',
      previewId,
      aiUsed: true,
      model,
      tokens,
      cost,
      calls: episodes.length,
      preview: {
        mode: 'llm',
        deterministic: false,
        aiUsed: true,
        previewId,
        model,
        tokens,
        cost,
        episodes: episodes.map((episode) => ({
          ep: episode.ep,
          title: episode.title,
          atomsBefore: episode.atomsBefore,
          atomsAfter: episode.atomsAfter,
          removed: episode.removed,
          coverage: episode.coverage,
          warnings: episode.warnings,
          targetCount: episode.targets.length,
          targets: episode.targets.map((target) => ({
            start: target.start,
            length: target.length,
            before: target.before,
            after: target.after.join('\n').slice(0, 300),
          })),
        })),
        atomsBefore: episodes.reduce((sum, episode) => sum + episode.atomsBefore, 0),
        atomsAfter: episodes.reduce((sum, episode) => sum + episode.atomsAfter, 0),
        removed: episodes.reduce((sum, episode) => sum + episode.removed, 0),
        warnings: episodes.flatMap((episode) => episode.warnings),
      },
    }
  }

  async function applyLlmMergePreview(project, previewId) {
    if (projectActive.has(project.id)) throw new Error('project is busy')
    if (!previewId) throw new Error('previewId is required for LLM merge apply')
    const stagingPath = path.join(mergeStagingDir(project), `${previewId}.json`)
    const staging = await readJsonFile(stagingPath)
    if (!staging || staging.schema !== 'lianben/merge_staging/1' || staging.projectId !== project.id) {
      throw new Error('LLM 合并预览不存在或已过期，请重新预览')
    }
    const plans = []
    for (const episode of staging.episodes || []) {
      const file = epSourceFile(project, episode.ep)
      const currentSha = await sha256File(file)
      if (currentSha !== episode.sourceSha) throw new Error(`第${episode.ep}集源稿在预览后发生变化，请重新预览`)
      plans.push({
        ep: episode.ep,
        title: episode.title,
        sourceFile: episode.sourceFile,
        originalText: episode.originalText,
        newText: episode.newText,
        atomsBefore: episode.atomsBefore,
        atomsAfter: episode.atomsAfter,
        removed: episode.removed,
        targets: Array.isArray(episode.targets) ? episode.targets : [],
      })
    }
    const applied = await applyMergePlans(project, plans)
    const merged = {
      ...applied.merge,
      mode: 'llm',
      llm: {
        model: staging.model || null,
        tokens: staging.tokens || null,
        cost: staging.cost || null,
        previewId,
        calls: (staging.episodes || []).length,
        coverage: (staging.episodes || []).length > 0
          ? Number(((staging.episodes.reduce((sum, episode) => sum + (Number(episode.coverage) || 0), 0)) / staging.episodes.length).toFixed(4))
          : null,
      },
    }
    const nextMeta = await writeMeta(project, (meta) => ({ ...meta, merge: merged }))
    await writeJsonAtomic(mergeStateFile(project), { schema: 'lianben/merge_state/1', ...merged, project: project.id })
    await fs.rm(stagingPath, { force: true }).catch(() => {})
    return { ok: true, at: applied.at, applied: applied.applied, merge: merged, meta: nextMeta }
  }


  async function applyLlmBatchPreviews(project, previewIds) {
    if (projectActive.has(project.id)) throw new Error('project is busy')
    const ids = Array.isArray(previewIds)
      ? Array.from(new Set(previewIds.map((value) => String(value || '').trim()).filter(Boolean)))
      : []
    if (ids.length === 0) throw new Error('previewIds is required for batch LLM merge apply')
    if (ids.length > 20) throw new Error('一次最多应用 20 个 LLM 预览批次')
    const stagingItems = []
    for (const previewId of ids) {
      const stagingPath = path.join(mergeStagingDir(project), `${previewId}.json`)
      const staging = await readJsonFile(stagingPath)
      if (!staging || staging.schema !== 'lianben/merge_staging/1' || staging.projectId !== project.id) {
        throw new Error(`LLM 合并预览 ${previewId} 不存在或已过期，请重新预览`)
      }
      stagingItems.push({ previewId, stagingPath, staging })
    }
    const seen = new Set()
    const plans = []
    const tokens = emptyTokens()
    const cost = emptyCost()
    let model = null
    const coverageValues = []
    const applyItems = []
    for (const item of stagingItems) {
      if (item.staging.model) model = item.staging.model
      if (item.staging.tokens) {
        for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
          tokens[key] = Number(tokens[key] || 0) + Number(item.staging.tokens[key] || 0)
        }
        tokens.calls += Number(item.staging.tokens.calls) || 0
      }
      if (item.staging.cost) {
        for (const key of ['total', 'input', 'cacheRead', 'output']) {
          cost[key] = Number(cost[key] || 0) + Number(item.staging.cost[key] || 0)
        }
        cost.calls += Number(item.staging.cost.calls) || 0
      }
      for (const episode of item.staging.episodes || []) {
        const ep = Number(episode.ep)
        if (seen.has(ep)) throw new Error(`第${ep}集在多个预览批次中重复`)
        seen.add(ep)
        const file = epSourceFile(project, ep)
        const currentSha = await sha256File(file)
        if (currentSha !== episode.sourceSha) throw new Error(`第${ep}集源稿在预览后发生变化，请重新预览`)
        plans.push({
          ep,
          title: episode.title,
          sourceFile: episode.sourceFile,
          originalText: episode.originalText,
          newText: episode.newText,
          atomsBefore: episode.atomsBefore,
          atomsAfter: episode.atomsAfter,
          removed: episode.removed,
          targets: Array.isArray(episode.targets) ? episode.targets : [],
        })
        coverageValues.push(Number(episode.coverage) || 0)
        applyItems.push(item)
      }
    }
    const applied = await applyMergePlans(project, plans)
    const merged = {
      ...applied.merge,
      mode: 'llm',
      llm: {
        model: model || null,
        tokens,
        cost,
        previewId: ids.length === 1 ? ids[0] : null,
        previewIds: ids,
        batch: true,
        calls: plans.length,
        coverage: coverageValues.length > 0
          ? Number((coverageValues.reduce((sum, value) => sum + value, 0) / coverageValues.length).toFixed(4))
          : null,
      },
    }
    const nextMeta = await writeMeta(project, (meta) => ({ ...meta, merge: merged }))
    await writeJsonAtomic(mergeStateFile(project), { schema: 'lianben/merge_state/1', ...merged, project: project.id })
    for (const item of applyItems) {
      await fs.rm(item.stagingPath, { force: true }).catch(() => {})
    }
    return { ok: true, at: applied.at, applied: applied.applied, merge: merged, meta: nextMeta }
  }

  async function applyMergePlans(project, plans) {
    if (projectActive.has(project.id)) throw new Error('project is busy')
    await fs.mkdir(mergeBackupDir(project), { recursive: true })
    const epIndex = (await readEpIndex(project)) || { episodes: [] }
    const entries = Array.isArray(epIndex.episodes) ? epIndex.episodes : []
    const at = new Date().toISOString()
    const applied = []
    // Backups first: if anything fails before source writes, no source is touched.
    for (const plan of plans) {
      const backup = path.join(mergeBackupDir(project), `ep${String(plan.ep).padStart(2, '0')}.md`)
      try {
        await fs.access(backup)
      } catch {
        await writeTextAtomic(backup, plan.originalText)
      }
    }
    for (const plan of plans) {
      const file = epSourceFile(project, plan.ep)
      await writeTextAtomic(file, plan.newText)
      const sha = await sha256File(file)
      const entry = entries.find((item) => Number(item.ep) === Number(plan.ep))
      if (entry) {
        entry.lines = plan.newText.split(/\r?\n/).length
        entry.atoms = plan.atomsAfter
        entry.cjk = cjkCount(plan.newText)
        entry.sha256 = sha
      }
      applied.push({
        ep: plan.ep,
        title: plan.title,
        sourceFile: plan.sourceFile,
        atomsBefore: plan.atomsBefore,
        atomsAfter: plan.atomsAfter,
        removed: plan.removed,
        targetCount: plan.targets.length,
        sha256: sha,
        lines: plan.newText.split(/\r?\n/).length,
        backup: `work/merge/original/ep${String(plan.ep).padStart(2, '0')}.md`,
      })
    }
    await writeJsonAtomic(path.join(project.dir, 'work', 'meta', 'ep_index.json'), epIndex)
    const merge = {
      schema: 'lianben/merge/1',
      at,
      deterministic: true,
      aiUsed: false,
      backupDir: 'work/merge/original',
      episodes: applied,
      atomsBefore: applied.reduce((sum, entry) => sum + entry.atomsBefore, 0),
      atomsAfter: applied.reduce((sum, entry) => sum + entry.atomsAfter, 0),
      removed: applied.reduce((sum, entry) => sum + entry.removed, 0),
    }
    const nextMeta = await writeMeta(project, (meta) => {
      const history = Array.isArray(meta.mergeHistory) ? meta.mergeHistory.slice(-9) : []
      history.push({ at, episodes: applied.map((entry) => entry.ep), atomsBefore: merge.atomsBefore, atomsAfter: merge.atomsAfter })
      return { ...meta, merge, preflightStale: true, mergeHistory: history }
    })
    await writeJsonAtomic(mergeStateFile(project), { schema: 'lianben/merge_state/1', ...merge, project: project.id })
    return { ok: true, at, applied, merge, meta: nextMeta }
  }

  async function restoreMerge(project) {
    if (projectActive.has(project.id)) throw new Error('project is busy')
    const latest = await readProject(project.id)
    const meta = latest ? latest.meta : project.meta
    const merge = meta && meta.merge
    if (!merge || !Array.isArray(merge.episodes) || merge.episodes.length === 0) throw new Error('当前项目没有可恢复的合并记录')
    const epIndex = await readEpIndex(project)
    const entries = epIndex && Array.isArray(epIndex.episodes) ? epIndex.episodes : []
    const restoreItems = []
    for (const item of merge.episodes) {
      const ep = Number(item.ep)
      const backup = path.join(mergeBackupDir(project), `ep${String(ep).padStart(2, '0')}.md`)
      let text = ''
      try {
        text = await fs.readFile(backup, 'utf8')
      } catch {
        throw new Error(`第${ep}集备份缺失：${path.relative(project.dir, backup)}`)
      }
      restoreItems.push({ ep, text, file: epSourceFile(project, ep), entry: entries.find((entry) => Number(entry.ep) === ep) })
    }
    const at = new Date().toISOString()
    const restored = []
    for (const item of restoreItems) {
      await writeTextAtomic(item.file, item.text)
      const sha = await sha256File(item.file)
      if (item.entry) {
        item.entry.lines = item.text.split(/\r?\n/).length
        item.entry.atoms = (item.text.match(/^△/gm) || []).length
        item.entry.cjk = cjkCount(item.text)
        item.entry.sha256 = sha
      }
      restored.push({ ep: item.ep, sha256: sha })
    }
    await writeJsonAtomic(path.join(project.dir, 'work', 'meta', 'ep_index.json'), epIndex)
    const nextMeta = await writeMeta(project, (current) => {
      const history = Array.isArray(current.mergeHistory) ? current.mergeHistory.slice(-9) : []
      history.push({ at, restored: restored.map((entry) => entry.ep) })
      return { ...current, merge: null, preflightStale: false, mergeHistory: history }
    })
    await writeJsonAtomic(mergeStateFile(project), { schema: 'lianben/merge_state/1', restoredAt: at, restored, project: project.id })
    return { ok: true, at, restored, meta: nextMeta }
  }


  function emptyTokens() {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, calls: 0 }
  }

  function addTokens(target, usage) {
    if (!usage || typeof usage !== 'object') return target
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'reasoningTokens']) {
      if (typeof usage[key] === 'number') target[key] = (target[key] || 0) + usage[key]
    }
    target.calls = (target.calls || 0) + 1
    return target
  }

  async function resolveLlmTarget() {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') throw new Error('llm service unavailable')
    let provider = null
    let model = null
    const defaultModel = ctx.get('agentDefaultModel')
    if (defaultModel && typeof defaultModel.currentSelection === 'function') {
      const selection = defaultModel.currentSelection()
      provider = selection && typeof selection.provider === 'string' ? selection.provider : null
      model = selection && typeof selection.model === 'string' ? selection.model : null
    }
    if (!provider || !model) {
      const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
      const first = Array.isArray(providers) ? providers[0] : null
      provider = first ? first.id || first.provider : null
      if (provider && typeof llm.listModels === 'function') {
        const models = await llm.listModels(provider)
        model = Array.isArray(models) && models[0] ? models[0].id : null
      }
    }
    if (!provider || !model) throw new Error('no default LLM model available')
    return { llm, provider, model }
  }

  function normalizePromptMessages(messages) {
    if (!Array.isArray(messages)) return []
    return messages.map((message) => {
      if (typeof message === 'string') return { role: 'user', content: [{ type: 'text', text: message }] }
      if (message && typeof message === 'object' && typeof message.content === 'string') {
        return { role: message.role || 'user', content: [{ type: 'text', text: message.content }] }
      }
      return message
    })
  }

  async function callDirector(prompt, signal, onTextDelta) {
    const { llm, provider, model } = await resolveLlmTarget()
    let text = ''
    let usage = null
    let finish = null
    let error = null
    const chunkTypes = {}
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('director timeout')), DIRECTOR_TIMEOUT_MS)
    const combinedSignal = signal ? AbortSignal.any ? AbortSignal.any([signal, controller.signal]) : controller.signal : controller.signal
    try {
      const stream = llm.stream({
        provider,
        model,
        system: prompt.system,
        messages: normalizePromptMessages(prompt.messages),
        maxTokens: Math.max(Number(prompt.maxTokens) || 0, DIRECTOR_MAX_TOKENS),
        temperature: typeof prompt.temperature === 'number' ? prompt.temperature : 0.4,
        reasoningEffort: 'low',
        signal: combinedSignal,
      })
      for await (const chunk of stream) {
        if (!chunk || typeof chunk.type !== 'string') continue
        chunkTypes[chunk.type] = (chunkTypes[chunk.type] || 0) + 1
        if (chunk.type === 'text-delta') {
          text += chunk.text
          if (typeof onTextDelta === 'function' && chunk.text) {
            try {
              onTextDelta(chunk.text)
            } catch {
              // live preview is best-effort; never fail the model call for it
            }
          }
        } else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') {
          finish = chunk.reason
          if (chunk.reason && chunk.reason.kind === 'error') {
            error = (chunk.reason.failure && chunk.reason.failure.message) || 'llm error'
          }
          if (chunk.reason && chunk.reason.kind === 'aborted' && !error) error = 'aborted'
        }
      }
    } catch (caught) {
      if (signal && signal.aborted) throw new Error('cancelled')
      error = String((caught && caught.message) || caught)
    } finally {
      clearTimeout(timer)
    }
    if (error) throw new Error(error)
    return { text, usage, finish, chunkTypes, provider, model }
  }

  async function appendTokenLog(project, entry) {
    const file = path.join(project.dir, 'work', 'logs', 'tokens.ndjson')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  async function ensureProjectToolchain(project) {
    const toolsDir = path.join(project.dir, 'tools')
    const mode = modeOf(project.meta)
    const is20 = mode === MODE_20
    const revision = is20 ? TOOLCHAIN2_REVISION : TOOLCHAIN_REVISION
    const sourceDir = is20 ? path.join(ENGINE2_DIR, 'tools') : path.join(ENGINE_DIR, 'tools')
    const marker = path.join(toolsDir, is20 ? '.engine2_version' : '.engine_version')
    let current = null
    try {
      current = (await fs.readFile(marker, 'utf8')).trim()
    } catch {
      current = null
    }
    if (current === revision) return toolsDir
    await fs.mkdir(toolsDir, { recursive: true })
    await fs.cp(sourceDir, toolsDir, { recursive: true, force: true })
    await fs.writeFile(marker, `${revision}\n`, 'utf8')
    return toolsDir
  }

  async function runProjectScript(project, scriptName, args = [], options = {}) {
    const python = await probePython()
    if (!python.ok) return { ok: false, exitCode: null, error: python.error || 'python unavailable' }
    const toolsDir = await ensureProjectToolchain(project)
    const subprocess = ctx.get('subprocess')
    if (!subprocess) return { ok: false, exitCode: null, error: 'subprocess service unavailable' }
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs || SCRIPT_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(new Error('script timeout')), timeoutMs)
    try {
      const handle = subprocess.spawn({
        argv: [python.python, path.join(toolsDir, scriptName), ...args.map((value) => String(value))],
        cwd: project.dir,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 4 * 1024 * 1024 },
          stderr: { maxBytes: 2 * 1024 * 1024 },
        },
        graceMs: 3000,
        signal: controller.signal,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      })
      const outcome = await handle.done
      return {
        ok: outcome.exitCode === 0,
        exitCode: outcome.exitCode,
        stdout: readCollected(handle, 'stdout'),
        stderr: readCollected(handle, 'stderr'),
        signal: outcome.signal,
      }
    } catch (error) {
      return { ok: false, exitCode: null, error: String((error && error.message) || error) }
    } finally {
      clearTimeout(timer)
    }
  }

  async function readEpisodeCheck(project, ep) {
    const padded = String(ep).padStart(2, '0')
    return readJsonFile(path.join(project.dir, 'work', 'report', `check_ep${padded}.json`), null)
  }

  async function runCheckEp(project, ep, extra = []) {
    const result = await runProjectScript(project, 'check_ep.py', ['--eps', String(ep), ...extra], { timeoutMs: SCRIPT_TIMEOUT_MS })
    const check = await readEpisodeCheck(project, ep)
    const hardFails = check && Array.isArray(check.fails)
      ? check.fails.filter((item) => {
          const text = String(item)
          return !text.startsWith('fmt:') && !text.startsWith('warn')
        })
      : []
    const warns = check && Array.isArray(check.warns) ? check.warns.map(String) : []
    return { ok: result.exitCode === 0, exitCode: result.exitCode, hardFails, warns, check, stdout: result.stdout, stderr: result.stderr }
  }

  async function writeDirectorArtifacts(project, ep, parsed) {
    const padded = String(ep).padStart(2, '0')
    const draftPath = path.join(project.dir, 'work', 'draft', `ep${padded}.md`)
    const reportPath = path.join(project.dir, 'work', 'report', `ep${padded}.json`)
    const notesPath = path.join(project.dir, 'work', 'report', `ep${padded}_production_notes.md`)
    const draft = String(parsed.draft || '')
      .replace(/^```(?:markdown|md)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim()
    await writeTextAtomic(draftPath, `${draft}\n`)
    const report = parsed.report && typeof parsed.report === 'object' ? { ...parsed.report } : {}
    report.ep = ep
    if (!report.status) report.status = 'OK'
    await writeJsonAtomic(reportPath, report)
    await writeTextAtomic(notesPath, `${String(parsed.notes || '').trim()}\n`)
    return {
      draft: `work/draft/ep${padded}.md`,
      report: `work/report/ep${padded}.json`,
      notes: `work/report/ep${padded}_production_notes.md`,
    }
  }

  async function refineTargets(project, requested) {
    const index = await readJsonFile(path.join(project.dir, 'work', 'meta', 'ep_index.json'), null)
    const indexEpisodes = index && Array.isArray(index.episodes) ? index.episodes : []
    const all = indexEpisodes.map((episode) => Number(episode.ep)).filter((value) => Number.isFinite(value))
    const progress = await readJsonFile(path.join(project.dir, 'work', 'meta', 'progress.json'), null)
    const progressEpisodes = progress && progress.episodes ? progress.episodes : {}
    const blocked = new Set()
    const protagonist = await readJsonFile(path.join(project.dir, 'work', 'preflight', 'protagonist.json'), null)
    if (protagonist && Array.isArray(protagonist.blocked_eps)) {
      for (const ep of protagonist.blocked_eps) blocked.add(Number(ep))
    }
    for (const [key, value] of Object.entries(progressEpisodes)) {
      if (value && value.status === 'blocked') blocked.add(Number(key))
    }
    const requestedList = Array.isArray(requested) ? requested.map(Number).filter((value) => Number.isFinite(value)) : null
    const targets = requestedList
      ? requestedList.filter((ep) => all.includes(ep) && !blocked.has(ep))
      : all.filter((ep) => {
          if (blocked.has(ep)) return false
          const status = progressEpisodes[String(ep)] && progressEpisodes[String(ep)].status
          return !(status === 'passed' || status === 'passed-with-issues')
        })
    return {
      targets: [...new Set(targets)].sort((left, right) => left - right),
      blocked: [...blocked].sort((left, right) => left - right),
      total: all.length,
      titles: Object.fromEntries(indexEpisodes.map((episode) => [Number(episode.ep), episode.title || ''])),
    }
  }

  function newRefineState(jobId, targets) {
    const now = new Date().toISOString()
    return {
      schema: 'lianben/refine_state/1',
      jobId,
      state: 'running',
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      progress: { total: targets.length, pending: targets.length, running: 0, passed: 0, issues: 0, blocked: 0, failed: 0 },
      episodes: {},
      artifacts: null,
      tokens: emptyTokens(),
      cost: emptyCost(),
      budget: {
        stage: 'refine',
        limitTokens: Math.max(REFINE_BUDGET_PER_EP, Math.ceil(targets.length * REFINE_BUDGET_PER_EP * 1.25)),
        spentTokens: 0,
        ratio: 0,
        warning: false,
        exceeded: false,
      },
      checkPassRate: null,
    }
  }

  function recomputeRefineProgress(state) {
    const entries = Object.values(state.episodes)
    state.progress = {
      total: entries.length,
      pending: entries.filter((entry) => entry.state === 'pending').length,
      running: entries.filter((entry) => entry.state === 'running').length,
      passed: entries.filter((entry) => entry.state === 'passed').length,
      issues: entries.filter((entry) => entry.state === 'passed-with-issues').length,
      blocked: Array.isArray(state.blockedEps) ? state.blockedEps.length : (state.progress ? state.progress.blocked : 0),
      failed: entries.filter((entry) => entry.state === 'failed').length,
    }
    state.updatedAt = new Date().toISOString()
    return state
  }

  async function persistRefineState(project, state) {
    recomputeRefineProgress(state)
    await writeJsonAtomic(path.join(project.dir, 'work', 'meta', 'refine_state.json'), state)
  }

  function refineSummary(state) {
    if (!state || typeof state !== 'object') return null
    let cost = state.cost || null
    if (!cost && state.tokens) {
      const finishedAt = state.finishedAt || state.startedAt
      cost = {
        ...costForTokenLedger(state.tokens, new Date(finishedAt || Date.now())),
        estimated: true,
      }
    }
    return {
      schema: state.schema || 'lianben/refine_state/1',
      jobId: state.jobId || null,
      state: state.state || 'unknown',
      startedAt: state.startedAt || null,
      finishedAt: state.finishedAt || null,
      progress: state.progress || null,
      blockedEps: Array.isArray(state.blockedEps) ? state.blockedEps : [],
      tokens: state.tokens || null,
      cost,
      budget: state.budget || null,
      artifacts: state.artifacts || null,
      checkPassRate: state.checkPassRate || null,
    }
  }

  async function readRefineState(project) {
    return readJsonFile(path.join(project.dir, 'work', 'meta', 'refine_state.json'), null)
  }

  async function latestRefineJob(project) {
    const dir = path.join(project.dir, 'work', 'meta', 'jobs')
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }
    let latest = null
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const job = await readJsonFile(path.join(dir, entry.name), null)
      if (!job || job.kind !== 'refine') continue
      if (!latest || String(job.updatedAt || '').localeCompare(String(latest.updatedAt || '')) > 0) latest = job
    }
    return latest
  }

  function emptyRefineEpisode(ep, title) {
    return {
      ep,
      title: title || '',
      state: 'pending',
      attempts: 0,
      check: null,
      artifacts: null,
      tokens: emptyTokens(),
      cost: emptyCost(),
      error: null,
      statusLine: null,
    }
  }

  async function runPool(items, limit, worker, signal) {
    let index = 0
    const width = Math.max(1, Math.min(items.length, limit))
    async function runner() {
      while (true) {
        if (signal && signal.aborted) throw new Error('cancelled')
        const current = index
        index += 1
        if (current >= items.length) return
        await worker(items[current], current)
      }
    }
    await Promise.all(Array.from({ length: width }, runner))
  }

  async function runRefineEpisode({ project, context, ep, record, refineState, log }) {
    const entry = refineState.episodes[ep] || emptyRefineEpisode(ep, '')
    refineState.episodes[ep] = entry
    entry.state = 'running'
    entry.attempts = 0
    entry.error = null
    await persistRefineState(project, refineState)
    emitJob(record, { type: 'episode', ep, state: 'running', attempts: 0 })
    let retryText = ''
    let previousDraft = null
    const maxAttempts = 1 + Math.max(0, Math.min(2, Number((config.refine && config.refine.maxRetries) ?? 2)))
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (record.controller.signal.aborted) throw new Error('cancelled')
        entry.attempts = attempt
        emitJob(record, { type: 'phase', phase: attempt === 1 ? 'write' : 'retry', index: attempt === 1 ? 1 : 3, total: REFINE_PHASES.length })
        await updateJob(record, { phase: attempt === 1 ? 'write' : 'retry', phaseIndex: attempt === 1 ? 1 : 3 }, { persist: false })
        emitJob(record, { type: 'log', level: 'info', message: `EP${ep} attempt ${attempt} director start` })
        const prompt = buildDirectorPrompt({ context, projectDir: project.dir, ep, retryText, previousDraft })
        const promptChars = JSON.stringify(prompt).length
        emitJob(record, { type: 'director-start', ep, attempt, promptChars })
        let deltaBuffer = ''
        let lastDeltaAt = Date.now()
        const flushDirectorDelta = () => {
          if (!deltaBuffer) return
          const chunk = deltaBuffer
          deltaBuffer = ''
          emitJob(record, { type: 'director-delta', ep, attempt, delta: chunk })
          lastDeltaAt = Date.now()
        }
        const onTextDelta = (delta) => {
          if (!delta) return
          deltaBuffer += delta
          if (deltaBuffer.length >= 1200 || Date.now() - lastDeltaAt >= 200) flushDirectorDelta()
        }
        const calledAt = Date.now()
        let llmResult
        try {
          llmResult = await callDirector(prompt, record.controller.signal, onTextDelta)
        } finally {
          flushDirectorDelta()
        }
        const durationMs = Date.now() - calledAt
        emitJob(record, {
          type: 'director-end',
          ep,
          attempt,
          chars: String(llmResult.text || '').length,
          finish: llmResult.finish || null,
        })
        const callCost = costForUsage(llmResult.usage || {}, new Date())
        if (!entry.cost) entry.cost = emptyCost()
        addCost(entry.cost, callCost)
        if (!refineState.cost) refineState.cost = emptyCost()
        addCost(refineState.cost, callCost)
        addTokens(entry.tokens, llmResult.usage)
        addTokens(refineState.tokens, llmResult.usage)
        updateBudget(refineState, 'refine', record, log)
        const padded = String(ep).padStart(2, '0')
        const rawDir = path.join(project.dir, 'work', 'logs', 'llm')
        await fs.mkdir(rawDir, { recursive: true })
        const rawText = String(llmResult.text || '')
        await writeTextAtomic(path.join(rawDir, `ep${padded}-attempt${attempt}.txt`), rawText.slice(0, 400_000))
        await writeJsonAtomic(path.join(rawDir, `ep${padded}-attempt${attempt}.json`), {
          ep,
          attempt,
          provider: llmResult.provider,
          model: llmResult.model,
          finish: llmResult.finish,
          chunkTypes: llmResult.chunkTypes,
          usage: llmResult.usage || null,
          cost: callCost,
          promptChars,
          rawChars: rawText.length,
          durationMs,
          retryText,
        })
        await appendTokenLog(project, {
          ts: new Date().toISOString(),
          jobId: jobIdOfRecord(record),
          ep,
          attempt,
          provider: llmResult.provider,
          model: llmResult.model,
          usage: llmResult.usage || null,
          cost: callCost,
          tariff: callCost.tariff,
          finish: llmResult.finish,
          chunkTypes: llmResult.chunkTypes,
          promptChars,
          rawChars: rawText.length,
          durationMs,
        })
        emitJob(record, {
          type: 'token',
          ep,
          usage: llmResult.usage || null,
          cost: callCost,
          costTotal: refineState.cost ? { ...refineState.cost } : { ...callCost },
          budget: refineState.budget || null,
        })
        const parsed = parseDirectorOutput(llmResult.text)
        if (!parsed.ok) {
          const truncated = llmResult.finish && llmResult.finish.kind === 'max-tokens'
          retryText = truncated
            ? '上一次输出达到长度上限被截断：这次必须精简，不要复述已给规则，不要长推理，直接依次输出五个哨兵段；优先保证 DRAFT_MD 完整，REPORT_JSON 只保留必需字段。'
            : `上一次输出解析失败：${(parsed.errors || []).join('; ') || '未知解析错误'}\n请严格按哨兵段输出，不要省略段落或使用代码围栏。`
          previousDraft = String(llmResult.text || '').slice(0, 2000)
          entry.error = truncated ? 'output max-tokens truncation' : 'parse failed'
          log.push(`EP${ep} attempt ${attempt} ${truncated ? 'truncated' : 'parse failed'}`)
          if (attempt >= maxAttempts) {
            entry.state = 'failed'
            break
          }
          continue
        }
        entry.error = null
        entry.statusLine = parsed.statusLine || null
        entry.artifacts = await writeDirectorArtifacts(project, ep, parsed)
        previousDraft = String(parsed.draft || '').slice(0, 4000)
        emitJob(record, { type: 'phase', phase: 'check', index: 2, total: REFINE_PHASES.length })
        const check = await runCheckEp(project, ep)
        entry.check = { exitCode: check.exitCode, hardFails: check.hardFails, warns: check.warns }
        if (check.ok) {
          entry.state = 'passed'
          break
        }
        log.push(`EP${ep} attempt ${attempt} check failed: ${check.hardFails.slice(0, 3).join(' | ')}`)
        if (attempt < maxAttempts) {
          retryText = buildRetryInstruction(check.hardFails.length > 0 ? check.hardFails : [`check_ep 退出码 ${check.exitCode}`])
          continue
        }
        const degraded = await runCheckEp(project, ep, ['--allow-issue-pass'])
        entry.check = {
          exitCode: degraded.exitCode,
          hardFails: degraded.hardFails,
          warns: degraded.warns,
          allowIssuePass: true,
        }
        entry.state = degraded.ok ? 'passed-with-issues' : 'failed'
        if (!degraded.ok) entry.error = degraded.hardFails.slice(0, 5).join(' | ') || 'check_ep failed after retries'
        log.push(`EP${ep} degraded=${degraded.ok} (${entry.state})`)
        break
      }
    } catch (error) {
      if (record.controller.signal.aborted) throw new Error('cancelled')
      if (error && ['BUDGET_EXCEEDED', 'CANCELLED', 'WORD_LOCKED'].includes(error.code)) throw error
      entry.state = 'failed'
      entry.error = String((error && error.message) || error)
      log.push(`EP${ep} failed: ${entry.error}`)
    }
    await persistRefineState(project, refineState)
    emitJob(record, {
      type: 'episode',
      ep,
      state: entry.state,
      attempts: entry.attempts,
      check: entry.check,
      error: entry.error,
      tokens: entry.tokens || null,
      cost: entry.cost || null,
    })
    const job = record.job
    job.episodes.done = Object.values(refineState.episodes).filter((item) => ['passed', 'passed-with-issues', 'failed'].includes(item.state)).length
    await updateJob(record, { episodes: job.episodes }, { persist: false })
    return entry
  }

  function jobIdOfRecord(record) {
    return record && record.job ? record.job.id : null
  }

  async function collectRefineArtifacts(project) {
    const readDir = async (dir) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        return entries.filter((entry) => entry.isFile()).map((entry) => path.join(dir, entry.name))
      } catch {
        return []
      }
    }
    const relative = (file) => path.relative(project.dir, file).replace(/\\/g, '/')
    const find = (files, pattern) => {
      const match = files.find((file) => pattern.test(path.basename(file)))
      return match ? relative(match) : null
    }
    const outputFiles = await readDir(path.join(project.dir, 'output'))
    const reportFiles = await readDir(path.join(project.dir, 'report'))
    const workReportDir = path.join(project.dir, 'work', 'report')
    const summaryPath = path.join(workReportDir, 'production_summary.md')
    let summary = null
    try {
      await fs.access(summaryPath)
      summary = relative(summaryPath)
    } catch {
      summary = null
    }
    return {
      director: {
        md: find(outputFiles, /_导演执行版\.md$/),
        docx: find(outputFiles, /_导演执行版\.docx$/),
      },
      qcReport: {
        md: find(outputFiles, /_质检报告\.md$/),
        docx: find(outputFiles, /_质检报告\.docx$/),
      },
      productionSummary: summary,
      outputs: outputFiles.map(relative),
      reports: reportFiles.map(relative),
    }
  }

  async function finishRefineJob(project, record, refineState, log) {
    const entries = Object.values(refineState.episodes)
    const passed = entries.filter((entry) => entry.state === 'passed').length
    const issues = entries.filter((entry) => entry.state === 'passed-with-issues').length
    const failed = entries.filter((entry) => entry.state === 'failed').length
    const blocked = refineState.progress ? refineState.progress.blocked : 0
    const forcePartial = blocked > 0 || failed > 0 || entries.length < refineState.totalForJob
    emitJob(record, { type: 'phase', phase: 'merge', index: 4, total: REFINE_PHASES.length })
    await updateJob(record, { phase: 'merge', phaseIndex: 4 }, { persist: false })
    await persistRefineState(project, refineState)
    const partialArgs = forcePartial ? ['--allow-partial'] : []
    const steps = [
      { script: 'merge.py', args: partialArgs, phase: 'merge', index: 4, required: true },
      { script: 'writeback_docx.py', args: partialArgs, phase: 'writeback', index: 5, required: true },
      { script: 'final_audit.py', args: partialArgs, phase: 'audit', index: 6, required: false },
      { script: 'generate_summary.py', args: [], phase: 'report', index: 7, required: false },
      { script: 'generate_qc_report.py', args: [], phase: 'report', index: 7, required: false },
    ]
    const stepsResult = []
    let fatal = null
    for (const step of steps) {
      if (record.controller.signal.aborted) throw new Error('cancelled')
      emitJob(record, { type: 'phase', phase: step.phase, index: step.index, total: REFINE_PHASES.length })
      await updateJob(record, { phase: step.phase, phaseIndex: step.index }, { persist: false })
      emitJob(record, { type: 'log', level: 'info', message: `run ${step.script} ${step.args.join(' ')}`.trim() })
      const result =
        step.script === 'writeback_docx.py'
          ? await runScriptWithWordLockRetry({
              project,
              script: step.script,
              args: step.args,
              record,
              log,
              timeoutMs: SCRIPT_TIMEOUT_MS,
            })
          : await runProjectScript(project, step.script, step.args, { timeoutMs: SCRIPT_TIMEOUT_MS })
      stepsResult.push({
        script: step.script,
        args: step.args,
        exitCode: result.exitCode,
        ok: result.ok,
        error: result.error || null,
        stdoutTail: (result.stdout || '').slice(-1000),
        stderrTail: (result.stderr || '').slice(-1000),
      })
      log.push(`${step.script} exit=${result.exitCode}`)
      if (!result.ok && step.required) {
        const hint = result.exitCode === 3 ? '输出 docx 被占用，请关闭 Word/WPS 后重试' : `脚本 ${step.script} 失败（exit ${result.exitCode}）`
        fatal = hint
        break
      }
    }
    const artifacts = await collectRefineArtifacts(project)
    const totalTargets = entries.length
    const checkPassRate = totalTargets > 0 ? Number(((passed + issues) / totalTargets).toFixed(4)) : null
    refineState.state = fatal ? 'failed' : failed > 0 || passed + issues < totalTargets ? 'partial' : 'succeeded'
    refineState.finishedAt = new Date().toISOString()
    refineState.artifacts = artifacts
    refineState.checkPassRate = checkPassRate
    await persistRefineState(project, refineState)
    const result = {
      status: refineState.state,
      kind: 'refine',
      episodes: { total: totalTargets, passed, issues, failed, blocked },
      tokens: refineState.tokens,
      cost: refineState.cost || emptyCost(),
      budget: refineState.budget || null,
      checkPassRate,
      artifacts,
      steps: stepsResult,
      fatal,
    }
    if (fatal) {
      await updateJob(record, { state: 'failed', failureKind: 'script', error: fatal, result, finishedAt: new Date().toISOString() }, { persist: false })
      await commitRefineMeta(project, refineState, 'refine_failed')
      await flushRecord(record)
      emitJob(record, { type: 'error', error: fatal, job: publicJob(record.job) })
      return result
    }
    await updateJob(record, { state: 'succeeded', result, error: null, finishedAt: new Date().toISOString() }, { persist: false })
    await commitRefineMeta(project, refineState, refineState.state === 'succeeded' ? 'refine_done' : 'refine_partial')
    await flushRecord(record)
    emitJob(record, { type: 'done', job: publicJob(record.job), result })
    return result
  }

  async function commitRefineMeta(project, refineState, status) {
    await writeMeta(project, (meta) => ({
      ...meta,
      status,
      refine: {
        state: refineState.state,
        jobId: refineState.jobId,
        finishedAt: refineState.finishedAt,
        progress: refineState.progress,
        tokens: refineState.tokens,
        cost: refineState.cost || emptyCost(),
        artifacts: refineState.artifacts,
        checkPassRate: refineState.checkPassRate,
      },
    }))
  }

  async function flushRecord(record) {
    try {
      await record.writeChain
    } catch {
      // ignore
    }
    try {
      await persistJob(record)
    } catch {
      // ignore
    }
  }

  function startRefineJob(project, options = {}) {
    if (projectActive.has(project.id)) return { ok: false, error: 'project is busy', code: 'BUSY' }
    const id = `job-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 6)}`
    if (!JOB_ID_RE.test(id)) return { ok: false, error: 'job id generation failed', code: 'INTERNAL' }
    const job = {
      schema: 'lianben/job/1',
      id,
      projectId: project.id,
      kind: 'refine',
      state: 'queued',
      phase: null,
      phaseIndex: -1,
      phases: REFINE_PHASES.slice(),
      episodes: { total: 0, done: 0 },
      error: null,
      result: null,
      seq: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      failureKind: null,
      detection: null,
      params: {
        episodes: Array.isArray(options.episodes) ? options.episodes.map(Number) : null,
        concurrency: options.concurrency ? Number(options.concurrency) : null,
      },
    }
    const controller = new AbortController()
    const record = makeRecord(project.dir, job, { live: true, controller })
    jobs.set(id, record)
    projectActive.set(project.id, id)
    void persistJob(record)
    emitJob(record, { type: 'job', job: publicJob(job) })
    const log = []

    const run = async () => {
      let refineState = null
      try {
        await updateJob(record, { state: 'running', startedAt: new Date().toISOString() }, { persist: false })
        emitJob(record, { type: 'log', level: 'info', message: 'refine job started' })
        emitJob(record, { type: 'phase', phase: 'prepare', index: 0, total: REFINE_PHASES.length })
        await updateJob(record, { phase: 'prepare', phaseIndex: 0 }, { persist: false })
        await ensureProjectToolchain(project)
        const targetInfo = await refineTargets(project, options.episodes)
        refineState = newRefineState(id, targetInfo.targets)
        refineState.totalForJob = targetInfo.total
        refineState.blockedEps = targetInfo.blocked.slice()
        refineState.progress.blocked = targetInfo.blocked.length
        for (const ep of targetInfo.targets) refineState.episodes[ep] = emptyRefineEpisode(ep, targetInfo.titles[ep] || '')
        await persistRefineState(project, refineState)
        record.job.episodes = { total: targetInfo.targets.length, done: 0 }
        await updateJob(record, { episodes: record.job.episodes }, { persist: false })
        if (targetInfo.targets.length === 0) {
          refineState.state = 'succeeded'
          refineState.finishedAt = new Date().toISOString()
          refineState.artifacts = await collectRefineArtifacts(project)
          refineState.checkPassRate = 1
          await persistRefineState(project, refineState)
          await commitRefineMeta(project, refineState, 'refine_done')
          await updateJob(record, { state: 'succeeded', result: { status: 'succeeded', episodes: { total: 0 }, tokens: refineState.tokens, cost: refineState.cost || emptyCost(), artifacts: refineState.artifacts }, finishedAt: new Date().toISOString() }, { persist: false })
          await flushRecord(record)
          emitJob(record, { type: 'done', job: publicJob(record.job), result: record.job.result })
          return
        }
        emitJob(record, { type: 'log', level: 'info', message: `targets=${targetInfo.targets.join(',')} blocked=${targetInfo.blocked.join(',') || '-'}` })
        const context = await loadDirectorContext({ projectDir: project.dir, engineDir: ENGINE_DIR })
        emitJob(record, { type: 'phase', phase: 'write', index: 1, total: REFINE_PHASES.length })
        const concurrency = Math.max(
          1,
          Math.min(20, Number(options.concurrency) || Number((config.refine && config.refine.concurrency) ?? 20) || 20),
        )
        await runPool(
          targetInfo.targets,
          concurrency,
          (ep) => runRefineEpisode({ project, context, ep, record, refineState, log }),
          record.controller.signal,
        )
        if (record.controller.signal.aborted) throw new Error('cancelled')
        await finishRefineJob(project, record, refineState, log)
      } catch (error) {
        const message = String((error && error.message) || error)
        const cancelled = record.cancelRequested || record.controller.signal.aborted
        const budgetExceeded = Boolean(error && error.code === 'BUDGET_EXCEEDED')
        const wordLocked = Boolean(error && error.code === 'WORD_LOCKED')
        const needsConfirm = budgetExceeded || wordLocked
        if (refineState) {
          refineState.state = cancelled ? 'cancelled' : needsConfirm ? 'needs_confirm' : 'failed'
          refineState.finishedAt = new Date().toISOString()
          refineState.artifacts = await collectRefineArtifacts(project).catch(() => null)
          await persistRefineState(project, refineState).catch(() => {})
          const metaStatus = cancelled ? 'refine_cancelled' : needsConfirm ? 'refine_needs_confirm' : 'refine_failed'
          await commitRefineMeta(project, refineState, metaStatus).catch(() => {})
        }
        await updateJob(record, {
          state: cancelled ? 'cancelled' : needsConfirm ? 'needs_confirm' : 'failed',
          failureKind: cancelled ? 'cancelled' : budgetExceeded ? 'budget' : wordLocked ? 'word_locked' : 'host',
          error: cancelled ? 'cancelled by user' : message,
          result: refineState
            ? {
                status: refineState.state,
                tokens: refineState.tokens,
                cost: refineState.cost || emptyCost(),
                budget: refineState.budget || null,
                artifacts: refineState.artifacts,
                episodes: refineState.progress,
              }
            : null,
          finishedAt: new Date().toISOString(),
        }, { persist: false })
        await flushRecord(record)
        emitJob(record, { type: 'error', error: cancelled ? 'cancelled' : message, job: publicJob(record.job) })
        log.push(`refine job ${needsConfirm ? 'needs_confirm' : 'failed'}: ${message}`)
      } finally {
        projectActive.delete(project.id)
        try {
          record.controller.abort()
        } catch {
          // ignore
        }
      }
    }
    void run()
    return { ok: true, job: publicJob(record.job) }
  }


  // -------------------------------------------------------------------------
  // 2.0 storyboard refine (planner -> plan check -> writer -> check -> audit)
  // -------------------------------------------------------------------------

  function newStoryboardState(jobId, targets) {
    const now = new Date().toISOString()
    return {
      schema: 'lianben/storyboard_state/1',
      jobId,
      mode: MODE_20,
      state: 'running',
      startedAt: now,
      finishedAt: null,
      phases: STORYBOARD_PHASES.slice(),
      phase: 'prepare',
      phaseIndex: 0,
      progress: { total: targets.length, pending: targets.length, planning: 0, writing: 0, passed: 0, failed: 0, retries: 0 },
      episodes: {},
      artifacts: null,
      tokens: emptyTokens(),
      cost: emptyCost(),
      budget: {
        stage: 'storyboard',
        limitTokens: Math.max(STORYBOARD_BUDGET_PER_EP, Math.ceil(targets.length * STORYBOARD_BUDGET_PER_EP * 1.1)),
        spentTokens: 0,
        ratio: 0,
        warning: false,
        exceeded: false,
      },
      checkPassRate: null,
    }
  }

  function recomputeStoryboardProgress(state) {
    const entries = Object.values(state.episodes || {})
    state.progress = {
      total: entries.length,
      pending: entries.filter((entry) => entry.state === 'pending').length,
      planning: entries.filter((entry) => entry.state === 'planning').length,
      writing: entries.filter((entry) => entry.state === 'writing').length,
      passed: entries.filter((entry) => entry.state === 'passed').length,
      failed: entries.filter((entry) => entry.state === 'failed').length,
      retries: entries.reduce((sum, entry) => sum + (Number(entry.retries) || 0), 0),
    }
  }

  async function persistStoryboardState(project, state) {
    recomputeStoryboardProgress(state)
    await writeJsonAtomic(path.join(project.dir, 'work', 'meta', 'storyboard_state.json'), state)
  }

  function storyboardSummary(state) {
    if (!state || typeof state !== 'object') return null
    return {
      schema: state.schema || 'lianben/storyboard_state/1',
      jobId: state.jobId || null,
      mode: MODE_20,
      state: state.state || 'unknown',
      startedAt: state.startedAt || null,
      finishedAt: state.finishedAt || null,
      phase: state.phase || null,
      phases: state.phases || STORYBOARD_PHASES,
      progress: state.progress || null,
      episodes: Object.values(state.episodes || {}).sort((left, right) => Number(left.ep) - Number(right.ep)),
      artifacts: state.artifacts || null,
      tokens: state.tokens || null,
      cost: state.cost || emptyCost(),
      budget: state.budget || null,
      checkPassRate: state.checkPassRate || null,
    }
  }

  async function readStoryboardState(project) {
    return readJsonFile(path.join(project.dir, 'work', 'meta', 'storyboard_state.json'), null)
  }

  async function storyboardProfile(project) {
    const local = await readJsonFile(path.join(project.dir, 'storyboard-profile.json'), null)
    const fallback = await readJsonFile(path.join(ENGINE2_DIR, 'defaults', 'storyboard-profile.json'), {})
    const data = local || fallback || { active: 'B_bilingual_full', profiles: {} }
    const name = String(data.active || 'B_bilingual_full')
    const profile = (data.profiles || {})[name] || { language: 'bilingual' }
    return { name, profile }
  }

  async function readTextIfExists(file) {
    try {
      return await fs.readFile(file, 'utf8')
    } catch {
      return ''
    }
  }

  async function storyboardContext(project, ep) {
    const profileInfo = await storyboardProfile(project)
    const ledgerFile = path.join(project.dir, 'work', 'meta', 'source_dialogue.tsv')
    const ledger = await readTextIfExists(ledgerFile)
    const factsLock = await readTextIfExists(path.join(project.dir, 'work', 'meta', 'facts_lock.md'))
    const handoffRaw = await readTextIfExists(path.join(project.dir, 'work', 'meta', 'handoff.json'))
    let handoff = handoffRaw
    try {
      const parsed = JSON.parse(handoffRaw)
      const entry = (Array.isArray(parsed) ? parsed : parsed.episodes || parsed.handoff || []).find
        ? null
        : null
      handoff = JSON.stringify(parsed, null, 1)
    } catch {
      // keep raw text
    }
    let optimized = ''
    const optimizedJson = path.join(project.dir, 'work', 'preflight', 'optimized', `ep${String(ep).padStart(2, '0')}.json`)
    const optimizedMd = path.join(project.dir, 'work', 'preflight', 'optimized', `ep${String(ep).padStart(2, '0')}.md`)
    try {
      optimized = await fs.readFile(optimizedJson, 'utf8')
    } catch {
      optimized = await readTextIfExists(optimizedMd)
    }
    return { profileInfo, ledger, factsLock, handoff, optimized }
  }

  async function runStoryboardCheck(project, args) {
    return runProjectScript(project, 'storyboard_check.py', args, { timeoutMs: SCRIPT_TIMEOUT_MS })
  }

  async function callStoryboardLlm({ project, prompt, record, state, ep, stage }) {
    emitJob(record, { type: 'storyboard-start', ep, stage })
    const answer = await callDirector(
      prompt,
      record.controller.signal,
      (text) => emitJob(record, { type: 'storyboard-delta', ep, stage, text }),
    )
    emitJob(record, { type: 'storyboard-end', ep, stage, chars: String(answer.text || '').length, finish: answer.finish || null })
    if (answer.usage) addTokens(state.tokens, answer.usage)
    const callCost = costForUsage(answer.usage || {}, new Date())
    addCost(state.cost, callCost)
    updateBudget(state, 'storyboard', record, [])
    await appendTokenLog(project, {
      at: new Date().toISOString(),
      stage: `storyboard-${stage}`,
      ep,
      provider: answer.provider || null,
      model: answer.model || null,
      usage: answer.usage || null,
      cost: callCost,
    }).catch(() => {})
    return { answer, callCost }
  }

  async function runStoryboardEpisode({ project, record, state, ep, context, title, log }) {
    const entry = state.episodes[ep]
    entry.state = 'planning'
    entry.error = null
    entry.attempts = Number(entry.attempts) || 0
    const sourceFile = epSourceFile(project, ep)
    let sourceText = ''
    try {
      sourceText = await fs.readFile(sourceFile, 'utf8')
    } catch {
      entry.state = 'failed'
      entry.error = 'source missing'
      throw new Error(`EP${ep} source missing`)
    }
    if (!context.ledger.trim()) throw new Error('source_dialogue.tsv missing; run 2.0 preflight first')
    const planPath = path.join(project.dir, 'work', 'storyboard', `ep${String(ep).padStart(2, '0')}_plan.json`)
    const mdPath = path.join(project.dir, 'work', 'storyboard', `ep${String(ep).padStart(2, '0')}.md`)
    await fs.mkdir(path.dirname(planPath), { recursive: true })
    let lastErrors = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (record.controller.signal.aborted) throw new Error('cancelled')
      entry.attempts = attempt + 1
      if (attempt > 0) entry.retries = (Number(entry.retries) || 0) + 1
      const plannerPrompt = buildStoryboardPlannerPrompt({
        ep,
        title,
        profileName: context.profileInfo.name,
        profile: context.profileInfo.profile,
        source: sourceText,
        ledgerRows: context.ledger,
        factsLock: context.factsLock,
        handoff: context.handoff,
        optimized: context.optimized,
      })
      if (lastErrors.length > 0) {
        plannerPrompt.messages.push({
          role: 'user',
          content: [{ type: 'text', text: buildStoryboardRetryInstruction({ stage: 'planner', errors: lastErrors }) }],
        })
      }
      const planResult = await callStoryboardLlm({ project, prompt: plannerPrompt, record, state, ep, stage: 'planner' })
      const parsedPlan = parseStoryboardPlan(planResult.answer.text, {
        expectedEp: ep,
        profileName: context.profileInfo.name,
        profile: context.profileInfo.profile,
      })
      if (!parsedPlan.ok) {
        lastErrors = parsedPlan.errors
        entry.error = parsedPlan.errors.join('；')
        log.push(`EP${ep} planner invalid: ${entry.error}`)
        continue
      }
      await writeJsonAtomic(planPath, parsedPlan.plan)
      const planCheck = await runStoryboardCheck(project, ['--plans', 'work/storyboard', '--eps', String(ep)])
      if (planCheck.exitCode !== 0) {
        const planReport = await readJsonFile(path.join(project.dir, 'work', 'report', 'storyboard_plan_check.json'), null)
        const row = planReport && Array.isArray(planReport.results) ? planReport.results.find((item) => Number(item.ep) === ep) : null
        lastErrors = row && Array.isArray(row.fails) && row.fails.length > 0 ? row.fails : [String(planCheck.stderr || planCheck.stdout || 'plan check failed').slice(-1000)]
        entry.error = lastErrors.join('；')
        log.push(`EP${ep} plan_check failed: ${entry.error}`)
        continue
      }
      entry.state = 'writing'
      const writerPrompt = buildStoryboardWriterPrompt({
        ep,
        title,
        profileName: context.profileInfo.name,
        profile: context.profileInfo.profile,
        plan: parsedPlan.plan,
        source: sourceText,
      })
      if (lastErrors.length > 0) {
        writerPrompt.messages.push({
          role: 'user',
          content: [{ type: 'text', text: buildStoryboardRetryInstruction({ stage: 'writer', errors: lastErrors }) }],
        })
      }
      const writerResult = await callStoryboardLlm({ project, prompt: writerPrompt, record, state, ep, stage: 'writer' })
      const parsedMd = parseStoryboardMarkdown(writerResult.answer.text, {
        ep,
        profileName: context.profileInfo.name,
        profile: context.profileInfo.profile,
      })
      if (!parsedMd.ok) {
        lastErrors = parsedMd.errors
        entry.error = parsedMd.errors.join('；')
        log.push(`EP${ep} writer invalid: ${entry.error}`)
        continue
      }
      await writeTextAtomic(mdPath, parsedMd.text)
      const check = await runStoryboardCheck(project, ['--dir', 'work/storyboard', '--eps', String(ep)])
      if (check.exitCode !== 0) {
        const report = await readJsonFile(path.join(project.dir, 'work', 'report', 'storyboard_check.json'), null)
        const row = report && Array.isArray(report.results) ? report.results.find((item) => Number(item.ep) === ep) : null
        lastErrors = row && Array.isArray(row.fails) && row.fails.length > 0 ? row.fails : [String(check.stderr || check.stdout || 'storyboard check failed').slice(-1000)]
        entry.error = lastErrors.join('；')
        log.push(`EP${ep} check failed: ${entry.error}`)
        continue
      }
      entry.state = 'passed'
      entry.plan = path.relative(project.dir, planPath).replace(/\\/g, '/')
      entry.storyboard = path.relative(project.dir, mdPath).replace(/\\/g, '/')
      entry.error = null
      return
    }
    entry.state = 'failed'
    entry.error = entry.error || 'max retries exceeded'
    throw new Error(`EP${ep} failed: ${entry.error}`)
  }

  async function collectStoryboardArtifacts(project) {
    const epIndex = await readJsonFile(path.join(project.dir, 'work', 'meta', 'ep_index.json'), {}) || {}
    const sourceName = epIndex.docx ? String(epIndex.docx).split(/[\\/]/).pop() : ''
    const base = sourceName ? sourceName.replace(/\.docx$/i, '') : '剧本'
    const output = path.join(project.dir, 'output')
    let names = []
    try {
      names = await fs.readdir(output)
    } catch {
      names = []
    }
    const plan = names.find((name) => name.includes('竖屏分镜稿') && name.endsWith('.md')) || `${base}_竖屏分镜稿.md`
    const docx = plan.replace(/\.md$/i, '.docx')
    return {
      planMd: `output/${plan}`,
      planDocx: names.includes(docx) ? `output/${docx}` : null,
      storyboardDir: 'work/storyboard',
      checkReport: 'work/report/storyboard_check.json',
      dialogueAudit: 'work/report/dialogue_audit.json',
    }
  }

  async function commitStoryboardMeta(project, state, status) {
    await writeMeta(project, (meta) => ({
      ...meta,
      status,
      storyboard: {
        state: state.state,
        jobId: state.jobId,
        finishedAt: state.finishedAt,
        progress: state.progress,
        tokens: state.tokens,
        cost: state.cost || emptyCost(),
        budget: state.budget || null,
        artifacts: state.artifacts || null,
        checkPassRate: state.checkPassRate || null,
      },
    }))
  }

  async function finishStoryboardJob(project, record, state, log) {
    const entries = Object.values(state.episodes || {})
    const failed = entries.filter((entry) => entry.state !== 'passed')
    if (failed.length > 0) throw new Error(`storyboard 未通过集：${failed.map((entry) => entry.ep).join(', ')}`)
    record.job.phase = 'audit'
    record.job.phaseIndex = STORYBOARD_PHASES.indexOf('audit')
    emitJob(record, { type: 'phase', phase: 'audit', index: record.job.phaseIndex, total: STORYBOARD_PHASES.length })
    const allowPartial = Number(state.allEpisodes || 0) > entries.length
    const merge = await runProjectScript(project, 'storyboard_merge.py', allowPartial ? ['--allow-partial'] : [], { timeoutMs: SCRIPT_TIMEOUT_MS })
    if (merge.exitCode !== 0) throw new Error(`storyboard_merge failed: ${String(merge.stderr || merge.stdout || '').slice(-2000)}`)
    emitJob(record, { type: 'phase', phase: 'build', index: STORYBOARD_PHASES.indexOf('build'), total: STORYBOARD_PHASES.length })
    const build = await runProjectScript(project, 'storyboard_build_docx.py', [], { timeoutMs: SCRIPT_TIMEOUT_MS })
    if (build.exitCode !== 0) throw new Error(`storyboard_build_docx failed: ${String(build.stderr || build.stdout || '').slice(-2000)}`)
    const audit = await runProjectScript(project, 'audit_dialogue.py', ['--dir', 'work/storyboard'], { timeoutMs: SCRIPT_TIMEOUT_MS })
    emitJob(record, { type: 'log', level: audit.exitCode === 0 ? 'info' : 'warn', message: `dialogue audit exit=${audit.exitCode}` })
    const finalCheck = await runStoryboardCheck(project, ['--dir', 'work/storyboard'])
    const report = await readJsonFile(path.join(project.dir, 'work', 'report', 'storyboard_check.json'), null)
    if (finalCheck.exitCode !== 0) throw new Error(`final storyboard_check failed: ${String(finalCheck.stderr || finalCheck.stdout || '').slice(-2000)}`)
    state.artifacts = await collectStoryboardArtifacts(project)
    state.checkPassRate = report && Number(report.total) ? Number(((Number(report.passed) || 0) / Number(report.total)).toFixed(4)) : null
    state.phase = 'report'
    state.phaseIndex = STORYBOARD_PHASES.length - 1
    state.finishedAt = new Date().toISOString()
    state.state = 'succeeded'
    await persistStoryboardState(project, state)
    await commitStoryboardMeta(project, state, 'refine2_done')
    const result = {
      status: 'succeeded',
      kind: 'refine2',
      episodes: state.progress,
      tokens: state.tokens,
      cost: state.cost || emptyCost(),
      artifacts: state.artifacts,
      dialogueAudit: audit.exitCode,
      check: report || null,
    }
    record.job.phase = 'report'
    record.job.phaseIndex = STORYBOARD_PHASES.length - 1
    await updateJob(record, { state: 'succeeded', result, error: null, failureKind: null, finishedAt: new Date().toISOString() }, { persist: false })
    await flushRecord(record)
    emitJob(record, { type: 'done', job: publicJob(record.job), result })
    return result
  }

  function startStoryboardJob(project, options = {}) {
    if (projectActive.has(project.id)) return { ok: false, error: 'project is busy', code: 'BUSY' }
    const id = `job-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 6)}`
    if (!JOB_ID_RE.test(id)) return { ok: false, error: 'job id generation failed', code: 'INTERNAL' }
    const job = {
      schema: 'lianben/job/1',
      id,
      projectId: project.id,
      kind: 'refine2',
      state: 'queued',
      phase: null,
      phaseIndex: -1,
      phases: STORYBOARD_PHASES.slice(),
      episodes: { total: 0, done: 0 },
      error: null,
      result: null,
      seq: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      failureKind: null,
      detection: null,
      params: { episodes: Array.isArray(options.episodes) ? options.episodes.map(Number) : null, concurrency: options.concurrency ? Number(options.concurrency) : null },
    }
    const controller = new AbortController()
    const record = makeRecord(project.dir, job, { live: true, controller })
    jobs.set(id, record)
    projectActive.set(project.id, id)
    void persistJob(record)
    emitJob(record, { type: 'job', job: publicJob(job) })
    const log = []
    const run = async () => {
      let state = null
      try {
        await updateJob(record, { state: 'running', startedAt: new Date().toISOString() }, { persist: false })
        emitJob(record, { type: 'log', level: 'info', message: '2.0 storyboard refine started' })
        await ensureProjectToolchain(project)
        const epIndex = await readJsonFile(path.join(project.dir, 'work', 'meta', 'ep_index.json'), null)
        if (!epIndex || !Array.isArray(epIndex.episodes)) throw new Error('ep_index.json missing; run 2.0 preflight first')
        const allEps = epIndex.episodes.map((entry) => Number(entry.ep)).filter(Boolean).sort((a, b) => a - b)
        let targets = allEps
        if (Array.isArray(options.episodes) && options.episodes.length > 0) {
          const wanted = new Set(options.episodes.map(Number))
          targets = allEps.filter((ep) => wanted.has(ep))
        }
        if (targets.length === 0) throw new Error('no target episodes')
        const titles = new Map(epIndex.episodes.map((entry) => [Number(entry.ep), entry.title || '']))
        state = newStoryboardState(id, targets)
        state.allEpisodes = allEps.length
        for (const ep of targets) {
          state.episodes[ep] = { ep, title: titles.get(ep) || `第${ep}集`, state: 'pending', attempts: 0, retries: 0, error: null }
        }
        await persistStoryboardState(project, state)
        record.job.episodes = { total: targets.length, done: 0 }
        await updateJob(record, { episodes: record.job.episodes }, { persist: false })
        const context = await storyboardContext(project, targets[0])
        if (!context.ledger.trim()) throw new Error('source_dialogue.tsv missing; run 2.0 preflight first')
        const concurrency = Math.max(1, Math.min(5, Number(options.concurrency) || Number((config.refine && config.refine.concurrency) ?? 3) || 3))
        state.phase = 'plan'
        state.phaseIndex = 1
        await persistStoryboardState(project, state)
        emitJob(record, { type: 'phase', phase: 'plan', index: 1, total: STORYBOARD_PHASES.length })
        await runPool(targets, concurrency, async (ep) => {
          const epContext = await storyboardContext(project, ep)
          await runStoryboardEpisode({ project, record, state, ep, context: epContext, title: titles.get(ep) || `第${ep}集`, log })
          record.job.episodes.done = Object.values(state.episodes).filter((entry) => ['passed', 'failed'].includes(entry.state)).length
          await updateJob(record, { episodes: record.job.episodes }, { persist: false })
          await persistStoryboardState(project, state)
          emitJob(record, { type: 'episode', ep, state: state.episodes[ep].state, retries: state.episodes[ep].retries, progress: state.progress })
        }, record.controller.signal)
        if (record.controller.signal.aborted) throw new Error('cancelled')
        await finishStoryboardJob(project, record, state, log)
      } catch (error) {
        const message = String((error && error.message) || error)
        const cancelled = record.cancelRequested || record.controller.signal.aborted
        if (state) {
          state.state = cancelled ? 'cancelled' : 'failed'
          state.finishedAt = new Date().toISOString()
          state.artifacts = await collectStoryboardArtifacts(project).catch(() => null)
          await persistStoryboardState(project, state).catch(() => {})
          await commitStoryboardMeta(project, state, cancelled ? 'refine2_cancelled' : 'refine2_failed').catch(() => {})
        }
        await updateJob(record, {
          state: cancelled ? 'cancelled' : 'failed',
          failureKind: cancelled ? 'cancelled' : 'host',
          error: cancelled ? 'cancelled by user' : message,
          result: state ? { status: state.state, tokens: state.tokens, cost: state.cost, budget: state.budget, artifacts: state.artifacts, episodes: state.progress } : null,
          finishedAt: new Date().toISOString(),
        }, { persist: false })
        await flushRecord(record)
        emitJob(record, { type: 'error', error: cancelled ? 'cancelled' : message, job: publicJob(record.job) })
        log.push(`storyboard job failed: ${message}`)
      } finally {
        projectActive.delete(project.id)
        try {
          record.controller.abort()
        } catch {
          // ignore
        }
      }
    }
    void run()
    return { ok: true, job: publicJob(record.job) }
  }

  async function handleProjectRefine(request) {
    const id = new URL(request.url).searchParams.get('id')
    const project = await readProject(id)
    if (!project) return jsonResponse({ ok: false, error: 'project not found', code: 'NOT_FOUND' }, 404)
    if (modeOf(project.meta) === MODE_20) {
      const state = await readStoryboardState(project)
      const job = await readJsonFile(path.join(project.dir, 'work', 'meta', 'host_job.json'), null)
      const summary = storyboardSummary(state)
      return jsonResponse({
        ok: true,
        mode: MODE_20,
        refine: summary,
        storyboard: summary,
        job: job ? publicJob(job) : null,
        profiles: await storyboardProfile(project),
      })
    }
    const state = await readRefineState(project)
    const job = await latestRefineJob(project)
    if (!state) {
      return jsonResponse({
        ok: true,
        refine: {
          state: 'pending',
          progress: { total: 0, pending: 0, running: 0, passed: 0, issues: 0, blocked: 0, failed: 0 },
          episodes: [],
          artifacts: null,
          tokens: null,
          cost: null,
          job: job ? publicJob(job) : null,
          pricing: pricingSnapshot(),
        },
      })
    }
    const summary = refineSummary(state) || { state: 'unknown', episodes: [] }
    if (!summary.cost && summary.tokens) {
      summary.cost = {
        ...costForTokenLedger(summary.tokens, new Date(state.finishedAt || state.startedAt || Date.now())),
        estimated: true,
      }
    }
    const episodes = Object.values(state.episodes || {})
      .map((entry) => {
        const item = { ...entry }
        if (!item.cost && item.tokens) {
          item.cost = {
            ...costForTokenLedger(item.tokens, new Date(state.finishedAt || state.startedAt || Date.now())),
            estimated: true,
          }
        }
        return item
      })
      .sort((left, right) => Number(left.ep) - Number(right.ep))
    return jsonResponse({
      ok: true,
      refine: { ...summary, episodes, job: job ? publicJob(job) : null, pricing: pricingSnapshot() },
    })
  }

  async function handleProjectDraft(request) {
    const url = new URL(request.url)
    const id = url.searchParams.get('id')
    const ep = Number(url.searchParams.get('ep'))
    const project = await readProject(id)
    if (!project) return jsonResponse({ ok: false, error: 'project not found', code: 'NOT_FOUND' }, 404)
    if (!Number.isFinite(ep) || ep < 1) return jsonResponse({ ok: false, error: 'invalid episode', code: 'BAD_INPUT' }, 400)
    const padded = String(ep).padStart(2, '0')
    const draftPath = path.join(project.dir, 'work', 'draft', `ep${padded}.md`)
    const notesPath = path.join(project.dir, 'work', 'report', `ep${padded}_production_notes.md`)
    const checkPath = path.join(project.dir, 'work', 'report', `check_ep${padded}.json`)
    const readText = async (file) => {
      try {
        return await fs.readFile(file, 'utf8')
      } catch {
        return ''
      }
    }
    return jsonResponse({
      ok: true,
      episode: {
        ep,
        draftMarkdown: await readText(draftPath),
        notes: await readText(notesPath),
        check: await readJsonFile(checkPath, null),
        report: await readJsonFile(path.join(project.dir, 'work', 'report', `ep${padded}.json`), null),
      },
    })
  }

  // -------------------------------------------------------------------------
  // M4 BGM (配乐) stage
  // -------------------------------------------------------------------------

  const BGM_EP_STATES = ['pending', 'writing', 'machine_checking', 'qc_pending', 'qc_running', 'retry_wait', 'passed', 'failed']
  const bgmStateWriteQueues = new Map()

  function codedError(code, message) {
    const error = new Error(message)
    error.code = code
    return error
  }

  function budgetSpentTokens(tokens) {
    const value = tokens && typeof tokens === 'object' ? tokens : {}
    return (Number(value.inputTokens) || 0) + (Number(value.outputTokens) || 0)
  }

  async function sleep(ms, signal) {
    if (!ms || ms <= 0) return
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      if (signal && typeof signal.addEventListener === 'function') {
        const onAbort = () => {
          clearTimeout(timer)
          reject(codedError('CANCELLED', 'cancelled'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  /**
   * Refresh state.budget from state.tokens and emit a `budget` frame.
   * Throws BUDGET_EXCEEDED once the limit is reached.
   */
  function updateBudget(state, stage, record, log) {
    if (!state) return null
    const perEpisode = stage === 'bgm' ? BGM_BUDGET_PER_EP : stage === 'storyboard' ? STORYBOARD_BUDGET_PER_EP : REFINE_BUDGET_PER_EP
    const targets = Object.keys(state.episodes || {}).length
    if (!state.budget || typeof state.budget !== 'object') {
      state.budget = {
        stage,
        limitTokens: Math.max(perEpisode, Math.ceil(targets * perEpisode * 1.25)),
        spentTokens: 0,
        ratio: 0,
        warning: false,
        exceeded: false,
      }
    }
    const budget = state.budget
    budget.stage = stage
    budget.spentTokens = budgetSpentTokens(state.tokens)
    budget.limitTokens = budget.limitTokens || Math.max(perEpisode, Math.ceil(targets * perEpisode * 1.25))
    budget.ratio = budget.limitTokens > 0 ? Number((budget.spentTokens / budget.limitTokens).toFixed(4)) : 0
    if (budget.ratio >= 0.8 && !budget.warning) {
      budget.warning = true
      if (log) log.push(`budget warning ${stage}: ${budget.spentTokens}/${budget.limitTokens}`)
    }
    budget.exceeded = budget.spentTokens >= budget.limitTokens
    if (record) {
      emitJob(record, {
        type: 'budget',
        stage,
        limitTokens: budget.limitTokens,
        spentTokens: budget.spentTokens,
        ratio: budget.ratio,
        warning: budget.warning,
        exceeded: budget.exceeded,
      })
    }
    if (budget.exceeded) {
      throw codedError(
        'BUDGET_EXCEEDED',
        `预算超限：${stage} 已使用 ${budget.spentTokens} / ${budget.limitTokens} tokens（按 input+output 计）`,
      )
    }
    return budget
  }

  async function runScriptWithWordLockRetry({ project, script, args, record, log, timeoutMs }) {
    for (let attempt = 1; attempt <= WORD_LOCK_RETRY_ATTEMPTS; attempt += 1) {
      const result = await runProjectScript(project, script, args, { timeoutMs })
      if (result.exitCode !== 3) return result
      if (record.controller.signal.aborted) throw codedError('CANCELLED', 'cancelled')
      log.push(`${script} exit=3 (Word/WPS lock), retry ${attempt}/${WORD_LOCK_RETRY_ATTEMPTS}`)
      emitJob(record, { type: 'log', level: 'warn', message: `${script} 输出被 Word/WPS 占用，${Math.round(WORD_LOCK_RETRY_MS / 1000)}s 后重试（${attempt}/${WORD_LOCK_RETRY_ATTEMPTS}）` })
      if (attempt < WORD_LOCK_RETRY_ATTEMPTS) await sleep(WORD_LOCK_RETRY_MS, record.controller.signal)
    }
    throw codedError(
      'WORD_LOCKED',
      '输出 docx 被 Word/WPS 占用：已重试 3 次。请关闭 Word/WPS 后重新运行（已完成集不会重复调用模型）。',
    )
  }

  function bgmPad(ep) {
    return String(ep).padStart(2, '0')
  }

  async function ensureProjectBgmAssets(project) {
    const refsDir = path.join(project.dir, '参考资料', 'bgm配乐规则')
    const marker = path.join(refsDir, '.lianben_version')
    const is20 = modeOf(project.meta) === MODE_20
    const revision = is20 ? BGM_ASSET_REVISION_2 : BGM_ASSET_REVISION
    const source = path.join(is20 ? ENGINE2_DIR : ENGINE_DIR, 'rules', 'bgm配乐规则')
    let current = null
    try {
      current = (await fs.readFile(marker, 'utf8')).trim()
    } catch {
      current = null
    }
    if (current === revision) return refsDir
    await fs.rm(refsDir, { recursive: true, force: true })
    await fs.mkdir(refsDir, { recursive: true })
    await fs.cp(source, refsDir, { recursive: true, force: true })
    await fs.writeFile(marker, `${revision}\n`, 'utf8')
    return refsDir
  }

  async function readBgmIndex(project) {
    return readJsonFile(path.join(project.dir, 'work', 'meta', 'bgm_index.json'), null)
  }

  async function readBgmState(project) {
    return readJsonFile(path.join(project.dir, 'work', 'meta', 'bgm_state.json'), null)
  }

  function newBgmState(jobId, targets, titles) {
    const now = new Date().toISOString()
    return {
      schema: 'lianben/bgm_state/1',
      jobId,
      state: 'running',
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      progress: { total: targets.length, pending: targets.length, writing: 0, machine_checking: 0, qc_pending: 0, qc_running: 0, passed: 0, retry_wait: 0, failed: 0 },
      episodes: {},
      seriesBible: false,
      themeMap: false,
      audit: null,
      artifacts: null,
      tokens: emptyTokens(),
      cost: emptyCost(),
      budget: {
        stage: 'bgm',
        limitTokens: Math.max(BGM_BUDGET_PER_EP, Math.ceil(targets.length * BGM_BUDGET_PER_EP * 1.25)),
        spentTokens: 0,
        ratio: 0,
        warning: false,
        exceeded: false,
      },
      checkPassRate: null,
    }
  }

  function emptyBgmEpisode(ep, title) {
    return {
      ep,
      title: title || '',
      state: 'pending',
      attempts: 0,
      qcAttempts: 0,
      check: null,
      qc: null,
      tokens: emptyTokens(),
      cost: emptyCost(),
      artifacts: { bgm: '', report: '', check: '', qc: '' },
      error: null,
      statusLine: null,
    }
  }

  function recomputeBgmProgress(state) {
    const entries = Object.values(state.episodes || {})
    const counts = Object.fromEntries(BGM_EP_STATES.map((key) => [key, 0]))
    counts.total = entries.length
    for (const entry of entries) {
      const key = BGM_EP_STATES.includes(entry.state) ? entry.state : 'pending'
      counts[key] += 1
    }
    state.progress = counts
    state.updatedAt = new Date().toISOString()
    return state
  }

  async function persistBgmState(project, state) {
    recomputeBgmProgress(state)
    const file = path.join(project.dir, 'work', 'meta', 'bgm_state.json')
    // Episode workers run concurrently; serialize snapshots per file so two
    // workers never race the same temp->target rename.
    let snapshot
    try {
      snapshot = JSON.parse(JSON.stringify(state))
    } catch {
      snapshot = state
    }
    const previous = bgmStateWriteQueues.get(file) || Promise.resolve()
    const next = previous.catch(() => {}).then(() => writeJsonAtomic(file, snapshot))
    bgmStateWriteQueues.set(file, next)
    try {
      await next
    } finally {
      if (bgmStateWriteQueues.get(file) === next) bgmStateWriteQueues.delete(file)
    }
  }

  function bgmSummary(state) {
    if (!state || typeof state !== 'object') return null
    let cost = state.cost || null
    if (!cost && state.tokens) {
      cost = {
        ...costForTokenLedger(state.tokens, new Date(state.finishedAt || state.startedAt || Date.now())),
        estimated: true,
      }
    }
    return {
      schema: state.schema || 'lianben/bgm_state/1',
      jobId: state.jobId || null,
      state: state.state || 'unknown',
      startedAt: state.startedAt || null,
      finishedAt: state.finishedAt || null,
      progress: state.progress || null,
      episodes: Object.values(state.episodes || {}).sort((left, right) => Number(left.ep) - Number(right.ep)),
      seriesBible: Boolean(state.seriesBible),
      themeMap: Boolean(state.themeMap),
      audit: state.audit || null,
      artifacts: state.artifacts || null,
      tokens: state.tokens || null,
      cost,
      budget: state.budget || null,
      checkPassRate: state.checkPassRate || null,
    }
  }

  async function latestBgmJob(project) {
    const dir = path.join(project.dir, 'work', 'meta', 'jobs')
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }
    let latest = null
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const job = await readJsonFile(path.join(dir, entry.name), null)
      if (!job || job.kind !== 'bgm') continue
      if (!latest || String(job.updatedAt || '').localeCompare(String(latest.updatedAt || '')) > 0) latest = job
    }
    return latest
  }

  async function readBgmText(project, relative) {
    try {
      return await fs.readFile(path.join(project.dir, relative), 'utf8')
    } catch {
      return ''
    }
  }

  async function writeBgmOutputs(project, ep, parsed) {
    const padded = bgmPad(ep)
    const bgmRel = `work/bgm/ep${padded}.md`
    const reportRel = `work/report/bgm_ep${padded}.json`
    const bgmText = String(parsed.bgm || '')
      .replace(/^```(?:markdown|md)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim()
    await writeTextAtomic(path.join(project.dir, bgmRel), `${bgmText}\n`)
    const report = parsed.report && typeof parsed.report === 'object' ? { ...parsed.report } : {}
    report.ep = ep
    if (!report.status) report.status = 'OK'
    await writeJsonAtomic(path.join(project.dir, reportRel), report)
    return { bgm: bgmRel, report: reportRel, check: `work/report/bgm_check_ep${padded}.json`, qc: `work/report/bgm_qc_ep${padded}.json` }
  }

  async function runBgmCheck(project, ep) {
    const result = await runProjectScript(project, 'bgm_check_ep.py', ['--eps', String(ep)], { timeoutMs: BGM_WORKER_SCRIPT_TIMEOUT_MS })
    const check = await readJsonFile(path.join(project.dir, 'work', 'report', `bgm_check_ep${bgmPad(ep)}.json`), null)
    const fails = check && Array.isArray(check.fails) ? check.fails.map(String) : []
    const warns = check && Array.isArray(check.warnings) ? check.warnings.map(String) : check && Array.isArray(check.warns) ? check.warns.map(String) : []
    return { ok: result.exitCode === 0 && fails.length === 0, exitCode: result.exitCode, fails, warns, check, stdout: result.stdout, stderr: result.stderr }
  }

  async function callBgmLlm(prompt, signal, onTextDelta, timeoutMs = 300_000) {
    const { llm, provider, model } = await resolveLlmTarget()
    let text = ''
    let usage = null
    let finish = null
    let error = null
    const chunkTypes = {}
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('bgm llm timeout')), timeoutMs)
    const combinedSignal = signal ? (AbortSignal.any ? AbortSignal.any([signal, controller.signal]) : controller.signal) : controller.signal
    try {
      const stream = llm.stream({
        provider,
        model,
        system: prompt.system,
        messages: normalizePromptMessages(prompt.messages),
        maxTokens: Number(prompt.maxTokens) || 4096,
        temperature: typeof prompt.temperature === 'number' ? prompt.temperature : 0.2,
        reasoningEffort: 'low',
        signal: combinedSignal,
      })
      for await (const chunk of stream) {
        if (!chunk || typeof chunk.type !== 'string') continue
        chunkTypes[chunk.type] = (chunkTypes[chunk.type] || 0) + 1
        if (chunk.type === 'text-delta') {
          text += chunk.text
          if (typeof onTextDelta === 'function' && chunk.text) {
            try {
              onTextDelta(chunk.text)
            } catch {
              // live preview is best-effort
            }
          }
        } else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') {
          finish = chunk.reason
          if (chunk.reason && chunk.reason.kind === 'error') error = (chunk.reason.failure && chunk.reason.failure.message) || 'llm error'
          if (chunk.reason && chunk.reason.kind === 'aborted' && !error) error = 'aborted'
        }
      }
    } catch (caught) {
      if (signal && signal.aborted) throw new Error('cancelled')
      error = String((caught && caught.message) || caught)
    } finally {
      clearTimeout(timer)
    }
    if (error) throw new Error(error)
    return { text, usage, finish, chunkTypes, provider, model }
  }

  async function callBgmStage({ record, project, state, entry, role, ep, attempt, prompt, purpose, log }) {
    // deepseek-flash may spend a full 1024-token reasoning budget on the QC prompt
    // before emitting its one-line verdict (observed finish=max-tokens, text empty).
    // Keep the contract parameters but guarantee headroom for the visible answer.
    const effectivePrompt = role === 'bgm-qc' ? { ...prompt, maxTokens: Math.max(Number(prompt.maxTokens) || 0, 4096) } : prompt
    const promptChars = JSON.stringify(effectivePrompt).length
    emitJob(record, { type: 'bgm-start', ep, role, attempt, promptChars, purpose: purpose || role })
    let deltaBuffer = ''
    let lastDeltaAt = Date.now()
    const flushDelta = () => {
      if (!deltaBuffer) return
      const chunk = deltaBuffer
      deltaBuffer = ''
      emitJob(record, { type: 'bgm-delta', ep, role, attempt, delta: chunk })
      lastDeltaAt = Date.now()
    }
    const onTextDelta = (delta) => {
      if (!delta) return
      deltaBuffer += delta
      if (deltaBuffer.length >= 1200 || Date.now() - lastDeltaAt >= 200) flushDelta()
    }
    const startedAt = Date.now()
    let result
    try {
      result = await callBgmLlm(effectivePrompt, record.controller.signal, onTextDelta, (BGM_LLM[role.replace('bgm-', '')] || BGM_LLM.worker).timeoutMs)
    } finally {
      flushDelta()
    }
    const durationMs = Date.now() - startedAt
    emitJob(record, { type: 'bgm-end', ep, role, attempt, chars: String(result.text || '').length, finish: result.finish || null })
    const callCost = costForUsage(result.usage || {}, new Date())
    if (!state.cost) state.cost = emptyCost()
    addCost(state.cost, callCost)
    if (entry) {
      if (!entry.cost) entry.cost = emptyCost()
      addCost(entry.cost, callCost)
      addTokens(entry.tokens, result.usage)
    }
    addTokens(state.tokens, result.usage)
    updateBudget(state, 'bgm', record, log)
    const rawText = String(result.text || '')
    const rawDir = path.join(project.dir, 'work', 'logs', 'llm')
    await fs.mkdir(rawDir, { recursive: true })
    const suffix = ep > 0 ? `ep${bgmPad(ep)}` : 'series'
    const base = path.join(rawDir, `bgm-${role}-${suffix}-attempt${attempt}`)
    await writeTextAtomic(`${base}.txt`, rawText.slice(0, 400_000))
    await writeJsonAtomic(`${base}.json`, {
      role,
      ep,
      attempt,
      provider: result.provider,
      model: result.model,
      finish: result.finish,
      chunkTypes: result.chunkTypes,
      usage: result.usage || null,
      cost: callCost,
      promptChars,
      rawChars: rawText.length,
      durationMs,
      purpose: purpose || role,
    })
    await appendTokenLog(project, {
      ts: new Date().toISOString(),
      jobId: jobIdOfRecord(record),
      stage: 'bgm',
      role,
      purpose: purpose || role,
      ep,
      attempt,
      provider: result.provider,
      model: result.model,
      usage: result.usage || null,
      cost: callCost,
      tariff: callCost.tariff,
      finish: result.finish,
      chunkTypes: result.chunkTypes,
      promptChars,
      rawChars: rawText.length,
      durationMs,
    })
    emitJob(record, {
      type: 'token',
      ep,
      role,
      stage: 'bgm',
      usage: result.usage || null,
      cost: callCost,
      costTotal: state.cost ? { ...state.cost } : { ...callCost },
      budget: state.budget || null,
    })
    if (log) log.push(`BGM ${role} ep=${ep || 'series'} attempt=${attempt} chars=${rawText.length}`)
    return result
  }

  async function runBgmArchitect({ project, context, record, state, log }) {
    let lastError = ''
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (record.controller.signal.aborted) throw new Error('cancelled')
      emitJob(record, { type: 'phase', phase: 'architect', index: 1, total: BGM_PHASES.length })
      await updateJob(record, { phase: 'architect', phaseIndex: 1 }, { persist: false })
      const prompt = buildBgmArchitectPrompt({ context })
      const result = await callBgmStage({
        record,
        project,
        state,
        entry: null,
        role: 'bgm-architect',
        ep: 0,
        attempt,
        prompt,
        purpose: 'series-bible',
        log,
      })
      const parsed = parseBgmArchitectOutput(result.text)
      if (!parsed.ok) {
        lastError = (parsed.errors || []).join('; ') || 'architect parse failed'
        log.push(`BGM architect attempt ${attempt} parse failed: ${lastError}`)
        continue
      }
      await fs.mkdir(path.join(project.dir, 'work', 'meta'), { recursive: true })
      await writeTextAtomic(path.join(project.dir, 'work', 'meta', 'series-bible.md'), `${String(parsed.seriesBible || '').trim()}\n`)
      await writeJsonAtomic(path.join(project.dir, 'work', 'meta', 'theme-map.json'), parsed.themeMap || { themes: [] })
      state.seriesBible = true
      state.themeMap = true
      await persistBgmState(project, state)
      return true
    }
    throw new Error(`bgm architect failed: ${lastError}`)
  }

  function parseBgmQcResult(parsed) {
    if (!parsed) return { ok: false, verdict: 'FAIL', feedback: 'qc parse failed' }
    if (parsed.ok === false) return { ok: false, verdict: 'FAIL', feedback: (parsed.errors || []).join('; ') || 'qc parse failed' }
    const verdict = parsed.verdict === 'PASS' ? 'PASS' : 'FAIL'
    return { ok: true, verdict, feedback: parsed.detail || parsed.line || '' }
  }

  async function runBgmEpisode({ project, context, record, state, entry, indexMeta, log, maxAttempts = BGM_MAX_ATTEMPTS, seedRetryText = '' }) {
    const ep = entry.ep
    entry.state = 'writing'
    await persistBgmState(project, state)
    emitJob(record, { type: 'episode', ep, state: 'writing', attempts: entry.attempts, check: entry.check, qc: entry.qc, cost: entry.cost })
    let retryText = seedRetryText || ''
    let previousBgm = ''
    let parseError = ''
    let qcFeedback = ''
    const baseAttempts = entry.attempts || 0
    for (let localAttempt = 1; localAttempt <= maxAttempts; localAttempt += 1) {
      if (record.controller.signal.aborted) throw new Error('cancelled')
      entry.attempts = baseAttempts + localAttempt
      entry.state = 'writing'
      await persistBgmState(project, state)
      emitJob(record, { type: 'phase', phase: 'write', index: 2, total: BGM_PHASES.length })
      emitJob(record, { type: 'episode', ep, state: 'writing', attempts: entry.attempts, check: entry.check, qc: entry.qc, cost: entry.cost })
      await fs.mkdir(path.join(project.dir, 'work', 'bgm'), { recursive: true })
      await fs.rm(path.join(project.dir, 'work', 'bgm', `ep${bgmPad(ep)}.md`), { force: true })
      await fs.rm(path.join(project.dir, 'work', 'report', `bgm_ep${bgmPad(ep)}.json`), { force: true })
      const prompt = buildBgmWorkerPrompt({
        context,
        projectDir: project.dir,
        ep,
        retryText,
        previousBgm,
        parseError,
        qcFeedback,
        checkFails: entry.check && Array.isArray(entry.check.fails) ? entry.check.fails : [],
      })
      const result = await callBgmStage({
        record,
        project,
        state,
        entry,
        role: 'bgm-worker',
        ep,
        attempt: entry.attempts,
        prompt,
        purpose: 'bgm-write',
        log,
      })
      const parsed = parseBgmWorkerOutput(result.text)
      if (!parsed.ok) {
        parseError = (parsed.errors || []).join('; ') || 'worker parse failed'
        previousBgm = String(result.text || '').slice(0, 6000)
        retryText = buildBgmRetryInstruction({ parseError })
        entry.error = parseError
        log.push(`BGM EP${ep} attempt ${entry.attempts} parse failed: ${parseError}`)
        continue
      }
      entry.artifacts = await writeBgmOutputs(project, ep, parsed)
      entry.statusLine = parsed.statusLine || null
      entry.error = null
      previousBgm = String(parsed.bgm || '')
      emitJob(record, { type: 'phase', phase: 'check', index: 3, total: BGM_PHASES.length })
      entry.state = 'machine_checking'
      await persistBgmState(project, state)
      const check = await runBgmCheck(project, ep)
      entry.check = { exitCode: check.exitCode, fails: check.fails, warns: check.warns }
      entry.artifacts.check = `work/report/bgm_check_ep${bgmPad(ep)}.json`
      if (!check.ok) {
        entry.state = 'retry_wait'
        retryText = buildBgmRetryInstruction({ checkFails: check.fails })
        log.push(`BGM EP${ep} attempt ${entry.attempts} machine check failed: ${check.fails.slice(0, 3).join(' | ')}`)
        if (localAttempt >= maxAttempts) {
          entry.state = 'failed'
          entry.error = check.fails.slice(0, 5).join(' | ') || 'bgm check failed'
          break
        }
        await persistBgmState(project, state)
        emitJob(record, { type: 'episode', ep, state: 'retry_wait', attempts: entry.attempts, check: entry.check, qc: entry.qc, cost: entry.cost })
        continue
      }
      emitJob(record, { type: 'phase', phase: 'qc', index: 4, total: BGM_PHASES.length })
      entry.state = 'qc_running'
      entry.qcAttempts = (entry.qcAttempts || 0) + 1
      await persistBgmState(project, state)
      const qcPrompt = buildBgmQcPrompt({ context, projectDir: project.dir, ep, draftMarkdown: String(parsed.bgm || '') })
      const qcResult = await callBgmStage({
        record,
        project,
        state,
        entry,
        role: 'bgm-qc',
        ep,
        attempt: entry.qcAttempts,
        prompt: qcPrompt,
        purpose: 'bgm-qc',
        log,
      })
      const qc = parseBgmQcResult(parseBgmQcOutput(qcResult.text))
      entry.qc = { verdict: qc.verdict, feedback: qc.feedback }
      entry.artifacts.qc = `work/report/bgm_qc_ep${bgmPad(ep)}.json`
      await writeJsonAtomic(path.join(project.dir, 'work', 'report', `bgm_qc_ep${bgmPad(ep)}.json`), {
        ep,
        verdict: qc.verdict,
        feedback: qc.feedback,
        at: new Date().toISOString(),
      })
      if (qc.verdict === 'PASS') {
        entry.state = 'passed'
        await persistBgmState(project, state)
        emitJob(record, { type: 'episode', ep, state: 'passed', attempts: entry.attempts, check: entry.check, qc: entry.qc, cost: entry.cost })
        return entry
      }
      qcFeedback = qc.feedback || 'QC FAIL'
      retryText = buildBgmRetryInstruction({ checkFails: [], qcFeedback, parseError })
      entry.state = 'retry_wait'
      log.push(`BGM EP${ep} attempt ${entry.attempts} QC FAIL: ${qcFeedback.slice(0, 120)}`)
      if (localAttempt >= maxAttempts) {
        entry.state = 'failed'
        entry.error = qcFeedback || 'bgm qc failed'
        break
      }
      await persistBgmState(project, state)
      emitJob(record, { type: 'episode', ep, state: 'retry_wait', attempts: entry.attempts, check: entry.check, qc: entry.qc, cost: entry.cost })
    }
    if (entry.state !== 'failed') entry.state = entry.state === 'passed' ? 'passed' : 'failed'
    await persistBgmState(project, state)
    emitJob(record, { type: 'episode', ep, state: entry.state, attempts: entry.attempts, check: entry.check, qc: entry.qc, cost: entry.cost, error: entry.error })
    return entry
  }

  async function collectBgmArtifacts(project) {
    const index = await readBgmIndex(project)
    const stem = (index && index.stem) || '剧本'
    const outputDir = path.join(project.dir, 'output')
    const readDir = async (dir) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        return entries.filter((entry) => entry.isFile()).map((entry) => path.join(dir, entry.name))
      } catch {
        return []
      }
    }
    const relative = (file) => path.relative(project.dir, file).replace(/\\/g, '/')
    const files = await readDir(outputDir)
    const find = (base) => files.find((file) => path.basename(file) === base) || null
    const planMd = find(`${stem}_配乐方案.md`) || find(`${stem}_配乐方案_部分完成.md`)
    const planDocx = find(`${stem}_配乐方案.docx`) || find(`${stem}_配乐方案_部分完成.docx`)
    const auditReport = find('配乐终检报告.md')
    const outputs = files.filter((file) => /_配乐方案|配乐终检报告/.test(path.basename(file))).map(relative)
    const seriesBiblePath = path.join(project.dir, 'work', 'meta', 'series-bible.md')
    const themeMapPath = path.join(project.dir, 'work', 'meta', 'theme-map.json')
    const [seriesBible, themeMap] = await Promise.all([
      fs.access(seriesBiblePath).then(() => 'work/meta/series-bible.md').catch(() => null),
      fs.access(themeMapPath).then(() => 'work/meta/theme-map.json').catch(() => null),
    ])
    return {
      planMd: planMd ? relative(planMd) : null,
      planDocx: planDocx ? relative(planDocx) : null,
      auditReport: auditReport ? relative(auditReport) : null,
      outputs,
      seriesBible,
      themeMap,
    }
  }

  async function runBgmAuditor({ project, context, record, state, auditAttempt, log }) {
    const artifacts = await collectBgmArtifacts(project)
    if (!artifacts.planMd) return null
    const mergedMarkdown = await readBgmText(project, artifacts.planMd)
    if (!mergedMarkdown.trim()) return null
    const prompt = buildBgmAuditorPrompt({ context, mergedMarkdown })
    const result = await callBgmStage({
      record,
      project,
      state,
      entry: null,
      role: 'bgm-auditor',
      ep: 0,
      attempt: auditAttempt,
      prompt,
      purpose: 'bgm-audit',
      log,
    })
    const parsed = parseBgmAuditorOutput(result.text)
    if (parsed.ok === false) {
      log.push(`BGM auditor parse failed: ${(parsed.errors || []).join('; ')}`)
      return null
    }
    const audit = parsed.audit || { status: 'PASS', issues: [] }
    await writeJsonAtomic(path.join(project.dir, 'work', 'report', 'audit_agent.json'), {
      ...audit,
      at: new Date().toISOString(),
      attempt: auditAttempt,
    })
    state.audit = audit
    return audit
  }

  async function finishBgmJob({ project, record, state, context, index, targets, log }) {
    const allEps = (index && Array.isArray(index.episodes) ? index.episodes : []).map((item) => Number(item.ep))
    const entries = Object.values(state.episodes || {})
    const passed = entries.filter((entry) => entry.state === 'passed').length
    const failed = entries.filter((entry) => entry.state === 'failed').length
    const partial = targets.length < allEps.length || failed > 0 || passed < entries.length
    const partialArgs = partial ? ['--allow-partial'] : []
    const runStep = async (phase, script, args, required) => {
      emitJob(record, { type: 'phase', phase, index: BGM_PHASES.indexOf(phase), total: BGM_PHASES.length })
      await updateJob(record, { phase, phaseIndex: BGM_PHASES.indexOf(phase) }, { persist: false })
      emitJob(record, { type: 'log', level: 'info', message: `run ${script} ${args.join(' ')}`.trim() })
      const result =
        script === 'bgm_build_docx.py'
          ? await runScriptWithWordLockRetry({
              project,
              script,
              args,
              record,
              log,
              timeoutMs: BGM_WORKER_SCRIPT_TIMEOUT_MS,
            })
          : await runProjectScript(project, script, args, { timeoutMs: BGM_WORKER_SCRIPT_TIMEOUT_MS })
      log.push(`${script} exit=${result.exitCode}`)
      if (!result.ok && required) {
        const hint = result.exitCode === 3 ? '输出 docx 被占用，请关闭 Word/WPS 后重试' : `脚本 ${script} 失败（exit ${result.exitCode}）`
        throw new Error(hint)
      }
      return result
    }
    await runStep('merge', 'bgm_merge.py', partialArgs, true)
    await runStep('build', 'bgm_build_docx.py', partialArgs, true)
    emitJob(record, { type: 'phase', phase: 'audit', index: 7, total: BGM_PHASES.length })
    await updateJob(record, { phase: 'audit', phaseIndex: 7 }, { persist: false })
    let audit = null
    try {
      audit = await runBgmAuditor({ project, context, record, state, auditAttempt: 1, log })
      if (audit && audit.status === 'FIX' && Array.isArray(audit.issues) && audit.issues.length > 0) {
        const repairEps = Array.from(new Set(audit.issues.map((issue) => Number(issue && issue.ep)).filter((ep) => Number.isFinite(ep) && ep > 0)))
        let repaired = false
        for (const ep of repairEps) {
          const entry = state.episodes[ep]
          if (!entry || entry.state !== 'passed') continue
          const detail = audit.issues.filter((issue) => Number(issue.ep) === ep).map((issue) => `[${issue.type || 'issue'}] ${issue.detail || ''}`).join('；')
          log.push(`BGM audit FIX repair EP${ep}`)
          await runBgmEpisode({
            project,
            context,
            record,
            state,
            entry,
            indexMeta: null,
            log,
            maxAttempts: 1,
            seedRetryText: buildBgmRetryInstruction({ auditorDetail: detail }),
          })
          repaired = true
        }
        if (repaired) {
          await runStep('merge', 'bgm_merge.py', partialArgs, true)
          await runStep('build', 'bgm_build_docx.py', partialArgs, true)
          audit = (await runBgmAuditor({ project, context, record, state, auditAttempt: 2, log })) || audit
        }
      }
    } catch (error) {
      log.push(`BGM auditor skipped: ${String((error && error.message) || error)}`)
    }
    emitJob(record, { type: 'phase', phase: 'report', index: 8, total: BGM_PHASES.length })
    await updateJob(record, { phase: 'report', phaseIndex: 8 }, { persist: false })
    const finalAudit = await runProjectScript(project, 'bgm_final_audit.py', [], { timeoutMs: BGM_WORKER_SCRIPT_TIMEOUT_MS })
    log.push(`bgm_final_audit.py exit=${finalAudit.exitCode}`)
    const artifacts = await collectBgmArtifacts(project)
    state.artifacts = artifacts
    state.audit = audit || state.audit || null
    const finalEntries = Object.values(state.episodes || {})
    const passedFinal = finalEntries.filter((entry) => entry.state === 'passed').length
    const failedFinal = finalEntries.filter((entry) => entry.state === 'failed').length
    const auditFix = Boolean(state.audit && state.audit.status === 'FIX')
    const partialFinal = targets.length < allEps.length || failedFinal > 0 || passedFinal < finalEntries.length || auditFix
    state.checkPassRate = finalEntries.length > 0 ? Number((passedFinal / finalEntries.length).toFixed(4)) : null
    state.state = finalAudit.ok && !partialFinal ? 'succeeded' : 'partial'
    state.finishedAt = new Date().toISOString()
    await persistBgmState(project, state)
    const result = {
      status: state.state,
      kind: 'bgm',
      episodes: {
        total: finalEntries.length,
        passed: passedFinal,
        failed: failedFinal,
        retried: finalEntries.filter((entry) => entry.attempts > 1).length,
        partial: partialFinal,
      },
      tokens: state.tokens,
      cost: state.cost || emptyCost(),
      budget: state.budget || null,
      checkPassRate: state.checkPassRate,
      audit: state.audit,
      finalAudit: { exitCode: finalAudit.exitCode, ok: finalAudit.ok, stdout: (finalAudit.stdout || '').slice(-2000) },
      artifacts,
      seriesBible: state.seriesBible,
      themeMap: state.themeMap,
    }
    await updateJob(record, { state: 'succeeded', result, error: null, finishedAt: new Date().toISOString() }, { persist: false })
    await commitBgmMeta(project, state, state.state === 'succeeded' ? 'bgm_done' : 'bgm_partial')
    try {
      await record.writeChain
    } catch {
      // ignore
    }
    await persistJob(record)
    emitJob(record, { type: 'done', job: publicJob(record.job), result })
    return result
  }

  async function commitBgmMeta(project, state, status) {
    await writeMeta(project, (meta) => ({
      ...meta,
      status,
      bgm: {
        state: state.state,
        jobId: state.jobId,
        finishedAt: state.finishedAt,
        progress: state.progress,
        tokens: state.tokens,
        cost: state.cost || emptyCost(),
        artifacts: state.artifacts,
        checkPassRate: state.checkPassRate,
      },
    }))
  }

  async function bgmReadyForProject(project) {
    if (modeOf(project.meta) === MODE_20) {
      const status = String(project.meta.status || '')
      if (!['preflight_done', 'refine2_done', 'refine2_partial', 'refine_done', 'refine_partial'].includes(status)) return false
      try {
        const entries = await fs.readdir(path.join(project.dir, 'work', 'source'))
        return entries.some((name) => /^ep\d+\.md$/i.test(name))
      } catch {
        return false
      }
    }
    const refineState = await readRefineState(project)
    return Boolean(refineState && ['succeeded', 'partial'].includes(String(refineState.state || '').toLowerCase()))
  }

  function startBgmJob(project, options = {}) {
    if (projectActive.has(project.id)) return { ok: false, error: 'project is busy', code: 'BUSY' }
    const id = `job-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 6)}`
    if (!JOB_ID_RE.test(id)) return { ok: false, error: 'job id generation failed', code: 'INTERNAL' }
    const job = {
      schema: 'lianben/job/1',
      id,
      projectId: project.id,
      kind: 'bgm',
      state: 'queued',
      phase: null,
      phaseIndex: -1,
      phases: BGM_PHASES.slice(),
      episodes: { total: 0, done: 0 },
      error: null,
      result: null,
      seq: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      failureKind: null,
      detection: null,
      params: {
        episodes: Array.isArray(options.episodes) ? options.episodes.map(Number) : null,
        concurrency: options.concurrency ? Number(options.concurrency) : null,
      },
    }
    const controller = new AbortController()
    const record = makeRecord(project.dir, job, { live: true, controller })
    jobs.set(id, record)
    projectActive.set(project.id, id)
    void persistJob(record)
    emitJob(record, { type: 'job', job: publicJob(job) })
    const log = []

    const run = async () => {
      let state = null
      try {
        const bgmReady = await bgmReadyForProject(project)
        if (!bgmReady) throw new Error(modeOf(project.meta) === MODE_20 ? '请先完成 2.0 前置（需要 work/source 分集存档）' : '请先完成炼本（需要 refine_done/partial）')
        await updateJob(record, { state: 'running', startedAt: new Date().toISOString() }, { persist: false })
        emitJob(record, { type: 'log', level: 'info', message: 'bgm job started' })
        emitJob(record, { type: 'phase', phase: 'prepare', index: 0, total: BGM_PHASES.length })
        await updateJob(record, { phase: 'prepare', phaseIndex: 0 }, { persist: false })
        await ensureProjectToolchain(project)
        await ensureProjectBgmAssets(project)
        const prep = await runProjectScript(project, 'bgm_prepare.py', [], { timeoutMs: BGM_WORKER_SCRIPT_TIMEOUT_MS })
        if (!prep.ok) throw new Error(`bgm_prepare.py 失败（exit ${prep.exitCode}）`)
        const index = await readBgmIndex(project)
        if (!index || !Array.isArray(index.episodes) || index.episodes.length === 0) throw new Error('bgm_index.json 为空')
        const allEps = index.episodes.map((item) => Number(item.ep))
        const requested = Array.isArray(options.episodes) ? options.episodes.map(Number) : null
        const targets = requested ? requested.filter((ep) => allEps.includes(ep)) : allEps
        if (targets.length === 0) throw new Error('没有可配乐的集')
        const titles = Object.fromEntries(index.episodes.map((item) => [Number(item.ep), item.title || '']))
        state = newBgmState(id, targets, titles)
        const biblePath = path.join(project.dir, 'work', 'meta', 'series-bible.md')
        const themePath = path.join(project.dir, 'work', 'meta', 'theme-map.json')
        const [bibleExists, themeExists] = await Promise.all([
          fs.access(biblePath).then(() => true).catch(() => false),
          fs.access(themePath).then(() => true).catch(() => false),
        ])
        state.seriesBible = bibleExists
        state.themeMap = themeExists
        for (const ep of targets) state.episodes[ep] = emptyBgmEpisode(ep, titles[ep] || '')
        await persistBgmState(project, state)
        record.job.episodes = { total: targets.length, done: 0 }
        await updateJob(record, { episodes: record.job.episodes }, { persist: false })
        emitJob(record, { type: 'log', level: 'info', message: `targets=${targets.join(',')} (${targets.length}/${allEps.length})` })
        const context = await loadBgmContext({ projectDir: project.dir, engineDir: modeOf(project.meta) === MODE_20 ? ENGINE2_DIR : ENGINE_DIR })
        if (!state.seriesBible || !state.themeMap) {
          await runBgmArchitect({ project, context, record, state, log })
          context.seriesBible = await readBgmText(project, 'work/meta/series-bible.md')
          context.themeMap = await readJsonFile(themePath, null)
        }
        emitJob(record, { type: 'phase', phase: 'write', index: 2, total: BGM_PHASES.length })
        const concurrency = Math.max(1, Math.min(20, Number(options.concurrency) || Number((config.bgm && config.bgm.concurrency) ?? 20) || 20))
        await runPool(
          targets,
          concurrency,
          (ep) => runBgmEpisode({ project, context, record, state, entry: state.episodes[ep], indexMeta: index.episodes.find((item) => Number(item.ep) === ep), log }),
          record.controller.signal,
        )
        if (record.controller.signal.aborted) throw new Error('cancelled')
        record.job.episodes.done = Object.values(state.episodes || {}).filter((entry) => ['passed', 'failed'].includes(entry.state)).length
        await updateJob(record, { episodes: record.job.episodes }, { persist: false })
        await finishBgmJob({ project, record, state, context, index, targets, log })
      } catch (error) {
        const message = String((error && error.message) || error)
        const cancelled = record.cancelRequested || record.controller.signal.aborted
        const budgetExceeded = Boolean(error && error.code === 'BUDGET_EXCEEDED')
        const wordLocked = Boolean(error && error.code === 'WORD_LOCKED')
        const needsConfirm = budgetExceeded || wordLocked
        if (state) {
          state.state = cancelled ? 'cancelled' : needsConfirm ? 'needs_confirm' : 'failed'
          state.finishedAt = new Date().toISOString()
          state.artifacts = await collectBgmArtifacts(project).catch(() => null)
          await persistBgmState(project, state).catch(() => {})
          const metaStatus = cancelled ? 'bgm_cancelled' : needsConfirm ? 'bgm_needs_confirm' : 'bgm_failed'
          await commitBgmMeta(project, state, metaStatus).catch(() => {})
        }
        await updateJob(record, {
          state: cancelled ? 'cancelled' : needsConfirm ? 'needs_confirm' : 'failed',
          failureKind: cancelled ? 'cancelled' : budgetExceeded ? 'budget' : wordLocked ? 'word_locked' : 'host',
          error: cancelled ? 'cancelled by user' : message,
          result: state
            ? { status: state.state, tokens: state.tokens, cost: state.cost, budget: state.budget || null, artifacts: state.artifacts, episodes: state.progress }
            : null,
          finishedAt: new Date().toISOString(),
        }, { persist: false })
        try {
          await record.writeChain
        } catch {
          // ignore
        }
        await persistJob(record)
        emitJob(record, { type: 'error', error: cancelled ? 'cancelled' : message, job: publicJob(record.job) })
        log.push(`bgm job ${needsConfirm ? 'needs_confirm' : 'failed'}: ${message}`)
      } finally {
        projectActive.delete(project.id)
        try {
          record.controller.abort()
        } catch {
          // ignore
        }
      }
    }
    void run()
    return { ok: true, job: publicJob(record.job) }
  }

  async function handleProjectBgm(request) {
    const id = new URL(request.url).searchParams.get('id')
    const project = await readProject(id)
    if (!project) return jsonResponse({ ok: false, error: 'project not found', code: 'NOT_FOUND' }, 404)
    const state = await readBgmState(project)
    const job = await latestBgmJob(project)
    const pricing = pricingSnapshot()
    const refineReady = await bgmReadyForProject(project)
    if (!state) {
      return jsonResponse({ ok: true, bgm: { schema: 'lianben/bgm_state/1', state: 'pending', progress: null, episodes: [], artifacts: null, tokens: null, cost: null, job: job ? publicJob(job) : null, pricing, refineReady } })
    }
    const summary = bgmSummary(state) || { state: 'unknown', episodes: [] }
    const episodes = (summary.episodes || []).map((entry) => {
      const item = { ...entry }
      if (!item.cost && item.tokens) {
        item.cost = { ...costForTokenLedger(item.tokens, new Date(state.finishedAt || state.startedAt || Date.now())), estimated: true }
      }
      return item
    })
    const seriesBible = await readBgmText(project, 'work/meta/series-bible.md')
    const themeMap = await readJsonFile(path.join(project.dir, 'work', 'meta', 'theme-map.json'), null)
    return jsonResponse({
      ok: true,
      bgm: {
        ...summary,
        episodes,
        job: job ? publicJob(job) : null,
        pricing,
        refineReady,
        seriesBible: seriesBible ? seriesBible.slice(0, 12000) : '',
        themeMap,
      },
    })
  }

  async function handleProjectBgmDraft(request) {
    const url = new URL(request.url)
    const id = url.searchParams.get('id')
    const ep = Number(url.searchParams.get('ep'))
    const project = await readProject(id)
    if (!project) return jsonResponse({ ok: false, error: 'project not found', code: 'NOT_FOUND' }, 404)
    if (!Number.isFinite(ep) || ep < 1) return jsonResponse({ ok: false, error: 'invalid episode', code: 'BAD_INPUT' }, 400)
    const padded = bgmPad(ep)
    return jsonResponse({
      ok: true,
      episode: {
        ep,
        markdown: await readBgmText(project, `work/bgm/ep${padded}.md`),
        report: await readJsonFile(path.join(project.dir, 'work', 'report', `bgm_ep${padded}.json`), null),
        check: await readJsonFile(path.join(project.dir, 'work', 'report', `bgm_check_ep${padded}.json`), null),
        qc: await readJsonFile(path.join(project.dir, 'work', 'report', `bgm_qc_ep${padded}.json`), null),
      },
    })
  }

  async function toolListProjects(query) {
    const url = new URL('http://local/api/lianben/projects')
    if (query) url.searchParams.set('query', String(query))
    return listProjects(url)
  }

  async function toolExecute(args) {
    const action = String((args && args.action) || '')
    if (action === 'health') {
      const [python, engine] = await Promise.all([probePython(), engineInfo()])
      return {
        bundle: BUNDLE,
        version: VERSION,
        workspace,
        projectsRoot,
        python: { ok: python.ok, python: python.python || null },
        engine,
        pricing: pricingSnapshot(),
        jobPhases: JOB_PHASES,
        refinePhases: REFINE_PHASES,
        bgmPhases: BGM_PHASES,
      }
    }
    if (action === 'list_projects') return { projects: await toolListProjects(args && args.query) }
    if (action === 'project') {
      const snapshot = await getSnapshot(args && args.projectId)
      if (!snapshot) throw new Error('project not found')
      return { snapshot }
    }
    if (action === 'run_preflight') {
      const project = await readProject(args && args.projectId)
      if (!project) throw new Error('project not found')
      const jobResult = startJob('rerun-preflight', project)
      if (!jobResult.ok) throw new Error(jobResult.error || 'cannot start job')
      return jobResult
    }
    if (action === 'run_refine') {
      const project = await readProject(args && args.projectId)
      if (!project) throw new Error('project not found')
      const jobResult = startRefineJob(project, {
        episodes: args && args.episodes,
        concurrency: args && args.concurrency,
      })
      if (!jobResult.ok) throw new Error(jobResult.error || 'cannot start refine job')
      return jobResult
    }
    if (action === 'run_bgm') {
      const project = await readProject(args && args.projectId)
      if (!project) throw new Error('project not found')
      const jobResult = startBgmJob(project, {
        episodes: args && args.episodes,
        concurrency: args && args.concurrency,
      })
      if (!jobResult.ok) throw new Error(jobResult.error || 'cannot start bgm job')
      return jobResult
    }
    if (action === 'bgm') {
      const project = await readProject(args && args.projectId)
      if (!project) throw new Error('project not found')
      const state = await readBgmState(project)
      const job = await latestBgmJob(project)
      return { bgm: state ? { ...bgmSummary(state), episodes: Object.values(state.episodes || {}) } : null, job: job ? publicJob(job) : null }
    }
    if (action === 'job') {
      const record = await findJob(args && args.jobId)
      if (!record) throw new Error('job not found')
      return { job: publicJob(record.job) }
    }
    if (action === 'cancel') {
      return cancelJob(args && args.jobId)
    }
    if (action === 'selfcheck') return ensureSelfCheck('tool')
    if (action === 'refine') {
      const project = await readProject(args && args.projectId)
      if (!project) throw new Error('project not found')
      const state = await readRefineState(project)
      const job = await latestRefineJob(project)
      return { refine: state ? { ...refineSummary(state), episodes: Object.values(state.episodes || {}) } : null, job: job ? publicJob(job) : null }
    }
    throw new Error(`unknown action: ${action}`)
  }

  // -------------------------------------------------------------------------
  // Route handlers
  // -------------------------------------------------------------------------

  async function handleHealth() {
    const [python, engine] = await Promise.all([probePython(), engineInfo()])
    return jsonResponse({
      ok: true,
      bundle: BUNDLE,
      version: VERSION,
      workspace,
      projectsRoot,
      python: { ok: python.ok, python: python.python || null, error: python.error || null },
      engine,
      routes: routePaths.slice(),
      jobPhases: JOB_PHASES,
      refinePhases: REFINE_PHASES,
      bgmPhases: BGM_PHASES,
      pricing: pricingSnapshot(),
      now: new Date().toISOString(),
    })
  }

  async function handleMode(request) {
    await ensureModeLoaded()
    if (request.method === 'GET') {
      return jsonResponse({ ok: true, mode: activeMode, modes: MODES })
    }
    const body = await readJsonBody(request)
    if (!body || typeof body !== 'object' || !body.mode) {
      return jsonResponse({ ok: false, error: 'mode is required', code: 'BAD_INPUT' }, 400)
    }
    try {
      const mode = await setActiveMode(String(body.mode))
      return jsonResponse({ ok: true, mode, modes: MODES })
    } catch (error) {
      return jsonResponse({ ok: false, error: String((error && error.message) || error), code: 'BAD_MODE' }, 400)
    }
  }

  async function handlePricing() {
    return jsonResponse({ ok: true, pricing: pricingSnapshot() })
  }

  async function handleProjects(request) {
    const url = new URL(request.url)
    return jsonResponse({ ok: true, projects: await listProjects(url) })
  }

  async function handleProject(request) {
    const id = new URL(request.url).searchParams.get('id')
    const snapshot = await getSnapshot(id)
    if (!snapshot) return jsonResponse({ ok: false, error: 'project not found', code: 'NOT_FOUND' }, 404)
    return jsonResponse({ ok: true, snapshot })
  }

  async function handleReport(request) {
    const url = new URL(request.url)
    const id = url.searchParams.get('id')
    const project = await readProject(id)
    if (!project) return jsonResponse({ ok: false, error: 'project not found', code: 'NOT_FOUND' }, 404)
    const summary = summaryFromMeta(project.meta) || {}
    let relative = project.meta.preflight && project.meta.preflight.reportMd ? project.meta.preflight.reportMd : null
    if (!relative && summary.report) relative = summary.report.md || null
    if (!relative) {
      const reportDir = path.join(project.dir, 'report')
      try {
        const entries = await fs.readdir(reportDir)
        const candidate = entries.find((entry) => entry.endsWith('.md') && !entry.startsWith('.'))
        if (candidate) relative = `report/${candidate}`
      } catch {
        // no report
      }
    }
    if (!relative) return jsonResponse({ ok: false, error: 'report not found', code: 'NOT_FOUND' }, 404)
    const file = path.resolve(project.dir, relative)
    if (!isInside(project.dir, file)) return jsonResponse({ ok: false, error: 'invalid path', code: 'BAD_PATH' }, 400)
    try {
      const markdown = await fs.readFile(file, 'utf8')
      if (url.searchParams.get('format') === 'json') return jsonResponse({ ok: true, path: relative, markdown })
      return textResponse(markdown, 200, 'text/markdown; charset=utf-8')
    } catch {
      return jsonResponse({ ok: false, error: 'report not readable', code: 'IO_ERROR' }, 500)
    }
  }

  async function handleEpisode(request) {
    const url = new URL(request.url)
    const id = url.searchParams.get('id')
    const ep = Number(url.searchParams.get('ep'))
    const project = await readProject(id)
    if (!project) return jsonResponse({ ok: false, error: 'project not found', code: 'NOT_FOUND' }, 404)
    if (!Number.isFinite(ep) || ep < 1) return jsonResponse({ ok: false, error: 'invalid episode', code: 'BAD_INPUT' }, 400)
    const snapshot = await getSnapshot(id)
    const episode = snapshot && snapshot.episodes ? snapshot.episodes.find((entry) => entry.ep === ep) : null
    const padded = String(ep).padStart(2, '0')
    let markdown = ''
    try {
      markdown = await fs.readFile(path.join(project.dir, 'work', 'source', `ep${padded}.md`), 'utf8')
    } catch {
      markdown = ''
    }
    let findings = []
    try {
      findings = await buildEpisodeFindings(project.dir, ep)
    } catch {
      findings = []
    }
    return jsonResponse({ ok: true, episode: { ...(episode || { ep }), markdown, findings } })
  }

  async function handleOptions(request) {
    const body = await readJsonBody(request)
    if (!body || typeof body !== 'object') return jsonResponse({ ok: false, error: 'invalid JSON body' }, 400)
    const project = await readProject(body.id)
    if (!project) return jsonResponse({ ok: false, error: 'project not found', code: 'NOT_FOUND' }, 404)
    if (projectActive.has(project.id)) return jsonResponse({ ok: false, error: 'project is busy', code: 'BUSY' }, 409)
    const patch = sanitizeOptions(body.options)
    const previousOverrides = (project.meta.options && project.meta.options.check_overrides) || {}
    const patchOverrides = (patch && patch.check_overrides) || {}
    const hasPatchPacing = Object.prototype.hasOwnProperty.call(patchOverrides, 'pacing')
    const previousPacing = previousOverrides.pacing || {}
    const patchPacing = hasPatchPacing ? patchOverrides.pacing || {} : {}
    const mergedPacing = hasPatchPacing
      ? (Object.keys(patchPacing).length === 0 ? {} : { ...previousPacing, ...patchPacing })
      : { ...previousPacing }
    const merged = {
      ...(project.meta.options || {}),
      ...patch,
      check_overrides: {
        ...previousOverrides,
        ...patchOverrides,
        pacing: mergedPacing,
      },
    }
    if (Object.keys(merged.check_overrides.pacing).length === 0) delete merged.check_overrides.pacing
    if (Object.keys(merged.check_overrides).length === 0) merged.check_overrides = {}
    const profile = await writeCheckProfile(project, merged)
    await writeMeta(project, (meta) => ({ ...meta, options: merged, checkProfile: profile }))
    return jsonResponse({ ok: true, options: merged, checkProfile: profile, requiresRerun: true })
  }

  async function handleAction(request) {
    const body = await readJsonBody(request)
    if (!body || typeof body !== 'object') return jsonResponse({ ok: false, error: 'invalid JSON body' }, 400)
    const id = body.id
    const action = body.action
    const project = await readProject(id)
    if (!project) return jsonResponse({ ok: false, error: 'project not found', code: 'NOT_FOUND' }, 404)
    if (action === 'rerun-preflight') {
      if (projectActive.has(id)) return jsonResponse({ ok: false, error: 'project is busy', code: 'BUSY' }, 409)
      if (project.meta && project.meta.merge && Array.isArray(project.meta.merge.episodes) && project.meta.merge.episodes.length > 0) {
        return jsonResponse({
          ok: false,
          error: '项目源稿已按建议合并；重跑前置会用 docx 覆盖合并结果。请先在前置检查点「恢复合并前原文」，再重跑。',
          code: 'MERGED_SOURCE',
        }, 409)
      }
      const archivedTo = await archiveProjectWork(project.dir)
      const fresh = await readProject(id)
      const jobResult = startJob('rerun-preflight', fresh || project)
      if (!jobResult.ok) return jsonResponse(jobResult, jobResult.code === 'BUSY' ? 409 : 500)
      return jsonResponse({ ok: true, archivedTo, job: jobResult.job }, 202)
    }
    if (action === 'run-refine') {
      if (projectActive.has(id)) return jsonResponse({ ok: false, error: 'project is busy', code: 'BUSY' }, 409)
      const jobResult = modeOf(project.meta) === MODE_20
        ? startStoryboardJob(project, { episodes: body.episodes, concurrency: body.concurrency })
        : startRefineJob(project, {
            episodes: body.episodes,
            concurrency: body.concurrency,
          })
      if (!jobResult.ok) return jsonResponse(jobResult, jobResult.code === 'BUSY' ? 409 : 500)
      return jsonResponse({ ok: true, job: jobResult.job }, 202)
    }
    if (action === 'run-bgm') {
      if (projectActive.has(id)) return jsonResponse({ ok: false, error: 'project is busy', code: 'BUSY' }, 409)
      const jobResult = startBgmJob(project, {
        episodes: body.episodes,
        concurrency: body.concurrency,
      })
      if (!jobResult.ok) return jsonResponse(jobResult, jobResult.code === 'BUSY' ? 409 : 500)
      return jsonResponse({ ok: true, job: jobResult.job }, 202)
    }
    if (action === 'archive') {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const archiveRoot = path.join(projectsRoot, '.archive')
      await fs.mkdir(archiveRoot, { recursive: true })
      const target = path.join(archiveRoot, `${id}-${timestamp}`)
      await fs.rename(project.dir, target)
      return jsonResponse({ ok: true, archivedTo: target })
    }
    if (action === 'delete') {
      await fs.rm(project.dir, { recursive: true, force: true })
      return jsonResponse({ ok: true, deleted: id })
    }
    return jsonResponse({ ok: false, error: `unknown action: ${String(action)}` }, 400)
  }

  async function handleMergeGet(request) {
    const url = new URL(request.url)
    const id = url.searchParams.get('id')
    const project = await readProject(id)
    if (!project) return jsonResponse({ ok: false, error: 'project not found', code: 'NOT_FOUND' }, 404)
    try {
      return jsonResponse(await mergeSuggestions(project))
    } catch (error) {
      return jsonResponse({ ok: false, error: String((error && error.message) || error), code: 'MERGE_SUGGESTIONS_FAILED' }, 500)
    }
  }

  async function handleMergePost(request) {
    const body = await readJsonBody(request)
    if (!body || typeof body !== 'object') return jsonResponse({ ok: false, error: 'body required', code: 'BAD_INPUT' }, 400)
    const id = body.id || body.projectId
    const project = await readProject(id)
    if (!project) return jsonResponse({ ok: false, error: 'project not found', code: 'NOT_FOUND' }, 404)
    const action = String(body.action || 'preview')
    const mode = body.mode === 'llm' ? 'llm' : 'deterministic'
    try {
      if (action === 'preview') {
        if (mode === 'llm') {
          return jsonResponse(await buildLlmMergePreview(project, body.episodes))
        }
        const plans = await buildMergePlans(project, body.episodes)
        return jsonResponse({ ok: true, dryRun: true, preview: mergePreview(plans), aiUsed: false })
      }
      if (action === 'apply-batch') {
        if (body.confirm !== true) {
          return jsonResponse({ ok: false, error: 'apply-batch requires explicit confirm:true', code: 'CONFIRM_REQUIRED' }, 400)
        }
        if (mode !== 'llm') return jsonResponse({ ok: false, error: 'apply-batch only supports mode:llm', code: 'BAD_INPUT' }, 400)
        if (mergeActive.has(project.id)) return jsonResponse({ ok: false, error: 'merge already in progress', code: 'BUSY' }, 409)
        mergeActive.add(project.id)
        try {
          const result = await applyLlmBatchPreviews(project, body.previewIds)
          const snapshot = await getSnapshot(project.id).catch(() => null)
          return jsonResponse({ ok: true, result, snapshot })
        } finally {
          mergeActive.delete(project.id)
        }
      }
      if (action === 'apply') {
        if (body.confirm !== true) {
          return jsonResponse({ ok: false, error: 'apply requires explicit confirm:true', code: 'CONFIRM_REQUIRED' }, 400)
        }
        if (mergeActive.has(project.id)) return jsonResponse({ ok: false, error: 'merge already in progress', code: 'BUSY' }, 409)
        mergeActive.add(project.id)
        try {
          if (mode === 'llm') {
            const result = await applyLlmMergePreview(project, body.previewId)
            const snapshot = await getSnapshot(project.id).catch(() => null)
            return jsonResponse({ ok: true, result, snapshot })
          }
          const plans = await buildMergePlans(project, body.episodes)
          const result = await applyMergePlans(project, plans)
          const snapshot = await getSnapshot(project.id).catch(() => null)
          return jsonResponse({ ok: true, result, snapshot })
        } finally {
          mergeActive.delete(project.id)
        }
      }
      if (action === 'restore') {
        if (body.confirm !== true) {
          return jsonResponse({ ok: false, error: 'restore requires explicit confirm:true', code: 'CONFIRM_REQUIRED' }, 400)
        }
        if (mergeActive.has(project.id)) return jsonResponse({ ok: false, error: 'merge already in progress', code: 'BUSY' }, 409)
        mergeActive.add(project.id)
        try {
          const result = await restoreMerge(project)
          const snapshot = await getSnapshot(project.id).catch(() => null)
          return jsonResponse({ ok: true, result, snapshot })
        } finally {
          mergeActive.delete(project.id)
        }
      }
      return jsonResponse({ ok: false, error: `unknown merge action: ${action}`, code: 'BAD_INPUT' }, 400)
    } catch (error) {
      return jsonResponse({ ok: false, error: String((error && error.message) || error), code: 'MERGE_FAILED' }, 422)
    }
  }

  async function handleMerge(request) {
    if (request.method === 'GET') return handleMergeGet(request)
    return handleMergePost(request)
  }


  async function handleMigrateLegacy(request) {
    const body = await readJsonBody(request)
    if (!body || typeof body !== 'object' || typeof body.source !== 'string' || !body.source.trim()) {
      return jsonResponse({ ok: false, error: 'source is required', code: 'BAD_INPUT' }, 400)
    }
    const source = path.resolve(body.source.trim())
    let stat = null
    try {
      stat = await fs.stat(source)
    } catch {
      stat = null
    }
    if (!stat || !stat.isDirectory()) {
      return jsonResponse({ ok: false, error: 'legacy project source not found or not a directory', code: 'NOT_FOUND' }, 404)
    }
    const script = path.join(ENGINE_DIR, 'tools', 'migrate_legacy.py')
    try {
      await fs.access(script)
    } catch {
      return jsonResponse({ ok: false, error: 'migrate_legacy.py is not installed', code: 'INTERNAL' }, 500)
    }
    const python = await probePython()
    if (!python.ok) return jsonResponse({ ok: false, error: python.error || 'python unavailable', code: 'PYTHON_MISSING' }, 500)
    const subprocess = ctx.get('subprocess')
    if (!subprocess) return jsonResponse({ ok: false, error: 'subprocess service unavailable', code: 'INTERNAL' }, 500)
    const argv = [python.python, script, '--source', source, '--projects-root', projectsRoot, '--json']
    if (body.title && String(body.title).trim()) argv.push('--title', String(body.title).trim())
    try {
      const handle = subprocess.spawn({
        argv,
        cwd: workspace,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 2 * 1024 * 1024 } },
        graceMs: 3000,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      })
      const outcome = await handle.done
      const stdout = readCollected(handle, 'stdout')
      const stderr = readCollected(handle, 'stderr')
      if (outcome.exitCode !== 0) {
        return jsonResponse({
          ok: false,
          error: (stderr || stdout || `migration failed (exit ${outcome.exitCode})`).slice(-4000),
          code: 'MIGRATION_FAILED',
        }, 422)
      }
      let parsed = null
      for (const line of String(stdout).split(/\r?\n/).reverse()) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        try {
          parsed = JSON.parse(trimmed)
          break
        } catch {
          // keep looking
        }
      }
      const newProjectId = parsed && (parsed.projectId || parsed.id)
      if (!newProjectId) {
        return jsonResponse({ ok: false, error: 'migration output has no projectId', code: 'MIGRATION_FAILED', stdout: String(stdout).slice(-4000) }, 500)
      }
      const project = await readProject(newProjectId)
      const snapshot = project ? await getSnapshot(newProjectId) : null
      return jsonResponse({
        ok: true,
        project: project
          ? { id: project.id, title: project.meta.title || project.meta.id || project.id, dir: project.dir }
          : { id: newProjectId, title: parsed.title || newProjectId, dir: parsed.path || null },
        migration: parsed,
        snapshot,
      })
    } catch (error) {
      return jsonResponse({ ok: false, error: String((error && error.message) || error), code: 'MIGRATION_FAILED' }, 500)
    }
  }


  async function handleFile(request) {
    const url = new URL(request.url)
    const id = url.searchParams.get('id')
    const relative = url.searchParams.get('path')
    const project = await readProject(id)
    if (!project) return jsonResponse({ ok: false, error: 'project not found', code: 'NOT_FOUND' }, 404)
    if (!relative) return jsonResponse({ ok: false, error: 'path is required' }, 400)
    const file = path.resolve(project.dir, relative)
    if (!isInside(project.dir, file)) return jsonResponse({ ok: false, error: 'invalid path', code: 'BAD_PATH' }, 400)
    if (!DOWNLOAD_EXTENSIONS.has(path.extname(file).toLowerCase())) return jsonResponse({ ok: false, error: 'file type not allowed', code: 'BAD_TYPE' }, 400)
    try {
      const data = await fs.readFile(file)
      return new Response(data, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
          'content-disposition': contentDisposition(path.basename(file)),
        },
      })
    } catch {
      return jsonResponse({ ok: false, error: 'file not found', code: 'NOT_FOUND' }, 404)
    }
  }

  async function stageUpload(request, originalName) {
    await ensureProjectsRoot()
    const staged = path.join(tmpDir, `${Date.now()}-${randomUUID()}.docx`)
    const handle = await fs.open(staged, 'w')
    let bytes = 0
    let header = Buffer.alloc(0)
    try {
      if (request.body) {
        const reader = request.body.getReader()
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > MAX_UPLOAD_BYTES) throw new Error(`upload exceeds ${MAX_UPLOAD_BYTES} bytes`)
            if (header.length < 4) header = Buffer.concat([header, Buffer.from(chunk.value.subarray(0, 4 - header.length))])
            await handle.write(chunk.value)
          }
        } finally {
          reader.releaseLock()
        }
      }
    } finally {
      await handle.close()
    }
    if (bytes === 0) {
      await fs.rm(staged, { force: true })
      return { ok: false, error: 'empty upload', code: 'EMPTY_BODY' }
    }
    if (!(header.length >= 4 && header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04)) {
      await fs.rm(staged, { force: true })
      return { ok: false, error: 'file is not a zip-based .docx', code: 'BAD_MAGIC' }
    }
    return { ok: true, staged, bytes, originalName }
  }

  async function handleImport(request) {
    const url = new URL(request.url)
    const provider = url.searchParams.get('provider')
    void provider
    const originalName = sanitizeFileName(url.searchParams.get('name') || 'script.docx')
    if (!/\.docx$/i.test(originalName)) return jsonResponse({ ok: false, error: 'only .docx files are accepted', code: 'BAD_TYPE' }, 400)
    const title = sanitizeTitle(url.searchParams.get('title') || originalName.replace(/\.docx$/i, ''))
    const sync = url.searchParams.get('sync') === '1'
    const llmCorrection = url.searchParams.get('correction') === '1'
    let staged
    try {
      const uploaded = await stageUpload(request, originalName)
      if (!uploaded.ok) return jsonResponse(uploaded, 400)
      staged = uploaded.staged
      if (sync) {
        const created = await createProjectFromDocx({ stagedPath: staged, originalName, title, llmCorrection })
        if (!created.ok) {
          return jsonResponse({ ok: false, error: created.error, code: created.code || 'PREFLIGHT_FAILED', project: created.project, detail: created.detail || null }, created.code === 'NEEDS_CONFIRM' ? 409 : 500)
        }
        return jsonResponse({ ok: true, project: { id: created.project.id, title: created.project.title }, snapshot: created.snapshot })
      }
      const project = await scaffoldProject({ stagedPath: staged, originalName, title, llmCorrection })
      const jobResult = startJob('import-preflight', project)
      if (!jobResult.ok) return jsonResponse(jobResult, 500)
      return jsonResponse({ ok: true, project: { id: project.id, title: project.meta.title }, job: jobResult.job }, 202)
    } catch (error) {
      return jsonResponse({ ok: false, error: String((error && error.message) || error), code: 'IMPORT_FAILED' }, 500)
    } finally {
      if (staged) await fs.rm(staged, { force: true }).catch(() => {})
    }
  }

  async function handleJob(request) {
    const url = new URL(request.url)
    const jobId = url.searchParams.get('id')
    const record = await findJob(jobId)
    if (!record) return jsonResponse({ ok: false, error: 'job not found', code: 'NOT_FOUND' }, 404)
    const project = await readProject(record.job.projectId)
    const snapshot = project
      ? buildSnapshot(record.job.projectId, project.meta, record.job)
      : buildSnapshot(record.job.projectId, {}, record.job)
    if (project) {
      const refineState = await readRefineState(project)
      snapshot.refine = refineSummary(refineState)
      const bgmState = await readBgmState(project)
      snapshot.bgm = bgmSummary(bgmState)
      snapshot.pricing = pricingSnapshot()
    }
    return jsonResponse({ ok: true, job: publicJob(record.job), project: snapshot ? snapshot.project : null, snapshot })
  }

  async function handleJobCancel(request) {
    const body = await readJsonBody(request)
    if (!body || typeof body !== 'object' || !body.jobId) return jsonResponse({ ok: false, error: 'jobId is required', code: 'BAD_INPUT' }, 400)
    const result = await cancelJob(body.jobId)
    return jsonResponse(result, result.ok ? 200 : result.code === 'NOT_FOUND' ? 404 : result.code === 'FINISHED' ? 409 : 400)
  }

  async function handleEvents(request) {
    const url = new URL(request.url)
    const jobId = url.searchParams.get('jobId')
    const record = await findJob(jobId)
    if (!record) return jsonResponse({ ok: false, error: 'job not found', code: 'NOT_FOUND' }, 404)
    const lastEventIdHeader = request.headers.get('last-event-id') || url.searchParams.get('lastEventId') || '0'
    const lastEventId = Number.parseInt(lastEventIdHeader, 10)
    const encoder = new TextEncoder()
    let closed = false
    let heartbeat = null
    let listener = null
    const stream = new ReadableStream({
      async start(controller) {
        const send = (frame) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`id: ${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`))
          } catch {
            closed = true
          }
        }
        const close = () => {
          if (closed) return
          closed = true
          if (heartbeat) clearInterval(heartbeat)
          if (listener) record.listeners.delete(listener)
          try {
            controller.close()
          } catch {
            // already closed
          }
        }
        const replay = await readJobEvents(record, Number.isFinite(lastEventId) ? lastEventId : 0)
        for (const frame of replay) send(frame)
        const terminalReplay = replay.some((frame) => frame.type === 'done' || frame.type === 'error')
        if (terminalReplay || isTerminalState(record.job.state)) {
          if (!terminalReplay) send({ type: 'job', seq: record.job.seq || 0, job: publicJob(record.job) })
          close()
          return
        }
        if (!record.live) {
          send({ type: 'job', seq: record.job.seq || 0, job: publicJob(record.job) })
        }
        listener = { send, close }
        record.listeners.add(listener)
        send({ type: 'job', seq: record.job.seq || 0, job: publicJob(record.job) })
        heartbeat = setInterval(() => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(': ping\n\n'))
          } catch {
            close()
          }
        }, 15_000)
      },
      cancel() {
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        if (listener) record.listeners.delete(listener)
      },
    })
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  }

  async function handleClientReport(request) {
    const body = await readJsonBody(request)
    if (body === null) return jsonResponse({ ok: false, error: 'invalid JSON body' }, 400)
    const file = path.join(dataDir, 'client-report.json')
    await writeJsonAtomic(file, { receivedAt: new Date().toISOString(), report: body })
    return jsonResponse({ ok: true, storedAt: file })
  }

  // -------------------------------------------------------------------------
  // Startup self-check (python + engine + fixture + sync import + async job)
  // -------------------------------------------------------------------------

  async function runFixtureAcceptance() {
    const fixture = path.join(FIXTURES_DIR, 'sample-20eps.docx')
    try {
      await fs.access(fixture)
    } catch {
      return { ok: false, skipped: true, reason: 'fixture not installed (engine/fixtures/sample-20eps.docx)' }
    }
    const root = path.join(dataDir, 'acceptance', 'latest')
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(path.join(root, '剧本输入'), { recursive: true })
    await fs.copyFile(fixture, path.join(root, '剧本输入', 'sample-20eps.docx'))
    const startedAt = Date.now()
    const result = await runEngine(['preflight', '--root', root], { timeoutMs: PREFLIGHT_TIMEOUT_MS })
    const durationMs = Date.now() - startedAt
    const summary = result.json || null
    const episodes = summary && Array.isArray(summary.episodes) ? summary.episodes : []
    const blocked = summary && summary.project && Array.isArray(summary.project.blocked_eps) ? summary.project.blocked_eps : []
    const checks = summary && summary.checks ? Object.keys(summary.checks) : []
    let sourceFiles = []
    try {
      sourceFiles = (await fs.readdir(path.join(root, 'work', 'source'))).filter((entry) => /^ep\d{2}\.md$/.test(entry))
    } catch {
      // ignore
    }
    return {
      ok: result.ok && episodes.length > 0,
      skipped: false,
      fixture,
      projectRoot: root,
      durationMs,
      exitCode: result.exitCode,
      python: result.python || null,
      episodes: episodes.length,
      sourceFiles: sourceFiles.length,
      blockedEps: blocked,
      checks,
      detection: summary ? summary.detection || null : null,
      report: summary ? summary.report || null : null,
      error: result.ok ? null : (result.json && result.json.error) || result.error || null,
    }
  }

  async function runSyncImportCheck() {
    const fixture = path.join(FIXTURES_DIR, 'sample-20eps.docx')
    try {
      await fs.access(fixture)
    } catch {
      return { ok: false, skipped: true, reason: 'fixture missing' }
    }
    const created = await createProjectFromDocx({ stagedPath: fixture, originalName: 'sample-20eps.docx', title: 'M2 自检样例', mode: MODE_10 })
    const result = created.ok
      ? {
          ok: true,
          projectId: created.project.id,
          episodes: created.snapshot.stats.episodes,
          blockedEps: created.snapshot.stats.blocked,
          checks: Object.keys(created.snapshot.checks || {}),
          report: created.snapshot.report,
          projectStatus: created.project.status,
        }
      : { ok: false, error: created.error || 'import failed', code: created.code || null }
    if (created.ok) await fs.rm(path.join(projectsRoot, created.project.id), { recursive: true, force: true }).catch(() => {})
    return result
  }

  async function runJobCheck() {
    const fixture = path.join(FIXTURES_DIR, 'sample-3eps.docx')
    try {
      await fs.access(fixture)
    } catch {
      return { ok: false, skipped: true, reason: 'fixture missing (sample-3eps.docx)' }
    }
    const project = await scaffoldProject({ stagedPath: fixture, originalName: 'sample-3eps.docx', title: 'M2 Job 自检', mode: MODE_10 })
    const started = startJob('import-preflight', project)
    if (!started.ok) {
      await fs.rm(project.dir, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: started.error }
    }
    const record = jobs.get(started.job.id)
    const waited = await waitJobTerminal(record, 120_000)
    // The terminal job state is committed slightly before the terminal SSE frame
    // is flushed; wait for the done/error frame so the self-check sees the full
    // event sequence.
    let eventsText = ''
    for (let attempt = 0; attempt < 30; attempt += 1) {
      eventsText = await fs.readFile(jobEventsFile(project.dir, started.job.id), 'utf8').catch(() => '')
      const terminalFrame = eventsText.includes('"type":"done"') || eventsText.includes('"type":"error"')
      if (terminalFrame) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const eventTypes = []
    let phaseCount = 0
    for (const line of eventsText.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const frame = JSON.parse(line)
        if (!eventTypes.includes(frame.type)) eventTypes.push(frame.type)
        if (frame.type === 'phase') phaseCount += 1
      } catch {
        // ignore
      }
    }
    const result = {
      ok:
        !waited.timeout &&
        record.job.state === 'succeeded' &&
        record.job.result &&
        record.job.result.episodes === 3 &&
        eventTypes.includes('phase') &&
        eventTypes.includes('episode') &&
        eventTypes.includes('done'),
      jobId: record.job.id,
      state: record.job.state,
      timeout: waited.timeout,
      episodes: record.job.result ? record.job.result.episodes : null,
      eventTypes,
      phaseCount,
      eventsFile: jobEventsFile(project.dir, started.job.id),
      error: record.job.error,
    }
    await fs.rm(project.dir, { recursive: true, force: true }).catch(() => {})
    return result
  }

  async function runHostSelfCheck(reason) {
    const startedAt = new Date().toISOString()
    const state = {
      schema: 'lianben/m3/host-selfcheck/1',
      bundle: BUNDLE,
      version: VERSION,
      reason,
      startedAt,
      workspace,
      projectsRoot,
      runtime: { node: process.version, platform: process.platform, pid: process.pid },
      python: null,
      engine: null,
      acceptance: null,
      syncImport: null,
      asyncJob: null,
      jobPhases: JOB_PHASES,
      refinePhases: REFINE_PHASES,
      bgmPhases: BGM_PHASES,
      pricing: pricingSnapshot(),
    }
    try {
      state.python = await probePython(true)
    } catch (error) {
      state.python = { ok: false, error: String((error && error.message) || error) }
    }
    try {
      state.engine = await engineInfo(true)
    } catch (error) {
      state.engine = { available: false, error: String((error && error.message) || error) }
    }
    try {
      state.acceptance = await runFixtureAcceptance()
    } catch (error) {
      state.acceptance = { ok: false, error: String((error && error.message) || error) }
    }
    try {
      state.syncImport = await runSyncImportCheck()
    } catch (error) {
      state.syncImport = { ok: false, error: String((error && error.message) || error) }
    }
    try {
      state.asyncJob = await runJobCheck()
    } catch (error) {
      state.asyncJob = { ok: false, error: String((error && error.message) || error) }
    }
    state.finishedAt = new Date().toISOString()
    lastSelfCheck = state
    try {
      await fs.mkdir(dataDir, { recursive: true })
      await writeJsonAtomic(path.join(dataDir, 'host-selfcheck.json'), state)
    } catch (error) {
      console.error(`[${BUNDLE}] failed to write self-check:`, error)
    }
    console.log(
      `[${BUNDLE}] self-check python=${Boolean(state.python && state.python.ok)} engine=${Boolean(
        state.engine && state.engine.available,
      )} acceptance=${Boolean(state.acceptance && state.acceptance.ok)} syncImport=${Boolean(
        state.syncImport && state.syncImport.ok,
      )} asyncJob=${Boolean(state.asyncJob && state.asyncJob.ok)}`,
    )
    return state
  }

  async function ensureSelfCheck(reason) {
    if (lastSelfCheck && reason === 'lazy') return lastSelfCheck
    if (selfCheckInFlight) return selfCheckInFlight
    selfCheckInFlight = runHostSelfCheck(reason).finally(() => {
      selfCheckInFlight = null
    })
    return selfCheckInFlight
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  const route = (suffix, methods, requestBody, fetchImpl) => {
    const routePath = `${API}/${suffix}`
    routePaths.push(routePath)
    return { path: routePath, methods, requestBody, fetch: fetchImpl }
  }

  const routes = [
    route('health', ['GET', 'HEAD'], 'buffered', () => handleHealth()),
    route('mode', ['GET', 'POST'], 'buffered', (request) => handleMode(request)),
    route('pricing', ['GET'], 'buffered', () => handlePricing()),
    route('projects', ['GET'], 'buffered', (request) => handleProjects(request)),
    route('project', ['GET'], 'buffered', (request) => handleProject(request)),
    route('project/report', ['GET'], 'buffered', (request) => handleReport(request)),
    route('project/episode', ['GET'], 'buffered', (request) => handleEpisode(request)),
    route('project/refine', ['GET'], 'buffered', (request) => handleProjectRefine(request)),
    route('project/draft', ['GET'], 'buffered', (request) => handleProjectDraft(request)),
    route('project/bgm', ['GET'], 'buffered', (request) => handleProjectBgm(request)),
    route('project/bgm-draft', ['GET'], 'buffered', (request) => handleProjectBgmDraft(request)),
    route('project/action', ['POST'], 'buffered', (request) => handleAction(request)),
    route('project/options', ['POST'], 'buffered', (request) => handleOptions(request)),
    route('project/merge', ['GET', 'POST'], 'buffered', (request) => handleMerge(request)),
    route('migrate-legacy', ['POST'], 'buffered', (request) => handleMigrateLegacy(request)),
    route('file', ['GET'], 'buffered', (request) => handleFile(request)),
    route('import', ['POST'], 'streaming', (request) => handleImport(request)),
    route('job', ['GET'], 'buffered', (request) => handleJob(request)),
    route('events', ['GET'], 'buffered', (request) => handleEvents(request)),
    route('job/cancel', ['POST'], 'buffered', (request) => handleJobCancel(request)),
    route('selfcheck', ['GET'], 'buffered', async () => jsonResponse(await ensureSelfCheck('lazy'))),
    route('run-selfcheck', ['POST'], 'buffered', async () => jsonResponse(await ensureSelfCheck('manual'))),
    route('m3/client-report', ['POST'], 'buffered', (request) => handleClientReport(request)),
    route('m2/client-report', ['POST'], 'buffered', (request) => handleClientReport(request)),
    route('m1/client-report', ['POST'], 'buffered', (request) => handleClientReport(request)),
  ]

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  ctx.effect(() => {
    const disposers = []
    for (const definition of routes) {
      try {
        disposers.push(ctx.connection.fetch.register(definition))
      } catch (error) {
        console.error(`[${BUNDLE}] failed to register route ${definition.path}:`, error)
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          const result = dispose()
          if (result && typeof result.catch === 'function') result.catch(() => {})
        } catch {
          // ignore teardown errors
        }
      }
    }
  }, `${BUNDLE}: M2 fetch routes`)

  ctx.effect(() => {
    const tools = ctx.get('tools')
    if (!tools || typeof tools.register !== 'function') return () => {}
    const definition = {
      name: 'lianben_workbench',
      description:
        '炼本工作台：查看项目/前置/炼本/配乐状态，触发前置、炼本或配乐作业，查询/取消作业。action: health|list_projects|project|run_preflight|run_refine|run_bgm|job|cancel|selfcheck|refine|bgm。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['health', 'list_projects', 'project', 'run_preflight', 'run_refine', 'run_bgm', 'job', 'cancel', 'selfcheck', 'refine', 'bgm'],
          },
          projectId: { type: 'string' },
          jobId: { type: 'string' },
          query: { type: 'string' },
          episodes: { type: 'array', items: { type: 'integer' } },
          concurrency: { type: 'integer' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args) => toolExecute(args),
    }
    try {
      return tools.register(definition)
    } catch (error) {
      console.error(`[${BUNDLE}] failed to register lianben_workbench tool:`, error)
      return () => {}
    }
  }, `${BUNDLE}: lianben_workbench tool`)

  ctx.effect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        await recoverInterruptedJobs().catch((error) => console.error(`[${BUNDLE}] job recovery failed:`, error))
        await ensureSelfCheck('startup').catch((error) => console.error(`[${BUNDLE}] startup self-check failed:`, error))
      })()
    }, 1200)
    return () => clearTimeout(timer)
  }, `${BUNDLE}: M2 startup recovery + self-check`)

  console.log(
    `[${BUNDLE}] host half active; workspace=${workspace}; projectsRoot=${projectsRoot}; engine=${ENGINE_DIR}; routes=${routes
      .map((entry) => entry.path)
      .join(',')}`,
  )
}
