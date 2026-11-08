import { expect, test } from 'claude-code/testing'

import { EMPTY, dayKey, merge, recordRun, recordSpent, shortModel, summarize, usd, tok, verdict } from '../hooks/stats'
import { PANE, engine, settle, step, typed } from './support'

const U = (i: number, o: number, r = 0, w = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: w })
const TODAY = '2026-11-08'
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6)

test('stats: a cheaper model saves the repriced tokens, the autopilot own calls are subtracted, effort stays a separate estimate', () => {
  let l = EMPTY
  // a subagent ran on Haiku at low where the session would have used Sonnet at high: 1M in, 100K out
  l = recordRun(l, TODAY, { who: 'agent', usage: { ...U(1_000_000, 100_000), model: 'claude-haiku-5-5' }, wouldModel: 'claude-sonnet-5-5', ranEffort: 'low', wouldEffort: 'high' })
  // the chat ran on the model it would have anyway
  l = recordRun(l, TODAY, { who: 'chat', usage: { ...U(1000, 500), model: 'claude-sonnet-5-5' }, wouldModel: 'claude-sonnet-5-5', ranEffort: 'high', wouldEffort: 'high' })
  l = recordSpent(l, TODAY, 'verdict', U(100_000, 1000))

  const s = summarize(l, TODAY, 'day')
  const t = s.totals.day
  expect(t.requests).toBe(2)
  near(t.saved.usd, 3 - 0.15) // sonnet (1M×$2 + 100K×$10) less haiku (1M×$0.10 + 100K×$0.50)
  near(t.spent.usd, 0.0105)
  near(t.net, 2.85 - 0.0105)
  // effort: output 100K at low would have been 100K × 1/0.35 at high, priced at Haiku's output rate
  near(t.effortUsd.point, ((100_000 / 0.35) - 100_000) * 0.5 / 1e6)
  near(t.effortUsd.low, t.effortUsd.point * 0.5)
  near(t.effortUsd.high, t.effortUsd.point * 1.5)
  near(t.netWithEffort, t.net + t.effortUsd.point)
  expect(s.routes).toHaveLength(1)
  expect(s.routes[0]).toMatchObject({ who: 'agent', ran: 'haiku', would: 'sonnet' })
  expect(s.unchanged.n).toBe(1)
  expect(s.judges).toMatchObject([{ kind: 'verdict', n: 1, tokensIn: 100_000, tokensOut: 1000 }])
  expect(verdict(t)).toContain('Saving you $2.84')
})

test('stats: a dearer pick and a costly judge read as a cost, and the verdict says so', () => {
  let l = EMPTY
  l = recordRun(l, TODAY, { who: 'chat', usage: { ...U(100_000, 10_000), model: 'claude-opus-5-5' }, wouldModel: 'claude-sonnet-5-5' })
  l = recordSpent(l, TODAY, 'effort', U(5000, 50))
  const t = summarize(l, TODAY, 'day').totals.day
  expect(t.saved.usd).toBeLessThan(0)
  expect(t.net).toBeLessThan(0)
  expect(verdict(t)).toContain('more than they save')
  expect(verdict(summarize(EMPTY, TODAY, 'day').totals.day)).toContain('Nothing recorded yet')
})

test('stats: periods, pruning, unpriced models and the words', () => {
  let l = EMPTY
  l = recordSpent(l, '2026-11-08', 'verdict', U(1_000_000, 0)) // today: $0.10
  l = recordSpent(l, '2026-11-03', 'verdict', U(2_000_000, 0)) // 5 days ago: $0.20
  l = recordSpent(l, '2026-10-01', 'verdict', U(4_000_000, 0)) // 38 days ago: $0.40
  const s = summarize(l, TODAY, 'all')
  near(s.totals.day.spent.usd, 0.1)
  near(s.totals.week.spent.usd, 0.3)
  near(s.totals.all.spent.usd, 0.7)
  expect(s.since).toBe('2026-10-01')
  // merging adds, and drops a day older than 90 days
  const m = merge(merge(l, l, TODAY), recordSpent(EMPTY, '2026-06-01', 'verdict', U(1, 1)), TODAY)
  expect(Object.keys(m.days).sort()).toEqual(['2026-10-01', '2026-11-03', '2026-11-08'])
  near(summarize(m, TODAY, 'all').totals.all.spent.usd, 1.4)
  // a model without a price is counted apart and left out of the dollars
  const u = summarize(recordRun(EMPTY, TODAY, { who: 'chat', usage: { ...U(10, 10), model: 'mystery-1' }, wouldModel: 'claude-sonnet-5-5' }), TODAY, 'day').totals.day
  expect(u.unpriced).toBe(1)
  expect(u.saved.usd).toBe(0)
  expect(shortModel('claude-fable-5-1')).toBe('fable')
  expect(usd(0.0042)).toBe('$0.0042')
  expect(usd(-0.06, true)).toBe('−$0.06')
  expect(usd(2.8395, true)).toBe('+$2.84')
  expect(tok(412)).toBe('412')
  expect(tok(12_400)).toBe('12K')
  expect(tok(1_240_000)).toBe('1.2M')
})

// The mod records what it sees: its own Haiku calls, the chat's request, a subagent's request. The Savings tab draws them.
test('stats: the chat, a subagent and the Haiku calls are recorded, saved under the session key and drawn in the Savings tab', async ($: any, on: any) => {
  const t = engine(on, {
    orders: 'effort: auto\nsubagents: auto\nmodel: off\n',
    repoOrders: 'effort: auto\nsubagents: auto\nmodel: off\n',
    state: true,
    handlers: {
      'model.complete': (_: unknown, e: any) => ({
        value: {
          isAnswered: true,
          text: JSON.stringify(String(e.system).includes('helper subagent') ? { model: 'haiku', effort: 'low', why: 'search' } : { effort: 'low', why: 'rename' }),
          usage: U(300, 20),
        },
      }),
      'agent.spawn': () => ({ agentId: 'a1', model: 'claude-haiku-5-5' }),
      'turn.step': async function* (_: unknown, e: any) {
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...U(1000, 500), model: e.model } }
      },
    },
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await typed($, 'Rename a variable', 't1', 'claude-sonnet-5-5', 'high')
  await $.agent.spawn({ prompt: 'grep for foo', description: 'find foo', subagentType: 'Explore' } as never)
  await step($, 't1', 'claude-haiku-5-5', { agentId: 'a1', effort: 'high' })
  await settle()

  const saved = (t.stored as any[]).filter(v => v?.ledger).at(-1)
  const day = saved.ledger.days[dayKey(1000)]
  // the chat: Sonnet, as the session had it, at low where the session had high
  expect(day.runs['chat|sonnet|sonnet']).toMatchObject({ n: 1, i: 1000, o: 500 })
  expect(day.effort['sonnet|low|high']).toMatchObject({ n: 1, o: 500 })
  // the subagent: its model was picked (Haiku), the session's was Sonnet; its effort was picked (low)
  expect(day.runs['agent|haiku|sonnet']).toMatchObject({ n: 1, i: 1000, o: 500 })
  expect(day.effort['haiku|low|high']).toBeUndefined() // Haiku takes no effort, so none is steered
  expect(day.spent.effort).toMatchObject({ n: 1, i: 300, o: 20 })
  expect(day.spent.subagent).toMatchObject({ n: 1, i: 300, o: 20 })

  t.set('tab', 'savings')
  const pane = await $.ui.mount(PANE('desktop'))
  expect(await pane.find({ type: 'Text', text: /Is it paying for itself/ })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: /Effort pick/ })).toBeTruthy()
  expect(await pane.find({ type: 'Text', text: /Subagent pick/ })).toBeTruthy()
  expect(await pane.find({ type: 'Button', label: 'Today' })).toBeTruthy()
  await pane.unmount()
})

// History survives a restart: every session's slice is read back, and slices a day old fold into one archive key.
test('stats: session start merges every saved slice, folds the old ones into the archive and prunes nothing it should keep', async ($: any, on: any) => {
  const DAY = 86_400_000
  const now = 10 * DAY
  const old = { at: 5 * DAY, ledger: recordSpent(EMPTY, '1970-01-05', 'verdict', U(1_000_000, 0)) }
  const recent = { at: now - 1000, ledger: recordSpent(EMPTY, '1970-01-11', 'verdict', U(2_000_000, 0)) }
  const store: Record<string, unknown> = { 'stats:5': old, 'stats:recent': recent }
  const deleted: string[] = []
  const t = engine(on, {
    orders: 'effort: auto\n',
    state: true,
    now,
    handlers: {
      'store.keys': () => ({ value: Object.keys(store) }),
      'store.get': (_: unknown, e: any) => ({ value: store[e.key] }),
      'store.delete': (_: unknown, e: any) => {
        deleted.push(e.key)
        return { value: undefined }
      },
    },
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()

  expect(deleted).toEqual(['stats:5']) // only the slice a day old is folded away
  const archive = (t.stored as any[]).find(v => v?.ledger?.days?.['1970-01-05'])
  expect(Object.keys(archive.ledger.days)).toEqual(['1970-01-05']) // the recent slice stays under its own key
  // the pane's total counts both slices: $0.10 + $0.20
  t.set('tab', 'savings')
  t.set('statsPeriod', 'all')
  const pane = await $.ui.mount(PANE('desktop'))
  expect(await pane.find({ type: 'Text', text: /−\$0\.30/ })).toBeTruthy()
  await pane.unmount()
  // and the command opens the tab
  expect((await $.command.run({ command: 'orders', args: 'savings' })).text).toContain('savings')
})
