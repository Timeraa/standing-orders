import { expect, test } from 'claude-code/testing'

declare const setTimeout: (fn: () => void, ms: number) => unknown

type Seen = { efforts: unknown[]; spawned: any[]; judged: string[]; a1: string }

function engine(on: any, orders: string): Seen {
  const seen: Seen = { efforts: [], spawned: [], judged: [], a1: 'running' }
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'find foo', type: 'Explore', status: seen.a1 }] }))
  on('ui.panes', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'orders' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', () => ({ value: orders }))
  on('fs.write', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.sleep', async () => {
    await new Promise(r => setTimeout(() => r(undefined), 2000)) // the judge answers well before this
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
  on('model.complete', (_: unknown, e: { system: string }) => {
    seen.judged.push(String(e.system).slice(0, 30))
    const text = String(e.system).includes('helper subagent')
      ? '{"model":"haiku","effort":"low","why":"search"}'
      : '{"effort":"medium","why":"test"}'
    return { value: { isAnswered: true, text } }
  })
  on('agent.spawn', (_: unknown, e: unknown) => {
    seen.spawned.push(e)
    return { agentId: 'a1', model: 'claude-haiku-5-5' } as never
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number; effort?: unknown }) {
    seen.efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }))
  return seen
}

const settle = async () => {
  for (let i = 0; i < 100; i++) await new Promise(r => setTimeout(() => r(undefined), 0))
}
const step = async ($: any, turnId: string, model: string, agentId?: string) => {
  const s = $.turn.step({ turnId, index: 0, model, effort: 'medium', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of s) void _
  await s.result
}

test('a fixed effort runs every prompt at it with no judge', async ($: any, on: any) => {
  const seen = engine(on, 'effort: xhigh\nmodel: off\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Rename a variable', origin: { kind: 'composer' }, wait: false })
  await settle()
  await $.turn.start({ turnId: 't1', prompt: 'x' })
  await step($, 't1', 'claude-opus-5-5')

  expect(seen.efforts).toEqual(['xhigh'])
  expect(seen.judged).toEqual([])
})

test('auto effort stays inside the range', async ($: any, on: any) => {
  const seen = engine(on, 'effort: auto\neffort-min: high\neffort-max: xhigh\nmodel: off\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Rename a variable', origin: { kind: 'composer' }, wait: false })
  await settle()
  await $.turn.start({ turnId: 't1', prompt: 'x' })
  await step($, 't1', 'claude-opus-5-5')

  expect(seen.efforts).toEqual(['high']) // the judge said medium; the floor lifts it
})

test('a subagent gets a model and effort from its task; a named model stays', async ($: any, on: any) => {
  const seen = engine(on, 'subagents: auto\nmodel: off\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'grep for foo', description: 'find foo', subagentType: 'Explore' } as never)
  await $.agent.spawn({ prompt: 'grep for bar', description: 'find bar', subagentType: 'Explore', model: 'opus' } as never)
  await $.agent.spawn({ prompt: 'continue', description: 'fork', subagentType: 'x', fork: true } as never)

  expect(seen.spawned.map(e => e.model)).toEqual(['haiku', 'opus', undefined])
  expect(seen.judged.length).toBe(2) // the fork was not judged
  // every request of the steered subagent runs at its picked effort
  await step($, 't9', 'claude-opus-5-5', 'a1')
  expect(seen.efforts).toEqual(['low'])
  // once it has finished, the refresh forgets its effort
  seen.a1 = 'completed'
  await $.command.run({ command: 'crew', args: '' })
  await settle()
  await step($, 't10', 'claude-opus-5-5', 'a1')
  expect(seen.efforts).toEqual(['low', 'medium'])
})

test('subagents: off leaves spawns alone', async ($: any, on: any) => {
  const seen = engine(on, 'subagents: off\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'grep for foo', description: 'find foo', subagentType: 'Explore' } as never)

  expect(seen.spawned[0].model).toBeUndefined()
  expect(seen.judged).toEqual([])
})
