import { expect, test } from 'claude-code/testing'

import { parseModel, parseModels, parseOrders, setSetting } from '../hooks/judges'

declare const setTimeout: (fn: () => void, ms: number) => unknown

function engine(on: any, orders: string) {
  const seen = { models: [] as string[], judged: 0 }
  on('command.register', () => ({ value: { command: 'orders' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', () => ({ value: orders }))
  on('fs.write', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('model.complete', (_: unknown, e: { system: string }) => {
    if (String(e.system).includes('NEW chat')) seen.judged += 1
    return { value: { isAnswered: true, text: JSON.stringify({ model: 'opus', effort: 'low', why: 'hard' }) } }
  })
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number; model: string }) {
    seen.models.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }))
  return seen
}

const settle = async () => {
  for (let i = 0; i < 100; i++) await new Promise(r => setTimeout(() => r(undefined), 0))
}
const type = async ($: any, text: string, model: string, turnId: string) => {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  await settle()
  await $.turn.start({ turnId, prompt: text })
  const s = $.turn.step({ turnId, index: 0, model, effort: 'medium', messageCount: 1 })
  for await (const _ of s) void _
  await s.result
}

test('a new chat picks its model once, from the first prompt', async ($: any, on: any) => {
  const seen = engine(on, 'model: auto\nmodels: sonnet, opus\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await type($, 'Rework the scheduler and fix the deadlock', 'claude-sonnet-5-5', 't1')
  await type($, 'Also rename the helper', 'claude-sonnet-5-5', 't2')
  // The chat stays on the first pick; running /model yourself ends it.
  await type($, 'Now something else', 'claude-haiku-5-5', 't3')

  expect(seen.judged).toBe(1)
  // Pinned by alias, so a newer Opus is picked up with no change here.
  expect(seen.models).toEqual(['opus', 'opus', 'claude-haiku-5-5'])
})

test('model: off leaves the model alone', async ($: any, on: any) => {
  const seen = engine(on, 'model: off\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await type($, 'Rework the scheduler and fix the deadlock', 'claude-sonnet-5-5', 't1')

  expect(seen.judged).toBe(0)
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
