/** @jsxImportSource @opentui/solid */
// MiMoCode TUI plugin: a braille trace of real token traffic, the remaining
// context and the provider's prepaid balance, drawn in the prompt row.
// Ported from the OpenCode pacman-tokens bar.
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@mimo-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onMount, onCleanup } from "solid-js"
import os from "node:os"
import path from "node:path"
import { readFileSync } from "node:fs"
import {
  BASELINE,
  TOP,
  balanceFromCredits,
  chatgptLimits,
  deepseekBalance,
  folderName,
  isFreeModel,
  layout,
  modelWindow,
  money,
  providerFrom,
  usageFrom,
} from "./ecg.mjs"

const id = "local.pacman-tokens"

const TICK_MS = 160
const FLOW_DECAY = 0.85
const PEAK_DECAY = 0.98
const SAMPLE_BUFFER = 200
const BALANCE_EVERY_MS = 300_000
const BALANCE_TIMEOUT_MS = 5_000
// Providers with a documented prepaid-balance endpoint.
const BALANCE_PROVIDERS = new Set(["deepseek", "openrouter"])
// Providers whose allowance is a rolling window instead of a balance.
const LIMIT_PROVIDERS = new Set(["openai"])
// The prompt row already carries the agent, model and provider ticker on the
// left and the voice indicator on the right; the bar gets what is left of the
// terminal, within limits that keep both the trace and the summary legible.
const LEFT_RESERVE = 44
const RIGHT_RESERVE = 12
const BUDGET_MIN = 18
const BUDGET_MAX = 64

// Kept outside the component so switching sessions (which remounts the bar)
// continues the trace instead of restarting it, matching the original plugin.
let lastTokens = 0
let flow = 0
let tokenPeak = 1
let samples: number[] = []

// MiMoCode keeps provider credentials in <data>/auth.json and the TUI's model
// selection in <state>/model.json; the plugin reads both into memory only and
// never writes or logs them. An explicit environment variable wins so a user can
// override the stored credential.
function baseDir(kind: "data" | "state") {
  const home = process.env.MIMOCODE_HOME
  if (home) return path.join(home, kind)
  const base =
    kind === "data"
      ? process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
      : process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(base, "mimocode")
}

function apiKeyFor(providerID: string): string | undefined {
  const fromEnv = process.env[`${providerID.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`]
  if (fromEnv) return fromEnv
  try {
    const auth = JSON.parse(readFileSync(path.join(baseDir("data"), "auth.json"), "utf8")) as Record<
      string,
      { type?: string; key?: string }
    >
    const entry = auth[providerID]
    return entry?.type === "api" && typeof entry.key === "string" ? entry.key : undefined
  } catch {
    return undefined
  }
}

// The TUI moves the chosen model to the front of `recent` when the user selects
// it, so this is the provider in use before the session has any reply.
function selectedProviderID(): string | undefined {
  try {
    const state = JSON.parse(readFileSync(path.join(baseDir("state"), "model.json"), "utf8")) as {
      recent?: { providerID?: string }[]
    }
    const first = Array.isArray(state.recent) ? state.recent[0] : undefined
    return typeof first?.providerID === "string" ? first.providerID : undefined
  } catch {
    return undefined
  }
}

// A ChatGPT plan has no prepaid balance: its allowance is two rolling windows.
// The OAuth access token MiMoCode already stores is used directly, the same way
// the Codex CLI asks its own backend. Read-only, in memory, never logged.
function chatgptCredential(): { access: string; accountId: string } | undefined {
  try {
    const auth = JSON.parse(readFileSync(path.join(baseDir("data"), "auth.json"), "utf8")) as Record<
      string,
      { type?: string; access?: string; accountId?: string }
    >
    const entry = auth.openai
    if (entry?.type !== "oauth" || typeof entry.access !== "string") return undefined
    return { access: entry.access, accountId: entry.accountId ?? "" }
  } catch {
    return undefined
  }
}

// Only documented balance endpoints are used for money. A ChatGPT plan has no
// balance, so it reports its 5-hour and 7-day allowance instead.
async function fetchBalance(providerID: string) {
  if (providerID === "openai") return undefined
  const key = apiKeyFor(providerID)
  if (!key) return undefined
  const signal = AbortSignal.timeout(BALANCE_TIMEOUT_MS)
  try {
    if (providerID === "deepseek") {
      const response = await fetch("https://api.deepseek.com/user/balance", {
        headers: { Authorization: `Bearer ${key}` },
        signal,
      })
      if (!response.ok) return undefined
      return deepseekBalance(await response.json())
    }
    if (providerID === "openrouter") {
      const response = await fetch("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: `Bearer ${key}` },
        signal,
      })
      if (!response.ok) return undefined
      return balanceFromCredits(await response.json())
    }
  } catch {
    return undefined
  }
  return undefined
}

async function fetchLimits(providerID: string) {
  if (providerID !== "openai") return []
  const credential = chatgptCredential()
  if (!credential) return []
  try {
    const response = await fetch("https://chatgpt.com/backend-api/codex/usage", {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        "ChatGPT-Account-Id": credential.accountId,
        "User-Agent": "codex_cli_rs",
      },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    })
    if (!response.ok) return []
    return chatgptLimits(await response.json())
  } catch {
    return []
  }
}

function Bar(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const dimensions = useTerminalDimensions()
  const [tick, setTick] = createSignal(0)
  const [balance, setBalance] = createSignal<string | undefined>()
  const [limits, setLimits] = createSignal<{ label: string; left: number }[]>([])

  const usage = createMemo(() => usageFrom(props.api.state.session.messages(props.session_id)))
  const model = createMemo(() => {
    const used = usage()
    if (!used) return undefined
    return props.api.state.provider.find((item) => item.id === used.providerID)?.models[used.modelID]
  })
  const window = createMemo(() => modelWindow(model()))
  const folder = createMemo(() =>
    folderName(props.api.state.session.cwd(props.session_id) ?? props.api.state.path.directory),
  )

  // Usage updates land their whole delta on a single tick, so feeding that
  // straight into a sample flashes one cell for 160ms. Blending it into a
  // slow-decaying `flow` spreads a burst into a visible rise and fall.
  onMount(() => {
    const handle = setInterval(() => {
      const current = usage()?.used
      if (current !== undefined) {
        const delta = Math.max(0, current - lastTokens)
        lastTokens = current
        flow = flow * FLOW_DECAY + delta
        tokenPeak = Math.max(flow, tokenPeak * PEAK_DECAY)
        const ratio = tokenPeak > 0 ? Math.min(1, flow / tokenPeak) : 0
        samples = [...samples, Math.round(BASELINE + ratio * (TOP - BASELINE))].slice(-SAMPLE_BUFFER)
      }
      setTick((count) => count + 1)
    }, TICK_MS)
    onCleanup(() => clearInterval(handle))
  })

  // The balance belongs to the provider in use — the one that served the last
  // turn, or the selected model before the session has any reply. A switch
  // refetches instead of showing the previous account's money.
  const [selected, setSelected] = createSignal(selectedProviderID())
  const provider = createMemo(() =>
    providerFrom({
      turn: usage()?.providerID,
      configured: props.api.state.config.model,
      selected: selected(),
    }),
  )

  // FREE only explains why a *balance* does not move, so it is limited to the
  // providers that report one. MiMoCode zeroes every model's cost for a ChatGPT
  // plan, and there the bar shows the plan's windows instead.
  const free = createMemo(() => {
    const id = provider()
    return id !== undefined && BALANCE_PROVIDERS.has(id) && isFreeModel(model()?.cost)
  })

  let provider_current: string | undefined
  let provider_busy = false
  let provider_stopped = false
  const loadAccount = async () => {
    const next = provider()
    if (next !== provider_current) {
      provider_current = next
      setBalance(undefined)
      setLimits([])
    }
    const wantsMoney = next !== undefined && BALANCE_PROVIDERS.has(next)
    const wantsLimits = next !== undefined && LIMIT_PROVIDERS.has(next)
    if ((!wantsMoney && !wantsLimits) || provider_busy) return
    provider_busy = true
    try {
      const [cash, windows] = await Promise.all([
        wantsMoney ? fetchBalance(next) : Promise.resolve(undefined),
        wantsLimits ? fetchLimits(next) : Promise.resolve([]),
      ])
      if (provider_stopped || provider_current !== next) return
      setBalance(money(cash))
      setLimits(windows)
    } finally {
      provider_busy = false
    }
  }

  createEffect(() => {
    provider() // refetch as soon as the provider changes
    setSelected(selectedProviderID())
    void loadAccount()
  })

  onMount(() => {
    const handle = setInterval(() => void loadAccount(), BALANCE_EVERY_MS)
    onCleanup(() => {
      provider_stopped = true
      clearInterval(handle)
    })
  })

  const view = createMemo(() => {
    tick() // reactivity dependency: the trace advances between ticks
    const budget = Math.max(
      BUDGET_MIN,
      Math.min(BUDGET_MAX, dimensions().width - LEFT_RESERVE - RIGHT_RESERVE),
    )
    return layout({
      width: budget,
      folder: folder(),
      tokens: usage()?.used,
      window: window(),
      balance: balance(),
      free: free(),
      limits: limits(),
      samples,
    })
  })

  return (
    <text fg={theme().textMuted}>
      {view().label}
      <span style={{ fg: theme().primary }}>{view().signal}</span>
      {view().summary}
    </text>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 90,
    slots: {
      session_prompt_right(_ctx, props) {
        return <Bar api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
