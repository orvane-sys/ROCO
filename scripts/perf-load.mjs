#!/usr/bin/env node
// Cold-load report for the built page (dist/): requests, bytes on the wire, the biggest files, and the time until the 3D view
// has its robot. Not a pass/fail check, the numbers depend on the PC; it prints them so a change can be compared before and after.
//   npm run build && node scripts/perf-load.mjs [runs]
// Chrome runs with the cache off and software GL, so the time to the robot is only good for comparing two builds on one PC.
import { guardCsp, startBrowser } from './lib-browser.mjs'

const runs = Math.max(1, Number(process.argv[2]) || 3)
const { url, browser, close } = await startBrowser('perf-load')

const kb = (n) => (n / 1024).toFixed(0).padStart(7) + ' kB'
const results = []
for (let i = 0; i < runs; i++) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } })
  await guardCsp(context)
  await context.addInitScript(() => {
    try {
      localStorage.setItem('roco.tour.v1', '1')
    } catch {
      /* storage blocked */
    }
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  const files = new Map()
  cdp.on('Network.responseReceived', (e) => files.set(e.requestId, { url: e.response.url, bytes: 0 }))
  cdp.on('Network.loadingFinished', (e) => {
    const f = files.get(e.requestId)
    if (f) f.bytes = e.encodedDataLength
  })
  const t0 = Date.now()
  await page.goto(url, { waitUntil: 'load' })
  const tLoad = Date.now() - t0
  // the robot is in when the "Loading robot model…" overlay has appeared and gone again
  const overlay = page.getByText('Loading robot model…')
  await overlay.waitFor({ state: 'attached', timeout: 30000 }).catch(() => {})
  await overlay.waitFor({ state: 'detached', timeout: 120000 }).catch(() => {})
  const tRobot = Date.now() - t0
  await page.waitForTimeout(500)
  const list = [...files.values()]
  const total = list.reduce((s, f) => s + f.bytes, 0)
  const by = (re) => list.filter((f) => re.test(new URL(f.url).pathname))
  const sum = (a) => a.reduce((s, f) => s + f.bytes, 0)
  results.push({ tLoad, tRobot, total, count: list.length, list, js: sum(by(/\.js$/)), models: sum(by(/\/models\//)), demo: sum(by(/\/demo\//)), errors })
  await context.close()
}
await close()

results.sort((a, b) => a.tRobot - b.tRobot)
const mid = results[Math.floor(results.length / 2)]
console.log(`cold load, median of ${runs} (cache off, 1366x768):`)
console.log(`  requests        ${String(mid.count).padStart(7)}`)
console.log(`  transferred     ${kb(mid.total)}`)
console.log(`    scripts       ${kb(mid.js)}`)
console.log(`    robot models  ${kb(mid.models)}`)
console.log(`    sample        ${kb(mid.demo)}`)
console.log(`  load event      ${String(mid.tLoad).padStart(7)} ms`)
console.log(`  robot on screen ${String(mid.tRobot).padStart(7)} ms`)
const errs = results.flatMap((r) => r.errors)
console.log(`  page errors     ${String(errs.length).padStart(7)}${errs.length ? `   the first: ${errs[0]}` : ''} (all runs; includes CSP violations)`)
console.log('  biggest files:')
for (const f of [...mid.list].sort((a, b) => b.bytes - a.bytes).slice(0, 8)) console.log(`   ${kb(f.bytes)}  ${new URL(f.url).pathname}`)
