import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { BASELINE, balanceFromCredits, budgetForModel, chatgptLimits, contextForModel, deepseekBalance, folderName, goLimits, isFreeModel, layout, probeUrlFor, selectedModelRef, TOP } from "./ecg.mjs"

const TICK_MS = 160
const PROBE_EVERY_MS = 15_000
const PROBE_TIMEOUT_MS = 5_000
const ROLLING_EVERY_MS = 60_000
const BALANCE_EVERY_MS = 300_000
const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage"

// Kept outside the component so switching sessions (which remounts the bar)
// starts from the last known state instead of re-announcing a lost connection.
let lastKnownOffline = false

function EcgBar(props: { sessionID?: string }) {
  const context = usePlugin()
  const [tick, setTick] = createSignal(0)
  const [samples, setSamples] = createSignal<number[]>([])
  const [width, setWidth] = createSignal(100)
  const [offline, setOffline] = createSignal(lastKnownOffline)
  const [limits, setLimits] = createSignal<any>()
  const [chatgptUsage, setChatgptUsage] = createSignal<any>()
  const [balance, setBalance] = createSignal<{ left: number; currency: string } | undefined>()
  const [settings] = context.storage.store("settings", { initial: { openrouterKey: "" } })
  let barRef: { width?: number } | undefined

  const location = () => context.location ?? context.data.location.default()
  const folder = () => folderName(location().directory)

  const selectedModel = () => {
    const selected = context.ui.model.current() ??
      (props.sessionID ? context.data.session.get(props.sessionID)?.model : undefined)
    return selectedModelRef(selected)
  }

  const modelInfo = () => {
    const selected = selectedModel()
    if (!selected) return undefined
    const models = context.data.location.model.list(location()) as any
    const entries = Array.isArray(models) ? models : Object.values(models ?? {})
    return entries.find((entry: any) => entry?.providerID === selected.providerID &&
      (entry?.id === selected.id || entry?.modelID === selected.id)) as any
  }

  // The selected model sets the capacity. Only use the last response's tokens
  // if that response used the same model; switching models resets usage to ?.
  const usage = () => {
    const selected = selectedModel()
    const window = modelInfo()?.limit?.context
    const messages = props.sessionID ? context.data.session.message.list(props.sessionID) ?? [] : []
    return contextForModel(messages, selected, window)
  }

  // The trace plots real token traffic: how many tokens were counted since the previous
  // tick, auto-scaled against a decaying recent peak so a quiet moment reads as flat and
  // a burst fills the height. `usage().used` already behaves like a running context
  // total (it is the last response's input tokens, which include the history sent with
  // it), so the delta between ticks is the tokens that arrived since the last one.
  //
  // Usage updates tend to land their whole delta on a single tick rather than trickling
  // in, so feeding that straight into a sample would flash one cell for 160ms and then
  // go flat — easy to miss. Blending it into a slow-decaying `flow` instead spreads a
  // burst into a visible rise and fall over roughly a second.
  let sampleHistory: number[] = []
  let lastTokens = 0
  let flow = 0
  const FLOW_DECAY = 0.85
  let tokenPeak = 1
  const PEAK_DECAY = 0.98
  const SAMPLE_BUFFER = 200
  const sampleTick = () => {
    const current = usage()?.used ?? lastTokens
    const delta = Math.max(0, current - lastTokens)
    lastTokens = current
    flow = flow * FLOW_DECAY + delta
    tokenPeak = Math.max(flow, tokenPeak * PEAK_DECAY)
    const ratio = tokenPeak > 0 ? Math.min(1, flow / tokenPeak) : 0
    sampleHistory = [...sampleHistory, Math.round(BASELINE + ratio * (TOP - BASELINE))].slice(-SAMPLE_BUFFER)
    setSamples(sampleHistory)
  }

  // The key is read from the plugin options or the environment; it is never
  // written to disk or logged by this plugin.
  const openRouterKey = () => {
    const saved = (settings as any)?.openrouterKey
    if (typeof saved === "string" && saved) return saved
    const configured = (context.options as any)?.openrouterKey
    if (typeof configured === "string" && configured) return configured
    try {
      const fromEnv = (globalThis as any).process?.env?.OPENROUTER_API_KEY
      return typeof fromEnv === "string" && fromEnv ? fromEnv : undefined
    } catch {
      return undefined
    }
  }

  // The DeepSeek key lives in OpenCode's auth store (opencode auth login),
  // with a fallback to the standard env var and a plugin option.
  const deepseekKey = async () => {
    const configured = (context.options as any)?.deepseekKey
    if (typeof configured === "string" && configured) return configured
    try {
      const fromEnv = (globalThis as any).process?.env?.DEEPSEEK_API_KEY
      if (typeof fromEnv === "string" && fromEnv) return fromEnv
    } catch {
      // no env access
    }
    try {
      const { readFileSync } = await import("node:fs")
      const env = (globalThis as any).process?.env ?? {}
      const home = env.HOME || env.USERPROFILE
      const dataDir = env.XDG_DATA_HOME || (home ? `${home}/.local/share` : "")
      if (!dataDir) return undefined
      const data = JSON.parse(readFileSync(`${dataDir}/opencode/auth.json`, "utf8"))
      const key = data?.deepseek?.key
      return typeof key === "string" && key ? key.trim() : undefined
    } catch {
      return undefined
    }
  }

  // The generated client's query serializer flattens the nested `location`
  // object into a single string, which the server rejects as "Expected
  // object | undefined" (HTTP 400) — reproduced even with `opencode api`
  // itself, so it is a bug in OpenCode, not something fixable by changing
  // what we pass to context.client. Fetched directly instead, against the
  // local background service's own address, the same way `opencode api`
  // and the TUI itself reach the server — confirmed by hand that
  // `location[directory]=<dir>` is what the endpoint actually expects.
  const serviceInfo = async (): Promise<{ url: string; password: string } | undefined> => {
    try {
      const { readFileSync } = await import("node:fs")
      const env = (globalThis as any).process?.env ?? {}
      const home = env.HOME || env.USERPROFILE
      const stateDir = env.XDG_STATE_HOME || (home ? `${home}/.local/state` : "")
      if (!stateDir) return undefined
      const service = JSON.parse(readFileSync(`${stateDir}/opencode/service.json`, "utf8"))
      return service?.url && service?.password ? { url: service.url, password: service.password } : undefined
    } catch {
      return undefined
    }
  }

  const goUsageLimits = async (): Promise<any> => {
    const service = await serviceInfo()
    if (!service) return undefined
    try {
      const dir = location().directory
      const auth = Buffer.from(`opencode:${service.password}`).toString("base64")
      const url = `${service.url}/api/experimental/usage/limits?location%5Bdirectory%5D=${encodeURIComponent(dir)}`
      const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` } })
      return response.ok ? await response.json() : undefined
    } catch {
      return undefined
    }
  }

  // ChatGPT's OAuth credentials live in OpenCode's own credential store, not
  // a file this plugin can read; `auth export` is the supported way to reach
  // them, run against the same executable that is hosting this plugin.
  const chatgptCredential = async (): Promise<{ access: string; accountId: string } | undefined> => {
    try {
      const bin = (globalThis as any).process?.execPath
      if (!bin) return undefined
      const { execFile } = await import("node:child_process")
      const { promisify } = await import("node:util")
      const { stdout } = await promisify(execFile)(bin, ["auth", "export", "openai"], { timeout: 5_000 })
      const entries = JSON.parse(stdout)
      const list = Array.isArray(entries) ? entries : [entries]
      const withAccess = (entry: any) => (entry?.value ?? entry)?.access
      const chosen = list.find((entry: any) => withAccess(entry) && entry.active) ?? list.find(withAccess)
      const value = chosen?.value ?? chosen
      if (!value?.access) return undefined
      return { access: value.access, accountId: value.metadata?.accountID ?? "" }
    } catch {
      return undefined
    }
  }

  // OpenCode Go's docs define its three allowances as 5-hour/weekly/monthly
  // shares of the plan. ChatGPT's own backend (not a documented OpenAI API)
  // separately exposes a 5-hour and a 7-day window.
  const rateLimits = () => {
    const selected = selectedModel()
    if (selected?.providerID === "opencode-go") return goLimits(limits()?.go)
    if (selected?.providerID === "openai") return chatgptLimits(chatgptUsage())
    return []
  }

  // OpenRouter marks some models ":free"; OpenCode's own catalog also carries
  // zero cost for them. Either is enough to say the balance will not move.
  const free = () => {
    const selected = selectedModel()
    return selected?.providerID === "openrouter" && isFreeModel(selected.id, modelInfo()?.cost)
  }

  const blink = () => Math.floor(tick() / 3) % 2 === 0
  const frame = createMemo(() => {
    const current = usage()
    return layout({
      width: width(), folder: folder(), tokens: current?.used, window: current?.window,
      limits: rateLimits(), balance: balance(), free: free(),
      samples: samples(), offline: offline(), lit: blink(),
    })
  })

  onMount(() => {
    let disposed = false
    const animation = setInterval(() => {
      // Sampled every tick, turn or no turn, so the trace reflects real token traffic
      // rather than a fixed pattern that only moved while a turn was running.
      sampleTick()
      setTick((value) => value + 1)
    }, TICK_MS)

    const renderer = context.renderer as any
    const measure = () => {
      const actual = barRef?.width || renderer?.width
      if (typeof actual === "number" && actual > 0) setWidth(actual)
    }
    measure()
    const measureSoon = setTimeout(measure, 50)
    const measureLate = setTimeout(measure, 500)
    renderer?.on?.("resize", measure)
    void context.data.location.model.sync(location()).catch(() => {})

    // The OpenCode server answers even with the network unplugged, so probing it
    // alone stayed green while the provider was unreachable. Online now needs
    // both: the server answers, and a HEAD to the provider's host completes.
    const serverReachable = async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const probe = (context.client as any).server?.info?.() ?? context.client.session.list({ limit: 1 })
        await Promise.race([probe, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS)
        })])
        return true
      } catch {
        return false
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    }

    const hostReachable = async (url: string) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new Error("probe timeout")), PROBE_TIMEOUT_MS)
      try {
        // Any HTTP answer counts, so a 401 or 404 from the host still means the
        // route works; only a network error or the timeout means offline.
        await fetch(url, { method: "HEAD", signal: controller.signal })
        return true
      } catch {
        return false
      } finally {
        clearTimeout(timeout)
      }
    }

    // Only the newest probe may publish a result, so a slow earlier check cannot
    // overwrite a newer one and make the bar flap.
    let probeRun = 0
    const checkConnection = async () => {
      const run = ++probeRun
      const url = probeUrlFor(selectedModel()?.providerID)
      const [server, host] = await Promise.all([serverReachable(), url ? hostReachable(url) : true])
      if (disposed || run !== probeRun) return
      const next = !server || !host
      if (next === offline()) return
      lastKnownOffline = next
      setOffline(next)
      // The colour change is easy to miss, so a transition also raises a toast
      // and, while the terminal is not focused, a system notification + sound.
      const message = next
        ? (server ? "No connection to the provider" : "No connection to the server")
        : "Connection restored"
      context.ui.toast.show({
        title: "Connection",
        message,
        variant: next ? "error" : "success",
        duration: 5000,
      })
      try {
        void context.attention.notify({
          title: "OpenCode",
          message,
          notification: { when: "blurred" },
          sound: { name: next ? "error" : "done", when: "blurred" },
        }).catch(() => {})
      } catch {
        // attention is optional on hosts that do not expose it
      }
    }

    // OpenRouter keeps the prepaid credits; OpenCode Console reports its own
    // budget. Prefer whichever source matches the selected provider.
    const checkBalance = async () => {
      const selected = selectedModel()
      if (selected?.providerID === "openrouter") {
        const key = openRouterKey()
        if (!key) {
          if (!disposed) setBalance(undefined)
          return
        }
        try {
          const headers = { Authorization: `Bearer ${key}` }
          const request = async (url: string) => {
            const response = await fetch(url, { headers })
            return response.ok ? response.json() : undefined
          }
          const [credits, keyInfo] = await Promise.all([
            request("https://openrouter.ai/api/v1/credits").catch(() => undefined),
            request("https://openrouter.ai/api/v1/key").catch(() => undefined),
          ])
          if (!disposed) setBalance(balanceFromCredits(credits, keyInfo?.data ?? keyInfo))
        } catch {
          if (!disposed) setBalance(undefined)
        }
        return
      }
      if (selected?.providerID === "deepseek") {
        const key = await deepseekKey()
        if (!key) {
          if (!disposed) setBalance(undefined)
          return
        }
        try {
          const response = await fetch("https://api.deepseek.com/user/balance", {
            headers: { Authorization: `Bearer ${key}` },
          })
          const data = response.ok ? await response.json() : undefined
          if (!disposed) setBalance(deepseekBalance(data))
        } catch {
          if (!disposed) setBalance(undefined)
        }
        return
      }
      const consoleBudget = budgetForModel(limits(), selected)
      if (!disposed) setBalance(consoleBudget ? { left: consoleBudget.left, currency: "USD" } : undefined)
    }

    const checkRolling = async () => {
      const payload = await goUsageLimits()
      if (!disposed) setLimits(payload?.data ?? undefined)
    }

    // Unlike Go's rolling data, OpenCode does not proxy this: fetched directly
    // from ChatGPT's backend with the account's own OAuth credentials.
    const checkChatgpt = async () => {
      if (selectedModel()?.providerID !== "openai") {
        if (!disposed) setChatgptUsage(undefined)
        return
      }
      const credential = await chatgptCredential()
      if (!credential) {
        if (!disposed) setChatgptUsage(undefined)
        return
      }
      try {
        const response = await fetch(CHATGPT_USAGE_URL, {
          headers: {
            Authorization: `Bearer ${credential.access}`,
            "ChatGPT-Account-Id": credential.accountId,
            "User-Agent": "codex_cli_rs",
          },
        })
        const data = response.ok ? await response.json() : undefined
        if (!disposed) setChatgptUsage(data)
      } catch {
        if (!disposed) setChatgptUsage(undefined)
      }
    }

    void checkConnection()
    void checkRolling()
    void checkBalance()
    void checkChatgpt()
    // Saving a key in /balance, or switching model/provider, re-reads the
    // balance so the bar never shows another account's figure.
    createEffect(() => {
      void (settings as any)?.openrouterKey
      void selectedModel()?.providerID
      void checkBalance()
      void checkChatgpt()
      // The probe host follows the provider, so a switch re-checks at once.
      void checkConnection()
    })
    const probeTimer = setInterval(() => void checkConnection(), PROBE_EVERY_MS)
    const rollingTimer = setInterval(() => void checkRolling(), ROLLING_EVERY_MS)
    const chatgptTimer = setInterval(() => void checkChatgpt(), ROLLING_EVERY_MS)
    const balanceTimer = setInterval(() => void checkBalance(), BALANCE_EVERY_MS)
    // A reconnected event stream says the server is back, not the provider.
    const stopConnected = context.data.on("server.connected", () => void checkConnection())
    const stopFailed = context.data.on("session.execution.failed", (event: any) => {
      if (event?.data?.sessionID === props.sessionID) void checkConnection()
    })

    onCleanup(() => {
      disposed = true
      clearInterval(animation)
      clearInterval(probeTimer)
      clearInterval(rollingTimer)
      clearInterval(chatgptTimer)
      clearInterval(balanceTimer)
      clearTimeout(measureSoon)
      clearTimeout(measureLate)
      renderer?.off?.("resize", measure)
      stopConnected()
      stopFailed()
    })
  })

  return (
    <box
      ref={(element) => { barRef = element }}
      width="100%"
      height={1}
      flexShrink={0}
      paddingLeft={2}
      paddingRight={2}
      onSizeChange={function (this: { width: number }) { setWidth(this.width) }}
    >
      <text wrapMode="none" flexShrink={1}>
        <span style={{ fg: context.theme.text.muted }}>{frame().label}</span>
        <span style={{ fg: offline() ? (blink() ? "#FF3B30" : "#7A1F1F") : "#5AF78E" }}>
          {frame().signal}
        </span>
        <span style={{ fg: offline() ? (blink() ? "#FF3B30" : "#7A1F1F") : "#5AF78E" }}>
          {frame().heart}
        </span>
        <span style={{ fg: offline() ? "#FF3B30" : context.theme.text.muted }}>{frame().separator}</span>
        <span style={{ fg: offline() ? (blink() ? "#FF3B30" : "#7A1F1F") : context.theme.text.base }}>
          {frame().summary}
        </span>
      </text>
    </box>
  )
}

export default Plugin.define({
  id: "local.pacman-tokens",
  setup(context) {
    const [, updateSettings] = context.storage.store("settings", { initial: { openrouterKey: "" } })

    // The OpenRouter key is stored by OpenCode, never in this plugin's folder.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "pacman-tokens.set-openrouter-key",
          title: "Balance: set OpenRouter key",
          group: "Balance",
          palette: true,
          slash: { name: "balance", aliases: ["saldo"] },
          run: async () => {
            const key = await context.ui.dialog.prompt({
              title: "OpenRouter key",
              placeholder: "sk-or-...",
            })
            if (!key?.trim()) return
            await updateSettings((draft: { openrouterKey: string }) => {
              draft.openrouterKey = key.trim()
            })
            context.ui.toast.show({ message: "Key saved", variant: "success" })
          },
        },
      ],
    }))

    return context.ui.slot({
      append: "session.composer.top",
      render: (input) => <EcgBar sessionID={input.sessionID} />,
    })
  },
})
