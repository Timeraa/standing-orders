// Picks: the one home of the mod's three choices: the effort of a turn, the model of a
// new chat, the model and effort of a subagent. Each is asked of Haiku, parsed,
// raced against one deadline, bounded by the orders and then recorded (Activity
// note, session tally, toast), all of it here and nowhere else. It also holds what
// those choices remember between hooks: the pending judge jobs, this turn's effort,
// the chat's pinned model and each subagent's effort.
// No `$` in this file: the engine is a parameter (the Host), like the file store in orders.ts.
import type { EffortView, LogEntry } from '../types'
import {
  EFFORT_JUDGE,
  MODEL_JUDGE,
  SUBAGENT_JUDGE,
  cap,
  capEffort,
  clampEffort,
  isFollowUp,
  parseEffort,
  parseModel,
  parseSubagent,
  pickText,
  subagentModels,
  takesEffort,
  type Effort,
  type ModelName,
} from './judges'
import type { Orders } from './orders'

// ---- the seam -----------------------------------------------------------

/** One question to the judge model: what `$.model.complete` takes. */
export type Ask = { model: 'haiku'; system: string; prompt: string; maxTokens: number; timeoutMs: number }
/** What `$.model.complete` answers; `text` only when `isAnswered`. */
export type Answer = { isAnswered: boolean; text?: string }

/**
 * Everything this module needs from the engine and from the mod's atoms, as plain
 * functions (the engine rejects `$.x` used as a value, so register.tsx wraps each call).
 */
export type Host = {
  /** `$.model.complete`: the one seam to the judge model. */
  complete(req: Ask): Promise<Answer>
  /** `$.clock.sleep`: the deadline's timer. */
  sleep(ms: number): Promise<unknown>
  /** The effort atom: read it, and merge a patch into it (returns the new view). */
  view(): Promise<EffortView>
  show(patch: Partial<EffortView>): Promise<EffortView>
  /** How full the context is (percent), null before it is known. */
  contextPercent(): Promise<number | null>
  /** The Activity feed. Must not throw. */
  note(kind: LogEntry['kind'], text: string): Promise<void>
  /** The session tally; `key` is the level or model (ignored for `subagents`). */
  tally(kind: 'effort' | 'models' | 'subagents', key?: string): Promise<unknown>
  toast(text: string): unknown
}

// ---- the deadline -------------------------------------------------------

/** How long any pick waits for its judge before moving on without it. */
export const DEADLINE_MS = 3000

// A judge that is not back by the deadline is dropped, and so is its late answer (the
// race is over); a judge that fails counts as slow. The one deadline for every pick.
const within = <T>(host: Host, job: Promise<T | null>): Promise<T | null> =>
  Promise.race([job, host.sleep(DEADLINE_MS).then(() => null)]).catch(() => null)

// The recipe's first half: ask Haiku, parse its text (null when it did not answer or the answer is unusable).
async function ask<T>(host: Host, req: Omit<Ask, 'model'>, parse: (text: string) => T | null): Promise<T | null> {
  const r = await host.complete({ model: 'haiku', ...req })
  return r.isAnswered ? parse(r.text ?? '') : null
}

// ---- the bounds ---------------------------------------------------------

/** The usage-limit cap: while the limit is nearly used up, a pick may not go above this. */
export const SAVING_CEILING: Effort = 'medium'

export type Bounds = {
  /** The floor and the ceiling from the orders (effort-min, effort-max). */
  min: Effort
  max: Effort
  /** Whether the usage-limit cap applies: the ceiling drops to SAVING_CEILING (a floor above it still wins). */
  saving: boolean
}

/** The one bounds policy: a picked level, held between the floor and the (possibly capped) ceiling. */
export const boundEffort = (level: Effort, { min, max, saving }: Bounds): Effort =>
  clampEffort(level, min, saving ? capEffort(max, SAVING_CEILING) : max)

// ---- the record ---------------------------------------------------------

const shortModel = (m: string) => /(haiku|sonnet|opus|fable)/i.exec(m)?.[1]?.toLowerCase() ?? (m || '?')

// What a pick leaves behind: the Activity feed, the session tally and the toasts. Written here and nowhere else.
const record = {
  /** A judged level reached the turn (a kept go-ahead and a fixed level add no note). */
  effortJudged: (host: Host, level: Effort, why: string) => host.note('effort', pickText(level, why)),
  /** A prompt's first request ran at an applied level (judged, kept or fixed). */
  effortApplied: (host: Host, level: Effort) => void host.tally('effort', level),
  /** The person moved the session's effort under auto. */
  effortTakenOver: (host: Host) =>
    host.toast('You changed effort yourself: auto effort is off. /orders effort auto turns it back on.'),
  chatModel: async (host: Host, model: ModelName, why: string) => {
    void host.tally('models', model)
    await host.note('model', pickText(model, why))
    host.toast(`Auto model: this chat runs on ${cap(model)} (${why}). /model changes it; /orders model off stops this.`)
  },
  subagent: async (host: Host, model: string, level: Effort, why: string) => {
    await host.tally('subagents')
    void host.tally('models', model)
    await host.note('subagent', pickText(`${model}/${level}`, why))
  },
}

// ---- the module ---------------------------------------------------------

/**
 * The picks, held as one: `orders()` is what the mod obeys right now. Hooks call these;
 * a hook handler is a few lines around one of them.
 */
export function createPicks(orders: () => Orders) {
  // effort: the judge's job for the prompt just typed, and the level it settled on for this turn
  let effortJob: Promise<{ effort: Effort; why: string } | null> | null = null
  let turnEffort: Effort | null = null
  // The session's own level as last seen, and the one we last set: a request that matches neither was changed by the person.
  let lastBase: unknown
  let lastApplied: unknown
  // The effort judge's context: how the agent's last message ended.
  let lastAnswerTail = ''
  // model: chosen once, for a chat with no history
  let isModelChecked = false
  let modelJob: Promise<{ model: ModelName; why: string } | null> | null = null
  let chatModel: { base: string; id: string } | null = null
  // subagents: the effort picked at spawn, by agent id
  const agentEffort = new Map<string, Effort>()

  // ---- effort ----

  // The judge of the prompt just typed.
  // QUIRK (b): its own `timeoutMs` is 8 seconds, but `pickEffort` waits only DEADLINE_MS (3 seconds):
  // the race is over by then and a late answer is dropped. The other two judges ask for 3 seconds.
  const askEffort = (host: Host, text: string) =>
    ask(
      host,
      {
        system: EFFORT_JUDGE,
        prompt: `END OF THE AGENT'S PREVIOUS MESSAGE:\n${lastAnswerTail || '(none: first message)'}\n\nTHE USER'S MESSAGE:\n${text.slice(0, 3000)}`,
        maxTokens: 80,
        timeoutMs: 8000,
      },
      parseEffort,
    )

  // Waits briefly for the prompt's judge and settles this turn's level.
  async function pickEffort(host: Host) {
    const job = effortJob
    if (!job) return
    effortJob = null
    const picked = await within(host, job)
    const saving = (await host.view()).isSaving
    if (!picked) {
      await host.show({ why: 'too slow: left as is', isJudging: false })
      return
    }
    const { effortMin, effortMax } = orders()
    // QUIRK (a): the saving cap applies to a judged turn level only. A fixed level and a
    // subagent's level skip it (see `levelFor` and `spawn`); to change that, change those call sites.
    const level = boundEffort(picked.effort, { min: effortMin, max: effortMax, saving })
    turnEffort = level
    await host.show({ why: picked.why, isJudging: false })
    await record.effortJudged(host, level, picked.why)
  }

  // The level this request runs at: the fixed one, else the turn's pick; null leaves the session's own.
  const levelFor = (model: string, isAuto: boolean): Effort | null =>
    // QUIRK (a): a fixed `effort: <level>` is applied as written, with no floor, ceiling or saving cap.
    isAuto && takesEffort(model) ? (orders().effortFixed ?? turnEffort) : null

  // ---- model: a new chat only ----

  // Waits briefly for the first prompt's pick, then pins the chat to it.
  async function pickModel(host: Host, base: string) {
    const job = modelJob
    if (!job) return
    modelJob = null
    const picked = await within(host, job)
    if (!picked || shortModel(base) === picked.model) return
    // An alias: the engine resolves it to the family's newest model.
    chatModel = { base, id: picked.model }
    await record.chatModel(host, picked.model, picked.why)
  }

  return {
    /**
     * Who runs effort. The person (or `effort: off`) sets it off, `/orders effort auto` or a
     * level sets it on. Off, no level is applied until it is on and judged again.
     * isAuto changes in three places only: here, `followOrders` and a request the person changed.
     */
    async setAuto(host: Host, isAuto: boolean) {
      await host.show({ isAuto, why: isAuto ? 'auto' : 'yours' })
      if (!isAuto) turnEffort = null
    },

    /** The orders were (re)loaded: if they turn effort off, auto is off. (This one leaves this turn's level standing.) */
    async followOrders(host: Host) {
      if (!orders().isEffortAuto) await host.show({ isAuto: false })
    },

    /** The agent's message ended: its tail is the next effort judge's context. */
    afterTurn(answer: string) {
      lastAnswerTail = answer.slice(-800)
    },

    /**
     * The chat's first typed prompt (once): if the orders say so, and there is no history and
     * no /model typed, Haiku starts picking the chat's model. Called for every prompt typed
     * before a turn; only the first does anything.
     */
    async firstPrompt(host: Host, p: { text: string; isCommand: boolean }) {
      if (isModelChecked) return
      isModelChecked = true
      const pct = await host.contextPercent()
      const { isModelAuto, models } = orders()
      if (isModelAuto && !p.isCommand && (pct === null || pct < 5) && !isFollowUp(p.text)) {
        modelJob = ask(
          host,
          {
            system: MODEL_JUDGE,
            prompt: `ALLOWED MODELS: ${models.join(', ')}\n\nTHE USER'S FIRST MESSAGE:\n${p.text.slice(0, 3000)}`,
            maxTokens: 80,
            timeoutMs: 3000,
          },
          text => parseModel(text, models),
        )
      }
    },

    /**
     * A prompt the person typed to start a turn. Auto effort starts the judge (a go-ahead
     * keeps the last level, a fixed level needs no judge); the pick is awaited at `request`.
     */
    async typed(host: Host, p: { text: string; isDraftSent: boolean }) {
      const view = await host.view()
      const { effortFixed } = orders()
      if (view.isAuto && !effortFixed && !p.isDraftSent && !isFollowUp(p.text)) {
        effortJob = askEffort(host, p.text)
        await host.show({ isJudging: true })
      } else if (view.isAuto && effortFixed) {
        await host.show({ why: 'fixed in your orders' })
      } else if (view.isAuto) {
        await host.show({ why: 'kept for a follow-up' })
      }
    },

    /**
     * The main loop's request: settles the chat's model and this turn's effort and says what to
     * change in the request (spread it over the event). On a turn's first request it waits (up
     * to the deadline) for the judges started by the prompt.
     */
    async request(host: Host, req: { index: number; model: string; effort?: unknown }): Promise<{ effort?: Effort; model?: string }> {
      // The chat's pick from its first prompt: every main request goes there until the person runs /model.
      if (req.index === 0) await pickModel(host, req.model)
      if (chatModel && req.model !== chatModel.base) chatModel = null
      const model = chatModel?.id ?? req.model

      let view = await host.view()
      if (req.index === 0) {
        // The session's own level moved under us: the person changed it.
        const moved = lastBase !== undefined && req.effort !== lastBase && req.effort !== lastApplied
        lastBase = req.effort
        if (moved && view.isAuto) {
          turnEffort = null
          effortJob = null
          view = await host.show({ isAuto: false, isJudging: false, why: 'yours' })
          record.effortTakenOver(host)
        }
        if (view.isAuto && !orders().effortFixed && takesEffort(model)) await pickEffort(host)
      }

      const level = levelFor(model, view.isAuto)
      if (level) lastApplied = level
      if (level && req.index === 0) record.effortApplied(host, level)
      await host.show({ model: shortModel(model), level: level ?? (req.effort === undefined ? null : String(req.effort)) })

      return { ...(level ? { effort: level } : {}), ...(chatModel ? { model } : {}) }
    },

    /** A subagent's request: the effort picked at its spawn, or undefined to leave the request alone. */
    subagentRequest(agentId: string, model: string, effort: unknown): Effort | undefined {
      const picked = agentEffort.get(agentId)
      return picked && typeof effort === 'string' && takesEffort(model) ? picked : undefined
    },

    /**
     * A subagent about to start. Haiku picks its model and effort from the task; `run(model)`
     * starts it (with `model` when the pick fills a gap, undefined when the caller named one or
     * there is no pick) and its result gives the agent's id. `eligible` is false for forks,
     * teammates and workflows, which are left alone.
     */
    async spawn<R>(
      host: Host,
      a: { eligible: boolean; prompt: string; subagentType: string; named?: string | undefined },
      run: (model?: ModelName) => Promise<R>,
    ): Promise<R> {
      if (!orders().isSubagentsAuto || !a.eligible) return run()
      const allowed = subagentModels(orders().models)
      const pick = await within(
        host,
        ask(
          host,
          {
            system: SUBAGENT_JUDGE,
            prompt: `ALLOWED MODELS: ${allowed.join(', ')}\n\nSUBAGENT TYPE: ${a.subagentType}\nTASK:\n${String(a.prompt).slice(0, 2000)}`,
            maxTokens: 80,
            timeoutMs: 3000,
          },
          text => parseSubagent(text, allowed),
        ),
      )
      if (!pick) return run()
      // A model the Agent call already named wins; only the gap is filled.
      const result = await run(a.named ? undefined : pick.model)
      const got = result as { agentId?: string; model?: string }
      if (got.agentId) {
        const { effortMin, effortMax } = orders()
        // QUIRK (a): `saving: false` on purpose, a subagent's level ignores the usage-limit cap.
        const level = boundEffort(pick.effort, { min: effortMin, max: effortMax, saving: false })
        agentEffort.set(got.agentId, level)
        await record.subagent(host, shortModel(String(got.model ?? pick.model)), level, pick.why)
      }
      return result
    },

    /** Forgets the effort of every subagent the engine lists as finished. */
    prune(agents: readonly { id: string; status: string }[]) {
      const listed = new Map(agents.map(a => [a.id, a.status]))
      for (const id of agentEffort.keys()) {
        const st = listed.get(id)
        if (st && !['pending', 'running', 'waiting'].includes(st)) agentEffort.delete(id)
      }
    },
  }
}

export type Picks = ReturnType<typeof createPicks>
