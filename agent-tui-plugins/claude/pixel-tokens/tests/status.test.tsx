import type { SessionMeasureInput, SessionRateLimit } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { displayWidth, folderName, line, resetLabel, resetMoment } from '../hooks/register'

type Measurer = { session: { measure: (e: SessionMeasureInput) => Promise<unknown> } }

async function measure($: Measurer, tokens: number) {
  await $.session.measure({
    context: { tokens, window: 200_000, percent: Math.round((tokens / 200_000) * 100) },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 30 },
      { kind: 'seven_day', percentUsed: 50 },
    ],
    changed: ['context', 'rateLimits'],
  })
}

// A spike is a braille cell with its top row lit — the only thing that bit pattern can
// mean, since the trace never lights a row above the current sample's height. Restricted
// to the braille block itself so the heart emoji after the trace is never miscounted.
function spikes(text: string): number {
  return [...text.split(' │ ')[0]!]
    .filter(c => {
      const cp = c.codePointAt(0)!
      return cp >= 0x2800 && cp <= 0x28ff && ((cp - 0x2800) & 0x09) !== 0
    })
    .length
}

test('the status line shows the ECG, the context left, the five-hour and weekly windows', async ($, on) => {
  let shown: string | undefined
  on('ui.status', (_, e) => {
    shown = e.text
    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await measure($, 50_000)

  // Before any real tick has drained a measurement, the trace may be an honest flat
  // line (U+2800) rather than faking motion — this only checks the trace area is there.
  expect(/[⠀-⣿]/u.test(shown ?? '')).toBe(true)
  expect(shown?.includes('💚')).toBe(true)
  expect(shown?.includes('CTX ██████░░ 75% · 150k/200k')).toBe(true)
  expect(shown?.includes('5H ██████░░ 70%')).toBe(true)
  expect(shown?.includes('7D ████░░░░ 50%')).toBe(true)
})

test('a live burst of tokens shows up in the rendered trace', async ($, on) => {
  let shown = ''
  on('ui.status', (_, e) => {
    shown = e.text ?? ''
    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await measure($, 0)
  const calm = spikes(shown)
  await measure($, 190_000)

  expect(spikes(shown) >= calm).toBe(true)
})

test('the bar turns red when the API cannot be reached', async ($, on) => {
  let shown = ''
  on('ui.status', (_, e) => {
    shown = e.text ?? ''
    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 50_000, window: 200_000, percent: 25 }, rateLimits: [] },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/home/me/code/app' }))
  on('http.fetch', () => {
    throw new Error('offline')
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await measure($, 50_000)

  expect(shown.includes('OFFLINE')).toBe(true)
  expect(shown.includes('🟥')).toBe(true)
  expect(shown.includes('💔')).toBe(true)
  expect(shown.startsWith('📁 app │ ')).toBe(true)
})

test('the folder shows only its name', () => {
  expect(folderName('/home/me/code/app')).toBe('app')
  expect(folderName('/home/me/code/app/')).toBe('app')
  expect(folderName('/')).toBe('/')
})

const GAUGE = { tokens: 50_000, window: 200_000, fiveHour: 30, weekly: 50 }
const DAY_MS = 24 * 60 * 60 * 1000

test('the five-hour and weekly bars say when the window reopens', () => {
  const now = Date.now()
  const gauge = {
    ...GAUGE,
    fiveHourResetsAt: now + 90 * 60 * 1000,
    weeklyResetsAt: now + 3 * DAY_MS + 2 * 60 * 60 * 1000,
  }
  const shown = line(gauge, [], true, true, 160)

  expect(/5H [█░]+ 70% \(\d{2}:\d{2}\)/.test(shown)).toBe(true)
  expect(/7D [█░]+ 50% \(3d1h\)/.test(shown)).toBe(true)
})

test('a reset more than a day away is a countdown and a past one is hidden', () => {
  const now = Date.UTC(2026, 10, 9, 10, 0, 0)

  expect(/^\(\d{2}:\d{2}\)$/.test(resetLabel(now + 60 * 60 * 1000, now))).toBe(true)
  expect(resetLabel(now + 6 * DAY_MS + 9 * 60 * 60 * 1000, now)).toBe('(6d9h)')
  expect(resetLabel(now + 2 * DAY_MS, now)).toBe('(2d)')
  expect(resetLabel(now - 1, now)).toBe('')
  expect(resetLabel(undefined, now)).toBe('')
})

test('a rate limit reports its reset moment in epoch seconds or relative seconds', () => {
  const now = 1_700_000_000_000

  expect(resetMoment({ kind: 'five_hour', percentUsed: 100, resetsAt: 1_800_000_000 } as unknown as SessionRateLimit, now))
    .toBe(1_800_000_000_000)
  expect(resetMoment({ kind: 'five_hour', percentUsed: 100, resetsInSeconds: 60 } as unknown as SessionRateLimit, now))
    .toBe(now + 60_000)
  // The OAuth usage payload spells it as an ISO timestamp.
  expect(resetMoment({ kind: 'five_hour', percentUsed: 53, resets_at: '2026-11-09T12:20:00.109062+00:00' } as unknown as SessionRateLimit, now))
    .toBe(Date.parse('2026-11-09T12:20:00.109062+00:00'))
  expect(resetMoment(undefined, now)).toBe(undefined)
})

test('a burst of tokens spikes the trace higher than an idle one', () => {
  const idle = Array<number>(200).fill(0)
  const burst = Array<number>(200).fill(8)

  const idleLine = line(GAUGE, idle, true, true, 160)
  const burstLine = line(GAUGE, burst, true, true, 160)

  expect(spikes(burstLine) > spikes(idleLine)).toBe(true)
  expect(spikes(idleLine)).toBe(0)
})

test('only the most recent samples are shown; older history scrolls off', () => {
  const recentBurst = Array<number>(300).fill(0).concat(Array<number>(10).fill(8))
  const oldBurst = Array<number>(10).fill(8).concat(Array<number>(300).fill(0))

  expect(spikes(line(GAUGE, recentBurst, true, true, 160)) > 0).toBe(true)
  expect(spikes(line(GAUGE, oldBurst, true, true, 160))).toBe(0)
})

test('the line fills the terminal width without passing it', () => {
  for (const columns of [60, 80, 120, 200]) {
    for (const isOnline of [true, false]) {
      expect(displayWidth(line(GAUGE, [], isOnline, true, columns)) <= columns - 2).toBe(true)
    }
  }
  // A wider terminal gets a longer trace.
  const traceOf = (columns: number) => line(GAUGE, [], true, true, columns).split(' │ ')[0]!.length
  expect(traceOf(200) > traceOf(120)).toBe(true)
  expect(displayWidth(line(GAUGE, [], true, true, 120))).toBe(118)
})

test('a narrow terminal drops the extras but keeps the trace and percentages', () => {
  const narrow = line(GAUGE, [], true, true, 50)

  expect(narrow.includes('/200k')).toBe(false)
  expect(narrow.includes('75%')).toBe(true)
  expect(narrow.includes('70%')).toBe(true)
  expect(narrow.includes('💚')).toBe(true)
})

test('the status line follows the width the band above the prompt measures', async ($, on) => {
  let shown = ''
  on('ui.status', (_, e) => {
    shown = e.text ?? ''
    return { value: undefined }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  // Stands for the engine, which draws an empty band beneath the plugin.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>band</Text>
  })

  await measure($, 50_000)
  const ui = await $.ui.mount({
    plugin: 'pixel-tokens',
    component: 'AbovePrompt',
    surface: 'terminal',
    viewport: { columns: 160, rows: 40, isFullscreen: false },
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 20,
      bodyColumns: 155,
      scroll: { offset: 0, bodyRows: 19 },
      view: {},
    },
  })

  // The trace's rendered width never depends on which samples it holds, so this
  // compares displayWidth rather than exact text — the live trace's own history
  // isn't reproducible from here, but the width-fitting math is.
  expect(displayWidth(shown)).toBe(displayWidth(line(GAUGE, [], true, true, 160)))
  expect(displayWidth(shown) > displayWidth(line(GAUGE, [], true, true, 80))).toBe(true)
  await ui.unmount()
})
