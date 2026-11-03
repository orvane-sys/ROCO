import { useSyncExternalStore } from 'react'

/**
 * Cues that do not need the eyes: a tone for a new critical alert and spoken state changes. Both are off until the operator
 * turns them on, and both are generated on this PC (WebAudio and the browser's own speech), so nothing is fetched. Browsers
 * only let a page make sound after a click or key press, so the audio context is made from the button's own click and
 * resumed on the next click or key press if the browser suspended it.
 */

type AudioCtor = typeof AudioContext
const audioCtor = (): AudioCtor | undefined =>
  typeof window === 'undefined' ? undefined : window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext

export const soundSupported = (): boolean => audioCtor() !== undefined
export const speechSupported = (): boolean =>
  typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window

let ctx: AudioContext | null = null
let running = false
const listeners = new Set<() => void>()

function setRunning(next: boolean): void {
  if (next === running) return
  running = next
  listeners.forEach((l) => l())
}

function context(): AudioContext | null {
  if (ctx) return ctx
  const Ctor = audioCtor()
  if (!Ctor) return null
  try {
    ctx = new Ctor()
    setRunning(ctx.state === 'running')
    ctx.addEventListener('statechange', () => setRunning(ctx?.state === 'running'))
  } catch {
    ctx = null
  }
  return ctx
}

/** Call from a click or key press. Resolves true when the page may make sound. */
export async function prepareAudio(): Promise<boolean> {
  const c = context()
  if (!c) return false
  try {
    if (c.state !== 'running') await c.resume()
  } catch {
    // stays suspended; the next gesture tries again
  }
  setRunning(c.state === 'running')
  return c.state === 'running'
}

let unlockArmed = false
/** While sound is on, the next click or key press resumes a suspended context (after a page reload, for example). */
export function armAudioUnlock(): void {
  if (unlockArmed || typeof window === 'undefined') return
  unlockArmed = true
  const unlock = () => {
    void prepareAudio().then((ok) => {
      if (ok) {
        window.removeEventListener('pointerdown', unlock, true)
        window.removeEventListener('keydown', unlock, true)
        unlockArmed = false
      }
    })
  }
  window.addEventListener('pointerdown', unlock, true)
  window.addEventListener('keydown', unlock, true)
}

function beep(c: AudioContext, start: number, freq: number, dur: number, gain: number): void {
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = 'square'
  osc.frequency.value = freq
  g.gain.setValueAtTime(0, start)
  g.gain.linearRampToValueAtTime(gain, start + 0.01)
  g.gain.setValueAtTime(gain, start + dur - 0.02)
  g.gain.linearRampToValueAtTime(0, start + dur)
  osc.connect(g).connect(c.destination)
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

/** Three alternating high and low pulses: unlike the single soft blip of the test tone, and not a message chime. */
export function playCriticalTone(): void {
  const c = context()
  if (!c || c.state !== 'running') return
  const t = c.currentTime + 0.02
  for (let i = 0; i < 3; i++) beep(c, t + i * 0.2, i % 2 === 0 ? 880 : 587, 0.15, 0.12)
}

/** One short soft blip, to confirm that sound works. */
export function playTestTone(): void {
  const c = context()
  if (!c || c.state !== 'running') return
  beep(c, c.currentTime + 0.02, 660, 0.12, 0.06)
}

/** Speak a short sentence now, replacing anything still being spoken. */
export function speak(text: string): void {
  if (!speechSupported()) return
  try {
    const synth = window.speechSynthesis
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.05
    synth.speak(u)
  } catch {
    // no voice available
  }
}

export function stopSpeaking(): void {
  if (!speechSupported()) return
  try {
    window.speechSynthesis.cancel()
  } catch {
    // nothing to stop
  }
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** True once the page may make sound. False before the first click, or when the browser has blocked audio. */
export function useAudioRunning(): boolean {
  return useSyncExternalStore(subscribe, () => running)
}
