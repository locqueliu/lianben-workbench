/**
 * Deterministic △ merge helper (no LLM, no content rewriting).
 *
 * Input: episode source markdown and merge targets from preflight atom_pacing
 *        (`{start,length}` indexes into the non-empty normalized body lines).
 * Output: new markdown where each target run of consecutive △ paragraphs is
 *         replaced by exactly one △ paragraph. Every non-△ line is byte-identical
 *         and every character of the original △ bodies is preserved (only the
 *         repeated leading △ markers are removed and, when needed, a Chinese
 *         semicolon is inserted between clauses).
 *
 * This is intentionally NOT an optimizer: it never rewrites facts, dialogue,
 * scene headers or action wording. It is used only after an explicit user
 * confirmation from the preflight tab.
 */

export function normalizeForBody(raw) {
  let text = String(raw == null ? '' : raw).replace(/\ufeff/g, '')
  text = text.replace(/\u3000/g, ' ')
  text = text.replace(/\u201c/g, '"').replace(/\u201d/g, '"')
  text = text.replace(/\u2018/g, "'").replace(/\u2019/g, "'")
  return text.replace(/\s+/g, ' ').trim()
}

export function bodyEntries(sourceText) {
  const lines = String(sourceText == null ? '' : sourceText).split(/\r?\n/)
  const entries = []
  lines.forEach((raw, index) => {
    const body = normalizeForBody(raw)
    if (body) entries.push({ index, raw, body })
  })
  return entries
}

function needsSeparator(text) {
  return !/[。！？!?；;，,、…]$/.test(text)
}

/** Merge a single target's original body lines into one complete △ paragraph. */
export function mergeAtomBodies(bodies) {
  const content = bodies
    .map((body) => String(body).replace(/^△\s*/, '').trim())
    .filter((body) => body.length > 0)
  if (content.length === 0) throw new Error('atom run has no content')
  let merged = content[0]
  for (const part of content.slice(1)) {
    if (needsSeparator(merged)) merged += '；'
    merged += part
  }
  return `△${merged}`
}

/**
 * Build a merge plan without writing anything.
 * @param {string} sourceText
 * @param {Array<{start:number,length:number}>} targets
 * @returns {{ok:boolean, text:string, beforeAtoms:number, afterAtoms:number,
 *            removed:number, targets:Array, errors:string[]}}
 */
export function buildMergePlan(sourceText, targets) {
  const errors = []
  const entries = bodyEntries(sourceText)
  const beforeAtoms = entries.filter((entry) => entry.body.startsWith('△')).length
  const rawLines = String(sourceText == null ? '' : sourceText).split(/\r?\n/)
  const rawTargets = []
  if (!Array.isArray(targets)) {
    return { ok: false, text: sourceText, beforeAtoms, afterAtoms: beforeAtoms, removed: 0, targets: [], errors: ['targets must be an array'] }
  }

  const sorted = targets.slice()
  sorted.sort((left, right) => Number(left && left.start) - Number(right && right.start))
  let lastEnd = -1
  for (const target of sorted) {
    if (!target || typeof target !== 'object') {
      errors.push(`invalid target ${JSON.stringify(target)}`)
      continue
    }
    const start = Number(target.start)
    const length = Number(target.length)
    if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 2) {
      errors.push(`invalid target ${JSON.stringify(target)}`)
      continue
    }
    if (start < lastEnd) {
      errors.push(`overlapping target at ${start}`)
      continue
    }
    if (start + length > entries.length) {
      errors.push(`target ${start}+${length} out of range (${entries.length})`)
      continue
    }
    // The preflight check historically could include plain non-△ lines
    // (e.g. an English translation line without a speaker tag) inside a
    // merge_target, because its run detector only broke on dialogue/scene
    // lines. Clip each legacy target to its actual consecutive △ sub-runs so
    // existing projects can merge safely without re-running preflight.
    const range = entries.slice(start, start + length)
    let subStart = null
    const subRuns = []
    for (let offset = 0; offset <= range.length; offset += 1) {
      const isAtom = offset < range.length && range[offset].body.startsWith('△')
      if (isAtom && subStart === null) subStart = offset
      if (!isAtom && subStart !== null) {
        if (offset - subStart >= 2) subRuns.push({ offset: subStart, length: offset - subStart })
        subStart = null
      }
    }
    for (const subRun of subRuns) {
      const bodyLines = range.slice(subRun.offset, subRun.offset + subRun.length)
      const mergedLine = mergeAtomBodies(bodyLines.map((entry) => entry.raw.trim()))
      const rawStart = bodyLines[0].index
      const rawEnd = bodyLines[bodyLines.length - 1].index
      rawTargets.push({
        start: start + subRun.offset,
        length: subRun.length,
        rawStart,
        rawEnd,
        before: bodyLines.map((entry) => entry.raw.trim()),
        merged: mergedLine,
        preview: mergedLine.length > 160 ? `${mergedLine.slice(0, 160)}…` : mergedLine,
      })
    }
    lastEnd = start + length
  }

  if (errors.length === 0 && rawTargets.length === 0) {
    errors.push('targets contain no mergeable consecutive △ run (target range contains non-△ lines)')
  }
  if (errors.length > 0) {
    return { ok: false, text: sourceText, beforeAtoms, afterAtoms: beforeAtoms, removed: 0, targets: rawTargets, errors }
  }

  const mergedLines = rawLines.slice()
  for (const target of rawTargets.slice().sort((left, right) => right.rawStart - left.rawStart)) {
    mergedLines.splice(target.rawStart, target.rawEnd - target.rawStart + 1, target.merged)
  }
  const text = mergedLines.join('\n')
  const afterEntries = bodyEntries(text)
  const afterAtoms = afterEntries.filter((entry) => entry.body.startsWith('△')).length

  // Hard invariant: every non-△ line stays exactly the same, in the same order.
  const beforeNonAtoms = entries.filter((entry) => !entry.body.startsWith('△')).map((entry) => entry.body)
  const afterNonAtoms = afterEntries.filter((entry) => !entry.body.startsWith('△')).map((entry) => entry.body)
  if (beforeNonAtoms.length !== afterNonAtoms.length || beforeNonAtoms.some((line, index) => line !== afterNonAtoms[index])) {
    errors.push('non-△ lines changed')
  }
  const expectedRemoved = rawTargets.reduce((sum, target) => sum + target.length - 1, 0)
  if (beforeAtoms - afterAtoms !== expectedRemoved) {
    errors.push(`atom count delta mismatch: ${beforeAtoms}->${afterAtoms}, expected -${expectedRemoved}`)
  }
  for (const target of rawTargets) {
    const mergedBody = normalizeForBody(target.merged)
    if (!mergedBody.startsWith('△')) errors.push('merged line does not start with △')
    const originalChars = target.before.map((line) => line.replace(/^△\s*/, '').trim()).join('')
    const rawMergedContent = target.merged.replace(/^△\s*/, '').trim()
    const stripSeparators = (value) => value.replace(/[；;]/g, '')
    if (stripSeparators(originalChars) !== stripSeparators(rawMergedContent)) errors.push(`target ${target.start} content was not preserved verbatim`)
  }

  return {
    ok: errors.length === 0,
    text,
    beforeAtoms,
    afterAtoms,
    removed: beforeAtoms - afterAtoms,
    targets: rawTargets,
    errors,
  }
}
