/**
 * A test procedure as data: stages, and in each stage the checks the manual asks for. The page shows them and measures what
 * the controller reports; it never blocks, starts or commands anything, and a stage is done only when the operator says so.
 * A procedure for another robot or test plan is a new file next to g1_type6.ts, with no change to the page.
 */

/**
 * `auto`: ROCO can measure it from what the bridge sends. `log`: a g1_ctrl log line must (or must not) appear.
 * `manual`: only a person can judge it (rope, spotter, waist lock, Wi-Fi), so the operator ticks it.
 */
export type ItemKind = 'auto' | 'log' | 'manual'

/** What ROCO measures for an `auto` item, and the manual's stop limit for it. Evaluated in src/utils/procedureModel.ts. */
export type AutoRule =
  /** "Safety: motor temperatures ... at start": stop at or above this. On a real robot an all-zero reading is a placeholder. */
  | { type: 'startTemps'; stopAtC: number }
  /** "Safety: motorstate at start": all zero is what the simulator gives; anything else is for the operator to read. */
  | { type: 'startMotorstate' }
  /** "step interval max" of every policy timing line in this run. */
  | { type: 'policyInterval'; stopMs: number }
  /** The "first 2s in <state>" report: biggest command step (deg/tick) or fastest joint (rad/s). */
  | { type: 'first2s'; state: string; parts: ('legs' | 'arms')[]; measure: 'step' | 'speed'; stop: number }
  /** A per-state maximum from real_log.py's numbers, over this run's visits to the state. */
  | { type: 'segment'; state: string; field: 'tauAnkP' | 'tauKnee'; stop: number }
  /** Peak torso lean in the squat against the manual's 13 degrees (see alertPolicy.ts for the stop line). */
  | { type: 'squatLean' }
  /** Fastest leg joint outside Passive in this run, against the runaway stop. */
  | { type: 'legSpeed'; stop: number }
  /** rt/lowcmd rate: far above g1_ctrl's own rate means a second sender. */
  | { type: 'lowcmdRate'; stopHz: number }
  /** Longest gap between rt/lowstate messages. */
  | { type: 'lowstateGap'; watchMs: number; stopMs: number }
  /** Squats started in this run against "about 5 a session". */
  | { type: 'squatCount'; about: number }

/** A line the g1_ctrl log must show, or must not. Only lines of the latest run count. */
export interface LogRule {
  /** `ok` once a line matches. */
  seen?: RegExp
  /** `stop` as soon as a line matches. Wins over `seen`. */
  stop?: RegExp
  /** A line at one of these levels is a stop. */
  stopLevels?: string[]
  /** `ok` as soon as the log has any line and nothing stopped it (for "no X appears"). */
  okWhenNone?: boolean
}

/** A reference value is labelled by where it came from. A simulator figure is never shown as the real robot's. */
export interface References {
  sim?: string
  real?: string
}

export interface ProcItem {
  /** Unique inside the procedure; used to remember ticks. Never reuse an id for a different check. */
  id: string
  kind: ItemKind
  text: string
  /** Manual section, e.g. "§6 T5". */
  ref: string
  /** Heading inside the stage, e.g. "Robot". */
  group?: string
  /** The manual's stop limit or fail condition, in words. */
  stop?: string
  refs?: References
  /** A condition on the check, e.g. "skip when running on this PC". */
  note?: string
  auto?: AutoRule
  log?: LogRule
}

export interface Stage {
  /** Short label for the stage chip, e.g. "T5". */
  id: string
  title: string
  /** Where the robot is: "hanging", "feet on the floor". */
  where?: string
  /** g1_ctrl states this stage covers; used only to point at the stage that matches the current state. */
  states?: string[]
  /** What the manual says to press, in its own words. */
  keys?: string
  /** A short line from the manual that frames the stage. */
  intro?: string
  items: ProcItem[]
}

export interface Procedure {
  id: string
  title: string
  summary: string
  /** The manual this procedure was written from. If the bridge reports another hash, the page says so. */
  manual: { file: string; sha256: string }
  stages: Stage[]
}
