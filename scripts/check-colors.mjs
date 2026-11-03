// Fails when a component uses a raw palette colour instead of a token from src/styles/tokens.css.
// Run by `npm run lint`.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('../src', import.meta.url).pathname
const PALETTE = /(?<![\w-])(?:bg|text|border(?:-[trblxyse])?|ring|shadow|divide|placeholder|from|to|via|outline|fill|stroke|accent|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{2,3})?(?![\w-])/g
const ARBITRARY = /(?<![\w-])(?:bg|text|border|ring|shadow|from|to|via|fill|stroke)-\[(?:#|rgb|hsl|oklch)/g
const HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|0x[0-9a-fA-F]{6}\b/g
// importer/codec parsers carry numbers that merely look like hex; the token file is the one place for colours
const SKIP = new Set(['styles/tokens.css', 'assets'])
const ALLOW_HEX = /^(utils\/|services\/(telemetryStream|g1Gait|plotRing))/

const bad = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = relative(root, full)
    if (SKIP.has(rel) || SKIP.has(name)) continue
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.(tsx?|css|html)$/.test(name)) check(full, rel)
  }
}
function check(full, rel) {
  const lines = readFileSync(full, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (line.includes('colour-ok:')) return // lighting etc. that is deliberately the same in every theme
    const code = line.replace(/\/\/.*$/, '')
    for (const re of [PALETTE, ARBITRARY]) for (const m of code.matchAll(re)) bad.push(`${rel}:${i + 1}  ${m[0]}`)
    if (!ALLOW_HEX.test(rel)) for (const m of code.matchAll(HEX)) bad.push(`${rel}:${i + 1}  ${m[0]} (use a --plot-/--scene- token)`)
  })
}
walk(root)
if (bad.length) {
  console.error('Raw colours found; use the semantic tokens in src/styles/tokens.css:\n' + bad.join('\n'))
  process.exit(1)
}
console.log('check-colors: no raw palette colours in src/')
