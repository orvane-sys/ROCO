import { useEffect, useId, useLayoutEffect, useRef, useState, useCallback } from 'react'
import type { VelocityCommand } from '../types/telemetry'
import {
  Gamepad2,
  AlertOctagon,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  RotateCcw,
  RotateCw,
  Gauge,
  Sliders,
  ShieldAlert,
  Keyboard,
  ChevronDown,
} from 'lucide-react'
import { cn } from '../utils/cn'

interface TeleopControlsProps {
  onVelocityChange: (cmd: VelocityCommand) => void
  onEmergencyStopToggle: (latched: boolean) => void
  onOpenHelp: () => void
  isEmergencyStopped: boolean
  /** True while a dialog is open: movement keys are ignored, Space (E-stop) still works. */
  inputSuspended: boolean
  linearVelocity: { x: number; y: number }
  /** False when the robot link cannot report body linear velocity; show n/a instead of 0. */
  linearVelocityValid?: boolean
  angularVelocity: { z: number }
}

const MAX_VX = 0.8
const MAX_VY = 0.4
const MAX_WZ = 1.0

// Keyboard codes that drive the robot. Arrow left/right turn, like Q/E.
const MOVEMENT_CODES = new Set([
  'KeyW',
  'ArrowUp',
  'KeyS',
  'ArrowDown',
  'KeyA',
  'KeyD',
  'KeyQ',
  'KeyE',
  'ArrowLeft',
  'ArrowRight',
])
const ARROW_CODES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

// Arrow keys light the same on-screen keycap as their letter twin.
const KEYCAP_ALIAS: Record<string, string> = {
  ArrowUp: 'KeyW',
  ArrowDown: 'KeyS',
  ArrowLeft: 'KeyQ',
  ArrowRight: 'KeyE',
}
const VIRTUAL_KEYCAP: Record<string, string> = {
  forward: 'KeyW',
  backward: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  rot_ccw: 'KeyQ',
  rot_cw: 'KeyE',
}

const NON_TEXT_INPUT_TYPES = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'])

// Fixed-width signed number so live readouts don't jitter.
const signed = (v: number, digits = 2) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(digits)}`

const ZERO_CMD: VelocityCommand = { vx: 0, vy: 0, vz: 0 }

export function TeleopControls({
  onVelocityChange,
  onEmergencyStopToggle,
  onOpenHelp,
  isEmergencyStopped,
  inputSuspended,
  linearVelocity,
  linearVelocityValid = true,
  angularVelocity,
}: TeleopControlsProps) {
  const [speedScale, setSpeedScale] = useState<number>(1.0)
  const [gamepadName, setGamepadName] = useState<string | null>(null)
  const [activeDirection, setActiveDirection] = useState<string | null>(null)
  const [litKeys, setLitKeys] = useState<string>('')
  const [commanded, setCommanded] = useState<VelocityCommand>(ZERO_CMD)
  const [collapsed, setCollapsed] = useState<boolean>(false)

  const sliderId = useId()
  const bodyId = useId()

  const speedScaleRef = useRef(speedScale)
  const isEStoppedRef = useRef(isEmergencyStopped)
  const inputSuspendedRef = useRef(inputSuspended)

  // Latest callbacks in refs so the window listeners / 50 Hz loop are installed exactly once
  // and are never torn down by parent re-renders.
  const onVelocityChangeRef = useRef(onVelocityChange)
  const onEmergencyStopToggleRef = useRef(onEmergencyStopToggle)
  const onOpenHelpRef = useRef(onOpenHelp)

  useLayoutEffect(() => {
    speedScaleRef.current = speedScale
    onVelocityChangeRef.current = onVelocityChange
    onEmergencyStopToggleRef.current = onEmergencyStopToggle
    onOpenHelpRef.current = onOpenHelp
  })

  // Synced only on change so a locally latched E-stop isn't clobbered by a render that happens
  // before the parent's state catches up.
  useLayoutEffect(() => {
    isEStoppedRef.current = isEmergencyStopped
  }, [isEmergencyStopped])

  const pressedKeysRef = useRef<Set<string>>(new Set())
  const virtualDirectionRef = useRef<string | null>(null)
  const activeDirectionRef = useRef<string | null>(null)
  const litKeysRef = useRef('')
  const gamepadNameRef = useRef<string | null>(null)
  const lastDispatchedCmdRef = useRef<VelocityCommand>(ZERO_CMD)

  // A dialog opening must not leave a key "held" behind it.
  useLayoutEffect(() => {
    inputSuspendedRef.current = inputSuspended
    if (inputSuspended) {
      pressedKeysRef.current.clear()
      virtualDirectionRef.current = null
    }
  }, [inputSuspended])

  const updateActiveDirection = useCallback((dir: string | null) => {
    if (activeDirectionRef.current !== dir) {
      activeDirectionRef.current = dir
      setActiveDirection(dir)
    }
  }, [])

  // Latch the E-stop. Updates the local ref immediately so a second trigger within the same
  // render frame (key + gamepad, double tap) can't race against the prop round-trip.
  const latchEmergencyStop = useCallback(() => {
    pressedKeysRef.current.clear()
    virtualDirectionRef.current = null
    if (isEStoppedRef.current) return
    isEStoppedRef.current = true
    onEmergencyStopToggleRef.current(true)
  }, [])

  // Stop all motion and reset state
  const stopAllMotion = useCallback(() => {
    pressedKeysRef.current.clear()
    virtualDirectionRef.current = null
    updateActiveDirection(null)
    onVelocityChangeRef.current(ZERO_CMD)
    lastDispatchedCmdRef.current = ZERO_CMD
  }, [updateActiveDirection])

  // Attach active window keydown and keyup listeners
  useEffect(() => {
    // Only text-entry fields swallow teleop keys; sliders, buttons and checkboxes must not,
    // otherwise touching the speed slider silently disables keyboard driving.
    const isTextEntryFocused = () => {
      const activeEl = document.activeElement as HTMLElement | null
      if (!activeEl) return false
      if (activeEl instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(activeEl.type)
      return activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT' || activeEl.isContentEditable
    }

    const releaseAll = () => {
      pressedKeysRef.current.clear()
      virtualDirectionRef.current = null
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTextEntryFocused()) return

      // Space: latch-only E-stop (reset requires an explicit click). preventDefault also stops a
      // focused <button> from turning the same keystroke into a click that would toggle it back.
      // It stays armed even while a dialog is open.
      if (e.code === 'Space') {
        e.preventDefault()
        if (!e.repeat) latchEmergencyStop()
        return
      }

      if (e.key === '?' && !e.repeat) {
        e.preventDefault()
        onOpenHelpRef.current()
        return
      }

      if (inputSuspendedRef.current) return

      // Browser/OS shortcuts (Ctrl+S, Cmd+W, Alt+D …) must not start the robot: the matching keyup
      // is often swallowed, which would leave the key stuck "pressed".
      if (e.ctrlKey || e.metaKey || e.altKey) {
        releaseAll()
        return
      }

      if (!MOVEMENT_CODES.has(e.code)) return
      if (ARROW_CODES.has(e.code)) e.preventDefault()
      // Adding to a Set is idempotent, so auto-repeat is harmless — and it re-arms a key that was
      // still held when the window regained focus.
      pressedKeysRef.current.add(e.code)
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      // Always release, even if focus moved into a text field while the key was held —
      // otherwise the key stays "pressed" and the robot keeps walking.
      pressedKeysRef.current.delete(e.code)
      // Releasing a modifier can hide the keyups of keys pressed under it.
      if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt') releaseAll()
      if (e.code === 'Space' && !isTextEntryFocused()) e.preventDefault()
    }

    const handleVisibilityChange = () => {
      if (document.hidden) releaseAll()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', releaseAll)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', releaseAll)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [latchEmergencyStop])

  // Unified 50 Hz Velocity Dispatch Watchdog Loop
  useEffect(() => {
    const applyDeadzone = (val: number, threshold = 0.12) =>
      Math.abs(val) > threshold ? val : 0

    let tick = 0

    const dispatchInterval = setInterval(() => {
      tick++

      // Gamepad presence is polled, so a pad that was already connected at page load (no
      // gamepadconnected event) is still reported.
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : []
      const gp = Array.from(gamepads).find((pad) => pad?.connected) ?? null
      const padName = gp ? gp.id || 'Connected gamepad' : null
      if (gamepadNameRef.current !== padName) {
        gamepadNameRef.current = padName
        setGamepadName(padName)
      }

      if (isEStoppedRef.current) {
        const last = lastDispatchedCmdRef.current
        if (last.vx !== 0 || last.vy !== 0 || last.vz !== 0) {
          onVelocityChangeRef.current(ZERO_CMD)
          lastDispatchedCmdRef.current = ZERO_CMD
          setCommanded(ZERO_CMD)
        }
        updateActiveDirection(null)
        if (litKeysRef.current !== '') {
          litKeysRef.current = ''
          setLitKeys('')
        }
        return
      }

      let vx = 0
      let vy = 0
      let vz = 0

      // 1. Keyboard Inputs
      const keys = pressedKeysRef.current
      if (keys.has('KeyW') || keys.has('ArrowUp')) vx += MAX_VX
      if (keys.has('KeyS') || keys.has('ArrowDown')) vx -= MAX_VX
      if (keys.has('KeyA')) vy += MAX_VY
      if (keys.has('KeyD')) vy -= MAX_VY
      if (keys.has('KeyQ') || keys.has('ArrowLeft')) vz += MAX_WZ
      if (keys.has('KeyE') || keys.has('ArrowRight')) vz -= MAX_WZ

      // 2. On-Screen Virtual D-Pad Inputs
      const vDir = virtualDirectionRef.current
      if (vDir === 'forward') vx += MAX_VX
      if (vDir === 'backward') vx -= MAX_VX
      if (vDir === 'left') vy += MAX_VY
      if (vDir === 'right') vy -= MAX_VY
      if (vDir === 'rot_ccw') vz += MAX_WZ
      if (vDir === 'rot_cw') vz -= MAX_WZ

      // 3. HTML5 Gamepad Inputs (standard mapping: axes are +right / +down)
      if (gp) {
        if (gp.buttons[1]?.pressed || gp.buttons[9]?.pressed) {
          latchEmergencyStop()
          return
        }

        // Stick up → +v_x, stick left → +v_y (ROS left), right stick left → +ω_z (CCW)
        vx += -applyDeadzone(gp.axes[1] ?? 0) * MAX_VX
        vy += -applyDeadzone(gp.axes[0] ?? 0) * MAX_VY
        vz += -applyDeadzone(gp.axes[2] ?? 0) * MAX_WZ
      }

      // Apply current speed limiter
      const scale = speedScaleRef.current
      const finalVx = Number((vx * scale).toFixed(2))
      const finalVy = Number((vy * scale).toFixed(2))
      const finalVz = Number((vz * scale).toFixed(2))

      // Update active direction indicator for UI feedback
      if (finalVx > 0.05) {
        updateActiveDirection('forward')
      } else if (finalVx < -0.05) {
        updateActiveDirection('backward')
      } else if (finalVy > 0.05) {
        updateActiveDirection('left')
      } else if (finalVy < -0.05) {
        updateActiveDirection('right')
      } else if (finalVz > 0.05) {
        updateActiveDirection('rot_ccw')
      } else if (finalVz < -0.05) {
        updateActiveDirection('rot_cw')
      } else {
        updateActiveDirection(null)
      }

      // Keycap legend lights, only touching React state when the set of lit keys changes.
      const lit = new Set<string>()
      keys.forEach((code) => lit.add(KEYCAP_ALIAS[code] ?? code))
      if (vDir && VIRTUAL_KEYCAP[vDir]) lit.add(VIRTUAL_KEYCAP[vDir])
      const litSignature = Array.from(lit).sort().join(',')
      if (litKeysRef.current !== litSignature) {
        litKeysRef.current = litSignature
        setLitKeys(litSignature)
      }

      const nextCmd: VelocityCommand = { vx: finalVx, vy: finalVy, vz: finalVz }
      onVelocityChangeRef.current(nextCmd)
      const prev = lastDispatchedCmdRef.current
      lastDispatchedCmdRef.current = nextCmd

      // Mirror the commanded value into React at ~10 Hz (and immediately on a change to/from zero).
      if (tick % 5 === 0 || (prev.vx === 0 && prev.vy === 0 && prev.vz === 0) !== (finalVx === 0 && finalVy === 0 && finalVz === 0)) {
        setCommanded((c) => (c.vx === nextCmd.vx && c.vy === nextCmd.vy && c.vz === nextCmd.vz ? c : nextCmd))
      }
    }, 20) // 50 Hz

    return () => clearInterval(dispatchInterval)
  }, [latchEmergencyStop, updateActiveDirection])

  // Press-and-hold handlers for the on-screen pad (pointer events cover mouse, touch and pen).
  const holdHandlers = (direction: string) => {
    const release = () => {
      if (virtualDirectionRef.current === direction) virtualDirectionRef.current = null
    }
    return {
      onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        virtualDirectionRef.current = direction
      },
      onPointerUp: release,
      onPointerCancel: release,
      onLostPointerCapture: release,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    }
  }

  const padButton = (direction: string, active: string) =>
    cn(
      'w-14 h-14 rounded-lg flex items-center justify-center font-bold transition-colors border touch-none select-none',
      activeDirection === direction
        ? active
        : 'bg-raised/80 hover:bg-high border-line-bold text-ink'
    )
  const padActive = 'bg-accent-solid border-accent-ink text-on-accent shadow-lg shadow-accent/30'
  const turnButton = (direction: string) =>
    cn(
      'flex-1 px-3 py-3 min-h-12 rounded-lg flex items-center justify-center gap-1.5 border text-sm font-semibold transition-colors touch-none select-none',
      activeDirection === direction
        ? 'bg-info-solid border-info-ink text-on-accent shadow-md shadow-info/30'
        : 'bg-raised/80 hover:bg-high border-line-bold text-ink'
    )

  const effVx = (MAX_VX * speedScale).toFixed(2)
  const effVy = (MAX_VY * speedScale).toFixed(2)
  const effWz = (MAX_WZ * speedScale).toFixed(2)

  const handleEStopClick = () => {
    if (isEmergencyStopped) {
      onEmergencyStopToggle(false)
    } else {
      latchEmergencyStop()
    }
  }

  const keycap = (code: string, label: string) => (
    <kbd
      key={code}
      className={cn(
        'min-w-9 h-9 px-2 inline-flex items-center justify-center rounded-md border font-mono text-sm transition-colors',
        litKeys.split(',').includes(code)
          ? 'bg-accent-solid border-accent-ink text-on-accent font-bold'
          : 'bg-raised border-line-bold text-ink'
      )}
    >
      {label}
    </kbd>
  )

  return (
    <section
      aria-labelledby="teleop-heading"
      className="bg-surface/80 border border-line/90 rounded-xl p-4 flex flex-col gap-4 shadow-xl"
    >
      {/* Header & Status Indicators */}
      <div className="flex items-center justify-between gap-2 flex-wrap border-b border-line/80 pb-3">
        <div className="flex items-center gap-2">
          <Gamepad2 className="w-5 h-5 text-accent" aria-hidden="true" />
          <h2 id="teleop-heading" className="text-base font-semibold text-ink">
            Drive the robot
          </h2>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border bg-accent-solid/10 border-accent-line/40 text-accent-ink">
            <Keyboard className="w-4 h-4" aria-hidden="true" />
            <span>Keyboard active</span>
          </div>

          <div
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border ${
              gamepadName
                ? 'bg-ok/10 border-ok-line/40 text-ok-ink'
                : 'bg-raised/50 border-line-strong/60 text-ink-soft'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${gamepadName ? 'bg-ok' : 'bg-ink-muted'}`}
              aria-hidden="true"
            />
            <span className="truncate max-w-[10rem]">{gamepadName ? gamepadName.slice(0, 24) : 'No gamepad'}</span>
          </div>

          {/* Below xl the panel can be folded away; keep the E-stop within reach while it is. */}
          {collapsed && (
            <button
              type="button"
              onClick={handleEStopClick}
              aria-pressed={isEmergencyStopped}
              className="xl:hidden px-3 py-1.5 rounded-lg border-2 border-crit bg-crit-solid text-on-solid text-xs font-bold flex items-center gap-1.5"
            >
              <AlertOctagon className="w-4 h-4" aria-hidden="true" />
              {isEmergencyStopped ? 'Reset E-stop' : 'E-stop'}
            </button>
          )}

          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            className="xl:hidden p-2 rounded-lg border border-line-strong text-ink hover:bg-raised"
            aria-label={collapsed ? 'Expand drive controls' : 'Collapse drive controls'}
          >
            <ChevronDown className={cn('w-4 h-4 transition-transform', collapsed && '-rotate-90')} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div id={bodyId} className={cn('flex flex-col gap-4', collapsed && 'max-xl:hidden')}>
        {/* Main Controls Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
          {/* High-visibility emergency stop: first on narrow screens so it is never buried. */}
          <div className="order-first md:order-last flex flex-col items-center justify-center p-2">
            <button
              type="button"
              onClick={handleEStopClick}
              aria-pressed={isEmergencyStopped}
              aria-label={
                isEmergencyStopped
                  ? 'Emergency stop is latched. Activate to reset.'
                  : 'Emergency stop. Activate to halt the robot.'
              }
              className={`w-full max-w-[15rem] h-28 md:h-32 rounded-2xl flex flex-col items-center justify-center gap-1.5 border-4 transition-colors duration-150 select-none shadow-2xl relative overflow-hidden group ${
                isEmergencyStopped
                  ? 'bg-crit-solid hover:bg-crit-solid/85 border-crit-ink text-on-solid shadow-crit-solid/50'
                  : 'bg-crit-soft/70 hover:bg-crit-soft/80 border-crit-line text-crit-ink shadow-crit-soft/40'
              }`}
            >
              <AlertOctagon
                className={`w-9 h-9 ${isEmergencyStopped ? 'text-on-solid' : 'text-crit-ink'}`}
                aria-hidden="true"
              />
              <span className="font-black text-sm tracking-wide uppercase">
                {isEmergencyStopped ? 'E-stop latched' : 'Emergency stop'}
              </span>
              <span
                className={`text-xs px-2 py-0.5 rounded-full border ${
                  isEmergencyStopped
                    ? 'bg-on-solid/20 border-on-solid/50 text-on-solid font-bold'
                    : 'bg-crit-soft/60 border-crit-line/70 text-crit-ink'
                }`}
              >
                {isEmergencyStopped ? 'Click to reset' : 'Space to halt'}
              </span>
            </button>

            {isEmergencyStopped && (
              <div className="flex items-center gap-1.5 mt-2 text-crit-ink text-sm" role="status">
                <ShieldAlert className="w-4 h-4" aria-hidden="true" />
                <span>Actuator outputs inhibited</span>
              </div>
            )}
          </div>

          {/* Move pad */}
          <div className="flex flex-col items-center gap-2">
            <span className="text-sm font-medium text-ink">Move</span>
            <div
              role="group"
              aria-label="Movement pad. Hold a button to move."
              className="grid grid-cols-3 gap-1.5 p-2 bg-sunken/70 border border-line rounded-xl select-none"
            >
              <div />
              <button
                type="button"
                {...holdHandlers('forward')}
                className={padButton('forward', padActive)}
                aria-label={`Walk forward (W or Up arrow), ${effVx} meters per second`}
                title="Forward (W / ↑)"
              >
                <ArrowUp className="w-5 h-5" aria-hidden="true" />
              </button>
              <div />

              <button
                type="button"
                {...holdHandlers('left')}
                className={padButton('left', padActive)}
                aria-label={`Strafe left (A), ${effVy} meters per second`}
                title="Strafe left (A)"
              >
                <ArrowLeft className="w-5 h-5" aria-hidden="true" />
              </button>

              <button
                type="button"
                onClick={stopAllMotion}
                className="w-14 h-14 rounded-lg flex items-center justify-center text-xs font-bold bg-surface border border-line-bold hover:border-line-hot text-ink"
                aria-label="Stop moving (zero velocity)"
                title="Zero velocity"
              >
                Stop
              </button>

              <button
                type="button"
                {...holdHandlers('right')}
                className={padButton('right', padActive)}
                aria-label={`Strafe right (D), ${effVy} meters per second`}
                title="Strafe right (D)"
              >
                <ArrowRight className="w-5 h-5" aria-hidden="true" />
              </button>

              <div />
              <button
                type="button"
                {...holdHandlers('backward')}
                className={padButton('backward', padActive)}
                aria-label={`Walk backward (S or Down arrow), ${effVx} meters per second`}
                title="Backward (S / ↓)"
              >
                <ArrowDown className="w-5 h-5" aria-hidden="true" />
              </button>
              <div />
            </div>
          </div>

          {/* Turn & speed scale */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-col items-center gap-1.5">
              <span className="text-sm font-medium text-ink">Turn</span>
              <div className="flex items-center gap-2 w-full max-w-[19rem]">
                <button
                  type="button"
                  {...holdHandlers('rot_ccw')}
                  className={turnButton('rot_ccw')}
                  aria-label={`Turn left (Q or Left arrow), ${effWz} radians per second`}
                  title="Turn left (Q / ←)"
                >
                  <RotateCcw className="w-4 h-4" aria-hidden="true" />
                  <span>Left (Q)</span>
                </button>

                <button
                  type="button"
                  {...holdHandlers('rot_cw')}
                  className={turnButton('rot_cw')}
                  aria-label={`Turn right (E or Right arrow), ${effWz} radians per second`}
                  title="Turn right (E / →)"
                >
                  <RotateCw className="w-4 h-4" aria-hidden="true" />
                  <span>Right (E)</span>
                </button>
              </div>
            </div>

            {/* Speed Scale Slider */}
            <div className="bg-sunken/70 border border-line rounded-xl p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between text-sm">
                <label htmlFor={sliderId} className="flex items-center gap-1.5 text-ink">
                  <Sliders className="w-4 h-4 text-accent" aria-hidden="true" />
                  <span>Speed limit</span>
                </label>
                <span className="font-bold text-accent-ink tabular-nums">{Math.round(speedScale * 100)}%</span>
              </div>
              <input
                id={sliderId}
                type="range"
                min="0.2"
                max="1.0"
                step="0.05"
                value={speedScale}
                onChange={(e) => setSpeedScale(parseFloat(e.target.value))}
                aria-valuetext={`${Math.round(speedScale * 100)} percent`}
                className="w-full h-2 bg-raised rounded-lg appearance-none cursor-pointer accent-accent"
              />
              <div className="flex justify-between text-xs text-ink-muted">
                <span>20% (fine)</span>
                <span>60%</span>
                <span>100% (full)</span>
              </div>
            </div>
          </div>
        </div>

        {/* Keycap legend: lights up as keys are pressed */}
        <div
          className="flex items-center justify-center gap-x-6 gap-y-2 flex-wrap bg-sunken/50 border border-line/80 rounded-lg px-3 py-2"
          aria-label="Keyboard shortcuts"
          role="group"
        >
          <div className="flex items-center gap-1.5" aria-label="Move: W A S D">
            {keycap('KeyW', 'W')}
            {keycap('KeyA', 'A')}
            {keycap('KeyS', 'S')}
            {keycap('KeyD', 'D')}
            <span className="text-xs text-ink-soft ml-1">move (arrows ↑↓ too)</span>
          </div>
          <div className="flex items-center gap-1.5" aria-label="Turn: Q E">
            {keycap('KeyQ', 'Q')}
            {keycap('KeyE', 'E')}
            <span className="text-xs text-ink-soft ml-1">turn (arrows ←→ too)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <kbd className="min-w-16 h-9 px-2 inline-flex items-center justify-center rounded-md border border-crit-line/70 bg-crit-soft/60 font-mono text-sm text-crit-ink">
              Space
            </kbd>
            <span className="text-xs text-ink-soft ml-1">emergency stop</span>
          </div>
          <div className="flex items-center gap-1.5">
            <kbd className="min-w-9 h-9 px-2 inline-flex items-center justify-center rounded-md border border-line-bold bg-raised font-mono text-sm text-ink">
              ?
            </kbd>
            <span className="text-xs text-ink-soft ml-1">help</span>
          </div>
        </div>

        {/* Commanded vs measured velocity */}
        <div className="bg-sunken/60 border border-line/80 rounded-lg px-3 py-2 flex flex-col gap-1.5 text-sm text-ink-soft tabular-nums">
          <div className="flex items-center gap-x-5 gap-y-1 flex-wrap">
            <span className="flex items-center gap-1.5 text-ink font-medium">
              <Gauge className="w-4 h-4 text-accent" aria-hidden="true" />
              Commanded
            </span>
            <span>
              Forward <strong className="text-ink font-mono">{signed(commanded.vx)}</strong> m/s
            </span>
            <span>
              Sideways <strong className="text-ink font-mono">{signed(commanded.vy)}</strong> m/s
            </span>
            <span>
              Turn <strong className="text-ink font-mono">{signed(commanded.vz)}</strong> rad/s
            </span>
          </div>
          <div className="flex items-center gap-x-5 gap-y-1 flex-wrap text-ink-muted">
            <span className="font-medium">Measured</span>
            <span>
              Forward <strong className="text-ink font-mono">{linearVelocityValid ? signed(linearVelocity.x) : 'n/a'}</strong>{linearVelocityValid ? ' m/s' : ''}
            </span>
            <span>
              Sideways <strong className="text-ink font-mono">{linearVelocityValid ? signed(linearVelocity.y) : 'n/a'}</strong>{linearVelocityValid ? ' m/s' : ''}
            </span>
            <span>
              Turn <strong className="text-ink font-mono">{signed(angularVelocity.z)}</strong> rad/s
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}
