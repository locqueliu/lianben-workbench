/**
 * refine-text.mjs — 炼本输出契约的文本工具：哨兵切段、围栏/尾逗号容错、JSON 宽松解析。
 *
 * 与 docs/13 §4.1/§4.2 对应：
 * - 只容忍：去围栏、去 BOM/零宽字符、trim、删除尾随逗号；
 * - 不容忍：截断补全、注释剥离、单引号替换、字段猜测。
 */

/** director 输出契约的 5 个哨兵（顺序即契约顺序）。 */
export const DIRECTOR_SENTINELS = Object.freeze({
  shotPlan: '===SHOT_PLAN_JSON===',
  draft: '===DRAFT_MD===',
  notes: '===PRODUCTION_NOTES_MD===',
  report: '===REPORT_JSON===',
  status: '===STATUS===',
})

export const DIRECTOR_SENTINEL_ORDER = Object.freeze([
  'shotPlan',
  'draft',
  'notes',
  'report',
  'status',
])

const SENTINEL_LINE_RE = /^===([A-Z][A-Z0-9_]*)===\s*$/
const FENCE_LINE_RE = /^```[A-Za-z0-9_-]*\s*$/

/** 去 BOM、零宽字符，CRLF→LF。 */
export function normalizeOutputText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
}

/** 整段被 ``` / ```lang 包裹时剥离首尾围栏行；否则原样返回。 */
export function stripOuterFence(text) {
  const lines = String(text ?? '').split('\n')
  let start = 0
  let end = lines.length - 1
  while (start <= end && lines[start].trim() === '') start += 1
  while (end >= start && lines[end].trim() === '') end -= 1
  if (start > end) return ''
  if (FENCE_LINE_RE.test(lines[start].trim()) && FENCE_LINE_RE.test(lines[end].trim()) && start !== end) {
    return lines.slice(start + 1, end).join('\n').replace(/^\n+|\n+$/g, '')
  }
  return lines.slice(start, end + 1).join('\n')
}

/**
 * 宽松 JSON 解析：只允许去围栏、去 BOM/零宽、trim、删除 `}`/`]` 前的尾随逗号。
 * @returns {{ok: true, value: any, repaired: boolean} | {ok: false, error: string}}
 */
export function parseJsonLoose(text) {
  let source = normalizeOutputText(text).trim()
  if (!source) return { ok: false, error: 'empty_json' }
  let repaired = false
  if (FENCE_LINE_RE.test(source.split('\n')[0].trim())) {
    source = stripOuterFence(source).trim()
    repaired = true
  }
  const withoutTrailingCommas = source.replace(/,\s*([}\]])/g, '$1')
  if (withoutTrailingCommas !== source) {
    source = withoutTrailingCommas
    repaired = true
  }
  try {
    return { ok: true, value: JSON.parse(source), repaired }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) }
  }
}

/**
 * 按哨兵行切段。
 * @returns {{sections: Map<string,string>, order: string[], preamble: string, errors: string[]}}
 */
export function splitSentinelSections(text) {
  const normalized = normalizeOutputText(text)
  const lines = normalized.split('\n')
  const sections = new Map()
  const order = []
  const errors = []
  const preambleLines = []
  let current = null
  let currentLines = []

  const flush = () => {
    if (!current) return
    sections.set(current, stripOuterFence(currentLines.join('\n')).trim())
  }

  for (const line of lines) {
    const match = line.trim().match(SENTINEL_LINE_RE)
    if (match) {
      flush()
      current = match[1]
      currentLines = []
      if (sections.has(current)) {
        errors.push(`duplicate_segment:${current}`)
        current = null
        continue
      }
      order.push(current)
      continue
    }
    if (current === null) preambleLines.push(line)
    else currentLines.push(line)
  }
  flush()

  const preamble = preambleLines.join('\n').trim()
  if (preamble) errors.push('text_before_first_sentinel')
  return { sections, order, preamble, errors }
}

/** 规范化单行：去首尾空白、连续空白压成单空格（不用于成品正文）。 */
export function normalizeLine(line) {
  return String(line ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 正文首个非空行（用于校验集标题行）。 */
export function firstNonEmptyLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/** CJK 字符数（与 check_ep 的 cjk_count 同口径：\u4e00-\u9fff）。 */
export function countCjk(text) {
  let n = 0
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0)
    if (code >= 0x4e00 && code <= 0x9fff) n += 1
  }
  return n
}

/** 首行是否像「第N集《标题》」/「第N集」。 */
export function looksLikeEpisodeHeader(line) {
  return /^第\s*\d+\s*集/.test(normalizeLine(line))
}

/** 从状态段文本中提取一行状态行（取首个非空行）。 */
export function extractStatusLine(text) {
  const section = String(text ?? '').trim()
  if (!section) return ''
  const lines = section.split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.length ? lines[0] : ''
}
