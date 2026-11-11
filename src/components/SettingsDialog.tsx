import { useId, useState } from 'react'
import { AlertTriangle, Binary, Bot, CheckCircle2, FlaskConical, FolderUp, Radio, RefreshCw } from 'lucide-react'
import type { ConnectionStatus } from '../types/telemetry'
import { Dialog } from './Dialog'
import { telemetryService } from '../services/telemetryStream'
import { getAllRobotProfiles, type RobotProfile } from '../config/robotRegistry'

function validateWsUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return 'Address must start with ws:// or wss://'
    if (!url.hostname) return 'Address needs a host name'
    return null
  } catch {
    return 'Not a valid address. Example: ws://localhost:8765'
  }
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  LIVE: 'Live robot bridge',
  SAFETY_HALT: 'Watchdog safety halt',
  CONNECTING: 'Connecting…',
  DISCONNECTED: 'Disconnected',
}

interface SettingsDialogProps {
  profile: RobotProfile
  onSelectProfile: (profileId: string) => void
  /** Closes this dialog and opens the importer. */
  onImport: () => void
  status: ConnectionStatus
  wsUrl: string
  onClose: () => void
  onUpdateConfig: (config: { wsUrl: string }) => void
  /** The sample recording is playing. */
  sample: boolean
  onPlaySample: () => void
  onReconnect: () => void
}

/** Mounted only while open, so the input always starts from the saved address. */
export function SettingsDialog({ profile, onSelectProfile, onImport, status, wsUrl, onClose, onUpdateConfig, sample, onPlaySample, onReconnect }: SettingsDialogProps) {
  const inputId = useId()
  const robotId = useId()
  const errorId = useId()
  const [inputUrl, setInputUrl] = useState(wsUrl)
  const [error, setError] = useState<string | null>(null)
  const [codecTestResult, setCodecTestResult] = useState<{ success: boolean; roundtripMaxJointDiff: number } | null>(null)

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    const value = inputUrl.trim()
    const problem = validateWsUrl(value)
    if (problem) {
      setError(problem)
      return
    }
    onUpdateConfig({ wsUrl: value })
    onClose()
  }

  const handleRunCodecTest = () => {
    const res = telemetryService.verifyBinaryCodec()
    setCodecTestResult(res)
  }

  const secondaryButton =
    'flex-1 px-3 py-2.5 rounded-lg bg-raised hover:bg-high text-ink text-sm flex items-center justify-center gap-1.5 transition-colors'

  return (
    <Dialog
      title="Settings"
      icon={<Radio className="w-5 h-5 text-accent" aria-hidden="true" />}
      onClose={onClose}
    >
      <form onSubmit={handleSave} className="flex flex-col gap-4" noValidate>
        <div className="bg-sunken/60 p-3 rounded-lg border border-line flex flex-col gap-2">
          <label htmlFor={robotId} className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Bot className="w-4 h-4 text-accent" aria-hidden="true" />
            Robot model
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              id={robotId}
              value={profile.id}
              onChange={(e) => onSelectProfile(e.target.value)}
              className="flex-1 min-w-0 min-h-9 bg-surface border border-line-bold rounded-lg px-2 text-sm text-ink"
            >
              {getAllRobotProfiles().map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="text-xs font-mono font-bold px-1.5 py-0.5 rounded bg-accent-soft text-accent-ink border border-accent-line">
              {profile.joints.length} DOF
            </span>
            <button
              type="button"
              onClick={onImport}
              className="flex items-center gap-1.5 px-2.5 min-h-9 rounded-lg bg-raised hover:bg-high border border-line-strong text-sm text-ink"
            >
              <FolderUp className="w-4 h-4 text-accent" aria-hidden="true" />
              Import model…
            </button>
          </div>
          <p className="text-xs text-ink-muted">The model sets the joint names and the 3D shape. The bridge chooses the limits.</p>
        </div>

        <div>
          <label htmlFor={inputId} className="block text-sm text-ink mb-1.5">
            WebSocket address
          </label>
          <input
            id={inputId}
            type="text"
            inputMode="url"
            value={inputUrl}
            onChange={(e) => {
              setInputUrl(e.target.value)
              setError(null)
            }}
            placeholder="ws://localhost:8765"
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            className="w-full bg-sunken border border-line-bold rounded-lg px-3.5 py-2.5 font-mono text-sm text-ink focus:border-accent"
          />
          {error ? (
            <p id={errorId} role="alert" className="text-sm text-crit-ink mt-1.5">
              {error}
            </p>
          ) : (
            <p className="text-xs text-ink-muted mt-1.5">
              Binary WebSocket stream (2092B LowState_ ArrayBuffer). Trips safety halt if packets cease &gt;250ms.
            </p>
          )}
        </div>

        {/* Unitree G1 Binary Codec & Loopback Verification */}
        <div className="bg-sunken/70 p-3 rounded-lg border border-line flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Binary className="w-4 h-4 text-accent" />
              <span className="text-xs font-semibold text-ink">Binary LowState_ codec (2092B)</span>
            </div>
          </div>
          <p className="text-xs text-ink-muted">
            Encodes a test posture into a Unitree G1 binary LowState_ frame and decodes it with a DataView into a reused snapshot.
          </p>
          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={handleRunCodecTest}
              className="px-2.5 py-1 text-xs font-mono rounded bg-raised hover:bg-high text-accent-ink border border-line-strong flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Verify Codec Fidelity</span>
            </button>
            {codecTestResult && (
              <span
                role="status"
                className={`text-xs font-mono flex items-center gap-1 ${
                  codecTestResult.success ? 'text-ok' : 'text-crit-ink'
                }`}
              >
                {codecTestResult.success ? (
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>
                  {codecTestResult.success
                    ? 'CRC32 OK (Δ < 1e-4 rad)'
                    : `Codec check FAILED (max Δ ${codecTestResult.roundtripMaxJointDiff.toExponential(1)} rad)`}
                </span>
              </span>
            )}
          </div>
        </div>

        <div className="bg-sunken/60 p-3 rounded-lg border border-line flex items-center justify-between text-sm">
          <span className="text-ink-soft">Current mode</span>
          <span className="text-accent-ink font-semibold">{sample ? 'Sample recording, not a robot' : (STATUS_LABEL[status] ?? status)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => {
              onPlaySample()
              onClose()
            }}
            className={secondaryButton}
          >
            <FlaskConical className="w-4 h-4 text-accent" aria-hidden="true" />
            <span>Play a sample recording</span>
          </button>
          <button
            type="button"
            data-action="reconnect"
            onClick={() => {
              onReconnect()
              onClose()
            }}
            className={secondaryButton}
          >
            <RefreshCw className="w-4 h-4 text-info" aria-hidden="true" />
            <span>Reconnect</span>
          </button>
          <button
            type="submit"
            className="flex-1 px-3 py-2.5 rounded-lg bg-accent-solid hover:bg-accent-solid/85 text-on-accent font-bold text-sm transition-colors"
          >
            Save &amp; apply
          </button>
        </div>
      </form>
    </Dialog>
  )
}
