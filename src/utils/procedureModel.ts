import type { MonitorSource, MonitorState, FsmEvent, FsmSegment } from '../types/monitor'
import type { AutoRule, ItemKind, LogRule, ProcItem, Procedure, References, Stage } from '../config/procedures/types'
import { SQUAT_LEAN_REF_DEG, SQUAT_LEAN_STOP_DEG } from '../config/alertPolicy'
import { currentRun } from './alertModel'
import { formatDataTime, statsSince, statsSinceNote } from './monitorFormat'

/**
 * Turns a procedure (data) and what the bridge reports into a result for every check. Pure, so scripts/check-procedures.mjs
 * can test it without a browser. Nothing here blocks or commands anything: a result is information for the operator.
 */

/**
 * `ok`: confirmed (within the manual's limit, the line was seen, or you ticked it). `stop`: a stop limit or abort line was
 * crossed. `check`: ROCO cannot tell, so a person must look. `pending`: nothing to judge yet. `skipped`: you marked it not
 * applicable.
 */
export type ItemStatus = 'ok' | 'stop' | 'check' | 'pending' | 'skipped'

export interface ItemResult {
  item: ProcItem
  status: ItemStatus
  /** Status in words, for the badge. Never colour alone. */
  word: string
  /** What was measured or seen, in one sentence. */
  detail: string | null
  /** Data time of the line or value that decided it. */
  t: number | null
  /** The operator confirmed it by hand (a `check` an auto or log item could not decide). */
  byYou: boolean
}

export interface StageCounts {
  ok: number
  stop: number
  check: number
  pending: number
  skipped: number
  /** Items that count towards "N of M confirmed": all but the skipped ones. */
  total: number
}

export interface StageResult {
  stage: Stage
  items: ItemResult[]
  counts: StageCounts
  done: boolean
  /** The stage's states include g1_ctrl's current state. */
  matchesState: boolean
}

export interface ProcedureResult {
  procedure: Procedure
  stages: StageResult[]
  counts: StageCounts
}

/** What the operator did with a procedure, kept by procedureStore. */
export interface ProcOps {
  ticked: ReadonlySet<string>
  skipped: ReadonlySet<string>
  /** Auto or log items the operator confirmed by hand after reading the data. */
  confirmed: ReadonlySet<string>
  /** Stage ids the operator marked done. */
  done: ReadonlySet<string>
  /** Replay only: what two checks that read the present moment already showed fine. Absent live and in tests that do not need it. */
  latch?: ReachedOk
}

/**
 * Two checks (rt/lowcmd rate, rt/lowstate gap) read the current moment, so a replay played past them flips them back to Waiting.
 * Once one read fine at data time t, a replay shows it fine ("Confirmed at t") until the cursor goes back before t. A stop limit
 * always shows. Held in memory only; it belongs to one g1_ctrl run of one recording.
 */
export interface ReachedOk {
  run: number | null
  at: Map<string, number>
}
export const newReachedOk = (): ReachedOk => ({ run: null, at: new Map() })

const EMPTY: ReadonlySet<string> = new Set()
export const NO_OPS: ProcOps = { ticked: EMPTY, skipped: EMPTY, confirmed: EMPTY, done: EMPTY }

const f1 = (n: number) => n.toFixed(1)
const f2 = (n: number) => n.toFixed(2)

interface Verdict {
  status: 'ok' | 'stop' | 'check' | 'pending'
  detail: string
  t?: number | null
}

interface Run {
  events: FsmEvent[]
  start: number | null
  state: MonitorState
}

/** Visits to one g1_ctrl state in the latest run, with the one in progress last. */
function visits(run: Run, name: string): FsmSegment[] {
  const { state, start } = run
  const out = state.fsm.segments.filter((s) => s.name === name && (start === null || s.t0 === null || s.t0 >= start))
  const now = state.fsm.segment
  if (now && now.name === name && state.fsm.state === name) out.push(now)
  return out
}

const sinceNote = (run: Run): string => statsSinceNote(run.state)

function autoVerdict(rule: AutoRule, run: Run, source: MonitorSource | null): Verdict {
  const { state, events } = run
  switch (rule.type) {
    case 'startTemps': {
      const e = [...events].reverse().find((x) => x.health?.kind === 'startTemps')
      const h = e?.health
      if (!e || h?.kind !== 'startTemps') return { status: 'pending', detail: 'No start-up temperature line yet. g1_ctrl logs it when it starts.' }
      if (h.maxC === null) return { status: 'check', detail: 'The start-up temperature line has no readings. Read it.', t: e.t }
      if (h.maxC >= rule.stopAtC) return { status: 'stop', detail: `A motor read ${h.maxC} °C at start (limit: below ${rule.stopAtC} °C).`, t: e.t }
      if (source === 'robot' && h.maxC === 0)
        return { status: 'stop', detail: 'Every start-up temperature reads 0 on the real robot. That is a placeholder, so the 80 °C stop would not see it.', t: e.t }
      return { status: 'ok', detail: `Hottest start-up reading ${h.maxC} °C over ${h.motors} motors.`, t: e.t }
    }
    case 'startMotorstate': {
      const e = [...events].reverse().find((x) => x.health?.kind === 'startMotorstate')
      const h = e?.health
      if (!e || h?.kind !== 'startMotorstate') return { status: 'pending', detail: 'No start-up motorstate line yet.' }
      if (h.nonzero.length === 0) return { status: 'ok', detail: `All ${h.motors} motorstate values are 0.`, t: e.t }
      return {
        status: 'check',
        detail: `${h.nonzero.length} of ${h.motors} motorstate values are not 0 (index ${h.nonzero.slice(0, 6).join(', ')}${h.nonzero.length > 6 ? ', …' : ''}). They must all be the same value: read the line.`,
        t: e.t,
      }
    }
    case 'policyInterval': {
      let worst: { ms: number; t: number; policy: string } | null = null
      let n = 0
      for (const e of events) {
        const h = e.health
        if (h?.kind !== 'policyTiming') continue
        n++
        if (!worst || h.intervalMaxMs > worst.ms) worst = { ms: h.intervalMaxMs, t: e.t, policy: h.policy }
      }
      if (!worst) return { status: 'pending', detail: 'No policy timing line yet. g1_ctrl logs it when a policy state ends.' }
      if (worst.ms > rule.stopMs) return { status: 'stop', detail: `${worst.policy} policy: step interval max ${f1(worst.ms)} ms (limit ${rule.stopMs}).`, t: worst.t }
      return { status: 'ok', detail: `Largest ${f1(worst.ms)} ms (${worst.policy}) over ${n} policy ${n === 1 ? 'visit' : 'visits'} in this run.`, t: worst.t }
    }
    case 'first2s': {
      let worst: { v: number; t: number; part: string } | null = null
      let n = 0
      for (const e of events) {
        const h = e.health
        if (h?.kind !== 'first2s' || h.state !== rule.state) continue
        n++
        for (const part of rule.parts) {
          const v =
            rule.measure === 'step' ? (part === 'legs' ? h.cmdStepLegs : h.cmdStepArms) : part === 'legs' ? h.speedLegs : h.speedArms
          if (!worst || v > worst.v) worst = { v, t: e.t, part }
        }
      }
      const unit = rule.measure === 'step' ? 'deg/tick' : 'rad/s'
      if (!worst) return { status: 'pending', detail: `No “first 2s in ${rule.state}” line yet. g1_ctrl prints it 2 s after entering the state.` }
      if (worst.v > rule.stop) return { status: 'stop', detail: `${worst.part} ${f2(worst.v)} ${unit} (limit ${rule.stop}).`, t: worst.t }
      return { status: 'ok', detail: `Largest ${f2(worst.v)} ${unit} (${worst.part})${n > 1 ? ` over ${n} visits` : ''}.`, t: worst.t }
    }
    case 'segment': {
      const v = visits(run, rule.state)
      if (v.length === 0) return { status: 'pending', detail: `No ${rule.state} visit${sinceNote(run) || ' in this run yet'}.` }
      const worst = v.reduce((a, b) => (b[rule.field] > a[rule.field] ? b : a))
      const val = worst[rule.field]
      const what = rule.field === 'tauAnkP' ? 'ankle pitch torque' : 'knee torque'
      if (val > rule.stop) return { status: 'stop', detail: `${what} reached ${f1(val)} Nm in ${rule.state} (limit ${rule.stop} Nm).`, t: worst.t0 }
      return { status: 'ok', detail: `Peak ${f1(val)} Nm over ${v.length} ${v.length === 1 ? 'visit' : 'visits'} (max over both sides)${sinceNote(run)}.`, t: worst.t0 }
    }
    case 'squatLean': {
      const v = visits(run, 'squat')
      if (v.length === 0) return { status: 'pending', detail: `No squat${sinceNote(run) || ' in this run yet'}.` }
      const lean = Math.max(...v.map((s) => s.tiltDeg[1]))
      if (lean > SQUAT_LEAN_STOP_DEG)
        return { status: 'stop', detail: `Body pitch reached ${f1(lean)}° (reference ${SQUAT_LEAN_REF_DEG}°; ROCO stops above ${SQUAT_LEAN_STOP_DEG}°).`, t: v[v.length - 1].t0 }
      if (lean > SQUAT_LEAN_REF_DEG)
        return { status: 'check', detail: `Body pitch reached ${f1(lean)}°, a little above ${SQUAT_LEAN_REF_DEG}°. The manual stops at “much more”${sinceNote(run)}.`, t: v[v.length - 1].t0 }
      return { status: 'ok', detail: `Body pitch peak ${f1(lean)}° (size only, not direction)${sinceNote(run)}.`, t: v[v.length - 1].t0 }
    }
    case 'legSpeed': {
      const segs = [...state.fsm.segments.filter((s) => s.name !== 'Passive' && (run.start === null || s.t0 === null || s.t0 >= run.start))]
      const now = state.fsm.segment
      if (now && state.fsm.state !== null && now.name === state.fsm.state && now.name !== 'Passive') segs.push(now)
      if (segs.length === 0) return { status: 'pending', detail: `No visit outside Passive${sinceNote(run) || ' in this run yet'}.` }
      const worst = segs.reduce((a, b) => (b.legDqMax > a.legDqMax ? b : a))
      if (worst.legDqMax >= rule.stop) return { status: 'stop', detail: `A leg joint reached ${f1(worst.legDqMax)} rad/s in ${worst.name} (limit ${rule.stop}).`, t: worst.t0 }
      return { status: 'ok', detail: `Fastest leg joint ${f1(worst.legDqMax)} rad/s (${worst.name})${sinceNote(run)}.`, t: worst.t0 }
    }
    case 'lowcmdRate': {
      const link = state.aux?.link
      if (!link || link.lowcmdHz <= 0) return { status: 'pending', detail: 'No rt/lowcmd right now.' }
      if (link.lowcmdHz > rule.stopHz) return { status: 'stop', detail: `rt/lowcmd arrives at ${Math.round(link.lowcmdHz)} Hz (limit ${rule.stopHz}): a second program is probably sending.`, t: state.aux?.t ?? null }
      return { status: 'ok', detail: `rt/lowcmd at ${Math.round(link.lowcmdHz)} Hz.`, t: state.aux?.t ?? null }
    }
    case 'lowstateGap': {
      const link = state.aux?.link
      if (!link || link.lowstateCount === 0) return { status: 'pending', detail: 'No rt/lowstate yet.' }
      const g = link.lowstateGapMaxMs
      if (g >= rule.stopMs) return { status: 'stop', detail: `Longest rt/lowstate gap ${Math.round(g)} ms (the lost-state stop trips at 200 ms).`, t: state.aux?.t ?? null }
      if (g >= rule.watchMs) return { status: 'check', detail: `Longest rt/lowstate gap ${Math.round(g)} ms. Check the cable and close other programs.`, t: state.aux?.t ?? null }
      return { status: 'ok', detail: `Longest rt/lowstate gap ${Math.round(g)} ms.`, t: state.aux?.t ?? null }
    }
    case 'squatCount': {
      const n = visits(run, 'squat').length
      if (n === 0) return { status: 'pending', detail: `No squat${sinceNote(run) || ' in this run yet'}.` }
      // "about 5" is a session limit, not an abort condition: it asks for a look, it does not trip
      if (n > rule.about) return { status: 'check', detail: `${n} squats${sinceNote(run) || ' in this run'}; the manual limits a session to about ${rule.about}.` }
      return { status: 'ok', detail: `${n} of about ${rule.about} squats${sinceNote(run) || ' in this run'}.` }
    }
  }
}

function logVerdict(rule: LogRule, run: Run): Verdict {
  const { events } = run
  // lines that carry numbers, state changes and our own parsing are not "log lines" for these checks, except state changes
  // which the `seen` patterns look for by their text
  const stopLevels = rule.stopLevels ?? []
  if (rule.stop || stopLevels.length) {
    for (const e of events) {
      if (e.health) continue
      if ((rule.stop && rule.stop.test(e.text)) || stopLevels.includes(e.level)) return { status: 'stop', detail: `Log: ${e.text}`, t: e.t }
    }
  }
  if (rule.seen) {
    const e = events.find((x) => rule.seen!.test(x.text))
    if (e) return { status: 'ok', detail: `Seen: ${e.text}`, t: e.t }
    return { status: 'pending', detail: events.length === 0 ? 'No g1_ctrl log line has reached ROCO yet.' : 'Not seen in this run yet.' }
  }
  if (rule.okWhenNone) {
    if (events.length === 0) return { status: 'pending', detail: 'No g1_ctrl log line has reached ROCO yet, so this cannot be checked.' }
    return { status: 'ok', detail: 'None seen in the log lines ROCO has.' }
  }
  return { status: 'pending', detail: 'Not seen yet.' }
}

/** Measured checks whose numbers come from the bridge's visits: when those start after the recording does, say from when. */
const SINCE_RULES: ReadonlySet<string> = new Set(['segment', 'squatLean', 'legSpeed', 'squatCount'])

export function statusWord(kind: ItemKind, status: ItemStatus, byYou: boolean, rule?: LogRule, since = ''): string {
  switch (status) {
    case 'ok':
      if (byYou) return 'Checked by you'
      if (kind === 'auto' && since) return `Within limit ${since}`
      return kind === 'manual' ? 'Ticked' : kind === 'log' ? (rule?.seen ? 'Seen' : 'None seen') : 'Within limit'
    case 'stop':
      return kind === 'log' ? 'Abort line seen' : 'Stop limit crossed'
    case 'check':
      return 'Check'
    case 'pending':
      return kind === 'manual' ? 'Not ticked' : 'Waiting for data'
    case 'skipped':
      return 'Skipped'
  }
}

const LATCHED_RULES: ReadonlySet<string> = new Set(['lowcmdRate', 'lowstateGap'])

function latched(id: string, type: string, v: Verdict, runStart: number | null, state: MonitorState, latch?: ReachedOk): Verdict {
  const r = state.replay
  if (!latch || !r || !LATCHED_RULES.has(type)) return v
  if (latch.run !== runStart) {
    latch.at.clear()
    latch.run = runStart
  }
  // a seek back before the moment it was confirmed: that moment has not happened yet
  const at = latch.at.get(id)
  if (at !== undefined && at > r.t) latch.at.delete(id)
  if (v.status === 'ok') {
    if (!latch.at.has(id)) latch.at.set(id, v.t ?? r.t)
    return v
  }
  const seen = latch.at.get(id)
  if (v.status === 'pending' && seen !== undefined)
    return { status: 'ok', detail: `Confirmed at ${formatDataTime(seen, state)}; now: ${v.detail}`, t: seen }
  return v
}

export function evaluateItem(item: ProcItem, state: MonitorState, ops: ProcOps): ItemResult {
  const cur = currentRun(state.fsm.events)
  const run: Run = { events: cur.run, start: cur.start, state }
  const source = state.hello?.source ?? null
  const since = item.kind === 'auto' && item.auto && SINCE_RULES.has(item.auto.type) ? statsSince(state) : ''
  const make = (status: ItemStatus, detail: string | null, t: number | null, byYou = false): ItemResult => ({
    item,
    status,
    word: statusWord(item.kind, status, byYou, item.log, since),
    detail,
    t,
    byYou,
  })
  if (item.kind === 'manual') {
    if (ops.skipped.has(item.id)) return make('skipped', 'You marked this as not applicable.', null)
    return ops.ticked.has(item.id) ? make('ok', null, null) : make('pending', null, null)
  }

  let v: Verdict
  if (item.kind === 'auto' && item.auto) v = autoVerdict(item.auto, run, source)
  else if (item.kind === 'log' && item.log) v = logVerdict(item.log, run)
  else v = { status: 'pending', detail: 'This check has no rule.' }
  if (item.kind === 'auto' && item.auto) v = latched(item.id, item.auto.type, v, cur.start, state, ops.latch)

  // a stop limit stays visible whatever the operator did: "not applicable" and "I checked this" never hide one
  if (v.status === 'stop') return make('stop', v.detail, v.t ?? null)
  if (ops.skipped.has(item.id)) return make('skipped', 'You marked this as not applicable.', null)
  // a person may confirm what ROCO could not decide
  if (ops.confirmed.has(item.id) && (v.status === 'check' || v.status === 'pending')) return make('ok', v.detail, v.t ?? null, true)
  return make(v.status, v.detail, v.t ?? null)
}

function countOf(results: ItemResult[]): StageCounts {
  const c: StageCounts = { ok: 0, stop: 0, check: 0, pending: 0, skipped: 0, total: 0 }
  for (const r of results) c[r.status]++
  c.total = results.length - c.skipped
  return c
}

export function evaluateProcedure(procedure: Procedure, state: MonitorState, ops: ProcOps): ProcedureResult {
  const fsmState = state.fsm.state
  const stages: StageResult[] = procedure.stages.map((stage) => {
    const items = stage.items.map((it) => evaluateItem(it, state, ops))
    return {
      stage,
      items,
      counts: countOf(items),
      done: ops.done.has(stage.id),
      matchesState: fsmState !== null && (stage.states?.includes(fsmState) ?? false),
    }
  })
  return { procedure, stages, counts: countOf(stages.flatMap((s) => s.items)) }
}

export type ManualStatus = 'match' | 'changed' | 'missing' | 'unknown'

/** Does the manual the bridge can read match the one this procedure was written from? */
export function manualStatus(procedure: Procedure, state: MonitorState): { status: ManualStatus; found: string | null } {
  const hello = state.hello
  if (!hello) return { status: 'unknown', found: null }
  if (hello.manual === undefined) return { status: 'unknown', found: null }
  if (hello.manual === null) return { status: 'missing', found: null }
  return {
    status: hello.manual.sha256 === procedure.manual.sha256 ? 'match' : 'changed',
    found: hello.manual.sha256,
  }
}

export interface ShownReference {
  label: string
  text: string
}

/**
 * The reference values to show next to a check. A simulator value is shown only for the simulator, and the real robot's value
 * only for the robot, because the two differ a lot. A replay does not say which it was, so both are shown, labelled.
 */
export function referencesFor(refs: References | undefined, source: MonitorSource | null): ShownReference[] {
  if (!refs) return []
  const sim: ShownReference | null = refs.sim ? { label: 'Simulator', text: refs.sim } : null
  const real: ShownReference | null = refs.real ? { label: 'Real robot', text: refs.real } : null
  if (source === 'sim') return sim ? [sim] : []
  if (source === 'robot') {
    if (real) return [real]
    return sim ? [{ label: 'Real robot', text: 'No real-robot reference in the manual yet. The simulator figure is not shown here because the two differ.' }] : []
  }
  return [sim, real].filter((r): r is ShownReference => r !== null)
}

/** The first stage whose states cover g1_ctrl's current one and that the operator has not marked done, or null. */
export function suggestStage(result: ProcedureResult, fsmState: string | null): StageResult | null {
  if (fsmState === null) return null
  const fits = result.stages.filter((s) => s.matchesState)
  return fits.find((s) => !s.done) ?? fits[0] ?? null
}
