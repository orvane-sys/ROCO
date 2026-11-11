import { useEffect, useRef } from 'react'
import type { RobotProfile } from '../config/robotRegistry'
import type { MonitorState } from '../types/monitor'
import { announcementText, type AlertGroup, type AlertView } from '../utils/alertModel'
import { alertTitle } from '../utils/monitorFormat'
import { armAudioUnlock, playCriticalTone, speak, stopSpeaking } from '../services/alertCues'

/** Never announce faster than this. A flood of alerts is read as one message. */
const ASSERTIVE_MIN_GAP_MS = 5000
const POLITE_MIN_GAP_MS = 1500
/** A live region only announces a change, so an identical message is cleared first and set again after this pause. */
const REPEAT_PAUSE_MS = 60

interface Props {
  state: MonitorState
  view: AlertView
  profile: RobotProfile
  sound: boolean
  speech: boolean
  /** Abort checks and guided-check stop limits that are crossed. Each is announced once, as a critical message. */
  limits: { id: string; text: string }[]
}

function write(el: HTMLElement | null, text: string, timers: number[]): void {
  if (!el) return
  el.textContent = ''
  timers.push(
    window.setTimeout(() => {
      el.textContent = text
    }, REPEAT_PAUSE_MS)
  )
  if (timers.length > 20) timers.splice(0, timers.length - 20)
}

function describe(g: AlertGroup, state: MonitorState, profile: RobotProfile): string {
  const crit = [g.first, ...g.rest].find((i) => i.active && i.level === 'critical') ?? g.first
  const after = g.cause ? 'After the change to Passive. ' : ''
  return `${after}Critical alert: ${alertTitle(crit.alert, profile, state)}. ${crit.response}`
}

/**
 * The page's two live regions, and the optional tone and speech. One polite region says the g1_ctrl state when it changes. One
 * assertive region says a new critical group, a tripped abort check or a crossed stop limit, at most once every few seconds, and
 * says how many when several came together.
 * Nothing is announced per frame, and warnings are not announced: they are on the page and in the status bar.
 */
export function AlertAnnouncer({ state, view, profile, sound, speech, limits }: Props) {
  const politeEl = useRef<HTMLDivElement>(null)
  const assertiveEl = useRef<HTMLDivElement>(null)
  const prefs = useRef({ sound, speech })
  const latest = useRef({ state, profile })
  const lastState = useRef<string | null | undefined>(undefined)
  const announced = useRef(new Set<string>())
  const queue = useRef<string[]>([])
  const lastAssertive = useRef(-Infinity)
  const lastPolite = useRef(-Infinity)
  const politeTimer = useRef<number | undefined>(undefined)
  const assertiveTimer = useRef<number | undefined>(undefined)
  const writeTimers = useRef<number[]>([])

  useEffect(() => {
    prefs.current = { sound, speech }
    latest.current = { state, profile }
  })

  useEffect(() => {
    if (sound) armAudioUnlock()
    if (!speech) stopSpeaking()
  }, [sound, speech])

  useEffect(() => {
    const timers = writeTimers.current
    return () => {
      window.clearTimeout(politeTimer.current)
      window.clearTimeout(assertiveTimer.current)
      timers.forEach((t) => window.clearTimeout(t))
      stopSpeaking()
    }
  }, [])

  // state changes: polite, latest wins, not faster than POLITE_MIN_GAP_MS
  const fsmState = state.fsm.state
  useEffect(() => {
    if (fsmState === null) return
    const before = lastState.current
    lastState.current = fsmState
    if (before === undefined || before === fsmState) return
    const message = `Controller state: ${fsmState}`
    window.clearTimeout(politeTimer.current)
    const wait = Math.max(0, lastPolite.current + POLITE_MIN_GAP_MS - performance.now())
    politeTimer.current = window.setTimeout(() => {
      lastPolite.current = performance.now()
      write(politeEl.current, message, writeTimers.current)
      if (prefs.current.speech) speak(message)
    }, wait)
  }, [fsmState])

  // new critical groups, tripped abort checks and crossed stop limits: assertive, once each, rate limited
  useEffect(() => {
    const live = new Set([...view.groups.map((g) => g.id), ...limits.map((l) => l.id)])
    for (const id of announced.current) if (!live.has(id)) announced.current.delete(id)
    const fresh = view.groups.filter((g) => g.level === 'critical' && !announced.current.has(g.id))
    const freshLimits = limits.filter((l) => !announced.current.has(l.id))
    if (fresh.length === 0 && freshLimits.length === 0) return
    for (const g of fresh) announced.current.add(g.id)
    for (const l of freshLimits) announced.current.add(l.id)
    queue.current.push(...fresh.map((g) => describe(g, latest.current.state, latest.current.profile)), ...freshLimits.map((l) => l.text))

    const flush = () => {
      const messages = queue.current
      if (messages.length === 0) return
      queue.current = []
      lastAssertive.current = performance.now()
      const text = announcementText(messages)
      write(assertiveEl.current, text, writeTimers.current)
      if (prefs.current.sound) playCriticalTone()
      if (prefs.current.speech) speak(text)
    }
    const wait = lastAssertive.current + ASSERTIVE_MIN_GAP_MS - performance.now()
    window.clearTimeout(assertiveTimer.current)
    if (wait <= 0) flush()
    else assertiveTimer.current = window.setTimeout(flush, wait)
  }, [view.groups, limits])

  return (
    <>
      <div ref={politeEl} role="status" aria-live="polite" aria-atomic="true" className="sr-only" />
      <div ref={assertiveEl} role="alert" aria-live="assertive" aria-atomic="true" className="sr-only" />
    </>
  )
}
