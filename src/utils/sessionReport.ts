import type { FsmSegment, MonitorState } from '../types/monitor'
import { FALLBACK_RESPONSE, RESPONSES } from '../config/alertPolicy'
import type { AbortCheck } from './alertModel'
import { KIND_LABEL, SOURCE_LABEL, formatDataTime, formatDuration, sourceBadge } from './monitorFormat'
import { manualStatus, statusWord, type ProcedureResult } from './procedureModel'
import { levelWord, timelineRows, type TimelineAlert, type TimelineModel } from './timelineModel'

/**
 * The session as Markdown, laid out like the hardware test reports (summary, setup, timeline, per-state numbers, checks, alerts,
 * notes), so it can be pasted into one. It lists what ROCO saw. It is not a clearance: ROCO cannot see the rope, the spotter or the room.
 */

export interface ReportInput {
  state: MonitorState
  /** Display name of the robot profile. */
  profileName: string
  generatedAt: Date
  timeline: TimelineModel
  /** Name of an alert for the report (joint names come from the active profile). */
  alertTitle: (a: TimelineAlert) => string
  abortChecks: AbortCheck[]
  procedure: ProcedureResult | null
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()
const row = (...cells: string[]): string => `| ${cells.map(cell).join(' | ')} |`
const table = (head: string[], rows: string[][]): string[] => [row(...head), row(...head.map(() => '---')), ...rows.map((r) => row(...r))]

function segmentRows(state: MonitorState): { name: string; at: string; cells: string[] }[] {
  const segs: (FsmSegment & { current?: boolean })[] = [...state.fsm.segments]
  if (state.fsm.segment && state.fsm.segment.samples >= 5) segs.push({ ...state.fsm.segment, current: true })
  return segs.map((g) => ({
    name: g.name + (g.current ? ' (now)' : ''),
    at: g.t0 === null ? 'start' : formatDataTime(g.t0, state),
    cells: [
      `${g.durS.toFixed(1)} s`,
      `${g.ankPitchDemandMax.toFixed(1)} Nm ${g.ankPitchDemandPct.toFixed(0)}%`,
      `${g.overMs.toFixed(0)} ms (${g.overRunMs.toFixed(0)})`,
      `${g.tauAnkP.toFixed(1)} / ${g.tauAnkR.toFixed(1)} / ${g.tauKnee.toFixed(1)}`,
      `${g.legErrMaxDeg.toFixed(1)}°`,
      g.legDqMax.toFixed(2),
      `${g.tiltDeg[0].toFixed(1)}° / ${g.tiltDeg[1].toFixed(1)}°`,
      g.gyroMax.toFixed(2),
    ],
  }))
}

const MANUAL_NOTE = {
  match: 'matches the manual this procedure was written for',
  changed: 'DIFFERS from the manual this procedure was written for: check the procedure against the manual before relying on it',
  missing: 'the bridge could not read the manual on this machine',
  unknown: 'not reported (older bridge)',
}

export function buildReport(input: ReportInput): string {
  const { state, timeline, procedure } = input
  const hello = state.hello
  const fmt = (t: number) => formatDataTime(t, state)
  const out: string[] = []
  const badge = sourceBadge(state) ?? 'no source'
  const day = input.generatedAt.toLocaleDateString('sv')

  out.push(`# ROCO session report: ${badge}, ${day}`, '')
  out.push(
    'Written by ROCO from what the read-only bridge showed. It lists what was seen; it is not a clearance. ROCO cannot see the rope, ' +
      'the spotter or the room, and "within limit" or "none seen" is not "safe to continue".',
    '',
  )

  // 1. Summary
  const visited = timeline.spans.filter((s) => s.state !== null).map((s) => s.state as string)
  const path = visited.filter((s, i) => i === 0 || s !== visited[i - 1])
  const alerts = timeline.alerts
  const count = (l: string) => alerts.filter((a) => a.level === l).length
  const tripped = input.abortChecks.filter((c) => c.status === 'trip')
  out.push('## 1. Summary', '')
  out.push(`- Source: ${SOURCE_LABEL[hello?.source ?? ''] ?? 'unknown'}${state.replay ? ` (${state.replay.file})` : ''}`)
  out.push(`- Data from ${fmt(timeline.t0)} to ${fmt(timeline.t1)} (${formatDuration(timeline.t1 - timeline.t0)})${state.replay && timeline.playedTo !== null && timeline.playedTo < timeline.t1 - 0.5 ? `; played to ${fmt(timeline.playedTo)}` : ''}`)
  out.push(`- g1_ctrl states: ${path.length ? path.join(' → ') : 'none seen'}`)
  out.push(`- Alerts: ${count('critical')} critical, ${count('warn')} warning, ${count('info')} info`)
  out.push(
    tripped.length
      ? `- Abort checks tripped: ${tripped.map((c) => c.label).join('; ')}`
      : '- Abort checks tripped: none seen (this is not "safe": ROCO sees only what the bridge sends)',
  )
  if (procedure) {
    out.push(`- Guided checks (${procedure.procedure.title}): ${procedure.counts.ok} of ${procedure.counts.total} confirmed${procedure.counts.stop ? `, ${procedure.counts.stop} stop limit${procedure.counts.stop > 1 ? 's' : ''} crossed` : ''}`)
  }
  out.push(`- Marks: ${timeline.marks.length}`, '')

  // 2. Setup
  out.push('## 2. Setup', '')
  const setup: string[][] = [['Source', badge]]
  if (hello) {
    setup.push(['Bridge', `${hello.bridge}, protocol ${hello.protocol}, ${hello.rateHz} Hz, read-only`])
    setup.push(['Robot', `${input.profileName}, mode_machine ${hello.modeMachine ?? hello.limits.modeMachine ?? 'unknown'}${hello.limits.lockedJoints.length ? `, locked motors ${hello.limits.lockedJoints.join('/')}` : ''}`])
    if (hello.limits.ctrlConfig) setup.push(['Controller config', hello.limits.ctrlConfig])
    if (hello.limits.model) setup.push(['Robot model', hello.limits.model])
    if (hello.replay) setup.push(['Recording', `${hello.replay.file} in ${hello.replay.store}`])
  }
  if (procedure) {
    const m = manualStatus(procedure.procedure, state)
    setup.push(['Procedure', procedure.procedure.title])
    setup.push(['Test manual', `${hello?.manual ? `${hello.manual.file}, SHA-256 ${hello.manual.sha256.slice(0, 12)}…` : 'not read'}: ${MANUAL_NOTE[m.status]}`])
  }
  setup.push(['Report made', input.generatedAt.toISOString()])
  out.push(...table(['Item', 'Value'], setup), '')

  // 3. Timeline
  const rows = timelineRows(timeline, input.alertTitle, formatDuration)
  out.push('## 3. Timeline', '')
  out.push(...(rows.length ? table([state.replay ? 'Time (s into the recording)' : 'Time', 'What'], rows.map((r) => [formatDataTime(r.t, state).replace(' s', ''), r.text])) : ['Nothing on the timeline yet.']), '')

  // 4. Per state
  const segs = segmentRows(state)
  out.push('## 4. Per state (as real_log.py)', '')
  if (segs.length === 0) out.push('No samples yet.', '')
  else {
    out.push(
      ...table(
        ['State', 'At', 'Dur', 'Ank P demand', `>${hello?.limits.ankleMotorPeak ?? 24.8} Nm (longest)`, 'τ ankP / ankR / knee', 'Leg err', 'Leg dq', 'Tilt r / p', 'Gyro'],
        segs.map((g) => [g.name, g.at, ...g.cells]),
      ),
      '',
      'Torques in Nm, leg dq and gyro in rad/s. Ankle demand is the larger of the two ankle pitch joints, compared with one ankle motor\'s peak (each ankle joint has two motors).',
      '',
    )
  }

  // 5. Guided checks
  if (procedure) {
    out.push('## 5. Guided checks', '')
    out.push('Status words: Ticked, Seen, None seen, Within limit and Checked by you are what the person or the data showed. Stop limit crossed and Abort line seen are the manual\'s own fail lines.', '')
    for (const st of procedure.stages) {
      const items = st.items
      if (items.length === 0) continue
      out.push(`### ${st.stage.id}: ${st.stage.title}${st.done ? ' (marked done by the operator)' : ''}`, '')
      out.push(...table(['Check', 'Status', 'Seen', 'Manual'], items.map((r) => [r.item.text, r.word || statusWord(r.item.kind, r.status, r.byYou, r.item.log), r.detail ?? '', r.item.ref])), '')
    }
  }

  // 6. Abort checks
  out.push(`## ${procedure ? 6 : 5}. Abort checks (manual section 3)`, '')
  out.push(...table(['Check', 'Result', 'Detail'], input.abortChecks.map((c) => [c.label, c.status === 'trip' ? 'TRIPPED' : c.status === 'watch' ? 'Watch' : c.status === 'ok' ? 'Not tripped' : c.status === 'idle' ? 'Not in use' : 'Unknown', c.detail])), '')

  // 7. Alerts
  out.push(`## ${procedure ? 7 : 6}. Alerts`, '')
  if (alerts.length === 0) out.push('No alerts in this session.', '')
  else {
    out.push(
      ...table(
        ['Opened', 'Level', 'Alert', 'Open for', 'Do'],
        alerts.map((a) => {
          const r = RESPONSES[a.kind] ?? FALLBACK_RESPONSE
          return [fmt(a.t), levelWord(a.level), input.alertTitle(a) || KIND_LABEL[a.kind] || a.kind, a.until !== null ? formatDuration(a.until - a.t) : 'still open', `${a.level === 'critical' ? r.critical : r.warn} (${r.ref})`]
        }),
      ),
      '',
    )
  }

  // 8. Marks
  out.push(`## ${procedure ? 8 : 7}. Operator marks`, '')
  if (timeline.marks.length === 0) out.push('No marks.', '')
  else out.push(...table(['#', 'Time', 'Note'], timeline.marks.map((m, n) => [String(n + 1), fmt(m.t), m.note || '(no note)'])), '')

  out.push('---', '', 'Reference values in the guided checks are labelled sim or robot. A simulator value is not the robot\'s expectation.', '')
  return out.join('\n')
}
