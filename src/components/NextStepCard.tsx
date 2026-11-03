import { OctagonX, Route } from 'lucide-react'
import type { MonitorState } from '../types/monitor'
import { G1_CTRL_ABORT, G1_CTRL_KEYS } from '../utils/monitorFormat'

const kbd = 'px-1.5 py-0.5 rounded bg-raised border border-line-bold font-mono text-sm text-ink'

/**
 * The keys that take g1_ctrl on from its current state. The checks for each test stage are in GuidedChecks, and the
 * operator, not ROCO, decides when a stage is done.
 */
export function NextStepCard({ state }: { state: MonitorState }) {
  const { fsm, hello, replay } = state
  const states = hello?.limits.states ?? []
  const next = G1_CTRL_KEYS.filter((k) => k.from === fsm.state && (!states.length || states.includes(k.to)))

  return (
    <section aria-labelledby="next-heading" className="bg-surface/80 border border-line/90 rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Route className="w-5 h-5 text-accent" aria-hidden="true" />
        <h2 id="next-heading" className="text-base font-semibold text-ink">
          {replay ? 'Keys that were available here' : 'Keys from this state'}
        </h2>
      </div>
      <div className="flex flex-col gap-1.5 text-sm">
        {fsm.state === null ? (
          <p className="text-ink-soft">The state is not known yet, so no keys are suggested.</p>
        ) : next.length > 0 ? (
          next.map((k) => (
            <div key={k.to} className="flex items-center gap-2 flex-wrap text-ink">
              <span>To {k.to}:</span>
              <kbd className={kbd}>{k.key}</kbd>
              {k.remote && (
                <>
                  <span className="text-ink-muted">or remote</span>
                  <kbd className={kbd}>{k.remote}</kbd>
                </>
              )}
              {k.note && <span className="text-xs text-ink-muted">({k.note})</span>}
            </div>
          ))
        ) : (
          <p className="text-ink-soft">No further state from here in this controller.</p>
        )}
        <p className="text-xs text-ink-muted">Keys go to g1_ctrl's own terminal, not to this page.</p>
      </div>
    </section>
  )
}

/** The abort routes for g1_ctrl. The browser has no stop button because a read-only page could not stop anything. */
export function AbortNote({ replay }: { replay: boolean }) {
  return (
    <div role="note" className="flex items-start gap-2 rounded-lg border border-crit-line/70 bg-crit-soft/40 px-3 py-2 text-sm text-crit-ink">
      <OctagonX className="w-5 h-5 mt-0.5 shrink-0 text-crit-ink" aria-hidden="true" />
      <span>
        {replay ? 'On the robot: ' : ''}
        {G1_CTRL_ABORT.text} The browser has no stop button here because it could not stop anything.
      </span>
    </div>
  )
}
