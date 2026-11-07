// Shared test kit: one fake engine for every *.test.ts here. This file is not a
// test (the runner only picks up *.test.ts), so it is imported, never run.
//
//   const t = engine(on, { orders: 'effort: auto\n', judge: { effort: 'high' } })
//   await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
//   ...
//   expect(t.efforts).toEqual(['high'])
//
// A test states only what is its own (the orders text, the judge's answer, extra
// files, handlers that replace a default); the rest of the engine is here.
import { mock } from 'claude-code/testing'

declare const setTimeout: (fn: () => void, ms: number) => unknown

/** Where the person's orders and the repo's orders live in the fake file system. */
export const GLOBAL = '/home/t/.claude/standing-orders.md'
export const REPO = '/repo/.claude/standing-orders.md'

type Handler = (ctx: unknown, e: any) => unknown
type JudgeAnswer = object | string
type Clock = ReturnType<typeof mock.clock>

export type Options = {
  /** The person's orders file; left out, it is missing (a first run). */
  orders?: string
  /** The repo's orders file; left out, it is missing. */
  repoOrders?: string
  /** More files, by path; replaces `orders` and `repoOrders` where it names the same path. */
  files?: Record<string, string>
  /** What `model.complete` answers: JSON for an object, text as given; a function sees the call. Left out: `{}`. */
  judge?: JudgeAnswer | ((call: { system: string; prompt: string }) => JudgeAnswer)
  /** What `$.store.get` holds (for every key). */
  saved?: unknown
  /** Where the mocked clock starts (it only moves when the test advances it). */
  now?: number
  /** Keep `$.state` in a plain map the test seeds with `set` (nothing redraws a pane from it). Off: the kit's own. */
  state?: boolean
  /** Handlers that replace a default, or add one; they see `(ctx, event)`, like `on`'s. */
  handlers?: Record<string, Handler>
}

export type Fake = {
  /** The file system: path to text. Writes land here; set or delete a path to change what a later read sees. */
  fs: Record<string, string>
  /** Every text written with `fs.write`, in order. */
  written: string[]
  /** What `model.complete` was asked: the system prompts and the prompts. */
  systems: string[]
  prompts: string[]
  /** Values given to `store.set`. */
  stored: unknown[]
  /** Prompt box and notifications: `prompt.fill`, `prompt.submit`, `ui.notify`. */
  filled: string[]
  submitted: string[]
  notified: string[]
  /** The effort and model each `turn.step` was asked for. */
  efforts: unknown[]
  models: string[]
  /** The mocked clock: advance it to let a `$.clock` wait run out. */
  clock: Clock
  /** With `state: true`: put a value in the session's state. */
  set: (key: string, value: unknown) => void
}

/** The fake engine; registers every default handler on `on`, less what `handlers` replaces. */
export function engine(on: any, o: Options = {}): Fake {
  const clock = mock.clock(on, { now: o.now ?? 1000 })
  const fs: Record<string, string> = {
    ...(o.orders === undefined ? {} : { [GLOBAL]: o.orders }),
    ...(o.repoOrders === undefined ? {} : { [REPO]: o.repoOrders }),
    ...o.files,
  }
  const t: Fake = {
    fs, written: [], systems: [], prompts: [], stored: [], filled: [], submitted: [], notified: [], efforts: [], models: [], clock,
    set: () => {
      throw new Error('engine(on, { state: true }) to seed state')
    },
  }
  const text = (a: JudgeAnswer) => (typeof a === 'string' ? a : JSON.stringify(a))

  const handlers: Record<string, Handler> = {
    'command.register': () => ({ value: { command: 'orders' } }),
    'session.start': (_, e) => ({ cwd: e.cwd }),
    'env.get': () => ({ value: '/home/t' }),
    'fs.read': (_, e) => (e.path in fs ? { value: fs[e.path] } : { deny: 'missing' }),
    'fs.write': (_, e) => {
      fs[e.path] = e.text
      t.written.push(e.text)
      return { value: undefined }
    },
    'store.get': () => ({ value: o.saved }),
    'store.set': (_, e) => {
      t.stored.push(e.value)
      return { value: undefined }
    },
    'model.complete': (_, e) => {
      t.systems.push(String(e.system))
      t.prompts.push(e.prompt)
      const a = typeof o.judge === 'function' ? o.judge({ system: String(e.system), prompt: e.prompt }) : (o.judge ?? {})
      return { value: { isAnswered: true, text: text(a) } }
    },
    'agent.list': () => ({ value: [] }),
    'turn.start': (_, e) => ({ turnId: e.turnId }),
    'turn.step': async function* (_: unknown, e: any) {
      t.efforts.push(e.effort)
      t.models.push(e.model)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    },
    'turn.complete': (_, e) => ({ text: e.answer }),
    'prompt.read': () => ({ value: { text: '', cursor: 0 } }),
    'prompt.fill': (_, e) => {
      t.filled.push(e.text)
      return { isFilled: true }
    },
    'prompt.submit': (_, e) => {
      t.submitted.push(e.text)
      return { text: e.text }
    },
    'ui.notify': (_, e) => {
      t.notified.push(e.text)
      return { value: { isSent: true, channel: 'terminal_bell' } }
    },
    'ui.toast': () => ({ value: undefined }),
    'ui.log': () => ({ value: undefined }),
    'ui.panes': () => ({ value: [] }),
    'ui.open': () => ({ value: undefined }),
  }
  if (o.state) {
    const values: Record<string, unknown> = {}
    handlers['state.get'] = (_, e) =>
      e.key in values ? { value: { value: values[e.key], version: 1 } } : { value: { value: undefined, version: 0 } }
    handlers['state.set'] = (_, e) => {
      values[e.key] = e.value
      return { value: { isSet: true, version: 1 } }
    }
    t.set = (key, value) => {
      values[key] = value
    }
  }
  for (const [name, h] of Object.entries({ ...handlers, ...o.handlers })) on(name, h)
  return t
}

/** Yields to the event loop `rounds` times, so work a hook left unawaited (the judge) can finish. */
export const settle = async (rounds = 100) => {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(() => r(undefined), 0))
}

/** The Autopilot pane to mount, on a surface. The desktop one shows the newest Activity entry as plain Text; the terminal wraps it in a flash Client. */
export const PANE = (surface: 'terminal' | 'desktop' = 'terminal') =>
  ({
    plugin: 'standing-orders',
    surface,
    component: 'Pane',
    requestId: 'autopilot',
    props: { title: 'Autopilot', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  }) as const

/** One request of a turn (a subagent's when `agentId` is given), run to its end. */
export async function step($: any, turnId: string, model: string, o: { effort?: string; agentId?: string } = {}) {
  const s = $.turn.step({ turnId, index: 0, model, effort: o.effort ?? 'medium', messageCount: 1, ...(o.agentId ? { agentId: o.agentId } : {}) })
  for await (const _ of s) void _
  await s.result
}

/** A prompt the person types: submitted, settled, then its first request run on `model` at the chat's own `effort`. */
export async function typed($: any, text: string, turnId: string, model: string, effort = 'medium') {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  await settle()
  await $.turn.start({ turnId, prompt: text })
  await step($, turnId, model, { effort })
}
