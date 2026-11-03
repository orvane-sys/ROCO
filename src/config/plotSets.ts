/**
 * Plot sets: which signals the Analyze plots show together. Plain data, so a set can be added without touching the plots.
 *
 * One plot (panel) holds signals of one unit on one axis, never two axes. A panel plots either the selected joint (its
 * measured value and the controller's command) or up to two named joints side by side (each with its command as a dashed
 * line), so there are never more than four lines in a panel.
 */

export const PLOT_WINDOWS = [5, 10, 30, 60] as const
export type PlotWindow = (typeof PLOT_WINDOWS)[number]

export type PanelKind = 'angle' | 'torque' | 'tilt'

export interface PanelSpec {
  kind: PanelKind
  /** Joint ids, at most two. Ignored for `tilt` and when `follow` is set. */
  joints: string[]
  /** Also draw the controller's command (target angle, or PD demand) as a dashed line. */
  command: boolean
  /** Take the joint from the one chosen in the table. With "Left and right" on, its other side is added. */
  follow?: 'selected'
}

export interface PlotSet {
  id: string
  label: string
  hint: string
  panels: PanelSpec[]
  /** Saved by the operator in this browser, not shipped with ROCO. */
  user?: boolean
}

export const MAX_JOINTS_PER_PANEL = 2
export const MAX_USER_SETS = 8

/** The left and right joint of one kind side by side, e.g. `pair('torque', 'knee', true)`. */
const pair = (kind: PanelKind, base: string, command: boolean): PanelSpec => ({ kind, joints: [`left_${base}_joint`, `right_${base}_joint`], command })

export const SHIPPED_SETS: PlotSet[] = [
  {
    id: 'selected',
    label: 'Selected joint',
    hint: 'The joint chosen in the table: angle, torque and body tilt. Turn on Left and right to overlay its other side.',
    panels: [
      { kind: 'angle', joints: [], command: true, follow: 'selected' },
      { kind: 'torque', joints: [], command: true, follow: 'selected' },
      { kind: 'tilt', joints: [], command: false },
    ],
  },
  {
    id: 'ankles',
    label: 'Ankles',
    hint: 'Ankle pitch torque and angle, left against right, and ankle roll torque (TEST_MANUAL section 6 watches these).',
    panels: [pair('torque', 'ankle_pitch', true), pair('angle', 'ankle_pitch', true), pair('torque', 'ankle_roll', false)],
  },
  {
    id: 'knees',
    label: 'Knees',
    hint: 'Knee torque and angle, left against right.',
    panels: [pair('torque', 'knee', true), pair('angle', 'knee', true)],
  },
  {
    id: 'balance',
    label: 'Balance',
    hint: 'Body tilt with the ankle pitch and hip roll torques that hold it.',
    panels: [{ kind: 'tilt', joints: [], command: false }, pair('torque', 'ankle_pitch', false), pair('torque', 'hip_roll', false)],
  },
  {
    id: 'squat',
    label: 'Squat check',
    hint: 'Ankle and knee torque and the forward lean, the three things the squat stages check.',
    panels: [pair('torque', 'ankle_pitch', false), pair('torque', 'knee', false), { kind: 'tilt', joints: [], command: false }],
  },
]

export const DEFAULT_SET_ID = 'selected'
