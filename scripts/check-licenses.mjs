#!/usr/bin/env node
// Licence allow-list for everything ROCO installs. Two uses:
//   node scripts/check-licenses.mjs [--lock FILE] [--pyproject FILE]   in npm run lint: every package in package-lock.json, and every
//                                                                      Python dependency in pyproject.toml, has a licence on the list
//   node scripts/check-licenses.mjs --self-test                         run by npm run lint: the checker itself catches what it should
// A licence is an SPDX expression. OR passes when any side passes, AND when both do. A missing licence, UNLICENSED, or anything
// not on the list (GPL, LGPL, AGPL, SSPL, BUSL and others) fails. To allow a new licence, add it here in a reviewed change.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

export const ALLOWED = new Set(['MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'MPL-2.0', 'BlueOak-1.0.0',
  'CC0-1.0', 'Unlicense'])
// Licences that are fine for the Python side only (they come from PyPI metadata, not npm).
export const ALLOWED_PYTHON = new Set([...ALLOWED, 'Python-2.0', 'PSF-2.0', 'Zlib', 'EPL-2.0'])

// The licence of each Python dependency, read from the package's own metadata and LICENSE file (2026-11-14). A dependency that
// pyproject.toml names but this table does not is an error, so the table cannot fall behind.
export const PYTHON_LICENCES = {
  numpy: 'BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0',   // newer wheels bundle code under these too
  pyyaml: 'MIT',
  cyclonedds: 'EPL-2.0 OR BSD-3-Clause',                            // its LICENSE: EPL-2.0 or the Eclipse Distribution License 1.0
}

/** Whether an SPDX expression passes the allow-list: OR needs one side, AND needs both, parentheses group. Malformed text fails. */
export function allowed(spdx, list = ALLOWED) {
  if (typeof spdx !== 'string') return false
  const tokens = spdx.match(/\(|\)|[^\s()]+/g) ?? []
  let i = 0
  const atom = () => {
    const t = tokens[i++]
    if (t === '(') { const v = or(); if (tokens[i++] !== ')') throw new Error('unbalanced'); return v }
    if (t === undefined || t === ')' || /^(AND|OR|WITH)$/.test(t)) throw new Error('bad token')
    return list.has(t.replace(/\+$/, ''))
  }
  const and = () => { let v = atom(); while (tokens[i] === 'AND') { i++; v = atom() && v } return v }
  const or = () => { let v = and(); while (tokens[i] === 'OR') { i++; v = and() || v } return v }
  try {
    const v = or()
    return i === tokens.length && v
  } catch {
    return false
  }
}

/** What is wrong with a package-lock.json (v2 or v3): each entry in `packages` with no licence or one off the list. */
export function npmProblems(lock) {
  const out = []
  const packages = lock?.packages
  if (!packages || typeof packages !== 'object') return ['package-lock.json has no "packages" table (lockfile v2 or v3 is needed)']
  for (const [path, p] of Object.entries(packages)) {
    if (path === '' || p.link) continue           // the project itself, and workspace links
    const name = p.name ?? path.replace(/^.*node_modules\//, '')
    const lic = typeof p.license === 'string' ? p.license.trim() : ''
    if (!lic || lic === 'UNLICENSED') out.push(`${name} ${p.version ?? ''}: no licence`)
    else if (!allowed(lic)) out.push(`${name} ${p.version ?? ''}: licence "${lic}" is not on the allow-list`)
  }
  return out
}

/** The package names in pyproject.toml's [project] dependencies and [project.optional-dependencies], lower case. */
export function pythonDependencies(text) {
  const table = (name) => text.split(new RegExp(`^\\[${name.replace(/\./g, '\\.')}\\]\\s*$`, 'm'))[1]?.split(/^\[/m)[0] ?? ''
  const strings = (s) => [...s.replace(/#.*$/gm, '').matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2])
  const project = table('project')
  const deps = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(project)?.[1] ?? ''
  const optional = table('project.optional-dependencies').split(/^[\w-]+\s*=/m).slice(1).join('\n')
  return [...strings(deps), ...strings(optional)].map((d) => /^[A-Za-z0-9._-]+/.exec(d)?.[0].toLowerCase().replace(/_/g, '-')).filter(Boolean)
}

/** What is wrong with pyproject.toml: a dependency missing from PYTHON_LICENCES, or one whose licence is off the Python list. */
export function pythonProblems(pyprojectText, table = PYTHON_LICENCES) {
  const out = []
  for (const name of new Set(pythonDependencies(pyprojectText))) {
    const lic = table[name]
    if (!lic) out.push(`${name}: a Python dependency with no entry in PYTHON_LICENCES (scripts/check-licenses.mjs); add its licence`)
    else if (!allowed(lic, ALLOWED_PYTHON)) out.push(`${name}: licence "${lic}" is not on the allow-list`)
  }
  return out
}

function selfTest() {
  const lock = (license) => ({ lockfileVersion: 3, packages: { '': { name: 'roco' }, 'node_modules/a': { version: '1.0.0', license } } })
  const py = (deps, extra = '') => `[project]\nname = "x"\ndependencies = [${deps}]\n\n[project.optional-dependencies]\n${extra}\n\n[project.scripts]\nx = "y"\n`
  const results = [
    [allowed('MIT') && allowed('Apache-2.0'), 'a listed licence passes'],
    [!allowed('GPL-3.0') && !allowed('GPL-3.0-only') && !allowed('LGPL-2.1') && !allowed('AGPL-3.0') && !allowed('SSPL-1.0'), 'copyleft and source-available licences fail'],
    [allowed('(MIT OR GPL-3.0)') && allowed('GPL-3.0 OR MIT'), '(MIT OR GPL-3.0) passes'],
    [!allowed('MIT AND GPL-3.0') && allowed('MIT AND ISC'), 'MIT AND GPL-3.0 fails, MIT AND ISC passes'],
    [allowed('(MIT OR GPL-3.0) AND (ISC OR AGPL-3.0)') && !allowed('(MIT OR GPL-3.0) AND GPL-2.0'), 'parentheses group'],
    [!allowed('') && !allowed(undefined) && !allowed('(MIT') && !allowed('MIT OR') && !allowed('MIT ISC'), 'malformed expressions fail'],
    [npmProblems(lock('MIT')).length === 0, 'a lockfile with listed licences passes'],
    [npmProblems(lock('GPL-3.0')).length === 1, 'a synthetic GPL-3.0 package fails'],
    [npmProblems(lock(undefined)).length === 1 && npmProblems(lock('UNLICENSED')).length === 1, 'a missing licence and UNLICENSED fail'],
    [npmProblems({}).length === 1, 'a lockfile with no packages table fails'],
    [pythonProblems(py('"numpy", "pyyaml"', 'dds = ["cyclonedds==0.10.2"]')).length === 0, 'the known Python dependencies pass'],
    [pythonProblems(py('"numpy", "requests>=2"')).some((p) => p.startsWith('requests:')), 'an unknown pyproject dependency fails'],
    [pythonProblems(py('"numpy"', 'extra = ["leftpad"]')).some((p) => p.startsWith('leftpad:')), 'an unknown optional dependency fails'],
    [pythonProblems(py('"a"'), { a: 'GPL-2.0' }).length === 1, 'a Python dependency off the list fails'],
    [pythonDependencies(py('"PyYAML>=6", "zope_interface"')).join() === 'pyyaml,zope-interface', 'names are normalised'],
  ]
  const failed = results.filter(([ok]) => !ok)
  for (const [, what] of failed) console.error('FAIL: ' + what)
  console.log(`check-licenses: ${results.length - failed.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`)
  return failed.length ? 1 : 0
}

function main(argv) {
  const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback }
  const lockPath = opt('--lock', join(root, 'package-lock.json'))
  const pyPath = opt('--pyproject', join(root, 'pyproject.toml'))
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const wrong = [...npmProblems(lock), ...pythonProblems(readFileSync(pyPath, 'utf8'))]
  if (wrong.length) {
    console.error('[check-licenses] FAIL\n[check-licenses] ' + wrong.join('\n[check-licenses] '))
    return 1
  }
  const n = Object.keys(lock.packages).filter((k) => k !== '').length
  console.log(`[check-licenses] ${n} npm packages and ${new Set(pythonDependencies(readFileSync(pyPath, 'utf8'))).size} Python dependencies on the allow-list`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(process.argv.includes('--self-test') ? selfTest() : main(process.argv.slice(2)))
