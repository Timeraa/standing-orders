import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Check, Counts, EffortView, LogEntry, Run, Vitals } from '../types'
import {
  HELP,
  INIT_PROMPT,
  REPO_ORDERS,
  JUDGE,
  PREAMBLE,
  STOPS,
  asked,
  checkAge,
  checkLife,
  groupChecks,
  liveChecks,
  loadChecks,
  mergeChecks,
  SHOWN_CHECKS,
  fit,
  EFFORTS,
  cap,
  clock,
  isPick,
  logBody,
  logHead,
  parseVerdict,
  MODEL_NAMES,
  type Effort,
} from './judges'
import { BAND_ITEMS, createOrders, type BandItem, type FileStore, type Settings } from './orders'
import { createPicks, type Host } from './picks'

const NAME = 'standing-orders'
const PANE = 'autopilot'
const IDLE: Run = { autoCount: 0, startedAt: 0, pending: null, last: null }
const run = atom({ plugin: 'standing-orders', key: 'run' } as const, IDLE)
const isPaused = atom({ plugin: 'standing-orders', key: 'isPaused' } as const, false)
// ponytail: per session on purpose; every new session starts in draft mode.
const mode = atom({ plugin: 'standing-orders', key: 'mode' } as const, 'draft' as 'draft' | 'auto')
const checks = atom({ plugin: 'standing-orders', key: 'checks' } as const, [] as Check[])
const isChecksOpen = atom({ plugin: 'standing-orders', key: 'isChecksOpen' } as const, false)
const effort = atom({ plugin: 'standing-orders', key: 'effort' } as const, {
  level: null,
  why: '',
  isAuto: true,
  isJudging: false,
  isSaving: false,
} as EffortView)
const vitals = atom({ plugin: 'standing-orders', key: 'vitals' } as const, {
  now: 0,
  contextPercent: null,
  lastResponseAt: 0,
  cacheTtlMin: 60,
  ratePercent: null,
  hasRepoOrders: true,
} as Vitals)
// The Autopilot pane's open tab.
const tab = atom({ plugin: 'standing-orders', key: 'tab' } as const, 'now' as 'now' | 'settings')
// What the mod did this session: counts only, never stored.
const counts = atom({ plugin: 'standing-orders', key: 'counts' } as const, { effort: {}, models: {}, subagents: 0 } as Counts)
const log = atom({ plugin: 'standing-orders', key: 'log' } as const, [] as LogEntry[])

// ponytail: one session per process, so module-level context is enough.
// The standing-orders files: orders.get() is what the mod obeys, orders.mine() the person's own file.
const orders = createOrders()
// The effort of a turn, the model of a new chat and a subagent's model and effort, and what they remember.
const picks = createPicks(() => orders.get())

const ctx = {
  cwd: '',
  // ponytail: a chat is one load of the mod (a /clear or reload starts a new one); its items are replaced together.
  chat: '',
  turnStartedAt: 0,
  composerAt: 0,
  isTicking: false,
}

// A turn this long that ends without a question still tells the person.
const LONG_TURN_MS = 180_000
// A new entry stays highlighted this long (the module's flash itself lasts under a second).
const FLASH_WINDOW_MS = 1500
const firstLine = (text: string) => text.trim().split('\n')[0]?.slice(0, 160) || 'Finished.'

async function notifyLong($: EngineInterface, ms: number, text: string) {
  if (ms >= LONG_TURN_MS) {
    await $.ui.notify(firstLine(text), { title: `Claude finished after ${Math.round(ms / 60000)}m` })
  }
}

// ---- actions: the commands and the buttons share these ------------------

// A lost feed line must never fail a spawn, a turn or a judgement.
const note = async ($: EngineInterface, kind: LogEntry['kind'], text: string) => {
  try {
    const at = await $.clock.now()
    await update($, log, l => [...l, { at, kind, text }].slice(-30))
  } catch {}
}
const setPaused = ($: EngineInterface, paused: boolean) => update($, isPaused, () => paused)
async function setMode($: EngineInterface, m: 'draft' | 'auto') {
  await update($, mode, () => m)
  await update($, isPaused, () => false)
}

// The picks module's engine: the model, the clock, the effort atom and where picks are recorded.
const pickHost = ($: EngineInterface): Host => ({
  complete: req => $.model.complete(req),
  sleep: ms => $.clock.sleep(ms),
  view: () => read($, effort),
  show: patch => update($, effort, v => ({ ...v, ...patch })),
  contextPercent: async () => (await read($, vitals)).contextPercent,
  note: (kind, text) => note($, kind, text),
  tally: (kind, key = '') =>
    kind === 'subagents'
      ? update($, counts, c => ({ ...c, subagents: c.subagents + 1 }))
      : update($, counts, c => ({ ...c, [kind]: { ...c[kind], [key]: (c[kind][key] ?? 0) + 1 } })),
  toast: text => $.ui.toast(text),
})

// The orders module's file store: the engine's `$.fs`, which can only be called, never passed.
const files = ($: EngineInterface): FileStore => ({
  read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text),
})

// The settings file is the source of truth: buttons and commands write to it.
async function writeSetting($: EngineInterface, pairs: Settings) {
  await orders.set(files($), pairs)
  await applyOrders($)
}
const EFFORT_CHOICES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'off'] as const
const effortChoice = () => (!orders.mine().isEffortAuto ? 'off' : (orders.mine().effortFixed ?? 'auto'))
async function chooseEffort($: EngineInterface, choice: string) {
  await writeSetting($, { effort: choice })
  await picks.setAuto(pickHost($), choice !== 'off')
}
async function setChecks($: EngineInterface, next: (old: Check[]) => Check[]) {
  const list = await update($, checks, next)
  await $.store.set(`checks:${ctx.cwd}`, list)
}
// A tab is named only to land on it; a plain open keeps the one the person left.
const openPane = async ($: EngineInterface, t?: 'now' | 'settings') => {
  if (t) await update($, tab, () => t)
  return $.ui.open({ id: PANE, title: 'Autopilot', closeOnEscape: true })
}
const closePane = ($: EngineInterface) => $.ui.close({ id: PANE })
// Submitted once the calling command has returned: a submit from inside it would
// wait on the turn the command holds.
const startInit = ($: EngineInterface) =>
  $.clock.after(50, () => void $.prompt.submit({ text: INIT_PROMPT, asUser: true }).catch(() => {}))
// Paused, then draft, then auto: one click walks the whole mode.
const cycle = async ($: EngineInterface) => {
  if (await read($, isPaused)) return setMode($, 'draft')
  if ((await read($, mode)) === 'draft') return setMode($, 'auto')
  return setPaused($, true)
}

// ---- orders -------------------------------------------------------------

// What a load of the orders changes elsewhere. Writing the vitals atom is also what
// redraws the Settings tab after a click, so every load comes through here.
async function applyOrders($: EngineInterface) {
  await update($, vitals, v => ({ ...v, hasRepoOrders: orders.hasRepo(), cacheTtlMin: orders.get().cacheTtlMin }))
  await picks.followOrders(pickHost($))
}

// Re-reads the files; applies them when they changed (always, with `force`).
async function reloadOrders($: EngineInterface, force = false) {
  if (await orders.refresh(files($), force)) await applyOrders($)
}

async function addChecks($: EngineInterface, found: readonly unknown[] | undefined, resolved: readonly unknown[] | undefined) {
  const strings = (l: readonly unknown[] | undefined) => (Array.isArray(l) ? l.map(c => String(c)) : [])
  const fresh = strings(found)
  const done = strings(resolved)
  if (!fresh.length && !done.length) return
  const now = await $.clock.now()
  await setChecks($, old => mergeChecks(old, fresh, done, ctx.chat, now))
}

async function wait($: EngineInterface, decision: string) {
  await update($, run, s => ({ ...s, pending: decision }))
  await note($, 'asked', decision)
  const sofar = (await read($, log))
    .filter(l => l.kind === 'answered' || l.kind === 'drafted')
    .slice(-3)
    .map(l => fit(l.text, 40))
    .join(' · ')
  await $.ui.notify(sofar ? `${decision}\nSo far: ${sofar}` : decision, { title: 'Claude needs you' })
}

async function judge($: EngineInterface, answer: string, durationMs: number) {
  const judgedAt = await $.clock.now()
  if (await read($, isPaused)) return
  if (ctx.composerAt > ctx.turnStartedAt) return // the person spoke during the turn

  const tail = answer.slice(-2500)
  const open = await read($, checks)
  const r = await $.model.complete({
    model: 'haiku',
    system: JUDGE,
    prompt: `STANDING ORDERS:\n${orders.get().text}\n\nOPEN CHECKS:\n${open.length ? open.map(c => `- ${c.text}`).join('\n') : '(none)'}\n\nEND OF THE AGENT'S MESSAGE:\n${tail}`,
    maxTokens: 500,
    timeoutMs: 45000,
  })
  const v = r.isAnswered ? parseVerdict(r.text) : null
  if (!v) return
  await addChecks($, v.checks, v.resolved)
  if (ctx.composerAt > judgedAt) return // the person took over meanwhile

  const state = await read($, run)
  if (v.action === 'stop') {
    await note($, 'stopped', v.decision || 'Finished.')
    if (state.autoCount > 0) {
      await $.ui.notify(v.decision || 'Finished.', {
        title: `Done after ${state.autoCount} standing answers`,
      })
    } else {
      await notifyLong($, durationMs, v.decision || answer)
    }
    return
  }
  if (v.action === 'ask') return wait($, v.decision || 'Claude is waiting on you.')

  // continue: a plain-code rail first, whatever the judge said.
  const railed = orders.get().rail?.exec(`${v.reply ?? ''} ${asked(tail)}`)
  if (railed) return wait($, v.decision || `Claude asks about "${railed[0]}": your call.`)
  const isAuto = (await read($, mode)) === 'auto'
  if (isAuto && state.autoCount >= orders.get().maxAuto) {
    return wait($, `${state.autoCount} standing answers this run. Check in.`)
  }
  if ((await $.prompt.read()).text.trim()) return // already typing a reply

  const reply = v.reply || 'Per my standing orders: keep going.'
  if (isAuto) {
    await update($, run, s => ({ ...s, autoCount: s.autoCount + 1, last: reply, pending: null }))
    await note($, 'answered', reply)
    await $.prompt.submit({ text: reply })
    return
  }
  await update($, run, s => ({ ...s, last: reply, pending: null }))
  await note($, 'drafted', reply)
  await $.prompt.fill({ text: reply, mode: 'replace' })
  await $.ui.notify(reply, { title: 'Answer drafted from your orders: Enter sends it, or type your own' })
}

// ---- vitals -------------------------------------------------------------

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const [usage, agents] = await Promise.all([
    $.session.usage().catch(() => null),
    $.agent.list().catch(() => []),
  ])
  const rate = usage?.rateLimits.length
    ? Math.max(...usage.rateLimits.map(r => r.percentUsed))
    : null
  await update($, vitals, v => ({
    ...v,
    now,
    ratePercent: rate,
    contextPercent: usage?.context.percent ?? v.contextPercent,
  }))
  await update($, effort, v => ({ ...v, isSaving: rate !== null && rate >= 85 }))

  // Orders written since the last load (by Claude, an editor, the Write them button) take effect now.
  await reloadOrders($)

  const open = await read($, checks)
  if (liveChecks(open, now).length !== open.length) await setChecks($, old => liveChecks(old, now))
  // A finished subagent's effort is no longer needed.
  picks.prune(agents)
}

// The next value in a cycle; a value outside it starts over.
const cycleOf = <T,>(cur: T, list: readonly T[]) => list[(list.indexOf(cur) + 1) % list.length] as T
// Meters run green, yellow, red; effort runs cool to hot.
const heat = (percent: number) => (percent >= 90 ? 'red' : percent >= 70 ? 'yellow' : 'green')
const EFFORT_COLOR: Record<string, string> = { low: 'green', medium: 'cyan', high: 'magenta', xhigh: 'red' }

// Only the terminal's and the desktop's tables have a Client; it is drawn on the terminal alone (see `fx`).
const clientOf = (ui: object) => (ui as { Client: any }).Client

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // Commands first: whatever fails below, /orders and /autopilot still exist.
    await $.command.register({
      name: 'orders',
      description: 'Standing orders: status, help, setup, init, auto, draft, on, off, effort <level>|model auto|off. Controls live in /autopilot',
    })
    await $.command.register({ name: 'autopilot', description: 'What needs you, what the orders did and picked, and the settings' })
    await $.command.register({ name: 'crew', description: 'Old name of /autopilot' })
    ctx.cwd = e.cwd
    orders.locate({ cwd: e.cwd, globalPath: `${(await $.env.get('HOME')) ?? ''}/.claude/standing-orders.md` })
    await reloadOrders($, true)
    const startedAt = await $.clock.now()
    ctx.chat = String(startedAt)
    const saved = await $.store.get(`checks:${ctx.cwd}`).catch(() => null)
    await update($, checks, () => loadChecks(saved, startedAt))
    if (!ctx.isTicking) {
      ctx.isTicking = true
      $.clock.every(5000, () => void tick($).catch(() => {}))
    }
    void tick($).catch(() => {})
    if (orders.consumeFirstRun()) {
      await openPane($, 'settings').catch(() => {})
    }

    return r
  }).catch(($, e, next) => {
    $.ui.log(`${NAME}: start failed (${next.error.kind}): ${next.error.message ?? 'no message'}`)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Only the chat's first prompt picks its model, only with no history, and never over a /model the person typed.
    if (e.origin.kind === 'composer' && e.turnId === undefined) await picks.firstPrompt(pickHost($), { text: e.text, isCommand: !!e.command })
    if (e.origin.kind === 'composer' && e.command?.name === 'effort') {
      // The person set effort themselves: they win until /orders effort auto.
      await picks.setAuto(pickHost($), false)
    } else if (e.origin.kind === 'composer' && !e.command) {
      ctx.composerAt = await $.clock.now()
      const isDraftSent = (await read($, run)).last === e.text.trim()
      if (e.turnId === undefined) {
        // Enter on a drafted answer continues the run; anything typed starts a new one.
        await update($, run, s =>
          isDraftSent
            ? { ...s, autoCount: s.autoCount + 1, pending: null }
            : { ...IDLE, startedAt: ctx.composerAt },
        )
        if (isDraftSent) ctx.composerAt = 0
        else await reloadOrders($, true)
        await picks.typed(pickHost($), { text: e.text, isDraftSent })
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e)) // never swallow what the person typed

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) ctx.turnStartedAt = await $.clock.now()

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const picked = picks.subagentRequest(e.agentId, e.model, e.effort)
      return yield* next(picked ? { ...e, effort: picked } : e)
    }
    const r = yield* next({ ...e, ...(await picks.request(pickHost($), e)) })
    const done = await $.clock.now()
    await update($, vitals, v => ({ ...v, now: done, lastResponseAt: done }))
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const ev = e as unknown as { prompt: string; subagentType: string; fork?: boolean; isTeammate?: boolean; workflow?: unknown; model?: string }
    const eligible = !(ev.fork || ev.isTeammate || ev.workflow)
    return picks.spawn(pickHost($), { eligible, prompt: ev.prompt, subagentType: ev.subagentType, named: ev.model }, model =>
      next(model ? ({ ...e, model } as typeof e) : e),
    )
  }).catch(($, e, next) => next(e)) // never block a spawn

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r

    picks.afterTurn(e.answer)
    const isAnswer = e.reason === 'answer' && !e.isAborted
    if (isAnswer && STOPS.test(e.answer.slice(-1500))) {
      void judge($, e.answer, e.durationMs).catch(err => $.ui.log(`${NAME}: judge failed: ${String(err)}`))
    } else if (isAnswer) {
      void notifyLong($, e.durationMs, e.answer).catch(() => {})
    }

    return r
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.traits.includes('teammate')) return r // the orders are the lead's, not a worker's

    return {
      sections: [
        ...r.sections,
        { id: `${NAME}:orders`, text: PREAMBLE + orders.get().text, scope: 'session' as const },
      ],
    }
  })

  // /crew is the old name: the same toggle, for this release.
  for (const command of ['autopilot', 'crew']) {
    on('command.run', { command }, async $ => {
      if ((await $.ui.panes()).some(p => p.id === PANE)) {
        await closePane($)
        return { text: 'Autopilot pane closed.' }
      }
      await openPane($)
      void tick($).catch(() => {})

      return { text: 'Autopilot pane opened. Esc, the Close button or /autopilot closes it.' }
    })
  }

  on('command.run', { command: 'orders' }, async ($, e) => {
    const [arg = '', sub = '', ...rest] = e.args.trim().toLowerCase().split(/\s+/)
    if (arg === 'help' || arg === '?') return { text: HELP }
    if (arg === 'effort') {
      if (sub === 'min' || sub === 'max') {
        const v = rest[0] ?? ''
        if (!EFFORTS.includes(v as Effort)) return { text: `Usage: /orders effort ${sub} ${EFFORTS.join('|')}` }
        await writeSetting($, { [`effort-${sub}`]: v })
        return { text: `Auto effort ${sub === 'min' ? 'floor' : 'ceiling'}: ${v}.` }
      }
      const choice = sub === '' ? 'auto' : sub
      if (!(EFFORT_CHOICES as readonly string[]).includes(choice)) return { text: `Usage: /orders effort ${EFFORT_CHOICES.join('|')} | min <level> | max <level>` }
      await chooseEffort($, choice)
      return {
        text:
          choice === 'auto'
            ? `Auto effort on: Haiku picks ${orders.get().effortMin} to ${orders.get().effortMax} for each prompt you type (Opus and Sonnet 5.5 or newer; mid-chat the model never changes).`
            : choice === 'off'
              ? 'Auto effort off: your own effort setting stands.'
              : `Effort fixed at ${choice} (Opus and Sonnet 5.5 or newer), no judge.`,
      }
    }
    if (arg === 'setup') {
      await openPane($, 'settings')
      return { text: 'Autopilot settings opened.' }
    }
    if (arg === 'model') {
      if (sub !== 'auto' && sub !== 'off') return { text: 'Usage: /orders model auto|off' }
      const isAuto = sub === 'auto'
      await writeSetting($, { model: isAuto ? 'auto' : 'off' })
      return {
        text: isAuto
          ? `Auto model on: a brand-new chat picks its model (${orders.get().models.join(', ')}) from your first message. Never mid-chat.`
          : 'Auto model off: /model stands.',
      }
    }
    if (arg === 'auto' || arg === 'draft') {
      await setMode($, arg)
      return {
        text:
          arg === 'auto'
            ? `Auto: answers the orders cover are sent by themselves, up to ${orders.get().maxAuto} per prompt. /orders draft to go back.`
            : 'Draft: answers wait in the prompt box for your Enter.',
      }
    }
    if (arg === 'off' || arg === 'on') {
      await setPaused($, arg === 'off')
      return { text: arg === 'off' ? 'Standing orders paused: Claude\'s questions wait for you. /orders on to resume.' : 'Standing orders on.' }
    }
    if (arg === 'init') {
      startInit($)
      return { text: `Asking Claude to write ${REPO_ORDERS} for this repo.` }
    }
    // Kept working, no longer documented: /autopilot covers both.
    if (arg === 'clear') {
      await setChecks($, () => [])
      return { text: 'Checks cleared.' }
    }
    if (arg === 'checks') {
      const list = await read($, checks)
      const now = await $.clock.now()
      return { text: list.length ? list.map(c => `- ${c.text} (${checkAge(now - c.at)})`).join('\n') : 'No checks waiting.' }
    }
    if (arg !== '') return { text: 'Usage: /orders [help | setup | init | auto | draft | on | off | effort auto|off|<level>|min|max | model auto|off]. Details and controls: /autopilot' }
    const s = await read($, run)
    const ev = await read($, effort)
    return {
      text: [
        `Standing orders: ${(await read($, isPaused)) ? 'paused' : await read($, mode)}, answered ${s.autoCount} of ${orders.get().maxAuto}.`,
        `Effort: ${ev.isAuto ? 'auto' : 'yours'}${ev.level ? `, now ${ev.level}` : ''}${ev.isSaving ? ' (capped: usage past 85%)' : ''}.`,
        ...(s.pending ? [`Needs you: ${s.pending}`] : []),
        'Details and controls: /autopilot',
      ].join('\n'),
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [s, list, paused, m, ev, v] = await Promise.all([
      read($, run),
      read($, checks),
      read($, isPaused),
      read($, mode),
      read($, effort),
      read($, vitals),
    ])
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Client = clientOf(ui)
    // Motion only where a Client is drawn and the person has not turned it off.
    const fx = orders.get().isMotionOn && e.surface === 'terminal'
    const show = (i: BandItem) => orders.get().band.includes(i)

    // Narrow bands get shorter words; whatever still does not fit wraps as whole parts.
    const narrow = (e.props.bodyColumns ?? 100) < 80
    const label = narrow ? (paused ? 'paused' : m === 'auto' ? 'auto' : 'draft') : paused ? 'Orders paused' : m === 'auto' ? 'Orders: auto' : 'Orders: draft'
    const effortText = ev.level
      ? `${ev.model ? `${cap(ev.model)}${narrow ? '·' : ' · '}` : ''}${cap(ev.level)}${ev.isAuto ? '' : narrow ? '*' : ' (yours)'}${ev.isSaving ? ' · save' : ''}`
      : ''
    const left = v.lastResponseAt ? v.cacheTtlMin * 60_000 - (v.now - v.lastResponseAt) : null
    const isCold = left !== null && left <= 0

    // What the line shows is the person's choice (Settings, Status line).
    const parts: [string, any][] = []
    if (show('mode')) {
      parts.push(['mode', <Button key="mode" label={`${paused ? '⏸' : m === 'auto' ? '▶' : '✎'} ${label}`} onPress={() => cycle($)} />])
    }
    if (show('answered') && s.autoCount > 0) parts.push(['answered', <Text dimColor>answered {s.autoCount}</Text>])
    if (show('effort')) {
      if (ev.isJudging) {
        parts.push([
          'effort',
          fx ? (
            <Box>
              <Text dimColor>effort </Text>
              <Client key="judging" module="./motion.tsx" props={{ kind: 'spinner', label: 'deciding' }} />
            </Box>
          ) : (
            <Text dimColor>effort: deciding</Text>
          ),
        ])
      } else if (effortText !== '') {
        parts.push(['effort', <Text color={ev.level ? EFFORT_COLOR[ev.level] : undefined}>{effortText}</Text>])
      }
    }
    if (show('ctx') && v.contextPercent !== null) {
      parts.push(['ctx', <Text color={heat(v.contextPercent)}>ctx {Math.round(v.contextPercent)}%</Text>])
    }
    if (show('limit') && v.ratePercent !== null) {
      parts.push(['limit', <Text color={heat(v.ratePercent)}>limit {Math.round(v.ratePercent)}%</Text>])
    }
    if (show('cache') && left !== null) {
      parts.push(['cache', <Text color={isCold ? 'yellow' : 'cyan'}>{isCold ? 'cache cold' : `cache ${clock(left)}`}</Text>])
    }
    if (show('hint') && !v.hasRepoOrders) parts.push(['hint', <Text dimColor>{narrow ? 'no repo orders' : 'no repo orders: /orders init'}</Text>])
    if (show('autopilot')) {
      parts.push(['autopilot', <Button key="autopilot" label={list.length > 0 ? `Autopilot · ${list.length}${narrow ? '' : ' to do'}` : 'Autopilot'} onPress={() => openPane($)} />])
    }

    return (
      <Box flexDirection="column">
        <Box flexWrap="wrap" columnGap={2}>
          {parts.map(([k, node]) => (
            <Box key={`part-${k}`} flexShrink={0}>
              {node}
            </Box>
          ))}
        </Box>
        {s.pending && <Text color="yellow" bold>⚠ Needs you: {s.pending}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Input } = ui
    const Client = clientOf(ui)
    const [t, v, s, list, paused, m, ev, entries, tl, isOpen, now] = await Promise.all([
      read($, tab), read($, vitals), read($, run), read($, checks),
      read($, isPaused), read($, mode), read($, effort), read($, log), read($, counts), read($, isChecksOpen),
      $.clock.now(),
    ])
    // The pane body scrolls, so nothing here is squeezed to a height.
    const width = Math.max(30, e.props.bodyColumns ?? 60)
    const fx = orders.get().isMotionOn && e.surface === 'terminal'
    const goTo = (to: 'now' | 'settings') => () => update($, tab, () => to)
    const tabBtn = (id: 'now' | 'settings', text: string) =>
      t === id ? (
        <Text bold underline color="cyan">{text}</Text>
      ) : (
        <Button key={id} dimColor label={text} hover={{ scope: `tab-${id}`, color: 'cyan', underline: true }} onPress={goTo(id)} />
      )
    const tabs = (
      <Box justifyContent="space-between">
        <Box gap={2}>
          {tabBtn('now', 'Now')}
          {tabBtn('settings', 'Settings')}
        </Box>
        <Button key="close" role="dismiss" dimColor label="✕ Close" onPress={() => closePane($)} />
      </Box>
    )
    // A bordered card: dim at rest, its own colour under the pointer, yellow when it needs the person.
    const card = (key: string, title: string, color: string, body: any, opts: { hot?: boolean; right?: any } = {}) => (
      <Box
        key={`card-${key}`}
        flexDirection="column"
        borderStyle="round"
        borderColor={opts.hot ? 'yellow' : undefined}
        borderDimColor={!opts.hot}
        paddingX={1}
        hover={{ borderColor: opts.hot ? 'yellow' : color, borderDimColor: false }}
      >
        <Box justifyContent="space-between">
          <Text bold color={color}>{title}</Text>
          {opts.right}
        </Box>
        {body}
      </Box>
    )

    if (t === 'settings') {
      // The person's own file, so a repo's orders are never written back into it.
      const mine = orders.mine()
      const choice = effortChoice()
      const control = (key: string, icon: string, name: string, color: string, value: string, hint: string, buttons: any, extra?: any) =>
        card(
          key,
          `${icon} ${name}`,
          color,
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              <Box flexShrink={1}>
                <Text wrap="truncate-end">{value}</Text>
              </Box>
              <Box flexShrink={0}>{buttons}</Box>
            </Box>
            <Text dimColor>{hint}</Text>
            {extra}
          </Box>,
        )
      const onOff = (isOn: boolean, key: 'model' | 'subagents') => (
        <Button key={key} label={isOn ? 'Turn off' : 'Turn on'} onPress={() => writeSetting($, { [key]: isOn ? 'off' : 'auto' })} />
      )
      // A row of toggles: ✓ on, ○ off. `last` keeps at least one on.
      const chips = <T extends string>(prefix: string, all: readonly T[], active: readonly T[], save: (next: T[]) => void, last = false) => (
        <Box flexWrap="wrap" columnGap={1}>
          {all.map(name => {
            const isOn = active.includes(name)
            return (
              <Button
                key={`${prefix}-${name}`}
                dimColor={!isOn}
                label={`${isOn ? '✓' : '○'} ${name}`}
                onPress={() => {
                  const next = all.filter(x => (x === name ? !isOn : active.includes(x)))
                  if (last && next.length === 0) return
                  save(next)
                }}
              />
            )
          })}
        </Box>
      )
      const addTerms = (raw: string) => {
        const words = raw.split(',').map(w => w.trim()).filter(Boolean)
        if (words.length) void writeSetting($, { 'always-ask': [...new Set([...mine.terms, ...words])].join(', ') })
      }
      const TTLS = [5, 15, 30, 60]
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
{!v.hasRepoOrders && control('repo', '◈', 'Repo orders missing', 'yellow', 'none yet',
            'Without them the autopilot only knows your global rules. Claude writes .claude/standing-orders.md from this repo: how to verify work, what to ask first.',
            (
              <Button key="init" label="Write them" onPress={() => {
                startInit($)
                $.ui.toast(`Asking Claude to write ${REPO_ORDERS} for this repo.`)
              }} />
            ))}
          <Box flexDirection="column"><Text bold dimColor>HOW IT ANSWERS</Text><Text dimColor>What the autopilot may do on its own.</Text></Box>
{card(
            'replies', '✎ Replies', 'green',
            <Box flexDirection="column" gap={1}>
              <Box justifyContent="space-between">
                <Text>Up to {mine.maxAuto} answers in a row in auto mode</Text>
                <Box gap={1}>
                  <Button key="maxauto-dec" label="−" onPress={() => writeSetting($, { 'max-auto': String(Math.max(1, mine.maxAuto - 1)) })} />
                  <Button key="maxauto-inc" label="+" onPress={() => writeSetting($, { 'max-auto': String(Math.min(50, mine.maxAuto + 1)) })} />
                </Box>
              </Box>
              <Text dimColor>Always ask you first when a reply or question mentions (click one to remove it):</Text>
              <Box flexWrap="wrap" columnGap={1}>
                {mine.terms.map(term => (
                  <Button key={`term-${term}`} dimColor label={`${term} ✕`} onPress={() => writeSetting($, { 'always-ask': mine.terms.filter(x => x !== term).join(', ') })} />
                ))}
              </Box>
              <Input key={`term-add-${mine.terms.length}`} placeholder="add words, comma separated" submitLabel="add" onSubmit={addTerms} />
            </Box>,
          )}
          {control('effort', '◆', 'Effort', ev.level ? EFFORT_COLOR[ev.level] ?? 'magenta' : 'magenta',
            `${!ev.isAuto ? 'yours' : mine.effortFixed ? `${mine.effortFixed} (fixed)` : `auto ${mine.effortMin}–${mine.effortMax}`}`,
            'auto picks low to xhigh thinking for every prompt you type; a level fixes it; off leaves /effort to you.',
            <Button key="effort" label={`⟳ ${ev.isAuto ? choice : 'yours'}`} onPress={() => chooseEffort($, cycleOf(effortChoice(), EFFORT_CHOICES))} />,
            choice === 'auto' && (
              <Box flexShrink={0} gap={1}>
                <Text dimColor>Range</Text>
                <Button key="floor" label={`floor ${mine.effortMin}${mine.effortMin === 'low' ? ' (default)' : ''}`} onPress={() => writeSetting($, { 'effort-min': cycleOf(orders.mine().effortMin, ['low', 'medium', 'high']) })} />
                <Button key="ceiling" label={`ceiling ${mine.effortMax}${mine.effortMax === 'xhigh' ? ' (default)' : ''}`} onPress={() => writeSetting($, { 'effort-max': cycleOf(orders.mine().effortMax, ['medium', 'high', 'xhigh', 'max']) })} />
                <Button key="reset" label="reset" onPress={() => writeSetting($, { 'effort-min': 'low', 'effort-max': 'xhigh' })} />
              </Box>
            ))}
                    <Box flexDirection="column"><Text bold dimColor>MODELS</Text><Text dimColor>Which model and effort each chat and helper gets.</Text></Box>
{control('chats', '◇', 'New chats', 'blue', mine.isModelAuto ? `auto · ${mine.models.join(' / ')}` : 'your /model',
            'Picks the model from your first message, only while the chat is empty (cache-safe). Choose which models it may use.',
            onOff(mine.isModelAuto, 'model'),
            mine.isModelAuto && chips('model', MODEL_NAMES, mine.models, next => void writeSetting($, { models: next.join(', ') }), true))}
          {control('subagents', '◇', 'Subagents', 'cyan', mine.isSubagentsAuto ? 'auto · model + effort per task' : 'inherit the chat',
            'Picks a model (Haiku for mechanical work) and effort for each helper from its task. Anything you named wins.',
            onOff(mine.isSubagentsAuto, 'subagents'))}
                    <Box flexDirection="column"><Text bold dimColor>DISPLAY</Text><Text dimColor>What you see above the prompt and in this pane.</Text></Box>
{card(
            'band', '▤ Status line', 'yellow',
            <Box flexDirection="column" gap={1}>
              <Text dimColor>What the line above the prompt shows:</Text>
              {chips('band', BAND_ITEMS, mine.band, next => void writeSetting($, { band: next.join(', ') }))}
              <Box justifyContent="space-between">
                <Text>Prompt cache lasts {mine.cacheTtlMin} min <Text dimColor>(a repo may set its own)</Text></Text>
                <Button key="ttl" label="⟳ change" onPress={() => writeSetting($, { 'cache-ttl': String(cycleOf(orders.mine().cacheTtlMin, TTLS)) })} />
              </Box>
            </Box>,
          )}
          {control('motion', '✦', 'Motion', 'magenta', mine.isMotionOn ? 'on · only while something happens' : 'off · static text',
            'A spinner while effort is picked, bars that ease, a highlight on new entries. Nothing moves at rest.',
            <Button key="motion" label={mine.isMotionOn ? 'Turn off' : 'Turn on'} onPress={() => writeSetting($, { motion: mine.isMotionOn ? 'off' : 'on' })} />)}
          {v.hasRepoOrders && control('repo', '◈', 'Repo orders', 'yellow', v.hasRepoOrders ? 'found' : 'none',
            'This repo\'s own .claude/standing-orders.md: how to verify work here, what to ask first.',
            v.hasRepoOrders ? null : (
              <Button key="init" label="Write them" onPress={() => {
                startInit($)
                $.ui.toast(`Asking Claude to write ${REPO_ORDERS} for this repo.`)
              }} />
            ))}
          <Text dimColor>
            {orders.get().terms.length} always-ask words · every click saves · rules live in ~/.claude/standing-orders.md
          </Text>
        </Box>
      )
    }

    // ---- Now ---------------------------------------------------------------
    const newest = [...list].reverse()
    const shown = isOpen ? newest : newest.slice(0, SHOWN_CHECKS)
    const recent = [...entries].reverse().slice(0, 8)
    const left = v.lastResponseAt ? v.cacheTtlMin * 60_000 - (v.now - v.lastResponseAt) : null
    // [name, colour, percent, text]
    const meters: [string, string, number, string][] = []
    if (v.contextPercent !== null) meters.push(['ctx', heat(v.contextPercent), v.contextPercent, `${Math.round(v.contextPercent)}%`])
    if (v.ratePercent !== null) meters.push(['limit', heat(v.ratePercent), v.ratePercent, `${Math.round(v.ratePercent)}%`])
    if (left !== null) {
      const ttl = v.cacheTtlMin * 60_000
      meters.push(['cache', left <= 0 ? 'yellow' : 'cyan', left <= 0 ? 0 : (left / ttl) * 100, left <= 0 ? 'cold' : `${clock(left)} left`])
    }
    // Fresh enough to highlight: only the newest of a list, so one timer at most per list.
    const isFresh = (at: number) => fx && now - at >= 0 && now - at < FLASH_WINDOW_MS
    const hasPending = !!s.pending || list.length > 0
    const bars = fx && width >= 48

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Box justifyContent="space-between">
          <Text bold color={paused ? 'yellow' : m === 'auto' ? 'green' : 'cyan'}>
            {paused ? '⏸ Paused' : m === 'auto' ? '▶ Auto' : '✎ Draft'}
            <Text dimColor> · answered {s.autoCount} of {orders.get().maxAuto}</Text>
          </Text>
          <Box gap={1}>
            <Button key="mode" label={m === 'auto' ? 'Draft' : 'Auto'} onPress={() => setMode($, m === 'auto' ? 'draft' : 'auto')} />
            <Button key="pause" label={paused ? '▶ Resume' : '⏸ Pause'} onPress={() => setPaused($, !paused)} />
          </Box>
        </Box>

        {card(
          'effort', 'Effort', 'magenta',
          ev.isJudging ? (
            fx ? <Client key="judging" module="./motion.tsx" props={{ kind: 'spinner', label: 'deciding' }} /> : <Text dimColor>deciding…</Text>
          ) : ev.level ? (
            <Box flexDirection="column">
              <Text bold color={EFFORT_COLOR[ev.level]}>{ev.model ? `${cap(ev.model)} · ` : ''}{cap(ev.level)}</Text>
              {(!ev.isAuto || (ev.why && ev.why !== 'auto') || ev.isSaving) && (
                <Text dimColor>{!ev.isAuto ? 'set by you' : ev.why && ev.why !== 'auto' ? ev.why : ''}{ev.isSaving ? `${ev.why && ev.why !== 'auto' ? ' · ' : ''}capped by usage` : ''}</Text>
              )}
            </Box>
          ) : <Text dimColor>Picked with your next prompt.</Text>,
        )}

        {hasPending ? card(
          'needs', `Needs you · ${(s.pending ? 1 : 0) + list.length}`, 'yellow',
          <Box flexDirection="column">
            {s.pending && (
              <Box flexDirection="column">
                <Text color="yellow" bold>? {fit(s.pending, width - 6)}</Text>
                <Text dimColor>  Claude is waiting on this. Answer in the prompt.</Text>
              </Box>
            )}
            {s.pending && shown.length > 0 && <Text dimColor>Only you can check:</Text>}
            {groupChecks(shown).map((g, gi) => (
              <Box key={`grp${gi}-${g.lead ?? ''}`} flexDirection="column" marginTop={gi > 0 || s.pending ? 1 : 0}>
                {g.lead && (
                  <Box justifyContent="space-between">
                    <Text bold>{g.lead} <Text dimColor>· {g.items.length}</Text></Text>
                    <Button key={`all${gi}`} dimColor label="Done all" hover={{ scope: `all-${gi}`, color: 'green' }} onPress={() => setChecks($, old => old.filter(x => !g.items.some(y => y.item.at === x.at && y.item.text === x.text)))} />
                  </Box>
                )}
                {g.items.map(({ item: c, text }) => {
                  const id = `${c.at}:${c.text}`
                  const age = v.now - c.at
                  const life = checkLife(age)
                  const isNewest = c === shown[0]
                  // unique per item: checks found in one turn share a timestamp, and a shared scope lights them together
                  const n = shown.indexOf(c)
                  const done = <Button key={`tick${id}`} label="✓ Done" /* a scope is capped at 64 characters and shared by equal strings: build it from the position, not text or time */ hover={{ scope: `done-${n}`, color: 'green' }} onPress={() => setChecks($, old => old.filter(x => x.at !== c.at || x.text !== c.text))} />
                  const ask = <Button key={`ask${id}`} dimColor label="↳ Ask" hover={{ scope: `ask-${n}`, color: 'cyan' }} onPress={() => void $.prompt.fill({ text: `About this check: ${c.text}`, mode: 'replace' })} />
                  const line = isNewest && isFresh(c.at) ? (
                    <Client key={`flash-check-${c.at}`} module="./motion.tsx" width="100%" props={{ kind: 'flash', head: '', body: `${text} · ${checkAge(age)}` }} />
                  ) : (
                    <Text>{text} <Text dimColor>· {checkAge(age)}</Text>{life ? <Text color="yellow"> · {life}</Text> : null}</Text>
                  )
                  // Wide: one row. Narrow: the text gets the full width, its buttons sit under it.
                  return width >= 80 ? (
                    <Box key={`check${id}`} gap={1} paddingLeft={g.lead ? 2 : 0}>
                      {done}
                      <Box flexShrink={1} flexGrow={1}>{line}</Box>
                      {ask}
                    </Box>
                  ) : (
                    <Box key={`check${id}`} flexDirection="column" paddingLeft={g.lead ? 2 : 0} marginTop={1}>
                      {line}
                      <Box gap={2}>{done}{ask}</Box>
                    </Box>
                  )
                })}
              </Box>
            ))}
            {list.length > SHOWN_CHECKS && (
              <Button key="older" label={isOpen ? 'Show fewer' : `+${list.length - SHOWN_CHECKS} older`} onPress={() => update($, isChecksOpen, o => !o)} />
            )}
          </Box>,
          { hot: true, right: list.length > 1 ? <Button key="clear" label="Clear all" onPress={() => setChecks($, () => [])} /> : undefined },
        ) : (
          <Text color="green">✓ Nothing needs you</Text>
        )}

        {card(
          'activity', 'Activity', 'blue',
          <Box flexDirection="column">
            {recent.length > 0
              ? recent.map((l, i) =>
                  i === 0 && isFresh(l.at) ? (
                    <Client key={`flash-log-${l.at}`} module="./motion.tsx" width="100%" props={{ kind: 'flash', head: logHead(l, now), body: logBody(l), dim: isPick(l.kind) }} />
                  ) : (
                    <Box key={`log${i}`} gap={1} marginTop={width < 80 && i > 0 ? 1 : 0}>
                      <Text dimColor>{logHead(l, v.now)}</Text>
                      <Box flexShrink={1}>
                        <Text dimColor={isPick(l.kind)}>{logBody(l)}</Text>
                      </Box>
                    </Box>
                  ),
                )
              : <Text dimColor>Nothing yet. Decisions and picks show up here.</Text>}
            {(Object.keys(tl.effort).length > 0 || Object.keys(tl.models).length > 0 || tl.subagents > 0) && (
              <Text dimColor>
                this session ·{Object.entries(tl.effort).map(([k, n]) => ` ${k} ×${n}`).join('')}
                {Object.keys(tl.models).length > 0 ? ` · models${Object.entries(tl.models).map(([k, n]) => ` ${k} ×${n}`).join('')}` : ''}
                {tl.subagents > 0 ? ` · ${tl.subagents} subagents steered` : ''}
              </Text>
            )}
          </Box>,
        )}

        {meters.length > 0 &&
          (bars ? (
            card(
              'usage', 'Usage', 'cyan',
              <Box flexDirection="column">
                {meters.map(([name, color, percent, text]) => (
                  <Client key={`bar-${name}`} module="./motion.tsx" props={{ kind: 'bar', name: name.padEnd(5), percent, color, width: Math.min(24, width - 28), text }} />
                ))}
              </Box>,
            )
          ) : (
            <Box>
              {meters.map(([name, color, , text], i) => (
                <Box key={name}>
                  {i > 0 && <Text dimColor> · </Text>}
                  <Text color={color}>{name} {text}</Text>
                </Box>
              ))}
            </Box>
          ))}
      </Box>
    )
  })
}
