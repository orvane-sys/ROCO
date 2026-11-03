import { useMemo, useRef, useState, type ReactNode } from 'react'
import { setSplit, useUiPrefs } from '../services/uiPrefs'
import { Splitter } from './Splitter'
import { cn } from '../utils/cn'

interface CockpitProps {
  /** Key the column widths are saved under: a workspace id, or `drive`. */
  layoutKey: string
  /** Default widths in percent for the visible columns, left to right. Must match their number. */
  defaults: number[]
  left: ReactNode | null
  /**
   * The 3D view. It stays mounted when `showCenter` is false (it is only hidden and stops drawing), so
   * switching workspace does not reload the robot model.
   */
  center: ReactNode
  showCenter: boolean
  right: ReactNode | null
  /** Names of the columns, used to label the splitters. */
  names?: { left: string; center: string; right: string }
  className?: string
}

const MIN_PCT = 15
const GAP = '1.5rem'

function normalise(sizes: number[], count: number, fallback: number[]): number[] {
  const src = sizes.length === count ? sizes : fallback
  const total = src.reduce((a, b) => a + b, 0)
  return src.map((n) => (n / total) * 100)
}

/**
 * Up to three columns side by side from the xl breakpoint, with keyboard-resizable splitters between them, and
 * one stacked column below it. Each column scrolls on its own, so the page itself never does.
 */
export function Cockpit({
  layoutKey,
  defaults,
  left,
  center,
  showCenter,
  right,
  names = { left: 'left column', center: '3D view', right: 'right column' },
  className,
}: CockpitProps) {
  const { split } = useUiPrefs()
  const gridRef = useRef<HTMLDivElement | null>(null)
  const showLeft = left !== null
  const showRight = right !== null
  const count = Number(showLeft) + Number(showCenter) + Number(showRight)

  // widths while a drag is in progress; saved only when it ends
  const [live, setLive] = useState<{ key: string; sizes: number[] } | null>(null)
  const saved = split[layoutKey]
  const sizes = useMemo(
    () => normalise(live && live.key === layoutKey ? live.sizes : saved ?? defaults, count, defaults),
    [live, saved, defaults, layoutKey, count]
  )

  // Splitter i sits between visible columns i and i+1. DOM order is left, s1, center, s2, right; a hidden
  // column drops out of the grid, so the splitter next to it lands between the two that remain.
  const pairs: { before: number; after: number }[] = []
  for (let i = 0; i < count - 1; i++) pairs.push({ before: i, after: i + 1 })
  const s1 = showLeft && count > 1 ? pairs[0] : null
  const s2 = showCenter && showRight ? pairs[showLeft ? 1 : 0] : null

  const tracks: string[] = []
  let c = 0
  const track = () => `minmax(0,${sizes[c++].toFixed(3)}fr)`
  if (showLeft) tracks.push(track())
  if (s1) tracks.push(GAP)
  if (showCenter) tracks.push(track())
  if (s2) tracks.push(GAP)
  if (showRight) tracks.push(track())

  const labels = [showLeft && names.left, showCenter && names.center, showRight && names.right].filter(Boolean) as string[]

  const move = (pair: { before: number; after: number }, valuePct: number, final: boolean) => {
    const total = sizes[pair.before] + sizes[pair.after]
    const before = Math.min(total - MIN_PCT, Math.max(MIN_PCT, (valuePct / 100) * total))
    const next = sizes.slice()
    next[pair.before] = before
    next[pair.after] = total - before
    if (final) {
      setLive(null)
      setSplit(layoutKey, next)
    } else setLive({ key: layoutKey, sizes: next })
  }
  const splitter = (pair: { before: number; after: number }) => {
    const total = sizes[pair.before] + sizes[pair.after]
    return (
      <Splitter
        label={`${labels[pair.before]} column and ${labels[pair.after]} column`}
        value={(sizes[pair.before] / total) * 100}
        min={(MIN_PCT / total) * 100}
        max={100 - (MIN_PCT / total) * 100}
        pairWidth={() => ((gridRef.current?.clientWidth ?? 1) * total) / 100}
        onChange={(v, final) => move(pair, v, final)}
        onReset={() => {
          setLive(null)
          setSplit(layoutKey, null)
        }}
      />
    )
  }

  // A column that can scroll must be reachable by keyboard, even when it holds nothing focusable.
  const column =
    'min-w-0 min-h-0 flex flex-col gap-4 xl:overflow-y-auto xl:pr-1 outline-none focus-visible:outline-2 focus-visible:outline-focus'
  const region = (label: string) => ({ role: 'region' as const, 'aria-label': `${label} column`, tabIndex: 0 })

  return (
    <div
      ref={gridRef}
      style={{ ['--cockpit-cols' as string]: tracks.join(' ') }}
      className={cn('flex flex-col gap-4 xl:grid xl:[grid-template-columns:var(--cockpit-cols)] xl:grid-rows-1 xl:gap-0 xl:h-full', className)}
    >
      {showLeft && <div className={column} {...region(names.left)}>{left}</div>}
      {s1 && splitter(s1)}
      <div className={cn(column, !showCenter && 'hidden')} {...region(names.center)}>{center}</div>
      {s2 && splitter(s2)}
      {showRight && <div className={column} {...region(names.right)}>{right}</div>}
    </div>
  )
}
