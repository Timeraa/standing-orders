import { expect, test } from 'claude-code/testing'
import { DEFAULT_ORDERS, createOrders, type FileStore } from '../hooks/orders'
import { GLOBAL, REPO } from './support'

// The module is held through its interface only, over a map standing in for the file system.
function disk(files: Record<string, string> = {}) {
  const t = {
    files,
    reads: [] as string[],
    writes: [] as string[],
    fs: {
      read: async (path: string) => {
        t.reads.push(path)
        const text = files[path]
        if (text === undefined) throw new Error('missing')
        return text
      },
      write: async (path: string, text: string) => {
        t.writes.push(path)
        files[path] = text
      },
    } satisfies FileStore,
  }
  return t
}

async function opened(files: Record<string, string>) {
  const d = disk(files)
  const orders = createOrders()
  orders.locate({ globalPath: GLOBAL, cwd: '/repo' })
  await orders.refresh(d.fs, true)
  d.reads.length = 0
  return { d, orders }
}

test('the repo file only tightens: always-ask words add up, max-auto goes down, effort goes off', async () => {
  const { orders } = await opened({
    [GLOBAL]: 'always-ask: deploy\nmax-auto: 8\neffort: high\ncache-ttl: 60\nmodel: auto\nsubagents: auto\neffort-max: medium',
    [REPO]: 'always-ask: migrate\nmax-auto: 3\neffort: off\ncache-ttl: 5\nmodel: off\nsubagents: off\neffort-max: max\nmax-auto: 1000',
  })
  const merged = orders.get()
  expect(merged.terms).toEqual(['deploy', 'migrate'])
  expect(merged.rail?.test('please migrate the db')).toBe(true)
  expect(merged.maxAuto).toBe(8) // the repo's last max-auto line (1000) cannot raise it
  expect(merged.isEffortAuto).toBe(false)
  expect(merged.effortFixed).toBeNull()
  expect(merged.cacheTtlMin).toBe(5)
  expect(merged.isModelAuto).toBe(true)
  expect(merged.isSubagentsAuto).toBe(true)
  expect(merged.effortMax).toBe('medium')
  expect(merged.text).toContain("# This repo's orders")

  // the person's own view never sees the repo
  const mine = orders.mine()
  expect(mine.terms).toEqual(['deploy'])
  expect(mine.isEffortAuto).toBe(true)
  expect(mine.effortFixed).toBe('high')
  expect(mine.cacheTtlMin).toBe(60)
  expect(mine.text).not.toContain('migrate')
  expect(orders.hasRepo()).toBe(true)
})

test('a repo file can lower max-auto, and without one both views are the global file', async () => {
  const { orders } = await opened({ [GLOBAL]: 'max-auto: 8', [REPO]: 'max-auto: 3' })
  expect(orders.get().maxAuto).toBe(3)
  expect(orders.mine().maxAuto).toBe(8)

  const alone = await opened({ [GLOBAL]: 'max-auto: 8\nalways-ask: deploy' })
  expect(alone.orders.hasRepo()).toBe(false)
  expect(alone.orders.get()).toEqual(alone.orders.mine())
})

test('set() writes the global file only, round-trips, and keeps one always-ask line', async () => {
  const { d, orders } = await opened({
    [GLOBAL]: 'max-auto: 8\nalways-ask: deploy\nalways-ask: delete\nmotion: on\n',
    [REPO]: 'always-ask: migrate\n',
  })
  await orders.set(d.fs, { 'max-auto': '3', 'always-ask': 'deploy, publish', motion: 'off' })

  expect(d.writes).toEqual([GLOBAL])
  expect(d.files[GLOBAL]).toBe('max-auto: 3\nalways-ask: deploy, publish\nmotion: off\n')
  expect(d.files[REPO]).toBe('always-ask: migrate\n')
  expect(orders.mine().maxAuto).toBe(3)
  expect(orders.mine().isMotionOn).toBe(false)
  expect(orders.mine().terms).toEqual(['deploy', 'publish'])
  expect(orders.get().terms).toEqual(['deploy', 'publish', 'migrate']) // the repo's words still join
})

test('set() starts from the default orders when the global file cannot be read, and appends new settings', async () => {
  const d = disk({})
  const orders = createOrders()
  orders.locate({ globalPath: GLOBAL, cwd: '/repo' })
  await orders.set(d.fs, { 'effort-min': 'high' })

  expect(d.files[GLOBAL]).toContain('## Always ask first')
  expect(d.files[GLOBAL]).toContain('effort-min: high')
  expect(d.files[GLOBAL]).not.toContain('effort-min: low')
  expect(orders.mine().effortMin).toBe('high')
  expect(orders.consumeFirstRun()).toBe(false) // a write is not a first run
})

test('set() rejects when the file cannot be written', async () => {
  const { d, orders } = await opened({ [GLOBAL]: 'max-auto: 8' })
  const broken: FileStore = { read: d.fs.read, write: async () => Promise.reject(new Error('read-only')) }
  await expect(orders.set(broken, { 'max-auto': '2' })).rejects.toThrow('read-only')
  expect(orders.mine().maxAuto).toBe(8)
})

test('refresh() reads each file once, and says nothing changed when nothing did', async () => {
  const { d, orders } = await opened({ [GLOBAL]: 'max-auto: 8', [REPO]: 'max-auto: 3' })

  expect(await orders.refresh(d.fs)).toBe(false)
  expect(d.reads.sort()).toEqual([GLOBAL, REPO].sort())
  expect(d.writes).toEqual([])

  d.reads.length = 0
  expect(await orders.refresh(d.fs, true)).toBe(true) // forced: the caller applies it anyway
  expect(d.reads.length).toBe(2)
})

test('refresh() notices an edit to either file', async () => {
  const { d, orders } = await opened({ [GLOBAL]: 'max-auto: 8', [REPO]: 'max-auto: 6' })

  d.files[GLOBAL] = 'max-auto: 5'
  expect(await orders.refresh(d.fs)).toBe(true)
  expect(orders.mine().maxAuto).toBe(5)
  expect(orders.get().maxAuto).toBe(5)
  expect(await orders.refresh(d.fs)).toBe(false)

  d.files[REPO] = 'max-auto: 2'
  expect(await orders.refresh(d.fs)).toBe(true)
  expect(orders.get().maxAuto).toBe(2)
  expect(orders.mine().maxAuto).toBe(5)
  expect(await orders.refresh(d.fs)).toBe(false)
})

test('refresh() picks up a repo file that appears later, and one that goes away', async () => {
  const { d, orders } = await opened({ [GLOBAL]: 'always-ask: deploy' })
  expect(orders.hasRepo()).toBe(false)

  d.files[REPO] = 'always-ask: migrate'
  expect(await orders.refresh(d.fs)).toBe(true)
  expect(orders.hasRepo()).toBe(true)
  expect(orders.get().terms).toEqual(['deploy', 'migrate'])

  delete d.files[REPO]
  expect(await orders.refresh(d.fs)).toBe(true)
  expect(orders.hasRepo()).toBe(false)
  expect(orders.get().terms).toEqual(['deploy'])
})

test('an empty repo file is still a repo file', async () => {
  const { orders } = await opened({ [GLOBAL]: 'max-auto: 8', [REPO]: '' })
  expect(orders.hasRepo()).toBe(true)
})

test('refresh() leaves a global file that vanished alone: the last load stands', async () => {
  const { d, orders } = await opened({ [GLOBAL]: 'max-auto: 4' })
  delete d.files[GLOBAL]
  expect(await orders.refresh(d.fs)).toBe(false)
  expect(orders.mine().maxAuto).toBe(4)
  expect(d.writes).toEqual([])
})

test('a missing global file is seeded with the default orders, and the first run is told once', async () => {
  const d = disk({})
  const orders = createOrders()
  orders.locate({ globalPath: GLOBAL, cwd: '/repo' })
  expect(orders.consumeFirstRun()).toBe(false) // nothing loaded yet

  expect(await orders.refresh(d.fs, true)).toBe(true)
  expect(d.files[GLOBAL]).toBe(DEFAULT_ORDERS)
  expect(orders.mine().text).toBe(DEFAULT_ORDERS)
  expect(orders.get().maxAuto).toBe(8)
  expect(orders.consumeFirstRun()).toBe(true)
  expect(orders.consumeFirstRun()).toBe(false)

  // the seed is on disk now: no change, and not a first run again
  expect(await orders.refresh(d.fs)).toBe(false)
  expect(orders.consumeFirstRun()).toBe(false)
})

test('an existing global file is never overwritten or called a first run', async () => {
  const d = disk({ [GLOBAL]: 'max-auto: 2' })
  const orders = createOrders()
  orders.locate({ globalPath: GLOBAL, cwd: '/repo' })
  await orders.refresh(d.fs, true)
  expect(d.writes).toEqual([])
  expect(orders.consumeFirstRun()).toBe(false)
  expect(orders.get().maxAuto).toBe(2)
})

test('a seed that cannot be written still gives the default orders', async () => {
  const orders = createOrders()
  orders.locate({ globalPath: GLOBAL, cwd: '/repo' })
  const readOnly: FileStore = { read: async () => Promise.reject(new Error('missing')), write: async () => Promise.reject(new Error('read-only')) }
  expect(await orders.refresh(readOnly, true)).toBe(true)
  expect(orders.get().text).toBe(DEFAULT_ORDERS)
  expect(orders.consumeFirstRun()).toBe(true)
})

test('before anything loads, the default orders stand and the always-ask rail is on', () => {
  const orders = createOrders()
  expect(orders.get().rail?.test('please deploy to prod')).toBe(true)
  expect(orders.get().maxAuto).toBe(8)
  expect(orders.hasRepo()).toBe(false)
})
