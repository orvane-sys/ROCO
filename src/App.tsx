import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ConnectScreen } from './components/ConnectScreen'
import { StatusBar } from './components/StatusBar'
import { WorkspaceBar } from './components/WorkspaceBar'
import { Cockpit } from './components/Cockpit'
import { AppearanceDialog } from './components/AppearanceDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { CommandPalette, type PaletteCommand } from './components/CommandPalette'
// three.js, urdf-loader and the mesh loaders make up most of the bundle; load them after the cockpit shell
// so the status bar, drive controls and E-stop are interactive immediately.
const DigitalTwin = lazy(() =>
  import('./components/DigitalTwin').then((m) => ({ default: m.DigitalTwin }))
)
// The importer pulls in the mesh loaders and parsers, so it loads only when the dialog is opened.
const ImportRobotDialog = lazy(() =>
  import('./components/ImportRobotDialog').then((m) => ({ default: m.ImportRobotDialog }))
)
import { MotorTelemetryGrid } from './components/MotorTelemetryGrid'
import { TeleopControls } from './components/TeleopControls'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ShortcutHelp } from './components/ShortcutHelp'
import { StateCard } from './components/StateCard'
import { AbortNote, NextStepCard } from './components/NextStepCard'
import { KeyLimits } from './components/KeyLimits'
import { AlertsPanel } from './components/AlertsPanel'
import { AbortChecks } from './components/AbortChecks'
import { GuidedChecks } from './components/GuidedChecks'
import { SessionTimeline } from './components/SessionTimeline'
import { ReportCard } from './components/ReportCard'
import { Tour } from './components/Tour'
import { tourSeen } from './services/tourPrefs'
import { timelineAlerts, useTimelineAlerts } from './services/timelineAlerts'
import { ConnectionChecks } from './components/ConnectionChecks'
import { connectionChecks } from './utils/connectionChecks'
import { AlertAnnouncer } from './components/AlertAnnouncer'
import { LinkHealth } from './components/LinkHealth'
import { SegmentTable } from './components/SegmentTable'
import { ReplayControls } from './components/ReplayControls'
import { JointPlot } from './components/JointPlot'
import { telemetryService } from './services/telemetryStream'
import { acknowledge, getAlertControls, resetAlertControls, unshelveAll, useAlertControls } from './services/alertControls'
import { playTestTone, prepareAudio, soundSupported, speak, speechSupported, useAudioRunning } from './services/alertCues'
import { buildAlertView, evaluateAbortChecks } from './utils/alertModel'
import { evaluateProcedure, newReachedOk } from './utils/procedureModel'
import { buildTimeline } from './utils/timelineModel'
import { buildReport } from './utils/sessionReport'
import { alertTitle } from './utils/monitorFormat'
import { motorOrderNote } from './utils/motorMatch'
import { addMarkNow } from './services/addMark'
import { marksStore, useMarks, type MarkScope } from './services/marksStore'
import { setPlotSet, setWindow } from './services/plotPrefs'
import { viewStore } from './services/viewStore'
import { PLOT_WINDOWS, SHIPPED_SETS } from './config/plotSets'
import { opsOf, procDataOf, procedureStore, useProcedureState, type ProcScope } from './services/procedureStore'
import { PROCEDURES } from './config/procedures/g1_type6'
import {
  SCENE3D_PREFS,
  TEXT_SCALES,
  THEME_PREFS,
  WORKSPACES,
  resolveScene3d,
  setScene3d,
  setSound,
  setSpeech,
  setSplit,
  setTextScale,
  setTheme,
  setWorkspace,
  useUiPrefs,
  type Workspace,
} from './services/uiPrefs'
import type { RobotProfile } from './config/robotRegistry'
import type { MonitorState } from './types/monitor'
import { cn } from './utils/cn'
import type {
  ConnectionStatus,
  RobotTelemetry,
  VelocityCommand,
} from './types/telemetry'
import { AlertTriangle, ShieldAlert } from 'lucide-react'

/** Column widths (percent) when a layout has no saved ones, for the columns that are visible. */
const DEFAULT_WIDTHS: Record<Workspace | 'drive', number[]> = {
  run: [30, 40, 30],
  analyze: [56, 44],
  review: [58, 42],
  drive: [58, 42],
}

const isTypingTarget = (el: Element | null) =>
  el instanceof HTMLInputElement ||
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement ||
  (el instanceof HTMLElement && el.isContentEditable)

export function App() {
  const [telemetry, setTelemetry] = useState<RobotTelemetry | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>(
    telemetryService.getStatus()
  )
  const [activeProfile, setActiveProfile] = useState<RobotProfile>(
    telemetryService.getActiveRobotProfile()
  )
  const [selectedJointId, setSelectedJointId] = useState<string | null>(null)
  const [wsUrl, setWsUrl] = useState<string>(telemetryService.getConfig().wsUrl)
  const [isEStopped, setIsEStopped] = useState<boolean>(telemetryService.isEStopped())
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isHelpOpen, setIsHelpOpen] = useState(false)
  const [isAppearanceOpen, setIsAppearanceOpen] = useState(false)
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [isPaletteOpen, setIsPaletteOpen] = useState(false)
  const [tourManual, setIsTourOpen] = useState(false)
  const [tourDismissed, setTourDismissed] = useState(false)
  // an element id to focus once the next render has put it on the page (after a workspace switch)
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null)
  const ui = useUiPrefs()
  const [notice, setNotice] = useState<string | null>(null)
  const [monitor, setMonitor] = useState<MonitorState>(telemetryService.getMonitorState())
  const alertControls = useAlertControls()
  const audioRunning = useAudioRunning()
  // The first connection attempt has failed: show the connect screen instead of an empty cockpit.
  const [sawDisconnect, setSawDisconnect] = useState(false)

  useEffect(() => {
    let lastRenderTime = 0
    const unsubTelemetry = telemetryService.subscribeTelemetry((data) => {
      const now = performance.now()
      // Throttle React state updates to ~15 Hz (66ms) to keep DOM diffing lightweight
      if (now - lastRenderTime >= 66) {
        lastRenderTime = now
        // The service mutates and re-emits one pre-allocated snapshot (binary path). React bails out
        // of setState for an identical reference and memoized children key off `joints`, so hand
        // React a fresh copy at this throttled rate (~15 Hz × 29 small objects is negligible).
        setTelemetry({
          ...data,
          joints: data.joints.map((j) => ({ ...j })),
          basePose: data.basePose ? { ...data.basePose } : undefined,
          imu: data.imu
            ? {
                ...data.imu,
                quaternion: [...data.imu.quaternion] as typeof data.imu.quaternion,
                gyroscope: [...data.imu.gyroscope] as typeof data.imu.gyroscope,
                accelerometer: [...data.imu.accelerometer] as typeof data.imu.accelerometer,
              }
            : undefined,
          linearVelocity: { ...data.linearVelocity },
          angularVelocity: { ...data.angularVelocity },
        })
      }
    })

    const unsubStatus = telemetryService.subscribeStatus((newStatus) => {
      setStatus(newStatus)
      if (newStatus === 'DISCONNECTED') setSawDisconnect(true)
      else if (newStatus === 'LIVE') setSawDisconnect(false)
    })

    const unsubProfile = telemetryService.subscribeRobotProfile((newProfile) => {
      setActiveProfile(newProfile)
      setSelectedJointId(null)
    })

    const unsubNotice = telemetryService.subscribeNotice(setNotice)

    // Bridge frames arrive at the bridge rate (50 Hz aux); render them at ~10 Hz, keeping the last one.
    let lastMonitorRender = 0
    let monitorTimer: number | undefined
    const unsubMonitor = telemetryService.subscribeMonitor((m) => {
      const wait = 100 - (performance.now() - lastMonitorRender)
      window.clearTimeout(monitorTimer)
      const apply = () => {
        lastMonitorRender = performance.now()
        setMonitor(telemetryService.getMonitorState())
      }
      if (wait <= 0 || m.aux === null) apply()
      else monitorTimer = window.setTimeout(apply, wait)
    })

    // E-stop latch is pushed immediately (not via the 15 Hz throttled telemetry path).
    const unsubEStop = telemetryService.subscribeEmergencyStop((latched) => {
      setIsEStopped(latched)
    })

    return () => {
      unsubTelemetry()
      unsubStatus()
      unsubProfile()
      unsubEStop()
      unsubNotice()
      unsubMonitor()
      window.clearTimeout(monitorTimer)
    }
  }, [])

  // Stable identities: TeleopControls' 50 Hz loop must not be rebuilt on every telemetry render.
  const handleVelocityChange = useCallback((cmd: VelocityCommand) => {
    telemetryService.sendVelocityCommand(cmd)
  }, [])

  const handleSelectProfile = useCallback((profileId: string) => {
    telemetryService.setActiveRobotProfile(profileId)
    setSelectedJointId(null)
  }, [])

  const handleEmergencyStopToggle = useCallback((latched: boolean) => {
    telemetryService.setEmergencyStop(latched)
  }, [])

  const handleOpenHelp = useCallback(() => setIsHelpOpen(true), [])
  const handleCloseHelp = useCallback(() => setIsHelpOpen(false), [])

  // The sample's last pose must not stay on screen as if a bridge had sent it.
  const leaveSample = useCallback(() => {
    if (telemetryService.isSample()) setTelemetry(null)
  }, [])

  const handleUpdateConfig = useCallback((config: { wsUrl: string }) => {
    setWsUrl(config.wsUrl)
    leaveSample()
    telemetryService.updateConfig(config)
  }, [leaveSample])

  const handlePlaySample = useCallback(() => {
    telemetryService.playSample()
  }, [])

  const handleReconnect = useCallback(() => {
    leaveSample()
    telemetryService.reconnect()
  }, [leaveSample])

  // Read-only bridge: no drive panel and no browser E-stop (it could not stop anything).
  const isMonitor = monitor.hello?.readOnly === true || telemetryService.isMonitorMode()
  const workspace: Workspace | null = isMonitor ? ui.workspace : null
  const showConnectScreen = !telemetry && !monitor.hello && (status === 'DISCONNECTED' || (status === 'CONNECTING' && sawDisconnect))
  const [tourWasSeen] = useState(tourSeen)
  const tourDue = !tourWasSeen && !tourDismissed && isMonitor && monitor.hello !== null && !showConnectScreen && workspace === 'run'
  const anyDialogOpen = isSettingsOpen || isHelpOpen || isImportOpen || isAppearanceOpen || isPaletteOpen || tourManual || tourDue

  const goToWorkspace = useCallback((w: Workspace, focus?: string) => {
    setWorkspace(w)
    if (focus) setFocusRequest({ id: focus })
  }, [])

  useEffect(() => {
    if (focusRequest) document.getElementById(focusRequest.id)?.focus()
  }, [focusRequest])

  // a new bridge session or replay file: what was seen and shelved belongs to the old one
  useEffect(() => {
    resetAlertControls()
  }, [monitor.hello])

  const alertView = useMemo(() => buildAlertView(monitor, alertControls), [monitor, alertControls])
  const abortChecks = useMemo(() => evaluateAbortChecks(monitor, alertControls), [monitor, alertControls])
  const abortTrips = abortChecks.filter((c) => c.status === 'trip').length

  // guided checks: a recording keeps its ticks in memory and forgets them when another one opens; live ticks last for the day
  const procScope: ProcScope = monitor.hello?.source === 'replay' ? 'replay' : 'live'
  const procState = useProcedureState(procScope)
  const reachedOk = useRef(newReachedOk())
  useEffect(() => {
    procedureStore('replay').reset()
    reachedOk.current = newReachedOk()
  }, [monitor.hello])
  const procResult = useMemo(() => {
    if (!isMonitor) return null
    const proc = PROCEDURES.find((p) => p.id === procState.procedure) ?? PROCEDURES[0]
    return evaluateProcedure(proc, monitor, { ...opsOf(procDataOf(procState, proc.id)), latch: reachedOk.current })
  }, [isMonitor, monitor, procState])
  const stageStops = procResult?.counts.stop ?? 0
  // what the announcer says besides alerts: a tripped abort check or a crossed stop limit, once each
  const limitCues = useMemo(
    () => [
      ...abortChecks.filter((c) => c.status === 'trip').map((c) => ({ id: `abort:${c.key}`, text: `Abort check tripped: ${c.label}. ${c.detail}` })),
      ...(procResult?.stages.flatMap((s) => s.items).filter((r) => r.status === 'stop').map((r) => ({ id: `stop:${procResult.procedure.id}:${r.item.id}`, text: `Stop limit crossed: ${r.item.text} ${r.detail ?? ''}` })) ?? []),
    ],
    [abortChecks, procResult],
  )

  // the session timeline: alerts are remembered for the whole session (and across replay seeks), marks are the operator's
  const marksScope: MarkScope = monitor.hello?.source === 'replay' ? 'replay' : 'live'
  const marks = useMarks(marksScope)
  useEffect(() => {
    marksStore('replay').clear()
    viewStore.unfreeze()
  }, [monitor.hello])
  const rememberedAlerts = useTimelineAlerts()
  useEffect(() => {
    timelineAlerts.reset()
  }, [monitor.hello])
  useEffect(() => {
    timelineAlerts.merge(alertView, telemetryService.getLastSeek())
  }, [alertView])
  const timeline = useMemo(() => {
    const ring = telemetryService.getPlotRing()
    return buildTimeline(monitor, rememberedAlerts, marks, { first: ring.firstTime(), last: ring.latestTime() })
  }, [monitor, rememberedAlerts, marks])

  // reads the latest state when called, so its identity never changes (the key handler and palette depend on it)
  const handleAcknowledgeAll = useCallback(() => {
    const m = telemetryService.getMonitorState()
    const controls = getAlertControls()
    const keys = buildAlertView(m, controls)
      .groups.flatMap((g) => [g.first, ...g.rest])
      .filter((i) => i.active)
      .map((i) => i.key)
    acknowledge([...keys, ...evaluateAbortChecks(m, controls).filter((c) => c.status === 'trip').map((c) => c.key)])
  }, [])

  const handleToggleSound = useCallback(() => {
    if (ui.sound) {
      setSound(false)
      return
    }
    setSound(true)
    // this click is the user gesture the browser needs before it allows sound
    void prepareAudio().then((ok) => {
      if (ok) playTestTone()
    })
  }, [ui.sound])
  const handleToggleSpeech = useCallback(() => {
    if (ui.speech) {
      setSpeech(false)
      return
    }
    setSpeech(true)
    speak('Voice on')
  }, [ui.speech])

  const replay = monitor.replay
  const toggleReplay = useCallback(() => {
    if (replay && !replay.busy) telemetryService.sendReplayControl(replay.playing ? 'pause' : 'play')
  }, [replay])

  // Keys that belong to this page. Driving keys live in TeleopControls (which also owns ? in drive mode).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (!e.repeat) setIsPaletteOpen((open) => !open)
        return
      }
      if (anyDialogOpen || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(document.activeElement)) return
      // Monitor only: in drive mode / would move the focus into the filter box, and the driving keys would type there.
      if (!isMonitor) return
      if (e.key === '/') {
        e.preventDefault()
        goToWorkspace('analyze', 'joint-filter')
      } else if (e.key === '1' || e.key === '2' || e.key === '3') {
        e.preventDefault()
        goToWorkspace(WORKSPACES[Number(e.key) - 1].id)
      } else if (e.key === '?') {
        e.preventDefault()
        setIsHelpOpen(true)
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        toggleReplay()
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault()
        handleAcknowledgeAll()
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        addMarkNow()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [anyDialogOpen, isMonitor, goToWorkspace, toggleReplay, handleAcknowledgeAll])

  const handleSelectSlot = useCallback(
    (slot: number) => {
      const def = activeProfile.joints.find((j, i) => (j.sdkMotorIndex ?? i) === slot)
      if (def) setSelectedJointId(def.id)
    },
    [activeProfile]
  )

  // the status bar chip: when the only thing crossed is a guided-check stop limit, the Alerts list has nothing to show, so go to the checks
  const onlyStageStops = alertView.counts.critical + alertView.counts.warn + abortTrips === 0 && stageStops > 0
  const handleShowAlerts = useCallback(() => goToWorkspace('run', onlyStageStops ? 'guided-checks' : 'alerts'), [goToWorkspace, onlyStageStops])
  const handleOpenSettings = useCallback(() => setIsSettingsOpen(true), [])
  const handleOpenImport = useCallback(() => {
    setIsSettingsOpen(false)
    setIsImportOpen(true)
  }, [])

  // Robot-side E-stop reported by a live bridge also counts as latched.
  const isEmergencyStopped = !isMonitor && (isEStopped || Boolean(telemetry?.emergencyStopped))
  const isLinkLost = status === 'DISCONNECTED' && telemetry !== null
  const isWatchdogHalt = status === 'SAFETY_HALT' || isLinkLost
  const isSafetyHalt = isWatchdogHalt || isEmergencyStopped

  const layoutKey: Workspace | 'drive' = workspace ?? 'drive'
  const quality = resolveScene3d(ui.scene3d, workspace, monitor.hello?.source ?? null)

  const commands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = []
    if (isMonitor) {
      for (const w of WORKSPACES) list.push({ id: `ws-${w.id}`, group: 'Workspace', label: `${w.label}: ${w.hint}`, keywords: w.label, hint: w.key, run: () => goToWorkspace(w.id) })
      list.push({ id: 'alerts', group: 'Go to', label: 'Alerts', keywords: 'first-out critical warning', run: () => goToWorkspace('run', 'alerts') })
      list.push({ id: 'joint-filter', group: 'Go to', label: 'Filter the joint table', hint: '/', run: () => goToWorkspace('analyze', 'joint-filter') })
    }
    for (const j of activeProfile.joints) {
      list.push({
        id: `joint-${j.id}`,
        group: 'Joint',
        label: j.name,
        keywords: j.id.replace(/_/g, ' '),
        run: () => {
          setSelectedJointId(j.id)
          if (isMonitor) goToWorkspace('analyze')
        },
      })
    }
    if (isMonitor) {
      list.push({ id: 'ack-all', group: 'Alerts', label: 'Acknowledge all active alerts', hint: 'A', keywords: 'seen ack', run: handleAcknowledgeAll })
      list.push({ id: 'unshelve', group: 'Alerts', label: 'Restore shelved warnings', keywords: 'shelve unshelve', run: () => unshelveAll() })
      if (soundSupported()) list.push({ id: 'sound', group: 'Alerts', label: ui.sound ? 'Tone for critical alerts: turn off' : 'Tone for critical alerts: turn on', keywords: 'sound audio beep', run: handleToggleSound })
      if (speechSupported()) list.push({ id: 'voice', group: 'Alerts', label: ui.speech ? 'Voice: turn off' : 'Voice: turn on', keywords: 'speech speak say', run: handleToggleSpeech })
    }
    if (isMonitor) {
      list.push({ id: 'mark', group: 'Timeline', label: 'Add a mark here', hint: 'M', keywords: 'note flag bookmark', run: () => void addMarkNow() })
      list.push({ id: 'freeze', group: 'Plots', label: 'Freeze or resume the plots', keywords: 'pause hold unfreeze', run: () => (viewStore.get().frozen ? viewStore.unfreeze() : viewStore.freeze()) })
      for (const w of PLOT_WINDOWS) list.push({ id: `win-${w}`, group: 'Plots', label: `Plot window: ${w} s`, keywords: 'time span seconds', run: () => { setWindow(w); goToWorkspace('analyze') } })
      for (const ps of SHIPPED_SETS) list.push({ id: `set-${ps.id}`, group: 'Plots', label: `Plot set: ${ps.label}`, keywords: 'signals ankle knee balance squat', run: () => { setPlotSet(ps.id); goToWorkspace('analyze') } })
      list.push({ id: 'report', group: 'Review', label: 'Go to the session report', keywords: 'download markdown handover', run: () => goToWorkspace('review', 'report-heading') })
      list.push({ id: 'tour', group: 'Open', label: 'Show the welcome tour', keywords: 'help intro first run', run: () => setIsTourOpen(true) })
    }
    if (replay) list.push({ id: 'replay-toggle', group: 'Replay', label: replay.playing ? 'Pause' : 'Play', hint: 'K', run: toggleReplay })
    for (const t of THEME_PREFS) list.push({ id: `theme-${t.value}`, group: 'Theme', label: t.label, keywords: 'colour color display dark light contrast', run: () => setTheme(t.value) })
    for (const n of TEXT_SCALES) list.push({ id: `text-${n}`, group: 'Text size', label: `${n}%`, keywords: 'font larger bigger', run: () => setTextScale(n) })
    for (const q of SCENE3D_PREFS) list.push({ id: `3d-${q.value}`, group: '3D view', label: q.label, keywords: 'quality performance fps off', run: () => setScene3d(q.value) })
    list.push({ id: 'reset-cols', group: 'Layout', label: 'Reset column widths', keywords: 'splitter resize', run: () => setSplit(layoutKey, null) })
    list.push({ id: 'display', group: 'Open', label: 'Display settings', run: () => setIsAppearanceOpen(true) })
    list.push({ id: 'settings', group: 'Open', label: 'Settings: connection, robot model, protocol', run: () => setIsSettingsOpen(true) })
    list.push({ id: 'help', group: 'Open', label: 'Keyboard shortcuts', hint: '?', run: () => setIsHelpOpen(true) })
    list.push({ id: 'reconnect', group: 'Connection', label: 'Reconnect to the bridge', run: () => telemetryService.reconnect() })
    return list
  }, [isMonitor, activeProfile, replay, layoutKey, ui.sound, ui.speech, goToWorkspace, toggleReplay, handleToggleSound, handleToggleSpeech, handleAcknowledgeAll])

  const twin = (
    <div
      className={cn(
        'h-[26rem] xl:min-h-[19rem] flex flex-col',
        isMonitor ? 'xl:h-full' : 'xl:h-[min(46vh,39rem)] shrink-0'
      )}
    >
      <ErrorBoundary label="The 3D view">
        <Suspense
          fallback={
            <div
              role="status"
              className="flex-1 flex items-center justify-center bg-sunken rounded-xl border border-line/80 text-sm text-ink-soft"
            >
              Loading 3D view…
            </div>
          }
        >
          <DigitalTwin status={status} activeProfile={activeProfile} selectedJointId={selectedJointId} quality={quality} />
        </Suspense>
      </ErrorBoundary>
    </div>
  )

  const joints = (
    <MotorTelemetryGrid
      joints={telemetry?.joints ?? []}
      profile={activeProfile}
      selectedJointId={selectedJointId}
      onSelectJoint={setSelectedJointId}
      monitor={isMonitor ? monitor : null}
    />
  )

  const alerts = <AlertsPanel state={monitor} profile={activeProfile} view={alertView} stageStops={stageStops} onSelectSlot={handleSelectSlot} defaultShowHistory={workspace === 'review'} />
  const checks = <AbortChecks checks={abortChecks} state={monitor} />
  const guided = procResult ? <GuidedChecks state={monitor} scope={procScope} procState={procState} result={procResult} big={workspace === 'run'} /> : null

  // first run: a short tour of the Run workspace, once per browser

  const checksCard = isMonitor && !monitor.replay ? connectionChecks(monitor, wsUrl) : null
  const waiting = checksCard !== null && checksCard.some((c) => !c.ok)

  const reportCard = isMonitor ? (
    <ReportCard
      build={() =>
        buildReport({
          state: telemetryService.getMonitorState(),
          profileName: activeProfile.name,
          motorNote: motorOrderNote(activeProfile.motorOrder, activeProfile.motorMatch),
          generatedAt: new Date(),
          timeline,
          alertTitle: (a) => alertTitle(a, activeProfile, monitor),
          abortChecks,
          procedure: procResult,
        })
      }
    />
  ) : null

  let left: React.ReactNode = null
  let right: React.ReactNode = null
  let centerExtra: React.ReactNode = null
  if (!isMonitor) {
    centerExtra = (
      <div id="teleop" tabIndex={-1} className="shrink-0 outline-none">
        <TeleopControls
          onVelocityChange={handleVelocityChange}
          onEmergencyStopToggle={handleEmergencyStopToggle}
          onOpenHelp={handleOpenHelp}
          isEmergencyStopped={isEmergencyStopped}
          inputSuspended={anyDialogOpen}
          linearVelocity={telemetry?.linearVelocity ?? { x: 0, y: 0 }}
          linearVelocityValid={telemetry?.linearVelocityValid !== false}
          angularVelocity={telemetry?.angularVelocity ?? { z: 0 }}
        />
      </div>
    )
    right = joints
  } else if (workspace === 'run') {
    left = (
      <>
        {alerts}
        {checks}
        <KeyLimits state={monitor} telemetry={telemetry} profile={activeProfile} />
      </>
    )
    right = (
      <>
        {waiting && checksCard && <ConnectionChecks checks={checksCard} heading="Waiting for data" />}
        <StateCard state={monitor} />
        {guided}
        <NextStepCard state={monitor} />
        <AbortNote replay={monitor.replay !== null} />
      </>
    )
  } else if (workspace === 'analyze') {
    left = (
      <>
        <JointPlot profile={activeProfile} state={monitor} selectedJointId={selectedJointId} onSelectJoint={setSelectedJointId} />
        <LinkHealth state={monitor} telemetry={telemetry} />
      </>
    )
    right = joints
  } else {
    left = (
      <>
        <SegmentTable state={monitor} />
        {alerts}
        {checks}
        {guided}
        {reportCard}
      </>
    )
  }

  const names =
    workspace === 'run'
      ? { left: 'alerts', center: '3D view', right: 'state and keys' }
      : workspace === 'analyze'
      ? { left: 'plots', center: '3D view', right: 'joint table' }
      : workspace === 'review'
      ? { left: 'per-state numbers', center: '3D view', right: 'right column' }
      : { left: 'left column', center: '3D view and controls', right: 'joint motors' }

  return (
    <div className="flex flex-col h-dvh w-screen bg-canvas text-ink overflow-hidden">
      <a
        href={isMonitor ? '#workspace-panel' : '#teleop'}
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:rounded-lg focus:bg-accent focus:text-on-accent focus:font-semibold"
      >
        {isMonitor ? 'Skip to the workspace' : 'Skip to drive controls'}
      </a>

      <StatusBar
        status={status}
        monitor={monitor}
        isMonitor={isMonitor}
        profile={activeProfile}
        pingLatency={telemetry ? telemetry.pingLatency : null}
        batteryVoltage={isMonitor ? monitor.aux?.battery?.motorVoltage ?? null : telemetry ? telemetry.batteryVoltage : null}
        batteryPercentage={isMonitor ? monitor.aux?.battery?.soc ?? null : telemetry ? telemetry.batteryPercentage : null}
        view={alertView}
        abortTrips={abortTrips}
        stageStops={stageStops}
        sound={ui.sound}
        speech={ui.speech}
        audioRunning={audioRunning}
        speechAvailable={speechSupported()}
        onToggleSound={handleToggleSound}
        onToggleSpeech={handleToggleSpeech}
        onShowAlerts={handleShowAlerts}
        onOpenRobotSettings={handleOpenSettings}
      />
      <AlertAnnouncer state={monitor} view={alertView} profile={activeProfile} sound={ui.sound} speech={ui.speech} limits={limitCues} />

      <WorkspaceBar
        workspace={workspace}
        onWorkspace={goToWorkspace}
        onOpenPalette={() => setIsPaletteOpen(true)}
        onOpenHelp={handleOpenHelp}
        onOpenDisplay={() => setIsAppearanceOpen(true)}
        onOpenSettings={handleOpenSettings}
      />

      {/* Safety Alert Banner (steady, not animated: constant motion competes with reading) */}
      {isSafetyHalt && (
        <div
          role="alert"
          className="bg-crit-solid text-on-solid px-4 py-2 border-b border-crit flex items-center justify-between gap-3 text-sm font-semibold z-10 shadow-lg shadow-crit-soft/40"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 shrink-0" aria-hidden="true" />
            <span>
              {isEmergencyStopped
                ? 'Emergency stop latched. Actuator drive is disabled.'
                : isLinkLost
                ? 'Connection to the bridge lost. The readings below are not live; retrying every 3 s.'
                : isMonitor
                ? 'No robot state for over 250 ms. The readings below are not live.'
                : 'Watchdog safety halt. No data for over 250 ms, so actuator drive is disabled.'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => (isEmergencyStopped ? handleEmergencyStopToggle(false) : handleReconnect())}
            className="px-3 py-1.5 bg-on-solid text-crit-solid hover:bg-on-solid/85 rounded text-sm font-bold transition-colors flex items-center gap-1.5 shrink-0"
          >
            <ShieldAlert className="w-4 h-4" aria-hidden="true" />
            {isEmergencyStopped ? 'Reset E-stop' : 'Reconnect'}
          </button>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="bg-warn-soft/70 text-warn-ink px-4 py-2 border-b border-warn-line/60 flex items-center justify-between gap-3 text-sm"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="px-2.5 py-1 rounded border border-warn-ink/60 hover:bg-warn-soft/60 text-xs font-semibold shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {monitor.hello?.demo && (
        <div
          role="status"
          className="bg-demo-soft/70 text-demo-ink px-4 py-2 border-b border-demo/60 text-sm font-semibold"
        >
          Sample recording · {monitor.hello.demo.title} · recorded {monitor.hello.demo.recorded} · not a live robot
        </div>
      )}

      {showConnectScreen && (
        <ConnectScreen
          monitor={monitor}
          wsUrl={wsUrl}
          connecting={status === 'CONNECTING'}
          sample={telemetryService.isSample()}
          onRetry={handleReconnect}
          onPlaySample={handlePlaySample}
        />
      )}

      {/* Stacked and scrolling on small screens. From xl the columns sit side by side and scroll on their own; on a short screen the page scrolls to the timeline instead of squeezing the columns. */}
      {!showConnectScreen && (
        <main className="flex-1 min-h-0 overflow-y-auto p-3 lg:p-4 flex flex-col gap-4">
          {isMonitor && replay && <ReplayControls state={monitor} compact={workspace !== 'review'} />}
          <div
            id="workspace-panel"
            role={workspace ? 'tabpanel' : undefined}
            aria-labelledby={workspace ? `tab-${workspace}` : undefined}
            tabIndex={-1}
            className="outline-none xl:flex-1 xl:min-h-[22rem]"
          >
            <Cockpit
              layoutKey={layoutKey}
              defaults={DEFAULT_WIDTHS[layoutKey]}
              left={left}
              center={
                <>
                  {twin}
                  {centerExtra}
                </>
              }
              showCenter={workspace !== 'analyze'}
              right={right}
              names={names}
            />
          </div>
          {isMonitor && <SessionTimeline state={monitor} profile={activeProfile} model={timeline} scope={marksScope} defaultTable={workspace === 'review'} />}
        </main>
      )}

      {isHelpOpen && <ShortcutHelp onClose={handleCloseHelp} monitor={isMonitor} onTour={() => { setIsHelpOpen(false); setIsTourOpen(true) }} />}
      {(tourManual || tourDue) && (
        <Tour
          onClose={() => {
            setIsTourOpen(false)
            setTourDismissed(true)
          }}
        />
      )}
      {isAppearanceOpen && <AppearanceDialog onClose={() => setIsAppearanceOpen(false)} />}
      {isSettingsOpen && (
        <SettingsDialog
          profile={activeProfile}
          onSelectProfile={handleSelectProfile}
          onImport={handleOpenImport}
          status={status}
          wsUrl={wsUrl}
          onClose={() => setIsSettingsOpen(false)}
          onUpdateConfig={handleUpdateConfig}
          sample={monitor.hello?.demo !== undefined}
          onPlaySample={handlePlaySample}
          onReconnect={handleReconnect}
        />
      )}
      {isImportOpen && (
        <Suspense fallback={null}>
          <ImportRobotDialog
            isOpen={isImportOpen}
            onClose={() => setIsImportOpen(false)}
            onImportSuccess={(prof) => handleSelectProfile(prof.id)}
          />
        </Suspense>
      )}
      {isPaletteOpen && <CommandPalette commands={commands} onClose={() => setIsPaletteOpen(false)} />}
    </div>
  )
}

export default App
