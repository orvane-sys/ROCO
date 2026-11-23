import { useSyncExternalStore } from 'react'
import { RotateCcw, X } from 'lucide-react'
import { getPose, resetPose, setPoseJoint, stopPose, subscribePose, type PoseJoint } from '../utils/manualPose'

const DEG = 180 / Math.PI

/** A joint's value in what its slider shows: degrees for a turning joint, millimetres for a sliding one. */
const toShown = (j: PoseJoint, v: number) => (j.kind === 'prismatic' ? v * 1000 : v * DEG)
const fromShown = (j: PoseJoint, s: number) => (j.kind === 'prismatic' ? s / 1000 : s / DEG)
const unit = (j: PoseJoint) => (j.kind === 'prismatic' ? 'mm' : '°')
const spoken = (j: PoseJoint, s: number) => `${s.toFixed(1)} ${j.kind === 'prismatic' ? 'millimetres' : 'degrees'}`

/**
 * One slider per movable joint of the robot in the 3D view, while it is posed by hand. Only the view moves: nothing is sent.
 * Shown by the 3D view beside its canvas (under it on a narrow screen) while posing; Stop posing closes it.
 */
export function PosePanel() {
  const pose = useSyncExternalStore(subscribePose, getPose)
  if (!pose) return null
  return (
    <section
      aria-labelledby="pose-heading"
      className="shrink-0 h-1/2 sm:h-auto sm:w-72 sm:pt-14 flex flex-col border-t sm:border-t-0 sm:border-l border-line bg-surface text-sm"
    >
      <div className="shrink-0 flex flex-wrap items-center justify-end gap-1.5 px-3 py-2 border-b border-line">
        <h3 id="pose-heading" className="max-sm:sr-only font-semibold text-ink mr-auto">
          Pose joints
        </h3>
        <button
          type="button"
          onClick={resetPose}
          className="px-2.5 min-h-9 rounded-lg border border-line-strong bg-surface text-ink hover:bg-raised flex items-center gap-1.5"
        >
          <RotateCcw className="w-4 h-4" aria-hidden="true" />
          Back to zero
        </button>
        <button
          type="button"
          onClick={stopPose}
          className="px-2.5 min-h-9 rounded-lg bg-accent-solid text-on-accent font-semibold hover:bg-accent-solid/85 flex items-center gap-1.5"
        >
          <X className="w-4 h-4" aria-hidden="true" />
          Stop posing
        </button>
      </div>
      <p className="shrink-0 px-3 pt-2 text-xs text-ink-soft">Moves the 3D view only. Nothing is sent to a robot.</p>
      <ul className="flex-1 min-h-0 overflow-y-auto px-3 py-2 flex flex-col gap-2">
        {pose.joints.map((j) => {
          const shown = toShown(j, pose.values.get(j.name) ?? 0)
          const id = `pose-${j.name}`
          return (
            <li key={j.name} className="flex flex-col">
              <div className="flex items-baseline gap-2">
                <label htmlFor={id} className="min-w-0 flex-1 truncate text-ink" title={j.name}>
                  {j.name}
                </label>
                <span className="shrink-0 font-mono text-xs text-ink-soft tabular-nums" aria-hidden="true">
                  {shown.toFixed(1)} {unit(j)}
                </span>
              </div>
              <input
                id={id}
                type="range"
                min={toShown(j, j.lower)}
                max={toShown(j, j.upper)}
                step="any"
                value={shown}
                onChange={(e) => setPoseJoint(j.name, fromShown(j, Number(e.target.value)))}
                aria-valuetext={spoken(j, shown)}
                className="h-6 w-full accent-accent"
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}
