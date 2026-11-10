/**
 * Pricing + cost accounting for the Lianben stages.
 *
 * DeepSeek `deepseek-flash` list prices (CNY per 1M tokens), split into peak
 * and idle windows. Official schedule (Beijing time):
 * - Peak: Monday–Friday, 09:00–12:00 and 14:00–18:00, excluding Chinese
 *   statutory holidays.
 * - Idle: all other times, including weekends and Chinese statutory holidays.
 * - Idle price is half the peak price.
 *
 * China has no DST. The Host treats the completion time of one model call as
 * the billing instant and records the tariff used for that call.
 *
 * Pure functions only so they can be unit-tested without a DSH runtime.
 */

export const PRICING = Object.freeze({
  model: 'deepseek-flash',
  currency: 'CNY',
  unit: 1_000_000,
  timeZone: 'Asia/Shanghai',
  peakWindows: Object.freeze([
    Object.freeze({ startMinutes: 9 * 60, endMinutes: 12 * 60 }),
    Object.freeze({ startMinutes: 14 * 60, endMinutes: 18 * 60 }),
  ]),
  scheduleLabel: '北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰时段；周末及中国法定节假日全天为空闲时段',
  // Chinese statutory holidays. Update yearly from the State Council notice.
  // The 2026 list is from 国办发明电〔2025〕7号 (2025-11-04).
  holidays: Object.freeze([
    // 2025
    '2025-01-01',
    ...dateRange('2025-01-28', '2025-02-04'),
    ...dateRange('2025-04-04', '2025-04-06'),
    ...dateRange('2025-05-01', '2025-05-05'),
    ...dateRange('2025-05-31', '2025-06-02'),
    ...dateRange('2025-10-01', '2025-10-08'),
    // 2026
    ...dateRange('2026-01-01', '2026-01-03'),
    ...dateRange('2026-02-15', '2026-02-23'),
    ...dateRange('2026-04-04', '2026-04-06'),
    ...dateRange('2026-05-01', '2026-05-05'),
    ...dateRange('2026-06-19', '2026-06-21'),
    ...dateRange('2026-09-25', '2026-09-27'),
    ...dateRange('2026-10-01', '2026-10-07'),
  ]),
  rates: Object.freeze({
    peak: Object.freeze({ inputMiss: 2, inputHit: 0.04, output: 8 }),
    idle: Object.freeze({ inputMiss: 1, inputHit: 0.02, output: 4 }),
  }),
})

function dateRange(start, end) {
  const out = []
  const cursor = new Date(`${start}T00:00:00Z`)
  const last = new Date(`${end}T00:00:00Z`)
  while (cursor.getTime() <= last.getTime()) {
    out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

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
  const weekday = shifted.getUTCDay() // 0 Sunday ... 6 Saturday
  return {
    hour,
    minute,
    second,
    weekday,
    minutes: hour * 60 + minute + second / 60,
    clock: `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
    date: `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`,
    beijingTime: `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
  }
}

export function isChinaHoliday(date = new Date()) {
  return PRICING.holidays.includes(beijingClock(date).date)
}

/**
 * Peak only on weekdays whose Beijing time falls in 09:00–12:00 or
 * 14:00–18:00, excluding Chinese statutory holidays. Everything else is idle.
 */
export function tariffAt(date = new Date()) {
  const clock = beijingClock(date)
  if (clock.weekday === 0 || clock.weekday === 6) return 'idle'
  if (PRICING.holidays.includes(clock.date)) return 'idle'
  const inPeak = PRICING.peakWindows.some(
    (window) => clock.minutes >= window.startMinutes && clock.minutes < window.endMinutes,
  )
  return inPeak ? 'peak' : 'idle'
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
    timeZone: PRICING.timeZone,
    rates: {
      peak: { ...PRICING.rates.peak },
      idle: { ...PRICING.rates.idle },
    },
    peakWindows: PRICING.peakWindows.map((window) => ({ ...window })),
    holidays: PRICING.holidays.slice(),
    scheduleLabel: PRICING.scheduleLabel,
    current: {
      tariff,
      label: tariffLabel(tariff),
      at: new Date(date).toISOString(),
      clock: clock.clock,
      date: clock.date,
      weekday: clock.weekday,
      holiday: PRICING.holidays.includes(clock.date),
      beijingTime: clock.beijingTime,
    },
  }
}
