import { Eye, Workflow } from 'lucide-react'
import type { MonitorState } from '../types/monitor'
import { formatDataTime, formatDuration } from '../utils/monitorFormat'
import { cn } from '../utils/cn'

/** What g1_ctrl is doing, large enough to read from across the test area. */
export function StateCard({ state }: { state: MonitorState }) {
  const { fsm, aux, replay } = state
  const now = aux?.t ?? null
  const inState = fsm.since !== null && now !== null ? now - fsm.since : null
  const changes = fsm.events.filter((e) => e.to)

  return (
    <section aria-labelledby="state-heading" className="bg-surface/80 border border-line/90 rounded-xl p-4 flex flex-col gap-3 shadow-xl">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Eye className="w-5 h-5 text-accent" aria-hidden="true" />
          <h2 id="state-heading" className="text-base font-semibold text-ink">
            g1_ctrl state
          </h2>
        </div>
        <span className="text-xs text-ink-soft">{replay ? 'Replaying a recording' : 'Monitor only: sends nothing to the robot'}</span>
      </div>

      <div>
        <div className="text-4xl font-semibold text-ink leading-tight break-words">{fsm.state ?? 'Unknown'}</div>
        <div className="text-sm text-ink-soft">
          {fsm.state === null
            ? replay
              ? 'No g1_ctrl log lines for this recording'
              : 'No log from a running g1_ctrl. g1_ctrl writes log/log.txt only when started with --log.'
            : `since ${formatDataTime(fsm.since, state)}${inState !== null ? ` · ${formatDuration(inState)}` : ''}`}
        </div>
        {aux?.fsmStale && (
          <p className="mt-2 text-xs text-warn-ink bg-warn-soft/60 border border-warn-line/60 rounded-lg px-2 py-1">
            No rt/lowcmd for over 1 s: g1_ctrl may not be running, so this state can be out of date.
          </p>
        )}
      </div>

      {changes.length > 0 && (
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink mb-1.5">
            <Workflow className="w-4 h-4 text-accent" aria-hidden="true" />
            State changes
          </h3>
          <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="g1_ctrl state changes, oldest first">
            {changes.slice(-8).map((e, i) => (
              <li
                key={`${e.t}-${i}`}
                className={cn(
                  'px-2 py-1 rounded-full border font-mono',
                  e.level === 'warning' || e.level === 'error' || e.level === 'critical'
                    ? 'border-warn-line/70 bg-warn-soft/50 text-warn-ink'
                    : 'border-line-strong bg-sunken/60 text-ink'
                )}
              >
                {formatDataTime(e.t, state)} → {e.to}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}
