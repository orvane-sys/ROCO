import { useSyncExternalStore } from 'react'
import type { PlotRing } from './plotRing'
import { telemetryService } from './telemetryStream'

/**
 * What the Analyze plots, the timeline, the joint table and the 3D view share:
 *  - a time cursor (data time), moved by hovering a plot or the timeline or with the arrow keys, and
 *  - a frozen moment: a copy of the plot history and the time its window ends at.
 * Nothing here is sent anywhere and nothing is kept after the page closes.
 */

export interface FrozenView {
  ring: PlotRing
  /** Data time the plot windows end at. */
  endT: number
}

export interface ViewState {
  cursorT: number | null
  frozen: FrozenView | null
}

let state: ViewState = { cursorT: null, frozen: null }
const listeners = new Set<() => void>()
let notifyTimer: number | undefined

/** Cursor moves at pointer rate; React readers are told at most every 40 ms. Canvas loops read `viewStore.get()` directly. */
function notify(immediate: boolean): void {
  const fire = () => {
    notifyTimer = undefined
    listeners.forEach((l) => l())
  }
  if (immediate) {
    window.clearTimeout(notifyTimer)
    fire()
  } else if (notifyTimer === undefined) notifyTimer = window.setTimeout(fire, 40)
}

export const viewStore = {
  get: (): ViewState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
  setCursor(t: number | null): void {
    if (state.cursorT === t) return
    state = { ...state, cursorT: t }
    notify(t === null)
  },
  /** Freeze the plots with their window ending at `endT` (the newest sample when omitted). */
  freeze(endT?: number): void {
    const ring = telemetryService.getPlotRing().clone()
    const last = ring.latestTime()
    if (last === null) return
    const first = ring.firstTime() ?? last
    const t = Math.min(Math.max(endT ?? last, first), last)
    state = { ...state, frozen: { ring, endT: t } }
    notify(true)
  },
  unfreeze(): void {
    if (!state.frozen) return
    state = { ...state, frozen: null }
    notify(true)
  },
}

export function useViewState(): ViewState {
  return useSyncExternalStore(viewStore.subscribe, viewStore.get)
}

/** The plot history the plots draw from: the frozen copy, or the live one. */
export const activeRing = (): PlotRing => viewStore.get().frozen?.ring ?? telemetryService.getPlotRing()

export interface CursorSample {
  t: number
  ring: PlotRing
  /** Physical index of the sample in the ring's arrays. */
  i: number
}

/** The stored sample nearest to the cursor, or null when there is no cursor or no history. */
export function cursorSample(): CursorSample | null {
  const { cursorT } = viewStore.get()
  if (cursorT === null) return null
  const ring = activeRing()
  const k = ring.nearest(cursorT)
  if (k === null) return null
  const i = ring.index(k)
  return { t: ring.t[i], ring, i }
}

/** For components that show the values at the cursor. The sample is looked up when the cursor moves. */
export function useCursorSample(): CursorSample | null {
  const v = useViewState()
  return v.cursorT === null ? null : cursorSample()
}
