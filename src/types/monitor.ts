/**
 * Frames sent by the read-only DDS bridge (scripts/roco_dds_bridge.py) next to the binary LowState_.
 * Per-motor arrays are indexed by SDK motor slot (0..28), not by profile joint order.
 * Times (`t`, `since`, `t0`) are unix seconds of the data: wall clock live, recording time in replay.
 */

export type MonitorSource = 'sim' | 'robot' | 'replay'
export type AlertLevel = 'warn' | 'critical'

export interface BridgeSafety {
  temp_warn?: number
  temp_stop?: number
  temp_index?: number[]
  lowstate_timeout_ms?: number
  policy_stall_ms?: number
  leg_speed_stop?: number
  leg_speed_ms?: number
}

export interface BridgeLimits {
  jointNames: string[]
  /** Joint torque limit (Nm) per motor slot; null where the model gives none. */
  torque: (number | null)[]
  range: ([number, number] | null)[]
  pdTargetRange: ([number, number] | null)[] | null
  lockedJoints: number[]
  modeMachine: number | null
  safety: BridgeSafety
  /** g1_ctrl FSM transitions: from -> to -> trigger text from its config. */
  transitions: Record<string, Record<string, string>>
  states: string[]
  /** One 5020 ankle motor's peak (Nm); each ankle joint has two. */
  ankleMotorPeak: number
  tiltWarnDeg: number
  tiltCritDeg: number
  model: string | null
  ctrlConfig: string | null
  warnings: string[]
}

export interface BridgeHello {
  type: 'hello'
  protocol: number
  bridge: string
  readOnly: boolean
  source: MonitorSource
  iface: string
  domain: number
  rateHz: number
  limits: BridgeLimits
  modeMachine: number | null
  replay?: { store: string; file: string; notes: string[] }
  /** The test manual the bridge can read (SHA-256 of its bytes), or null when it is not on this machine. Absent on an older bridge. */
  manual?: { file: string; sha256: string; bytes: number } | null
}

export interface MonitorAlert {
  id: string
  kind: string
  /** Motor slot, or null for whole-robot alerts. */
  joint: number | null
  level: AlertLevel
  peakLevel: AlertLevel
  value: number | null
  peak: number | null
  since: number
  last: number
  text: string
}

export interface AlertEvent extends MonitorAlert {
  event: 'open' | 'close'
  durationS?: number
}

/** A g1_ctrl info line the bridge parsed into numbers (TEST_MANUAL section 3 checks these by eye). */
export type FsmHealth =
  | { kind: 'policyTiming'; policy: string; steps: number; firstMs: number; intervalMaxMs: number }
  | { kind: 'first2s'; state: string; cmdStepLegs: number; cmdStepArms: number; speedLegs: number; speedArms: number }
  | { kind: 'startTemps'; maxC: number | null; motors: number }
  | { kind: 'startMotorstate'; nonzero: number[]; motors: number }

export interface FsmEvent {
  t: number
  level: string
  text: string
  from?: string
  to?: string
  health?: FsmHealth
  /** A "Config:" line: a new g1_ctrl run. */
  session?: boolean
  /** Read back from the log on connect or seek, not seen live. */
  history?: boolean
  /** The bridge's own line: g1_ctrl closed its log (it stopped), so its state is unknown from here. */
  logClosed?: boolean
}

/** real_log.py's per-state numbers for one visit to a g1_ctrl state. */
export interface FsmSegment {
  name: string
  t0: number | null
  durS: number
  ankPitchDemandMax: number
  ankPitchDemandPct: number
  overMs: number
  overRunMs: number
  tauAnkP: number
  tauAnkR: number
  tauKnee: number
  legErrMaxDeg: number
  legDqMax: number
  tiltDeg: [number, number]
  gyroMax: number
  samples: number
}

export interface FsmFrame {
  type: 'fsm'
  full: boolean
  state: string | null
  since: number | null
  events: FsmEvent[]
  segment: FsmSegment
  segments?: FsmSegment[]
}

export interface AuxCommand {
  q: number[]
  dq: number[]
  kp: number[]
  kd: number[]
  tau: number[]
  ageMs: number
}

export interface AuxLink {
  lowstateHz: number
  lowcmdHz: number
  lowstateAgeMs: number | null
  lowcmdAgeMs: number | null
  lowstateGapMaxMs: number
  lowcmdGapMaxMs: number
  tickGapMax: number
  dtMedMs: number
  lowstateCount: number
  lowcmdCount: number
}

export interface AuxFrame {
  type: 'aux'
  t: number
  source: MonitorSource
  cmd: AuxCommand | null
  /** PD demand kp*(q_cmd-q)+kd*(dq_cmd-dq)+tau of the latest sample (Nm). */
  demand: number[]
  /** Window maxima since the previous aux frame, from every ~1 kHz sample. */
  demandMax: number[]
  tauMax: number[]
  dqMax: number[]
  errMax: number[]
  /** Time each joint's |PD demand| spent at or over its torque limit since the bridge started (ms). */
  overLimitMs: number[]
  ankleMotor: { left: number; right: number; leftMax: number; rightMax: number; peak: number }
  odom: { topic: string; x: number; y: number; z: number; vx: number; vy: number; vz: number; ageMs: number } | null
  battery: {
    motorVoltage?: number | null
    soc?: number
    bmsVoltageRaw?: number[]
    currentRaw?: number
    bmsAgeMs?: number
  } | null
  link: AuxLink
  segment: FsmSegment
  alerts: MonitorAlert[]
  alertEvents: AlertEvent[]
  imuTemp?: number
  /** Live only: no rt/lowcmd for over 1 s, so the logged g1_ctrl state may be out of date. */
  fsmStale?: boolean
}

export interface ReplayStatus {
  type: 'replay'
  file: string
  store: string
  t0: number
  t1: number | null
  t: number
  /** Where the bridge's statistics (state visits, alerts) start: the recording's start, or the last seek. Absent on an older bridge. */
  statsFrom?: number
  speed: number
  playing: boolean
  ended: boolean
  indexing: boolean
  busy: string | null
  speeds: number[]
}

export type ReplayAction = 'play' | 'pause' | 'speed' | 'seek'

/** Every g1_ctrl state change in a recording (replay only), so the timeline can show the whole recording before it is played. */
export interface ReplayTimeline {
  type: 'timeline'
  t0: number
  states: { t: number; from: string | null; to: string; session: boolean }[]
}

/** Everything the dashboard knows about a read-only bridge session. */
export interface MonitorState {
  hello: BridgeHello | null
  aux: AuxFrame | null
  fsm: {
    state: string | null
    since: number | null
    events: FsmEvent[]
    segments: FsmSegment[]
    segment: FsmSegment | null
  }
  replay: ReplayStatus | null
  /** Replay only: all state changes of the recording. Absent on an older bridge. */
  timeline?: ReplayTimeline | null
  /** Opened and closed alerts, newest last (bounded). */
  alertLog: AlertEvent[]
}
