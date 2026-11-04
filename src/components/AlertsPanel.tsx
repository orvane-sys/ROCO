import { useState } from 'react'
import { AlertOctagon, AlertTriangle, BellRing, Check, CheckCheck, CheckCircle2, ChevronDown, ChevronRight, EyeOff, Info, Undo2 } from 'lucide-react'
import type { RobotProfile } from '../config/robotRegistry'
import type { EffectiveLevel } from '../config/alertPolicy'
import type { MonitorState } from '../types/monitor'
import type { AlertGroup, AlertItem, AlertView } from '../utils/alertModel'
import { alertTitle, carriedNote, formatDataTime } from '../utils/monitorFormat'
import { acknowledge, shelve, unshelve, unshelveAll } from '../services/alertControls'
import { cn } from '../utils/cn'

interface AlertsPanelProps {
  state: MonitorState
  profile: RobotProfile
  /** From `buildAlertView`: first-out, grouping and the severity rules are already applied. */
  view: AlertView
  onSelectSlot?: (slot: number) => void
  /** Open the list of cleared alerts at first (the Review workspace). */
  defaultShowHistory?: boolean
  /** Guided-check stop limits crossed. They are not alerts, so the empty list says they exist and where to look. */
  stageStops?: number
}

const LEVEL_STYLE: Record<EffectiveLevel, { label: string; row: string; icon: typeof AlertTriangle; iconColor: string }> = {
  critical: {
    label: 'Critical',
    row: 'border-crit-line/80 bg-crit-soft/50',
    icon: AlertOctagon,
    iconColor: 'text-crit-ink',
  },
  warn: {
    label: 'Warning',
    row: 'border-warn-line/70 bg-warn-soft/40',
    icon: AlertTriangle,
    iconColor: 'text-warn-ink',
  },
  info: {
    label: 'Informational',
    row: 'border-line bg-sunken/50',
    icon: Info,
    iconColor: 'text-info-ink',
  },
}

const tag = 'inline-flex items-center gap-1 rounded border border-line-strong bg-raised px-1.5 py-px text-xs text-ink'
const smallButton =
  'inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg border border-line-bold bg-surface text-xs text-ink hover:bg-raised'
const bigButton =
  'inline-flex items-center gap-1.5 min-h-11 px-3 rounded-lg border border-line-bold bg-surface text-sm text-ink hover:bg-raised'

interface RowProps {
  item: AlertItem
  state: MonitorState
  profile: RobotProfile
  onSelectSlot?: (slot: number) => void
  /** A tag such as "First out", shown beside the title. */
  label?: string
  /** Cleared list: no response and no actions. */
  history?: boolean
}

function AlertRow({ item, state, profile, onSelectSlot, label, history = false }: RowProps) {
  const a = item.alert
  const lv = LEVEL_STYLE[item.level]
  const Icon = lv.icon
  const title = alertTitle(a, profile, state)
  const peakCrit = a.peakLevel === 'critical' && item.rawLevel !== 'critical'
  return (
    <li className={cn('rounded-lg border px-2.5 py-1.5', lv.row)}>
      <div className="flex items-start gap-2">
        <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', lv.iconColor)} aria-hidden="true" />
        <div className="min-w-0 flex-1 flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <span className="text-sm font-semibold text-ink">
              <span className="sr-only">{lv.label}: </span>
              {title}
            </span>
            <span className="text-xs font-mono text-ink-muted tabular-nums">
              {formatDataTime(a.since, state)}
              {history && item.durationS !== undefined ? ` · ${(item.durationS * 1000).toFixed(0)} ms` : ''}
            </span>
          </div>
          {(label || item.acknowledged || peakCrit || (!item.active && !history) || item.follows || item.earlier || item.endedByRestart) && (
            <div className="flex flex-wrap gap-1.5">
              {label && <span className={cn(tag, 'font-semibold')}>{label}</span>}
              {peakCrit && <span className={tag}>peak was critical</span>}
              {!item.active && !history && <span className={tag}>cleared{item.durationS !== undefined ? ` after ${(item.durationS * 1000).toFixed(0)} ms` : ''}</span>}
              {item.follows && !label && <span className={tag}>after the change to Passive</span>}
              {item.endedByRestart && <span className={tag}>ended when the bridge stopped</span>}
              {item.earlier && !item.endedByRestart && <span className={tag}>earlier bridge session</span>}
              {item.acknowledged && item.active && (
                <span className={tag}>
                  <Check className="w-3 h-3" aria-hidden="true" />
                  seen
                </span>
              )}
            </div>
          )}
          <p className="text-xs text-ink break-words">{a.text}</p>
          {item.carried && <p className="text-xs text-ink-muted">{carriedNote(item.carried, state)}</p>}
          {!history && item.level !== 'info' && item.active && (
            <p className="text-xs text-ink">
              <span className="font-semibold">Do: </span>
              {item.response} <span className="text-ink-muted">(manual {item.ref})</span>
            </p>
          )}
          {item.level === 'info' && item.rule && <p className="text-xs text-ink-soft">{item.rule.why}</p>}
        </div>
      </div>
      {!history && item.active && (
        <div className="mt-1 flex flex-wrap gap-2 pl-6">
          {a.joint !== null && onSelectSlot && (
            <button type="button" onClick={() => onSelectSlot(a.joint as number)} className={smallButton}>
              Show this joint
              <span className="sr-only"> in the 3D view and the plots: {title}</span>
            </button>
          )}
          {item.level === 'warn' && (
            <button type="button" onClick={() => shelve(a.id)} className={smallButton}>
              <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />
              Shelve
              <span className="sr-only"> for this session: {title}</span>
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

interface GroupProps extends Omit<RowProps, 'item' | 'label' | 'history'> {
  group: AlertGroup
}

/** One burst of alerts: the first-out in full, critical ones after it in full, the rest folded under "N more after this". */
function Group({ group, state, profile, onSelectSlot }: GroupProps) {
  const [open, setOpen] = useState(false)
  const showAlways = group.rest.filter((i) => i.active && i.level === 'critical')
  const folded = group.rest.filter((i) => !(i.active && i.level === 'critical'))
  const foldedLive = folded.filter((i) => i.active)
  const warns = foldedLive.filter((i) => i.level === 'warn').length
  const cleared = folded.length - foldedLive.length
  const summary = [warns ? plural(warns, 'warning') : '', cleared ? `${cleared} cleared` : ''].filter(Boolean).join(', ')
  const liveKeys = [group.first, ...group.rest].filter((i) => i.active).map((i) => i.key)
  const cause = group.cause
  const foldId = `fold-${group.id.replace(/[^a-z0-9]/gi, '_')}`
  return (
    <li className="rounded-xl border border-line bg-sunken/30 p-2 flex flex-col gap-2">
      {cause && (
        <div className="text-sm text-ink flex flex-col gap-0.5 px-1">
          <p>
            <span className="font-semibold">These followed a change to Passive</span> from {cause.from ?? 'a state'} at {formatDataTime(cause.t, state)}.
            {cause.reason ? <span className="text-ink-soft"> g1_ctrl logged: {cause.reason}</span> : null}
          </p>
          <p className="text-xs text-ink-muted">
            Passive has no stiffness, so the robot sinks and joints reach their range ends. Read the cause first; the alerts below are usually
            consequences, not separate faults (manual §2).
          </p>
        </div>
      )}
      <ul className="flex flex-col gap-1.5" aria-label={cause ? 'Alerts after the change to Passive' : 'Alerts'}>
        <AlertRow
          item={group.first}
          state={state}
          profile={profile}
          onSelectSlot={onSelectSlot}
          label={cause ? 'First after Passive' : group.rest.length ? 'First out' : undefined}
        />
        {showAlways.map((i) => (
          <AlertRow key={i.key} item={i} state={state} profile={profile} onSelectSlot={onSelectSlot} />
        ))}
      </ul>
      {folded.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={foldId} className={cn(smallButton, 'self-start')}>
            {open ? <ChevronDown className="w-4 h-4" aria-hidden="true" /> : <ChevronRight className="w-4 h-4" aria-hidden="true" />}
            {folded.length} more after this{summary ? ` (${summary})` : ''}
          </button>
          {open && (
            <ul id={foldId} className="flex flex-col gap-1.5">
              {folded.map((i) => (
                <AlertRow key={i.key} item={i} state={state} profile={profile} onSelectSlot={onSelectSlot} />
              ))}
            </ul>
          )}
        </div>
      )}
      {liveKeys.length > 0 && (
        <div className="flex items-center gap-2">
          {group.unacknowledged > 0 ? (
            <button type="button" onClick={() => acknowledge(liveKeys)} className={bigButton}>
              <CheckCheck className="w-4 h-4" aria-hidden="true" />
              {liveKeys.length > 1 ? `Acknowledge these ${liveKeys.length}` : 'Acknowledge'}
            </button>
          ) : (
            <span className={cn(tag, 'min-h-8')}>
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
              Acknowledged. Still active until the condition clears.
            </span>
          )}
        </div>
      )}
    </li>
  )
}

/** The checks real_log.py runs after a test, evaluated live on every ~1 kHz sample by the bridge, then presented first-out. */
export function AlertsPanel({ state, profile, view, onSelectSlot, defaultShowHistory = false, stageStops = 0 }: AlertsPanelProps) {
  const [showHistory, setShowHistory] = useState(defaultShowHistory)
  const [showInfo, setShowInfo] = useState(false)
  const [showShelved, setShowShelved] = useState(false)
  const { counts } = view
  const activeCount = counts.critical + counts.warn
  const closed = view.closed

  return (
    <section
      id="alerts"
      tabIndex={-1}
      aria-labelledby="alerts-heading"
      className="bg-surface/80 border border-line/90 rounded-xl p-3 flex flex-col gap-2 outline-none focus-visible:outline-2 focus-visible:outline-focus"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <BellRing className="w-5 h-5 text-accent" aria-hidden="true" />
          <h2 id="alerts-heading" className="text-base font-semibold text-ink">
            Alerts
          </h2>
          <span className="text-xs px-2 py-0.5 rounded bg-raised border border-line-strong text-ink tabular-nums">
            {activeCount === 0
              ? 'none active'
              : `${activeCount} active${counts.critical ? `, ${counts.critical} critical` : ''}${counts.followOn ? `, ${counts.followOn} after Passive` : ''}`}
          </span>
        </div>
        <button type="button" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory} className={smallButton}>
          {showHistory ? 'Hide history' : `History (${closed.length})`}
        </button>
      </div>

      {view.groups.length === 0 ? (
        <p className="flex items-center gap-1.5 text-sm text-ink-soft">
          <CheckCircle2 className="w-4 h-4 text-ok shrink-0" aria-hidden="true" />
          <span>
            No limit, range, speed, fault or link check is tripped.
            {stageStops > 0 && ` ${stageStops} guided-check stop limit${stageStops > 1 ? 's' : ''} crossed: see Guided checks.`}
          </span>
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Active alerts, most severe group first">
          {view.groups.map((g) => (
            <Group key={g.id} group={g} state={state} profile={profile} onSelectSlot={onSelectSlot} />
          ))}
        </ul>
      )}

      {counts.info > 0 && (
        <div className="flex flex-col gap-1.5">
          <button type="button" onClick={() => setShowInfo((v) => !v)} aria-expanded={showInfo} className={cn(smallButton, 'self-start')}>
            {showInfo ? <ChevronDown className="w-4 h-4" aria-hidden="true" /> : <ChevronRight className="w-4 h-4" aria-hidden="true" />}
            Informational ({counts.info}): expected in this state
          </button>
          {showInfo && (
            <ul className="flex flex-col gap-1.5 max-h-72 overflow-y-auto pr-1">
              {view.info.map((i) => (
                <AlertRow key={i.key} item={i} state={state} profile={profile} history />
              ))}
            </ul>
          )}
        </div>
      )}

      {counts.shelved > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={() => setShowShelved((v) => !v)} aria-expanded={showShelved} className={smallButton}>
              {showShelved ? <ChevronDown className="w-4 h-4" aria-hidden="true" /> : <ChevronRight className="w-4 h-4" aria-hidden="true" />}
              {plural(counts.shelved, 'warning')} shelved for this session
            </button>
            <button type="button" onClick={unshelveAll} className={smallButton}>
              <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
              Restore all
            </button>
          </div>
          {showShelved && (
            <ul className="flex flex-col gap-1.5">
              {view.shelved.map((i) => (
                <li key={i.key} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-sunken/50 px-2.5 py-1.5">
                  <span className="text-xs text-ink min-w-0 break-words">
                    {alertTitle(i.alert, profile, state)}: {i.alert.text}
                  </span>
                  <button type="button" onClick={() => unshelve(i.alert.id)} className={cn(smallButton, 'shrink-0')}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showHistory && (
        <div>
          <h3 className="text-sm font-semibold text-ink mb-1">Cleared alerts, newest first</h3>
          {closed.length === 0 ? (
            <p className="text-sm text-ink-muted">None yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 max-h-72 overflow-y-auto pr-1">
              {closed.map((i) => (
                <AlertRow key={i.key} item={i} state={state} profile={profile} history />
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="text-xs text-ink-muted">
        Thresholds from the g1_ctrl config and robot model
        {state.hello?.limits.ankleMotorPeak ? `; ankle motor peak ${state.hello.limits.ankleMotorPeak} Nm` : ''}. Critical alerts can be
        acknowledged but never shelved.
      </p>
    </section>
  )
}
