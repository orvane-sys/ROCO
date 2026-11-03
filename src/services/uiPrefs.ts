import { useSyncExternalStore } from 'react'

/**
 * How the page looks, per viewer. Kept in localStorage (wrapped in try/catch, since it can be blocked or
 * empty), never sent anywhere. The same keys are read by the small script in index.html, so the first paint
 * already has the right theme and text size.
 */

export type ThemePref = 'auto' | 'dark' | 'light' | 'contrast'
export type Theme = 'dark' | 'light' | 'contrast'

export const THEME_PREFS: { value: ThemePref; label: string; hint: string }[] = [
  { value: 'auto', label: 'Automatic', hint: 'Dark, or High contrast when the system asks for more contrast' },
  { value: 'dark', label: 'Dark', hint: 'Low glare, for a dim room' },
  { value: 'light', label: 'Light', hint: 'For a bright test floor' },
  { value: 'contrast', label: 'High contrast', hint: 'Black and white with bright status colours' },
]

export const TEXT_SCALES = [100, 115, 130] as const
export type TextScale = (typeof TEXT_SCALES)[number]

export type Workspace = 'run' | 'analyze' | 'review'
export const WORKSPACES: { id: Workspace; label: string; key: string; hint: string }[] = [
  { id: 'run', label: 'Run', key: '1', hint: 'State, alerts and the robot: what to watch during a test' },
  { id: 'analyze', label: 'Analyze', key: '2', hint: 'Plots and the full joint table' },
  { id: 'review', label: 'Review', key: '3', hint: 'Per-state numbers, alert history and the recording' },
]

/** How much the 3D view may use. `auto` is reduced on the Run workspace and whenever the source is a real robot. */
export type Scene3dPref = 'auto' | 'full' | 'low' | 'off'
export const SCENE3D_PREFS: { value: Scene3dPref; label: string; hint: string }[] = [
  { value: 'auto', label: 'Automatic', hint: 'Reduced on Run and when connected to a robot, full elsewhere' },
  { value: 'full', label: 'Full', hint: 'Smooth motion, shadows, sharp on high-density screens' },
  { value: 'low', label: 'Reduced', hint: '15 frames a second, no shadows, standard resolution' },
  { value: 'off', label: 'Off', hint: 'No 3D drawing at all, so it takes no time from the test PC' },
]

export interface UiPrefs {
  theme: ThemePref
  textScale: TextScale
  workspace: Workspace
  scene3d: Scene3dPref
  /** A tone for a new critical alert. Off until the operator turns it on. */
  sound: boolean
  /** Spoken state changes and new critical alerts (speechSynthesis). Off until the operator turns it on. */
  speech: boolean
  /** Column widths in percent, per workspace (and `drive`), in the order the visible columns appear. */
  split: Record<string, number[]>
}

export interface UiState extends UiPrefs {
  /** The theme actually applied: `auto` resolved against the system's contrast settings. */
  resolvedTheme: Theme
}

export const STORAGE_KEY = 'roco.ui.v1'
const DEFAULTS: UiPrefs = { theme: 'auto', textScale: 100, workspace: 'run', scene3d: 'auto', sound: false, speech: false, split: {} }

const isThemePref = (v: unknown): v is ThemePref => v === 'auto' || v === 'dark' || v === 'light' || v === 'contrast'
const isTextScale = (v: unknown): v is TextScale => (TEXT_SCALES as readonly unknown[]).includes(v)

const isWorkspace = (v: unknown): v is Workspace => v === 'run' || v === 'analyze' || v === 'review'
const isScene3d = (v: unknown): v is Scene3dPref => v === 'auto' || v === 'full' || v === 'low' || v === 'off'

function loadSplit(v: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  if (typeof v !== 'object' || v === null) return out
  for (const [k, sizes] of Object.entries(v)) {
    if (Array.isArray(sizes) && sizes.length >= 2 && sizes.length <= 3 && sizes.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0))
      out[k] = sizes
  }
  return out
}

function load(): UiPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const p: unknown = JSON.parse(raw)
    if (typeof p !== 'object' || p === null) return { ...DEFAULTS }
    const o = p as Record<string, unknown>
    return {
      theme: isThemePref(o.theme) ? o.theme : DEFAULTS.theme,
      textScale: isTextScale(o.textScale) ? o.textScale : DEFAULTS.textScale,
      workspace: isWorkspace(o.workspace) ? o.workspace : DEFAULTS.workspace,
      scene3d: isScene3d(o.scene3d) ? o.scene3d : DEFAULTS.scene3d,
      sound: o.sound === true,
      speech: o.speech === true,
      split: loadSplit(o.split),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function save(p: UiPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    // blocked or full: the choice still applies until the page is closed
  }
}

const contrastQueries = (): MediaQueryList[] =>
  typeof matchMedia === 'function' ? [matchMedia('(forced-colors: active)'), matchMedia('(prefers-contrast: more)')] : []

function resolve(theme: ThemePref): Theme {
  if (theme !== 'auto') return theme
  return contrastQueries().some((q) => q.matches) ? 'contrast' : 'dark'
}

let prefs: UiPrefs = load()
let state: UiState = { ...prefs, resolvedTheme: resolve(prefs.theme) }
const listeners = new Set<() => void>()

function apply(): void {
  const root = document.documentElement
  root.dataset.theme = state.resolvedTheme
  // rem units follow this, so every size on the page, and the canvases, scale with it
  root.style.fontSize = state.textScale === 100 ? '' : `${state.textScale}%`
}

function refresh(): void {
  const next: UiState = { ...prefs, resolvedTheme: resolve(prefs.theme) }
  if (
    next.theme === state.theme &&
    next.textScale === state.textScale &&
    next.resolvedTheme === state.resolvedTheme &&
    next.workspace === state.workspace &&
    next.scene3d === state.scene3d &&
    next.sound === state.sound &&
    next.speech === state.speech &&
    next.split === state.split
  )
    return
  state = next
  apply()
  listeners.forEach((l) => l())
}

let started = false
/** Apply the saved choices and follow changes made in another tab or in the system settings. Safe to call twice. */
export function initUiPrefs(): void {
  if (started) return
  started = true
  apply()
  contrastQueries().forEach((q) => q.addEventListener('change', refresh))
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return
    prefs = load()
    refresh()
  })
}

export function setTheme(theme: ThemePref): void {
  prefs = { ...prefs, theme }
  save(prefs)
  refresh()
}

export function setTextScale(textScale: TextScale): void {
  prefs = { ...prefs, textScale }
  save(prefs)
  refresh()
}

export function setWorkspace(workspace: Workspace): void {
  prefs = { ...prefs, workspace }
  save(prefs)
  refresh()
}

export function setScene3d(scene3d: Scene3dPref): void {
  prefs = { ...prefs, scene3d }
  save(prefs)
  refresh()
}

export function setSound(sound: boolean): void {
  prefs = { ...prefs, sound }
  save(prefs)
  refresh()
}

export function setSpeech(speech: boolean): void {
  prefs = { ...prefs, speech }
  save(prefs)
  refresh()
}

/** Remember column widths for one layout. Pass `null` to go back to the default. */
export function setSplit(key: string, sizes: number[] | null): void {
  const split = { ...prefs.split }
  if (sizes) split[key] = sizes
  else delete split[key]
  prefs = { ...prefs, split }
  save(prefs)
  refresh()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useUiPrefs(): UiState {
  return useSyncExternalStore(subscribe, () => state)
}

/** Current value of a CSS custom property such as `--plot-s1`, for canvas and WebGL colours. */
export function themeVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Size of 1 rem in px relative to the 16 px design size: text size setting times the browser's own font setting. */
export function remScale(): number {
  return (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16
}

export type SceneQualityLevel = 'full' | 'low' | 'off'

/**
 * What the 3D view actually does. `auto` follows the manual (TEST_MANUAL section 4: the policy shares this PC):
 * reduced on the Run workspace and whenever the data comes from a real robot.
 */
export function resolveScene3d(
  pref: Scene3dPref,
  workspace: Workspace | null,
  source: 'sim' | 'robot' | 'replay' | null
): SceneQualityLevel {
  if (pref !== 'auto') return pref
  if (source === 'robot' || workspace === 'run') return 'low'
  return 'full'
}
