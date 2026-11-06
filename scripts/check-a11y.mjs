// Accessibility checks in a real browser, on the built page (dist/) playing the sample recording:
//   1. axe-core (WCAG 2.0 to 2.2 A and AA, plus its best practices) in all three themes, at 320, 768 and 1600 px, in all three workspaces
//   2. reflow: at 200 % and 400 % zoom (a 640 and a 320 px window) the page does not scroll sideways
//   3. the keyboard: Tab through every workspace; each stop has a name, a visible focus mark and is not covered by another element
// It needs a screen reader for the rest; docs/screen-reader-test.md is the script for that.
//
//   npm run build && npm run check:a11y
import { readFileSync } from 'node:fs'
import { startBrowser, tally } from './lib-browser.mjs'

const axeSource = readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8')
const { url, browser, close } = await startBrowser('check-a11y')
const { check, finish } = tally()

async function open(width, height, theme = 'dark') {
  const page = await browser.newPage({ viewport: { width, height } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(
    ([t]) => {
      try {
        localStorage.setItem('roco.tour.v1', '1')
        localStorage.setItem('roco.ui.v1', JSON.stringify({ theme: t, intros: ['run', 'analyze', 'review'] }))
      } catch {}
    },
    [theme]
  )
  await page.goto(url)
  await page.waitForSelector('section[aria-labelledby=replay-heading]', { timeout: 15000 })
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
        const s = await page.evaluate(() => {
          const el = document.activeElement
          if (!el || el === document.body) return null
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          const label = el.getAttribute('aria-label') || el.getAttribute('title') || (el.getAttribute('aria-labelledby') ? document.getElementById(el.getAttribute('aria-labelledby'))?.textContent : '') || el.textContent || el.getAttribute('placeholder') || ''
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
          }
        })
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
} finally {
  await close()
}

finish('check-a11y')
