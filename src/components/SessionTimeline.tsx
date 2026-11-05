import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Flag, History, Play, Table2, Trash2 } from 'lucide-react'
import type { RobotProfile } from '../config/robotRegistry'
import type { MonitorState } from '../types/monitor'
import { addMarkNow } from '../services/addMark'
import { MAX_MARK_NOTE, marksStore, startMarkNote, useMarkNoteEditing, useMarks, type Mark, type MarkScope } from '../services/marksStore'
import { telemetryService } from '../services/telemetryStream'
import { remScale, themeVar, useUiPrefs } from '../services/uiPrefs'
import { useViewState, viewStore } from '../services/viewStore'
import { alertTitle, formatDataTime, formatDuration } from '../utils/monitorFormat'
import { axisTicks, levelWord, spanText, tickLabel, timeAtX, timelineRows, xAtTime, type TimelineAlert, type TimelineModel } from '../utils/timelineModel'
import { cn } from '../utils/cn'

/**
 * The session on one line: the g1_ctrl states over time, the alerts that opened, and the operator's marks. A pointer, the
 * arrow keys and the table below all do the same job: move the shared time cursor (the plots, the joint table and a replay's
 * 3D view follow it) and, on Enter or a click, jump a recording there or freeze the live plots at that moment.
 * The band is drawn on canvas; everything on it is also listed in the table, for the keyboard and for screen readers.
 */

const H = { state: 26, alerts: 16, marks: 16, axis: 16, gap: 3 }
const PAD = 8

function stateColors(name: string | null): { fill: string; edge: string; hatch: boolean } {
  switch (name) {
    case 'Passive':
      return { fill: themeVar('--c-raised'), edge: themeVar('--c-line-bold'), hatch: false }
    case 'FixStand':
      return { fill: themeVar('--c-info-soft'), edge: themeVar('--c-info-line'), hatch: false }
    case 'Velocity':
      return { fill: themeVar('--c-accent-soft'), edge: themeVar('--c-accent-line'), hatch: false }
    case null:
      return { fill: themeVar('--c-sunken'), edge: themeVar('--c-line-bold'), hatch: true }
    default:
      return { fill: themeVar('--c-high'), edge: themeVar('--c-line-hot'), hatch: false }
  }
}

function hatchPattern(ctx: CanvasRenderingContext2D, color: string, sc: number): CanvasPattern | string {
  const c = document.createElement('canvas')
  c.width = c.height = Math.max(6, Math.round(6 * sc))
  const g = c.getContext('2d')
  if (!g) return color
  g.strokeStyle = color
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(0, c.height)
  g.lineTo(c.width, 0)
  g.stroke()
  return ctx.createPattern(c, 'repeat') ?? color
}

interface Hit {
  state: string | null
  /** The state, or why there is none. */
  what: string
  from: number
  to: number
  alert: TimelineAlert | null
  mark: { mark: Mark; n: number } | null
}

function hitAt(model: TimelineModel, t: number, tolS: number): Hit {
  const span = model.spans.find((s) => t >= s.t0 && t <= s.t1) ?? model.spans[model.spans.length - 1]
  const alert = model.alerts.filter((a) => Math.abs(a.t - t) <= tolS).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0] ?? null
  const mi = model.marks.findIndex((m) => Math.abs(m.t - t) <= tolS)
  return { state: span?.state ?? null, what: span ? spanText(span) : 'state not known', from: span?.t0 ?? model.t0, to: span?.t1 ?? model.t1, alert, mark: mi >= 0 ? { mark: model.marks[mi], n: mi + 1 } : null }
}

function draw(cv: HTMLCanvasElement, model: TimelineModel, state: MonitorState, cursorT: number | null, frozenT: number | null, sc: number): void {
  const dpr = window.devicePixelRatio || 1
  const w = cv.clientWidth
  const h = cv.clientHeight
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
  }
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = themeVar('--c-surface')
  ctx.fillRect(0, 0, w, h)
  const left = PAD * sc
  const width = w - 2 * PAD * sc
  if (width < 40) return
  const X = (t: number) => xAtTime(model, t, left, width)
  const ink = themeVar('--c-ink')
  const soft = themeVar('--c-ink-soft')
  const font = `${11 * sc}px ui-sans-serif, system-ui, sans-serif`
  ctx.font = font
  ctx.textBaseline = 'middle'

  const yState = 2 * sc
  const hState = H.state * sc
  const yAlerts = yState + hState + H.gap * sc
  const hAlerts = H.alerts * sc
  const yMarks = yAlerts + hAlerts + H.gap * sc
  const hMarks = H.marks * sc
  const yAxis = yMarks + hMarks + H.gap * sc

  // states
  for (const sp of model.spans) {
    const x0 = X(sp.t0)
    const x1 = X(sp.t1)
    const c = stateColors(sp.state)
    ctx.fillStyle = c.fill
    ctx.fillRect(x0, yState, Math.max(1, x1 - x0), hState)
    if (c.hatch) {
      ctx.fillStyle = hatchPattern(ctx, c.edge, sc)
      ctx.globalAlpha = 0.5
      ctx.fillRect(x0, yState, Math.max(1, x1 - x0), hState)
      ctx.globalAlpha = 1
    }
    ctx.strokeStyle = c.edge
    ctx.lineWidth = 1
    ctx.strokeRect(x0 + 0.5, yState + 0.5, Math.max(1, x1 - x0) - 1, hState - 1)
    const label = spanText(sp)
    if (x1 - x0 > ctx.measureText(label).width + 10 * sc) {
      ctx.fillStyle = ink
      ctx.textAlign = 'left'
      ctx.fillText(label, x0 + 5 * sc, yState + hState / 2)
    }
  }

  // alerts: a bar for how long each was open, and a marker whose shape tells the level
  const crit = themeVar('--c-crit')
  const warn = themeVar('--c-warn')
  const muted = themeVar('--c-ink-muted')
  for (const a of model.alerts) {
    const colour = a.level === 'critical' ? crit : a.level === 'warn' ? warn : muted
    const x = X(a.t)
    const mid = yAlerts + hAlerts / 2
    const end = a.until === null ? X(model.t1) : X(Math.min(a.until, model.t1))
    ctx.fillStyle = colour
    ctx.globalAlpha = 0.35
    ctx.fillRect(x, mid - 2 * sc, Math.max(0, end - x), 4 * sc)
    ctx.globalAlpha = 1
    ctx.beginPath()
    if (a.level === 'critical') {
      const r = 6 * sc
      ctx.moveTo(x, mid - r)
      ctx.lineTo(x + r * 0.8, mid)
      ctx.lineTo(x, mid + r)
      ctx.lineTo(x - r * 0.8, mid)
    } else if (a.level === 'warn') {
      const r = 6 * sc
      ctx.moveTo(x, mid - r)
      ctx.lineTo(x + r, mid + r * 0.8)
      ctx.lineTo(x - r, mid + r * 0.8)
    } else {
      ctx.arc(x, mid, 3 * sc, 0, Math.PI * 2)
    }
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = themeVar('--c-surface')
    ctx.lineWidth = 1
    ctx.stroke()
  }

  // marks: a flag with its number
  const accent = themeVar('--c-accent')
  model.marks.forEach((m, n) => {
    const x = X(m.t)
    ctx.fillStyle = accent
    ctx.fillRect(x - 1, yMarks, 2, hMarks)
    ctx.beginPath()
    ctx.moveTo(x, yMarks)
    ctx.lineTo(x + 9 * sc, yMarks + 4 * sc)
    ctx.lineTo(x, yMarks + 8 * sc)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = ink
    ctx.textAlign = 'left'
    ctx.fillText(String(n + 1), x + 11 * sc, yMarks + 6 * sc)
  })

  // axis
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.strokeStyle = themeVar('--c-line-bold')
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(left, yAxis + 0.5)
  ctx.lineTo(left + width, yAxis + 0.5)
  ctx.stroke()
  for (const t of axisTicks(model, width, sc)) {
    const x = Math.round(X(t)) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, yAxis)
    ctx.lineTo(x, yAxis + 4 * sc)
    ctx.stroke()
    ctx.fillStyle = soft
    const label = tickLabel(t, model, formatDataTime(t, state))
    ctx.fillText(label, Math.min(Math.max(x, left + 24 * sc), left + width - 24 * sc), yAxis + 5 * sc)
  }

  const line = (t: number, colour: string, dash: number[], lw: number) => {
    const x = Math.round(X(t)) + 0.5
    ctx.strokeStyle = colour
    ctx.lineWidth = lw
    ctx.setLineDash(dash)
    ctx.beginPath()
    ctx.moveTo(x, yState - 1)
    ctx.lineTo(x, yAxis)
    ctx.stroke()
    ctx.setLineDash([])
  }
  if (model.replay && model.playedTo !== null) line(Math.min(Math.max(model.playedTo, model.t0), model.t1), themeVar('--c-accent'), [], 2 * Math.max(1, sc))
  if (frozenT !== null && frozenT >= model.t0 && frozenT <= model.t1) line(frozenT, themeVar('--c-warn'), [4 * sc, 3 * sc], 2)
  if (cursorT !== null && cursorT >= model.t0 && cursorT <= model.t1) line(cursorT, ink, [], 1)
}

interface SessionTimelineProps {
  state: MonitorState
  profile: RobotProfile
  model: TimelineModel
  scope: MarkScope
}

export function SessionTimeline({ state, profile, model, scope }: SessionTimelineProps) {
  const cv = useRef<HTMLCanvasElement | null>(null)
  const wrap = useRef<HTMLDivElement | null>(null)
  const noteInput = useRef<HTMLInputElement | null>(null)
  const returnFocus = useRef<Element | null>(null)
  const [showTable, setShowTable] = useState(false)
  const [hoverX, setHoverX] = useState<number | null>(null)
  const [status, setStatus] = useState('')
  const [size, setSize] = useState(0)
  const view = useViewState()
  const { resolvedTheme, textScale } = useUiPrefs()
  const sc = remScale()
  const editing = useMarkNoteEditing()

  const title = (a: TimelineAlert) => alertTitle(a, profile, state)
  const rows = useMemo(() => timelineRows(model, title, formatDuration), [model, profile, state.hello]) // eslint-disable-line react-hooks/exhaustive-deps
  const frozenT = view.frozen ? view.frozen.endT : null

  useLayoutEffect(() => {
    if (cv.current) draw(cv.current, model, state, view.cursorT, frozenT, sc)
  })
  useEffect(() => {
    const el = wrap.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setSize(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // redraw on a theme or size change even when nothing else did
  useEffect(() => {
    if (cv.current) draw(cv.current, model, state, view.cursorT, frozenT, sc)
  }, [resolvedTheme, textScale, size]) // eslint-disable-line react-hooks/exhaustive-deps

  // M: the mark is added by the page; this puts the cursor in its note
  useEffect(() => {
    if (editing === null) return
    returnFocus.current = document.activeElement
    noteInput.current?.focus()
  }, [editing])
  // looked up among all marks, so a mark outside the timeline's span (made before the run started) still gets its note field
  const allMarks = useMarks(scope)
  const editedMark = editing ? allMarks.find((m) => m.id === editing) ?? null : null
  const editedN = editedMark ? model.marks.findIndex((m) => m.id === editedMark.id) + 1 : 0
  const finishNote = () => {
    startMarkNote(null)
    const back = returnFocus.current
    returnFocus.current = null
    if (back instanceof HTMLElement && document.contains(back)) back.focus()
  }

  const store = marksStore(scope)
  const tolS = (model.t1 - model.t0) * ((8 * sc) / Math.max(1, (size || 600) - 2 * PAD * sc))

  const pointerT = (e: { clientX: number; currentTarget: HTMLCanvasElement }): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    return timeAtX(model, e.clientX - rect.left, PAD * sc, rect.width - 2 * PAD * sc)
  }

  /** Jump the recording there, or freeze the plots at that moment (live). */
  const activate = (t: number) => {
    if (model.replay) {
      telemetryService.sendReplayControl('seek', t)
      setStatus(`Jumping the recording to ${formatDataTime(t, state)}.`)
      return
    }
    const ring = telemetryService.getPlotRing()
    const first = ring.firstTime()
    viewStore.freeze(t)
    viewStore.setCursor(t)
    setStatus(
      first !== null && t < first
        ? `That moment is older than the plot history (about ${Math.round((ring.latestTime() ?? first) - first)} s). The plots are frozen at the oldest data.`
        : `Plots frozen at ${formatDataTime(t, state)}. Resume them on Analyze.`,
    )
  }

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const span = model.t1 - model.t0
    const base = Math.min(30, Math.max(0.1, span / 100))
    const step = (e.shiftKey ? 10 : 1) * base
    const cur = view.cursorT ?? model.t1
    let t: number | null = cur
    if (e.key === 'ArrowLeft') t = Math.max(model.t0, cur - step)
    else if (e.key === 'ArrowRight') t = Math.min(model.t1, cur + step)
    else if (e.key === 'Home') t = model.t0
    else if (e.key === 'End') t = model.t1
    else if (e.key === 'Escape') t = null
    else if ((e.key === 'Enter' || e.key === ' ') && view.cursorT !== null) {
      e.preventDefault()
      activate(view.cursorT)
      return
    } else return
    e.preventDefault()
    viewStore.setCursor(t)
    // the tooltip follows the keyboard cursor too
    setHoverX(t !== null && size ? xAtTime(model, t, PAD * sc, size - 2 * PAD * sc) : null)
    if (t !== null) {
      const h = hitAt(model, t, tolS)
      setStatus(`${formatDataTime(t, state)}: ${h.what}${h.alert ? `, ${levelWord(h.alert.level)} ${title(h.alert)}` : ''}${h.mark ? `, mark ${h.mark.n}` : ''}`)
    }
  }

  const hover = hoverX !== null && view.cursorT !== null ? hitAt(model, view.cursorT, tolS) : null
  const tipLeft = hoverX !== null && size ? Math.min(Math.max(hoverX, 100), Math.max(100, size - 100)) : 0

  const lineText = editedMark ? `${editedN ? `Mark ${editedN}` : 'Mark'} added at ${formatDataTime(editedMark.t, state)}.` : status
  const alertCount = model.alerts.filter((a) => a.level !== 'info').length
  const canvasH = (2 + H.state + H.gap + H.alerts + H.gap + H.marks + H.gap + H.axis + 8) * sc

  return (
    <section aria-labelledby="timeline-heading" data-tour="timeline" className="bg-surface/80 border border-line/90 rounded-xl p-3 flex flex-col gap-2 shrink-0">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <History className="w-5 h-5 text-accent shrink-0" aria-hidden="true" />
          <h2 id="timeline-heading" className="text-base font-semibold text-ink">
            Session timeline
          </h2>
          <span className="text-xs text-ink-soft tabular-nums">
            {formatDuration(model.t1 - model.t0)} · {alertCount} {alertCount === 1 ? 'alert' : 'alerts'} · {model.marks.length} {model.marks.length === 1 ? 'mark' : 'marks'}
          </span>
        </div>
        {/* The key to the drawing, or the line that says what the keys did while that has text: one slot, so the section keeps its height. */}
        <div className="order-last w-full min-w-0 xl:order-none xl:w-auto xl:flex-1 text-xs text-ink-soft">
          <ul className={cn('flex items-center gap-x-4 gap-y-1 flex-wrap xl:flex-nowrap xl:overflow-hidden xl:whitespace-nowrap', lineText && 'hidden')} aria-label="Key to the timeline">
            <li>Hatched: state not known</li>
            <li>◆ critical</li>
            <li>▲ warning</li>
            <li>● info</li>
            <li>⚑ mark</li>
            <li className="xl:truncate">{model.replay ? 'Click: jump the recording there' : 'Click: freeze the plots at that moment'}</li>
          </ul>
          <p role="status" className={cn('xl:truncate', !lineText && 'sr-only')} title={lineText || undefined}>
            {lineText}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {frozenT !== null && (
            <button type="button" onClick={() => viewStore.unfreeze()} className="px-2.5 py-1 min-h-8 rounded-lg border border-warn-line text-sm text-warn-ink flex items-center gap-1.5 hover:bg-raised">
              <Play className="w-4 h-4" aria-hidden="true" />
              Resume plots
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              addMarkNow()
            }}
            className="px-2.5 py-1 min-h-8 rounded-lg border border-line-bold text-sm text-ink flex items-center gap-1.5 hover:bg-raised"
            title="Add a mark at this moment (M)"
          >
            <Flag className="w-4 h-4" aria-hidden="true" />
            Add mark <kbd className="hidden sm:inline px-1 rounded border border-line-bold font-mono text-xs text-ink-soft">M</kbd>
          </button>
          <button
            type="button"
            onClick={() => setShowTable(!showTable)}
            aria-expanded={showTable}
            className="px-2.5 py-1 min-h-8 rounded-lg border border-line-bold text-sm text-ink flex items-center gap-1.5 hover:bg-raised"
          >
            <Table2 className="w-4 h-4" aria-hidden="true" />
            {showTable ? 'Hide table' : 'Table view'}
          </button>
        </div>
      </div>

      <div
        ref={wrap}
        className="relative rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
        tabIndex={0}
        role="group"
        aria-label={`Session timeline, ${formatDuration(model.t1 - model.t0)}. Left and right arrow keys move the cursor, Shift moves ten times as far, Enter ${model.replay ? 'jumps the recording there' : 'freezes the plots there'}, Escape clears.`}
        onKeyDown={onKey}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            viewStore.setCursor(null)
            setHoverX(null)
          }
        }}
      >
        <canvas
          ref={cv}
          aria-hidden="true"
          className="block w-full touch-none cursor-crosshair rounded-lg"
          style={{ height: canvasH }}
          onPointerMove={(e) => {
            setHoverX(e.clientX - e.currentTarget.getBoundingClientRect().left)
            viewStore.setCursor(pointerT(e))
          }}
          onPointerLeave={() => {
            setHoverX(null)
            viewStore.setCursor(null)
          }}
          onClick={(e) => activate(pointerT(e))}
        />
        {hover && (
          <div
            className="absolute -top-1 -translate-y-full z-10 pointer-events-none rounded-lg border border-line-strong bg-sunken/95 px-2.5 py-1.5 text-xs shadow-lg max-w-[16rem]"
            style={{ left: tipLeft, transform: 'translate(-50%, -100%)' }}
          >
            <div className="text-ink font-medium">{formatDataTime(view.cursorT, state)}</div>
            <div className="text-ink-soft">
              {hover.what}: {formatDataTime(hover.from, state)} to {formatDataTime(hover.to, state)} ({formatDuration(hover.to - hover.from)})
            </div>
            {hover.alert && (
              <div className="text-ink">
                {levelWord(hover.alert.level)}: {title(hover.alert)}
              </div>
            )}
            {hover.mark && (
              <div className="text-ink">
                Mark {hover.mark.n}
                {hover.mark.mark.note ? `: ${hover.mark.mark.note}` : ''}
              </div>
            )}
          </div>
        )}
      </div>

      {editedMark && (
        <form
          className="flex items-center gap-2 flex-wrap"
          onSubmit={(e) => {
            e.preventDefault()
            finishNote()
          }}
        >
          <label className="flex items-center gap-1.5 text-sm text-ink">
            <span>
              Note for {editedN ? `mark ${editedN}` : 'the new mark'} <span className="text-ink-muted">(optional)</span>
            </span>
            <input
              ref={noteInput}
              value={editedMark.note}
              maxLength={MAX_MARK_NOTE}
              onChange={(e) => store.setNote(editedMark.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  finishNote()
                }
              }}
              className="bg-surface border border-line-bold rounded-lg px-2 py-1 min-h-8 text-sm text-ink w-64 max-w-full"
            />
          </label>
          <button type="submit" className="px-2.5 py-1 min-h-8 rounded-lg border border-line-bold text-sm text-ink hover:bg-raised">
            Done
          </button>
          <span className="text-xs text-ink-muted">Enter keeps the mark, with or without a note.</span>
        </form>
      )}

      {showTable && (
        <div className="max-h-64 xl:max-h-[22dvh] overflow-auto rounded-lg border border-line" tabIndex={0} aria-label="Session timeline events, scrolls">
          <table className="w-full text-xs text-left tabular-nums">
            <caption className="sr-only">
              Everything on the session timeline in time order: state changes, alerts and marks. The last column jumps to that moment.
            </caption>
            <thead className="bg-surface text-ink-soft sticky top-0">
              <tr>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  Time
                </th>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  What
                </th>
                <th scope="col" className="px-2 py-1.5 font-medium text-right">
                  Go to
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/80">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-2 py-2 text-ink-soft">
                    Nothing yet.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={`${r.kind}-${r.id}`} className="bg-surface/50">
                  <th scope="row" className="px-2 py-1 font-mono font-normal text-ink-soft whitespace-nowrap">
                    {formatDataTime(r.t, state)}
                  </th>
                  <td className="px-2 py-1 text-ink">
                    {r.kind === 'mark' ? (
                      <MarkRow scope={scope} id={r.id} label={r.text.split(':')[0]} />
                    ) : (
                      <>
                        {r.text}
                      </>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      onClick={() => {
                        viewStore.setCursor(r.t)
                        activate(r.t)
                      }}
                      className="px-2 min-h-7 rounded border border-line-bold text-ink hover:bg-raised"
                    >
                      {model.replay ? 'Jump' : 'Freeze plots'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** A mark in the table: its note can be changed and the mark deleted. */
function MarkRow({ scope, id, label }: { scope: MarkScope; id: string; label: string }) {
  const store = marksStore(scope)
  const mark = store.get().find((m) => m.id === id)
  if (!mark) return null
  return (
    <div className="flex items-center gap-2">
      <Flag className="w-3.5 h-3.5 text-accent shrink-0" aria-hidden="true" />
      <label className="flex items-center gap-1.5 min-w-0">
        <span className="shrink-0">{label}</span>
        <input
          value={mark.note}
          maxLength={MAX_MARK_NOTE}
          onChange={(e) => store.setNote(id, e.target.value)}
          aria-label={`Note for ${label}`}
          placeholder="note"
          className="bg-surface border border-line-bold rounded px-1.5 py-0.5 min-h-7 text-xs text-ink w-48 max-w-full"
        />
      </label>
      <button type="button" onClick={() => store.remove(id)} aria-label={`Delete ${label}`} className="p-1 min-w-7 min-h-7 rounded border border-line-bold text-ink hover:bg-raised">
        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
