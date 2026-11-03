import { useSyncExternalStore } from 'react'
import { DEFAULT_SET_ID, MAX_JOINTS_PER_PANEL, MAX_USER_SETS, PLOT_WINDOWS, SHIPPED_SETS, type PanelKind, type PanelSpec, type PlotSet, type PlotWindow } from '../config/plotSets'

/**
 * What the Analyze plots show: window, plot set, the Left and right switch, and the sets the operator saved. Kept in
 * localStorage (in try/catch: it can be blocked), never sent anywhere.
 */

export interface PlotPrefs {
  windowS: PlotWindow
  setId: string
  compare: boolean
  userSets: PlotSet[]
}

export const PLOT_STORAGE_KEY = 'roco.plots.v1'
const DEFAULTS: PlotPrefs = { windowS: 10, setId: DEFAULT_SET_ID, compare: false, userSets: [] }

const isWindow = (v: unknown): v is PlotWindow => (PLOT_WINDOWS as readonly unknown[]).includes(v)
const isKind = (v: unknown): v is PanelKind => v === 'angle' || v === 'torque' || v === 'tilt'

function loadPanel(v: unknown): PanelSpec | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (!isKind(o.kind) || !Array.isArray(o.joints)) return null
  const joints = o.joints.filter((j): j is string => typeof j === 'string' && j.length < 80).slice(0, MAX_JOINTS_PER_PANEL)
  if (o.kind !== 'tilt' && joints.length === 0 && o.follow !== 'selected') return null
  return { kind: o.kind, joints, command: o.command === true, ...(o.follow === 'selected' ? { follow: 'selected' as const } : {}) }
}

export function loadUserSets(v: unknown): PlotSet[] {
  if (!Array.isArray(v)) return []
  const out: PlotSet[] = []
  for (const x of v) {
    if (typeof x !== 'object' || x === null) continue
    const o = x as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.label !== 'string' || !Array.isArray(o.panels)) continue
    if (SHIPPED_SETS.some((s) => s.id === o.id) || out.some((s) => s.id === o.id)) continue
    const panels = o.panels.map(loadPanel).filter((p): p is PanelSpec => p !== null).slice(0, 4)
    if (panels.length === 0) continue
    out.push({ id: o.id.slice(0, 40), label: o.label.slice(0, 40), hint: 'Saved in this browser.', user: true, panels })
    if (out.length >= MAX_USER_SETS) break
  }
  return out
}

function load(): PlotPrefs {
  try {
    const raw = localStorage.getItem(PLOT_STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const p: unknown = JSON.parse(raw)
    if (typeof p !== 'object' || p === null) return { ...DEFAULTS }
    const o = p as Record<string, unknown>
    const userSets = loadUserSets(o.userSets)
    const known = (id: unknown) => typeof id === 'string' && (SHIPPED_SETS.some((s) => s.id === id) || userSets.some((s) => s.id === id))
    return {
      windowS: isWindow(o.windowS) ? o.windowS : DEFAULTS.windowS,
      setId: known(o.setId) ? (o.setId as string) : DEFAULTS.setId,
      compare: o.compare === true,
      userSets,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

let prefs: PlotPrefs = load()
const listeners = new Set<() => void>()

function commit(next: PlotPrefs): void {
  prefs = next
  try {
    localStorage.setItem(PLOT_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // blocked or full: the choice still applies until the page is closed
  }
  listeners.forEach((l) => l())
}

export const allSets = (p: PlotPrefs = prefs): PlotSet[] => [...SHIPPED_SETS, ...p.userSets]
export const setById = (id: string, p: PlotPrefs = prefs): PlotSet => allSets(p).find((s) => s.id === id) ?? SHIPPED_SETS[0]

export function setWindow(windowS: PlotWindow): void {
  if (windowS !== prefs.windowS) commit({ ...prefs, windowS })
}
export function setPlotSet(setId: string): void {
  if (setId !== prefs.setId && allSets().some((s) => s.id === setId)) commit({ ...prefs, setId })
}
export function setCompare(compare: boolean): void {
  if (compare !== prefs.compare) commit({ ...prefs, compare })
}

/** Keep a set under a name. Returns false when the name is empty, taken by a shipped set, or the limit is reached. */
export function saveUserSet(label: string, build: (id: string, label: string) => PlotSet): boolean {
  const name = label.trim().slice(0, 40)
  if (!name) return false
  const existing = prefs.userSets.find((s) => s.label.toLowerCase() === name.toLowerCase())
  if (SHIPPED_SETS.some((s) => s.label.toLowerCase() === name.toLowerCase())) return false
  if (!existing && prefs.userSets.length >= MAX_USER_SETS) return false
  let id = existing?.id
  if (!id) {
    // Two saves in one millisecond must not share an id (the loader drops duplicates).
    const base = Date.now().toString(36)
    let n = 0
    while (prefs.userSets.some((s) => s.id === `user-${base}${n ? '-' + n : ''}`)) n++
    id = `user-${base}${n ? '-' + n : ''}`
  }
  const set = build(id, name)
  const userSets = existing ? prefs.userSets.map((s) => (s.id === id ? set : s)) : [...prefs.userSets, set]
  commit({ ...prefs, userSets, setId: id })
  return true
}

export function deleteUserSet(id: string): void {
  if (!prefs.userSets.some((s) => s.id === id)) return
  commit({ ...prefs, userSets: prefs.userSets.filter((s) => s.id !== id), setId: prefs.setId === id ? DEFAULT_SET_ID : prefs.setId })
}

export const getPlotPrefs = (): PlotPrefs => prefs

/** Test hook: read the stored choices again, as a page reload does. */
export function reloadPlotPrefs(): void {
  prefs = load()
  listeners.forEach((l) => l())
}

export function usePlotPrefs(): PlotPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => prefs,
  )
}
