import { expect, test } from 'claude-code/testing'

import type { EffortView } from '../types'
import { parseOrders } from '../hooks/orders'
import { DEADLINE_MS, boundEffort, createPicks, type Answer, type Ask, type Host } from '../hooks/picks'
import { engine, settle, step } from './support'

// The module is held through its interface only, over a scripted judge model and a clock the test runs by hand.
type Say = object | string | (() => Promise<object | string>)
function rig(orders: string, say: (req: Ask) => Say, o: { saving?: boolean; contextPercent?: number | null } = {}) {
  const t = {
    view: { level: null, why: '', isAuto: true, isJudging: false, isSaving: o.saving ?? false } as EffortView,
    asked: [] as Ask[],
    sleeps: [] as { ms: number; wake: () => void }[],
    notes: [] as [string, string][],
    tallies: [] as [string, string | undefined][],
    toasts: [] as string[],
    picks: createPicks(() => parseOrders(orders)),
    host: undefined as unknown as Host,
    /** Time passes: every pending deadline fires. */
    timeUp: () => t.sleeps.splice(0).forEach(s => s.wake()),
  }
  const text = (a: object | string) => (typeof a === 'string' ? a : JSON.stringify(a))
  const host: Host = {
    complete: async (req): Promise<Answer> => {
      t.asked.push(req)
      const a = say(req)
      return { isAnswered: true, text: text(typeof a === 'function' ? await a() : a) }
    },
    sleep: ms => new Promise(wake => t.sleeps.push({ ms, wake: () => wake(undefined) })),
    view: async () => t.view,
    show: async patch => (t.view = { ...t.view, ...patch }),
    contextPercent: async () => (o.contextPercent === undefined ? null : o.contextPercent),
    note: async (kind, text) => void t.notes.push([kind, text]),
    tally: async (kind, key) => void t.tallies.push([kind, key]),
    toast: text => void t.toasts.push(text),
  }
  t.host = host
  return t
}
type Rig = ReturnType<typeof rig>

// A prompt is typed, then the turn's first request runs on `model` at the chat's own `effort`.
async function turn(t: Rig, text: string, model = 'claude-opus-5-5', effort: unknown = 'medium', index = 0) {
  await t.picks.typed(t.host, { text, isDraftSent: false })
  return t.picks.request(t.host, { index, model, effort })
}
// What the settle() of the event loop lets a not-yet-awaited judge finish.
const later = () => settle(20)

const AUTO = 'effort: auto\n'

test('the judged level is applied to the turn, noted once and tallied', async () => {
  const t = rig(AUTO, () => ({ effort: 'high', why: 'multi-file feature' }))
  const p = turn(t, 'Profile the sim tick and fix whatever is slow')
  await later()
  t.timeUp() // nothing waits on it: the judge answered long before the deadline
  expect(await p).toEqual({ effort: 'high' })

  expect(t.notes).toEqual([['effort', 'high · multi-file feature']])
  expect(t.tallies).toEqual([['effort', 'high']])
  expect(t.view).toMatchObject({ level: 'high', model: 'opus', why: 'multi-file feature', isAuto: true, isJudging: false })
  expect(t.toasts).toEqual([])
  expect(t.asked.map(a => [a.model, a.maxTokens])).toEqual([['haiku', 80]])
  expect(t.asked[0]?.system).toContain('how hard')
})

test('a go-ahead keeps the level and asks no judge; the level reaches later requests of the turn without a new note', async () => {
  const t = rig(AUTO, () => ({ effort: 'high', why: 'x' }))
  const p = turn(t, 'Profile the sim tick')
  await later()
  await p
  await t.picks.typed(t.host, { text: 'go ahead', isDraftSent: false })
  expect(t.view.why).toBe('kept for a follow-up')
  expect(await t.picks.request(t.host, { index: 0, model: 'claude-opus-5-5', effort: 'high' })).toEqual({ effort: 'high' })
  // a later request of the same turn applies the level and tallies nothing
  expect(await t.picks.request(t.host, { index: 1, model: 'claude-opus-5-5', effort: 'high' })).toEqual({ effort: 'high' })

  expect(t.asked.length).toBe(1)
  expect(t.notes.length).toBe(1)
  expect(t.tallies).toEqual([['effort', 'high'], ['effort', 'high']])
})

test('a slow judge is left behind at the deadline and its late answer is dropped', async () => {
  let answer = () => {}
  const t = rig(AUTO, () => () => new Promise<object>(r => (answer = () => r({ effort: 'xhigh', why: 'late' }))))
  const p = turn(t, 'Rework the scheduler')
  await later()
  // the request is waiting: one deadline timer, 3 seconds, while the judge's own timeout is 8
  expect(t.sleeps.map(s => s.ms)).toEqual([DEADLINE_MS])
  expect(t.asked[0]?.timeoutMs).toBe(8000)
  t.timeUp()
  expect(await p).toEqual({})
  expect(t.view).toMatchObject({ why: 'judge slow: kept', isJudging: false })

  answer()
  await later()
  expect(await t.picks.request(t.host, { index: 1, model: 'claude-opus-5-5', effort: 'medium' })).toEqual({})
  expect(t.notes).toEqual([])
  expect(t.tallies).toEqual([])
})

test('through the mod: the deadline runs on the engine clock, and the late answer is dropped', async ($: any, on: any) => {
  let answer = () => {}
  const seen = engine(on, {
    orders: AUTO,
    repoOrders: AUTO,
    handlers: {
      'model.complete': () => new Promise(r => (answer = () => r({ value: { isAnswered: true, text: '{"effort":"xhigh","why":"late"}' } }))),
    },
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Rework the scheduler', origin: { kind: 'composer' }, wait: false })
  await settle()
  await $.turn.start({ turnId: 't1', prompt: 'x' })
  let isDone = false
  const stepping = step($, 't1', 'claude-opus-5-5').then(() => (isDone = true))
  await settle()
  expect(isDone).toBe(false) // the request waits for the judge
  await seen.clock.advance(DEADLINE_MS)
  await stepping
  expect(seen.efforts).toEqual(['medium']) // kept: the session's own level

  answer() // too late
  await settle()
  await step($, 't1', 'claude-opus-5-5')
  expect(seen.efforts).toEqual(['medium', 'medium'])
})

test('the saving cap bounds a judged turn level, and a floor above it still wins', async () => {
  const xhigh = () => ({ effort: 'xhigh', why: 'hard' })
  const capped = rig('effort: auto\neffort-max: xhigh\n', xhigh, { saving: true })
  const p = turn(capped, 'Rework the scheduler')
  await later()
  expect(await p).toEqual({ effort: 'medium' })
  expect(capped.notes).toEqual([['effort', 'medium · hard']])

  const floored = rig('effort: auto\neffort-min: high\n', xhigh, { saving: true })
  const q = turn(floored, 'Rework the scheduler')
  await later()
  expect(await q).toEqual({ effort: 'high' })

  const free = rig('effort: auto\n', xhigh)
  const r = turn(free, 'Rework the scheduler')
  await later()
  expect(await r).toEqual({ effort: 'xhigh' })
})

test('bounds: floor, ceiling and the saving cap are explicit arguments', () => {
  const at = (level: any, min: any, max: any, saving = false) => boundEffort(level, { min, max, saving })
  expect(at('low', 'medium', 'high')).toBe('medium')
  expect(at('xhigh', 'medium', 'high')).toBe('high')
  expect(at('high', 'low', 'xhigh')).toBe('high')
  expect(at('high', 'xhigh', 'medium')).toBe('xhigh') // a floor above the ceiling wins
  expect(at('xhigh', 'low', 'max', true)).toBe('medium')
  expect(at('low', 'low', 'max', true)).toBe('low')
  expect(at('xhigh', 'high', 'max', true)).toBe('high')
})

test('a fixed level runs every prompt as written: no judge, no floor, no ceiling, no saving cap', async () => {
  const t = rig('effort: max\neffort-min: low\neffort-max: medium\n', () => ({ effort: 'low', why: 'x' }), { saving: true })
  expect(await turn(t, 'Rename a variable')).toEqual({ effort: 'max' })

  expect(t.asked).toEqual([])
  expect(t.view.why).toBe('fixed')
  expect(t.notes).toEqual([])
  expect(t.tallies).toEqual([['effort', 'max']])
})

test('effort off ("yours") leaves the session alone', async () => {
  const t = rig(AUTO, () => ({ effort: 'low', why: 'x' }))
  await t.picks.setAuto(t.host, false)
  expect(t.view).toMatchObject({ isAuto: false, why: 'yours' })

  expect(await turn(t, 'Rename a variable', 'claude-opus-5-5', 'xhigh')).toEqual({})
  expect(t.asked).toEqual([])
  expect(t.view.level).toBe('xhigh') // the session's own, shown as is
  expect(t.tallies).toEqual([])

  // the orders turning effort off does the same
  const off = rig('effort: off\n', () => ({ effort: 'low', why: 'x' }))
  await off.picks.followOrders(off.host)
  expect(off.view.isAuto).toBe(false)
  expect(await turn(off, 'Rename a variable', 'claude-opus-5-5', 'high')).toEqual({})
  expect(off.asked).toEqual([])
  const on = rig(AUTO, () => ({}))
  await on.picks.followOrders(on.host)
  expect(on.view.isAuto).toBe(true)
})

test('a model where effort rewrites the cache is left alone', async () => {
  const t = rig(AUTO, () => ({ effort: 'low', why: 'x' }))
  const p = turn(t, 'What does this function return?', 'claude-fable-5-1', 'high')
  await later()
  expect(await p).toEqual({})
  expect(t.view.level).toBe('high')
  expect(t.notes).toEqual([])
})

test('changing effort yourself turns auto off, with a toast', async () => {
  const t = rig(AUTO, () => ({ effort: 'low', why: 'x' }))
  const p = turn(t, 'Rename this variable everywhere')
  await later()
  expect(await p).toEqual({ effort: 'low' })
  // between prompts the person picked xhigh in the effort menu
  expect(await turn(t, 'Now rework the scheduler', 'claude-opus-5-5', 'xhigh')).toEqual({})
  expect(t.view).toMatchObject({ isAuto: false, isJudging: false, why: 'yours', level: 'xhigh' })
  expect(t.toasts.length).toBe(1)
  expect(t.toasts[0]).toContain('/orders effort auto')
})

test('a new chat picks its model once, from the first prompt', async () => {
  const t = rig('model: auto\nmodels: sonnet, opus\n', () => ({ model: 'opus', why: 'hard' }), { contextPercent: 1 })
  await t.picks.firstPrompt(t.host, { text: 'Rework the scheduler and fix the deadlock', isCommand: false })
  await t.picks.firstPrompt(t.host, { text: 'Also rename the helper', isCommand: false }) // only the first is asked
  const first = t.picks.request(t.host, { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  await later()
  expect(await first).toEqual({ model: 'opus' })
  // the chat stays on the pick; the person's /model ends it
  expect(await t.picks.request(t.host, { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })).toEqual({ model: 'opus' })
  expect(await t.picks.request(t.host, { index: 0, model: 'claude-haiku-5-5', effort: 'medium' })).toEqual({})

  expect(t.asked.length).toBe(1)
  expect(t.asked[0]?.system).toContain('NEW chat')
  expect(t.asked[0]?.prompt).toContain('ALLOWED MODELS: sonnet, opus')
  expect(t.notes).toEqual([['model', 'opus · hard']])
  expect(t.tallies).toEqual([['models', 'opus']])
  expect(t.toasts).toEqual(['Auto model: this chat runs on Opus (hard). /model changes it; /orders model off stops this.'])
})

test('a new chat keeps its model when the pick is the one it has, or nothing asks', async () => {
  const same = rig('model: auto\n', () => ({ model: 'sonnet', why: 'ordinary' }), { contextPercent: null })
  await same.picks.firstPrompt(same.host, { text: 'Fix the flaky test in the planner', isCommand: false })
  const p = same.picks.request(same.host, { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  await later()
  expect(await p).toEqual({})
  expect(same.notes).toEqual([])

  const skipped = async (orders: string, p: { text: string; isCommand: boolean }, contextPercent: number | null) => {
    const t = rig(orders, () => ({ model: 'opus', why: 'x' }), { contextPercent })
    await t.picks.firstPrompt(t.host, p)
    return t.asked.length
  }
  expect(await skipped('model: off\n', { text: 'Rework the scheduler', isCommand: false }, null)).toBe(0)
  expect(await skipped('model: auto\n', { text: 'Rework the scheduler', isCommand: true }, null)).toBe(0) // a /model typed
  expect(await skipped('model: auto\n', { text: 'Rework the scheduler', isCommand: false }, 40)).toBe(0) // history
  expect(await skipped('model: auto\n', { text: 'go ahead', isCommand: false }, null)).toBe(0)
  expect(await skipped('model: auto\n', { text: 'Rework the scheduler', isCommand: false }, 2)).toBe(1)
})

test('a slow model judge leaves the chat on its own model', async () => {
  const t = rig('model: auto\n', () => () => new Promise<object>(() => {}), { contextPercent: 0 })
  await t.picks.firstPrompt(t.host, { text: 'Rework the scheduler', isCommand: false })
  const p = t.picks.request(t.host, { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  await later()
  t.timeUp()
  expect(await p).toEqual({})
  expect(t.notes).toEqual([])
})

const spawnWith = (t: Rig, a: { named?: string; eligible?: boolean } = {}) => {
  const started: (string | undefined)[] = []
  const done = t.picks.spawn(
    t.host,
    { eligible: a.eligible ?? true, prompt: 'grep for foo', subagentType: 'Explore', named: a.named },
    async model => (started.push(model), { agentId: 'a1', model: 'claude-haiku-5-5' }),
  )
  return { started, done }
}

test('a subagent gets a model and an effort from its task, recorded once', async () => {
  const t = rig('subagents: auto\nmodels: sonnet, opus\neffort-min: medium\n', () => ({ model: 'haiku', effort: 'low', why: 'search' }))
  const s = spawnWith(t)
  await later()
  expect(await s.done).toEqual({ agentId: 'a1', model: 'claude-haiku-5-5' })

  expect(s.started).toEqual(['haiku'])
  expect(t.asked[0]?.prompt).toContain('ALLOWED MODELS: haiku, sonnet, opus')
  expect(t.notes).toEqual([['subagent', 'haiku/medium · search']]) // the floor lifts low
  expect(t.tallies).toEqual([['subagents', undefined], ['models', 'haiku']])
  // every request of that subagent runs at the picked level; others and models that do not take effort are left alone
  expect(t.picks.subagentRequest('a1', 'claude-opus-5-5', 'high')).toBe('medium')
  expect(t.picks.subagentRequest('a2', 'claude-opus-5-5', 'high')).toBeUndefined()
  expect(t.picks.subagentRequest('a1', 'claude-fable-5-1', 'high')).toBeUndefined()
  expect(t.picks.subagentRequest('a1', 'claude-opus-5-5', undefined)).toBeUndefined()
})

test('a subagent keeps the model the Agent call named, forks are not judged, off leaves spawns alone', async () => {
  const t = rig('subagents: auto\n', () => ({ model: 'haiku', effort: 'low', why: 'search' }))
  const named = spawnWith(t, { named: 'opus' })
  await later()
  await named.done
  expect(named.started).toEqual([undefined]) // the caller's model stands; the effort is still ours
  expect(t.picks.subagentRequest('a1', 'claude-opus-5-5', 'high')).toBe('low')

  const fork = spawnWith(t, { eligible: false })
  await fork.done
  expect(fork.started).toEqual([undefined])
  expect(t.asked.length).toBe(1)

  const off = rig('subagents: off\n', () => ({ model: 'haiku', effort: 'low', why: 'x' }))
  const o = spawnWith(off)
  await o.done
  expect(o.started).toEqual([undefined])
  expect(off.asked).toEqual([])
})

test('a subagent is not held to the usage-limit cap (kept as it was), only to the floor and ceiling', async () => {
  const t = rig('subagents: auto\neffort-max: high\n', () => ({ model: 'opus', effort: 'xhigh', why: 'review' }), { saving: true })
  const s = spawnWith(t)
  await later()
  await s.done
  expect(t.picks.subagentRequest('a1', 'claude-opus-5-5', 'low')).toBe('high') // the ceiling, not medium
})

test('a slow subagent judge starts the helper unchanged', async () => {
  const t = rig('subagents: auto\n', () => () => new Promise<object>(() => {}))
  const s = spawnWith(t)
  await later()
  t.timeUp()
  await s.done
  expect(s.started).toEqual([undefined])
  expect(t.notes).toEqual([])
  expect(t.picks.subagentRequest('a1', 'claude-opus-5-5', 'high')).toBeUndefined()
})

test('a finished subagent is forgotten; a running one is not', async () => {
  const t = rig('subagents: auto\n', () => ({ model: 'haiku', effort: 'low', why: 'search' }))
  const s = spawnWith(t)
  await later()
  await s.done
  t.picks.prune([{ id: 'a1', status: 'running' }])
  expect(t.picks.subagentRequest('a1', 'claude-opus-5-5', 'high')).toBe('low')
  t.picks.prune([])
  expect(t.picks.subagentRequest('a1', 'claude-opus-5-5', 'high')).toBe('low') // not listed: unknown, kept
  t.picks.prune([{ id: 'a1', status: 'completed' }])
  expect(t.picks.subagentRequest('a1', 'claude-opus-5-5', 'high')).toBeUndefined()
})

test('the effort judge is shown how the last answer ended', async () => {
  const t = rig(AUTO, () => ({ effort: 'low', why: 'x' }))
  const first = turn(t, 'First question')
  await later()
  await first
  t.picks.afterTurn(`${'x'.repeat(900)}END`)
  const second = turn(t, 'A second, different question')
  await later()
  await second
  expect(t.asked[0]?.prompt).toContain('(none: first message)')
  expect(t.asked[1]?.prompt).toContain('x'.repeat(797) + 'END')
  expect(t.asked[1]?.prompt).not.toContain('x'.repeat(798) + 'END')
})
