// What the browser checks (check-layout, check-a11y) share: a static server on the built page (dist/) and the Chrome or Chromium on
// this PC. playwright-core downloads no browser, so CI uses the one on the runner and this PC uses its own.
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  const browser = await launchChrome(name)
  return {
    url,
    browser,
    async close() {
      await browser.close()
      server.close()
    },
  }
}

/** Starts headless Chrome or Chromium from this PC (or CHROME_PATH). Exits with a message when there is none. */
export async function launchChrome(name) {
  const chromePath = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p))
  if (!chromePath) {
    console.error(`${name}: no Chrome or Chromium found; set CHROME_PATH`)
    process.exit(1)
  }
  return chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
  })
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

/**
 * A xacro that needs an argument it is not given and names a mesh it does not have, so its import shows the dialog's report
 * (two problems) and the arguments form. Its joint is named from both arguments.
 */
export const REPORT_XACRO = `<?xml version="1.0"?>
<robot name="report_bot" xmlns:xacro="http://www.ros.org/wiki/xacro">
  <xacro:arg name="side" default="left"/>
  <link name="base"/>
  <link name="arm"><visual><geometry><mesh filename="package://report_bot_description/meshes/a_rather_long_folder_name/forearm_link_visual_mesh.stl"/></geometry></visual></link>
  <joint name="$(arg prefix)joint_$(arg side)" type="revolute"><parent link="base"/><child link="arm"/><axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint>
</robot>
`

/**
 * Opens Settings, then the import dialog, and imports REPORT_XACRO through its file input; resolves once the report shows. The
 * file stays on disk for "Import again" until the returned function removes it (call it after closing the page).
 */
export async function openImportReport(page) {
  const dir = mkdtempSync(join(tmpdir(), 'roco-dialog-'))
  const remove = () => rmSync(dir, { recursive: true, force: true })
  try {
    writeFileSync(join(dir, 'report_bot.xacro'), REPORT_XACRO)
    await page.locator('[data-action="settings"]').first().click()
    await page.getByRole('button', { name: /Import model/ }).click()
    await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(join(dir, 'report_bot.xacro'))
    await page.getByRole('heading', { name: 'Import report' }).waitFor({ timeout: PAGE_READY_MS })
    await page.getByRole('form', { name: 'Xacro arguments' }).waitFor()
  } catch (e) {
    remove()
    throw e
  }
  return remove
}

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
