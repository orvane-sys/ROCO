import { Table2 } from 'lucide-react'
import type { FsmSegment, MonitorState } from '../types/monitor'
import { formatDataTime } from '../utils/monitorFormat'

/** real_log.py's per-state table, built live: one row per visit to a g1_ctrl state. */
export function SegmentTable({ state }: { state: MonitorState }) {
  const rows: (FsmSegment & { current?: boolean })[] = [...state.fsm.segments]
  if (state.fsm.segment && state.fsm.segment.samples >= 5) rows.push({ ...state.fsm.segment, current: true })
  const peak = state.hello?.limits.ankleMotorPeak ?? 24.8

  return (
    <section aria-labelledby="segments-heading" className="bg-surface/80 border border-line/90 rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Table2 className="w-5 h-5 text-accent" aria-hidden="true" />
        <h2 id="segments-heading" className="text-base font-semibold text-ink">
          Per state (as real_log.py)
        </h2>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-soft">No samples yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line" tabIndex={0} aria-label="Per-state table, scrolls sideways">
          <table className="w-full text-xs text-left tabular-nums whitespace-nowrap">
            <caption className="sr-only">
              Per g1_ctrl state: ankle pitch PD demand against one {peak} Nm ankle motor, time over it, measured torques,
              leg PD error, leg speed, tilt and gyro
            </caption>
            <thead className="bg-surface text-ink-soft whitespace-normal align-bottom">
              <tr>
                <th scope="col" className="px-2 py-1.5 font-medium">State</th>
                <th scope="col" className="px-2 py-1.5 font-medium text-right">At</th>
                <th scope="col" className="px-2 py-1.5 font-medium text-right">Dur</th>
                <th scope="col" className="px-2 py-1.5 font-medium text-right min-w-20">Ank P demand</th>
                <th scope="col" className="px-2 py-1.5 font-medium text-right min-w-24">&gt;{peak} Nm (longest)</th>
                <th scope="col" className="px-2 py-1.5 font-medium text-right min-w-24">τ ankP / ankR / knee</th>
                <th scope="col" className="px-2 py-1.5 font-medium text-right">Leg err</th>
                <th scope="col" className="px-2 py-1.5 font-medium text-right">Leg dq</th>
                <th scope="col" className="px-2 py-1.5 font-medium text-right">Tilt r / p</th>
                <th scope="col" className="px-2 py-1.5 font-medium text-right">Gyro</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/80 font-mono">
              {rows.map((g, i) => (
                <tr key={`${g.name}-${g.t0}-${i}`} className={g.current ? 'bg-accent-soft/30' : 'bg-surface/50'}>
                  <th scope="row" className="px-2 py-1 font-sans font-normal text-ink">
                    {g.name}
                    {g.current && <span className="ml-1 text-accent-ink">(now)</span>}
                    {g.t0 === null && (
                      <span className="block text-ink-muted whitespace-normal min-w-24">
                        {state.replay ? 'from start of recording' : 'from bridge start, may include time before g1_ctrl ran'}
                      </span>
                    )}
                  </th>
                  <td className="px-2 py-1 text-right text-ink-soft">{g.t0 === null ? 'start' : formatDataTime(g.t0, state)}</td>
                  <td className="px-2 py-1 text-right text-ink">{g.durS.toFixed(1)} s</td>
                  <td className="px-2 py-1 text-right text-ink">
                    {g.ankPitchDemandMax.toFixed(1)} Nm <span className="text-ink-muted">{g.ankPitchDemandPct.toFixed(0)}%</span>
                  </td>
                  <td className={'px-2 py-1 text-right ' + (g.overMs > 0 ? 'text-crit-ink font-semibold' : 'text-ink')}>
                    {g.overMs.toFixed(0)} ms ({g.overRunMs.toFixed(0)})
                  </td>
                  <td className="px-2 py-1 text-right text-ink">
                    {g.tauAnkP.toFixed(1)} / {g.tauAnkR.toFixed(1)} / {g.tauKnee.toFixed(1)}
                  </td>
                  <td className="px-2 py-1 text-right text-ink">{g.legErrMaxDeg.toFixed(1)}°</td>
                  <td className="px-2 py-1 text-right text-ink">{g.legDqMax.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right text-ink">
                    {g.tiltDeg[0].toFixed(1)}° / {g.tiltDeg[1].toFixed(1)}°
                  </td>
                  <td className="px-2 py-1 text-right text-ink">{g.gyroMax.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-ink-muted">
        Torques in Nm, leg dq in rad/s, gyro in rad/s. Ankle demand is the larger of the two ankle pitch joints, compared
        with one motor's {peak} Nm peak (each ankle joint has two motors).
      </p>
    </section>
  )
}
