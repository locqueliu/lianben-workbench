/**
 * refine-token.mjs — prompt 字符/token 估算（与 docs/00 §1.2、docs/13 §6.1 同口径）。
 *
 * 口径：中文 ≈0.9 token/字；英文/ASCII ≈1 token/4 字符（0.25）；其它≈0.6；空白≈0.05。
 * 仅用于预算护栏与 A/B 对照，最终以 `usage.inputTokens` 实测校准。
 */

const CJK_RANGES = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
]

function isCjk(code) {
  return CJK_RANGES.some(([lo, hi]) => code >= lo && code <= hi)
}

/** 统计文本的字符构成（按 Unicode 码点计）。 */
export function textStats(text) {
  const source = String(text ?? '')
  let cjk = 0
  let ascii = 0
  let spaces = 0
  let other = 0
  for (const ch of source) {
    const code = ch.codePointAt(0)
    if (isCjk(code)) cjk += 1
    else if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) spaces += 1
    else if (code < 0x80) ascii += 1
    else other += 1
  }
  return { chars: cjk + ascii + spaces + other, cjk, ascii, spaces, other }
}

/** 估一段文本的 token 数（向上取整，至少 1）。 */
export function estimateTokens(text) {
  const { cjk, ascii, spaces, other } = textStats(text)
  const raw = cjk * 0.9 + ascii * 0.25 + other * 0.6 + spaces * 0.05
  return Math.max(1, Math.ceil(raw))
}

function messageTexts(messages) {
  if (!Array.isArray(messages)) return []
  const out = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const content = message.content
    if (typeof content === 'string') {
      out.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
        out.push(part.text)
      } else if (typeof part === 'string') {
        out.push(part)
      }
    }
  }
  return out
}

/**
 * 估一个 prompt 的 token 数。
 * @param {string | {system?: string, messages?: unknown[]}} prompt 允许直接传字符串或 buildDirectorPrompt 的返回值
 * @returns {number}
 */
export function estimatePromptTokens(prompt) {
  if (typeof prompt === 'string') return estimateTokens(prompt)
  if (!prompt || typeof prompt !== 'object') return 1
  const system = typeof prompt.system === 'string' ? prompt.system : ''
  const parts = [system, ...messageTexts(prompt.messages)]
  return estimatePromptTokens(parts.join('\n'))
}

/** 估一个 prompt 的字符构成（调试/报告用）。 */
export function estimatePromptStats(prompt) {
  if (typeof prompt === 'string') return textStats(prompt)
  const system = prompt && typeof prompt.system === 'string' ? prompt.system : ''
  const messages = prompt && prompt.messages
  const text = [system, ...messageTexts(messages)].join('\n')
  return textStats(text)
}
