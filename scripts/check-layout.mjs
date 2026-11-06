// Checks the page layout in a real browser, on the built page (dist/) playing the sample recording: the header keeps its height whatever
// it says, from xl the page does not scroll and the replay row and timeline stay on screen, every stage tab is in view, and each
// workspace's note shows once. It uses the Chrome or Chromium on this PC (playwright-core downloads no browser).
//
//   npm run build && npm run check:layout        (CHROME_PATH=/path/to/chrome to choose a browser)
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
if (!existsSync(join(dist, 'index.html'))) {
  console.error('check-layout: no dist/, run npm run build first')
  process.exit(1)
}
const chromePath = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
  (p) => p && existsSync(p)
)
if (!chromePath) {
  console.error('check-layout: no Chrome or Chromium found; set CHROME_PATH')
  process.exit(1)
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.gz': 'application/gzip' }
const server = createServer((req, res) => {
  const file = normalize(join(dist, decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/\/$/, '/index.html')))
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/?demo=1`

let failed = 0
let passed = 0
function check(ok, what) {
  if (ok) passed++
  else {
    failed++
    console.error('FAIL: ' + what)
  }
}

const SEEN_ALL = { intros: ['run', 'analyze', 'review'] }
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
})

/** A page at a size with the tour seen and, unless `prefs` is given, every workspace note dismissed. */
async function open(width, height, prefs = SEEN_ALL) {
  const page = await browser.newPage({ viewport: { width, height } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(
    ([p]) => {
      try {
        if (!localStorage.getItem('roco.tour.v1')) localStorage.setItem('roco.tour.v1', '1')
        if (p !== null && !localStorage.getItem('roco.ui.v1')) localStorage.setItem('roco.ui.v1', JSON.stringify(p))
      } catch {}
    },
    [prefs]
  )
  await page.goto(url)
  await page.waitForSelector('section[aria-labelledby=replay-heading]', { timeout: 15000 })
  await page.waitForTimeout(600)
  page.errors = errors
  return page
}
const tab = async (page, name) => {
  await page.getByRole('tab', { name }).click()
  await page.waitForTimeout(500)
}
const measure = (page) =>
  page.evaluate(() => {
    const box = (e) => {
      if (!e) return null
      const b = e.getBoundingClientRect()
      return { top: b.top, bottom: b.bottom, height: b.height }
    }
    const main = document.querySelector('main')
    return {
      vh: innerHeight,
      header: box(document.querySelector('header')),
      nav: box(document.querySelector('[role=tablist]')?.parentElement),
      panel: box(document.getElementById('workspace-panel')),
      replay: box(document.querySelector('section[aria-labelledby=replay-heading]')),
      timeline: box(document.querySelector('section[aria-labelledby=timeline-heading]')),
      overflow: main.scrollHeight - main.clientHeight,
      hscroll: document.documentElement.scrollWidth > innerWidth,
    }
  })

try {
  // 1. From xl: the page does not scroll, the dock is on screen below the workspace, the header and nav keep their size.
  for (const [w, h, cockpit] of [
    [1920, 1080, 600],
    [1600, 900, 420],
    [1366, 768, 340],
    [1280, 800, 370],
  ]) {
    const page = await open(w, h)
    for (const ws of ['Run', 'Analyze', 'Review']) {
      await tab(page, ws)
      const m = await measure(page)
      const at = `${w}x${h} ${ws}`
      check(Math.round(m.header.height) === 65, `${at}: header is 65 px (${m.header.height})`)
      check(Math.round(m.nav.height) === 57, `${at}: workspace bar is 57 px (${m.nav.height})`)
      check(m.overflow <= 0, `${at}: the page does not scroll (${m.overflow} px over)`)
      check(!m.hscroll, `${at}: no sideways scroll`)
      check(m.panel.height >= cockpit, `${at}: the workspace is at least ${cockpit} px tall (${Math.round(m.panel.height)})`)
      check(m.replay.top >= m.panel.bottom - 1 && m.timeline.top >= m.replay.bottom - 1, `${at}: workspace, replay row, timeline in that order`)
      check(m.timeline.bottom <= m.vh + 0.5, `${at}: the timeline is on screen (bottom ${Math.round(m.timeline.bottom)} of ${m.vh})`)
      check(m.replay.height <= 60, `${at}: the replay controls are one row (${Math.round(m.replay.height)} px)`)
    }
    check(page.errors.length === 0, `${w}x${h}: no page errors (${page.errors[0] ?? ''})`)
    await page.close()
  }

  // 2. Below xl: one scroll, the replay row sticks to the bottom edge, header and bar keep their size down to 640.
  for (const [w, h] of [
    [1024, 768],
    [768, 900],
    [640, 900],
    [390, 844],
  ]) {
    const page = await open(w, h)
    for (const ws of ['Run', 'Review']) {
      await tab(page, ws)
      const at = `${w}x${h} ${ws}`
      let m = await measure(page)
      if (w >= 640) {
        check(Math.round(m.header.height) === 65, `${at}: header is 65 px (${m.header.height})`)
        check(Math.round(m.nav.height) === 57, `${at}: workspace bar is 57 px (${m.nav.height})`)
      }
      check(!m.hscroll, `${at}: no sideways scroll`)
      check(m.replay.bottom <= m.vh + 0.5 && m.replay.top >= 0, `${at}: the replay row is on screen at the top of the page`)
      // Stuck to the bottom edge it must touch it. The sticky offset once left a 12 px gap there (a replay row in its own place is far above the edge).
      check(!(m.vh - m.replay.bottom > 1 && m.vh - m.replay.bottom < 16), `${at}: no gap between the replay row and the bottom edge (${Math.round(m.vh - m.replay.bottom)} px)`)
      await page.evaluate(() => document.querySelector('main').scrollTo(0, 99999))
      await page.waitForTimeout(200)
      m = await measure(page)
      check(m.replay.bottom <= m.vh + 0.5 && m.replay.top >= 0, `${at}: the replay row is on screen at the end of the page`)
      check(m.timeline.bottom <= m.vh + 0.5, `${at}: the end of the page shows the whole timeline`)
    }
    await page.close()
  }

  // 3. B10: the header and the workspace do not move while the recording plays (fastest speed, so the whole recording goes by).
  {
    const page = await open(1280, 800)
    const speed = page.getByRole('combobox', { name: 'Speed' })
    await speed.selectOption(await speed.evaluate((el) => el.options[el.options.length - 1].value))
    const play = page.getByRole('button', { name: /^Play/ })
    if (await play.count()) await play.first().click()
    const seen = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const tops = new Set()
          const sample = () => {
            const h = document.querySelector('header').getBoundingClientRect()
            const p = document.getElementById('workspace-panel').getBoundingClientRect()
            tops.add(`${Math.round(h.height)}/${Math.round(p.top)}/${Math.round(p.height)}`)
          }
          const timer = setInterval(sample, 100)
          setTimeout(() => {
            clearInterval(timer)
            resolve([...tops])
          }, 18000)
        })
    )
    check(seen.length === 1, `while playing, the header and workspace keep one size and place (saw ${seen.join(', ')})`)
    await page.close()
  }

  // 4. The worst the header can say, injected into the page: it stays one row and the bar stays one row.
  for (const [w, h] of [
    [1600, 900],
    [1280, 800],
    [1024, 768],
    [768, 900],
    [640, 900],
  ]) {
    const page = await open(w, h)
    await page.evaluate(() => {
      const group = document.querySelector('[role=group][aria-label="Robot state and alert status"]')
      const [stateChip, alertButton] = group.children
      stateChip.children[1].textContent = 'Standing_Transition_With_A_Very_Long_Name'
      const late = document.createElement('span')
      late.className = 'text-xs text-warn-ink'
      late.textContent = 'may be out of date'
      stateChip.append(late)
      alertButton.lastElementChild.textContent =
        '2 critical · 1 abort check tripped · 1 guided-check limit crossed · 3 warnings first: Left ankle motor current above its limit (after Passive, 4 shelved)'
      const rates = group.nextElementSibling
      rates.classList.remove('max-lg:hidden')
      rates.lastElementChild.textContent = 'state 1054 Hz · cmd 925 Hz LOST'
      // A real pack reports volts and percent: the chip then holds the long text from md and the percent below it.
      for (const chip of document.querySelectorAll('[aria-label^="Battery"]')) {
        for (const el of [...chip.querySelectorAll('span')]) el.remove()
        for (const [cls, text] of [['max-md:hidden', '52.0 V (100%)'], ['md:hidden', '100%']]) {
          const span = document.createElement('span')
          span.className = cls
          span.textContent = text
          chip.append(span)
        }
      }
    })
    await page.waitForTimeout(200)
    const m = await measure(page)
    const at = `worst-case text at ${w}`
    check(Math.round(m.header.height) === 65, `${at}: header is 65 px (${m.header.height})`)
    check(Math.round(m.nav.height) === 57, `${at}: workspace bar is 57 px (${m.nav.height})`)
    check(!m.hscroll, `${at}: no sideways scroll`)
    await page.close()
  }

  // 5. Every stage tab is in view in the right column of Run, at the top and at the end of its scroll.
  {
    const page = await open(1366, 768)
    await tab(page, 'Run')
    const inView = () =>
      page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label=Stages]')
        const col = nav.closest('.xl\\:overflow-y-auto')
        const n = nav.getBoundingClientRect()
        const c = col.getBoundingClientRect()
        const card = nav.parentElement.getBoundingClientRect()
        // Sticky stops at the edge of its card, so the tabs must be inside the column for as long as the card is showing more than them.
        const cardShows = card.bottom > c.top + n.height + 8 && card.top < c.bottom - n.height
        return { tabs: nav.querySelectorAll('button').length, top: n.top - c.top, bottom: c.bottom - n.bottom, cardShows, scrolls: col.scrollHeight > col.clientHeight }
      })
    let covered = 0
    for (const to of [0, 150, 300, 450, 600, 800, 1200, 99999]) {
      await page.evaluate((y) => document.querySelector('nav[aria-label=Stages]').closest('.xl\\:overflow-y-auto').scrollTo(0, y), to)
      await page.waitForTimeout(120)
      const v = await inView()
      check(v.tabs === 11, `stage tabs, column scrolled to ${to}: all 11 exist (${v.tabs})`)
      if (v.cardShows) {
        covered++
        check(v.top >= -1 && v.bottom >= -1, `stage tabs, column scrolled to ${to}: inside the column (${Math.round(v.top)} below its top, ${Math.round(v.bottom)} above its bottom)`)
      }
    }
    check(covered >= 4, `stage tabs: checked at ${covered} scroll positions with the card showing`)
    await page.close()
  }

  // 6. The workspace notes: shown once per workspace, kept after a reload, back when the saved value is damaged.
  {
    const page = await open(1366, 768, null)
    const note = () => page.locator('[role=note]:has(button[aria-label^="Dismiss the note about"])')
    const noteText = async () => ((await note().count()) ? await note().innerText() : null)
    await tab(page, 'Run')
    check((await noteText())?.includes('what to watch during a test'), 'first visit to Run: the note shows')
    await page.getByRole('button', { name: 'Dismiss the note about Run' }).click()
    await page.waitForTimeout(200)
    check((await noteText()) === null, 'dismissed: the note is gone')
    check((await page.evaluate(() => document.activeElement?.id)) === 'workspace-panel', 'dismissed: focus goes to the workspace')
    await page.reload()
    await page.waitForSelector('section[aria-labelledby=replay-heading]')
    check((await noteText()) === null, 'after a reload the Run note stays gone')
    await tab(page, 'Analyze')
    check((await noteText())?.includes('Plots and the full joint table'), 'first visit to Analyze: its own note shows')
    await tab(page, 'Review')
    await tab(page, 'Analyze')
    check((await noteText()) === null, 'leaving Analyze counted as seen: no note when back')
    await page.close()

    const bad = await open(1366, 768, null)
    await bad.evaluate(() => localStorage.setItem('roco.ui.v1', '{not json'))
    await bad.reload()
    await bad.waitForSelector('section[aria-labelledby=replay-heading]')
    check((await bad.locator('[role=note]:has(button[aria-label^="Dismiss the note about"])').count()) === 1, 'a damaged saved value: the note shows again and the page works')
    await bad.close()
  }

  // 7. Larger text (reported, not a pass mark: the page may scroll here, that is its safety net).
  {
    const page = await open(1366, 768, { ...SEEN_ALL, textScale: 130 })
    const m = await measure(page)
    console.log(`check-layout: text at 130 % on 1366x768: header ${Math.round(m.header.height)} px, workspace ${Math.round(m.panel.height)} px, page scrolls ${Math.max(0, Math.round(m.overflow))} px`)
    check(!m.hscroll, 'text at 130 %: no sideways scroll')
    await page.close()
  }
} finally {
  await browser.close()
  server.close()
}

console.log(`check-layout: ${passed} checks passed`)
if (failed > 0) {
  console.error(`check-layout: ${failed} FAILED`)
  process.exit(1)
}
