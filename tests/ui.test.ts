import { expect, test } from 'claude-code/testing'

// The status line and the crew pane draw on every surface from what the state
// holds, with nothing beneath the plugin.
test('the band and the crew pane draw', async ($: any, on: any) => {
  on('state.get', (_: unknown, e: { key: string }) => {
    const values: Record<string, unknown> = {
      run: { autoCount: 2, startedAt: 0, pending: 'Deploy to production?', last: null },
      effort: { level: 'high', why: 'test', isAuto: true, isJudging: false, isSaving: false },
      vitals: {
        now: 600_000,
        contextPercent: 41,
        lastResponseAt: 100_000,
        cacheTtlMin: 60,
        ratePercent: 20,
        hasRepoOrders: true,
      },
      crew: [
        { id: 'main', name: 'main conversation', type: 'main', status: 'running', model: 'claude-opus-5-5', startedAt: 0, lastAt: 590_000, lastTool: 'Bash run tests', tools: 9 },
        { id: 'a1', name: 'lane-icons', type: 'general-purpose', status: 'running', model: 'claude-haiku-5-5', startedAt: 60_000, lastAt: 580_000, lastTool: 'Edit EntityIcon.gd', tools: 14 },
      ],
      checks: ['Test the island on a notched Mac'],
      log: [{ at: 590_000, kind: 'drafted', text: 'Per my standing orders: yes, commit.' }],
    }
    return e.key in values ? { value: { value: values[e.key], version: 1 } } : { value: { value: undefined, version: 0 } }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'standing-orders',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 10 },
    })
    expect((await band.find({ type: 'Text', text: /High/ }))?.text).toContain('High')
    expect((await band.find({ type: 'Text', text: /cache/ }))?.text).toContain('cache 51:40')
    expect((await band.find({ type: 'Text', text: /Needs you/ }))?.text).toContain('Deploy')
    expect(await band.find({ type: 'Button', label: 'Crew' })).toBeTruthy()
    expect(await band.find({ type: 'Button', label: /Orders/ })).toBeTruthy()
    await band.unmount()

    const pane = await $.ui.mount({
      plugin: 'standing-orders',
      surface,
      component: 'Pane',
      requestId: 'crew',
      props: { title: 'Crew', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect((await pane.find({ type: 'Text', text: /lane-icons/ }))?.text).toContain('haiku')
    expect((await pane.find({ type: 'Text', text: /Needs you/ }))?.text).toContain('Needs you')
    expect((await pane.find({ type: 'Text', text: /notched/ }))?.text).toContain('notched')
    expect((await pane.find({ type: 'Text', text: /drafted/ }))?.text).toContain('commit')
    expect(await pane.find({ type: 'Button', label: /Pause/ })).toBeTruthy()
    expect(await pane.find({ type: 'Button', label: /Close/ })).toBeTruthy()
    expect(await pane.find({ type: 'Button', label: /Done/ })).toBeTruthy()
    expect(await pane.find({ type: 'Button', text: /Turn (on|off)/ })).toBeTruthy()
    expect(await pane.find({ type: 'Button', text: /⟳/ })).toBeTruthy()
    await pane.unmount()

    // The setup pane never shows a blank range, even from an older saved value.
    const setup = await $.ui.mount({
      plugin: 'standing-orders',
      surface,
      component: 'Pane',
      requestId: 'setup',
      props: { title: 'Setup', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await setup.find({ type: 'Button', text: /floor low \(default\)/ })).toBeTruthy()
    expect(await setup.find({ type: 'Button', text: /ceiling xhigh \(default\)/ })).toBeTruthy()
    expect(await setup.find({ type: 'Button', text: /undefined/ })).toBeFalsy()
    await setup.unmount()
  }
})

declare const setTimeout: (fn: () => void, ms: number) => unknown
const settle = async () => {
  for (let i = 0; i < 100; i++) await new Promise(r => setTimeout(() => r(undefined), 0))
}

// The 5-second refresh end to end: usage and the agent list reach the band.
test('the refresh fills the band from usage and agents, and offers /orders init', async ($: any, on: any) => {
  let ran = 0
  on('command.register', () => ({ value: { command: 'orders' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('fs.write', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1000 }))
  on('clock.every', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000, percent: 63 }, rateLimits: [{ kind: '5h', percentUsed: 90 }] },
  }))
  on('process.run', () => {
    ran += 1
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('agent.list', () => ({
    value: [{ id: 'a1', description: 'lane-icons', type: 'general-purpose', status: 'running' }],
  }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()

  const band = await $.ui.mount({
    plugin: 'standing-orders',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10 },
  })
  expect((await band.find({ type: 'Text', text: /orders init/ }))?.text).toContain('no repo orders')
  expect((await band.find({ type: 'Text', text: /ctx/ }))?.text).toContain('ctx 63%')
  expect((await band.find({ type: 'Button', text: /agents/ }))).toBeTruthy()
  await band.unmount()
  expect(ran).toBe(0) // nothing is run on the machine
})
