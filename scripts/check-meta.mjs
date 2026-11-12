// Checks what a visitor sees before the app runs (index.html: title, description, icons, browser bar colour), that no unused
// file sits in public/ or src/assets/, that every tour step points at a part of the page that exists, and that every command of the
// palette has a control on screen (src/config/actions.ts).
//
//   node scripts/check-meta.mjs
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(join(root, p), 'utf8')

let failed = 0
let passed = 0
function check(ok, what) {
  if (ok) passed++
  else {
    failed++
    console.error('FAIL: ' + what)
  }
}

const html = read('index.html')
const meta = (name) => html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1]
const link = (rel) => html.match(new RegExp(`<link rel="${rel}"[^>]*href="([^"]*)"`))?.[1]

const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ''
check(/^ROCO\b/.test(title) && /G1/.test(title), `the title names ROCO and the G1 (is "${title}")`)
const desc = meta('description') ?? ''
check(desc.length >= 50 && desc.length <= 160 && /read-only/i.test(desc), `the description is 50 to 160 characters and says read-only (${desc.length})`)

// public/ files are served from the base, so index.html names them from "/" and Vite adds the base
const icon = link('icon')
check(icon === '/favicon.svg' && existsSync(join(root, 'public/favicon.svg')), 'the favicon link names public/favicon.svg')
const touch = link('apple-touch-icon')
const png = touch && existsSync(join(root, 'public', touch)) ? readFileSync(join(root, 'public', touch)) : null
// PNG signature, then the IHDR chunk: width and height as big-endian u32 at bytes 16 and 20
check(png && png.readUInt32BE(12) === 0x49484452 && png.readUInt32BE(16) === 180 && png.readUInt32BE(20) === 180, 'the touch icon is a 180x180 PNG')
check(!read('public/favicon.svg').includes('#863bff'), 'the favicon is ROCO\'s, not the Vite template\'s')

// the name and licence notes a stranger needs before installing
const readme = read('README.md')
check(/not affiliated with or endorsed by Unitree/.test(readme), 'the README says ROCO is not affiliated with Unitree')
check(/not\s+published/.test(readme), 'the README says the test manual behind the checks is not published')
check(/`pip install roco`/.test(readme) && /unrelated/.test(readme), 'the README warns that pip install roco is another project')
check(/license:\s*\{\s*fileName:\s*'THIRD-PARTY-LICENSES\.md'/.test(read('vite.config.ts')) && readme.includes('THIRD-PARTY-LICENSES.md'), 'the build writes THIRD-PARTY-LICENSES.md and the README names it')

// the logo: the README's two pictures hold the page's drawing, and the favicon is readable on a dark tab bar too
const pathsOf = (text) => [...text.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1]).sort()
const pagePaths = pathsOf(read('src/components/RocoLogo.tsx'))
check(pagePaths.length === 10, `RocoLogo.tsx draws the mark and the letters (${pagePaths.length} paths)`)
for (const f of ['docs/brand/roco-logo-light.svg', 'docs/brand/roco-logo-dark.svg']) {
  check(existsSync(join(root, f)) && JSON.stringify(pathsOf(read(f))) === JSON.stringify(pagePaths), `${f} is the same drawing as RocoLogo.tsx`)
  check(read('README.md').includes(f), `the README shows ${f}`)
}
check(/prefers-color-scheme: dark/.test(read('public/favicon.svg')), 'the favicon has colours for a dark browser')
check(/name and logo are not covered by the Apache-2\.0 licence/.test(readme), 'the README says the name and logo are outside the code licence')
const brandNote = existsSync(join(root, 'docs/brand/README.md')) ? read('docs/brand/README.md') : ''
check(/AI image tool/.test(brandNote) && /redrawn by hand/.test(brandNote), 'docs/brand/README.md says how the logo was made')

// a shared link's preview: a crawler needs a full address, and the picture is 1200x630
const og = (name) => html.match(new RegExp(`<meta property="og:${name}" content="([^"]*)"`))?.[1]
check(og('title') === title && og('description') === desc, 'og:title and og:description equal the title and the description')
check(og('image') === 'https://orvane-sys.github.io/ROCO/og.png', `og:image is the full address of public/og.png (${og('image')})`)
check(meta('twitter:card') === 'summary_large_image', 'twitter:card shows the large picture')
const ogPng = existsSync(join(root, 'public/og.png')) ? readFileSync(join(root, 'public/og.png')) : null
check(ogPng && ogPng.readUInt32BE(12) === 0x49484452 && ogPng.readUInt32BE(16) === 1200 && ogPng.readUInt32BE(20) === 630, 'public/og.png is a 1200x630 PNG')

// before the app runs the bar takes the dark theme's header colour; uiPrefs.ts then reads the token itself
const tokens = read('src/styles/tokens.css')
const darkSunken = tokens.match(/:root\s*\{[^}]*--c-sunken:\s*([^;]+);/)?.[1].trim()
check(darkSunken && meta('theme-color') === darkSunken, `theme-color equals the dark --c-sunken (${meta('theme-color')} vs ${darkSunken})`)
check(read('src/services/uiPrefs.ts').includes(`'--c-sunken'`), 'uiPrefs.ts sets theme-color from --c-sunken')

// every file in public/ (except the robot models) and src/assets/ is used somewhere
const sources = []
const walk = (dir) => {
  for (const f of readdirSync(join(root, dir))) {
    const p = join(dir, f)
    if (statSync(join(root, p)).isDirectory()) walk(p)
    else if (/\.(tsx?|css)$/.test(f)) sources.push(read(p))
  }
}
walk('src')
const used = [html, ...sources].join('\n')
for (const f of readdirSync(join(root, 'public'))) {
  if (f === 'models') continue
  check(f === 'demo' ? used.includes('demo/g1-sample.rocodemo.gz') : used.includes(f), `public/${f} is used by index.html or the page`)
}
if (existsSync(join(root, 'src/assets'))) {
  for (const f of readdirSync(join(root, 'src/assets'))) check(used.includes(`assets/${f}`), `src/assets/${f} is imported`)
}

// each tour step's target is marked with data-tour="…" in a component
const tour = read('src/components/Tour.tsx')
const targets = [...tour.matchAll(/target: '([a-z-]+)'/g)].map((m) => m[1])
check(targets.length >= 4, `the tour points at the page's parts (${targets.length} targets)`)
for (const t of targets) check(sources.some((s) => s.includes(`data-tour="${t}"`)), `the tour target "${t}" is marked in a component`)

// every palette command has a place in src/config/actions.ts, and every place a control marked data-action="…"
const actionsSrc = read('src/config/actions.ts')
const actionIds = [...actionsSrc.matchAll(/\{ id: '([a-z0-9-]+)'/g)].map((m) => m[1])
check(actionIds.length >= 20 && new Set(actionIds).size === actionIds.length, `src/config/actions.ts lists each action once (${actionIds.length})`)
const appSrc = read('src/App.tsx')
const commandIds = [...appSrc.matchAll(/list\.push\(\{\s*id: [`']([a-z0-9]+(?:-[a-z0-9]+)*)/g)].map((m) => m[1])
check(commandIds.length >= 20, `the palette commands are found in App.tsx (${commandIds.length})`)
for (const id of commandIds) {
  const family = id.includes('-') ? id.slice(0, id.indexOf('-')) : id
  check(actionIds.includes(id) || actionIds.includes(family), `the palette command "${id}" has a place in src/config/actions.ts`)
}
const controls = sources.filter((s) => s !== actionsSrc)
for (const id of actionIds) check(controls.some((s) => s.includes(`data-action="${id}"`)), `the action "${id}" has a control marked data-action="${id}"`)

// the abort: Unitree's own g1_ctrl stops on LT+B only; p is a keyboard abort that only some builds have, so it is never given alone
// or first (the type-6 procedure is written for a build that has it, so it is not checked here)
for (const [f, text] of [
  ['src/components/Tour.tsx', read('src/components/Tour.tsx').match(/'The real abort[^']*(?:\\'[^']*)*'/)?.[0] ?? ''],
  ['src/config/alertPolicy.ts', read('src/config/alertPolicy.ts').match(/const ABORT = '([^']*)'/)?.[1] ?? ''],
  ['src/components/AbortChecks.tsx', read('src/components/AbortChecks.tsx').match(/abort \(([^)]*)\)/)?.[1] ?? ''],
  ['src/utils/monitorFormat.ts', read('src/utils/monitorFormat.ts').match(/text: 'Abort from any state:([^']*)'/)?.[1] ?? ''],
]) {
  const ltb = text.search(/LT ?\+ ?B/), p = text.search(/\bp\b/)
  check(ltb >= 0 && (p < 0 || ltb < p) && (p < 0 || /if your/.test(text)), `${f} gives LT+B first and p only for builds that have it ("${text.slice(0, 60)}")`)
}
{
  const safety = readme.match(/## Safety[\s\S]*?(?=\n## )/)?.[0] ?? ''
  const ltb = safety.search(/LT ?\+ ?B/), p = safety.search(/`p`/)
  check(ltb >= 0 && (p < 0 || ltb < p), 'the README\'s Safety section gives LT+B first')
}

// a newcomer's path: the README says what runs where, how to start with Unitree's own g1_ctrl, and what to do when it does not work
for (const [re, what] of [
  [/^## Quick start$/m, 'a Quick start section'],
  [/^## Troubleshooting$/m, 'a Troubleshooting section'],
  [/\*\*Supported:\*\* Ubuntu 22\.04 with Python 3\.10\. Tested in Chrome\./, 'the supported platform line'],
  [/roco demo/, 'roco demo'],
  [/--deploy-dir/, '--deploy-dir'],
  [/g1_ctrl --network=lo 2>&1 \| tee \.\.\/log\/log\.txt/, 'running g1_ctrl through tee into the log ROCO reads'],
  [/\]\(docs\/recording-format\.md\)/, 'a link to docs/recording-format.md'],
  [/ssh -L 8765:127\.0\.0\.1:8765/, 'the SSH tunnel for watching from another PC'],
]) check(re.test(readme), `the README has ${what}`)
// the tee line must write the file the bridge reads by default (deploy/robots/g1/log/log.txt, run from deploy/robots/g1/build)
check(/"ctrl_log": os\.path\.join\(root, "robots\/g1\/log\/log\.txt"\)/.test(read('scripts/roco_dds_bridge.py')), 'the bridge reads robots/g1/log/log.txt, as the README\'s tee line writes')
check(/cd .*deploy\/robots\/g1\/build|in `~\/unitree_rl_mjlab\/deploy\/robots\/g1\/build`/.test(readme), 'the README says where to run g1_ctrl from')
const recFormat = existsSync(join(root, 'docs/recording-format.md')) ? read('docs/recording-format.md') : ''
check(recFormat.length > 0, 'docs/recording-format.md exists')
// every column the replay needs is documented, and is still one the bridge reads
const bridgeSrc = read('scripts/roco_dds_bridge.py')
for (const c of ['unix_t', 'tick', 'mode_pr', 'mode_machine', 'quat_w', 'gyro_x', 'acc_x', 'rpy_r', 'tau_est', 'temp0_', 'temp1_', 'vol_', 'motorstate_']) {
  check(recFormat.includes('`' + c) && bridgeSrc.includes(`"${c}"`), `docs/recording-format.md documents the column ${c}, which the bridge reads`)
}
check(meta('referrer') === 'no-referrer', 'index.html sends no referrer (a bridge token never leaks in one)')

console.log(`meta: ${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
