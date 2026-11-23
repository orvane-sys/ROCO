// Accessibility checks in a real browser, on the built page (dist/) playing the sample recording:
//   1. axe-core (WCAG 2.0 to 2.2 A and AA, plus its best practices) in all three themes, at 320, 768 and 1600 px, in all three workspaces
//   2. reflow: at 200 % and 400 % zoom (a 640 and a 320 px window) the page does not scroll sideways
//   3. the keyboard: Tab through every workspace; each stop has a name, a visible focus mark and is not covered by another element
//   4. the import dialog showing its report and xacro arguments form: axe in all three themes at 320, 768 and 1600 px, no sideways
//      scroll at 320 px, and the keyboard stays in the dialog with each stop named, marked and uncovered
//   5. the 3D view posed by hand: axe with the joint panel open in all three themes at 320, 768 and 1600 px, every slider named and
//      its value said in words, and the keyboard reaches and moves the sliders
//   6. the import dialog's GitHub card, shared link and error (GitHub answered by fakes): axe in all three themes at 320, 768 and
//      1600 px, nothing off the side at 320 px, and the keyboard reaches each of its controls
// It needs a screen reader for the rest; docs/screen-reader-test.md is the script for that.
//
//   npm run build && npm run check:a11y
import { readFileSync } from 'node:fs'
import { PAGE_READY_MS, guardCsp, openImportReport, startBrowser, tally } from './lib-browser.mjs'

const axeSource = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8')
const { url, browser, close } = await startBrowser('check-a11y')
const { check, finish } = tally()

/** Each keyboard stop: what it is, whether it has a name, is on screen and uncovered, and shows a focus mark. */
const stopOf = () => {
  const el = document.activeElement
  if (!el || el === document.body) return null
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const label = el.getAttribute('aria-label') || el.getAttribute('title') || (el.getAttribute('aria-labelledby') ? document.getElementById(el.getAttribute('aria-labelledby'))?.textContent : '') || el.textContent || el.labels?.[0]?.textContent || el.getAttribute('placeholder') || ''
  const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1)
  const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1)
  const top = document.elementFromPoint(x, y)
  return {
    what: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${label.trim().slice(0, 40)}"`,
    named: label.trim().length > 0 || (el.labels?.length ?? 0) > 0,
    sized: r.width > 0 && r.height > 0,
    inView: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
    covered: !(top === el || el.contains(top) || top?.contains(el)),
    mark: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none',
    outside: document.querySelector('main') ? !document.querySelector('main').contains(el) : false,
    inDialog: !!el.closest('[role=dialog]'),
  }
}

async function open(width, height, theme = 'dark', query = '') {
  const page = await browser.newPage({ viewport: { width, height } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await guardCsp(page)
  await page.addInitScript(
    ([t]) => {
      try {
        localStorage.setItem('roco.tour.v1', '1')
        localStorage.setItem('roco.ui.v1', JSON.stringify({ theme: t, intros: ['run', 'analyze', 'review'] }))
      } catch {}
    },
    [theme]
  )
  await page.goto(url + query)
  await page.waitForSelector('section[aria-labelledby=replay-heading]', { timeout: PAGE_READY_MS })
  page.errors = errors
  return page
}
const tab = async (page, name) => {
  await page.getByRole('tab', { name }).click()
  await page.waitForTimeout(900)
}
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

try {
  // 1. axe
  let runs = 0
  for (const theme of ['dark', 'light', 'contrast']) {
    for (const [w, h] of [
      [320, 700],
      [768, 900],
      [1600, 900],
    ]) {
      const page = await open(w, h, theme)
      await page.evaluate(axeSource)
      for (const ws of ['Run', 'Analyze', 'Review']) {
        await tab(page, ws)
        const at = `${theme} ${w}px ${ws}`
        runs++
        const found = await page.evaluate((tags) => axe.run(document, { runOnly: { type: 'tag', values: tags } }).then((r) => r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary?.split('\n').slice(1, 2).join(' ').trim() ?? '' })) }))), TAGS)
        for (const v of found) {
          for (const n of v.nodes) {
            // A control under the sticky replay bar is only covered where the page happens to be scrolled; the real test is where it
            // sits when it is brought into view.
            if (v.id === 'target-size' && /obscured/.test(n.summary)) {
              const selector = n.target.at(-1)
              const again = await page.evaluate(
                (sel) => {
                  const el = document.querySelector(sel)
                  if (!el) return null
                  el.scrollIntoView({ block: 'center' })
                  return axe.run(el, { runOnly: { type: 'rule', values: ['target-size'] } }).then((r) => r.violations.length)
                },
                selector
              )
              check(again === 0, `${at}: target-size of ${selector} even in view`)
            } else check(false, `${at}: axe ${v.id} on ${n.target.join(' ')}: ${n.summary}`)
          }
        }
      }
      check(page.errors.length === 0, `${theme} ${w}px: no page errors (${page.errors[0] ?? ''})`)
      await page.close()
    }
  }
  check(runs === 27, `axe ran ${runs} times`)

  // 2. reflow: 200 % zoom of a 1280 px window is 640 px wide, 400 % is 320 px (WCAG 1.4.10)
  for (const [w, h, zoom] of [
    [640, 400, '200 %'],
    [320, 256, '400 %'],
  ]) {
    const page = await open(w, h)
    for (const ws of ['Run', 'Analyze', 'Review']) {
      await tab(page, ws)
      const wide = await page.evaluate(() => {
        const bad = [...document.querySelectorAll('body *')].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('[class*=overflow-x]') && !e.closest('canvas'))
        return { sideways: document.documentElement.scrollWidth > innerWidth, first: bad[0] ? `${bad[0].tagName}.${String(bad[0].className).slice(0, 50)}` : '' }
      })
      check(!wide.sideways, `${zoom} zoom, ${ws}: the page does not scroll sideways (${wide.first})`)
    }
    await page.close()
  }

  // 3. the keyboard
  {
    const page = await open(1366, 768)
    for (const ws of ['Run', 'Analyze', 'Review']) {
      await tab(page, ws)
      await page.evaluate(() => document.getElementById('workspace-panel').focus())
      const stops = []
      for (let i = 0; i < 120; i++) {
        await page.keyboard.press('Tab')
        const s = await page.evaluate(stopOf)
        if (s === null) break
        stops.push(s)
      }
      check(stops.length > 20, `keyboard, ${ws}: Tab reaches the page's controls (${stops.length} stops)`)
      for (const s of stops) {
        check(s.named, `keyboard, ${ws}: ${s.what} has a name`)
        check(s.sized && s.inView, `keyboard, ${ws}: ${s.what} is on screen when focused`)
        check(!s.covered, `keyboard, ${ws}: ${s.what} is not covered by another element when focused`)
        check(s.mark, `keyboard, ${ws}: ${s.what} shows a focus mark`)
      }
    }
    await page.close()
  }

  // 4. the import dialog with its model check, its report and the xacro arguments form open
  {
    let runs = 0
    for (const theme of ['dark', 'light', 'contrast']) {
      for (const [w, h] of [
        [320, 700],
        [768, 900],
        [1600, 900],
      ]) {
        const page = await open(w, h, theme)
        const at = `import dialog, ${theme} ${w}px`
        const removeFile = await openImportReport(page)
        await page.evaluate(axeSource)
        runs++
        const found = await page.evaluate((tags) => axe.run(document.querySelector('[role=dialog]'), { runOnly: { type: 'tag', values: tags } }).then((r) => r.violations.flatMap((v) => v.nodes.map((n) => `${v.id} on ${n.target.join(' ')}: ${n.failureSummary?.split('\n').slice(1, 2).join(' ').trim() ?? ''}`))), TAGS)
        for (const v of found) check(false, `${at}: axe ${v}`)
        const model = await page.getByRole('group', { name: 'Model check findings' }).innerText()
        check(/Errors \(1\)/.test(model) && model.includes('arm') && !model.includes('Warnings'), `${at}: the model check shows one error, on the link arm (${JSON.stringify(model.slice(0, 120))})`)
        if (w === 320) {
          const wide = await page.evaluate(() => {
            const bad = [...document.querySelectorAll('[role=dialog] *')].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > innerWidth + 1)
            return { sideways: document.documentElement.scrollWidth > innerWidth, first: bad[0] ? `${bad[0].tagName}.${String(bad[0].className).slice(0, 50)}` : '' }
          })
          check(!wide.sideways && !wide.first, `${at}: nothing in the dialog runs off the side (${wide.first})`)
        }
        if (theme === 'dark' && w === 768) {
          const stops = []
          for (let i = 0; i < 30; i++) {
            await page.keyboard.press('Tab')
            const s = await page.evaluate(stopOf)
            if (s === null || (stops.length && s.what === stops[0].what)) break
            stops.push(s)
          }
          const names = stops.map((s) => s.what).join(' | ')
          check(['Download report', 'Model check findings', 'Report items', 'side', 'prefix', 'Import again with these values', 'Done', 'Close dialog'].every((n) => names.includes(n)),
            `${at}: Tab reaches the report download, the model check and report lists, each argument, Import again, Done and Close (${names})`)
          for (const s of stops) {
            check(s.inDialog, `${at}: ${s.what} is inside the dialog (focus stays in it)`)
            check(s.named, `${at}: ${s.what} has a name`)
            check(s.sized && s.inView && !s.covered, `${at}: ${s.what} is on screen and not covered when focused`)
            check(s.mark, `${at}: ${s.what} shows a focus mark`)
          }
        }
        check(page.errors.length === 0, `${at}: no page errors (${page.errors[0] ?? ''})`)
        await page.close()
        removeFile()
      }
    }
    check(runs === 9, `axe ran on the import dialog ${runs} times`)
  }

  // 5. the 3D view posed by hand: axe on the view with its joint panel open in all three themes at 320, 768 and 1600 px; every
  //    slider has a name and a value in words; the keyboard reaches each control in the panel and moves a slider
  {
    let runs = 0
    for (const theme of ['dark', 'light', 'contrast']) {
      for (const [w, h] of [
        [320, 700],
        [768, 900],
        [1600, 900],
      ]) {
        const page = await open(w, h, theme)
        const at = `pose panel, ${theme} ${w}px`
        const view = page.locator('section[aria-label$="digital twin"]')
        await page.getByText('Loading robot model…').waitFor({ state: 'detached', timeout: PAGE_READY_MS })
        await view.getByRole('button', { name: 'Pose joints' }).click()
        const panel = view.locator('section[aria-labelledby=pose-heading]')
        await panel.waitFor({ timeout: PAGE_READY_MS })
        await page.evaluate(axeSource)
        runs++
        const found = await page.evaluate((tags) => axe.run(document.querySelector('section[aria-label$="digital twin"]'), { runOnly: { type: 'tag', values: tags } }).then((r) => r.violations.flatMap((v) => v.nodes.map((n) => `${v.id} on ${n.target.join(' ')}: ${n.failureSummary?.split('\n').slice(1, 2).join(' ').trim() ?? ''}`))), TAGS)
        for (const v of found) check(false, `${at}: axe ${v}`)
        const sliders = await panel.getByRole('slider').evaluateAll((els) => els.map((e) => ({ name: e.labels?.[0]?.textContent?.trim() ?? '', text: e.getAttribute('aria-valuetext') ?? '' })))
        check(sliders.length === 29, `${at}: one slider for each of the G1's 29 joints (${sliders.length})`)
        const bad = sliders.filter((s) => !s.name || !/^-?\d+\.\d (degrees|millimetres)$/.test(s.text))
        check(bad.length === 0, `${at}: every slider has a name and its value in words (${JSON.stringify(bad[0] ?? '')})`)
        if (theme === 'dark' && w === 1600) {
          await view.getByRole('button', { name: 'Pose joints' }).focus()
          const stops = []
          for (let i = 0; i < 40; i++) {
            await page.keyboard.press('Tab')
            const s = await page.evaluate(stopOf)
            if (s === null) break
            stops.push(s)
            if (s.what.includes('right_wrist_yaw_joint')) break
          }
          const names = stops.map((s) => s.what).join(' | ')
          check(['Back to zero', 'Stop posing', 'left_hip_pitch_joint', 'right_wrist_yaw_joint'].every((n) => names.includes(n)), `${at}: Tab reaches Back to zero, Stop posing and every slider (${names.slice(0, 300)})`)
          for (const s of stops) {
            check(s.named, `${at}: ${s.what} has a name`)
            check(s.sized && s.inView && !s.covered, `${at}: ${s.what} is on screen and not covered when focused`)
            check(s.mark, `${at}: ${s.what} shows a focus mark`)
          }
          const knee = panel.getByRole('slider', { name: 'left_knee_joint' })
          await knee.focus()
          const before = await knee.getAttribute('aria-valuetext')
          await page.keyboard.press('ArrowRight')
          await page.keyboard.press('PageUp')
          const after = await knee.getAttribute('aria-valuetext')
          check(parseFloat(after) > parseFloat(before), `${at}: the arrow and Page Up keys move a slider (${before} -> ${after})`)
        }
        check(page.errors.length === 0, `${at}: no page errors (${page.errors[0] ?? ''})`)
        await page.close()
      }
    }
    check(runs === 9, `axe ran on the posed view ${runs} times`)
  }
  // 6. the import dialog's GitHub card with its shared link, then its error; GitHub's two hosts are answered by fakes
  {
    const SHA = 'c'.repeat(40)
    const files = {
      'gh_bot_description/package.xml': '<package><name>gh_bot_description</name></package>',
      'gh_bot_description/urdf/gh_bot.urdf': '<robot name="gh_bot"><link name="base"/></robot>',
    }
    const GH = `gh:acme/bots@${SHA}/gh_bot_description/urdf/gh_bot.urdf`
    const fake = (route) => {
      const u = new URL(route.request().url())
      const headers = { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }
      if (u.host === 'api.github.com' && u.pathname === `/repos/acme/bots/git/trees/${SHA}`) {
        const tree = Object.entries(files).map(([path, body]) => ({ path, type: 'blob', size: Buffer.byteLength(body) }))
        return route.fulfill({ status: 200, headers, body: JSON.stringify({ tree: [...tree, { path: 'gh_bot_description', type: 'tree' }, { path: 'gh_bot_description/urdf', type: 'tree' }], truncated: false }) })
      }
      const prefix = `/acme/bots/${SHA}/`
      if (u.host === 'raw.githubusercontent.com' && u.pathname.startsWith(prefix) && files[u.pathname.slice(prefix.length)]) {
        return route.fulfill({ status: 200, headers, body: files[u.pathname.slice(prefix.length)] })
      }
      return route.fulfill({ status: 404, headers, body: 'Not Found' })
    }
    const axeOn = (page) => page.evaluate((tags) => axe.run(document.querySelector('[role=dialog]'), { runOnly: { type: 'tag', values: tags } }).then((r) => r.violations.flatMap((v) => v.nodes.map((n) => `${v.id} on ${n.target.join(' ')}: ${n.failureSummary?.split('\n').slice(1, 2).join(' ').trim() ?? ''}`))), TAGS)
    const offSide = (page) => page.evaluate(() => {
      const bad = [...document.querySelectorAll('[role=dialog] *')].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > innerWidth + 1)
      return { sideways: document.documentElement.scrollWidth > innerWidth, first: bad[0] ? `${bad[0].tagName}.${String(bad[0].className).slice(0, 50)}` : '' }
    })
    let runs = 0
    for (const theme of ['dark', 'light', 'contrast']) {
      for (const [w, h] of [
        [320, 700],
        [768, 900],
        [1600, 900],
      ]) {
        const at = `GitHub card, ${theme} ${w}px`
        const p = await open(w, h, theme, `&model=${encodeURIComponent(GH)}`)
        try {
          await p.route(/^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//, fake)
          const dlg = p.locator('[role=dialog]')
          await dlg.getByRole('button', { name: 'Look up' }).click()
          const card = dlg.getByRole('region', { name: 'GitHub files' })
          await card.waitFor({ timeout: PAGE_READY_MS })
          await card.getByRole('button', { name: 'Copy link' }).click()
          await card.getByRole('textbox', { name: 'Link to this model' }).waitFor()
          await p.evaluate(axeSource)
          runs++
          for (const v of await axeOn(p)) check(false, `${at}: axe ${v}`)
          if (w === 320) {
            const wide = await offSide(p)
            check(!wide.sideways && !wide.first, `${at}: nothing in the dialog runs off the side (${wide.first})`)
          }
          if (theme === 'dark' && w === 768) {
            const stops = []
            await p.locator('#gh-link').focus()
            for (let i = 0; i < 12; i++) {
              const s = await p.evaluate(stopOf)
              if (s === null || stops.some((t) => t.what === s.what)) break
              stops.push(s)
              await p.keyboard.press('Tab')
            }
            const names = stops.map((s) => s.what).join(' | ')
            check(['input#gh-link', 'Look up', 'Fetch and import', 'Copy link', 'Link to this model'].every((n) => names.includes(n)),
              `${at}: Tab reaches the link field, Look up, Fetch and import, Copy link and the link (${names})`)
            for (const s of stops) check(s.named && s.inDialog && s.sized && s.inView && !s.covered && s.mark, `${at}: ${s.what} is named, on screen, uncovered and marked (${JSON.stringify(s)})`)
          }
          // the error state: a link that is not GitHub's
          await p.locator('#gh-link').fill('https://example.com/acme/bots/blob/main/r.urdf')
          await dlg.getByRole('button', { name: 'Look up' }).click()
          await dlg.getByText(/not a GitHub link ROCO can read/).waitFor({ timeout: PAGE_READY_MS })
          runs++
          for (const v of await axeOn(p)) check(false, `${at}, error: axe ${v}`)
          if (w === 320) {
            const wide = await offSide(p)
            check(!wide.sideways && !wide.first, `${at}, error: nothing in the dialog runs off the side (${wide.first})`)
          }
          check(p.errors.length === 0, `${at}: no page errors (${p.errors[0] ?? ''})`)
        } finally {
          await p.close()
        }
      }
    }
    check(runs === 18, `axe ran on the GitHub card and its error ${runs} times`)
  }
} finally {
  await close()
}

finish('check-a11y')
