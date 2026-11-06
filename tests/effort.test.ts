import { expect, test } from 'claude-code/testing'

import { capEffort, isFollowUp, parseOrders, takesEffort } from '../hooks/judges'

declare const setTimeout: (fn: () => void, ms: number) => unknown

type Seen = { efforts: unknown[]; judged: number }

// Stands in for the engine; the effort judge answers `level`.
function engine(on: any, level: string): Seen {
  const seen: Seen = { efforts: [], judged: 0 }
  on('command.register', () => ({ value: { command: 'orders' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('fs.write', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('model.complete', (_: unknown, e: { system: string }) => {
    if (String(e.system).includes('how hard')) seen.judged += 1
    return { value: { isAnswered: true, text: JSON.stringify({ effort: level, why: 'test' }) } }
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number; effort?: unknown }) {
    seen.efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('ui.toast', () => ({ value: undefined }))
  return seen
}

const settle = async () => {
  for (let i = 0; i < 100; i++) await new Promise(r => setTimeout(() => r(undefined), 0))
}

async function prompt($: any, text: string, model: string, base: string, turnId: string) {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  await settle()
  await $.turn.start({ turnId, prompt: text })
  const s = $.turn.step({ turnId, index: 0, model, effort: base, messageCount: 1 })
  for await (const _ of s) void _
  await s.result
}

test('a typed prompt runs at the judged effort; a go-ahead keeps it without asking', async ($: any, on: any) => {
  const seen = engine(on, 'high')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await prompt($, 'Profile the sim tick and fix whatever is slow', 'claude-opus-5-5', 'medium', 't1')
  expect(seen.efforts).toEqual(['high'])
  expect(seen.judged).toBe(1)

  await prompt($, 'go ahead', 'claude-opus-5-5', 'medium', 't2')
  expect(seen.efforts).toEqual(['high', 'high'])
  expect(seen.judged).toBe(1)
})

test('a model where effort rewrites the cache is left alone', async ($: any, on: any) => {
  const seen = engine(on, 'low')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await prompt($, 'What does this function return?', 'claude-fable-5-1', 'high', 't1')

  expect(seen.efforts).toEqual(['high'])
})

test('changing effort yourself turns auto off', async ($: any, on: any) => {
  const seen = engine(on, 'low')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await prompt($, 'Rename this variable everywhere', 'claude-opus-5-5', 'medium', 't1')
  // The person picked xhigh in the effort menu between prompts.
  await prompt($, 'Now rework the scheduler', 'claude-opus-5-5', 'xhigh', 't2')

  expect(seen.efforts).toEqual(['low', 'xhigh'])
})

test('the pure helpers', () => {
  expect(isFollowUp('go ahead')).toBe(true)
  expect(isFollowUp('Q1: C')).toBe(true)
  expect(isFollowUp('go ahead and also port the planner to C++')).toBe(false)
  expect(takesEffort('claude-opus-5-5')).toBe(true)
  expect(takesEffort('claude-sonnet-5-5[1m]')).toBe(true)
  expect(takesEffort('claude-fable-5-1')).toBe(false)
  expect(takesEffort('opus')).toBe(true)
  expect(takesEffort('claude-opus-6')).toBe(true)
  expect(takesEffort('us.anthropic.claude-sonnet-5-7-v1:0')).toBe(true)
  expect(takesEffort('claude-sonnet-4-5')).toBe(false)
  expect(takesEffort('claude-sonnet-4-20250514')).toBe(false)
  expect(takesEffort('haiku')).toBe(false)
  expect(capEffort('xhigh', 'medium')).toBe('medium')
  expect(capEffort('low', 'medium')).toBe('low')
  const o = parseOrders('effort: off\ncache-ttl: 5\nalways-ask: deploy')
  expect(o.isEffortAuto).toBe(false)
  expect(o.cacheTtlMin).toBe(5)
  expect(o.rail?.test('please Deploy it')).toBe(true)
  // A repo's file adds always-ask words and may lower max-auto.
  const both = parseOrders('always-ask: deploy\nmax-auto: 8', 'always-ask: migrate, publish\nmax-auto: 3')
  expect(both.terms).toEqual(['deploy', 'migrate', 'publish'])
  expect(both.maxAuto).toBe(3)
  expect(both.rail?.test('run the migrate script')).toBe(true)
  expect(both.text).toContain("# This repo's orders")
})

test('a repo file cannot raise what the person set', () => {
  const global = 'max-auto: 8\neffort: auto\neffort-max: xhigh\nmodel: off\nsubagents: off\nmodels: sonnet\ncache-ttl: 60'
  const o = parseOrders(global, 'max-auto: 1000\neffort: max\neffort-max: max\nmodel: auto\nsubagents: auto\nmodels: opus\ncache-ttl: 5')
  expect(o.maxAuto).toBe(8)
  expect(o.effortFixed).toBe(null)
  expect(o.isEffortAuto).toBe(true)
  expect(o.effortMax).toBe('xhigh')
  expect(o.isModelAuto).toBe(false)
  expect(o.isSubagentsAuto).toBe(false)
  expect(o.models).toEqual(['sonnet'])
  expect(o.cacheTtlMin).toBe(5)
  const off = parseOrders('effort: high', 'effort: off')
  expect(off.isEffortAuto).toBe(false)
  expect(off.effortFixed).toBe(null)
})
