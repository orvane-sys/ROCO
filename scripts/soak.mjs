#!/usr/bin/env node
// Long run, started by hand, not in CI: plays the sample recording over and over in Chrome and writes down what the page costs,
// so a slow leak or a slowing 3D view shows up as a trend instead of as a complaint after a long test.
//   npm run build && node scripts/soak.mjs [--minutes 120] [--every 5] [--out soak.csv] [--size 960x540]
// The 3D view is drawn in software here (headless Chrome has no GPU), which costs a lot of CPU in proportion to its pixels. The small
// default size keeps a laptop cool; to keep it quieter still, run it as: nice -n 19 taskset -c 0,1 npm run soak
// Every --every minutes it reports the JS heap after a forced garbage collection, the 3D view's frames a second (the number the page
// shows itself), the number of elements in the page, and the timeline's own count of alerts and marks.
// Pass: after the first 10 minutes the heap stays within +-20 % of its middle value and the frame rate of the last quarter is not
// below 80 % of the first quarter's. Exit code 1 when it does not hold.
import { writeFileSync } from 'node:fs'
import { guardCsp, startBrowser } from './lib-browser.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const minutes = Number(arg('minutes', 120))
const everyMin = Number(arg('every', 5))
const out = arg('out', 'soak.csv')
const [width, height] = arg('size', '960x540').split('x').map(Number)
const warmupMin = Math.min(10, minutes / 4)

const { url, browser, close } = await startBrowser('soak')
const context = await browser.newContext({ viewport: { width, height } })
await guardCsp(context)
await context.addInitScript(() => {
  try {
    localStorage.setItem('roco.tour.v1', '1')
  } catch {
    /* storage blocked */
  }
})
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
await cdp.send('Performance.enable')
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

await page.goto(url)
await page.getByText('Loading robot model…').waitFor({ state: 'detached', timeout: 120000 }).catch(() => {})

async function sample(minute) {
  await cdp.send('HeapProfiler.collectGarbage')
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  const info = await page.evaluate(() => {
    const text = document.body.innerText
    const fps = /(\d+)\s*fps/.exec(text)
    const timeline = /(\d+)\s+alerts?\s+·\s+(\d+)\s+marks?/.exec(text)
    return { fps: fps ? Number(fps[1]) : null, nodes: document.getElementsByTagName('*').length, alerts: timeline ? Number(timeline[1]) : null, marks: timeline ? Number(timeline[2]) : null }
  })
  return { minute, heapMB: metrics.JSHeapUsedSize / 1048576, ...info }
}

// keep the recording playing: when it ends, play it again
const again = setInterval(async () => {
  const b = page.getByRole('button', { name: 'Play again' })
  if (await b.isVisible().catch(() => false)) await b.click().catch(() => {})
}, 2000)

const rows = []
const t0 = Date.now()
console.log(`soak: ${minutes} min, a sample every ${everyMin} min, writing ${out}`)
for (let m = 0; m <= minutes; m += everyMin) {
  const wait = t0 + m * 60_000 - Date.now()
  if (wait > 0) await page.waitForTimeout(wait)
  const r = await sample(m)
  rows.push(r)
  console.log(`  ${String(m).padStart(4)} min  heap ${r.heapMB.toFixed(1).padStart(6)} MB  ${String(r.fps ?? '?').padStart(3)} fps  ${r.nodes} elements  ${r.alerts ?? '?'} alerts  ${r.marks ?? '?'} marks`)
}
clearInterval(again)
writeFileSync(out, 'minute,heap_mb,fps,elements,alerts,marks\n' + rows.map((r) => [r.minute, r.heapMB.toFixed(2), r.fps ?? '', r.nodes, r.alerts ?? '', r.marks ?? ''].join(',')).join('\n') + '\n')
await close()

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const after = rows.filter((r) => r.minute >= warmupMin)
let failed = 0
if (after.length >= 3) {
  const mid = median(after.map((r) => r.heapMB))
  const drift = Math.max(...after.map((r) => Math.abs(r.heapMB - mid) / mid))
  const ok = drift <= 0.2
  console.log(`heap after minute ${warmupMin}: middle ${mid.toFixed(1)} MB, furthest sample ${(drift * 100).toFixed(0)} % away: ${ok ? 'flat' : 'NOT FLAT'}`)
  if (!ok) failed++
  const fps = rows.map((r) => r.fps).filter((v) => v !== null && v > 0)
  if (fps.length >= 4) {
    const q = Math.floor(fps.length / 4)
    const first = median(fps.slice(0, q))
    const last = median(fps.slice(-q))
    const ok2 = last >= first * 0.8
    console.log(`3D frame rate: first quarter ${first} fps, last quarter ${last} fps: ${ok2 ? 'held' : 'DROPPED'}`)
    if (!ok2) failed++
  }
} else console.log('too short a run to judge (needs three samples after the warm-up)')
if (errors.length) {
  console.log(`${errors.length} console errors, the first: ${errors[0]}`)
  failed++
}
process.exit(failed ? 1 : 0)
