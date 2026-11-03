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

function itemsOf(view: AlertView) {
  const all = new Map<string, AlertView['closed'][number]>()
  for (const g of view.groups) for (const i of [g.first, ...g.rest]) all.set(i.key, i)
  for (const i of [...view.info, ...view.shelved, ...view.closed]) if (!all.has(i.key)) all.set(i.key, i)
  return all
}

/**
 * Add what the alert view now shows to the remembered occurrences. A replay seek makes the bridge restart its statistics, so an
 * alert that was already open at the seek time opens again at that time; `seekT` lets that one be recognised and not counted twice.
 */
export function mergeTimelineAlerts(prev: TimelineAlert[], view: AlertView, seekT: number | null): TimelineAlert[] {
  const byKey = new Map(prev.map((a) => [a.key, a]))
  let changed = false
  for (const it of itemsOf(view).values()) {
    const a = it.alert
    const until = it.active ? null : it.durationS !== undefined ? a.since + it.durationS : a.last
    let target = byKey.get(it.key)
    if (!target && seekT !== null && a.since <= seekT + CARRY_S) {
      // the same alert, already open before the seek
      target = prev.find((p) => p.id === a.id && p.t < seekT && (p.until === null || p.until >= seekT - 0.5))
    }
    if (!target) {
      byKey.set(it.key, { key: it.key, id: a.id, kind: a.kind, joint: a.joint, level: it.level, t: a.since, until })
      changed = true
      continue
    }
    const level = RANK[it.level] > RANK[target.level] ? it.level : target.level
    if (level !== target.level || until !== target.until) {
      byKey.set(target.key, { ...target, level, until })
      changed = true
    }
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
    t1 = replay.t1 ?? Math.max(replay.t, t0 + MIN_SPAN_S)
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
    const dur = a.until !== null ? ` for ${formatDuration(a.until - a.t)}` : ' (still open)'
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
