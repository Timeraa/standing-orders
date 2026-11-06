import { expect, test } from 'claude-code/testing'
import { CHECK_TTL_MS, checkAge, liveChecks, loadChecks, mergeChecks, type Check } from '../hooks/judges'

const DAY = 86_400_000
const c = (text: string, at: number, chat = 'a'): Check => ({ text, at, chat })

test('a turn replaces its own chat\'s items, keeps other chats\', and collapses repeats', () => {
  const old = [c('Test on a Mac', 1, 'a'), c('Ask the designer', 2, 'b')]
  const next = mergeChecks(old, ['Check the device.', 'check the device', 'Sign the form'], [], 'a', 10)
  expect(next.map(x => x.text)).toEqual(['Ask the designer', 'Check the device.', 'Sign the form'])
  // the same text from another chat is one item, not two
  expect(mergeChecks(old, ['ask the designer'], [], 'a', 10).map(x => x.text)).toEqual(['ask the designer'])
  // a turn with nothing new leaves the list alone
  expect(mergeChecks(old, [], [], 'a', 10)).toEqual(old)
})

test('resolved ticks items off in any chat; unknown text does nothing', () => {
  const old = [c('Merge PR #419', 1, 'a'), c('Ask the designer', 2, 'b')]
  expect(mergeChecks(old, [], ['merge pr #419.'], 'c', 10).map(x => x.text)).toEqual(['Ask the designer'])
  expect(mergeChecks(old, [], ['something else'], 'c', 10)).toEqual(old)
  // a resolved item is not re-added by the same turn
  expect(mergeChecks(old, ['Merge PR #419'], ['Merge PR #419'], 'c', 10).map(x => x.text)).toEqual(['Ask the designer'])
})

test('five new per turn, thirty in all, three days of life', () => {
  const six = ['1', '2', '3', '4', '5', '6']
  expect(mergeChecks([], six, [], 'a', 0).map(x => x.text)).toEqual(['1', '2', '3', '4', '5'])
  const many = Array.from({ length: 40 }, (_, i) => c(`t${i}`, 0, `chat${i}`))
  expect(mergeChecks(many, ['new'], [], 'z', 1).length).toBe(30)
  const old = [c('old', 0), c('fresh', 2 * DAY)]
  expect(liveChecks(old, CHECK_TTL_MS).map(x => x.text)).toEqual(['fresh'])
  expect(mergeChecks(old, [], [], 'a', CHECK_TTL_MS + 1).map(x => x.text)).toEqual(['fresh'])
})

test('the store from before 0.8 loads dated from now, so nothing vanishes', () => {
  const now = 10 * DAY
  const loaded = loadChecks(['Test on a Mac', '  ', { text: 'Kept', at: now - DAY, chat: 'x' }, { text: 'Expired', at: 1, chat: 'x' }, 7, null], now)
  expect(loaded).toEqual([c('Test on a Mac', now, ''), c('Kept', now - DAY, 'x')])
  expect(loadChecks(undefined, now)).toEqual([])
})

test('ages read as now, minutes, hours, days', () => {
  expect([0, 59_000, 5 * 60_000, 3 * 3_600_000, 2 * DAY].map(checkAge)).toEqual(['now', 'now', '5m', '3h', '2d'])
})
