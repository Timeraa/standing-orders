/** The autopilot run since the person's last typed prompt. */
export type Run = {
  /** Turns answered by the standing orders this run. */
  autoCount: number
  /** When the person's last prompt went in (ms), 0 before any. */
  startedAt: number
  /** The decision Claude is waiting on, or null. */
  pending: string | null
  /** The answer last drafted or sent, or null. */
  last: string | null
}

/** The effort autopilot's view of the current prompt. */
export type EffortView = {
  /** The level the main loop runs at, or null before the first request. */
  level: string | null
  /** The model the main loop runs on (a pick, or the chat's own), null before the first request. */
  model?: string | null
  /** Why the judge picked it ("kept" for a follow-up). */
  why: string
  /** False once the person set effort themselves, or effort: off. */
  isAuto: boolean
  /** True while the judge is deciding. */
  isJudging: boolean
  /** True when a usage limit is past 85% and effort is capped at medium. */
  isSaving: boolean
}

/** What the mod did this session, for the Autopilot pane. */
export type Counts = {
  /** Prompts run at each effort level. */
  effort: Record<string, number>
  /** Models picked for new chats and subagents. */
  models: Record<string, number>
  subagents: number
}

/** Numbers the band shows, refreshed on a timer. */
export type Vitals = {
  now: number
  contextPercent: number | null
  /** When the main loop's last response ended (ms), 0 before any. */
  lastResponseAt: number
  cacheTtlMin: number
  ratePercent: number | null
  /** False in a repo without its own .claude/standing-orders.md. */
  hasRepoOrders: boolean
}

/** A thing only the person can do (device, account, other people). */
export type Check = {
  text: string
  /** When it was found (ms); it expires three days later. */
  at: number
  /** The chat that found it; that chat's next list replaces it. */
  chat: string
}

/** One line of the Autopilot pane's Activity feed. */
export type LogEntry = {
  at: number
  /** Decisions of the judge, then the picks the mod made (effort, a new chat's model, a subagent). */
  kind: 'answered' | 'drafted' | 'asked' | 'stopped' | 'effort' | 'model' | 'subagent'
  /** The reply sent or drafted, the question, the summary, or a pick ("high · multi-file feature"). */
  text: string
}

/** Tokens of one bucket: requests, uncached input, output, cache reads, cache writes. */
export type Tok = { n: number; i: number; o: number; r: number; w: number }

/** Requests, output tokens and the sum of their squares: enough to compare two groups with a confidence range. */
export type Audit = { n: number; o: number; q: number }

/** One day of the stats ledger (see hooks/stats.ts for what each bucket counts). */
export type Day = {
  spent: Record<string, Tok>
  runs: Record<string, Tok>
  effort: Record<string, Tok>
  levels: Record<string, Tok>
  /** Chat requests after an effort change, or after none (older records have none). */
  cache?: Record<string, Tok>
  /** Audited turns' requests by `model|auto` and `model|held` (older records have none). */
  audit?: Record<string, Audit>
}

/** Days by local date (YYYY-MM-DD). */
export type Ledger = { days: Record<string, Day> }

/** The Savings tab's period. */
export type PeriodKey = 'day' | 'week' | 'all'

declare module 'claude-code' {
  interface PluginState {
    'standing-orders': {
      run: Run
      isPaused: boolean
      /** draft: the answer waits in the prompt box for Enter. auto: it is sent. */
      mode: 'draft' | 'auto'
      /** Checks only the person can do (devices, accounts, other people). */
      checks: Check[]
      /** True while the Autopilot pane lists every open check, not just the newest. */
      isChecksOpen: boolean
      /** The Autopilot pane's open tab. */
      tab: 'now' | 'settings' | 'savings'
      effort: EffortView
      counts: Counts
      vitals: Vitals
      log: LogEntry[]
      /** Tokens the autopilot spent and moved, by day (see hooks/stats.ts). */
      stats: Ledger
      /** The Savings tab's period. */
      statsPeriod: PeriodKey
    }
  }
}
