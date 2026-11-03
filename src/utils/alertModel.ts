import type { AlertLevel, FsmEvent, FsmSegment, MonitorAlert, MonitorState } from '../types/monitor'
import {
  ABORT_LOG_LEVELS,
  ABORT_LOG_PATTERNS,
  BURST_GAP_S,
  FALLBACK_RESPONSE,
  FOLLOW_PASSIVE_S,
  RESPONSES,
  SEVERITY_RULES,
  SQUAT_LEAN_REF_DEG,
  SQUAT_LEAN_STOP_DEG,
  STEP_INTERVAL_STOP_MS,
  type EffectiveLevel,
  type SeverityRule,
} from '../config/alertPolicy'

/**
 * How the page presents the bridge's alerts: which one came first, which follow a change into Passive, what to do about each,
 * and which are expected in the current g1_ctrl state. Pure functions of the monitor state, so they can be checked without a
 * browser (scripts/check-alerts.mjs). Nothing here changes what the bridge raises or logs.
 */

/** One entry of the g1_ctrl state timeline. A new g1_ctrl run ("Config:" line) starts in Passive. */
export interface StateChange {
  t: number
  from: string | null
  to: string
  session: boolean
}

export function stateChanges(events: FsmEvent[]): StateChange[] {
  const out: StateChange[] = []
  for (const e of events) {
    if (e.to) out.push({ t: e.t, from: e.from ?? null, to: e.to, session: false })
    else if (e.session) out.push({ t: e.t, from: null, to: 'Passive', session: true })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** The g1_ctrl state at data time `t`, or null when the log does not reach back that far. */
export function stateAt(t: number, changes: StateChange[], current: string | null): string | null {
  if (changes.length === 0) return current
  let s: string | null = changes[0].from
  for (const c of changes) {
    if (c.t <= t) s = c.to
    else break
  }
  return s
}

/** A change into Passive that the rest of the alerts may be a consequence of. */
export interface PassiveChange {
  t: number
  from: string | null
  /** The g1_ctrl log line that explains it (an abort key, a safety stop), when one was logged next to it. */
  reason: string | null
}

const REASON_BEFORE_S = 1
const REASON_AFTER_S = 0.2
const CHANGE_TOLERANCE_S = 0.1

function passiveChanges(changes: StateChange[], events: FsmEvent[]): PassiveChange[] {
  const out: PassiveChange[] = []
  for (const c of changes) {
    if (c.session || c.to !== 'Passive' || c.from === 'Passive') continue
    const why = events.find(
      (e) =>
        !e.to &&
        !e.health &&
        (e.level === 'warning' || e.level === 'error' || e.level === 'critical') &&
        e.t >= c.t - REASON_BEFORE_S &&
        e.t <= c.t + REASON_AFTER_S
    )
    out.push({ t: c.t, from: c.from, reason: why ? why.text : null })
  }
  return out
}

export interface AlertItem {
  /** One occurrence: the alert id plus when it opened. A new occurrence after a close is a new item. */
  key: string
  alert: MonitorAlert
  active: boolean
  /** The level to show, after the severity rules. Cleared alerts show the highest level they reached. */
  level: EffectiveLevel
  /** The bridge's own level, before any rule. */
  rawLevel: AlertLevel
  rule: SeverityRule | null
  /** g1_ctrl state when the alert was last seen. */
  state: string | null
  response: string
  ref: string
  follows: PassiveChange | null
  acknowledged: boolean
  shelved: boolean
  durationS?: number
}

export interface AlertGroup {
  /** The first-out's key. */
  id: string
  first: AlertItem
  /** Everything that opened after it in the same burst, oldest first. */
  rest: AlertItem[]
  /** Set when the first-out itself follows a change into Passive: the change is the cause to read first. */
  cause: PassiveChange | null
  level: EffectiveLevel
  /** Active members that are not acknowledged yet. */
  unacknowledged: number
}

export interface AlertCounts {
  critical: number
  warn: number
  /** Lowered by a severity rule: listed, not counted as a warning. */
  info: number
  /** Warnings the operator shelved. Critical alerts cannot be shelved. */
  shelved: number
  /** Of the counted ones, how many opened after a change into Passive. */
  followOn: number
  unacknowledged: number
}

export interface AlertView {
  groups: AlertGroup[]
  info: AlertItem[]
  shelved: AlertItem[]
  counts: AlertCounts
  /** The first-out of the group to read first (most severe, then newest). */
  firstOut: AlertItem | null
  /** Cleared alerts, newest first, as they were shown. */
  closed: AlertItem[]
}

export interface AlertControls {
  /** Occurrence keys the operator has marked as seen. */
  acked: ReadonlySet<string>
  /** Alert ids (not occurrences) the operator shelved for this session. */
  shelved: ReadonlySet<string>
}

export const NO_CONTROLS: AlertControls = { acked: new Set(), shelved: new Set() }

export const occurrenceKey = (a: { id: string; since: number }): string => `${a.id}@${a.since}`

const RANK: Record<EffectiveLevel, number> = { info: 0, warn: 1, critical: 2 }

function applyRules(
  raw: AlertLevel,
  a: MonitorAlert,
  state: string | null,
  jointNames: string[]
): { level: EffectiveLevel; rule: SeverityRule | null } {
  if (state) {
    const name = a.joint !== null ? (jointNames[a.joint] ?? '').toLowerCase() : ''
    for (const r of SEVERITY_RULES) {
      if (r.kind !== a.kind || raw !== r.from || !r.states.includes(state)) continue
      if (r.joint && !name.includes(r.joint)) continue
      return { level: 'info', rule: r }
    }
  }
  return { level: raw, rule: null }
}

function buildItem(
  a: MonitorAlert,
  active: boolean,
  durationS: number | undefined,
  changes: StateChange[],
  passive: PassiveChange[],
  currentState: string | null,
  jointNames: string[],
  controls: AlertControls
): AlertItem {
  const state = stateAt(a.last, changes, currentState)
  // an active alert shows how it is now; a cleared one shows the worst it reached
  const raw = active ? a.level : a.peakLevel
  const { level, rule } = applyRules(raw, a, state, jointNames)
  const r = RESPONSES[a.kind] ?? FALLBACK_RESPONSE
  const key = occurrenceKey(a)

  // follows the latest change into Passive that happened before this alert opened and before the next state change
  let follows: PassiveChange | null = null
  for (const p of passive) {
    if (p.t - CHANGE_TOLERANCE_S > a.since) break
    if (a.since - p.t > FOLLOW_PASSIVE_S) continue
    const next = changes.find((c) => c.t > p.t + CHANGE_TOLERANCE_S)
    if (next && next.t <= a.since - CHANGE_TOLERANCE_S) continue
    follows = p
  }
  return {
    key,
    alert: a,
    active,
    level,
    rawLevel: raw,
    rule,
    state,
    response: level === 'critical' ? r.critical : r.warn,
    ref: r.ref,
    follows,
    acknowledged: controls.acked.has(key),
    shelved: level === 'warn' && controls.shelved.has(a.id),
    durationS,
  }
}

/** Alerts of one session in the order they opened, with first-out, grouping and the severity rules applied. */
export function buildAlertView(state: MonitorState, controls: AlertControls = NO_CONTROLS): AlertView {
  const jointNames = state.hello?.limits.jointNames ?? []
  const changes = stateChanges(state.fsm.events)
  const passive = passiveChanges(changes, state.fsm.events)
  const activeList = state.aux?.alerts ?? []

  const items = new Map<string, AlertItem>()
  const make = (a: MonitorAlert, active: boolean, dur?: number) =>
    buildItem(a, active, dur, changes, passive, state.fsm.state, jointNames, controls)
  // log first (open then close events), then the live alerts override: they are the current truth
  for (const e of state.alertLog) {
    const k = occurrenceKey(e)
    if (e.event === 'close') items.set(k, make(e, false, e.durationS))
    else if (!items.has(k)) items.set(k, make(e, true))
  }
  const activeKeys = new Set<string>()
  for (const a of activeList) {
    activeKeys.add(occurrenceKey(a))
    items.set(occurrenceKey(a), make(a, true))
  }
  // an open event with no matching live alert and no close has been lost (a seek, a trimmed log): it is not active
  for (const [k, it] of items) {
    if (it.active && !activeKeys.has(k)) items.set(k, { ...it, active: false })
  }

  // alerts that open in the same frame share a time: the key breaks the tie so the first-out never swaps between renders
  const all = [...items.values()].sort((a, b) => a.alert.since - b.alert.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const shown = all.filter((i) => i.level !== 'info' && !i.shelved)

  // bursts: each alert within BURST_GAP_S of the previous one joins it. The first of a burst is the first-out.
  const bursts: AlertItem[][] = []
  for (const it of shown) {
    const cur = bursts[bursts.length - 1]
    if (cur && it.alert.since - cur[cur.length - 1].alert.since <= BURST_GAP_S) cur.push(it)
    else bursts.push([it])
  }
  const groups: AlertGroup[] = []
  for (const b of bursts) {
    const live = b.filter((i) => i.active)
    if (live.length === 0) continue
    const level = live.reduce<EffectiveLevel>((m, i) => (RANK[i.level] > RANK[m] ? i.level : m), 'info')
    groups.push({
      id: b[0].key,
      first: b[0],
      rest: b.slice(1),
      cause: b[0].follows,
      level,
      unacknowledged: live.filter((i) => !i.acknowledged).length,
    })
  }
  groups.sort((a, b) => RANK[b.level] - RANK[a.level] || b.first.alert.since - a.first.alert.since)

  const live = shown.filter((i) => i.active)
  const counts: AlertCounts = {
    critical: live.filter((i) => i.level === 'critical').length,
    warn: live.filter((i) => i.level === 'warn').length,
    info: all.filter((i) => i.active && i.level === 'info').length,
    shelved: all.filter((i) => i.active && i.shelved).length,
    followOn: live.filter((i) => i.follows !== null).length,
    unacknowledged: live.filter((i) => !i.acknowledged).length,
  }
  return {
    groups,
    info: all.filter((i) => i.active && i.level === 'info'),
    shelved: all.filter((i) => i.active && i.shelved),
    counts,
    firstOut: groups[0]?.first ?? null,
    closed: all
      .filter((i) => !i.active)
      .slice(-50)
      .reverse(),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Manual section 3 abort criteria, as named checks
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `trip`: the manual's limit was crossed. `watch`: past the reference but not past a stop limit (not counted as a trip).
 * `ok` only means not seen: ROCO cannot see the robot, the rope or the spotter.
 */
export type CheckStatus = 'ok' | 'watch' | 'trip' | 'idle' | 'unknown'

export interface AbortCheck {
  id: string
  label: string
  ref: string
  status: CheckStatus
  detail: string
  /** Data time of the line or segment that tripped it. */
  t: number | null
  /** Occurrence key, so a trip can be acknowledged. Empty unless tripped. */
  key: string
  acknowledged: boolean
}

/** The events of the latest g1_ctrl run: from its "Config:" line on, or all of them when no run start was seen. */
export function currentRun(events: FsmEvent[]): { run: FsmEvent[]; start: number | null } {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].session) return { run: events.slice(i), start: events[i].t }
  }
  return { run: events, start: null }
}

const fmt = (n: number, d = 1) => n.toFixed(d)

export function evaluateAbortChecks(state: MonitorState, controls: AlertControls = NO_CONTROLS): AbortCheck[] {
  const { run, start } = currentRun(state.fsm.events)
  const noLog = state.fsm.events.length === 0 && state.fsm.state === null
  const ack = (key: string) => controls.acked.has(key)

  // 1. policy step interval
  let worst: { ms: number; t: number; policy: string } | null = null
  let timings = 0
  for (const e of run) {
    const h = e.health
    if (h?.kind !== 'policyTiming') continue
    timings++
    if (!worst || h.intervalMaxMs > worst.ms) worst = { ms: h.intervalMaxMs, t: e.t, policy: h.policy }
  }
  const stepKey = worst && worst.ms > STEP_INTERVAL_STOP_MS ? `step-interval@${worst.t}` : ''
  const step: AbortCheck = {
    id: 'step-interval',
    label: `Policy step interval at most ${STEP_INTERVAL_STOP_MS} ms`,
    ref: '§3',
    status: !worst ? 'unknown' : worst.ms > STEP_INTERVAL_STOP_MS ? 'trip' : 'ok',
    detail: !worst
      ? 'No policy timing line yet. g1_ctrl logs it when a policy state ends.'
      : worst.ms > STEP_INTERVAL_STOP_MS
      ? `${worst.policy} policy: step interval max ${fmt(worst.ms)} ms. Stop and investigate.`
      : `Largest so far ${fmt(worst.ms)} ms (${worst.policy}), over ${timings} policy ${timings === 1 ? 'visit' : 'visits'}.`,
    t: stepKey && worst ? worst.t : null,
    key: stepKey,
    acknowledged: ack(stepKey),
  }

  // 2. abort lines in the g1_ctrl log
  let hit: { t: number; label: string; text: string } | null = null
  let hits = 0
  for (const e of run) {
    if (e.health || e.to) continue
    let label: string | null = ABORT_LOG_LEVELS.includes(e.level) ? e.level : null
    if (!label) label = ABORT_LOG_PATTERNS.find((p) => p.re.test(e.text))?.label ?? null
    if (!label) continue
    hits++
    if (!hit) hit = { t: e.t, label, text: e.text }
  }
  const logKey = hit ? `log-lines@${hit.t}` : ''
  const lines: AbortCheck = {
    id: 'log-lines',
    label: 'No abort line in the g1_ctrl log',
    ref: '§3',
    status: hit ? 'trip' : noLog ? 'unknown' : 'ok',
    detail: hit
      ? `${hit.label}: ${hit.text}${hits > 1 ? ` (and ${hits - 1} more)` : ''}`
      : noLog
      ? 'No g1_ctrl log line has reached ROCO yet, so this cannot be checked.'
      : 'None of SAFETY STOP, no robot state, motor temperature, motorstate, critical or error seen in the log lines ROCO has.',
    t: hit ? hit.t : null,
    key: logKey,
    acknowledged: ack(logKey),
  }

  // 3. torso lean in the squat
  const visits: FsmSegment[] = state.fsm.segments.filter((s) => s.name === 'squat' && (start === null || s.t0 === null || s.t0 >= start))
  const now = state.fsm.segment
  const inSquat = now !== null && now.name === 'squat' && state.fsm.state === 'squat'
  if (inSquat) visits.push(now)
  const lean = visits.length ? Math.max(...visits.map((s) => s.tiltDeg[1])) : null
  const leanT = visits.length ? visits[visits.length - 1].t0 : null
  const leanKey = lean !== null && lean > SQUAT_LEAN_STOP_DEG && leanT !== null ? `squat-lean@${leanT}` : ''
  const squat: AbortCheck = {
    id: 'squat-lean',
    label: `Torso lean in the squat about ${SQUAT_LEAN_REF_DEG}° at most`,
    ref: '§3, T6',
    status: lean === null ? 'idle' : lean > SQUAT_LEAN_STOP_DEG ? 'trip' : lean > SQUAT_LEAN_REF_DEG ? 'watch' : 'ok',
    detail:
      lean === null
        ? 'No squat in this run yet.'
        : lean > SQUAT_LEAN_STOP_DEG
        ? `Body pitch reached ${fmt(lean)}° (reference 12 to 13°, either direction). The manual says stop if it is much more.`
        : lean > SQUAT_LEAN_REF_DEG
        ? `Body pitch reached ${fmt(lean)}°, a little above the reference of 12 to 13°. The manual stops at "much more"; ROCO trips above ${SQUAT_LEAN_STOP_DEG}°.`
        : `Body pitch peak ${fmt(lean)}° (reference 12 to 13°)${inSquat ? ', squat in progress' : ''}.`,
    t: leanKey ? leanT : null,
    key: leanKey,
    acknowledged: ack(leanKey),
  }
  return [step, lines, squat]
}
