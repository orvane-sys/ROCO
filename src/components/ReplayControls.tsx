import { useState } from 'react'
import { Pause, Play, RotateCcw, Film } from 'lucide-react'
import type { MonitorState } from '../types/monitor'
import { telemetryService } from '../services/telemetryStream'
import { statsPassNote } from '../utils/monitorFormat'

/**
 * Transport for a recording the bridge replays (`roco_dds_bridge.py --replay`): one row, so it fits in the dock under the workspace.
 * Below xl it is stuck to the bottom of the page and the row wraps.
 */
export function ReplayControls({ state }: { state: MonitorState }) {
  const r = state.replay
  // slider position while dragging; the seek is sent once, on release
  const [drag, setDrag] = useState<number | null>(null)
  if (!r) return null
  const span = r.t1 !== null ? r.t1 - r.t0 : null
  const pos = drag ?? r.t - r.t0
  const note = statsPassNote(state) ?? (span === null ? 'Seeking is available once the index is built.' : null)

  const commit = () => {
    if (drag !== null) telemetryService.sendReplayControl('seek', r.t0 + drag)
    setDrag(null)
  }

  return (
    <section
      aria-labelledby="replay-heading"
      className="sticky -bottom-3 z-20 bg-surface border border-line/90 rounded-xl px-3 py-2 flex flex-wrap xl:flex-nowrap items-center gap-x-3 gap-y-1.5 xl:relative xl:bottom-auto xl:z-0 xl:bg-transparent xl:border-0 xl:rounded-none xl:p-0"
    >
      <h2 id="replay-heading" className="sr-only">
        Replay {r.file}
      </h2>
      <Film className="w-5 h-5 text-accent shrink-0 max-xl:hidden" aria-hidden="true" />
      <button
        type="button"
        data-action="replay-toggle"
        onClick={() => telemetryService.sendReplayControl(r.playing ? 'pause' : 'play')}
        disabled={!!r.busy}
        className="px-3 min-h-9 rounded-lg bg-accent-solid text-on-accent font-semibold text-sm flex items-center gap-1.5 disabled:opacity-50 shrink-0"
      >
        {r.playing ? <Pause className="w-4 h-4" aria-hidden="true" /> : r.ended ? <RotateCcw className="w-4 h-4" aria-hidden="true" /> : <Play className="w-4 h-4" aria-hidden="true" />}
        {r.playing ? 'Pause' : r.ended ? 'Play again' : 'Play'}
      </button>
      <label className="flex items-center gap-1.5 text-sm text-ink shrink-0">
        <span>Speed</span>
        <select
          value={r.speed}
          onChange={(e) => telemetryService.sendReplayControl('speed', Number(e.target.value))}
          className="bg-surface border border-line-bold rounded-lg px-2 min-h-9 text-sm text-ink"
        >
          {r.speeds.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </label>
      <span className="text-sm font-mono text-ink tabular-nums shrink-0 max-xl:ml-auto">
        {pos.toFixed(1)} s / {span !== null ? `${span.toFixed(1)} s` : '…'}
      </span>
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
        className="h-6 accent-accent max-xl:order-last max-xl:basis-full xl:flex-1 xl:min-w-24"
      />
      <span className="text-xs text-ink-soft shrink-0 xl:w-28 xl:text-right max-xl:ml-auto" aria-live="polite">
        {r.busy ? 'Seeking…' : r.ended ? 'Ended' : r.playing ? `Playing at ${r.speed}×` : 'Paused'}
        {r.indexing ? ' · indexing' : ''}
      </span>
      {note && (
        <span className="text-xs text-ink-soft min-w-0 truncate max-xl:basis-full xl:max-w-[14rem]" title={note}>
          {note}
        </span>
      )}
    </section>
  )
}

/** What the bridge says about the recording: its notes, which Review shows in full. */
export function ReplayNotes({ state }: { state: MonitorState }) {
  const notes = state.hello?.replay?.notes ?? []
  if (!state.replay || notes.length === 0) return null
  return (
    <section aria-labelledby="replay-notes-heading" className="bg-surface/80 border border-line/90 rounded-xl p-3 flex flex-col gap-2">
      <h2 id="replay-notes-heading" className="text-base font-semibold text-ink flex items-center gap-2">
        <Film className="w-5 h-5 text-accent shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">
          Recording <span className="font-mono text-sm text-ink-soft break-all" title={state.replay.file}>{state.replay.file}</span>
        </span>
      </h2>
      <ul className="text-xs text-ink-soft list-disc pl-4">
        {notes.map((n) => (
          <li key={n} className="break-words">
            {n}
          </li>
        ))}
      </ul>
    </section>
  )
}
