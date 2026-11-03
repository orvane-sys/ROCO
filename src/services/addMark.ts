import { marksStore, startMarkNote } from './marksStore'
import { telemetryService } from './telemetryStream'

/**
 * Add a mark at the current moment of the data (the recording's position, or the newest live sample) and open its note.
 * Returns null when there is no data yet, so a mark never gets a made-up time.
 */
export function addMarkNow(): { id: string; t: number } | null {
  const m = telemetryService.getMonitorState()
  const t = m.replay ? m.replay.t : m.aux?.t
  if (t === undefined || t === null || !Number.isFinite(t)) return null
  const id = marksStore(m.hello?.source === 'replay' ? 'replay' : 'live').add(t)
  if (!id) return null
  startMarkNote(id)
  return { id, t }
}
