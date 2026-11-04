import type { AlertCarry, AlertEvent } from '../types/monitor'

/**
 * The alerts of a live bridge, kept in localStorage for the rest of the day so that a bridge restart does not wipe History, the
 * first-out times and the report's alert section. (A page reload on a running bridge gets them from the bridge itself; this covers
 * the restart.) Replay keeps nothing here: the bridge sends a recording's whole history.
 *
 * localStorage and not IndexedDB: the read is synchronous, so the history is on screen with the first frame; the data is small (200
 * events per bridge address); and a write happens at most once a second, only after an alert opened or closed.
 * Storage that is blocked, full or damaged only means the history lives in memory until the page closes.
 */

export type StoredEvent = AlertEvent & { session: string }
export type StoredCarry = AlertCarry & { session: string }

export interface StoredScope {
  /** Oldest first. */
  events: StoredEvent[]
  /** Data time each bridge session was last heard, by session id. */
  ends: Record<string, number>
  carry: Record<string, StoredCarry>
}

interface StoredData {
  day: string
  scopes: Record<string, StoredScope>
}

const STORAGE_KEY = 'roco.alertHistory.v1'
export const MAX_STORED_EVENTS = 200
const MAX_SCOPES = 8
const MAX_ENDS = 12
export const FLUSH_MS = 1000

const today = (): string => new Date().toLocaleDateString('sv')
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const eventKey = (e: { event: string; id: string; since: number }): string => `${e.event}|${e.id}|${e.since}`

/** The bridge address a history belongs to: another interface or DDS domain is another robot. */
export const alertScopeKey = (h: { source: string; iface?: string | null; domain?: number | null }): string =>
  `${h.source}|${h.iface ?? ''}|${h.domain ?? ''}`

const emptyScope = (): StoredScope => ({ events: [], ends: {}, carry: {} })

function cleanEvent(x: unknown): StoredEvent | null {
  if (typeof x !== 'object' || x === null) return null
  const e = x as Record<string, unknown>
  if ((e.event !== 'open' && e.event !== 'close') || typeof e.id !== 'string' || typeof e.session !== 'string') return null
  if (!finite(e.since) || !finite(e.last) || typeof e.kind !== 'string' || typeof e.text !== 'string') return null
  if (e.level !== 'info' && e.level !== 'warn' && e.level !== 'critical') return null
  if (e.peakLevel !== 'info' && e.peakLevel !== 'warn' && e.peakLevel !== 'critical') return null
  if (e.joint !== null && !finite(e.joint)) return null
  return { ...(e as unknown as StoredEvent), value: finite(e.value) ? e.value : null, peak: finite(e.peak) ? e.peak : null }
}

function cleanScope(x: unknown): StoredScope | null {
  if (typeof x !== 'object' || x === null) return null
  const o = x as Record<string, unknown>
  const out = emptyScope()
  if (Array.isArray(o.events)) {
    for (const raw of o.events) {
      const e = cleanEvent(raw)
      if (e) out.events.push(e)
    }
    if (out.events.length > MAX_STORED_EVENTS) out.events = out.events.slice(-MAX_STORED_EVENTS)
  }
  if (typeof o.ends === 'object' && o.ends !== null) {
    for (const [k, v] of Object.entries(o.ends)) if (finite(v)) out.ends[k] = v
  }
  if (typeof o.carry === 'object' && o.carry !== null) {
    for (const [k, v] of Object.entries(o.carry)) {
      if (typeof v !== 'object' || v === null) continue
      const c = v as Record<string, unknown>
      if (finite(c.since) && finite(c.gapTo) && typeof c.session === 'string' && (c.gapFrom === null || finite(c.gapFrom)) && (c.newSince === undefined || finite(c.newSince)))
        out.carry[k] = { since: c.since, newSince: c.newSince, gapFrom: c.gapFrom, gapTo: c.gapTo, session: c.session }
    }
  }
  return out
}

function readStorage(): StoredData {
  const fresh: StoredData = { day: today(), scopes: {} }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fresh
    const p: unknown = JSON.parse(raw)
    if (typeof p !== 'object' || p === null) return fresh
    const o = p as Record<string, unknown>
    if (o.day !== fresh.day || typeof o.scopes !== 'object' || o.scopes === null) return fresh
    for (const [k, v] of Object.entries(o.scopes)) {
      const s = cleanScope(v)
      if (s) fresh.scopes[k] = s
      if (Object.keys(fresh.scopes).length >= MAX_SCOPES) break
    }
    return fresh
  } catch {
    return fresh
  }
}

let data: StoredData | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let dirty = false
/** The bridge session being watched: where `end` records when it was last heard. */
let current: { scope: string; session: string; lastT: number | null } | null = null

function all(): StoredData {
  if (!data || data.day !== today()) data = readStorage()
  return data
}

function scopeOf(key: string): StoredScope {
  const d = all()
  let s = d.scopes[key]
  if (!s) {
    const keys = Object.keys(d.scopes)
    if (keys.length >= MAX_SCOPES) delete d.scopes[keys[0]]
    s = d.scopes[key] = emptyScope()
  }
  return s
}

function schedule(): void {
  dirty = true
  if (timer === null) timer = setTimeout(flush, FLUSH_MS)
}

/** Writes what changed, once. Called by the timer, when the page is hidden, and when a bridge session ends. */
export function flush(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (!dirty || !data) return
  dirty = false
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // blocked or full: the history still applies until the page is closed
  }
}

export const alertHistoryStore = {
  /** What this bridge address has stored today (a copy). Synchronous. */
  load(scope: string): StoredScope {
    const s = scopeOf(scope)
    return { events: [...s.events], ends: { ...s.ends }, carry: { ...s.carry } }
  },
  /** A new bridge session is being watched. */
  begin(scope: string, session: string): void {
    current = { scope, session, lastT: null }
  },
  /** The data time of the latest aux frame. A single assignment: this runs for every frame. */
  touch(t: number): void {
    if (current) current.lastT = t
  },
  /** Events not stored yet are added (an event, id and opening time are stored once); the newest 200 are kept. */
  add(scope: string, session: string, events: readonly AlertEvent[]): void {
    if (events.length === 0) return
    const s = scopeOf(scope)
    const seen = new Set(s.events.map(eventKey))
    let added = false
    for (const e of events) {
      const k = eventKey(e)
      if (seen.has(k)) continue
      seen.add(k)
      const { earlier: _earlier, ...rest } = e
      s.events.push({ ...rest, session })
      added = true
    }
    if (!added) return
    if (s.events.length > MAX_STORED_EVENTS) s.events = s.events.slice(-MAX_STORED_EVENTS)
    schedule()
  },
  setCarry(scope: string, session: string, carry: Record<string, AlertCarry>): void {
    const s = scopeOf(scope)
    const next: Record<string, StoredCarry> = {}
    for (const [k, c] of Object.entries(s.carry)) if (c.session !== session) next[k] = c
    for (const [k, c] of Object.entries(carry)) if (c.newSince !== undefined) next[k] = { ...c, session }
    s.carry = next
    schedule()
  },
  /** The bridge stopped being heard (the link dropped or the page is closing): remember when, and write now. */
  end(): void {
    if (!current || current.lastT === null) return
    const s = scopeOf(current.scope)
    s.ends[current.session] = current.lastT
    current = null
    const keys = Object.keys(s.ends)
    if (keys.length > MAX_ENDS) for (const k of keys.slice(0, keys.length - MAX_ENDS)) delete s.ends[k]
    schedule()
    flush()
  },
  /** For checks: forget what is cached and any pending write. */
  reset(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    dirty = false
    data = null
    current = null
  },
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    alertHistoryStore.end()
    flush()
  })
}
