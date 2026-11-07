import { expect, test } from 'claude-code/testing'

import type { EffortView } from '../types'
import { DEFAULT_ORDERS } from '../hooks/orders'
import { FLASH_WINDOW_MS, NEEDS_LABEL, bandView, firstSentence, meters, needsCount, needsNote, paneView, paneWidth, type PaneSnapshot } from '../hooks/view'
import { PANE, engine, settle } from './support'

// The view is held through its interface only: state in, plain data out, nothing mounted.
const idle: EffortView = { level: null, why: '', isAuto: true, isJudging: false, isSaving: false }
const snap = (o: Partial<PaneSnapshot> = {}): PaneSnapshot => ({
  run: { autoCount: 0, startedAt: 0, pending: null, last: null },
  checks: [],
  isPaused: false,
  mode: 'draft',
  effort: idle,
  vitals: { now: 600_000, contextPercent: null, lastResponseAt: 0, cacheTtlMin: 60, ratePercent: null, hasRepoOrders: true },
  log: [],
  counts: { effort: {}, models: {}, subagents: 0 },
  isChecksOpen: false,
  ...o,
})
const pane = (o: Partial<PaneSnapshot> = {}, opts: { columns?: number; fx?: boolean; now?: number } = {}) =>
  paneView(snap(o), { columns: opts.columns, fx: opts.fx ?? false, now: opts.now ?? 600_000, maxAuto: 8 })
const vitals = (v: Partial<PaneSnapshot['vitals']>) => ({ ...snap().vitals, ...v })

// ---- the band's Needs you note -----------------------------------------

test('first sentence: the first line, up to a sentence end that a new sentence follows', () => {
  expect(firstSentence('Deploy to production?')).toBe('Deploy to production?')
  expect(firstSentence('Deploy to production? It touches billing. Sure?')).toBe('Deploy to production?')
  expect(firstSentence('Ship v1.2 to prod. Then tell the team.')).toBe('Ship v1.2 to prod.')
  expect(firstSentence('Use e.g. redis here? yes')).toBe('Use e.g. redis here? yes') // a lower-case word after a full stop is not a new sentence
  expect(firstSentence('  \n\nFirst line only\nsecond line')).toBe('First line only') // blank lines first, then one line
  expect(firstSentence('Spaced    out \t words.')).toBe('Spaced out words.')
  expect(firstSentence('Did it say "stop." Then what')).toBe('Did it say "stop."')
  expect(firstSentence('   ')).toBe('')
})

test('the Needs you note is one line: fitted to the width, with "+N more" when others wait', () => {
  // fits whole
  expect(needsNote('Deploy to production?', 0, 100)).toEqual({ label: NEEDS_LABEL, text: 'Deploy to production?', more: '' })
  // a long question: first sentence only, ellipsized to leave the label and the tail room
  const long = `Should I deploy the billing service to production now? ${'It touches every invoice. '.repeat(20)}`
  const wide = needsNote(long, 0, 40)
  expect(wide.text).toBe('Should I deploy the billin…')
  expect(`${NEEDS_LABEL} ${wide.text}`.length).toBe(40)
  // more than one item: the others are counted, and the tail is reserved before the text is cut
  const two = needsNote(long, 3, 50)
  expect(two.more).toBe('+3 more')
  expect(`${NEEDS_LABEL} ${two.text} ${two.more}`.length).toBeLessThanOrEqual(50)
  expect(`${NEEDS_LABEL} ${two.text} ${two.more}`.length).toBe(50)
  expect(two.text.endsWith('…')).toBe(true)
  // a short question keeps the whole text and still gets its tail
  expect(needsNote('Deploy?', 1, 100)).toEqual({ label: NEEDS_LABEL, text: 'Deploy?', more: '+1 more' })
  // multi-sentence and multi-line text never reaches the band past the first sentence
  expect(needsNote('Deploy now? Check billing.\nAlso more', 0, 100).text).toBe('Deploy now?')
  // narrow: "+N more" gives way before the question does
  const narrow = needsNote(long, 4, 28)
  expect(narrow.more).toBe('')
  expect(narrow.text).toBe('Should I deplo…')
  expect(needsNote(long, 4, 29).more).toBe('+4 more') // one column more and the tail fits again
  // very short: the label stays, the text shrinks to an ellipsis, then to nothing
  expect(needsNote(long, 0, NEEDS_LABEL.length + 2).text).toBe('…')
  expect(needsNote(long, 0, NEEDS_LABEL.length + 3).text).toBe('S…')
  expect(needsNote(long, 0, NEEDS_LABEL.length + 1).text).toBe('')
  expect(needsNote(long, 2, 5)).toEqual({ label: NEEDS_LABEL, text: '', more: '' })
})

test('the band describes the note only while Claude is waiting, and counts the other items', () => {
  const run = { autoCount: 0, startedAt: 0, pending: 'Deploy to production? Billing is involved.', last: null }
  const checks = [{ text: 'a', at: 1, chat: '' }, { text: 'b', at: 2, chat: '' }]
  expect(bandView(snap(), {}).note).toBeNull()
  expect(bandView(snap({ checks }), {}).note).toBeNull() // open checks alone are not a question
  expect(bandView(snap({ run, checks }), {}).note).toEqual({ label: NEEDS_LABEL, text: 'Deploy to production?', more: '+2 more' })
  expect(needsCount(snap({ run, checks }))).toBe(3)
  expect(needsCount(snap({ checks }))).toBe(2)
  expect(needsCount(snap({ run }))).toBe(1)
  expect(needsCount(snap())).toBe(0)
})

// ---- the band's wording -------------------------------------------------

test('the band: wide words, then short words below 80 columns', () => {
  const ev: EffortView = { level: 'high', model: 'sonnet', why: '', isAuto: false, isJudging: false, isSaving: true }
  const base = snap({ effort: ev, checks: [{ text: 'a', at: 1, chat: '' }] })
  const wide = bandView(base, { columns: 120 })
  expect(wide.isNarrow).toBe(false)
  expect(wide.mode.label).toBe('✎ Orders: draft')
  expect(wide.effort.text).toBe('Sonnet · High (yours) · save')
  expect(wide.hint).toBe('no repo orders: /orders init')
  expect(wide.autopilot).toBe('Autopilot · 1 to do')
  const narrow = bandView(base, { columns: 79 })
  expect(narrow.isNarrow).toBe(true)
  expect(narrow.mode.label).toBe('✎ draft')
  expect(narrow.effort.text).toBe('Sonnet·High* · save')
  expect(narrow.hint).toBe('no repo orders')
  expect(narrow.autopilot).toBe('Autopilot · 1')
  expect(bandView(base, { columns: 80 }).isNarrow).toBe(false)
  expect(bandView(base, {}).isNarrow).toBe(false) // no width given: wide
  expect(bandView(snap(), {}).autopilot).toBe('Autopilot')
})

test('the band: mode words, effort colour and the model left out', () => {
  expect(bandView(snap({ mode: 'auto' }), {}).mode).toEqual({ key: 'auto', label: '▶ Orders: auto' })
  expect(bandView(snap({ mode: 'auto', isPaused: true }), {}).mode).toEqual({ key: 'paused', label: '⏸ Orders paused' }) // paused wins
  expect(bandView(snap({ mode: 'auto', isPaused: true }), { columns: 40 }).mode.label).toBe('⏸ paused')
  expect(bandView(snap({ mode: 'auto' }), { columns: 40 }).mode.label).toBe('▶ auto')
  const e = (level: string, model?: string) => bandView(snap({ effort: { ...idle, level, model } }), {}).effort
  expect(e('xhigh')).toEqual({ isJudging: false, text: 'Xhigh', color: 'red' })
  expect(e('low', 'opus')).toMatchObject({ text: 'Opus · Low', color: 'green' })
  expect(e('max').color).toBeUndefined()
  expect(bandView(snap(), {}).effort).toEqual({ isJudging: false, text: '', color: undefined })
  expect(bandView(snap({ effort: { ...idle, isJudging: true } }), {}).effort.isJudging).toBe(true)
})

// ---- the meters ---------------------------------------------------------

test('meters: heat by percent, the cache clock, and one list for the band and the pane', () => {
  expect(meters(vitals({}))).toEqual([]) // nothing known yet
  const m = meters(vitals({ contextPercent: 41.4, ratePercent: 90, lastResponseAt: 100_000 }))
  expect(m.map(x => [x.name, x.tone, x.text, x.label])).toEqual([
    ['ctx', 'green', '41%', 'ctx 41%'],
    ['limit', 'red', '90%', 'limit 90%'],
    ['cache', 'cyan', '51:40 left', 'cache 51:40'],
  ])
  expect(m[0]?.percent).toBe(41.4) // the bar gets the raw value
  expect(Math.round(m[2]?.percent ?? 0)).toBe(86) // 3100s of 3600s
  expect(m.map(x => x.barName)).toEqual(['ctx  ', 'limit', 'cache'])
  expect(meters(vitals({ contextPercent: 69.9 }))[0]?.tone).toBe('green')
  expect(meters(vitals({ contextPercent: 70 }))[0]?.tone).toBe('yellow')
  expect(meters(vitals({ contextPercent: 89.9 }))[0]?.tone).toBe('yellow')
  expect(meters(vitals({ contextPercent: 90 }))[0]?.tone).toBe('red')
  // the cache: cold at (and past) the end of its window, whatever its length
  const cold = meters(vitals({ now: 3_700_000, lastResponseAt: 100_000 }))[0]
  expect(cold).toMatchObject({ name: 'cache', tone: 'yellow', percent: 0, text: 'cold', label: 'cache cold' })
  expect(meters(vitals({ now: 3_700_000, lastResponseAt: 100_000 }))[0]?.percent).toBe(0)
  expect(meters(vitals({ now: 400_000, lastResponseAt: 100_000, cacheTtlMin: 5 }))[0]).toMatchObject({ tone: 'yellow', text: 'cold' }) // exactly 0 left
  expect(meters(vitals({ now: 399_000, lastResponseAt: 100_000, cacheTtlMin: 5 }))[0]).toMatchObject({ tone: 'cyan', text: '0:01 left', label: 'cache 0:01' })
  expect(bandView(snap({ vitals: vitals({ contextPercent: 41, lastResponseAt: 100_000 }) }), {}).meters.map(x => x.label)).toEqual(['ctx 41%', 'cache 51:40'])
})

// ---- the pane -----------------------------------------------------------

test('the pane: width is never under 30, the bars need motion and 48 columns, the rows stack under 80', () => {
  expect(paneWidth(undefined)).toBe(60)
  expect(paneWidth(10)).toBe(30)
  expect(paneWidth(200)).toBe(200)
  const v = vitals({ contextPercent: 41, ratePercent: 20 })
  expect(pane({ vitals: v }, { columns: 100, fx: true }).usage).toMatchObject({ kind: 'bars', barWidth: 24 })
  expect(pane({ vitals: v }, { columns: 60, fx: true }).usage).toMatchObject({ kind: 'bars', barWidth: 24 })
  expect(pane({ vitals: v }, { columns: 50, fx: true }).usage).toMatchObject({ kind: 'bars', barWidth: 22 })
  expect(pane({ vitals: v }, { columns: 48, fx: true }).usage).toMatchObject({ kind: 'bars', barWidth: 20 })
  expect(pane({ vitals: v }, { columns: 47, fx: true }).usage.kind).toBe('inline')
  expect(pane({ vitals: v }, { columns: 100, fx: false }).usage.kind).toBe('inline') // no motion: plain words
  expect(pane({}, { columns: 100, fx: true }).usage.kind).toBe('none')
  expect(pane({}, { columns: 80 }).isWide).toBe(true)
  expect(pane({}, { columns: 79 }).isWide).toBe(false)
  expect(pane({}, { columns: 5 }).width).toBe(30)
  expect(pane({}, {}).isWide).toBe(false) // the default 60
})

test('the pane: mode, effort wording and why', () => {
  expect(pane({ mode: 'auto', run: { autoCount: 3, startedAt: 0, pending: null, last: null } }).mode).toMatchObject({
    key: 'auto', label: '▶ Auto', answered: 'answered 3 of 8', tone: 'green', toggleTo: 'draft', toggleLabel: 'Draft', pauseLabel: '⏸ Pause',
  })
  expect(pane({ isPaused: true }).mode).toMatchObject({ label: '⏸ Paused', tone: 'yellow', toggleTo: 'auto', toggleLabel: 'Auto', pauseLabel: '▶ Resume' })
  expect(pane().mode).toMatchObject({ label: '✎ Draft', tone: 'cyan' })

  const effort = (e: Partial<EffortView>) => pane({ effort: { ...idle, ...e } }).effort
  expect(effort({})).toEqual({ kind: 'none' })
  expect(effort({ isJudging: true, level: 'high' })).toEqual({ kind: 'judging' })
  expect(effort({ level: 'high' })).toEqual({ kind: 'level', color: 'magenta', title: 'High', note: null })
  expect(effort({ level: 'high', why: 'auto' })).toMatchObject({ note: null }) // "auto" says nothing
  expect(effort({ level: 'low', model: 'opus', why: 'tiny edit' })).toEqual({ kind: 'level', color: 'green', title: 'Opus · Low', note: 'tiny edit' })
  expect(effort({ level: 'high', isAuto: false, why: 'tiny edit' })).toMatchObject({ note: 'set by you' })
  expect(effort({ level: 'high', isSaving: true })).toMatchObject({ note: 'capped by usage' })
  expect(effort({ level: 'high', why: 'big refactor', isSaving: true })).toMatchObject({ note: 'big refactor · capped by usage' })
})

test('the pane: Needs you counts the question and every open check, wraps the question whole, and groups by lead', () => {
  const long = `Should I deploy the billing service to production now? ${'It touches every invoice. '.repeat(10)}`
  const checks = [
    { text: 'Plain one', at: 1_000, chat: 'a' },
    { text: 'After /reload, watch the band', at: 2_000, chat: 'a' },
    { text: 'After /reload, open the pane', at: 3_000, chat: 'a' },
  ]
  const v = pane({ run: { autoCount: 0, startedAt: 0, pending: long, last: null }, checks }, { columns: 40 })
  expect(v.needs.count).toBe(4)
  expect(v.needs.hasAny).toBe(true)
  expect(v.needs.pending).toBe(long) // never cut: the card wraps it
  expect(v.needs.canClearAll).toBe(true)
  expect(v.needs.older).toBe(0)
  expect(v.needs.groups.map(g => [g.lead, g.items.map(i => i.text)])).toEqual([
    ['After /reload', ['Open the pane', 'Watch the band']],
    [null, ['Plain one']],
  ])
  expect(pane().needs).toMatchObject({ count: 0, hasAny: false, pending: null, groups: [], canClearAll: false })
  expect(pane({ checks: [checks[0]!] }).needs.canClearAll).toBe(false)
  expect(pane({ run: { autoCount: 0, startedAt: 0, pending: 'Q?', last: null } }).needs).toMatchObject({ count: 1, hasAny: true })
})

test('the pane: item age, the last-day heads-up, and the short list with its older count', () => {
  const day = 86_400_000
  const now = 10 * day
  const many = Array.from({ length: 7 }, (_, i) => ({ text: `Check ${i}`, at: now - 3_600_000 - i, chat: 'a' }))
  const closed = pane({ checks: many, vitals: vitals({ now }) })
  expect(closed.needs.groups.flatMap(g => g.items).length).toBe(5)
  expect(closed.needs.older).toBe(2)
  expect(closed.needs.olderLabel).toBe('+2 older')
  const open = pane({ checks: many, isChecksOpen: true, vitals: vitals({ now }) })
  expect(open.needs.groups.flatMap(g => g.items).length).toBe(7)
  expect(open.needs.olderLabel).toBe('Show fewer')
  const one = pane({ checks: [{ text: 'Old one', at: now - 2.5 * day, chat: 'a' }], vitals: vitals({ now }) }).needs.groups[0]?.items[0]
  expect(one).toMatchObject({ text: 'Old one', age: '2d', life: 'drops in 12h', flashBody: 'Old one · 2d' })
  expect(pane({ checks: many, vitals: vitals({ now }) }).needs.groups[0]?.items[0]).toMatchObject({ age: '1h', life: '' })
})

test('the pane: only the newest check and the newest log entry flash, only with motion and only while fresh', () => {
  const now = 1_000_000
  const checks = [
    { text: 'Older', at: now - 100, chat: 'a' },
    { text: 'Newest', at: now - 50, chat: 'a' },
  ]
  const log = [
    { at: now - 60_000, kind: 'answered' as const, text: 'Old reply' },
    { at: now - 400, kind: 'effort' as const, text: 'high · fresh' },
  ]
  const at = (fx: boolean, n: number) => pane({ checks, log, vitals: vitals({ now: n }) }, { fx, now: n })
  const v = at(true, now)
  expect(v.needs.groups.flatMap(g => g.items).map(i => [i.text, i.isFlash])).toEqual([['Newest', true], ['Older', false]])
  expect(v.activity.rows.map(r => [r.body, r.isFlash, r.isPick])).toEqual([
    ['effort high · fresh', true, true],
    ['sent: Old reply', false, false],
  ])
  expect(v.activity.rows[0]?.at).toBe(now - 400)
  expect(at(false, now).activity.rows.some(r => r.isFlash)).toBe(false) // motion off
  expect(at(false, now).needs.groups.flatMap(g => g.items).some(i => i.isFlash)).toBe(false)
  // the window's edge
  expect(at(true, now - 400 + FLASH_WINDOW_MS - 1).activity.rows[0]?.isFlash).toBe(true)
  expect(at(true, now - 400 + FLASH_WINDOW_MS).activity.rows[0]?.isFlash).toBe(false)
  // an entry from the future (a skewed clock) does not flash
  expect(at(true, now - 1000).activity.rows[0]?.isFlash).toBe(false)
  // a row's head is read at the pane's last tick, a highlight's at the clock now
  const skew = pane({ log, vitals: vitals({ now: now + 60_000 }) }, { fx: true, now })
  expect(skew.activity.rows[0]).toMatchObject({ head: '◆  1m', flashHead: '◆  0s' })
})

test('the pane: the activity feed keeps the newest eight and tallies the session', () => {
  const log = Array.from({ length: 10 }, (_, i) => ({ at: 1000 + i, kind: 'answered' as const, text: `r${i}` }))
  const v = pane({ log })
  expect(v.activity.rows.length).toBe(8)
  expect(v.activity.rows[0]?.body).toBe('sent: r9')
  expect(v.activity.rows.at(-1)?.body).toBe('sent: r2')
  expect(v.activity.tally).toBeNull()
  const counts = (c: Partial<PaneSnapshot['counts']>) => pane({ counts: { effort: {}, models: {}, subagents: 0, ...c } }).activity.tally
  expect(counts({ effort: { high: 2, low: 1 } })).toBe('this session · high ×2 low ×1')
  expect(counts({ effort: { high: 2 }, models: { opus: 1 }, subagents: 1 })).toBe('this session · high ×2 · models opus ×1 · 1 subagents steered')
  expect(counts({ subagents: 3 })).toBe('this session · · 3 subagents steered') // as it always read when only subagents were steered
})

test('the pane meters carry the pane wording', () => {
  const v = pane({ vitals: vitals({ contextPercent: 41, ratePercent: 20, lastResponseAt: 100_000 }) }, { fx: true, columns: 60 })
  expect(v.usage.meters.map(m => [m.barName, m.text, m.tone])).toEqual([
    ['ctx  ', '41%', 'green'],
    ['limit', '20%', 'green'],
    ['cache', '51:40 left', 'cyan'],
  ])
})

// ---- mounted: the band draws the note as one line -----------------------

test('the band draws the Needs you note on one line, label yellow, text plain, "+N more" dim', async ($: any, on: any) => {
  const { set } = engine(on, { orders: DEFAULT_ORDERS, repoOrders: DEFAULT_ORDERS, state: true })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  const long = `Should I deploy the billing service to production now? ${'It touches every invoice. '.repeat(30)}`
  await set('run', { autoCount: 0, startedAt: 0, pending: long, last: null })
  await set('checks', [{ text: 'Try it on a device', at: 1, chat: 'a' }])
  const mount = (bodyColumns: number) =>
    $.ui.mount({ plugin: 'standing-orders', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns } })

  const band = await mount(100)
  const note = await band.find({ type: 'Text', text: /Needs you/ })
  expect(note?.text).toBe('⚠ Needs you: Should I deploy the billing service to production now? +1 more')
  expect(note?.text.length).toBeLessThanOrEqual(100)
  expect(note?.text).not.toContain('invoice')
  const label = await band.find({ type: 'Text', text: /^⚠ Needs you:$/ })
  expect(label?.props).toMatchObject({ color: 'yellow', bold: true })
  const more = await band.find({ type: 'Text', text: /^ ?\+1 more$/ })
  expect(more?.props).toMatchObject({ dimColor: true })
  await band.unmount()

  const small = await mount(40)
  const cut = await small.find({ type: 'Text', text: /Needs you/ })
  expect(cut?.text.length).toBeLessThanOrEqual(40)
  expect(cut?.text).toContain('…')
  await small.unmount()

  // the pane's card keeps the whole question
  const card = await $.ui.mount(PANE('terminal'))
  expect(await card.find({ type: 'Text', text: /every invoice\. $/ })).toBeTruthy()
  await card.unmount()
})
