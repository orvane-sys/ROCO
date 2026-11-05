// Plays a sample recording in the browser where no bridge can run, such as GitHub Pages. It has the WebSocket surface telemetryStream
// uses and sends what the real bridge sent for that recording, so every frame goes through the page's normal code.
//
// The file comes from scripts/capture_demo.py: a gzip of records [u32 ms][u8 kind][u32 len][payload], little-endian, ms being data time
// since the recording's first moment. GREETING records are what a page gets on connecting, PLAY records a 1x play-through, SNAPSHOT
// records what the bridge sent after a seek to that whole second. The BINARY flag marks a binary frame.

const GREETING = 0
const PLAY = 1
const SNAPSHOT = 2
const BINARY = 0x80
const HEADER_BYTES = 9
const TICK_MS = 20 // the bridge's 50 Hz step
const STATUS_MS = 200
const MAX_STEP_S = 0.25 // as the bridge: a stalled timer plays on from where it was

interface SampleRecord {
  ms: number
  text: string | null
  bytes: Uint8Array | null
  aux: boolean
  /** An aux frame that opens or closes an alert. It must reach the page even when frames are skipped at high speed. */
  alert: boolean
}

export type SampleFrame = string | ArrayBuffer

export interface Sample {
  greeting: SampleFrame[]
  /** The status frame of the greeting: the template of the status frames sent later. */
  status: Record<string, unknown> & { t0: number; t1: number }
  play: SampleRecord[]
  /** By whole second. */
  snapshots: SampleFrame[][]
  endMs: number
}

const toFrame = (r: SampleRecord): SampleFrame => r.text ?? (r.bytes as Uint8Array).slice().buffer

export function parseSample(raw: Uint8Array): Sample {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const decoder = new TextDecoder()
  const greeting: SampleFrame[] = []
  const play: SampleRecord[] = []
  const snapshots: SampleFrame[][] = []
  let status: Sample['status'] | null = null
  for (let i = 0; i + HEADER_BYTES <= raw.length; ) {
    const ms = view.getUint32(i, true)
    const kind = view.getUint8(i + 4)
    const len = view.getUint32(i + 5, true)
    const body = raw.subarray(i + HEADER_BYTES, i + HEADER_BYTES + len)
    i += HEADER_BYTES + len
    const text = kind & BINARY ? null : decoder.decode(body)
    const aux = text !== null && text.startsWith('{"type":"aux"')
    const r: SampleRecord = {
      ms,
      text,
      bytes: text === null ? body : null,
      aux,
      alert: aux && !text.includes('"alertEvents":[]'),
    }
    const k = kind & ~BINARY
    if (k === GREETING) {
      if (text?.startsWith('{"type":"replay"')) status = JSON.parse(text)
      else greeting.push(toFrame(r))
    } else if (k === PLAY) play.push(r)
    else if (k === SNAPSHOT) (snapshots[ms / 1000] ??= []).push(toFrame(r))
  }
  if (!status || !play.length || !snapshots[0]) throw new Error('not a sample recording')
  return { greeting, status, play, snapshots, endMs: play[play.length - 1].ms }
}

/** Index of the first record later than ms. */
function firstAfter(play: SampleRecord[], ms: number): number {
  let lo = 0
  let hi = play.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (play[mid].ms > ms) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * The frames for the time after `from` up to `to` (ms): every fsm frame and every aux frame with an alert, but only the last aux and
 * binary frame, as the bridge sends one of each per step at any speed.
 */
export function playFrames(sample: Sample, from: number, to: number): SampleFrame[] {
  const { play } = sample
  const lo = firstAfter(play, from)
  const hi = firstAfter(play, to)
  let lastAux = -1
  let lastBinary = -1
  for (let i = hi - 1; i >= lo && (lastAux < 0 || lastBinary < 0); i--) {
    if (play[i].bytes && lastBinary < 0) lastBinary = i
    else if (play[i].aux && lastAux < 0) lastAux = i
  }
  const out: SampleFrame[] = []
  for (let i = lo; i < hi; i++) {
    const r = play[i]
    if (r.bytes ? i === lastBinary : !r.aux || r.alert || i === lastAux) out.push(toFrame(r))
  }
  return out
}

/** What a page gets after a seek to ms: what the bridge sent for the whole second before it, then the rest of the way there. */
export function seekFrames(sample: Sample, ms: number): SampleFrame[] {
  const sec = Math.min(Math.floor(ms / 1000), sample.snapshots.length - 1)
  return [...sample.snapshots[sec], ...playFrames(sample, sec * 1000, ms)]
}

export class RecordedBridgeSocket {
  readyState: number = 0 // WebSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  private readonly abort = new AbortController()
  private sample: Sample | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private cursor = -1 // ms; before the first record, whose frames are stamped 0
  private playing = true
  private ended = false
  private speed = 1
  private lastWall = 0
  private lastStatus = 0

  constructor(url: string) {
    void this.load(url)
  }

  private async load(url: string): Promise<void> {
    try {
      const res = await fetch(url, { signal: this.abort.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      let raw = new Uint8Array(await res.arrayBuffer())
      // A host may send it Content-Encoding: gzip, and then the browser has already unpacked it.
      if (raw[0] === 0x1f && raw[1] === 0x8b) {
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))
        raw = new Uint8Array(await new Response(stream).arrayBuffer())
      }
      if (this.readyState !== 0) return
      this.sample = parseSample(raw)
    } catch {
      if (this.readyState !== 0) return
      this.readyState = 3 // WebSocket.CLOSED
      this.onerror?.()
      this.onclose?.()
      return
    }
    this.readyState = 1 // WebSocket.OPEN
    this.onopen?.()
    this.emit(this.sample.greeting)
    this.sendStatus(null)
    this.lastWall = performance.now()
    this.timer = setTimeout(this.tick, TICK_MS)
  }

  send(data: unknown): void {
    if (typeof data !== 'string' || !this.sample) return
    let msg: { type?: string; action?: string; value?: number }
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (msg.type !== 'replay_control') return
    const { status } = this.sample
    if (msg.action === 'play') {
      if (this.ended) this.seek(status.t0)
      this.playing = true
    } else if (msg.action === 'pause') this.playing = false
    else if (msg.action === 'speed' && (status.speeds as number[]).includes(msg.value as number)) this.speed = msg.value as number
    else if (msg.action === 'seek' && Number.isFinite(msg.value)) this.seek(msg.value as number)
    else return
    this.sendStatus(null)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.abort.abort()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.sample = null
    this.onclose?.()
  }

  private readonly tick = (): void => {
    const sample = this.sample
    if (!sample) return
    const now = performance.now()
    const step = Math.min(MAX_STEP_S, (now - this.lastWall) / 1000)
    this.lastWall = now
    if (this.playing) {
      const target = Math.min(sample.endMs, Math.max(this.cursor, 0) + step * 1000 * this.speed)
      this.emit(playFrames(sample, this.cursor, target))
      this.cursor = target
      if (target >= sample.endMs) {
        this.ended = true
        this.playing = false
        this.sendStatus(null)
      }
    }
    if (now - this.lastStatus >= STATUS_MS) this.sendStatus(null)
    this.timer = setTimeout(this.tick, TICK_MS)
  }

  private seek(t: number): void {
    const sample = this.sample as Sample
    const ms = Math.min(sample.endMs, Math.max(0, (t - sample.status.t0) * 1000))
    this.sendStatus('seeking')
    this.ended = false
    this.cursor = ms
    this.emit(seekFrames(sample, ms))
  }

  private sendStatus(busy: string | null): void {
    const { status } = this.sample as Sample
    this.lastStatus = performance.now()
    const t = this.ended ? status.t1 : status.t0 + Math.max(this.cursor, 0) / 1000
    this.emit([JSON.stringify({ ...status, t, speed: this.speed, playing: this.playing, ended: this.ended, busy })])
  }

  private emit(frames: SampleFrame[]): void {
    // a frame's handler may close this socket
    for (const data of frames) if (this.readyState === 1) this.onmessage?.({ data } as MessageEvent)
  }
}
