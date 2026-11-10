// Checks what a visitor sees before the app runs (index.html: title, description, icons, browser bar colour), that no unused
// file sits in public/ or src/assets/, and that every tour step points at a part of the page that exists.
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

console.log(`meta: ${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
