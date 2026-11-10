#!/usr/bin/env node
// Post-build step: finishes the licence notices that ship with the page, and fails the build when one is missing.
//
// Vite's build.license writes dist/THIRD-PARTY-LICENSES.md, but it knows only the packages it bundled and the licence files they
// carry. Three things fall through, so this adds them: urdf-loader's npm package has no licence file; three.js's copy of the
// meshoptimizer decoder has its own copyright; Tailwind's base styles are in the CSS. ROCO's own LICENSE goes next to the page too.
//
//   node scripts/add-licenses.mjs               run by npm run build, on dist/
//   node scripts/add-licenses.mjs --self-test   run by npm run lint, needs no dist/
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(join(root, p), 'utf8')
const NOTICES = 'dist/THIRD-PARTY-LICENSES.md'

/** The sections of the notices file: { heading: "three - 0.186.1 (MIT)", name: "three", licence: "MIT", body }. */
export function sections(text) {
  return text.split(/^## /m).slice(1).map((part) => {
    const heading = part.split('\n', 1)[0].trim()
    return {
      heading,
      name: heading.split(' ', 1)[0],
      licence: /\(([^)]*)\)$/.exec(heading)?.[1] ?? '',
      body: part.slice(part.indexOf('\n') + 1).trim(),
    }
  })
}

/** What is wrong with a notices file: a package the page depends on with no section, a section with no text, or a copyleft licence. */
export function problems(text, dependencies) {
  const found = sections(text)
  const out = []
  for (const name of dependencies) if (!found.some((s) => s.name === name)) out.push(`${name} has no section`)
  for (const s of found) {
    if (s.body.length < 200) out.push(`${s.heading} has no licence text`)
    if (/GPL/i.test(s.licence)) out.push(`${s.heading} is copyleft: decide before shipping it`)
  }
  return out
}

/** Puts a note and the Apache-2.0 text under each Apache-2.0 section that came with none. */
export function fillApache(text, apacheText, noteFor) {
  return text.replace(/^## (\S+) - \S+ \(Apache-2\.0\)\n+(?=## |$(?![\s\S]))/gm, (m, name) => `${m.trimEnd()}\n\n${noteFor(name)}\n\n${apacheText.trim()}\n\n`)
}

function selfTest() {
  const text = 'x'.repeat(200)
  const good = `# Licenses\n\n## a - 1.0.0 (MIT)\n\n${text}\n\n## b - 2.0.0 (ISC)\n\n${text}\n`
  const results = [
    [sections(good).length === 2 && sections(good)[1].licence === 'ISC', 'sections are read'],
    [problems(good, ['a', 'b']).length === 0, 'a complete file passes'],
    [problems(good, ['a', 'c']).join() === 'c has no section', 'a dependency with no section is caught'],
    [problems('## a - 1.0.0 (MIT)\n\nshort\n', ['a']).length === 1, 'a section with no text is caught'],
    [problems(`## a - 1.0.0 (GPL-3.0)\n\n${text}\n`, ['a']).some((p) => p.includes('copyleft')), 'a copyleft licence is caught'],
    [problems(`## a - 1.0.0 (LGPL-2.1)\n\n${text}\n`, ['a']).some((p) => p.includes('copyleft')), 'LGPL is caught too'],
  ]
  const filled = fillApache(`## u - 1.0.0 (Apache-2.0)\n\n## v - 1.0.0 (MIT)\n\n${text}\n\n## w - 1.0.0 (Apache-2.0)\n`, 'APACHE', (n) => `note ${n}`)
  const parts = sections(filled)
  results.push([parts[0].body === 'note u\n\nAPACHE' && parts[1].body === text && parts[2].body === 'note w\n\nAPACHE', 'empty Apache-2.0 sections are filled, others left alone'])
  const kept = `## u - 1.0.0 (Apache-2.0)\n\n${text}\n`
  results.push([fillApache(kept, 'APACHE', () => 'n') === kept, 'an Apache-2.0 section with its own text is left alone'])
  const failed = results.filter(([ok]) => !ok)
  for (const [, what] of failed) console.error('FAIL: ' + what)
  console.log(`licences: ${results.length - failed.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`)
  return failed.length ? 1 : 0
}

function main() {
  const file = join(root, NOTICES)
  if (!existsSync(file)) {
    console.error(`[add-licenses] ${NOTICES} is missing: check build.license in vite.config.ts`)
    return 1
  }
  const pkg = JSON.parse(read('package.json'))
  const apache = read('LICENSE')
  // the copyright of urdf-loader is only in its README
  const urdfNotice = /^Copyright ©[\s\S]*?written permission\.$/m.exec(read('node_modules/urdf-loader/README.md'))?.[0]
  if (!urdfNotice) {
    console.error('[add-licenses] the copyright text is gone from urdf-loader\'s README: find it and update this script')
    return 1
  }
  writeFileSync(file, fillApache(readFileSync(file, 'utf8'), apache, (name) =>
    `The ${name} package carries no licence file. Its package.json gives Apache-2.0, and its README says:\n\n${urdfNotice}`))

  const add = (name, heading, note, licence) => {
    if (!sections(readFileSync(file, 'utf8')).some((s) => s.name === name)) appendFileSync(file, `\n## ${heading}\n\n${note}\n\n${licence.trim()}\n`)
  }
  const tailwind = JSON.parse(read('node_modules/tailwindcss/package.json'))
  add('tailwindcss', `tailwindcss - ${tailwind.version} (MIT)`, 'Its base styles are in the page\'s CSS.', read('node_modules/tailwindcss/LICENSE'))
  // gltfpack is part of meshoptimizer and carries the same licence
  add('meshoptimizer', 'meshoptimizer - decoder inside three (MIT)', 'three.js includes this decoder, which reads the robot\'s meshes.', read('node_modules/gltfpack/LICENSE.md'))
  copyFileSync(join(root, 'LICENSE'), join(root, 'dist/LICENSE'))

  const text = readFileSync(file, 'utf8')
  const wrong = problems(text, Object.keys(pkg.dependencies))
  if (wrong.length) {
    console.error('[add-licenses] ' + wrong.join('\n[add-licenses] '))
    return 1
  }
  console.log(`[add-licenses] ${sections(text).length} packages in THIRD-PARTY-LICENSES.md, LICENSE copied`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(process.argv.includes('--self-test') ? selfTest() : main())
