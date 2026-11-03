import { useSyncExternalStore } from 'react'
import type { AlertControls } from '../utils/alertModel'

/**
 * What the operator did with the alert list in this browser tab: marked as seen, or shelved. Kept in memory only, so a page
 * reload or a new bridge session starts clean (a shelf from an earlier run must never hide a new problem). Critical alerts
 * can be marked as seen but never shelved: the model ignores a shelved id at critical level, so one that escalates comes back.
 */
const MAX_ACKED = 500

let state: AlertControls = { acked: new Set(), shelved: new Set() }
const listeners = new Set<() => void>()

function set(next: AlertControls): void {
  state = next
  listeners.forEach((l) => l())
}

/** The current choices, for code that runs on a click and must not depend on render state. */
export const getAlertControls = (): AlertControls => state

export function acknowledge(keys: string[]): void {
  const fresh = keys.filter((k) => k && !state.acked.has(k))
  if (fresh.length === 0) return
  const acked = new Set(state.acked)
  for (const k of fresh) acked.add(k)
  // keep the newest MAX_ACKED; a Set iterates in insertion order
  while (acked.size > MAX_ACKED) acked.delete(acked.values().next().value as string)
  set({ ...state, acked })
}

export function shelve(id: string): void {
  if (state.shelved.has(id)) return
  set({ ...state, shelved: new Set(state.shelved).add(id) })
}

export function unshelve(id: string): void {
  if (!state.shelved.has(id)) return
  const shelved = new Set(state.shelved)
  shelved.delete(id)
  set({ ...state, shelved })
}

export function unshelveAll(): void {
  if (state.shelved.size) set({ ...state, shelved: new Set() })
}

/** A new bridge session or a different replay file: forget what was seen and shelved. */
export function resetAlertControls(): void {
  if (state.acked.size || state.shelved.size) set({ acked: new Set(), shelved: new Set() })
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useAlertControls(): AlertControls {
  return useSyncExternalStore(subscribe, () => state)
}
