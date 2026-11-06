import { expect, test } from 'claude-code/testing'
import { logLine, orderTree } from '../hooks/judges'

test('agents nest under their parent, live before finished, orphans under main', () => {
  const r = (id: string, status: string, parentId?: string) => ({ id, status, parentId })
  const out = orderTree([r('done', 'completed'), r('main', 'running'), r('b', 'running'), r('c', 'running', 'b'), r('o', 'running', 'gone')])
  expect(out.map(x => `${x.depth}${x.row.id}`)).toEqual(['0main', '1b', '2c', '1o', '1done'])
})

test('a log line reads time, verb and the reply', () => {
  expect(logLine({ at: 0, kind: 'asked', text: 'Deploy?' }, 120_000)).toBe(' 2m ago  asked you: Deploy?')
})
