// Checks the model importer's parts on small hand-made cases: the asset resolver (src/utils/assetResolver.ts), the import
// report (src/utils/importReport.ts), and, in headless Chrome (the converters need DOMParser), MJCF, xacro and SDF conversion
// through the page's own importer. Bundles the sources with rolldown in memory, like check-profiles.mjs.
//
//   node scripts/check-import.mjs [--dump-fixtures DIR]
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'
import { tally } from './lib-browser.mjs'

// `--dump-fixtures DIR` writes the MJCF and SDF fixtures below as files, so MuJoCo itself can say where each body should be
// (the expected poses in this check came from mujoco 3.17.0 reading exactly these files), and gz sdf -k can check the SDF.
const dumpAt = process.argv.indexOf('--dump-fixtures')
if (dumpAt > 0) {
  const dir = process.argv[dumpAt + 1]
  for (const [name, fx] of Object.entries({ ...mjcfFixtures(), ...sdfFixtures() })) {
    for (const [path, body] of Object.entries(fx.files)) {
      const out = join(dir, name, path)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, body)
    }
  }
  console.log(`check-import: fixtures written to ${dir}`)
  process.exit(0)
}

const root = new URL('..', import.meta.url)
const load = async (input) => {
  const b = await rolldown({ input: fileURLToPath(new URL(input, root)), logLevel: 'silent' })
  const { output } = await b.generate({ format: 'esm' })
  await b.close()
  return import('data:text/javascript;base64,' + Buffer.from(output[0].code).toString('base64'))
}
const { AssetIndex, normalizeAssetPath, joinBundlePath } = await load('src/utils/assetResolver.ts')
const { ImportReport } = await load('src/utils/importReport.ts')
const { countTriangles, countGltfJson, countDae, countObjFaces } = await load('src/utils/meshTriangles.ts')
const { check, finish } = tally()

/** An index whose urls are `url:<path as given>`, so a result names the file it picked. */
const indexOf = (paths) => {
  const idx = new AssetIndex()
  for (const p of paths) idx.add(p, `url:${p}`)
  return idx
}
const run = (paths, ref, from) => {
  const report = new ImportReport()
  const r = indexOf(paths).resolve(ref, { from, report })
  return { r, report, kinds: report.items.map((i) => i.kind).join(',') }
}

// --- relative paths --------------------------------------------------------------------------------------------------
let t = run(['robot/urdf/r.urdf', 'robot/meshes/a.stl', 'other/meshes/a.stl'], '../meshes/a.stl', 'robot/urdf/r.urdf')
check(t.r.url === 'url:robot/meshes/a.stl' && t.r.how === 'exact' && t.report.items.length === 0,
  'a relative path is read against the referring file\'s folder, exactly, with nothing reported')
t = run(['Robot/Meshes/A.STL'], 'meshes/a.stl', 'robot/r.urdf')
check(t.r.how === 'exact' && t.r.url === 'url:Robot/Meshes/A.STL', 'paths match without regard to case')
t = run(['robot/meshes/a b.stl'], 'meshes/a%20b.stl', 'robot/r.urdf')
check(t.r.how === 'exact', 'a percent-encoded reference matches the file name it encodes')
t = run(['meshes/a.stl'], '../meshes/a.stl', 'r.urdf')
check(t.kinds === 'limit,substitution' && t.r.how === 'substituted' && t.r.path === 'meshes/a.stl',
  '`..` above the top of the import is refused (reported as a limit) and only a file inside the import is used, reported')
check(!t.r.path.includes('..'), 'a refused climb never yields a path with `..`')
t = run(['meshes/a.stl'], '../../../../etc/passwd', 'r.urdf')
check(t.r.how === 'missing' && t.r.url === null && t.kinds === 'limit', 'a climb to a file that is not imported resolves to nothing')
t = run(['robot/meshes/a.stl'], 'parts/a.stl', 'robot/r.urdf')
check(t.r.how === 'substituted' && t.kinds === 'substitution' && t.report.items[0].where[0] === 'parts/a.stl → robot/meshes/a.stl',
  'a relative path that leads nowhere falls back to the name, and the report says which file was used')
t = run(['robot/meshes/a.stl'], 'nope.stl', 'robot/r.urdf')
check(t.r.how === 'missing' && t.r.url === null && t.report.items.length === 0, 'an unknown file is missing; the resolver reports nothing (the importer does)')

// --- package://, model://, $(find) ----------------------------------------------------------------------------------
t = run(['ws/src/h1_description/meshes/a.stl', 'ws/src/h1_description/urdf/h1.urdf'], 'package://h1_description/meshes/a.stl', 'ws/src/h1_description/urdf/h1.urdf')
check(t.r.how === 'exact' && t.report.items.length === 0, 'package:// finds the package folder anywhere in the import, with nothing reported')
{
  const report = new ImportReport()
  const idx = indexOf(['unitree_h1/meshes/a.stl', 'unitree_h1/meshes/b.stl', 'unitree_h1/h1.urdf'])
  const a = idx.resolve('package://h1_description/meshes/a.stl', { from: 'unitree_h1/h1.urdf', report })
  const b = idx.resolve('package://h1_description/meshes/b.stl', { from: 'unitree_h1/h1.urdf', report })
  check(a.how === 'substituted' && b.url === 'url:unitree_h1/meshes/b.stl', 'a package that is not a folder in the import is read from the folder its files are in')
  check(report.items.length === 1 && report.items[0].count === 2 && /package:\/\/h1_description is not a folder in the import; it was read from unitree_h1\//.test(report.items[0].message),
    'the substitution is reported once per package, with a count')
}
t = run(['meshes/a.stl'], 'package://pkg/meshes/a.stl', 'r.urdf')
check(/read from the top of the import/.test(t.report.items[0]?.message ?? ''), 'a package read from the top of the import says so')
t = run(['m/x/a.stl'], 'model://pkg/meshes/a.stl', 'm/model.sdf')
check(t.r.how === 'substituted' && /model:\/\/pkg files were matched by name/.test(t.report.items[0]?.message ?? ''), 'model:// matched by name only is reported as such')
t = run(['pkg/meshes/a.stl'], 'model://pkg/meshes/a.stl', 'pkg/model.sdf')
check(t.r.how === 'exact', 'model:// resolves like package://')
t = run(['ws/pkg/meshes/a.stl'], '$(find pkg)/meshes/a.stl', 'ws/pkg/r.xml')
check(t.r.how === 'exact' && t.r.url === 'url:ws/pkg/meshes/a.stl', '$(find pkg) resolves like package://')
t = run(['ws/pkg/meshes/a.stl'], 'package://pkg', 'ws/pkg/r.urdf')
check(t.r.how === 'missing', 'a package with no file path resolves to nothing')

// --- absolute paths and other schemes -------------------------------------------------------------------------------
t = run(['robot/meshes/a.stl'], 'file:///opt/ws/robot/meshes/a.stl', 'robot/r.urdf')
check(t.r.how === 'substituted' && /absolute file path/.test(t.report.items[0]?.message ?? ''), 'file:// is matched by the end of its path and reported')
t = run(['robot/meshes/a.stl'], '/opt/ws/robot/meshes/a.stl', 'robot/r.urdf')
check(t.r.how === 'substituted' && t.r.url === 'url:robot/meshes/a.stl', 'a POSIX absolute path is matched by its end')
t = run(['robot/meshes/a.stl'], 'D:\\ws\\robot\\meshes\\a.stl', 'robot/r.urdf')
check(t.r.how === 'substituted' && t.r.url === 'url:robot/meshes/a.stl', 'a Windows absolute path is matched by its end')
t = run(['robot/meshes/a.stl'], 'https://example.com/robot/meshes/a.stl', 'robot/r.urdf')
check(t.r.how === 'substituted' && t.r.url === 'url:robot/meshes/a.stl' && /never fetched/.test(t.report.items[0]?.message ?? ''),
  'a web address is never fetched: only an imported file is used, and that is reported')
t = run(['robot/meshes/a.stl'], 'https://example.com/other.stl', 'robot/r.urdf')
check(t.r.url === null && t.r.how === 'missing', 'a web address with no imported file of that name resolves to nothing')
t = run([], 'data:model/stl;base64,AAAA', 'r.urdf')
check(t.r.url === 'data:model/stl;base64,AAAA' && t.r.how === 'exact', 'a data: URI is used as it is')

// --- ambiguity ------------------------------------------------------------------------------------------------------
t = run(['a/meshes/x.stl', 'b/meshes/x.stl'], 'meshes/x.stl', 'c/r.urdf')
check(t.r.ambiguousWith.length === 1 && t.report.items.some((i) => /several imported files/.test(i.message) && i.hint),
  'a name that matches two files equally is reported as a guess, with a hint')
t = run(['a/meshes/x.stl', 'b/meshes/x.stl'], 'package://p/meshes/x.stl', 'b/urdf/r.urdf')
check(t.r.url === 'url:b/meshes/x.stl' && t.r.ambiguousWith.length === 0 && !t.report.items.some((i) => /several/.test(i.message)),
  'a tie goes to the file nearest the referring file, and is then not a guess')

// --- the helpers, and the twin's request ----------------------------------------------------------------------------
check(normalizeAssetPath('package://pkg/a/../b.stl') === 'pkg/b.stl', 'normalizeAssetPath keeps its v1 behaviour')
check(normalizeAssetPath('blob:http://127.0.0.1:5173/unitree_h1/meshes/a%20b.STL') === 'unitree_h1/meshes/a b.stl', 'the twin\'s blob-folder prefix drops out')
check(joinBundlePath(['a'], '../../x') === null && joinBundlePath(['a', 'b'], '../x/./y') === 'a/x/y', 'joinBundlePath refuses a climb above the top')
{
  const idx = indexOf(['unitree_h1/meshes/a b.stl', 'other/unitree_h1/meshes/a b.stl'])
  const hit = idx.exact('blob:https://example.github.io/unitree_h1/meshes/a%20b.stl')
  check(hit.url === 'url:unitree_h1/meshes/a b.stl' && hit.ambiguousWith.length === 0, 'the twin\'s request for a rewritten path finds exactly that file')
}

// --- the report -----------------------------------------------------------------------------------------------------
{
  const r = new ImportReport()
  for (let i = 0; i < 15; i++) r.add('approx', 'Ball joint shown fixed.', { where: `j${i}` })
  r.add('approx', 'Ball joint shown fixed.', { where: 'j0' })
  r.add('error', 'A mesh is missing.', { where: 'a.stl', hint: 'Import the meshes folder.' })
  const ball = r.items[0]
  check(r.items.length === 2 && ball.count === 16 && ball.where.length === 10, 'repeats are counted once, with at most 10 example places')
  const lines = r.lines()
  check(lines[0].startsWith('error: A mesh is missing. (a.stl) Import the meshes folder.') && lines[1].startsWith('approx ×16: Ball joint shown fixed. (j0,') && lines[1].endsWith(', …)'),
    'lines put the most serious kind first and mark cut example lists')
  const json = r.toJson()
  json.items[0].where.push('changed')
  check(json.version === 1 && json.items.length === 2 && r.items[0].where.length === 10, 'toJson is a copy')
  check(new ImportReport().toText() === 'Nothing to report.\n' && r.toText().split('\n').length === 3, 'toText of an empty and a full report')
  check(r.byKind('fix').length === 0 && r.byKind('approx').length === 1, 'byKind filters')
}

// --- triangle counts (src/utils/meshTriangles.ts) -------------------------------------------------------------------
{
  const tri = async (bytes, name) => countTriangles(new Blob([bytes]), name)
  const same = (got, triangles, exact = true) => got !== null && got.triangles === triangles && got.exact === exact
  check(same(await tri(stl(), 'a.STL'), 4), 'a binary STL is counted from its header (any case of extension)')
  const facet = 'facet normal 0 0 1\n outer loop\n  vertex 0 0 0\n  vertex 1 0 0\n  vertex 0 1 0\n endloop\nendfacet\n'
  check(same(await tri(`solid a\n${facet.repeat(3)}endsolid a\n`, 'a.stl'), 3), 'an ASCII STL is counted by its facets')
  check(same(await tri(glb({ accessors: [{ count: 1_500_003 }], meshes: [{ primitives: [{ indices: 0 }] }] }), 'g.glb'), 500_001), 'a GLB: indexed triangles are a third of the indices')
  check(same(countGltfJson(JSON.stringify({ accessors: [{ count: 10 }, { count: 9 }, { count: 7 }], meshes: [{ primitives: [{ mode: 5, indices: 0 }, { attributes: { POSITION: 1 } }] }, { primitives: [{ mode: 6, attributes: { POSITION: 2 } }, { mode: 1, indices: 0 }] }] })), 8 + 3 + 5),
    'glTF: a strip and a fan are n - 2, unindexed triangles count POSITION, lines draw none')
  check(await tri(Buffer.from('not a glb at all, twenty+ bytes'), 'g.glb') === null, 'a GLB with the wrong magic is not counted')
  {
    const bad = glb({ meshes: [] })
    bad.writeUInt32LE(2 ** 30, 12) // a JSON chunk longer than the file
    check(await tri(bad, 'g.glb') === null, 'a GLB whose JSON chunk runs past the end of the file is not read')
  }
  check(countGltfJson('{"meshes": [') === null && same(countGltfJson('{"meshes":[{"primitives":[{"indices":5}]}]}'), 0), 'broken glTF JSON is not counted; a missing accessor counts nothing')
  check(same(countDae('<mesh><triangles material="m" count="600000"><input/></triangles><lines count="900"/></mesh>'), 600_000), 'COLLADA: <triangles> counts exactly, lines draw none')
  check(same(countDae('<triangles count="2"/><polylist count="5"><vcount>3 4 4 3 5</vcount></polylist><polygons count=\'1\'>'), 8, false),
    'COLLADA: polylist and polygons give a lower bound (one triangle each)')
  check(same(countDae(`<trianglesX count="9"/><triangles${' '.repeat(2100)}count="9">`), 0), 'COLLADA: another tag, or a start tag with no `>` near it, is not counted')
  check(countObjFaces('f 1 2 3 4\n  f\t1 2 3\r\nfo 1 2 3\n#f 1 2 3\nf 1 2\nvt 0 0\nf 1/1/1 2/2/2 3/3/3 4/4/4 5/5/5') === 2 + 1 + 3,
    'OBJ: a face of k vertices is k - 2 triangles; other lines and short faces count nothing; the last line needs no newline')
  check(same(await tri('v 0 0 0\nf 1 2 3\n', 'm.obj'), 1) && await tri('x', 'm.ply') === null, 'an OBJ is counted; another format is not')
}

// MuJoCo 3.17.0 reading these fixtures (mj_kinematics at qpos0): each body's xpos and xquat (w, x, y, z), to 9 decimals.
const EXPECTED = {
  orient: {
    base: { xyz: [0, 0, 0], quat: [1, 0, 0, 0] },
    b_quat: { xyz: [1, 0, 0], quat: [0.707106781, 0, 0, 0.707106781] },
    b_axisangle: { xyz: [0, 1, 0], quat: [0.707106781, 0, 0.707106781, 0] },
    b_euler: { xyz: [0, 0, 0], quat: [0.5, 0.5, 0.5, 0.5] },
    b_xyaxes: { xyz: [0, 0, 0], quat: [0.707106781, 0, 0, 0.707106781] },
    b_zaxis: { xyz: [0, 0, 0], quat: [0.707106781, 0, 0.707106781, 0] },
    b_zaxis_down: { xyz: [0, 0, 0], quat: [0, 1, 0, 0] },
    b_near_lock: { xyz: [0.1, 0.2, 0.3], quat: [0.500003, 0.5, -0.5, 0.499997] },
    b_after_lock: { xyz: [-0.4000012, -0.399997, 0.700003], quat: [0.500003, 0.5, -0.5, 0.499997] },
  },
  orient_extrinsic: {
    base: { xyz: [0, 0, 0], quat: [1, 0, 0, 0] },
    b_euler: { xyz: [0, 0, 0], quat: [0.5, 0.5, 0.5, -0.5] },
    b_lock: { xyz: [0, 0, 0], quat: [0.706223082, 0.03534061, 0.706223082, -0.03534061] },
    b_after_lock: { xyz: [0.646919207, 0.437602033, -0.4], quat: [0.706223082, 0.03534061, 0.706223082, -0.03534061] },
  },
  features: {
    deg_body: { xyz: [0, 0, 2], quat: [1, 0, 0, 0] },
    torso: { xyz: [0, 0, 1], quat: [1, 0, 0, 0] },
    upper: { xyz: [0, 0.7, 1], quat: [0.707106781, 0, 0, 0.707106781] },
    lower: { xyz: [0, 1, 1], quat: [0.43528575, -0.072547625, 0.217642875, 0.8705715] },
    wrist: { xyz: [-0.122105263, 1.145263158, 0.936842105], quat: [0.43528575, -0.072547625, 0.217642875, 0.8705715] },
    finger: { xyz: [-0.152631579, 1.181578947, 0.921052632], quat: [0.461690258, 0.564288094, -0.153896753, 0.666885929] },
  },
}

// --- MJCF conversion, through the page's importer in Chrome ------------------------------------------------------------
{
  const bundle = await rolldown({ input: fileURLToPath(new URL('scripts/import-harness.ts', root)), logLevel: 'silent',
    transform: { define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.VITE_HOSTED': 'undefined' } } })
  const harness = (await bundle.generate({ format: 'iife' })).output[0].code
  await bundle.close()
  const server = createServer((req, res) => {
    if (req.url === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><script src="/harness.js"></script>')
    if (req.url === '/harness.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(harness)
    // the shipped G1 files, for the units check's negative case; only the files listed are served
    const g1 = decodeURIComponent(req.url.slice('/g1/'.length))
    if (req.url.startsWith('/g1/') && G1_FILES.includes(g1)) return res.writeHead(200).end(readFileSync(fileURLToPath(new URL(`public/models/g1_description/${g1}`, root))))
    res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { launchChrome } = await import('./lib-browser.mjs')
  const browser = await launchChrome('check-import')
  const G1_URDF = 'g1_29dof.urdf'
  const G1_FILES = [G1_URDF, ...new Set(Array.from(readFileSync(fileURLToPath(new URL(`public/models/g1_description/${G1_URDF}`, root)), 'utf8').matchAll(/filename="([^"]+)"/g), (m) => m[1]))]
  const errors = []
  const strays = []
  const importFixture = async (name, want = {}) => {
    const fx = mjcfFixtures()[name] ?? xacroFixtures()[name] ?? sdfFixtures()[name] ?? heightFixtures()[name] ?? meshFixtures()[name]
    const page = await browser.newPage()
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
    // every request the import makes: only the page, the harness and the G1 files it was given may reach a server
    const origin = `http://127.0.0.1:${server.address().port}`
    const stray = []
    page.on('request', (r) => {
      const u = r.url()
      if (/^(blob|data):/i.test(u)) return
      const path = u.startsWith(`${origin}/`) ? u.slice(origin.length) : null
      if (path === '/' || path === '/harness.js' || path?.startsWith('/g1/')) return
      stray.push(u)
    })
    // the importer's module graph starts the telemetry client; give it a socket that never connects
    await page.addInitScript(() => {
      window.WebSocket = class { constructor() { this.readyState = 3 } send() {} close() {} addEventListener() {} removeEventListener() {} }
    })
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.waitForFunction(() => !!window.__rocoImport, null, { timeout: 30000 })
    const list = fx.g1
      ? G1_FILES.map((f) => ({ path: `${name}/${f}`, url: `http://127.0.0.1:${server.address().port}/g1/${encodeURIComponent(f)}` }))
      : Object.entries(fx.files).map(([path, body]) => ({ path: `${name}/${path}`, url: 'data:application/octet-stream;base64,' + Buffer.from(body).toString('base64') }))
    const got = await page.evaluate(([l, o, w]) => window.__rocoImport.run(l, o, w), [list, { ...(fx.main ? { mainFile: `${name}/${fx.main}` } : {}), ...fx.options }, want])
    await page.close()
    if (stray.length) strays.push(`${name}: ${stray.slice(0, 3).join(', ')}`)
    return { ...got, stray }
  }
  const near = (a, b, tol = 1e-9) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol)
  /** Same rotation: q and -q are one rotation. */
  const sameRot = (a, b, tol = 1e-9) => near(a, b, tol) || near(a, b.map((c) => -c), tol)
  const posesMatch = (got, expected, what) => {
    const bad = Object.entries(expected).filter(([n, e]) => !got.poses?.[n] || !near(got.poses[n].xyz, e.xyz, 1e-7) || !sameRot(got.poses[n].quat, e.quat, 1e-7))
    check(bad.length === 0, `${what}: every body is where MuJoCo puts it${bad.length ? ` (off: ${bad.map(([n]) => `${n} got ${JSON.stringify(got.poses?.[n])}`).join('; ')})` : ''}`)
  }
  try {
    let got = await importFixture('orient')
    check(got.ok, `orient imports (${got.error ?? ''})`)
    posesMatch(got, EXPECTED.orient, 'quat, axisangle, intrinsic euler, xyaxes, zaxis (also straight down), a near-gimbal-lock quat')
    check(got.joints?.deg?.type === 'revolute' && near([got.joints.deg.lower, got.joints.deg.upper], [-Math.PI / 2, Math.PI / 4]), 'a hinge range in degrees (the default) is converted to radians')
    got = await importFixture('orient_extrinsic')
    check(got.ok, `orient_extrinsic imports (${got.error ?? ''})`)
    posesMatch(got, EXPECTED.orient_extrinsic, 'extrinsic euler (eulerseq XYZ, radians) and an exact 90° pitch')

    got = await importFixture('features', { urdf: true })
    check(got.ok, `features imports (${got.error ?? ''})`)
    posesMatch(got, EXPECTED.features, 'frame, childclass, include, multi-joint body with offset joints, ball, slide, free')
    const j = got.joints ?? {}
    const jointIs = (n, type, axis, lower, upper) =>
      j[n]?.type === type && (!axis || near(j[n].axis, axis)) && (lower === undefined || (near([j[n].lower], [lower]) && near([j[n].upper], [upper])))
    check(jointIs('root', 'floating'), 'a freejoint is a floating joint')
    check(jointIs('shoulder', 'revolute', [1, 0, 0], -1, 1), 'a joint takes axis and range from the childclass a <frame> sets')
    check(jointIs('elbow_y', 'revolute', [0, 1, 0], -1, 1) && jointIs('elbow_z', 'revolute', [0, 0, 1], -0.5, 0.5), 'two joints on one body: both kept, own attributes over the class')
    check(jointIs('wrist_ball', 'fixed'), 'a ball joint is shown fixed')
    check(jointIs('slide', 'prismatic', [1, 0, 0], 0, 0.04), 'a slide joint is prismatic with its range in metres (not scaled as an angle)')
    check(jointIs('spin', 'continuous', [1, 0, 0]), 'limited="false" with a range is not limited')
    check(jointIs('deg_rad', 'revolute', [0, 0, 1], -1.5, 0.75), 'a body from an include found next to the main file keeps its joint')
    check(!('lower__j1' in j) && !('finger__j1' in j) && j['lower__anchor']?.type === 'fixed', 'helper links carry no joint of their own; the offset anchor is fixed')
    const visuals = (link) => {
      const m = new RegExp(`<link name="${link}">([\\s\\S]*?)</link>`).exec(got.urdf ?? '')
      return m ? m[1] : ''
    }
    check(/<mesh filename="features\/assets\/t\.stl" scale="2 2 2"\/>/.test(visuals('lower')), 'a mesh is found under meshdir with its asset scale')
    check(!/<box/.test(visuals('lower')), 'a group 3 (collision) geom is not drawn')
    check(/<mesh filename="features\/assets\/sub\/t\.stl" scale="3 3 3"\/>/.test(visuals('finger')), 'a mesh asset takes its scale from its class')
    const upper = visuals('upper')
    check((upper.match(/<visual>/g) ?? []).length === 3 && /<cylinder radius="0.03" length="0.3"\/>/.test(upper) && (upper.match(/<sphere radius="0.03"\/>/g) ?? []).length === 2,
      'a capsule placed with fromto is a cylinder of its length with a sphere on each end')
    check(/rgba="1 0 0 1"/.test(upper), 'a class rgba wins over the material')
    const torso = visuals('torso')
    check((torso.match(/<visual>/g) ?? []).length === 1 && /rgba="0 1 0 1"/.test(torso), 'a geom with only a material takes its colour; an rgba alpha of 0 is not drawn')
    check(/<sphere radius="0.03"\/>/.test(visuals('wrist')), 'an ellipsoid is a sphere of its largest radius')
    const w = got.warnings ?? []
    const has = (text) => w.some((l) => l.includes(text))
    check(has('A ball joint is shown fixed.') && has('A free joint is shown as a floating base.') && has('An ellipsoid geom is drawn as a sphere'),
      'the ball joint, the free joint and the ellipsoid are reported')
    check(!w.some((l) => l.startsWith('error')) && !has('scenery'), 'nothing in features is reported as an error, and a floor plane is not scenery')

    got = await importFixture('missing_include')
    check(got.ok && (got.warnings ?? []).some((l) => l.startsWith('error') && l.includes('An included file was not imported') && l.includes('not_here.xml')),
      'a missing include is reported as an error, and the rest still imports')
    got = await importFixture('circular')
    check(!got.ok && /^The description nests too deeply \(circular include of 'main.xml'\)/.test(got.error ?? ''), `a circular include is refused (${got.error ?? 'imported'})`)
    got = await importFixture('include_depth')
    check(!got.ok && /^The description nests too deeply \(include 'd9.xml' is 9 includes deep\)/.test(got.error ?? ''), `includes 9 deep are refused (${got.error ?? 'imported'})`)
    got = await importFixture('ambiguous')
    check(got.ok && got.robotName === 'right', 'the main file the import names is the one used')
    // --- xacro: the expression table against Python xacro 2.1.1, then each error it reports and goes on past ---
    const unxml = (v) => v.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e])
    const xs = (urdf) => Array.from((urdf ?? '').matchAll(/<x n="([^"]*)" v="([^"]*)"\/>/g), (m) => [m[1], unxml(m[2])])
    got = await importFixture('xacro', { urdf: true })
    check(got.ok, `xacro imports (${got.error ?? ''})`)
    {
      const table = xs(got.urdf)
      const off = xacroExpected().table.map(([n, v], i) => (table[i]?.[0] === n && table[i]?.[1] === v ? null : `${n}: got ${JSON.stringify(table[i])}, Python xacro ${JSON.stringify(v)}`)).filter(Boolean)
      check(off.length === 0 && table.length === xacroExpected().table.length, `xacro: every expression, substitution, property, yaml and macro value equals Python xacro's (${table.length}/${xacroExpected().table.length}${off.length ? `; ${off.slice(0, 6).join('; ')}` : ''})`)
      const flat = (got.urdf ?? '').replace(/>\s+</g, '><')
      check(flat.includes(xacroExpected().tail), 'xacro: blocks, nested macros, scopes, xacro:element, xacro:attribute, if/unless and eval-comments give Python xacro\'s elements')
      check(got.joints?.j_left?.type === 'revolute' && Math.abs(got.joints.j_left.lower + Math.PI / 2) < 1e-12 && Math.abs(got.joints.j_left.upper - Math.PI / 4) < 1e-12,
        'xacro: a joint named from a property set by $(arg), with limits from pi and radians()')
      check(!(got.warnings ?? []).some((l) => l.startsWith('error')), `xacro: nothing in the fixture is reported as an error (${(got.warnings ?? []).filter((l) => l.startsWith('error')).join(' | ')})`)
    }
    got = await importFixture('xacro_errors', { urdf: true })
    check(got.ok, `xacro_errors still imports (${got.error ?? ''})`)
    {
      const ew = got.warnings ?? []
      for (const [text, what] of [
        ['circular variable definition: a -> b -> a', 'a circular property'],
        ['unknown macro name: xacro:nope', 'an unknown macro'],
        ['Property names must be valid python identifiers: 1x', 'a property name that is not an identifier'],
        ['Property names must not start with double underscore: __x', 'a property name starting with __'],
        ['__class__', 'a double-underscore name in an expression'],
        ['$(eval ...) may not contain double underscore expressions', 'a double underscore in $(eval)'],
        ["needs the argument 'nothere'", 'a $(arg) with no value'],
        ["name 'abs' is not defined", 'abs() outside python. (Python xacro has none)'],
        ['Excessive alias count', 'a yaml alias bomb'],
        ['Undefined parameters [p]', 'a macro call missing a parameter'],
        ['Invalid parameter "zz"', 'a macro call with an unknown parameter'],
        ['not a boolean expression', 'a xacro:if that is neither true nor false'],
      ]) check(ew.some((l) => l.startsWith('error') && l.includes(text)), `xacro reports ${what}`)
      const table = Object.fromEntries(xs(got.urdf))
      check(table.circ === '${a}' && table.dunder === "${'a'.__class__}" && table.method === '${ok.items[0]}' && table.noarg === '',
        `an expression that fails is left as written; a missing $(arg) is empty; a yaml dict's method wins over its key, as in Python (${JSON.stringify(table)})`)
      check(table.after === 'still here' && !('maybe' in table) && !('needs' in table), 'after the errors the rest expands, without the failed elements')
    }
    got = await importFixture('xacro_fatal')
    check(!got.ok && (got.error ?? '').includes('The xacro stopped itself with xacro.fatal: stop here'), `xacro.fatal stops the import (${got.error ?? 'imported'})`)
    got = await importFixture('xacro_eval_cap')
    check(!got.ok && /^A xacro expression or its value is over 10,000 characters/.test(got.error ?? ''), `a $(eval) value over the cap is refused (${got.error ?? 'imported'})`)

    // --- SDFormat: frames, joints, nested and included models, then what is reported or refused ---
    const c = Math.SQRT1_2
    const at = (xyz, quat = [1, 0, 0, 0]) => ({ xyz, quat })
    const sdfJoint = (g, n, type, axis, lower, upper) => {
      const jj = g.joints?.[n]
      return jj?.type === type && (!axis || near(jj.axis, axis)) && (lower === undefined || (near([jj.lower], [lower]) && near([jj.upper], [upper])))
    }
    const said = (g, kind, text) => (g.warnings ?? []).some((l) => l.startsWith(kind) && l.includes(text))
    const linkVisuals = (g, link) => (new RegExp(`<link name="${link}">([\\s\\S]*?)</link>`).exec(g.urdf ?? '') ?? [])[1] ?? ''

    got = await importFixture('sdf_frames', { urdf: true })
    check(got.ok && got.robotName === 'arm', `sdf_frames imports (${got.error ?? ''})`)
    posesMatch(got, {
      base: at([0, 0, 0]), upper: at([0, 1, 1], [c, 0, 0, c]), upper__joint: at([0, 1, 1.5], [c, 0, 0, c]), deg: at([0, 1, 1], [0, 0, 0, 1]),
      q: at([0, 1, 1.2], [0, 0, 0, 1]), b: at([0, 1, 1.2], [0, 0, 0, 1]), u__j1: at([0, 1, 1.3], [0, 0, 0, 1]), u: at([0, 1, 1.3], [0, 0, 0, 1]), lost: at([1, 2, 3]),
    }, 'SDF: relative_to a frame, a link and a joint offset from its child; degrees; quat_xyzw; the model pose is the origin')
    check(!('world' in (got.poses ?? {})), 'one free link where the model frame is is the URDF root, with no world link')
    check(sdfJoint(got, 'shoulder', 'revolute', [0, -1, 0], -1, 2), 'an axis expressed_in __model__ is turned into the joint frame')
    check(sdfJoint(got, 'spin', 'continuous', [0, 0, 1]), 'a revolute joint with no limit is continuous, its axis +z by default')
    check(sdfJoint(got, 'slide', 'prismatic', [0, 1, 0], 0, 0.04), 'a prismatic joint keeps its limits in metres')
    check(sdfJoint(got, 'wrist_ball', 'fixed') && said(got, 'approx', 'A ball joint is shown fixed.'), 'a ball joint is shown fixed and reported')
    check(sdfJoint(got, 'uni', 'revolute', [1, 0, 0], -0.5, 0.5) && sdfJoint(got, 'uni__2', 'revolute', [0, 1, 0], -0.25, 0.25) && !said(got, 'approx', 'universal'),
      'a universal joint is two revolute joints, axis then axis2, each with its own limits')
    check(sdfJoint(got, 'upper__anchor', 'fixed') && !('upper__joint' in (got.joints ?? {})), 'a joint away from its child ends at a helper link, anchored to the child')
    check(said(got, 'error', 'refers to a frame that does not exist') && said(got, 'error', 'lost → nowhere'), 'a pose relative_to a missing frame is reported and read from the model frame')
    {
      const up = linkVisuals(got, 'upper')
      check((up.match(/<visual>/g) ?? []).length === 4 && /<box size="0.1 0.2 0.3"\/>/.test(up) && /rgba="1 0 0 1"/.test(up) && (up.match(/<sphere radius="0.03"\/>/g) ?? []).length === 2,
        'SDF visuals: a box with its diffuse colour, a capsule as a cylinder and two spheres, a fully transparent one not drawn')
      check(/<sphere radius="0.03"\/>/.test(linkVisuals(got, 'u')) && said(got, 'approx', 'An ellipsoid is drawn as a sphere'), 'an ellipsoid is a sphere of its largest radius, reported')
    }

    got = await importFixture('sdf_nested', { urdf: true })
    check(got.ok && got.robotName === 'rover' && !(got.warnings ?? []).some((l) => l.includes('Several files')), `sdf_nested imports, its main file picked over the model it includes (${got.error ?? ''})`)
    posesMatch(got, {
      chassis: at([0, 0, 0]), 'arm::l1': at([1, 0, 1]), 'arm::l2': at([1, 0, 1.5]),
      'wheel_left::rim': at([0, 1, 0], [c, -c, 0, 0]), 'wheel_left::cap': at([0, 1.1, 0], [0.5, -0.5, 0.5, 0.5]),
      'wheel_right::rim': at([0, -1, 0], [c, c, 0, 0]), 'wheel_right::cap': at([0, -1.1, 0], [0.5, 0.5, -0.5, 0.5]),
    }, 'SDF: a nested model and one model included twice, each under its own name and pose')
    check(sdfJoint(got, 'arm::j', 'revolute', [0, 1, 0], -0.5, 0.5) && sdfJoint(got, 'mount', 'fixed'), 'a nested model\'s joint keeps its scoped name; a joint reaches into it with ::')
    check(sdfJoint(got, 'axle_left', 'continuous', [0, 0, 1]) && sdfJoint(got, 'axle_right', 'continuous', [0, 0, 1]), 'joints into included models, one axis expressed_in __model__')
    check(sdfJoint(got, 'wheel_left::cap_j', 'revolute', [0, -1, 0], -1, 1) && sdfJoint(got, 'wheel_right::cap_j', 'revolute', [0, -1, 0], -1, 1),
      'SDF 1.6 use_parent_model_frame reads the axis in the model frame')
    check(/<mesh filename="sdf_nested\/rover\/meshes\/t\.stl" scale="2 2 2"\/>/.test(linkVisuals(got, 'chassis')) && /<mesh filename="sdf_nested\/wheel\/meshes\/tire\.stl"/.test(linkVisuals(got, 'wheel_left::rim')),
      'a model:// mesh, and a relative mesh in an included file read from that file\'s folder')
    check(got.meshes?.total === 3 && got.meshes?.resolved === 3, `every SDF mesh resolves (${JSON.stringify(got.meshes)})`)
    check(!(got.warnings ?? []).some((l) => l.startsWith('error')), `nothing in sdf_nested is an error (${(got.warnings ?? []).filter((l) => l.startsWith('error')).join(' | ')})`)

    got = await importFixture('sdf_world')
    check(got.ok && got.robotName === 'bot', `sdf_world imports its model with the most joints (${got.error ?? ''})`)
    posesMatch(got, { world: at([0, 0, 0]), base: at([0, 0, 0], [c, 0, 0, c]) }, 'SDF world: the robot model at the origin')
    check(sdfJoint(got, 'hinge', 'revolute', [0, -1, 0], -1, 1), 'SDF 1.4 reads the axis in the model frame; a joint to world hangs from a world link')
    check(said(got, 'substitution', 'holds 2 models; bot') && said(got, 'unsupported', 'model://sun'), 'the other model and the missing sun are reported')
    check(!('o' in (got.poses ?? {})) && !(got.warnings ?? []).some((l) => /matched by name/.test(l)), 'model://sun is never read from another model folder')

    got = await importFixture('sdf_broken')
    check(got.ok, `sdf_broken still imports (${got.error ?? ''})`)
    {
      const jn = Object.keys(got.joints ?? {})
      check(['j_ab', 'j_bc', 'j_ad'].every((n) => jn.includes(n)) && !['j_ca', 'j_bd', 'j_ghost'].some((n) => jn.includes(n)), `a joint closing a loop, a second parent and a missing link are left out (${jn.join(',')})`)
      for (const [text, what] of [
        ['Joints form a closed loop', 'a loop of joints'],
        ['child of two joints', 'a link with two parents'],
        ['does not exist, so it is left out', 'a joint to a missing link'],
        ['Poses refer to each other in a loop', 'frames relative to each other'],
        ['An included model was not imported', 'a missing include inside the model'],
      ]) check(said(got, 'error', text), `SDF reports ${what}`)
      check(sdfJoint(got, 'j_ae', 'continuous') && said(got, 'approx', 'screw joint'), 'a screw joint turns and is reported')
      posesMatch(got, { a: at([0, 0, 0]), e: at([0, 0, 1]) }, 'SDF: a pose through a frame loop falls back to the model frame')
    }
    got = await importFixture('sdf_circular')
    check(!got.ok && /^The description nests too deeply \(circular include of 'model:\/\/a'\)/.test(got.error ?? ''), `a circular SDF include is refused (${got.error ?? 'imported'})`)
    got = await importFixture('sdf_depth')
    check(!got.ok && /^The description nests too deeply \(include 'model:\/\/m9' is 9 includes deep\)/.test(got.error ?? ''), `SDF includes 9 deep are refused (${got.error ?? 'imported'})`)
    got = await importFixture('sdf_frame_chain')
    check(got.ok, `sdf_frame_chain imports (${got.error ?? ''})`)
    posesMatch(got, { arm: at([1, 0.9999, 0], [Math.SQRT1_2, 0, 0, Math.SQRT1_2]) }, 'SDF: a link placed through a chain of 10 000 frames, each in the one before')

    // the profile's standing height: base origin above the lowest point, a sole inside a foot mesh below the ankle's origin
    for (const [name, want, what] of [
      ['height_stl', 1, 'an STL foot mesh below the ankle'],
      ['height_obj', 1, 'an OBJ foot mesh (the loader picks the format by the path, not the blob URL)'],
      ['height_missing', 0.9, 'a foot mesh that was not imported: the ankle, and the import still works'],
    ]) {
      got = await importFixture(name)
      check(got.ok && got.profile?.category === 'biped' && got.profile.nominalPelvisHeight === want,
        `standing height from ${what}: ${want} m, not the 3 m width of the body (got ${JSON.stringify(got.profile ?? got.error)})`)
    }
    got = await importFixture('height_arm')
    check(got.ok && got.profile?.category === 'fixed_manipulator' && got.profile.nominalPelvisHeight === 0.45, `an arm keeps the fixed 0.45 m (got ${JSON.stringify(got.profile ?? got.error)})`)

    // a robot file in millimetres or Y-up (src/utils/unitsCheck.ts): found on the loaded meshes, offered, and right once fixed
    const isAbout = (a, b) => Math.abs(a - b) <= 1e-6
    for (const [name, fix, what] of [
      ['units_mm', { scale: 0.001, upY: 0 }, 'a biped in millimetres with STL feet'],
      ['units_yup', { scale: 1, upY: 1 }, 'a Y-up biped with OBJ feet'],
      ['units_ydown', { scale: 1, upY: -1 }, 'a biped standing along minus Y'],
      ['units_mm_yup', { scale: 0.001, upY: 1 }, 'a Y-up biped in millimetres'],
    ]) {
      got = await importFixture(name, { units: true })
      const u = got.units
      check(got.ok && JSON.stringify(u?.offer?.fix) === JSON.stringify(fix) && isAbout(u.size[1], 1.1) && u.size[0] < 0.5 && u.size[2] < 0.5 && u.groundAtBottom,
        `units: ${what} is found and, fixed, stands 1.1 m tall on its feet (got ${JSON.stringify(u ?? got.error)})`)
    }
    for (const [name, what] of [['height_stl', 'a Z-up biped in metres'], ['height_arm', 'an arm reaching 2 m down'], ['units_g1', 'the G1 sample'],
      ['units_33m', 'a biped 33 m tall (3.3 cm at 1/1000, too small for millimetres)'], ['units_6600m', 'a biped 6600 m tall (6.6 m at 1/1000, too big)']]) {
      got = await importFixture(name, { units: true })
      check(got.ok && got.units && got.units.offer === null, `units: ${what} is not flagged (got ${JSON.stringify(got.units?.offer ?? got.error)})`)
    }
    // --- the report as the dialog gets it: items, notes, xacro arguments, and what a failed import got to ---
    const items = (g, kind) => (g.report ?? []).filter((i) => i.kind === kind)
    got = await importFixture('tri_formats')
    {
      const lim = items(got, 'limit')
      const per = lim.find((i) => /^A mesh has more than 500,000 triangles/.test(i.message))
      const where = [...(per?.where ?? [])].sort()
      const want = ['tri_formats/meshes/g.glb: 500,001', 'tri_formats/meshes/p.dae: at least 500,001', 'tri_formats/meshes/q.obj: 500,002', 'tri_formats/meshes/t.dae: 600,000']
      check(got.ok && JSON.stringify(where) === JSON.stringify(want), `each mesh over 500,000 triangles is named with its count, in every format (got ${JSON.stringify(per?.where ?? got.error)})`)
      check(lim.some((i) => i.message === 'The meshes have at least 2,100,004 triangles in all, more than 2,000,000, so the robot may draw slowly.'),
        `the total says "at least" when a COLLADA file gives only a lower bound (got ${JSON.stringify(lim.map((i) => i.message))})`)
      check(got.warnings.length === got.notes.length + got.report.length && got.notes.every((n) => got.warnings.includes(n)),
        'the warnings are the notes and one line per report item')
    }
    got = await importFixture('tri_small')
    check(got.ok && items(got, 'limit').length === 0, `meshes under the limits, lines and other tags are not warned about (got ${JSON.stringify(items(got, 'limit'))})`)

    // a mesh the import does not have is never asked of a server (the path could name the user's own folders)
    got = await importFixture('missing_refs', { units: true })
    check(got.ok && got.stray.length === 0, `missing meshes (package://, file://, https://, relative) make no request (got ${JSON.stringify(got.stray ?? got.error)})`)
    check(items(got, 'error').length > 0, 'the missing meshes are still reported')

    // xacro arguments: declared ones with their defaults, needed ones with none, then the import again with a value
    got = await importFixture('xacro_args')
    check(got.ok && JSON.stringify(got.xacroArgs) === JSON.stringify([{ name: 'side', value: 'left' }, { name: 'prefix' }]) && got.mainFile === 'xacro_args/a.xacro',
      `the xacro's arguments come back in order, a needed one with no value (got ${JSON.stringify(got.xacroArgs)}, ${got.mainFile})`)
    check(!!got.joints?.j_left && got.warnings.some((l) => l.includes("needs the argument 'prefix'")), 'with no value the argument is empty and reported')
    got = await importFixture('xacro_args_set')
    check(got.ok && JSON.stringify(got.xacroArgs) === JSON.stringify([{ name: 'side', value: 'right' }, { name: 'prefix', value: 'p_' }]) && !!got.joints?.p_j_right,
      `given values replace the defaults and fill the needed one (got ${JSON.stringify(got.xacroArgs)}, joints ${Object.keys(got.joints ?? {})})`)
    got = await importFixture('xacro_args_late')
    check(got.ok && JSON.stringify(got.xacroArgs) === JSON.stringify([{ name: 'late' }]) && !!got.joints?.j_x,
      `an argument used before it is declared stays needed in the list, as it was where it failed (got ${JSON.stringify(got.xacroArgs)}, joints ${Object.keys(got.joints ?? {})})`)
    got = await importFixture('xacro_args_fail')
    check(!got.ok && /stop a/.test(got.error ?? '') && got.failure?.mainFile === 'xacro_args_fail/f.xacro' &&
      JSON.stringify(got.failure?.xacroArgs) === JSON.stringify([{ name: 'mode', value: 'a' }, { name: 'need' }]) &&
      got.failure.report.some((i) => i.kind === 'error' && i.message.includes("needs the argument 'need'")),
      `a failed import still gives its report, main file and arguments (got ${JSON.stringify(got.failure ?? got.error)})`)
    got = await importFixture('xacro_fatal')
    check(!got.ok && got.failure && JSON.stringify(got.failure.xacroArgs) === '[]', 'a xacro with no arguments fails with an empty list')

    check(strays.length === 0, `no fixture made a request outside the page and its files (${strays.join('; ')})`)
    check(errors.length === 0, `no page errors (${errors.join('; ')})`)
  } finally {
    await browser.close()
    server.close()
  }
}

finish('check-import')

/**
 * Bipeds for the standing height: a base 3 m wide in Y, legs whose ankle origin is 0.9 m below the base, and a foot mesh (the
 * unit tetrahedron scaled to 0.1 m) reaching 0.1 m lower, so the height is 1.0 m only if the mesh is loaded and measured on Z.
 */
function heightFixtures() {
  const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n'
  const limit = '<axis xyz="0 1 0"/><limit lower="-1" upper="1" effort="10" velocity="1"/>'
  const biped = (mesh) => `<robot name="hb">
  <link name="base_link"><visual><geometry><box size="0.2 3 0.2"/></geometry></visual></link>
${['left', 'right'].map((side, i) => `  <joint name="${side}_hip_joint" type="revolute"><parent link="base_link"/><child link="${side}_leg"/><origin xyz="0 ${i ? -0.1 : 0.1} -0.5"/>${limit}</joint>
  <link name="${side}_leg"/>
  <joint name="${side}_ankle_joint" type="revolute"><parent link="${side}_leg"/><child link="${side}_foot"/><origin xyz="0 0 -0.4"/>${limit}</joint>
  <link name="${side}_foot"><visual><origin xyz="0 0 -0.1"/><geometry><mesh filename="meshes/${mesh}" scale="0.1 0.1 0.1"/></geometry></visual></link>`).join('\n')}
</robot>`
  // the same biped standing along Y (or minus Y), in millimetres or not; its legs are 0.2 m apart along X
  const along = (mesh, k, up) => {
    const at = (d) => (up === 'z' ? `0 0 ${-d * k}` : `0 ${up === 'y' ? -d * k : d * k} 0`)
    const s = 0.1 * k
    return `<robot name="units">
  <link name="base_link"><visual><geometry><box size="${0.2 * k} ${0.2 * k} ${0.2 * k}"/></geometry></visual></link>
${['left', 'right'].map((side, i) => `  <joint name="${side}_hip_joint" type="revolute"><parent link="base_link"/><child link="${side}_leg"/><origin xyz="${(i ? -0.1 : 0.1) * k} ${at(0.5).split(' ').slice(1).join(' ')}"/>${limit}</joint>
  <link name="${side}_leg"/>
  <joint name="${side}_ankle_joint" type="revolute"><parent link="${side}_leg"/><child link="${side}_foot"/><origin xyz="${at(0.4)}"/>${limit}</joint>
  <link name="${side}_foot"><visual><origin xyz="${at(up === 'ydown' ? 0 : 0.1)}"/><geometry><mesh filename="meshes/${mesh}" scale="${s} ${s} ${s}"/></geometry></visual></link>`).join('\n')}
</robot>`
  }
  return {
    units_mm: { main: 'r.urdf', files: { 'r.urdf': along('foot.stl', 1000, 'z'), 'meshes/foot.stl': stl() } },
    units_yup: { main: 'r.urdf', files: { 'r.urdf': along('foot.obj', 1, 'y'), 'meshes/foot.obj': obj } },
    units_ydown: { main: 'r.urdf', files: { 'r.urdf': along('foot.obj', 1, 'ydown'), 'meshes/foot.obj': obj } },
    units_mm_yup: { main: 'r.urdf', files: { 'r.urdf': along('foot.stl', 1000, 'y'), 'meshes/foot.stl': stl() } },
    units_33m: { main: 'r.urdf', files: { 'r.urdf': along('foot.stl', 30, 'z'), 'meshes/foot.stl': stl() } },
    units_6600m: { main: 'r.urdf', files: { 'r.urdf': along('foot.stl', 6000, 'z'), 'meshes/foot.stl': stl() } },
    units_g1: { main: 'g1_29dof.urdf', g1: true },
    height_stl: { main: 'r.urdf', files: { 'r.urdf': biped('foot.stl'), 'meshes/foot.stl': stl() } },
    height_obj: { main: 'r.urdf', files: { 'r.urdf': biped('foot.obj'), 'meshes/foot.obj': obj } },
    height_missing: { main: 'r.urdf', files: { 'r.urdf': biped('foot.stl') } },
    height_arm: { main: 'r.urdf', files: { 'meshes/foot.stl': stl(), 'r.urdf': `<robot name="arm"><link name="base_link"/>
  <joint name="joint_1" type="revolute"><parent link="base_link"/><child link="l1"/><origin xyz="0 0 -2"/>${limit}</joint>
  <link name="l1"><visual><geometry><mesh filename="meshes/foot.stl"/></geometry></visual></link></robot>` } },
  }
}

/** A binary STL tetrahedron, small enough to inline. */
function stl() {
  // wound so every face points outward (MuJoCo rejects a mesh whose volume comes out negative)
  const tris = [[[0, 0, 0], [0, 1, 0], [1, 0, 0]], [[0, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 0, 0], [1, 0, 0], [0, 0, 1]], [[1, 0, 0], [0, 1, 0], [0, 0, 1]]]
  const b = Buffer.alloc(84 + 50 * tris.length)
  b.writeUInt32LE(tris.length, 80)
  tris.forEach((t, i) => t.flat().forEach((v, k) => b.writeFloatLE(v, 84 + 50 * i + 12 + 4 * k)))
  return b
}

/** A GLB of just a JSON chunk (no binary chunk: only the JSON is read for counting). */
function glb(json) {
  const text = Buffer.from(JSON.stringify(json))
  const body = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)])
  const head = Buffer.alloc(20)
  head.writeUInt32LE(0x46546c67, 0) // 'glTF'
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(20 + body.length, 8)
  head.writeUInt32LE(body.length, 12)
  head.writeUInt32LE(0x4e4f534a, 16) // 'JSON'
  return Buffer.concat([head, body])
}

/**
 * Robots for the triangle counts and for meshes the import does not have. A link per mesh; the meshes are only counted, never
 * drawn (except in missing_refs, loaded as the twin loads it), so they need not be whole files.
 */
function meshFixtures() {
  const limit = '<axis xyz="0 1 0"/><limit lower="-1" upper="1" effort="10" velocity="1"/>'
  const robot = (name, meshes) => `<robot name="${name}">
  <link name="base_link"><visual><geometry><box size="0.2 0.2 0.2"/></geometry></visual></link>
${meshes.map((m, i) => `  <joint name="j${i}" type="revolute"><parent link="base_link"/><child link="l${i}"/><origin xyz="0 0 -0.5"/>${limit}</joint>
  <link name="l${i}"><visual><geometry><mesh filename="${m}"/></geometry></visual></link>`).join('\n')}
</robot>`
  const dae = (body) => `<?xml version="1.0"?><COLLADA><library_geometries><geometry><mesh>${body}</mesh></geometry></library_geometries></COLLADA>`
  return {
    tri_formats: { main: 'r.urdf', files: {
      'r.urdf': robot('tri', ['meshes/q.obj', 'meshes/t.dae', 'meshes/g.glb', 'meshes/p.dae']),
      'meshes/q.obj': 'v 0 0 0\n' + 'f 1 2 3 4\n'.repeat(250_001), // 500,002: each quad is two
      'meshes/t.dae': dae('<triangles count="600000"/>'),
      'meshes/g.glb': glb({ accessors: [{ count: 1_500_003 }], meshes: [{ primitives: [{ indices: 0 }] }] }),
      'meshes/p.dae': dae('<polylist count="500001"/>'),
    } },
    tri_small: { main: 'r.urdf', files: {
      'r.urdf': robot('tri_small', ['meshes/q.obj', 'meshes/g.glb', 'meshes/l.dae']),
      'meshes/q.obj': 'f 1 2 3 4\n'.repeat(10),
      'meshes/g.glb': glb({ accessors: [{ count: 3_000_000 }], meshes: [{ primitives: [{ mode: 1, indices: 0 }] }] }),
      'meshes/l.dae': dae('<lines count="3000000"/><trianglesX count="3000000"/>'),
    } },
    // a biped (feet below the base) whose feet are nowhere in the import, named every way a robot file can name a file
    missing_refs: { main: 'r.urdf', files: { 'r.urdf': robot('missing', ['package://nopkg/meshes/gone.stl', 'file:///srv/robot/gone.stl',
      'https://example.invalid/m.stl', 'meshes/gone.stl']).replace(/name="j(\d)"/g, (_, i) => `name="${['left_hip', 'right_hip', 'left_ankle', 'right_ankle'][i]}_joint"`) } },
  }
}

/**
 * The MJCF fixtures: each is a folder of files and its main file. MuJoCo 3.17.0 compiles each one except missing_include and
 * circular (it refuses both); include_depth it compiles, but the importer stops includes 8 deep.
 */
function mjcfFixtures() {
  const joint = '<joint name="j0"/><geom size="0.1"/>'
  return {
    orient: { main: 'orient.xml', files: { 'orient.xml': `<mujoco model="orient">
  <worldbody>
    <body name="base">
      <joint name="deg" axis="0 0 1" range="-90 45"/>
      <geom size="0.1"/>
      <body name="b_quat" pos="1 0 0" quat="0.7071068 0 0 0.7071068"/>
      <body name="b_axisangle" pos="0 1 0" axisangle="0 1 0 90"/>
      <body name="b_euler" euler="90 90 0"/>
      <body name="b_xyaxes" xyaxes="0 1 0 -1 0 0"/>
      <body name="b_zaxis" zaxis="1 0 0"/>
      <body name="b_zaxis_down" zaxis="0 0 -1"/>
      <body name="b_near_lock" pos="0.1 0.2 0.3" quat="0.500003 0.5 -0.5 0.499997">
        <body name="b_after_lock" pos="0.4 0.5 0.6"/>
      </body>
    </body>
  </worldbody>
</mujoco>
` } },
    orient_extrinsic: { main: 'm.xml', files: { 'm.xml': `<mujoco model="orient_extrinsic">
  <compiler angle="radian" eulerseq="XYZ"/>
  <worldbody>
    <body name="base">
      ${joint}
      <body name="b_euler" euler="1.5707963267948966 1.5707963267948966 0"/>
      <body name="b_lock" euler="0.3 1.5707963267948966 0.2">
        <body name="b_after_lock" pos="0.4 0.5 0.6"/>
      </body>
    </body>
  </worldbody>
</mujoco>
` } },
    features: { main: 'main.xml', files: {
      'main.xml': `<mujoco model="features">
  <compiler angle="radian" meshdir="assets" autolimits="true"/>
  <include file="parts/defaults.xml"/>
  <asset>
    <mesh file="t.stl" scale="2 2 2"/>
    <mesh name="m2" class="big" file="sub/t.stl"/>
  </asset>
  <worldbody>
    <geom type="plane" size="1 1 0.1"/>
    <body name="torso" pos="0 0 1">
      <freejoint name="root"/>
      <geom size="0.1" material="green"/>
      <geom size="0.05" rgba="1 1 1 0"/>
      <frame pos="0 0.5 0" euler="0 0 1.5707963267948966" childclass="arm">
        <body name="upper" pos="0.2 0 0">
          <joint name="shoulder"/>
          <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.03" material="green"/>
          <body name="lower" pos="0.3 0 0" quat="0.9 0.1 0.2 0.3">
            <joint name="elbow_y" axis="0 1 0" pos="0.01 0 0"/>
            <joint name="elbow_z" axis="0 0 1" pos="0.02 0.01 0" range="-0.5 0.5"/>
            <geom type="mesh" mesh="t"/>
            <geom type="box" size="0.1 0.1 0.1" group="3"/>
            <body name="wrist" pos="0.2 0 0">
              <joint name="wrist_ball" type="ball" range="0 1"/>
              <geom type="ellipsoid" size="0.01 0.02 0.03"/>
              <body name="finger" pos="0.05 0 0" xyaxes="0 0 1 0 1 0">
                <joint name="slide" type="slide" range="0 0.04"/>
                <joint name="spin" limited="false" range="-1 1"/>
                <geom class="big" type="mesh" mesh="m2"/>
              </body>
            </body>
          </body>
        </body>
      </frame>
    </body>
  </worldbody>
</mujoco>
`,
      'parts/defaults.xml': `<mujoco>
  <default>
    <joint damping="1"/>
    <default class="arm">
      <joint axis="1 0 0" range="-1 1"/>
      <geom rgba="1 0 0 1"/>
      <default class="big">
        <mesh scale="3 3 3"/>
      </default>
    </default>
  </default>
  <include file="more.xml"/>
</mujoco>
`,
      'parts/more.xml': `<mujoco>
  <asset>
    <material name="green" rgba="0 1 0 1"/>
  </asset>
  <include file="deg.xml"/>
</mujoco>
`,
      // found next to the main file, not next to parts/more.xml (MuJoCo looks in both)
      'deg.xml': `<mujoco>
  <worldbody>
    <body name="deg_body" pos="0 0 2">
      <joint name="deg_rad" axis="0 0 1" range="-1.5 0.75"/>
      <geom size="0.1"/>
    </body>
  </worldbody>
</mujoco>
`,
      'assets/t.stl': stl(),
      'assets/sub/t.stl': stl(),
    } },
    missing_include: { main: 'm.xml', files: { 'm.xml': `<mujoco model="missing_include"><include file="not_here.xml"/><worldbody><body name="b">${joint}</body></worldbody></mujoco>\n` } },
    circular: { main: 'main.xml', files: {
      'main.xml': `<mujoco model="circular"><include file="a.xml"/><worldbody><body name="b">${joint}</body></worldbody></mujoco>\n`,
      'a.xml': '<mujoco><include file="main.xml"/></mujoco>\n',
    } },
    include_depth: { main: 'main.xml', files: {
      'main.xml': `<mujoco model="include_depth"><include file="d1.xml"/><worldbody><body name="b">${joint}</body></worldbody></mujoco>\n`,
      ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`d${i + 1}.xml`, i < 8 ? `<mujoco><include file="d${i + 2}.xml"/></mujoco>\n` : '<mujoco><worldbody/></mujoco>\n'])),
    } },
    ambiguous: { main: 'right.xml', files: {
      'left.xml': `<mujoco model="left"><worldbody><body name="b">${joint}</body></worldbody></mujoco>\n`,
      'right.xml': `<mujoco model="right"><worldbody><body name="b">${joint}</body></worldbody></mujoco>\n`,
    } },
  }
}

/**
 * What Python xacro 2.1.1 gives for the `xacro` fixture: its <x n v> elements in order ($(find pkg) gives a path there,
 * package://pkg here), and its output from the first macro call to the end with no whitespace between elements.
 */
function xacroExpected() {
  return {
    table: [["int", "3"], ["div", "0.5"], ["floordiv", "3"], ["pow", "1024"], ["neg", "-0.0015"], ["pi", "3.141592653589793"], ["third", "0.3333333333333333"], ["big", "1e+20"], ["small", "1e-07"], ["str", "ab"], ["upper", "ABC"], ["cond", "yes"], ["cmp", "True"], ["list", "[1, 2.5, 'a']"], ["index", "2.5"], ["slice", "[2.5, 'a']"], ["dict", "two"], ["len", "3"], ["minmax", "1 9"], ["round", "2.67"], ["intf", "3 2.0 5"], ["math", "1.4142135623730951 4.0 2"], ["abs", "4"], ["bool", "True"], ["none", "None"], ["lazy", "1.0"], ["eager", "2.0"], ["default", "0.5"], ["quoted", "7"], ["under", "1_0"], ["mix", "a0.5b2c"], ["escape", "${w} $(arg n)"], ["arg", "left 3 yes"], ["argexpr", "3"], ["eval", "7"], ["evalstr", "False"], ["find", "package://pkg"], ["optenv", "fallback"], ["tok", "['a', 'b', 'c', 'd']"], ["yaml-f", "1.5"], ["yaml-sub", "hip"], ["yaml-deg", "1.5707963267948966"], ["yaml-mm", "0.25"], ["yaml-bool", "True y"], ["yaml-num", "1e3 16 8"], ["yaml-list", "b 3"], ["ns", "1.0"], ["ns-macro", "t1 1.0"], ["m-a", "0.5"], ["m-b", "2"], ["m-c", "5"], ["m-a", "x"], ["m-b", "2"], ["m-c", "7"], ["m-a", "called"], ["m-b", "2"], ["m-c", "7"], ["inner", "kk"], ["parent", "42 g"], ["if-true", "1"], ["unless-0", "1"], ["if-1", "1"]],
    tail: "<x n=\"m-a\" v=\"0.5\"/><x n=\"m-b\" v=\"2\"/><x n=\"m-c\" v=\"5\"/><f n=\"first\"/><g><r1/><r2/></g><x n=\"m-a\" v=\"x\"/><x n=\"m-b\" v=\"2\"/><x n=\"m-c\" v=\"7\"/><f n=\"first2\"/><g/><x n=\"m-a\" v=\"called\"/><x n=\"m-b\" v=\"2\"/><x n=\"m-c\" v=\"7\"/><f n=\"first3\"/><g><r3/></g><x n=\"inner\" v=\"kk\"/><x n=\"parent\" v=\"42 g\"/><origin xyz=\"1 2 3\"/><made_left k=\"v\"><child/></made_left><y attr_left=\"w=0.5\"/><x n=\"if-true\" v=\"1\"/><x n=\"unless-0\" v=\"1\"/><x n=\"if-1\" v=\"1\"/><!-- w is 0.5 --><z/><!-- not evaluated ${w} -->",
  }
}

/**
 * The xacro fixtures. `xacro` covers what the expression table above checks; Python xacro 2.1.1 expands it (args
 * given:=yes) to xacroExpected(). `xacro_errors` holds one of each error the importer reports and goes on past; Python
 * xacro stops at the first. `xacro_fatal` and `xacro_eval_cap` stop the import.
 */
function xacroFixtures() {
  const joint = '<link name="base"/><link name="arm"/><joint name="j" type="revolute"><parent link="base"/><child link="arm"/><axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint>'
  const argsXacro = `<robot name="xa" xmlns:xacro="http://www.ros.org/wiki/xacro">
  <xacro:arg name="side" default="left"/>
  <link name="base"/><link name="arm"/>
  <joint name="$(arg prefix)j_$(arg side)" type="revolute"><parent link="base"/><child link="arm"/><axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint>
</robot>`
  const robot = (name, body) => `<robot name="${name}" xmlns:xacro="http://www.ros.org/wiki/xacro">${joint}${body}</robot>`
  return {
    xacro: { main: 'pkg/urdf/main.xacro', options: { xacroArgs: { given: 'yes' } }, files: {
      'pkg/urdf/main.xacro': `<?xml version="1.0"?>
<robot name="xt" xmlns:xacro="http://www.ros.org/wiki/xacro">
  <xacro:arg name="side" default="left"/>
  <xacro:arg name="n" default="3"/>
  <xacro:arg name="given" default="unset"/>
  <xacro:property name="side" value="$(arg side)"/>
  <xacro:property name="w" value="0.5"/>
  <xacro:property name="lazy" value="\${w * 2}"/>
  <xacro:property name="eager" value="\${w * 4}" lazy_eval="false"/>
  <xacro:property name="w" default="9"/>
  <xacro:property name="gone" value="1"/>
  <xacro:property name="gone" remove="true"/>
  <xacro:property name="lst" value="\${[1, 2.5, 'a']}"/>
  <xacro:property name="d" value="\${dict(a=1, b='two')}"/>
  <xacro:property name="quoted" value="'007'"/>
  <xacro:property name="under" value="1_0"/>
  <xacro:property name="blk"><origin xyz="1 2 3"/></xacro:property>
  <xacro:property name="cfg" value="\${xacro.load_yaml('../config/p.yaml')}"/>
  <xacro:include filename="$(find pkg)/urdf/parts.xacro" ns="parts"/>

  <xacro:macro name="m" params="a b:=2 c:=^|7 *first **rest">
    <x n="m-a" v="\${a}"/>
    <x n="m-b" v="\${b}"/>
    <x n="m-c" v="\${c}"/>
    <xacro:insert_block name="first"/>
    <g><xacro:insert_block name="rest"/></g>
  </xacro:macro>
  <xacro:macro name="outer" params="k">
    <xacro:macro name="inner" params="">
      <x n="inner" v="\${k}"/>
    </xacro:macro>
    <xacro:inner/>
  </xacro:macro>
  <xacro:macro name="setp" params="">
    <xacro:property name="fromparent" value="\${42}" scope="parent"/>
    <xacro:property name="fromglobal" value="g" scope="global"/>
  </xacro:macro>

  <link name="base"/>
  <link name="arm_\${side}"/>
  <joint name="j_\${side}" type="revolute">
    <parent link="base"/><child link="arm_\${side}"/>
    <axis xyz="0 0 1"/>
    <limit lower="\${-pi/2}" upper="\${radians(45)}" effort="1" velocity="1"/>
  </joint>
  <x n="int" v="\${1+2}"/>
  <x n="div" v="\${1/2}"/>
  <x n="floordiv" v="\${7//2}"/>
  <x n="pow" v="\${2**10}"/>
  <x n="neg" v="\${-1.5e-3}"/>
  <x n="pi" v="\${pi}"/>
  <x n="third" v="\${1/3}"/>
  <x n="big" v="\${1e20}"/>
  <x n="small" v="\${1e-7}"/>
  <x n="str" v="\${'a' + 'b'}"/>
  <x n="upper" v="\${'abc'.upper()}"/>
  <x n="cond" v="\${'yes' if w > 0.1 else 'no'}"/>
  <x n="cmp" v="\${1 &lt; 2 &lt; 3}"/>
  <x n="list" v="\${lst}"/>
  <x n="index" v="\${lst[1]}"/>
  <x n="slice" v="\${lst[-2:]}"/>
  <x n="dict" v="\${d['b']}"/>
  <x n="len" v="\${len(lst)}"/>
  <x n="minmax" v="\${min(3, 1, 2)} \${max([4, 9])}"/>
  <x n="round" v="\${round(2.675, 2)}"/>
  <x n="intf" v="\${int(3.9)} \${float(2)} \${str(5)}"/>
  <x n="math" v="\${math.sqrt(2)} \${sqrt(16)} \${floor(2.5)}"/>
  <x n="abs" v="\${python.abs(-4)}"/>
  <x n="bool" v="\${True and not False}"/>
  <x n="none" v="\${None}"/>
  <x n="lazy" v="\${lazy}"/>
  <x n="eager" v="\${eager}"/>
  <x n="default" v="\${w}"/>
  <x n="quoted" v="\${quoted}"/>
  <x n="under" v="\${under}"/>
  <x n="mix" v="a\${w}b\${1+1}c"/>
  <x n="escape" v="$\${w} $$(arg n)"/>
  <x n="arg" v="$(arg side) $(arg n) $(arg given)"/>
  <x n="argexpr" v="\${xacro.arg('n')}"/>
  <x n="eval" v="$(eval 2 * n + 1)"/>
  <x n="evalstr" v="$(eval side == 'right')"/>
  <x n="find" v="$(find pkg)"/>
  <x n="optenv" v="$(optenv ROCO_NOT_SET fallback)"/>
  <x n="tok" v="\${xacro.tokenize('a b,c;d')}"/>
  <x n="yaml-f" v="\${cfg.joint.limit}"/>
  <x n="yaml-sub" v="\${cfg['joint']['name']}"/>
  <x n="yaml-deg" v="\${cfg.joint.angle}"/>
  <x n="yaml-mm" v="\${cfg.joint.len}"/>
  <x n="yaml-bool" v="\${cfg['flags'][True]} \${cfg.flags.y}"/>
  <x n="yaml-num" v="\${cfg.flags.exp} \${cfg.flags.hex} \${cfg.flags.lead}"/>
  <x n="yaml-list" v="\${cfg['items'][1]} \${len(cfg.keys())}"/>
  <x n="ns" v="\${parts.size}"/>
  <xacro:parts.thing name="t1"/>
  <xacro:m a="\${w}" c="5"><f n="first"/><r><r1/><r2/></r></xacro:m>
  <xacro:m a="x"><f n="first2"/><r/></xacro:m>
  <xacro:call macro="m" a="called"><f n="first3"/><r><r3/></r></xacro:call>
  <xacro:outer k="kk"/>
  <xacro:setp/>
  <x n="parent" v="\${fromparent} \${fromglobal}"/>
  <xacro:insert_block name="blk"/>
  <xacro:element xacro:name="made_\${side}" k="v"><child/></xacro:element>
  <y><xacro:attribute name="attr_\${side}" value="w=\${w}"/></y>
  <xacro:if value="\${w > 0}"><x n="if-true" v="1"/></xacro:if>
  <xacro:if value="false"><x n="if-false" v="1"/></xacro:if>
  <xacro:unless value="0"><x n="unless-0" v="1"/></xacro:unless>
  <xacro:if value="1"><x n="if-1" v="1"/></xacro:if>
  <!-- xacro:eval-comments -->
  <!-- w is \${w} -->
  <z/>
  <!-- not evaluated \${w} -->
</robot>
`,
      'pkg/urdf/parts.xacro': `<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro">
  <xacro:property name="size" value="\${0.25 * 4}"/>
  <xacro:macro name="thing" params="name">
    <x n="ns-macro" v="\${name} \${size}"/>
  </xacro:macro>
</robot>
`,
      'pkg/config/p.yaml': `joint:
  name: hip
  limit: 1.5
  angle: !degrees 90
  len: !millimeters 250
flags:
  on: on
  y: y
  exp: 1e3
  hex: 0x10
  lead: 010
items: [a, b, c]
`,
    } },
    xacro_errors: { main: 'errs.xacro', files: {
      'errs.xacro': `<?xml version="1.0"?>
<robot name="errs" xmlns:xacro="http://www.ros.org/wiki/xacro">
  <xacro:property name="a" value="\${b}"/>
  <xacro:property name="b" value="\${a}"/>
  <xacro:property name="1x" value="1"/>
  <xacro:property name="__x" value="1"/>
  <xacro:property name="bomb" value="\${xacro.load_yaml('bomb.yaml')}"/>
  <xacro:property name="ok" value="\${xacro.load_yaml('ok.yaml')}"/>
  <xacro:macro name="needs" params="p q:=1"><x n="needs" v="\${p}"/></xacro:macro>
  <link name="base"/>
  <link name="arm"/>
  <joint name="j" type="revolute">
    <parent link="base"/><child link="arm"/><axis xyz="0 0 1"/>
    <limit lower="-1" upper="1" effort="1" velocity="1"/>
  </joint>
  <x n="circ" v="\${a}"/>
  <xacro:nope/>
  <x n="dunder" v="\${'a'.__class__}"/>
  <x n="evaldunder" v="$(eval __import__('os'))"/>
  <x n="noarg" v="$(arg nothere)"/>
  <x n="abs" v="\${abs(-1)}"/>
  <x n="method" v="\${ok.items[0]}"/>
  <x n="bomb" v="\${bomb}"/>
  <xacro:needs q="2"/>
  <xacro:needs p="1" zz="3"/>
  <xacro:if value="maybe"><x n="maybe" v="1"/></xacro:if>
  <x n="after" v="still here"/>
</robot>
`,
      'ok.yaml': `items: [a, b]
`,
      'bomb.yaml': `a: &a [x, x, x, x, x, x, x, x, x]
b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]
c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]
d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]
e: [*d, *d, *d, *d, *d, *d, *d, *d, *d]
`,
    } },
    xacro_fatal: { main: 'f.xacro', files: { 'f.xacro': robot('f', '<link name="${xacro.fatal(\'stop here\')}"/>') } },
    xacro_args: { main: 'a.xacro', files: { 'a.xacro': argsXacro } },
    xacro_args_set: { main: 'a.xacro', options: { xacroArgs: { side: 'right', prefix: 'p_' } }, files: { 'a.xacro': argsXacro } },
    xacro_args_late: { main: 'l.xacro', files: { 'l.xacro': `<robot name="al" xmlns:xacro="http://www.ros.org/wiki/xacro">
  <link name="base"/><link name="arm"/>
  <joint name="j$(arg late)_x" type="revolute"><parent link="base"/><child link="arm"/><axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint>
  <xacro:arg name="late" default="d"/>
</robot>` } },
    xacro_args_fail: { main: 'f.xacro', files: { 'f.xacro': `<robot name="af" xmlns:xacro="http://www.ros.org/wiki/xacro">
  <xacro:arg name="mode" default="a"/>
  <xacro:property name="m" value="$(arg mode)$(arg need)"/>
  ${joint}<link name="\${xacro.fatal('stop ' + m)}"/>
</robot>` } },
    xacro_eval_cap: { main: 'e.xacro', files: { 'e.xacro': robot('e', '<link name="$(eval \'x\' * 20000)"/>') } },
  }
}

/**
 * The SDFormat fixtures. Each pose below is worked out by hand from the SDFormat specification (gz sdf -k, libsdformat 9.7,
 * accepts the 1.4-1.7 ones); `sdf_frames` is 1.9, for degrees, quat_xyzw and expressed_in. A `main` of null leaves the
 * importer to pick the main file.
 */
function sdfFixtures() {
  const link = (name, pose = '') => `<link name="${name}">${pose}</link>`
  const limit = (lo, hi) => `<limit><lower>${lo}</lower><upper>${hi}</upper></limit>`
  return {
    sdf_frames: { main: 'frames.sdf', files: { 'frames.sdf': `<?xml version="1.0"?>
<!-- a comment before the root -->
<sdf version="1.9">
  <model name="arm">
    <pose>5 0 0 0 0 0</pose>
    <frame name="mount" attached_to="__model__"><pose>0 0 1 0 0 1.5707963267948966</pose></frame>
    ${link('base')}
    <link name="upper">
      <pose relative_to="mount">1 0 0 0 0 0</pose>
      <visual name="v"><geometry><box><size>0.1 0.2 0.3</size></box></geometry><material><diffuse>1 0 0 1</diffuse></material></visual>
      <visual name="cap"><pose>0 0 1 0 0 0</pose><geometry><capsule><radius>0.03</radius><length>0.3</length></capsule></geometry></visual>
      <visual name="hidden"><transparency>1</transparency><geometry><sphere><radius>1</radius></sphere></geometry><material><diffuse>0 0 1 1</diffuse></material></visual>
    </link>
    <joint name="shoulder" type="revolute">
      <parent>base</parent><child>upper</child>
      <pose>0 0 0.5 0 0 0</pose>
      <axis><xyz expressed_in="__model__">1 0 0</xyz>${limit(-1, 2)}</axis>
    </joint>
    ${link('deg', '<pose degrees="true" relative_to="upper">0 0 0 0 0 90</pose>')}
    <joint name="spin" type="revolute"><parent>upper</parent><child>deg</child></joint>
    ${link('q', '<pose rotation_format="quat_xyzw" relative_to="upper">0 0 0.2 0 0 0.7071067811865476 0.7071067811865476</pose>')}
    <joint name="slide" type="prismatic"><parent>upper</parent><child>q</child><axis><xyz>0 1 0</xyz>${limit(0, 0.04)}</axis></joint>
    ${link('b', '<pose relative_to="q"/>')}
    <joint name="wrist_ball" type="ball"><parent>q</parent><child>b</child></joint>
    <link name="u">
      <pose relative_to="b">0 0 0.1 0 0 0</pose>
      <visual name="e"><geometry><ellipsoid><radii>0.01 0.03 0.02</radii></ellipsoid></geometry></visual>
    </link>
    <joint name="uni" type="universal"><parent>b</parent><child>u</child><axis><xyz>1 0 0</xyz>${limit(-0.5, 0.5)}</axis><axis2><xyz>0 1 0</xyz>${limit(-0.25, 0.25)}</axis2></joint>
    ${link('lost', '<pose relative_to="nowhere">1 2 3 0 0 0</pose>')}
    <joint name="to_lost" type="fixed"><parent>base</parent><child>lost</child></joint>
  </model>
</sdf>
` } },
    sdf_nested: { main: null, files: {
      'rover/model.config': '<?xml version="1.0"?><model><name>rover</name><sdf version="1.7">model.sdf</sdf></model>\n',
      'rover/model.sdf': `<?xml version="1.0"?>
<sdf version="1.7">
  <model name="rover">
    <link name="chassis"><visual name="v"><geometry><mesh><uri>model://rover/meshes/t.stl</uri><scale>2 2 2</scale></mesh></geometry></visual></link>
    <model name="arm">
      <pose>1 0 0 0 0 0</pose>
      ${link('l1', '<pose>0 0 1 0 0 0</pose>')}
      <joint name="j" type="revolute"><parent>l1</parent><child>l2</child><axis><xyz>0 1 0</xyz>${limit(-0.5, 0.5)}</axis></joint>
      ${link('l2', '<pose relative_to="l1">0 0 0.5 0 0 0</pose>')}
    </model>
    <joint name="mount" type="fixed"><parent>chassis</parent><child>arm::l1</child></joint>
    <include><uri>model://wheel</uri><name>wheel_left</name><pose>0 1 0 -1.5707963267948966 0 0</pose></include>
    <joint name="axle_left" type="continuous"><parent>chassis</parent><child>wheel_left::rim</child><axis><xyz expressed_in="__model__">0 1 0</xyz></axis></joint>
    <include><uri>model://wheel</uri><name>wheel_right</name><pose>0 -1 0 1.5707963267948966 0 0</pose></include>
    <joint name="axle_right" type="revolute"><parent>chassis</parent><child>wheel_right::rim</child><axis><xyz>0 0 1</xyz></axis></joint>
  </model>
</sdf>
`,
      'rover/meshes/t.stl': stl(),
      'wheel/model.config': '<?xml version="1.0"?><model><name>wheel</name><sdf version="1.5">old.sdf</sdf><sdf version="1.6">wheel.sdf</sdf></model>\n',
      'wheel/wheel.sdf': `<?xml version="1.0"?>
<sdf version="1.6">
  <model name="wheel">
    <link name="rim"><visual name="v"><geometry><mesh><uri>meshes/tire.stl</uri></mesh></geometry></visual></link>
    ${link('cap', '<pose>0 0 0.1 0 0 1.5707963267948966</pose>')}
    <joint name="cap_j" type="revolute"><parent>rim</parent><child>cap</child><axis><xyz>1 0 0</xyz><use_parent_model_frame>true</use_parent_model_frame>${limit(-1, 1)}</axis></joint>
  </model>
</sdf>
`,
      'wheel/meshes/tire.stl': stl(),
    } },
    sdf_world: { main: 'world.sdf', files: {
      'world.sdf': `<?xml version="1.0"?>
<sdf version="1.4">
  <world name="w">
    <include><uri>model://sun</uri></include>
    <model name="crate">${link('c')}</model>
    <model name="bot">
      <pose>0 0 1 0 0 0</pose>
      ${link('base', '<pose>0 0 0 0 0 1.5707963267948966</pose>')}
      <joint name="hinge" type="revolute"><parent>world</parent><child>base</child><axis><xyz>1 0 0</xyz>${limit(-1, 1)}</axis></joint>
    </model>
  </world>
</sdf>
`,
      // a model folder that is not the sun: model://sun must never be read from it
      'other/model.config': '<?xml version="1.0"?><model><name>other</name><sdf version="1.4">model.sdf</sdf></model>\n',
      'other/model.sdf': `<?xml version="1.0"?><sdf version="1.4"><model name="other">${link('o')}</model></sdf>\n`,
    } },
    sdf_broken: { main: 'broken.sdf', files: { 'broken.sdf': `<?xml version="1.0"?>
<sdf version="1.7">
  <model name="broken">
    ${link('a')}${link('b')}${link('c')}${link('d')}
    <joint name="j_ab" type="revolute"><parent>a</parent><child>b</child><axis><xyz>0 0 1</xyz>${limit(-1, 1)}</axis></joint>
    <joint name="j_bc" type="revolute"><parent>b</parent><child>c</child><axis><xyz>0 0 1</xyz>${limit(-1, 1)}</axis></joint>
    <joint name="j_ca" type="revolute"><parent>c</parent><child>a</child><axis><xyz>0 0 1</xyz>${limit(-1, 1)}</axis></joint>
    <joint name="j_ad" type="fixed"><parent>a</parent><child>d</child></joint>
    <joint name="j_bd" type="fixed"><parent>b</parent><child>d</child></joint>
    <joint name="j_ghost" type="fixed"><parent>a</parent><child>ghost</child></joint>
    <frame name="f1"><pose relative_to="f2"/></frame>
    <frame name="f2"><pose relative_to="f1"/></frame>
    <link name="e"><pose relative_to="f1">0 0 1 0 0 0</pose></link>
    <joint name="j_ae" type="screw"><parent>a</parent><child>e</child></joint>
    <include><uri>model://absent</uri></include>
  </model>
</sdf>
` } },
    sdf_circular: { main: 'a/model.sdf', files: {
      'a/model.sdf': `<sdf version="1.7"><model name="a">${link('l')}<include><uri>model://b</uri></include></model></sdf>\n`,
      'b/model.sdf': `<sdf version="1.7"><model name="b">${link('l')}<include><uri>model://a</uri></include></model></sdf>\n`,
    } },
    sdf_depth: { main: 'm0/model.sdf', files: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`m${i}/model.sdf`,
      `<sdf version="1.7"><model name="m${i}">${link('l')}${i < 9 ? `<include><uri>model://m${i + 1}</uri></include>` : ''}</model></sdf>\n`])) },
    // f1 is turned 90° about z; each of the 9 999 frames after it is 0.1 mm along the x of the one before, so along world y
    sdf_frame_chain: { main: 'chain.sdf', files: { 'chain.sdf': `<sdf version="1.7"><model name="chain"><frame name="f0"/>
<frame name="f1"><pose relative_to="f0">1 0 0 0 0 1.5707963267948966</pose></frame>
${Array.from({ length: 9999 }, (_, i) => `<frame name="f${i + 2}"><pose relative_to="f${i + 1}">0.0001 0 0 0 0 0</pose></frame>`).join('\n')}
${link('base')}${link('arm', '<pose relative_to="f10000">0 0 0 0 0 0</pose>')}
<joint name="j" type="revolute"><parent>base</parent><child>arm</child><axis><xyz>0 0 1</xyz>${limit(-1, 1)}</axis></joint></model></sdf>
` } },
  }
}
