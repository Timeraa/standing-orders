import { expect, mock, test } from 'claude-code/testing'

import { DEFAULT_ORDERS, fit, isPick, logBody, logLine, pickText } from '../hooks/judges'

declare const setTimeout: (fn: () => void, ms: number) => unknown
const settle = async () => {
  for (let i = 0; i < 100; i++) await new Promise(r => setTimeout(() => r(undefined), 0))
}

// Stands in for the session's state: what a test sets is what the pane reads, and what the plugin writes stays.
function store(on: any) {
  const values: Record<string, unknown> = {}
  on('state.get', (_: unknown, e: { key: string }) =>
    e.key in values ? { value: { value: values[e.key], version: 1 } } : { value: { value: undefined, version: 0 } },
  )
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => {
    values[e.key] = e.value
    return { value: { isSet: true, version: 1 } }
  })
  return (key: string, value: unknown) => {
    values[key] = value
  }
}
const PANE = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'standing-orders',
    surface,
    component: 'Pane',
    requestId: 'autopilot',
    props: { title: 'Autopilot', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  }) as const

// The status line and the Autopilot pane draw on every surface from what the
// state holds, with nothing beneath the plugin.
test('the band and the Autopilot pane draw: Now, then Settings, whose buttons write the file', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const set = store(on)
  let file = DEFAULT_ORDERS
  const written: string[] = []
  const submitted: string[] = []
  on('command.register', () => ({ value: { command: 'orders' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', (_: unknown, e: { path: string }) => (e.path === '/home/t/.claude/standing-orders.md' ? { value: file } : { deny: 'missing' }))
  on('fs.write', (_: unknown, e: { text: string }) => {
    file = e.text
    written.push(e.text)
    return { value: undefined }
  })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  const seed = async () => {
    await set('tab', 'now')
    await set('run', { autoCount: 2, startedAt: 0, pending: 'Deploy to production?', last: null })
    await set('effort', { level: 'high', why: 'test', isAuto: true, isJudging: false, isSaving: false })
    await set('vitals', { now: 600_000, contextPercent: 41, lastResponseAt: 100_000, cacheTtlMin: 60, ratePercent: 20, hasRepoOrders: false })
    // seven open: the pane shows the newest five and offers the rest
    await set('checks', [
      ...Array.from({ length: 6 }, (_, i) => ({ text: `Old check ${i}`, at: 100_000 + i, chat: 'a' })),
      { text: 'Test the island on a notched Mac', at: 590_000, chat: 'a' },
    ])
    // nine entries: the feed shows the newest eight, one of each kind among them
    await set('log', [
      { at: 300_000, kind: 'answered', text: 'Ancient reply 0' },
      { at: 310_000, kind: 'answered', text: 'Ancient reply 1' },
      { at: 500_000, kind: 'answered', text: 'Per my standing orders: yes, run the tests.' },
      { at: 510_000, kind: 'drafted', text: 'Per my standing orders: yes, commit.' },
      { at: 520_000, kind: 'asked', text: 'Deploy to production?' },
      { at: 530_000, kind: 'stopped', text: 'Shipped the fix.' },
      { at: 540_000, kind: 'effort', text: pickText('high', 'multi-file feature') },
      { at: 550_000, kind: 'model', text: pickText('opus', 'hard debugging') },
      { at: 560_000, kind: 'subagent', text: pickText('haiku/low', 'grep the repo') },
    ])
    await set('counts', { effort: { high: 2 }, models: { opus: 1 }, subagents: 1 })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    await seed()
    const band = await $.ui.mount({
      plugin: 'standing-orders',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 10 },
    })
    expect((await band.find({ type: 'Text', text: /High/ }))?.text).toContain('High')
    expect((await band.find({ type: 'Text', text: /cache/ }))?.text).toContain('cache 51:40')
    expect((await band.find({ type: 'Text', text: /Needs you/ }))?.text).toContain('Deploy')
    // seven open checks: the count, not an agent count
    expect(await band.find({ type: 'Button', label: 'Autopilot · 7 to do' })).toBeTruthy()
    expect(await band.find({ type: 'Button', text: /agents/ })).toBeFalsy()
    expect(await band.find({ type: 'Button', label: /Orders/ })).toBeTruthy()
    await band.unmount()

    let pane = await $.ui.mount(PANE(surface))
    // The stand-in state has no readers to redraw, so each press mounts the pane again.
    const press = async (key: string) => {
      await pane.press({ key })
      await pane.unmount()
      pane = await $.ui.mount(PANE(surface))
    }
    // Now: header, Needs you, Activity, footer
    expect(await pane.find({ type: 'Text', text: /answered 2 of 8/ })).toBeTruthy()
    expect(await pane.find({ type: 'Button', label: /Pause/ })).toBeTruthy()
    expect(await pane.find({ type: 'Button', label: /Close/ })).toBeTruthy()
    expect((await pane.find({ type: 'Text', text: /Needs you/ }))?.text).toContain('Needs you · 8')
    expect(await pane.find({ type: 'Text', text: /Deploy to production\?/ })).toBeTruthy()
    expect((await pane.find({ type: 'Text', text: /notched/ }))?.text).toContain('notched')
    expect(await pane.find({ type: 'Button', label: /Done/ })).toBeTruthy()
    expect(await pane.find({ type: 'Button', text: /\+2 older/ })).toBeTruthy()
    expect(await pane.find({ type: 'Text', text: /Old check 0/ })).toBeFalsy()
    for (const line of [
      /sent: Per my standing orders: yes, run/,
      /drafted: .*commit/,
      /asked you: Deploy/,
      /finished: Shipped/,
      /effort high · multi-file feature/,
      /new chat → opus · hard debugging/,
      /subagent → haiku\/low · grep the repo/,
      /Ancient reply 1/,
    ]) expect(await pane.find({ type: 'Text', text: line })).toBeTruthy()
    expect(await pane.find({ type: 'Text', text: /Ancient reply 0/ })).toBeFalsy()
    expect(await pane.find({ type: 'Text', text: /this session/ })).toBeTruthy()
    expect((await pane.find({ type: 'Text', text: /ctx/ }))?.text).toBe('ctx 41%')
    expect((await pane.find({ type: 'Text', text: /limit/ }))?.text).toBe('limit 20%')
    expect((await pane.find({ type: 'Text', text: /cache/ }))?.text).toBe('cache 51:40 left')
    // agents are not listed here any more
    expect(await pane.find({ type: 'Text', text: /Agents|Finished|lane-icons/ })).toBeFalsy()
    expect(await pane.find({ type: 'Button', text: /undefined/ })).toBeFalsy()
    // the older checks open and close again
    await press('older')
    expect(await pane.find({ type: 'Text', text: /Old check 0/ })).toBeTruthy()
    await press('older')
    expect(await pane.find({ type: 'Text', text: /Old check 0/ })).toBeFalsy()

    // Settings
    await press('settings')
    expect(await pane.find({ type: 'Text', text: /Effort/ })).toBeTruthy()
    expect(await pane.find({ type: 'Text', text: /New chats/ })).toBeTruthy()
    expect(await pane.find({ type: 'Text', text: /Subagents/ })).toBeTruthy()
    expect(await pane.find({ type: 'Text', text: /Repo orders/ })).toBeTruthy()
    expect(await pane.find({ type: 'Text', text: /standing-orders\.md/ })).toBeTruthy()
    expect(await pane.find({ type: 'Button', text: /⟳ auto/ })).toBeTruthy()
    expect(await pane.find({ type: 'Button', text: /floor low \(default\)/ })).toBeTruthy()
    expect(await pane.find({ type: 'Button', text: /ceiling xhigh \(default\)/ })).toBeTruthy()
    expect((await pane.find({ type: 'Button', key: 'model' }))?.text).toBe('Turn off')
    expect((await pane.find({ type: 'Button', key: 'subagents' }))?.text).toBe('Turn off')
    expect(await pane.find({ type: 'Button', text: /undefined/ })).toBeFalsy()
    expect(await pane.find({ type: 'Text', text: /undefined/ })).toBeFalsy()
    expect(await pane.find({ type: 'Button', label: 'Now' })).toBeTruthy()
    expect(await pane.find({ type: 'Button', label: /Close/ })).toBeTruthy()

    // every click writes the file, and the pane follows it
    await press('subagents')
    expect(written.at(-1)).toContain('subagents: off')
    expect((await pane.find({ type: 'Button', key: 'subagents' }))?.text).toBe('Turn on')
    await press('subagents')
    expect(written.at(-1)).toContain('subagents: auto')
    await press('model')
    expect(written.at(-1)).toContain('model: off')
    await press('model')
    expect(written.at(-1)).toContain('model: auto')
    await press('floor')
    expect(written.at(-1)).toContain('effort-min: medium')
    expect(await pane.find({ type: 'Button', text: /floor medium$/ })).toBeTruthy()
    await press('reset')
    expect(written.at(-1)).toContain('effort-min: low')
    expect(written.at(-1)).toContain('effort-max: xhigh')
    // the cycle: auto, then each level, then off, then back to auto
    await press('effort')
    expect(written.at(-1)).toContain('effort: low')
    expect(await pane.find({ type: 'Button', text: /floor/ })).toBeFalsy() // a fixed level has no range
    for (let i = 0; i < 6; i++) await press('effort')
    expect(written.at(-1)).toContain('effort: auto')
    expect(await pane.find({ type: 'Button', text: /floor low/ })).toBeTruthy()

    // no repo orders here: the button has Claude write them
    submitted.length = 0
    await press('init')
    await clock.advance(100)
    expect(submitted.length).toBe(1)
    expect(submitted[0]).toContain('Write `.claude/standing-orders.md`')

    await press('now')
    expect(await pane.find({ type: 'Text', text: /Activity/ })).toBeTruthy()
    await pane.unmount()
  }
})

// A repo that has orders shows "found", with nothing to write.
test('the Settings tab reports repo orders as found', async ($: any, on: any) => {
  mock.clock(on)
  const set = store(on)
  on('command.register', () => ({ value: { command: 'orders' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', () => ({ value: DEFAULT_ORDERS }))
  on('fs.write', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  await set('tab', 'settings')

  const pane = await $.ui.mount(PANE('terminal'))
  expect((await pane.find({ type: 'Text', text: /^found$/ }))?.text).toBe('found')
  expect(await pane.find({ type: 'Button', key: 'init' })).toBeFalsy()
  await pane.unmount()
})

// The 5-second refresh end to end: usage reaches the band and the footer, a
// first run opens the Settings tab, and /autopilot (and its old name /crew) toggles the pane.
test('the refresh fills the footer from usage; first run and /orders setup open Settings; /crew still opens the pane', async ($: any, on: any) => {
  const set = store(on)
  let ran = 0
  let isOpen = false
  const opened: string[] = []
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
  on('ui.panes', () => ({ value: isOpen ? [{ id: 'autopilot' }] : [] }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    isOpen = true
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    isOpen = false
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()

  // first run: the pane opened on the Settings tab
  expect(opened).toEqual(['autopilot'])
  let pane = await $.ui.mount(PANE('terminal'))
  const press = async (key: string) => {
    await pane.press({ key })
    await pane.unmount()
    pane = await $.ui.mount(PANE('terminal'))
  }
  expect(await pane.find({ type: 'Button', key: 'effort' })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: /Repo orders/ })).toBeTruthy()
  expect(await pane.find({ type: 'Button', label: 'Write them' })).toBeTruthy()
  await press('now')
  expect((await pane.find({ type: 'Text', text: /ctx/ }))?.text).toBe('ctx 63%')
  expect((await pane.find({ type: 'Text', text: /limit/ }))?.text).toBe('limit 90%')
  expect(await pane.find({ type: 'Text', text: /lane-icons/ })).toBeFalsy() // agents are not listed
  await pane.unmount()

  const band = await $.ui.mount({
    plugin: 'standing-orders',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10 },
  })
  expect((await band.find({ type: 'Text', text: /orders init/ }))?.text).toContain('no repo orders')
  expect((await band.find({ type: 'Text', text: /ctx/ }))?.text).toContain('ctx 63%')
  expect(await band.find({ type: 'Button', label: 'Autopilot' })).toBeTruthy()
  expect(await band.find({ type: 'Button', text: /agents|Crew/ })).toBeFalsy()
  await band.unmount()

  // one command, two names: each toggles the same pane
  expect((await $.command.run({ command: 'autopilot', args: '' })).text).toContain('closed') // it was open
  expect((await $.command.run({ command: 'crew', args: '' })).text).toContain('opened')
  expect((await $.command.run({ command: 'crew', args: '' })).text).toContain('closed')
  expect((await $.command.run({ command: 'autopilot', args: '' })).text).toContain('opened')

  // /orders setup lands on the Settings tab even when the pane was left on Now
  await set('tab', 'now')
  expect((await $.command.run({ command: 'orders', args: 'setup' })).text).toContain('settings')
  const again = await $.ui.mount(PANE('terminal'))
  expect(await again.find({ type: 'Button', key: 'effort' })).toBeTruthy()
  await again.unmount()
  expect((await $.command.run({ command: 'orders', args: '' })).text).toContain('/autopilot')
  expect(ran).toBe(0) // nothing is run on the machine
})

// Orders written after the start (Claude writing the repo file, an edit) reach the pane without a prompt.
test('a repo orders file that appears later is picked up by the refresh', async ($: any, on: any) => {
  mock.clock(on)
  const set = store(on)
  let hasRepo = false
  on('command.register', () => ({ value: { command: 'orders' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', (_: unknown, e: { path: string }) =>
    e.path.startsWith('/repo/') ? (hasRepo ? { value: 'always-ask: migrate' } : { deny: 'missing' }) : { value: DEFAULT_ORDERS },
  )
  on('fs.write', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  await set('tab', 'settings')
  const before = await $.ui.mount(PANE('terminal'))
  expect(await before.find({ type: 'Button', key: 'init' })).toBeTruthy()
  await before.unmount()

  hasRepo = true
  await $.command.run({ command: 'autopilot', args: '' }) // runs the refresh
  await settle()
  const after = await $.ui.mount(PANE('terminal'))
  expect((await after.find({ type: 'Text', text: /^found$/ }))?.text).toBe('found')
  expect(await after.find({ type: 'Button', key: 'init' })).toBeFalsy()
  expect((await after.find({ type: 'Text', text: /always-ask words/ }))?.text).toContain('18 always-ask words')
  await after.unmount()
})

test('log lines: decisions read with a colon, picks read as a sentence', () => {
  expect(logLine({ at: 0, kind: 'asked', text: 'Deploy?' }, 120_000)).toBe('?  2m  asked you: Deploy?')
  expect(logLine({ at: 0, kind: 'effort', text: pickText('high', 'multi-file feature') }, 5_000)).toBe('◆  5s  effort high · multi-file feature')
  expect(logBody({ kind: 'model', text: pickText('opus', 'hard debugging') })).toBe('new chat → opus · hard debugging')
  expect(logBody({ kind: 'subagent', text: pickText('haiku/low', 'grep the repo') })).toBe('subagent → haiku/low · grep the repo')
  expect(pickText('opus', '  ')).toBe('opus')
  expect(['answered', 'asked', 'effort', 'model', 'subagent'].map(k => isPick(k as never))).toEqual([false, false, true, true, true])
  expect(fit('abcdef', 4)).toBe('abc…')
})
