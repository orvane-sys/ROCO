// What the browser checks (check-layout, check-a11y) share: a static server on the built page (dist/) and the Chrome or Chromium on
// this PC. playwright-core downloads no browser, so CI uses the one on the runner and this PC uses its own.
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

/**
 * How long a check waits for the page to show the replay section. Chrome draws the 3D view in software here, so a first load takes
 * about 15 s on one core: a slower CI runner passed 15 s while the page was fine. This limit is for a page that never comes up.
 */
export const PAGE_READY_MS = 60000

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.gz': 'application/gzip' }

/** Serves dist/ on a free local port and starts Chrome. Exits with a message when there is no dist/ or no browser. */
export async function startBrowser(name) {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url))
  if (!existsSync(join(dist, 'index.html'))) {
    console.error(`${name}: no dist/, run npm run build first`)
    process.exit(1)
  }
  const chromePath = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p))
  if (!chromePath) {
    console.error(`${name}: no Chrome or Chromium found; set CHROME_PATH`)
    process.exit(1)
  }
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
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
  })
  return {
    url,
    browser,
    async close() {
      await browser.close()
      server.close()
    },
  }
}

/**
 * Makes every Content Security Policy violation a page error, which the checks already fail on, so a policy that blocks something
 * the page needs (a model, the sample, the meshes' WebAssembly, the bridge) cannot pass unseen. `target` is a page or a context.
 */
export const guardCsp = (target) =>
  target.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      setTimeout(() => {
        throw new Error(`CSP blocked ${e.blockedURI || 'inline'} (${e.effectiveDirective})`)
      })
    })
  })

/** A tally for the checks: `check(ok, what)` counts, and `finish(name)` prints the totals and sets the exit code. */
export function tally() {
  let failed = 0
  let passed = 0
  return {
    check(ok, what) {
      if (ok) passed++
      else {
        failed++
        console.error('FAIL: ' + what)
      }
    },
    finish(name) {
      console.log(`${name}: ${passed} checks passed`)
      if (failed > 0) {
        console.error(`${name}: ${failed} FAILED`)
        process.exitCode = 1
      }
    },
  }
}
