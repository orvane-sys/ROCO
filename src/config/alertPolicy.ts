/**
 * What ROCO says about an alert, and the few rules that change how it is shown. This is data on purpose: to change a
 * response or a rule, edit this file. No rule ever stops the bridge from raising or logging an alert; a rule only changes how
 * the page presents it. Section numbers refer to TEST_MANUAL.md (deploy_lock).
 *
 * The bridge decides what trips (its limits come from the g1_ctrl config and the robot model). The wording below is ROCO's, so
 * where a limit is ROCO's own and not the manual's, the text says so instead of borrowing the manual's authority.
 */

/** `info` is an alert the rules below lowered: still logged and listed, but not counted as a warning. */
export type EffectiveLevel = 'critical' | 'warn' | 'info'

export interface AlertResponse {
  /** What to do at warning level, in one or two short sentences. */
  warn: string
  /** What to do at critical level. */
  critical: string
  /** Where the manual says it, e.g. "§3, §7". Empty when the check is ROCO's own. */
  ref: string
  /** Added when the response depends on g1_ctrl's state and ROCO does not know it at the alert's time. */
  stateUnknown?: string
}

const ABORT = 'LT+B (or p, if your g1_ctrl has the keyboard abort)'

/** One entry per alert `kind` the bridge raises (scripts/roco_dds_bridge.py). */
export const RESPONSES: Record<string, AlertResponse> = {
  pd_demand: {
    warn: `Watch this joint. If it keeps rising or the robot looks unsteady, abort: ${ABORT}.`,
    critical: `The demand is at or over the joint's torque limit. If it does not fall at once, abort: ${ABORT}, and the spotter takes the weight.`,
    ref: '§3, §7',
  },
  ankle_motor: {
    warn: 'Compare with the stage limit: ankle pitch torque above 15 Nm is a stop in T5 and T6. Abort if a foot slips or lifts.',
    critical: `An ankle motor is at its peak (ROCO's own limit, approximate). If it does not fall at once, abort: ${ABORT}.`,
    ref: '§6 T5, T6',
  },
  joint_range: {
    warn: 'A joint is near the end of its range. This is normal for some joints while hanging. Abort if the robot is moving unexpectedly.',
    critical: `A joint is beyond its range. If g1_ctrl is still in a policy state, abort: ${ABORT}. After a fall, check the robot on the rope.`,
    ref: '§3',
    stateUnknown: "ROCO does not know g1_ctrl's state at this time: read it in g1_ctrl's terminal.",
  },
  pd_target: {
    warn: 'g1_ctrl clamps this target to the range itself, but clamping does not cap torque. Watch this joint and abort if it chatters.',
    critical: 'g1_ctrl clamps this target to the range itself, but clamping does not cap torque. Watch this joint and abort if it chatters.',
    ref: '§7',
  },
  leg_speed: {
    warn: 'A leg joint is above the runaway speed. g1_ctrl stops itself if this lasts 50 ms. Abort if you see wild leg motion.',
    critical: 'Above the runaway speed for the stop time: expect SAFETY STOP and Passive, latched. The spotter takes the weight. Restart g1_ctrl only after reading the log.',
    ref: '§2, §7',
  },
  temperature: {
    warn: `The manual lists a motor temperature warning as an abort: ${ABORT}, and the spotter takes the weight. Rest the robot before restarting.`,
    critical: 'At the stop temperature g1_ctrl goes to Passive and latches. The spotter takes the weight. Restart only after the motor has cooled and the log is read.',
    ref: '§3, §7, T8',
  },
  motorstate: {
    warn: `Treat any motorstate warning as an abort: ${ABORT}.`,
    critical: `Treat any motorstate warning as an abort: ${ABORT}.`,
    ref: '§3, §7',
  },
  locked_cmd: {
    warn: `A locked joint was commanded. g1_ctrl should force these to zero. Abort: ${ABORT}, and have the config checked.`,
    critical: `A locked joint was commanded. g1_ctrl should force these to zero. Abort: ${ABORT}, and have the config checked.`,
    ref: '§7',
  },
  tilt: {
    warn: 'The body is leaning. Abort if it leans backward, or sideways by more than a few degrees. In the squat, abort if the torso leans much more than 13° forward.',
    critical: `Falling. g1_ctrl goes to Passive at 1.0 rad (57°) in Velocity, but the rope must catch the robot earlier. Abort: ${ABORT}.`,
    ref: '§3, §7',
  },
  lowstate_timeout: {
    warn: 'No robot state. Check the cable.',
    critical: 'No robot state: g1_ctrl goes to Passive after 200 ms and refuses every key until the state is back. Check the cable. The rope takes the weight.',
    ref: '§2, §7',
  },
  lowcmd_silent: {
    warn: 'Nothing is commanding the robot. If g1_ctrl crashed, nothing sends damping: the spotter takes the weight at once.',
    critical: 'Nothing is commanding the robot. If g1_ctrl crashed, nothing sends damping: the spotter takes the weight at once.',
    ref: '§2, §7',
  },
  lowstate_gap: {
    warn: 'Gaps near 200 ms could trip the lost-state stop by itself. Check the cable and close other programs on this PC.',
    critical: 'Gaps near 200 ms could trip the lost-state stop by itself. Check the cable and close other programs on this PC.',
    ref: '§4, T7',
  },
}

export const FALLBACK_RESPONSE: AlertResponse = {
  warn: `No stored response for this kind of alert. Use §3: abort (${ABORT}) if anything looks wrong.`,
  critical: `No stored response for this kind of alert. Use §3: abort (${ABORT}) if anything looks wrong.`,
  ref: '§3',
}

/**
 * Lowers an alert to `info` when it is expected in that g1_ctrl state. Only an alert at the `from` level is lowered: an alert
 * beyond a limit (critical) always stays critical. The alert is still raised, logged and listed under "Informational".
 */
export interface SeverityRule {
  id: string
  /** Alert kind this rule covers. */
  kind: string
  /** Part of the joint name from the bridge (lower case), e.g. `knee`. Omitted: any joint. */
  joint?: string
  /** g1_ctrl states in which it applies. */
  states: string[]
  from: 'warn'
  why: string
}

export const SEVERITY_RULES: SeverityRule[] = [
  {
    id: 'knee-range-hanging',
    kind: 'joint_range',
    joint: 'knee',
    states: ['Passive', 'FixStand'],
    from: 'warn',
    why: 'Straight legs hang near the knee range end in Passive and FixStand, so this warning is expected there.',
  },
]

/** Alerts that open within this many seconds of the previous one belong to the same burst. The first of a burst is the first-out. */
export const BURST_GAP_S = 2

/** An alert opened up to this long after a change into Passive (and before the next state change) follows that change. */
export const FOLLOW_PASSIVE_S = 10

/** Manual §3: a policy timing line with `step interval max` above this is an abort. */
export const STEP_INTERVAL_STOP_MS = 50

/** Manual T6: the torso leans forward to about 12-13° in the squat; "much more" is a stop. */
export const SQUAT_LEAN_REF_DEG = 13
/**
 * ROCO's reading of "much more than 13°" (the manual gives no number). Between the reference and this the check says "above the
 * reference" and asks for a look; it only trips above this. A real squat on 2026-10-24 reached 13.6°. Edit here to change it.
 */
export const SQUAT_LEAN_STOP_DEG = 15

/**
 * Manual §3, lines in the g1_ctrl log that mean abort. The start-up lines ("Safety: motor temperatures ... at start") are not
 * these: they are the T0 check and carry parsed numbers instead.
 */
export const ABORT_LOG_PATTERNS: { id: string; label: string; re: RegExp }[] = [
  { id: 'safety-stop', label: 'SAFETY STOP', re: /SAFETY STOP/ },
  { id: 'no-state', label: 'SAFETY: no robot state', re: /SAFETY: no robot state/ },
  { id: 'temperature', label: 'Safety: motor … temperature', re: /Safety: motor \d+ temperature\b/ },
  { id: 'motorstate', label: 'Safety: motor … motorstate', re: /Safety: motor \d+ motorstate\b/ },
]
/** Log levels that are an abort on their own (manual §3: `critical`, `error`). */
export const ABORT_LOG_LEVELS = ['critical', 'error']
