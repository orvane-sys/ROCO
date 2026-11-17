#!/usr/bin/env node
// Imports each corpus model with the page's own importer (in headless Chrome) and compares what it read with the reference tools'
// record from tools/corpus/reference.py: did it load, are the joints' names, types, axes and limits the same, and is every link
// within 1e-5 m and 1e-5 rad of the reference with every joint at zero.
//
//   node scripts/check-import-corpus.mjs [--only NAME ...] [--ci] [--cache DIR] [--out FILE] [--report-only]
//   node scripts/check-import-corpus.mjs --sdf DIR [--only NAME ...]   SDF: each URDF model through gz sdf -p into DIR
//   node scripts/check-import-corpus.mjs --self-test          the comparison itself, no browser
//
// Run tools/corpus/fetch.py and reference.py first. With no corpus cache it says so and exits 0, unless --ci is given (CI fetches
// the subset first, so a missing cache there is an error). --report-only prints the table and always exits 0 (used for the v1
// baseline); otherwise any target missed exits 1. The model folder is handed to the importer as a folder drop would hand it.
//
// --sdf (stage 1.1 P4, local only, skipped when gz is absent): Gazebo's `gz sdf -p` turns each URDF model into SDF in DIR (never the
// cache), the SDF is added to the model folder as its main file, and the import is compared with the URDF reference. gz lumps links
// joined by fixed joints into their parent and leaves out links with no mass, so only the links and joints the SDF still has are
// compared; the rest are counted. gz writes about 6 significant digits, so the tolerances are SDF_TOL.
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
export const POS_TOL = 1e-5
export const ROT_TOL = 1e-5
const AXIS_TOL = 1e-6
const LIMIT_TOL = 1e-6
const TOL = { pos: POS_TOL, rot: ROT_TOL, axis: AXIS_TOL, limit: LIMIT_TOL }
/**
 * gz sdf -p writes about 6 significant digits. Measured on the corpus URDFs (2026-11-16): poses within 2.0e-6 m and 6.9e-6 rad and
 * axes exact, so those keep the URDF tolerances; limits off by up to 5.0e-6, so the limit tolerance is 1e-5.
 */
export const SDF_TOL = { ...TOL, limit: 1e-5 }
/** The models CI checks (stage 1.1 decision P6): small, and every format the subset can cover. */
export const CI_SUBSET = ['jvrc1', 'skydio_x2', 'upkie', 'go2', 'h1']
export const LOAD_TARGET = 0.95

const norm = (v) => {
  const n = Math.hypot(...v)
  return n > 0 ? v.map((c) => c / n) : v
}
const close = (a, b, tol) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol)

/**
 * The angle between two rotations given as quaternions [w, x, y, z]. atan2 of the relative rotation's parts, not acos of their dot
 * product: acos is ill-conditioned near 1, so rounding the reference to 9 decimals read as 5e-5 rad there.
 */
export function rotationBetween(a, b) {
  const [aw, ax, ay, az] = a
  const [bw, bx, by, bz] = b
  // conj(a) * b
  const w = aw * bw + ax * bx + ay * by + az * bz
  const x = aw * bx - ax * bw - ay * bz + az * by
  const y = aw * by + ax * bz - ay * bw - az * bx
  const z = aw * bz - ax * by + ay * bx - az * bw
  return 2 * Math.atan2(Math.hypot(x, y, z), Math.abs(w))
}

/** The URDF joint type an importer should give for a reference joint, and whether that type is only an approximation. */
export function expectedType(ref, format) {
  if (format !== 'mjcf') return { type: ref.type, approx: false }
  switch (ref.type) {
    case 'hinge': return { type: ref.range ? 'revolute' : 'continuous', approx: false }
    case 'slide': return { type: 'prismatic', approx: false }
    case 'free': return { type: 'floating', approx: false }
    case 'ball': return { type: 'fixed', approx: true }       // stage 1.1 P5: shown fixed and flagged
    default: return { type: ref.type, approx: false }
  }
}

/** Compares one model's import with its reference. Pure, so --self-test can check it. */
export function compareModel(ref, got, tol = TOL) {
  const out = { name: ref.name, format: ref.format, loaded: !!got?.ok, error: got?.ok ? undefined : got?.error ?? 'no result',
    joints: 0, jointProblems: [], approx: [], unnamed: 0, poses: 0, poseProblems: [], worstPos: 0, worstRot: 0, worstAxis: 0, worstLimit: 0 }
  if (!ref.ok) {
    out.error = 'reference not ok: ' + ref.reason
    out.loaded = false
    return out
  }
  if (!got?.ok) return out
  for (const rj of ref.joints ?? []) {
    if (!rj.name) {
      out.unnamed++
      continue
    }
    out.joints++
    const gj = got.joints?.[rj.name]
    if (!gj) {
      out.jointProblems.push(`${rj.name}: missing`)
      continue
    }
    const { type, approx } = expectedType(rj, ref.format)
    if (gj.type !== type) {
      out.jointProblems.push(`${rj.name}: type ${gj.type}, expected ${type}`)
      continue
    }
    if (approx) out.approx.push(`${rj.name}: ${rj.type} shown as ${type}`)
    const axisOff = Math.max(...gj.axis.map((c, i) => Math.abs(c - norm(rj.axis)[i])))
    if (['revolute', 'continuous', 'prismatic'].includes(type)) out.worstAxis = Math.max(out.worstAxis, axisOff)
    if (['revolute', 'continuous', 'prismatic'].includes(type) && !close(gj.axis, norm(rj.axis), tol.axis)) {
      out.jointProblems.push(`${rj.name}: axis ${gj.axis.map((c) => c.toFixed(6))}, expected ${norm(rj.axis).map((c) => c.toFixed(6))}`)
    }
    const lim = ref.format === 'mjcf' ? rj.range : rj.limit
    if (lim && ['revolute', 'prismatic'].includes(type)) out.worstLimit = Math.max(out.worstLimit, Math.abs(gj.lower - lim[0]), Math.abs(gj.upper - lim[1]))
    if (lim && ['revolute', 'prismatic'].includes(type) && !close([gj.lower, gj.upper], lim, tol.limit)) {
      out.jointProblems.push(`${rj.name}: limits [${gj.lower}, ${gj.upper}], expected [${lim}]`)
    }
  }
  for (const [link, rp] of Object.entries(ref.poses ?? {})) {
    out.poses++
    const gp = got.poses?.[link]
    if (!gp) {
      out.poseProblems.push(`${link}: missing`)
      continue
    }
    const dp = Math.hypot(...gp.xyz.map((c, i) => c - rp.xyz[i]))
    const dr = rotationBetween(gp.quat, rp.quat)
    out.worstPos = Math.max(out.worstPos, dp)
    out.worstRot = Math.max(out.worstRot, dr)
    if (dp > tol.pos || dr > tol.rot) out.poseProblems.push(`${link}: off by ${dp.toExponential(2)} m, ${dr.toExponential(2)} rad`)
  }
  return out
}

/**
 * The part of a URDF reference that gz's SDF of it still has: the links and joints it names. The rest are counted, fixed joints
 * apart from the others, so the report says what gz left out.
 */
export function sdfReference(ref, sdfText) {
  const names = (tag) => new Set([...sdfText.matchAll(new RegExp(`<${tag}\\s+name=(['"])(.*?)\\1`, 'g'))].map((m) => m[2]))
  const links = names('link')
  const joints = names('joint')
  const kept = (ref.joints ?? []).filter((j) => joints.has(j.name))
  const left = (ref.joints ?? []).filter((j) => !joints.has(j.name))
  return {
    ref: { ...ref, joints: kept, poses: Object.fromEntries(Object.entries(ref.poses ?? {}).filter(([l]) => links.has(l))) },
    droppedFixed: left.filter((j) => j.type === 'fixed').length,
    droppedOther: left.filter((j) => j.type !== 'fixed').map((j) => j.name),
    droppedLinks: Object.keys(ref.poses ?? {}).filter((l) => !links.has(l)).length,
  }
}

/** Whether a set of comparisons meets the stage 1.1 targets, and why not. */
export function targetsMet(results) {
  const why = []
  const loaded = results.filter((r) => r.loaded).length
  if (results.length && loaded / results.length < LOAD_TARGET) why.push(`${loaded}/${results.length} loaded, target ${LOAD_TARGET * 100}%`)
  for (const r of results) {
    if (!r.loaded) why.push(`${r.name}: did not load (${r.error})`)
    if (r.jointProblems.length) why.push(`${r.name}: ${r.jointProblems.length} joint mismatch(es), first ${r.jointProblems[0]}`)
    if (r.poseProblems.length) why.push(`${r.name}: ${r.poseProblems.length} pose mismatch(es), first ${r.poseProblems[0]}`)
  }
  return { ok: why.length === 0, why }
}

function selfTest() {
  let passed = 0
  let failed = 0
  const check = (ok, what) => (ok ? passed++ : (failed++, console.error('FAIL: ' + what)))
  const id = { xyz: [0, 0, 0], quat: [1, 0, 0, 0] }
  const ref = { name: 'm', format: 'urdf', ok: true,
    joints: [{ name: 'j1', type: 'revolute', axis: [0, 0, 2], limit: [-1, 1] }, { name: 'j2', type: 'fixed', axis: [1, 0, 0], limit: null }],
    poses: { a: id, b: { xyz: [1, 0, 0], quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] } } }
  const got = () => ({ ok: true, joints: { j1: { type: 'revolute', axis: [0, 0, 1], lower: -1, upper: 1 }, j2: { type: 'fixed', axis: [1, 0, 0], lower: 0, upper: 0 } },
    poses: { a: { xyz: [0, 0, 0], quat: [1, 0, 0, 0] }, b: { xyz: [1, 0, 0], quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] } } })
  let r = compareModel(ref, got())
  check(r.loaded && r.jointProblems.length === 0 && r.poseProblems.length === 0 && r.joints === 2 && r.poses === 2, 'an equal import passes')
  check(targetsMet([r]).ok, 'an equal import meets the targets')
  let g = got(); g.joints.j1.axis = [0, 1, 0]
  r = compareModel(ref, g)
  check(r.jointProblems.length === 1 && r.jointProblems[0].startsWith('j1: axis'), 'a wrong axis fails, naming the joint')
  g = got(); g.joints.j1.upper = 1.001
  check(compareModel(ref, g).jointProblems[0]?.startsWith('j1: limits'), 'a wrong limit fails, naming the joint')
  g = got(); g.joints.j1.type = 'continuous'
  check(compareModel(ref, g).jointProblems[0]?.startsWith('j1: type'), 'a wrong type fails')
  g = got(); delete g.joints.j2
  check(compareModel(ref, g).jointProblems[0] === 'j2: missing', 'a missing joint fails')
  g = got(); g.poses.b.xyz = [1, 2e-5, 0]
  r = compareModel(ref, g)
  check(r.poseProblems.length === 1 && r.poseProblems[0].startsWith('b: off by'), 'a link 2e-5 m off fails, naming the link')
  g = got(); g.poses.b.xyz = [1, 5e-6, 0]
  check(compareModel(ref, g).poseProblems.length === 0, 'a link 5e-6 m off passes')
  g = got(); const a = 3e-5; g.poses.a.quat = [Math.cos(a / 2), Math.sin(a / 2), 0, 0]
  check(compareModel(ref, g).poseProblems[0]?.startsWith('a: off by'), 'a link turned 3e-5 rad fails')
  const r9 = (q) => q.map((c) => Math.round(c * 1e9) / 1e9)
  const t = 0.7
  check(rotationBetween([Math.cos(t), Math.sin(t) * 0.6, 0, Math.sin(t) * 0.8], r9([Math.cos(t), Math.sin(t) * 0.6, 0, Math.sin(t) * 0.8])) < 1e-8,
    'a quaternion rounded to 9 decimals reads as the same rotation (no acos error)')
  check(Math.abs(rotationBetween([1, 0, 0, 0], [Math.cos(0.25), 0, Math.sin(0.25), 0]) - 0.5) < 1e-12, 'a 0.5 rad turn reads as 0.5 rad')
  g = got(); g.poses.a.quat = [-1, 0, 0, 0]
  check(compareModel(ref, g).poseProblems.length === 0, 'q and -q are the same rotation')
  g = got(); delete g.poses.b
  check(compareModel(ref, g).poseProblems[0] === 'b: missing', 'a missing link fails')
  r = compareModel(ref, { ok: false, error: 'boom' })
  check(!r.loaded && !targetsMet([r]).ok, 'a model that did not load misses the targets')
  check(!targetsMet([...Array(19)].map(() => compareModel(ref, got())).concat(compareModel(ref, { ok: false }), compareModel(ref, { ok: false }))).ok, '19 of 21 loaded (90%) misses the 95% target')
  const mref = { name: 'm', format: 'mjcf', ok: true, poses: {}, joints: [
    { name: 'h', type: 'hinge', axis: [0, 1, 0], range: [-1, 1] }, { name: 'c', type: 'hinge', axis: [1, 0, 0], range: null },
    { name: 's', type: 'slide', axis: [0, 0, 1], range: [0, 0.1] }, { name: 'f', type: 'free', axis: [0, 0, 1], range: null },
    { name: 'b', type: 'ball', axis: [0, 0, 1], range: null }, { name: null, type: 'hinge', axis: [0, 0, 1], range: null }] }
  const mgot = { ok: true, poses: {}, joints: {
    h: { type: 'revolute', axis: [0, 1, 0], lower: -1, upper: 1 }, c: { type: 'continuous', axis: [1, 0, 0], lower: 0, upper: 0 },
    s: { type: 'prismatic', axis: [0, 0, 1], lower: 0, upper: 0.1 }, f: { type: 'floating', axis: [1, 0, 0], lower: 0, upper: 0 },
    b: { type: 'fixed', axis: [1, 0, 0], lower: 0, upper: 0 } } }
  r = compareModel(mref, mgot)
  check(r.jointProblems.length === 0 && r.approx.length === 1 && r.unnamed === 1, 'MJCF types map to URDF; a ball is an approximation; unnamed joints are counted')
  mgot.joints.b.type = 'revolute'
  check(compareModel(mref, mgot).jointProblems[0]?.startsWith('b: type'), 'negative: a ball shown as revolute fails')
  check(!compareModel({ ...ref, ok: false, reason: 'x' }, got()).loaded, 'a model whose reference failed is not counted as loaded')
  const sdf = "<sdf version='1.7'><model name='m'><link name='a'/><link name=\"b\"/>\n<joint name='j1' type='revolute'/></model></sdf>"
  const sv = sdfReference({ ...ref, joints: [...ref.joints, { name: 'j3', type: 'revolute', axis: [1, 0, 0], limit: [-1, 1] }], poses: { ...ref.poses, c: id } }, sdf)
  check(sv.ref.joints.map((j) => j.name).join() === 'j1' && Object.keys(sv.ref.poses).join() === 'a,b' && sv.droppedFixed === 1 &&
    sv.droppedOther.join() === 'j3' && sv.droppedLinks === 1, 'SDF: only what gz kept is compared; what it left out is counted')
  g = got(); delete g.joints.j1
  check(compareModel(sv.ref, g, SDF_TOL).jointProblems[0] === 'j1: missing', 'negative: a joint the SDF has but the import lacks fails')
  g = got(); g.poses.b.xyz = [1, SDF_TOL.pos * 3, 0]
  check(compareModel(sv.ref, g, SDF_TOL).poseProblems[0]?.startsWith('b: off by'), 'negative: a link 3x the SDF tolerance off fails')
  console.log(`check-import-corpus: ${passed} self-test checks passed${failed ? `, ${failed} FAILED` : ''}`)
  return failed ? 1 : 0
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile()) out.push(p)     // symlinks are not followed: fetch.py already refused any that leave the checkout
  }
  return out
}

async function main(argv) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const only = argv.flatMap((a, i) => (argv[i - 1] === '--only' ? [a] : []))
  const ci = argv.includes('--ci')
  const reportOnly = argv.includes('--report-only')
  const sdfDir = opt('--sdf') && resolve(opt('--sdf'))
  const cache = resolve(opt('--cache') ?? process.env.ROCO_CORPUS_CACHE ?? join(homedir(), '.cache', 'roco-corpus'))
  const lock = JSON.parse(readFileSync(join(root, 'tools/corpus/corpus.lock.json'), 'utf8'))
  let models = lock.models
  const names = ci ? CI_SUBSET : only
  if (names.length) {
    const unknown = names.filter((n) => !models.some((m) => m.name === n))
    if (unknown.length) {
      console.error(`check-import-corpus: unknown model(s) ${unknown.join(', ')}`)
      return 2
    }
    models = models.filter((m) => names.includes(m.name))
  }
  if (sdfDir) {
    if (ci) {
      console.error('check-import-corpus: --sdf is local only (CI has no gz)')
      return 2
    }
    if (spawnSync('gz', ['sdf', '--help'], { stdio: 'ignore', timeout: 30000 }).error) {
      console.log('check-import-corpus: no gz (Gazebo) on PATH; --sdf skipped')
      return 0
    }
    if (sdfDir === cache || sdfDir.startsWith(cache + sep)) {
      console.error('check-import-corpus: --sdf DIR must be outside the corpus cache')
      return 2
    }
    models = models.filter((m) => m.format === 'urdf')
  }
  const slug = (repo) => basename(repo).replace(/\.git$/, '')
  const plan = models.map((m) => {
    const checkout = join(cache, `${slug(m.repo)}-${m.commit.slice(0, 12)}`)
    const dir = m.package === '.' ? checkout : join(checkout, m.package)
    const refFile = join(cache, 'reference', `${m.name}.json`)
    return { m, dir, top: m.package === '.' ? slug(m.repo) : basename(m.package), refFile, sdf: undefined }
  })
  const missing = plan.filter((p) => !existsSync(p.dir) || !existsSync(p.refFile))
  if (missing.length) {
    const msg = `check-import-corpus: no corpus checkout or reference for ${missing.map((p) => p.m.name).join(', ')} in ${cache}; ` +
      'run tools/corpus/fetch.py and tools/corpus/reference.py first'
    if (ci || missing.length < plan.length) {
      console.error(msg)
      return 1
    }
    console.log(msg + ' (skipped)')
    return 0
  }
  if (sdfDir) {
    // gz may write its log under HOME; give it one in DIR. Its output goes to DIR, never into the cache.
    mkdirSync(join(sdfDir, 'home'), { recursive: true })
    for (const p of plan) {
      const urdf = join(p.dir, p.m.package === '.' ? p.m.path : p.m.path.slice(p.m.package.length + 1))
      const r = spawnSync('gz', ['sdf', '-p', urdf], { env: { ...process.env, HOME: join(sdfDir, 'home') }, encoding: 'utf8',
        timeout: 60000, maxBuffer: 256 * 2 ** 20 })
      if (r.status !== 0 || !/<sdf[\s>]/.test(r.stdout ?? '')) {
        console.error(`check-import-corpus: gz sdf -p failed on ${p.m.name}: ${r.error?.message ?? (r.stderr ?? '').slice(0, 300)}`)
        return 1
      }
      p.sdf = join(sdfDir, `${p.m.name}.sdf`)
      writeFileSync(p.sdf, r.stdout)
    }
  }

  const { rolldown } = await import('rolldown')
  const { launchChrome } = await import('./lib-browser.mjs')
  const bundle = await rolldown({ input: join(root, 'scripts/import-harness.ts'), logLevel: 'silent',
    transform: { define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.VITE_HOSTED': 'undefined' } } })
  const { output } = await bundle.generate({ format: 'iife' })
  await bundle.close()
  const harness = output[0].code

  const dirs = plan.map((p) => p.dir)
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (url === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><script src="/harness.js"></script>')
    if (url === '/harness.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(harness)
    const s = /^\/sdf\/(\d+)$/.exec(url)
    if (s && plan[Number(s[1])]?.sdf) return res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(readFileSync(plan[Number(s[1])].sdf))
    const m = /^\/files\/(\d+)\/(.+)$/.exec(url)
    const base = m && dirs[Number(m[1])]
    const file = base && resolve(base, m[2])
    if (!file || !file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end()
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(readFileSync(file))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await launchChrome('check-import-corpus')
  const results = []
  try {
    for (const [i, p] of plan.entries()) {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      // the importer's module graph starts the telemetry client; give it a socket that never connects instead of a real one
      await page.addInitScript(() => {
        window.WebSocket = class { constructor() { this.readyState = 3 } send() {} close() {} addEventListener() {} removeEventListener() {} }
      })
      await page.goto(origin + '/')
      await page.waitForFunction(() => !!window.__rocoImport, null, { timeout: 30000 }).catch((e) => {
        throw new Error(`the harness did not load: ${errors.join('; ') || e.message}`)
      })
      const files = walk(p.dir).map((f) => {
        const rel = relative(p.dir, f).split(sep).join('/')
        return { path: `${p.top}/${rel}`, url: `${origin}/files/${i}/${rel.split('/').map(encodeURIComponent).join('/')}` }
      })
      const rel = p.m.package === '.' ? p.m.path : p.m.path.slice(p.m.package.length + 1)
      if (p.sdf) files.push({ path: `${p.top}/${p.m.name}.gz.sdf`, url: `${origin}/sdf/${i}` })
      const options = { mainFile: p.sdf ? `${p.top}/${p.m.name}.gz.sdf` : `${p.top}/${rel}`, xacroArgs: p.m.xacro_args ?? {} }
      const got = await page.evaluate(([f, o]) => window.__rocoImport.run(f, o), [files, options])
      await page.close()
      let ref = JSON.parse(readFileSync(p.refFile, 'utf8'))
      let left = ''
      if (p.sdf) {
        const v = sdfReference(ref, readFileSync(p.sdf, 'utf8'))
        ref = v.ref
        left = `  gz left out ${v.droppedLinks} links, ${v.droppedFixed} fixed joints` + (v.droppedOther.length ? `, ${v.droppedOther.length} others (${v.droppedOther.join(', ')})` : '')
      }
      const r = compareModel(ref, got, p.sdf ? SDF_TOL : TOL)
      r.ms = Math.round(got.ms)
      r.files = files.length
      r.profileName = got.profileName
      r.warnings = got.warnings ?? []
      r.meshes = got.meshes ?? null
      r.profile = got.profile ?? null
      r.pageErrors = errors
      results.push(r)
      const mark = r.loaded && !r.jointProblems.length && !r.poseProblems.length ? 'ok  ' : 'MISS'
      console.log(`${mark} ${p.m.name.padEnd(17)} ${p.m.format.padEnd(5)} ${r.loaded ? 'loaded' : 'failed'} ` +
        (r.loaded
          ? `joints ${r.joints - r.jointProblems.length}/${r.joints}  poses ${r.poses - r.poseProblems.length}/${r.poses}  ` +
            `worst ${r.worstPos.toExponential(1)} m ${r.worstRot.toExponential(1)} rad  ${r.ms} ms  warnings ${r.warnings.length}` +
            (r.meshes ? `  meshes ${r.meshes.resolved}/${r.meshes.total}` : '') +
            (r.approx.length ? `  approx ${r.approx.length}` : '') + (r.unnamed ? `  unnamed ${r.unnamed}` : '') +
            (p.sdf ? `  axis ${r.worstAxis.toExponential(1)} limit ${r.worstLimit.toExponential(1)}${left}` : '')
          : `(${r.error})`) + (errors.length ? `  PAGE ERRORS ${errors.length}` : ''))
      if (r.loaded && (r.jointProblems.length || r.poseProblems.length)) {
        for (const w of [...r.jointProblems.slice(0, 3), ...r.poseProblems.slice(0, 3)]) console.log(`       ${w}`)
      }
    }
  } finally {
    await browser.close()
    server.close()
  }
  const out = opt('--out')
  if (out) writeFileSync(out, JSON.stringify(results, null, 1) + '\n')
  const loaded = results.filter((r) => r.loaded).length
  const exact = results.filter((r) => r.loaded && !r.jointProblems.length && !r.poseProblems.length).length
  const pageErrors = results.reduce((n, r) => n + r.pageErrors.length, 0)
  console.log(`check-import-corpus: ${loaded}/${results.length} loaded, ${exact}/${results.length} match the reference, ${pageErrors} page errors`)
  const t = targetsMet(results)
  if (reportOnly) return 0
  if (!t.ok || pageErrors) {
    for (const w of t.why) console.error('MISS: ' + w)
    return 1
  }
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = process.argv.includes('--self-test') ? selfTest() : await main(process.argv.slice(2))
}
