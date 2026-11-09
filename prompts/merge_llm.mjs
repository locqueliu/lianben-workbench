/**
 * Prompt builder/parser for the optional LLM-optimized atom merge (M6.1).
 * The model only produces replacement △ paragraphs for explicitly selected
 * preflight merge targets; it never rewrites dialogue, scene headers, locks or
 * non-target lines (the Host replaces only target ranges).
 */

export function buildMergeLlmPrompt({ ep, title, targets, context = '' }) {
  const targetText = (Array.isArray(targets) ? targets : [])
    .map((target, index) => {
      const lines = Array.isArray(target.lines) ? target.lines : []
      return [
        `【目标块 ${index}】连续 ${lines.length} 条 △：`,
        ...lines.map((line, lineIndex) => `${lineIndex + 1}. ${line}`),
      ].join('\n')
    })
    .join('\n\n')
  const system = [
    '你是中文竖屏短剧剧本的格式优化器。你的任务只是把指定的连续 △ 动作段合并为 1~2 条完整 △ 动作段。',
    '硬性规则：',
    '1. 不能增加、删除、改变任何事实、人物、对象、方向、因果、数字、专有名词、英文台词或动作顺序。',
    '2. 不能新增台词、VO、OS、DIALOGUE，不能改台词标签，不能改场次/人物/【…】结构行。',
    '3. 只允许合并动作句、用「，」「；」等连接，必要时调整句子衔接；不得把动作改写成新情节。',
    '4. 输出 JSON，且只能是 JSON：{"runs":[{"id":0,"lines":["△……"]}]}。',
    '5. 每个目标块输出 1~2 条 lines；每条必须以 △ 开头；不得输出空行、解释、markdown 代码块。',
    '6. 不得输出任何未选中块，不得保留目标块之外的原文。',
  ].join('\n')
  const user = [
    `第${ep}集${title ? `《${title}》` : ''}。`,
    context ? `上下文（只读，不得改写）：\n${context}\n` : '',
    targetText,
    '请按规则输出 JSON。',
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 4096,
    temperature: 0.15,
  }
}

function extractJson(text) {
  const raw = String(text || '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const source = fenced ? fenced[1].trim() : raw
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(source.slice(start, end + 1))
  } catch {
    return null
  }
}

export function parseMergeLlmOutput(text, expectedTargets) {
  const parsed = extractJson(text)
  const errors = []
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, runs: [], errors: ['output is not a JSON object'] }
  }
  const runs = Array.isArray(parsed.runs) ? parsed.runs : []
  const expected = Array.isArray(expectedTargets) ? expectedTargets : []
  if (runs.length !== expected.length) errors.push(`expected ${expected.length} runs, got ${runs.length}`)
  const byId = new Map()
  for (const run of runs) {
    if (!run || typeof run !== 'object') {
      errors.push('run is not an object')
      continue
    }
    const id = Number(run.id)
    if (!Number.isInteger(id) || id < 0 || id >= expected.length) {
      errors.push(`invalid run id ${String(run.id)}`)
      continue
    }
    if (byId.has(id)) {
      errors.push(`duplicate run id ${id}`)
      continue
    }
    const lines = Array.isArray(run.lines) ? run.lines.map((line) => String(line == null ? '' : line).trim()).filter(Boolean) : []
    if (lines.length < 1) {
      errors.push(`run ${id} has no lines`)
      continue
    }
    const originalLength = Number(expected[id].length) || 0
    if (lines.length > Math.max(1, originalLength - 1)) errors.push(`run ${id} has too many lines (${lines.length})`)
    if (lines.some((line) => !line.startsWith('△'))) errors.push(`run ${id} has a line not starting with △`)
    if (lines.some((line) => /(?:对白|DIALOGUE|VO|OS)/i.test(line))) errors.push(`run ${id} appears to contain dialogue`)
    byId.set(id, lines)
  }
  for (let id = 0; id < expected.length; id += 1) {
    if (!byId.has(id)) errors.push(`missing run ${id}`)
  }
  const ordered = expected.map((_, id) => ({ id, lines: byId.get(id) || [] }))
  return { ok: errors.length === 0, runs: ordered, errors }
}
