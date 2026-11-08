import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Check, Counts, EffortView, LogEntry, Vitals } from '../types'
import {
  HELP,
  INIT_PROMPT,
  REPO_ORDERS,
  JUDGE,
  PREAMBLE,
  STOPS,
  INTRO,
  asked,
  fit,
  EFFORTS,
  parseVerdict,
  MODEL_NAMES,
  type Effort,
} from './judges'
import { checkAge, createChecks, type Host as ChecksHost } from './checks'
import { BAND_ITEMS, createOrders, type BandItem, type FileStore, type Settings } from './orders'
import { createPicks, type Host } from './picks'
import { IDLE, beforeJudging, decide, drafted, sent, waiting, whenTyped } from './run'
import { bandView, effortColor, paneView } from './view'

const NAME = 'standing-orders'
const PANE = 'autopilot'
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
// The Needs you list: its load, its changes (each saved with the list), its expiry and what the pane shows of it.
const needsYou = createChecks()

const ctx = {
  turnStartedAt: 0,
  composerAt: 0,
  isTicking: false,
}

// A turn this long that ends without a question still tells the person.
const LONG_TURN_MS = 180_000
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

// The checks module's engine: the checks atom and the store it is saved in.
const checkHost = ($: EngineInterface): ChecksHost => ({
  list: () => read($, checks),
  change: next => update($, checks, next),
  load: key => $.store.get(key),
  save: (key, list) => $.store.set(key, list),
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

async function wait($: EngineInterface, decision: string) {
  await update($, run, s => waiting(s, decision))
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
  if (beforeJudging({ isPaused: await read($, isPaused), composerAt: ctx.composerAt, turnStartedAt: ctx.turnStartedAt })) return

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
  await needsYou.add(checkHost($), v.checks, v.resolved, await $.clock.now())

  const state = await read($, run)
  const d = await decide(
    {
      verdict: v,
      composerAt: ctx.composerAt,
      judgedAt,
      railed: orders.get().rail?.exec(`${v.reply ?? ''} ${asked(tail)}`)?.[0] ?? null,
      isAuto: (await read($, mode)) === 'auto',
      autoCount: state.autoCount,
      maxAuto: orders.get().maxAuto,
    },
    async () => !!(await $.prompt.read()).text.trim(),
  )
  if (d.do === 'skip') return
  if (d.do === 'ask') return wait($, d.text)
  if (d.do === 'stop') {
    await note($, 'stopped', v.decision || 'Finished.')
    if (state.autoCount > 0) {
      await $.ui.notify(v.decision || 'Finished.', {
        title: `Done after ${state.autoCount} automatic answers`,
      })
    } else {
      await notifyLong($, durationMs, v.decision || answer)
    }
    return
  }
  if (d.do === 'send') {
    await update($, run, s => sent(s, d.reply))
    await note($, 'answered', d.reply)
    await $.prompt.submit({ text: d.reply })
    return
  }
  await update($, run, s => drafted(s, d.reply))
  await note($, 'drafted', d.reply)
  await $.prompt.fill({ text: d.reply, mode: 'replace' })
  await $.ui.notify(d.reply, { title: 'Answer drafted from your orders: Enter sends it, or type your own' })
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

  await needsYou.expire(checkHost($), now)
  // A finished subagent's effort is no longer needed.
  picks.prune(agents)
}

// The next value in a cycle; a value outside it starts over.
const cycleOf = <T,>(cur: T, list: readonly T[]) => list[(list.indexOf(cur) + 1) % list.length] as T
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
    orders.locate({ cwd: e.cwd, globalPath: `${(await $.env.get('HOME')) ?? ''}/.claude/standing-orders.md` })
    await reloadOrders($, true)
    const startedAt = await $.clock.now()
    await needsYou.load(checkHost($), { cwd: e.cwd, now: startedAt })
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
      if (e.turnId === undefined) {
        // Enter on a drafted answer continues the run; anything typed starts a new one.
        let isDraftSent = false as boolean // set inside the update (the closure runs before the await returns)
        await update($, run, s => {
          const typed = whenTyped(s, { text: e.text, now: ctx.composerAt })
          isDraftSent = typed.isDraftSent
          return typed.run
        })
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
              : `Effort fixed at ${choice} (Opus and Sonnet 5.5 or newer), no Haiku call.`,
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
      await needsYou.clear(checkHost($))
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
        `Standing orders: ${(await read($, isPaused)) ? 'paused' : await read($, mode)}, answered ${s.autoCount} of up to ${orders.get().maxAuto} in a row.`,
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
    const view = bandView({ run: s, checks: list, isPaused: paused, mode: m, effort: ev, vitals: v }, { columns: e.props.bodyColumns })
    const meter = (name: 'ctx' | 'limit' | 'cache') => view.meters.find(x => x.name === name)

    // What the line shows is the person's choice (Settings, Status line).
    const parts: [string, any][] = []
    if (show('mode')) {
      parts.push(['mode', <Button key="mode" label={view.mode.label} onPress={() => cycle($)} />])
    }
    if (show('answered') && view.answered > 0) parts.push(['answered', <Text dimColor>answered {view.answered}</Text>])
    if (show('effort')) {
      if (view.effort.isJudging) {
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
      } else if (view.effort.text !== '') {
        parts.push([
          'effort',
          view.isNarrow ? (
            <Text color={view.effort.color}>{view.effort.text}</Text>
          ) : (
            <Box>
              <Text dimColor>effort </Text>
              <Text color={view.effort.color}>{view.effort.text}</Text>
            </Box>
          ),
        ])
      }
    }
    for (const name of ['ctx', 'limit', 'cache'] as const) {
      const x = meter(name)
      if (show(name) && x) parts.push([name, <Text color={x.tone}>{view.isNarrow ? x.label : x.wideLabel}</Text>])
    }
    if (show('hint') && !v.hasRepoOrders) parts.push(['hint', <Text dimColor>{view.hint}</Text>])
    if (show('autopilot')) {
      parts.push(['autopilot', <Button key="autopilot" label={view.autopilot} onPress={() => openPane($)} />])
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
        {view.note && (
          <Text wrap="truncate-end">
            <Text color="yellow" bold>{view.note.label}</Text>
            {view.note.text ? ` ${view.note.text}` : ''}
            {view.note.more ? <Text dimColor> {view.note.more}</Text> : null}
          </Text>
        )}
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
      const control = (key: string, icon: string, name: string, color: string, value: string, hint: string, buttons: any, extra?: any, note?: string) =>
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
            {note && source(note)}
          </Box>,
        )
      const onOff = (isOn: boolean, key: 'model' | 'subagents') => (
        <Button key={key} label={isOn ? 'Turn off' : 'Turn on'} onPress={() => writeSetting($, { [key]: isOn ? 'off' : 'auto' })} />
      )
      // A row of toggles: ✓ on, ○ off. `last` keeps at least one on.
      const chips = <T extends string>(prefix: string, all: readonly T[], active: readonly T[], save: (next: T[]) => void, last = false, names: Record<string, string> = {}) => (
        <Box flexWrap="wrap" columnGap={1}>
          {all.map(name => {
            const isOn = active.includes(name)
            return (
              <Button
                key={`${prefix}-${name}`}
                dimColor={!isOn}
                label={`${isOn ? '✓' : '○'} ${names[name] ?? name}`}
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
      // Where a card's values live, in one dim italic line under it.
      const source = (text: string) => <Text dimColor italic>{text}</Text>
      const BAND_NAMES: Record<string, string> = { ctx: 'context', limit: 'usage limit', cache: 'prompt cache', hint: 'repo-orders hint', autopilot: 'Autopilot button' }
      const REPO_NOTE = 'A repo file can only add to always-ask, lower max-auto, set effort: off and cache-ttl; your own file decides the rest.'
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
            ),
            undefined,
            REPO_NOTE)}
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
              <Text dimColor>Never answers for you when the question or reply mentions one of these words (click one to remove it):</Text>
              <Box flexWrap="wrap" columnGap={1}>
                {mine.terms.map(term => (
                  <Button key={`term-${term}`} dimColor label={`${term} ✕`} onPress={() => writeSetting($, { 'always-ask': mine.terms.filter(x => x !== term).join(', ') })} />
                ))}
              </Box>
              <Input key={`term-add-${mine.terms.length}`} placeholder="add words, comma separated" submitLabel="add" onSubmit={addTerms} />
              {source('Saved as max-auto: and always-ask: in ~/.claude/standing-orders.md (starter list on first run). A repo file can add words or lower the cap.')}
            </Box>,
          )}
          {control('effort', '◆', 'Effort', effortColor(ev.level) ?? 'magenta',
            `${!ev.isAuto ? 'yours' : mine.effortFixed ? `${mine.effortFixed} (fixed)` : `auto ${mine.effortMin}–${mine.effortMax}`}`,
            'How hard Claude thinks. auto picks a level for each prompt you type, between the floor and ceiling; a level fixes it; off leaves /effort to you.',
            <Button key="effort" label={`⟳ ${ev.isAuto ? choice : 'yours'}`} onPress={() => chooseEffort($, cycleOf(effortChoice(), EFFORT_CHOICES))} />,
            choice === 'auto' && (
              <Box flexShrink={0} gap={1}>
                <Text dimColor>Range</Text>
                <Button key="floor" label={`floor ${mine.effortMin}${mine.effortMin === 'low' ? ' (default)' : ''}`} onPress={() => writeSetting($, { 'effort-min': cycleOf(orders.mine().effortMin, ['low', 'medium', 'high']) })} />
                <Button key="ceiling" label={`ceiling ${mine.effortMax}${mine.effortMax === 'xhigh' ? ' (default)' : ''}`} onPress={() => writeSetting($, { 'effort-max': cycleOf(orders.mine().effortMax, ['medium', 'high', 'xhigh', 'max']) })} />
                <Button key="reset" label="reset" onPress={() => writeSetting($, { 'effort-min': 'low', 'effort-max': 'xhigh' })} />
              </Box>
            ),
            'Saved as effort:, effort-min: and effort-max: in ~/.claude/standing-orders.md. A repo file can only set effort: off.')}
                    <Box flexDirection="column"><Text bold dimColor>MODELS</Text><Text dimColor>Which model and effort each chat and helper gets.</Text></Box>
{control('chats', '◇', 'New chats', 'blue', mine.isModelAuto ? `auto · ${mine.models.join(' / ')}` : 'your /model',
            'Picks the model from your first message of a brand-new chat, never mid-chat. Choose which models it may pick.',
            onOff(mine.isModelAuto, 'model'),
            mine.isModelAuto && chips('model', MODEL_NAMES, mine.models, next => void writeSetting($, { models: next.join(', ') }), true),
            'Saved as model: and models: in ~/.claude/standing-orders.md.')}
          {control('subagents', '◇', 'Subagents', 'cyan', mine.isSubagentsAuto ? 'auto · model + effort per task' : 'same as the chat',
            'Subagents are the helper agents Claude starts for side tasks. auto picks each one\'s model (Haiku for mechanical work) and effort from its task; a model Claude already named for it wins.',
            onOff(mine.isSubagentsAuto, 'subagents'),
            undefined,
            'Saved as subagents: in ~/.claude/standing-orders.md.')}
                    <Box flexDirection="column"><Text bold dimColor>DISPLAY</Text><Text dimColor>What you see above the prompt and in this pane.</Text></Box>
{card(
            'band', '▤ Status line', 'yellow',
            <Box flexDirection="column" gap={1}>
              <Text dimColor>What the line above the prompt shows:</Text>
              {chips('band', BAND_ITEMS, mine.band, next => void writeSetting($, { band: next.join(', ') }), false, BAND_NAMES)}
              <Box justifyContent="space-between">
                <Text>Prompt cache lasts {mine.cacheTtlMin} min</Text>
                <Button key="ttl" label="⟳ change" onPress={() => writeSetting($, { 'cache-ttl': String(cycleOf(orders.mine().cacheTtlMin, TTLS)) })} />
              </Box>
              {source('Saved as band: and cache-ttl: in ~/.claude/standing-orders.md. cache-ttl only sets the cache countdown; a repo file may set its own.')}
            </Box>,
          )}
          {control('motion', '✦', 'Motion', 'magenta', mine.isMotionOn ? 'on · only while something happens' : 'off · static text',
            'A spinner while effort is picked, bars that ease, a highlight on new entries. Nothing moves at rest.',
            <Button key="motion" label={mine.isMotionOn ? 'Turn off' : 'Turn on'} onPress={() => writeSetting($, { motion: mine.isMotionOn ? 'off' : 'on' })} />,
            undefined,
            'Saved as motion: in ~/.claude/standing-orders.md.')}
          {v.hasRepoOrders && control('repo', '◈', 'Repo orders', 'yellow', v.hasRepoOrders ? 'found' : 'none',
            'This repo\'s own .claude/standing-orders.md: how to verify work here, what to ask first.',
            v.hasRepoOrders ? null : (
              <Button key="init" label="Write them" onPress={() => {
                startInit($)
                $.ui.toast(`Asking Claude to write ${REPO_ORDERS} for this repo.`)
              }} />
            ),
            undefined,
            REPO_NOTE)}
          <Text dimColor>
            {orders.get().terms.length} always-ask words in force · every click saves to ~/.claude/standing-orders.md
          </Text>
        </Box>
      )
    }

    // ---- Now ---------------------------------------------------------------
    const view = paneView(
      { run: s, checks: list, isPaused: paused, mode: m, effort: ev, vitals: v, log: entries, counts: tl, isChecksOpen: isOpen },
      { columns: e.props.bodyColumns, fx, now, maxAuto: orders.get().maxAuto },
    )
    const { mode: vm, needs, activity, usage, intro } = view

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {intro && card('intro', 'What is this?', 'cyan', <Box flexDirection="column">{intro.map(line => <Text key={line} dimColor>{line}</Text>)}</Box>)}
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold color={vm.tone}>
              {vm.label}
              <Text dimColor> · {vm.answered}</Text>
            </Text>
            <Box gap={1}>
              <Button key="mode" label={vm.toggleLabel} onPress={() => setMode($, vm.toggleTo)} />
              <Button key="pause" label={vm.pauseLabel} onPress={() => setPaused($, !paused)} />
            </Box>
          </Box>
          <Text dimColor>{vm.note}</Text>
        </Box>

        {card(
          'effort', 'Effort', 'magenta',
          <Box flexDirection="column">
            <Text dimColor>How hard Claude thinks about your prompt.</Text>
            {view.effort.kind === 'judging' ? (
              fx ? <Client key="judging" module="./motion.tsx" props={{ kind: 'spinner', label: 'deciding' }} /> : <Text dimColor>deciding…</Text>
            ) : view.effort.kind === 'level' ? (
              <Box flexDirection="column">
                <Text bold color={view.effort.color}>{view.effort.title}</Text>
                {view.effort.note !== null && <Text dimColor>{view.effort.note}</Text>}
              </Box>
            ) : <Text dimColor>Chosen when you send your next prompt.</Text>}
          </Box>,
        )}

        {needs.hasAny ? card(
          'needs', `Needs you · ${needs.count}`, 'yellow',
          <Box flexDirection="column">
            <Text dimColor>Claude's question for you, and things only you can check.</Text>
            {needs.pending && (
              <Box flexDirection="column">
                <Box>
                  <Text color="yellow" bold>? </Text>
                  <Box flexShrink={1}>
                    <Text color="yellow" bold>{needs.pending}</Text>
                  </Box>
                </Box>
                <Text dimColor>  Claude is waiting on this. Answer in the prompt.</Text>
              </Box>
            )}
            {needs.pending && needs.groups.length > 0 && <Text dimColor>Only you can check:</Text>}
            {needs.groups.map((g, gi) => (
              <Box key={`grp${gi}-${g.lead ?? ''}`} flexDirection="column" marginTop={gi > 0 || needs.pending ? 1 : 0}>
                {g.lead && (
                  <Box justifyContent="space-between">
                    <Text bold>{g.lead} <Text dimColor>· {g.items.length}</Text></Text>
                    <Button key={`all${gi}`} dimColor label="Done all" hover={{ scope: `all-${gi}`, color: 'green' }} onPress={() => needsYou.tickOffGroup(checkHost($), g)} />
                  </Box>
                )}
                {g.items.map(({ item: c, text, age, life, isFlash, flashBody }) => {
                  // a hover scope is unique per item: checks found in one turn share a timestamp, and a shared scope lights them together
                  const done = <Button key={`tick${c.id}`} label="✓ Done" /* a scope is capped at 64 characters and shared by equal strings: build it from the position, not text or time */ hover={{ scope: `done-${c.slot}`, color: 'green' }} onPress={() => needsYou.tickOff(checkHost($), c.id)} />
                  const ask = <Button key={`ask${c.id}`} dimColor label="↳ Ask" hover={{ scope: `ask-${c.slot}`, color: 'cyan' }} onPress={() => void $.prompt.fill({ text: `About this check: ${c.text}`, mode: 'replace' })} />
                  const line = isFlash ? (
                    <Client key={`flash-check-${c.at}`} module="./motion.tsx" width="100%" props={{ kind: 'flash', head: '', body: flashBody }} />
                  ) : (
                    <Text>{text} <Text dimColor>· {age}</Text>{life ? <Text color="yellow"> · {life}</Text> : null}</Text>
                  )
                  // Wide: one row. Narrow: the text gets the full width, its buttons sit under it.
                  return view.isWide ? (
                    <Box key={`check${c.id}`} gap={1} paddingLeft={g.lead ? 2 : 0}>
                      {done}
                      <Box flexShrink={1} flexGrow={1}>{line}</Box>
                      {ask}
                    </Box>
                  ) : (
                    <Box key={`check${c.id}`} flexDirection="column" paddingLeft={g.lead ? 2 : 0} marginTop={1}>
                      {line}
                      <Box gap={2}>{done}{ask}</Box>
                    </Box>
                  )
                })}
              </Box>
            ))}
            {needs.older > 0 && (
              <Button key="older" label={needs.olderLabel} onPress={() => update($, isChecksOpen, o => !o)} />
            )}
          </Box>,
          { hot: true, right: needs.canClearAll ? <Button key="clear" label="Clear all" onPress={() => needsYou.clear(checkHost($))} /> : undefined },
        ) : (
          <Text color="green">✓ Nothing needs you</Text>
        )}

        {card(
          'activity', 'Activity', 'blue',
          <Box flexDirection="column">
            {activity.rows.length > 0
              ? activity.rows.map((l, i) =>
                  l.isFlash ? (
                    <Client key={`flash-log-${l.at}`} module="./motion.tsx" width="100%" props={{ kind: 'flash', head: l.flashHead, body: l.body, dim: l.isPick }} />
                  ) : (
                    <Box key={`log${i}`} gap={1} marginTop={!view.isWide && i > 0 ? 1 : 0}>
                      <Text dimColor>{l.head}</Text>
                      <Box flexShrink={1}>
                        <Text dimColor={l.isPick}>{l.body}</Text>
                      </Box>
                    </Box>
                  ),
                )
              : <Text dimColor>Nothing yet. Answers it sends or drafts, questions it passes to you, and the effort and models it picks show up here.</Text>}
            {activity.tally && <Text dimColor>{activity.tally}</Text>}
          </Box>,
        )}

        {usage.kind === 'bars' ? (
          card(
            'usage', 'Usage', 'cyan',
            <Box flexDirection="column">
              {usage.meters.map(x => (
                <Client key={`bar-${x.name}`} module="./motion.tsx" props={{ kind: 'bar', name: x.barName, percent: x.percent, color: x.tone, width: usage.barWidth, text: x.text }} />
              ))}
              {usage.legend.map(line => <Text key={line} dimColor>{line}</Text>)}
            </Box>,
          )
        ) : usage.kind === 'inline' ? (
          <Box flexDirection="column">
            <Box>
              {usage.meters.map((x, i) => (
                <Box key={x.name}>
                  {i > 0 && <Text dimColor> · </Text>}
                  <Text color={x.tone}>{x.name} {x.text}</Text>
                </Box>
              ))}
            </Box>
            {usage.legend.map(line => <Text key={line} dimColor>{line}</Text>)}
          </Box>
        ) : null}
      </Box>
    )
  })
}
