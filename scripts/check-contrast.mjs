// Checks the colour pairs the page uses against WCAG 2.2, once per theme. Run by `npm run lint`.
// Text needs 4.5:1 (7:1 in the contrast theme); borders of controls, focus rings and plot lines need 3:1.
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8')

function block(selector) {
  const start = css.indexOf(selector + ' {')
  if (start < 0) throw new Error('tokens.css: no block for ' + selector)
  return css.slice(start, css.indexOf('\n}', start))
}
function vars(text) {
  const out = {}
  for (const m of text.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}

const base = vars(block(':root'))
const themes = {
  dark: { level: 4.5, v: base },
  light: { level: 4.5, v: { ...base, ...vars(block(":root[data-theme='light']")) } },
  contrast: { level: 7, v: { ...base, ...vars(block(":root[data-theme='contrast']")) } },
}

function rgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error('not a #rrggbb colour: ' + hex)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function lum(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const HUES = ['accent', 'ok', 'warn', 'crit', 'info', 'demo']
const failures = []
let checked = 0

for (const [name, { level, v }] of Object.entries(themes)) {
  const get = (k) => {
    if (!(k in v)) throw new Error(`${name}: missing --${k}`)
    return v[k]
  }
  const check = (fg, bg, min, what) => {
    const r = ratio(get(fg), get(bg))
    checked++
    if (r < min) failures.push(`${name}: ${what ?? `${fg} on ${bg}`} is ${r.toFixed(2)}:1, needs ${min}:1`)
  }

  // body text on every surface it sits on
  for (const t of ['c-ink', 'c-ink-soft', 'c-ink-muted'])
    for (const bg of ['c-canvas', 'c-surface', 'c-raised', 'c-sunken']) check(t, bg, level)
  for (const t of ['c-ink', 'c-ink-soft']) check(t, 'c-high', level)

  // status text and icons
  for (const h of HUES) {
    for (const bg of ['c-canvas', 'c-surface', 'c-sunken']) {
      check(`c-${h}`, bg, level)
      check(`c-${h}-ink`, bg, level)
    }
    check(`c-${h}-ink`, `c-${h}-soft`, level)
    check(`c-${h}`, `c-${h}-soft`, level)
  }

  // text on filled buttons and banners
  check('c-on-solid', 'c-crit-solid', level)
  check('c-on-accent', 'c-accent-solid', level)
  check('c-on-accent', 'c-info-solid', level)
  check('c-on-accent', 'c-accent', level, 'on-accent on accent (skip link)')

  // non-text: control edges, focus ring
  check('c-line-bold', 'c-surface', 3)
  check('c-line-hot', 'c-surface', 3)
  check('c-focus', 'c-canvas', 3)
  check('c-focus', 'c-surface', 3)
  check('c-focus', 'c-raised', 3)
  if (name === 'contrast') check('c-line', 'c-surface', 3, 'line on surface (contrast theme draws every border)')

  // plots: lines against the canvas background, labels as text
  check('plot-s1', 'plot-surface', 3)
  check('plot-s2', 'plot-surface', 3)
  check('plot-ref', 'plot-surface', 3)
  check('plot-muted', 'plot-surface', level)
  check('plot-text', 'plot-surface', level)
  check('plot-axis', 'plot-surface', name === 'contrast' ? 3 : 1.5, 'plot-axis on plot-surface')
  // 3D view: the floor must read as ground against the sky, and its grid as lines on it, or the robot looks like it floats
  check('scene-floor', 'scene-bg', 1.2, 'scene-floor on scene-bg')
  check('scene-grid-sub', 'scene-floor', 1.3, 'scene-grid-sub on scene-floor')
  get('scene-shadow')
  if (get('plot-surface').toLowerCase() !== get('c-surface').toLowerCase())
    failures.push(`${name}: --plot-surface must equal --c-surface, the plots sit on a panel`)
}

if (failures.length) {
  console.error('Contrast failures:\n' + failures.join('\n'))
  process.exit(1)
}
console.log(`check-contrast: ${checked} pairs pass in ${Object.keys(themes).join(', ')}`)
