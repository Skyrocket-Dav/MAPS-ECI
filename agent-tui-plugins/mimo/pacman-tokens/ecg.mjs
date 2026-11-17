// Pure rendering helpers for the MiMoCode port; the TUI host owns animation and
// data access. The trace is braille: each character is one sample, filled dot by
// dot from the bottom — BASELINE (a single resting dot, so the line is never
// blank even at zero traffic) to TOP (every dot lit, as busy as the recent peak).
export const BASELINE = 1
// Cumulative fill order: bottom row first, left dot before right, row by row upward.
const FILL_STEPS = [0x40, 0x80, 0x04, 0x20, 0x02, 0x10, 0x01, 0x08]
const CELL_BITS = FILL_STEPS.reduce((bits, step) => {
  bits.push((bits.at(-1) ?? 0) | step)
  return bits
}, [0])
export const TOP = FILL_STEPS.length

export function folderName(path) {
  return String(path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? String(path ?? "")
}

export function shortCount(count) {
  if (count >= 1_000_000) return `${Math.round(count / 1_000_000)}M`
  return count >= 1_000 ? `${Math.round(count / 1_000)}k` : String(count)
}

export function bar(percent, cells = 8) {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return "▰".repeat(filled) + "▱".repeat(cells - filled)
}

export function gauge(tokens, window, cells = 8) {
  if (!Number.isFinite(window) || window <= 0) return "CTX —"
  const left = Math.max(0, window - Math.max(0, tokens ?? 0))
  const percent = Math.round((left / window) * 100)
  return `CTX ${bar(percent, cells)} ${percent}% · ${shortCount(left)}/${shortCount(window)}`
}

// MiMoCode resolves a model's prompt capacity the same way its compaction
// trigger does: `limit.input` when the provider publishes one, else
// `limit.context`. A context of 0 means the provider declared no window.
export function modelWindow(model) {
  const context = model?.limit?.context
  if (!Number.isFinite(context) || context === 0) return undefined
  const input = model?.limit?.input
  return Number.isFinite(input) && input > 0 ? input : context
}

// The last measured assistant turn, the same source MiMoCode's own context
// sidebar reads: the running context is that turn's full token record.
export function usageFrom(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== "assistant" || !message.tokens) continue
    if (!(message.tokens.output > 0)) continue
    const tokens = message.tokens
    const used =
      (tokens.input ?? 0) +
      (tokens.output ?? 0) +
      (tokens.reasoning ?? 0) +
      (tokens.cache?.read ?? 0) +
      (tokens.cache?.write ?? 0)
    return {
      used: used > 0 ? used : undefined,
      providerID: message.providerID,
      modelID: message.modelID,
    }
  }
  return undefined
}

// DeepSeek reports a prepaid balance as a documented list of currency entries
// (GET https://api.deepseek.com/user/balance). total_balance arrives as a
// string, and the currency is CNY or USD depending on the account.
export function deepseekBalance(data) {
  const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : undefined
  const total = Number(info?.total_balance)
  if (!Number.isFinite(total)) return undefined
  const currency = typeof info.currency === "string" && info.currency ? info.currency : "USD"
  return { left: total, currency }
}

// OpenRouter reports prepaid credits and lifetime usage. A capped key also
// reports what is left on that key, which is the stricter limit when present.
export function balanceFromCredits(credits, key) {
  const source = credits?.data ?? credits
  if (Number.isFinite(key?.limit_remaining)) return { left: key.limit_remaining, currency: "USD" }
  if (!source || !Number.isFinite(source.total_credits) || !Number.isFinite(source.total_usage)) return undefined
  const left = source.total_credits - source.total_usage
  return left >= 0 ? { left, currency: "USD" } : undefined
}

// Which provider the balance belongs to. A turn that already ran is exact; a
// configured `model` ("provider/model") applies before the first turn; the TUI's
// persisted selection covers a session the user just started.
export function providerFrom({ turn, configured, selected }) {
  if (typeof turn === "string" && turn) return turn
  if (typeof configured === "string" && configured.includes("/")) return configured.split("/")[0]
  if (typeof selected === "string" && selected) return selected
  return undefined
}

const CURRENCY_SYMBOLS = { USD: "$", CNY: "¥", EUR: "€" }

export function money(balance) {
  if (!balance || !Number.isFinite(balance.left)) return undefined
  const symbol = CURRENCY_SYMBOLS[balance.currency] ?? `${balance.currency} `
  return `${symbol}${balance.left.toFixed(2)}`
}

// A model MiMoCode serves with zero cost on every tier never spends money, so
// the bar says FREE instead of showing an unrelated account balance.
export function isFreeModel(cost) {
  if (!cost) return false
  const tiers = Array.isArray(cost) ? cost : [cost, cost.experimentalOver200K].filter(Boolean)
  if (!tiers.length) return false
  return tiers.every(
    (tier) =>
      (tier.input ?? 0) === 0 &&
      (tier.output ?? 0) === 0 &&
      (tier.cache?.read ?? 0) === 0 &&
      (tier.cache?.write ?? 0) === 0,
  )
}

// ChatGPT's backend (not a documented OpenAI API; the same endpoint the Codex
// CLI uses) reports a 5-hour primary window and a 7-day secondary window. A
// window is only labelled when its reported length matches what is expected, so
// a backend change drops the segment instead of mislabelling it. Values are
// turned into what is LEFT, which is what the bar shows.
const FIVE_HOURS_SECONDS = 5 * 60 * 60
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60

export function chatgptLimits(usage) {
  const rate = usage?.rate_limit
  const entries = []
  const window = (source, seconds, label) => {
    if (source?.limit_window_seconds !== seconds) return
    if (!Number.isFinite(source.used_percent)) return
    entries.push({ label, left: Math.max(0, Math.min(100, 100 - source.used_percent)) })
  }
  window(rate?.primary_window, FIVE_HOURS_SECONDS, "5H")
  window(rate?.secondary_window, SEVEN_DAYS_SECONDS, "7D")
  return entries
}

/**
 * The trace drawn from `samples` (oldest first; only the most recent `width` are
 * used). Pure: the caller decides what the samples mean — here, how many tokens
 * were counted since the previous tick.
 */export function trace(samples, width) {
  const count = Math.max(0, Math.floor(width))
  if (!count) return ""
  const tail = samples.slice(-count)
  const shown = Array(Math.max(0, count - tail.length)).fill(BASELINE).concat(tail)
  return shown
    .map((height) => String.fromCharCode(0x2800 + (CELL_BITS[Math.max(0, Math.min(TOP, Math.round(height)))] ?? 0)))
    .join("")
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function characterWidth(grapheme) {
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 2
  if (/^[\p{Mark}\p{Format}]+$/u.test(grapheme)) return 0
  if (/[\u1100-\u115f\u2329-\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(grapheme)) return 2
  return 1
}

export function displayWidth(text) {
  let width = 0
  for (const { segment } of segmenter.segment(text)) width += characterWidth(segment)
  return width
}

export function takeColumns(text, columns) {
  let result = ""
  let used = 0
  for (const { segment } of segmenter.segment(text)) {
    const width = characterWidth(segment)
    if (used + width > columns) break
    result += segment
    used += width
  }
  return result
}

// The summary is chosen richest-first and the trace takes whatever columns are
// left, so a narrow prompt row keeps the money readout and the percentage and
// loses the trace length rather than overflowing the line. Money and the
// shortest rate-limit window outrank context detail: a shrinking gauge is
// recovered on the next tick, a hidden balance is not.
export function layout({
  width,
  folder = "",
  tokens,
  window,
  balance,
  free: isFree = false,
  limits = [],
  samples = [],
}) {
  const available = Math.max(0, Math.floor(width))
  const remaining = window > 0 ? Math.round((100 * Math.max(0, window - (tokens ?? 0))) / window) : undefined
  const summaries =
    window > 0
      ? tokens === undefined
        ? [`CTX ?/${shortCount(window)}`, "CTX ?", "?"]
        : [gauge(tokens, window), gauge(tokens, window, 4), `CTX ${remaining}%`, `${remaining}%`]
      : ["CTX —", "—"]

  // A free model never touches the balance, whatever the account holds.
  const moneyText = isFree ? " FREE" : balance ? ` · ${balance}` : ""
  const windows = limits.filter((item) => Number.isFinite(item?.left))
  const segment = ({ label, left }, cells) => ` · ${label} ${bar(left, cells)} ${Math.round(left)}%`
  const segments = windows.map((item) => segment(item, 8))

  // Drop windows richest-first, collapsing consecutive duplicates so a narrow
  // bar keeps the 5-hour window and loses the week.
  const levels = []
  for (let count = segments.length; count >= 0; count--) levels.push(segments.slice(0, count).join(""))
  const unique = levels.filter((level, index) => index === 0 || level !== levels[index - 1])

  const extras = []
  if (moneyText) for (const level of unique) extras.push(`${moneyText}${level}`)
  for (const level of unique) extras.push(level)

  const fits = (text, margin = 10) => available - displayWidth(text) >= margin
  // Extras are the outer loop so an informative segment is kept even at the cost
  // of a plainer context readout; within one level, the richest summary wins.
  // An empty extra is the final fallback below, not a candidate here: otherwise a
  // plain summary would win before a bar narrow enough to carry only one window.
  const full = extras
    .filter((extra) => extra.trim() !== "")
    .flatMap((extra) => summaries.map((summary) => summary + extra))
    .find((text) => fits(text))
  // When even that fails, give up the trace columns rather than the readout: the
  // money and the first window are the two facts worth a bare bar.
  const firstWindow = windows.length ? segment(windows[0], 4) : ""
  const tightExtras = []
  if (moneyText) tightExtras.push(`${moneyText}${firstWindow}`, moneyText)
  if (firstWindow) tightExtras.push(firstWindow)
  const tight = tightExtras
    .flatMap((extra) => summaries.map((summary) => summary + extra))
    .find((text) => fits(text, 2))
  const summary = full ?? tight ?? summaries.find((text) => fits(text)) ?? ""

  const separator = summary ? " " : ""
  let free = available - displayWidth(summary) - displayWidth(separator)

  const folderBudget = Math.min(20, free - 10)
  const label = folder && folderBudget >= 7 ? `📁 ${takeColumns(folder, folderBudget - 3)} ` : ""
  free -= displayWidth(label)

  const signal = trace(samples, Math.max(0, free))
  return { label, signal, summary, text: label + signal + separator + summary }
}
