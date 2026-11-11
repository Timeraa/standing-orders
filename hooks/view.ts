// View: what the status band and the Autopilot pane say, as plain data. The mod's state
// goes in and labels, flags, numbers and already-fitted text come out; register.tsx draws
// them (layout, colours, buttons) and wires the buttons to the engine. Every derivation the
// two surfaces share (the mode, the effort wording, the cache clock, the meters, the
// Needs you count) is made once, here, and the narrow-width wording rules live here too.
// No `$` in this file, and no JSX: it is held through its two functions and nothing else.
import type { Check, Counts, EffortView, LogEntry, Run, Vitals } from '../types'
import { checkAge, checkLife, shownChecks, type CheckRow } from './checks'
import { INTRO, cap, clock, isPick, logBody, logHead } from './judges'

// ---- the rules ----------------------------------------------------------

/** Below this many columns the band and the pane use short words and stack their rows. */
export const NARROW_BELOW = 80
const BAND_COLUMNS = 100 // the band's width when the host does not say
const PANE_COLUMNS = 60 // the pane's width when the host does not say
const PANE_MIN_COLUMNS = 30
/** The pane draws bars (motion on, terminal) from this many columns. */
const BARS_FROM = 48
const BAR_MAX = 24
/** A new entry stays highlighted this long (the module's flash itself lasts under a second). */
export const FLASH_WINDOW_MS = 1500
/** The band's Needs you note keeps at least this much of the question before it gives "+N more" up. */
const NOTE_MIN_TEXT = 8
export const NEEDS_LABEL = '⚠ Needs you:'

/** Meters run green, yellow, red. */
export const heat = (percent: number) => (percent >= 90 ? 'red' : percent >= 70 ? 'yellow' : 'green')
/** Effort runs cool to hot (a level without a colour, `max`, takes the default one). */
const EFFORT_COLOR: Record<string, string> = { low: 'green', medium: 'cyan', high: 'magenta', xhigh: 'red' }
export const effortColor = (level: string | null | undefined) => (level ? EFFORT_COLOR[level] : undefined)

// ---- the input ----------------------------------------------------------

/** The atoms both surfaces read. */
export type Snapshot = {
  run: Run
  checks: readonly Check[]
  isPaused: boolean
  mode: 'draft' | 'auto'
  effort: EffortView
  vitals: Vitals
}

/** What only the pane reads on top of it. */
export type PaneSnapshot = Snapshot & {
  log: readonly LogEntry[]
  counts: Counts
  isChecksOpen: boolean
}

// ---- shared derivations -------------------------------------------------

export type ModeKey = 'paused' | 'auto' | 'draft'
const MODE_ICON: Record<ModeKey, string> = { paused: '⏸', auto: '▶', draft: '✎' }
const modeKey = (s: Snapshot): ModeKey => (s.isPaused ? 'paused' : s.mode)

/** Time left on the prompt cache (ms; at or under 0 once cold), null before the first response. */
export const cacheLeft = (v: Vitals) => (v.lastResponseAt ? v.cacheTtlMin * 60_000 - (v.now - v.lastResponseAt) : null)

export type Meter = {
  name: 'ctx' | 'limit' | 'cache'
  /** A colour name. */
  tone: string
  /** 0 to 100, for a bar. */
  percent: number
  /** How the pane says it: "41%", "51:40 left", "cold". */
  text: string
  /** How the band says it in a narrow column: "ctx 41%", "cache 51:40", "cache cold". */
  label: string
  /** How the band says it from 80 columns: "context 41%", "usage limit 20%", "prompt cache 51:40". */
  wideLabel: string
  /** The name padded so the bars line up. */
  barName: string
}

/** What each meter's short name means, for the pane (the band is too narrow to say it). */
const METER_MEANING = {
  ctx: 'ctx = how much of this chat\'s context window is used',
  limit: 'limit = how much of your usage limit is used',
  cache: 'cache = how long the prompt cache stays warm; replying before it ends is cheaper',
} as const

/** Context, usage limit and prompt cache, in that order, those with a value. */
export function meters(v: Vitals): Meter[] {
  const out: Meter[] = []
  const pct = (name: 'ctx' | 'limit', p: number) => {
    const text = `${Math.round(p)}%`
    const wide = name === 'ctx' ? 'context' : 'usage limit'
    out.push({ name, tone: heat(p), percent: p, text, label: `${name} ${text}`, wideLabel: `${wide} ${text}`, barName: name.padEnd(5) })
  }
  if (v.contextPercent !== null) pct('ctx', v.contextPercent)
  if (v.ratePercent !== null) pct('limit', v.ratePercent)
  const left = cacheLeft(v)
  if (left !== null) {
    const isCold = left <= 0
    out.push({
      name: 'cache',
      tone: isCold ? 'yellow' : 'cyan',
      percent: isCold ? 0 : (left / (v.cacheTtlMin * 60_000)) * 100,
      text: isCold ? 'cold' : `${clock(left)} left`,
      label: isCold ? 'cache cold' : `cache ${clock(left)}`,
      wideLabel: isCold ? 'prompt cache cold' : `prompt cache ${clock(left)}`,
      barName: 'cache',
    })
  }
  return out
}

/** How many things wait on the person: the question Claude asked, and the open checks. */
export const needsCount = (s: { run: Run; checks: readonly unknown[] }) => (s.run.pending ? 1 : 0) + s.checks.length

// ---- the Needs you note in the band ------------------------------------

const ellipsize = (text: string, n: number) => (n <= 0 ? '' : text.length <= n ? text : n === 1 ? '…' : `${text.slice(0, n - 1)}…`)

/**
 * The question's first line, cut at the end of its first sentence (a full stop, ! or ?
 * that a capital, digit or quote follows, so "v1.2", "e.g. this" and "a? b" stay whole).
 */
export function firstSentence(text: string) {
  const line = (text.split('\n').find(l => l.trim()) ?? '').trim().replace(/\s+/g, ' ')
  return /^(.+?[.!?]["')\]]?)(?=\s+[^a-z\s])/.exec(line)?.[1] ?? line
}

export type NeedsNote = {
  /** "⚠ Needs you:" (drawn yellow and bold). */
  label: string
  /** The question's first sentence, ellipsized to leave the label and the tail room on one line ('' when there is none). */
  text: string
  /** "+2 more" when other things wait too (drawn dim), or '' (also when the line is too short to spare it). */
  more: string
}

/** The one line the band prints for a question Claude is waiting on, `others` more items waiting, in `width` columns. */
export function needsNote(pending: string, others: number, width: number): NeedsNote {
  const room = Math.max(0, width - NEEDS_LABEL.length - 1)
  const more = others > 0 ? `+${others} more` : ''
  const hasMore = more !== '' && room >= more.length + 1 + NOTE_MIN_TEXT
  return { label: NEEDS_LABEL, text: ellipsize(firstSentence(pending), hasMore ? room - more.length - 1 : room), more: hasMore ? more : '' }
}

// ---- the band -----------------------------------------------------------

export type BandView = {
  isNarrow: boolean
  /** The mode button: "✎ Replies: draft", narrow "✎ draft". */
  mode: { key: ModeKey; label: string }
  /** Answers given since the person's last typed prompt. */
  answered: number
  effort: {
    isJudging: boolean
    /** "Sonnet · High (yours) · capped", narrow "Sonnet·High*"; '' before the first request. */
    text: string
    color: string | undefined
  }
  meters: Meter[]
  /** The hint for a repo without orders. */
  hint: string
  /** The Autopilot button: "Autopilot · 7 to do", narrow "Autopilot · 7". */
  autopilot: string
  /** The line under the parts, or null when Claude is not waiting on a question. */
  note: NeedsNote | null
}

export function bandView(s: Snapshot, o: { columns?: number }): BandView {
  const width = o.columns ?? BAND_COLUMNS
  const isNarrow = width < NARROW_BELOW
  const key = modeKey(s)
  const wide = { paused: 'Replies paused', auto: 'Replies: auto', draft: 'Replies: draft' }[key]
  const ev = s.effort
  const open = s.checks.length
  return {
    isNarrow,
    mode: { key, label: `${MODE_ICON[key]} ${isNarrow ? key : wide}` },
    answered: s.run.autoCount,
    effort: {
      isJudging: ev.isJudging,
      text: ev.level
        ? `${ev.model ? `${cap(ev.model)}${isNarrow ? '·' : ' · '}` : ''}${cap(ev.level)}${ev.isAuto ? '' : isNarrow ? '*' : ev.why === 'paused' ? ' (paused)' : ' (yours)'}${ev.isSaving ? ' · capped' : ''}`
        : '',
      color: effortColor(ev.level),
    },
    meters: meters(s.vitals),
    hint: isNarrow ? 'no repo orders' : 'no repo orders: /orders init',
    autopilot: open > 0 ? `Autopilot · ${open}${isNarrow ? '' : ' to do'}` : 'Autopilot',
    note: s.run.pending ? needsNote(s.run.pending, open, width) : null,
  }
}

// ---- the pane -----------------------------------------------------------

export type CheckItem = {
  item: CheckRow
  /** The text to show: the whole check, or what is left after its group's lead. */
  text: string
  /** "3h" */
  age: string
  /** "drops in 5h" in the last day of its life, else ''. */
  life: string
  /** Drawn as a highlight: the newest, and found just now (terminal with motion only). */
  isFlash: boolean
  /** What the highlight says. */
  flashBody: string
}
export type CheckGroupView = { lead: string | null; items: CheckItem[] }

export type ActivityRow = {
  /** When it happened (ms): a highlight is keyed by it. */
  at: number
  /** "✓  2m" at the pane's last tick. */
  head: string
  /** The same head at the clock's now: what a highlight shows. */
  flashHead: string
  body: string
  /** A pick the mod made, not a decision: drawn dim. */
  isPick: boolean
  /** Drawn as a highlight: the newest, and just in (terminal with motion only). */
  isFlash: boolean
}

export type PaneView = {
  width: number
  /** One row per item with its buttons beside it; narrow, the buttons sit under the text. */
  isWide: boolean
  mode: {
    key: ModeKey
    /** "✎ Draft" */
    label: string
    /** "answered 2 of 8" */
    answered: string
    /** One sentence on what the mode does. */
    note: string
    tone: string
    /** The mode the first button goes to, and its label. */
    toggleTo: 'draft' | 'auto'
    toggleLabel: string
    pauseLabel: string
  }
  effort:
    | { kind: 'judging' }
    | { kind: 'none' }
    | { kind: 'level'; color: string | undefined; title: string; note: string | null }
  needs: {
    count: number
    hasAny: boolean
    /** The question Claude is waiting on, whole (the card wraps it). */
    pending: string | null
    groups: CheckGroupView[]
    /** The open checks that the short list leaves out. */
    older: number
    /** "+3 older" or "Show fewer"; the button shows only when `older > 0`. */
    olderLabel: string
    canClearAll: boolean
  }
  activity: {
    rows: ActivityRow[]
    /** "picked this session: effort high ×2 · new chats opus ×1 · subagents ×1", or null when nothing was picked. */
    tally: string | null
  }
  usage: {
    kind: 'none' | 'inline' | 'bars'
    meters: Meter[]
    barWidth: number
    /** What each shown meter's name means, one line each. */
    legend: string[]
  }
  /** The "What is this?" lines: only while the pane has nothing to show yet (no answers, no activity, nothing waiting). */
  intro: readonly string[] | null
}

/** The pane's width: what the host says, never under 30. */
export const paneWidth = (columns?: number) => Math.max(PANE_MIN_COLUMNS, columns ?? PANE_COLUMNS)

export function paneView(s: PaneSnapshot, o: { columns?: number; fx: boolean; now: number; maxAuto: number }): PaneView {
  const width = paneWidth(o.columns)
  const isWide = width >= NARROW_BELOW
  const v = s.vitals
  const ev = s.effort
  const key = modeKey(s)
  const fresh = (at: number) => o.fx && o.now - at >= 0 && o.now - at < FLASH_WINDOW_MS

  const count = needsCount(s)
  const { groups, older } = shownChecks(s.checks, s.isChecksOpen)
  const recent = [...s.log].reverse().slice(0, 8)
  const tl = s.counts
  const hasTally = Object.keys(tl.effort).length > 0 || Object.keys(tl.models).length > 0 || tl.subagents > 0
  const all = meters(v)
  const has = (why: string) => !!why && why !== 'auto'

  return {
    width,
    isWide,
    mode: {
      key,
      label: `${MODE_ICON[key]} ${cap(key)}`,
      answered: `answered ${s.run.autoCount} of ${o.maxAuto}`,
      note:
        key === 'paused'
          ? 'Paused: Claude\'s questions wait for you.'
          : key === 'auto'
            ? `Auto: an answer your orders cover is sent for you, up to ${o.maxAuto} in a row.`
            : 'Draft: an answer your orders cover is typed into your prompt box; Enter sends it.',
      tone: key === 'paused' ? 'yellow' : key === 'auto' ? 'green' : 'cyan',
      toggleTo: s.mode === 'auto' ? 'draft' : 'auto',
      toggleLabel: s.mode === 'auto' ? 'Draft' : 'Auto',
      pauseLabel: s.isPaused ? '▶ Resume' : '⏸ Pause',
    },
    effort: ev.isJudging
      ? { kind: 'judging' }
      : ev.level
        ? {
            kind: 'level',
            color: effortColor(ev.level),
            title: `${ev.model ? `${cap(ev.model)} · ` : ''}${cap(ev.level)}`,
            note:
              !ev.isAuto || has(ev.why) || ev.isSaving
                ? `${!ev.isAuto ? (ev.why === 'paused' ? 'paused' : 'set by you') : has(ev.why) ? ev.why : ''}${ev.isSaving ? `${has(ev.why) ? ' · ' : ''}capped by usage limit` : ''}`
                : null,
          }
        : { kind: 'none' },
    needs: {
      count,
      hasAny: count > 0,
      pending: s.run.pending || null,
      groups: groups.map(g => ({
        lead: g.lead,
        items: g.items.map(({ item, text }) => {
          const age = v.now - item.at
          return {
            item,
            text,
            age: checkAge(age),
            life: checkLife(age),
            isFlash: item.slot === 0 && fresh(item.at),
            flashBody: `${text} · ${checkAge(age)}`,
          }
        }),
      })),
      older,
      olderLabel: s.isChecksOpen ? 'Show fewer' : `+${older} older`,
      canClearAll: s.checks.length > 1,
    },
    activity: {
      rows: recent.map((l, i) => ({
        at: l.at,
        head: logHead(l, v.now),
        flashHead: logHead(l, o.now),
        body: logBody(l),
        isPick: isPick(l.kind),
        isFlash: i === 0 && fresh(l.at),
      })),
      tally: hasTally
        ? `picked this session: ${[
            ...(Object.keys(tl.effort).length > 0 ? [`effort${Object.entries(tl.effort).map(([k, n]) => ` ${k} ×${n}`).join('')}`] : []),
            ...(Object.keys(tl.models).length > 0 ? [`new chats${Object.entries(tl.models).map(([k, n]) => ` ${k} ×${n}`).join('')}`] : []),
            ...(tl.subagents > 0 ? [`subagents ×${tl.subagents}`] : []),
          ].join(' · ')}`
        : null,
    },
    usage: {
      kind: all.length === 0 ? 'none' : o.fx && width >= BARS_FROM ? 'bars' : 'inline',
      meters: all,
      barWidth: Math.min(BAR_MAX, width - 28),
      legend: all.map(m => METER_MEANING[m.name]),
    },
    intro: s.log.length === 0 && s.run.autoCount === 0 && count === 0 ? INTRO : null,
  }
}
