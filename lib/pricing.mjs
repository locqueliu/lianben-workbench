/**
 * Pricing + cost accounting for the Lianben refine stage.
 *
 * List prices are for DeepSeek `deepseek-flash` (CNY per 1M tokens), split into
 * peak and idle windows. The idle window is Beijing time 00:30–08:30; every
 * other minute is peak. The Host treats the *completion time* of one model call
 * as the billing instant and records the tariff used for that call.
 *
 * Pure functions only so they can be unit-tested without a DSH runtime.
 */

export const PRICING = Object.freeze({
  model: 'deepseek-flash',
  currency: 'CNY',
  unit: 1_000_000,
  idleWindow: Object.freeze({
    timeZone: 'Asia/Shanghai',
    startMinutes: 30,
    endMinutes: 510,
    label: '00:30–08:30',
  }),
  rates: Object.freeze({
    peak: Object.freeze({ inputMiss: 2, inputHit: 0.04, output: 8 }),
    idle: Object.freeze({ inputMiss: 1, inputHit: 0.02, output: 4 }),
  }),
})

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * Beijing wall-clock fields for an instant. China has no DST, so a fixed +8h
 * shift is exact.
 */
export function beijingClock(date = new Date()) {
  const shifted = new Date(new Date(date).getTime() + BEIJING_OFFSET_MS)
  const hour = shifted.getUTCHours()
  const minute = shifted.getUTCMinutes()
  const second = shifted.getUTCSeconds()
  return {
    hour,
    minute,
    second,
    minutes: hour * 60 + minute + second / 60,
    clock: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
    date: `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`,
    beijingTime: `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
  }
}

/** `idle` inside 00:30–08:30 Beijing time, `peak` otherwise. */
export function tariffAt(date = new Date()) {
  const { minutes } = beijingClock(date)
  return minutes >= PRICING.idleWindow.startMinutes && minutes < PRICING.idleWindow.endMinutes ? 'idle' : 'peak'
}

export function tariffLabel(tariff) {
  return tariff === 'idle' ? '空闲时段' : '高峰时段'
}

export function roundCost(value) {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 1_000_000) / 1_000_000
}

/**
 * Cost of one model call.
 *
 * `usage` follows the DSH llm usage shape: inputTokens are cache-miss input,
 * cacheReadTokens are cache-hit input, cacheWriteTokens (if any) are billed as
 * cache-miss input, outputTokens are output.
 */
export function costForUsage(usage = {}, date = new Date(), tariffOverride = null) {
  const tariff = tariffOverride || tariffAt(date)
  const rates = PRICING.rates[tariff] || PRICING.rates.peak
  const inputTokens = Number(usage.inputTokens) || 0
  const cacheReadTokens = Number(usage.cacheReadTokens) || 0
  const cacheWriteTokens = Number(usage.cacheWriteTokens) || 0
  const outputTokens = Number(usage.outputTokens) || 0
  const input = roundCost(((inputTokens + cacheWriteTokens) * rates.inputMiss) / PRICING.unit)
  const cacheRead = roundCost((cacheReadTokens * rates.inputHit) / PRICING.unit)
  const output = roundCost((outputTokens * rates.output) / PRICING.unit)
  return {
    currency: PRICING.currency,
    unit: PRICING.unit,
    model: PRICING.model,
    tariff,
    at: new Date(date).toISOString(),
    rates: { ...rates },
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    input,
    cacheRead,
    output,
    total: roundCost(input + cacheRead + output),
  }
}

export function emptyCost() {
  return {
    currency: PRICING.currency,
    unit: PRICING.unit,
    total: 0,
    input: 0,
    cacheRead: 0,
    output: 0,
    calls: 0,
  }
}

/** Accumulate one call cost into a running total (mutates and returns target). */
export function addCost(target, call) {
  if (!target || typeof target !== 'object') return target
  if (!call || typeof call !== 'object') return target
  for (const key of ['input', 'cacheRead', 'output', 'total']) {
    if (Number.isFinite(Number(call[key]))) target[key] = roundCost((Number(target[key]) || 0) + Number(call[key]))
  }
  target.calls = (Number(target.calls) || 0) + 1
  target.currency = PRICING.currency
  target.unit = PRICING.unit
  return target
}

/** Cost of an aggregate token ledger (used to backfill pre-cost runs). */
export function costForTokenLedger(tokens = {}, date = new Date(), tariffOverride = null) {
  return costForUsage(
    {
      inputTokens: tokens.inputTokens,
      cacheReadTokens: tokens.cacheReadTokens,
      cacheWriteTokens: tokens.cacheWriteTokens,
      outputTokens: tokens.outputTokens,
    },
    date,
    tariffOverride,
  )
}

/** Rates + the tariff that would apply right now. Safe to expose to the page. */
export function pricingSnapshot(date = new Date()) {
  const clock = beijingClock(date)
  const tariff = tariffAt(date)
  return {
    model: PRICING.model,
    currency: PRICING.currency,
    unit: PRICING.unit,
    rates: {
      peak: { ...PRICING.rates.peak },
      idle: { ...PRICING.rates.idle },
    },
    idleWindow: { ...PRICING.idleWindow },
    current: {
      tariff,
      label: tariffLabel(tariff),
      at: new Date(date).toISOString(),
      clock: clock.clock,
      beijingTime: clock.beijingTime,
    },
  }
}
