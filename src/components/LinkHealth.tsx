import { Activity } from 'lucide-react'
import type { RobotTelemetry } from '../types/telemetry'
import type { FsmHealth, MonitorState } from '../types/monitor'
import { useRenderStats } from '../services/renderStats'
import { STEP_INTERVAL_STOP_MS } from '../config/alertPolicy'

interface LinkHealthProps {
  state: MonitorState
  telemetry: RobotTelemetry | null
}

const deg = (r: number | undefined) => (r === undefined || !Number.isFinite(r) ? '—' : `${((r * 180) / Math.PI).toFixed(1)}°`)
const num = (v: number | null | undefined, d = 1, unit = '') =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}${unit}`

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' | 'bad' }) {
  return (
    <div
      className={
        'rounded-lg border px-2.5 py-1.5 min-w-0 ' +
        (tone === 'bad'
          ? 'border-crit-line/80 bg-crit-soft/40'
          : tone === 'warn'
          ? 'border-warn-line/70 bg-warn-soft/30'
          : 'border-line bg-sunken/60')
      }
    >
      <div className="text-xs text-ink-muted truncate">{label}</div>
      <div className="text-sm font-semibold text-ink truncate">{value}</div>
      {sub && <div className="text-xs text-ink-muted">{sub}</div>}
    </div>
  )
}

type PolicyTiming = Extract<FsmHealth, { kind: 'policyTiming' }>

/** The newest "<policy> policy: N steps … step interval max" line g1_ctrl logged (TEST_MANUAL section 3: abort above 50 ms). */
function lastPolicyTiming(state: MonitorState): PolicyTiming | null {
  const events = state.fsm.events
  for (let i = events.length - 1; i >= 0; i--) {
    const h = events[i].health
    if (h?.kind === 'policyTiming') return h
  }
  return null
}

/** Rates, gaps and the IMU, as the bridge measured them on every sample. */
export function LinkHealth({ state, telemetry }: LinkHealthProps) {
  const aux = state.aux
  const link = aux?.link
  const timeout = state.hello?.limits.safety.lowstate_timeout_ms ?? 200
  const pose = telemetry?.basePose
  const imu = telemetry?.imu
  const batt = aux?.battery
  const odom = aux?.odom
  const sim = state.hello?.source === 'sim'
  const lsAge = link?.lowstateAgeMs ?? null
  const policy = lastPolicyTiming(state)
  const replayIdle = state.replay !== null && !state.replay.playing
  const draw = useRenderStats()

  return (
    <section aria-labelledby="link-heading" className="bg-surface/80 border border-line/90 rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Activity className="w-5 h-5 text-accent" aria-hidden="true" />
        <h2 id="link-heading" className="text-base font-semibold text-ink">
          Link and body
        </h2>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
        <Tile
          label="rt/lowstate"
          value={link ? `${link.lowstateHz.toFixed(0)} Hz` : '—'}
          sub={lsAge === null ? 'no state yet' : `age ${lsAge.toFixed(0)} ms`}
          tone={!replayIdle && lsAge !== null && lsAge > timeout ? 'bad' : undefined}
        />
        <Tile
          label="rt/lowcmd"
          value={link ? `${link.lowcmdHz.toFixed(0)} Hz` : '—'}
          sub={link?.lowcmdAgeMs == null ? 'no command yet' : `age ${link.lowcmdAgeMs.toFixed(0)} ms`}
          tone={!replayIdle && link?.lowcmdAgeMs != null && link.lowcmdAgeMs > 200 && (lsAge ?? Infinity) < 200 ? 'warn' : undefined}
        />
        <Tile
          label="Longest gap (frame)"
          value={link ? `${link.lowstateGapMaxMs.toFixed(1)} ms` : '—'}
          sub={link ? `cmd ${link.lowcmdGapMaxMs.toFixed(1)} ms · tick +${link.tickGapMax}` : undefined}
          tone={link && link.lowstateGapMaxMs > timeout / 2 ? 'warn' : undefined}
        />
        <Tile
          label="Policy step interval"
          value={policy ? `${policy.intervalMaxMs.toFixed(1)} ms max` : '—'}
          sub={policy ? `${policy.policy}, ${policy.steps} steps · abort above ${STEP_INTERVAL_STOP_MS} ms` : 'logged when a policy state ends'}
          tone={policy && policy.intervalMaxMs > STEP_INTERVAL_STOP_MS ? 'bad' : undefined}
        />
        <Tile
          label="ROCO 3D drawing"
          value={draw.state === 'running' ? `${draw.avgMs.toFixed(1)} ms` : draw.state === 'paused' ? 'paused' : 'off'}
          sub={
            draw.state === 'running'
              ? `per frame, ${draw.fps.toFixed(0)} fps, about ${((draw.avgMs * draw.fps) / 10).toFixed(0)}% of one CPU core (GPU not measured)`
              : draw.state === 'paused'
              ? 'not on screen, so nothing is drawn'
              : 'no 3D view is running'
          }
          tone={draw.state === 'running' && draw.avgMs * draw.fps > 250 ? 'warn' : undefined} // over a quarter of one core
        />
        <Tile label="Roll / pitch" value={`${deg(pose?.roll)} / ${deg(pose?.pitch)}`} sub={`yaw ${deg(pose?.yaw)}`} />
        <Tile
          label="Gyro"
          value={imu ? `${imu.gyroscope.map((g) => g.toFixed(2)).join(' ')}` : '—'}
          sub="x y z, rad/s"
        />
        <Tile
          label="Battery"
          value={batt?.soc !== undefined ? `${batt.soc}%` : '—'}
          sub={batt?.motorVoltage ? `motors ${batt.motorVoltage.toFixed(1)} V` : sim ? 'motor voltage n/a (sim)' : 'no motor voltage'}
        />
        <Tile
          label="Body velocity"
          value={odom ? `${num(odom.vx, 2)} ${num(odom.vy, 2)} m/s` : 'n/a'}
          sub={odom ? `forward, left · ${odom.topic}` : 'no odometry topic'}
        />
        <Tile
          label="Pelvis position"
          value={odom ? `${num(odom.x, 2)} ${num(odom.y, 2)} ${num(odom.z, 2)}` : 'n/a'}
          sub={odom ? 'x y z, m' : state.replay ? 'not recorded by g1_record' : undefined}
        />
      </div>
    </section>
  )
}
