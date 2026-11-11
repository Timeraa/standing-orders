// Orders: the one home of the standing-orders files. The person's global
// ~/.claude/standing-orders.md and the repo's untrusted .claude/standing-orders.md
// are read, merged by the trust rules, changed and re-read here, and nowhere else.
// No `$` in this file: the file store (`$.fs`, or a map in a test) is a parameter.
import { EFFORTS, MODEL_NAMES, REPO_ORDERS, type Effort, type ModelName } from './judges'

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
effort-min: low
effort-max: xhigh
subagents: auto
model: auto
models: sonnet, opus
cache-ttl: 60
motion: on
band: mode, answered, effort, ctx, cache, hint, autopilot
`

export type Orders = {
  text: string
  rail: RegExp | null
  terms: string[]
  maxAuto: number
  isEffortAuto: boolean
  /** A fixed level from `effort: <level>`: no judge, every prompt runs at it. */
  effortFixed: Effort | null
  effortMin: Effort
  effortMax: Effort
  isSubagentsAuto: boolean
  isModelAuto: boolean
  models: ModelName[]
  cacheTtlMin: number
  /** Animations in the band and the pane (a spinner, easing bars, a flash on a new entry). */
  isMotionOn: boolean
  /** Savings audit: a random share of turns runs at your own effort, so the effort effect can be measured. */
  isAuditOn: boolean
  /** What the line above the prompt shows. */
  band: BandItem[]
}

/** The parts of the line above the prompt, in the order drawn. */
export const BAND_ITEMS = ['mode', 'answered', 'effort', 'ctx', 'limit', 'cache', 'hint', 'autopilot'] as const
export type BandItem = (typeof BAND_ITEMS)[number]
export const BAND_DEFAULT: readonly BandItem[] = ['mode', 'answered', 'effort', 'ctx', 'cache', 'hint', 'autopilot']

export function parseBand(raw: string | undefined): BandItem[] {
  if (raw === undefined) return [...BAND_DEFAULT]
  const want = raw.toLowerCase().split(/[,\s]+/)
  return BAND_ITEMS.filter(i => want.includes(i))
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

export function parseModels(raw: string | undefined): ModelName[] {
  const list = (raw ?? '').toLowerCase().split(/[,\s]+/).filter((m): m is ModelName => MODEL_NAMES.includes(m as ModelName))
  return list.length ? [...new Set(list)] : ['sonnet', 'opus']
}

// Set `key: value` in a settings file: replace the last such line, or append one.
// `all`: a list that adds up over several lines (always-ask) keeps one line, the first.
export function setSetting(text: string, key: string, value: string, all = false) {
  const re = new RegExp(`^${key}:.*$`, 'gim')
  const hits = [...text.matchAll(re)]
  const line = `${key}: ${value}`
  if (all && hits.length > 1) {
    for (const hit of hits.slice(1).reverse()) text = text.slice(0, hit.index) + text.slice((hit.index ?? 0) + hit[0].length).replace(/^\n/, '')
    return setSetting(text, key, value)
  }
  const last = hits.at(-1)
  if (!last || last.index === undefined) return `${text.replace(/\n*$/, '\n')}${line}\n`
  return text.slice(0, last.index) + line + text.slice(last.index + last[0].length)
}

const level = (raw: string | undefined): Effort | null => {
  const e = (raw ?? '').toLowerCase() as Effort
  return EFFORTS.includes(e) ? e : null
}

// A repo's file is untrusted (any clone can ship one): it may add always-ask
// words, lower max-auto, turn effort off and set cache-ttl. Every other
// setting is the person's global file alone.
export function parseOrders(global: string, repo = ''): Orders {
  const text = repo ? `${global}\n\n# This repo's orders\n\n${repo}` : global
  const repoEffortOff = setting(repo, 'effort')?.toLowerCase() === 'off'
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
    maxAuto: Math.min(num(setting(global, 'max-auto'), 8), num(setting(repo, 'max-auto'), Infinity)),
    isEffortAuto: !repoEffortOff && (setting(global, 'effort') ?? 'auto').toLowerCase() !== 'off',
    effortFixed: repoEffortOff ? null : level(setting(global, 'effort')),
    effortMin: level(setting(global, 'effort-min')) ?? 'low',
    effortMax: level(setting(global, 'effort-max')) ?? 'xhigh',
    isSubagentsAuto: (setting(global, 'subagents') ?? 'off').toLowerCase() === 'auto',
    isModelAuto: (setting(global, 'model') ?? 'off').toLowerCase() === 'auto',
    models: parseModels(setting(global, 'models')),
    cacheTtlMin: num(setting(repo, 'cache-ttl') ?? setting(global, 'cache-ttl'), 60),
    isMotionOn: (setting(global, 'motion') ?? 'on').toLowerCase() !== 'off',
    isAuditOn: (setting(global, 'audit') ?? 'off').toLowerCase() === 'on',
    band: parseBand(setting(global, 'band')),
  }
}

// ---- the store ----------------------------------------------------------

/** The seam: what `$.fs` offers, and all this module asks of a file system. A missing file rejects `read`. */
export type FileStore = {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<unknown>
}

/** The settings the mod writes; a repo's file never gets written. */
export type SettingKey =
  | 'always-ask'
  | 'max-auto'
  | 'effort'
  | 'effort-min'
  | 'effort-max'
  | 'subagents'
  | 'model'
  | 'models'
  | 'cache-ttl'
  | 'motion'
  | 'audit'
  | 'band'
export type Settings = Partial<Record<SettingKey, string>>

/** What can be paused for a while without touching the file: the session's or this project's. */
export const PARTS = ['replies', 'effort', 'model', 'subagents'] as const
export type Part = (typeof PARTS)[number]
export type Scope = 'session' | 'project'

// A pause only turns things off, so it is laid over the merged orders like a repo's tightening.
export function withPaused(o: Orders, paused: ReadonlySet<Part>): Orders {
  if (!paused.size) return o
  return {
    ...o,
    ...(paused.has('effort') ? { isEffortAuto: false, effortFixed: null } : {}),
    ...(paused.has('model') ? { isModelAuto: false } : {}),
    ...(paused.has('subagents') ? { isSubagentsAuto: false } : {}),
  }
}

const attempt = async <T>(job: () => Promise<T>): Promise<T | null> => {
  try {
    return await job()
  } catch {
    return null
  }
}

/**
 * Both orders files, held as one view. `get()` is what the mod obeys (the global
 * file with the repo's few allowed tightenings); `mine()` is the person's own file
 * alone, what the Settings tab shows and writes back.
 */
export function createOrders() {
  let globalPath = ''
  let cwd = ''
  // The two files as last loaded (null: missing), so a refresh notices an edit or a new repo file.
  let globalText: string | null = null
  let repoText: string | null = null
  let merged = parseOrders(DEFAULT_ORDERS)
  let own = parseOrders(DEFAULT_ORDERS)
  let isFirstRun = false
  // Pauses: never written to a file. The session's live in memory, the project's in the plugin store (the caller's).
  const paused = { session: new Set<Part>(), project: new Set<Part>() }
  const pausedNow = () => new Set([...paused.session, ...paused.project])

  // Reads each file once; reloads when asked to or when either differs from the last load.
  async function refresh(fs: FileStore, force = false) {
    const [g, r] = await Promise.all([
      attempt(() => fs.read(globalPath)),
      attempt(() => fs.read(`${cwd}/${REPO_ORDERS}`)),
    ])
    if (!force && r === repoText && (g === null || g === globalText)) return false
    let text = g
    if (text === null) {
      // No global file (or none readable): seed it, and say so once, for the first-run tour.
      text = DEFAULT_ORDERS
      isFirstRun = true
      await attempt(() => fs.write(globalPath, DEFAULT_ORDERS))
    }
    globalText = text
    repoText = r
    merged = parseOrders(text, r ?? '')
    own = parseOrders(text)
    return true
  }

  return {
    /** What the mod obeys: the global file, what the repo's file may tighten, and what is paused. */
    get: () => withPaused(merged, pausedNow()),
    /** What is paused, per scope (replies are only listed here; the caller holds them back). */
    paused: (scope?: Scope) => (scope ? new Set(paused[scope]) : pausedNow()),
    /** Pauses (`on`) or resumes parts in one scope. Returns that scope's parts after the change. */
    pause(scope: Scope, parts: readonly Part[], on: boolean) {
      for (const p of parts) on ? paused[scope].add(p) : paused[scope].delete(p)
      return [...paused[scope]]
    },
    /** The person's own file alone. */
    mine: () => own,
    /** Whether the repo has an orders file. */
    hasRepo: () => repoText !== null,
    /** Which files these are: the global path, and the repo whose file joins it. No file is read yet. */
    locate(paths: { globalPath: string; cwd: string }) {
      globalPath = paths.globalPath
      cwd = paths.cwd
    },
    /**
     * Reads both files once. Returns whether anything changed (or `force`d), so the
     * caller can redraw; an unchanged refresh touches nothing. A missing global
     * file is seeded with the default orders.
     */
    refresh,
    /**
     * Writes settings into the person's global file (the repo's is never written),
     * then reloads both. Rejects if the write fails.
     */
    async set(fs: FileStore, pairs: Settings) {
      let text = (await attempt(() => fs.read(globalPath))) ?? DEFAULT_ORDERS
      for (const [k, v] of Object.entries(pairs)) text = setSetting(text, k, v, k === 'always-ask')
      await fs.write(globalPath, text)
      await refresh(fs, true)
    },
    /** True once after a load seeded the global file: the first run ever. */
    consumeFirstRun() {
      const was = isFirstRun
      isFirstRun = false
      return was
    },
  }
}

export type OrdersStore = ReturnType<typeof createOrders>
