// Pure parts of standing-orders: the default orders, the judges' prompts and
// the parsers. No `$` here, so the tests can hold these directly.

export const DEFAULT_ORDERS = `# Standing orders

Claude reads these in every new chat. When a turn ends on a question they
already answer, the standing-orders mod drafts that answer in your prompt box
(or, after /orders auto, sends it). Edit freely. In a repo, /orders init has
Claude write that repo's own .claude/standing-orders.md.

## Keep going
- Leftovers you can do yourself (untested, unchecked, not run, "still open",
  follow-ups, partially done): do them instead of listing them.
- You offered options: take the one you recommend. If they are small and
  independent, do them all.
- After a plan or spec the user agreed to: start on it.
- Before asking the user to check something, run every check you can run
  yourself: tests, builds, screenshots, probes, logs.
- Commit finished, verified work in small commits in the repo's message style
  and push the current branch.
- Fan-out work: cheaper models implement, you review. Keep the machine usable,
  never max out the CPU.

## Always ask first
- Anything matching the always-ask line below.
- Deleting data or history, spending money, messaging other people.
- Changing what the product does or promises, and taste calls the user has not
  settled.

## Settings
always-ask: production, prod, deploy, release, merge into main, merge to main, merge into stable, force push, force-push, delete, drop, secret, credential, payment, App Store, TestFlight, submit for review
max-auto: 8
effort: auto
cache-ttl: 60
`

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
{"action":"continue"|"ask"|"stop","reply":"...","decision":"...","checks":["..."]}

- "continue": the message ends with a question, offer or list of leftovers that the
  orders already answer. "reply" is the answer to give, short and concrete, naming the
  order that covers it ("Per my standing orders: yes, do 1-3, then commit.").
- "ask": it needs the user's own judgment: a choice the orders don't cover, a taste or
  product call, anything the orders say to always ask about, or you are unsure.
  "decision" is that question in one line.
- "stop": the work is finished and nothing is left the agent could do itself.
  "decision" is a one-line summary of what was done.
- "checks": things only the user can do or verify (real hardware, devices, accounts,
  other people, store or console clicks) that the message leaves open. [] if none.
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
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh']

export type Orders = {
  text: string
  rail: RegExp | null
  terms: string[]
  maxAuto: number
  isEffortAuto: boolean
  cacheTtlMin: number
}

// A setting's every line, in order: the global file's first, the repo's after.
const settings = (text: string, key: string) =>
  [...text.matchAll(new RegExp(`^${key}:\\s*(.*)$`, 'gim'))].map(m => (m[1] ?? '').trim())
// The repo's line wins over the global one.
const setting = (text: string, key: string) => settings(text, key).at(-1)

const num = (raw: string | undefined, fallback: number) => {
  const n = Number(raw)
  return raw !== undefined && Number.isFinite(n) && n > 0 ? n : fallback
}

export function parseOrders(text: string): Orders {
  // always-ask lines add up: the repo's words join the global ones.
  const terms = [
    ...new Set(
      settings(text, 'always-ask')
        .flatMap(line => line.split(','))
        .map(t => t.trim())
        .filter(Boolean),
    ),
  ]
  const escaped = terms.map(t =>
    t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'),
  )

  return {
    text,
    terms,
    rail: escaped.length ? new RegExp(`\\b(${escaped.join('|')})\\b`, 'i') : null,
    maxAuto: num(setting(text, 'max-auto'), 8),
    isEffortAuto: (setting(text, 'effort') ?? 'auto').toLowerCase() !== 'off',
    cacheTtlMin: num(setting(text, 'cache-ttl'), 60),
  }
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
export const takesEffort = (model: string) => /(opus|sonnet)-5-5/i.test(model)

export const capEffort = (e: Effort, cap: Effort) =>
  EFFORTS.indexOf(e) > EFFORTS.indexOf(cap) ? cap : e

export type TreeRow = { id: string; status: string; parentId?: string }

// Main first, then each agent under its parent (or under main when the parent
// is gone), live ones before finished ones. Depth is the indent.
export function orderTree<T extends TreeRow>(rows: readonly T[]): { row: T; depth: number }[] {
  const ids = new Set(rows.map(r => r.id))
  const live = (r: T) => (['running', 'pending', 'waiting'].includes(r.status) ? 0 : 1)
  const out: { row: T; depth: number }[] = []
  const walk = (parent: string, depth: number) => {
    const kids = rows
      .filter(r => r.id !== 'main' && (r.parentId && ids.has(r.parentId) ? r.parentId : 'main') === parent)
      .sort((a, b) => live(a) - live(b))
    for (const row of kids) {
      out.push({ row, depth })
      walk(row.id, depth + 1)
    }
  }
  const main = rows.find(r => r.id === 'main')
  if (main) out.push({ row: main, depth: 0 })
  walk('main', 1)
  return out
}

const ICONS: Record<string, string> = {
  running: '●', pending: '○', waiting: '◔', idle: '◌', completed: '✓', failed: '✗', killed: '✗',
}
export const statusMark = (status: string) => `${ICONS[status] ?? '·'} ${status}`

export function agoText(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`
}

const MARK = { answered: '✓', drafted: '✎', asked: '?', stopped: '■' }
const VERB = { answered: 'sent', drafted: 'drafted', asked: 'asked you', stopped: 'finished' }
export const logHead = (e: { at: number; kind: keyof typeof MARK }, now: number) =>
  `${MARK[e.kind]} ${agoText(now - e.at).padStart(3)}`
export const logBody = (e: { kind: keyof typeof MARK; text: string }) =>
  `${VERB[e.kind]}: ${e.text.replace(/\s+/g, ' ').slice(0, 240)}`
export const logLine = (e: { at: number; kind: keyof typeof MARK; text: string }, now: number) =>
  `${logHead(e, now)}  ${logBody(e)}`

export const fit = (text: string, n: number) =>
  n > 1 && text.length > n ? `${text.slice(0, n - 1)}…` : text

export const bar = (percent: number, cells = 8) => {
  const full = Math.round((Math.min(100, Math.max(0, percent)) / 100) * cells)
  return '━'.repeat(full) + '─'.repeat(cells - full)
}

export function clock(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60000))
  const s = Math.max(0, Math.floor((ms % 60000) / 1000))
  return `${m}:${String(s).padStart(2, '0')}`
}

// What /orders help shows: the whole mod in plain words.
export const HELP = `Standing orders: what it does and when to use what

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
- What is it doing? ........... /crew (agents, what the orders did, checks)
- Things only you can check ... /crew: click one to tick it off
- Buttons for all of this ..... /crew (Esc or Close shuts it); the line above
                                 the prompt: click the mode to cycle, Crew opens it

The line above the prompt (click the mode to cycle it; Crew opens the pane):
  Orders: draft | auto | paused   the mode
  answered N                      answers given since your last typed prompt
  Low/Medium/High/Xhigh           effort for this prompt; (yours) if you set it
  ctx N%                          context used (yellow from 80%)
  cache m:ss / cache cold         time left on the prompt cache; replying
                                  before it runs out is cheaper
  no repo orders                  this repo has no orders file yet

Effort: Haiku picks low..xhigh for each prompt you type (Opus and Sonnet 5.5
only; the model never changes, so the cache survives). A short go-ahead keeps
the last level. Setting /effort yourself turns it off; /orders effort auto
turns it back on.

Files:
- ~/.claude/standing-orders.md: your rules for every repo, plus the settings
  always-ask, max-auto, effort, cache-ttl. Claude sees edits in the next chat.
- .claude/standing-orders.md: this repo's additions, from /orders init. Its
  always-ask words add to yours; its other settings win.`
