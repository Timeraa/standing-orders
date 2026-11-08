// Pure parts of standing-orders: the judges' prompts, their answers' parsers and
// the helpers around them. The orders files themselves live in orders.ts. No `$`
// here, so the tests can hold these directly.

export const REPO_ORDERS = '.claude/standing-orders.md'

export const INIT_PROMPT = `Write \`${REPO_ORDERS}\` for this repository: the repo-specific standing orders the standing-orders mod adds to my global ones (~/.claude/standing-orders.md, which you already have; don't repeat it).

Read what the repo says about itself first: CLAUDE.md / AGENTS.md (including nested ones), the README, package scripts, Makefile or task files, and CI config. Then write, under 40 lines, only what holds for this repo:
- How to verify work here: the exact test, build, lint and type-check commands, which are fast enough to run after every change and which only before a commit.
- How to see a UI or visual change, if the repo has a UI.
- Commit, branch and PR conventions it documents.
- What to always ask first here: deploys, releases, migrations, publishing, destructive or costly scripts. Put those words on one line \`always-ask: word, word\` (it adds to the global list).
- Only add \`effort: off\` or \`cache-ttl: N\` lines if the repo gives a reason.

If the file exists, update it rather than starting over. Show me the result. Don't commit it.`

export const PREAMBLE = `## The user's standing orders
The user's own instructions for how to work. When they cover the next step,
take it instead of ending the turn with a question. When something remains that
only the user can check (real devices, accounts, other people), list it last
under a line "Checks for you:", one per line.

`

// Ends that stop for the person: a question, an offer, or a leftovers list.
export const STOPS =
  /(\?\s*$|want me to|should i\b|shall i\b|say (so|the word|if)|tell me (if|whether|which)|which (one|of these)|do you want|or stop here|nothing is committed|not committed|haven.?t (run|tested|checked|committed|pushed|profiled)|didn.?t (run|test|check|commit)|still (open|untested|unchecked)|untested|follow.?ups?)/i

// A short go-ahead keeps the effort already picked; no judge is asked.
const FOLLOW_UP =
  /^\W*(yes|yeah|yep|ok(ay)?|sure|go( ahead)?|do (it|them|all|that|both|so)|make it happen|proceed|continue|just start|you decide|sounds good|all of them|both|commit( and push)?( it)?|push( it)?|pr it|ship it|thanks?|thank you|nice|great|perfect|[a-d]|q\d+:?\s*[a-d])\W*$/i
export const isFollowUp = (text: string) => text.trim().length <= 60 && FOLLOW_UP.test(text.trim())

export const JUDGE = `You decide whether an AI coding agent's end-of-turn question is already answered by its user's standing orders.
You get the orders and the end of the agent's last message.
Reply with JSON only, no prose:
{"action":"continue"|"ask"|"stop","reply":"...","decision":"...","checks":["..."],"resolved":["..."]}

- "continue": the message ends with a question, offer or list of leftovers that the
  orders already answer. "reply" is the answer to give, short and concrete, naming the
  order that covers it ("Per my standing orders: yes, do 1-3, then commit.").
- "ask": it needs the user's own judgment: a choice the orders don't cover, a taste or
  product call, anything the orders say to always ask about, or you are unsure.
  "decision" is that question in one line.
- "stop": the work is finished and nothing is left the agent could do itself.
  "decision" is a one-line summary of what was done.
- "checks": things a person must physically do or decide outside the chat that the
  message leaves open: real devices, accounts or credentials, other people, store or
  console clicks. Never something the agent could run, read or look up itself, and never
  a merge, deploy, CI or test result the agent can check. One short line each, at most 5.
  [] if none.
- "resolved": items of OPEN CHECKS, copied exactly, that the message clearly shows are
  done or no longer needed. [] when unsure.
When in doubt, "ask".`

export const EFFORT_JUDGE = `You pick how hard an AI coding agent should think about the user's next message.
You get the end of the agent's previous message (for context) and the user's message.
Reply with JSON only: {"effort":"low"|"medium"|"high"|"xhigh","why":"at most 6 words"}

- low: a quick question, a lookup, a command to run, a tiny or mechanical edit,
  a status check, a short go-ahead to a plan that is already clear.
- medium: an ordinary change with a clear cause and scope, a routine commit or PR,
  explaining a piece of code.
- high: a multi-file feature, debugging a bug whose cause is unclear, performance work,
  design or architecture questions, reviews, a broad "fix everything" request.
- xhigh: hard open-ended work: deep performance or architecture rework, subtle
  concurrency, numerical or state bugs, large refactors, or a problem the user reports
  is still broken after earlier attempts.
Pick the lowest level that will get it right.`

export type Verdict = {
  action: 'continue' | 'ask' | 'stop'
  reply?: string
  decision?: string
  checks?: string[]
  resolved?: string[]
}

export type ModelName = 'haiku' | 'sonnet' | 'opus' | 'fable'
export const MODEL_NAMES: readonly ModelName[] = ['haiku', 'sonnet', 'opus', 'fable']

export const MODEL_JUDGE = `You pick which model an AI coding agent should start a NEW chat on, from the user's first message.
Reply with JSON only: {"model":"<one of the allowed models>","why":"at most 6 words"}
- The cheapest allowed model for a quick question, lookup, small or mechanical edit, or routine task.
- A middle model for ordinary features and fixes with clear scope.
- The strongest allowed model for hard debugging, architecture, large refactors, deep research, or ambiguous open-ended work.
When unsure, pick the stronger one.`

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function parseModel(text: string, allowed: readonly ModelName[]): { model: ModelName; why: string } | null {
  const v = json(text)
  const model = String(v?.model ?? '').toLowerCase() as ModelName
  return allowed.includes(model) ? { model, why: String(v?.why ?? '').slice(0, 60) } : null
}

const json = (text: string) => {
  const raw = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!raw) return null
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

export function parseVerdict(text: string): Verdict | null {
  const v = json(text) as Verdict | null
  return v && ['continue', 'ask', 'stop'].includes(v.action) ? v : null
}

export function parseEffort(text: string): { effort: Effort; why: string } | null {
  const v = json(text)
  const effort = String(v?.effort ?? '').toLowerCase() as Effort
  return EFFORTS.includes(effort) ? { effort, why: String(v?.why ?? '').slice(0, 60) } : null
}

// What the always-ask rail is held against besides the reply: every asking
// sentence of the tail, and its last paragraph whole, since an offer often has
// no question mark ("Say the word and I'll release this as build 26.").
// ponytail: errs toward asking; a stray "deploy" in that paragraph asks too.
export function asked(tail: string) {
  const paragraphs = tail.trim().split(/\n\s*\n/)
  const last = (paragraphs[paragraphs.length - 1] ?? '').slice(-600)
  return `${(tail.match(/[^.?!\n]*\?/g) ?? []).join(' ')} ${last}`
}

// Effort per message rewrites most of the prompt cache on other models, so the
// mod only sets it on the models where it does not.
// Opus and Sonnet from 5.5 on; a bare alias is the family's newest.
// ponytail: assumes later Opus/Sonnet keep per-message effort; a family that
// drops it costs a cache rewrite on each effort change until it is listed here.
export function takesEffort(model: string) {
  if (/^(opus|sonnet)(\[1m\])?$/i.test(model)) return true
  const m = /(opus|sonnet)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(model)
  return !!m && Number(m[2]) * 100 + Number(m[3] ?? 0) >= 505
}

export const clampEffort = (e: Effort, min: Effort, max: Effort) => {
  const i = EFFORTS.indexOf(e)
  const lo = EFFORTS.indexOf(min)
  const hi = Math.max(lo, EFFORTS.indexOf(max))
  return EFFORTS[Math.min(hi, Math.max(lo, i))] ?? e
}

// The models a subagent may use: the chat's allowlist plus Haiku for mechanical work.
export const subagentModels = (models: readonly ModelName[]): ModelName[] => [...new Set<ModelName>(['haiku', ...models])]

export const SUBAGENT_JUDGE = `You pick the model and thinking effort for a helper subagent of an AI coding agent, from the task it was given.
Reply with JSON only: {"model":"<one allowed model>","effort":"low"|"medium"|"high"|"xhigh","why":"at most 6 words"}
- haiku (if allowed) and low: searching, listing, reading files, grepping, mechanical edits, summaries.
- a middle model and medium: focused implementation or a bounded investigation.
- the strongest allowed model and high or xhigh: review, architecture, hard debugging, anything where a wrong answer is costly.
When unsure, pick the stronger one.`

export function parseSubagent(text: string, models: readonly ModelName[]): { model: ModelName; effort: Effort; why: string } | null {
  const v = json(text)
  const model = String(v?.model ?? '').toLowerCase() as ModelName
  const effort = String(v?.effort ?? '').toLowerCase() as Effort
  return models.includes(model) && EFFORTS.includes(effort)
    ? { model, effort, why: String(v?.why ?? '').slice(0, 60) }
    : null
}

export const capEffort = (e: Effort, cap: Effort) =>
  EFFORTS.indexOf(e) > EFFORTS.indexOf(cap) ? cap : e

export function agoText(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`
}

const MARK = { answered: '✓', drafted: '✎', asked: '?', stopped: '■', effort: '◆', model: '◇', subagent: '◇' }
// Decisions read "sent: ..."; picks read "effort high · why".
const VERB = {
  answered: 'sent: ', drafted: 'drafted: ', asked: 'asked you: ', stopped: 'finished: ',
  effort: 'effort ', model: 'new chat → ', subagent: 'subagent → ',
}
export const isPick = (kind: keyof typeof MARK) => kind === 'effort' || kind === 'model' || kind === 'subagent'
export const pickText = (what: string, why: string) => (why.trim() ? `${what} · ${why.trim()}` : what)
export const logHead = (e: { at: number; kind: keyof typeof MARK }, now: number) =>
  `${MARK[e.kind]} ${agoText(now - e.at).padStart(3)}`
export const logBody = (e: { kind: keyof typeof MARK; text: string }) =>
  `${VERB[e.kind]}${e.text.replace(/\s+/g, ' ').slice(0, 240)}`
export const logLine = (e: { at: number; kind: keyof typeof MARK; text: string }, now: number) =>
  `${logHead(e, now)}  ${logBody(e)}`

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const fit = (text: string, n: number) =>
  n > 1 && text.length > n ? `${text.slice(0, n - 1)}…` : text

export function clock(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60000))
  const s = Math.max(0, Math.floor((ms % 60000) / 1000))
  return `${m}:${String(s).padStart(2, '0')}`
}

// The short "What is this?": the top of the Now tab while it is empty, and of /orders help.
export const INTRO = [
  'When Claude finishes a turn and asks you something, the autopilot checks your standing orders.',
  'If they cover it, it drafts the answer in your prompt box (Draft) or sends it (Auto). If not, or if it touches a word you always ask about (deploy, delete, ...), it asks you instead.',
  'Your rules live in ~/.claude/standing-orders.md; the Settings tab edits them.',
] as const

// What /orders help shows: the whole mod in plain words.
export const HELP = `Standing orders: what it does and when to use what

What is this?
${INTRO.join('\n')}

When Claude ends a turn on a question ("Want me to commit?"), Haiku checks your
orders file and picks one of three:
- continue: your orders already answer it. The answer is drafted for you.
- ask: it is your call (taste, product, or an always-ask word such as deploy or
  delete). Nothing is answered; "Needs you: ..." shows above the prompt.
- stop: the work is done. You get a notification.

Draft or auto (only matters for "continue"):
- draft (default): the answer is typed into your prompt box, not sent. Enter
  sends it; edit or clear it to answer yourself. You still approve every step.
  It is the default because Haiku can misread a question; a wrong draft costs
  you one look, a wrong sent answer costs work.
- auto: the answer is sent for you, up to max-auto in a row, and never past an
  always-ask word. For long jobs while you are away.
Typing anything yourself always wins: a turn you typed in is never answered.

When to use what:
- At the keyboard ............ leave it on draft
- Walking away from a long job  /orders auto, then /orders draft when back
- Exploring, want every question /orders off (or Pause), /orders on later
- First time in a repo ........ /orders init (Claude writes the repo's orders)
- What is it doing? ........... /autopilot, Now tab (what needs you, what the
                                 orders did and picked, context and limits)
- Things only you can check ... /autopilot: click one to tick it off (the newest
                                 show first, "+N older" opens the rest; each
                                 drops by itself after 3 days)
- Is it saving money? ......... /autopilot, Savings tab (or /orders savings): tokens
                                 and API-equivalent dollars saved and spent, with a
                                 verdict ("Proven" needs the audit: turn it
                                 on in that tab to measure the effort effect)
- Change a setting ............ /autopilot, Settings tab: every click saves to
                                 your orders file. /orders setup opens it
- Buttons for all of this ..... /autopilot (Esc or Close shuts it; /crew is its
                                 old name); the line above the prompt: click the
                                 mode to cycle, Autopilot opens the pane

The line above the prompt (click the mode to cycle it; Autopilot opens the pane):
  Replies: draft | auto | paused  the mode
  answered N                      answers given since your last typed prompt
  effort Low/Medium/High/Xhigh    how hard Claude thinks about this prompt;
                                  (yours) if you set it, "capped" when your
                                  usage limit is nearly used
  context N%                      context used (yellow from 70%, red from 90%)
  prompt cache m:ss / cold        time left on the prompt cache; replying
                                  before it runs out is cheaper
  usage limit N%                  your plan's usage limit used (off by default)
  no repo orders                  this repo has no orders file yet
  (a narrow line says ctx, cache, limit for the same three)
  Which of these show is yours to choose: /autopilot, Settings, Status line
  (the band: line of your orders file).

Model: with model: auto, a brand-new chat (no history yet) lets Haiku pick the
model from your first message, among the models: line (default sonnet, opus).
It happens once per chat, never mid-chat, so the cache is never rewritten. If you
switch /model yourself, it stays out of the way. /orders model auto|off.

Effort: "effort: auto" lets Haiku pick low..xhigh for each prompt you type
(Opus and Sonnet 5.5 or newer; mid-chat the model never changes, so the cache
survives). "effort: high" (any level, even max) fixes it with no judge.
effort-min / effort-max bound auto. A short go-ahead keeps the last level.
Setting /effort yourself turns it off; /orders effort auto turns it back on.

Subagents: with "subagents: auto", each helper subagent gets a model (Haiku
allowed) and effort picked from its task. A model or effort you or Claude named
for it always wins.

Files:
- ~/.claude/standing-orders.md: your rules for every repo, plus the settings
  always-ask, max-auto, effort, effort-min, effort-max, subagents, model, models,
  cache-ttl, motion, band. /orders setup (or /autopilot, Settings) changes them. Claude sees
  edits in the next chat.
- .claude/standing-orders.md: this repo's additions, from /orders init. Its
  always-ask words add to yours and it can lower max-auto, set effort: off or
  cache-ttl. Your other settings are never overridden by a repo.`
