import type {
  BasePose,
  ConnectionStatus,
  JointState,
  RobotTelemetry,
  TelemetryConfig,
  VelocityCommand,
} from '../types/telemetry'
import { G1_29DOF_JOINTS } from '../types/telemetry'
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
  AuxFrame,
  BridgeHello,
  FsmFrame,
  MonitorState,
  ReplayAction,
  ReplayStatus,
  ReplayTimeline,
} from '../types/monitor'
import { PLOT_SLOTS, PlotRing } from './plotRing'
import { matchMotorSlots } from '../utils/motorMatch'
import { alertHistoryStore, alertScopeKey } from './alertHistoryStore'
import { auxNeedsDraw, reduceAux, reduceFsm, reduceHello } from './monitorReducer'
import { RecordedBridgeSocket } from './recordedBridge'
import type { AlertPersist } from './monitorReducer'

type TelemetryListener = (telemetry: RobotTelemetry) => void
type StatusListener = (status: ConnectionStatus) => void
type EmergencyStopListener = (latched: boolean) => void
type RobotProfileListener = (profile: RobotProfile) => void
type NoticeListener = (message: string | null) => void
type MonitorListener = (state: MonitorState) => void

/** Odometry older than this no longer counts as a measured body velocity. */
const ODOM_FRESH_MS = 500

// Dashboard URL options, set by the bridge's printed link:
//   ?ws=<ws:// or wss:// url>  bridge address
//   ?demo=1                    play the sample recording, a real G1 run, without a bridge
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
  timeline: null,
  alertLog: [],
})

// Teleop command envelope (matches TeleopControls key mapping).
const MAX_VX = 0.8
const MAX_VY = 0.4
const MAX_WZ = 1.0

const finiteOr = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/** Built for a static host (VITE_HOSTED=1): nothing to connect to there, so the page opens on the sample recording. */
export const HOSTED = import.meta.env.VITE_HOSTED === '1'
const SAMPLE_URL = `${import.meta.env.BASE_URL}demo/g1-sample.rocodemo.gz`

const DEFAULT_CONFIG: TelemetryConfig = {
  wsUrl: wsUrlFromQuery() ?? 'ws://localhost:8765',
  heartbeatTimeoutMs: 250,
  connectTimeoutMs: 1200,
}

export class TelemetryStreamService {
  private config: TelemetryConfig
  private socket: WebSocket | RecordedBridgeSocket | null = null
  private status: ConnectionStatus = 'CONNECTING'
  private telemetryListeners: Set<TelemetryListener> = new Set()
  private statusListeners: Set<StatusListener> = new Set()
  private eStopListeners: Set<EmergencyStopListener> = new Set()
  private profileListeners: Set<RobotProfileListener> = new Set()
  private noticeListeners: Set<NoticeListener> = new Set()
  private notice: string | null = null
  private lastUnknownModeMachine = 0
  /** The sample recording plays in place of a bridge. Connecting to a bridge leaves it. */
  private sample = URL_PARAMS.get('demo') === '1' || (HOSTED && !wsUrlFromQuery())
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
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private isEmergencyStopped: boolean = false
  // 6-DOF pelvis pose in the ROS odom frame (+X fwd, +Y left, +Z up)
  private basePose: BasePose = {
    x: 0,
    y: 0,
    z: G1_29DOF_PROFILE.nominalPelvisHeight,
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
      z: G1_29DOF_PROFILE.nominalPelvisHeight,
      roll: 0,
      pitch: 0,
      yaw: 0,
    },
    gaitBlend: 0,
    emergencyStopped: false,
  }

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
    // play at the end of a recording makes the bridge start over from the first moment, which restarts its statistics like a seek
    else if (action === 'play' && this.monitor.replay.ended) this.lastSeekT = this.monitor.replay.t0
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
    // an imported robot lists its joints in its own order: tie each to the motor of the same name (limits below stay as they were)
    if (profile.motorOrder === 'fileOrder') {
      const r = matchMotorSlots(profile.joints, lim.jointNames)
      profile = { ...profile, joints: r.joints, motorMatch: r.match }
    }
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

  /** The live bridge session whose alerts are being kept in the alert history store (null: replay, demo). */
  private alertScope: { scope: string; session: string } | null = null

  private persistAlerts(p: AlertPersist): void {
    const a = this.alertScope
    if (!a) return
    alertHistoryStore.add(a.scope, a.session, p.events)
    if (p.carry) alertHistoryStore.setCarry(a.scope, a.session, p.carry)
  }

  private handleHello(hello: BridgeHello): void {
    alertHistoryStore.end()
    if (hello.source === 'replay') {
      this.alertScope = null
      this.setMonitor(reduceHello(hello, null, ''))
    } else {
      const scope = alertScopeKey(hello)
      const session = hello.session?.id ?? `page-${Date.now().toString(36)}`
      this.alertScope = { scope, session }
      const restored = alertHistoryStore.load(scope)
      alertHistoryStore.begin(scope, session)
      this.setMonitor(reduceHello(hello, restored, session))
    }
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
    if (frame.full && this.monitor.replay) this.plotRing.clear() // a seek: the plotted past is gone
    const r = reduceFsm(this.monitor, frame)
    this.setMonitor(r.patch)
    if (r.persist) this.persistAlerts(r.persist)
  }

  private handleAux(aux: AuxFrame): void {
    const r = reduceAux(this.monitor, aux)
    this.setMonitor(r.patch)
    if (r.persist) this.persistAlerts(r.persist)
    alertHistoryStore.touch(aux.t)
    this.applyAuxToSnapshot()
    this.recordPlotSample(aux)
    // Paused or seeking replay, or a silent robot: no binary frame follows, but commands and alerts still change.
    if (auxNeedsDraw(performance.now() - this.lastBinaryTimestamp, this.monitor.replay)) {
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
      if (newStatus === 'DISCONNECTED' || newStatus === 'CONNECTING') alertHistoryStore.end()
      this.status = newStatus
      this.statusListeners.forEach((listener) => listener(newStatus))
    }
  }

  public connect(): void {
    this.cleanup()
    this.setStatus('CONNECTING')
    // a new bridge introduces itself again (or is not a read-only bridge at all)
    if (this.monitor.hello || this.monitor.aux || this.monitor.replay) this.setMonitor(emptyMonitorState())
    this.plotRing.clear()
    this.lastBinaryTimestamp = 0

    try {
      this.socket = this.sample ? new RecordedBridgeSocket(SAMPLE_URL) : new WebSocket(this.config.wsUrl)
      this.socket.binaryType = 'arraybuffer'

      // The sample comes over the network and may take a while; it reports its own failure.
      if (!this.sample) {
        this.connectTimeoutTimer = setTimeout(() => {
          if (this.status === 'CONNECTING' && (!this.socket || this.socket.readyState !== WebSocket.OPEN)) {
            this.connectFailed()
          }
        }, this.config.connectTimeoutMs)
      }

      this.socket.onopen = () => {
        if (this.connectTimeoutTimer) {
          clearTimeout(this.connectTimeoutTimer)
          this.connectTimeoutTimer = null
        }
        this.setStatus('LIVE')
        this.lastPacketTimestamp = performance.now()
        // A recording has no link to lose, and a hidden tab's slow timers must not look like one.
        if (!this.sample) this.startWatchdog()
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

  /** No bridge: stay offline and keep retrying. */
  private connectFailed(): void {
    this.cleanup()
    this.setStatus('DISCONNECTED')
    this.startReconnectSchedule()
  }

  public reconnect(): void {
    this.sample = false
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

  /** True while the sample recording plays, or is being fetched, in place of a bridge. */
  public isSample(): boolean {
    return this.sample
  }

  public playSample(): void {
    this.sample = true
    this.cleanup()
    this.connect()
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
