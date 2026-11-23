// Checks the page layout in a real browser, on the built page (dist/) playing the sample recording: the header keeps its height whatever
// it says, from xl the page does not scroll and the replay row and timeline stay on screen, every stage tab is in view, and each
// workspace's note shows once, and every palette command has a visible control. It uses the Chrome or Chromium on this PC (playwright-core downloads no browser).
//
//   npm run build && npm run check:layout        (CHROME_PATH=/path/to/chrome to choose a browser)
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { rolldown } from 'rolldown'
import { PAGE_READY_MS, REPORT_XACRO, guardCsp, openImportReport, startBrowser, tally } from './lib-browser.mjs'

const { url, browser, close } = await startBrowser('check-layout')
const { check, finish } = tally()

const SEEN_ALL = { intros: ['run', 'analyze', 'review'] }
/** A page at a size with the tour seen and, unless `prefs` is given, every workspace note dismissed. */
async function open(width, height, prefs = SEEN_ALL) {
  const page = await browser.newPage({ viewport: { width, height } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await guardCsp(page)
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
  await page.waitForSelector('section[aria-labelledby=replay-heading]', { timeout: PAGE_READY_MS })
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
    // the sample names its checklist: it opens on the simulator rehearsal; the real checklist, with the most tabs, is the one to fit
    const procedure = page.getByLabel('Procedure', { exact: true })
    check((await procedure.inputValue()) === 'g1_type6_sim' && (await inView()).tabs === 2, `the sample opens on the simulator checklist (${await procedure.inputValue()})`)
    await procedure.selectOption('g1_type6')
    await page.waitForTimeout(150)
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
    await page.waitForSelector('section[aria-labelledby=replay-heading]', { timeout: PAGE_READY_MS })
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
    await bad.waitForSelector('section[aria-labelledby=replay-heading]', { timeout: PAGE_READY_MS })
    check((await bad.locator('[role=note]:has(button[aria-label^="Dismiss the note about"])').count()) === 1, 'a damaged saved value: the note shows again and the page works')
    await bad.close()
  }

  // 6b. A jump while paused shows the target of the new moment: the joint table's target column after a jump to a moment is the same
  // whichever moment the jump came from (it once kept the old target, because the page did not draw the frame that carries it).
  {
    const page = await open(1600, 900)
    await tab(page, 'Analyze')
    const play = page.locator('section[aria-labelledby=replay-heading] button').first()
    if ((await play.textContent())?.includes('Pause')) await play.click()
    const slider = page.getByRole('slider', { name: 'Recording position, seconds' })
    const targetsAt = async (t) => {
      await slider.fill(String(t))
      await slider.press('Shift')
      await page.waitForFunction(() => !document.querySelector('section[aria-labelledby=replay-heading] [aria-live]')?.textContent?.includes('Seeking'))
      await page.waitForTimeout(700)
      return page.evaluate(() =>
        [...document.querySelectorAll('table tbody tr')].map((tr) => tr.querySelectorAll('td')[1]?.textContent ?? '').join('|')
      )
    }
    const first = await targetsAt(10)
    const mid = await targetsAt(25)
    const late = await targetsAt(40)
    const back = await targetsAt(10)
    check(first.length > 0 && (first !== mid || first !== late), 'the target column changes between 10, 25 and 40 s (so the next check means something)')
    check(back === first, 'paused: the target at 10 s is the same after a jump from 40 s as after a jump from the start')
    check(page.errors.length === 0, `no page errors during the jumps (${page.errors.join('; ')})`)
    await page.close()
  }

  // 6c. The 3D view's badge while paused (its longest text): the replay position is shown whole and inside the badge, at the widths
  // the operator test uses (it once ran past the badge's edge at 1440 px).
  for (const [w, h] of [[1440, 900], [1366, 768]]) {
    const page = await open(w, h)
    const play = page.locator('section[aria-labelledby=replay-heading] button').first()
    if ((await play.textContent())?.includes('Pause')) await play.click()
    await page.waitForFunction(() => /paused at/i.test(document.querySelector('section[aria-label="Unitree G1 digital twin"]')?.textContent ?? ''))
    const fit = await page.evaluate(() => {
      const label = [...document.querySelectorAll('section[aria-label="Unitree G1 digital twin"] span')].find((s) => s.children.length === 0 && /paused at/i.test(s.textContent ?? ''))
      if (!label) return null
      const badge = label.parentElement.getBoundingClientRect()
      return { whole: label.scrollWidth <= label.clientWidth, inside: label.getBoundingClientRect().right <= badge.right + 0.5, text: label.textContent }
    })
    check(fit !== null && fit.whole && fit.inside, `${w}x${h}: the paused replay position is whole and inside the 3D view's badge (${JSON.stringify(fit)})`)
    await page.close()
  }

  // 7a. Phones: every button in the bar is on screen (none cut off at the edge), the header is short, and the tone, voice and battery
  // menu works: opens, switches, closes on Escape (focus back on its button), on a click outside, and when Tab leaves it.
  for (const [w, h] of [
    [320, 700],
    [390, 844],
  ]) {
    const page = await open(w, h)
    const at = `${w}x${h}`
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll('nav[aria-label="Workspaces and settings"] button')]
        .filter((b) => b.getClientRects().length > 0)
        .map((b) => {
          const r = b.getBoundingClientRect()
          return { name: b.getAttribute('aria-label') ?? b.textContent, left: r.left, right: r.right }
        })
    )
    check(buttons.length >= 7, `${at}: the bar shows its buttons (${buttons.length})`)
    for (const b of buttons) check(b.left >= 0 && b.right <= w + 0.5, `${at}: "${b.name}" is on screen (${Math.round(b.left)} to ${Math.round(b.right)} of ${w})`)
    const m = await measure(page)
    check(m.header.height <= 120, `${at}: the header is at most 120 px (${Math.round(m.header.height)})`)

    const trigger = page.getByRole('button', { name: /^Sound, speech and battery/ })
    check((await trigger.count()) === 1, `${at}: one menu button for tone, voice and battery`)
    check((await page.getByRole('button', { name: /^Alert sound (on|off)/ }).count()) === 0, `${at}: the switches are not in the bar while the menu is shut`)
    await trigger.click()
    check((await trigger.getAttribute('aria-expanded')) === 'true', `${at}: the menu opens`)
    const tone = page.getByRole('button', { name: /^Alert sound (on|off)/ })
    check((await tone.count()) === 1 && (await page.getByRole('button', { name: /^Spoken alerts / }).count()) === 1, `${at}: Tone and Voice are in the menu`)
    check((await page.locator('#tools-menu [aria-label^="Battery"]').count()) === 1, `${at}: the battery is in the menu`)
    const box = await page.locator('#tools-menu').boundingBox()
    check(box !== null && box.x >= 0 && box.x + box.width <= w + 0.5, `${at}: the menu is on screen`)
    const before = await tone.getAttribute('aria-pressed')
    await tone.click()
    check((await page.getByRole('button', { name: /^Alert sound (on|off)/ }).getAttribute('aria-pressed')) !== before, `${at}: Tone switches from the menu`)
    await page.keyboard.press('Escape')
    check((await trigger.getAttribute('aria-expanded')) === 'false', `${at}: Escape closes the menu`)
    check(await trigger.evaluate((el) => el === document.activeElement), `${at}: Escape puts focus back on the menu button`)
    await trigger.click()
    await page.mouse.click(w / 2, h / 2)
    check((await trigger.getAttribute('aria-expanded')) === 'false', `${at}: a click outside closes the menu`)
    await trigger.click()
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab')
    check((await trigger.getAttribute('aria-expanded')) === 'false', `${at}: Tab out of the menu closes it`)
    await page.close()
  }

  // 7. Larger text (reported, not a pass mark: the page may scroll here, that is its safety net).
  {
    const page = await open(1366, 768, { ...SEEN_ALL, textScale: 130 })
    const m = await measure(page)
    console.log(`check-layout: text at 130 % on 1366x768: header ${Math.round(m.header.height)} px, workspace ${Math.round(m.panel.height)} px, page scrolls ${Math.max(0, Math.round(m.overflow))} px`)
    check(!m.hscroll, 'text at 130 %: no sideways scroll')
    await page.close()
  }

  // 8. Every palette command has a control on screen (src/config/actions.ts says where): visible on its workspace, or in its dialog.
  {
    const src = readFileSync(new URL('../src/config/actions.ts', import.meta.url), 'utf8')
    const actions = [...src.matchAll(/\{ id: '([a-z0-9-]+)'.*?place: '([a-z-]+)'/g)].map((m) => ({ id: m[1], place: m[2] }))
    const page = await open(1600, 900)
    const visible = (id) => page.locator(`[data-action="${id}"]`).evaluateAll((els) => els.some((e) => e.checkVisibility() && e.getBoundingClientRect().width > 0))
    const onPage = { header: 'Run', run: 'Run', analyze: 'Analyze', review: 'Review', dock: 'Run', replay: 'Run' }
    for (const ws of ['Run', 'Analyze', 'Review']) {
      await tab(page, ws)
      for (const a of actions.filter((x) => onPage[x.place] === ws)) check(await visible(a.id), `1600x900 ${ws}: the "${a.id}" control is visible`)
    }
    const dialogs = [
      ['display', /^Display settings/],
      ['settings', /^Settings/],
      ['help', /^Help/],
    ]
    for (const [place, name] of dialogs) {
      await page.getByRole('button', { name }).first().click()
      await page.waitForTimeout(300)
      for (const a of actions.filter((x) => x.place === place)) check(await visible(a.id), `1600x900 ${place} dialog: the "${a.id}" control is visible`)
      if (place === 'help') {
        const rows = await page.locator('[role=dialog] tbody tr').count()
        check(rows === actions.length, `the Help sheet lists every action (${rows} of ${actions.length})`)
      }
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    }
    check(await visible('tour'), 'the sample banner has a Take the tour button')
    await page.keyboard.press('Control+k')
    await page.waitForTimeout(200)
    await page.keyboard.type('freeze')
    const where = await page.locator('[role=option]').first().textContent()
    check(/On screen: Analyze/.test(where ?? ''), `the palette says where a command is on screen (${where})`)
    await page.keyboard.press('Escape')
    check(page.errors.length === 0, `actions: no page errors (${page.errors[0] ?? ''})`)
    await page.close()
  }

  {
    // the Content Security Policy is on and lets the page work: nothing is blocked while the sample plays and the robot's meshes
    // load (WebAssembly), and a script added afterwards does not run and is reported, which shows the guard sees what it blocks
    const page = await open(1366, 768)
    await page.getByText('Loading robot model…').waitFor({ state: 'detached', timeout: PAGE_READY_MS }).catch(() => {})
    await page.waitForTimeout(500)
    const meta = (await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')) ?? ''
    check(/script-src 'self' 'sha256-[A-Za-z0-9+/]+=*' 'wasm-unsafe-eval'/.test(meta) && /object-src 'none'/.test(meta), `CSP: the page has its policy (${meta})`)
    check(page.errors.length === 0, `CSP: the page, its sample and the robot load with nothing blocked (${page.errors[0] ?? ''})`)
    const ran = await page.evaluate(async () => {
      const s = document.createElement('script')
      s.textContent = 'window.__cspProbe = 1'
      document.head.append(s)
      await new Promise((r) => setTimeout(r, 300))
      return window.__cspProbe === 1
    })
    await page.waitForTimeout(200)
    check(!ran && page.errors.length === 1 && /CSP blocked inline \(script-src/.test(page.errors[0]), `CSP: a script added later does not run and is reported (ran: ${ran}; ${page.errors.join('; ')})`)
    await page.close()
  }

  // 9. The import dialog's report and xacro arguments: inside the window at every width, the report downloads as text, and the
  // arguments form imports the same file again with the value typed in.
  for (const [w, h] of [
    [320, 640],
    [390, 844],
    [768, 1024],
    [1366, 768],
  ]) {
    const page = await open(w, h)
    const at = `import dialog ${w}x${h}`
    const removeFile = await openImportReport(page)
    const box = await page.evaluate(() => {
      const d = document.querySelector('[role=dialog]').getBoundingClientRect()
      const out = [...document.querySelectorAll('[role=dialog] *')].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > d.right + 0.5)
      return { inside: d.left >= 0 && d.right <= innerWidth && d.top >= 0 && d.bottom <= innerHeight, hscroll: document.documentElement.scrollWidth > innerWidth, out: out[0] ? `${out[0].tagName}.${String(out[0].className).slice(0, 40)}` : '' }
    })
    check(box.inside && !box.hscroll && !box.out, `${at}: the dialog and all it shows fit the window (${JSON.stringify(box)})`)
    const text = await page.locator('[role=dialog]').innerText()
    check(/Imported report bot \(1 joint\)!/.test(text) && /Problems \(2\)/.test(text) && text.includes("needs the argument 'prefix'") && text.includes('forearm_link_visual_mesh.stl'),
      `${at}: the dialog says it imported, with both problems and where (${text.slice(-400)})`)
    check(/Model check\s+Download report\s+Errors \(1\)/.test(text) && text.indexOf('Model check') < text.indexOf('Import report') && text.includes('Missing files are listed under Problems'),
      `${at}: the model check shows above the report, with its one error and the note that points to Problems (${JSON.stringify(text.slice(0, 300))})`)
    if (w === 1366) {
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download report' }).click()])
      const saved = await download.path()
      const body = saved ? readFileSync(saved, 'utf8') : ''
      check(/^roco_import_report_\d{8}_\d{4}\.txt$/.test(download.suggestedFilename()) && body.startsWith('ROCO import report\nModel: report bot (1 joint)\nMain file: report_bot.xacro\n') &&
        body.includes('xacro arg prefix = (no value)') && body.includes("error: ") && body.includes("needs the argument 'prefix'") &&
        /\nModel check:\nError \(moving-massless\): .+\n  where: arm\n  fix: /.test(body),
        `${at}: Download report saves the report as text (${download.suggestedFilename()}: ${JSON.stringify(body.slice(0, 160))})`)
      await page.getByRole('textbox', { name: /^prefix/ }).fill('p_')
      await page.getByRole('button', { name: 'Import again with these values' }).click()
      await page.waitForFunction(() => {
        const t = document.querySelector('[role=dialog]')?.innerText ?? ''
        return /Problems \(1\)/.test(t) && !t.includes("needs the argument 'prefix'")
      }, null, { timeout: PAGE_READY_MS }).catch(() => {})
      const again = await page.locator('[role=dialog]').innerText()
      check(/Imported report bot \(1 joint\)!/.test(again) && /Problems \(1\)/.test(again) && !again.includes("needs the argument 'prefix'") && (await page.getByRole('textbox', { name: /^prefix/ }).inputValue()) === 'p_',
        `${at}: Import again uses the typed value: the argument problem is gone, the missing mesh stays (${again.slice(-400)})`)
      await page.locator('[role=dialog]').getByRole('button', { name: 'Done', exact: true }).click()
      check((await page.locator('[role=dialog]').count()) === 0, `${at}: Done closes the dialog`)
    }
    check(page.errors.length === 0, `${at}: no page errors (${page.errors[0] ?? ''})`)
    await page.close()
    removeFile()
  }

  // arguments named like Object.prototype's members are needed like any other, the report is not a live region (a screen
  // reader would read all of it at each change), and Import again on a file changed since it was chosen says so in words
  {
    const page = await open(1366, 768)
    const at = 'import dialog, odd names'
    const dir = mkdtempSync(join(tmpdir(), 'roco-dialog-'))
    try {
      const file = join(dir, 'odd_bot.xacro')
      writeFileSync(file, `<?xml version="1.0"?>
<robot name="odd_bot" xmlns:xacro="http://www.ros.org/wiki/xacro">
  <link name="base"/><link name="l$(arg constructor)$(arg toString)"/>
  <joint name="j" type="revolute"><parent link="base"/><child link="l$(arg constructor)$(arg toString)"/>
    <axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint>
</robot>
`)
      await page.locator('[data-action="settings"]').first().click()
      await page.getByRole('button', { name: /Import model/ }).click()
      await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(file)
      const form = page.getByRole('form', { name: 'Xacro arguments' })
      await form.waitFor({ timeout: PAGE_READY_MS })
      const fields = await form.locator('input').evaluateAll((els) => els.map((e) => `${e.id}=${JSON.stringify(e.value)}:${e.getAttribute('aria-invalid')}`))
      const said = await form.innerText()
      check(fields.join(' ') === 'xacro-arg-0="":true xacro-arg-1="":true' && said.includes('2 arguments have no value'),
        `${at}: 'constructor' and 'toString' are both empty and needed (${fields.join(' ')}; ${JSON.stringify(said.slice(0, 120))})`)
      const role = await page.locator('section[aria-label="Import report"]').evaluate((e) => [e.getAttribute('role'), e.getAttribute('aria-live'), e.closest('[aria-live],[role=status],[role=log],[role=alert]') ? 'live' : ''].join('|'))
      check(role === '||', `${at}: the report is not a live region (${role})`)
      writeFileSync(file, '<!-- changed -->\n', { flag: 'a' })
      utimesSync(file, new Date(), new Date(Date.now() + 5000))
      await form.getByRole('button', { name: 'Import again with these values' }).click()
      const dialog = page.locator('[role=dialog]')
      await dialog.getByText(/changed, moved or was deleted/).waitFor({ timeout: PAGE_READY_MS }).catch(() => {})
      const text = await dialog.innerText()
      check(text.includes('A chosen file changed, moved or was deleted after it was chosen, so it could not be read. Choose the files again.') && !/permission problems/.test(text),
        `${at}: Import again on a changed file says so in words (${JSON.stringify(text.slice(-300))})`)
      check(page.errors.length === 0, `${at}: no page errors (${page.errors[0] ?? ''})`)
    } finally {
      await page.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // the first visit does not load the importer: its chunk is fetched only when the import dialog opens. Checked by chunk name
  // and by a word only the MJCF converter has, so a converter merged into another chunk is caught too.
  {
    const at = 'cold load'
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } })
    const errors = []
    const scripts = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('response', (r) => {
      if (r.request().resourceType() === 'script' || /\.m?js(\?|$)/.test(r.url())) scripts.push(r.text().then((body) => ({ url: r.url(), body }), () => ({ url: r.url(), body: '' })))
    })
    await guardCsp(page)
    await page.addInitScript(() => {
      try {
        localStorage.setItem('roco.tour.v1', '1')
      } catch {}
    })
    try {
      await page.goto(url)
      await page.waitForSelector('section[aria-labelledby=replay-heading]', { timeout: PAGE_READY_MS })
      await page.waitForSelector('canvas', { timeout: PAGE_READY_MS })
      await page.waitForTimeout(1500)
      const IMPORTER = /ImportRobotDialog|robotImporter|modelFormatParser|xacro|mjcfConverter|sdfConverter|zipBundle|zipWorker|githubSource/
      const cold = await Promise.all(scripts)
      const coldNames = cold.map((s) => s.url.split('/').pop())
      check(cold.length > 0, `${at}: scripts were seen (${cold.length})`)
      check(!coldNames.some((n) => IMPORTER.test(n)), `${at}: no importer chunk on the first visit (${coldNames.filter((n) => IMPORTER.test(n)).join(', ') || 'none'})`)
      check(!cold.some((s) => s.body.includes('eulerseq')), `${at}: no converter code on the first visit (${cold.filter((s) => s.body.includes('eulerseq')).map((s) => s.url.split('/').pop()).join(', ') || 'none'})`)
      // negative test: opening the dialog does fetch the importer, so the checks above can fail
      await page.locator('[data-action="settings"]').first().click()
      await page.getByRole('button', { name: /Import model/ }).click()
      await page.locator('[role=dialog]').getByRole('button', { name: /Select Model Files/ }).waitFor({ timeout: PAGE_READY_MS })
      await page.waitForTimeout(500)
      const all = await Promise.all(scripts)
      check(all.some((s) => /ImportRobotDialog/.test(s.url)), `${at}: opening Import model… fetches the importer chunk`)
      check(all.some((s) => s.body.includes('eulerseq')), `${at}: opening Import model… brings the converter code`)
      check(errors.length === 0, `${at}: no page errors (${errors[0] ?? ''})`)
    } finally {
      await page.close()
    }
  }

  // files dropped on the 3D view open the import dialog, so its report is seen; a drop that carries no files opens nothing
  {
    const page = await open(1366, 768)
    const at = 'drop'
    const drop = (withFile) =>
      page.evaluate(([text, f]) => {
        const dt = new DataTransfer()
        if (f) dt.items.add(new File([text], 'report_bot.xacro', { type: 'application/xml' }))
        else dt.setData('text/plain', 'not a file')
        const view = document.querySelector('section[aria-label$="digital twin"]')
        view.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
        view.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      }, [REPORT_XACRO, withFile])
    try {
      await drop(false)
      await page.waitForTimeout(1000)
      check((await page.locator('[role=dialog]').count()) === 0, `${at}: a drop with no files opens no dialog`)
      await drop(true)
      const shown = await page.getByRole('heading', { name: 'Import report' }).waitFor({ timeout: PAGE_READY_MS }).then(() => true, () => false)
      check(shown, `${at}: dropped files open the import dialog with its report`)
      check(shown && (await page.getByRole('form', { name: 'Xacro arguments' }).count()) === 1, `${at}: the dropped xacro's arguments form shows`)
      await page.keyboard.press('Escape')
      await page.locator('[role=dialog]').waitFor({ state: 'detached', timeout: PAGE_READY_MS })

      // real folders, dragged in through Chrome's own drag input, so the folder walk runs as it does for a user
      const dir = mkdtempSync(join(tmpdir(), 'roco-drop-'))
      try {
        const folder = join(dir, 'report_bot_description')
        mkdirSync(join(folder, 'urdf'), { recursive: true })
        writeFileSync(join(folder, 'urdf', 'report_bot.xacro'), REPORT_XACRO)
        const empty = join(dir, 'empty_folder')
        mkdirSync(empty)
        const cdp = await page.context().newCDPSession(page)
        const box = await page.locator('section[aria-label$="digital twin"]').boundingBox()
        const dragIn = async (path) => {
          const data = { items: [], files: [path], dragOperationsMask: 1 }
          for (const type of ['dragEnter', 'dragOver', 'drop']) {
            await cdp.send('Input.dispatchDragEvent', { type, x: box.x + box.width / 2, y: box.y + box.height / 2, data })
          }
        }
        const dialogText = (want) =>
          page.locator('[role=dialog]').getByText(want).first().waitFor({ timeout: PAGE_READY_MS }).then(() => page.locator('[role=dialog]').innerText(), () => '(not shown)')
        // the same folder twice, closing in between: each drop is imported, not only the first
        for (const round of ['first', 'second']) {
          await dragIn(folder)
          const got = await dialogText('Imported report bot (1 joint)!')
          check(got.includes('Import report') && got.includes('report_bot_description/urdf/report_bot.xacro'),
            `${at}: a dropped folder (${round} time) is walked and imported with its paths (${JSON.stringify(got.slice(-200))})`)
          await page.keyboard.press('Escape')
          await page.locator('[role=dialog]').waitFor({ state: 'detached', timeout: PAGE_READY_MS })
        }
        await dragIn(empty)
        const got = await dialogText('No files provided for robot import.')
        check(got.includes('No files provided for robot import.'), `${at}: an empty folder opens the dialog, which says it holds no files (${JSON.stringify(got.slice(-200))})`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      check(page.errors.length === 0, `${at}: no page errors (${page.errors[0] ?? ''})`)
    } finally {
      await page.close()
    }
  }

  // a GitHub link (src/utils/githubSource.ts): a shared link only fills the field; Look up and Fetch and import ask the two hosts
  // the CSP allows, answered here by fakes (nothing reaches GitHub); any other host is blocked by the CSP before a request is made
  {
    const at = 'github'
    const SHA = 'c'.repeat(40)
    const STL = 'solid arm\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 0.1 0 0\nvertex 0 0.1 0\nendloop\nendfacet\nendsolid arm\n'
    const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 123456\n'
    // the moving link has no mass, so the model check keeps the dialog open after the import
    const repoFiles = {
      'gh_bot_description/package.xml': '<package><name>gh_bot_description</name></package>',
      'gh_bot_description/urdf/gh_bot.urdf': `<robot name="gh_bot"><link name="base"/>
<joint name="gh_joint" type="revolute"><parent link="base"/><child link="arm"/><axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint>
<link name="arm"><visual><geometry><mesh filename="package://gh_bot_description/meshes/arm.stl"/></geometry></visual></link></robot>`,
      'gh_bot_description/meshes/arm.stl': STL,
    }
    const GH = `gh:acme/bots@${SHA}/gh_bot_description/urdf/gh_bot.urdf`
    let rate = false
    // slowRaw: the mesh answers after 2 s, to see the dialog while it downloads; links: symbolic links (path -> target)
    let slowRaw = false
    let links = {}
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const asked = []
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-RateLimit-Remaining, X-RateLimit-Reset' }
    const fake = async (route) => {
      const u = new URL(route.request().url())
      asked.push(u.href)
      const answer = (status, body, type = 'application/json', extra = {}) => route.fulfill({ status, body, headers: { ...cors, 'content-type': type, ...extra } })
      if (u.host === 'api.github.com') {
        if (rate) return answer(403, '{"message":"API rate limit exceeded"}', 'application/json', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800) })
        if (u.pathname === '/repos/acme/bots/commits/main') return answer(200, SHA, 'application/vnd.github.sha')
        // a branch that takes 2 s to answer, to edit the link while it is looked up
        if (u.pathname === '/repos/acme/bots/commits/slow') return wait(2000).then(() => answer(200, SHA, 'application/vnd.github.sha')).catch(() => {})
        if (u.pathname === `/repos/acme/bots/git/trees/${SHA}` && u.search === '?recursive=1') {
          const dirs = ['gh_bot_description', 'gh_bot_description/urdf', 'gh_bot_description/meshes'].map((path) => ({ path, mode: '040000', type: 'tree', sha: 'e'.repeat(40) }))
          const blobs = Object.entries(repoFiles).map(([path, body]) => ({ path, mode: '100644', type: 'blob', sha: 'f'.repeat(40), size: Buffer.byteLength(body) }))
          const symlinks = Object.entries(links).map(([path, target]) => ({ path, mode: '120000', type: 'blob', sha: 'd'.repeat(40), size: Buffer.byteLength(target) }))
          return answer(200, JSON.stringify({ sha: SHA, tree: [...dirs, ...blobs, ...symlinks], truncated: false }))
        }
        if (u.pathname === '/rate_limit') return answer(200, '{}')
        return answer(404, '{"message":"Not Found"}')
      }
      if (u.host === 'raw.githubusercontent.com') {
        const prefix = `/acme/bots/${SHA}/`
        const at = u.pathname.startsWith(prefix) ? decodeURIComponent(u.pathname.slice(prefix.length)) : ''
        const body = repoFiles[at] ?? links[at]
        if (slowRaw && at.endsWith('.stl')) await wait(2000)
        return (body === undefined ? answer(404, '404: Not Found', 'text/plain') : answer(200, body, 'text/plain')).catch(() => {})
      }
      return route.abort()
    }
    const openWith = async (query, { guard = true, tourSeen = true } = {}) => {
      const page = await browser.newPage({ viewport: { width: 1366, height: 768 } })
      page.errors = []
      page.on('pageerror', (e) => page.errors.push(String(e)))
      if (guard) await guardCsp(page)
      if (tourSeen) await page.addInitScript(() => {
        try {
          localStorage.setItem('roco.tour.v1', '1')
        } catch {}
      })
      await page.route(/^https:\/\//, fake)
      await page.goto(url + query)
      await page.waitForSelector('section[aria-labelledby=replay-heading]', { timeout: PAGE_READY_MS })
      return page
    }
    const dialog = (page) => page.locator('[role=dialog]')

    // a shared link opens the dialog with the field filled, before the tour, and asks GitHub nothing until Look up
    let page = await openWith(`&model=${encodeURIComponent(GH)}`, { tourSeen: false })
    try {
      await page.locator('#gh-link').waitFor({ timeout: PAGE_READY_MS })
      check((await page.locator('#gh-link').inputValue()) === GH, `${at}: a shared link fills the GitHub field (${await page.locator('#gh-link').inputValue()})`)
      await page.waitForTimeout(2000)
      check(asked.length === 0, `${at}: a shared link asks GitHub nothing until Look up (${asked.join(', ')})`)
      check((await dialog(page).count()) === 1 && (await dialog(page).getByRole('form', { name: 'Import from GitHub' }).count()) === 1,
        `${at}: the shared link's dialog shows, not the tour (${await dialog(page).count()} dialogs)`)

      // Look up: the file list and the description files only; the card says what Fetch would download
      await dialog(page).getByRole('button', { name: 'Look up' }).click()
      const card = dialog(page).getByRole('region', { name: 'GitHub files' })
      await card.waitFor({ timeout: PAGE_READY_MS })
      const cardText = await card.innerText()
      check(/acme\/bots/.test(cardText) && cardText.includes(SHA.slice(0, 7)) && /3 files/.test(cardText) && cardText.includes('gh_bot_description/urdf/gh_bot.urdf'),
        `${at}: the card names the repository, commit, file and download (${JSON.stringify(cardText)})`)
      check(asked.filter((a) => a.startsWith('https://api.github.com/')).length === 1 && !asked.some((a) => a.endsWith('.stl')),
        `${at}: Look up on a shared link makes one API call and downloads no mesh (${asked.join(', ')})`)

      // Copy link: the link it gives is the same shared link
      await card.getByRole('button', { name: 'Copy link' }).click()
      const shared = await card.getByRole('textbox', { name: 'Link to this model' }).inputValue()
      check(new URL(shared).searchParams.get('model') === GH, `${at}: Copy link gives the shared link back (${shared})`)

      // Fetch and import: the mesh is downloaded and the robot imported, with its mesh found
      const before = asked.length
      await card.getByRole('button', { name: 'Fetch and import' }).click()
      const done = await dialog(page).getByText('Imported gh bot (1 joint)!').waitFor({ timeout: PAGE_READY_MS }).then(() => true, () => false)
      const text = await dialog(page).innerText()
      check(done && !text.includes('Problems'), `${at}: Fetch and import imports the robot with its mesh (${JSON.stringify(text.slice(0, 300))})`)
      check(asked.slice(before).length === 1 && asked.at(-1).endsWith('/gh_bot_description/meshes/arm.stl'), `${at}: Fetch downloads only the mesh (${asked.slice(before).join(', ')})`)

      // a mesh stored in Git LFS is listed under Problems, and no LFS host is asked
      repoFiles['gh_bot_description/meshes/arm.stl'] = LFS_POINTER
      await page.locator('#gh-link').fill('https://github.com/acme/bots/blob/main/gh_bot_description/urdf/gh_bot.urdf')
      await dialog(page).getByRole('button', { name: 'Look up' }).click()
      await card.getByRole('button', { name: 'Fetch and import' }).click()
      const lfsShown = await dialog(page).getByText('Stored in Git LFS').first().waitFor({ timeout: PAGE_READY_MS }).then(() => true, () => false)
      check(lfsShown && (await dialog(page).innerText()).includes('Problems'), `${at}: a mesh stored in Git LFS is listed under Problems`)
      repoFiles['gh_bot_description/meshes/arm.stl'] = STL

      // the hourly limit: the dialog says when it resets
      rate = true
      await page.locator('#gh-link').fill('https://github.com/acme/bots/blob/main/gh_bot_description/urdf/gh_bot.urdf')
      await dialog(page).getByRole('button', { name: 'Look up' }).click()
      const rateShown = await dialog(page).getByText(/60 requests an hour/).waitFor({ timeout: PAGE_READY_MS }).then(() => true, () => false)
      check(rateShown, `${at}: the hourly limit is explained in the dialog`)
      rate = false

      // editing the link while it is looked up stops that look-up: its card never shows under the edited link
      const lookingUp = dialog(page).getByText('Looking up the link…')
      const lookUpButton = dialog(page).getByRole('button', { name: 'Look up' })
      const slowLink = 'https://github.com/acme/bots/blob/slow/gh_bot_description/urdf/gh_bot.urdf'
      const mainLink = 'https://github.com/acme/bots/blob/main/gh_bot_description/urdf/gh_bot.urdf'
      await page.locator('#gh-link').fill(slowLink)
      await lookUpButton.click()
      await lookingUp.waitFor({ timeout: PAGE_READY_MS })
      await page.locator('#gh-link').fill(mainLink)
      const stoppedAtOnce = (await lookingUp.count()) === 0 && (await lookUpButton.isEnabled())
      await page.waitForTimeout(3000)
      check(stoppedAtOnce && (await card.count()) === 0 && (await page.locator('#gh-link').inputValue()) === mainLink,
        `${at}: editing the link during a look-up stops it, and its card never shows (stopped at once ${stoppedAtOnce}, cards ${await card.count()})`)
      await lookUpButton.click()
      await card.waitFor({ timeout: PAGE_READY_MS })
      check((await card.innerText()).includes('gh_bot_description/urdf/gh_bot.urdf'), `${at}: Look up after the edit shows the edited link's card`)
      // the same slow look-up, left alone, does show its card
      await page.locator('#gh-link').fill(slowLink)
      await lookUpButton.click()
      const slowCard = await card.waitFor({ timeout: PAGE_READY_MS }).then(() => true, () => false)
      check(slowCard && (await lookingUp.count()) === 0, `${at}: a slow look-up left alone shows its card`)

      // while a confirmed download runs, the link cannot be edited
      // (the earlier import's success line stays until the new files are imported, so the download is seen ending instead)
      slowRaw = true
      const fetchedFrom = asked.length
      await card.getByRole('button', { name: 'Fetch and import' }).click()
      const downloading = dialog(page).getByText(/^Downloading/)
      await downloading.waitFor({ timeout: PAGE_READY_MS })
      const readOnly = await page.locator('#gh-link').evaluate((el) => el.readOnly)
      const ended = await downloading.waitFor({ state: 'hidden', timeout: PAGE_READY_MS }).then(() => true, () => false)
      const imported = ended && await dialog(page).getByText('Imported gh bot (1 joint)!').waitFor({ timeout: PAGE_READY_MS }).then(() => true, () => false)
      const meshAsked = asked.slice(fetchedFrom).some((a) => a.endsWith('/gh_bot_description/meshes/arm.stl'))
      check(readOnly && imported && meshAsked && !(await page.locator('#gh-link').evaluate((el) => el.readOnly)) && !(await dialog(page).innerText()).includes('The download failed'),
        `${at}: the link is read-only while its files download, then editable (read-only ${readOnly}, ended ${ended}, imported ${imported}, mesh ${meshAsked})`)
      slowRaw = false

      // a symbolic link is shown on the card, not downloaded, and listed in the report as not supported
      links = { 'gh_bot_description/meshes/alias.stl': 'arm.stl' }
      await page.locator('#gh-link').fill(mainLink)
      await lookUpButton.click()
      await card.waitFor({ timeout: PAGE_READY_MS })
      const linkCard = await card.innerText()
      await card.getByRole('button', { name: 'Fetch and import' }).click()
      const linkReported = await dialog(page).getByText(/A symbolic link, which ROCO does not follow/).first().waitFor({ timeout: PAGE_READY_MS }).then(() => true, () => false)
      const linkText = await dialog(page).innerText()
      check(/One file is a symbolic link/.test(linkCard) && linkCard.includes('gh_bot_description/meshes/alias.stl') && linkReported
        && linkText.includes('Not supported') && linkText.includes('alias.stl') && !asked.some((a) => a.endsWith('/alias.stl')),
        `${at}: a symbolic link is on the card and in the report, and is not downloaded (${JSON.stringify(linkCard)})`)
      links = {}

      // a link that is not GitHub's is refused in the dialog, with no request
      const n = asked.length
      await page.locator('#gh-link').fill('https://example.com/acme/bots/blob/main/r.urdf')
      await dialog(page).getByRole('button', { name: 'Look up' }).click()
      const refused = await dialog(page).getByText(/not a GitHub link ROCO can read/).waitFor({ timeout: PAGE_READY_MS }).then(() => true, () => false)
      check(refused && asked.length === n, `${at}: a link off GitHub is refused without a request (${asked.slice(n).join(', ')})`)
      check(asked.every((a) => /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//.test(a)), `${at}: only the two GitHub hosts were asked (${asked.join(', ')})`)
      check(page.errors.length === 0, `${at}: no page errors (${page.errors[0] ?? ''})`)
    } finally {
      await page.close()
    }

    // the top of a repository's shared link (Copy link on a link to the top) opens the dialog too, and asks nothing until Look up
    {
      const TOP = `gh:acme/bots@${SHA}/`
      asked.length = 0
      page = await openWith(`&model=${encodeURIComponent(TOP)}`)
      try {
        const field = await page.locator('#gh-link').waitFor({ timeout: PAGE_READY_MS }).then(() => page.locator('#gh-link').inputValue(), () => null)
        await page.waitForTimeout(1000)
        check(field === TOP && asked.length === 0, `${at}: the top of a repository's shared link fills the field and asks nothing (${field}; ${asked.join(', ')})`)
        const card = dialog(page).getByRole('region', { name: 'GitHub files' })
        if (field === TOP) {
          await dialog(page).getByRole('button', { name: 'Look up' }).click()
          await card.waitFor({ timeout: PAGE_READY_MS })
          const cardText = await card.innerText()
          await card.getByRole('button', { name: 'Copy link' }).click()
          const back = new URL(await card.getByRole('textbox', { name: 'Link to this model' }).inputValue()).searchParams.get('model')
          check(cardText.includes('(top of the repository)') && /3 files/.test(cardText) && back === TOP,
            `${at}: Look up on it shows the top of the repository, and Copy link gives it back (${JSON.stringify(cardText)}; ${back})`)
        }
        check(page.errors.length === 0, `${at}: the top of a repository's shared link: no page errors (${page.errors[0] ?? ''})`)
      } finally {
        await page.close()
      }
    }

    // a ?model= that is not a shared link's shape opens nothing
    for (const bad of [`gh:acme/bots@${SHA.slice(0, 7)}/r.urdf`, 'https://evil.example/r.urdf', `gh:acme/bots@${SHA}`]) {
      page = await openWith(`&model=${encodeURIComponent(bad)}`)
      try {
        await page.waitForTimeout(1000)
        check((await dialog(page).count()) === 0, `${at}: ?model=${bad} opens no dialog`)
        check(page.errors.length === 0, `${at}: ?model=${bad}: no page errors (${page.errors[0] ?? ''})`)
      } finally {
        await page.close()
      }
    }

    // the CSP: GitHub's two hosts are allowed; any other host, Git LFS's included, is blocked before a request is made
    page = await openWith('', { guard: false })
    try {
      asked.length = 0
      const got = await page.evaluate(async (targets) => {
        const seen = []
        document.addEventListener('securitypolicyviolation', (e) => seen.push(`${e.blockedURI} ${e.effectiveDirective}`))
        const out = []
        for (const t of targets) out.push(await fetch(t, { credentials: 'omit' }).then((r) => `ok ${r.status}`, () => 'refused'))
        await new Promise((r) => setTimeout(r, 300))
        return { out, seen }
      }, ['https://api.github.com/rate_limit', 'https://media.githubusercontent.com/media/acme/bots/main/a.stl', 'https://github.com/acme/bots', 'https://objects.githubusercontent.com/a', 'https://example.com/'])
      check(got.out[0] === 'ok 200' && asked.length === 1 && asked[0] === 'https://api.github.com/rate_limit', `${at}: the CSP lets the page ask api.github.com (${got.out[0]}; ${asked.join(', ')})`)
      const blocked = got.seen.filter((s) => s.endsWith(' connect-src'))
      check(got.out.slice(1).every((o) => o === 'refused') && blocked.length === 4 && blocked.some((s) => s.startsWith('https://media.githubusercontent.com')),
        `${at}: the CSP blocks Git LFS's host and every other host (${JSON.stringify(got)})`)
    } finally {
      await page.close()
    }
  }

  // a robot with no movable joints (a drone) imports as one rigid body: its joint table says so, not "Waiting for telemetry…"
  {
    const page = await open(1366, 768)
    const at = 'rigid robot'
    const dir = mkdtempSync(join(tmpdir(), 'roco-rigid-'))
    // the joint table is in one of the workspaces: visit each tab until it is there
    const tableText = async () => {
      const table = page.locator('section[aria-labelledby=actuators-heading]')
      for (const tab of await page.getByRole('tab').all()) {
        if (await table.count()) break
        await tab.click()
      }
      return (await table.count()) ? table.innerText() : '(no joint table)'
    }
    try {
      const file = join(dir, 'rigid_bot.urdf')
      writeFileSync(file, `<?xml version="1.0"?>
<robot name="rigid_bot">
  <link name="base"><visual><geometry><box size="0.2 0.2 0.05"/></geometry></visual></link><link name="rotor"/>
  <joint name="rotor_mount" type="fixed"><parent link="base"/><child link="rotor"/></joint>
</robot>
`)
      await page.locator('section[aria-labelledby=replay-heading]').waitFor({ timeout: PAGE_READY_MS })
      await tableText()
      // demo data fills the G1's rows
      await page.waitForFunction(() => !document.querySelector('section[aria-labelledby=actuators-heading]')?.textContent?.includes('Waiting for telemetry'), null, { timeout: PAGE_READY_MS }).catch(() => {})
      const before = await tableText()
      check(!before.includes('no movable joints') && !before.includes('Waiting for telemetry'), `${at}: the G1 with demo data has rows, not a no-joints note (${JSON.stringify(before.slice(0, 120))})`)
      await page.locator('[data-action="settings"]').first().click()
      await page.getByRole('button', { name: /Import model/ }).click()
      await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(file)
      const dialog = page.locator('[role=dialog]')
      await dialog.getByText('Imported rigid bot (0 joints)!').waitFor({ timeout: PAGE_READY_MS })
      await dialog.getByRole('button', { name: 'Done', exact: true }).click()
      const after = await tableText()
      check(after.includes('This robot has no movable joints.') && !after.includes('Waiting for telemetry'), `${at}: the joint table says the robot has no movable joints (${JSON.stringify(after.slice(0, 160))})`)
      check(!/matched to motors|Motor order/.test(after), `${at}: no motor-order note for a robot with no joints to match (${JSON.stringify(after.slice(0, 160))})`)
      check(page.errors.length === 0, `${at}: no page errors (${page.errors[0] ?? ''})`)
    } finally {
      await page.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 10. Posing by hand (sample paused, so only the sliders move the robot): the joint panel and its badge fit the 3D view with no
  // sideways scroll on a phone and on a desktop; a slider changes the picture; Stop posing gives back the exact picture of the data.
  // Then an imported robot: only its posable joints get a slider (a mimic joint and a joint with no range get none).
  const viewOf = (page) => page.locator('section[aria-label$="digital twin"]')
  const shot = async (page) => {
    await page.mouse.move(0, 0)
    await page.waitForTimeout(900)
    // the smoothing has settled once two pictures in a row are the same (a slow software renderer can take longer than 900 ms)
    const img = viewOf(page).locator('[role=img]')
    let last = await img.screenshot()
    for (const end = Date.now() + 6000; Date.now() < end; ) {
      await page.waitForTimeout(300)
      const next = await img.screenshot()
      if (next.equals(last)) return next
      last = next
    }
    return last
  }
  const startPosing = async (page) => {
    await page.getByText('Loading robot model…').waitFor({ state: 'detached', timeout: PAGE_READY_MS })
    await viewOf(page).getByRole('button', { name: 'Pose joints' }).click()
    await viewOf(page).locator('section[aria-labelledby=pose-heading]').waitFor({ timeout: PAGE_READY_MS })
  }
  const nudge = async (page, name, presses) => {
    await viewOf(page).getByRole('slider', { name }).focus()
    for (let i = 0; i < presses; i++) await page.keyboard.press('PageUp')
  }
  for (const [w, h] of [
    [390, 844],
    [1366, 768],
  ]) {
    const page = await open(w, h)
    const at = `posing ${w}x${h}`
    try {
      const play = page.locator('section[aria-labelledby=replay-heading] button').first()
      if ((await play.textContent())?.includes('Pause')) await play.click()
      await page.getByText('Loading robot model…').waitFor({ state: 'detached', timeout: PAGE_READY_MS })
      const data = await shot(page)
      await startPosing(page)
      const fit = await page.evaluate(() => {
        const view = document.querySelector('section[aria-label$="digital twin"]').getBoundingClientRect()
        const canvas = document.querySelector('section[aria-label$="digital twin"] [role=img]').getBoundingClientRect()
        const panel = document.querySelector('section[aria-labelledby=pose-heading]').getBoundingClientRect()
        const badge = [...document.querySelectorAll('section[aria-label$="digital twin"] span')].find((s) => s.textContent === 'Posed by hand — not live data')
        const b = badge?.getBoundingClientRect()
        return {
          hscroll: document.documentElement.scrollWidth > innerWidth,
          panelInside: panel.left >= view.left - 0.5 && panel.right <= view.right + 0.5 && panel.width > 0 && panel.height > 0,
          badgeInside: !!b && b.left >= canvas.left && b.right <= canvas.right + 0.5 && b.bottom <= canvas.bottom + 0.5 && b.top >= canvas.top,
          canvas: Math.round(canvas.width) + 'x' + Math.round(canvas.height),
        }
      })
      check(!fit.hscroll && fit.panelInside && fit.badgeInside, `${at}: the joint panel and the badge fit the 3D view, no sideways scroll (${JSON.stringify(fit)})`)
      const held = await shot(page)
      await nudge(page, 'left_knee_joint', 4)
      const posed = await shot(page)
      check(!posed.equals(held), `${at}: moving the knee slider changes the 3D view`)
      await viewOf(page).getByRole('button', { name: 'Stop posing' }).click()
      await viewOf(page).locator('section[aria-labelledby=pose-heading]').waitFor({ state: 'detached', timeout: PAGE_READY_MS })
      const back = await shot(page)
      check(back.equals(data), `${at}: Stop posing shows the data's picture again, exactly`)
      check((await viewOf(page).getByText('Posed by hand — not live data').count()) === 0, `${at}: the badge goes with the panel`)
      check(page.errors.length === 0, `${at}: no page errors (${page.errors[0] ?? ''})`)
    } finally {
      await page.close()
    }
  }
  {
    const page = await open(1366, 768)
    const at = 'posing an imported robot'
    const dir = mkdtempSync(join(tmpdir(), 'roco-pose-'))
    try {
      const file = join(dir, 'pose_bot.urdf')
      const box = (x, y, z) => `<visual><geometry><box size="${x} ${y} ${z}"/></geometry></visual>`
      writeFileSync(file, `<?xml version="1.0"?>
<robot name="pose_bot">
  <link name="base">${box(0.3, 0.3, 0.1)}</link>
  <link name="arm">${box(0.05, 0.05, 0.5)}</link>
  <link name="slide">${box(0.1, 0.1, 0.1)}</link>
  <link name="wheel">${box(0.2, 0.02, 0.2)}</link>
  <link name="twin">${box(0.05, 0.05, 0.2)}</link>
  <link name="stuck">${box(0.05, 0.05, 0.05)}</link>
  <joint name="shoulder" type="revolute"><parent link="base"/><child link="arm"/><origin xyz="0 0 0.3"/><axis xyz="0 1 0"/><limit lower="-1.5" upper="1.5" effort="1" velocity="1"/></joint>
  <joint name="lift" type="prismatic"><parent link="base"/><child link="slide"/><origin xyz="0.3 0 0"/><axis xyz="0 0 1"/><limit lower="0" upper="0.2" effort="1" velocity="1"/></joint>
  <joint name="spin" type="continuous"><parent link="base"/><child link="wheel"/><origin xyz="-0.3 0 0"/><axis xyz="0 1 0"/></joint>
  <joint name="follow" type="revolute"><parent link="base"/><child link="twin"/><origin xyz="0 0.3 0"/><axis xyz="0 1 0"/><limit lower="-1" upper="1" effort="1" velocity="1"/><mimic joint="shoulder"/></joint>
  <joint name="no_range" type="revolute"><parent link="base"/><child link="stuck"/><origin xyz="0 -0.3 0"/><axis xyz="0 1 0"/><limit lower="0" upper="0" effort="1" velocity="1"/></joint>
</robot>
`)
      await page.locator('[data-action="settings"]').first().click()
      await page.getByRole('button', { name: /Import model/ }).click()
      await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(file)
      const dialog = page.locator('[role=dialog]')
      await dialog.getByText(/Imported pose bot/).waitFor({ timeout: PAGE_READY_MS })
      await dialog.getByRole('button', { name: 'Done', exact: true }).click()
      await dialog.waitFor({ state: 'detached', timeout: PAGE_READY_MS })
      // the sample's data stays on (paused): it names none of this robot's joints, so they must come back from the pose by themselves
      const play = page.locator('section[aria-labelledby=replay-heading] button').first()
      if ((await play.textContent())?.includes('Pause')) await play.click()
      await page.getByText('Loading robot model…').waitFor({ state: 'detached', timeout: PAGE_READY_MS })
      const data = await shot(page)
      await startPosing(page)
      const sliders = await viewOf(page).getByRole('slider').evaluateAll((els) => els.map((e) => `${e.id}:${e.min}..${e.max}:${e.getAttribute('aria-valuetext')}`))
      const ids = sliders.map((s) => s.split(':')[0]).sort().join(' ')
      check(ids === 'pose-lift pose-shoulder pose-spin', `${at}: sliders for the revolute, sliding and turning joints only, none for the mimic or no-range joint (${sliders.join(' | ')})`)
      check(sliders.some((s) => /^pose-lift:0\.\.200:0\.0 millimetres$/.test(s)) && sliders.some((s) => /^pose-spin:-180\.\.180:/.test(s)),
        `${at}: a sliding joint in millimetres over its range, a turning joint over one turn (${sliders.join(' | ')})`)
      const held = await shot(page)
      await nudge(page, 'shoulder', 3)
      check(!(await shot(page)).equals(held), `${at}: moving a slider changes the 3D view`)
      await viewOf(page).getByRole('button', { name: 'Stop posing' }).click()
      await viewOf(page).locator('section[aria-labelledby=pose-heading]').waitFor({ state: 'detached', timeout: PAGE_READY_MS })
      check((await shot(page)).equals(data), `${at}: Stop posing with the sample's data on puts the joints the data does not name back, exactly`)
      // switching the 3D view off ends posing and takes the Pose joints button away (no robot in the view to pose)
      await startPosing(page)
      await page.keyboard.press('Control+k')
      await page.keyboard.type('3D view off')
      await page.locator('[role=option]', { hasText: '3D view: Off' }).first().click()
      await viewOf(page).getByText('3D view is off').waitFor({ timeout: PAGE_READY_MS })
      check((await viewOf(page).locator('section[aria-labelledby=pose-heading]').count()) === 0, `${at}: switching the 3D view off closes the joint panel`)
      check((await viewOf(page).getByRole('button', { name: 'Pose joints' }).count()) === 0, `${at}: no Pose joints button while the 3D view is off`)
      check(page.errors.length === 0, `${at}: no page errors (${page.errors[0] ?? ''})`)
    } finally {
      await page.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 11. Nothing goes to a bridge before its first message. A read-only bridge says so in its hello, always its first message;
  // the drive panel's 50 Hz loop must not reach it in the gap after the socket opens (the fake bridge waits 1 s before it speaks).
  // A drive bridge (tools/sim-drive: no hello) still gets the drive commands once its first robot frame has come.
  {
    const b = await rolldown({ input: new URL('../src/services/recordedBridge.ts', import.meta.url).pathname, logLevel: 'silent' })
    const { output } = await b.generate({ format: 'esm' })
    await b.close()
    const { parseSample } = await import('data:text/javascript;base64,' + Buffer.from(output[0].code).toString('base64'))
    // a plain Uint8Array: a Node Buffer's slice() shares memory, so each frame would be the whole recording
    const sample = parseSample(new Uint8Array(gunzipSync(readFileSync(new URL('../dist/demo/g1-sample.rocodemo.gz', import.meta.url)))))
    const live = { ...JSON.parse(sample.greeting[0]), source: 'sim', readOnly: true }
    delete live.demo
    const hello = JSON.stringify(live)
    const robotFrame = Buffer.from(sample.snapshots[0].find((f) => typeof f !== 'string'))
    check(robotFrame.length < 4096, `the fake bridge's robot frame is one frame (${robotFrame.length} bytes)`)
    const bridgeUrl = url.replace('?demo=1', '?ws=' + encodeURIComponent('ws://127.0.0.1:18799/'))
    for (const [kind, greeting] of [
      ['a read-only bridge', [hello]],
      ['a drive bridge', []],
    ]) {
      const page = await browser.newPage({ viewport: { width: 1366, height: 768 } })
      const errors = []
      page.on('pageerror', (e) => errors.push(String(e)))
      await guardCsp(page)
      await page.addInitScript(() => {
        try {
          localStorage.setItem('roco.tour.v1', '1')
        } catch {}
      })
      const got = []
      let spokeAt = Infinity
      let sockets = 0
      let timer = 0
      await page.routeWebSocket(/:18799\//, (ws) => {
        sockets++
        ws.onMessage((m) => got.push({ at: Date.now(), m }))
        setTimeout(() => {
          spokeAt = Date.now()
          for (const g of greeting) ws.send(g)
          ws.send(robotFrame)
          timer = setInterval(() => ws.send(robotFrame), 20)
        }, 1000)
      })
      try {
        await page.goto(bridgeUrl)
        await page.waitForTimeout(3000)
        const early = got.filter((g) => g.at < spokeAt).length
        const teleop = got.filter((g) => Buffer.isBuffer(g.m) && g.m.length >= 4 && g.m.readUInt32LE(0) === 0x524f434f).length
        check(sockets === 1, `${kind}: the page opened one socket to it (${sockets})`)
        check(early === 0, `${kind}: the page sent nothing before the bridge's first message (${early} sent)`)
        if (greeting.length) check(got.length === 0, `${kind}: the page sent nothing at all (${got.length} sent)`)
        else check(teleop > 0, `${kind}: the drive commands go out once its first robot frame has come (${teleop} sent)`)
        check(errors.length === 0, `${kind}: no page errors (${errors[0] ?? ''})`)
      } finally {
        clearInterval(timer)
        await page.close()
      }
    }
  }
} finally {
  await close()
}

finish('check-layout')
