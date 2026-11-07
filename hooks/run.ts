// Run: the autopilot run (the `run` atom's value) and the end-of-turn decision. A run starts when
// the person types, grows by one for each answer the orders give, and waits on a decision when
// the orders hand a question back. Every change to it is a named transition here, and the order
// in which the judge's guards are held against a turn is written down once, in `decide`.
// No `$` in this file: the atom, the clock and the prompt box stay in register.tsx, which
// reads what these functions need, calls them and applies what they return.
import type { Run } from '../types'
import type { Verdict } from './judges'

/** No run yet: also what a typed prompt resets to. */
export const IDLE: Run = { autoCount: 0, startedAt: 0, pending: null, last: null }

// ---- transitions --------------------------------------------------------

/**
 * The person submitted `text` from the composer at `now`. If it is the answer the orders
 * drafted, the run goes on (one more standing answer, nothing pending); anything else
 * is the person speaking, and starts a new run.
 *
 * QUIRK: "Enter sent the draft" is a guess by text: the submitted text, trimmed, equals the
 * `last` answer, which is also set by an auto-sent reply. So a person who types the very same
 * words as the last answer is taken for sending the draft, and a draft edited by even one
 * character starts a new run. This is the only place that compares them.
 */
export function whenTyped(run: Run, at: { text: string; now: number }): { run: Run; isDraftSent: boolean } {
  const isDraftSent = run.last === at.text.trim()
  return {
    isDraftSent,
    run: isDraftSent ? { ...run, autoCount: run.autoCount + 1, pending: null } : { ...IDLE, startedAt: at.now },
  }
}

/** The orders handed a decision back to the person. */
export const waiting = (run: Run, decision: string): Run => ({ ...run, pending: decision })

/** The orders sent `reply` themselves (auto mode): one more standing answer. */
export const sent = (run: Run, reply: string): Run => ({ ...run, autoCount: run.autoCount + 1, last: reply, pending: null })

/** The orders drafted `reply` into the prompt box (draft mode). It only counts once the person sends it (see `whenTyped`). */
export const drafted = (run: Run, reply: string): Run => ({ ...run, last: reply, pending: null })

// ---- the end-of-turn decision --------------------------------------------

/** Why the judge is not even asked. */
export type Skip = 'paused' | 'person-spoke'

/**
 * Guards 1 and 2, before the judge model is asked at all (it costs a call):
 *   1. paused: the person turned the orders off.
 *   2. the person typed since this turn started (`composerAt` is when they last did).
 * Returns why to skip, or null to go on and ask the judge.
 */
export function beforeJudging(f: { isPaused: boolean; composerAt: number; turnStartedAt: number }): Skip | null {
  if (f.isPaused) return 'paused'
  if (f.composerAt > f.turnStartedAt) return 'person-spoke'
  return null
}

/** What the judge's verdict comes to. `text` is what the person is told, `reply` what goes in the box. */
export type Decision =
  | { do: 'skip'; why: 'took-over' | 'typing' }
  | { do: 'stop' }
  | { do: 'ask'; why: 'judge' | 'rail' | 'cap'; text: string }
  | { do: 'send'; reply: string }
  | { do: 'draft'; reply: string }

export type Flags = {
  /** What the judge said (already parsed; a turn without a verdict never gets here). */
  verdict: Pick<Verdict, 'action' | 'reply' | 'decision'>
  /** When the person last typed, and when this judging began (clock readings, ms). */
  composerAt: number
  judgedAt: number
  /** The always-ask rail's match against the reply and the agent's question (see `asked` in judges.ts), or null. */
  railed: string | null
  /** Auto mode (otherwise draft), this run's standing answers so far, and the orders' ceiling on them. */
  isAuto: boolean
  autoCount: number
  maxAuto: number
}

export const AUTO_REPLY = 'Per my standing orders: keep going.'

/**
 * The guards after the verdict, in the order they are held (the first that holds wins):
 *   3. the person typed while the judge was thinking: they took over, drop the verdict.
 *   4. the judge said stop, or ask (the person is told, nothing is sent).
 *   5. the always-ask rail matches: ask, whatever the judge said.
 *   6. auto mode and `maxAuto` standing answers used: ask for a check-in.
 *   7. there is already text in the prompt box: the person is typing a reply, leave it.
 *   Then the reply goes out (auto) or into the box (draft).
 * `isTyping` is asked only when no earlier guard held (it reads the prompt box), and only on this last step.
 * (Guards 1 and 2 are `beforeJudging`.)
 *
 * QUIRK: a stop or ask verdict is not held against the rail, the cap or the typing check: the
 * person is told even if they are typing. QUIRK: draft mode never hits the cap (only auto
 * sends are counted against it); the rail still applies to drafts.
 */
export async function decide(f: Flags, isTyping: () => Promise<boolean>): Promise<Decision> {
  const v = f.verdict
  if (f.composerAt > f.judgedAt) return { do: 'skip', why: 'took-over' }
  if (v.action === 'stop') return { do: 'stop' }
  if (v.action === 'ask') return { do: 'ask', why: 'judge', text: v.decision || 'Claude is waiting on you.' }
  if (f.railed) return { do: 'ask', why: 'rail', text: v.decision || `Claude asks about "${f.railed}": your call.` }
  if (f.isAuto && f.autoCount >= f.maxAuto) {
    return { do: 'ask', why: 'cap', text: `${f.autoCount} standing answers this run. Check in.` }
  }
  if (await isTyping()) return { do: 'skip', why: 'typing' }
  const reply = v.reply || AUTO_REPLY
  return f.isAuto ? { do: 'send', reply } : { do: 'draft', reply }
}
