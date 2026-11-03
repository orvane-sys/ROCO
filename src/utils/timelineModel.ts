import type { MonitorState } from '../types/monitor'
import type { EffectiveLevel } from '../config/alertPolicy'
import type { Mark } from '../services/marksStore'
import { currentRun, stateAt, stateChanges, type AlertView, type StateChange } from './alertModel'

/**
 * What the session timeline draws and lists: the g1_ctrl states over time, the alerts that opened, and the operator's marks.
 * Pure functions of the monitor state, so they are checked without a browser (scripts/check-timeline.mjs).
 */

/** One alert occurrence as the timeline remembers it. The timeline keeps these for the whole session (and across replay seeks). */
export interface TimelineAlert {
  key: string
  /** The alert's id (kind and joint): the same one opening again later is a new occurrence with the same id. */
  id: string
  kind: string
  joint: number | null
  /** Level after the severity rules, the highest it reached. */
  level: EffectiveLevel
  t: number
  /** Data time it closed, or null while it is open. */
  until: number | null
}

const RANK: Record<EffectiveLevel, number> = { info: 0, warn: 1, critical: 2 }
const CARRY_S = 1
/** The bridge's AlertBook holds an alert 0.5 s before it opens it (scripts/roco_dds_bridge.py). */
const HOLD_S = 0.5

function itemsOf(view: AlertView) {
  const all = new Map<string, AlertView['closed'][number]>()
  for (const g of view.groups) for (const i of [g.first, ...g.rest]) all.set(i.key, i)
  for (const i of [...view.info, ...view.shelved, ...view.closed]) if (!all.has(i.key)) all.set(i.key, i)
  return all
}

/**
 * Add what the alert view now shows to the remembered occurrences. A replay seek makes the bridge restart its statistics, so an
 * alert already seen comes back when the replay passes it again, and its `since` can differ by a few milliseconds from the first
 * time (the key is `id@since`). With `seekT` set, such an item is matched to the remembered occurrence of the same alert whose
 * interval holds it, so it is not listed twice. A bridge never has two occurrences of one alert open together, so an overlap
 * means the same one; an occurrence that has its own key in this view is a different one (it closed and opened again).
 */
export function mergeTimelineAlerts(prev: TimelineAlert[], view: AlertView, seekT: number | null): TimelineAlert[] {
  const byKey = new Map(prev.map((a) => [a.key, a]))
  const items = [...itemsOf(view).values()]
  const inView = new Set(items.map((i) => i.key))
  const claimed = new Set<string>()
  let changed = false
  const update = (target: TimelineAlert, it: AlertView['closed'][number], until: number | null) => {
    claimed.add(target.key)
    const level = RANK[it.level] > RANK[target.level] ? it.level : target.level
    // an occurrence that has closed does not become open again because the replay went back and is passing it once more
    if (until === null && target.until !== null) until = target.until
    if (level !== target.level || until !== target.until) {
      byKey.set(target.key, { ...target, level, until })
      changed = true
    }
  }
  const untilOf = (it: AlertView['closed'][number]) => (it.active ? null : it.durationS !== undefined ? it.alert.since + it.durationS : it.alert.last)
  const unmatched: AlertView['closed'][number][] = []
  for (const it of items) {
    const target = byKey.get(it.key)
    if (target) update(target, it, untilOf(it))
    else unmatched.push(it)
  }
  for (const it of unmatched) {
    const a = it.alert
    const until = untilOf(it)
    let target: TimelineAlert | undefined
    if (seekT !== null) {
      target = prev.find(
        (p) =>
          p.id === a.id &&
          !inView.has(p.key) &&
          !claimed.has(p.key) &&
          ((p.t < seekT && a.since <= seekT + CARRY_S && (p.until === null || p.until >= seekT - HOLD_S)) ||
            (a.since >= p.t - HOLD_S && a.since <= (p.until ?? Infinity) + HOLD_S)),
      )
    }
    if (target) {
      update(target, it, until)
      continue
    }
    byKey.set(it.key, { key: it.key, id: a.id, kind: a.kind, joint: a.joint, level: it.level, t: a.since, until })
    claimed.add(it.key)
    changed = true
  }
  return changed ? [...byKey.values()].sort((x, y) => x.t - y.t || (x.key < y.key ? -1 : 1)) : prev
}

export interface TimelineSpan {
  /** g1_ctrl state, or null where it is not known (before the log starts, or a recording not played that far yet). */
  state: string | null
  t0: number
  t1: number
}

export interface TimelineModel {
  t0: number
  t1: number
  replay: boolean
  /** Replay: how far the recording has played. */
  playedTo: number | null
  spans: TimelineSpan[]
  changes: StateChange[]
  alerts: TimelineAlert[]
  marks: Mark[]
}

export interface RingSpan {
  first: number | null
  last: number | null
}

const MIN_SPAN_S = 1

/** The timeline of the current session: a recording from its start to its end, live data from the latest g1_ctrl run to now. */
export function buildTimeline(state: MonitorState, alerts: TimelineAlert[], marks: readonly Mark[], ring: RingSpan): TimelineModel {
  const replay = state.replay
  const frame = state.timeline
  const changes: StateChange[] = replay && frame ? [...frame.states].sort((a, b) => a.t - b.t) : stateChanges(state.fsm.events)
  let t0: number
  let t1: number
  if (replay) {
    t0 = replay.t0
    // a recording of one sample (or a cut-off one) still has a span, so the time axis never divides by zero
    t1 = replay.t1 !== null ? Math.max(replay.t1, t0 + MIN_SPAN_S) : Math.max(replay.t, t0 + MIN_SPAN_S)
  } else {
    const start = currentRun(state.fsm.events).start
    t0 = start ?? changes[0]?.t ?? ring.first ?? state.aux?.t ?? 0
    t1 = state.aux?.t ?? ring.last ?? changes[changes.length - 1]?.t ?? t0
    // a mark made since the page started stays on the timeline even if it came before the run's first state change
    if (ring.first !== null) for (const m of marks) if (m.t >= ring.first - 1e-6 && m.t < t0) t0 = m.t
  }
  if (t1 < t0 + MIN_SPAN_S) t1 = t0 + MIN_SPAN_S
  const playedTo = replay ? replay.t : null
  // a recording without the bridge's full list is known only as far as it has played
  const knownTo = replay && !frame ? Math.min(Math.max(playedTo ?? t0, t0), t1) : t1

  const spans: TimelineSpan[] = []
  let cur: string | null = stateAt(t0, changes, state.fsm.state)
  let at = t0
  for (const c of changes) {
    if (c.t <= t0) continue
    if (c.t >= knownTo) break
    spans.push({ state: cur, t0: at, t1: c.t })
    cur = c.to
    at = c.t
  }
  spans.push({ state: cur, t0: at, t1: knownTo })
  if (knownTo < t1) spans.push({ state: null, t0: knownTo, t1 })

  return {
    t0,
    t1,
    replay: replay !== null,
    playedTo,
    spans,
    changes,
    alerts: alerts.filter((a) => a.t >= t0 - 1e-6 && a.t <= t1 + 1e-6),
    marks: marks.filter((m) => m.t >= t0 - 1e-6 && m.t <= t1 + 1e-6),
  }
}

export type TimelineRowKind = 'state' | 'alert' | 'mark'
export interface TimelineRow {
  t: number
  kind: TimelineRowKind
  /** Plain words for the row. */
  text: string
  /** The row's own key (alert key, mark id, state change time). */
  id: string
  level?: EffectiveLevel
}

/**
 * What to say about an alert that has not closed. On live data it is still open; in a recording it was open when the data (or the
 * playing) ended, which says nothing about what happened after. The 0.5 s is the same as the report's "played to" test.
 */
export function openWord(model: Pick<TimelineModel, 'replay' | 'playedTo' | 't1'>): string {
  if (!model.replay) return 'still open'
  return model.playedTo !== null && model.playedTo >= model.t1 - 0.5 ? 'open at end of recording' : 'open where play stopped'
}

const LEVEL_WORD: Record<EffectiveLevel, string> = { critical: 'Critical', warn: 'Warning', info: 'Info' }
export const levelWord = (l: EffectiveLevel): string => LEVEL_WORD[l]

/** Everything on the timeline as a list in time order: for the table view, the report and a screen reader. */
export function timelineRows(model: TimelineModel, alertTitle: (a: TimelineAlert) => string, formatDuration: (s: number) => string): TimelineRow[] {
  const rows: TimelineRow[] = []
  model.spans.forEach((sp, n) => {
    if (sp.state === null) return
    rows.push({ t: sp.t0, kind: 'state', id: `state-${n}`, text: n === 0 ? `State: ${sp.state}` : `State changes to ${sp.state}` })
  })
  for (const a of model.alerts) {
    const dur = a.until !== null ? ` for ${formatDuration(a.until - a.t)}` : ` (${openWord(model)})`
    rows.push({ t: a.t, kind: 'alert', id: a.key, level: a.level, text: `${LEVEL_WORD[a.level]}: ${alertTitle(a)}${dur}` })
  }
  model.marks.forEach((m, n) => rows.push({ t: m.t, kind: 'mark', id: m.id, text: `Mark ${n + 1}${m.note ? `: ${m.note}` : ''}` }))
  const order: Record<TimelineRowKind, number> = { state: 0, alert: 1, mark: 2 }
  return rows.sort((a, b) => a.t - b.t || order[a.kind] - order[b.kind] || (a.id < b.id ? -1 : 1))
}

/** The time under x pixels of a band that starts at `left` and is `width` wide. */
export const timeAtX = (model: Pick<TimelineModel, 't0' | 't1'>, x: number, left: number, width: number): number =>
  model.t0 + Math.min(Math.max((x - left) / width, 0), 1) * (model.t1 - model.t0)
export const xAtTime = (model: Pick<TimelineModel, 't0' | 't1'>, t: number, left: number, width: number): number =>
  left + ((t - model.t0) / (model.t1 - model.t0)) * width
