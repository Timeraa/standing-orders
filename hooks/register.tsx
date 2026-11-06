import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Check, Counts, EffortView, LogEntry, Run, Vitals } from '../types'
import {
  DEFAULT_ORDERS,
  HELP,
  INIT_PROMPT,
  REPO_ORDERS,
  EFFORT_JUDGE,
  JUDGE,
  MODEL_JUDGE,
  PREAMBLE,
  STOPS,
  asked,
  checkAge,
  liveChecks,
  loadChecks,
  mergeChecks,
  SHOWN_CHECKS,
  fit,
  EFFORTS,
  SUBAGENT_JUDGE,
  capEffort,
  clampEffort,
  parseSubagent,
  subagentModels,
  clock,
  isFollowUp,
  isPick,
  logBody,
  logHead,
  parseEffort,
  parseModel,
  setSetting,
  parseOrders,
  parseVerdict,
  pickText,
  takesEffort,
  type Effort,
  type ModelName,
} from './judges'

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
const ctx = {
  orders: parseOrders(DEFAULT_ORDERS),
  // The person's own file alone: what the Settings tab starts from.
  mine: parseOrders(DEFAULT_ORDERS),
  globalPath: '',
  cwd: '',
  // ponytail: a chat is one load of the mod (a /clear or reload starts a new one); its items are replaced together.
  chat: '',
  turnStartedAt: 0,
  composerAt: 0,
  lastAnswerTail: '',
  // effort
  effortJob: null as Promise<{ effort: Effort; why: string } | null> | null,
  turnEffort: null as Effort | null,
  lastBase: undefined as unknown,
  lastApplied: undefined as unknown,
  isTicking: false,
  // model: chosen once, for a chat with no history
  isFirstRun: false,
  isModelChecked: false,
  modelJob: null as Promise<{ model: ModelName; why: string } | null> | null,
  chatModel: null as { base: string; id: string } | null,
  // subagents: the effort picked at spawn, by agent id
  agentEffort: new Map<string, Effort>(),
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
async function setEffortAuto($: EngineInterface, isAuto: boolean) {
  await update($, effort, v => ({ ...v, isAuto, why: isAuto ? 'auto' : 'yours' }))
  if (!isAuto) ctx.turnEffort = null
}
const tally = ($: EngineInterface, kind: 'effort' | 'models', key: string) =>
  update($, counts, c => ({ ...c, [kind]: { ...c[kind], [key]: (c[kind][key] ?? 0) + 1 } }))

// The settings file is the source of truth: buttons and commands write to it.
async function writeSetting($: EngineInterface, pairs: Record<string, string>) {
  let text: string
  try {
    text = await $.fs.read(ctx.globalPath)
  } catch {
    text = DEFAULT_ORDERS
  }
  for (const [k, v] of Object.entries(pairs)) text = setSetting(text, k, v)
  await $.fs.write(ctx.globalPath, text)
  await loadOrders($)
}
const EFFORT_CHOICES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'off'] as const
const effortChoice = () => (!ctx.mine.isEffortAuto ? 'off' : (ctx.mine.effortFixed ?? 'auto'))
async function chooseEffort($: EngineInterface, choice: string) {
  await writeSetting($, { effort: choice })
  await setEffortAuto($, choice !== 'off')
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

async function loadOrders($: EngineInterface) {
  let text: string
  try {
    text = await $.fs.read(ctx.globalPath)
  } catch {
    text = DEFAULT_ORDERS
    ctx.isFirstRun = true
    await $.fs.write(ctx.globalPath, DEFAULT_ORDERS).catch(() => {})
  }
  let repo = ''
  let hasRepoOrders = false
  try {
    repo = await $.fs.read(`${ctx.cwd}/${REPO_ORDERS}`)
    hasRepoOrders = true
  } catch {}
  ctx.orders = parseOrders(text, repo)
  ctx.mine = parseOrders(text)
  await update($, vitals, v => ({ ...v, hasRepoOrders, cacheTtlMin: ctx.orders.cacheTtlMin }))
  if (!ctx.orders.isEffortAuto) await update($, effort, v => ({ ...v, isAuto: false }))
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
    prompt: `STANDING ORDERS:\n${ctx.orders.text}\n\nOPEN CHECKS:\n${open.length ? open.map(c => `- ${c.text}`).join('\n') : '(none)'}\n\nEND OF THE AGENT'S MESSAGE:\n${tail}`,
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
  const railed = ctx.orders.rail?.exec(`${v.reply ?? ''} ${asked(tail)}`)
  if (railed) return wait($, v.decision || `Claude asks about "${railed[0]}": your call.`)
  const isAuto = (await read($, mode)) === 'auto'
  if (isAuto && state.autoCount >= ctx.orders.maxAuto) {
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

// ---- effort -------------------------------------------------------------

async function judgeEffort($: EngineInterface, text: string) {
  const r = await $.model.complete({
    model: 'haiku',
    system: EFFORT_JUDGE,
    prompt: `END OF THE AGENT'S PREVIOUS MESSAGE:\n${ctx.lastAnswerTail || '(none: first message)'}\n\nTHE USER'S MESSAGE:\n${text.slice(0, 3000)}`,
    maxTokens: 80,
    timeoutMs: 8000,
  })
  return r.isAnswered ? parseEffort(r.text) : null
}

async function pickEffort($: EngineInterface): Promise<void> {
  const job = ctx.effortJob
  if (!job) return
  ctx.effortJob = null
  const timeout = $.clock.sleep(3000).then(() => null)
  const picked = await Promise.race([job, timeout]).catch(() => null)
  const saving = (await read($, effort)).isSaving
  if (picked) {
    const { effortMin, effortMax } = ctx.orders
    const level = clampEffort(picked.effort, effortMin, saving ? capEffort(effortMax, 'medium') : effortMax)
    ctx.turnEffort = level
    await update($, effort, v => ({ ...v, why: picked.why, isJudging: false }))
    await note($, 'effort', pickText(level, picked.why))
  } else {
    await update($, effort, v => ({ ...v, why: 'judge slow: kept', isJudging: false }))
  }
}

// ---- model: a new chat only ---------------------------------------------

async function judgeModel($: EngineInterface, text: string) {
  const { models } = ctx.orders
  const r = await $.model.complete({
    model: 'haiku',
    system: MODEL_JUDGE,
    prompt: `ALLOWED MODELS: ${models.join(', ')}\n\nTHE USER'S FIRST MESSAGE:\n${text.slice(0, 3000)}`,
    maxTokens: 80,
    timeoutMs: 3000,
  })
  return r.isAnswered ? parseModel(r.text, models) : null
}

// Waits briefly for the first prompt's pick, then pins the chat to it.
async function pickModel($: EngineInterface, base: string) {
  const job = ctx.modelJob
  if (!job) return
  ctx.modelJob = null
  const picked = await Promise.race([job, $.clock.sleep(3000).then(() => null)]).catch(() => null)
  if (!picked || shortModel(base) === picked.model) return
  // An alias: the engine resolves it to the family's newest model.
  ctx.chatModel = { base, id: picked.model }
  void tally($, 'models', picked.model)
  await note($, 'model', pickText(picked.model, picked.why))
  $.ui.toast(`Auto model: this chat runs on ${cap(picked.model)} (${picked.why}). /model changes it; /orders model off stops this.`)
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

  const open = await read($, checks)
  if (liveChecks(open, now).length !== open.length) await setChecks($, old => liveChecks(old, now))
  // A finished subagent's effort is no longer needed.
  const listed = new Map(agents.map(a => [a.id, a.status]))
  for (const id of ctx.agentEffort.keys()) {
    const st = listed.get(id)
    if (st && !['pending', 'running', 'waiting'].includes(st)) ctx.agentEffort.delete(id)
  }
}

const shortModel = (m: string) => /(haiku|sonnet|opus|fable)/i.exec(m)?.[1]?.toLowerCase() ?? (m || '?')
// The next value in a cycle; a value outside it starts over.
const cycleOf = <T,>(cur: T, list: readonly T[]) => list[(list.indexOf(cur) + 1) % list.length] as T
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
// Meters run green, yellow, red; effort runs cool to hot.
const heat = (percent: number) => (percent >= 90 ? 'red' : percent >= 70 ? 'yellow' : 'green')
const EFFORT_COLOR: Record<string, string> = { low: 'green', medium: 'cyan', high: 'magenta', xhigh: 'red' }

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
    ctx.globalPath = `${(await $.env.get('HOME')) ?? ''}/.claude/standing-orders.md`
    await loadOrders($)
    const startedAt = await $.clock.now()
    ctx.chat = String(startedAt)
    const saved = await $.store.get(`checks:${ctx.cwd}`).catch(() => null)
    await update($, checks, () => loadChecks(saved, startedAt))
    if (!ctx.isTicking) {
      ctx.isTicking = true
      $.clock.every(5000, () => void tick($).catch(() => {}))
    }
    void tick($).catch(() => {})
    if (ctx.isFirstRun) {
      ctx.isFirstRun = false
      await openPane($, 'settings').catch(() => {})
    }

    return r
  }).catch(($, e, next) => {
    $.ui.log(`${NAME}: start failed (${next.error.kind}): ${next.error.message ?? 'no message'}`)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && e.turnId === undefined && !ctx.isModelChecked) {
      // Only the chat's first prompt, only with no history, and never over a /model the person typed.
      ctx.isModelChecked = true
      const pct = (await read($, vitals)).contextPercent
      if (ctx.orders.isModelAuto && !e.command && (pct === null || pct < 5) && !isFollowUp(e.text)) {
        ctx.modelJob = judgeModel($, e.text)
      }
    }
    if (e.origin.kind === 'composer' && e.command?.name === 'effort') {
      // The person set effort themselves: they win until /orders effort auto.
      await update($, effort, v => ({ ...v, isAuto: false, why: 'yours' }))
      ctx.turnEffort = null
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
        else await loadOrders($)

        const ev = await read($, effort)
        if (ev.isAuto && !ctx.orders.effortFixed && !isDraftSent && !isFollowUp(e.text)) {
          ctx.effortJob = judgeEffort($, e.text)
          await update($, effort, v => ({ ...v, isJudging: true }))
        } else if (ev.isAuto && ctx.orders.effortFixed) {
          await update($, effort, v => ({ ...v, why: 'fixed' }))
        } else if (ev.isAuto) {
          await update($, effort, v => ({ ...v, why: 'kept for a follow-up' }))
        }
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
      const picked = ctx.agentEffort.get(e.agentId)
      const isSteerable = picked && typeof e.effort === 'string' && takesEffort(e.model)
      return yield* next(isSteerable ? { ...e, effort: picked } : e)
    }
    // The chat's pick from its first prompt: every main request goes there until the person runs /model.
    if (e.index === 0) await pickModel($, e.model)
    if (ctx.chatModel && e.model !== ctx.chatModel.base) ctx.chatModel = null
    const model = ctx.chatModel?.id ?? e.model

    let ev = await read($, effort)
    if (e.index === 0) {
      // The session's own level moved under us: the person changed it.
      const moved =
        ctx.lastBase !== undefined && e.effort !== ctx.lastBase && e.effort !== ctx.lastApplied
      ctx.lastBase = e.effort
      if (moved && ev.isAuto) {
        ctx.turnEffort = null
        ctx.effortJob = null
        ev = await update($, effort, v => ({ ...v, isAuto: false, isJudging: false, why: 'yours' }))
        $.ui.toast('You changed effort yourself: auto effort is off. /orders effort auto turns it back on.')
      }
      if (ev.isAuto && !ctx.orders.effortFixed && takesEffort(model)) await pickEffort($)
    }

    const level = ev.isAuto && takesEffort(model) ? (ctx.orders.effortFixed ?? ctx.turnEffort) : null
    if (level) ctx.lastApplied = level
    if (level && e.index === 0) void tally($, 'effort', level)
    await update($, effort, v => ({ ...v, level: level ?? (e.effort === undefined ? null : String(e.effort)) }))

    const r = yield* next({ ...e, ...(level ? { effort: level } : {}), ...(ctx.chatModel ? { model } : {}) })
    const done = await $.clock.now()
    await update($, vitals, v => ({ ...v, now: done, lastResponseAt: done }))
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const ev = e as unknown as { prompt: string; subagentType: string; fork?: boolean; isTeammate?: boolean; workflow?: unknown; model?: string }
    if (!ctx.orders.isSubagentsAuto || ev.fork || ev.isTeammate || ev.workflow) return next(e)
    const allowed = subagentModels(ctx.orders.models)
    const pick = await Promise.race([
      $.model
        .complete({
          model: 'haiku',
          system: SUBAGENT_JUDGE,
          prompt: `ALLOWED MODELS: ${allowed.join(', ')}\n\nSUBAGENT TYPE: ${ev.subagentType}\nTASK:\n${String(ev.prompt).slice(0, 2000)}`,
          maxTokens: 80,
          timeoutMs: 3000,
        })
        .then(r => (r.isAnswered ? parseSubagent(r.text, allowed) : null)),
      $.clock.sleep(3000).then(() => null),
    ]).catch(() => null)
    if (!pick) return next(e)
    // A model the Agent call already named wins; only the gap is filled.
    const result = await next(ev.model ? e : ({ ...e, model: pick.model } as typeof e))
    const id = (result as { agentId?: string }).agentId
    if (id) {
      const level = clampEffort(pick.effort, ctx.orders.effortMin, ctx.orders.effortMax)
      ctx.agentEffort.set(id, level)
      const model = shortModel(String((result as { model?: string }).model ?? pick.model))
      await update($, counts, c => ({ ...c, subagents: c.subagents + 1 }))
      void tally($, 'models', model)
      await note($, 'subagent', pickText(`${model}/${level}`, pick.why))
    }
    return result
  }).catch(($, e, next) => next(e)) // never block a spawn

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r

    ctx.lastAnswerTail = e.answer.slice(-800)
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
        { id: `${NAME}:orders`, text: PREAMBLE + ctx.orders.text, scope: 'session' as const },
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
            ? `Auto effort on: Haiku picks ${ctx.orders.effortMin} to ${ctx.orders.effortMax} for each prompt you type (Opus and Sonnet 5.5 or newer; mid-chat the model never changes).`
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
          ? `Auto model on: a brand-new chat picks its model (${ctx.orders.models.join(', ')}) from your first message. Never mid-chat.`
          : 'Auto model off: /model stands.',
      }
    }
    if (arg === 'auto' || arg === 'draft') {
      await setMode($, arg)
      return {
        text:
          arg === 'auto'
            ? `Auto: answers the orders cover are sent by themselves, up to ${ctx.orders.maxAuto} per prompt. /orders draft to go back.`
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
        `Standing orders: ${(await read($, isPaused)) ? 'paused' : await read($, mode)}, answered ${s.autoCount} of ${ctx.orders.maxAuto}.`,
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
    const { Box, Text, Button } = $.ui.resolve(e)

    const label = paused ? 'Orders paused' : m === 'auto' ? 'Orders: auto' : 'Orders: draft'
    const effortText = ev.isJudging
      ? 'effort: deciding'
      : ev.level
        ? `${cap(ev.level)}${ev.isAuto ? '' : ' (yours)'}${ev.isSaving ? ' · save' : ''}`
        : ''
    const left = v.lastResponseAt ? v.cacheTtlMin * 60_000 - (v.now - v.lastResponseAt) : null
    const isCold = left !== null && left <= 0

    return (
      <Box flexDirection="column">
        <Box>
          <Button
            key="mode"
            label={`${paused ? '⏸' : m === 'auto' ? '▶' : '✎'} ${label}`}
            onPress={() => cycle($)}
          />
          {s.autoCount > 0 && <Text dimColor> · answered {s.autoCount}</Text>}
          {effortText !== '' && <Text color={ev.level ? EFFORT_COLOR[ev.level] : undefined}> · {effortText}</Text>}
          {v.contextPercent !== null && (
            <Text color={heat(v.contextPercent)}>
              {' '}· ctx {Math.round(v.contextPercent)}%
            </Text>
          )}
          {left !== null && (
            <Text color={isCold ? 'yellow' : 'cyan'}>
              {' '}· {isCold ? 'cache cold' : `cache ${clock(left)}`}
            </Text>
          )}
          {!v.hasRepoOrders && <Text dimColor> · no repo orders: /orders init</Text>}
          <Text> · </Text>
          <Button
            key="autopilot"
            label={list.length > 0 ? `Autopilot · ${list.length} to do` : 'Autopilot'}
            onPress={() => openPane($)}
          />
        </Box>
        {s.pending && <Text color="yellow" bold>⚠ Needs you: {s.pending}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [t, v, s, list, paused, m, ev, entries, tl, isOpen] = await Promise.all([
      read($, tab), read($, vitals), read($, run), read($, checks),
      read($, isPaused), read($, mode), read($, effort), read($, log), read($, counts), read($, isChecksOpen),
    ])
    // The pane body scrolls, so nothing here is squeezed to a height.
    const width = Math.max(30, e.props.bodyColumns ?? 60)
    const heading = (text: string, color?: string) => <Text bold color={color}>{text}</Text>
    const goTo = (to: 'now' | 'settings') => () => update($, tab, () => to)
    const tabs = (
      <Box justifyContent="space-between">
        <Box>
          {t === 'now' ? <Text bold color="cyan">● Now</Text> : <Button key="now" label="Now" onPress={goTo('now')} />}
          <Text>  </Text>
          {t === 'settings' ? <Text bold color="cyan">● Settings</Text> : <Button key="settings" label="Settings" onPress={goTo('settings')} />}
        </Box>
        <Button key="close" role="dismiss" label="✕ Close" onPress={() => closePane($)} />
      </Box>
    )

    if (t === 'settings') {
      // The person's own file, so a repo's orders are never written back into it.
      const mine = ctx.mine
      const choice = effortChoice()
      const effortNow = ev.level ? ` · now ${cap(ev.level)}${ev.isAuto && ev.why && ev.why !== 'auto' ? ` (${ev.why})` : ''}` : ''
      const control = (icon: string, name: string, color: string, value: string, hint: string, buttons: any) => (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Box flexShrink={1}>
              <Text color={color} bold>{icon} {name.padEnd(11)}</Text>
              <Text wrap="truncate-end">{value}</Text>
            </Box>
            <Box flexShrink={0}>{buttons}</Box>
          </Box>
          <Text dimColor>  {hint}</Text>
        </Box>
      )
      const onOff = (isOn: boolean, key: 'model' | 'subagents') => (
        <Button key={key} label={isOn ? 'Turn off' : 'Turn on'} onPress={() => writeSetting($, { [key]: isOn ? 'off' : 'auto' })} />
      )
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          {control('◆', 'Effort', ev.level ? EFFORT_COLOR[ev.level] ?? 'magenta' : 'magenta',
            `${!ev.isAuto ? 'yours' : mine.effortFixed ? `${mine.effortFixed} (fixed)` : `auto ${mine.effortMin}–${mine.effortMax}`}${effortNow}`,
            'auto picks low to xhigh thinking for every prompt you type; a level fixes it; off leaves /effort to you.',
            <Button key="effort" label={`⟳ ${ev.isAuto ? choice : 'yours'}`} onPress={() => chooseEffort($, cycleOf(effortChoice(), EFFORT_CHOICES))} />)}
          {choice === 'auto' && (
            <Box>
              <Text>  Range  </Text>
              <Button key="floor" label={`floor ${mine.effortMin}${mine.effortMin === 'low' ? ' (default)' : ''}`} onPress={() => writeSetting($, { 'effort-min': cycleOf(ctx.mine.effortMin, ['low', 'medium', 'high']) })} />
              <Text>  </Text>
              <Button key="ceiling" label={`ceiling ${mine.effortMax}${mine.effortMax === 'xhigh' ? ' (default)' : ''}`} onPress={() => writeSetting($, { 'effort-max': cycleOf(ctx.mine.effortMax, ['medium', 'high', 'xhigh', 'max']) })} />
              <Text>  </Text>
              <Button key="reset" label="reset" onPress={() => writeSetting($, { 'effort-min': 'low', 'effort-max': 'xhigh' })} />
            </Box>
          )}
          {control('◇', 'New chats', 'blue', mine.isModelAuto ? `auto · ${mine.models.join(' / ')}` : 'your /model',
            'Sonnet or Opus from your first message, only while the chat is empty (cache-safe).',
            onOff(mine.isModelAuto, 'model'))}
          {control('◇', 'Subagents', 'cyan', mine.isSubagentsAuto ? 'auto · model + effort per task' : 'inherit the chat',
            'Picks a model (Haiku for mechanical work) and effort for each helper from its task. Anything you named wins.',
            onOff(mine.isSubagentsAuto, 'subagents'))}
          {control('◈', 'Repo orders', 'yellow', v.hasRepoOrders ? 'found' : 'none',
            'This repo\'s own .claude/standing-orders.md: how to verify work here, what to ask first.',
            v.hasRepoOrders ? null : (
              <Button key="init" label="Write them" onPress={() => {
                startInit($)
                $.ui.toast(`Asking Claude to write ${REPO_ORDERS} for this repo.`)
              }} />
            ))}
          <Text dimColor>
            {ctx.orders.terms.length} always-ask words · every click saves · rules live in ~/.claude/standing-orders.md
          </Text>
        </Box>
      )
    }

    // ---- Now ---------------------------------------------------------------
    const newest = [...list].reverse()
    const shown = isOpen ? newest : newest.slice(0, SHOWN_CHECKS)
    const recent = [...entries].reverse().slice(0, 8)
    const left = v.lastResponseAt ? v.cacheTtlMin * 60_000 - (v.now - v.lastResponseAt) : null
    const meters: [string, string, string][] = []
    if (v.contextPercent !== null) meters.push(['ctx', heat(v.contextPercent), `ctx ${Math.round(v.contextPercent)}%`])
    if (v.ratePercent !== null) meters.push(['limit', heat(v.ratePercent), `limit ${Math.round(v.ratePercent)}%`])
    if (left !== null) meters.push(['cache', left <= 0 ? 'yellow' : 'cyan', left <= 0 ? 'cache cold' : `cache ${clock(left)} left`])

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Box justifyContent="space-between">
          <Text bold color={paused ? 'yellow' : m === 'auto' ? 'green' : 'cyan'}>
            {paused ? '⏸ Paused' : m === 'auto' ? '▶ Auto' : '✎ Draft'}
            <Text dimColor> · answered {s.autoCount} of {ctx.orders.maxAuto}</Text>
          </Text>
          <Box>
            <Button key="mode" label={m === 'auto' ? 'Draft' : 'Auto'} onPress={() => setMode($, m === 'auto' ? 'draft' : 'auto')} />
            <Text> </Text>
            <Button key="pause" label={paused ? '▶ Resume' : '⏸ Pause'} onPress={() => setPaused($, !paused)} />
          </Box>
        </Box>

        {s.pending || list.length > 0 ? (
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              {heading(`Needs you · ${(s.pending ? 1 : 0) + list.length}`, 'yellow')}
              {list.length > 1 && <Button key="clear" label="Clear all" onPress={() => setChecks($, () => [])} />}
            </Box>
            {s.pending && <Text color="yellow" bold>? {fit(s.pending, width - 2)}</Text>}
            {shown.map(c => {
              const id = `${c.at}:${c.text}`
              return (
                <Box key={`check${id}`}>
                  <Button key={`tick${id}`} label="✓ Done" onPress={() => setChecks($, old => old.filter(x => x.at !== c.at || x.text !== c.text))} />
                  <Box marginLeft={1} flexShrink={1}>
                    <Text>{c.text} <Text dimColor>· {checkAge(v.now - c.at)}</Text></Text>
                  </Box>
                </Box>
              )
            })}
            {list.length > SHOWN_CHECKS && (
              <Button key="older" label={isOpen ? 'Show fewer' : `+${list.length - SHOWN_CHECKS} older`} onPress={() => update($, isChecksOpen, o => !o)} />
            )}
          </Box>
        ) : (
          <Text color="green">✓ Nothing needs you</Text>
        )}

        <Box flexDirection="column">
          {heading('Activity', 'blue')}
          {recent.length > 0
            ? recent.map((l, i) => (
                <Box key={`log${i}`}>
                  <Text dimColor>{logHead(l, v.now)} </Text>
                  <Box flexShrink={1}>
                    <Text dimColor={isPick(l.kind)}>{logBody(l)}</Text>
                  </Box>
                </Box>
              ))
            : <Text dimColor>Nothing yet. Decisions and picks show up here.</Text>}
          {(Object.keys(tl.effort).length > 0 || Object.keys(tl.models).length > 0 || tl.subagents > 0) && (
            <Text dimColor>
              this session ·{Object.entries(tl.effort).map(([k, n]) => ` ${k} ×${n}`).join('')}
              {Object.keys(tl.models).length > 0 ? ` · models${Object.entries(tl.models).map(([k, n]) => ` ${k} ×${n}`).join('')}` : ''}
              {tl.subagents > 0 ? ` · ${tl.subagents} subagents steered` : ''}
            </Text>
          )}
        </Box>

        {meters.length > 0 && (
          <Box>
            {meters.map(([k, color, text], i) => (
              <Box key={k}>
                {i > 0 && <Text dimColor> · </Text>}
                <Text color={color}>{text}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
