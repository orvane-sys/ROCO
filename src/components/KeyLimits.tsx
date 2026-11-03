import { AlertOctagon, AlertTriangle, Gauge } from 'lucide-react'
import type { RobotProfile } from '../config/robotRegistry'
import type { FsmHealth, MonitorState } from '../types/monitor'
import type { RobotTelemetry } from '../types/telemetry'
import { STEP_INTERVAL_STOP_MS } from '../config/alertPolicy'
import { cn } from '../utils/cn'

type Level = 'ok' | 'warn' | 'crit'

interface Tile {
  label: string
  value: string
  sub: string
  level: Level
}

const LEVEL_STYLE: Record<Level, string> = {
  ok: 'border-line bg-sunken/60',
  warn: 'border-warn-line/70 bg-warn-soft/40',
  crit: 'border-crit-line/80 bg-crit-soft/50',
}

/** Same rule as the bridge's own alerts: a warning from 80 % of a limit, critical from 100 %. */
const byFraction = (f: number): Level => (f >= 1 ? 'crit' : f >= 0.8 ? 'warn' : 'ok')

function lastPolicyTiming(state: MonitorState): Extract<FsmHealth, { kind: 'policyTiming' }> | null {
  const events = state.fsm.events
  for (let i = events.length - 1; i >= 0; i--) {
    const h = events[i].health
    if (h?.kind === 'policyTiming') return h
  }
  return null
}

/** Slot of the first joint whose id contains all of the words, e.g. `left`, `knee`. */
function slotOf(profile: RobotProfile, ...words: string[]): number | null {
  const i = profile.joints.findIndex((j) => words.every((w) => j.id.includes(w)))
  return i < 0 ? null : profile.joints[i].sdkMotorIndex ?? i
}

/**
 * The few numbers TEST_MANUAL asks you to watch, read from across the area. Limits and levels come from the bridge's own
 * alert rules, so this agrees with the alert list. The 50 ms step interval is the manual's section 3 abort limit.
 * Calm-stand reference torques are not shown here: the manual lists very different ones for the simulator and the robot.
 */
export function KeyLimits({ state, telemetry, profile }: { state: MonitorState; telemetry: RobotTelemetry | null; profile: RobotProfile }) {
  const { aux, hello } = state
  const tiles: Tile[] = []

  const ank = aux?.ankleMotor
  for (const side of ['left', 'right'] as const) {
    const v = ank ? ank[side] : null
    const f = v !== null && ank?.peak ? v / ank.peak : 0
    tiles.push({
      label: `Ankle motor ${side === 'left' ? 'L' : 'R'}`,
      value: v === null ? '—' : `${v.toFixed(1)} Nm`,
      sub: ank?.peak ? `${Math.round(f * 100)}% of ${ank.peak} Nm peak (approx.)` : 'no data yet',
      level: byFraction(f),
    })
  }

  for (const side of ['left', 'right'] as const) {
    const slot = slotOf(profile, side, 'knee')
    const limit = slot !== null ? hello?.limits.torque[slot] ?? null : null
    const d = slot !== null && aux ? Math.abs(aux.demand[slot] ?? NaN) : NaN
    const f = limit && Number.isFinite(d) ? d / limit : 0
    tiles.push({
      label: `Knee ${side === 'left' ? 'L' : 'R'} PD demand`,
      value: Number.isFinite(d) ? `${d.toFixed(1)} Nm` : '—',
      sub: limit ? `${Math.round(f * 100)}% of ${limit} Nm limit` : 'no limit from the model',
      level: byFraction(f),
    })
  }

  const pose = telemetry?.basePose
  const tilt = pose ? (Math.max(Math.abs(pose.roll), Math.abs(pose.pitch)) * 180) / Math.PI : null
  const warn = hello?.limits.tiltWarnDeg
  const crit = hello?.limits.tiltCritDeg
  tiles.push({
    label: 'Body tilt',
    value: tilt === null ? '—' : `${tilt.toFixed(1)}°`,
    sub: warn !== undefined && crit !== undefined ? `larger of roll and pitch · warns at ${warn}°, critical at ${crit}°` : 'larger of roll and pitch',
    level: tilt === null || warn === undefined || crit === undefined ? 'ok' : tilt >= crit ? 'crit' : tilt >= warn ? 'warn' : 'ok',
  })

  const policy = lastPolicyTiming(state)
  tiles.push({
    label: 'Policy step interval',
    value: policy ? `${policy.intervalMaxMs.toFixed(1)} ms max` : '—',
    sub: policy ? `${policy.policy}, ${policy.steps} steps · abort above ${STEP_INTERVAL_STOP_MS} ms (manual §3)` : 'logged when a policy state ends',
    level: policy && policy.intervalMaxMs > STEP_INTERVAL_STOP_MS ? 'crit' : 'ok',
  })

  return (
    <section aria-labelledby="limits-heading" className="bg-surface/80 border border-line/90 rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Gauge className="w-5 h-5 text-accent" aria-hidden="true" />
        <h2 id="limits-heading" className="text-base font-semibold text-ink">
          Key limits
        </h2>
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {tiles.map((t) => (
          <li key={t.label} className={cn('rounded-lg border px-3 py-2 min-w-0', LEVEL_STYLE[t.level])}>
            <div className="text-xs text-ink-soft">{t.label}</div>
            <div className="flex items-center gap-1.5 text-2xl font-semibold text-ink tabular-nums">
              {t.level === 'crit' ? (
                <AlertOctagon className="w-5 h-5 text-crit-ink shrink-0" aria-hidden="true" />
              ) : t.level === 'warn' ? (
                <AlertTriangle className="w-5 h-5 text-warn-ink shrink-0" aria-hidden="true" />
              ) : null}
              <span>{t.value}</span>
              {t.level !== 'ok' && <span className="sr-only">{t.level === 'crit' ? 'critical' : 'warning'}</span>}
            </div>
            <div className="text-xs text-ink-muted">{t.sub}</div>
          </li>
        ))}
      </ul>
    </section>
  )
}
