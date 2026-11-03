import { useSyncExternalStore } from 'react'

/**
 * Operator marks: a moment (data time) with an optional note, added with M. They go on the timeline and into the session
 * report. Live marks are kept in localStorage for the rest of the day (a reload must not lose them); marks on a replay stay
 * in memory and are forgotten when another recording opens, like the guided checks.
 */

export interface Mark {
  id: string
  t: number
  note: string
}

export type MarkScope = 'live' | 'replay'

const STORAGE_KEY = 'roco.marks.v1'
const MAX_MARKS = 200
const MAX_NOTE = 200
const today = (): string => new Date().toLocaleDateString('sv')

function loadMarks(): Mark[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const p: unknown = JSON.parse(raw)
    if (typeof p !== 'object' || p === null) return []
    const o = p as Record<string, unknown>
    if (o.day !== today() || !Array.isArray(o.marks)) return []
    const out: Mark[] = []
    for (const m of o.marks) {
      if (typeof m !== 'object' || m === null) continue
      const x = m as Record<string, unknown>
      if (typeof x.id === 'string' && typeof x.t === 'number' && Number.isFinite(x.t) && typeof x.note === 'string')
        out.push({ id: x.id.slice(0, 40), t: x.t, note: x.note.slice(0, MAX_NOTE) })
      if (out.length >= MAX_MARKS) break
    }
    return out
  } catch {
    return []
  }
}

let counter = 0

function makeStore(persist: boolean) {
  let marks: Mark[] = persist ? loadMarks() : []
  const listeners = new Set<() => void>()
  const commit = (next: Mark[]) => {
    marks = [...next].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1))
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ day: today(), marks }))
      } catch {
        // blocked or full: the marks still apply until the page is closed
      }
    }
    listeners.forEach((l) => l())
  }
  return {
    get: (): readonly Mark[] => marks,
    subscribe(l: () => void) {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    /** Returns the new mark's id, or null at the limit or for a time that is not a number. */
    add(t: number, note = ''): string | null {
      if (!Number.isFinite(t) || marks.length >= MAX_MARKS) return null
      const id = `m${Date.now().toString(36)}${(counter++).toString(36)}`
      commit([...marks, { id, t, note: note.slice(0, MAX_NOTE) }])
      return id
    },
    setNote(id: string, note: string) {
      if (marks.some((m) => m.id === id && m.note !== note.slice(0, MAX_NOTE))) commit(marks.map((m) => (m.id === id ? { ...m, note: note.slice(0, MAX_NOTE) } : m)))
    },
    remove(id: string) {
      if (marks.some((m) => m.id === id)) commit(marks.filter((m) => m.id !== id))
    },
    clear() {
      if (marks.length) commit([])
    },
  }
}

const stores = { live: makeStore(true), replay: makeStore(false) }
export const marksStore = (scope: MarkScope) => stores[scope]
export const MAX_MARK_NOTE = MAX_NOTE

export function useMarks(scope: MarkScope): readonly Mark[] {
  const s = stores[scope]
  return useSyncExternalStore(s.subscribe, s.get)
}

// ---------------------------------------------------------------------------------------------------------------------
// Which mark's note is being typed (M adds a mark and opens its note)
// ---------------------------------------------------------------------------------------------------------------------

let editing: string | null = null
const editListeners = new Set<() => void>()

export function startMarkNote(id: string | null): void {
  if (editing === id) return
  editing = id
  editListeners.forEach((l) => l())
}

export function useMarkNoteEditing(): string | null {
  return useSyncExternalStore(
    (l) => {
      editListeners.add(l)
      return () => editListeners.delete(l)
    },
    () => editing,
  )
}
