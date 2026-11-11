import type { AlertCarry, AlertEvent, AuxFrame, BridgeHello, FsmFrame, MonitorState } from '../types/monitor'
import type { StoredScope } from './alertHistoryStore'

/**
 * How the bridge's hello, fsm and aux frames change the monitor state. Pure functions: no sockets, no timers, no storage, so the
 * page's alert bookkeeping can be checked without a browser (scripts/check-alerts.mjs) and a recorded frame stream can be replayed
 * through the same code (scripts/regress.py). `telemetryStream` calls these and does the side effects (plots, storage, listeners).
 */

export const MAX_FSM_EVENTS = 200
export const MAX_ALERT_LOG = 200
/**
 * An alert that was open when the bridge stopped and opens again within this long of the next bridge's start is the same
 * occurrence: it keeps its first time. After that it is a new one.
 */
export const CARRY_WINDOW_S = 5

/** What the caller should keep in storage after a frame. */
export interface AlertPersist {
  events: AlertEvent[]
  /** The whole carry table, set when it changed. */
  carry: Record<string, AlertCarry> | null
}

export interface Reduced {
  patch: Partial<MonitorState>
  persist: AlertPersist | null
}

const evKey = (e: { event: string; id: string; since: number }): string => `${e.event}|${e.id}|${e.since}`
const occ = (e: { id: string; since: number }): string => `${e.id}@${e.since}`
/** Where an event belongs on the time line: an open at its start, a close at the last time the alert was seen. */
const evTime = (e: AlertEvent): number => (e.event === 'open' ? e.since : e.last)

/** Events with the carried alerts' first times put back; `carry` is returned as it was unless an alert was seen again. */
function remapEvents(
  evs: readonly AlertEvent[],
  carry: Record<string, AlertCarry> | undefined,
  startedAt: number | undefined
): { events: AlertEvent[]; carry: Record<string, AlertCarry> | undefined; changed: boolean } {
  if (!carry) return { events: evs as AlertEvent[], carry, changed: false }
  let next = carry
  let changed = false
  const out = evs.map((e) => {
    const c = next[e.id]
    if (!c) return e
    if (c.newSince === undefined) {
      if (e.event !== 'open' || startedAt === undefined || e.since - startedAt > CARRY_WINDOW_S) return e
      next = { ...next, [e.id]: { ...c, newSince: e.since } }
      changed = true
      return { ...e, since: c.since }
    }
    if (c.newSince !== e.since) return e
    return e.event === 'close' ? { ...e, since: c.since, durationS: Math.round((e.last - c.since) * 1000) / 1000 } : { ...e, since: c.since }
  })
  return { events: out, carry: next, changed }
}

/** `a` then `b`, an event stored once (same event, id and opening time), in time order, the newest MAX_ALERT_LOG. */
function mergeLogs(a: readonly AlertEvent[], b: readonly AlertEvent[]): AlertEvent[] {
  const seen = new Set<string>()
  const out: AlertEvent[] = []
  for (const e of a) {
    const k = evKey(e)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(e)
    }
  }
  for (const e of b) {
    const k = evKey(e)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(e)
    }
  }
  const sorted = out.map((e, i) => ({ e, i })).sort((x, y) => evTime(x.e) - evTime(y.e) || x.i - y.i).map((x) => x.e)
  return sorted.length > MAX_ALERT_LOG ? sorted.slice(-MAX_ALERT_LOG) : sorted
}

/**
 * A live bridge introduces itself. `restored` is what this page stored of the same bridge address today (null: replay, or nothing);
 * `sid` is this bridge session's id (made up by the page for a bridge that sends none).
 * Events of an earlier bridge session come back marked `earlier`; the ones that were still open then may be carried (see CARRY_WINDOW_S).
 */
export function reduceHello(hello: BridgeHello, restored: StoredScope | null, sid: string): Partial<MonitorState> {
  if (!restored || hello.source === 'replay') return { hello, alertCarry: undefined, alertCarryUntil: undefined }
  const startedAt = hello.session?.startedAt

  const alertLog: AlertEvent[] = restored.events.map((e) => {
    const { session, ...rest } = e
    return session === sid && !e.endedByRestart ? rest : { ...rest, earlier: true }
  })

  let carry: Record<string, AlertCarry> = {}
  for (const [id, c] of Object.entries(restored.carry)) {
    if (c.session === sid) carry[id] = { since: c.since, newSince: c.newSince, gapFrom: c.gapFrom, gapTo: c.gapTo }
  }
  let until: number | undefined
  if (startedAt !== undefined) {
    // opens with no close, from a bridge that is no longer running
    const open = new Map<string, (typeof restored.events)[number]>()
    for (const e of restored.events) {
      if (e.event === 'open') open.set(occ(e), e)
      else open.delete(occ(e))
    }
    const ends = Object.entries(restored.ends).filter(([s]) => s !== sid).map(([, t]) => t)
    const lastEnd = ends.length ? Math.max(...ends) : null
    const first = new Map<string, (typeof restored.events)[number]>()
    for (const e of open.values()) {
      if (e.session === sid) continue
      if (carry[e.id] && carry[e.id].since === e.since) continue
      const f = first.get(e.id)
      if (!f || e.since < f.since) first.set(e.id, e)
    }
    for (const e of first.values()) {
      if (carry[e.id]?.newSince !== undefined) continue
      carry[e.id] = { since: e.since, gapFrom: lastEnd ?? e.last, gapTo: startedAt }
      until = startedAt + CARRY_WINDOW_S
    }
  }
  return {
    hello,
    alertLog: alertLog.length > MAX_ALERT_LOG ? alertLog.slice(-MAX_ALERT_LOG) : alertLog,
    alertCarry: Object.keys(carry).length ? carry : undefined,
    alertCarryUntil: until,
  }
}

export function reduceFsm(prev: MonitorState, frame: FsmFrame): Reduced {
  const events = frame.full ? [...frame.events] : [...prev.fsm.events, ...frame.events]
  const patch: Partial<MonitorState> = {
    fsm: {
      state: frame.state,
      since: frame.since,
      events: events.length > MAX_FSM_EVENTS ? events.slice(-MAX_FSM_EVENTS) : events,
      segments: frame.segments ?? (frame.full ? [] : prev.fsm.segments),
      segment: frame.segment,
    },
  }
  if (!frame.full) return { patch, persist: null }
  // after a replay seek the alert history is what the bridge says it is at the cursor (empty from a bridge that restarts its numbers)
  if (prev.replay) {
    patch.alertLog = (frame.alertHistory ?? []).slice(-MAX_ALERT_LOG)
    return { patch, persist: null }
  }
  // a live bridge sends the alerts of its own run: they join what was kept from before
  if (!frame.alertHistory || frame.alertHistory.length === 0) return { patch, persist: null }
  const startedAt = prev.hello?.session?.startedAt
  const r = remapEvents(frame.alertHistory, prev.alertCarry, startedAt)
  patch.alertLog = mergeLogs(prev.alertLog, r.events)
  if (r.changed) patch.alertCarry = r.carry
  return { patch, persist: { events: r.events, carry: r.changed ? (r.carry ?? null) : null } }
}

/**
 * Whether an aux frame must be drawn by itself. Usually the next robot frame draws it. With no robot frame for 100 ms (a silent
 * robot), or in a paused or seeking replay (a seek sends the robot frame first, then this one, and then nothing), nothing else would.
 */
export function auxNeedsDraw(msSinceRobotFrame: number, replay: { playing: boolean; busy: string | null } | null | undefined): boolean {
  if (msSinceRobotFrame > 100) return true
  return !!replay && (!replay.playing || replay.busy !== null)
}

export function reduceAux(prev: MonitorState, aux: AuxFrame): Reduced {
  const fsm = { ...prev.fsm, segment: aux.segment }
  const carry0 = prev.alertCarry
  const until = prev.alertCarryUntil
  // the common frame: nothing opened or closed, no carry to settle
  if (aux.alertEvents.length === 0 && (until === undefined || aux.t <= until)) return { patch: { aux, fsm }, persist: null }

  let alertLog = prev.alertLog
  let carry = carry0
  const persistEvents: AlertEvent[] = []
  let carryChanged = false
  const patch: Partial<MonitorState> = { aux, fsm }

  if (aux.alertEvents.length) {
    if (prev.replay) {
      // replay: the bridge numbers its own run, nothing is kept or carried
      alertLog = [...alertLog, ...aux.alertEvents]
      if (alertLog.length > MAX_ALERT_LOG) alertLog = alertLog.slice(-MAX_ALERT_LOG)
      return { patch: { ...patch, alertLog }, persist: null }
    }
    // live: an event the full fsm frame already brought is stored once
    const r = remapEvents(aux.alertEvents, carry, prev.hello?.session?.startedAt)
    carry = r.carry
    carryChanged = r.changed
    alertLog = mergeLogs(alertLog, r.events)
    persistEvents.push(...r.events)
  }

  if (until !== undefined && aux.t > until) {
    // the window is over: what the earlier session left open and the new one did not open again ended with that session
    const rest: Record<string, AlertCarry> = {}
    const closes: AlertEvent[] = []
    for (const [id, c] of Object.entries(carry ?? {})) {
      if (c.newSince !== undefined) {
        rest[id] = c
        continue
      }
      const open = alertLog.find((e) => e.event === 'open' && e.id === id && e.since === c.since)
      if (open) {
        const last = c.gapFrom !== null && c.gapFrom >= c.since ? c.gapFrom : open.last
        closes.push({ ...open, event: 'close', last, durationS: Math.round((last - c.since) * 1000) / 1000, earlier: true, endedByRestart: true })
      }
    }
    if (closes.length) {
      alertLog = mergeLogs(alertLog, closes)
      persistEvents.push(...closes)
    }
    carry = Object.keys(rest).length ? rest : undefined
    carryChanged = true
    patch.alertCarryUntil = undefined
  }

  patch.alertLog = alertLog
  if (carryChanged) patch.alertCarry = carry
  return { patch, persist: persistEvents.length || carryChanged ? { events: persistEvents, carry: carryChanged ? (carry ?? {}) : null } : null }
}
