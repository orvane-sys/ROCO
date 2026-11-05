// Checks the sample recording the hosted page plays (public/demo/, made by scripts/capture_demo.py) through the page's own player,
// src/services/recordedBridge.ts: it is small, it says nothing about the PC it was made on, and a jump shows what playing there shows.
// The reports are compared by check-regress-report.mjs, the test the real bridge passes in regress.py R4.
//
//   node scripts/check-demo.mjs [file] [--times 15,30,45]      (times in seconds into the recording)
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { rolldown } from 'rolldown'

const root = fileURLToPath(new URL('..', import.meta.url))
const MAX_BYTES = 3 * 1024 * 1024
const STEP_MS = 20

const args = process.argv.slice(2)
const flag = args.indexOf('--times')
const times = (flag >= 0 ? args.splice(flag, 2)[1] : '15,30,45').split(',').map(Number)
const file = args[0] ?? join(root, 'public/demo/g1-sample.rocodemo.gz')

let failed = 0
let passed = 0
function check(ok, what) {
  if (ok) passed++
  else {
    failed++
    console.error('FAIL: ' + what)
  }
}

const b = await rolldown({ input: join(root, 'src/services/recordedBridge.ts'), logLevel: 'silent' })
const { output } = await b.generate({ format: 'esm' })
await b.close()
const { parseSample, playFrames, seekFrames, RecordedBridgeSocket } = await import('data:text/javascript;base64,' + Buffer.from(output[0].code).toString('base64'))

const packed = readFileSync(file)
const raw = gunzipSync(packed)
const sample = parseSample(raw)
const text = (frames) => frames.filter((f) => typeof f === 'string')
const allText = [...text(sample.greeting), ...text(sample.snapshots.flat()), ...sample.play.flatMap((r) => r.text ?? []), JSON.stringify(sample.status)]

check(statSync(file).size <= MAX_BYTES, `the file is at most 3 MB (${(statSync(file).size / 1e6).toFixed(2)} MB)`)
for (const p of ['/home/', '/Users/', '/root/', '/tmp/', 'C:\\\\']) check(!allText.some((s) => s.includes(p)), `no text in the file holds ${p}`)

const hello = JSON.parse(sample.greeting[0])
check(hello.type === 'hello' && hello.source === 'replay' && hello.readOnly === true, 'it starts with a read-only replay hello')
check(hello.demo?.title && /^\d{4}-\d\d-\d\d$/.test(hello.demo.recorded ?? ''), 'the hello says what it is and when it was recorded')
check(sample.play.every((r, i) => i === 0 || r.ms >= sample.play[i - 1].ms), 'the play records are in time order')
const seconds = Math.floor(sample.endMs / 1000)
check(sample.snapshots.length >= seconds && [...sample.snapshots].every((s) => s?.some((f) => typeof f !== 'string')), `every whole second has a snapshot with a robot frame (${sample.snapshots.length})`)

/** The frames a page gets by playing to ms, in the bridge's steps of data time. */
function played(ms, step) {
  const out = []
  for (let t = -1; t < ms; ) {
    const next = Math.min(ms, Math.max(t, 0) + step)
    out.push(...playFrames(sample, t, next))
    t = next
  }
  return out
}
const opened = (r) => JSON.parse(r).alertEvents?.length
const alertFrames = sample.play.filter((r) => r.alert).length
check(alertFrames > 0 && text(played(sample.endMs, 8 * STEP_MS)).filter((f) => f.startsWith('{"type":"aux"') && opened(f)).length === alertFrames, `8x speed keeps every alert frame (${alertFrames})`)

const tmp = mkdtempSync(join(tmpdir(), 'roco_demo_'))
const write = (name, lines) => {
  const p = join(tmp, name)
  writeFileSync(p, lines.join('\n') + '\n')
  return p
}
try {
  for (const sec of times) {
    const ms = sec * 1000
    const t = sample.status.t0 + sec
    const status = (extra) => JSON.stringify({ ...sample.status, t, ...extra })
    const start = [...text(sample.greeting), JSON.stringify(sample.status)]
    const seek = write('seek.jsonl', [...start, JSON.stringify({ seek: t }), ...text(seekFrames(sample, ms)), status()])
    for (const speed of [1, 8]) {
      const play = write('play.jsonl', [...start, ...text(played(ms, speed * STEP_MS)), status()])
      const r = spawnSync(process.execPath, [join(root, 'scripts/check-regress-report.mjs'), play, seek], { encoding: 'utf8' })
      check(r.status === 0, `the report at ${sec} s after a jump equals ${speed}x play:\n${r.stdout}${r.stderr}`)
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// The socket itself, as telemetryStream drives it
const wait = (ready, what) =>
  new Promise((resolve) => {
    const end = Date.now() + 5000
    const poll = () => {
      if (ready()) resolve(true)
      else if (Date.now() > end) {
        check(false, what)
        resolve(false)
      } else setTimeout(poll, 5)
    }
    poll()
  })
const open = (body, status = 200) => {
  globalThis.fetch = async () => new Response(body, { status })
  const s = new RecordedBridgeSocket('sample')
  const seen = { frames: [], status: null, opened: false, failed: 0, closed: 0 }
  s.onopen = () => (seen.opened = true)
  s.onerror = () => seen.failed++
  s.onclose = () => seen.closed++
  s.onmessage = ({ data }) => {
    seen.frames.push(data)
    if (typeof data === 'string' && data.startsWith('{"type":"replay"')) seen.status = JSON.parse(data)
  }
  return { s, seen, send: (action, value) => s.send(JSON.stringify({ type: 'replay_control', action, value })) }
}

const live = open(packed)
await wait(() => live.seen.status?.playing, 'the sample starts playing by itself')
check(live.seen.opened && live.s.readyState === 1, 'the socket opens')
check(live.seen.frames.some((f) => f instanceof ArrayBuffer && f.byteLength === 2092), 'robot frames are 2092-byte ArrayBuffers')
live.send('pause')
check(live.seen.status.playing === false, 'pause stops it')
live.seen.frames.length = 0
live.send('seek', sample.status.t0 + 10.5)
check(Math.abs(live.seen.status.t - sample.status.t0 - 10.5) < 1e-6 && !live.seen.status.busy, 'a seek lands on its moment')
check(text(live.seen.frames).some((f) => f.startsWith('{"type":"fsm"') && JSON.parse(f).full), 'a seek sends a full fsm frame')
live.send('speed', 3)
check(live.seen.status.speed === 1, 'a speed the bridge does not offer is refused')
live.send('speed', 8)
live.send('seek', sample.status.t1 - 0.2)
live.send('play')
await wait(() => live.seen.status?.ended, 'playing to the end stops there')
check(live.seen.status.t === sample.status.t1 && !live.seen.status.playing, 'the end is the last moment, not playing')
live.send('play')
check(live.seen.status.playing && live.seen.status.t === sample.status.t0, 'play at the end starts over')
live.s.close()
check(live.seen.closed === 1 && live.s.readyState === 3, 'close closes once')
live.seen.frames.length = 0
await new Promise((r) => setTimeout(r, 60))
check(live.seen.frames.length === 0, 'nothing is sent after close')

const unpacked = open(raw)
await wait(() => unpacked.seen.opened, 'a file the host already unpacked plays too')
unpacked.s.close()

const missing = open('not found', 404)
await wait(() => missing.seen.failed, 'a missing file reports an error')
check(missing.seen.closed === 1 && !missing.seen.opened, 'a missing file closes without opening')

console.log(`demo: ${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
