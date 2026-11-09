/**
 * prompts/preflight2_correct.mjs — T2（2.0 演绎剧）前置「单集修复/标准化」prompt 资产与解析器。
 *
 * 契约（Host 直接 import，保持稳定）：
 *   buildPreflightCorrectionPrompt({ ep, title, source, issues })
 *     -> { system, messages, maxTokens: 8192, temperature, reasoningEffort: 'low' }
 *   parseCorrectedEpisode(text, { ep })
 *     -> { ok, text, errors }
 *
 * 依据（只读参考）：
 *   work/2.0/script-refinement-workflow-2.0-yanyi-workflow/.opencode/agents/episode-optimizer.md
 *   以及 2.0 前置 reviewer 的 must_fix / suspected / scene_unify / culture_issues 语义。
 *
 * 核心约束：只修复列出的问题；台词/锁行/场次逐字不动；最小改动；输出完整集 Markdown；
 * 第一行为「第N集《标题》」；不输出解释、报告、审计或代码围栏。
 * 本模块不写文件、不调用模型。
 */

import { firstNonEmptyLine, normalizeOutputText, stripOuterFence } from '../lib/refine-text.mjs'

export const PREFLIGHT2_CORRECT_PROMPT_VERSION = 't2.1'
export const CORRECTION_MAX_TOKENS = 8192
export const CORRECTION_TEMPERATURE = 0.2

const SCENE_LINE_RE = /^(\d+)\s*[-－]\s*(\d+)\s+\S/
const DIALOGUE_LINE_RE = /^([^：:（(]{1,40})[（(][^）)]*[）)]\s*[：:]\s*(.+)$/
const TITLE_RE = /^第\s*(\d+)\s*集/

const CORRECTION_SYSTEM = `你是「单集修复优化工人」（2.0 前置 correction）。依据任务中列出的质检问题，修复本集已确认的问题，并把本集整理成标准格式，一次输出完整的最终存档稿。你不做分镜计划、不写镜头块、不做导演级富化；没有工具，全部输入已随消息注入。

唯一允许的修改范围（只修任务列出的问题，最小改动）：
1. must_fix：按报告建议修复姓名、台词归属、身份、关系、称呼、知情范围、出入场状态、受伤/离开/死亡状态、数字与前后冲突；必须采用建议，不得自由发挥。
2. suspected：能依据本集与前文事实确认方向的，按最小改动修复；无法确认方向的保留原文（在输出正文中不改），不得猜改。
3. scene_unify：只统一本集已有的场景名，不新增场景设计、不改变场次顺序。
4. culture_issues / culture_notes（severity=must_fix 或 suspected 且 fixable=true）：按建议改为文化中性写法（如「分菜/放进碟中/收回手」，不命名新器物）；severity=info 只报告不改；fixable=false 的台词/锁行不得修改。不得用另一种文化符号替换原符号；不得新增 SOURCE 未建立的文化元素、器物、礼仪、服饰、称谓、节庆。
5. 结构/格式问题：把结构单元拆成独立段落、纠正明显行类型归类、统一全角/半角空格与引号冒号等纯格式差异；给明确属于场景/动作/环境的裸描述补「△」行首。不得拆合段、不得调序、不得增删内容。

硬锁（违反任一即失败）：
- 台词/旁白/VO/OS 的文字与标点逐字保留；说话人、括号标签、台词顺序、中英相邻关系不变；不得增删、拆分、合并、调序任何台词行。
- 集标题行、英文集标题行、场次行、人物/出场行、【…】结构块、音效标签逐字保留（仅允许纯格式统一）。
- 不得把场景描述或 △ 改写成台词/VO；不得为无标签台词补标签。
- 不得新增/删除剧情事实、人物、关系结论、能力、伤势、道具功能；不得改写未被问题点名的内容。
- 不得为「丰富动作」新增事件或改变动作顺序/参与者/结果；只允许对 SOURCE 已有动作/神态做具体化与衔接补足。
- 不得输出解释、审查意见、修改说明、Markdown 标题层级、表格或代码围栏；文件必须是纯文本逐行段落。
- 第一行必须为「第N集《标题》」（保留原集号与标题文字，只做格式规范）。`

function pad2(n) {
  return String(n).padStart(2, '0')
}

function normalizeEp(ep) {
  const n = Number(ep)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`E_EP_INVALID: ${String(ep)}`)
  return n
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

/** 归一化问题清单：字符串 / 对象数组 / 分类对象均可。 */
export function normalizeCorrectionIssues(issues) {
  if (!issues) return []
  if (typeof issues === 'string') return issues.trim() ? [{ type: 'must_fix', severity: 'must_fix', detail: issues.trim() }] : []
  if (Array.isArray(issues)) {
    return issues
      .map((item, index) => {
        if (typeof item === 'string' && item.trim()) return { type: 'must_fix', severity: 'must_fix', detail: item.trim(), index }
        if (item && typeof item === 'object') return { index, ...item }
        return null
      })
      .filter(Boolean)
  }
  if (typeof issues === 'object') {
    const out = []
    for (const [key, value] of Object.entries(issues)) {
      if (Array.isArray(value)) {
        value.forEach((item) => {
          if (typeof item === 'string' && item.trim()) out.push({ type: key, severity: key, detail: item.trim() })
          else if (item && typeof item === 'object') out.push({ type: key, severity: item.severity || key, ...item })
        })
      } else if (typeof value === 'string' && value.trim()) {
        out.push({ type: key, severity: key, detail: value.trim() })
      }
    }
    return out
  }
  return []
}

/**
 * 构建 2.0 前置单集修复 prompt。
 * @returns {{system:string, messages:Array, maxTokens:number, temperature:number, reasoningEffort:'low'}}
 */
export function buildPreflightCorrectionPrompt({ ep, title, source, issues } = {}) {
  const epNumber = normalizeEp(ep)
  const titleText = textOr(title, `第${epNumber}集`)
  const sourceText = textOr(source, '')
  if (!sourceText) throw new Error(`E_SOURCE_REQUIRED: 第${epNumber} 集缺少 SOURCE`)
  const issueList = normalizeCorrectionIssues(issues)
  const issueBlock = issueList.length ? jsonBlock(issueList) : '（本集无列出问题：仅做格式标准化，不改内容；若无格式问题则原样输出完整集。）'
  const hasNoIssues = issueList.length === 0

  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            section('本集信息', `- 集号：EP${pad2(epNumber)}\n- 集标题：${titleText}\n- 问题数量：${issueList.length}`),
            section(`本集 SOURCE：第 ${epNumber} 集（唯一事实源，逐字；原样输出基础）`, sourceText.trim()),
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
            section('本集待处理问题（只允许修复这里列出的项）', issueBlock),
            section(
              '处理规则',
              [
                '- 逐条处理：must_fix 采用建议；suspected 能确认才最小修复，否则保留原文；culture 项按 fixable/severity 处理；结构项只做纯格式整理。',
                '- 台词/锁行/场次逐字不动；不改台词标签、说话人、顺序、中英相邻关系。',
                '- 只做最小改动；未被点名的内容一律不动。',
                hasNoIssues ? '- 本集无问题：除必要格式标准化外，保持原文逐字不变，输出完整集。' : '',
              ]
                .filter(Boolean)
                .join('\n'),
            ),
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
              `输出第 ${epNumber} 集（${titleText}）修复后的完整 Markdown 纯文本集稿：第一行为「第${epNumber}集《标题》」，随后逐行输出整集正文（保持原顺序）。不要只输出 diff/片段，不要输出解释或修改说明。`,
            ),
            section(
              '输出契约',
              [
                '- 只输出完整集正文（纯文本逐行段落），不输出任何前后说明、审查意见、Markdown 标题层级、表格或代码围栏。',
                '- 第一行必须为「第N集《标题》」；不得改集号与标题文字（仅允许格式统一）。',
                '- 台词行沿用「说话人（标签，表演提示）：台词」原格式；原文无标签不得补。',
                '- 场次行、人物行、△ 原子、音效标签保持原顺序与原文（仅允许纯格式统一）。',
                '- 不得新增剧情/人物/关系/能力/伤势/道具功能；不得新增 SOURCE 未建立的文化元素。',
              ].join('\n'),
            ),
          ].join('\n\n'),
        },
      ],
    },
  ]

  return {
    system: CORRECTION_SYSTEM,
    messages,
    maxTokens: CORRECTION_MAX_TOKENS,
    temperature: CORRECTION_TEMPERATURE,
    reasoningEffort: 'low',
  }
}

/**
 * 解析修复后的完整集 Markdown。
 * @param {string} text
 * @param {{ep?:number}} [options]
 * @returns {{ok:boolean, text:string, errors:string[]}}
 */
export function parseCorrectedEpisode(text, options = {}) {
  const errors = []
  const result = { ok: false, text: '', errors }
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

  const lines = normalized.split('\n')
  const titleLine = firstNonEmptyLine(normalized)
  const titleMatch = titleLine.match(TITLE_RE)
  if (!titleMatch) {
    errors.push('title_line_invalid')
  } else {
    const titleEp = Number(titleMatch[1])
    const expectedEp = options.ep !== undefined ? Number(options.ep) : null
    if (expectedEp !== null && titleEp !== expectedEp) errors.push(`ep_mismatch:${titleEp}/${expectedEp}`)
    if (!/《.+》/.test(titleLine)) errors.push('title_format_missing_booktitle')
  }

  const episodeTitles = lines.filter((line) => TITLE_RE.test(line.trim())).length
  if (episodeTitles > 1) errors.push(`multiple_episode_titles:${episodeTitles}`)

  const bodyLines = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(1)
  if (!bodyLines.length) errors.push('empty_body')
  const sceneLines = bodyLines.filter((line) => SCENE_LINE_RE.test(line))
  if (!sceneLines.length) errors.push('missing_scene_line')
  const dialogueLines = bodyLines.filter((line) => DIALOGUE_LINE_RE.test(line))
  if (!dialogueLines.length) errors.push('missing_dialogue_line')

  // 说明/报告/结构残留（修复稿只允许正文）
  if (lines.some((line) => /^#{1,6}\s/.test(line.trim()))) errors.push('markdown_heading')
  if (lines.some((line) => /^\|/.test(line.trim()))) errors.push('markdown_table')
  if (/修改说明|以下是修正|以下是修改|审查意见|修复说明|说明：/.test(normalized)) errors.push('explanation_residue')

  // 禁止把台词整段删空/只输出片段：至少保留原有场次数量级（无法核对源时只做宽松检查）
  if (bodyLines.length < 3) errors.push('body_too_short')

  result.ok = errors.length === 0
  return result
}

export default {
  PREFLIGHT2_CORRECT_PROMPT_VERSION,
  normalizeCorrectionIssues,
  buildPreflightCorrectionPrompt,
  parseCorrectedEpisode,
}
