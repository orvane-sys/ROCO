import {
  AlertOctagon,
  AlertTriangle,
  Battery,
  BatteryCharging,
  BatteryMedium,
  BatteryWarning,
  Bot,
  CheckCircle2,
  Cpu,
  FlaskConical,
  Film,
  Loader2,
  PlugZap,
  Radio,
  Speech,
  Volume2,
  VolumeX,
  Wifi,
  type LucideIcon,
} from 'lucide-react'
import type { ConnectionStatus } from '../types/telemetry'
import type { MonitorState } from '../types/monitor'
import type { RobotProfile } from '../config/robotRegistry'
import type { AlertView } from '../utils/alertModel'
import { alertTitle, formatDuration } from '../utils/monitorFormat'
import { cn } from '../utils/cn'

interface StatusBarProps {
  status: ConnectionStatus
  monitor: MonitorState
  isMonitor: boolean
  profile: RobotProfile
  /** Drive mode only: null until the first packet. */
  pingLatency: number | null
  batteryVoltage: number | null
  batteryPercentage: number | null
  /** First-out, grouping and severity rules already applied (see utils/alertModel). */
  view: AlertView
  /** Manual §3 abort checks that have tripped. They count as critical here. */
  abortTrips: number
  /** Stop limits of the guided checks crossed in this g1_ctrl run, in any stage. They count as critical. */
  stageStops: number
  sound: boolean
  speech: boolean
  /** The browser has allowed sound (it needs a click first). */
  audioRunning: boolean
  speechAvailable: boolean
  onToggleSound: () => void
  onToggleSpeech: () => void
  onShowAlerts: () => void
  onOpenRobotSettings: () => void
}

type Tone = 'neutral' | 'ok' | 'warn' | 'crit' | 'info' | 'demo' | 'accent'

const TONE: Record<Tone, string> = {
  neutral: 'border-line-strong bg-raised/70 text-ink',
  ok: 'border-ok-line/60 bg-ok-soft/40 text-ok-ink',
  warn: 'border-warn-line/70 bg-warn-soft/50 text-warn-ink',
  crit: 'border-crit bg-crit-solid text-on-solid',
  info: 'border-info-line/70 bg-info-soft/40 text-info-ink',
  demo: 'border-demo/70 bg-demo-soft/60 text-demo-ink',
  accent: 'border-accent bg-accent-solid text-on-accent',
}

const chip = 'inline-flex items-center gap-2 rounded-lg border px-3 min-h-9 text-sm whitespace-nowrap'

/** Where the data comes from. The four sources must never be mistaken for each other, so each has its own icon, word and colour. */
function sourceChip(status: ConnectionStatus, monitor: MonitorState, isMonitor: boolean): { Icon: LucideIcon; word: string; detail: string; tone: Tone } {
  if (status === 'MOCK') return { Icon: FlaskConical, word: 'DEMO DATA', detail: 'invented motion', tone: 'demo' }
  if (status === 'CONNECTING') return { Icon: Loader2, word: 'CONNECTING', detail: '', tone: 'warn' }
  if (status === 'DISCONNECTED') return { Icon: PlugZap, word: 'OFFLINE', detail: 'no bridge', tone: 'crit' }
  if (status === 'SAFETY_HALT') return { Icon: AlertOctagon, word: 'HALT', detail: 'no data', tone: 'crit' }
  const h = monitor.hello
  if (isMonitor && h) {
    if (h.source === 'replay') return { Icon: Film, word: 'REPLAY', detail: monitor.replay?.file ?? h.replay?.file ?? '', tone: 'neutral' }
    if (h.source === 'robot') return { Icon: Bot, word: 'ROBOT', detail: `via DDS (${h.iface})`, tone: 'accent' }
    return { Icon: Cpu, word: 'SIM', detail: `via DDS (${h.iface})`, tone: 'info' }
  }
  return { Icon: Radio, word: 'LIVE', detail: 'robot bridge', tone: 'ok' }
}

function BatteryChip({ percent, volts, monitor }: { percent: number | null; volts: number | null; monitor: boolean }) {
  // The pack voltage thresholds are for the demo/drive bridge's pack; a read-only session trusts the BMS charge only.
  const level = monitor ? percent : null
  const Icon =
    monitor
      ? percent === null ? Battery : percent >= 50 ? BatteryCharging : percent >= 20 ? BatteryMedium : BatteryWarning
      : volts === null ? Battery : volts >= 23.5 ? BatteryCharging : volts >= 22.2 ? BatteryMedium : BatteryWarning
  const color =
    monitor
      ? level === null ? 'text-ink-muted' : level >= 50 ? 'text-ok' : level >= 20 ? 'text-warn' : 'text-crit'
      : volts === null ? 'text-ink-muted' : volts >= 23.5 ? 'text-ok' : volts >= 22.2 ? 'text-warn' : 'text-crit'
  const text = volts !== null ? `${volts.toFixed(1)} V${percent !== null ? ` (${percent}%)` : ''}` : percent !== null ? `${percent}%` : '—'
  const label = volts !== null ? `Battery ${volts.toFixed(1)} volts${percent !== null ? `, ${percent} percent` : ''}` : percent !== null ? `Battery ${percent} percent` : 'Battery: no data'
  return (
    <div className={cn(chip, TONE.neutral, 'font-mono tabular-nums')} role="group" aria-label={label}>
      <Icon className={cn('w-4 h-4', color)} aria-hidden="true" />
      <span aria-hidden="true">{text}</span>
    </div>
  )
}

/** The glance line: source, g1_ctrl state, alerts, link and battery. Always visible, in every workspace. */
export function StatusBar({
  status,
  monitor,
  isMonitor,
  profile,
  pingLatency,
  batteryVoltage,
  batteryPercentage,
  view,
  abortTrips,
  stageStops,
  sound,
  speech,
  audioRunning,
  speechAvailable,
  onToggleSound,
  onToggleSpeech,
  onShowAlerts,
  onOpenRobotSettings,
}: StatusBarProps) {
  const src = sourceChip(status, monitor, isMonitor)
  const { fsm, aux, hello, replay } = monitor
  const now = aux?.t ?? null
  const inState = fsm.since !== null && now !== null ? now - fsm.since : null
  const { counts, firstOut } = view
  const crit = counts.critical + abortTrips + stageStops
  const warn = counts.warn
  const parts = [
    counts.critical ? `${counts.critical} critical` : '',
    abortTrips ? `${abortTrips} abort check${abortTrips > 1 ? 's' : ''} tripped` : '',
    stageStops ? `${stageStops} guided-check limit${stageStops > 1 ? 's' : ''} crossed` : '',
    warn ? `${warn} warning${warn > 1 ? 's' : ''}` : '',
  ].filter(Boolean)
  const extra = [counts.followOn ? `${counts.followOn} after Passive` : '', counts.shelved ? `${counts.shelved} shelved` : ''].filter(Boolean)
  const firstTitle = firstOut ? alertTitle(firstOut.alert, profile, monitor) : null
  // Never "safe": ROCO cannot see the rope, the spotter or the room, only what the controller reports.
  const alertsText = parts.length > 0 ? parts.join(' · ') : aux ? 'No abort condition seen' : 'Waiting for data'
  const link = aux?.link
  const timeout = hello?.limits.safety.lowstate_timeout_ms ?? 200
  const lsAge = link?.lowstateAgeMs ?? null
  const replayIdle = replay !== null && !replay.playing
  const stateLost = !replayIdle && lsAge !== null && lsAge > timeout
  const SrcIcon = src.Icon

  return (
    <header data-tour="bar" className="border-b border-line/80 bg-sunken/80 backdrop-blur-md px-3 lg:px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-2 z-20 shrink-0">
      <h1 className="font-mono text-lg font-black tracking-wider text-ink flex items-center gap-2 mr-1">
        <span className="w-8 h-8 rounded-lg bg-gradient-to-tr from-accent-solid to-info flex items-center justify-center shrink-0" aria-hidden="true">
          <Bot className="w-5 h-5 text-on-accent" />
        </span>
        ROCO
      </h1>

      <div role="status" aria-live="polite" className={cn(chip, TONE[src.tone], 'font-mono font-bold')}>
        <SrcIcon className={cn('w-4 h-4 shrink-0', status === 'CONNECTING' && 'motion-safe:animate-spin')} aria-hidden="true" />
        <span>{src.word}</span>
        {src.detail && <span className="font-normal opacity-90 hidden md:inline">{src.detail}</span>}
      </div>

      {isMonitor ? (
        <>
          {/* Frame round the two things to read first: the state and the abort status. */}
          <div role="group" aria-label="Robot state and alert status" className="flex flex-wrap items-center gap-2 rounded-xl border-2 border-accent p-1">
          <div className={cn(chip, TONE.neutral, 'gap-3')}>
            <span className="text-xs text-ink-muted">g1_ctrl state</span>
            <span className="text-lg font-semibold leading-tight">
              {fsm.state ?? 'Unknown'}
            </span>
            {inState !== null && <span className="font-mono tabular-nums text-ink-soft">{formatDuration(inState)}</span>}
            {aux?.fsmStale && <span className="text-xs text-warn-ink">may be out of date</span>}
          </div>

          <button
            type="button"
            onClick={onShowAlerts}
            className={cn(chip, 'cursor-pointer hover:border-line-hot font-semibold', crit ? TONE.crit : warn ? TONE.warn : TONE.neutral)}
            aria-label={`${alertsText}${firstTitle && parts.length ? ` first: ${firstTitle}` : ''}${extra.length ? ` (${extra.join(', ')})` : ''}, ${stageStops && !counts.critical && !counts.warn && !abortTrips ? 'show guided checks' : 'show alerts'}`}
          >
            {crit ? <AlertOctagon className="w-4 h-4" aria-hidden="true" /> : warn ? <AlertTriangle className="w-4 h-4" aria-hidden="true" /> : <CheckCircle2 className={cn('w-4 h-4', aux ? 'text-ok' : 'text-ink-muted')} aria-hidden="true" />}
            <span aria-hidden="true">{alertsText}</span>
            {firstTitle && parts.length > 0 && (
              <>
                {' '}
                <span className="font-normal hidden lg:inline max-w-[16rem] truncate" aria-hidden="true">
                  first: {firstTitle}
                </span>
              </>
            )}
            {extra.length > 0 && (
              <>
                {' '}
                <span className="font-normal hidden md:inline" aria-hidden="true">
                  ({extra.join(', ')})
                </span>
              </>
            )}
          </button>
          </div>

          <div className={cn(chip, stateLost ? TONE.crit : TONE.neutral, 'font-mono tabular-nums')} role="group" aria-label={link ? (replayIdle ? 'Rates not shown while the replay is not playing' : `Robot state ${link.lowstateHz.toFixed(0)} hertz, commands ${link.lowcmdHz.toFixed(0)} hertz${stateLost ? ', state lost' : ''}`) : 'Link: no data'}>
            <Radio className="w-4 h-4" aria-hidden="true" />
            <span aria-hidden="true">
              {link ? (replayIdle ? 'state — Hz · cmd — Hz' : `state ${link.lowstateHz.toFixed(0)} Hz · cmd ${link.lowcmdHz.toFixed(0)} Hz`) : 'no link data'}
            </span>
            {stateLost && <span aria-hidden="true">LOST</span>}
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={onOpenRobotSettings}
            className={cn(chip, TONE.neutral, 'cursor-pointer hover:border-line-hot')}
            aria-label={`Robot: ${profile.name}, ${profile.joints.length} joints. Change in settings`}
          >
            <Bot className="w-4 h-4 text-accent" aria-hidden="true" />
            <span className="font-semibold" aria-hidden="true">{profile.name}</span>
            <span className="text-xs font-mono text-ink-soft" aria-hidden="true">{profile.joints.length} DOF</span>
          </button>
          <div className={cn(chip, TONE.neutral, 'font-mono tabular-nums')} role="group" aria-label={pingLatency === null ? 'Ping: no data' : `Ping ${pingLatency} milliseconds`}>
            <Wifi className={cn('w-4 h-4', pingLatency === null ? 'text-ink-muted' : pingLatency < 30 ? 'text-ok' : pingLatency < 80 ? 'text-warn' : 'text-crit')} aria-hidden="true" />
            <span aria-hidden="true">{pingLatency === null ? 'Ping —' : `Ping ${pingLatency} ms`}</span>
          </div>
        </>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {isMonitor && (
          <>
            <button
              type="button"
              onClick={onToggleSound}
              aria-pressed={sound}
              title={sound ? 'A tone sounds for a new critical alert. Click to turn off.' : 'Click to turn on a tone for a new critical alert.'}
              className={cn(chip, 'cursor-pointer hover:border-line-hot', sound ? 'border-accent bg-accent-soft/40 text-ink' : TONE.neutral)}
            >
              {sound ? <Volume2 className="w-4 h-4" aria-hidden="true" /> : <VolumeX className="w-4 h-4 text-ink-muted" aria-hidden="true" />}
              <span>Tone {sound ? (audioRunning ? 'on' : 'on, click the page') : 'off'}</span>
            </button>
            <button
              type="button"
              onClick={onToggleSpeech}
              aria-pressed={speech}
              disabled={!speechAvailable}
              title={
                !speechAvailable
                  ? 'This browser has no speech.'
                  : speech
                  ? 'State changes and new critical alerts are spoken. Click to turn off.'
                  : 'Click to speak state changes and new critical alerts.'
              }
              className={cn(chip, 'cursor-pointer hover:border-line-hot disabled:cursor-default disabled:opacity-60', speech ? 'border-accent bg-accent-soft/40 text-ink' : TONE.neutral)}
            >
              <Speech className={cn('w-4 h-4', !speech && 'text-ink-muted')} aria-hidden="true" />
              <span>Voice {!speechAvailable ? 'n/a' : speech ? 'on' : 'off'}</span>
            </button>
          </>
        )}
        <BatteryChip percent={batteryPercentage} volts={batteryVoltage} monitor={isMonitor} />
      </div>
    </header>
  )
}
