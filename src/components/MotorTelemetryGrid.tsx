import { useState, useMemo } from 'react'
import type { JointState } from '../types/telemetry'
import type { RobotProfile } from '../config/robotRegistry'
import { G1_29DOF_PROFILE } from '../config/robotRegistry'
import type { MonitorState } from '../types/monitor'
import { PLOT_SLOTS } from '../services/plotRing'
import { useCursorSample, type CursorSample } from '../services/viewStore'
import { formatDataTime } from '../utils/monitorFormat'
import { motorOrderNote } from '../utils/motorMatch'
import { Activity, AlertOctagon, Gauge, Flame, Compass, Layers, Rows3, LayoutGrid, Search, X } from 'lucide-react'
import { cn } from '../utils/cn'

interface MotorTelemetryGridProps {
  joints: JointState[]
  profile?: RobotProfile
  selectedJointId?: string | null
  onSelectJoint?: (jointId: string | null) => void
  /** Read-only bridge session: adds the controller's command, PD demand and faults per joint. */
  monitor?: MonitorState | null
}

type SortOption = 'index' | 'temperature' | 'torque' | 'demand'

const SORT_LABELS: Record<SortOption, string> = {
  index: 'Joint number',
  temperature: 'Hottest first',
  torque: 'Highest torque first',
  demand: 'Highest PD demand first',
}

const getTempThreshold = (temp: number, warn = 50, stop = 65) => {
  if (temp >= stop) {
    return { color: 'text-crit-ink', bg: 'bg-crit/10 border-crit-line/40', bar: 'bg-crit', status: 'Critical' }
  }
  if (temp >= warn) {
    return { color: 'text-warn-ink', bg: 'bg-warn/10 border-warn-line/40', bar: 'bg-warn', status: 'Warm' }
  }
  return { color: 'text-ok-ink', bg: 'bg-ok/10 border-ok-line/40', bar: 'bg-ok', status: 'Normal' }
}

const getTorqueThreshold = (torque: number, maxEffort = 60) => {
  const ratio = Math.abs(torque) / maxEffort
  if (ratio >= 0.8) return { color: 'text-crit-ink', bar: 'bg-crit', status: 'High' }
  if (ratio >= 0.5) return { color: 'text-warn-ink', bar: 'bg-warn', status: 'Elevated' }
  return { color: 'text-accent-ink', bar: 'bg-accent-solid', status: 'Low' }
}

const radToDeg = (rad: number) => (rad * (180 / Math.PI)).toFixed(1)

/** Largest |PD demand| since the previous bridge frame, as a share of the joint torque limit. */
const demandRatio = (j: JointState) =>
  j.pdDemandMax !== undefined && Number.isFinite(j.pdDemandMax) ? Math.abs(j.pdDemandMax) / (j.maxEffort || 60) : 0

const getDemandTone = (ratio: number) => {
  if (ratio >= 1) return { color: 'text-crit-ink font-semibold', status: 'Over limit' }
  if (ratio >= 0.8) return { color: 'text-warn-ink', status: 'High' }
  return { color: 'text-ink', status: '' }
}

/**
 * The joints as they were at the time cursor: angle, target, torque and the PD demand peak from the plot history. Speed, temperature
 * and faults are not kept in it and stay as they are now (the table says so).
 */
function jointsAt(joints: JointState[], profile: RobotProfile, c: CursorSample): JointState[] {
  return joints.map((j) => {
    const di = profile.joints.findIndex((d) => d.id === j.id)
    const slot = di < 0 ? -1 : profile.joints[di].sdkMotorIndex ?? di
    if (slot < 0) return j // a joint with no motor in the bridge's list keeps its rest values
    const b = c.i * PLOT_SLOTS + slot
    const q = c.ring.q[b]
    const tau = c.ring.tau[b]
    const qc = c.ring.qCmd[b]
    const pd = c.ring.demandPeak[b]
    return {
      ...j,
      position: Number.isFinite(q) ? q : j.position,
      torque: Number.isFinite(tau) ? tau : j.torque,
      qCmd: Number.isFinite(qc) ? qc : undefined,
      kp: Number.isFinite(qc) ? 1 : 0,
      pdDemandMax: Number.isFinite(pd) ? pd : undefined,
    }
  })
}

/** A PD target only means something while the loop holds the joint (kp > 0). */
const heldTarget = (j: JointState) => (j.kp !== undefined && j.kp > 0 && j.qCmd !== undefined ? j.qCmd : null)

export function MotorTelemetryGrid({
  joints: liveJoints,
  profile,
  selectedJointId,
  onSelectJoint,
  monitor = null,
}: MotorTelemetryGridProps) {
  const [selectedGroup, setSelectedGroup] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [sortPref, setSortBy] = useState<SortOption>('index')
  // the monitor columns need the table; cards stay one click away
  const [compactPref, setCompact] = useState<boolean | null>(null)
  const compact = compactPref ?? monitor !== null
  const sortBy: SortOption = sortPref === 'demand' && !monitor ? 'index' : sortPref

  const sim = monitor?.hello?.source === 'sim'
  const tempWarn = monitor?.hello?.limits.safety.temp_warn ?? (monitor ? 65 : 50)
  const tempStop = monitor?.hello?.limits.safety.temp_stop ?? (monitor ? 80 : 65)
  const ankle = monitor?.aux?.ankleMotor ?? null
  /** Approximate load on one of the two ankle motors on this joint's side (window max), or null. */
  const ankleMotorPct = (id: string) => {
    if (!ankle || !ankle.peak || !id.includes('ankle')) return null
    if (id.startsWith('left_')) return (ankle.leftMax / ankle.peak) * 100
    if (id.startsWith('right_')) return (ankle.rightMax / ankle.peak) * 100
    return null
  }

  const activeProfile = profile ?? G1_29DOF_PROFILE
  const activeGroups = activeProfile.groups ?? []

  // the shared time cursor (hovering a plot or the timeline): show the joints as they were then
  const cursor = useCursorSample()
  const joints = useMemo(
    () => (cursor && monitor ? jointsAt(liveJoints, activeProfile, cursor) : liveJoints),
    [liveJoints, activeProfile, monitor, cursor?.ring, cursor?.i], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const atCursor = cursor !== null && monitor !== null && monitor !== undefined

  const effectiveGroup =
    selectedGroup === 'all' || activeGroups.some((g) => g.id === selectedGroup)
      ? selectedGroup
      : 'all'

  // Dynamic motor index map based on active profile definition or incoming joints
  const jointIndexMap = useMemo(() => {
    const defs = activeProfile.joints
    if (defs && defs.length > 0) {
      return new Map(defs.map((d, idx) => [d.id, idx]))
    }
    return new Map(joints.map((j, idx) => [j.id, idx]))
  }, [activeProfile, joints])

  const lockedIds = useMemo(
    () => new Set(activeProfile.joints.filter((j) => j.locked).map((j) => j.id)),
    [activeProfile]
  )

  // imported robot: joints with no motor of that name in the bridge's list (slot -1) have no data to show
  const noMotorIds = useMemo(
    () => new Set(activeProfile.joints.filter((j) => j.sdkMotorIndex === -1).map((j) => j.id)),
    [activeProfile]
  )
  const orderNote = motorOrderNote(activeProfile.motorOrder, activeProfile.motorMatch)

  const jointLabel = (joint: JointState, fallbackIdx: number) => {
    const idx = jointIndexMap.get(joint.id) ?? fallbackIdx
    return `J${String(idx + 1).padStart(2, '0')}`
  }

  const filteredJoints = useMemo(() => {
    let list = effectiveGroup === 'all' ? [...joints] : joints.filter((j) => j.group === effectiveGroup)
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      list = list.filter((j) => j.name.toLowerCase().includes(q) || j.id.toLowerCase().includes(q))
    }
    if (sortBy === 'temperature') list.sort((a, b) => b.temperature - a.temperature)
    else if (sortBy === 'torque') list.sort((a, b) => Math.abs(b.torque) - Math.abs(a.torque))
    else if (sortBy === 'demand') list.sort((a, b) => demandRatio(b) - demandRatio(a))
    else if (sortBy === 'index') {
      list.sort((a, b) => (jointIndexMap.get(a.id) ?? 0) - (jointIndexMap.get(b.id) ?? 0))
    }
    return list
  }, [joints, effectiveGroup, searchQuery, sortBy, jointIndexMap])

  const stats = useMemo(() => {
    if (filteredJoints.length === 0) {
      return { maxTemp: 0, maxTorque: 0 }
    }
    const maxTemp = Math.max(...filteredJoints.map((j) => j.temperature))
    const maxTorque = Math.max(...filteredJoints.map((j) => Math.abs(j.torque)))
    return { maxTemp, maxTorque }
  }, [filteredJoints])

  const filterButton = (active: boolean) =>
    cn(
      'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors shrink-0',
      active
        ? 'bg-accent-solid text-on-accent font-bold shadow-md shadow-accent/20'
        : 'bg-surface border border-line-strong text-ink-soft hover:text-ink hover:bg-raised'
    )

  const totalJointsCount = joints.length || activeProfile.joints.length

  return (
    <section aria-labelledby="actuators-heading" className="flex flex-col gap-3">
      {/* Title & joint group filter */}
      <div className="flex flex-col gap-2 px-1">
        {orderNote && (
          <p role="status" className={cn('text-xs', noMotorIds.size > 0 || !activeProfile.motorMatch ? 'text-warn-ink' : 'text-ink-muted')}>
            {orderNote}
          </p>
        )}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-accent" aria-hidden="true" />
            <h2 id="actuators-heading" className="text-base font-semibold text-ink">
              Joint actuators
            </h2>
            <span className="text-xs px-2 py-0.5 rounded bg-raised text-accent-ink border border-line-strong tabular-nums">
              {filteredJoints.length} of {totalJointsCount}
            </span>
          </div>

          {/* Search box */}
          <div className="relative min-w-[9.5rem] max-w-xs">
            <Search className="w-3.5 h-3.5 text-ink-muted absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              id="joint-filter"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter joint name or ID…"
              aria-label="Filter joints by text"
              className="w-full bg-surface border border-line-strong rounded-lg pl-8 pr-7 py-1 text-xs text-ink placeholder-ink-muted focus:border-accent focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear filter"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Dynamic Groups Bar */}
        <div role="group" aria-label="Filter joints by body part" className="flex items-center gap-1.5 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => setSelectedGroup('all')}
            aria-pressed={effectiveGroup === 'all'}
            aria-label={`All ${totalJointsCount} joints`}
            className={filterButton(effectiveGroup === 'all')}
          >
            All ({totalJointsCount})
          </button>
          {activeGroups.map((grp) => {
            const grpCount =
              joints.filter((j) => j.group === grp.id).length ||
              activeProfile.joints.filter((j) => j.group === grp.id).length
            return (
              <button
                type="button"
                key={grp.id}
                onClick={() => setSelectedGroup(grp.id)}
                aria-pressed={effectiveGroup === grp.id}
                aria-label={grp.label}
                className={filterButton(effectiveGroup === grp.id)}
              >
                {grp.label} ({grpCount})
              </button>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <label className="flex items-center gap-2 text-sm text-ink min-w-0 max-w-full">
            <span>Sort</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              className="bg-surface border border-line-bold rounded-lg px-2 py-1.5 text-sm text-ink min-w-0"
            >
              {(Object.keys(SORT_LABELS) as SortOption[]).filter((key) => key !== 'demand' || monitor).map((key) => (
                <option key={key} value={key}>
                  {SORT_LABELS[key]}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => setCompact(!compact)}
            aria-pressed={compact}
            className="px-3 py-1.5 rounded-lg text-sm border border-line-bold bg-surface text-ink hover:bg-raised flex items-center gap-1.5"
          >
            {compact ? (
              <LayoutGrid className="w-4 h-4" aria-hidden="true" />
            ) : (
              <Rows3 className="w-4 h-4" aria-hidden="true" />
            )}
            <span>{compact ? 'Detailed cards' : 'Compact list'}</span>
          </button>
        </div>
      </div>

      {/* Aggregate group metrics strip */}
      <div className="bg-sunken/70 border border-line/80 rounded-lg px-3 py-2 flex items-center gap-x-5 gap-y-1 flex-wrap text-sm text-ink-soft tabular-nums">
        <div className="flex items-center gap-1.5">
          <Layers className="w-4 h-4 text-accent" aria-hidden="true" />
          <span>Peaks in view</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Flame className="w-4 h-4 text-warn" aria-hidden="true" />
          <span>Temperature</span>
          <strong className="text-ink font-mono">{sim ? 'n/a (sim)' : `${stats.maxTemp.toFixed(1)} °C`}</strong>
        </div>
        <div className="flex items-center gap-1.5">
          <Gauge className="w-4 h-4 text-info" aria-hidden="true" />
          <span>Torque</span>
          <strong className="text-ink font-mono">{stats.maxTorque.toFixed(1)} N·m</strong>
        </div>
        {selectedJointId && (
          <div className="flex items-center gap-1.5 ml-auto text-xs text-accent-ink">
            <span>Highlighted:</span>
            <span className="font-mono font-bold bg-accent-soft/80 px-2 py-0.5 rounded border border-accent-line">
              {selectedJointId}
            </span>
          </div>
        )}
      </div>

      {joints.length === 0 && <p className="text-sm text-ink-soft px-1">Waiting for telemetry…</p>}
      {atCursor && monitor && cursor && (
        <p role="status" className="text-xs px-3 py-1.5 rounded-lg border border-accent-line bg-accent-soft/60 text-ink">
          Showing angle, target, torque and PD demand at <strong className="tabular-nums">{formatDataTime(cursor.t, monitor)}</strong> (the time cursor). Speed,
          temperature and faults are the latest values.
        </p>
      )}

      {compact && monitor ? (
        <div
          className="rounded-xl border border-line/90 overflow-x-auto"
          tabIndex={0}
          aria-label="Joint table, scrolls sideways"
        >
          <table className="w-full text-xs text-left tabular-nums whitespace-nowrap">
            <caption className="sr-only">
              Per joint: measured angle, g1_ctrl target and the error between them, speed, measured torque, PD demand
              (largest since the last frame, against the joint limit; ankle rows add the approximate load on one of
              the joint's two {ankle?.peak ?? 24.8} Nm motors), temperature and motor fault bits
            </caption>
            <thead className="bg-surface text-ink-soft">
              <tr>
                <th scope="col" className="px-2 py-2 font-medium">Joint</th>
                <th scope="col" className="px-2 py-2 font-medium text-right">q °</th>
                <th scope="col" className="px-2 py-2 font-medium text-right">q_cmd °</th>
                <th scope="col" className="px-2 py-2 font-medium text-right">Error °</th>
                <th scope="col" className="px-2 py-2 font-medium text-right">dq rad/s{atCursor ? ' (latest)' : ''}</th>
                <th scope="col" className="px-2 py-2 font-medium text-right">τ Nm</th>
                <th scope="col" className="px-2 py-2 font-medium text-right">PD demand (% of joint limit)</th>
                <th scope="col" className="px-2 py-2 font-medium text-right">Temp{atCursor ? ' (latest)' : ''}</th>
                <th scope="col" className="px-2 py-2 font-medium text-right">Faults{atCursor ? ' (latest)' : ''}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/80 font-mono">
              {filteredJoints.map((joint, index) => {
                const isSelected = selectedJointId === joint.id
                const locked = lockedIds.has(joint.id)
                const noMotor = noMotorIds.has(joint.id)
                const target = heldTarget(joint)
                const ratio = demandRatio(joint)
                const demand = getDemandTone(ratio)
                const temp = getTempThreshold(joint.temperature, tempWarn, tempStop)
                const ankPct = ankleMotorPct(joint.id)
                const fault = joint.motorState ?? 0

                return (
                  <tr
                    key={joint.id || index}
                    onClick={() => onSelectJoint?.(isSelected ? null : joint.id)}
                    className={cn(
                      'cursor-pointer transition-colors',
                      isSelected ? 'bg-accent-soft/70 border-l-4 border-l-accent' : 'bg-surface/60 hover:bg-raised/60'
                    )}
                  >
                    <th scope="row" className="px-2 py-1 font-sans font-normal text-ink">
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        aria-label={`${jointLabel(joint, index)} ${joint.name}. Select for the 3D view and the plots`}
                        onClick={(e) => {
                          e.stopPropagation()
                          onSelectJoint?.(isSelected ? null : joint.id)
                        }}
                        className="text-left rounded min-h-6 inline-flex items-center"
                      >
                        <span className="font-mono text-xs text-accent-ink mr-1">{jointLabel(joint, index)}</span>{' '}
                        {joint.name}
                      </button>
                    </th>
                    {noMotor ? (
                      <td colSpan={6} className="px-2 py-1 font-sans text-warn-ink">
                        not in the bridge’s motor list — no data
                      </td>
                    ) : locked ? (
                      <td colSpan={6} className="px-2 py-1 font-sans text-warn-ink">
                        locked — reading invalid
                      </td>
                    ) : (
                      <>
                        <td className="px-2 py-1 text-right text-ink">{radToDeg(joint.position)}</td>
                        <td className="px-2 py-1 text-right text-ink">{target === null ? '—' : radToDeg(target)}</td>
                        <td className="px-2 py-1 text-right text-ink">
                          {target === null ? '—' : radToDeg(target - joint.position)}
                        </td>
                        <td className="px-2 py-1 text-right text-ink">{joint.velocity.toFixed(2)}</td>
                        <td className="px-2 py-1 text-right text-ink">{joint.torque.toFixed(1)}</td>
                        <td className={cn('px-2 py-1 text-right', demand.color)}>
                          {joint.pdDemandMax === undefined ? (
                            '—'
                          ) : (
                            <>
                              {Math.abs(joint.pdDemandMax).toFixed(1)} Nm · {(ratio * 100).toFixed(0)}%
                              {demand.status && <span className="ml-1 font-sans">({demand.status})</span>}
                              {ankPct !== null && (
                                <div className="font-sans text-ink-muted font-normal">
                                  one motor ≈ {ankPct.toFixed(0)}% of its {ankle?.peak} Nm peak
                                </div>
                              )}
                            </>
                          )}
                        </td>
                      </>
                    )}
                    <td className={cn('px-2 py-1 text-right', sim || noMotor ? 'text-ink-muted font-sans' : temp.color)}>
                      {noMotor ? (
                        '—'
                      ) : sim ? (
                        'n/a (sim)'
                      ) : (
                        <>
                          {joint.temperature.toFixed(0)} °C
                          {temp.status !== 'Normal' && <span className="ml-1 font-sans">({temp.status})</span>}
                        </>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {noMotor ? (
                        <span className="text-ink-muted font-sans">—</span>
                      ) : sim ? (
                        <span className="text-ink-muted font-sans">n/a (sim)</span>
                      ) : fault ? (
                        <span className="inline-flex items-center gap-1 text-crit-ink font-semibold">
                          <AlertOctagon className="w-3.5 h-3.5" aria-hidden="true" />
                          <span className="font-sans">Fault</span> 0x{fault.toString(16).padStart(8, '0')}
                        </span>
                      ) : (
                        <span className="text-ink-muted font-sans">none</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : compact ? (
        <div className="rounded-xl border border-line/90 overflow-x-auto">
          <table className="w-full text-sm text-left tabular-nums">
            <caption className="sr-only">Joint positions, torques and temperatures</caption>
            <thead className="bg-surface text-ink-soft">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Joint</th>
                <th scope="col" className="px-3 py-2 font-medium text-right">Angle</th>
                <th scope="col" className="px-3 py-2 font-medium text-right">Torque</th>
                <th scope="col" className="px-3 py-2 font-medium text-right">Temp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/80">
              {filteredJoints.map((joint, index) => {
                const temp = getTempThreshold(joint.temperature)
                const torque = getTorqueThreshold(joint.torque, joint.maxEffort || 60)
                const isSelected = selectedJointId === joint.id

                return (
                  <tr
                    key={joint.id || index}
                    onClick={() => onSelectJoint?.(isSelected ? null : joint.id)}
                    className={cn(
                      'cursor-pointer transition-colors',
                      isSelected ? 'bg-accent-soft/70 border-l-4 border-l-accent' : 'bg-surface/60 hover:bg-raised/60'
                    )}
                  >
                    <th scope="row" className="px-3 py-1.5 font-normal text-ink">
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        aria-label={`Highlight ${joint.name} in the 3D view`}
                        onClick={(e) => {
                          e.stopPropagation()
                          onSelectJoint?.(isSelected ? null : joint.id)
                        }}
                        className="text-left rounded"
                      >
                        <span className="font-mono text-xs text-accent-ink mr-2">{jointLabel(joint, index)}</span>
                        {joint.name}
                        {lockedIds.has(joint.id) && <span className="ml-2 text-xs text-warn-ink">(locked)</span>}
                      </button>
                    </th>
                    <td className="px-3 py-1.5 text-right font-mono text-ink">{radToDeg(joint.position)}°</td>
                    <td className={cn('px-3 py-1.5 text-right font-mono', torque.color)}>
                      {joint.torque.toFixed(1)} N·m
                      {torque.status !== 'Low' && <span className="ml-1 text-xs">({torque.status})</span>}
                    </td>
                    <td className={cn('px-3 py-1.5 text-right font-mono', temp.color)}>
                      {joint.temperature.toFixed(1)} °C
                      {temp.status !== 'Normal' && <span className="ml-1 text-xs">({temp.status})</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2 gap-3">
          {filteredJoints.map((joint, index) => {
            const tempConfig = getTempThreshold(joint.temperature, tempWarn, tempStop)
            const torqueConfig = getTorqueThreshold(joint.torque, joint.maxEffort || 60)
            const target = monitor ? heldTarget(joint) : null
            const ratio = demandRatio(joint)
            const demand = getDemandTone(ratio)
            const ankPct = monitor ? ankleMotorPct(joint.id) : null
            const minLimit = joint.limitMin ?? -3.14
            const maxLimit = joint.limitMax ?? 3.14
            const range = maxLimit - minLimit
            const positionPercent = Math.min(100, Math.max(0, ((joint.position - minLimit) / range) * 100))
            const isSelected = selectedJointId === joint.id

            return (
              <article
                key={joint.id || index}
                onClick={() => onSelectJoint?.(isSelected ? null : joint.id)}
                aria-label={`${jointLabel(joint, index)} ${joint.name}`}
                className={cn(
                  'rounded-xl p-3 flex flex-col justify-between transition-all shadow-md cursor-pointer select-none',
                  isSelected
                    ? 'bg-accent-soft/40 border-2 border-accent ring-2 ring-accent/40 shadow-accent-soft/40'
                    : 'bg-surface/70 border border-line/90 hover:border-line-bold'
                )}
              >
                {/* Card header */}
                <div className="flex items-center justify-between gap-2 pb-2 border-b border-line/60">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-raised text-accent-ink border border-line-strong shrink-0">
                      {jointLabel(joint, index)}
                    </span>
                    {/* Real button so keyboard and screen-reader users can highlight the joint in the 3D view
                        (the card-wide click is only a pointer convenience). */}
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      aria-label={`Highlight ${joint.name} in the 3D view`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelectJoint?.(isSelected ? null : joint.id)
                      }}
                      className="flex flex-col min-w-0 text-left rounded"
                    >
                      <span className="text-sm font-semibold text-ink truncate">
                        {joint.name}
                        {lockedIds.has(joint.id) && <span className="ml-2 text-xs text-warn-ink">(locked)</span>}
                      </span>
                      <span className="text-xs font-mono text-ink-muted truncate">{joint.id}</span>
                    </button>
                  </div>
                  {!sim && (
                    <div className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${tempConfig.bg} ${tempConfig.color}`}>
                      {tempConfig.status}
                    </div>
                  )}
                </div>

                {monitor && lockedIds.has(joint.id) && (
                  <p className="mt-2 text-xs text-warn-ink">locked — reading invalid</p>
                )}
                {monitor && !lockedIds.has(joint.id) && (
                  <div className="mt-2 text-xs text-ink-soft tabular-nums flex flex-col gap-0.5">
                    <span>
                      Target{' '}
                      <span className="font-mono text-ink">{target === null ? '— (not held)' : `${radToDeg(target)}°`}</span>
                      {target !== null && (
                        <span className="text-ink-muted"> · error {radToDeg(target - joint.position)}°</span>
                      )}
                    </span>
                    <span className={demand.color}>
                      PD demand{' '}
                      <span className="font-mono">
                        {joint.pdDemandMax === undefined
                          ? '—'
                          : `${Math.abs(joint.pdDemandMax).toFixed(1)} Nm · ${(ratio * 100).toFixed(0)}%`}
                      </span>
                      {demand.status && ` (${demand.status})`}
                    </span>
                    {ankPct !== null && (
                      <span className="text-ink-muted">≈ {ankPct.toFixed(0)}% of one {ankle?.peak} Nm ankle motor</span>
                    )}
                    {!sim && (joint.motorState ?? 0) !== 0 && (
                      <span className="inline-flex items-center gap-1 text-crit-ink font-semibold">
                        <AlertOctagon className="w-3.5 h-3.5" aria-hidden="true" />
                        Fault 0x{(joint.motorState ?? 0).toString(16).padStart(8, '0')}
                      </span>
                    )}
                  </div>
                )}

                {/* Metrics */}
                <div className="grid grid-cols-2 gap-2 my-2 tabular-nums">
                  <div className="bg-sunken/60 rounded-lg p-2 border border-line/50">
                    <div className="flex items-center gap-1 text-xs text-ink-soft mb-0.5">
                      <Compass className="w-3.5 h-3.5 text-accent" aria-hidden="true" />
                      <span>Angle</span>
                    </div>
                    <div className="flex items-baseline gap-1">
                      <span className="font-mono text-base font-bold text-ink">{radToDeg(joint.position)}</span>
                      <span className="text-xs text-ink-muted">°</span>
                    </div>
                    <div className="text-xs text-ink-muted font-mono">{joint.position.toFixed(2)} rad</div>
                  </div>

                  <div className="bg-sunken/60 rounded-lg p-2 border border-line/50">
                    <div className="flex items-center gap-1 text-xs text-ink-soft mb-0.5">
                      <Activity className="w-3.5 h-3.5 text-info" aria-hidden="true" />
                      <span>Speed</span>
                    </div>
                    <div className="flex items-baseline gap-1">
                      <span className="font-mono text-base font-bold text-ink">{joint.velocity.toFixed(2)}</span>
                      <span className="text-xs text-ink-muted">rad/s</span>
                    </div>
                    <div className="text-xs text-ink-muted font-mono">{radToDeg(joint.velocity)}°/s</div>
                  </div>

                  <div className="bg-sunken/60 rounded-lg p-2 border border-line/50">
                    <div className="flex items-center justify-between gap-1 text-xs text-ink-soft mb-0.5">
                      <span className="flex items-center gap-1">
                        <Gauge className={`w-3.5 h-3.5 ${torqueConfig.color}`} aria-hidden="true" />
                        <span>Torque</span>
                      </span>
                      {torqueConfig.status !== 'Low' && (
                        <span className={`font-semibold ${torqueConfig.color}`}>{torqueConfig.status}</span>
                      )}
                    </div>
                    <div className="flex items-baseline gap-1">
                      <span className={`font-mono text-base font-bold ${torqueConfig.color}`}>
                        {joint.torque.toFixed(1)}
                      </span>
                      <span className="text-xs text-ink-muted">N·m</span>
                    </div>
                    <div className="w-full bg-raised h-1.5 rounded-full mt-1 overflow-hidden" aria-hidden="true">
                      <div
                        className={`h-full ${torqueConfig.bar} transition-all duration-150`}
                        style={{
                          width: `${Math.min(100, (Math.abs(joint.torque) / (joint.maxEffort || 60)) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div className="bg-sunken/60 rounded-lg p-2 border border-line/50">
                    <div className="flex items-center gap-1 text-xs text-ink-soft mb-0.5">
                      <Flame className={`w-3.5 h-3.5 ${tempConfig.color}`} aria-hidden="true" />
                      <span>Temp</span>
                    </div>
                    {sim ? (
                      <div className="text-sm text-ink-muted">n/a (sim)</div>
                    ) : (
                      <div className="flex items-baseline gap-1">
                        <span className={`font-mono text-base font-bold ${tempConfig.color}`}>
                          {joint.temperature.toFixed(1)}
                        </span>
                        <span className="text-xs text-ink-muted">°C</span>
                      </div>
                    )}
                    <div className="w-full bg-raised h-1.5 rounded-full mt-1 overflow-hidden" aria-hidden="true">
                      <div
                        className={`h-full ${tempConfig.bar} transition-all duration-150`}
                        style={{
                          width: `${Math.min(100, Math.max(0, ((joint.temperature - 25) / 55) * 100))}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* Physical limit range bar */}
                <div className="pt-1 border-t border-line/50 flex flex-col gap-0.5">
                  <div className="flex justify-between text-xs font-mono text-ink-muted tabular-nums">
                    <span>{radToDeg(minLimit)}°</span>
                    <span className="text-ink-soft">Range</span>
                    <span>{radToDeg(maxLimit)}°</span>
                  </div>
                  <div
                    className="w-full bg-sunken h-2 rounded-full relative overflow-hidden border border-line"
                    aria-hidden="true"
                  >
                    <div
                      className="absolute top-0 bottom-0 bg-accent-solid transition-all duration-100 rounded-full"
                      style={{ left: `${Math.max(0, positionPercent - 4)}%`, width: '8%' }}
                    />
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
