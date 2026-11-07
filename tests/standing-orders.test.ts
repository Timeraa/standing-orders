import { expect, test } from 'claude-code/testing'

import { engine, settle } from './support'

const ORDERS = `# test orders
- Leftovers you can do yourself: do them.
always-ask: deploy, merge to main
max-auto: 2
`

async function endTurn($: any, answer: string) {
  await $.turn.start({ turnId: 't1', prompt: 'x' })
  await $.turn.complete({ turnId: 't1', answer, durationMs: 1000, isAborted: false, reason: 'answer' })
  await settle(200) // the judge runs unawaited
}

test('a question the orders cover is drafted, not sent', async ($: any, on: any) => {
  const seen = engine(on, { orders: ORDERS, judge: { action: 'continue', reply: 'Per my standing orders: do 1-3.', checks: [] } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await endTurn($, 'Three items are still open. Want me to do them?')

  expect(seen.filled).toEqual(['Per my standing orders: do 1-3.'])
  expect(seen.submitted).toEqual([])
})

test('an always-ask word turns a continue into a notification', async ($: any, on: any) => {
  const seen = engine(on, { orders: ORDERS, judge: { action: 'continue', reply: 'Yes, deploy it.', checks: [] } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await endTurn($, 'Tests pass. Should I deploy this?')

  expect(seen.filled).toEqual([])
  expect(seen.notified.length).toBe(1)
})

test('an offer without a question mark still hits the rail', async ($: any, on: any) => {
  const seen = engine(on, { orders: ORDERS, judge: { action: 'continue', reply: 'Per my standing orders: yes, go ahead.', checks: [] } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'orders', args: 'auto' })
  await endTurn($, 'The fix is in and tests pass.\n\nSay the word and I will deploy this as build 26.')

  expect(seen.submitted).toEqual([])
  expect(seen.filled).toEqual([])
  expect(seen.notified.length).toBe(1)
})

test('auto mode sends the answer, and a done turn ends quietly', async ($: any, on: any) => {
  const seen = engine(on, { orders: ORDERS, judge: { action: 'continue', reply: 'Per my standing orders: commit.', checks: [] } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'orders', args: 'auto' })
  await endTurn($, 'Nothing is committed. Want me to commit?')

  expect(seen.submitted).toEqual(['Per my standing orders: commit.'])
  expect(seen.filled).toEqual([])
})

test('a turn without a question is not judged', async ($: any, on: any) => {
  const seen = engine(on, { orders: ORDERS, judge: { action: 'continue', reply: 'nope', checks: [] } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await endTurn($, 'Done. All 12 tests pass and the change is committed as abc123.')

  expect(seen.filled).toEqual([])
  expect(seen.submitted).toEqual([])
  expect(seen.notified).toEqual([])
})

test('a long turn that ends without a question still notifies', async ($: any, on: any) => {
  const seen = engine(on, { orders: ORDERS, judge: { action: 'stop', checks: [] } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ turnId: 't1', prompt: 'x' })
  await $.turn.complete({ turnId: 't1', answer: 'Done. All tests pass, committed as abc123.', durationMs: 25 * 60_000, isAborted: false, reason: 'answer' })
  await settle(200)

  expect(seen.notified).toEqual(['Done. All tests pass, committed as abc123.'])
})

test('/orders init asks Claude to write the repo file', async ($: any, on: any) => {
  const t = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'orders', args: 'init' })
  expect(r.text).toContain('.claude/standing-orders.md')

  await t.clock.advance(100)
  expect(t.submitted.length).toBe(1)
  expect(t.submitted[0]).toContain('Write `.claude/standing-orders.md`')
})

test('/orders help explains the modes, and the status points to it', async ($: any, on: any) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const help = await $.command.run({ command: 'orders', args: 'help' })
  expect(help.text).toContain('draft (default)')
  expect(help.text).toContain('When to use what')
  const status = await $.command.run({ command: 'orders', args: '' })
  expect(status.text).toContain('/autopilot')
})

test('the judge sees the open checks, adds new ones and ticks off resolved ones', async ($: any, on: any) => {
  // a list saved by 0.7: plain strings, loaded as dated from now
  const seen = engine(on, {
    orders: ORDERS,
    judge: { action: 'stop', decision: 'Done.', checks: ['Test on a notched Mac'], resolved: ['merge PR #419'] },
    saved: ['Merge PR #419', 'Ask the designer'],
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await endTurn($, 'PR #419 is merged. Still untested on a device. Anything else?')

  expect(seen.prompts[0]).toContain('OPEN CHECKS:\n- Merge PR #419\n- Ask the designer')
  const list = await $.command.run({ command: 'orders', args: 'checks' })
  expect(list.text).toContain('Ask the designer')
  expect(list.text).toContain('Test on a notched Mac')
  expect(list.text).not.toContain('Merge PR')
  const saved = seen.stored.at(-1) as { text: string; at: number; chat: string }[]
  expect(saved.map(c => c.text)).toEqual(['Ask the designer', 'Test on a notched Mac'])
  expect(saved.every(c => typeof c.at === 'number')).toBe(true)
  expect(saved.map(c => c.chat !== '')).toEqual([false, true]) // migrated: no chat; found now: this chat
})
