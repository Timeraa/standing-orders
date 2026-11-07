// Checks: the "Needs you" list, things only the person can do (a device, an account,
// other people). A check is dated and belongs to the chat that found it; a chat's next
// list replaces its earlier items, the judge can tick items off, and an item drops by
// itself after three days. The list lives in the mod's `checks` atom and is saved per
// folder; its whole life (load, add, expire, tick off, clear, what the pane shows and
// the identity of an item) is here and nowhere else.
// No `$` in this file: the atom and the store are a parameter (the Host), like the file store in orders.ts.
import type { Check } from '../types'

export type { Check }

// ---- the seam -----------------------------------------------------------

/**
 * What this module needs from the mod's atom and from `$.store`, as plain functions
 * (the engine rejects `$.x` used as a value, so register.tsx wraps each call).
 */
export type Host = {
  /** The checks atom, as it is now. The atom is the source of truth: the pane reads it, a test seeds it. */
  list(): Promise<Check[]>
  /** Replaces the atom's list through a function of the old one; returns the new list. */
  change(next: (old: Check[]) => Check[]): Promise<Check[]>
  /** `$.store.get`: what a folder's list was saved as (anything: before 0.8 it was plain strings). May reject. */
  load(key: string): Promise<unknown>
  /** `$.store.set`. */
  save(key: string, list: Check[]): Promise<unknown>
}

// ---- the rules ----------------------------------------------------------

export const CHECK_TTL_MS = 3 * 86_400_000
const MAX_CHECKS = 30
const MAX_NEW_CHECKS = 5
/** How many the Now tab lists before "+N older". */
export const SHOWN_CHECKS = 5

/**
 * The one identity of a check: when it was found and what it says. Items found in one
 * turn share a time and differ in text, so it is unique in a list; it survives a save and
 * a load and any merge that keeps the item. (A check found again is a new item with a new
 * time, so it has a new id.) Keys, removal and the pane's buttons all go by it; a hover
 * scope does not (it is capped at 64 characters), that is built from `slot`.
 */
export const checkId = (c: Check) => `${c.at}:${c.text}`

const same = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '')

const liveChecks = (list: readonly Check[], now: number) => list.filter(c => now - c.at < CHECK_TTL_MS)

// What the store held: plain strings from before 0.8 are dated from now, so they
// get the full lifetime instead of vanishing on first load.
function loadChecks(saved: unknown, now: number): Check[] {
  if (!Array.isArray(saved)) return []
  return liveChecks(
    saved.flatMap((c: unknown): Check[] => {
      if (typeof c === 'string') return c.trim() ? [{ text: c.trim(), at: now, chat: '' }] : []
      const o = (c ?? {}) as Partial<Check>
      if (typeof o.text !== 'string' || !o.text.trim()) return []
      return [{ text: o.text.trim(), at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : now, chat: String(o.chat ?? '') }]
    }),
    now,
  )
}

// A judged turn's findings: its chat's earlier items give way to the new list
// (when it has one), `resolved` ticks items off in any chat, repeats collapse.
function mergeChecks(old: readonly Check[], fresh: readonly string[], resolved: readonly string[], chat: string, now: number): Check[] {
  const done = new Set(resolved.map(same))
  const seen = new Set<string>()
  const next = fresh
    .map(t => t.trim())
    .filter(t => t && !done.has(same(t)) && !seen.has(same(t)) && seen.add(same(t)))
    .slice(0, MAX_NEW_CHECKS)
  const keep = liveChecks(old, now).filter(
    c => !done.has(same(c.text)) && !seen.has(same(c.text)) && !(next.length > 0 && c.chat === chat),
  )
  return [...keep, ...next.map(text => ({ text, at: now, chat }))].slice(-MAX_CHECKS)
}

// ---- the views ----------------------------------------------------------

// "After /reload-plugins, open /autopilot ..." splits into the lead ("After /reload-plugins") and what to do.
const LEAD = /^((?:after|once|when|before|while|in|on|at)\s[^,:]{3,60}),\s+(\S[\s\S]*)$/i
export function splitLead(text: string): { lead: string | null; rest: string } {
  const m = LEAD.exec(text.trim())
  if (!m) return { lead: null, rest: text.trim() }
  const rest = m[2] ?? ''
  return { lead: m[1] ?? null, rest: rest.charAt(0).toUpperCase() + rest.slice(1) }
}

export type CheckGroup<T> = { lead: string | null; items: { item: T; text: string }[] }
// Items that share a lead (two or more) group under it, in order of first sight; the rest stay whole.
export function groupChecks<T extends { text: string }>(items: readonly T[]): CheckGroup<T>[] {
  const split = items.map(item => ({ item, ...splitLead(item.text) }))
  const count = new Map<string, number>()
  for (const x of split) if (x.lead) count.set(x.lead.toLowerCase(), (count.get(x.lead.toLowerCase()) ?? 0) + 1)
  const groups: CheckGroup<T>[] = []
  for (const x of split) {
    const grouped = !!x.lead && (count.get(x.lead.toLowerCase()) ?? 0) > 1
    const lead = grouped ? x.lead : null
    const entry = { item: x.item, text: grouped ? x.rest : x.item.text }
    const home = groups.find(g => (lead ? g.lead?.toLowerCase() === lead.toLowerCase() : g.lead === null && g === groups.at(-1)))
    if (home) home.items.push(entry)
    else groups.push({ lead, items: [entry] })
  }
  return groups
}

// The last day of an item's life says so: it is about to drop by itself.
export function checkLife(ageMs: number) {
  const left = CHECK_TTL_MS - ageMs
  return left <= 86_400_000 ? `drops in ${checkAge(left)}` : ''
}

export function checkAge(ms: number) {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}

/** A check as the Now tab draws it: its id, and its place in the shown list (what a hover scope is built from, so equal scopes never light two items). */
export type CheckRow = Check & { id: string; slot: number }

/**
 * The Now tab's list: the newest first, only the newest SHOWN_CHECKS unless `isOpen`,
 * grouped by their lead. `older` is how many the short list leaves out.
 */
export function shownChecks(list: readonly Check[], isOpen: boolean) {
  const newest = [...list].reverse()
  const rows = (isOpen ? newest : newest.slice(0, SHOWN_CHECKS)).map((c, slot): CheckRow => ({ ...c, id: checkId(c), slot }))
  return { groups: groupChecks(rows), older: Math.max(0, list.length - SHOWN_CHECKS) }
}

// ---- the module ---------------------------------------------------------

/**
 * The checks, held as one: every change to the list goes through here and is saved
 * with it. Hooks and buttons call these; each is a line around one of them.
 */
export function createChecks() {
  let cwd = ''
  // ponytail: a chat is one load of the mod (a /clear or reload starts a new one); its items are replaced together.
  let chat = ''
  const key = () => `checks:${cwd}`

  // The one way the list changes: the atom first, then the store.
  async function apply(host: Host, next: (old: Check[]) => Check[]) {
    const list = await host.change(next)
    await host.save(key(), list)
  }

  const remove = (host: Host, ids: readonly string[]) => apply(host, old => old.filter(c => !ids.includes(checkId(c))))

  return {
    /**
     * A session starts in `cwd` at `now`: this folder's saved list becomes the atom's, and
     * this load of the mod is the chat that finds the next items. A saved list that cannot be
     * read is an empty one.
     * QUIRK: loading writes no store (the first change after it does): an item that expired while
     * the mod was off stays saved until then, and a pre-0.8 plain-string list stays strings until
     * then, dated from each load. Only the atom is replaced.
     */
    async load(host: Host, at: { cwd: string; now: number }) {
      cwd = at.cwd
      chat = String(at.now)
      let saved: unknown = null
      try {
        saved = await host.load(key())
      } catch {}
      await host.change(() => loadChecks(saved, at.now))
    },

    /**
     * A judged turn's findings (`found`) and the items it shows done (`resolved`), stamped with
     * this chat and `now`. Both are whatever the judge said, so anything but a list is none.
     */
    async add(host: Host, found: readonly unknown[] | undefined, resolved: readonly unknown[] | undefined, now: number) {
      const strings = (l: readonly unknown[] | undefined) => (Array.isArray(l) ? l.map(c => String(c)) : [])
      const fresh = strings(found)
      const done = strings(resolved)
      if (!fresh.length && !done.length) return
      await apply(host, old => mergeChecks(old, fresh, done, chat, now))
    },

    /** Drops the items past their three days. Returns whether any went (nothing is written when none did). */
    async expire(host: Host, now: number) {
      const open = await host.list()
      if (liveChecks(open, now).length === open.length) return false
      await apply(host, old => liveChecks(old, now))
      return true
    },

    /** The person did one: removes the item with this id (see `checkId`). */
    tickOff: (host: Host, id: string) => remove(host, [id]),

    /** The person did a whole group (the Now tab's "Done all"). */
    tickOffGroup: (host: Host, group: CheckGroup<{ id: string; text: string }>) => remove(host, group.items.map(x => x.item.id)),

    /** Clear all. */
    clear: (host: Host) => apply(host, () => []),
  }
}

export type Checks = ReturnType<typeof createChecks>
