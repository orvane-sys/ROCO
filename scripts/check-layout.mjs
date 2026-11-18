// Checks the page layout in a real browser, on the built page (dist/) playing the sample recording: the header keeps its height whatever
// it says, from xl the page does not scroll and the replay row and timeline stay on screen, every stage tab is in view, and each
// workspace's note shows once, and every palette command has a visible control. It uses the Chrome or Chromium on this PC (playwright-core downloads no browser).
//
//   npm run build && npm run check:layout        (CHROME_PATH=/path/to/chrome to choose a browser)
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PAGE_READY_MS, guardCsp, openImportReport, startBrowser, tally } from './lib-browser.mjs'

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
    if (w === 1366) {
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download report' }).click()])
      const saved = await download.path()
      const body = saved ? readFileSync(saved, 'utf8') : ''
      check(/^roco_import_report_\d{8}_\d{4}\.txt$/.test(download.suggestedFilename()) && body.startsWith('ROCO import report\nModel: report bot (1 joint)\nMain file: report_bot.xacro\n') &&
        body.includes('xacro arg prefix = (no value)') && body.includes("error: ") && body.includes("needs the argument 'prefix'"),
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
} finally {
  await close()
}

finish('check-layout')
