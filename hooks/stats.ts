// Stats: what the autopilot costs and what it saves, as plain data. The ledger counts
// tokens (never dollars) per day, split by what spent them, so a changed price table
// reprices the whole history. Dollars here are API list prices: a plan (Max, Ultra) shows
// no bill, but its usage limit drains in proportion, so "API-equivalent" is the common unit.
//   spent   the mod's own Haiku calls (judge, effort pick, model pick, subagent pick): measured
//   runs    every request the chat or a subagent made, by the model it ran on and the model it
//           would have run on without the mod: the same tokens repriced = the model saving, measured
//   effort  requests whose effort differs from the session's own: tokens are measured, the saving
//           is an ESTIMATE (the run that did not happen cannot be measured), kept apart from the net
// No `$` in this file: register.tsx records into it and draws what summarize() returns.

// ---- the shapes ---------------------------------------------------------

import type { Day, Ledger, PeriodKey, Tok } from '../types'
export type { Day, Ledger, PeriodKey, Tok }


/** The API's four counts, as `usage` carries them. */
export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export const EMPTY: Ledger = { days: {} }

// ---- the prices ---------------------------------------------------------

/** USD per million tokens; a cache write costs 1.25 × input. First-party list prices, not a plan's. */
export const PRICES: Record<string, { in: number; out: number; read: number }> = {
  haiku: { in: 0.1, out: 0.5, read: 0.01 },
  sonnet: { in: 2, out: 10, read: 0.2 },
  opus: { in: 4, out: 20, read: 0.2 },
  fable: { in: 10, out: 50, read: 0.25 },
}
export const PRICES_AS_OF = '2026-10-06'

/** "claude-sonnet-5-5" and "sonnet" are both "sonnet". */
export const shortModel = (m: string) => /(haiku|sonnet|opus|fable)/i.exec(m)?.[1]?.toLowerCase() ?? (m || '?')

/** API-equivalent dollars for tokens on a model, or null for a model without a price. */
export function cost(model: string, t: Tok): number | null {
  const p = PRICES[model]
  return p ? (t.i * p.in + t.o * p.out + t.r * p.read + t.w * p.in * 1.25) / 1e6 : null
}

// What a level is assumed to cost in output (thinking) tokens against `high` = 1. NOT measured:
// the pane prints these, next to the averages the person's own requests show, and counts the result apart.
export const EFFORT_WEIGHT: Record<string, number> = { low: 0.35, medium: 0.6, high: 1, xhigh: 1.5, max: 2 }
/** The estimate's honesty band: it is shown as this fraction of the point estimate up to this one. */
export const EFFORT_BAND = [0.5, 1.5] as const

// ---- recording (pure: a ledger in, a ledger out) -------------------------

const ZERO: Tok = { n: 0, i: 0, o: 0, r: 0, w: 0 }
const plus = (a: Tok = ZERO, b: Tok): Tok => ({ n: a.n + b.n, i: a.i + b.i, o: a.o + b.o, r: a.r + b.r, w: a.w + b.w })
const tokOf = (u: Usage): Tok => ({ n: 1, i: u.input_tokens || 0, o: u.output_tokens || 0, r: u.cache_read_input_tokens || 0, w: u.cache_creation_input_tokens || 0 })
const mergeTokMap = (a: Record<string, Tok>, b: Record<string, Tok>) => {
  const out = { ...a }
  for (const [k, t] of Object.entries(b)) out[k] = plus(out[k], t)
  return out
}
const EMPTY_DAY: Day = { spent: {}, runs: {}, effort: {}, levels: {} }

/** The local calendar date of a time (ms). */
export const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const into = (l: Ledger, date: string, bucket: keyof Day, key: string, t: Tok): Ledger => {
  const day = l.days[date] ?? EMPTY_DAY
  return { days: { ...l.days, [date]: { ...day, [bucket]: { ...day[bucket], [key]: plus(day[bucket][key], t) } } } }
}

/** A Haiku call the mod made itself. */
export const recordSpent = (l: Ledger, date: string, kind: string, u: Usage) => into(l, date, 'spent', kind, tokOf(u))

export type RunInput = {
  who: 'chat' | 'agent'
  usage: Usage & { model: string }
  /** The model the request would have run on without the mod (the session's own); left out, the one it ran on. */
  wouldModel?: string | undefined
  /** The effort it ran at and the one the session had set; a model without effort has none. */
  ranEffort?: unknown
  wouldEffort?: unknown
}

/** A request the chat or a subagent made. */
export function recordRun(l: Ledger, date: string, r: RunInput): Ledger {
  const ran = shortModel(r.usage.model)
  const would = r.wouldModel ? shortModel(r.wouldModel) : ran
  const t = tokOf(r.usage)
  const ranE = typeof r.ranEffort === 'string' ? r.ranEffort : null
  const wouldE = typeof r.wouldEffort === 'string' ? r.wouldEffort : null
  let out = into(l, date, 'runs', `${r.who}|${ran}|${would}`, t)
  out = into(out, date, 'levels', ranE ?? 'none', t)
  if (ranE && wouldE && ranE !== wouldE) out = into(out, date, 'effort', `${ran}|${ranE}|${wouldE}`, t)
  return out
}

/** Two ledgers as one; days older than `keepDays` before `today` are dropped. */
export function merge(a: Ledger, b: Ledger, today?: string, keepDays = 90): Ledger {
  const days: Record<string, Day> = { ...a.days }
  for (const [date, d] of Object.entries(b.days)) {
    const x = days[date] ?? EMPTY_DAY
    days[date] = { spent: mergeTokMap(x.spent, d.spent), runs: mergeTokMap(x.runs, d.runs), effort: mergeTokMap(x.effort, d.effort), levels: mergeTokMap(x.levels, d.levels) }
  }
  if (today) {
    const cut = dayKey(Date.parse(`${today}T12:00:00`) - keepDays * 86_400_000)
    for (const date of Object.keys(days)) if (date < cut) delete days[date]
  }
  return { days }
}

// ---- summarizing --------------------------------------------------------

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'day', label: 'Today' },
  { key: 'week', label: '7 days' },
  { key: 'all', label: 'All time' },
]

/** Dollars (API-equivalent) and tokens of one line of the table. */
export type Amount = { usd: number; tokens: number }

export type Totals = {
  requests: number
  /** Cost the mod's own Haiku calls added. */
  spent: Amount
  /** Saved by running on a cheaper model than the session's own (negative: a dearer one). Measured. */
  saved: Amount
  /** saved − spent. Measured. */
  net: number
  /** The effort estimate: point, low and high (negative: effort ran higher than your own). Not in `net`. */
  effortUsd: { point: number; low: number; high: number }
  /** net plus the effort point estimate. */
  netWithEffort: number
  /** Requests on a model without a price (left out of every dollar figure). */
  unpriced: number
}

export type Route = { who: 'chat' | 'agent'; ran: string; would: string; n: number; tokens: number; ranUsd: number; wouldUsd: number; savedUsd: number }
export type Judge = { kind: string; n: number; tokensIn: number; tokensOut: number; usd: number }
export type EffortRow = { model: string; ran: string; would: string; n: number; outTokens: number; estUsd: number }
export type LevelRow = { level: string; n: number; avgOut: number }

export type Summary = {
  period: PeriodKey
  /** Totals for all three periods (the table's columns). */
  totals: Record<PeriodKey, Totals>
  /** The detail of the chosen period. */
  routes: Route[]
  /** Requests that ran on the model they would have run on anyway. */
  unchanged: { n: number; tokens: number; usd: number }
  judges: Judge[]
  efforts: EffortRow[]
  levels: LevelRow[]
  /** The earliest day with any record, or null. */
  since: string | null
}

const sumTok = (m: Record<string, Tok>) => Object.values(m).reduce((a, t) => plus(a, t), ZERO)
const allTok = (t: Tok) => t.i + t.o + t.r + t.w

function daysIn(l: Ledger, period: PeriodKey, today: string): Day[] {
  const from = period === 'day' ? today : period === 'week' ? dayKey(Date.parse(`${today}T12:00:00`) - 6 * 86_400_000) : ''
  return Object.entries(l.days).filter(([d]) => d >= from && d <= today).map(([, d]) => d)
}

const flat = (days: Day[], bucket: keyof Day) => days.reduce((m, d) => mergeTokMap(m, d[bucket]), {} as Record<string, Tok>)

function totalsOf(days: Day[]): Totals {
  const runs = flat(days, 'runs')
  let saved = 0
  let movedTokens = 0
  let unpriced = 0
  let requests = 0
  for (const [key, t] of Object.entries(runs)) {
    const [, ran = '', would = ''] = key.split('|')
    requests += t.n
    const a = cost(ran, t)
    const b = cost(would, t)
    if (a === null || b === null) {
      unpriced += t.n
    } else if (ran !== would) {
      saved += b - a
      movedTokens += allTok(t)
    }
  }
  const spentMap = flat(days, 'spent')
  const spent = { usd: Object.values(spentMap).reduce((s, t) => s + (cost('haiku', t) ?? 0), 0), tokens: allTok(sumTok(spentMap)) }
  let point = 0
  for (const e of effortRows(days)) point += e.estUsd
  const [lo, hi] = EFFORT_BAND
  const net = saved - spent.usd
  return {
    requests,
    spent,
    saved: { usd: saved, tokens: movedTokens },
    net,
    effortUsd: { point, low: point * (point < 0 ? hi : lo), high: point * (point < 0 ? lo : hi) },
    netWithEffort: net + point,
    unpriced,
  }
}

function effortRows(days: Day[]): EffortRow[] {
  return Object.entries(flat(days, 'effort')).flatMap(([key, t]) => {
    const [model = '', ran = '', would = ''] = key.split('|')
    const a = EFFORT_WEIGHT[ran]
    const b = EFFORT_WEIGHT[would]
    const p = PRICES[model]
    if (!a || !b || !p) return []
    // Output at the effort it would have had, less what it had: tokens priced at the model's output rate.
    return [{ model, ran, would, n: t.n, outTokens: t.o, estUsd: ((t.o * b) / a - t.o) * p.out / 1e6 }]
  })
}

/** Everything the Savings tab draws, for `today` (a dayKey). */
export function summarize(l: Ledger, today: string, period: PeriodKey): Summary {
  const days = daysIn(l, period, today)
  const routes: Route[] = []
  const unchanged = { n: 0, tokens: 0, usd: 0 }
  for (const [key, t] of Object.entries(flat(days, 'runs'))) {
    const [who = 'chat', ran = '', would = ''] = key.split('|')
    const a = cost(ran, t)
    const b = cost(would, t)
    if (a === null || b === null) continue
    if (ran === would) {
      unchanged.n += t.n
      unchanged.tokens += allTok(t)
      unchanged.usd += a
    } else {
      routes.push({ who: who as Route['who'], ran, would, n: t.n, tokens: allTok(t), ranUsd: a, wouldUsd: b, savedUsd: b - a })
    }
  }
  routes.sort((x, y) => Math.abs(y.savedUsd) - Math.abs(x.savedUsd))
  const judges = Object.entries(flat(days, 'spent')).map(([kind, t]) => ({
    kind,
    n: t.n,
    tokensIn: t.i + t.r + t.w,
    tokensOut: t.o,
    usd: cost('haiku', t) ?? 0,
  }))
  judges.sort((x, y) => y.usd - x.usd)
  const levels = Object.entries(flat(days, 'levels'))
    .map(([level, t]) => ({ level, n: t.n, avgOut: t.n ? Math.round(t.o / t.n) : 0 }))
    .sort((x, y) => (EFFORT_WEIGHT[x.level] ?? 9) - (EFFORT_WEIGHT[y.level] ?? 9))
  const dates = Object.keys(l.days).sort()
  return {
    period,
    totals: { day: totalsOf(daysIn(l, 'day', today)), week: totalsOf(daysIn(l, 'week', today)), all: totalsOf(daysIn(l, 'all', today)) },
    routes,
    unchanged,
    judges,
    efforts: effortRows(days).sort((x, y) => Math.abs(y.estUsd) - Math.abs(x.estUsd)),
    levels,
    since: dates[0] ?? null,
  }
}

// ---- words --------------------------------------------------------------

/** "$0.84", "$0.0042", "−$0.06"; the sign is always shown for a saving or a cost. */
export function usd(n: number, signed = false) {
  const a = Math.abs(n)
  const body = a === 0 ? '0.00' : a < 0.01 ? a.toFixed(4) : a < 10 ? a.toFixed(2) : a.toFixed(0)
  return `${n < 0 ? '−' : signed && n > 0 ? '+' : ''}$${body}`
}

/** "412", "12.4K", "1.2M". */
export function tok(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(Math.round(n))
}

export const JUDGE_NAMES: Record<string, string> = {
  verdict: 'End-of-turn judge',
  effort: 'Effort pick',
  'chat-model': 'New-chat model pick',
  subagent: 'Subagent pick',
}

/** The one-sentence verdict over the headline numbers: the likely picture first, what is measured and what is not said plainly. */
export function verdict(t: Totals): string {
  if (t.requests === 0 && t.spent.tokens === 0) return 'Nothing recorded yet. Use Claude Code with auto effort, model or subagents on and this fills in.'
  if (t.net >= 0) return `Saving you ${usd(t.net)} in API-equivalent usage, measured${t.effortUsd.point > 0 ? `, plus about ${usd(t.effortUsd.point)} more from lower effort (an estimate)` : ''}.`
  const measured = `Measured alone it is ${usd(t.net, true)}: its own calls cost ${usd(t.spent.usd)} and model picks saved ${usd(t.saved.usd)}.`
  if (t.netWithEffort >= 0) return `Probably saving you about ${usd(t.netWithEffort)}, almost all from lower effort, which cannot be measured exactly. ${measured}`
  return `Costing you about ${usd(-t.netWithEffort)} more than it saves, even counting the effort estimate. ${measured}`
}
