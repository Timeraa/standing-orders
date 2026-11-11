import { expect, test } from 'claude-code/testing'

import { parseOrders, withPaused } from '../hooks/orders'
import { createPicks, type Host } from '../hooks/picks'
import type { EffortView } from '../types'
import { GLOBAL, engine, typed } from './support'

const ORDERS = 'effort: auto\nmodel: auto\nsubagents: auto\nmodels: sonnet, opus\n'
const judged = (t: { systems: string[] }, word: string) => t.systems.filter(s => s.includes(word)).length

test('a session pause turns effort, model and subagents off without touching the orders file; resume brings auto back', async ($: any, on: any) => {
  const t = engine(on, { orders: ORDERS, judge: { effort: 'high', model: 'opus', why: 'x' } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const r = await $.command.run({ command: 'orders', args: 'pause' })
  expect(r.text).toContain('for this session')
  expect(t.written).toEqual([]) // the file is never written
  expect(t.fs[GLOBAL]).toBe(ORDERS)

  await typed($, 'Rework the scheduler and fix the deadlock', 't1', 'claude-sonnet-5-5', 'medium')
  expect(judged(t, 'NEW chat')).toBe(0)
  expect(judged(t, 'how hard')).toBe(0)
  expect(t.efforts).toEqual(['medium']) // the session's own
  expect(t.models).toEqual(['claude-sonnet-5-5'])
  expect((await $.command.run({ command: 'orders', args: '' })).text).toContain('Paused this session: effort, model, subagents')
  expect((await $.command.run({ command: 'orders', args: '' })).text).toContain('Standing orders: paused') // replies too

  await $.command.run({ command: 'orders', args: 'resume effort' })
  await typed($, 'Now profile the hot loop', 't2', 'claude-sonnet-5-5', 'medium')
  expect(t.efforts).toEqual(['medium', 'high'])
  expect(t.written).toEqual([])

  expect((await $.command.run({ command: 'orders', args: 'pause bogus' })).text).toContain('Usage')
})

test('a project pause is saved for this folder and read back by the next session there, not elsewhere', async ($: any, on: any) => {
  const kept: Record<string, unknown> = {}
  const t = engine(on, {
    orders: ORDERS,
    judge: { effort: 'high', why: 'x' },
    handlers: {
      'store.get': (_: unknown, e: any) => ({ value: kept[e.key] }),
      'store.set': (_: unknown, e: any) => {
        kept[e.key] = e.value
        return { value: undefined }
      },
    },
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'orders', args: 'pause effort project' })).text).toContain('in /repo')
  expect(kept['paused:/repo']).toEqual(['effort'])

  // a new session in the same folder starts paused
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await typed($, 'Profile the sim tick and fix whatever is slow', 't1', 'claude-opus-5-5', 'medium')
  expect(t.efforts).toEqual(['medium'])

  // another folder does not
  await $.session.start({ cwd: '/other', surface: 'terminal', isInteractive: true })
  await typed($, 'Profile the sim tick and fix whatever is slow', 't2', 'claude-opus-5-5', 'medium')
  expect(t.efforts).toEqual(['medium', 'high'])

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'orders', args: 'resume project' })
  expect(kept['paused:/repo']).toEqual([])
  expect(t.written).toEqual([])
})

test('a pause only turns things off; resume does not undo the person taking effort over', async () => {
  const o = parseOrders('effort: high\nmodel: auto\nsubagents: auto\n')
  const p = withPaused(o, new Set(['effort', 'subagents']))
  expect(p).toMatchObject({ isEffortAuto: false, effortFixed: null, isSubagentsAuto: false, isModelAuto: true })
  expect(withPaused(o, new Set())).toBe(o)

  let isOff = false
  let view = { level: null, why: '', isAuto: true, isJudging: false, isSaving: false } as EffortView
  const host = { view: async () => view, show: async (patch: Partial<EffortView>) => (view = { ...view, ...patch }) } as unknown as Host
  const picks = createPicks(() => parseOrders(isOff ? 'effort: off\n' : 'effort: auto\n'))

  // the orders (or a pause) going off and back on: auto follows
  isOff = true
  await picks.followOrders(host)
  expect(view.isAuto).toBe(false)
  isOff = false
  await picks.followOrders(host)
  expect(view.isAuto).toBe(true)

  // the person ran /effort: auto stays off through a resume, until /orders effort auto
  await picks.setAuto(host, false)
  await picks.followOrders(host)
  expect(view.isAuto).toBe(false)
  await picks.setAuto(host, true)
  expect(view.isAuto).toBe(true)
})
