import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CrewRow, EffortView, LogEntry, Run, Vitals } from '../types'
import {
  DEFAULT_ORDERS,
  HELP,
  INIT_PROMPT,
  REPO_ORDERS,
  EFFORT_JUDGE,
  JUDGE,
  PREAMBLE,
  STOPS,
  asked,
  bar,
  fit,
  capEffort,
  clock,
  isFollowUp,
  logBody,
  logHead,
  orderTree,
  parseEffort,
  parseOrders,
  parseVerdict,
  statusMark,
  takesEffort,
  type Effort,
} from './judges'

const NAME = 'standing-orders'
const PANE = 'crew'
const IDLE: Run = { autoCount: 0, startedAt: 0, pending: null, last: null }
const run = atom({ plugin: 'standing-orders', key: 'run' } as const, IDLE)
const isPaused = atom({ plugin: 'standing-orders', key: 'isPaused' } as const, false)
// ponytail: per session on purpose; every new session starts in draft mode.
const mode = atom({ plugin: 'standing-orders', key: 'mode' } as const, 'draft' as 'draft' | 'auto')
const checks = atom({ plugin: 'standing-orders', key: 'checks' } as const, [] as string[])
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
const crew = atom({ plugin: 'standing-orders', key: 'crew' } as const, [] as CrewRow[])
const log = atom({ plugin: 'standing-orders', key: 'log' } as const, [] as LogEntry[])

type Loop = { model: string; startedAt: number; lastAt: number; lastTool: string; tools: number }

// ponytail: one session per process, so module-level context is enough.
const ctx = {
  orders: parseOrders(DEFAULT_ORDERS),
  globalPath: '',
  cwd: '',
  turnStartedAt: 0,
  composerAt: 0,
  isTurnRunning: false,
  lastAnswerTail: '',
  // effort
  effortJob: null as Promise<{ effort: Effort; why: string } | null> | null,
  turnEffort: null as Effort | null,
  lastBase: undefined as unknown,
  lastApplied: undefined as unknown,
  // crew
  loops: new Map<string, Loop>(),
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

const loopOf = (id: string, now: number) => {
  let l = ctx.loops.get(id)
  if (!l) {
    l = { model: '', startedAt: now, lastAt: now, lastTool: '', tools: 0 }
    ctx.loops.set(id, l)
  }
  return l
}

function toolLabel(e: Record<string, unknown>) {
  const arg = e.description ?? e.command ?? e.file_path ?? e.pattern ?? e.url ?? e.prompt ?? ''
  return `${String(e.tool)} ${String(arg).replace(/\s+/g, ' ').slice(0, 48)}`.trim()
}

// ---- actions: the commands and the buttons share these ------------------

const note = async ($: EngineInterface, kind: LogEntry['kind'], text: string) => {
  const at = await $.clock.now()
  await update($, log, l => [...l, { at, kind, text }].slice(-20))
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
async function setChecks($: EngineInterface, next: (old: string[]) => string[]) {
  const list = await update($, checks, next)
  await $.store.set(`checks:${ctx.cwd}`, list)
}
const openCrew = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Crew', closeOnEscape: true })
const closeCrew = ($: EngineInterface) => $.ui.close({ id: PANE })
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
    await $.fs.write(ctx.globalPath, DEFAULT_ORDERS).catch(() => {})
  }
  let hasRepoOrders = false
  try {
    text += `\n\n# This repo's orders\n\n${await $.fs.read(`${ctx.cwd}/${REPO_ORDERS}`)}`
    hasRepoOrders = true
  } catch {}
  ctx.orders = parseOrders(text)
  await update($, vitals, v => ({ ...v, hasRepoOrders, cacheTtlMin: ctx.orders.cacheTtlMin }))
  if (!ctx.orders.isEffortAuto) await update($, effort, v => ({ ...v, isAuto: false }))
}

async function addChecks($: EngineInterface, found: readonly unknown[] | undefined) {
  const fresh = (found ?? []).map(c => String(c).trim()).filter(Boolean)
  if (!fresh.length) return
  await setChecks($, old => [...old, ...fresh.filter(c => !old.includes(c))].slice(-30))
}

async function wait($: EngineInterface, decision: string) {
  await update($, run, s => ({ ...s, pending: decision }))
  await note($, 'asked', decision)
  await $.ui.notify(decision, { title: 'Claude needs you' })
}

async function judge($: EngineInterface, answer: string, durationMs: number) {
  const judgedAt = await $.clock.now()
  if (await read($, isPaused)) return
  if (ctx.composerAt > ctx.turnStartedAt) return // the person spoke during the turn

  const tail = answer.slice(-2500)
  const r = await $.model.complete({
    model: 'haiku',
    system: JUDGE,
    prompt: `STANDING ORDERS:\n${ctx.orders.text}\n\nEND OF THE AGENT'S MESSAGE:\n${tail}`,
    maxTokens: 500,
    timeoutMs: 45000,
  })
  const v = r.isAnswered ? parseVerdict(r.text) : null
  if (!v) return
  await addChecks($, v.checks)
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
    ctx.turnEffort = capEffort(picked.effort, saving ? 'medium' : 'xhigh')
    await update($, effort, v => ({ ...v, why: picked.why, isJudging: false }))
  } else {
    await update($, effort, v => ({ ...v, why: 'judge slow: kept', isJudging: false }))
  }
}

// ---- vitals and crew ----------------------------------------------------

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

  const rows: CrewRow[] = agents
    .map(a => {
      const l = loopOf(a.id, now)
      return {
        id: a.id,
        name: a.name ?? a.description,
        type: a.type,
        status: a.status,
        model: l.model,
        startedAt: l.startedAt,
        lastAt: l.lastAt,
        lastTool: l.lastTool,
        tools: l.tools,
        parentId: a.parentId,
      }
    })
    // finished agents fade out of the list after ten minutes
    .filter(r => ['pending', 'running', 'waiting'].includes(r.status) || now - r.lastAt < 600_000)
    .slice(-30)
  const main = loopOf('main', now)
  await update($, crew, () => [
    {
      id: 'main',
      name: 'main conversation',
      type: 'main',
      status: ctx.isTurnRunning ? 'running' : 'idle',
      model: main.model,
      startedAt: ctx.turnStartedAt || main.startedAt,
      lastAt: main.lastAt,
      lastTool: main.lastTool,
      tools: main.tools,
    },
    ...rows,
  ])
}

const ago = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`)
const shortModel = (m: string) => /(haiku|sonnet|opus|fable)/i.exec(m)?.[1]?.toLowerCase() ?? (m || '?')
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    ctx.cwd = e.cwd
    ctx.globalPath = `${(await $.env.get('HOME')) ?? ''}/.claude/standing-orders.md`
    await loadOrders($)
    const saved = await $.store.get(`checks:${ctx.cwd}`)
    await update($, checks, () => (Array.isArray(saved) ? saved.map(String) : []))
    await $.command.register({
      name: 'orders',
      description: 'Standing orders: status, help, init, auto, draft, on, off, effort auto|off. Controls live in /crew',
    })
    await $.command.register({ name: 'crew', description: 'Agents, what the orders did, things for you, and the controls' })
    if (!ctx.isTicking) {
      ctx.isTicking = true
      $.clock.every(5000, () => void tick($).catch(() => {}))
    }
    void tick($).catch(() => {})

    return r
  })

  on('prompt.submit', async ($, e, next) => {
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
        if (ev.isAuto && !isDraftSent && !isFollowUp(e.text)) {
          ctx.effortJob = judgeEffort($, e.text)
          await update($, effort, v => ({ ...v, isJudging: true }))
        } else if (ev.isAuto) {
          await update($, effort, v => ({ ...v, why: 'kept for a follow-up' }))
        }
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e)) // never swallow what the person typed

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      ctx.turnStartedAt = await $.clock.now()
      ctx.isTurnRunning = true
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const now = await $.clock.now()
    if (e.agentId !== undefined) {
      loopOf(e.agentId, now).model = e.model
      return yield* next(e)
    }
    loopOf('main', now).model = e.model

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
      if (ev.isAuto && takesEffort(e.model)) await pickEffort($)
    }

    const level = ev.isAuto && takesEffort(e.model) ? ctx.turnEffort : null
    if (level) ctx.lastApplied = level
    await update($, effort, v => ({ ...v, level: level ?? (e.effort === undefined ? null : String(e.effort)) }))

    const r = yield* next(level ? { ...e, effort: level } : e)
    const done = await $.clock.now()
    await update($, vitals, v => ({ ...v, now: done, lastResponseAt: done }))
    return r
  })

  on('tool.call', async ($, e, next) => {
    const l = loopOf(e.agentId ?? 'main', await $.clock.now())
    l.lastTool = toolLabel(e as unknown as Record<string, unknown>)
    l.lastAt = await $.clock.now()
    l.tools += 1

    return next(e)
  }).catch(($, e, next) => next(e)) // bookkeeping only: never block a tool call

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r

    ctx.isTurnRunning = false
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

  on('command.run', { command: 'crew' }, async $ => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await closeCrew($)
      return { text: 'Crew pane closed.' }
    }
    await openCrew($)
    void tick($).catch(() => {})

    return { text: 'Crew pane opened. Esc, the Close button or /crew closes it.' }
  })

  on('command.run', { command: 'orders' }, async ($, e) => {
    const [arg = '', sub = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (arg === 'help' || arg === '?') return { text: HELP }
    if (arg === 'effort') {
      const isAuto = sub !== 'off'
      await setEffortAuto($, isAuto)
      return {
        text: isAuto
          ? 'Auto effort on: Haiku picks low to xhigh for each prompt you type (Opus and Sonnet 5.5 only; the model never changes).'
          : 'Auto effort off: your own effort setting stands.',
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
      // Submitted once this command has returned: a submit from inside it would
      // wait on the turn the command holds.
      $.clock.after(50, () => void $.prompt.submit({ text: INIT_PROMPT, asUser: true }).catch(() => {}))
      return { text: `Asking Claude to write ${REPO_ORDERS} for this repo.` }
    }
    // Kept working, no longer documented: /crew covers both.
    if (arg === 'clear') {
      await setChecks($, () => [])
      return { text: 'Checks cleared.' }
    }
    if (arg === 'checks') {
      const list = await read($, checks)
      return { text: list.length ? list.map(c => `- ${c}`).join('\n') : 'No checks waiting.' }
    }
    if (arg !== '') return { text: 'Usage: /orders [help | init | auto | draft | on | off | effort auto|off]. Details and controls: /crew' }
    const s = await read($, run)
    const ev = await read($, effort)
    return {
      text: [
        `Standing orders: ${(await read($, isPaused)) ? 'paused' : await read($, mode)}, answered ${s.autoCount} of ${ctx.orders.maxAuto}.`,
        `Effort: ${ev.isAuto ? 'auto' : 'yours'}${ev.level ? `, now ${ev.level}` : ''}${ev.isSaving ? ' (capped: usage past 85%)' : ''}.`,
        ...(s.pending ? [`Needs you: ${s.pending}`] : []),
        'Details and controls: /crew',
      ].join('\n'),
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [s, list, paused, m, ev, v, rows] = await Promise.all([
      read($, run),
      read($, checks),
      read($, isPaused),
      read($, mode),
      read($, effort),
      read($, vitals),
      read($, crew),
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
    const agents = rows.filter(r => r.id !== 'main' && (r.status === 'running' || r.status === 'pending')).length

    const open = agents + list.length
    return (
      <Box flexDirection="column">
        <Box>
          <Button
            key="mode"
            label={label}
            onPress={() => cycle($)}
          />
          {s.autoCount > 0 && <Text dimColor> · answered {s.autoCount}</Text>}
          {effortText !== '' && <Text> · {effortText}</Text>}
          {v.contextPercent !== null && (
            <Text color={v.contextPercent >= 80 ? 'yellow' : undefined} dimColor={v.contextPercent < 80}>
              {' '}· ctx {Math.round(v.contextPercent)}%
            </Text>
          )}
          {left !== null && (
            <Text color={isCold ? 'yellow' : undefined} dimColor={!isCold}>
              {' '}· {isCold ? 'cache cold' : `cache ${clock(left)}`}
            </Text>
          )}
          {!v.hasRepoOrders && <Text dimColor> · no repo orders: /orders init</Text>}
          <Text> · </Text>
          <Button
            key="crew"
            label={open > 0 ? `Crew (${[agents ? `${agents} agents` : '', list.length ? `${list.length} checks` : ''].filter(Boolean).join(', ')})` : 'Crew'}
            onPress={() => openCrew($)}
          />
        </Box>
        {s.pending && <Text color="yellow">Needs you: {s.pending}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [rows, v, s, list, paused, m, ev, entries] = await Promise.all([
      read($, crew), read($, vitals), read($, run), read($, checks),
      read($, isPaused), read($, mode), read($, effort), read($, log),
    ])
    const width = Math.max(30, e.props.bodyColumns ?? 60)
    const left = v.lastResponseAt ? v.cacheTtlMin * 60_000 - (v.now - v.lastResponseAt) : null
    const isLive = (st: string) => st === 'running' || st === 'pending' || st === 'waiting'
    const tree = orderTree(rows)
    const isDone = (t: (typeof tree)[number]) => !isLive(t.row.status) && t.row.id !== 'main' && t.row.status !== 'failed'
    const meter = (name: string, percent: number | null) =>
      percent === null ? null : (
        <Text key={name} color={percent >= 80 ? 'yellow' : undefined}>
          {name} {bar(percent)} {Math.round(percent)}%
        </Text>
      )

    const agent = ({ row: r, depth }: (typeof tree)[number]) => {
      const bad = r.status === 'failed' || r.status === 'killed'
      const pad = '  '.repeat(depth)
      const title = fit(r.name, width - depth * 2 - 28)
      return (
        <Box key={r.id} flexDirection="column">
          <Text color={bad ? 'red' : isLive(r.status) ? 'cyan' : undefined} dimColor={!isLive(r.status) && !bad && r.id !== 'main'}>
            {pad}{statusMark(r.status)}  {title}
            <Text dimColor>{r.model ? ` · ${shortModel(r.model)}` : ''}{isLive(r.status) ? ` · ${clock(v.now - r.startedAt)}` : ''}{r.tools > 0 ? ` · ${r.tools} tools` : ''}</Text>
          </Text>
          {r.lastTool !== '' && isLive(r.status) && (
            <Text dimColor>{pad}   └ {fit(r.lastTool, width - depth * 2 - 6)}</Text>
          )}
        </Box>
      )
    }

    // Lines left after the header, meters and buttons; sections fill them in order.
    let room = Math.max(1, (e.viewport?.rows ?? 24) - 7)
    const take = <T,>(items: T[], perItem = 1, head = 1) => {
      const n = Math.max(0, Math.min(items.length, Math.floor((room - head) / perItem)))
      if (n > 0) room -= head + n * perItem
      return items.slice(0, n)
    }
    const asks = take(s.pending ? [s.pending] : [], 1, 2)
    const todo = take(list.map((c, i) => ({ c, i })), 1, asks.length ? 0 : 2)
    const live = take(tree.filter(t => !isDone(t)), 2)
    const recent = take([...entries].reverse().slice(0, 8))
    const done = take(tree.filter(isDone), 1)
    const heading = (t: string, color?: string) => <Text bold color={color}>{t}</Text>

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold color={paused ? 'yellow' : 'cyan'}>
              {paused ? '⏸ Paused' : m === 'auto' ? '▶ Auto' : '✎ Draft'}
              <Text dimColor> · answered {s.autoCount} of {ctx.orders.maxAuto}</Text>
            </Text>
            <Button key="close" role="dismiss" label="✕ Close" onPress={() => closeCrew($)} />
          </Box>
          <Text dimColor>
            effort {ev.isAuto ? 'auto' : 'yours'}{ev.level ? ` · ${ev.level}` : ''}{ev.why && ev.isAuto && ev.why !== 'auto' ? ` (${ev.why})` : ''}
          </Text>
        </Box>

        <Box flexDirection="column">
          {meter('context', v.contextPercent)}
          {meter('limit  ', v.ratePercent)}
          {left !== null && <Text color={left <= 0 ? 'yellow' : undefined} dimColor={left > 0}>{left <= 0 ? 'cache cold: a reply now rewrites it' : `cache   ${clock(left)} left`}</Text>}
        </Box>

        <Box>
          <Button key="pause" label={paused ? '▶ Resume' : '⏸ Pause'} onPress={() => setPaused($, !paused)} />
          <Text>  </Text>
          <Button key="mode" label={m === 'auto' ? 'Switch to draft' : 'Switch to auto'} onPress={() => setMode($, m === 'auto' ? 'draft' : 'auto')} />
          <Text>  </Text>
          <Button key="effort" label={ev.isAuto ? 'Effort: take over' : 'Effort: auto'} onPress={() => setEffortAuto($, !ev.isAuto)} />
        </Box>

        {asks.length + todo.length > 0 ? (
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              {heading(`Needs you · ${asks.length + list.length}`, 'yellow')}
              {list.length > 1 && <Button key="clear" label="Clear all" onPress={() => setChecks($, () => [])} />}
            </Box>
            {asks.map(q => <Text key="ask" color="yellow">? {fit(q, width - 2)}</Text>)}
            {todo.map(({ c, i }) => (
              <Box key={`check${i}`}>
                <Button key={`tick${i}`} label="✓ Done" onPress={() => setChecks($, old => old.filter(x => x !== c))} />
                <Box marginLeft={1} flexShrink={1}>
                  <Text>{c}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        ) : (
          <Text dimColor>✓ Nothing needs you.</Text>
        )}

        <Box flexDirection="column">
          {heading(`Agents · ${rows.length - 1}`)}
          {live.length > 0 ? live.map(agent) : <Text dimColor>No agents yet.</Text>}
        </Box>

        <Box flexDirection="column">
          {heading('What the orders did')}
          {recent.length > 0
            ? recent.map((l, i) => (
                <Box key={i}>
                  <Text dimColor>{logHead(l, v.now)} </Text>
                  <Box flexShrink={1}>
                    <Text dimColor={l.kind !== 'asked'}>{logBody(l)}</Text>
                  </Box>
                </Box>
              ))
            : <Text dimColor>Nothing yet. They step in when Claude ends on a question.</Text>}
        </Box>

        {done.length > 0 && (
          <Box flexDirection="column">
            {heading('Finished')}
            {done.map(agent)}
          </Box>
        )}
      </Box>
    )
  })
}
