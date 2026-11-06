import { expect, mock, test } from 'claude-code/testing'

declare const setTimeout: (fn: () => void, ms: number) => unknown

const ORDERS = `# test orders
- Leftovers you can do yourself: do them.
always-ask: deploy, merge to main
max-auto: 2
`

type Seen = { filled: string[]; submitted: string[]; notified: string[] }

// Stands in for the engine; `verdict` is what Haiku answers.
function engine(on: any, verdict: object): Seen {
  const seen: Seen = { filled: [], submitted: [], notified: [] }
  on('command.register', () => ({ value: { command: 'orders' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', (_: unknown, e: { path: string }) =>
    e.path.endsWith('/home/t/.claude/standing-orders.md')
      ? { value: ORDERS }
      : { deny: 'missing' },
  )
  on('fs.write', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: JSON.stringify(verdict) },
  }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_: unknown, e: { text: string }) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.notify', (_: unknown, e: { text: string }) => {
    seen.notified.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('clock.now', () => ({ value: 1000 }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  return seen
}

async function endTurn($: any, answer: string) {
  await $.turn.start({ turnId: 't1', prompt: 'x' })
  await $.turn.complete({ turnId: 't1', answer, durationMs: 1000, isAborted: false, reason: 'answer' })
  for (let i = 0; i < 200; i++) await new Promise(r => setTimeout(() => r(undefined), 0)) // the judge runs unawaited
}

test('a question the orders cover is drafted, not sent', async ($: any, on: any) => {
  const seen = engine(on, { action: 'continue', reply: 'Per my standing orders: do 1-3.', checks: [] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await endTurn($, 'Three items are still open. Want me to do them?')

  expect(seen.filled).toEqual(['Per my standing orders: do 1-3.'])
  expect(seen.submitted).toEqual([])
})

test('an always-ask word turns a continue into a notification', async ($: any, on: any) => {
  const seen = engine(on, { action: 'continue', reply: 'Yes, deploy it.', checks: [] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await endTurn($, 'Tests pass. Should I deploy this?')

  expect(seen.filled).toEqual([])
  expect(seen.notified.length).toBe(1)
})

test('an offer without a question mark still hits the rail', async ($: any, on: any) => {
  const seen = engine(on, { action: 'continue', reply: 'Per my standing orders: yes, go ahead.', checks: [] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'orders', args: 'auto' })
  await endTurn($, 'The fix is in and tests pass.\n\nSay the word and I will deploy this as build 26.')

  expect(seen.submitted).toEqual([])
  expect(seen.filled).toEqual([])
  expect(seen.notified.length).toBe(1)
})

test('auto mode sends the answer, and a done turn ends quietly', async ($: any, on: any) => {
  const seen = engine(on, { action: 'continue', reply: 'Per my standing orders: commit.', checks: [] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'orders', args: 'auto' })
  await endTurn($, 'Nothing is committed. Want me to commit?')

  expect(seen.submitted).toEqual(['Per my standing orders: commit.'])
  expect(seen.filled).toEqual([])
})

test('a turn without a question is not judged', async ($: any, on: any) => {
  const seen = engine(on, { action: 'continue', reply: 'nope', checks: [] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await endTurn($, 'Done. All 12 tests pass and the change is committed as abc123.')

  expect(seen.filled).toEqual([])
  expect(seen.submitted).toEqual([])
  expect(seen.notified).toEqual([])
})

test('a long turn that ends without a question still notifies', async ($: any, on: any) => {
  const seen = engine(on, { action: 'stop', checks: [] })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ turnId: 't1', prompt: 'x' })
  await $.turn.complete({ turnId: 't1', answer: 'Done. All tests pass, committed as abc123.', durationMs: 25 * 60_000, isAborted: false, reason: 'answer' })
  for (let i = 0; i < 200; i++) await new Promise(r => setTimeout(() => r(undefined), 0))

  expect(seen.notified).toEqual(['Done. All tests pass, committed as abc123.'])
})

test('/orders init asks Claude to write the repo file', async ($: any, on: any) => {
  const clock = mock.clock(on)
  const submitted: string[] = []
  on('command.register', () => ({ value: { command: 'orders' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('fs.write', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'orders', args: 'init' })
  expect(r.text).toContain('.claude/standing-orders.md')

  await clock.advance(100)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('Write `.claude/standing-orders.md`')
})

test('/orders help explains the modes, and the status points to it', async ($: any, on: any) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'orders' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('fs.write', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const help = await $.command.run({ command: 'orders', args: 'help' })
  expect(help.text).toContain('draft (default)')
  expect(help.text).toContain('When to use what')
  const status = await $.command.run({ command: 'orders', args: '' })
  expect(status.text).toContain('/crew')
})
