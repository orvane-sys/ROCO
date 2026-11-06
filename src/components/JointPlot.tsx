import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Download, LineChart, Pause, Play, Save, Trash2 } from 'lucide-react'
import type { RobotProfile } from '../config/robotRegistry'
import type { MonitorState } from '../types/monitor'
import { PLOT_WINDOWS, SHIPPED_SETS } from '../config/plotSets'
import { PLOT_SLOTS, type PlotRing } from '../services/plotRing'
import { telemetryService } from '../services/telemetryStream'
import { deleteUserSet, saveUserSet, setById, setCompare, setPlotSet, setWindow, usePlotPrefs } from '../services/plotPrefs'
import { useViewState, viewStore } from '../services/viewStore'
import { remScale, themeVar, useUiPrefs } from '../services/uiPrefs'
import {
  buildPlotCsv,
  plotSampleRate,
  demandPeak,
  followsSelection,
  mirrorOf,
  resolveSet,
  sampleValue,
  snapshotSet,
  tableStep,
  tickStep,
  type PlotPanel,
  type PlotSeries,
} from '../utils/plotModel'
import { downloadText, fileStamp } from '../utils/download'
import { cn } from '../utils/cn'
import { replayIdleNote } from '../utils/monitorFormat'

/**
 * The joint plots, drawn on canvas from the stream's PlotRing (no chart library). Each panel holds signals of one unit on one
 * axis (never two axes); a set of panels is chosen in plotSets.ts. Colours come from the --plot-* tokens of the active theme
 * (validated per theme by scripts/check-contrast.mjs), and the second line of a pair is dashed as well, so a pair never depends on
 * colour alone. The time cursor is shared (viewStore): hovering here moves it on the timeline, in the joint table and, in a
 * replay, in the 3D view. Sizes are design pixels at 1 rem = 16 px, multiplied by remScale() so text size and browser zoom scale
 * the canvases too.
 */

const GAP_S = 0.25 // a longer gap between samples breaks the line
const PANEL_H = 116
const AXIS_H = 18
const M = { l: 46, r: 68, t: 8, b: 6 }
const SERIES_DASH = [7, 3.5]
const REF_DASH = [2, 3]
const REDRAW_MS = 38 // new data is drawn at most about 25 times a second; a cursor move is drawn at once

interface Colors {
  s: [string, string]
  wash: string
  grid: string
  axis: string
  ref: string
  muted: string
  text: string
  surface: string
}
function readColors(): Colors {
  return {
    s: [themeVar('--plot-s1'), themeVar('--plot-s2')],
    wash: themeVar('--plot-wash'),
    grid: themeVar('--plot-grid'),
    axis: themeVar('--plot-axis'),
    ref: themeVar('--plot-ref'),
    muted: themeVar('--plot-muted'),
    text: themeVar('--plot-text'),
    surface: themeVar('--plot-surface'),
  }
}
function dims(sc: number) {
  return { sc, m: { l: M.l * sc, r: M.r * sc, t: M.t * sc, b: M.b * sc }, axisH: AXIS_H * sc, panelH: PANEL_H * sc, font: `${11 * sc}px ui-sans-serif, system-ui, sans-serif` }
}
type Dims = ReturnType<typeof dims>

interface View {
  r: PlotRing
  windowS: number
  tStart: number
  tEnd: number
  /** Logical sample range [k0, k1) in the window, plus one sample before it so lines enter from the edge. */
  k0: number
  k1: number
  tiltWarnDeg: number
  replayT0: number | null
  d: Dims
}

function makeView(r: PlotRing, endT: number | null, windowS: number, tiltWarnDeg: number, replayT0: number | null, d: Dims): View | null {
  const last = r.latestTime()
  if (last === null || r.count < 2) return null
  const tEnd = endT ?? last
  const tStart = tEnd - windowS
  return { r, windowS, tStart, tEnd, k0: Math.max(0, r.lowerBound(tStart) - 1), k1: r.lowerBound(tEnd + 1e-9), tiltWarnDeg, replayT0, d }
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw))
  const f = raw / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p
}

function timeTicks(v: View): { t: number; label: string }[] {
  const out: { t: number; label: string }[] = []
  const step = tickStep(v.windowS)
  if (v.replayT0 !== null) {
    // seconds into the recording, on multiples of the step
    for (let s = Math.ceil((v.tStart - v.replayT0) / step) * step; v.replayT0 + s <= v.tEnd + 1e-6; s += step) out.push({ t: v.replayT0 + s, label: `${s} s` })
  } else {
    for (let s = 0; s <= v.windowS + 1e-6; s += step) out.push({ t: v.tEnd - s, label: s === 0 ? 'now' : `−${s} s` })
  }
  return out
}

/** A 45 degree hatch in a line's colour, so a second joint's peaks differ from the first's by pattern as well as colour. */
function hatch(ctx: CanvasRenderingContext2D, color: string): CanvasPattern | string {
  const c = document.createElement('canvas')
  c.width = c.height = 6
  const g = c.getContext('2d')
  if (!g) return color
  g.strokeStyle = color
  g.lineWidth = 1.5
  g.beginPath()
  g.moveTo(0, 6)
  g.lineTo(6, 0)
  g.moveTo(-1, 1)
  g.lineTo(1, -1)
  g.moveTo(5, 7)
  g.lineTo(7, 5)
  g.stroke()
  return ctx.createPattern(c, 'repeat') ?? color
}

function drawPanel(cv: HTMLCanvasElement, p: PlotPanel, v: View | null, hoverT: number | null, bottom: boolean, c: Colors, d: Dims): void {
  const m = d.m
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
  ctx.clearRect(0, 0, w, h)
  // An opaque ground, so the plot reads the same when the system overrides page colours (forced colours).
  ctx.fillStyle = c.surface
  ctx.fillRect(0, 0, w, h)
  const pw = w - m.l - m.r
  const ph = h - m.t - m.b - (bottom ? d.axisH : 0)
  if (pw < 40 * d.sc || ph < 30 * d.sc || !v) return
  const r = v.r
  const demandSeries = p.kind === 'torque' ? p.series.filter((s) => s.measure === 'demand') : []

  // y extent over the window (a PD demand peak counts, so a short spike is never clipped)
  let lo = Infinity
  let hi = -Infinity
  const take = (y: number) => {
    if (!Number.isFinite(y)) return
    if (y < lo) lo = y
    if (y > hi) hi = y
  }
  for (let k = v.k0; k < v.k1; k++) {
    const i = r.index(k)
    for (const s of p.series) take(sampleValue(r, i, s))
    for (const s of demandSeries) take(demandPeak(r, i, s.slot))
  }
  if (!Number.isFinite(lo)) {
    lo = -1
    hi = 1
  }
  if (p.kind !== 'angle') {
    lo = Math.min(lo, 0)
    hi = Math.max(hi, 0)
  }
  if (hi - lo < 2) {
    const mid = (hi + lo) / 2
    lo = mid - 1
    hi = mid + 1
  }
  const pad = (hi - lo) * 0.04
  const step = niceStep((hi - lo + 2 * pad) / 4)
  const yMin = Math.floor((lo - pad) / step) * step
  const yMax = Math.ceil((hi + pad) / step) * step
  const X = (t: number) => m.l + ((t - v.tStart) / v.windowS) * pw
  const Y = (y: number) => m.t + ((yMax - y) / (yMax - yMin)) * ph

  ctx.font = d.font
  ctx.lineWidth = 1
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  const yDigits = step < 1 ? Math.min(2, Math.ceil(-Math.log10(step))) : 0
  for (let y = yMin; y <= yMax + step * 1e-6; y += step) {
    const py = Math.round(Y(y)) + 0.5
    ctx.strokeStyle = Math.abs(y) < step * 1e-6 ? c.axis : c.grid
    ctx.beginPath()
    ctx.moveTo(m.l, py)
    ctx.lineTo(m.l + pw, py)
    ctx.stroke()
    ctx.fillStyle = c.muted
    ctx.fillText((Math.abs(y) < step * 1e-6 ? 0 : y).toFixed(yDigits), m.l - 6 * d.sc, py)
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (const tk of timeTicks(v)) {
    const px = Math.round(X(tk.t)) + 0.5
    if (px < m.l - 0.5 || px > m.l + pw + 0.5) continue
    ctx.strokeStyle = c.grid
    ctx.beginPath()
    ctx.moveTo(px, m.t)
    ctx.lineTo(px, m.t + ph)
    ctx.stroke()
    if (bottom) {
      ctx.fillStyle = c.muted
      ctx.fillText(tk.label, Math.min(Math.max(px, m.l + 12 * d.sc), m.l + pw - 12 * d.sc), m.t + ph + 5 * d.sc)
    }
  }

  // reference lines: the joints' torque limits, or the tilt warning; a note when they are off scale
  const refs: number[] = []
  if (p.kind === 'torque') {
    for (const j of p.joints) if (j.maxEffort > 0 && !refs.includes(j.maxEffort)) refs.push(j.maxEffort)
  } else if (p.kind === 'tilt' && v.tiltWarnDeg > 0) refs.push(v.tiltWarnDeg)
  let offScale = false
  ctx.setLineDash(REF_DASH)
  for (const ref of refs.flatMap((x) => [x, -x])) {
    if (ref < yMin || ref > yMax) {
      offScale = true
      continue
    }
    const py = Math.round(Y(ref)) + 0.5
    ctx.strokeStyle = c.ref
    ctx.beginPath()
    ctx.moveTo(m.l, py)
    ctx.lineTo(m.l + pw, py)
    ctx.stroke()
  }
  ctx.setLineDash([])

  ctx.save()
  ctx.beginPath()
  ctx.rect(m.l, m.t, pw, ph)
  ctx.clip()
  // peak between frames, behind the lines: one joint in the single wash colour, two joints each in its own colour (the second hatched)
  for (const s of demandSeries) {
    if (p.byJoint) {
      ctx.fillStyle = s.entity === 1 ? hatch(ctx, c.s[1]) : c.s[0]
      ctx.globalAlpha = s.entity === 1 ? 0.55 : 0.24
    } else {
      ctx.fillStyle = c.wash
    }
    const y0 = Y(0)
    for (let k = v.k0; k < v.k1; k++) {
      const i = r.index(k)
      const y = demandPeak(r, i, s.slot)
      if (!Number.isFinite(y)) continue
      const x0 = X(r.t[i])
      const x1 = k + 1 < v.k1 ? Math.max(X(r.t[r.index(k + 1)]), x0 + 1) : x0 + 2
      const py = Y(y)
      ctx.fillRect(x0, Math.min(py, y0), x1 - x0, Math.abs(py - y0))
    }
    ctx.globalAlpha = 1
  }
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const s of p.series) {
    ctx.strokeStyle = c.s[s.entity]
    ctx.setLineDash(s.dashed ? SERIES_DASH : [])
    ctx.beginPath()
    let pen = false
    let prevT = -Infinity
    for (let k = v.k0; k < v.k1; k++) {
      const i = r.index(k)
      const y = sampleValue(r, i, s)
      const t = r.t[i]
      if (!Number.isFinite(y)) {
        pen = false
        continue
      }
      if (pen && t - prevT <= GAP_S) ctx.lineTo(X(t), Y(y))
      else ctx.moveTo(X(t), Y(y))
      pen = true
      prevT = t
    }
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.restore()

  // the shared cursor, with a ringed dot per line
  if (hoverT !== null && hoverT >= v.tStart && hoverT <= v.tEnd) {
    const k = r.nearest(hoverT)
    if (k !== null && k >= v.k0 && k < v.k1) {
      const i = r.index(k)
      const px = Math.round(X(r.t[i])) + 0.5
      ctx.strokeStyle = c.muted
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(px, m.t)
      ctx.lineTo(px, m.t + ph)
      ctx.stroke()
      for (const s of p.series) {
        const y = sampleValue(r, i, s)
        if (!Number.isFinite(y)) continue
        ctx.beginPath()
        ctx.arc(px, Y(y), 4 * d.sc, 0, Math.PI * 2)
        ctx.fillStyle = c.s[s.entity]
        ctx.fill()
        ctx.lineWidth = 2
        ctx.strokeStyle = c.surface
        ctx.stroke()
      }
    }
  }

  // end labels: latest value of each line, skipped when they would collide
  const ends: { y: number; s: PlotSeries; v: number }[] = []
  for (const s of p.series) {
    for (let k = v.k1 - 1; k >= v.k0; k--) {
      const val = sampleValue(r, r.index(k), s)
      if (Number.isFinite(val)) {
        ends.push({ y: Y(val), s, v: val })
        break
      }
    }
  }
  ends.sort((a, b) => a.y - b.y)
  let lastY = -Infinity
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (const e of ends) {
    if (e.y - lastY < 14 * d.sc) continue
    lastY = e.y
    const ey = Math.min(Math.max(e.y, m.t + 6 * d.sc), m.t + ph - 6 * d.sc)
    ctx.strokeStyle = c.s[e.s.entity]
    ctx.lineWidth = 2
    ctx.setLineDash(e.s.dashed ? [3, 2] : [])
    ctx.beginPath()
    ctx.moveTo(m.l + pw + 6 * d.sc, ey)
    ctx.lineTo(m.l + pw + 14 * d.sc, ey)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = c.text
    ctx.fillText(e.v.toFixed(e.s.digits), m.l + pw + 18 * d.sc, ey)
  }
  if (offScale) {
    ctx.fillStyle = c.muted
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText('limit off scale', m.l + pw - 4 * d.sc, m.t + 2 * d.sc)
  }
}

/** Legend line sample in the line's colour and dash, so it matches what the canvas draws. */
function Swatch({ s }: { s: Pick<PlotSeries, 'entity' | 'dashed'> }) {
  return (
    <svg width="18" height="6" className="inline-block align-middle shrink-0" aria-hidden="true">
      <line x1="0" x2="18" y1="3" y2="3" strokeWidth="2" strokeDasharray={s.dashed ? '5 2.5' : undefined} style={{ stroke: s.entity ? 'var(--plot-s2)' : 'var(--plot-s1)' }} />
    </svg>
  )
}

const fmt = (v: number, digits: number): string => (Number.isFinite(v) ? v.toFixed(digits) : '—')

const btn = 'px-2.5 py-1 min-h-8 rounded-lg border border-line-bold text-sm text-ink flex items-center gap-1.5 hover:bg-raised disabled:opacity-50'

interface JointPlotProps {
  profile: RobotProfile
  state: MonitorState
  selectedJointId: string | null
  onSelectJoint: (id: string) => void
}

export function JointPlot({ profile, state, selectedJointId, onSelectJoint }: JointPlotProps) {
  const canvases = useRef<(HTMLCanvasElement | null)[]>([])
  const prefs = usePlotPrefs()
  const view = useViewState()
  const [showTable, setShowTable] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [saveNote, setSaveNote] = useState('')
  const [, setTick] = useState(0)
  const { resolvedTheme, textScale } = useUiPrefs()
  const d = dims(remScale())

  const set = setById(prefs.setId, prefs)
  const follows = followsSelection(set)
  const joints = profile.joints.map((j, i) => ({ def: j, slot: j.sdkMotorIndex ?? i })).filter((j) => j.slot >= 0 && j.slot < PLOT_SLOTS)
  const sel = joints.find((j) => j.def.id === selectedJointId) ?? joints.find((j) => j.slot === 4) ?? joints[0] ?? null
  const mirror = sel ? mirrorOf(profile, sel.def.id) : null
  const compare = prefs.compare && follows
  const resolved = useMemo(
    () => resolveSet(set, profile, sel?.def.id ?? null, compare),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `set` changes only with prefs
    [prefs.setId, prefs.userSets, profile, sel?.def.id, compare],
  )
  const tiltWarnDeg = state.hello?.limits.tiltWarnDeg ?? 0
  const replayT0 = state.replay?.t0 ?? null
  const frozen = view.frozen
  const ring = frozen?.ring ?? telemetryService.getPlotRing()
  const hoverT = view.cursorT

  // the draw loop reads the latest inputs from here, so it never restarts
  const inputs = useRef({ resolved, windowS: prefs.windowS, tiltWarnDeg, replayT0, resolvedTheme, textScale, d })
  useLayoutEffect(() => {
    inputs.current = { resolved, windowS: prefs.windowS, tiltWarnDeg, replayT0, resolvedTheme, textScale, d }
  })
  const viewRef = useRef<View | null>(null)

  useEffect(() => {
    let raf = 0
    let lastKey = ''
    let lastVersion = -1
    let lastDraw = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const inp = inputs.current
      const vs = viewStore.get()
      const r = vs.frozen?.ring ?? telemetryService.getPlotRing()
      const sizes = canvases.current.map((c) => (c ? `${c.clientWidth}x${c.clientHeight}` : '')).join(',')
      const key = `${inp.resolved.set.id}|${inp.resolved.panels.map((p) => p.id + p.series.map((s) => s.key).join('+')).join('/')}|${vs.frozen ? vs.frozen.endT : 'l'}|${inp.windowS}|${inp.tiltWarnDeg}|${inp.replayT0}|${vs.cursorT}|${inp.resolvedTheme}|${inp.textScale}|${inp.d.sc}|${sizes}|${window.devicePixelRatio}`
      const version = r.version
      const keyChanged = key !== lastKey
      if (!keyChanged && (version === lastVersion || now - lastDraw < REDRAW_MS)) return
      lastKey = key
      lastVersion = version
      lastDraw = now
      const v = makeView(r, vs.frozen ? vs.frozen.endT : null, inp.windowS, inp.tiltWarnDeg, inp.replayT0, inp.d)
      const colors = readColors()
      viewRef.current = v
      inp.resolved.panels.forEach((p, n) => {
        const cv = canvases.current[n]
        if (cv) drawPanel(cv, p, v, vs.cursorT, n === inp.resolved.panels.length - 1, colors, inp.d)
      })
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  // the values table follows the data at 2 Hz while it is open
  useEffect(() => {
    if (!showTable || frozen) return
    const id = window.setInterval(() => setTick((n) => n + 1), 500)
    return () => window.clearInterval(id)
  }, [showTable, frozen])

  // the cursor belongs to the plots on this page; leave none behind when they go
  useEffect(() => () => viewStore.setCursor(null), [])

  const pv = makeView(ring, frozen ? frozen.endT : null, prefs.windowS, tiltWarnDeg, replayT0, d)
  const hoverK = pv && hoverT !== null && hoverT >= pv.tStart - 1e-6 && hoverT <= pv.tEnd + 1e-6 ? ring.nearest(hoverT) : null
  const hoverI = hoverK !== null && pv && hoverK >= pv.k0 && hoverK < pv.k1 ? ring.index(hoverK) : null
  const timeLabel = (t: number) => (replayT0 !== null ? `${(t - replayT0).toFixed(2)} s` : pv ? `${(t - pv.tEnd).toFixed(2)} s` : '')

  const pointerToT = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const v = viewRef.current
    if (!v) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pw = rect.width - v.d.m.l - v.d.m.r
    const t = v.tStart + ((e.clientX - rect.left - v.d.m.l) / pw) * v.windowS
    const k = v.r.nearest(Math.min(Math.max(t, v.tStart), v.tEnd))
    viewStore.setCursor(k === null ? null : v.r.t[v.r.index(k)])
  }

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!pv) return
    const cur = hoverK ?? pv.k1 - 1
    const by = e.shiftKey ? 10 : 1
    let k: number | null = cur
    if (e.key === 'ArrowLeft') k = Math.max(pv.k0, cur - by)
    else if (e.key === 'ArrowRight') k = Math.min(pv.k1 - 1, cur + by)
    else if (e.key === 'Home') k = pv.k0
    else if (e.key === 'End') k = pv.k1 - 1
    else if (e.key === 'Escape') k = null
    else return
    e.preventDefault()
    viewStore.setCursor(k === null ? null : ring.t[ring.index(k)])
  }

  // largest |PD demand| per joint in the window, from the between-frame peaks
  const peaks: { name: string; abs: number; limit: number }[] = []
  if (pv) {
    const seen = new Set<string>()
    for (const p of resolved.panels)
      for (const s of p.series) {
        const j = p.joints.find((x) => x.slot === s.slot)
        if (s.measure !== 'demand' || !j || seen.has(j.id)) continue
        seen.add(j.id)
        let abs = 0
        for (let k = pv.k0; k < pv.k1; k++) {
          const v = ring.demandPeak[ring.index(k) * PLOT_SLOTS + s.slot]
          if (Number.isFinite(v) && v > abs) abs = v
        }
        peaks.push({ name: j.name, abs, limit: j.maxEffort })
      }
  }

  const uniqueSeries: PlotSeries[] = []
  for (const p of resolved.panels) for (const s of p.series) if (!uniqueSeries.some((u) => u.key === s.key)) uniqueSeries.push(s)

  const exportCsv = () => {
    if (!pv) return
    const csv = buildPlotCsv(ring, resolved.panels, pv.tStart, pv.tEnd, replayT0 ?? pv.tEnd)
    // the file name says how many samples a second it holds: these are the page's samples, not the recording's full rate
    const hz = plotSampleRate(ring, pv.tStart, pv.tEnd)
    downloadText(`roco_plots_${set.id}_${hz === null ? '' : Math.round(hz) + 'hz_'}${fileStamp()}.csv`, csv, 'text/csv')
  }

  const tableRows: number[] = []
  if (showTable && pv) {
    const step = tableStep(prefs.windowS)
    for (let t = Math.ceil(pv.tStart / step) * step; t <= pv.tEnd + 1e-6; t += step) {
      const k = ring.nearest(t)
      if (k !== null && k >= pv.k0 && k < pv.k1 && tableRows[tableRows.length - 1] !== k) tableRows.push(k)
    }
  }

  const doSave = () => {
    if (saving === null) return
    const ok = saveUserSet(saving, (id, label) => snapshotSet(resolved, id, label))
    if (ok) {
      setSaving(null)
      setSaveNote('')
    } else {
      setSaveNote(
        !saving.trim()
          ? 'Type a name first.'
          : SHIPPED_SETS.some((s) => s.label.toLowerCase() === saving.trim().toLowerCase())
          ? 'That name belongs to a set that comes with ROCO. Pick another.'
          : 'You can keep up to 8 sets. Delete one first.',
      )
    }
  }

  const name = sel?.def.name ?? 'Joint'
  const plotted = resolved.panels.flatMap((p) => p.joints).filter((j, i, a) => a.findIndex((x) => x.id === j.id) === i)
  const summary = plotted.length ? plotted.map((j) => j.name).join(' and ') : 'body tilt'

  return (
    <section aria-labelledby="plot-heading" className="bg-surface/80 border border-line/90 rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <LineChart className="w-5 h-5 text-accent shrink-0" aria-hidden="true" />
          <h2 id="plot-heading" className="text-base font-semibold text-ink">
            Last {prefs.windowS} s
          </h2>
          {frozen && (
            <span className="text-xs px-2 py-0.5 rounded bg-warn-soft text-warn-ink border border-warn-line/60 font-semibold">Frozen</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div role="group" aria-label="Time window" className="flex items-center rounded-lg border border-line-bold overflow-hidden">
            {PLOT_WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={prefs.windowS === w}
                onClick={() => setWindow(w)}
                className={cn('px-2.5 min-h-8 text-sm tabular-nums', prefs.windowS === w ? 'bg-accent-solid text-on-accent font-semibold' : 'text-ink hover:bg-raised')}
              >
                {w} s
              </button>
            ))}
          </div>
          <button type="button" onClick={() => (frozen ? viewStore.unfreeze() : viewStore.freeze())} aria-pressed={!!frozen} className={btn}>
            {frozen ? <Play className="w-4 h-4" aria-hidden="true" /> : <Pause className="w-4 h-4" aria-hidden="true" />}
            {frozen ? 'Resume' : 'Freeze'}
          </button>
          <button type="button" onClick={exportCsv} disabled={!pv} className={btn} title="The lines in view, one row per sample the page holds (about 50 a second, the file name says). The recording's own CSV has every sample. PlotJuggler opens it directly.">
            <Download className="w-4 h-4" aria-hidden="true" />
            CSV
          </button>
        </div>
      </div>

      <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
        <label className="flex items-center gap-1.5 text-sm text-ink">
          <span>Plot set</span>
          <select
            value={prefs.setId}
            onChange={(e) => setPlotSet(e.target.value)}
            className="bg-surface border border-line-bold rounded-lg px-2 py-1 min-h-8 text-sm text-ink max-w-[11rem]"
          >
            <optgroup label="Comes with ROCO">
              {SHIPPED_SETS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </optgroup>
            {prefs.userSets.length > 0 && (
              <optgroup label="Saved by you">
                {prefs.userSets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label className={cn('flex items-center gap-1.5 text-sm', follows ? 'text-ink' : 'text-ink-muted')}>
          <span>Joint</span>
          <select
            value={sel?.def.id ?? ''}
            disabled={!follows}
            onChange={(e) => {
              viewStore.setCursor(null)
              onSelectJoint(e.target.value)
            }}
            className="bg-surface border border-line-bold rounded-lg px-2 py-1 min-h-8 text-sm text-ink max-w-[11rem] disabled:opacity-60"
          >
            {joints.map((j) => (
              <option key={j.def.id} value={j.def.id}>
                {j.def.name}
                {j.def.locked ? ' (locked)' : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-pressed={compare}
          disabled={!follows || !mirror}
          onClick={() => setCompare(!prefs.compare)}
          className={cn(btn, compare && 'bg-accent-soft border-accent')}
          title={!follows ? 'This set picks its own joints' : !mirror ? `${name} has no left or right counterpart` : 'Add the same joint on the other side'}
        >
          Left and right
        </button>
        {set.user ? (
          <button type="button" onClick={() => deleteUserSet(set.id)} className={btn}>
            <Trash2 className="w-4 h-4" aria-hidden="true" />
            Delete set
          </button>
        ) : (
          <button type="button" onClick={() => setSaving(saving === null ? '' : null)} aria-expanded={saving !== null} className={btn}>
            <Save className="w-4 h-4" aria-hidden="true" />
            Save as set
          </button>
        )}
      </div>

      {saving !== null && (
        <form
          className="flex items-center gap-2 flex-wrap"
          onSubmit={(e) => {
            e.preventDefault()
            doSave()
          }}
        >
          <label className="flex items-center gap-1.5 text-sm text-ink">
            <span>Name for this set</span>
            <input
              value={saving}
              onChange={(e) => {
                setSaving(e.target.value)
                setSaveNote('')
              }}
              maxLength={40}
              autoFocus
              className="bg-surface border border-line-bold rounded-lg px-2 py-1 min-h-8 text-sm text-ink w-44"
            />
          </label>
          <button type="submit" className={btn}>
            Save
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => {
              setSaving(null)
              setSaveNote('')
            }}
          >
            Cancel
          </button>
          {saveNote && (
            <span role="status" className="text-xs text-warn-ink">
              {saveNote}
            </span>
          )}
          <span className="text-xs text-ink-muted w-full">Keeps the joints and plots in view under this name, in this browser only.</span>
        </form>
      )}

      <p className="text-xs text-ink-soft">
        <span className="text-ink font-medium">{summary}</span>
        <span className="ml-2">{set.hint}</span>
        {peaks.map((p) => (
          <span key={p.name} className="ml-2 whitespace-nowrap">
            {peaks.length > 1 ? `${p.name} ` : ''}peak PD demand {p.abs.toFixed(1)} Nm{p.limit > 0 ? ` (${((p.abs / p.limit) * 100).toFixed(0)}% of the ${p.limit} Nm joint limit)` : ''}
          </span>
        ))}
        {sel?.def.locked && follows && <span className="ml-2 text-ink-muted">locked — reading invalid</span>}
        {resolved.notes.map((n) => (
          <span key={n} className="ml-2 text-warn-ink">
            {n}
          </span>
        ))}
      </p>

      <div
        className="relative outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg"
        tabIndex={0}
        role="group"
        aria-label={`Plots for ${summary}. Left and right arrow keys step through samples, Shift steps 10, Escape clears.`}
        onKeyDown={onKey}
      >
        {resolved.panels.map((p, n) => (
          <div key={p.id} className={n ? 'mt-1' : ''}>
            <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-xs text-ink-soft pl-1">
              <span className="font-medium text-ink">{p.title}</span>
              {p.series.map((s) => (
                <span key={s.key} className="flex items-center gap-1">
                  <Swatch s={s} />
                  {s.label}
                </span>
              ))}
              {p.kind === 'torque' && p.series.some((s) => s.measure === 'demand') && (
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--plot-wash)' }} aria-hidden="true" />
                  peak between frames{p.byJoint ? ' (second joint hatched)' : ''}
                </span>
              )}
              {p.kind === 'torque' && p.joints.some((j) => j.maxEffort > 0) && (
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3.5 border-t border-dotted" style={{ borderColor: 'var(--plot-ref)' }} aria-hidden="true" />
                  limit ±{[...new Set(p.joints.filter((j) => j.maxEffort > 0).map((j) => j.maxEffort))].join(' / ±')}
                </span>
              )}
              {p.kind === 'tilt' && tiltWarnDeg > 0 && (
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3.5 border-t border-dotted" style={{ borderColor: 'var(--plot-ref)' }} aria-hidden="true" />
                  warn ±{tiltWarnDeg}°
                </span>
              )}
            </div>
            <canvas
              ref={(el) => {
                canvases.current[n] = el
              }}
              aria-hidden="true"
              className="block w-full touch-none"
              style={{ height: d.panelH + (n === resolved.panels.length - 1 ? d.axisH : 0) }}
              onPointerMove={pointerToT}
              onPointerDown={pointerToT}
              onPointerLeave={() => viewStore.setCursor(null)}
            />
          </div>
        ))}

        {!pv && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-soft bg-surface/60 rounded-lg">{replayIdleNote(state) ?? 'Waiting for samples from the bridge…'}</div>
        )}

        {hoverI !== null && pv && (
          <div
            className="absolute top-6 z-10 pointer-events-none rounded-lg border border-line-strong bg-sunken/95 px-2.5 py-1.5 text-xs shadow-lg max-h-[80%] overflow-hidden"
            style={
              (ring.t[hoverI] - pv.tStart) / pv.windowS > 0.55
                ? { right: `calc(${(1 - (ring.t[hoverI] - pv.tStart) / pv.windowS) * 100}% + 12px)` }
                : { left: `calc(${((ring.t[hoverI] - pv.tStart) / pv.windowS) * 100}% + 12px)` }
            }
          >
            <div className="text-ink-soft mb-0.5">{timeLabel(ring.t[hoverI])}</div>
            <table className="tabular-nums">
              <tbody>
                {resolved.panels.flatMap((p) => [
                  ...p.series.map((s) => (
                    <tr key={`${p.id}-${s.key}`}>
                      <td className="pr-1.5">
                        <Swatch s={s} />
                      </td>
                      <td className="pr-3 text-ink-soft">{p.byJoint || p.kind === 'tilt' ? s.label : `${p.kind === 'angle' ? 'Angle' : 'Torque'}: ${s.label}`}</td>
                      <td className="text-right font-semibold text-ink">
                        {fmt(sampleValue(ring, hoverI, s), s.digits)} {s.unit}
                      </td>
                    </tr>
                  )),
                  ...p.series
                    .filter((s) => s.measure === 'demand')
                    .map((s) => (
                      <tr key={`${p.id}-${s.key}-peak`}>
                        <td className="pr-1.5">
                          <span className="inline-block w-2.5 h-2.5 rounded-sm align-middle" style={{ background: 'var(--plot-wash)' }} aria-hidden="true" />
                        </td>
                        <td className="pr-3 text-ink-soft">{p.byJoint ? `${s.label.split(':')[0]}: PD demand peak` : 'PD demand peak'}</td>
                        <td className="text-right font-semibold text-ink">{fmt(demandPeak(ring, hoverI, s.slot), 1)} Nm</td>
                      </tr>
                    )),
                ])}
              </tbody>
            </table>
          </div>
        )}
        <p className="sr-only" aria-live="polite">
          {hoverI !== null ? `${timeLabel(ring.t[hoverI])}: ` + uniqueSeries.map((s) => `${s.label} ${fmt(sampleValue(ring, hoverI, s), s.digits)} ${s.unit}`).join(', ') : ''}
        </p>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowTable(!showTable)}
          aria-expanded={showTable}
          className="text-xs inline-flex items-center min-h-6 text-accent-ink underline underline-offset-2 hover:text-ink"
        >
          {showTable ? 'Hide values' : 'Show values'}
        </button>
        {showTable && pv && (
          <div className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-line" tabIndex={0} aria-label={`Plotted values, every ${tableStep(prefs.windowS)} s`}>
            <table className="w-full text-xs text-right tabular-nums whitespace-nowrap font-mono">
              <caption className="sr-only">
                {summary}, plotted values every {tableStep(prefs.windowS)} s
              </caption>
              <thead className="bg-surface text-ink-soft font-sans sticky top-0">
                <tr>
                  <th scope="col" className="px-2 py-1 font-medium text-left">
                    Time
                  </th>
                  {uniqueSeries.map((s) => (
                    <th key={s.key} scope="col" className="px-2 py-1 font-medium">
                      {s.label} {s.unit}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line/80 text-ink">
                {tableRows.map((k) => {
                  const i = ring.index(k)
                  return (
                    <tr key={k}>
                      <th scope="row" className="px-2 py-0.5 font-normal text-left text-ink-soft">
                        {timeLabel(ring.t[i])}
                      </th>
                      {uniqueSeries.map((s) => (
                        <td key={s.key} className="px-2 py-0.5">
                          {fmt(sampleValue(ring, i, s), s.digits)}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
