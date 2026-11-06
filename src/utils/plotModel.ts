import type { RobotProfile } from '../config/robotRegistry'
import { MAX_JOINTS_PER_PANEL, type PanelKind, type PanelSpec, type PlotSet } from '../config/plotSets'
import { PLOT_SLOTS, type PlotRing } from '../services/plotRing'

/**
 * Turns a plot set into the lines a panel draws, and reads their values from the plot history. Pure, so the choices
 * (which joints, how many lines, what is dashed) are checked without a browser (scripts/check-timeline.mjs).
 */

export type Measure = 'q' | 'qCmd' | 'tau' | 'demand' | 'roll' | 'pitch'

const RAD2DEG = 180 / Math.PI

/** Plain name first, the name used in the controller and the logs after it. */
export const MEASURE_LABEL: Record<Measure, string> = {
  q: 'angle (q)',
  qCmd: 'target angle (q_cmd)',
  tau: 'torque (τ, tau_est)',
  demand: 'PD demand',
  roll: 'roll',
  pitch: 'pitch',
}
export const MEASURE_UNIT: Record<Measure, string> = { q: '°', qCmd: '°', tau: 'Nm', demand: 'Nm', roll: '°', pitch: '°' }
export const PANEL_TITLE: Record<PanelKind, string> = { angle: 'Joint angle (°)', torque: 'Joint torque (Nm)', tilt: 'Body tilt (°)' }

export interface PlotSeries {
  key: string
  label: string
  measure: Measure
  slot: number
  /** 0 = first plot colour, 1 = second. Colour follows the joint, or the signal when one joint is plotted. */
  entity: 0 | 1
  /** Dashed as well as coloured, so a pair never depends on colour alone. */
  dashed: boolean
  unit: string
  digits: number
}

export interface PlotJoint {
  id: string
  slot: number
  name: string
  maxEffort: number
}

export interface PlotPanel {
  id: string
  kind: PanelKind
  title: string
  series: PlotSeries[]
  joints: PlotJoint[]
  /** Colour tells the joints apart (two joints), else it tells the signals apart (one joint). */
  byJoint: boolean
}

export interface ResolvedSet {
  set: PlotSet
  panels: PlotPanel[]
  /** Why the plots differ from what was asked for (a joint this robot does not have, no left/right counterpart). */
  notes: string[]
}

const slotOf = (profile: RobotProfile, index: number) => profile.joints[index].sdkMotorIndex ?? index

function jointById(profile: RobotProfile, id: string): PlotJoint | null {
  const i = profile.joints.findIndex((j) => j.id === id)
  if (i < 0) return null
  const slot = slotOf(profile, i)
  if (slot < 0 || slot >= PLOT_SLOTS) return null
  const d = profile.joints[i]
  return { id: d.id, slot, name: d.name, maxEffort: d.maxEffort }
}

/** The joint on the other side of the body (`left_knee_joint` and `right_knee_joint`), if this robot has it. */
export function mirrorOf(profile: RobotProfile, id: string): PlotJoint | null {
  const other = id.startsWith('left_') ? 'right_' + id.slice(5) : id.startsWith('right_') ? 'left_' + id.slice(6) : null
  return other ? jointById(profile, other) : null
}

const s = (measure: Measure, joint: PlotJoint | null, entity: 0 | 1, dashed: boolean, label: string): PlotSeries => ({
  key: `${joint ? joint.id : 'body'}.${measure}`,
  label,
  measure,
  slot: joint ? joint.slot : 0,
  entity,
  dashed,
  unit: MEASURE_UNIT[measure],
  digits: 1,
})

function panelFor(spec: PanelSpec, index: number, joints: PlotJoint[]): PlotPanel | null {
  const id = `${spec.kind}-${index}`
  if (spec.kind === 'tilt') {
    return {
      id,
      kind: 'tilt',
      title: PANEL_TITLE.tilt,
      byJoint: false,
      joints: [],
      series: [s('roll', null, 0, false, 'Roll'), s('pitch', null, 1, true, 'Pitch')],
    }
  }
  if (joints.length === 0) return null
  const measured: Measure = spec.kind === 'angle' ? 'q' : 'tau'
  const command: Measure = spec.kind === 'angle' ? 'qCmd' : 'demand'
  const series: PlotSeries[] = []
  if (joints.length === 1) {
    series.push(s(measured, joints[0], 0, false, MEASURE_LABEL[measured][0].toUpperCase() + MEASURE_LABEL[measured].slice(1)))
    if (spec.command) series.push(s(command, joints[0], 1, true, MEASURE_LABEL[command][0].toUpperCase() + MEASURE_LABEL[command].slice(1)))
  } else {
    joints.forEach((j, n) => {
      const e = n as 0 | 1
      series.push(s(measured, j, e, false, `${j.name}: ${MEASURE_LABEL[measured]}`))
      if (spec.command) series.push(s(command, j, e, true, `${j.name}: ${MEASURE_LABEL[command]}`))
    })
  }
  return { id, kind: spec.kind, title: PANEL_TITLE[spec.kind], series, joints, byJoint: joints.length > 1 }
}

/**
 * The panels of a set for this robot. `selectedId` is the joint chosen in the table and `compare` adds its other side to
 * panels that follow it. A joint the robot does not have drops its panel and says so in `notes`.
 */
export function resolveSet(set: PlotSet, profile: RobotProfile, selectedId: string | null, compare: boolean): ResolvedSet {
  const notes: string[] = []
  const fallback = profile.joints.findIndex((j) => (j.sdkMotorIndex ?? profile.joints.indexOf(j)) === 4)
  const selected =
    (selectedId ? jointById(profile, selectedId) : null) ??
    (fallback >= 0 ? jointById(profile, profile.joints[fallback].id) : null) ??
    jointById(profile, profile.joints[0]?.id ?? '')
  const panels: PlotPanel[] = []
  set.panels.forEach((spec, n) => {
    let joints: PlotJoint[] = []
    if (spec.kind === 'tilt') joints = []
    else if (spec.follow === 'selected') {
      if (selected) {
        joints = [selected]
        if (compare) {
          const m = mirrorOf(profile, selected.id)
          if (m) joints.push(m)
          else if (n === 0) notes.push(`${selected.name} has no left or right counterpart, so only it is plotted.`)
        }
      }
    } else {
      const found = spec.joints.slice(0, MAX_JOINTS_PER_PANEL).map((id) => jointById(profile, id))
      joints = found.filter((j): j is PlotJoint => j !== null)
      if (joints.length < found.length) notes.push(`This robot lacks a joint of the "${set.label}" set, so a plot shows fewer lines.`)
    }
    const panel = panelFor(spec, n, joints)
    if (panel) panels.push(panel)
  })
  return { set, panels, notes }
}

/** A plot set that follows the table's selection (so the Left and right switch applies to it). */
export const followsSelection = (set: PlotSet): boolean => set.panels.some((p) => p.follow === 'selected')

/** The set to save when the operator keeps the current plots: the joints are named, so it keeps working when the selection moves. */
export function snapshotSet(resolved: ResolvedSet, id: string, label: string): PlotSet {
  return {
    id,
    label,
    hint: 'Saved in this browser.',
    user: true,
    panels: resolved.panels.map((p) => ({
      kind: p.kind,
      joints: p.joints.map((j) => j.id),
      command: p.series.some((x) => x.measure === 'qCmd' || x.measure === 'demand'),
    })),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------------------------------

/** Value of one line at logical sample index `i` of the ring (NaN where there is none). Angles and tilt in degrees. */
export function sampleValue(r: PlotRing, i: number, series: Pick<PlotSeries, 'measure' | 'slot'>): number {
  const b = i * PLOT_SLOTS + series.slot
  switch (series.measure) {
    case 'q':
      return r.q[b] * RAD2DEG
    case 'qCmd':
      return r.qCmd[b] * RAD2DEG
    case 'tau':
      return r.tau[b]
    case 'demand':
      return r.demand[b]
    case 'roll':
      return r.roll[i] * RAD2DEG
    default:
      return r.pitch[i] * RAD2DEG
  }
}

/** Largest |PD demand| between two frames, signed like the frame's demand. */
export function demandPeak(r: PlotRing, i: number, slot: number): number {
  const p = r.demandPeak[i * PLOT_SLOTS + slot]
  return r.demand[i * PLOT_SLOTS + slot] < 0 ? -p : p
}

/** Seconds between the rows of the values table for a window, so a table never has more than about 120 rows. */
export const tableStep = (windowS: number): number => (windowS <= 10 ? 0.5 : windowS <= 30 ? 1 : 2)

/** Time grid spacing (s) for the axis of a window. */
export const tickStep = (windowS: number): number => (windowS <= 5 ? 1 : windowS <= 10 ? 2 : windowS <= 30 ? 5 : 10)

// ---------------------------------------------------------------------------------------------------------------------
// CSV of the visible window
// ---------------------------------------------------------------------------------------------------------------------

export const csvName = (series: PlotSeries): string => {
  const base = series.measure === 'roll' || series.measure === 'pitch' ? 'body' : series.key.split('.')[0]
  const unit = series.unit === '°' ? 'deg' : 'nm'
  return `${base}.${series.measure}_${unit}`
}

/**
 * How many samples a second the stored samples in [tStart, tEnd] are, from their median spacing, or null with fewer than two. The page
 * keeps what the bridge sends for the dashboard (about 50 a second); the recording and the robot's own log have far more.
 */
export function plotSampleRate(r: PlotRing, tStart: number, tEnd: number): number | null {
  const gaps: number[] = []
  let prev = NaN
  for (let k = r.lowerBound(tStart); k < r.count; k++) {
    const t = r.t[r.index(k)]
    if (t > tEnd + 1e-9) break
    if (Number.isFinite(prev) && t > prev) gaps.push(t - prev)
    prev = t
  }
  if (gaps.length === 0) return null
  gaps.sort((a, b) => a - b)
  return 1 / gaps[Math.floor(gaps.length / 2)]
}

/**
 * One row per stored sample in [tStart, tEnd], one column per line of the plots (joint angle in degrees, torque in Nm), with
 * the PD demand peak beside each PD demand. The first column is the unix time in seconds, as PlotJuggler expects; `t_rel_s`
 * counts from `relativeTo` (the start of the recording, or the end of the window live). Empty cells are values with no data.
 */
export function buildPlotCsv(r: PlotRing, panels: PlotPanel[], tStart: number, tEnd: number, relativeTo: number): string {
  const cols: PlotSeries[] = []
  const seen = new Set<string>()
  for (const p of panels)
    for (const x of p.series)
      if (!seen.has(x.key)) {
        seen.add(x.key)
        cols.push(x)
      }
  const header = ['t', 't_rel_s', ...cols.flatMap((c) => (c.measure === 'demand' ? [csvName(c), csvName(c).replace('demand', 'demand_peak')] : [csvName(c)]))]
  const lines = [header.join(',')]
  const num = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '')
  const k0 = r.lowerBound(tStart)
  for (let k = k0; k < r.count; k++) {
    const i = r.index(k)
    const t = r.t[i]
    if (t > tEnd + 1e-9) break
    const row = [t.toFixed(6), (t - relativeTo).toFixed(4)]
    for (const c of cols) {
      row.push(num(sampleValue(r, i, c)))
      if (c.measure === 'demand') row.push(num(r.demandPeak[i * PLOT_SLOTS + c.slot]))
    }
    lines.push(row.join(','))
  }
  return lines.join('\n') + '\n'
}
