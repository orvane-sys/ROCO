import { useState } from 'react'
import { Cable, Copy, Check, RefreshCw, FlaskConical } from 'lucide-react'
import type { MonitorState } from '../types/monitor'
import { HOSTED } from '../services/telemetryStream'
import { ConnectionChecks } from './ConnectionChecks'
import { connectionChecks } from '../utils/connectionChecks'

interface ConnectScreenProps {
  monitor: MonitorState
  wsUrl: string
  connecting: boolean
  onRetry: () => void
  /** Waiting for the sample recording, not for a bridge. */
  sample: boolean
  onPlaySample: () => void
}

const CASES: { title: string; note: string; command: string; bridgeOnly: string }[] = [
  {
    title: 'Simulator on this PC',
    note: 'unitree_mujoco and g1_ctrl running on the loopback interface. The launcher starts the bridge and serves this page.',
    command: './scripts/roco sim',
    bridgeOnly: 'python3 scripts/roco_dds_bridge.py --iface lo',
  },
  {
    title: 'Real robot',
    note: 'Replace enp2s0 with the wired interface that reaches the G1.',
    command: './scripts/roco robot enp2s0',
    bridgeOnly: 'python3 scripts/roco_dds_bridge.py --iface enp2s0 --source robot',
  },
  {
    title: 'Replay a recording',
    note: 'A g1_record folder or zip (<prefix>_lowstate.csv and _lowcmd.csv).',
    command: './scripts/roco replay <folder-or-zip>',
    bridgeOnly: 'python3 scripts/roco_dds_bridge.py --replay <folder-or-zip>',
  },
]

function CommandRow({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard
      ?.writeText(command)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  return (
    <div className="flex items-stretch gap-2">
      <code className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap rounded-md border border-line-strong bg-sunken px-3 py-2 text-sm text-ink">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-line-bold bg-raised px-3 text-sm text-ink hover:border-line-hot"
      >
        {copied ? <Check className="w-4 h-4 text-ok" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  )
}

/** Shown while no bridge answers. It never shows made-up robot data in its place. */
export function ConnectScreen({ monitor, wsUrl, connecting, sample, onRetry, onPlaySample }: ConnectScreenProps) {
  return (
    <main id="monitor" tabIndex={-1} className="flex-1 min-h-0 overflow-y-auto p-4 outline-none">
      <div className="mx-auto max-w-3xl flex flex-col gap-5 py-6">
        <div className="flex items-center gap-3">
          <Cable className="w-7 h-7 text-warn-ink" aria-hidden="true" />
          <div>
            <h1 className="text-xl font-semibold text-ink">{sample ? 'The sample recording did not load' : 'Not connected to a bridge'}</h1>
            {sample ? (
              <p role="status" className="text-sm text-ink-soft">{connecting ? 'Trying again…' : 'Retrying every 3 s.'}</p>
            ) : (
              <p role="status" className="text-sm text-ink-soft">
                {connecting ? 'Trying' : 'Nothing answered at'} <span className="font-mono text-ink">{wsUrl}</span>
                {connecting ? '…' : '. Retrying every 3 s.'}
              </p>
            )}
          </div>
        </div>

        <p className="text-sm text-ink-soft">
          {sample
            ? 'ROCO only watches. On your own PC, start it with one of these in a terminal in the ROCO folder.'
            : 'ROCO only watches. Start it with one of these in a terminal in the ROCO folder; this page connects by itself once the bridge is up.'}{' '}
          The launcher needs only Python and the built page in dist/.
        </p>

        {HOSTED && (
          <p className="text-sm text-ink-soft">
            This copy of the page has no bridge behind it. To watch your own robot, get ROCO from{' '}
            <a href="https://github.com/orvane-sys/ROCO" className="text-accent-ink underline">github.com/orvane-sys/ROCO</a> and run it on a PC on
            the robot's network.
          </p>
        )}

        {!sample && <ConnectionChecks checks={connectionChecks(monitor, wsUrl)} heading="Checks, in order" />}

        <ul className="flex flex-col gap-4">
          {CASES.map((c) => (
            <li key={c.title} className="rounded-xl border border-line bg-surface/80 p-3 flex flex-col gap-2">
              <h2 className="text-base font-semibold text-ink">{c.title}</h2>
              <p className="text-sm text-ink-soft">{c.note}</p>
              <CommandRow command={c.command} />
              <details className="text-xs text-ink-soft">
                <summary className="cursor-pointer min-h-6 inline-flex items-center">Only the bridge, with <code className="mx-1">npm run dev</code> for the page</summary>
                <div className="mt-2">
                  <CommandRow command={c.bridgeOnly} />
                </div>
              </details>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-2 rounded-lg border border-line-bold bg-raised px-4 py-2 text-sm font-semibold text-ink hover:border-line-hot"
          >
            <RefreshCw className="w-4 h-4 text-info" aria-hidden="true" />
            Try again now
          </button>
          <button
            type="button"
            onClick={onPlaySample}
            className="inline-flex items-center gap-2 rounded-lg border border-demo/60 bg-demo/10 px-4 py-2 text-sm font-semibold text-demo-ink hover:bg-demo/20"
          >
            <FlaskConical className="w-4 h-4" aria-hidden="true" />
            Play a sample recording
          </button>
        </div>
        <p className="text-xs text-ink-muted">
          60 s of a real Unitree G1 squat test, played in this page. It is labelled SAMPLE and is never a live robot.
        </p>
      </div>
    </main>
  )
}
