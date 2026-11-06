#!/usr/bin/env node
// Developer step, run by hand when a Unitree mesh changes: turns the STL meshes the shipped URDFs use into small GLB files.
//   node scripts/pack-meshes.mjs          writes public/models/g1_description/meshes_glb/<name>.glb
//   node scripts/pack-meshes.mjs --check  makes no file; fails when a URDF's STL has no GLB twin (used by npm run lint; file times are no use in a fresh clone)
//
// The STL files stay: they are Unitree's source (BSD-3, see the LICENSE next to them), tools/sim-drive reads them, and the page
// falls back to them for any robot that has no GLB. Each GLB is the same triangles, flat normals kept, quantized to 14 bits and
// meshopt compressed by gltfpack. The hands are also simplified to about 10 % of their triangles: they are drawn a few pixels
// wide and carry no limits or contact meaning.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pack } from 'gltfpack'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const modelDir = join(root, 'public', 'models', 'g1_description')
const outDir = join(modelDir, 'meshes_glb')

/**
 * How a mesh is simplified: the share of triangles kept. Only the hands are, to a tenth: they are drawn a few pixels wide.
 * The other meshes keep every triangle. The flat shading of the STL files gives every face its own vertices, so gltfpack's
 * edge-respecting simplifier cannot remove anything from them; the hands need its aggressive mode (-sa), and the limit links
 * and shells are not worth the change of look.
 */
export function simplify(name) {
  return /hand/i.test(name) ? { ratio: 0.1, aggressive: true } : { ratio: 1, aggressive: false }
}

/** The STL files the URDFs listed in robotRegistry.ts use, as meshes/<name>.STL basenames. */
export function usedMeshes() {
  const registry = readFileSync(join(root, 'src', 'config', 'robotRegistry.ts'), 'utf8')
  const urdfs = [...new Set([...registry.matchAll(/\$\{URDF_ROOT\}([\w.-]+\.urdf)/g)].map((m) => m[1]))]
  const names = new Set()
  for (const urdf of urdfs) {
    const text = readFileSync(join(modelDir, urdf), 'utf8')
    for (const m of text.matchAll(/filename\s*=\s*["']meshes\/([^"']+\.stl)["']/gi)) names.add(m[1])
  }
  return [...names].sort()
}

export const glbName = (stl) => stl.replace(/\.stl$/i, '.glb')

/** Reads a binary STL: [80 header][u32 n][n x (12 normal, 36 vertices, 2 attr)]. Returns flat position and normal arrays. */
function readStl(buf) {
  const n = buf.readUInt32LE(80)
  if (buf.length !== 84 + n * 50) throw new Error('not a binary STL (ASCII STL is not supported here)')
  const pos = new Float32Array(n * 9)
  const nor = new Float32Array(n * 9)
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50
    let nx = buf.readFloatLE(o)
    let ny = buf.readFloatLE(o + 4)
    let nz = buf.readFloatLE(o + 8)
    for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) pos[i * 9 + v * 3 + k] = buf.readFloatLE(o + 12 + v * 12 + k * 4)
    // a zero facet normal is common in STL files: take it from the winding instead
    if (nx === 0 && ny === 0 && nz === 0) {
      const p = pos.subarray(i * 9, i * 9 + 9)
      const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2]
      const bx = p[6] - p[0], by = p[7] - p[1], bz = p[8] - p[2]
      nx = ay * bz - az * by
      ny = az * bx - ax * bz
      nz = ax * by - ay * bx
    }
    const len = Math.hypot(nx, ny, nz) || 1
    for (let v = 0; v < 3; v++) {
      nor[i * 9 + v * 3] = nx / len
      nor[i * 9 + v * 3 + 1] = ny / len
      nor[i * 9 + v * 3 + 2] = nz / len
    }
  }
  return { pos, nor }
}

/** A minimal GLB: one mesh, one node, POSITION and NORMAL, no indices, no material. */
function writeGlb({ pos, nor }) {
  const count = pos.length / 3
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i * 3 + k])
      max[k] = Math.max(max[k], pos[i * 3 + k])
    }
  }
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(nor.buffer)])
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: nor.byteLength, target: 34962 },
    ],
    buffers: [{ byteLength: bin.length }],
  }
  const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)])
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20)
  const binChunk = pad(bin, 0)
  const head = Buffer.alloc(12)
  head.writeUInt32LE(0x46546c67, 0) // 'glTF'
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8)
  const chunkHead = (len, type) => {
    const h = Buffer.alloc(8)
    h.writeUInt32LE(len, 0)
    h.writeUInt32LE(type, 4)
    return h
  }
  return Buffer.concat([head, chunkHead(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHead(binChunk.length, 0x004e4942), binChunk])
}

async function packOne(name) {
  const stl = readFileSync(join(modelDir, 'meshes', name))
  const mesh = readStl(stl)
  const files = { 'in.glb': writeGlb(mesh) }
  const iface = {
    read: (p) => {
      if (!files[p]) throw new Error('no file ' + p)
      return files[p]
    },
    write: (p, data) => {
      files[p] = data
    },
  }
  const { ratio, aggressive } = simplify(name)
  const args = ['-i', 'in.glb', '-o', 'out.glb', '-c', ...(ratio < 1 ? ['-si', String(ratio), ...(aggressive ? ['-sa'] : [])] : [])]
  const log = await pack(args, iface)
  if (process.env.PACK_LOG) console.log(log)
  return Buffer.from(files['out.glb'])
}

const check = process.argv.includes('--check')
if (import.meta.url === `file://${process.argv[1]}`) {
  const names = usedMeshes()
  let bad = 0
  let stlBytes = 0
  let glbBytes = 0
  if (!check) mkdirSync(outDir, { recursive: true })
  for (const name of names) {
    const src = join(modelDir, 'meshes', name)
    const dst = join(outDir, glbName(name))
    stlBytes += statSync(src).size
    if (check) {
      if (!existsSync(dst)) {
        console.error(`FAIL: ${glbName(name)} is missing, run node scripts/pack-meshes.mjs`)
        bad++
      } else if (readFileSync(dst).readUInt32LE(0) !== 0x46546c67) {
        console.error(`FAIL: ${glbName(name)} is not a GLB file`)
        bad++
      } else glbBytes += statSync(dst).size
      continue
    }
    const out = await packOne(name)
    writeFileSync(dst, out)
    glbBytes += out.length
    console.log(`${name.padEnd(34)} ${(statSync(src).size / 1024).toFixed(0).padStart(6)} kB -> ${(out.length / 1024).toFixed(0).padStart(5)} kB`)
  }
  if (!check) {
    const stale = readdirSync(outDir).filter((f) => !names.some((n) => glbName(n) === f))
    if (stale.length) console.log('not used by any URDF any more (delete by hand): ' + stale.join(', '))
  }
  console.log(`${names.length} meshes: ${(stlBytes / 1048576).toFixed(1)} MB STL -> ${(glbBytes / 1048576).toFixed(2)} MB GLB`)
  if (bad) process.exit(1)
}
