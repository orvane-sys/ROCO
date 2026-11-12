import { AlertTriangle, Check, CheckCheck, CircleDashed, CircleHelp, ClipboardCheck, OctagonAlert } from 'lucide-react'
import type { AbortCheck, CheckStatus } from '../utils/alertModel'
import { formatDataTime } from '../utils/monitorFormat'
import type { MonitorState } from '../types/monitor'
import { acknowledge } from '../services/alertControls'
import { cn } from '../utils/cn'

const STATUS: Record<CheckStatus, { word: string; icon: typeof Check; row: string; color: string }> = {
  trip: { word: 'Tripped', icon: OctagonAlert, row: 'border-crit-line/80 bg-crit-soft/50', color: 'text-crit-ink' },
  watch: { word: 'Above the reference', icon: AlertTriangle, row: 'border-warn-line/70 bg-warn-soft/40', color: 'text-warn-ink' },
  ok: { word: 'Not tripped', icon: Check, row: 'border-line bg-sunken/60', color: 'text-ok' },
  idle: { word: 'Not applicable yet', icon: CircleDashed, row: 'border-line bg-sunken/40', color: 'text-ink-muted' },
  unknown: { word: 'No data yet', icon: CircleHelp, row: 'border-line bg-sunken/40', color: 'text-ink-muted' },
}

/**
 * The abort criteria of TEST_MANUAL section 3 that the controller's own numbers can show, as named checks. A tripped check says
 * the limit was crossed. "Not tripped" never means safe: ROCO cannot see the rope, the spotter, a sound or a smell.
 */
export function AbortChecks({ checks, state }: { checks: AbortCheck[]; state: MonitorState }) {
  const tripped = checks.filter((c) => c.status === 'trip')
  const unseen = tripped.filter((c) => !c.acknowledged)
  return (
    <section aria-labelledby="checks-heading" className="bg-surface/80 border border-line/90 rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <ClipboardCheck className="w-5 h-5 text-accent" aria-hidden="true" />
        <h2 id="checks-heading" className="text-base font-semibold text-ink">
          Abort checks
        </h2>
        <span className="text-xs px-2 py-0.5 rounded bg-raised border border-line-strong text-ink tabular-nums">
          {tripped.length === 0 ? 'none tripped' : `${tripped.length} tripped`}
        </span>
      </div>
      <p className="text-xs text-ink-soft">The stop conditions of the test manual (section 3). Stop the test if one trips.</p>
      <ul className="flex flex-col gap-1.5">
        {checks.map((c) => {
          const st = STATUS[c.status]
          const Icon = st.icon
          return (
            <li key={c.id} className={cn('rounded-lg border px-2.5 py-1.5', st.row)}>
              <div className="flex items-start gap-2">
                <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', st.color)} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-ink">{c.label}</span>
                    <span className={cn('text-xs font-semibold', c.status === 'trip' ? 'text-crit-ink' : 'text-ink-soft')}>
                      {st.word}
                      {c.status === 'trip' && c.t !== null ? ` at ${formatDataTime(c.t, state)}` : ''}
                    </span>
                  </div>
                  <p className="text-xs text-ink break-words">{c.detail}</p>
                  <p className="text-xs text-ink-muted">Manual {c.ref}</p>
                </div>
              </div>
              {c.status === 'trip' && (
                <div className="mt-1 pl-6">
                  {c.acknowledged ? (
                    <span className="inline-flex items-center gap-1 rounded border border-line-strong bg-raised px-1.5 py-px text-xs text-ink">
                      <Check className="w-3 h-3" aria-hidden="true" />
                      seen
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => acknowledge([c.key])}
                      className="inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg border border-line-bold bg-surface text-xs text-ink hover:bg-raised"
                    >
                      <CheckCheck className="w-3.5 h-3.5" aria-hidden="true" />
                      Acknowledge
                      <span className="sr-only">: {c.label}</span>
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {unseen.length > 0 && (
        <p className="text-xs text-crit-ink">
          The manual says to abort (LT+B, or p if your g1_ctrl has the keyboard abort; spotter takes the weight) when one of these is crossed, and not to restart before the cause is known.
        </p>
      )}
      <p className="text-xs text-ink-muted">
        These only cover what the controller reports. ROCO cannot see the rope, the spotter, the feet, a sound or a smell, so "not tripped" is
        not "safe".
      </p>
    </section>
  )
}
