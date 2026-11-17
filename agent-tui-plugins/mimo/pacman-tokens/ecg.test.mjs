import assert from "node:assert/strict"
import { test } from "node:test"

import {
  BASELINE,
  TOP,
  balanceFromCredits,
  bar,
  chatgptLimits,
  deepseekBalance,
  displayWidth,
  folderName,
  gauge,
  isFreeModel,
  layout,
  modelWindow,
  money,
  providerFrom,
  shortCount,
  takeColumns,
  trace,
  usageFrom,
} from "./ecg.mjs"

test("shows remaining context, not consumed context", () => {
  assert.equal(gauge(50_000, 200_000), "CTX ▰▰▰▰▰▰▱▱ 75% · 150k/200k")
  assert.equal(gauge(250_000, 200_000), "CTX ▱▱▱▱▱▱▱▱ 0% · 0/200k")
  assert.equal(gauge(undefined, 200_000), "CTX ▰▰▰▰▰▰▰▰ 100% · 200k/200k")
})

test("an unknown window never claims a percentage", () => {
  assert.equal(gauge(50_000, 0), "CTX —")
  assert.equal(gauge(50_000, undefined), "CTX —")
})

test("counts are abbreviated only once they stop fitting", () => {
  assert.equal(shortCount(999), "999")
  assert.equal(shortCount(1_500), "2k")
  assert.equal(shortCount(2_400_000), "2M")
})

test("a bar fills proportionally and never exceeds its cells", () => {
  assert.equal(bar(0, 4), "▱▱▱▱")
  assert.equal(bar(100, 4), "▰▰▰▰")
  assert.equal([...bar(250, 4)].length, 4)
})

// A spike is a braille cell with its top row lit — the only thing that bit
// pattern can mean, since the trace never lights a row above the sample height.
function spikes(text) {
  return [...text].filter((character) => {
    const code = character.codePointAt(0)
    return code >= 0x2800 && code <= 0x28ff && ((code - 0x2800) & 0x09) !== 0
  }).length
}

test("renders braille and never more cells than asked for", () => {
  assert.match(trace(Array(50).fill(8), 22), /[\u2801-\u28ff]/u)
  assert.equal([...trace(Array(20).fill(5), 8)].length, 8)
})

test("a burst of tokens spikes the trace higher than an idle one", () => {
  const idle = Array(60).fill(BASELINE)
  const burst = Array(60).fill(TOP)
  assert.ok(spikes(trace(burst, 30)) > spikes(trace(idle, 30)))
  assert.equal(spikes(trace(idle, 30)), 0)
})

test("only the most recent samples are shown; older history scrolls off", () => {
  const recentBurst = Array(100).fill(BASELINE).concat(Array(10).fill(TOP))
  const oldBurst = Array(10).fill(TOP).concat(Array(100).fill(BASELINE))
  assert.ok(spikes(trace(recentBurst, 12)) > spikes(trace(oldBurst, 12)))
})

test("a trace narrower than the history still starts at the baseline", () => {
  // BASELINE is the bottom-left dot of the cell: U+2840.
  assert.equal(trace([], 3), "\u2840".repeat(3))
  assert.equal(trace(Array(2).fill(TOP), 5).length, 5)
})

test("folder label uses only the final path segment", () => {
  assert.equal(folderName("/tmp/example"), "example")
  assert.equal(folderName("C:\\work\\example\\"), "example")
  assert.equal(folderName(""), "")
})

test("wide characters are measured, so a label is truncated by columns", () => {
  assert.equal(displayWidth("abc"), 3)
  assert.equal(displayWidth("📁 a"), 4)
  assert.equal(takeColumns("abcdef", 4), "abcd")
  // the folder emoji is two columns, so only one letter still fits
  assert.equal(takeColumns("📁abcd", 3), "📁a")
  assert.equal(takeColumns("📁abcd", 2), "📁")
})

test("the model window prefers the prompt capacity MiMoCode compacts against", () => {
  assert.equal(modelWindow({ limit: { context: 200_000, input: 150_000 } }), 150_000)
  assert.equal(modelWindow({ limit: { context: 200_000 } }), 200_000)
  assert.equal(modelWindow({ limit: { context: 0 } }), undefined)
  assert.equal(modelWindow(undefined), undefined)
})

test("usage comes from the last measured assistant turn", () => {
  const messages = [
    { role: "user" },
    {
      role: "assistant",
      providerID: "test",
      modelID: "model",
      tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
    },
    { role: "assistant", providerID: "test", modelID: "model", tokens: { input: 0, output: 0 } },
  ]
  assert.deepEqual(usageFrom(messages), { used: 20, providerID: "test", modelID: "model" })
})

test("an unmeasured session reports no usage instead of zero", () => {
  assert.equal(usageFrom([]), undefined)
  assert.equal(usageFrom([{ role: "user" }]), undefined)
  assert.equal(
    usageFrom([{ role: "assistant", providerID: "test", modelID: "model", tokens: { input: 0, output: 0 } }]),
    undefined,
  )
})

test("the summary degrades before the trace disappears", () => {
  const tokens = 50_000
  const window = 200_000
  const rich = layout({ width: 64, tokens, window })
  assert.equal(rich.summary, gauge(tokens, window))

  // Too narrow for the full gauge: the bar shrinks, the percentage survives.
  const tight = layout({ width: 24, tokens, window })
  assert.equal(tight.summary, "CTX 75%")
  assert.ok(tight.signal.length >= 1)

  const unknown = layout({ width: 64, window })
  assert.equal(unknown.summary, "CTX ?/200k")
})

test("the layout never exceeds the columns it was given", () => {
  for (const width of [18, 24, 32, 48, 64, 80]) {
    for (const tokens of [undefined, 0, 50_000, 200_000]) {
      const out = layout({ width, folder: "example", tokens, window: 200_000, samples: Array(30).fill(TOP) })
      assert.ok(displayWidth(out.text) <= width, `width ${width} tokens ${tokens} overflowed: ${out.text}`)
    }
  }
})

test("the balance survives a shrinking bar", () => {
  const tokens = 50_000
  const window = 200_000
  const rich = layout({ width: 64, tokens, window, balance: "$12.34" })
  assert.match(rich.summary, / \$12\.34$/)

  const tight = layout({ width: 26, tokens, window, balance: "$12.34" })
  assert.match(tight.summary, /\$12\.34$/, `balance was dropped: ${tight.summary}`)

  // Only when nothing carrying the balance fits does it go away.
  const tiny = layout({ width: 20, tokens, window, balance: "$12.34" })
  assert.ok(displayWidth(tiny.text) <= 20)
})

test("a free model shows FREE instead of an account balance", () => {
  const out = layout({ width: 64, tokens: 1_000, window: 200_000, balance: "$12.34", free: true })
  assert.match(out.summary, / FREE$/)
  assert.doesNotMatch(out.summary, /12\.34/)
})

test("DeepSeek's documented balance payload is parsed", () => {
  const usd = deepseekBalance({
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }],
  })
  assert.deepEqual(usd, { left: 110, currency: "USD" })
  assert.equal(money(usd), "$110.00")

  // CNY accounts report yuan, so the symbol has to follow the currency.
  const cny = deepseekBalance({ balance_infos: [{ currency: "CNY", total_balance: "88.5" }] })
  assert.equal(money(cny), "¥88.50")

  assert.equal(deepseekBalance({ balance_infos: [] }), undefined)
  assert.equal(deepseekBalance({}), undefined)
  assert.equal(money(undefined), undefined)
})

test("OpenRouter credits minus usage, or the capped key's remainder", () => {
  assert.deepEqual(balanceFromCredits({ data: { total_credits: 20, total_usage: 7.5 } }), {
    left: 12.5,
    currency: "USD",
  })
  // A key limit is stricter than the account total, so it wins.
  assert.deepEqual(balanceFromCredits({ data: { total_credits: 20, total_usage: 0 } }, { limit_remaining: 3 }), {
    left: 3,
    currency: "USD",
  })
  assert.equal(balanceFromCredits({ data: { total_credits: 5, total_usage: 9 } }), undefined)
  assert.equal(balanceFromCredits({}), undefined)
})

test("a model is free only when every tier costs nothing", () => {
  const zero = { input: 0, output: 0, cache: { read: 0, write: 0 } }
  assert.equal(isFreeModel(zero), true)
  assert.equal(isFreeModel({ ...zero, experimentalOver200K: zero }), true)
  assert.equal(isFreeModel({ ...zero, input: 0.1 }), false)
  // A long-context surcharge means the model can spend money.
  assert.equal(isFreeModel({ ...zero, experimentalOver200K: { ...zero, output: 2 } }), false)
  assert.equal(isFreeModel(undefined), false)
  assert.equal(isFreeModel([{ input: 0, output: 0, cache: { read: 0, write: 0 } }]), true)
})

test("a folder label is dropped rather than truncating the summary", () => {
  const narrow = layout({ width: 22, folder: "example", tokens: 50_000, window: 200_000 })
  assert.equal(narrow.label, "")
  assert.ok(narrow.summary.length > 0)
})

test("the balance provider resolves before the first turn", () => {
  // A turn that already ran is exact, whatever else is configured.
  assert.equal(providerFrom({ turn: "deepseek", configured: "openai/gpt", selected: "x" }), "deepseek")
  // Before any reply, an explicit config model applies.
  assert.equal(providerFrom({ configured: "deepseek/deepseek-flash", selected: "openai" }), "deepseek")
  // A session the user just started falls back to the TUI's persisted selection.
  assert.equal(providerFrom({ selected: "deepseek" }), "deepseek")
  assert.equal(providerFrom({ configured: "not-a-ref", selected: "deepseek" }), "deepseek")
  assert.equal(providerFrom({}), undefined)
})

test("ChatGPT windows are reported as what is left", () => {
  const usage = {
    rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 80, limit_window_seconds: 604_800 },
    },
  }
  assert.deepEqual(chatgptLimits(usage), [
    { label: "5H", left: 75 },
    { label: "7D", left: 20 },
  ])
})

test("a window of unexpected length is dropped instead of mislabelled", () => {
  const usage = {
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 3_600 },
      secondary_window: { used_percent: 80, limit_window_seconds: 604_800 },
    },
  }
  assert.deepEqual(chatgptLimits(usage), [{ label: "7D", left: 20 }])
  assert.deepEqual(chatgptLimits({}), [])
  assert.deepEqual(chatgptLimits(undefined), [])
})

test("the 5-hour window survives a narrow bar and the week is dropped first", () => {
  const limits = [
    { label: "5H", left: 75 },
    { label: "7D", left: 20 },
  ]
  const wide = layout({ width: 80, tokens: 10_000, window: 100_000, limits })
  assert.match(wide.summary, /5H/)
  assert.match(wide.summary, /7D/)

  const narrow = layout({ width: 30, tokens: 10_000, window: 100_000, limits })
  assert.match(narrow.summary, /5H/)
  assert.doesNotMatch(narrow.summary, /7D/)

  for (const width of [18, 24, 30, 40, 56, 80]) {
    const out = layout({ width, tokens: 10_000, window: 100_000, limits, samples: Array(20).fill(TOP) })
    assert.ok(displayWidth(out.text) <= width, `width ${width} overflowed: ${out.text}`)
  }
})
