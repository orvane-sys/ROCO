import { useSyncExternalStore } from 'react'

/**
 * What the 3D view costs this PC. TEST_MANUAL section 4 asks to close heavy programs because g1_ctrl's policy
 * shares the machine, so ROCO reports its own drawing cost instead of assuming it is small.
 *
 * The time is the CPU time of one drawn frame (pose update plus issuing the WebGL calls). The GPU's own time is
 * not visible to the page, so a slow GPU can cost more than this number shows.
 */
export type RenderState = 'running' | 'paused' | 'off'

export interface RenderSnapshot {
  state: RenderState
  /** Frames actually drawn per second over the last second. */
  fps: number
  avgMs: number
  maxMs: number
}

const IDLE: RenderSnapshot = { state: 'off', fps: 0, avgMs: 0, maxMs: 0 }
let snap: RenderSnapshot = IDLE
let state: RenderState = 'off'
let frames = 0
let sumMs = 0
let maxMs = 0
let windowStart = 0
const listeners = new Set<() => void>()
let timer: number | undefined

/** Called by the 3D view after each frame it draws. */
export function recordFrame(ms: number): void {
  if (frames === 0) windowStart = performance.now()
  frames++
  sumMs += ms
  if (ms > maxMs) maxMs = ms
}

/** Called by the 3D view when it starts, pauses (hidden) or is switched off. */
export function setRenderState(next: RenderState): void {
  state = next
  flush()
}

function flush(): void {
  const now = performance.now()
  const seconds = frames > 0 ? Math.max(0.25, (now - windowStart) / 1000) : 0
  const next: RenderSnapshot =
    state !== 'running' || frames === 0
      ? { state, fps: 0, avgMs: 0, maxMs: 0 }
      : { state, fps: frames / seconds, avgMs: sumMs / frames, maxMs }
  frames = 0
  sumMs = 0
  maxMs = 0
  windowStart = now
  const same =
    next.state === snap.state &&
    Math.round(next.fps) === Math.round(snap.fps) &&
    Math.round(next.avgMs * 10) === Math.round(snap.avgMs * 10) &&
    Math.round(next.maxMs) === Math.round(snap.maxMs)
  if (same) return
  snap = next
  listeners.forEach((l) => l())
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  if (listeners.size === 1) timer = window.setInterval(flush, 1000)
  return () => {
    listeners.delete(l)
    if (listeners.size === 0) {
      window.clearInterval(timer)
      timer = undefined
    }
  }
}

export function useRenderStats(): RenderSnapshot {
  return useSyncExternalStore(subscribe, () => snap)
}
