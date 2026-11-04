import { useState } from 'react'
import { Pause, Play, RotateCcw, Film } from 'lucide-react'
import type { MonitorState } from '../types/monitor'
import { telemetryService } from '../services/telemetryStream'
import { statsPassNote } from '../utils/monitorFormat'

/** Transport for a recording the bridge replays (`roco_dds_bridge.py --replay`). */
/** `compact` leaves out the bridge's notes about the recording; the Review workspace shows them. */
export function ReplayControls({ state, compact = false }: { state: MonitorState; compact?: boolean }) {
  const r = state.replay
  // slider position while dragging; the seek is sent once, on release
  const [drag, setDrag] = useState<number | null>(null)
  if (!r) return null
  const span = r.t1 !== null ? r.t1 - r.t0 : null
  const pos = drag ?? r.t - r.t0
  const notes = state.hello?.replay?.notes ?? []
  const passNote = statsPassNote(state)

  const commit = () => {
    if (drag !== null) telemetryService.sendReplayControl('seek', r.t0 + drag)
    setDrag(null)
  }

  return (
    <section aria-labelledby="replay-heading" className="bg-surface/80 border border-line/90 rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Film className="w-5 h-5 text-accent shrink-0" aria-hidden="true" />
          <h2 id="replay-heading" className="text-base font-semibold text-ink truncate">
            Replay <span className="font-mono text-sm text-ink-soft">{r.file}</span>
          </h2>
        </div>
        <span className="text-xs text-ink-soft" aria-live="polite">
          {r.busy ? 'Seeking…' : r.ended ? 'Ended' : r.playing ? `Playing at ${r.speed}×` : 'Paused'}
          {r.indexing ? ' · building seek index' : ''}
        </span>
        {passNote && <span className="text-xs text-ink-soft w-full sm:w-auto">{passNote}</span>}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => telemetryService.sendReplayControl(r.playing ? 'pause' : 'play')}
          disabled={!!r.busy}
          className="px-3 py-1.5 rounded-lg bg-accent-solid text-on-accent font-semibold text-sm flex items-center gap-1.5 disabled:opacity-50"
        >
          {r.playing ? <Pause className="w-4 h-4" aria-hidden="true" /> : r.ended ? <RotateCcw className="w-4 h-4" aria-hidden="true" /> : <Play className="w-4 h-4" aria-hidden="true" />}
          {r.playing ? 'Pause' : r.ended ? 'Play again' : 'Play'}
        </button>
        <label className="flex items-center gap-1.5 text-sm text-ink">
          <span>Speed</span>
          <select
            value={r.speed}
            onChange={(e) => telemetryService.sendReplayControl('speed', Number(e.target.value))}
            className="bg-surface border border-line-bold rounded-lg px-2 py-1 text-sm text-ink"
          >
            {r.speeds.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <span className="text-sm font-mono text-ink tabular-nums ml-auto">
          {pos.toFixed(1)} s / {span !== null ? `${span.toFixed(1)} s` : '…'}
        </span>
      </div>

      <input
        type="range"
        min={0}
        max={span ?? 1}
        step={0.1}
        value={Math.min(pos, span ?? 1)}
        disabled={span === null || !!r.busy}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={() => setDrag(null)}
        aria-label="Recording position, seconds"
        aria-valuetext={`${pos.toFixed(1)} of ${span?.toFixed(1) ?? 'unknown'} seconds`}
        className="w-full h-6 accent-accent"
      />
      {span === null && <p className="text-xs text-ink-muted">Seeking is available once the index is built.</p>}
      {!compact && notes.length > 0 && (
        <ul className="text-xs text-ink-muted list-disc pl-4">
          {notes.map((n) => (
            <li key={n} className="break-words">{n}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
