import { expect, test } from 'claude-code/testing'

import { capEffort, isFollowUp, parseOrders, takesEffort } from '../hooks/judges'
import { PANE, engine, typed } from './support'

// The effort judge answers `level`; it was asked once per "how hard" system prompt.
function engineWith(on: any, level: string) {
  const t = engine(on, { judge: { effort: level, why: 'test' } })
  return { ...t, judged: () => t.systems.filter(s => s.includes('how hard')).length }
}

test('a typed prompt runs at the judged effort; a go-ahead keeps it without asking', async ($: any, on: any) => {
  const seen = engineWith(on, 'high')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await typed($, 'Profile the sim tick and fix whatever is slow', 't1', 'claude-opus-5-5', 'medium')
  expect(seen.efforts).toEqual(['high'])
  expect(seen.judged()).toBe(1)

  await typed($, 'go ahead', 't2', 'claude-opus-5-5', 'medium')
  expect(seen.efforts).toEqual(['high', 'high'])
  expect(seen.judged()).toBe(1)

  // the judged pick reaches the Activity feed once; the kept go-ahead adds nothing
  const pane = await $.ui.mount(PANE('desktop'))
  await pane.press({ key: 'now' }) // a first run opens the pane on Settings
  expect((await pane.findAll({ type: 'Text', text: /effort high · test/ })).length).toBe(1)
  await pane.unmount()
})

test('a model where effort rewrites the cache is left alone', async ($: any, on: any) => {
  const seen = engineWith(on, 'low')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await typed($, 'What does this function return?', 't1', 'claude-fable-5-1', 'high')

  expect(seen.efforts).toEqual(['high'])
})

test('changing effort yourself turns auto off', async ($: any, on: any) => {
  const seen = engineWith(on, 'low')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await typed($, 'Rename this variable everywhere', 't1', 'claude-opus-5-5', 'medium')
  // The person picked xhigh in the effort menu between prompts.
  await typed($, 'Now rework the scheduler', 't2', 'claude-opus-5-5', 'xhigh')

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
