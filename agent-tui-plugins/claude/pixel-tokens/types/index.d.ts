export type Gauge = {
  /** Input tokens of the last response; absent before the first one. */
  tokens?: number
  /** The model's context window, in tokens. */
  window: number
  /** Percent of the five-hour rate-limit window used; absent off a subscription. */
  fiveHour?: number
  /** Percent of the seven-day (weekly) rate-limit window used; absent off a subscription. */
  weekly?: number
  /** When the five-hour window reopens, in epoch milliseconds; absent if the session does not report it. */
  fiveHourResetsAt?: number
  /** When the seven-day window reopens, in epoch milliseconds; absent if the session does not report it. */
  weeklyResetsAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'pixel-tokens': { gauge: Gauge | null }
  }
}
