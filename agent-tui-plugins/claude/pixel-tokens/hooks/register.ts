import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, Timer } from 'claude-code'

import type { Gauge } from '../types'

const gauge = atom({ plugin: 'pixel-tokens', key: 'gauge' } as const, null)

const TICK_MS = 160

/**
 * How the line is laid out: trace length in braille cells, bar length, and which optional
 * parts show. Without a measured width it is the classic 22-cell trace with 8-cell bars.
 */
type Layout = { trace: number; cells: number; showFolder: boolean; showCounts: boolean }
const DEFAULT_LAYOUT: Layout = { trace: 22, cells: 8, showFolder: true, showCounts: true }
/** Richest first: on a narrow terminal parts drop off until the line fits. */
const VARIANTS: Omit<Layout, 'trace'>[] = [
  { cells: 10, showFolder: true, showCounts: true },
  { cells: 8, showFolder: true, showCounts: true },
  { cells: 8, showFolder: false, showCounts: true },
  { cells: 5, showFolder: false, showCounts: false },
  { cells: 0, showFolder: false, showCounts: false },
]
/** The trace never gets shorter than this (the offline flatline needs room) nor longer than that. */
const MIN_TRACE = 10
const MAX_TRACE = 90
/** Cells left free at the right edge, so the line never wraps. */
const MARGIN = 2

// The trace is drawn in braille: each character is one sample, filled dot by dot from
// the bottom — BASELINE (a single resting dot, so the line is never fully blank even
// at zero traffic) to TOP (every dot lit, as busy as the recent peak). This uses all 8
// dots of a cell for one sample rather than splitting the cell into two half-resolution
// samples, which is the densest a single text cell can plot without leaving plain text.
const BASELINE = 1
/** Cumulative fill order: bottom row first, left dot before right, row by row upward. */
const FILL_STEPS = [0x40, 0x80, 0x04, 0x20, 0x02, 0x10, 0x01, 0x08]
const CELL_BITS = FILL_STEPS.reduce<number[]>((bits, step) => {
  bits.push((bits.at(-1) ?? 0) | step)
  return bits
}, [0])
const TOP = FILL_STEPS.length

// The status line is plain text, so color comes from emoji.
const HEART_ONLINE = '💚'
const FOLDER = '📁'
const HEART_BROKEN = '💔'
const OFFLINE = '🔴 OFFLINE'
const RED_FULL = '🟥'
const RED_EMPTY = '⬛'
const OFFLINE_DIM = '⚫ OFFLINE'
const HEART_DIM = '🖤'
/** While offline the line blinks, flipping every few animation ticks. */
const BLINK_TICKS = 3

/** How often the connection is checked, and how long one check may take. */
const PROBE_EVERY_MS = 15_000
const PROBE_TIMEOUT_MS = 5_000
/** Any HTTP answer from here, even an error status, means the network reaches the API. */
const PROBE_URL = 'https://api.anthropic.com'

function toGauge(context: SessionContextUsage, rateLimits: SessionRateLimit[]): Gauge {
  const fiveHour = rateLimits.find(r => r.kind === 'five_hour')
  const weekly = rateLimits.find(r => r.kind === 'seven_day')

  return {
    tokens: context.tokens,
    window: context.window,
    fiveHour: fiveHour?.percentUsed,
    weekly: weekly?.percentUsed,
    fiveHourResetsAt: resetMoment(fiveHour),
    weeklyResetsAt: resetMoment(weekly),
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When a rate-limit window reopens. Current builds report `resetsAt` in epoch
 * seconds; the other spellings (and a relative seconds field) are accepted
 * defensively, so a renamed field costs the timestamp rather than the bar. A
 * value that already looks like milliseconds is kept as-is.
 */
export function resetMoment(limit: SessionRateLimit | undefined, now = Date.now()): number | undefined {
  if (!limit) return undefined
  const raw = limit as unknown as Record<string, unknown>
  // The OAuth usage payload spells this `resets_at` as an ISO string; the session
  // may hand it over as `resetsAt` in epoch seconds. Accept either.
  const absolute = raw.resetsAt ?? raw.resets_at ?? raw.resetAt ?? raw.reset_at ?? raw.resetAtSeconds
  if (typeof absolute === 'string' && absolute) {
    const parsed = Date.parse(absolute)
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof absolute === 'number' && Number.isFinite(absolute) && absolute > 0) {
    return absolute > 1e12 ? absolute : absolute * 1000
  }
  const relative = raw.resetsInSeconds ?? raw.resetInSeconds ?? raw.resets_in_seconds ??
    raw.reset_in_seconds ?? raw.resetAfterSeconds ?? raw.reset_after_seconds
  if (typeof relative === 'number' && Number.isFinite(relative) && relative >= 0) {
    return now + relative * 1000
  }

  return undefined
}

/**
 * Local clock time when the window reopens, e.g. "(11:29)". A reset more than a
 * day away reads better as a coarse countdown ("(6d9h)"); a window that has
 * already reset shows nothing rather than a time in the past. Plain ASCII on
 * purpose: the status line is drawn by the terminal, and glyphs such as an
 * arrow or a parallelogram are missing from many monospace fonts.
 */
export function resetLabel(resetsAt: number | undefined, now = Date.now()): string {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return ''
  const delta = resetsAt - now
  if (delta <= 0) return ''
  if (delta < DAY_MS) {
    const time = new Date(resetsAt)
    const hours = String(time.getHours()).padStart(2, '0')
    const minutes = String(time.getMinutes()).padStart(2, '0')
    return `(${hours}:${minutes})`
  }
  const days = Math.floor(delta / DAY_MS)
  const hours = Math.floor((delta % DAY_MS) / (60 * 60 * 1000))
  return hours > 0 ? `(${days}d${hours}h)` : `(${days}d)`
}

function shortCount(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** A bar of `percent`; red emoji squares when offline (all dark on the blink's off phase). */
function bar(percent: number, cells: number, isOnline: boolean, isLit: boolean): string {
  if (cells === 0) return ''
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  // Block elements instead of parallelograms: `█`/`░` ship with virtually every
  // monospace font, while `▰`/`▱` render as tofu or at the wrong width on many.
  const body = isOnline
    ? '█'.repeat(filled) + '░'.repeat(cells - filled)
    : (isLit ? RED_FULL : RED_EMPTY).repeat(filled) + RED_EMPTY.repeat(cells - filled)

  return body + ' '
}

/**
 * The trace drawn from `samples` (oldest first; only the most recent `length` are
 * used), followed by a green heart while online. Pure: the caller decides what the
 * samples mean — here, how many tokens were counted since the previous tick.
 */
function trace(samples: number[], length: number, isOnline: boolean, isLit: boolean): string {
  if (!isOnline) {
    // A flatline, under a label and heart that blink; the label takes the room of 8 trace cells.
    const flat = String.fromCharCode(0x2800 + 0x24).repeat(Math.max(1, length - 8))
    return (isLit ? OFFLINE : OFFLINE_DIM) + ' ' + flat + ' ' + (isLit ? HEART_BROKEN : HEART_DIM)
  }

  const tail = samples.slice(-length)
  const shown = Array<number>(Math.max(0, length - tail.length)).fill(BASELINE).concat(tail)
  const line = shown
    .map(y => String.fromCharCode(0x2800 + (CELL_BITS[Math.max(0, Math.min(TOP, Math.round(y)))] ?? 0)))
    .join('')

  return line + ' ' + HEART_ONLINE
}

/** The folder's own name, without the path leading to it. */
export function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** Cells a string takes in the terminal: emoji are two wide, variation selectors none. */
export function displayWidth(text: string): number {
  let width = 0
  for (const c of text) {
    const cp = c.codePointAt(0) ?? 0
    if (cp === 0xfe0f || cp === 0x200d) continue
    width += cp >= 0x1f000 || cp === 0x2b1b || cp === 0x2b1c ? 2 : 1
  }
  return width
}

function compose(g: Gauge, samples: number[], isOnline: boolean, isLit: boolean, layout: Layout): string {
  const left = Math.max(0, g.window - (g.tokens ?? 0))
  const leftPercent = Math.round((left / g.window) * 100)
  const counts = layout.showCounts ? ` · ${shortCount(left)}/${shortCount(g.window)}` : ''
  const ctx = `CTX ${bar(leftPercent, layout.cells, isOnline, isLit)}${leftPercent}%${counts}`
  const fiveReset = resetLabel(g.fiveHourResetsAt)
  const weeklyReset = resetLabel(g.weeklyResetsAt)
  const limit =
    g.fiveHour === undefined
      ? ''
      : ` │ 5H ${bar(100 - g.fiveHour, layout.cells, isOnline, isLit)}${Math.round(100 - g.fiveHour)}%${fiveReset ? ` ${fiveReset}` : ''}`
  const weekly =
    g.weekly === undefined
      ? ''
      : ` │ 7D ${bar(100 - g.weekly, layout.cells, isOnline, isLit)}${Math.round(100 - g.weekly)}%${weeklyReset ? ` ${weeklyReset}` : ''}`

  const where = !layout.showFolder || folder === '' ? '' : `${FOLDER} ${folder} │ `

  return `${where}${trace(samples, layout.trace, isOnline, isLit)} │ ${ctx}${limit}${weekly}`
}

/**
 * The richest layout that fits `columns`, its trace stretched to fill what is left.
 * The line grows one cell per trace cell, so one measurement at the shortest trace tells the room.
 * The trace's rendered width never depends on what the samples are, so fitting needs none.
 */
export function fit(g: Gauge, columns: number | undefined, isOnline: boolean): Layout {
  if (columns === undefined) return DEFAULT_LAYOUT
  const room = columns - MARGIN

  for (const variant of VARIANTS) {
    const shortest = { ...variant, trace: MIN_TRACE }
    const spare = room - displayWidth(compose(g, [], isOnline, true, shortest))
    if (spare >= 0) return { ...variant, trace: Math.min(MAX_TRACE, MIN_TRACE + spare) }
  }

  return { ...VARIANTS[VARIANTS.length - 1]!, trace: MIN_TRACE }
}

export function line(g: Gauge, samples: number[], isOnline: boolean, isLit = true, columns?: number): string {
  return compose(g, samples, isOnline, isLit, fit(g, columns, isOnline))
}

// The animation's state, kept by the module: a reload starts it over.
let timers: Timer[] = []
let isOnline = true
let folder = ''
let n = 0
/** The terminal's width as the last drawing measured it; unknown until something draws. */
let columns: number | undefined

// Rolling trace samples (oldest first); one pushed per tick by sampleTick(). Sized so the
// widest trace (MAX_TRACE cells, 2 samples each) never runs out of real history to show.
let samples: number[] = []
const SAMPLE_BUFFER = MAX_TRACE + 8
/** The context size as of the last noteTokens() call, to turn the next one into a delta. */
let lastTokens = 0
/** Tokens counted since the last tick, folded into `flow` and cleared every tick. */
let pendingTokens = 0
/**
 * A smoothed reading of how busy things are right now. `session.measure` tends to land
 * its whole delta on a single tick rather than trickling in, so draining `pendingTokens`
 * straight into a sample would flash one braille column for 160ms and then go flat —
 * easy to miss. Blending it into a slow-decaying `flow` instead spreads a burst into a
 * visible rise and fall over roughly a second, at the cost of trailing the real delta by
 * a beat or two.
 */
let flow = 0
const FLOW_DECAY = 0.85
/** A decaying recent max, so the trace auto-scales to whatever "busy" currently looks like. */
let tokenPeak = 1
const PEAK_DECAY = 0.98

/** Sets the baseline without counting it as a burst — call once, on session start. */
function initTokens(tokens: number | undefined): void {
  lastTokens = tokens ?? 0
}

/** Folds however many tokens `session.measure` just reported into the pending tick. */
function noteTokens(tokens: number | undefined): void {
  const current = tokens ?? lastTokens
  pendingTokens += Math.max(0, current - lastTokens)
  lastTokens = current
}

/** One tick of the trace: `flow` auto-scaled against a decaying recent peak, so a quiet
 *  moment reads as flat and a burst rises and falls over about a second. */
function sampleTick(): void {
  flow = flow * FLOW_DECAY + pendingTokens
  pendingTokens = 0

  tokenPeak = Math.max(flow, tokenPeak * PEAK_DECAY)
  const ratio = tokenPeak > 0 ? Math.min(1, flow / tokenPeak) : 0
  const level = Math.round(BASELINE + ratio * (TOP - BASELINE))

  samples.push(level)
  if (samples.length > SAMPLE_BUFFER) samples.shift()
}

/** Reads the session's project root; `/cd` or a worktree move changes it between turns. */
async function readFolder($: EngineInterface): Promise<void> {
  folder = folderName(await $.session.root())
}

async function draw($: EngineInterface): Promise<void> {
  const g = await read($, gauge)
  const isLit = Math.floor(n / BLINK_TICKS) % 2 === 0
  if (g !== null) $.ui.status(line(g, samples, isOnline, isLit, columns))
}

/** Online when the API answers anything within the timeout; a redraw only when that changes. */
async function probe($: EngineInterface): Promise<void> {
  const timeout = $.clock.sleep(PROBE_TIMEOUT_MS).then(() => {
    throw new Error('timeout')
  })
  const reached = await Promise.race([$.http.fetch(PROBE_URL, { method: 'HEAD' }), timeout]).then(
    () => true,
    () => false,
  )

  if (reached !== isOnline) {
    isOnline = reached
    await draw($)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    await update($, gauge, () => toGauge(usage.context, usage.rateLimits))
    await readFolder($)
    // Seeds the baseline without it counting as a burst of newly-read tokens.
    initTokens(usage.context.tokens)

    timers.forEach(t => t.cancel())
    timers = [
      $.clock.every(TICK_MS, async () => {
        // Sampled every tick, turn or no turn, so the trace reflects real token traffic
        // rather than a fixed pattern that only moved while a turn was running.
        sampleTick()
        n += 1
        await draw($)
      }),
      $.clock.every(PROBE_EVERY_MS, () => void probe($)),
    ]
    // Draw at once, so a fresh load or a reload replaces whatever line was there before.
    await draw($)
    await probe($)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    await readFolder($)
    // A turn that died on an API error may mean the network went away: check now.
    if (e.reason === 'error') void probe($)
    return next(e)
  })

  // The status line is plain text and is told no width, but every drawing is: the band above the
  // prompt re-draws on a resize, so it is where the width is read. It draws nothing of its own.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const measured = e.viewport?.columns
    if (measured !== undefined && measured !== columns) {
      columns = measured
      await draw($)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, gauge, () => toGauge(e.context, e.rateLimits))
    noteTokens(e.context.tokens)
    await draw($)

    return next(e)
  })
}
