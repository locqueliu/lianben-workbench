/**
 * prompts/storyboard2.mjs — T2（2.0 演绎剧）分镜 planner/writer prompt 资产与解析器。
 *
 * 契约（Host 直接 import，保持稳定）：
 *   buildStoryboardPlannerPrompt({ ep, title, profileName, profile, source, ledgerRows, factsLock, handoff, optimized, rules })
 *     -> { system, messages, maxTokens: 8192, temperature, reasoningEffort: 'low' }
 *   parseStoryboardPlan(text, { expectedEp, profileName, profile } = {})
 *     -> { ok, plan, errors, warnings }
 *   buildStoryboardWriterPrompt({ ep, title, profileName, profile, plan, source, contract, craft })
 *     -> { system, messages, maxTokens: 16384, temperature, reasoningEffort: 'low' }
 *   parseStoryboardMarkdown(text, { ep, profileName, profile } = {})
 *     -> { ok, text, errors, warnings }
 *   buildStoryboardRetryInstruction({ stage, errors })
 *     -> string
 *
 * 依据（只读参考）：
 *   work/2.0/script-refinement-workflow-2.0-yanyi-workflow/
 *     .opencode/agents/{storyboard-planner,storyboard-writer}.md
 *     参考资料/分镜细则/{00-contract,01-planning,02-craft}.md
 *     storyboard-profile.json
 *
 * 本模块不写文件、不调用模型；规则/契约文本内嵌为默认值，可通过参数覆盖。
 * 只使用本集 SOURCE 与台账本集行；不注入其他集正文。
 */

import {
  firstNonEmptyLine,
  normalizeOutputText,
  parseJsonLoose,
  stripOuterFence,
} from '../lib/refine-text.mjs'

export const STORYBOARD2_PROMPT_VERSION = 't2.1'

export const PLANNER_MAX_TOKENS = 8192
export const WRITER_MAX_TOKENS = 16384
export const PLANNER_TEMPERATURE = 0.4
export const WRITER_TEMPERATURE = 0.5

/** 2.0 官方 profile 默认值（与参考 storyboard-profile.json 对齐；可由调用方覆盖）。 */
export const STORYBOARD_PROFILES = Object.freeze({
  B_bilingual_full: {
    language: 'bilingual',
    require_fields: ['space_start', 'shot_time', 'sound', 'prohibit'],
    optional_fields: ['frame_range', 'offscreen_lock'],
    shot_max: 4.0,
    group_max: 15.0,
    episode_max: 150.0,
    groups_per_ep: [6, 12],
    shots_per_group: [1, 5],
    shots_per_ep: [28, 50],
    cjk_per_ep: [4500, 9000],
    total_chars_per_ep: 10000,
    total_chars_target: 9000,
    episode_warn_above: 145.0,
    time_tolerance: 0.06,
    forbid_tokens: ['△', 'SPECTACLE', 'VFX', '【人物站位】', '【景别', '[EN]:'],
    space_forbid_phrases: ['同上', '同前', '承接上一', '位置不变', '参照上组', '参见上组'],
    dialogue_tags: ['对白', 'VO', 'OS', 'O.S.'],
  },
  A_english_lean: {
    language: 'english',
    require_fields: ['space_start', 'shot_time', 'sound', 'prohibit'],
    optional_fields: ['frame_range', 'offscreen_lock'],
    shot_max: 4.0,
    group_max: 15.0,
    episode_max: 150.0,
    groups_per_ep: [6, 12],
    shots_per_group: [1, 5],
    shots_per_ep: [28, 50],
    cjk_per_ep: [4500, 9000],
    total_chars_per_ep: 10000,
    total_chars_target: 9000,
    episode_warn_above: 145.0,
    time_tolerance: 0.06,
    forbid_tokens: ['△', 'SPECTACLE', 'VFX', '【人物站位】', '【景别', '[EN]:'],
    space_forbid_phrases: ['同上', '同前', '承接上一', '位置不变', '参照上组', '参见上组'],
    dialogue_tags: ['对白', 'VO', 'OS', 'O.S.'],
  },
})

/* ------------------------------------------------------------------------- */
/* 内嵌规则文本（与 2.0 参考分镜细则对齐；可由 rules 参数覆盖）                  */
/* ------------------------------------------------------------------------- */

const CONTRACT_RULES = `# 竖屏分镜稿输出契约（A/B 共用）
固定结构：
第N集
N-N 日/夜 内/外 场景名
人物：角色A、角色B
分镜1（时长：12.0秒）
空间起点：本组 0.0 秒仍在场的全部人物位置、朝向、距离、场景参照物；摄影机位置与拍摄方向
镜头1（0.0—3.0秒）
景别，机位/运镜。（姿态：…）（位置：…）本镜动作、表演、画面范围
角色（表演提示）：台词
镜头2（3.0—6.0秒）
...
声音设计：本组实际可听的环境声、动作声、人声
禁止：无背景音乐，无字幕。

硬指标：单镜 ≤4.0 秒；分镜组 ≤15.0 秒；单集 ≤150.0 秒（上限不是目标，短集 80—120 秒）；分镜组/集 6—12；镜头/集 28—50；中文/集 4500—9000 为目标（超过 9000 仅提示）；总字符数/集仅 >10000 为硬错误（含标点/空格/换行），≤9000 为目标提示，9001—10000 可通过；时间精度 0.5 秒；组内时间轴从 0.0 连续，镜头时长之和 = 组时长；单集 >145 秒需确认是否必要。
组：分镜N（时长：X.X秒），同集从 1 连续编号；组首必须有且只有一个「空间起点：」；组末必须有「声音设计：」（或「声音：」）与「禁止：」（或「硬性禁止：」）。
镜头：镜头N（A.A—B.B秒），组内从 0 开始首尾相接；画面范围：/画外锁定（禁止生成入画）：为可选字段。
禁用：△、SPECTACLE、VFX、【人物站位】、【景别、[EN]:；禁用「同上/同前/承接上一/位置不变/参照上组/参见上组」等空间省略词；禁用无来源的新人物/新剧情/新能力/新伤势/新道具功能；禁止 BGM、字幕、画面新增文字。
语言 profile：
B_bilingual_full（默认）：保留源稿中英双语台词；英文是表演/口型/计时轨，中文是对照；英文逐字保留，中文按同一语义边界拆分；标签支持 对白 / VO / OS / O.S.（O.S. 统一按 OS 处理）；画面范围可选但建议写。
A_english_lean：最终只保留英文台词；中文译文删除（不是改写）；英文逐字保留，可按语义拆到多镜；中文只保留在表演提示/动作说明中。
台词：每句源台词必须在成品中出现且只出现一次（长台词拆分后各片段只出现一次，拼起来等于原文）；不新增、不改写、不翻译、不合并角色归属；标签只沿用源稿，源稿无标签时不得擅自补「对白」；长台词拆分优先在标点/语义边界；极短回应（No. / 滚。）不拆。
质量目标：每个分镜组可独立生成（只读本组空间起点就能还原人物位置与摄影机关系）；每 3—5 秒至少一次有效变化；多人镜头写清高低位、前后纵深、左右、遮挡、视线与轴线；关键动作链写清触发—动作—接触—结果/反应；倾听者有符合心理的可见反应；开头/结尾优先近景或特写，禁止孤立器官大特写；每集 30—45 镜、约 4800—5200 中文字，不为凑数加空镜。`

const PLANNING_RULES = `# 分镜计划器规则（先计划，后写稿）
计划器只产出结构化计划，不写最终分镜正文，不输出解释。
必读输入：storyboard-profile.json、参考资料/分镜细则/ 全部文件、本集 SOURCE、台词台账（本集行，含无标签句）、facts_lock、handoff（仅本集接点）、optimized 记录（若有）。
计划 JSON 结构：{ ep, profile, scenes:[ { scene, heading, cast:[...], groups:[ { no, duration, space_start, sound, prohibit, shots:[ { no, start, end, shot, frame_range?, offscreen?, action, dialogue:[ {sid, speaker, label, text} ], tags? } ] } ] } ] }。
dialogue[].text 必须是台账原文；拆分时每个片段各出现一次，按顺序拼回等于原文。label 只用「对白 / VO / OS」（台账 O.S. 已归一为 OS）；源无标签时留空。sid 必填，同一 sid 可拆成多个片段但必须连续、按序、无重复全文。
规划顺序：
1 锁定事实：按场读 SOURCE，列出人物、道具、动作结果、情绪变化、台词/OS/VO，不得新增事实。
2 分场：沿用 SOURCE 场次，不增删场景。
3 排真实时间：英文按约 2—3 词/秒估算，中文按语义对应英文时长；先算台词/动作/反应的真实重叠时间再切镜头；单镜 ≤4 秒、组 ≤15 秒、集 ≤150 秒。
4 分组：每组 1—5 镜（建议 3—5）；同一连续发言优先同组；组间用动作/视线/声音/道具衔接。
5 写空间起点：本组 0.0 秒全部在场人物逐人写站点、朝向、距离、参照物；摄影机位置/方向；不得用省略词。
6 逐镜计划：镜头给最能推进信息/情绪/关系的人；相邻镜不得同主体+相近景别+同构图；关键动作链写触发—动作—接触—结果；倾听者有可见反应；开头/结尾用近景或特写。
7 台词拆分：超长句按标点/语义边界拆到连续镜头；极短回应不拆；拆分后每片只出现一次，拼回原文；不得改字、不得改标签、不得翻译。
8 自检：时间求和、组/集上限、空间起点完整、台词覆盖、标签、无 △/SPECTACLE/[EN]:。
密度目标：每集 28—50 镜、6—12 组、约 4500—9000 中文字（B 含中英双语栏；A 只算英文+动作），均为生成目标；超过 9000 仅提示；总字符数目标 ≤9000，9001—10000 可通过，仅 >10000 为长度硬错误。150 秒是硬上限不是目标；不得为接近上限加镜/加动作/加环境描写。`

const CRAFT_RULES = `# 分镜写稿细则（空间、表演、镜头、声音）
空间与多人关系：每场先选移动最少、最稳定的人物作参照，用固定物品（门、桌、柜台、台阶、柱子）锁定真实站点；其他人写相对方位、前后偏差、间距、身体朝向、视线目标。每组空间起点必须独立写全（画左/画右、前/中/后景、高低、距离、朝向、参照物、摄影机在哪一侧）；禁止省略词。走位写清从哪进、经过哪、停在哪、朝哪转；走位后重新核对全员关系。双人对话固定关系轴；过肩/反打继承画面左右与轴线，不越轴。三人以上写清三角/前后/高低关系；后入场先给声音、入口或移动方向。关键动作链写接触前起点、发力/接触、结果、双方反应，不得用切镜跳过接触或用结果替代动作。道具写清持有者、支撑面、取放过程、落点。
表演：写实主义+心理现实主义；情绪由刺激、判断、行动推进，不直接写「愤怒/紧张/绝望」。每句台词括号只写「怎么说」：声音/气息/情绪状态 + 至少一个可拍的面部、眼部、下颌、喉部或手部细节；不把完整动作链塞进括号。说话者未出镜标 OS/VO/电话画外音；倾听者在信息抵达时给符合心理的视线、神态、动作或距离变化。抽象状态（平静/冷静/冷酷/克制/淡漠/沉默）必须转成可见表演。颜色只在剧情需要时写；禁止「脸色惨白/通红/眼睛发光」与孤立嘴唇/牙齿/鼻子/眼睛大特写。
镜头：每镜一个完整可拍过程（起—变/接触—落），单镜 ≤4 秒；相邻镜不得同主体+相近景别+同构图；冲突/羞辱/认知改变/关系转折/证据/爆发优先近景/特写；全景只用于空间建立/大范围移动；每镜技术描述写景别、机位/高度/俯仰、固定或运镜；画面范围写实际入画人物、景深、正/侧/背、可见身体范围、遮挡；画外锁定只锁不该入画的人/部位；每 3—5 秒至少一次有效变化；不为换镜加准备/停顿/收尾时间。
声音：每场建立 1—3 种代表性环境声；组末声音设计汇总本组实际可听声音；声音开始/停止/影响表演时在对应镜头动作段写触发时点。无 BGM、无字幕、无画面新增文字。
台词：逐字锁定；不翻译、不改写、不增删、不调序、不改角色归属；长台词按标点/语义拆到连续镜头，每片只出现一次；极短回应不拆；标签只用 对白/VO/OS；O.S. 归一为 OS；源无标签不补；双语 profile 保留中英对照。
交付自检：组首空间起点可独立还原全组；组末声音/禁止齐全；时间轴连续、求和等于组时长；组 ≤15s、集 ≤150s、单镜 ≤4s；台词拼回原文；无 △/SPECTACLE/VFX/[EN]:/【人物站位】/【景别。`

export const STORYBOARD_RULES = Object.freeze({
  contract: CONTRACT_RULES,
  planning: PLANNING_RULES,
  craft: CRAFT_RULES,
})

/* ------------------------------------------------------------------------- */
/* 校验常量与工具                                                              */
/* ------------------------------------------------------------------------- */

const SID_RE = /^EP(\d{2})-D(\d{4})$/
const CONTACT_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/
const GROUP_LINE_RE = /^分镜\s*(\d+)\s*[（(]\s*时长\s*[：:]\s*([0-9]+(?:\.[0-9]+)?)\s*秒\s*[）)]/
const SHOT_LINE_RE = /^镜头\s*(\d+)\s*[（(]\s*([0-9]+(?:\.[0-9]+)?)\s*[—\-–~]\s*([0-9]+(?:\.[0-9]+)?)\s*秒\s*[）)]/
const SCENE_LINE_RE = /^(\d+)\s*[-－]\s*(\d+)\s+\S/
const DIALOGUE_LINE_RE = /^([^：:（(]{1,40})[（(][^）)]*[）)]\s*[：:]\s*(.+)$/

function pad2(n) {
  return String(n).padStart(2, '0')
}

function pad4(n) {
  return String(n).padStart(4, '0')
}

function normalizeEp(ep) {
  const n = Number(ep)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`E_EP_INVALID: ${String(ep)}`)
  return n
}

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function countCjk(text) {
  let n = 0
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0)
    if (code >= 0x4e00 && code <= 0x9fff) n += 1
  }
  return n
}

function profileFor(nameOrProfile, fallbackName = 'B_bilingual_full') {
  if (nameOrProfile && typeof nameOrProfile === 'object' && nameOrProfile.shot_max) {
    return { name: nameOrProfile.name || fallbackName, profile: nameOrProfile }
  }
  const requested = typeof nameOrProfile === 'string' && nameOrProfile ? nameOrProfile : ''
  const fallback = STORYBOARD_PROFILES[fallbackName] ? fallbackName : 'B_bilingual_full'
  const name = STORYBOARD_PROFILES[requested] ? requested : fallback
  return { name, profile: STORYBOARD_PROFILES[name] }
}

function normalizeIssues(issues) {
  if (!issues) return []
  const out = []
  for (const issue of Array.isArray(issues) ? issues : [issues]) {
    if (typeof issue === 'string' && issue.trim()) {
      out.push({ type: 'must_fix', severity: 'must_fix', detail: issue.trim() })
      continue
    }
    if (issue && typeof issue === 'object') out.push(issue)
  }
  return out
}

function textOr(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || fallback
}

function jsonBlock(value) {
  return JSON.stringify(value, null, 1)
}

function section(title, body) {
  return `【${title}】\n${body}`
}

/**
 * 归一化台词台账行：接受对象数组或 TSV 字符串；按本集过滤；缺 sid 时按台账顺序生成
 * EP{ep2}-D{no4}（Host 也可显式传入已有 sid，不得改写）。
 * @returns {Array<{sid:string,no:number,scene:string,speaker:string,tag:string,lang:string,text:string}>}
 */
export function normalizeLedgerRows(ledgerRows, ep) {
  const epNumber = normalizeEp(ep)
  const rows = []
  if (typeof ledgerRows === 'string') {
    const lines = normalizeOutputText(ledgerRows).split('\n').filter((line) => line.trim())
    if (!lines.length) return rows
    const header = lines[0].split('\t').map((cell) => cell.trim())
    for (const line of lines.slice(1)) {
      const cells = line.split('\t')
      const row = {}
      header.forEach((key, index) => {
        row[key] = (cells[index] ?? '').trim()
      })
      rows.push(row)
    }
  } else if (Array.isArray(ledgerRows)) {
    rows.push(...ledgerRows.filter((row) => row && typeof row === 'object'))
  }
  return rows
    .filter((row) => row.ep === undefined || Number(row.ep) === epNumber)
    .map((row, index) => {
      const no = Number(row.no ?? index + 1)
      const sid = isNonEmptyString(row.sid) ? row.sid.trim() : `EP${pad2(epNumber)}-D${pad4(no)}`
      return {
        sid,
        no,
        scene: String(row.scene ?? '').trim(),
        speaker: String(row.speaker ?? '').trim(),
        tag: String(row.tag ?? row.label ?? '').trim(),
        lang: String(row.lang ?? '').trim(),
        text: String(row.text ?? '').trim(),
      }
    })
    .filter((row) => row.text)
}

/* ------------------------------------------------------------------------- */
/* Planner prompt                                                              */
/* ------------------------------------------------------------------------- */

const PLANNER_SYSTEM = `你是「竖屏分镜计划器」（storyboard-planner）。只做结构化计划，不写最终分镜正文；没有工具，全部输入已随消息注入。只输出一个 JSON 对象（可放在单个 Markdown 代码围栏内），不输出解释、报告或 Markdown 围栏以外的文字。

硬约束（违反任一即失败）：
1. 时间：单镜 ≤4.0 秒；分镜组 ≤15.0 秒；单集 ≤150.0 秒（上限不是目标，短集 80—120 秒）；组内时间轴从 0.0 开始首尾相接，镜头时长之和 = 组时长；不得为接近上限加镜/加动作/加环境描写。
2. 规模：每集 6—12 个分镜组、28—50 个镜头（均为目标，不得为凑数分组/切镜）；每组 1—5 镜（建议 3—5）。
3. 每组必须有完整 space_start（0.0 秒仍在场的全部人物：站点、朝向、距离、参照物、摄影机方向），不得用「同上/同前/位置不变/承接上一/参照上组」；每组必须有 sound 与 prohibit。
4. 台词逐字锁定：计划中的每个 dialogue[].text 必须来自本集台词台账原文；不新增、不改写、不翻译、不调序、不合并角色；长台词可按语义/标点拆到连续镜头，每片只出现一次，拼回等于原文；极短回应不拆。标签只用「对白 / VO / OS」（台账 O.S. 归一为 OS）；源无标签留空，不补。sid 必填且不得改写；同一 sid 可拆成多个片段，但必须连续、按序、无重复全文。
5. 语言 profile：B_bilingual_full 保留中英双语台词（英文为表演/计时轨，中文为对照）；A_english_lean 只保留英文台词，删除中文译文（不翻译、不改写）。
6. 分场：沿用 SOURCE 场次，不增删场景、不新增人物/剧情/能力/伤势/道具功能。
7. 计划中不得出现禁用字段/符号：△、SPECTACLE、VFX、[EN]:、【人物站位】、【景别；不得出现手机号/联系方式/URL 等非剧本信息。
8. 只输出合法 JSON；ep 为数字；profile 与注入一致；scenes 非空；groups/shots 编号连续。`

const PLAN_SCHEMA = `{
  "ep": <集号数字>,
  "profile": "<profile 名，如 B_bilingual_full>",
  "scenes": [
    {
      "scene": "<场次号，如 1-1>",
      "heading": "<场次行：N-N 日/夜 内/外 场景名>",
      "cast": ["<本场出镜/发声人物>"],
      "groups": [
        {
          "no": 1,
          "duration": 12.0,
          "space_start": "<本组 0.0 秒全部在场人物站点/朝向/距离/参照物 + 摄影机位置方向>",
          "sound": "<本组实际可听环境声/动作声/人声>",
          "prohibit": "无背景音乐，无字幕",
          "shots": [
            {
              "no": 1,
              "start": 0.0,
              "end": 3.0,
              "shot": "<景别，机位/高度/俯仰，固定或运镜>",
              "frame_range": "<可选：实际入画人物/景深/正侧背/可见身体范围/遮挡>",
              "offscreen": "<可选：画外锁定，不应入画的人/部位>",
              "action": "<本镜实际动作、表演、反应、姿态与落幅>",
              "dialogue": [
                { "sid": "EP01-D0001", "speaker": "<说话人>", "label": "对白|VO|OS|空", "text": "<台账原文>" }
              ],
              "tags": ["<可选：镜头语言/动作标签>"]
            }
          ]
        }
      ]
    }
  ]
}`

/**
 * 构建分镜计划器 prompt。
 * @returns {{system:string, messages:Array, maxTokens:number, temperature:number, reasoningEffort:'low'}}
 */
export function buildStoryboardPlannerPrompt({
  ep,
  title,
  profileName,
  profile,
  source,
  ledgerRows,
  factsLock,
  handoff,
  optimized,
  rules,
} = {}) {
  const epNumber = normalizeEp(ep)
  const resolved = profileFor(profile || profileName, profileName || 'B_bilingual_full')
  const profileNameResolved = resolved.name
  const profileObj = resolved.profile
  const titleText = textOr(title, `第${epNumber}集`)
  const sourceText = textOr(source, '')
  if (!sourceText) throw new Error(`E_SOURCE_REQUIRED: 第${epNumber} 集缺少 SOURCE`)
  const ruleSet = rules && typeof rules === 'object' ? { ...STORYBOARD_RULES, ...rules } : STORYBOARD_RULES
  const ledger = normalizeLedgerRows(ledgerRows, epNumber)
  const ledgerBlock = ledger.length
    ? ledger.map((row) => `${row.sid}\t${row.scene}\t${row.speaker}\t${row.tag || '（无标签）'}\t${row.lang}\t${row.text}`).join('\n')
    : '（无本集台账行：禁止新增台词；只能使用 SOURCE 中可识别的台词并保留原文/原标签）'
  const languageRule =
    profileObj.language === 'english'
      ? 'A_english_lean：最终只保留英文台词；中文译文必须删除（不翻译、不改写）；中文只保留在表演提示/动作说明中。计划 dialogue 中不得出现中文台词。'
      : 'B_bilingual_full：保留中英双语台词；英文逐字保留（表演/口型/计时轨），中文按同一语义边界拆分；两者都必须在计划中出现。'

  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            section('规则（分镜细则 00/01/02，逐字硬约束）', ''),
            section('00-contract', ruleSet.contract),
            section('01-planning', ruleSet.planning),
            section('02-craft', ruleSet.craft),
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
            section('本集与 profile', ''),
            `- 集号：EP${pad2(epNumber)}`,
            `- 集标题：${titleText}`,
            `- profile：${profileNameResolved}`,
            `- 语言策略：${languageRule}`,
            section('profile JSON', jsonBlock(profileObj)),
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
            section(`本集 SOURCE：第 ${epNumber} 集（唯一事实源，逐字）`, sourceText.trim()),
            section('本集台词台账（共 ' + ledger.length + ' 行；除本集外不得引用其他集）', ledgerBlock),
            section('全局锁定事实 facts_lock.md（可缺）', textOr(factsLock, '（无全局锁定事实）')),
            section('跨集接点 handoff（仅本集条目）', textOr(handoff, '（无）')),
            section('本集前置优化记录 optimized（可缺）', textOr(optimized, '（无前置优化记录）')),
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
            section(
              '任务',
              [
                `为第 ${epNumber} 集（${titleText}）输出分镜计划 JSON。按 01-planning 的顺序执行：锁定事实 → 分场 → 排真实时间 → 分组 → 写空间起点 → 逐镜计划 → 台词拆分 → 自检。`,
                '计划的最终稿长度预算：总字符数目标 ≤9000，9001—10000 可通过；仅 >10000 为硬错误。按分镜组预先分配预算，逼近上限时减少重复动作/修饰，不改台词与硬锁。',
                '只处理本集；只使用注入的 SOURCE 与台账；不引用、不推测其他集。',
              ].join('\n'),
            ),
            section('输出契约（只输出 JSON，可放单个代码围栏）', PLAN_SCHEMA),
            section(
              '禁止项',
              [
                '- 不写最终分镜正文、不写解释/报告/审计/方法论。',
                '- 不得改台词原文/标签/sid；不得改场次；不得新增事实或人物。',
                '- 不得出现 △、SPECTACLE、VFX、[EN]:、【人物站位】、【景别。',
                '- 不得出现手机号/联系方式/URL 等非剧本信息。',
                '- 不得用「同上/同前/位置不变/承接上一/参照上组」等省略词写空间起点。',
              ].join('\n'),
            ),
          ].join('\n\n'),
        },
      ],
    },
  ]

  return {
    system: PLANNER_SYSTEM,
    messages,
    maxTokens: PLANNER_MAX_TOKENS,
    temperature: PLANNER_TEMPERATURE,
    reasoningEffort: 'low',
  }
}

/* ------------------------------------------------------------------------- */
/* Planner 输出解析                                                            */
/* ------------------------------------------------------------------------- */

function extractJsonCandidate(text) {
  const normalized = stripOuterFence(normalizeOutputText(text)).trim()
  const direct = parseJsonLoose(normalized)
  if (direct.ok) return { ok: true, value: direct.value }
  const start = normalized.indexOf('{')
  const end = normalized.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const sliced = parseJsonLoose(normalized.slice(start, end + 1))
    if (sliced.ok) return { ok: true, value: sliced.value }
  }
  return { ok: false, error: direct.error || 'not_json' }
}

function checkPlanTimeline(group, profile, errors, warnings) {
  const groupNo = group.no
  const shots = group.shots
  if (!Array.isArray(shots) || !shots.length) {
    errors.push(`group_${groupNo}:no_shots`)
    return
  }
  let expectedStart = 0
  let shotTotal = 0
  for (const [index, shot] of shots.entries()) {
    if (!shot || typeof shot !== 'object') {
      errors.push(`group_${groupNo}:shot_${index + 1}:invalid`)
      continue
    }
    const shotNo = Number(shot.no)
    if (shotNo !== index + 1) errors.push(`group_${groupNo}:shot_no_not_continuous:${shotNo}/${index + 1}`)
    const start = toNumber(shot.start)
    const end = toNumber(shot.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      errors.push(`group_${groupNo}:shot_${shotNo}:time_invalid`)
      continue
    }
    if (start < 0) errors.push(`group_${groupNo}:shot_${shotNo}:time_negative`)
    if (end <= start) errors.push(`group_${groupNo}:shot_${shotNo}:time_reversed_or_zero`)
    if (Math.abs(start - expectedStart) > profile.time_tolerance) {
      errors.push(`group_${groupNo}:shot_${shotNo}:time_gap:${start}/${round2(expectedStart)}`)
    }
    const duration = end - start
    if (duration > profile.shot_max + profile.time_tolerance) {
      errors.push(`group_${groupNo}:shot_${shotNo}:over_shot_max:${round2(duration)}`)
    }
    if (!isNonEmptyString(shot.shot)) errors.push(`group_${groupNo}:shot_${shotNo}:missing_shot`)
    if (!isNonEmptyString(shot.action) && !(Array.isArray(shot.dialogue) && shot.dialogue.length)) {
      warnings.push(`group_${groupNo}:shot_${shotNo}:no_action_or_dialogue`)
    }
    expectedStart = end
    shotTotal += duration
  }
  const groupDuration = toNumber(group.duration)
  if (!Number.isFinite(groupDuration) || groupDuration <= 0) {
    errors.push(`group_${groupNo}:duration_invalid`)
  } else {
    if (groupDuration > profile.group_max + profile.time_tolerance) {
      errors.push(`group_${groupNo}:over_group_max:${round2(groupDuration)}`)
    }
    if (Math.abs(shotTotal - groupDuration) > profile.time_tolerance) {
      errors.push(`group_${groupNo}:duration_sum_mismatch:${round2(shotTotal)}/${round2(groupDuration)}`)
    }
  }
  if (Array.isArray(shots)) {
    const [lo, hi] = profile.shots_per_group
    if (shots.length > hi) errors.push(`group_${groupNo}:too_many_shots:${shots.length}`)
    if (shots.length < lo) warnings.push(`group_${groupNo}:too_few_shots:${shots.length}`)
  }
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100
}

function checkDialogueEntry(entry, epNumber, profile, errors, warnings) {
  if (!entry || typeof entry !== 'object') {
    errors.push('dialogue:invalid_entry')
    return null
  }
  const sid = typeof entry.sid === 'string' ? entry.sid.trim() : ''
  if (!sid) {
    errors.push('dialogue:missing_sid')
    return null
  }
  const sidMatch = sid.match(SID_RE)
  if (!sidMatch) {
    errors.push(`dialogue:sid_format:${sid}`)
  } else if (Number(sidMatch[1]) !== epNumber) {
    errors.push(`dialogue:sid_ep_mismatch:${sid}`)
  }
  if (!isNonEmptyString(entry.speaker)) errors.push(`dialogue:${sid}:missing_speaker`)
  if (!isNonEmptyString(entry.text)) {
    errors.push(`dialogue:${sid}:missing_text`)
    return { sid, text: '' }
  }
  const text = entry.text.trim()
  const label = typeof entry.label === 'string' ? entry.label.trim() : ''
  if (label && !['对白', 'VO', 'OS'].includes(label)) errors.push(`dialogue:${sid}:label_invalid:${label}`)
  if (CONTACT_RE.test(text)) errors.push(`dialogue:${sid}:contact_info`)
  if (profile.language === 'english' && countCjk(text) > 0) errors.push(`dialogue:${sid}:a_profile_cn_dialogue`)
  if (text.includes('△')) errors.push(`dialogue:${sid}:forbidden_token:△`)
  return { sid, text }
}

/**
 * 解析分镜计划 JSON（允许 code fence / 前后少量文本包裹，但只接受可解析 JSON）。
 * @param {string} text
 * @param {{expectedEp?:number, profileName?:string, profile?:object}} [options]
 * @returns {{ok:boolean, plan:object|null, errors:string[], warnings:string[]}}
 */
export function parseStoryboardPlan(text, options = {}) {
  const errors = []
  const warnings = []
  const result = { ok: false, plan: null, errors, warnings }
  if (typeof text !== 'string' || !text.trim()) {
    errors.push('empty_output')
    return result
  }
  const candidate = extractJsonCandidate(text)
  if (!candidate.ok) {
    errors.push(`not_json:${candidate.error}`)
    return result
  }
  const plan = candidate.value
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    errors.push('plan_not_object')
    return result
  }
  result.plan = plan

  const expectedEp = options.expectedEp !== undefined ? Number(options.expectedEp) : null
  const ep = Number(plan.ep)
  if (!Number.isInteger(ep) || ep <= 0) {
    errors.push('ep_missing_or_invalid')
  } else if (expectedEp !== null && ep !== expectedEp) {
    errors.push(`ep_mismatch:${ep}/${expectedEp}`)
  }

  const profileFromPlan = typeof plan.profile === 'string' ? plan.profile : ''
  if (!profileFromPlan) {
    errors.push('profile_missing')
  } else if (!STORYBOARD_PROFILES[profileFromPlan]) {
    errors.push(`profile_unknown:${profileFromPlan}`)
  }
  const resolved = profileFor(options.profile || options.profileName || profileFromPlan || 'B_bilingual_full', profileFromPlan || 'B_bilingual_full')
  const profile = resolved.profile

  const rawPlanText = JSON.stringify(plan)
  for (const token of profile.forbid_tokens || []) {
    if (rawPlanText.includes(token)) errors.push(`forbidden_token:${token}`)
  }

  if (!Array.isArray(plan.scenes) || !plan.scenes.length) {
    errors.push('scenes_missing_or_empty')
    result.ok = errors.length === 0
    return result
  }

  let globalGroupNo = 0
  let shotsTotal = 0
  const durationTotal = (() => {
    let sum = 0
    for (const scene of plan.scenes) {
      for (const group of Array.isArray(scene.groups) ? scene.groups : []) sum += Number(group.duration) || 0
    }
    return sum
  })()

  const dialogueSequence = []
  for (const [sceneIndex, scene] of plan.scenes.entries()) {
    if (!scene || typeof scene !== 'object') {
      errors.push(`scene_${sceneIndex + 1}:invalid`)
      continue
    }
    if (!isNonEmptyString(scene.scene) || !/^\d+[-－]\d+$/.test(String(scene.scene).trim())) {
      errors.push(`scene_${sceneIndex + 1}:scene_invalid:${String(scene.scene)}`)
    }
    if (!isNonEmptyString(scene.heading) || !SCENE_LINE_RE.test(scene.heading.trim())) {
      errors.push(`scene_${sceneIndex + 1}:heading_invalid`)
    }
    if (scene.cast !== undefined && !Array.isArray(scene.cast)) errors.push(`scene_${sceneIndex + 1}:cast_not_array`)
    if (!Array.isArray(scene.groups) || !scene.groups.length) {
      errors.push(`scene_${sceneIndex + 1}:groups_empty`)
      continue
    }
    for (const group of scene.groups) {
      if (!group || typeof group !== 'object') {
        errors.push(`group_${globalGroupNo + 1}:invalid`)
        continue
      }
      globalGroupNo += 1
      if (Number(group.no) !== globalGroupNo) errors.push(`group_no_not_continuous:${group.no}/${globalGroupNo}`)
      const spaceStart = typeof group.space_start === 'string' ? group.space_start.trim() : ''
      if (!spaceStart) {
        errors.push(`group_${globalGroupNo}:missing_space_start`)
      } else {
        if (spaceStart.length < 10) errors.push(`group_${globalGroupNo}:space_start_too_short`)
        for (const phrase of profile.space_forbid_phrases || []) {
          if (spaceStart.includes(phrase)) errors.push(`group_${globalGroupNo}:space_forbid_phrase:${phrase}`)
        }
      }
      if (!isNonEmptyString(group.sound)) errors.push(`group_${globalGroupNo}:missing_sound`)
      if (!isNonEmptyString(group.prohibit)) errors.push(`group_${globalGroupNo}:missing_prohibit`)
      checkPlanTimeline(group, profile, errors, warnings)
      for (const shot of Array.isArray(group.shots) ? group.shots : []) {
        shotsTotal += 1
        if (!Array.isArray(shot.dialogue)) continue
        for (const entry of shot.dialogue) {
          const checked = checkDialogueEntry(entry, Number.isInteger(ep) ? ep : 0, profile, errors, warnings)
          if (checked) dialogueSequence.push(checked)
        }
      }
    }
  }

  if (durationTotal > profile.episode_max + profile.time_tolerance) {
    errors.push(`episode_over_max:${round2(durationTotal)}`)
  } else if (durationTotal > profile.episode_warn_above) {
    warnings.push(`episode_near_max:${round2(durationTotal)}`)
  }
  const [groupLo, groupHi] = profile.groups_per_ep
  if (globalGroupNo > groupHi) errors.push(`too_many_groups:${globalGroupNo}`)
  else if (globalGroupNo < groupLo) warnings.push(`too_few_groups:${globalGroupNo}`)
  const [shotLo, shotHi] = profile.shots_per_ep
  if (shotsTotal > shotHi) errors.push(`too_many_shots:${shotsTotal}`)
  else if (shotsTotal < shotLo) warnings.push(`too_few_shots:${shotsTotal}`)

  // sid 连续性：同一 sid 的片段必须连续出现（可拆不可乱序）
  const seen = new Set()
  let previousSid = null
  for (const item of dialogueSequence) {
    if (item.sid === previousSid) continue
    if (seen.has(item.sid)) errors.push(`dialogue:sid_not_continuous:${item.sid}`)
    seen.add(item.sid)
    previousSid = item.sid
  }

  result.ok = errors.length === 0
  return result
}

/* ------------------------------------------------------------------------- */
/* Writer prompt                                                               */
/* ------------------------------------------------------------------------- */

const WRITER_SYSTEM = `你是「竖屏分镜写手」（storyboard-writer）。只把计划写成目标格式正文，不重新规划、不改计划结构；没有工具，全部输入已随消息注入。只输出分镜稿正文，不写解释、报告、审计、Markdown 标题/表格，也不输出围栏以外的说明文字。

硬约束（违反任一即失败）：
1. 计划不可改：duration/start/end/space_start/sound/prohibit/shots 的编号与时间原样使用；不得改组号、镜号、时间。
2. 固定格式：集标题行「第N集」；场次行「N-N 日/夜 内/外 场景名」；人物行「人物：…」；「分镜N（时长：X.X秒）」；「空间起点：…」；「镜头N（A.A—B.B秒）」；随后「景别，机位/运镜。（姿态：…）（位置：…）动作、表演、画面范围」；组末固定「声音设计：…」与「禁止：无背景音乐，无字幕。」（或「硬性禁止：」）。
3. 每组必须完整写入 space_start（不得改写为同上/同前/位置不变/承接上一/参照上组）；组内时间轴连续、求和等于组时长；单镜 ≤4 秒、组 ≤15 秒、集 ≤150 秒。
4. 台词逐字照计划：不加、不改、不译、不调序、不合并角色；标签按计划（对白/VO/OS，无标签不补）；A profile 只保留英文台词，删除中文译文；B profile 保留中英双语。
5. 不得出现 △、SPECTACLE、VFX、[EN]:、【人物站位】、【景别；不得出现手机号/联系方式/URL；禁止 BGM、字幕、画面新增文字。
6. 每镜写（姿态：…）（位置：…）；有 frame_range/offscreen 时写入对应位置（画面范围：/画外锁定：）。
7. 长度：总字符数（含标点/空格/换行）>10000 才是硬错误；9000 是目标提示，9001—10000 可通过；不得删台词、硬锁或必要格式来压长度，逼近上限时优先压缩重复动作、无效修饰和冗余反应。
8. 不得为凑时长/字数扩写；150 秒是上限不是目标；短集按真实内容写短。`

const WRITER_FORMAT_CONTRACT = `固定结构（逐行）：
第N集
N-N 日/夜 内/外 场景名
人物：角色A、角色B
分镜1（时长：12.0秒）
空间起点：本组 0.0 秒全部在场人物的站点、朝向、距离、参照物；摄影机位置与拍摄方向
镜头1（0.0—3.0秒）
景别，机位/运镜。（姿态：…）（位置：…）本镜动作、表演、画面范围
角色（表演提示）：台词
镜头2（3.0—6.0秒）
...
声音设计：本组实际可听的环境声、动作声、人声
禁止：无背景音乐，无字幕。
场次之间直接进入下一场，不写「第X场」。`

/**
 * 构建分镜写手 prompt。
 * @returns {{system:string, messages:Array, maxTokens:number, temperature:number, reasoningEffort:'low'}}
 */
export function buildStoryboardWriterPrompt({
  ep,
  title,
  profileName,
  profile,
  plan,
  source,
  contract,
  craft,
} = {}) {
  const epNumber = normalizeEp(ep)
  const resolved = profileFor(profile || profileName, profileName || 'B_bilingual_full')
  const titleText = textOr(title, `第${epNumber}集`)
  const planText = typeof plan === 'string' ? plan : jsonBlock(plan || {})
  if (!plan || (typeof plan === 'object' && !Object.keys(plan).length)) {
    throw new Error(`E_PLAN_REQUIRED: 第${epNumber} 集缺少分镜计划`)
  }
  const sourceText = textOr(source, '')
  if (!sourceText) throw new Error(`E_SOURCE_REQUIRED: 第${epNumber} 集缺少 SOURCE`)
  const languageRule =
    resolved.profile.language === 'english'
      ? 'A_english_lean：只保留英文台词，删除中文译文（不是改写）；中文只出现在表演提示/动作说明中。'
      : 'B_bilingual_full：保留中英双语台词；英文逐字保留，中文按同一语义边界拆分对照。'

  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            section('写稿契约与细则（逐字硬约束）', ''),
            section('00-contract（写作相关）', textOr(contract, STORYBOARD_RULES.contract)),
            section('02-craft（空间/表演/镜头/声音）', textOr(craft, STORYBOARD_RULES.craft)),
            section('固定格式契约', WRITER_FORMAT_CONTRACT),
          ].join('\n\n'),
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'text', text: section('本集分镜计划 JSON（结构不可改，时间/编号/台词原样使用）', planText) }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            section('本集与 profile', `- 集号：EP${pad2(epNumber)}\n- 集标题：${titleText}\n- profile：${resolved.name}\n- 语言策略：${languageRule}`),
            section(`本集 SOURCE：第 ${epNumber} 集（核对台词原文，逐字）`, sourceText.trim()),
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
            section(
              '任务',
              `按计划写第 ${epNumber} 集（${titleText}）的竖屏分镜稿正文。严格按计划的时间/组号/镜号/空间起点/台词/标签输出；不重新规划；不写解释、报告、审计、Markdown 标题/表格。`,
            ),
            section(
              '禁止项',
              [
                '- 不得改时间、组号、镜号、台词、标签、空间起点内容；不得新增/删除镜头或台词。',
                '- 不得出现 △、SPECTACLE、VFX、[EN]:、【人物站位】、【景别。',
                '- 不得出现「同上/同前/位置不变/承接上一/参照上组」等空间省略词。',
                '- 不得写 BGM、字幕、画面新增文字；不得写手机号/联系方式/URL。',
                '- 总字符数 >10000 为硬错误；9001—10000 可通过；不得删台词/硬锁/必要格式来压长度。',
              ].join('\n'),
            ),
          ].join('\n\n'),
        },
      ],
    },
  ]

  return {
    system: WRITER_SYSTEM,
    messages,
    maxTokens: WRITER_MAX_TOKENS,
    temperature: WRITER_TEMPERATURE,
    reasoningEffort: 'low',
  }
}

/* ------------------------------------------------------------------------- */
/* Writer 输出解析                                                             */
/* ------------------------------------------------------------------------- */

/**
 * 解析分镜稿 Markdown。
 * @param {string} text
 * @param {{ep?:number, profileName?:string, profile?:object}} [options]
 * @returns {{ok:boolean, text:string, errors:string[], warnings:string[]}}
 */
export function parseStoryboardMarkdown(text, options = {}) {
  const errors = []
  const warnings = []
  const result = { ok: false, text: '', errors, warnings }
  if (typeof text !== 'string' || !text.trim()) {
    errors.push('empty_output')
    return result
  }
  const normalized = stripOuterFence(normalizeOutputText(text)).trim()
  result.text = normalized
  if (!normalized) {
    errors.push('empty_output')
    return result
  }
  if (/```/.test(normalized)) errors.push('code_fence_remaining')

  const lines = normalized.split('\n').map((line) => line.trim())
  const firstLine = firstNonEmptyLine(normalized)
  if (!/^第\s*\d+\s*集/.test(firstLine)) {
    errors.push('title_line_invalid')
  } else {
    const titleEp = Number(firstLine.match(/^第\s*(\d+)\s*集/)[1])
    const expectedEp = options.ep !== undefined ? Number(options.ep) : null
    if (expectedEp !== null && titleEp !== expectedEp) errors.push(`ep_mismatch:${titleEp}/${expectedEp}`)
  }

  const seenEpisodeHeaders = lines.filter((line) => /^第\s*\d+\s*集/.test(line)).length
  if (seenEpisodeHeaders > 1) errors.push(`multiple_episode_titles:${seenEpisodeHeaders}`)

  const scenes = lines.filter((line) => SCENE_LINE_RE.test(line))
  if (!scenes.length) errors.push('missing_scene_line')
  const groups = lines.filter((line) => GROUP_LINE_RE.test(line))
  if (!groups.length) errors.push('missing_group')
  const shots = lines.filter((line) => SHOT_LINE_RE.test(line))
  if (!shots.length) errors.push('missing_shot')

  const resolved = profileFor(options.profile || options.profileName || 'B_bilingual_full', options.profileName || 'B_bilingual_full')
  const profile = resolved.profile
  for (const token of profile.forbid_tokens || []) {
    if (token === '△') {
      if (lines.some((line) => line.startsWith('△'))) errors.push('forbidden_token:△')
    } else if (normalized.includes(token)) {
      errors.push(`forbidden_token:${token}`)
    }
  }

  // 逐组检查：空间起点/声音设计/禁止 各一次
  let currentGroup = null
  let groupHasSpace = false
  let groupHasSound = false
  let groupHasProhibit = false
  const closeGroup = () => {
    if (!currentGroup) return
    if (!groupHasSpace) errors.push(`group_${currentGroup}:missing_space_start`)
    if (!groupHasSound) errors.push(`group_${currentGroup}:missing_sound`)
    if (!groupHasProhibit) errors.push(`group_${currentGroup}:missing_prohibit`)
  }
  for (const line of lines) {
    const groupMatch = line.match(GROUP_LINE_RE)
    if (groupMatch) {
      closeGroup()
      currentGroup = Number(groupMatch[1])
      groupHasSpace = false
      groupHasSound = false
      groupHasProhibit = false
      continue
    }
    if (!currentGroup) continue
    if (/^空间(?:起点)?\s*[：:]/.test(line)) {
      groupHasSpace = true
      const spaceText = line.replace(/^空间(?:起点)?\s*[：:]\s*/, '')
      if (spaceText.length < 10) errors.push(`group_${currentGroup}:space_start_too_short`)
      for (const phrase of profile.space_forbid_phrases || []) {
        if (spaceText.includes(phrase)) errors.push(`group_${currentGroup}:space_forbid_phrase:${phrase}`)
      }
    } else if (/^(?:声音设计|声音)\s*[：:]/.test(line)) {
      groupHasSound = true
    } else if (/^(?:硬性禁止|禁止)\s*[：:]/.test(line)) {
      groupHasProhibit = true
    }
  }
  closeGroup()

  // markdown 结构/说明残留
  if (lines.some((line) => /^#{1,6}\s/.test(line))) errors.push('markdown_heading')
  if (lines.some((line) => /^\|/.test(line))) errors.push('markdown_table')
  if (/修改说明|以下是修正|以下是修改|说明：/.test(normalized)) errors.push('explanation_residue')

  // 语言策略：A profile 不得出现中文台词
  if (profile.language === 'english') {
    const cnDialogue = lines.filter((line) => {
      const match = line.match(DIALOGUE_LINE_RE)
      return match && countCjk(match[2]) > 0
    })
    if (cnDialogue.length) errors.push(`a_profile_cn_dialogue:${cnDialogue.length}`)
  }

  const totalChars = Array.from(normalized).length
  if (totalChars > profile.total_chars_per_ep) errors.push(`total_chars_over_limit:${totalChars}`)
  else if (totalChars > profile.total_chars_target) warnings.push(`total_chars_over_target:${totalChars}`)

  result.ok = errors.length === 0
  return result
}

/* ------------------------------------------------------------------------- */
/* 重试指令                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * 生成 planner / writer 重试指令。
 * @param {{stage?:string, errors?:string|string[]|{fails?:string[],warns?:string[]}}} [input]
 * @returns {string}
 */
export function buildStoryboardRetryInstruction({ stage, errors } = {}) {
  const normalizedStage = String(stage || 'writer').toLowerCase() === 'planner' ? 'planner' : 'writer'
  const list = Array.isArray(errors)
    ? errors.map((item) => String(item).trim()).filter(Boolean)
    : typeof errors === 'string' && errors.trim()
      ? [errors.trim()]
      : errors && typeof errors === 'object'
        ? [...(Array.isArray(errors.fails) ? errors.fails : []), ...(Array.isArray(errors.warns) ? errors.warns : [])]
            .map((item) => String(item).trim())
            .filter(Boolean)
        : []
  const failLines = list.length ? list.map((item, index) => `${index + 1}. ${item}`).join('\n') : '（未提供结构化失败项：请按 storyboard_check 的 fails/warns 自查）'
  const lines = ['【重试指令】', `本轮为 ${normalizedStage} 重试（共享返工预算，每集最多 2 轮，planner+writer 合计只计 1 次）。上次失败项：`, failLines, '']
  if (normalizedStage === 'planner') {
    lines.push(
      '只重做分镜计划 JSON（不写正文）。逐项修复上述问题，并重新自检：',
      '- 单镜 ≤4.0 秒、分镜组 ≤15.0 秒、单集 ≤150.0 秒（上限不是目标）；组内时间轴从 0.0 连续、镜头时长之和 = 组时长；组/镜头编号连续。',
      '- 每组完整 space_start（不得省略词）、sound、prohibit；台词只用本集台账原文，sid 不得改，长台词可拆但拼回原文。',
      '- 不得出现 △、SPECTACLE、VFX、[EN]:、【人物站位】、【景别；不得出现手机号/联系方式。',
      '- 只输出合法 JSON；不改 SOURCE 事实、不新增台词/人物/剧情。',
    )
  } else {
    lines.push(
      '只重写分镜稿正文，不改计划、不重新规划。逐项修复上述问题，并重新自检：',
      '- 严格按计划的 duration/start/end/space_start/sound/prohibit/组号/镜号输出；组首写全空间起点，组末写声音设计与禁止。',
      '- 台词逐字照计划；标签按计划（对白/VO/OS，无标签不补）；A profile 只保留英文，B profile 保留中英双语。',
      '- 不得出现 △、SPECTACLE、VFX、[EN]:、【人物站位】、【景别；不得写解释/报告/Markdown 标题表格；不得写手机号/联系方式。',
      '- 总字符数 >10000 为硬错误；优先压缩重复动作/冗余修饰，不删台词/硬锁/必要格式。',
    )
  }
  lines.push('', '只处理本集，不引用其他集。')
  return lines.join('\n')
}

export default {
  STORYBOARD_PROFILES,
  STORYBOARD_RULES,
  STORYBOARD2_PROMPT_VERSION,
  normalizeLedgerRows,
  buildStoryboardPlannerPrompt,
  parseStoryboardPlan,
  buildStoryboardWriterPrompt,
  parseStoryboardMarkdown,
  buildStoryboardRetryInstruction,
}
