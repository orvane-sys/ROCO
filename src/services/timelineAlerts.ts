import { useSyncExternalStore } from 'react'
import type { AlertView } from '../utils/alertModel'
import { mergeTimelineAlerts, type TimelineAlert } from '../utils/timelineModel'

/** The alert occurrences the session timeline remembers, for the whole session and across replay seeks. In memory only. */

let alerts: TimelineAlert[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export const timelineAlerts = {
  get: (): TimelineAlert[] => alerts,
  subscribe(l: () => void) {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
  /** Add what the alert view shows now. `seekT` is the latest replay seek this page asked for, if any. */
  merge(view: AlertView, seekT: number | null): void {
    const next = mergeTimelineAlerts(alerts, view, seekT)
    if (next !== alerts) {
      alerts = next
      emit()
    }
  },
  /** A new bridge session or recording: what was seen belongs to the old one. */
  reset(): void {
    if (alerts.length) {
      alerts = []
      emit()
    }
  },
}

export const useTimelineAlerts = (): TimelineAlert[] => useSyncExternalStore(timelineAlerts.subscribe, timelineAlerts.get)
