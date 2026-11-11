import { expect, test } from 'claude-code/testing'

import { parseOrders, withPaused } from '../hooks/orders'
import { createPicks, type Host } from '../hooks/picks'
import type { EffortView } from '../types'
import { GLOBAL, PANE, engine, typed } from './support'

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

test('a project pause of replies ends with /orders on, like the mode; a command typed first leaves the model pick to the first real prompt', async ($: any, on: any) => {
  const kept: Record<string, unknown> = {}
  const t = engine(on, {
    orders: ORDERS,
    judge: { model: 'opus', effort: 'high', why: 'x' },
    handlers: {
      'store.get': (_: unknown, e: any) => ({ value: kept[e.key] }),
      'store.set': (_: unknown, e: any) => {
        kept[e.key] = e.value
        return { value: undefined }
      },
    },
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'orders', args: 'pause replies project' })
  expect((await $.command.run({ command: 'orders', args: '' })).text).toContain('Standing orders: paused')
  await $.command.run({ command: 'orders', args: 'on' })
  expect(kept['paused:/repo']).toEqual([])
  expect((await $.command.run({ command: 'orders', args: '' })).text).not.toContain('paused')

  // /orders pause model typed as the chat's first prompt, then the first real prompt: no pick
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: '/orders pause model', command: { name: 'orders', args: 'pause model' }, origin: { kind: 'composer' }, wait: false })
  await $.command.run({ command: 'orders', args: 'pause model' })
  await typed($, 'Rework the scheduler and fix the deadlock', 't1', 'claude-sonnet-5-5')
  expect(judged(t, 'NEW chat')).toBe(0)
  expect(t.models).toEqual(['claude-sonnet-5-5'])
})

test('a command typed first (/autopilot) no longer uses up the chat\'s model pick', async ($: any, on: any) => {
  const t = engine(on, { orders: ORDERS, judge: { model: 'opus', effort: 'high', why: 'x' } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: '/autopilot', command: { name: 'autopilot', args: '' }, origin: { kind: 'composer' }, wait: false })
  await typed($, 'Rework the scheduler and fix the deadlock', 't2', 'claude-sonnet-5-5')
  expect(judged(t, 'NEW chat')).toBe(1)
})

test('the Settings Pause card pauses and resumes this session, and the Effort card says paused', async ($: any, on: any) => {
  const t = engine(on, { orders: ORDERS })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  let pane = await $.ui.mount(PANE('terminal'))
  await pane.press({ key: 'settings' })
  await pane.unmount()
  pane = await $.ui.mount(PANE('terminal'))
  expect(await pane.find({ type: 'Text', text: /nothing paused/ })).toBeTruthy()
  await pane.press({ key: 'pause-session' })
  await pane.unmount()
  pane = await $.ui.mount(PANE('terminal'))
  expect(await pane.find({ type: 'Text', text: /this session: .*effort/ })).toBeTruthy()
  expect(await pane.find({ type: 'Button', label: 'Resume session' })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: /^paused$/ })).toBeTruthy()
  await pane.press({ key: 'pause-session' })
  await pane.unmount()
  pane = await $.ui.mount(PANE('terminal'))
  expect(await pane.find({ type: 'Text', text: /nothing paused/ })).toBeTruthy()
  // one part, one scope
  await pane.press({ key: 'pause-project-model' })
  await pane.unmount()
  pane = await $.ui.mount(PANE('terminal'))
  expect(await pane.find({ type: 'Text', text: /this project: model/ })).toBeTruthy()
  expect(await pane.find({ type: 'Button', label: '⏸ model', key: 'pause-project-model' })).toBeTruthy()
  await pane.unmount()
  expect(t.written).toEqual([])
})
