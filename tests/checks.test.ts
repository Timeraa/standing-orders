import { expect, test } from 'claude-code/testing'
import { CHECK_TTL_MS, checkAge, checkId, createChecks, shownChecks, type Check, type Host } from '../hooks/checks'
import { DEFAULT_ORDERS } from '../hooks/orders'
import { PANE, engine, settle } from './support'

const DAY = 86_400_000
const KEY = 'checks:/repo'
const c = (text: string, at: number, chat = '1000'): Check => ({ text, at, chat })

// The checks module on an in-memory atom and store: the same two seams the mod gives it (`$.store` and the `checks` atom).
// `saved` is what the store holds before the session starts; `fails` makes reading it reject.
function kit(o: { saved?: unknown; fails?: boolean } = {}) {
  let list: Check[] = []
  const store = new Map<string, unknown>(o.saved === undefined ? [] : [[KEY, o.saved]])
  const writes: Check[][] = []
  const host: Host = {
    list: async () => list,
    change: async next => (list = next(list)),
    load: async key => {
      if (o.fails) throw new Error('store down')
      return store.get(key)
    },
    save: async (key, next) => {
      store.set(key, next)
      writes.push(next)
    },
  }
  const checks = createChecks()
  return { checks, host, store, writes, list: () => list, texts: () => list.map(x => x.text) }
}
type Kit = ReturnType<typeof kit>

// A session starts at `now` with `saved` in the store; its chat is the one that finds the next items.
async function started(saved: unknown, now: number): Promise<Kit> {
  const k = kit({ saved })
  await k.checks.load(k.host, { cwd: '/repo', now })
  return k
}

test('a turn replaces its own chat\'s items, keeps other chats\', and collapses repeats', async () => {
  const saved = [c('Test on a Mac', 1, '1000'), c('Ask the designer', 2, '2000')]
  const k = await started(saved, 1000)
  await k.checks.add(k.host, ['Check the device.', 'check the device', 'Sign the form'], [], 1010)
  expect(k.texts()).toEqual(['Ask the designer', 'Check the device.', 'Sign the form'])
  expect(k.store.get(KEY)).toEqual(k.list()) // every change is saved with the list

  // the same text from another chat is one item, not two
  const other = await started(saved, 1000)
  await other.checks.add(other.host, ['ask the designer'], [], 1010)
  expect(other.texts()).toEqual(['ask the designer'])

  // a turn with nothing new leaves the list alone, and writes nothing
  const quiet = await started(saved, 1000)
  await quiet.checks.add(quiet.host, [], [], 1010)
  await quiet.checks.add(quiet.host, undefined, undefined, 1010)
  await quiet.checks.add(quiet.host, 'not a list' as never, {} as never, 1010)
  expect(quiet.list()).toEqual(saved)
  expect(quiet.writes).toEqual([])
})

test('resolved ticks items off in any chat; unknown text does nothing', async () => {
  const saved = [c('Merge PR #419', 1, '1000'), c('Ask the designer', 2, '2000')]
  const k = await started(saved, 3000)
  await k.checks.add(k.host, [], ['merge pr #419.'], 3010)
  expect(k.texts()).toEqual(['Ask the designer'])
  expect(k.store.get(KEY)).toEqual(k.list())

  const unknown = await started(saved, 3000)
  await unknown.checks.add(unknown.host, [], ['something else'], 3010)
  expect(unknown.list()).toEqual(saved)

  // a resolved item is not re-added by the same turn
  const same = await started(saved, 3000)
  await same.checks.add(same.host, ['Merge PR #419'], ['Merge PR #419'], 3010)
  expect(same.texts()).toEqual(['Ask the designer'])
})

test('five new per turn, thirty in all, three days of life', async () => {
  const six = await started([], 0)
  await six.checks.add(six.host, ['1', '2', '3', '4', '5', '6'], [], 0)
  expect(six.texts()).toEqual(['1', '2', '3', '4', '5'])

  const many = await started(Array.from({ length: 40 }, (_, i) => c(`t${i}`, 0, `chat${i}`)), 1)
  expect(many.list().length).toBe(40) // loading does not cap
  await many.checks.add(many.host, ['new'], [], 1)
  expect(many.list().length).toBe(30)
  expect(many.texts().at(-1)).toBe('new')

  // an item is live until its third day is up: expiry drops it, saves the rest, and says so
  const k = await started([c('old', 0), c('fresh', 2 * DAY)], 1)
  expect(await k.checks.expire(k.host, CHECK_TTL_MS - 1)).toBe(false)
  expect(k.writes).toEqual([]) // nothing expired: nothing written
  expect(await k.checks.expire(k.host, CHECK_TTL_MS)).toBe(true)
  expect(k.texts()).toEqual(['fresh'])
  expect(k.store.get(KEY)).toEqual(k.list())
  expect(await k.checks.expire(k.host, CHECK_TTL_MS)).toBe(false)

  // a new turn also drops what has expired
  const late = await started([c('old', 0), c('fresh', 2 * DAY)], 1)
  await late.checks.add(late.host, [], ['something else'], CHECK_TTL_MS + 1)
  expect(late.texts()).toEqual(['fresh'])
})

test('the store from before 0.8 loads dated from now, so nothing vanishes', async () => {
  const now = 10 * DAY
  const legacy = ['Test on a Mac', '  ', { text: 'Kept', at: now - DAY, chat: 'x' }, { text: 'Expired', at: 1, chat: 'x' }, 7, null]
  const k = await started(legacy, now)
  expect(k.list()).toEqual([c('Test on a Mac', now, ''), c('Kept', now - DAY, 'x')])
  expect((await started(undefined, now)).list()).toEqual([])
  expect((await started('not a list', now)).list()).toEqual([])
  // a store that cannot be read is an empty list, and the session still starts
  const down = kit({ fails: true })
  await down.checks.load(down.host, { cwd: '/repo', now })
  expect(down.list()).toEqual([])

  // QUIRK: loading replaces the atom and writes no store; the first change after it saves the migrated list
  expect(k.writes).toEqual([])
  expect(k.store.get(KEY)).toBe(legacy)
  await k.checks.add(k.host, ['New'], [], now + 1)
  expect(k.store.get(KEY)).toEqual([c('Test on a Mac', now, ''), c('Kept', now - DAY, 'x'), c('New', now + 1, String(now))])
})

test('a saved list comes back the way it was left, in another folder\'s key it does not', async () => {
  const k = await started(undefined, 1000)
  await k.checks.add(k.host, ['One', 'Two'], [], 1010)
  const again = await started(k.store.get(KEY), 2000)
  expect(again.list()).toEqual(k.list())
  expect(again.list().map(checkId)).toEqual(k.list().map(checkId))
  // the folder is part of the key
  const elsewhere = kit()
  await elsewhere.checks.load(elsewhere.host, { cwd: '/other', now: 1000 })
  await elsewhere.checks.add(elsewhere.host, ['Three'], [], 1010)
  expect([...elsewhere.store.keys()]).toEqual(['checks:/other'])
})

test('ticking off: one item, a whole group, or all of them', async () => {
  const k = await started(undefined, 1000)
  // one turn finds all four: they share a time, and still tick off one at a time
  await k.checks.add(k.host, ['After deploy, check the logs', 'After deploy, tell the team', 'Sign the form', 'Test on a Mac'], [], 1010)
  const rows = () => shownChecks(k.list(), false).groups
  expect(new Set(k.list().map(x => x.at)).size).toBe(1)
  expect(new Set(k.list().map(checkId)).size).toBe(4)

  const grouped = rows().find(g => g.lead)!
  expect(grouped.items.map(x => x.text)).toEqual(['Tell the team', 'Check the logs'])
  const mac = rows().flatMap(g => g.items).find(x => x.item.text === 'Test on a Mac')!
  await k.checks.tickOff(k.host, mac.item.id)
  expect(k.texts()).toEqual(['After deploy, check the logs', 'After deploy, tell the team', 'Sign the form'])
  expect(k.store.get(KEY)).toEqual(k.list())

  await k.checks.tickOffGroup(k.host, rows().find(g => g.lead)!)
  expect(k.texts()).toEqual(['Sign the form'])
  expect(k.store.get(KEY)).toEqual(k.list())

  // an id no item has ticks nothing off
  await k.checks.tickOff(k.host, 'nothing')
  expect(k.texts()).toEqual(['Sign the form'])

  await k.checks.add(k.host, ['Back again'], ['Sign the form'], 1020)
  expect(k.texts()).toEqual(['Back again'])
  await k.checks.clear(k.host)
  expect(k.list()).toEqual([])
  expect(k.store.get(KEY)).toEqual([])
})

test('an item\'s id holds while the list around it changes', async () => {
  const k = await started([c('Ask the designer', 5, '2000')], 1000)
  const [designer] = k.list()
  const id = checkId(designer!)
  expect(id).toBe('5:Ask the designer')

  // other items come and go, in this chat and in a save and load: the id is the same, its place is not
  await k.checks.add(k.host, ['Sign the form', 'Test on a Mac'], [], 1010)
  const shown = () => shownChecks(k.list(), false).groups.flatMap(g => g.items.map(x => x.item))
  expect(shown().find(x => x.text === 'Ask the designer')).toMatchObject({ id, slot: 2 })
  await k.checks.add(k.host, ['Sign the form'], ['Test on a Mac'], 1020)
  expect(shown().find(x => x.text === 'Ask the designer')).toMatchObject({ id, slot: 1 })
  const reloaded = await started(k.store.get(KEY), 2000)
  expect(reloaded.list().map(checkId)).toEqual(k.list().map(checkId))

  // so a press made on a list that has since moved still ticks off the item it was drawn for
  await k.checks.tickOff(k.host, id)
  expect(k.texts()).toEqual(['Sign the form'])

  // an item found again is a new item (found now), with a new id: the old one ticks nothing off
  const before = checkId(k.list()[0]!)
  await k.checks.add(k.host, ['sign the form'], [], 1030)
  expect(checkId(k.list()[0]!)).not.toBe(before)
  await k.checks.tickOff(k.host, before)
  expect(k.texts()).toEqual(['sign the form'])
})

test('the Now tab lists the newest five, the rest on request, grouped by their lead', () => {
  const list = Array.from({ length: 7 }, (_, i) => c(`item ${i}`, 100 + i))
  const short = shownChecks(list, false)
  expect(short.older).toBe(2)
  expect(short.groups.flatMap(g => g.items.map(x => [x.item.text, x.item.slot]))).toEqual([
    ['item 6', 0], ['item 5', 1], ['item 4', 2], ['item 3', 3], ['item 2', 4],
  ])
  const open = shownChecks(list, true)
  expect(open.groups.flatMap(g => g.items).length).toBe(7)
  expect(open.older).toBe(2) // still told, so the button can say "Show fewer"
  expect(shownChecks([], false)).toEqual({ groups: [], older: 0 })
  // a group keeps the slots of its items, newest first
  const led = shownChecks([c('After deploy, one', 1), c('Solo', 2), c('After deploy, two', 3)], false)
  expect(led.groups.map(g => [g.lead, g.items.map(x => x.item.slot)])).toEqual([['After deploy', [0, 2]], [null, [1]]])
})

test('ages read as now, minutes, hours, days', () => {
  expect([0, 59_000, 5 * 60_000, 3 * 3_600_000, 2 * DAY].map(checkAge)).toEqual(['now', 'now', '5m', '3h', '2d'])
})

// The Now tab's buttons are one line each: the module does the rest, and saves it.
test('Done, Done all and Clear all on the Now tab tick off by id and save the list', async ($: any, on: any) => {
  const t = engine(on, { now: 10 * DAY, orders: DEFAULT_ORDERS, repoOrders: DEFAULT_ORDERS, state: true })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await settle()
  const now = t.clock.now()
  await t.set('tab', 'now')
  await t.set('vitals', { now, contextPercent: null, lastResponseAt: 0, cacheTtlMin: 60, ratePercent: null, hasRepoOrders: true })
  const seeded = [
    c('After /reload-plugins, watch the spinner', now - 3_600_000, 'a'),
    c('After /reload-plugins, open /autopilot', now - 3_600_000, 'a'),
    c('Sign the form', now - 3_600_000, 'a'),
    c('Test on a Mac', now - 3_600_000, 'a'),
  ]
  await t.set('checks', seeded)
  const texts = async () => ((await $.command.run({ command: 'orders', args: 'checks' })).text as string).split('\n').map(l => l.replace(/^- | \(\w+\)$/g, ''))
  const pane = async () => $.ui.mount(PANE('terminal'))

  // each item has its own buttons, though the four share a time (the test pane shows no hover scopes: the slots in shownChecks stand for them)
  let p = await pane()
  const keys = async (prefix: string) => ((await p.findAll({ type: 'Button' })) as any[]).map(b => b.key as string).filter(k => k.startsWith(prefix))
  expect((await keys('tick')).length).toBe(4)
  expect(new Set(await keys('tick')).size).toBe(4)
  expect(await keys('ask')).toEqual((await keys('tick')).map(k => k.replace('tick', 'ask')))

  await p.press({ key: `tick${now - 3_600_000}:Test on a Mac` })
  await p.unmount()
  expect(await texts()).toEqual(seeded.slice(0, 3).map(x => x.text))
  expect(t.stored.at(-1)).toEqual(seeded.slice(0, 3))

  p = await pane()
  await p.press({ key: 'all1' }) // the group under its lead, the second block after Sign the form
  await p.unmount()
  expect(await texts()).toEqual(['Sign the form'])
  expect(t.stored.at(-1)).toEqual([seeded[2]])

  await t.set('checks', seeded)
  p = await pane()
  await p.press({ key: 'clear' })
  await p.unmount()
  expect((await $.command.run({ command: 'orders', args: 'checks' })).text).toBe('No checks waiting.')
  expect(t.stored.at(-1)).toEqual([])
})
