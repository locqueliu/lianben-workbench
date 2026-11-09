/**
 * prompts/bgm.mjs — M4「配乐（BGM 提示词）」prompt 资产：上下文加载、四类 prompt 构建、输出解析、重试指令、token 估算。
 *
 * 契约（Host 直接 import，保持稳定）：
 *   loadBgmContext({ projectDir, engineDir }) -> Promise<BgmContext>
 *   buildBgmWorkerPrompt({ context, projectDir, ep, retryText, previousBgm, parseError, qcFeedback, checkFails })
 *   buildBgmQcPrompt({ context, projectDir, ep, draftMarkdown })
 *   buildBgmArchitectPrompt({ context })
 *   buildBgmAuditorPrompt({ context, mergedMarkdown })
 *   parseBgmWorkerOutput(text) / parseBgmQcOutput(text) / parseBgmArchitectOutput(text) / parseBgmAuditorOutput(text)
 *   buildBgmRetryInstruction(input) / estimateBgmPromptTokens(prompt)
 *
 * 依据：docs/13 §3.2–3.5、reference/.opencode/agents/bgm-{worker,qc,architect,auditor}.md、
 *       engine/rules/bgm配乐规则/00–07 + global-style（9 份，逐字注入、按文件名排序、带分隔标记）。
 *
 * 本模块不写文件、不调用模型；worker/qc 只注入本集 source/index 切片，不注入其他集正文；
 * architect 注入全剧摘要 digest，auditor 注入全剧合并稿（均为阶段设计所需，不读其他集 source 正文）。
 * 主路径缺 `work/meta/{bgm_digest.md,bgm_index.json}` 时按 SOURCE 确定性派生（仅用于夹具/容错，派生标记见 context.derived）。
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

import {
  isFile,
  joinPath,
  listMarkdownFiles,
  readOptionalJson,
  readOptionalText,
  readTextFile,
  tryReadTextFileSync,
} from '../lib/refine-fs.mjs'
import {
  firstNonEmptyLine,
  normalizeOutputText,
  parseJsonLoose,
  splitSentinelSections,
  stripOuterFence,
} from '../lib/refine-text.mjs'
import {
  estimatePromptStats as statsOfPrompt,
  estimatePromptTokens as estimateTokensOfPrompt,
} from '../lib/refine-token.mjs'

export const BGM_PROMPT_VERSION = 'm4.1'

export const BGM_SENTINELS = Object.freeze({
  bgm: '===BGM_MD===',
  report: '===REPORT_JSON===',
  status: '===STATUS===',
  bible: '===SERIES_BIBLE_MD===',
  themeMap: '===THEME_MAP_JSON===',
  audit: '===AUDIT_JSON===',
})

const RULES_DIR_NAME = 'bgm配乐规则'
const RULES_CACHE = new Map()

const WORKER_MAX_TOKENS = 2048
const WORKER_TEMPERATURE = 0.5
const QC_MAX_TOKENS = 1024
const QC_TEMPERATURE = 0.1
const ARCHITECT_MAX_TOKENS = 4096
const ARCHITECT_TEMPERATURE = 0.4
const AUDITOR_MAX_TOKENS = 4096
const AUDITOR_TEMPERATURE = 0.1

const REASONING_EFFORT = 'low'

/* ------------------------------------------------------------------------- */
/* 静态 system（docs/13 §3.2–3.5；全项目稳定，利于前缀缓存）                     */
/* ------------------------------------------------------------------------- */

const BGM_WORKER_SYSTEM = `你是「BGM 配乐工人」（bgm-worker）。唯一任务：为指定的一集写一条可直接复制使用的 BGM 生成提示词集块（四行三段式），并严格按契约输出。你没有任何工具；规则包、全剧总纲与本集数据已随消息注入。

已注入《bgm配乐规则》全部技能文件与 series-bible（可为空）；规则包与本 system 同为硬约束。

必须遵守：
1. 只写本集事实：不引用其他集事件，不写「见前文/后文/下一集」，不编造人物、事件、关系结论。
2. 结构固定四行：标题行「第N集｜关键词A、关键词B与关键词C」；「情绪音：…」；「场景配乐：…」；「节奏／调性：…」。不写 Markdown 标题、表格、编号列表、解释与点评。
3. 情绪音：各 ≤1 秒；触发只允许转场、眼神特写、关键动作/台词落点；映射组 2–5 组「X用Y」；一个触发点一个音效，不写空话套话。
4. 场景配乐：起头用 series-bible 的「风格基底」原句 +「纯器乐。」；必须覆盖本集全部场次（源文有场次号时条目名必须含场次号；无场次号按叙事段落拆 1–4 条）；每场至少 1 组来自 03 技能库的乐器。若 series-bible 为空，按本剧题材拟定一句中性风格基底并全剧一致，不得默认中式/古装/宫廷。
5. 节奏／调性：调名 + BPM 曲线 + 对白/动态策略 + 收尾策略，四项齐全；BPM 日常 44–90、峰值 ≤122（硬上限 140）；必须写明对白让位策略，且每集至少一处留白。
6. 让位原则：旋律只写单音/≤4 音短动机；打击稀疏点缀；不写密集鼓点、强律动、四踩、长线条大旋律、高音区歌唱性旋律、全程渐强；对白/VO 段撤中高频旋律与打击，只留低频或环境。
7. 不写人声歌词；不使用禁用词/禁用乐器/占位词（略/同上/待定/自行发挥）；不默认中式/古装/宫廷，文化以 SOURCE 与 series-bible 为准。
8. 弱质检版：不修复源文本、不补写缺失场次、不新增 SOURCE 未建立的文化元素；场次以 bgm_index 切片为准。
9. 只输出契约三段（===BGM_MD=== / ===REPORT_JSON=== / ===STATUS===）；不输出解释、前言、尾注、Markdown 围栏，不输出工具调用。`

const BGM_QC_SYSTEM = `你是独立配乐质检代理（bgm-qc），只审查指定的这一集。只输出一行判定，不写文件、不加评价、不做整体点评、不提出跨集建议。

审查依据：注入的《bgm配乐规则》全部技能文件、series-bible（若存在）、本集 source 与 draft。
按 07-quality-rules 逐项检查：
1. 剧情契合：本集关键转折/揭露/爆发在情绪音或场景配乐中有具体对应；情绪音触发可指认（转场/眼神特写/动作/台词落点），空话即硬伤。
2. 场次覆盖：场景配乐覆盖本集全部场次，每场有具体乐器组，场名与情绪词契合源文。
3. 参数完整：节奏／调性含调名、BPM 曲线、对白/动态策略、收尾策略。
4. 一致性：基底风格与乐器签名与 series-bible 一致；词汇与技能库一致；无串集引用。
5. 禁令：无禁用词/禁用乐器、无人声歌词、无占位词；四行结构与长度（100~350 字）合规。
6. 可执行性：复制该集块能否直接生成配乐（无歧义、无空话）。
7. 让位性：旋律克制（无大旋律主导）、节奏轻（无密集鼓点/强律动/四踩）、对白段去节奏化、有留白；过重即硬伤。
8. 文化背景：不得默认中式/古装/宫廷；场景名/风格与 source 一致。

判定与输出：
- 无实质问题：只输出一行「EPnn PASS」
- 需要返修：只输出一行「EPnn FAIL: <最小可执行修正要求>」
FAIL 只写对配乐稿的修正要求，禁止出现命令、脚本名、路径、重跑建议（如 /配乐、python、--eps、bgm_worker）或其他集内容。`

const BGM_ARCHITECT_SYSTEM = `你是全剧配乐架构师（bgm-architect）。只依据注入的《bgm配乐规则》与《全剧分集摘要 bgm_digest》归纳，不编造剧情、不增加人物、不默认中式/古装/宫廷；题材、地域、时代以 SOURCE 为准。

产出（由编排器落盘为 work/meta/series-bible.md 与 work/meta/theme-map.json）：
1. series-bible.md 固定结构：
   # 全剧配乐总纲
   ## 剧名与基调（一段话：题材、声音世界、总基调）
   ## 风格基底（一句话，供每集「场景配乐」段起头复用；以本剧题材定名，不用泛词）
   ## 主题动机表（| 主题名 | 归属 | 音色签名 | 允许的演化 |，覆盖主要人物、核心关系、阴谋/道具线）
   ## 全剧配乐弧线（按集号范围描述演化节点）
   ## 复用与禁止（主题复用规则；与 global-style 的衔接）
2. theme-map.json 严格 JSON：{"style":"一句话风格总述（与风格基底一致）","themes":[{"name":"主题名","owner":"归属","signature":"音色签名"}]}

禁止：编造 digest 未体现的人物/事件/关系；自造异构主题命名；运行任何命令；输出解释性文字。
只输出三段：===SERIES_BIBLE_MD=== → ===THEME_MAP_JSON=== → ===STATUS=== BIBLE OK themes=<T>。`

const BGM_AUDITOR_SYSTEM = `你是全剧配乐终检代理（bgm-auditor）。对全剧合并稿做跨集一致性、主题漂移与质量终检，只输出一份审计 JSON（由编排器落盘），不修改成品、不写其他内容。

审查项：
1. 集块完整性：每集四行齐全（标题 + 情绪音 + 场景配乐 + 节奏／调性）；集号连续、标题唯一且含「集号｜关键词」。
2. 场次覆盖：每个集块的场景条目与该集源文一致（可用 bgm_index 核对）。
3. 触发质量：抽查每集至少 2 组情绪音映射，是否具体可指认、是否空话。
4. 主题一致性：基底风格全剧统一；乐器签名不漂移；主题命名与 theme-map 一致。
5. 跨集一致性：风格词汇/基调不漂移；无串集引用、无提前剧透。
6. 禁令：无禁用词/禁用乐器、无人声歌词、无占位词。
7. 让位与轻量：抽查是否存在旋律主导或节奏过重描述（大旋律、密集鼓点、四踩、强律动、全程渐强），对白让位与留白是否到位。
8. 文化背景：全剧不得出现 SOURCE 未建立的中国/东方文化元素；不得默认中式/古装/宫廷。

输出：{"status":"PASS|FIX","issues":[{"ep":<集号>,"type":"scene_missing|structure|consistency|forbidden|other","detail":"<最小可执行修正要求>"}]}；detail 必须是最小可执行修正要求，供定点回炉使用；无问题时 status=PASS、issues=[]。
只输出两段：===AUDIT_JSON=== → ===STATUS=== AUDIT PASS 或 AUDIT FIX n=<问题数>。不输出其他文字。`

/* ------------------------------------------------------------------------- */
/* 共享 schema / 契约片段                                                      */
/* ------------------------------------------------------------------------- */

const BGM_REPORT_SCHEMA = `{
  "ep": <集号数字>,
  "status": "OK",
  "scenes": ["<场次号或场名>"],
  "sfx_groups": <情绪音映射组数，数字>,
  "cjk": <本集块中文字数，数字>,
  "warnings": ["<可选：信息不足/缺总纲等说明>"]
}`

const THEME_MAP_SCHEMA = `{
  "style": "一句话风格总述（与 series-bible 风格基底一致）",
  "themes": [
    { "name": "主题名", "owner": "归属（人物/关系/线索）", "signature": "音色签名（具体乐器组合）" }
  ]
}`

const AUDIT_SCHEMA = `{
  "status": "PASS | FIX",
  "issues": [
    { "ep": <集号数字>, "type": "scene_missing | structure | consistency | forbidden | other", "detail": "最小可执行修正要求" }
  ]
}`

/* ------------------------------------------------------------------------- */
/* 工具                                                                        */
/* ------------------------------------------------------------------------- */

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function section(title, body) {
  return `【${title}】\n${body}`
}

function jsonBlock(value) {
  return JSON.stringify(value, null, 1)
}

function textOr(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || fallback
}

function normalizeEp(ep) {
  const n = Number(ep)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`E_EP_INVALID: ${String(ep)}`)
  return n
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

const SCENE_LINE_RE = /^\s*(\d{1,3})\s*[-－—–]\s*(\d{1,3})\s*(.*)$/
const CAST_LINE_RE = /^(?:出场人物|人物)\s*[：:]\s*(.+)$/

/** 从 SOURCE 确定性抽取场次号/场次名/人物（derived bgm_index 用，仅夹具/容错路径）。 */
export function extractScenesFromSource(sourceText) {
  const scenes = []
  const sceneNames = []
  for (const rawLine of String(sourceText ?? '').split('\n')) {
    const match = rawLine.match(SCENE_LINE_RE)
    if (!match) continue
    const id = `${Number(match[1])}-${Number(match[2])}`
    if (scenes.includes(id)) continue
    scenes.push(id)
    sceneNames.push(String(match[3] || '').trim())
  }
  return { scenes, scene_names: sceneNames }
}

function extractCharactersFromSource(sourceText) {
  const found = []
  for (const rawLine of String(sourceText ?? '').split('\n')) {
    const match = rawLine.trim().match(CAST_LINE_RE)
    if (!match) continue
    for (const name of match[1].split(/[、,，;；/\s]+/)) {
      const trimmed = name.trim()
      if (trimmed && !found.includes(trimmed)) found.push(trimmed)
    }
  }
  return found.slice(0, 12)
}

/** 由 SOURCE 构造单集索引记录（与 bgm_prepare 产出的 episode 结构对齐的常用字段）。 */
export function deriveEpisodeRecord(ep, sourceText) {
  const n = normalizeEp(ep)
  const { scenes, scene_names } = extractScenesFromSource(sourceText)
  const lines = String(sourceText ?? '').split('\n').filter((line) => line.trim())
  const body = lines.slice(1)
  return {
    ep: n,
    title: firstNonEmptyLine(sourceText),
    scenes,
    scene_names,
    characters: extractCharactersFromSource(sourceText),
    chars: String(sourceText ?? '').length,
    head: body[0] ? body[0].slice(0, 130) : '',
    tail: body.length ? body[body.length - 1].slice(0, 130) : '',
  }
}

/* ------------------------------------------------------------------------- */
/* 规则包加载（缓存文本与 hash）                                                */
/* ------------------------------------------------------------------------- */

async function loadBgmRules(engineDir) {
  const cacheKey = path.resolve(engineDir)
  const cached = RULES_CACHE.get(cacheKey)
  if (cached) return cached

  const rulesDir = joinPath(engineDir, 'rules', RULES_DIR_NAME)
  const files = await listMarkdownFiles(rulesDir)
  if (!files.length) throw new Error(`E_BGM_RULES_MISSING: ${rulesDir}`)
  files.sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'en'))

  const members = []
  const blocks = []
  for (const filePath of files) {
    const name = path.basename(filePath)
    const content = await readTextFile(filePath)
    blocks.push(`===== 规则文件：${name} =====\n\n${content}`)
    members.push({ name, chars: content.length })
  }
  const rulesText = blocks.join('\n\n')
  const pack = { rulesText, rulesHash: sha256(rulesText), members, files: files.map((f) => path.basename(f)) }
  RULES_CACHE.set(cacheKey, pack)
  return pack
}

/* ------------------------------------------------------------------------- */
/* 上下文加载                                                                  */
/* ------------------------------------------------------------------------- */

function deriveDigest({ project, episodes }) {
  const title = textOr(project?.title, '剧本')
  const lines = ['# 全剧分集摘要（由 SOURCE 确定性派生；建议改用 bgm_prepare.py 产物）', '', `- 剧本：${title}`, `- 集数：${episodes.length}`, '']
  for (const record of episodes) {
    lines.push(`## ${record.title || `第${record.ep}集`}`)
    lines.push(`- 场次：${record.scenes && record.scenes.length ? record.scenes.join('、') : '（未识别，按单场处理）'}`)
    lines.push(`- 人物：${record.characters && record.characters.length ? record.characters.join('、') : '（未识别）'}`)
    lines.push(`- 开头：${textOr(record.head, '（无）')}`)
    lines.push(`- 结尾：${textOr(record.tail, '（无）')}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 加载配乐阶段上下文（规则包/总纲/主题表/全剧摘要/单集索引/本集 source 访问器）。
 * 主路径读 work/meta/bgm_{digest.md,index.json}；缺失时按 SOURCE 确定性派生并标记 derived。
 *
 * @param {{ projectDir: string, engineDir: string }} options
 */
export async function loadBgmContext({ projectDir, engineDir } = {}) {
  if (!projectDir || typeof projectDir !== 'string') {
    throw new Error('E_PROJECT_DIR_REQUIRED: loadBgmContext 需要 projectDir')
  }
  if (!engineDir || typeof engineDir !== 'string') {
    throw new Error('E_ENGINE_DIR_REQUIRED: loadBgmContext 需要 engineDir')
  }
  const root = path.resolve(projectDir)
  const engineRoot = path.resolve(engineDir)
  const metaDir = joinPath(root, 'work', 'meta')
  const sourceDir = joinPath(root, 'work', 'source')

  const [pack, seriesBible, themeMap, bgmDigestRaw, bgmIndexRaw, project, epIndex] = await Promise.all([
    loadBgmRules(engineRoot),
    readOptionalText(joinPath(metaDir, 'series-bible.md')),
    readOptionalJson(joinPath(metaDir, 'theme-map.json')),
    readOptionalText(joinPath(metaDir, 'bgm_digest.md')),
    readOptionalJson(joinPath(metaDir, 'bgm_index.json')),
    readOptionalJson(joinPath(root, 'project.json')),
    readOptionalJson(joinPath(metaDir, 'ep_index.json')),
  ])

  const sourceCache = new Map()
  function sourceByEp(ep) {
    const n = normalizeEp(ep)
    if (sourceCache.has(n)) return sourceCache.get(n)
    const filePath = joinPath(sourceDir, `ep${pad2(n)}.md`)
    const text = tryReadTextFileSync(filePath)
    if (text === null || !text.trim()) throw new Error(`E_SOURCE_MISSING: ${filePath}`)
    if (!/^第\s*\d+\s*集/.test(firstNonEmptyLine(text))) {
      throw new Error(`E_SOURCE_HEADER_INVALID: ${filePath}`)
    }
    sourceCache.set(n, text)
    return text
  }

  // 集列表：bgm_index（主路径）→ ep_index → work/source 目录扫描
  let episodes = []
  let indexDerived = false
  if (bgmIndexRaw && Array.isArray(bgmIndexRaw.episodes) && bgmIndexRaw.episodes.length) {
    episodes = bgmIndexRaw.episodes
      .map((item) => ({
        ep: Number(item.ep),
        title: String(item.title || ''),
        scenes: Array.isArray(item.scenes) ? item.scenes.map(String) : [],
        scene_names: Array.isArray(item.scene_names) ? item.scene_names.map(String) : [],
        characters: Array.isArray(item.characters) ? item.characters.map(String) : [],
        chars: Number(item.chars) || 0,
        sha256: item.sha256,
      }))
      .filter((item) => Number.isInteger(item.ep) && item.ep > 0)
      .sort((a, b) => a.ep - b.ep)
  }
  if (!episodes.length && epIndex && Array.isArray(epIndex.episodes) && epIndex.episodes.length) {
    for (const item of epIndex.episodes) {
      const ep = Number(item.ep)
      if (!Number.isInteger(ep) || ep <= 0) continue
      const source = sourceByEp(ep)
      const derivedRecord = deriveEpisodeRecord(ep, source)
      episodes.push({ ...derivedRecord, title: String(item.title || derivedRecord.title) })
    }
    indexDerived = true
  }
  if (!episodes.length) {
    const sourceFiles = await listMarkdownFiles(sourceDir)
    const epNumbers = sourceFiles
      .map((filePath) => path.basename(filePath).match(/^ep(\d+)\.md$/i))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b)
    for (const ep of epNumbers) episodes.push(deriveEpisodeRecord(ep, sourceByEp(ep)))
    indexDerived = true
  }

  const derivedDigest = !bgmDigestRaw
  const bgmDigest = bgmDigestRaw || deriveDigest({ project, episodes })
  const bgmIndex = bgmIndexRaw && Array.isArray(bgmIndexRaw.episodes) && bgmIndexRaw.episodes.length
    ? bgmIndexRaw
    : {
        stem: textOr(project?.title, textOr(bgmIndexRaw?.stem, '剧本')),
        derived: true,
        episode_count: episodes.length,
        episodes,
      }

  function episodeSlice(ep) {
    const n = normalizeEp(ep)
    const found = episodes.find((item) => item.ep === n)
    if (found) return found
    return deriveEpisodeRecord(n, sourceByEp(n))
  }

  return {
    rulesText: pack.rulesText,
    rulesHash: pack.rulesHash,
    seriesBible,
    themeMap,
    bgmDigest,
    bgmIndex,
    episodes,
    episodeSlice,
    sourceByEp,
    project: project || null,
    derived: { digest: derivedDigest, index: indexDerived },
  }
}

/* ------------------------------------------------------------------------- */
/* Prompt 构建                                                                 */
/* ------------------------------------------------------------------------- */

function validateContext(context) {
  if (!context || typeof context !== 'object' || typeof context.sourceByEp !== 'function' || typeof context.rulesText !== 'string') {
    throw new Error('E_CONTEXT_INVALID: 需要 loadBgmContext 的返回值')
  }
}

function episodeIndexSlice(context, ep) {
  if (typeof context.episodeSlice === 'function') return context.episodeSlice(ep)
  return { ep }
}

function rulesMessage(context) {
  return { role: 'user', content: [{ type: 'text', text: section('规则包（逐字，硬约束）', context.rulesText) }] }
}

function buildWorkerRetryMaterial({ retryText, previousBgm, parseError, qcFeedback, checkFails }) {
  const parts = []
  if (retryText && String(retryText).trim()) parts.push(String(retryText).trim())
  else if (checkFails || qcFeedback || parseError) {
    parts.push(buildBgmRetryInstruction({ checkFails, qcFeedback, parseError }))
  }
  if (previousBgm && String(previousBgm).trim()) {
    parts.push(`上一版集块（供逐项修复参考，不要照抄）：\n${String(previousBgm).trim()}`)
  }
  if (!parts.length) return ''
  return section('重试材料（仅重试）', parts.join('\n\n'))
}

/**
 * 构建 bgm-worker prompt。
 * @returns {{system:string, messages:Array, maxTokens:number, temperature:number, reasoningEffort:'low'}}
 */
export function buildBgmWorkerPrompt({
  context,
  projectDir,
  ep,
  retryText,
  previousBgm,
  parseError,
  qcFeedback,
  checkFails,
} = {}) {
  validateContext(context)
  const epNumber = normalizeEp(ep)
  const ep2 = pad2(epNumber)
  const source = context.sourceByEp(epNumber)
  if (!source || !source.trim()) throw new Error(`E_SOURCE_EMPTY: ep${ep2}`)
  const slice = episodeIndexSlice(context, epNumber)
  const bibleText = textOr(context.seriesBible, '（无全剧配乐总纲：仍按规则包与 SOURCE 确定基底风格，不得默认中式/古装/宫廷。）')
  const retryBlock = buildWorkerRetryMaterial({ retryText, previousBgm, parseError, qcFeedback, checkFails })

  const messages = [
    rulesMessage(context),
    { role: 'user', content: [{ type: 'text', text: section('全剧配乐总纲 series-bible（可能为空）', bibleText) }] },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            section('本集场次索引（bgm_index 切片，仅本集）', jsonBlock(slice)),
            section(`本集 SOURCE：第 ${epNumber} 集（唯一事实源，逐字）`, source.trim()),
          ].join('\n\n'),
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            retryBlock,
            section('任务', `处理第 ${epNumber} 集。先按规则包确定基底风格与本集全部场次的情绪与乐器，再写四行集块与报告 JSON。只写本集；只使用注入内容。`),
            section(
              '输出契约（严格按顺序，哨兵行独占一行，禁止代码围栏）',
              [
                `${BGM_SENTINELS.bgm}\n第${epNumber}集｜关键词A、关键词B与关键词C（2~4 组，用「、」连接，总长 ≤30 字）\n情绪音：各≤1秒，仅转场、眼神特写与关键动作/台词落点触发；<情绪A>用<音效a>，<情绪B>用<音效b>。\n场景配乐：<series-bible 风格基底原句>，纯器乐。<场次1名+情绪词>：<乐器组>；<场次2名+情绪词>：<乐器组>。\n节奏／调性：<调性>，<BPM起点>→<中段>→<终点>BPM；<对白/动态策略>；<收尾策略>。`,
                `${BGM_SENTINELS.report}\n${BGM_REPORT_SCHEMA}`,
                `${BGM_SENTINELS.status}\nEP${ep2} OK scenes=<覆盖场次数> sfx=<情绪音映射组数>`,
              ].join('\n\n'),
            ),
            section(
              '禁止项',
              [
                '- 只输出上述三段，段外只允许空行；不输出解释、前言、尾注、复盘、工具调用。',
                '- 不使用 ``` 围栏包裹哨兵段；四行结构不可增删行、不可改写栏目名。',
                '- 不引用其他集事件；不新增 SOURCE 未建立的文化元素；不写人声歌词/禁用乐器/占位词。',
                '- 场景配乐必须逐场覆盖（场次号见本集索引），不得合并或省略。',
              ].join('\n'),
            ),
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
  ]

  return {
    system: BGM_WORKER_SYSTEM,
    messages,
    maxTokens: WORKER_MAX_TOKENS,
    temperature: WORKER_TEMPERATURE,
    reasoningEffort: REASONING_EFFORT,
  }
}

/**
 * 构建 bgm-qc prompt（只回一行判定）。
 */
export function buildBgmQcPrompt({ context, projectDir, ep, draftMarkdown } = {}) {
  validateContext(context)
  const epNumber = normalizeEp(ep)
  const ep2 = pad2(epNumber)
  const source = context.sourceByEp(epNumber)
  const draft = textOr(draftMarkdown, null) || readDraftFromDisk(projectDir, ep2)
  if (!draft || !String(draft).trim()) throw new Error(`E_BGM_DRAFT_MISSING: ep${ep2}`)
  const bibleText = textOr(context.seriesBible, '（无）')

  const messages = [
    rulesMessage(context),
    { role: 'user', content: [{ type: 'text', text: section('全剧配乐总纲 series-bible（可能为空）', bibleText) }] },
    { role: 'user', content: [{ type: 'text', text: section('本集 SOURCE（只读）', source.trim()) }] },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            section('本集配乐草案（待审）', String(draft).trim()),
            section(
              '任务',
              `独立质检第 ${epNumber} 集。按 system 的检查项逐项审查，只输出一行判定：\n- 无实质问题：只输出一行「EP${ep2} PASS」\n- 需要返修：只输出一行「EP${ep2} FAIL: <最小可执行修正要求>」\n不写文件、不加评价、不做整体点评；FAIL 中禁止出现命令、脚本名、路径、重跑建议或其他集内容。`,
            ),
          ].join('\n\n'),
        },
      ],
    },
  ]

  return {
    system: BGM_QC_SYSTEM,
    messages,
    maxTokens: QC_MAX_TOKENS,
    temperature: QC_TEMPERATURE,
    reasoningEffort: REASONING_EFFORT,
  }
}

function readDraftFromDisk(projectDir, ep2) {
  if (!projectDir) return ''
  return tryReadTextFileSync(joinPath(path.resolve(projectDir), 'work', 'bgm', `ep${ep2}.md`)) || ''
}

/**
 * 构建 bgm-architect prompt（全剧总纲 + 主题动机表）。
 */
export function buildBgmArchitectPrompt({ context } = {}) {
  validateContext(context)
  const digest = textOr(context.bgmDigest, '（无 bgm_digest：仅可依据规则包与规则做出通用总纲；不得编造剧情。建议先运行 bgm_prepare.py。）')

  const messages = [
    rulesMessage(context),
    { role: 'user', content: [{ type: 'text', text: section('全剧分集摘要 bgm_digest（含剧名、集数、每集标题/场次/人物/开头/结尾）', digest) }] },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            section(
              '输出契约（严格按顺序，哨兵行独占一行，禁止代码围栏）',
              [
                `${BGM_SENTINELS.bible}\n# 全剧配乐总纲\n## 剧名与基调\n## 风格基底\n## 主题动机表（Markdown 表格：| 主题名 | 归属 | 音色签名 | 允许的演化 |）\n## 全剧配乐弧线\n## 复用与禁止`,
                `${BGM_SENTINELS.themeMap}\n${THEME_MAP_SCHEMA}`,
                `${BGM_SENTINELS.status}\nBIBLE OK themes=<themes 数组长度>`,
              ].join('\n\n'),
            ),
            section(
              '任务',
              '依据 bgm_digest 与规则包归纳全剧配乐总纲与主题动机表；只依据摘要与规则，不编造剧情、不增加人物；风格基底必须贴合本剧题材并供每集复用。只输出契约三段，不输出解释性文字。',
            ),
          ].join('\n\n'),
        },
      ],
    },
  ]

  return {
    system: BGM_ARCHITECT_SYSTEM,
    messages,
    maxTokens: ARCHITECT_MAX_TOKENS,
    temperature: ARCHITECT_TEMPERATURE,
    reasoningEffort: REASONING_EFFORT,
  }
}

/**
 * 构建 bgm-auditor prompt（全剧合并稿终检）。
 */
export function buildBgmAuditorPrompt({ context, mergedMarkdown } = {}) {
  validateContext(context)
  const merged = textOr(mergedMarkdown, null)
  if (!merged) throw new Error('E_MERGED_BGM_MISSING: buildBgmAuditorPrompt 需要 mergedMarkdown（合并稿全文）')
  const bibleText = textOr(context.seriesBible, '（无）')
  const themeMap = context.themeMap ? jsonBlock(context.themeMap) : '（无）'

  const messages = [
    rulesMessage(context),
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            section('全剧配乐总纲 series-bible', bibleText),
            section('主题动机表 theme-map', themeMap),
          ].join('\n\n'),
        },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: section('全剧合并稿（待终检；含全局风格、主题表与全部集块）', merged) }] },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            section('输出契约（严格按顺序，哨兵行独占一行，禁止代码围栏）', `${BGM_SENTINELS.audit}\n${AUDIT_SCHEMA}\n\n${BGM_SENTINELS.status}\nAUDIT PASS 或 AUDIT FIX n=<问题数>`),
            section('任务', '执行全剧终检并按契约输出审计 JSON 与状态行；issues.detail 必须是最小可执行修正要求；不修改成品。'),
          ].join('\n\n'),
        },
      ],
    },
  ]

  return {
    system: BGM_AUDITOR_SYSTEM,
    messages,
    maxTokens: AUDITOR_MAX_TOKENS,
    temperature: AUDITOR_TEMPERATURE,
    reasoningEffort: REASONING_EFFORT,
  }
}

/* ------------------------------------------------------------------------- */
/* 输出解析                                                                    */
/* ------------------------------------------------------------------------- */

function prepareOutputText(text) {
  return stripOuterFence(normalizeOutputText(text))
}

function parseSections(text) {
  const normalized = prepareOutputText(text)
  const { sections, errors } = splitSentinelSections(normalized)
  return { sections, errors }
}

const WORKER_BGM_LINE_RES = [
  /^第\s*\d+\s*集\s*[｜|]/,
  /^情绪音\s*[：:]/,
  /^场景配乐\s*[：:]/,
  /^节奏\s*[／/]\s*调性\s*[：:]/,
]
const WORKER_STATUS_RE = /^EP\d{2,3}\s+OK\s+scenes=\d+\s+sfx=\d+$/
const QC_LINE_RE = /^EP(\d{2,3})\s+(PASS|FAIL\s*[:：]\s*(.+))$/i
const ARCHITECT_STATUS_RE = /^BIBLE\s+OK\s+themes=\d+$/
const AUDITOR_STATUS_RE = /^AUDIT\s+(PASS|FIX\s+n=\d+)$/

/**
 * 解析 bgm-worker 输出：===BGM_MD===（严格四行）/===REPORT_JSON===/===STATUS===（可选但校验）。
 * @returns {{ok:boolean, bgm:string, bgmLines:string[], report:any, statusLine:string, errors:string[]}}
 */
export function parseBgmWorkerOutput(text) {
  const errors = []
  const result = { ok: false, bgm: '', bgmLines: [], report: null, statusLine: '', errors }
  if (typeof text !== 'string' || !text.trim()) {
    errors.push('empty_output')
    return result
  }
  const { sections, errors: splitErrors } = parseSections(text)
  errors.push(...splitErrors)

  const bgmRaw = sections.get('BGM_MD')
  if (bgmRaw === undefined) {
    errors.push('missing_segment:BGM_MD')
  } else {
    result.bgm = String(bgmRaw).trim()
    result.bgmLines = result.bgm
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (result.bgmLines.length !== 4) {
      errors.push(`bgm_line_count:${result.bgmLines.length}/4`)
    } else {
      const bad = result.bgmLines.filter((line, index) => !WORKER_BGM_LINE_RES[index].test(line))
      if (bad.length) errors.push(`bgm_line_invalid:${bad.length}`)
    }
  }

  const reportRaw = sections.get('REPORT_JSON')
  if (reportRaw === undefined) {
    errors.push('missing_segment:REPORT_JSON')
  } else {
    const parsed = parseJsonLoose(reportRaw)
    if (!parsed.ok) {
      errors.push(`invalid_json:REPORT_JSON:${parsed.error}`)
    } else if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      errors.push('invalid_structure:REPORT_JSON')
    } else {
      result.report = parsed.value
      if (result.report.status !== undefined && result.report.status !== 'OK') errors.push('report_status_not_ok')
      if (typeof result.report.scenes !== 'object') errors.push('report_missing_fields:scenes')
      if (typeof result.report.sfx_groups !== 'number') errors.push('report_missing_fields:sfx_groups')
      if (typeof result.report.cjk !== 'number') errors.push('report_missing_fields:cjk')
    }
  }

  if (sections.get('STATUS') === undefined) {
    errors.push('missing_segment:STATUS')
  } else {
    result.statusLine = firstNonEmptyLine(sections.get('STATUS'))
    if (!WORKER_STATUS_RE.test(result.statusLine)) errors.push('status_line_invalid')
  }

  const fatal = errors.some(
    (error) =>
      error === 'empty_output' ||
      error.startsWith('missing_segment:BGM_MD') ||
      error.startsWith('missing_segment:REPORT_JSON') ||
      error.startsWith('invalid_json:') ||
      error.startsWith('invalid_structure:REPORT_JSON') ||
      error.startsWith('bgm_line_count:') ||
      error.startsWith('bgm_line_invalid:'),
  )
  result.ok = !fatal
  return result
}

/**
 * 解析 bgm-qc 单行判定。
 * @returns {{ok:boolean, ep:number|null, verdict:'PASS'|'FAIL'|null, detail:string, line:string, errors:string[]}}
 */
export function parseBgmQcOutput(text) {
  const errors = []
  const result = { ok: false, ep: null, verdict: null, detail: '', line: '', errors }
  if (typeof text !== 'string' || !text.trim()) {
    errors.push('empty_output')
    return result
  }
  const normalized = prepareOutputText(text)
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) {
    errors.push('empty_output')
    return result
  }
  result.line = lines[0]
  if (lines.length > 1) errors.push(`extra_lines:${lines.length - 1}`)
  const match = result.line.match(QC_LINE_RE)
  if (!match) {
    errors.push('qc_line_invalid')
    return result
  }
  result.ep = Number(match[1])
  const verdictRaw = String(match[2] || '').toUpperCase()
  if (verdictRaw.startsWith('PASS')) {
    result.verdict = 'PASS'
  } else {
    result.verdict = 'FAIL'
    result.detail = String(match[3] || '').trim()
    if (!result.detail) errors.push('qc_fail_detail_missing')
  }
  result.ok = result.verdict !== null && !(result.verdict === 'FAIL' && !result.detail)
  return result
}

/**
 * 解析 bgm-architect 输出：===SERIES_BIBLE_MD=== / ===THEME_MAP_JSON=== / ===STATUS===。
 * @returns {{ok:boolean, seriesBible:string, themeMap:any, statusLine:string, themes:any[], errors:string[]}}
 */
export function parseBgmArchitectOutput(text) {
  const errors = []
  const result = { ok: false, seriesBible: '', themeMap: null, statusLine: '', themes: [], errors }
  if (typeof text !== 'string' || !text.trim()) {
    errors.push('empty_output')
    return result
  }
  const { sections, errors: splitErrors } = parseSections(text)
  errors.push(...splitErrors)

  const bibleRaw = sections.get('SERIES_BIBLE_MD')
  if (bibleRaw === undefined) {
    errors.push('missing_segment:SERIES_BIBLE_MD')
  } else {
    result.seriesBible = String(bibleRaw).trim()
    if (!result.seriesBible) {
      errors.push('empty_segment:SERIES_BIBLE_MD')
    } else {
      if (!/^#\s*全剧配乐总纲/.test(firstNonEmptyLine(result.seriesBible))) errors.push('bible_header_invalid')
      for (const heading of ['## 剧名与基调', '## 风格基底', '## 主题动机表', '## 全剧配乐弧线', '## 复用与禁止']) {
        if (!result.seriesBible.includes(heading)) errors.push(`bible_section_missing:${heading.replace('## ', '')}`)
      }
    }
  }

  const themeRaw = sections.get('THEME_MAP_JSON')
  if (themeRaw === undefined) {
    errors.push('missing_segment:THEME_MAP_JSON')
  } else {
    const parsed = parseJsonLoose(themeRaw)
    if (!parsed.ok) {
      errors.push(`invalid_json:THEME_MAP_JSON:${parsed.error}`)
    } else if (!parsed.value || typeof parsed.value !== 'object' || !Array.isArray(parsed.value.themes)) {
      errors.push('invalid_structure:THEME_MAP_JSON')
    } else {
      result.themeMap = parsed.value
      result.themes = parsed.value.themes
      if (!result.themes.length) errors.push('theme_map_empty')
      for (const [index, theme] of result.themes.entries()) {
        if (!theme || typeof theme !== 'object') {
          errors.push(`theme_invalid:${index + 1}`)
          continue
        }
        for (const field of ['name', 'owner', 'signature']) {
          if (typeof theme[field] !== 'string' || !theme[field].trim()) errors.push(`theme_invalid:${index + 1}:${field}`)
        }
      }
      if (typeof parsed.value.style !== 'string' || !parsed.value.style.trim()) errors.push('theme_invalid:style')
    }
  }

  if (sections.get('STATUS') === undefined) {
    errors.push('missing_segment:STATUS')
  } else {
    result.statusLine = firstNonEmptyLine(sections.get('STATUS'))
    if (!ARCHITECT_STATUS_RE.test(result.statusLine)) errors.push('status_line_invalid')
    else {
      const expected = Number(result.statusLine.match(/themes=(\d+)/)[1])
      if (result.themes.length && expected !== result.themes.length) {
        errors.push(`status_theme_count_mismatch:${expected}/${result.themes.length}`)
      }
    }
  }

  const fatal = errors.some(
    (error) =>
      error === 'empty_output' ||
      error.startsWith('missing_segment:SERIES_BIBLE_MD') ||
      error.startsWith('missing_segment:THEME_MAP_JSON') ||
      error.startsWith('invalid_json:') ||
      error === 'invalid_structure:THEME_MAP_JSON' ||
      error === 'empty_segment:SERIES_BIBLE_MD' ||
      error.startsWith('bible_') ||
      error.startsWith('theme_'),
  )
  result.ok = !fatal
  return result
}

/**
 * 解析 bgm-auditor 输出：===AUDIT_JSON=== / ===STATUS===。
 * @returns {{ok:boolean, audit:any, statusLine:string, issues:any[], errors:string[]}}
 */
export function parseBgmAuditorOutput(text) {
  const errors = []
  const result = { ok: false, audit: null, statusLine: '', issues: [], errors }
  if (typeof text !== 'string' || !text.trim()) {
    errors.push('empty_output')
    return result
  }
  const { sections, errors: splitErrors } = parseSections(text)
  errors.push(...splitErrors)

  const auditRaw = sections.get('AUDIT_JSON')
  if (auditRaw === undefined) {
    errors.push('missing_segment:AUDIT_JSON')
  } else {
    const parsed = parseJsonLoose(auditRaw)
    if (!parsed.ok) {
      errors.push(`invalid_json:AUDIT_JSON:${parsed.error}`)
    } else if (!parsed.value || typeof parsed.value !== 'object' || !Array.isArray(parsed.value.issues)) {
      errors.push('invalid_structure:AUDIT_JSON')
    } else {
      result.audit = parsed.value
      result.issues = parsed.value.issues
      const status = String(parsed.value.status || '').toUpperCase()
      if (status !== 'PASS' && status !== 'FIX') {
        errors.push('audit_status_invalid')
      } else if (status === 'PASS' && result.issues.length > 0) {
        errors.push('audit_pass_with_issues')
      } else if (status === 'FIX' && result.issues.length === 0) {
        errors.push('audit_fix_without_issues')
      }
      if (status === 'FIX') {
        for (const [index, issue] of result.issues.entries()) {
          if (!issue || typeof issue !== 'object') {
            errors.push(`audit_issue_invalid:${index + 1}`)
            continue
          }
          if (!Number.isInteger(Number(issue.ep)) || Number(issue.ep) <= 0) errors.push(`audit_issue_invalid:${index + 1}:ep`)
          if (typeof issue.detail !== 'string' || !issue.detail.trim()) errors.push(`audit_issue_invalid:${index + 1}:detail`)
        }
      }
    }
  }

  if (sections.get('STATUS') === undefined) {
    errors.push('missing_segment:STATUS')
  } else {
    result.statusLine = firstNonEmptyLine(sections.get('STATUS'))
    const match = result.statusLine.match(AUDITOR_STATUS_RE)
    if (!match) errors.push('status_line_invalid')
    else if (/^FIX/.test(match[1])) {
      const expected = Number(result.statusLine.match(/n=(\d+)/)[1])
      if (result.issues.length && expected !== result.issues.length) {
        errors.push(`status_issue_count_mismatch:${expected}/${result.issues.length}`)
      }
    }
  }

  const fatal = errors.some(
    (error) =>
      error === 'empty_output' ||
      error.startsWith('missing_segment:AUDIT_JSON') ||
      error.startsWith('invalid_json:') ||
      error === 'invalid_structure:AUDIT_JSON' ||
      error.startsWith('audit_status') ||
      error.startsWith('audit_pass_with_issues') ||
      error.startsWith('audit_fix_without_issues') ||
      error.startsWith('audit_issue_invalid'),
  )
  result.ok = !fatal
  return result
}

/* ------------------------------------------------------------------------- */
/* 重试指令 / token 估算                                                       */
/* ------------------------------------------------------------------------- */

function toStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (value && typeof value === 'object') {
    const out = []
    if (Array.isArray(value.fails)) out.push(...value.fails.map((item) => String(item).trim()).filter(Boolean))
    if (Array.isArray(value.warns)) out.push(...value.warns.map((item) => `(warn) ${String(item).trim()}`))
    return out
  }
  return []
}

/**
 * 生成配乐重试追加段，汇总 checkFails / qcFeedback / parseError / auditorDetail。
 * @param {{checkFails?:string|string[], qcFeedback?:string, parseError?:string, auditorDetail?:string}} [input]
 * @returns {string}
 */
export function buildBgmRetryInstruction(input = {}) {
  const payload = input && typeof input === 'object' && !Array.isArray(input) ? input : { checkFails: input }
  const checkFails = toStringList(payload.checkFails)
  const qcFeedback = typeof payload.qcFeedback === 'string' ? payload.qcFeedback.trim() : ''
  const parseError = typeof payload.parseError === 'string' ? payload.parseError.trim() : ''
  const auditorDetail = typeof payload.auditorDetail === 'string' ? payload.auditorDetail.trim() : ''

  const lines = ['【重试指令】', '本轮为内容重试（不是新任务）。上次失败/返修项：']
  let index = 0
  for (const item of checkFails) lines.push(`${(index += 1)}. 机检失败：${item}`)
  if (qcFeedback) lines.push(`${(index += 1)}. QC 返修要求：${qcFeedback}`)
  if (auditorDetail) lines.push(`${(index += 1)}. 全剧终检要求：${auditorDetail}`)
  if (parseError) lines.push(`${(index += 1)}. 上次输出解析失败：${parseError}`)
  if (!index) lines.push('（未提供结构化失败项：请按 bgm_check_ep 的 17 项规则自查四行结构/场次覆盖/参数完整/禁令/让位/长度）')
  lines.push(
    '',
    '逐项修复后重写整集：四行结构不可增删行或改名（标题行/情绪音/场景配乐/节奏／调性）；场次配乐必须覆盖本集全部场次且含场次号；',
    '只写本集、不引用其他集；不新增 SOURCE 未建立的文化元素；不写人声歌词/禁用乐器/占位词；只输出契约三段。',
  )
  return lines.join('\n')
}

/**
 * 估算配乐 prompt 的 token 数（字符串或 builder 返回值均可）。
 * @param {string|{system?:string,messages?:unknown[]}} prompt
 * @returns {number}
 */
export function estimateBgmPromptTokens(prompt) {
  return estimateTokensOfPrompt(prompt)
}

/** 统计配乐 prompt 的字符构成（调试/报告用）。 */
export function estimateBgmPromptStats(prompt) {
  return statsOfPrompt(prompt)
}

/** 只读探测：项目是否已具备配乐阶段全部输入（供 Host 健康检查用）。 */
export function hasBgmInputs({ projectDir } = {}) {
  if (!projectDir || typeof projectDir !== 'string') return false
  const root = path.resolve(projectDir)
  const meta = joinPath(root, 'work', 'meta')
  return isFile(joinPath(meta, 'bgm_digest.md')) && isFile(joinPath(meta, 'bgm_index.json'))
}

export default {
  loadBgmContext,
  buildBgmWorkerPrompt,
  buildBgmQcPrompt,
  buildBgmArchitectPrompt,
  buildBgmAuditorPrompt,
  parseBgmWorkerOutput,
  parseBgmQcOutput,
  parseBgmArchitectOutput,
  parseBgmAuditorOutput,
  buildBgmRetryInstruction,
  estimateBgmPromptTokens,
  estimateBgmPromptStats,
  BGM_PROMPT_VERSION,
  BGM_SENTINELS,
}
