import type { RobotProfile } from '../config/robotRegistry'
import type { MonitorState } from '../types/monitor'

/**
 * g1_ctrl (unitree_rl_mjlab deploy_lock) operator keys, from the header comment of its config.yaml.
 * They are typed in g1_ctrl's own terminal or pressed on the Unitree remote, never in this dashboard.
 */
export const G1_CTRL_KEYS: { from: string; to: string; key: string; remote: string; note?: string }[] = [
  { from: 'Passive', to: 'FixStand', key: 'f', remote: 'LT + up' },
  { from: 'FixStand', to: 'Velocity', key: 'v', remote: 'RT + A', note: 'after the 4 s ramp' },
  { from: 'Velocity', to: 'squat', key: 'n', remote: '', note: 'hands back to Velocity when it ends' },
]
export const G1_CTRL_ABORT = {
  key: 'p',
  remote: 'LT + B',
  text: 'Abort from any state: LT + B on the remote or p in the g1_ctrl terminal (Passive, damping). ' +
    'Ctrl+C in that terminal: Passive for 1 s, then g1_ctrl exits.',
}

/** Display name for a motor slot: the profile's joint name, else the bridge's model name. */
export function slotName(slot: number | null, profile: RobotProfile, state: MonitorState): string {
  if (slot === null) return 'Robot'
  const def = profile.joints.find((j, i) => (j.sdkMotorIndex ?? i) === slot)
  if (def) return def.name
  return state.hello?.limits.jointNames[slot] ?? `Motor ${slot}`
}

/** Data time as text: wall clock live, seconds into the recording in replay. */
export function formatDataTime(t: number | null | undefined, state: MonitorState): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return '—'
  const replay = state.replay
  if (replay) return `${(t - replay.t0).toFixed(1)} s`
  const d = new Date(t * 1000)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/**
 * After a replay seek the bridge restarts its statistics, so the state visits it reports start at the seek. The log lines still
 * cover the whole recording; verdicts built from visits add this so the two do not seem to contradict each other.
 * Empty when the data is the whole run (live, or a recording played from its start, or an older bridge that does not say).
 */
export function statsSinceNote(state: MonitorState): string {
  const r = state.replay
  if (!r || r.statsFrom === undefined || r.statsFrom <= r.t0 + 0.5) return ''
  return ` since ${formatDataTime(r.statsFrom, state)} (the recording was started there)`
}

export function formatDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—'
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m} min ${Math.round(s - 60 * m)} s`
}

export const SOURCE_LABEL: Record<string, string> = { sim: 'Simulator', robot: 'Robot', replay: 'Replay' }

/** "SIM via DDS (lo)", "ROBOT via DDS (enp2s0)", "REPLAY stand_cal16". */
export function sourceBadge(state: MonitorState): string | null {
  const h = state.hello
  if (!h) return null
  if (h.source === 'replay') return `REPLAY ${state.replay?.file ?? h.replay?.file ?? ''}`.trim()
  return `${h.source === 'robot' ? 'ROBOT' : 'SIM'} via DDS (${h.iface})`
}

/** Plain names for the alert kinds the bridge raises. */
export const KIND_LABEL: Record<string, string> = {
  pd_demand: 'PD demand',
  ankle_motor: 'Ankle motor',
  joint_range: 'Joint range',
  pd_target: 'Target range',
  leg_speed: 'Leg speed',
  temperature: 'Temperature',
  motorstate: 'Motor fault',
  locked_cmd: 'Locked joint',
  tilt: 'Tilt',
  lowstate_timeout: 'Robot state lost',
  lowcmd_silent: 'Commands stopped',
  lowstate_gap: 'State gap',
}

/** "Joint range · Left Knee", or just the kind for a whole-robot alert. */
export function alertTitle(a: { kind: string; joint: number | null }, profile: RobotProfile, state: MonitorState): string {
  const kind = KIND_LABEL[a.kind] ?? a.kind
  return a.joint === null ? kind : `${kind} · ${slotName(a.joint, profile, state)}`
}
