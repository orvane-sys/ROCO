#!/usr/bin/env node
// Post-build step: keep only the robot model files the app can actually request.
//
// `public/models` is copied verbatim into `dist/`, but the dashboard only fetches the URDFs listed in
// src/config/robotRegistry.ts and the meshes those URDFs reference. Variant URDFs, MJCF files (used by
// scripts/mujoco_roco_bridge.py straight from public/), hand models, images and notebooks are not needed
// in the shipped bundle. Source files in public/ are never touched.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const modelDir = join(root, 'dist', 'models', 'g1_description')

if (!existsSync(modelDir)) {
  console.log('[prune-models] dist/models/g1_description not found; nothing to prune.')
  process.exit(0)
}

const registrySrc = readFileSync(join(root, 'src', 'config', 'robotRegistry.ts'), 'utf8')
const urdfs = [...new Set([...registrySrc.matchAll(/\$\{URDF_ROOT\}([\w.-]+\.urdf)/g)].map((m) => m[1]))]
if (urdfs.length === 0) {
  console.error('[prune-models] No URDFs found in robotRegistry.ts; refusing to prune.')
  process.exit(1)
}

const keep = new Set()
keep.add(resolve(join(modelDir, 'LICENSE'))) // BSD-3: Unitree's notice must ship with their models
const missing = []
for (const urdf of urdfs) {
  const file = join(modelDir, urdf)
  if (!existsSync(file)) {
    missing.push(urdf)
    continue
  }
  keep.add(resolve(file))
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/filename\s*=\s*["']([^"']+)["']/g)) {
    const ref = m[1].replace(/^package:\/\/[^/]+\//, '').replace(/^\.\//, '')
    const mesh = resolve(modelDir, ref)
    if (existsSync(mesh)) keep.add(mesh)
    else missing.push(`${urdf} -> ${ref}`)
  }
}
if (missing.length > 0) {
  console.error('[prune-models] Referenced files missing from dist:\n  ' + missing.join('\n  '))
  process.exit(1)
}

const sizeOf = (dir) => {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? sizeOf(p) : statSync(p).size
  }
  return total
}
const before = sizeOf(modelDir)

let removed = 0
const prune = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      prune(p)
      if (readdirSync(p).length === 0) rmSync(p, { recursive: true })
    } else if (!keep.has(resolve(p))) {
      rmSync(p)
      removed++
    }
  }
}
prune(modelDir)

const after = sizeOf(modelDir)
const mb = (n) => (n / 1048576).toFixed(1)
console.log(
  `[prune-models] kept ${keep.size} files (${urdfs.length} URDFs), removed ${removed}; ` +
    `${mb(before)} MB -> ${mb(after)} MB (${relative(root, modelDir)})`
)
