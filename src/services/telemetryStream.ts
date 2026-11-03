import type {
  BasePose,
  ConnectionStatus,
  JointState,
  RobotTelemetry,
  TelemetryConfig,
  VelocityCommand,
} from '../types/telemetry'
import { G1_29DOF_JOINTS } from '../types/telemetry'
import { NOMINAL_PELVIS_HEIGHT, synthesizeG1Gait } from './g1Gait'
import {
  decodeLowState,
  encodeTeleopCmd,
  createMockLowStateBuffer,
  getLowStateModeMachine,
} from '../utils/unitreeBinaryCodec'
import type { RobotProfile } from '../config/robotRegistry'
import {
  G1_29DOF_PROFILE,
  getRobotProfile,
  getModeMachineForProfile,
  getProfileIdByModeMachine,
} from '../config/robotRegistry'
import type {
  AlertEvent,
  AuxFrame,
  BridgeHello,
  FsmFrame,
  MonitorState,
  ReplayAction,
  ReplayStatus,
  ReplayTimeline,
} from '../types/monitor'
import { PLOT_SLOTS, PlotRing } from './plotRing'

type TelemetryListener = (telemetry: RobotTelemetry) => void
type StatusListener = (status: ConnectionStatus) => void
type EmergencyStopListener = (latched: boolean) => void
type RobotProfileListener = (profile: RobotProfile) => void
type NoticeListener = (message: string | null) => void
type MonitorListener = (state: MonitorState) => void

const MAX_FSM_EVENTS = 200
const MAX_ALERT_LOG = 200
/** Odometry older than this no longer counts as a measured body velocity. */
const ODOM_FRESH_MS = 500

// Dashboard URL options, set by the bridge's printed link:
//   ?ws=<ws:// or wss:// url>  bridge address
//   ?demo=1                    start on demo data without a bridge (never the default)
//   ?monitor=1                 read-only from the first frame (no teleop is ever sent)
const URL_PARAMS =
  typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()

function wsUrlFromQuery(): string | undefined {
  const value = URL_PARAMS.get('ws')
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'ws:' || url.protocol === 'wss:' ? value : undefined
  } catch {
    return undefined
  }
}

const emptyMonitorState = (): MonitorState => ({
  hello: null,
  aux: null,
  fsm: { state: null, since: null, events: [], segments: [], segment: null },
  replay: null,
  alertLog: [],
})

// Teleop command envelope (matches TeleopControls key mapping).
const MAX_VX = 0.8
const MAX_VY = 0.4
const MAX_WZ = 1.0

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const finiteOr = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const DEFAULT_CONFIG: TelemetryConfig = {
  wsUrl: wsUrlFromQuery() ?? 'ws://localhost:8765',
  heartbeatTimeoutMs: 250,
  mockFallbackDelayMs: 1200,
}

export class TelemetryStreamService {
  private config: TelemetryConfig
  private socket: WebSocket | null = null
  private status: ConnectionStatus = 'CONNECTING'
  private telemetryListeners: Set<TelemetryListener> = new Set()
  private statusListeners: Set<StatusListener> = new Set()
  private eStopListeners: Set<EmergencyStopListener> = new Set()
  private profileListeners: Set<RobotProfileListener> = new Set()
  private noticeListeners: Set<NoticeListener> = new Set()
  private notice: string | null = null
  private lastUnknownModeMachine = 0
  /** Set once the operator leaves demo data, so ?demo=1 does not pull them back into it. */
  private demoDeclined = false
  private activeProfile: RobotProfile = G1_29DOF_PROFILE

  private readonly monitorFromUrl = URL_PARAMS.get('monitor') === '1'
  private monitor: MonitorState = emptyMonitorState()
  private monitorListeners: Set<MonitorListener> = new Set()
  private plotRing = new PlotRing()
  private slotQ = new Float32Array(PLOT_SLOTS)
  private slotTau = new Float32Array(PLOT_SLOTS)
  private slotQCmd = new Float32Array(PLOT_SLOTS)

  private lastPacketTimestamp: number = 0
  private lastBinaryTimestamp: number = 0
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private mockIntervalTimer: ReturnType<typeof setInterval> | null = null
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private mockTime: number = 0
  private walkPhase: number = 0
  private isEmergencyStopped: boolean = false
  private prevJointPositions: Map<string, number> = new Map()
  private jointTemperatures: Map<string, number> = new Map(
    G1_29DOF_JOINTS.map((j, idx) => [j.id, 34 + (idx % 5) * 1.5])
  )

  // Inertial Velocity States (Target vs Actual Integrated Velocity)
  private targetVelocity: { vx: number; vy: number; wz: number } = { vx: 0, vy: 0, wz: 0 }
  private currentVelocity: { vx: number; vy: number; wz: number } = { vx: 0, vy: 0, wz: 0 }
  private currentBatteryVoltage: number = 24.8

  // 6-DOF pelvis pose in the ROS odom frame (+X fwd, +Y left, +Z up)
  private basePose: BasePose = {
    x: 0,
    y: 0,
    z: NOMINAL_PELVIS_HEIGHT,
    roll: 0,
    pitch: 0,
    yaw: 0,
  }

  // Pre-allocated snapshot the binary decoder writes into (no per-frame snapshot or joint objects)
  private snapshotBuffer: RobotTelemetry = {
    timestamp: Date.now(),
    joints: G1_29DOF_JOINTS.map((j) => ({
      id: j.id,
      name: j.name,
      group: j.group,
      position: j.defaultPos,
      velocity: 0,
      torque: 0,
      temperature: 38.0,
      limitMin: j.limitMin,
      limitMax: j.limitMax,
      maxEffort: j.maxEffort,
    })),
    batteryVoltage: 24.8,
    batteryPercentage: 90,
    pingLatency: 12,
    linearVelocity: { x: 0, y: 0 },
    angularVelocity: { z: 0 },
    basePose: {
      x: 0,
      y: 0,
      z: NOMINAL_PELVIS_HEIGHT,
      roll: 0,
      pitch: 0,
      yaw: 0,
    },
    gaitBlend: 0,
    emergencyStopped: false,
  }

  // Binary Loopback test: encode mock gait into 2092B Unitree LowState_ & decode at 50Hz
  private binaryLoopbackEnabled: boolean = true
  private useBinaryCommands: boolean = true
  private pendingProfileSwitchUntil: number = 0

  // Synchronous Latest Snapshot Buffer for 60-144 FPS WebGL decoupling
  private latestSnapshot: RobotTelemetry | null = null

  constructor(config: Partial<TelemetryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.connect()
  }

  public getConfig(): TelemetryConfig {
    return { ...this.config }
  }

  public updateConfig(newConfig: Partial<TelemetryConfig>): void {
    const urlChanged = newConfig.wsUrl && newConfig.wsUrl !== this.config.wsUrl
    this.config = { ...this.config, ...newConfig }
    if (urlChanged) {
      this.reconnect()
    }
  }

  public getStatus(): ConnectionStatus {
    return this.status
  }

  public getLatestSnapshot(): RobotTelemetry | null {
    return this.latestSnapshot
  }

  public subscribeTelemetry(listener: TelemetryListener): () => void {
    this.telemetryListeners.add(listener)
    return () => {
      this.telemetryListeners.delete(listener)
    }
  }

  public subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    listener(this.status)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  public subscribeEmergencyStop(listener: EmergencyStopListener): () => void {
    this.eStopListeners.add(listener)
    listener(this.isEmergencyStopped)
    return () => {
      this.eStopListeners.delete(listener)
    }
  }

  public getActiveRobotProfile(): RobotProfile {
    return this.activeProfile
  }

  public subscribeRobotProfile(listener: RobotProfileListener): () => void {
    this.profileListeners.add(listener)
    listener(this.activeProfile)
    return () => {
      this.profileListeners.delete(listener)
    }
  }

  /** Non-fatal, user-visible notices (e.g. a robot type the registry does not know). null clears. */
  public subscribeNotice(listener: NoticeListener): () => void {
    this.noticeListeners.add(listener)
    listener(this.notice)
    return () => {
      this.noticeListeners.delete(listener)
    }
  }

  private setNotice(message: string | null): void {
    if (this.notice === message) return
    this.notice = message
    this.noticeListeners.forEach((l) => l(message))
  }

  /**
   * Read-only session: the bridge said so in its hello, or the page was opened with ?monitor=1.
   * Nothing but replay controls is ever sent, and the browser E-stop is not offered (it could not stop
   * anything: the real abort is in g1_ctrl).
   */
  public isMonitorMode(): boolean {
    return this.monitorFromUrl || this.monitor.hello?.readOnly === true
  }

  public getMonitorState(): MonitorState {
    return this.monitor
  }

  /** Bridge frames (hello, aux at the bridge rate, fsm, replay). The state object is replaced on change. */
  public subscribeMonitor(listener: MonitorListener): () => void {
    this.monitorListeners.add(listener)
    listener(this.monitor)
    return () => {
      this.monitorListeners.delete(listener)
    }
  }

  private setMonitor(patch: Partial<MonitorState>): void {
    this.monitor = { ...this.monitor, ...patch }
    this.monitorListeners.forEach((l) => l(this.monitor))
  }

  /** Replay transport (the only message a read-only bridge accepts). */
  public sendReplayControl(action: ReplayAction, value?: number): void {
    if (!this.monitor.replay || !this.socket || this.socket.readyState !== WebSocket.OPEN) return
    if (action === 'seek' && typeof value === 'number') this.lastSeekT = value
    this.socket.send(JSON.stringify({ type: 'replay_control', action, value }))
  }

  /** True when teleop / profile / E-stop frames may go to the bridge. */
  private canSendCommands(): boolean {
    return !this.isMonitorMode() && !!this.socket && this.socket.readyState === WebSocket.OPEN
  }

  /**
   * The bridge's limits (from the controller config and robot model) replace the profile's torque
   * limits and ranges, matched by joint name, when they describe this robot type.
   */
  private withBridgeLimits(profile: RobotProfile): RobotProfile {
    const lim = this.monitor.hello?.limits
    if (!lim || profile.codecType !== 'unitree_hg_2092') return profile
    if (lim.modeMachine != null && profile.modeMachine !== lim.modeMachine) return profile
    const slot = new Map(lim.jointNames.map((n, i) => [n, i]))
    const locked = new Set(lim.lockedJoints)
    return {
      ...profile,
      joints: profile.joints.map((j) => {
        const k = slot.get(j.id)
        if (k === undefined) return j
        const torque = lim.torque[k]
        const range = lim.range[k]
        return {
          ...j,
          maxEffort: torque ?? j.maxEffort,
          limitMin: range ? range[0] : j.limitMin,
          limitMax: range ? range[1] : j.limitMax,
          locked: locked.has(k) || j.locked,
        }
      }),
    }
  }

  private handleHello(hello: BridgeHello): void {
    this.setMonitor({ hello })
    if (hello.readOnly && this.isEmergencyStopped) this.setEmergencyStop(false)
    const mm = hello.modeMachine ?? hello.limits?.modeMachine
    const detected = mm ? getProfileIdByModeMachine(mm) : null
    if (detected && detected !== this.activeProfile.id && this.activeProfile.modeMachine !== undefined) {
      this.setActiveRobotProfile(detected)
    } else {
      this.applyProfile(this.withBridgeLimits(getRobotProfile(this.activeProfile.id)), false)
    }
  }

  private handleFsm(frame: FsmFrame): void {
    const prev = this.monitor.fsm
    const events = frame.full ? [...frame.events] : [...prev.events, ...frame.events]
    if (frame.full && this.monitor.replay) this.plotRing.clear() // a seek: the plotted past is gone
    this.setMonitor({
      fsm: {
        state: frame.state,
        since: frame.since,
        events: events.length > MAX_FSM_EVENTS ? events.slice(-MAX_FSM_EVENTS) : events,
        segments: frame.segments ?? (frame.full ? [] : prev.segments),
        segment: frame.segment,
      },
      // after a replay seek the bridge restarts its statistics, so the alert history restarts too
      ...(frame.full && this.monitor.replay ? { alertLog: [] as AlertEvent[] } : {}),
    })
  }

  private handleAux(aux: AuxFrame): void {
    let alertLog = this.monitor.alertLog
    if (aux.alertEvents.length) {
      alertLog = [...alertLog, ...aux.alertEvents]
      if (alertLog.length > MAX_ALERT_LOG) alertLog = alertLog.slice(-MAX_ALERT_LOG)
    }
    this.setMonitor({ aux, alertLog, fsm: { ...this.monitor.fsm, segment: aux.segment } })
    this.applyAuxToSnapshot()
    this.recordPlotSample(aux)
    // Paused replay or a silent robot: no binary frames, but commands and alerts still change.
    if (performance.now() - this.lastBinaryTimestamp > 100) {
      this.latestSnapshot = this.snapshotBuffer
      this.emitTelemetry(this.snapshotBuffer)
    }
  }

  /** Data time of the latest replay seek this page asked for (the timeline uses it to tell an alert still open from a new one). */
  private lastSeekT: number | null = null
  public getLastSeek(): number | null {
    return this.lastSeekT
  }

  public getPlotRing(): PlotRing {
    return this.plotRing
  }

  /** One plot sample per aux frame: measured state from the latest binary frame, the rest from aux. */
  private recordPlotSample(aux: AuxFrame): void {
    if (!this.lastBinaryTimestamp) return
    if (aux.t === this.plotRing.latestTime()) return // paused replay: same moment, keep the history
    this.slotQ.fill(NaN)
    this.slotTau.fill(NaN)
    const defs = this.activeProfile.joints
    this.snapshotBuffer.joints.forEach((j, i) => {
      const m = defs[i]?.sdkMotorIndex ?? i
      if (m >= 0 && m < PLOT_SLOTS) {
        this.slotQ[m] = j.position
        this.slotTau[m] = j.torque
      }
    })
    // a target only means something where the PD loop holds the joint (kp > 0; Passive sends q = 0)
    const cmd = aux.cmd
    for (let s = 0; s < PLOT_SLOTS; s++) {
      this.slotQCmd[s] = cmd && cmd.kp[s] > 0 ? cmd.q[s] : NaN
    }
    const pose = this.snapshotBuffer.basePose
    this.plotRing.push(aux.t, this.slotQ, this.slotQCmd, this.slotTau, aux.demand, aux.demandMax,
      pose?.roll ?? NaN, pose?.pitch ?? NaN)
  }

  /** Merges the latest aux frame (per motor slot) into the snapshot's joints and body velocity. */
  private applyAuxToSnapshot(): void {
    const aux = this.monitor.aux
    if (!aux) return
    const defs = this.activeProfile.joints
    const joints = this.snapshotBuffer.joints
    const cmd = aux.cmd
    for (let i = 0; i < joints.length; i++) {
      const m = defs[i]?.sdkMotorIndex ?? i
      if (m < 0 || m >= aux.demand.length) continue
      const j = joints[i]
      j.pdDemand = aux.demand[m]
      j.pdDemandMax = aux.demandMax[m]
      j.pdErrMax = aux.errMax[m]
      if (cmd) {
        j.qCmd = cmd.q[m]
        j.dqCmd = cmd.dq[m]
        j.kp = cmd.kp[m]
        j.kd = cmd.kd[m]
        j.tauCmd = cmd.tau[m]
      } else {
        j.qCmd = j.dqCmd = j.kp = j.kd = j.tauCmd = undefined
      }
    }
    const odom = aux.odom
    if (odom && odom.ageMs < ODOM_FRESH_MS) {
      this.snapshotBuffer.linearVelocity = { x: odom.vx, y: odom.vy }
      this.snapshotBuffer.linearVelocityValid = true
    }
  }

  public setActiveRobotProfile(profileId: string): void {
    const profile = this.withBridgeLimits(getRobotProfile(profileId))
    if (this.activeProfile.id === profile.id) return
    this.applyProfile(profile, true)
  }

  /** Makes `profile` active. reset: a different robot (new joints, pose and filters). */
  private applyProfile(profile: RobotProfile, reset: boolean): void {
    if (!reset) {
      this.activeProfile = profile
      this.snapshotBuffer.joints.forEach((j, i) => {
        const def = profile.joints[i]
        if (!def || def.id !== j.id) return
        j.limitMin = def.limitMin
        j.limitMax = def.limitMax
        j.maxEffort = def.maxEffort
      })
      this.profileListeners.forEach((l) => l(profile))
      return
    }

    this.activeProfile = profile
    this.pendingProfileSwitchUntil = Date.now() + 1000

    // Re-initialize snapshot buffer joints dynamically
    this.snapshotBuffer.joints = profile.joints.map((j) => ({
      id: j.id,
      name: j.name,
      group: j.group,
      position: j.defaultPos,
      velocity: 0,
      torque: 0,
      temperature: 38.0,
      limitMin: j.limitMin,
      limitMax: j.limitMax,
      maxEffort: j.maxEffort,
    }))

    // Reset base pose to nominal height
    this.basePose = {
      x: 0,
      y: 0,
      z: profile.nominalPelvisHeight,
      roll: 0,
      pitch: 0,
      yaw: 0,
    }
    this.snapshotBuffer.basePose = { ...this.basePose }

    // Reset velocities
    this.targetVelocity = { vx: 0, vy: 0, wz: 0 }
    this.currentVelocity = { vx: 0, vy: 0, wz: 0 }

    // Reset tracking maps
    this.prevJointPositions.clear()
    this.jointTemperatures = new Map(profile.joints.map((j, idx) => [j.id, 34 + (idx % 5) * 1.5]))

    this.latestSnapshot = { ...this.snapshotBuffer, joints: [...this.snapshotBuffer.joints] }
    this.emitTelemetry(this.latestSnapshot)
    this.profileListeners.forEach((l) => l(profile))

    if (this.socket && this.canSendCommands()) {
      if (this.useBinaryCommands) {
        const modeMachine = getModeMachineForProfile(profile)
        const binCmd = encodeTeleopCmd(0, 0, 0, this.isEmergencyStopped, modeMachine)
        this.socket.send(binCmd)
      } else {
        this.socket.send(
          JSON.stringify({
            type: 'switch_profile',
            profileId: profile.id,
            timestamp: Date.now(),
          })
        )
      }
    }
  }

  private setStatus(newStatus: ConnectionStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus
      this.statusListeners.forEach((listener) => listener(newStatus))
    }
  }

  public connect(): void {
    this.cleanup()
    if (URL_PARAMS.get('demo') === '1' && !this.demoDeclined) {
      this.fallbackToMock()
      return
    }
    this.setStatus('CONNECTING')
    // a new bridge introduces itself again (or is not a read-only bridge at all)
    if (this.monitor.hello || this.monitor.aux || this.monitor.replay) this.setMonitor(emptyMonitorState())
    this.plotRing.clear()
    this.lastBinaryTimestamp = 0

    try {
      this.socket = new WebSocket(this.config.wsUrl)
      this.socket.binaryType = 'arraybuffer'

      this.connectTimeoutTimer = setTimeout(() => {
        if (this.status === 'CONNECTING' && (!this.socket || this.socket.readyState !== WebSocket.OPEN)) {
          this.connectFailed()
        }
      }, this.config.mockFallbackDelayMs)

      this.socket.onopen = () => {
        if (this.connectTimeoutTimer) {
          clearTimeout(this.connectTimeoutTimer)
          this.connectTimeoutTimer = null
        }
        this.stopMockGenerator()
        this.setStatus('LIVE')
        this.lastPacketTimestamp = performance.now()
        this.startWatchdog()
      }

      this.socket.onmessage = (event: MessageEvent) => {
        this.lastPacketTimestamp = performance.now()
        const isBinary = event.data instanceof ArrayBuffer
        if (isBinary) this.lastBinaryTimestamp = this.lastPacketTimestamp

        // Packets resumed after a watchdog trip: the link is healthy again. A read-only bridge keeps
        // sending aux frames when the robot goes silent, so there only robot state counts.
        if (this.status === 'SAFETY_HALT' && !this.isEmergencyStopped && (isBinary || !this.isMonitorMode())) {
          this.setStatus('LIVE')
        }

        // 1. High-throughput binary LowState_ frame
        if (event.data instanceof ArrayBuffer) {
          // Imported robots (no modeMachine) are an explicit user choice: never auto-switch away.
          if (Date.now() > this.pendingProfileSwitchUntil && this.activeProfile.modeMachine !== undefined) {
            const modeMachine = getLowStateModeMachine(event.data)
            const detectedProfileId = getProfileIdByModeMachine(modeMachine)
            if (detectedProfileId) {
              this.lastUnknownModeMachine = 0
              this.setNotice(null)
              if (detectedProfileId !== this.activeProfile.id) {
                this.setActiveRobotProfile(detectedProfileId)
              }
            } else if (modeMachine !== 0 && modeMachine !== this.lastUnknownModeMachine) {
              // Unknown robot type: keep the current profile rather than guess.
              this.lastUnknownModeMachine = modeMachine
              this.setNotice(
                `The robot reported mode_machine ${modeMachine}, which matches no known profile. ` +
                  `Staying on ${this.activeProfile.name}; pick a profile manually if the joints look wrong.`
              )
            }
          }

          const ok = decodeLowState(event.data, this.snapshotBuffer, true, this.activeProfile)
          if (ok) {
            this.snapshotBuffer.emergencyStopped = this.isEmergencyStopped
            this.applyAuxToSnapshot()
            this.latestSnapshot = this.snapshotBuffer
            this.emitTelemetry(this.snapshotBuffer)
          }
          return
        }

        // 2. JSON frames: read-only bridge frames by type, else the legacy telemetry format
        if (typeof event.data === 'string') {
          let data: Record<string, unknown>
          try {
            data = JSON.parse(event.data)
          } catch {
            return // Ignore invalid packet formats
          }
          if (!data || typeof data !== 'object') return
          switch (data.type) {
            case 'hello':
              if (data.limits && typeof data.limits === 'object') this.handleHello(data as unknown as BridgeHello)
              return
            case 'aux':
              if (Array.isArray(data.demand) && Array.isArray(data.alertEvents)) this.handleAux(data as unknown as AuxFrame)
              return
            case 'fsm':
              if (Array.isArray(data.events)) this.handleFsm(data as unknown as FsmFrame)
              return
            case 'replay':
              this.setMonitor({ replay: data as unknown as ReplayStatus })
              return
            case 'timeline':
              if (Array.isArray(data.states)) this.setMonitor({ timeline: data as unknown as ReplayTimeline })
              return
            case 'switch_profile':
              if (
                typeof data.profileId === 'string' &&
                Date.now() > this.pendingProfileSwitchUntil &&
                data.profileId !== this.activeProfile.id
              ) {
                this.setActiveRobotProfile(data.profileId)
              }
              break
          }
          const parsedTelemetry = this.normalizeTelemetry(data)
          this.emitTelemetry(parsedTelemetry)
        }
      }

      this.socket.onerror = () => {
        if (this.status === 'CONNECTING') {
          this.connectFailed()
        }
      }

      this.socket.onclose = () => {
        if (this.status === 'LIVE' || this.status === 'SAFETY_HALT') {
          this.setStatus('DISCONNECTED')
          this.startReconnectSchedule()
        } else if (this.status === 'CONNECTING') {
          this.connectFailed()
        }
      }
    } catch {
      this.connectFailed()
    }
  }

  /** No bridge: stay offline and keep retrying. Demo data only starts when the operator asks for it. */
  private connectFailed(): void {
    this.cleanup()
    this.setStatus('DISCONNECTED')
    this.startReconnectSchedule()
  }

  public reconnect(): void {
    this.demoDeclined = true
    this.cleanup()
    this.connect()
  }

  private startReconnectSchedule(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      if (this.status === 'DISCONNECTED') {
        this.connect()
      }
    }, 3000)
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.watchdogTimer = setInterval(() => {
      if (this.status !== 'LIVE' && this.status !== 'SAFETY_HALT') return
      const monitor = this.isMonitorMode()
      const replay = this.monitor.replay
      // A paused, seeking or finished replay sends no robot state on purpose.
      if (monitor && replay && (!replay.playing || replay.busy)) {
        if (this.status === 'SAFETY_HALT') this.setStatus('LIVE')
        return
      }
      if (this.status === 'LIVE') {
        const elapsed = performance.now() - (monitor ? this.lastBinaryTimestamp : this.lastPacketTimestamp)
        if (elapsed > this.config.heartbeatTimeoutMs) {
          this.setStatus('SAFETY_HALT')
        }
      }
    }, 50)
  }

  private fallbackToMock(): void {
    if (this.socket) {
      this.socket.onopen = null
      this.socket.onmessage = null
      this.socket.onerror = null
      this.socket.onclose = null
      try {
        this.socket.close()
      } catch {
        // Safe ignore
      }
      this.socket = null
    }

    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }

    this.setStatus('MOCK')
    this.startMockGenerator()
  }

  private startMockGenerator(): void {
    if (this.mockIntervalTimer) clearInterval(this.mockIntervalTimer)

    const dt = 0.02 // 50 Hz physics tick (20ms interval)

    this.mockIntervalTimer = setInterval(() => {
      this.mockTime += dt
      const t = this.mockTime
      const isHalt = this.isEmergencyStopped

      // 1. Inertial Velocity Smoothing with Acceleration & Deceleration Ramping
      if (isHalt) {
        this.targetVelocity = { vx: 0, vy: 0, wz: 0 }
      }

      const rampVelocity = (
        current: number,
        target: number,
        accelRate: number,
        decelRate: number
      ) => {
        const isBraking =
          Math.sign(current) !== Math.sign(target) ||
          Math.abs(target) < Math.abs(current)
        const rate = isBraking ? decelRate : accelRate
        const step = rate * dt
        if (Math.abs(target - current) <= step) return target
        return current + Math.sign(target - current) * step
      }

      // Linear: ~2.5 m/s² accel, ~4.0 m/s² decel. Angular: ~4.0 rad/s² accel, ~6.0 rad/s² decel
      this.currentVelocity.vx = rampVelocity(this.currentVelocity.vx, this.targetVelocity.vx, 2.5, 4.0)
      this.currentVelocity.vy = rampVelocity(this.currentVelocity.vy, this.targetVelocity.vy, 2.5, 4.0)
      this.currentVelocity.wz = rampVelocity(this.currentVelocity.wz, this.targetVelocity.wz, 4.0, 6.0)

      const vx = this.currentVelocity.vx
      const vy = this.currentVelocity.vy
      const wz = this.currentVelocity.wz

      // Gait engagement: any commanded DOF (including turning in place) makes the robot step.
      const gaitBlend = Math.min(
        1.0,
        Math.max(Math.abs(vx) / MAX_VX, Math.abs(vy) / MAX_VY, (0.8 * Math.abs(wz)) / MAX_WZ)
      )

      // 2. Gait cadence: 1.0 Hz stride cycle when shuffling, 1.6 Hz at full speed.
      const gaitPeriod = 1 / (1.0 + 0.6 * gaitBlend)
      if (gaitBlend > 0.01) {
        this.walkPhase = (this.walkPhase + ((2 * Math.PI) / gaitPeriod) * dt) % (2 * Math.PI)
      }

      // 3. Planar base odometry in the ROS frame (+X fwd, +Y left, yaw CCW about +Z)
      const pose = this.basePose
      if (this.activeProfile.category === 'fixed_manipulator') {
        pose.x = 0
        pose.y = 0
        pose.yaw = 0
        pose.pitch = 0
        pose.roll = 0
        pose.z = this.activeProfile.nominalPelvisHeight
      } else {
        pose.yaw = wrapAngle(pose.yaw + wz * dt)
        const cosYaw = Math.cos(pose.yaw)
        const sinYaw = Math.sin(pose.yaw)
        pose.x += (vx * cosYaw - vy * sinYaw) * dt
        pose.y += (vx * sinYaw + vy * cosYaw) * dt
        pose.pitch = 0.06 * vx
        pose.roll = -0.05 * vy - 0.05 * vx * wz
      }

      // 4. Kinematic leg/arm synthesis (IK keeps stance feet planted and flat)
      const gait = synthesizeG1Gait({
        phase: this.walkPhase,
        period: gaitPeriod,
        blend: gaitBlend,
        vx,
        vy,
        wz,
        basePitch: pose.pitch,
        baseRoll: pose.roll,
      }, this.activeProfile)
      pose.z = gait.pelvisHeight

      const idleRatio = Math.max(0, 1.0 - gaitBlend / 0.2)

      const joints: JointState[] = this.activeProfile.joints.map((j, idx) => {
        let position = gait.joints[j.id] ?? j.defaultPos

        // Idle subtle breathing sway when stationary
        if (idleRatio > 0 && !isHalt) {
          if (j.group === 'waist') {
            position += Math.sin(t * 0.8 + idx) * 0.012 * idleRatio
          } else if (j.group === 'left_arm' || j.group === 'right_arm') {
            position += Math.sin(t * 0.9 + idx) * 0.015 * idleRatio
          }
        }
        position = Math.min(j.limitMax, Math.max(j.limitMin, position))

        const prev = this.prevJointPositions.get(j.id) ?? position
        this.prevJointPositions.set(j.id, position)
        const velocity = (position - prev) / dt

        // Load model: stance legs carry body weight, swing legs and arms mostly fight inertia.
        let load = 0.08
        if (j.group === 'left_leg' || j.group === 'right_leg') {
          const stance = j.group === 'left_leg' ? gait.leftStance : gait.rightStance
          const weightShare = gaitBlend > 0.01 ? (stance ? 1.0 : 0.25) : 0.5
          load = (0.12 + 0.35 * gaitBlend) * weightShare + 0.15
        } else if (j.group === 'waist') {
          load = 0.15 + 0.15 * gaitBlend
        } else {
          load = 0.1 + 0.25 * gaitBlend
        }
        const torque = isHalt ? 0 : load * j.maxEffort + Math.sin(t * 1.5 + idx) * 0.02 * j.maxEffort

        // First-order thermal model: I²R heating toward a load-dependent steady state.
        const loadRatio = Math.abs(torque) / j.maxEffort
        const steadyTemp = 34 + 45 * loadRatio * loadRatio + (idx % 5) * 1.5
        const prevTemp = this.jointTemperatures.get(j.id) ?? steadyTemp
        const temperature = prevTemp + (steadyTemp - prevTemp) * (dt / 60)
        this.jointTemperatures.set(j.id, temperature)

        return {
          id: j.id,
          name: j.name,
          group: j.group,
          position: Number(position.toFixed(4)),
          velocity: Number(velocity.toFixed(3)),
          torque: Number(torque.toFixed(1)),
          temperature: Number(temperature.toFixed(1)),
          limitMin: j.limitMin,
          limitMax: j.limitMax,
          maxEffort: j.maxEffort,
        }
      })

      this.currentBatteryVoltage = Math.max(22.2, 25.1 - (t * 0.0008) % 2.9)
      const batteryPercentage = Math.min(
        100,
        Math.max(0, Math.round(((this.currentBatteryVoltage - 21.6) / (25.2 - 21.6)) * 100))
      )

      const mockPing = 12 + Math.round(Math.sin(t * 2.5) * 4)

      const telemetry: RobotTelemetry = {
        timestamp: Date.now(),
        joints,
        batteryVoltage: Number(this.currentBatteryVoltage.toFixed(2)),
        batteryPercentage,
        pingLatency: mockPing,
        linearVelocity: { x: Number(vx.toFixed(2)), y: Number(vy.toFixed(2)) },
        angularVelocity: { z: Number(wz.toFixed(2)) },
        basePose: { ...pose },
        gaitBlend: Number(gaitBlend.toFixed(2)),
        emergencyStopped: this.isEmergencyStopped,
      }

      if (this.binaryLoopbackEnabled) {
        // Continuous 50Hz Loopback Test:
        // 1. Pack synthetic state into authentic 2092B Unitree LowState_ buffer with CRC32
        const binBuffer = createMockLowStateBuffer(telemetry, Math.floor(t * 50), this.activeProfile)
        // 2. Decode back through the DataView parser (writes into the pre-allocated snapshot)
        decodeLowState(binBuffer, this.snapshotBuffer, true, this.activeProfile)
        this.snapshotBuffer.batteryVoltage = telemetry.batteryVoltage
        this.snapshotBuffer.batteryPercentage = telemetry.batteryPercentage
        this.snapshotBuffer.pingLatency = telemetry.pingLatency
        this.snapshotBuffer.gaitBlend = telemetry.gaitBlend
        this.snapshotBuffer.linearVelocity = telemetry.linearVelocity
        this.snapshotBuffer.linearVelocityValid = true // the simulator knows its own velocity
        this.snapshotBuffer.emergencyStopped = telemetry.emergencyStopped
        // Preserve computed forward/lateral position
        this.snapshotBuffer.basePose!.x = pose.x
        this.snapshotBuffer.basePose!.y = pose.y
        this.snapshotBuffer.basePose!.z = pose.z
        this.latestSnapshot = this.snapshotBuffer
        this.emitTelemetry(this.snapshotBuffer)
      } else {
        this.latestSnapshot = telemetry
        this.emitTelemetry(telemetry)
      }
    }, 20)
  }

  private stopMockGenerator(): void {
    if (this.mockIntervalTimer) {
      clearInterval(this.mockIntervalTimer)
      this.mockIntervalTimer = null
    }
  }

  private normalizeTelemetry(raw: Record<string, unknown>): RobotTelemetry {
    let normalizedJoints: JointState[] = []

    if (Array.isArray(raw.joints)) {
      const incomingMap = new Map<string, Record<string, unknown>>()
      raw.joints.forEach((item) => {
        if (item && typeof item === 'object' && typeof item.id === 'string') {
          incomingMap.set(item.id, item)
        }
      })

      normalizedJoints = this.activeProfile.joints.map((def) => {
        const item = incomingMap.get(def.id)
        return {
          id: def.id,
          name: def.name,
          group: def.group,
          position: typeof item?.position === 'number' ? item.position : def.defaultPos,
          velocity: typeof item?.velocity === 'number' ? item.velocity : 0,
          torque: typeof item?.torque === 'number' ? item.torque : 0,
          temperature: typeof item?.temperature === 'number' ? item.temperature : 38.0,
          limitMin: def.limitMin,
          limitMax: def.limitMax,
          maxEffort: def.maxEffort,
        }
      })
    }

    // Bridge publishes base odometry in the ROS frame (+X fwd, +Y left, +Z up, RPY radians).
    const rawPose = raw.basePose as Partial<Record<keyof BasePose, unknown>> | undefined
    const basePose: BasePose = rawPose
      ? {
          x: finiteOr(rawPose.x, 0),
          y: finiteOr(rawPose.y, 0),
          z: finiteOr(rawPose.z, this.activeProfile.nominalPelvisHeight),
          roll: finiteOr(rawPose.roll, 0),
          pitch: finiteOr(rawPose.pitch, 0),
          yaw: finiteOr(rawPose.yaw, 0),
        }
      : { ...this.basePose }

    const telemetry: RobotTelemetry = {
      timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
      joints: normalizedJoints,
      batteryVoltage: typeof raw.batteryVoltage === 'number' ? raw.batteryVoltage : 24.0,
      batteryPercentage: typeof raw.batteryPercentage === 'number' ? raw.batteryPercentage : 85,
      pingLatency: typeof raw.pingLatency === 'number' ? raw.pingLatency : 18,
      linearVelocity: (raw.linearVelocity as { x: number; y: number }) || { x: 0, y: 0 },
      linearVelocityValid: raw.linearVelocity ? undefined : false,
      angularVelocity: (raw.angularVelocity as { z: number }) || { z: 0 },
      basePose,
      gaitBlend: typeof raw.gaitBlend === 'number' ? raw.gaitBlend : 0,
      emergencyStopped: Boolean(raw.emergencyStopped) || this.isEmergencyStopped,
    }

    this.latestSnapshot = telemetry
    return telemetry
  }

  private emitTelemetry(telemetry: RobotTelemetry): void {
    this.telemetryListeners.forEach((listener) => listener(telemetry))
  }

  public sendVelocityCommand(command: VelocityCommand): void {
    const modeMachine = getModeMachineForProfile(this.activeProfile)
    if (this.isEmergencyStopped) {
      if (this.socket && this.canSendCommands() && this.useBinaryCommands) {
        this.socket.send(encodeTeleopCmd(0, 0, 0, true, modeMachine))
      }
      return
    }

    // Never drive on a stale link: while the watchdog is tripped, command zero velocity.
    const halted = this.status === 'SAFETY_HALT'
    const clamp = (v: number, max: number) =>
      halted || !Number.isFinite(v) ? 0 : Math.min(max, Math.max(-max, v))
    const vx = clamp(command.vx, MAX_VX)
    const vy = clamp(command.vy, MAX_VY)
    const wz = clamp(command.vz, MAX_WZ)

    this.targetVelocity = { vx, vy, wz }

    if (this.socket && this.canSendCommands()) {
      if (this.useBinaryCommands) {
        const binCmd = encodeTeleopCmd(vx, vy, wz, this.isEmergencyStopped, modeMachine)
        this.socket.send(binCmd)
      } else {
        this.socket.send(
          JSON.stringify({
            type: 'cmd_vel',
            linear: { x: vx, y: vy, z: 0 },
            angular: { x: 0, y: 0, z: wz },
            timestamp: Date.now(),
          })
        )
      }
    }
  }

  public setTeleopVelocity(vx: number, vy: number, wz: number): void {
    this.sendVelocityCommand({ vx, vy, vz: wz })
  }

  public isBinaryLoopbackEnabled(): boolean {
    return this.binaryLoopbackEnabled
  }

  public setBinaryLoopback(enabled: boolean): void {
    this.binaryLoopbackEnabled = enabled
  }

  public isUseBinaryCommands(): boolean {
    return this.useBinaryCommands
  }

  public setUseBinaryCommands(enabled: boolean): void {
    this.useBinaryCommands = enabled
  }

  /**
   * Performs an immediate synchronous end-to-end self-test of the Unitree G1 binary codec.
   * Encodes a complete 29-DOF posture into a 2092-byte LowState_ buffer, validates CRC32,
   * and verifies bit-exact deserialization into a fresh snapshot.
   */
  public verifyBinaryCodec(): {
    success: boolean
    roundtripMaxJointDiff: number
    crcValid: boolean
    packetSize: number
  } {
    const testTelemetry: RobotTelemetry = {
      timestamp: Date.now(),
      joints: this.activeProfile.joints.map((j, i) => ({
        id: j.id,
        name: j.name,
        group: j.group,
        position: j.defaultPos + Math.sin(i * 0.3) * 0.2,
        velocity: Math.cos(i * 0.3) * 0.5,
        torque: 15 + i * 2,
        temperature: 36.5 + (i % 6) * 1.5,
        limitMin: j.limitMin,
        limitMax: j.limitMax,
        maxEffort: j.maxEffort,
      })),
      batteryVoltage: 24.5,
      batteryPercentage: 88,
      pingLatency: 14,
      linearVelocity: { x: 0.3, y: -0.1 },
      angularVelocity: { z: 0.25 },
      basePose: { x: 1.2, y: 0.4, z: 0.75, roll: 0.05, pitch: -0.08, yaw: 0.45 },
      gaitBlend: 0.6,
      emergencyStopped: false,
    }

    const buffer = createMockLowStateBuffer(testTelemetry, 1024, this.activeProfile)
    const target: RobotTelemetry = {
      timestamp: 0,
      joints: this.activeProfile.joints.map((j) => ({
        id: j.id,
        name: j.name,
        group: j.group,
        position: 0,
        velocity: 0,
        torque: 0,
        temperature: 0,
      })),
      batteryVoltage: 0,
      batteryPercentage: 0,
      pingLatency: 0,
      linearVelocity: { x: 0, y: 0 },
      angularVelocity: { z: 0 },
      basePose: { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 },
      emergencyStopped: false,
    }

    const crcValid = decodeLowState(buffer, target, true, this.activeProfile)

    let maxDiff = 0
    for (let i = 0; i < this.activeProfile.joints.length; i++) {
      const diff = Math.abs(testTelemetry.joints[i].position - target.joints[i].position)
      if (diff > maxDiff) maxDiff = diff
    }

    const success = crcValid && maxDiff < 1e-4
    return {
      success,
      roundtripMaxJointDiff: maxDiff,
      crcValid,
      packetSize: buffer.byteLength,
    }
  }

  /**
   * The E-stop latch is independent of link status: SAFETY_HALT is reserved for the
   * heartbeat watchdog so that latching/unlatching never fakes (or hides) a link state.
   */
  public setEmergencyStop(latched: boolean): void {
    // Read-only: a browser latch would stop nothing and suggest otherwise. Unlatching stays allowed.
    if (latched && this.isMonitorMode()) return
    if (latched) {
      this.targetVelocity = { vx: 0, vy: 0, wz: 0 }
      this.currentVelocity = { vx: 0, vy: 0, wz: 0 }
    }
    if (this.isEmergencyStopped !== latched) {
      this.isEmergencyStopped = latched
      this.eStopListeners.forEach((listener) => listener(latched))
    }

    if (this.socket && this.canSendCommands()) {
      if (this.useBinaryCommands) {
        const modeMachine = getModeMachineForProfile(this.activeProfile)
        const binCmd = encodeTeleopCmd(0, 0, 0, latched, modeMachine)
        this.socket.send(binCmd)
      } else {
        this.socket.send(
          JSON.stringify({
            type: 'emergency_stop',
            latched,
            timestamp: Date.now(),
          })
        )
      }
    }
  }

  public isEStopped(): boolean {
    return this.isEmergencyStopped
  }

  public switchToMock(): void {
    this.fallbackToMock()
  }

  public cleanup(): void {
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer)
      this.connectTimeoutTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
    this.stopMockGenerator()

    if (this.socket) {
      this.socket.onopen = null
      this.socket.onmessage = null
      this.socket.onerror = null
      this.socket.onclose = null
      try {
        this.socket.close()
      } catch {
        // Safe ignore
      }
      this.socket = null
    }
  }
}

export const telemetryService = new TelemetryStreamService()

// Vite HMR re-evaluates this module; tear down the old instance's socket and 50 Hz timers.
if (import.meta.hot) {
  import.meta.hot.dispose(() => telemetryService.cleanup())
}
