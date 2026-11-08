// Stats: what the autopilot costs and what it saves, as plain data. The ledger counts
// tokens (never dollars) per day, split by what spent them, so a changed price table
// reprices the whole history. Dollars here are API list prices: a plan (Max, Ultra) shows
// no bill, but its usage limit drains in proportion, so "API-equivalent" is the common unit.
//   spent   the mod's own Haiku calls (judge, effort pick, model pick, subagent pick): measured
//   runs    every request the chat or a subagent made, by the model it ran on and the model it
//           would have run on without the mod: the same tokens repriced = the model saving, measured
//   cache   chat requests right after an effort change vs after none: did the change rebuild the
//           prompt cache? Measured from cache-write tokens; the extra writes are a cost
//   audit   with the Savings audit on, a random share of turns runs at the session's own effort.
//           Random assignment makes the two groups comparable, so the difference in output tokens
//           per request is the effort effect, measured, with a 95% range. This is the proof.
//   effort  the fallback when no audit data exists: an assumed output-per-level table (an ESTIMATE)
// No `$` in this file: register.tsx records into it and draws what summarize() returns.

// ---- the shapes ---------------------------------------------------------

import type { Audit, Day, Ledger, PeriodKey, Tok } from '../types'
export type { Audit, Day, Ledger, PeriodKey, Tok }

/** The API's four counts, as `usage` carries them. */
export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export const EMPTY: Ledger = { days: {} }

/** The share of audited turns that run at the session's own effort. */
export const AUDIT_SHARE = 0.2
/**
 * Whether an audited turn runs at the session's own effort. A hash of the turn's id, uniform and unrelated
 * to what was typed, so it assigns turns as a coin would, and a test can say which ids land where.
 */
export function isHeld(turnId: string): boolean {
  let h = 2166136261
  for (let i = 0; i < turnId.length; i++) h = Math.imul(h ^ turnId.charCodeAt(i), 16777619)
  return ((h >>> 0) % 1000) / 1000 < AUDIT_SHARE
}
/** Requests each group needs before the audit says anything. */
export const AUDIT_MIN = 10
/** Requests each group needs before the cache check says anything. */
export const CACHE_MIN = 3

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
// used only while the audit has no data, and printed next to the person's own numbers.
export const EFFORT_WEIGHT: Record<string, number> = { low: 0.35, medium: 0.6, high: 1, xhigh: 1.5, max: 2 }
/** The assumed estimate's honesty band: shown as this fraction of the point estimate up to this one. */
export const EFFORT_BAND = [0.5, 1.5] as const

// ---- recording (pure: a ledger in, a ledger out) -------------------------

const ZERO: Tok = { n: 0, i: 0, o: 0, r: 0, w: 0 }
const plus = (a: Tok = ZERO, b: Tok): Tok => ({ n: a.n + b.n, i: a.i + b.i, o: a.o + b.o, r: a.r + b.r, w: a.w + b.w })
const plusAudit = (a: Audit = { n: 0, o: 0, q: 0 }, b: Audit): Audit => ({ n: a.n + b.n, o: a.o + b.o, q: a.q + b.q })
const tokOf = (u: Usage): Tok => ({ n: 1, i: u.input_tokens || 0, o: u.output_tokens || 0, r: u.cache_read_input_tokens || 0, w: u.cache_creation_input_tokens || 0 })
const mergeMap = <T>(a: Record<string, T> = {}, b: Record<string, T> = {}, add: (x: T | undefined, y: T) => T) => {
  const out = { ...a }
  for (const [k, t] of Object.entries(b)) out[k] = add(out[k], t)
  return out
}
const EMPTY_DAY: Day = { spent: {}, runs: {}, effort: {}, levels: {}, cache: {}, audit: {} }

/** The local calendar date of a time (ms). */
export const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type TokBucket = 'spent' | 'runs' | 'effort' | 'levels' | 'cache'
const into = (l: Ledger, date: string, bucket: TokBucket, key: string, t: Tok): Ledger => {
  const day = l.days[date] ?? EMPTY_DAY
  return { days: { ...l.days, [date]: { ...day, [bucket]: { ...day[bucket], [key]: plus(day[bucket]?.[key], t) } } } }
}
const intoAudit = (l: Ledger, date: string, key: string, a: Audit): Ledger => {
  const day = l.days[date] ?? EMPTY_DAY
  return { days: { ...l.days, [date]: { ...day, audit: { ...day.audit, [key]: plusAudit(day.audit?.[key], a) } } } }
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
  /** Audited chat turn: `auto` ran at the pick, `held` ran at the session's own effort. */
  arm?: 'auto' | 'held' | undefined
  /** A chat request whose cache was still warm: did its effort differ from the previous request's? */
  switched?: boolean | undefined
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
  if (r.who === 'chat' && r.switched !== undefined) out = into(out, date, 'cache', `${ran}|${r.switched ? 'changed' : 'same'}`, t)
  if (r.who === 'chat' && r.arm) out = intoAudit(out, date, `${ran}|${r.arm}`, { n: 1, o: t.o, q: t.o * t.o })
  return out
}

/** Two ledgers as one; days older than `keepDays` before `today` are dropped. */
export function merge(a: Ledger, b: Ledger, today?: string, keepDays = 90): Ledger {
  const days: Record<string, Day> = { ...a.days }
  for (const [date, d] of Object.entries(b.days)) {
    const x = days[date] ?? EMPTY_DAY
    days[date] = {
      spent: mergeMap(x.spent, d.spent, plus),
      runs: mergeMap(x.runs, d.runs, plus),
      effort: mergeMap(x.effort, d.effort, plus),
      levels: mergeMap(x.levels, d.levels, plus),
      cache: mergeMap(x.cache, d.cache, plus),
      audit: mergeMap(x.audit, d.audit, plusAudit),
    }
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

export type Range = { point: number; low: number; high: number }

/** What the audit measured, per model and in all. Dollars are API-equivalent; positive means auto saved. */
export type AuditRow = { model: string; nAuto: number; nHeld: number; meanAuto: number; meanHeld: number; usd: number; half: number }
export type AuditResult = { ready: boolean; rows: AuditRow[]; usd: number; half: number; nAuto: number; nHeld: number; /** Every audited request so far, ready or not. */ seen: { auto: number; held: number } }

export type CacheResult = {
  /** Extra cache-write cost after an effort change, measured (never negative). Zero until there is enough data. */
  usd: number
  enough: boolean
  changed: number
  same: number
  /** Share of input tokens written to the cache, after a change and after none. */
  writeChanged: number
  writeSame: number
}

export type Totals = {
  requests: number
  /** Cost the mod's own Haiku calls added, in dollars and tokens. */
  spent: { usd: number; tokens: number }
  /** Saved by running on a cheaper model than the session's own (negative: a dearer one). Measured. */
  saved: { usd: number; tokens: number }
  cache: CacheResult
  /** saved − spent − cache rebuilds. Measured. */
  net: number
  /** The assumed estimate of the effort effect, from the output-per-level table. */
  assumed: Range
  audit: AuditResult
  /** The effort effect in use: the audit's when it is ready, else the assumed estimate. */
  effort: Range
  effortSource: 'audit' | 'assumed'
  /** net plus the effort effect in use. */
  total: number
  /** The 95% range of `total` when it is known (audit ready, or no effort ever differed), else null. */
  totalRange: { low: number; high: number } | null
  /** `saving` or `costing` only when the whole range is on one side of zero. */
  proof: 'saving' | 'costing' | 'unproven'
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

const flat = (days: Day[], bucket: TokBucket) => days.reduce((m, d) => mergeMap(m, d[bucket], plus), {} as Record<string, Tok>)
const flatAudit = (days: Day[]) => days.reduce((m, d) => mergeMap(m, d.audit, plusAudit), {} as Record<string, Audit>)

/** The cache check: did a chat request right after an effort change write more to the cache than one after none? */
function cacheOf(days: Day[]): CacheResult {
  const m = flat(days, 'cache')
  let usd = 0
  let changed = 0
  let same = 0
  let enough = false
  let wc: Tok = ZERO
  let ws: Tok = ZERO
  for (const model of new Set(Object.keys(m).map(k => k.split('|')[0] ?? ''))) {
    const c = m[`${model}|changed`] ?? ZERO
    const s = m[`${model}|same`] ?? ZERO
    wc = plus(wc, c)
    ws = plus(ws, s)
    changed += c.n
    same += s.n
    const p = PRICES[model]
    const totalS = s.i + s.r + s.w
    if (!p || c.n < CACHE_MIN || s.n < CACHE_MIN || totalS === 0) continue
    enough = true
    // Writes beyond what a request after no change writes, priced at write (1.25 × in) instead of read.
    const extra = Math.max(0, c.w - (s.w / totalS) * (c.i + c.r + c.w))
    usd += (extra * (p.in * 1.25 - p.read)) / 1e6
  }
  const rate = (t: Tok) => (t.i + t.r + t.w ? t.w / (t.i + t.r + t.w) : 0)
  return { usd, enough, changed, same, writeChanged: rate(wc), writeSame: rate(ws) }
}

/** The audit: output tokens per request on audited turns, auto against held at the session's own effort. */
function auditOf(days: Day[]): AuditResult {
  const a = flatAudit(days)
  const rows: AuditRow[] = []
  let usd = 0
  let varUsd = 0
  let nAuto = 0
  let nHeld = 0
  for (const model of new Set(Object.keys(a).map(k => k.split('|')[0] ?? ''))) {
    const x = a[`${model}|auto`]
    const h = a[`${model}|held`]
    const p = PRICES[model]
    if (!x || !h || !p || x.n < AUDIT_MIN || h.n < AUDIT_MIN) continue
    const mx = x.o / x.n
    const mh = h.o / h.n
    const vx = Math.max(0, (x.q - x.n * mx * mx) / (x.n - 1))
    const vh = Math.max(0, (h.q - h.n * mh * mh) / (h.n - 1))
    const scale = (x.n * p.out) / 1e6 // tokens saved per request → dollars over every auto request
    const rowUsd = (mh - mx) * scale
    const half = 1.96 * Math.sqrt(vx / x.n + vh / h.n) * scale
    rows.push({ model, nAuto: x.n, nHeld: h.n, meanAuto: mx, meanHeld: mh, usd: rowUsd, half })
    usd += rowUsd
    varUsd += half * half
    nAuto += x.n
    nHeld += h.n
  }
  const seen = { auto: 0, held: 0 }
  for (const [k, x] of Object.entries(a)) seen[k.endsWith('|held') ? 'held' : 'auto'] += x.n
  return { ready: rows.length > 0, rows, usd, half: Math.sqrt(varUsd), nAuto, nHeld, seen }
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
  const cache = cacheOf(days)
  const net = saved - spent.usd - cache.usd

  const rows = effortRows(days)
  const point = rows.reduce((s, e) => s + e.estUsd, 0)
  const [lo, hi] = EFFORT_BAND
  const assumed: Range = { point, low: point * (point < 0 ? hi : lo), high: point * (point < 0 ? lo : hi) }
  const audit = auditOf(days)
  const effort: Range = audit.ready ? { point: audit.usd, low: audit.usd - audit.half, high: audit.usd + audit.half } : assumed

  // The total is known when the audit measured the effort effect, or when effort never differed from yours.
  const known = audit.ready || rows.length === 0
  const totalRange = known ? { low: net + (audit.ready ? effort.low : 0), high: net + (audit.ready ? effort.high : 0) } : null
  const proof = totalRange === null || requests + spent.tokens === 0 ? 'unproven' : totalRange.low > 0 ? 'saving' : totalRange.high < 0 ? 'costing' : 'unproven'
  return {
    requests,
    spent,
    saved: { usd: saved, tokens: movedTokens },
    cache,
    net,
    assumed,
    audit,
    effort,
    effortSource: audit.ready ? 'audit' : 'assumed',
    total: net + effort.point,
    totalRange,
    proof,
    unpriced,
  }
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

/** The one-sentence verdict. "Proven" only when the whole 95% range is on one side of zero. */
export function verdict(t: Totals): string {
  if (t.requests === 0 && t.spent.tokens === 0) return 'Nothing recorded yet. Use Claude Code with auto effort, model or subagents on and this fills in.'
  const r = t.totalRange
  if (t.proof === 'saving' && r) return `Proven: saving you ${usd(t.total)} in API-equivalent usage (95% range ${usd(r.low)} to ${usd(r.high)}).`
  if (t.proof === 'costing' && r) return `Proven: costing you ${usd(-t.total)} more than it saves (95% range ${usd(r.low)} to ${usd(r.high)}).`
  const measured = `Measured alone (model picks, its own calls, cache rebuilds) it is ${usd(t.net, true)}.`
  if (r) return `Not proven either way yet: ${usd(r.low, true)} to ${usd(r.high, true)} (95% range), best guess ${usd(t.total, true)}. ${measured} More audited turns narrow it.`
  const guess = t.assumed.point
  return `Not proven: effort changes are the unknown and are not measured yet. ${measured} Assuming typical output per level, effort adds about ${usd(guess, true)}. Turn the audit on to measure it for real.`
}
