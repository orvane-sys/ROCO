#!/usr/bin/env node
// Keeps the release honest. Three uses:
//   node scripts/check-release.mjs                 in npm run lint: the two version numbers agree, the CHANGELOG has an entry for that
//                                                  version, the Python commands point at real code, the wheel's page folder exists
//   node scripts/check-release.mjs --release vX.Y.Z  what .github/workflows/release.yml runs first: the tag is that version, its CHANGELOG
//                                                  entry has a date, and no text a visitor reads still holds the CONTACT_EMAIL placeholder
//   node scripts/check-release.mjs --notes         prints the CHANGELOG entry of the current version (the text of the GitHub release)
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(join(root, p), 'utf8')

/** The version in pyproject.toml's [project] table, or null. */
export function pyprojectVersion(text) {
  const project = text.split(/^\[project\]\s*$/m)[1]?.split(/^\[/m)[0] ?? ''
  return /^version\s*=\s*"([^"]+)"/m.exec(project)?.[1] ?? null
}

/** The CHANGELOG entry for a version: its heading text after the version, and its body. null when there is none. */
export function changelogEntry(text, version) {
  const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\](.*)$`, 'm')
  const m = heading.exec(text)
  if (!m) return null
  const rest = text.slice(m.index + m[0].length)
  const end = rest.search(/^## \[/m)
  return { heading: m[1].trim(), body: (end < 0 ? rest : rest.slice(0, end)).trim() }
}

/** A dated entry reads "- 2026-11-20"; "- Unreleased" or no date is not releasable. */
export const hasDate = (heading) => /^-\s*\d{4}-\d{2}-\d{2}$/.test(heading)

/** True when a text still holds the placeholder for the project's contact address. */
export const hasPlaceholder = (text) => /CONTACT_EMAIL/.test(text)

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const pkg = JSON.parse(read('package.json'))
  const py = read('pyproject.toml')
  const log = read('CHANGELOG.md')
  const version = pkg.version

  if (args.includes('--notes')) {
    const e = changelogEntry(log, version)
    if (!e) {
      console.error(`CHANGELOG.md has no entry for ${version}`)
      process.exit(1)
    }
    console.log(e.body)
    process.exit(0)
  }

  let failed = 0
  let passed = 0
  const check = (ok, what) => {
    if (ok) passed++
    else {
      failed++
      console.error('FAIL: ' + what)
    }
  }

  // the helpers, on small texts, so a wrong regular expression shows up here and not on release day
  check(pyprojectVersion('[build-system]\nrequires = []\n\n[project]\nname = "x"\nversion = "1.2.3" # c\n\n[tool.x]\nversion = "9"\n') === '1.2.3', 'self-test: reads the version of the [project] table')
  const sample = '# Changelog\n\n## [1.0.0] - 2026-01-02\n\nfirst\n\n### Added\n- a\n\n## [0.9.0] - Unreleased\n\nold\n'
  check(changelogEntry(sample, '1.0.0')?.body.startsWith('first') && !changelogEntry(sample, '1.0.0')?.body.includes('old'), 'self-test: an entry ends at the next one')
  check(changelogEntry(sample, '1.0')=== null && changelogEntry(sample, '2.0.0') === null, 'self-test: only the exact version matches')
  check(changelogEntry(sample, '1.0.0+') === null && changelogEntry(sample, '1.0.0|0.9.0') === null && changelogEntry(sample, '1.(0') === null && changelogEntry('## [1.0.0+b] - 2026-01-02\n\nbuild\n', '1.0.0+b')?.body === 'build', 'self-test: a version is matched as plain text, not as a pattern')
  check(hasDate('- 2026-01-02') && !hasDate('- Unreleased') && !hasDate(''), 'self-test: a date is told from "Unreleased"')
  check(hasPlaceholder('write to **CONTACT_EMAIL**.') && !hasPlaceholder('write to a@b.org'), 'self-test: the placeholder is found')

  check(/^\d+\.\d+\.\d+$/.test(version), `package.json has a plain x.y.z version (${version})`)
  check(pyprojectVersion(py) === version, `pyproject.toml and package.json have the same version (${pyprojectVersion(py)} and ${version})`)
  const entry = changelogEntry(log, version)
  check(entry !== null && entry.body.length > 40, `CHANGELOG.md has an entry for ${version}`)
  check(/\[project\.scripts\][^[]*roco\s*=\s*"roco_launcher:main"[^[]*roco-dds-bridge\s*=\s*"roco_dds_bridge:main"/.test(py), 'pyproject.toml installs the commands roco and roco-dds-bridge')
  check(/^def main\(/m.test(read('scripts/roco_launcher.py')) && /^def main\(/m.test(read('scripts/roco_dds_bridge.py')), 'both commands point at a main() that exists')
  check(/py-modules\s*=\s*\[([^\]]*)\]/.exec(py)?.[1].match(/"([^"]+)"/g)?.every((m) => existsSync(join(root, 'scripts', m.slice(1, -1) + '.py'))), 'every module the wheel lists exists in scripts/')
  check(existsSync(join(root, 'scripts/roco_page/__init__.py')), 'scripts/roco_page/__init__.py exists (the folder the release copies the page into)')
  const links = [...read('README.md').matchAll(/releases\/download\/v([\d.]+)\/roco-([\d.]+)-py3-none-any\.whl/g)]
  check(links.length > 0 && links.every((m) => m[1] === version && m[2] === version), `the wheel links in the README name ${version}`)
  const dds = /^dds\s*=\s*\[([^\]]*)\]/m.exec(py)?.[1] ?? ''
  check(/cyclonedds/.test(dds) && !/unitree/.test(dds), 'the dds extra names cyclonedds and not unitree_sdk2py (a pip build of that one is broken)')
  const pin = /cyclonedds==([\d.]+)/.exec(dds)?.[1]
  check(pin && read('.github/workflows/ci.yml').includes(`cyclonedds==${pin}`), `the dds extra and CI pin the same cyclonedds (${pin}), the one unitree_sdk2py requires`)
  check(existsSync(join(root, '.github/workflows/release.yml')) && /check-release\.mjs --release/.test(read('.github/workflows/release.yml')), 'release.yml runs this check with --release before it publishes')
  const rel = read('.github/workflows/release.yml')
  const publish = rel.split(/^\s*- name: Publish the release$/m)[1] ?? ''
  check(/uses: actions\/attest@/.test(rel) && /subject-checksums: SHA256SUMS/.test(rel) && /id-token: write/.test(rel) && /attestations: write/.test(rel) && /^\s*if: github\.event_name == 'push'$/m.test(publish.split(/^\s*- /m)[0]) && /gh release create[^]*?\bSHA256SUMS\b[^]*?--verify-tag/.test(publish), 'release.yml attests the files in SHA256SUMS, publishes SHA256SUMS, and publishes only on a pushed tag (a run by hand is a dry run)')
  check(/^on:[^]*?workflow_dispatch:/m.test(rel), 'release.yml can be run by hand as a dry run')
  check(/sha256sum -c/.test(read('README.md')) && /gh attestation verify .*--repo orvane-sys\/ROCO/.test(read('README.md')), 'the README says how to check a downloaded wheel (SHA256SUMS and the attestation)')

  const i = args.indexOf('--release')
  if (i >= 0) {
    const tag = args[i + 1] ?? ''
    check(tag === `v${version}`, `the tag is v${version} (is "${tag}")`)
    check(entry !== null && hasDate(entry.heading), `the CHANGELOG entry for ${version} has a date, not "Unreleased" (heading says "${entry?.heading ?? ''}")`)
    // the placeholder may sit in any text file a visitor reads: a Markdown file or a GitHub template
    const walk = (dir) =>
      readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? (['node_modules', 'dist', '.git'].includes(d.name) ? [] : walk(join(dir, d.name))) : /\.(md|ya?ml)$/.test(d.name) ? [join(dir, d.name)] : [],
      )
    const files = [...walk('.github'), ...readdirSync(root).filter((f) => /\.md$/.test(f)), ...walk('docs')]
    // only those texts count: this script names the placeholder in order to look for it, so a Markdown or yml file must not
    for (const f of files) check(!hasPlaceholder(read(f)), `${f} no longer holds the CONTACT_EMAIL placeholder`)
  }

  console.log(`check-release: ${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
