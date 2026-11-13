import { expect, test } from 'claude-code/testing'

import { parseModel } from '../hooks/judges'
import { parseModels, parseOrders, setSetting } from '../hooks/orders'
import { PANE, engine, typed } from './support'

// The orders answer every file read, the repo's too. The judge always picks Opus.
const engineWith = (on: any, orders: string) => {
  const t = engine(on, { orders, repoOrders: orders, judge: { model: 'opus', effort: 'low', why: 'hard' } })
  return { ...t, judged: () => t.systems.filter(s => s.includes('NEW chat')).length }
}

test('a new chat picks its model once, from the first prompt', async ($: any, on: any) => {
  const seen = engineWith(on, 'model: auto\nmodels: sonnet, opus\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await typed($, 'Rework the scheduler and fix the deadlock', 't1', 'claude-sonnet-5-5')
  await typed($, 'Also rename the helper', 't2', 'claude-sonnet-5-5')
  // The chat stays on the first pick; running /model yourself ends it.
  await typed($, 'Now something else', 't3', 'claude-haiku-5-5')

  expect(seen.judged()).toBe(1)
  // the pick reaches the Activity feed, once
  const pane = await $.ui.mount(PANE())
  expect((await pane.findAll({ type: 'Text', text: /new chat → opus · hard/ })).length).toBe(1)
  await pane.unmount()
  // Pinned by alias, so a newer Opus is picked up with no change here.
  expect(seen.models).toEqual(['opus', 'opus', 'claude-haiku-5-5'])
})

// /clear, then /model fable, then the first prompt: the chat starts on Fable, not on Haiku's pick.
// The mod sees no /model event for it, so the model the new chat starts on is the evidence.
test('a /clear then /model fable chat is not picked over', async ($: any, on: any) => {
  const memory: Record<string, unknown> = {}
  const t = engine(on, {
    orders: 'model: auto\nmodels: sonnet, opus, fable\n',
    repoOrders: 'model: auto\nmodels: sonnet, opus, fable\n',
    judge: { model: 'opus', effort: 'low', why: 'hard' },
    handlers: {
      'store.get': (_, e: any) => ({ value: memory[e.key] }),
      'store.set': (_, e: any) => {
        memory[e.key] = e.value
        return { value: undefined }
      },
    },
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await typed($, 'Rework the scheduler and fix the deadlock', 't1', 'claude-sonnet-5-5')
  expect(t.systems.filter(s => s.includes('NEW chat')).length).toBe(1)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  // The judge still answers (the pick is decided at the first request); its answer is dropped, so no pin.
  await typed($, 'Diagnose the vehicle routing', 't2', 'claude-fable-5-2')

  expect(t.models).toEqual(['opus', 'claude-fable-5-2'])
})

test('model: off leaves the model alone', async ($: any, on: any) => {
  const seen = engineWith(on, 'model: off\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await typed($, 'Rework the scheduler and fix the deadlock', 't1', 'claude-sonnet-5-5')

  expect(seen.judged()).toBe(0)
  expect(seen.models).toEqual(['claude-sonnet-5-5'])
})

test('settings helpers', () => {
  expect(parseOrders('').isModelAuto).toBe(false)
  expect(parseOrders('model: auto').isModelAuto).toBe(true)
  expect(parseModels('Opus, fable, nonsense')).toEqual(['opus', 'fable'])
  expect(parseModels(undefined)).toEqual(['sonnet', 'opus'])
  expect(parseModel('{"model":"opus","why":"hard"}', ['sonnet', 'opus'])?.model).toBe('opus')
  expect(parseModel('{"model":"haiku"}', ['sonnet', 'opus'])).toBeNull()
  expect(setSetting('a: 1\nmodel: off\nb: 2\n', 'model', 'auto')).toBe('a: 1\nmodel: auto\nb: 2\n')
  expect(setSetting('a: 1', 'model', 'auto')).toBe('a: 1\nmodel: auto\n')
})

import { clampEffort, parseSubagent, subagentModels } from '../hooks/judges'

test('effort range, fixed level and subagent helpers', () => {
  expect(clampEffort('low', 'medium', 'high')).toBe('medium')
  expect(clampEffort('xhigh', 'medium', 'high')).toBe('high')
  expect(clampEffort('high', 'xhigh', 'medium')).toBe('xhigh') // a floor above the ceiling wins
  const o = parseOrders('effort: high\neffort-min: medium\neffort-max: max\nsubagents: auto')
  expect([o.effortFixed, o.effortMin, o.effortMax, o.isSubagentsAuto]).toEqual(['high', 'medium', 'max', true])
  const d = parseOrders('effort: auto')
  expect([d.effortFixed, d.effortMin, d.effortMax, d.isSubagentsAuto]).toEqual([null, 'low', 'xhigh', false])
  expect(subagentModels(['sonnet', 'opus'])).toEqual(['haiku', 'sonnet', 'opus'])
  expect(parseSubagent('{"model":"haiku","effort":"low","why":"search"}', ['haiku', 'opus'])?.effort).toBe('low')
  expect(parseSubagent('{"model":"fable","effort":"low"}', ['haiku', 'opus'])).toBeNull()
})
