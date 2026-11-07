import { expect, test } from 'claude-code/testing'
import { AUTO_REPLY, IDLE, beforeJudging, decide, drafted, sent, waiting, whenTyped, type Flags } from '../hooks/run'

const run = { autoCount: 2, startedAt: 500, pending: 'which db?', last: 'Per the orders: yes.' }

// ---- transitions ---------------------------------------------------------

test('typing the drafted answer continues the run: one more standing answer, nothing pending, start kept', () => {
  const t = whenTyped(run, { text: 'Per the orders: yes.', now: 900 })
  expect(t.isDraftSent).toBe(true)
  expect(t.run).toEqual({ autoCount: 3, startedAt: 500, pending: null, last: 'Per the orders: yes.' })
})

test('typing anything else starts a new run at that time', () => {
  const t = whenTyped(run, { text: 'something else', now: 900 })
  expect(t.isDraftSent).toBe(false)
  expect(t.run).toEqual({ ...IDLE, startedAt: 900 })
})

test('draft-sent detection trims the typed text but is otherwise exact', () => {
  const is = (text: string) => whenTyped(run, { text, now: 1 }).isDraftSent
  expect(is('  Per the orders: yes.\n')).toBe(true)
  expect(is('per the orders: yes.')).toBe(false) // QUIRK: case counts
  expect(is('Per the orders: yes')).toBe(false) // QUIRK: an edit of one character is the person speaking
  expect(is('Per the  orders: yes.')).toBe(false) // inner whitespace counts
})

test('with no answer yet, no text is a sent draft (last is null, trimmed text never is)', () => {
  expect(whenTyped(IDLE, { text: '', now: 7 })).toEqual({ isDraftSent: false, run: { ...IDLE, startedAt: 7 } })
})

test('QUIRK: the last answer can have been auto-sent; typing the same words is still taken for it', () => {
  const after = sent(IDLE, 'go on')
  expect(whenTyped(after, { text: 'go on', now: 9 }).isDraftSent).toBe(true)
})

test('waiting, sent and drafted change only what they name', () => {
  expect(waiting(run, 'deploy?')).toEqual({ ...run, pending: 'deploy?' })
  expect(sent(run, 'ok')).toEqual({ autoCount: 3, startedAt: 500, pending: null, last: 'ok' })
  expect(drafted(run, 'ok')).toEqual({ autoCount: 2, startedAt: 500, pending: null, last: 'ok' })
})

// ---- the guards, in order ------------------------------------------------

test('before the judge is asked: paused first, then the person having spoken this turn', () => {
  const ok = { isPaused: false, composerAt: 0, turnStartedAt: 0 }
  expect(beforeJudging(ok)).toBeNull()
  expect(beforeJudging({ ...ok, isPaused: true })).toBe('paused')
  expect(beforeJudging({ ...ok, composerAt: 6, turnStartedAt: 5 })).toBe('person-spoke')
  expect(beforeJudging({ ...ok, composerAt: 5, turnStartedAt: 5 })).toBeNull() // spoke before the turn began, not during
  expect(beforeJudging({ isPaused: true, composerAt: 6, turnStartedAt: 5 })).toBe('paused') // earlier guard wins
})

// A flag set that reaches the last step: auto mode, a plain continue, nothing in the way.
const clear: Flags = {
  verdict: { action: 'continue', reply: 'yes' },
  composerAt: 0,
  judgedAt: 10,
  railed: null,
  isAuto: true,
  autoCount: 0,
  maxAuto: 5,
}
const decideWith = (f: Partial<Flags>, typing = false) => {
  let asked = 0
  return decide({ ...clear, ...f }, async () => (asked++, typing)).then(d => ({ d, asked }))
}

test('nothing in the way: auto sends, draft drafts, the judge not saying a reply gets the default', async () => {
  expect((await decideWith({})).d).toEqual({ do: 'send', reply: 'yes' })
  expect((await decideWith({ isAuto: false })).d).toEqual({ do: 'draft', reply: 'yes' })
  expect((await decideWith({ verdict: { action: 'continue' } })).d).toEqual({ do: 'send', reply: AUTO_REPLY })
  expect((await decideWith({ verdict: { action: 'continue', reply: '' } })).d).toEqual({ do: 'send', reply: AUTO_REPLY })
})

// Every guard tripped at once; each row removes the earlier ones, so the table reads top to bottom.
const everything: Partial<Flags> = {
  composerAt: 11, // took over
  verdict: { action: 'stop', decision: 'done' },
  railed: 'deploy',
  autoCount: 5, // at the cap
}
test('each guard flips the decision, and an earlier one wins over every later one', async () => {
  const withTyping = true
  const rows: [string, Partial<Flags>, unknown][] = [
    ['took over', everything, { do: 'skip', why: 'took-over' }],
    ['stop', { ...everything, composerAt: 0 }, { do: 'stop' }],
    ['judge asks', { ...everything, composerAt: 0, verdict: { action: 'ask', decision: 'which db?' } }, { do: 'ask', why: 'judge', text: 'which db?' }],
    ['rail', { ...everything, composerAt: 0, verdict: { action: 'continue', decision: 'big deal' } }, { do: 'ask', why: 'rail', text: 'big deal' }],
    ['cap', { ...everything, composerAt: 0, verdict: { action: 'continue' }, railed: null }, { do: 'ask', why: 'cap', text: '5 standing answers this run. Check in.' }],
    ['typing', { ...everything, composerAt: 0, verdict: { action: 'continue' }, railed: null, autoCount: 4 }, { do: 'skip', why: 'typing' }],
  ]
  for (const [name, f, want] of rows) expect([name, (await decideWith(f, withTyping)).d]).toEqual([name, want])
  // and with nothing tripped (typing aside), the same flags send
  expect((await decideWith({ autoCount: 4 })).d).toEqual({ do: 'send', reply: 'yes' })
})

test('the took-over guard is "after judging began", not "ever"', async () => {
  expect((await decideWith({ composerAt: 10 })).d.do).toBe('send') // spoke at the moment judging began: not after
  expect((await decideWith({ composerAt: 11 })).d).toEqual({ do: 'skip', why: 'took-over' })
})

test('texts: the judge\'s own wording wins, the rail names its word when the judge said nothing', async () => {
  expect((await decideWith({ verdict: { action: 'ask' } })).d).toEqual({ do: 'ask', why: 'judge', text: 'Claude is waiting on you.' })
  expect((await decideWith({ railed: 'deploy' })).d).toEqual({ do: 'ask', why: 'rail', text: 'Claude asks about "deploy": your call.' })
})

test('QUIRK: stop and ask are told even while the person types; the cap only counts auto, the rail also holds drafts', async () => {
  expect((await decideWith({ verdict: { action: 'stop' } }, true)).d).toEqual({ do: 'stop' })
  expect((await decideWith({ verdict: { action: 'ask' } }, true)).d.do).toBe('ask')
  expect((await decideWith({ isAuto: false, autoCount: 99 })).d).toEqual({ do: 'draft', reply: 'yes' })
  expect((await decideWith({ isAuto: false, railed: 'deploy' })).d).toMatchObject({ do: 'ask', why: 'rail' })
})

test('the prompt box is read only when every earlier guard let the turn through', async () => {
  for (const f of [{ composerAt: 11 }, { verdict: { action: 'stop' as const } }, { verdict: { action: 'ask' as const } }, { railed: 'x' }, { autoCount: 5 }]) {
    expect((await decideWith(f)).asked).toBe(0)
  }
  expect((await decideWith({})).asked).toBe(1)
})
