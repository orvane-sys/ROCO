import { useRef } from 'react'

interface SplitterProps {
  /** What it resizes, for screen readers: "alerts and 3D view". */
  label: string
  /** Width of the pane before the splitter, in percent of the pair's total. */
  value: number
  min: number
  max: number
  /** Width of the pair of panes in px, read when a drag starts. */
  pairWidth: () => number
  /** Called while dragging and on each key press with the new `value`. */
  onChange: (value: number, final: boolean) => void
  onReset: () => void
  className?: string
}

const STEP = 2
const BIG_STEP = 10

/**
 * Vertical separator between two columns. Drag it, or focus it and use Left/Right (Shift for bigger steps),
 * Home/End for the limits, and Enter or a double click to go back to the default widths.
 */
export function Splitter({ label, value, min, max, pairWidth, onChange, onReset, className }: SplitterProps) {
  const drag = useRef<{ x: number; value: number; width: number } | null>(null)
  const clamp = (v: number) => Math.min(max, Math.max(min, v))

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} percent for the left side`}
      tabIndex={0}
      title="Drag to resize. Double click to reset."
      className={'group relative hidden xl:flex justify-center cursor-col-resize touch-none select-none outline-none ' + (className ?? '')}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, value, width: Math.max(1, pairWidth()) }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        onChange(clamp(d.value + ((e.clientX - d.x) / d.width) * 100), false)
      }}
      onPointerUp={(e) => {
        const d = drag.current
        drag.current = null
        if (d) onChange(clamp(d.value + ((e.clientX - d.x) / d.width) * 100), true)
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? BIG_STEP : STEP
        let next: number | null = null
        if (e.key === 'ArrowLeft') next = value - step
        else if (e.key === 'ArrowRight') next = value + step
        else if (e.key === 'Home') next = min
        else if (e.key === 'End') next = max
        else if (e.key === 'Enter') {
          e.preventDefault()
          onReset()
          return
        }
        if (next === null) return
        e.preventDefault()
        onChange(clamp(next), true)
      }}
    >
      <span
        aria-hidden="true"
        className="my-1 w-0.5 rounded bg-line-strong group-hover:bg-line-hot group-focus-visible:bg-focus group-focus-visible:w-1 transition-colors"
      />
    </div>
  )
}
