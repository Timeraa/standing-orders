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
  /** Why the judge picked it ("kept" for a follow-up). */
  why: string
  /** False once the person set effort themselves, or effort: off. */
  isAuto: boolean
  /** True while the judge is deciding. */
  isJudging: boolean
  /** True when a usage limit is past 85% and effort is capped at medium. */
  isSaving: boolean
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

/** One loop as the crew pane lists it; `main` is the main conversation. */
export type CrewRow = {
  id: string
  name: string
  type: string
  status: string
  model: string
  startedAt: number
  lastAt: number
  lastTool: string
  tools: number
  /** The agent that spawned this one; absent when the main loop did. */
  parentId?: string
}

/** One judge decision, for the crew pane's "what the orders did". */
export type LogEntry = {
  at: number
  kind: 'answered' | 'drafted' | 'asked' | 'stopped'
  /** The reply sent or drafted, the question, or the summary. */
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    'standing-orders': {
      run: Run
      isPaused: boolean
      /** draft: the answer waits in the prompt box for Enter. auto: it is sent. */
      mode: 'draft' | 'auto'
      /** Checks only the person can do (devices, accounts, other people). */
      checks: string[]
      effort: EffortView
      vitals: Vitals
      crew: CrewRow[]
      log: LogEntry[]
    }
  }
}
