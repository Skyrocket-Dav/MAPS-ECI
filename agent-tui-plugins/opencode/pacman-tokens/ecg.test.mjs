import assert from "node:assert/strict"
import { test } from "node:test"

import { balanceFromCredits, budgetForModel, chatgptLimits, contextForModel, deepseekBalance, displayWidth, folderName, gauge, goLimits, isFreeModel, layout, probeUrlFor, providerRoute, resetLabel, resetMoment, selectedModelRef, trace } from "./ecg.mjs"

// Pinned so the clock-time assertions do not depend on the machine's zone.
// `resetLabel` formats in local time on purpose; the bar must answer in the
// user's own clock.
process.env.TZ = "UTC"


test("shows remaining context, not consumed context", () => {
  assert.equal(gauge(50_000, 200_000), "CTX ██████░░ 75% · 150k/200k")
  assert.equal(gauge(250_000, 200_000), "CTX ░░░░░░░░ 0% · 0/200k")
  assert.equal(gauge(undefined, 200_000), "CTX ████████ 100% · 200k/200k")
})

// A spike is a braille cell with its top row lit \u2014 the only thing that bit pattern can
// mean, since the trace never lights a row above the current sample's height.
function spikes(text) {
  return [...text].filter(c => {
    const cp = c.codePointAt(0)
    return cp >= 0x2800 && cp <= 0x28ff && ((cp - 0x2800) & 0x09) !== 0
  }).length
}

test("renders braille and never more cells than asked for", () => {
  assert.match(trace(Array(50).fill(8), 22), /[\u2801-\u28ff]/u)
  assert.equal([...trace(Array(20).fill(5), 8)].length, 8)
})

test("a burst of tokens spikes the trace higher than an idle one", () => {
  const idle = Array(60).fill(0)
  const burst = Array(60).fill(8)
  assert.ok(spikes(trace(burst, 30)) > spikes(trace(idle, 30)))
  assert.equal(spikes(trace(idle, 30)), 0)
})

test("only the most recent samples are shown; older history scrolls off", () => {
  const recentBurst = Array(100).fill(0).concat(Array(10).fill(8))
  const oldBurst = Array(10).fill(8).concat(Array(100).fill(0))
  assert.ok(spikes(trace(recentBurst, 30)) > 0)
  assert.equal(spikes(trace(oldBurst, 30)), 0)
})

test("folder label uses only the final path segment", () => {
  assert.equal(folderName("/home/me/code/app/"), "app")
  assert.equal(folderName("/"), "/")
  assert.equal(folderName("C:\\code\\app\\"), "app")
})

test("the ECG expands to fill available composer width", () => {
  const narrow = layout({ width: 70, folder: "customers", tokens: 50_000, window: 200_000 })
  const wide = layout({ width: 150, folder: "customers", tokens: 50_000, window: 200_000 })
  assert.ok(wide.signal.length > narrow.signal.length)
  assert.equal(displayWidth(wide.text), 146) // 2 columns of padding on each side
})

test("probing the selected provider detects a lost connection", () => {
  assert.equal(probeUrlFor("deepseek"), "https://api.deepseek.com")
  assert.equal(probeUrlFor("openrouter"), "https://openrouter.ai")
  assert.equal(probeUrlFor("opencode-go"), "https://opencode.ai")
})

test("without a known provider there is still an Internet connection to check", () => {
  assert.equal(probeUrlFor(undefined), "https://opencode.ai")
  assert.equal(probeUrlFor("some-gateway"), "https://opencode.ai")
})

test("a local runtime has no remote host to probe", () => {
  assert.equal(probeUrlFor("ollama"), undefined)
  assert.equal(probeUrlFor("lmstudio"), undefined)
  assert.equal(probeUrlFor("llama.cpp"), undefined)
  assert.equal(probeUrlFor("vllm"), undefined)
})

test("a lost connection swaps the heart and the trace for an alert", () => {
  const online = layout({ width: 100, folder: "app", samples: [8, 8, 8] })
  const offline = layout({ width: 100, folder: "app", samples: [8, 8, 8], offline: true })
  assert.match(online.heart, /💚/)
  assert.match(offline.heart, /💔|🖤/)
  assert.match(offline.text, /OFFLINE|offline/)
})

test("online and offline layouts fit the composer at every width", () => {
  for (let width = 5; width <= 240; width++) {
    for (const offline of [false, true]) {
      const result = layout({ width, folder: "📦超长-project-name", tokens: 50_000, window: 200_000,
        limits: goLimits({ rolling: { percent: 30 }, weekly: { percent: 40 }, monthly: { percent: 50 } }), offline })
      assert.ok(displayWidth(result.text) <= Math.max(0, width - 4), `${width} cols, offline=${offline}: ${result.text}`)
    }
  }
})

test("the 5-hour limit is shown only if there is room", () => {
  const limits = goLimits({ rolling: { percent: 30 } })
  assert.match(layout({ width: 150, folder: "app", limits }).summary, /5H/)
  assert.doesNotMatch(layout({ width: 45, folder: "app", limits }).summary, /5H/)
})

test("Go's weekly and monthly windows show next to the 5-hour one when there is room", () => {
  const limits = goLimits({ rolling: { percent: 30 }, weekly: { percent: 40 }, monthly: { percent: 50 } })
  const full = layout({ width: 150, folder: "app", limits }).summary
  assert.match(full, /5H ██████░░ 70%/)
  assert.match(full, /WK █████░░░ 60%/)
  assert.match(full, /MO ████░░░░ 50%/)
})

test("a narrower terminal drops monthly and weekly before dropping the 5-hour window", () => {
  const limits = goLimits({ rolling: { percent: 30 }, weekly: { percent: 40 }, monthly: { percent: 50 } })
  const narrower = layout({ width: 80, folder: "app", limits }).summary
  assert.match(narrower, /5H/)
  assert.doesNotMatch(narrower, /MO /)
})

test("a weekly-only account skips the monthly segment instead of repeating it", () => {
  const limits = goLimits({ rolling: { percent: 30 }, weekly: { percent: 40 } })
  const status = layout({ width: 150, folder: "app", limits })
  assert.match(status.summary, /5H/)
  assert.match(status.summary, /WK/)
  assert.doesNotMatch(status.summary, /MO /)
})

test("goLimits skips windows the account does not report", () => {
  assert.deepEqual(goLimits({ rolling: { percent: 30 } }), [{ label: "5H", used: 30 }])
  assert.deepEqual(goLimits(undefined), [])
})

test("chatgptLimits maps the primary/secondary windows to 5H/7D", () => {
  const usage = {
    rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800 },
    },
  }
  assert.deepEqual(chatgptLimits(usage), [{ label: "5H", used: 0 }, { label: "7D", used: 40 }])
})

test("chatgptLimits keeps when each window reopens", () => {
  const usage = {
    rate_limit: {
      primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1_800_500_000 },
    },
  }
  assert.deepEqual(chatgptLimits(usage), [
    { label: "5H", used: 100, resetsAt: 1_800_000_000_000 },
    { label: "7D", used: 40, resetsAt: 1_800_500_000_000 },
  ])
})

test("a relative reset becomes an absolute moment when reset_at is missing", () => {
  const now = 1_700_000_000_000
  const usage = {
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 3_881 },
    },
  }
  assert.deepEqual(chatgptLimits(usage, now), [{ label: "5H", used: 10, resetsAt: now + 3_881_000 }])
  assert.equal(resetMoment({ reset_at: 1_800_000_000.5 }, now), 1_800_000_000_500)
  assert.equal(resetMoment({}, now), undefined)
})

test("a reset within a day shows the local clock time, later ones a countdown", () => {
  const now = Date.UTC(2026, 10, 9, 10, 0, 0)
  assert.equal(resetLabel(now + 2 * 60 * 60 * 1000, now), "(12:00)")
  assert.equal(resetLabel(now + 6 * 24 * 60 * 60 * 1000 + 9 * 60 * 60 * 1000, now), "(6d9h)")
  assert.equal(resetLabel(now + 2 * 24 * 60 * 60 * 1000, now), "(2d)")
  assert.equal(resetLabel(now - 1, now), "")
  assert.equal(resetLabel(undefined, now), "")
})

test("the ChatGPT bars carry the reopening time", () => {
  const now = Date.UTC(2026, 10, 9, 10, 0, 0)
  const usage = {
    rate_limit: {
      primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: now / 1000 + 3600 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: now / 1000 + 6 * 86400 },
    },
  }
  const summary = layout({ width: 150, folder: "app", limits: chatgptLimits(usage), now }).summary
  assert.match(summary, /5H ░░░░░░░░ 0% \(11:00\)/)
  assert.match(summary, /7D █████░░░ 60% \(6d\)/)
})

test("chatgptLimits drops a window whose length does not match 5h/7d", () => {
  const usage = {
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 3600 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800 },
    },
  }
  assert.deepEqual(chatgptLimits(usage), [{ label: "7D", used: 40 }])
  assert.deepEqual(chatgptLimits(undefined), [])
})

test("chatgptLimits renders as 5H/7D bars in the status line", () => {
  const usage = {
    rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800 },
    },
  }
  const summary = layout({ width: 150, folder: "app", limits: chatgptLimits(usage) }).summary
  assert.match(summary, /5H ████████ 100%/)
  assert.match(summary, /7D █████░░░ 60%/)
})

test("isFreeModel recognizes OpenRouter's :free id suffix", () => {
  assert.equal(isFreeModel("meta-llama/llama-3-8b-instruct:free", undefined), true)
  assert.equal(isFreeModel("meta-llama/llama-3-8b-instruct", undefined), false)
})

test("isFreeModel recognizes a catalog entry with zero cost on every tier", () => {
  const free = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
  const paid = [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }]
  assert.equal(isFreeModel("some/model", free), true)
  assert.equal(isFreeModel("some/model", paid), false)
  assert.equal(isFreeModel("some/model", []), false)
  assert.equal(isFreeModel("some/model", undefined), false)
})

test("a free model shows FREE instead of a dollar balance", () => {
  const status = layout({ width: 120, folder: "app", window: 200_000,
    balance: { left: 12.34, currency: "USD" }, free: true })
  assert.match(status.summary, /BALANCE FREE/)
  assert.doesNotMatch(status.summary, /\$12\.34/)
})

test("a free model shows FREE even without a balance to report", () => {
  const status = layout({ width: 120, folder: "app", window: 200_000, free: true })
  assert.match(status.summary, /BALANCE FREE/)
  assert.doesNotMatch(status.summary, /n\/a/)
})

test("shows unknown usage instead of full context after switching models", () => {
  const result = layout({ width: 100, folder: "app", window: 200_000 })
  assert.match(result.summary, /CTX \?\/200k/)
  assert.doesNotMatch(result.summary, /100%/)
})

test("finds the Console budget that applies to a model", () => {
  const limits = { budgets: [{ picked: true, coverage: "models", per: "set", scope: "combined",
    limit: 25, spent: 9, models: [{ providerID: "openai", modelID: "gpt-a" }] }] }
  assert.deepEqual(budgetForModel(limits, { providerID: "openai", id: "gpt-a" }), { left: 16, limit: 25 })
  assert.equal(budgetForModel(limits, { providerID: "openai", id: "gpt-b" }), undefined)
})

test("uses model spending for a per-model budget and ignores unknown balances", () => {
  const budget = { picked: true, coverage: "models", per: "model", scope: "each", limit: 15,
    spent: 10, models: [{ providerID: "openai", modelID: "gpt-a", spent: 4 }] }
  const model = { providerID: "openai", id: "gpt-a" }
  assert.deepEqual(budgetForModel({ budgets: [budget] }, model), { left: 11, limit: 15 })
  assert.equal(budgetForModel({ budgets: [{ ...budget, models: [{ providerID: "openai", modelID: "gpt-a" }] }] }, model), undefined)
  assert.equal(budgetForModel(undefined, model), undefined)
})

test("context usage never carries over after a model switch", () => {
  const messages = [{ type: "assistant", model: { providerID: "openai", id: "a" },
    tokens: { input: 1_000, output: 200, cache: { read: 500, write: 0 } } }]
  assert.deepEqual(contextForModel(messages, { providerID: "openai", id: "a" }, 200_000),
    { used: 1_700, window: 200_000 })
  assert.deepEqual(contextForModel(messages, { providerID: "openai", id: "b" }, 100_000),
    { used: undefined, window: 100_000 })
})

test("drops model, route and provider from the bar", () => {
  const status = layout({ width: 150, folder: "app", tokens: 50_000, window: 200_000 })
  assert.doesNotMatch(status.text, /MODEL|VIA |PROVIDER/)
})

test("shows the OpenRouter credit balance", () => {
  const status = layout({ width: 120, folder: "app", tokens: 50_000, window: 200_000,
    balance: { left: 12.34, currency: "USD" } })
  assert.match(status.summary, /BALANCE \$12\.34/)
  assert.doesNotMatch(status.summary, /n\/a/)
})

test("says the balance is unknown instead of inventing zero", () => {
  const status = layout({ width: 120, folder: "app", window: 200_000 })
  assert.match(status.summary, /BALANCE n\/a/)
})

test("computes the remaining OpenRouter credits", () => {
  assert.deepEqual(balanceFromCredits({ total_credits: 20, total_usage: 7.5 }), { left: 12.5, currency: "USD" })
  assert.deepEqual(balanceFromCredits({ data: { total_credits: 5, total_usage: 5 } }), { left: 0, currency: "USD" })
  assert.equal(balanceFromCredits({ total_credits: 1, total_usage: 3 }), undefined)
  assert.equal(balanceFromCredits(null), undefined)
})

test("prefers the remaining key limit when the key is capped", () => {
  assert.deepEqual(balanceFromCredits({ total_credits: 100, total_usage: 10 }, { limit_remaining: 4.5 }),
    { left: 4.5, currency: "USD" })
  assert.deepEqual(balanceFromCredits({ total_credits: 100, total_usage: 10 }, { limit: null }),
    { left: 90, currency: "USD" })
  assert.deepEqual(balanceFromCredits(undefined, { limit_remaining: 2 }), { left: 2, currency: "USD" })
})

test("parses the DeepSeek prepaid balance", () => {
  assert.deepEqual(deepseekBalance({ balance_infos: [{ currency: "USD", total_balance: "13.68" }] }),
    { left: 13.68, currency: "USD" })
  assert.deepEqual(deepseekBalance({ balance_infos: [{ currency: "CNY", total_balance: "50" }] }),
    { left: 50, currency: "CNY" })
  assert.equal(deepseekBalance(undefined), undefined)
  assert.equal(deepseekBalance({ balance_infos: [] }), undefined)
  assert.equal(deepseekBalance({ balance_infos: [{ total_balance: "nope" }] }), undefined)
})

test("keeps the balance visible in a standard 80-column terminal", () => {
  const status = layout({ width: 80, folder: "customers", tokens: 50_000, window: 1_048_576,
    balance: { left: 12.34, currency: "USD" } })
  assert.match(status.summary, /BALANCE/)
  assert.ok(displayWidth(status.text) <= 76)
})

test("the balance survives a narrow terminal even if the context gauge must shrink", () => {
  const status = layout({ width: 40, folder: "customers", tokens: 900_000, window: 1_048_576,
    balance: { left: 12.34, currency: "USD" } })
  assert.match(status.summary, /BALANCE \$12\.34/)
  assert.ok(displayWidth(status.text) <= 36)
})
