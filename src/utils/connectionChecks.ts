import type { MonitorState } from '../types/monitor'

export interface ConnectionCheck {
  id: 'bridge' | 'lowstate' | 'ctrl'
  label: string
  ok: boolean
  /** What was seen when ok; what to look at when not. */
  text: string
}

/**
 * The three things a session needs, in the order they depend on each other: the bridge answers, robot state arrives through it,
 * and g1_ctrl's log is being read. `bridgeUrl` is shown when nothing answers yet.
 */
export function connectionChecks(monitor: MonitorState, bridgeUrl: string): ConnectionCheck[] {
  const hello = monitor.hello
  const replay = hello?.source === 'replay'
  const hz = monitor.aux?.link.lowstateHz ?? 0
  const gotState = replay ? monitor.aux !== null : hz > 0 && (monitor.aux?.link.lowstateAgeMs ?? Infinity) < 1500
  const ctrlLog = hello && 'ctrlLog' in hello ? (hello as unknown as { ctrlLog?: string | null }).ctrlLog : undefined
  // live: only a known state counts; lines from a g1_ctrl that has since stopped do not
  const ctrl = monitor.fsm.state !== null || (replay && monitor.fsm.events.length > 0)
  return [
    {
      id: 'bridge',
      label: 'Bridge',
      ok: hello !== null,
      text: hello ? `Connected (${hello.bridge}, ${hello.source})` : `Nothing answers at ${bridgeUrl}. Start the bridge (see below).`,
    },
    {
      id: 'lowstate',
      label: 'Robot state (rt/lowstate)',
      ok: gotState,
      text: gotState
        ? replay
          ? 'Playing from the recording'
          : `Arriving at ${hz.toFixed(0)} Hz`
        : hello
        ? `No robot state yet. Is the simulator or the robot running, and is the bridge on the right interface (${hello.iface ?? '--iface'})?`
        : 'Waits for the bridge.',
    },
    {
      id: 'ctrl',
      label: 'g1_ctrl log',
      ok: ctrl,
      text: ctrl
        ? `State ${monitor.fsm.state ?? 'not known yet'}`
        : hello
        ? `No log from a running g1_ctrl. Run g1_ctrl with --log, or pipe its output through tee into the file the bridge reads${ctrlLog ? ` (${ctrlLog})` : ''}. See Controller state in the README.`
        : 'Waits for the bridge.',
    },
  ]
}
