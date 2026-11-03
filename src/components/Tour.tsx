import { useState } from 'react'
import { Compass } from 'lucide-react'
import { Dialog } from './Dialog'
import { markTourSeen } from '../services/tourPrefs'

const STEPS: { title: string; body: string[] }[] = [
  {
    title: 'ROCO only watches',
    body: [
      'This page shows what the robot and g1_ctrl are doing. It never sends a command, and it never says "safe".',
      'The real abort is in g1_ctrl: press p in its terminal or LT+B on the remote.',
    ],
  },
  {
    title: 'The bar at the top',
    body: [
      'It always shows where the data comes from (SIM, ROBOT or REPLAY), the g1_ctrl state and the alert count.',
      'The alert count includes abort checks and stop limits from the guided checks. "No abort condition seen" means none was seen, not that it is safe.',
    ],
  },
  {
    title: 'Alerts on the left',
    body: [
      'The first alert of a burst is pinned on top and the rest fold under it, so you can see what happened first.',
      'Each one has a "Do:" line from the test manual. Critical alerts cannot be hidden.',
    ],
  },
  {
    title: 'State, keys and guided checks on the right',
    body: [
      'The state card shows which keys move g1_ctrl to the next state. The guided checks list each stage of the test, what ROCO measured, and what you tick yourself.',
      'A stage moves on only when you say so.',
    ],
  },
  {
    title: 'The timeline at the bottom',
    body: [
      'States, alerts and your marks on one line. Click it to jump a recording there or to freeze the plots at that moment.',
      'Press M to add a mark with an optional note. Keys 1, 2 and 3 switch workspace, Ctrl+K opens the command palette, and ? lists every key.',
    ],
  },
]

/** A short first-run tour of the Run workspace. Skippable, and shown once per browser. */
export function Tour({ onClose }: { onClose: () => void }) {
  const [n, setN] = useState(0)
  const last = n === STEPS.length - 1
  const step = STEPS[n]
  const close = () => {
    markTourSeen()
    onClose()
  }
  return (
    <Dialog title={`Welcome: ${step.title}`} icon={<Compass className="w-5 h-5 text-accent" aria-hidden="true" />} onClose={close}>
      <p className="text-xs text-ink-muted mb-2" aria-live="polite">
        Step {n + 1} of {STEPS.length}
      </p>
      <div className="flex flex-col gap-2 text-sm text-ink">
        {step.body.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between gap-2 flex-wrap">
        <button type="button" onClick={close} className="px-3 py-1.5 min-h-9 rounded-lg border border-line-bold text-sm text-ink hover:bg-raised">
          Skip tour
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setN(n - 1)}
            disabled={n === 0}
            className="px-3 py-1.5 min-h-9 rounded-lg border border-line-bold text-sm text-ink hover:bg-raised disabled:opacity-50"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => (last ? close() : setN(n + 1))}
            className="px-3 py-1.5 min-h-9 rounded-lg bg-accent-solid text-on-accent font-semibold text-sm"
          >
            {last ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
      <p className="mt-3 text-xs text-ink-muted">You can open this again from the command palette (Ctrl+K) and from the help (?).</p>
    </Dialog>
  )
}
