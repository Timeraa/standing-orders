import { expect, test } from 'claude-code/testing'

import { PANE, engine, settle, step } from './support'

type Seen = ReturnType<typeof engine> & { spawned: any[]; a1: string }

// The orders answer every file read, the repo's too. The judge: a helper subagent gets a model and an effort, a prompt gets an effort.
function steer(on: any, orders: string): Seen {
  const seen: Seen = engine(on, {
    orders,
    repoOrders: orders,
    judge: ({ system }) =>
      system.includes('helper subagent') ? { model: 'haiku', effort: 'low', why: 'search' } : { effort: 'medium', why: 'test' },
    handlers: {
      'agent.list': () => ({ value: [{ id: 'a1', description: 'find foo', type: 'Explore', status: seen.a1 }] }),
      'agent.spawn': (_, e) => {
        seen.spawned.push(e)
        return { agentId: 'a1', model: 'claude-haiku-5-5' }
      },
    },
  }) as Seen
  seen.spawned = []
  seen.a1 = 'running'
  return seen
}

test('a fixed effort runs every prompt at it with no judge', async ($: any, on: any) => {
  const seen = steer(on, 'effort: xhigh\nmodel: off\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Rename a variable', origin: { kind: 'composer' }, wait: false })
  await settle()
  await $.turn.start({ turnId: 't1', prompt: 'x' })
  await step($, 't1', 'claude-opus-5-5')

  expect(seen.efforts).toEqual(['xhigh'])
  expect(seen.systems).toEqual([])
})

test('auto effort stays inside the range', async ($: any, on: any) => {
  const seen = steer(on, 'effort: auto\neffort-min: high\neffort-max: xhigh\nmodel: off\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Rename a variable', origin: { kind: 'composer' }, wait: false })
  await settle()
  await $.turn.start({ turnId: 't1', prompt: 'x' })
  await step($, 't1', 'claude-opus-5-5')

  expect(seen.efforts).toEqual(['high']) // the judge said medium; the floor lifts it
})

test('a subagent gets a model and effort from its task; a named model stays', async ($: any, on: any) => {
  const seen = steer(on, 'subagents: auto\nmodel: off\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'grep for foo', description: 'find foo', subagentType: 'Explore' } as never)
  await $.agent.spawn({ prompt: 'grep for bar', description: 'find bar', subagentType: 'Explore', model: 'opus' } as never)
  await $.agent.spawn({ prompt: 'continue', description: 'fork', subagentType: 'x', fork: true } as never)

  expect(seen.spawned.map(e => e.model)).toEqual(['haiku', 'opus', undefined])
  expect(seen.systems.length).toBe(2) // the fork was not judged
  // each steered spawn reaches the Activity feed with its why; the fork does not
  const pane = await $.ui.mount(PANE('desktop'))
  expect((await pane.findAll({ type: 'Text', text: /subagent → haiku\/low · search/ })).length).toBe(2)
  await pane.unmount()
  // every request of the steered subagent runs at its picked effort
  await step($, 't9', 'claude-opus-5-5', { agentId: 'a1' })
  expect(seen.efforts).toEqual(['low'])
  // once it has finished, the refresh forgets its effort
  seen.a1 = 'completed'
  await $.command.run({ command: 'autopilot', args: '' })
  await settle()
  await step($, 't10', 'claude-opus-5-5', { agentId: 'a1' })
  expect(seen.efforts).toEqual(['low', 'medium'])
})

test('subagents: off leaves spawns alone', async ($: any, on: any) => {
  const seen = steer(on, 'subagents: off\n')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'grep for foo', description: 'find foo', subagentType: 'Explore' } as never)

  expect(seen.spawned[0].model).toBeUndefined()
  expect(seen.systems).toEqual([])
})
