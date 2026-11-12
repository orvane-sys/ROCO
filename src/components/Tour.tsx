import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Compass } from 'lucide-react'
import { Dialog } from './Dialog'
import { markTourSeen } from '../services/tourPrefs'

// target: the data-tour attribute of the part of the page the step is about
const STEPS: { title: string; target?: string; body: string[] }[] = [
  {
    title: 'ROCO only watches',
    body: [
      'ROCO only watches. This page shows what the robot and g1_ctrl are doing. It never sends a command, and it never says "safe".',
      'The real abort is in g1_ctrl: LT+B on the remote (Unitree\'s default). If your g1_ctrl build has a keyboard abort, p in its terminal works too.',
      'No robot? The page can play a recorded simulator run. To watch your own G1, see Quick start in the README.',
    ],
  },
  {
    title: 'The bar at the top',
    target: 'bar',
    body: [
      'It always shows where the data comes from (SIM, ROBOT or REPLAY), the controller state (g1_ctrl) and the alert count.',
      'The alert count includes abort checks and stop limits from the guided checks. "No abort condition seen" means none was seen, not that it is safe.',
    ],
  },
  {
    title: 'Alerts',
    target: 'alerts',
    body: [
      'The first alert of a burst is pinned on top and the rest fold under it, so you can see what happened first.',
      'Each one has a "Do:" line from the test manual. Critical alerts cannot be hidden.',
    ],
  },
  {
    title: 'State, keys and guided checks',
    target: 'state',
    body: [
      'The state card shows which keys move g1_ctrl to the next state. The guided checks below it list each stage of the test, what ROCO measured, and what you tick yourself.',
      'A stage moves on only when you say so.',
    ],
  },
  {
    title: 'The timeline',
    target: 'timeline',
    body: [
      'States, alerts and your marks on one line. Click it to jump a recording there or to freeze the plots at that moment.',
      'Press M to add a mark with an optional note. Keys 1, 2 and 3 switch workspace, Ctrl+K opens the command palette, and ? lists every key.',
    ],
  },
]

/** Where the step's target is on screen, following scrolls and size changes while the tour is open. */
function useTargetRect(target: string | undefined): DOMRect | null {
  // the rect is kept with the target it was measured for, so a step whose target is not on the page shows none
  const [seen, setSeen] = useState<{ target: string; rect: DOMRect } | null>(null)
  useLayoutEffect(() => {
    const el = target ? document.querySelector<HTMLElement>(`[data-tour="${target}"]`) : null
    if (!target || !el) return
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
    const update = () => setSeen({ target, rect: el.getBoundingClientRect() })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [target])
  return seen && seen.target === target ? seen.rect : null
}

/** Centre the panel unless it would cover the target; then put it on the other half of the screen. */
function placement(r: DOMRect | null): 'center' | 'top' | 'bottom' {
  if (!r) return 'center'
  const vw = window.innerWidth
  const half = Math.min(448, vw - 32) / 2
  if (r.right < vw / 2 - half || r.left > vw / 2 + half) return 'center'
  return r.top + r.height / 2 < window.innerHeight / 2 ? 'bottom' : 'top'
}

/** A short first-run tour of the Run workspace. Skippable, and shown once per browser. */
export function Tour({ onClose }: { onClose: () => void }) {
  const [n, setN] = useState(0)
  const last = n === STEPS.length - 1
  const step = STEPS[n]
  const rect = useTargetRect(step.target)
  const close = () => {
    markTourSeen()
    onClose()
  }
  const vh = typeof window === 'undefined' ? 0 : window.innerHeight
  return (
    <>
      <Dialog
        title={n === 0 ? 'Welcome to ROCO' : step.title}
        icon={<Compass className="w-5 h-5 text-accent" aria-hidden="true" />}
        onClose={close}
        backdrop={rect ? 'clear' : 'dim'}
        align={placement(rect)}
      >
        <p className="text-xs text-ink-muted mb-2" aria-live="polite">
          Step {n + 1} of {STEPS.length}
          <span className="sr-only">: {step.title}</span>
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
      {/* A ring around the target, above the dialog's backdrop. It hides nothing and takes no clicks. */}
      {rect &&
        createPortal(
          <div
            aria-hidden="true"
            className="fixed z-[60] pointer-events-none rounded-xl ring-4 ring-accent ring-offset-2 ring-offset-canvas"
            style={{
              top: Math.max(4, rect.top - 4),
              left: Math.max(4, rect.left - 4),
              width: Math.min(rect.width + 8, window.innerWidth - 8),
              height: Math.max(0, Math.min(rect.bottom + 4, vh - 4) - Math.max(4, rect.top - 4)),
            }}
          />,
          document.body,
        )}
    </>
  )
}
