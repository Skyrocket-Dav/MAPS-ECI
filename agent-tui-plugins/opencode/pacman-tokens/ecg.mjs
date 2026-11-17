// Pure rendering helpers; the OpenCode TUI owns the animation and data fetching.
// The trace is drawn in braille: each character is one sample, filled dot by dot from
// the bottom — BASELINE (a single resting dot, so the line is never fully blank even
// at zero traffic) to TOP (every dot lit, as busy as the recent peak). This uses all 8
// dots of a cell for one sample rather than splitting the cell into two half-resolution
// samples, which is the densest a single text cell can plot without leaving plain text.
export const BASELINE = 1
// Cumulative fill order: bottom row first, left dot before right, row by row upward.
const FILL_STEPS = [0x40, 0x80, 0x04, 0x20, 0x02, 0x10, 0x01, 0x08]
const CELL_BITS = FILL_STEPS.reduce((bits, step) => {
  bits.push((bits.at(-1) ?? 0) | step)
  return bits
}, [0])
export const TOP = FILL_STEPS.length

export function folderName(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function selectedModelRef(selected, sessionModel) {
  const model = selected ?? sessionModel
  const id = model?.modelID ?? model?.id
  return model?.providerID && id ? { providerID: model.providerID, id } : undefined
}

export function providerRoute(model, info) {
  if (!model) return undefined
  const via = model.providerID === "openrouter" ? "openrouter" :
    model.providerID === "opencode" ? "opencode" : "direct"
  // An OpenRouter model ID normally starts with its upstream provider.
  // Do not guess a vendor when it does not provide that prefix.
  const prefix = (info?.modelID ?? model.id).split("/")[0]
  const provider = via === "openrouter" ? (prefix !== model.id ? prefix : "unknown") : model.providerID
  return { via, provider }
}

// Connectivity is checked with a HEAD request against the host that serves the
// selected model. Any HTTP answer (even 401/404) proves the route works, so only
// a network error or the timeout counts as offline. Providers that run on this
// machine have no remote host to reach and report no probe at all.
const PROVIDER_PROBES = {
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com",
  google: "https://generativelanguage.googleapis.com",
  "google-vertex": "https://generativelanguage.googleapis.com",
  groq: "https://api.groq.com",
  mistral: "https://api.mistral.ai",
  openai: "https://api.openai.com",
  opencode: "https://opencode.ai",
  "opencode-go": "https://opencode.ai",
  openrouter: "https://openrouter.ai",
  xai: "https://api.x.ai",
}
// Without a known provider there is still an Internet connection to check.
const GENERIC_PROBE = "https://opencode.ai"
// Local runtimes keep working with the network unplugged.
const LOCAL_PROVIDERS = /^(ollama|lm-?studio|llama(?:\.?cpp)?|local|vllm|jan|kobold|sglang|text-generation-webui)/i

export function probeUrlFor(providerID) {
  if (typeof providerID === "string" && providerID && LOCAL_PROVIDERS.test(providerID)) return undefined
  return (providerID && PROVIDER_PROBES[providerID]) || GENERIC_PROBE
}

export function shortCount(count) {
  if (count >= 1_000_000) return `${Math.round(count / 1_000_000)}M`
  return count >= 1_000 ? `${Math.round(count / 1_000)}k` : String(count)
}

export function bar(percent, cells = 8) {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return "█".repeat(filled) + "░".repeat(cells - filled)
}

export function gauge(tokens, window, cells = 8) {
  if (!Number.isFinite(window) || window <= 0) return "CTX —"
  const left = Math.max(0, window - Math.max(0, tokens ?? 0))
  const percent = Math.round((left / window) * 100)
  return `CTX ${bar(percent, cells)} ${percent}% · ${shortCount(left)}/${shortCount(window)}`
}

// Console budgets are not prepaid API-key balances. Only show an active
// budget when OpenCode explicitly lists the selected provider and model.
export function budgetForModel(limits, model) {
  if (!model?.providerID || !model?.id) return undefined
  const applicable = []
  for (const budget of limits?.budgets ?? []) {
    if (!budget.picked || budget.coverage !== "models") continue
    const covered = budget.models?.find((entry) =>
      entry.providerID === model.providerID && entry.modelID === model.id)
    if (!covered || !Number.isFinite(budget.limit) || budget.limit <= 0) continue
    const spent = budget.per === "model" || budget.scope === "each" ? covered.spent : budget.spent
    if (!Number.isFinite(spent) || spent < 0) continue
    applicable.push({ left: Math.max(0, budget.limit - spent), limit: budget.limit })
  }
  return applicable.sort((a, b) => a.left - b.left)[0]
}

export function contextForModel(messages, selected, window) {
  if (!Number.isFinite(window) || window <= 0) return undefined
  const unknown = { used: undefined, window }
  if (!selected) return unknown
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.type !== "assistant" || !message.tokens) continue
    if (message.model?.providerID !== selected.providerID || message.model?.id !== selected.id) return unknown
    const tokens = message.tokens
    const used = (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) +
      (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
    return { used: used > 0 ? used : undefined, window }
  }
  return unknown
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

// DeepSeek reports a prepaid balance as a list of balance entries.
export function deepseekBalance(data) {
  const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : undefined
  const total = Number(info?.total_balance)
  if (!Number.isFinite(total)) return undefined
  const currency = typeof info.currency === "string" && info.currency ? info.currency : "USD"
  return { left: total, currency }
}

// OpenRouter marks a free model with a ":free" id suffix; OpenCode's own
// catalog also reports zero cost on every tier for a model offered free.
// Either signal alone is enough; an empty/missing cost list is not.
export function isFreeModel(id, cost) {
  if (typeof id === "string" && id.endsWith(":free")) return true
  if (!Array.isArray(cost) || cost.length === 0) return false
  return cost.every((tier) =>
    (tier?.input ?? 0) === 0 && (tier?.output ?? 0) === 0 &&
    (tier?.cache?.read ?? 0) === 0 && (tier?.cache?.write ?? 0) === 0)
}

// OpenCode Go's own docs (opencode.ai/v2/docs/console/go) define these as a
// 5-hour window (20% of the monthly allowance), a weekly one (50%) and the
// monthly allowance itself (100%) — each shown only if it is a number.
export function goLimits(go) {
  const entries = []
  if (Number.isFinite(go?.rolling?.percent)) entries.push({ label: "5H", used: go.rolling.percent })
  if (Number.isFinite(go?.weekly?.percent)) entries.push({ label: "WK", used: go.weekly.percent })
  if (Number.isFinite(go?.monthly?.percent)) entries.push({ label: "MO", used: go.monthly.percent })
  return entries
}

// ChatGPT's backend (not an OpenAI-documented API; reverse-engineered from the
// Codex CLI) reports a 5-hour primary window and a 7-day secondary window. A
// window is only labeled 5H/7D when its length matches what we expect — if the
// backend changes the window length, this quietly drops the segment instead of
// mislabeling it.
const FIVE_HOURS_SECONDS = 5 * 60 * 60
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60

// Each window carries both `reset_at` (epoch seconds) and a relative
// `reset_after_seconds`; prefer the absolute one and fall back to the relative
// field so an older payload still reports a moment. A value that already looks
// like milliseconds is kept as-is.
export function resetMoment(source, now = Date.now()) {
  if (Number.isFinite(source?.reset_at) && source.reset_at > 0) {
    return source.reset_at > 1e12 ? source.reset_at : source.reset_at * 1000
  }
  if (Number.isFinite(source?.reset_after_seconds) && source.reset_after_seconds >= 0) {
    return now + source.reset_after_seconds * 1000
  }
  return undefined
}

// Local clock time when the window reopens, e.g. "(11:29)". A reset more than a
// day away reads better as a coarse countdown ("(6d9h)"); a window that has
// already reset (the next poll has not landed yet) shows nothing rather than a
// time in the past. Parentheses avoid font-dependent arrow glyphs.
export function resetLabel(resetsAt, now = Date.now()) {
  if (!Number.isFinite(resetsAt)) return ""
  const delta = resetsAt - now
  if (delta <= 0) return ""
  const DAY_MS = 24 * 60 * 60 * 1000
  if (delta < DAY_MS) {
    const time = new Date(resetsAt)
    const hours = String(time.getHours()).padStart(2, "0")
    const minutes = String(time.getMinutes()).padStart(2, "0")
    return `(${hours}:${minutes})`
  }
  const days = Math.floor(delta / DAY_MS)
  const hours = Math.floor((delta % DAY_MS) / (60 * 60 * 1000))
  return hours ? `(${days}d${hours}h)` : `(${days}d)`
}

export function chatgptLimits(usage, now = Date.now()) {
  const rate = usage?.rate_limit
  const entries = []
  const window = (source, seconds, label) => {
    if (source?.limit_window_seconds !== seconds) return
    if (!Number.isFinite(source.used_percent)) return
    const entry = { label, used: source.used_percent }
    const resetsAt = resetMoment(source, now)
    if (resetsAt !== undefined) entry.resetsAt = resetsAt
    entries.push(entry)
  }
  window(rate?.primary_window, FIVE_HOURS_SECONDS, "5H")
  window(rate?.secondary_window, SEVEN_DAYS_SECONDS, "7D")
  return entries
}

/**
 * The trace drawn from `samples` (oldest first; only the most recent `width` are
 * used). Pure: the caller decides what the samples mean — here, how many tokens were
 * counted since the previous tick.
 */
export function trace(samples, width) {
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

function takeColumns(text, columns) {
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

// The box adds two columns of padding at each edge. Reserve summary and
// indicators first, then give every remaining column to the ECG.
export function layout({ width, folder = "", tokens, window, limits = [], balance, free: isFree = false, samples = [], offline = false, lit = true, now = Date.now() }) {
  const available = Math.max(0, Math.floor(width) - 4)
  const remaining = window > 0 ? Math.round(100 * Math.max(0, window - (tokens ?? 0)) / window) : undefined
  const summaries = window > 0
    ? tokens === undefined
      ? [`CTX ?/${shortCount(window)}`, "CTX ?", "?"]
      : [gauge(tokens, window), gauge(tokens, window, 4), `CTX ${remaining}%`, `${remaining}%`]
    : ["CTX —", "—"]
  const heart = available >= 12 ? (offline ? (lit ? " 💔" : " 🖤") : " 💚") : ""
  const separator = heart ? " │ " : ""
  const suffixWidth = displayWidth(heart + separator)
  const fits = (text) => available - suffixWidth - displayWidth(text) >= 8

  // `limits` is an ordered list of named rate-limit windows (OpenCode Go's
  // 5H/WK/MO, ChatGPT's 5H/7D, ...). Richest to narrowest: drop the last
  // one first, then the one before it, down to none. Consecutive duplicates
  // collapse when a narrower level has nothing left to drop. A window that
  // reports when it reopens keeps that next to its percentage.
  const segments = limits.map(({ label, used, resetsAt }) => {
    if (!Number.isFinite(used)) return ""
    const reset = resetLabel(resetsAt, now)
    return ` │ ${label} ${bar(100 - used)} ${Math.round(100 - used)}%${reset ? " " + reset : ""}`
  })
  const limitLevels = []
  for (let count = segments.length; count >= 0; count--) limitLevels.push(segments.slice(0, count).join(""))
  const levels = limitLevels.filter((level, index, all) => index === 0 || level !== all[index - 1])
  // A free model never touches the balance, regardless of what it reads —
  // say so instead of a dollar figure. A missing balance otherwise shows as
  // n/a; a zero balance shows as 0.00.
  const balanceText = isFree
    ? " │ BALANCE FREE"
    : balance && Number.isFinite(balance.left)
      ? ` │ BALANCE $${balance.left.toFixed(2)}` : " │ BALANCE n/a"

  // Keep the balance visible before keeping the full context bar: compact the
  // gauge and drop rate-limit windows, richest first, before dropping the balance.
  const preferred = levels.map((level) => balanceText + level)
  const fallback = levels
  const candidate = (extras) => summaries.flatMap((summary) => extras.map((extra) => summary + extra)).find(fits)
  const withExtras = candidate(preferred) ?? candidate(fallback)
    ?? takeColumns(balanceText, available - suffixWidth)
    ?? takeColumns(summaries.at(-1), available - suffixWidth)

  let free = available - suffixWidth - displayWidth(withExtras)
  const offlineText = offline ? (free >= 8 ? (lit ? "OFFLINE " : "offline ") : free >= 4 ? "OFF " : "") : ""
  free -= displayWidth(offlineText)

  const folderBudget = Math.min(24, free - 8)
  const label = folder && folderBudget >= 7 ? `📁 ${takeColumns(folder, folderBudget - 6)} │ ` : ""
  free -= displayWidth(label)

  const count = Math.max(0, free)
  const signal = offline ? offlineText + "⠤".repeat(count) : trace(samples, count)
  const text = label + signal + heart + separator + withExtras
  return { label, signal, heart, separator, summary: withExtras, text }
}
