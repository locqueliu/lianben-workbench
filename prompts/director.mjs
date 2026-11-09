/**
 * prompts/director.mjs — M3「炼本（导演执行稿）」prompt 资产：上下文加载、prompt 构建、输出解析、重试指令、token 估算。
 *
 * 契约（Host 直接 import，保持稳定）：
 *   loadDirectorContext({ projectDir, engineDir }) -> Promise<DirectorContext>
 *   buildDirectorPrompt({ context, projectDir, ep, retryText, previousDraft }) -> { system, messages, maxTokens, temperature, reasoningEffort }
 *   parseDirectorOutput(text) -> { ok, shotPlan, draft, notes, report, statusLine, errors }
 *   buildRetryInstruction(fails) -> string
 *   estimatePromptTokens(prompt) -> number
 *
 * 规则资产来源（docs/13 §1）：
 *   - engine/defaults/global-style.md（canonical，去重后只注入一次）
 *   - engine/rules/炼本细则/*.md（排除其中的 global-style.md 副本）
 * 输出契约来源：reference/.opencode/agents/director.md（台词/锁行逐字、括号表演提示、
 * P/R/N 镜头规划、镜头块、SPECTACLE、CJK≤10000），并叠加弱质检版约束（不修复源、不合并源 △）。
 * 本模块不写任何文件、不调用模型、不读写其他集正文。
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

import {
  joinPath,
  listMarkdownFiles,
  readJsonFile,
  readTextFile,
  tryReadTextFileSync,
} from '../lib/refine-fs.mjs'
import {
  DIRECTOR_SENTINELS,
  extractStatusLine,
  firstNonEmptyLine,
  looksLikeEpisodeHeader,
  parseJsonLoose,
  splitSentinelSections,
} from '../lib/refine-text.mjs'
import {
  estimatePromptTokens as estimateTokensOfPrompt,
  estimatePromptStats as statsOfPrompt,
} from '../lib/refine-token.mjs'

export const DIRECTOR_PROMPT_VERSION = 'm3.1'

const RULES_CACHE = new Map()

const DEFAULT_MAX_TOKENS = 24576
const DEFAULT_TEMPERATURE = 0.4
const DEFAULT_REASONING_EFFORT = 'low'

/* ------------------------------------------------------------------------- */
/* 静态 system：角色 + 硬规则摘要（全项目稳定，利于前缀缓存）                    */
/* ------------------------------------------------------------------------- */

const DIRECTOR_SYSTEM = `你是「炼稿工人」（director）。唯一任务：把调用方指定的单集 SOURCE 富化为可拍的导演执行稿，并严格按【输出契约】一次性输出五个哨兵段。你没有任何工具；所有规则、项目元数据与本集数据已随消息注入。

一、事实与锁定（违反即失败）
1. SOURCE 是唯一事实源：人物、关系、剧情、决定、能力、伤势、道具功能、事件顺序与结果、台词锁定，全部以 SOURCE 为准。
2. 台词/VO/OS 文字与标点逐字不动；台词标签只沿用 SOURCE（原文有则逐类保留；原文没有时不得新增、不得改分类、不得推断）；不得把场景描述、△ 或动作说明改写成台词/VO。
3. 中英台词是复合原子：未拆分时中文行后紧跟完整英文行；长台词拆分必须按相同语义边界等量拆分并严格按 CN1→EN1→CN2→EN2 交替；禁止只拆一侧、禁止多个中文片段后集中放完整英文。
4. SOURCE 台词顺序锁定：VO/OS/对白不得换位；镜头块与动作可插入台词之间，但不得移动、合并或重排台词。
5. 锁行逐字保留：集标题行、英文集标题行、场次行、人物/出场行、音效标签、【…】结构块、SOURCE 明确镜头指令，一字一标点不改（仅允许纯格式统一）。
6. 不新增剧情、决定、能力、伤势、道具功能、角色、关系结论；不改动作顺序与结果；不把非自愿事实改写为自愿。

二、台词括号表演提示（强制，每句必填）
1. 必含两类信息：声音/气息/情绪状态（声线、尾音、气息、喉音、语速）＋至少一个可拍的面部/眼部/下颌/喉部/手部细节（眉心、眼睑、视线焦点、下颌线、喉结、指节、手部重心）。
2. 情绪落点句（关键台词、转折句、压抑/爆发句）至少 2 个可见细节，优先写成「说到某字/某句时……」的节拍变化。
3. 长度：过场约 8—15 字；常规对白约 15—30 字；关键情绪句约 25—40 字；英文约 8—20 词。以「读完立刻知道这句怎么说」为准，不机械凑字。
4. 禁止：只写「正常/平静/自然/复杂/深邃/微微一笑」等无信息词；只写情绪结论（如「她很愤怒」）；不可演/特效化（双眼发光、脸色通红、周身发光、冒黑气）；抽象诗化比喻；把完整动作链、姿态余波、说完后的反应塞进括号（这些写入 △）。
5. 无标签台词：SOURCE 未标注对白/VO/OS 时，括号内只写表演提示，不得借机补标签。
6. VO/OS 例外：角色不在画面内时可用声音质感、气息、喉部、手部或画外动作细节替代面部细节；不得为凑可见细节让画外角色出现口型或强行入画。
7. 分工：括号只承担说话瞬间的表演提示；连续动作、动作过程、情绪变化、姿态余波、环境声相位写入 △；景别、机位、运镜、站位写入镜头块。

三、主角镜头规划（P/R/N，先规划后写）
1. 单主角，不换主角、不做双主角；主角以注入的 protagonist.json 为准。
2. 先按注入的「主角镜头贯穿」规则完成本集镜头规划并写入 SHOT_PLAN_JSON，再写正文；shot_plan.shots 数量必须等于正文镜头块数量，no 从 1 连续递增。
3. 硬指标：主角关联镜 (P+R)/total ≥70%；主角本人镜 P/total ≥35%；纯 N ≤30%；连续 N ≤2；连续配角互动 N ≤2；有主角在场的场次至少 1 个 P/R。
4. relation=P 的 anchor 用 face/eyes/body/action/hand/pov/voice/reaction/decision；R 用 pov/ots/foreground/frame/observe/object/hand/voice/reaction/cause/sound/reflection/shadow；N 用 none。不得用主角站背景凑数；不得新增 SOURCE 未建立的主角在场、能力、关系或事件。

四、正文与镜头
1. △ 原子保留 SOURCE 事实骨架（谁、做了什么、动作顺序、结果、道具状态、空间位移），自然融入微表情、微动作/肢体语言、情绪/姿态余波、动作过程、环境声相位；不得退化成剧情梗概。
2. 镜头块格式：【景别·摄影机状态/运动·功能】，下一行【人物站位】，随后写具体可拍执行；每场可在开头写一次【人物站位·本场总览】。镜头块内不写具体秒数；单镜时长上限 4 秒，一个镜头只承载一个可读动作过程；过长动作/复杂连续事件必须拆镜。
3. 每场至少一个 SPECTACLE: [奇观名]（可独立成片，有启动—变化—峰值—落幅）；VFX 候选可标 VFX: …；SPECTACLE 不新增事实，命名不得引入文化礼仪概念。
4. 相邻镜头不得同人物+同景别+同机位+同构图连续重复；须在景别/机位/角度/运镜/构图/节奏至少一项变化；有位移写进入/中间走位/离开方向；静止镜头写停留位置；相邻镜之间要有具体 NATURAL HANDOFF。
5. 每场写清光线：主光方向、冷暖与明暗、角色受光、光是否随时间变化。
6. 对白戏不得单一固定机位：须在建立镜、正反打、过肩、反应镜、手部/眼神细节、空间关系镜之间调度。
7. VO/旁白/内心独白/电话/广播等非现场声时，画面中对应角色嘴巴保持闭合，不得出现说话口型或口型同步。
8. 只输出可拍正文：不写审计、方法论、解释层；不加字幕、画面文字、标题卡、BGM/配乐描述（SOURCE 已有者逐字保留）。

五、字数与表演可行性
1. 单集成品中文（CJK）字数不得超过 10000；超出即失败，须在内部 ECONOMY PASS 精简到达标，不得删硬锁、密度基线、站位路径与因果过程。
2. 表演必须真人可执行：不写发光/通红/黑气等不可演特效，不用抽象、诗化、心象化比喻代替可拍行为。
3. 不得使用「自行发挥/略/同上」等模糊词。

六、文化背景与地域锁定（强制）
1. 文化、地域、时代以 SOURCE 为唯一依据；SOURCE 未建立的中国/东方元素、背景、器物、服饰、礼仪、称谓、节庆、文字、货币等一律不得添加。
2. 不得从中文措辞反推文化器物/礼仪：SOURCE 只写「夹了一块菜」时，不得添加筷子、筷架、中式餐具或「一筷之礼」；未指定餐具时写「分菜/放进碟中」等中性动作。
3. 不得新增跪礼、叩首、磕头、双膝跪地、拱手、作揖、抱拳、万福、打千、跪安、敛衽、合十等动作/礼仪；不得新增身份、家族、头衔、亲属称谓、社会制度。
4. 若 SOURCE 明确建立中国/东方背景，按 SOURCE 保留；本锁只禁止「SOURCE 未建立的添加」。

七、弱质检版特别约束（强制）
1. 前置为机器弱质检：SOURCE 可能仍含未修复的 must_fix/suspected；你不得修复、不得改写、不得删除源事实，也不得新增任何「修正」内容。
2. 不得自行合并、删除、拆分或重排任何源 △ 原子（前置未做 △ 合并）；逐条保留并富化。
3. 源问题只写入 PRODUCTION_NOTES_MD 的「源剧本问题」「修复结果」两节；正文按规则富化。
4. 若 SOURCE 的文化元素与硬规则冲突：保留 SOURCE、不新增、不改写。

八、输出纪律
1. 只输出【输出契约】规定的五个哨兵段；哨兵行必须独占一行且拼写完全一致；段外只允许空行。
2. 不输出解释、前言、尾注、复盘、工具调用；不使用 \`\`\` 围栏包裹哨兵段。
3. SHOT_PLAN_JSON 与 REPORT_JSON 必须是合法 JSON（不加注释、不加尾随文字）。

九、禁止事项
- 不修改 SOURCE、不引用其他集正文、不读取其他集数据（只有注入内容可用）。
- 不把草稿过程写进成品，只写最终稿。
- 不输出任何「我已完成」类说明文字。`

/* ------------------------------------------------------------------------- */
/* 共享输出契约片段                                                            */
/* ------------------------------------------------------------------------- */

const SHOT_PLAN_SCHEMA = `{
  "ep": <集号数字>,
  "status": "OK",
  "protagonist": "<主角名>",
  "shot_plan": {
    "shots": [
      {
        "no": 1,
        "scene": "<场次号，如 1-1>",
        "subject": "<镜头主体>",
        "subject_type": "protagonist|support|environment|prop|spectacle",
        "relation": "P|R|N",
        "anchor": "P: face|eyes|body|action|hand|pov|voice|reaction|decision；R: pov|ots|foreground|frame|observe|object|hand|voice|reaction|cause|sound|reflection|shadow；N: none",
        "purpose": "<该镜功能>"
      }
    ],
    "stats": {
      "total": 0, "p": 0, "r": 0, "n": 0,
      "related_ratio": 0, "protagonist_ratio": 0, "n_ratio": 0,
      "max_n_run": 0, "max_support_run": 0,
      "scene_missing": [], "closeup_share": 0, "anchor_variety": 0
    }
  }
}`

const REPORT_SCHEMA = `{
  "ep": <集号数字>,
  "status": "OK",
  "atoms_src": <源△原子数>,
  "atoms_out": <成品△原子数>,
  "scenes": <场次数>,
  "spectacle": <SPECTACLE 数量>,
  "spectacle_names": ["<奇观名>"],
  "cjk": <成品中文 CJK 字数>,
  "protagonist": "<主角名>",
  "shot_plan": <与 SHOT_PLAN_JSON 相同的 shot_plan 对象>
}`

/* ------------------------------------------------------------------------- */
/* 规则包加载（缓存文本与 hash）                                                */
/* ------------------------------------------------------------------------- */

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

async function loadRulesPack(engineDir) {
  const cacheKey = path.resolve(engineDir)
  const cached = RULES_CACHE.get(cacheKey)
  if (cached) return cached

  const globalStylePath = joinPath(engineDir, 'defaults', 'global-style.md')
  const directorAssetPath = joinPath(engineDir, 'rules', 'director.md')
  const rulesDir = joinPath(engineDir, 'rules', '炼本细则')
  const globalStyle = await readTextFile(globalStylePath)
  const ruleFiles = await listMarkdownFiles(rulesDir)
  const members = []
  const blocks = [`===== 规则文件：global-style.md =====\n\n${globalStyle}`]
  members.push({ name: 'global-style.md', chars: globalStyle.length, source: 'engine/defaults' })

  // Legacy director agent asset (role + must-read list + hard rules). Kept in the
  // stable rule pack for prompt parity with the original workflow; optional for
  // deployments that only ship the skill files.
  try {
    const directorAsset = await readTextFile(directorAssetPath)
    if (directorAsset.trim().length > 0) {
      blocks.push(`===== 规则文件：director.md =====\n\n${directorAsset}`)
      members.push({ name: 'director.md', chars: directorAsset.length, source: 'engine/rules' })
    }
  } catch {
    members.push({ name: 'director.md', chars: 0, source: 'missing-optional' })
  }

  for (const filePath of ruleFiles) {
    const name = path.basename(filePath)
    // 去重：旧 director 同时读根 global-style 与《炼本细则》副本，二者仅 1 行措辞差；
    // 以 engine/defaults/global-style.md 为 canonical，不再注入细则副本（docs/13 §1.3）。
    if (name === 'global-style.md') {
      members.push({ name: '炼本细则/global-style.md', chars: 0, source: 'deduped' })
      continue
    }
    const content = await readTextFile(filePath)
    blocks.push(`===== 规则文件：${name} =====\n\n${content}`)
    members.push({ name, chars: content.length, source: 'engine/rules/炼本细则' })
  }

  const rulesText = blocks.join('\n\n')
  const pack = { rulesText, rulesHash: sha256(rulesText), globalStyle, members }
  RULES_CACHE.set(cacheKey, pack)
  return pack
}

/* ------------------------------------------------------------------------- */
/* 上下文加载                                                                  */
/* ------------------------------------------------------------------------- */

function findPreflightEpisode(protagonistPreflight, ep) {
  if (!protagonistPreflight || !Array.isArray(protagonistPreflight.episodes)) return null
  return protagonistPreflight.episodes.find((item) => Number(item && item.ep) === Number(ep)) || null
}

/**
 * 加载导演上下文（规则包/项目元数据/本集源文访问器）。
 * 只读；缺失必需文件时抛 E_CONTEXT_*，不会静默降级。
 *
 * @param {{ projectDir: string, engineDir: string }} options
 */
export async function loadDirectorContext({ projectDir, engineDir } = {}) {
  if (!projectDir || typeof projectDir !== 'string') {
    throw new Error('E_PROJECT_DIR_REQUIRED: loadDirectorContext 需要 projectDir')
  }
  if (!engineDir || typeof engineDir !== 'string') {
    throw new Error('E_ENGINE_DIR_REQUIRED: loadDirectorContext 需要 engineDir')
  }
  const root = path.resolve(projectDir)
  const engineRoot = path.resolve(engineDir)
  const metaDir = joinPath(root, 'work', 'meta')
  const preflightDir = joinPath(root, 'work', 'preflight')

  const [pack, format, formatRules, factsLock, handoff, protagonist, protagonistPreflight, shotProfile] =
    await Promise.all([
      loadRulesPack(engineRoot),
      readJsonFile(joinPath(metaDir, 'format.json')),
      readTextFile(joinPath(metaDir, 'format_rules.md')),
      readTextFile(joinPath(metaDir, 'facts_lock.md')),
      readJsonFile(joinPath(metaDir, 'handoff.json')),
      readJsonFile(joinPath(metaDir, 'protagonist.json')),
      readJsonFile(joinPath(preflightDir, 'protagonist.json')),
      readJsonFile(joinPath(engineRoot, 'defaults', 'shot-profile.json')),
    ])

  const sourceDir = joinPath(root, 'work', 'source')
  const sourceCache = new Map()
  /** @param {number|string} ep @returns {string} 本集 source 原文（逐字；缺失抛 E_SOURCE_MISSING） */
  function sourceByEp(ep) {
    const n = Number(ep)
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`E_EP_INVALID: ${String(ep)}`)
    }
    if (sourceCache.has(n)) return sourceCache.get(n)
    const ep2 = String(n).padStart(2, '0')
    const filePath = joinPath(sourceDir, `ep${ep2}.md`)
    const text = tryReadTextFileSync(filePath)
    if (text === null || !text.trim()) {
      throw new Error(`E_SOURCE_MISSING: ${filePath}`)
    }
    if (!looksLikeEpisodeHeader(firstNonEmptyLine(text))) {
      throw new Error(`E_SOURCE_HEADER_INVALID: ${filePath}`)
    }
    sourceCache.set(n, text)
    return text
  }

  return {
    rulesText: pack.rulesText,
    rulesHash: pack.rulesHash,
    globalStyle: pack.globalStyle,
    shotProfile,
    format,
    formatRules,
    factsLock,
    handoff,
    protagonist,
    protagonistPreflight,
    sourceByEp,
  }
}

/* ------------------------------------------------------------------------- */
/* prompt 构建                                                                 */
/* ------------------------------------------------------------------------- */

function countSourceAtoms(sourceText) {
  let atoms = 0
  for (const line of String(sourceText).split('\n')) {
    if (line.trim().startsWith('△')) atoms += 1
  }
  return atoms
}

function section(title, body) {
  return `【${title}】\n${body}`
}

function jsonBlock(value) {
  return JSON.stringify(value, null, 1)
}

function buildEpisodeBlock(context, projectDir, epNumber, ep2, source, retryText, previousDraft) {
  const title = firstNonEmptyLine(source)
  const preflightEpisode = findPreflightEpisode(context.protagonistPreflight, epNumber)
  const sceneMap = preflightEpisode && Array.isArray(preflightEpisode.scene_map) ? preflightEpisode.scene_map : []
  const handoffEntry = (context.handoff && context.handoff[String(epNumber)]) || { prev_tail: [], next_head: [] }
  const atomsSrc = countSourceAtoms(source)

  const optimizedPath = projectDir
    ? joinPath(path.resolve(projectDir), 'work', 'preflight', 'optimized', `ep${ep2}.json`)
    : null
  const optimizedText = optimizedPath ? tryReadTextFileSync(optimizedPath) : null
  const optimizedLine = optimizedText
    ? `本集存在前置优化记录（仅供核对，不得据此改写 SOURCE 事实）：\n${optimizedText.trim()}`
    : '（无前置优化记录：弱质检前置不做 LLM 剧情修复/动作丰富/△合并；SOURCE 可能仍含未修复的 must_fix/suspected，按 system 约束只记录、不修改。）'

  const retryBlock =
    retryText || previousDraft
      ? `\n\n${section(
          '重试材料（仅重试）',
          [
            retryText ? `上次失败明细：\n${String(retryText).trim()}` : '',
            previousDraft ? `上一版正文（供逐项修复参考，不要照抄，不要整段搬回）：\n${String(previousDraft).trim()}` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        )}`
      : ''

  return {
    block: [
      section('本集数据（只注本集；不得引用其他集正文）', ''),
      `- 集号：EP${ep2}`,
      `- 集标题（SOURCE 首行）：${title}`,
      `- 源 △ 原子数：${atomsSrc}`,
      '',
      section('本集 SOURCE（唯一事实源，逐字）', source.trim()),
      section('本集场次-主角覆盖地图 scene_map（仅本集）', jsonBlock(sceneMap)),
      section('跨集接点 handoff（仅本集条目：上一集末尾 + 下一集开头）', jsonBlock(handoffEntry)),
      section('全局锁定事实 facts_lock.md', context.factsLock.trim() || '（无全局锁定事实）'),
      section('剧本格式规则 format.json（锁行以它为准）', jsonBlock(context.format)),
      section('格式规则说明 format_rules.md', context.formatRules.trim()),
      section('本集前置优化记录', optimizedLine),
    ].join('\n') + retryBlock,
    title,
    atomsSrc,
    sceneMap,
  }
}

function buildContractBlock(ep2, title, atomsSrc) {
  return [
    section(
      '任务',
      [
        `处理第 ${ep2} 集（${title}）。`,
        '1) 先按规则完成 P/R/N 主角镜头规划并自检达标，写入 SHOT_PLAN_JSON；',
        '2) 再按规划写完整集正文（DRAFT_MD），第一行必须为 SOURCE 集标题原文，源文顺序不变；',
        '3) 再写制作说明（PRODUCTION_NOTES_MD）；',
        '4) 最后输出 REPORT_JSON 与一行 STATUS。',
        '只处理本集；只使用注入内容，不引用、不推测其他集正文。',
      ].join('\n'),
    ),
    section(
      '输出契约（严格按顺序，哨兵行独占一行，禁止代码围栏）',
      [
        `${DIRECTOR_SENTINELS.shotPlan}\n${SHOT_PLAN_SCHEMA}`,
        `${DIRECTOR_SENTINELS.draft}\n第一行必须是 SOURCE 的集标题行原文：${title}；其后为全部场次正文，源文顺序不变；只写可拍正文。`,
        `${DIRECTOR_SENTINELS.notes}\n# EP${ep2} 制作说明\n## 动作与情绪丰富汇总（逐场：场次行 → 添加了什么）\n## 源剧本问题（来自前置质检报告本集 must_fix + suspected；无则写「无前置质检报告」）\n## 修复结果（弱质检版不修改 SOURCE；注明「未修复，保留原文」，或引用 optimized 记录说明）\n## 主角镜头规划（P/R/N 数量、关联占比、主角本人镜占比、最长 N 段、最长配角互动段、特写占比、关联点类型；无主角场次注明按 N 处理）\n## 台词保留确认（若本集有英文台词字数问题，注明「原台词已原样保留炼本，未做修改」；否则省略本节）`,
        `${DIRECTOR_SENTINELS.report}\n${REPORT_SCHEMA}`,
        `${DIRECTOR_SENTINELS.status}\nEP${ep2} OK atoms=<成品△原子数>/${atomsSrc} spectacle=<SPECTACLE 数量>`,
      ].join('\n\n'),
    ),
    section(
      '禁止项',
      [
        '- 只输出上述五个哨兵段，段外只允许空行；不输出解释、前言、尾注、复盘、工具调用。',
        '- 不使用 ``` 围栏包裹哨兵段；哨兵行拼写必须完全一致。',
        '- 不修改 SOURCE 台词/锁行/事实；不新增台词标签；不合并、删除、重排源 △。',
        '- 不新增 SOURCE 未建立的文化元素/礼仪/器物/称谓；不写不可演特效。',
        '- 单集成品 CJK 不得超过 10000；不得用「自行发挥/略/同上」等模糊词。',
      ].join('\n'),
    ),
  ].join('\n\n')
}

/**
 * 构建导演 prompt（同步，不发起任何 IO 写操作；仅为可选 optimized 记录做一次同步只读）。
 *
 * @param {{
 *   context: Awaited<ReturnType<typeof loadDirectorContext>>,
 *   projectDir?: string,
 *   ep: number|string,
 *   retryText?: string,
 *   previousDraft?: string,
 * }} options
 * @returns {{system: string, messages: Array<{role:'user', content:Array<{type:'text', text:string}>}>, maxTokens:number, temperature:number, reasoningEffort:'low'}}
 */
export function buildDirectorPrompt({ context, projectDir, ep, retryText, previousDraft } = {}) {
  if (!context || typeof context !== 'object' || typeof context.sourceByEp !== 'function') {
    throw new Error('E_CONTEXT_INVALID: buildDirectorPrompt 需要 loadDirectorContext 的返回值')
  }
  const epNumber = Number(ep)
  if (!Number.isInteger(epNumber) || epNumber <= 0) {
    throw new Error(`E_EP_INVALID: ${String(ep)}`)
  }
  const ep2 = String(epNumber).padStart(2, '0')
  const source = context.sourceByEp(epNumber)
  if (!source || !source.trim()) throw new Error(`E_SOURCE_EMPTY: ep${ep2}`)

  const episode = buildEpisodeBlock(context, projectDir, epNumber, ep2, source, retryText, previousDraft)

  const projectMeta = [
    section('项目元数据（项目级稳定）', ''),
    section('镜头配置 shot-profile.json', jsonBlock(context.shotProfile)),
    section('主角识别 protagonist.json（单主角，不做双主角）', jsonBlock(context.protagonist)),
  ].join('\n')

  const messages = [
    { role: 'user', content: [{ type: 'text', text: section('规则包（逐字，硬约束）', context.rulesText) }] },
    { role: 'user', content: [{ type: 'text', text: projectMeta }] },
    { role: 'user', content: [{ type: 'text', text: episode.block }] },
    { role: 'user', content: [{ type: 'text', text: buildContractBlock(ep2, episode.title, episode.atomsSrc) }] },
  ]

  return {
    system: DIRECTOR_SYSTEM,
    messages,
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
  }
}

/* ------------------------------------------------------------------------- */
/* 输出解析                                                                    */
/* ------------------------------------------------------------------------- */

const REQUIRED_SECTIONS = [
  ['shotPlan', 'SHOT_PLAN_JSON'],
  ['draft', 'DRAFT_MD'],
  ['notes', 'PRODUCTION_NOTES_MD'],
  ['report', 'REPORT_JSON'],
]

const STATUS_LINE_RE = /^EP\d{2,3}\s+OK\b/

function countDraftShotBlocks(draftText) {
  let blocks = 0
  for (const line of String(draftText).split('\n')) {
    const trimmed = line.trim()
    if (/^【.+】$/.test(trimmed) && !trimmed.startsWith('【人物站位')) blocks += 1
  }
  return blocks
}

/**
 * 解析 director 的五段哨兵输出。
 * 容错：去围栏、尾逗号、CRLF、段内多余空行；不允许截断补全/字段猜测。
 *
 * @param {string} text
 * @returns {{ok:boolean, shotPlan:any, draft:string, notes:string, report:any, statusLine:string, errors:string[]}}
 */
export function parseDirectorOutput(text) {
  const errors = []
  const result = { ok: false, shotPlan: null, draft: '', notes: '', report: null, statusLine: '', errors }

  if (typeof text !== 'string' || !text.trim()) {
    errors.push('empty_output')
    return result
  }

  const { sections, errors: splitErrors } = splitSentinelSections(text)
  errors.push(...splitErrors)

  const missing = REQUIRED_SECTIONS.filter(([, sentinel]) => !sections.has(sentinel)).map(([, sentinel]) => sentinel)
  for (const sentinel of missing) errors.push(`missing_segment:${sentinel}`)

  // SHOT_PLAN_JSON
  const shotPlanRaw = sections.get('SHOT_PLAN_JSON')
  if (shotPlanRaw !== undefined) {
    const parsed = parseJsonLoose(shotPlanRaw)
    if (!parsed.ok) {
      errors.push(`invalid_json:SHOT_PLAN_JSON:${parsed.error}`)
    } else if (!parsed.value || typeof parsed.value !== 'object' || !Array.isArray(parsed.value.shots) && !(parsed.value.shot_plan && Array.isArray(parsed.value.shot_plan.shots))) {
      errors.push('invalid_structure:SHOT_PLAN_JSON')
      result.shotPlan = parsed.value && typeof parsed.value === 'object' ? parsed.value : null
    } else {
      result.shotPlan = parsed.value
      const shots = Array.isArray(parsed.value.shots) ? parsed.value.shots : parsed.value.shot_plan.shots
      if (!shots.length) errors.push('invalid_structure:SHOT_PLAN_JSON:empty_shots')
      shots.forEach((shot, index) => {
        if (!shot || typeof shot !== 'object') {
          errors.push(`invalid_structure:SHOT_PLAN_JSON:shot${index + 1}`)
          return
        }
        if (Number(shot.no) !== index + 1) errors.push(`shot_no_mismatch:${index + 1}`)
        if (!['P', 'R', 'N'].includes(String(shot.relation || '').toUpperCase())) {
          errors.push(`shot_relation_invalid:${index + 1}`)
        }
      })
    }
  }

  // DRAFT_MD
  const draftRaw = sections.get('DRAFT_MD')
  if (draftRaw !== undefined) {
    result.draft = String(draftRaw || '').trim()
    if (!result.draft) {
      errors.push('empty_segment:DRAFT_MD')
    } else {
      const header = firstNonEmptyLine(result.draft)
      if (!looksLikeEpisodeHeader(header)) errors.push('draft_header_invalid')
    }
  }

  // PRODUCTION_NOTES_MD
  const notesRaw = sections.get('PRODUCTION_NOTES_MD')
  if (notesRaw !== undefined) {
    result.notes = String(notesRaw || '').trim()
    if (!result.notes) errors.push('empty_segment:PRODUCTION_NOTES_MD')
  }

  // REPORT_JSON
  const reportRaw = sections.get('REPORT_JSON')
  if (reportRaw !== undefined) {
    const parsed = parseJsonLoose(reportRaw)
    if (!parsed.ok) {
      errors.push(`invalid_json:REPORT_JSON:${parsed.error}`)
    } else if (!parsed.value || typeof parsed.value !== 'object') {
      errors.push('invalid_structure:REPORT_JSON')
    } else {
      result.report = parsed.value
      if (result.report.ep === undefined) errors.push('report_missing_fields:ep')
      if (result.report.shot_plan === undefined && result.shotPlan && result.shotPlan.shot_plan) {
        result.report = { ...result.report, shot_plan: result.shotPlan.shot_plan }
      }
      if (typeof result.report.cjk === 'number' && result.report.cjk > 10000) {
        errors.push(`report_cjk_over_limit:${result.report.cjk}`)
      }
    }
  }

  // STATUS（人类可读；缺失/格式不符只记错误，不阻断落盘）
  const statusRaw = sections.get('STATUS')
  if (statusRaw === undefined) {
    errors.push('missing_segment:STATUS')
  } else {
    result.statusLine = extractStatusLine(statusRaw)
    if (!STATUS_LINE_RE.test(result.statusLine)) errors.push('status_line_invalid')
  }

  // 结构性交叉校验（非致命，供重试判断）：shots 数 vs 正文镜头块数
  if (result.shotPlan && result.draft) {
    const shots = Array.isArray(result.shotPlan.shots)
      ? result.shotPlan.shots
      : result.shotPlan.shot_plan && Array.isArray(result.shotPlan.shot_plan.shots)
        ? result.shotPlan.shot_plan.shots
        : null
    if (shots) {
      const blocks = countDraftShotBlocks(result.draft)
      if (blocks !== shots.length) errors.push(`shot_count_mismatch:${shots.length}/${blocks}`)
    }
  }

  const fatal = errors.some(
    (error) =>
      error.startsWith('missing_segment:SHOT_PLAN_JSON') ||
      error.startsWith('missing_segment:DRAFT_MD') ||
      error.startsWith('missing_segment:PRODUCTION_NOTES_MD') ||
      error.startsWith('missing_segment:REPORT_JSON') ||
      error.startsWith('invalid_json:') ||
      error === 'empty_segment:DRAFT_MD' ||
      error === 'draft_header_invalid' ||
      error === 'invalid_structure:SHOT_PLAN_JSON' ||
      error === 'empty_output',
  )
  result.ok = !fatal
  return result
}

/* ------------------------------------------------------------------------- */
/* 重试指令 / token 估算                                                       */
/* ------------------------------------------------------------------------- */

function normalizeFails(fails) {
  if (Array.isArray(fails)) {
    return fails
      .map((item) => (item && typeof item === 'object' ? JSON.stringify(item) : String(item ?? '')))
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (fails && typeof fails === 'object') {
    const list = []
    if (Array.isArray(fails.fails)) list.push(...fails.fails.map((item) => String(item)))
    if (Array.isArray(fails.warns)) list.push(...fails.warns.map((item) => `(warn) ${String(item)}`))
    return list.map((item) => item.trim()).filter(Boolean)
  }
  if (typeof fails === 'string' && fails.trim()) return [fails.trim()]
  return []
}

/**
 * 生成重试追加段（Host 把它拼到下一次 prompt 的本集数据/重试材料位置）。
 * @param {string|string[]|{fails?:string[],warns?:string[]}} fails
 * @returns {string}
 */
export function buildRetryInstruction(fails) {
  const list = normalizeFails(fails)
  const failLines = list.length ? list.map((item, index) => `${index + 1}. ${item}`).join('\n') : '（未提供结构化失败项：请按 check_ep 硬失败白名单自查台词/锁行/双语/文化/主角镜头/字数）'
  return [
    '【重试指令】',
    '本轮为内容重试（不是新任务）。上次机检/解析失败项：',
    failLines,
    '',
    '逐项修复上述全部问题；先重做 shot_plan 并自检达标，再重写整集正文；同时完整执行 system 与规则包的全部规范。',
    '硬提醒：SOURCE 台词/锁行/事实逐字不动；不得合并、删除、重排源 △；CJK ≤10000；只处理本集；不得引入其他集正文。',
  ].join('\n')
}

/**
 * 估算一次 prompt 的 token 数（字符串或 buildDirectorPrompt 返回值均可）。
 * @param {string|{system?:string,messages?:unknown[]}} prompt
 * @returns {number}
 */
export function estimatePromptTokens(prompt) {
  return estimateTokensOfPrompt(prompt)
}

/** 统计 prompt 的字符构成（调试/报告用）：{chars,cjk,ascii,spaces,other}。 */
export function estimatePromptStats(prompt) {
  return statsOfPrompt(prompt)
}

export default {
  loadDirectorContext,
  buildDirectorPrompt,
  parseDirectorOutput,
  buildRetryInstruction,
  estimatePromptTokens,
  estimatePromptStats,
  DIRECTOR_PROMPT_VERSION,
}
