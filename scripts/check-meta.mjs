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
