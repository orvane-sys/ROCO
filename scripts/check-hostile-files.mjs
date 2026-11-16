// Checks that hostile imported files end in a named refusal, never a crash or a hang, and that good ones still import.
// The zips are written here (in a temp folder, removed at the end), then checked twice:
//   1. in Node, against the zip worker's own code (src/workers/zipWorker.ts): each case's reason, and for good zips that
//      every file comes out byte-equal;
//   2. through the built page's import dialog (dist/, so under its real CSP), where the same message must show, with no
//      page error and no CSP violation, and a good zip must import and draw its meshes.
// Then hostile description files (entities, a file over the text cap, nesting, exponential expansion, long expressions, the
// 30 s limit, a huge mesh) go through the page only, since their parsing needs the browser's DOMParser: each must end in
// its message within 35 s.
//
//   node scripts/check-hostile-files.mjs            (needs npm run build first)
//   node scripts/check-hostile-files.mjs --memory   (also a 477 MiB near-limit zip through the page; prints peak memory)
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'
import { rolldown } from 'rolldown'
import { guardCsp, PAGE_READY_MS, startBrowser, tally } from './lib-browser.mjs'

const root = new URL('..', import.meta.url)
const memory = process.argv.includes('--memory')

// --- a small zip writer, with knobs for lying ------------------------------------------------------------------------
/**
 * entries: { name (string, or a Buffer for raw bytes), data, method (0 stored, 8 deflate), level, host (0, or 3 Unix),
 *   attr (external attributes), cdFlags (extra flag bits in the directory only), usize (declared size, in both headers),
 *   cd: { csize, usize } (declared in the directory only), descriptor (sizes in a data descriptor after the data) }
 */
function zip(entries, { zip64 = false } = {}) {
  const parts = []
  const central = []
  let off = 0
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8')
    const utf8 = !Buffer.isBuffer(e.name) && Buffer.byteLength(e.name) !== e.name.length // non-ASCII
    const data = e.data ?? Buffer.alloc(0)
    const method = e.method ?? 8
    const comp = method === 8 ? deflateRawSync(data, { level: e.level ?? 6 }) : data
    const crc = crc32(data)
    const flags = (utf8 ? 0x800 : 0) | (e.descriptor ? 8 : 0)
    const usize = e.usize ?? data.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    if (!e.descriptor) {
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(comp.length, 18)
      local.writeUInt32LE(usize, 22)
    }
    local.writeUInt16LE(name.length, 26)
    const lho = off
    parts.push(local, name, comp)
    off += 30 + name.length + comp.length
    if (e.descriptor) {
      const dd = Buffer.alloc(16)
      dd.writeUInt32LE(0x08074b50, 0)
      dd.writeUInt32LE(crc, 4)
      dd.writeUInt32LE(comp.length, 8)
      dd.writeUInt32LE(usize, 12)
      parts.push(dd)
      off += 16
    }
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c[4] = 20
    c[5] = e.host ?? 0
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(flags | (e.cdFlags ?? 0), 8)
    c.writeUInt16LE(method, 10)
    c.writeUInt32LE(crc, 16)
    const cs = e.cd?.csize ?? comp.length
    const us = e.cd?.usize ?? usize
    let extra = Buffer.alloc(0)
    if (zip64) {
      extra = Buffer.alloc(28)
      extra.writeUInt16LE(1, 0)
      extra.writeUInt16LE(24, 2)
      extra.writeBigUInt64LE(BigInt(us), 4)
      extra.writeBigUInt64LE(BigInt(cs), 12)
      extra.writeBigUInt64LE(BigInt(lho), 20)
      c.writeUInt32LE(0xffffffff, 20)
      c.writeUInt32LE(0xffffffff, 24)
      c.writeUInt32LE(0xffffffff, 42)
    } else {
      c.writeUInt32LE(cs, 20)
      c.writeUInt32LE(us, 24)
      c.writeUInt32LE(lho, 42)
    }
    c.writeUInt16LE(name.length, 28)
    c.writeUInt16LE(extra.length, 30)
    c.writeUInt32LE(e.attr ?? 0, 38)
    central.push(c, name, extra)
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  if (zip64) {
    const rec = Buffer.alloc(56)
    rec.writeUInt32LE(0x06064b50, 0)
    rec.writeBigUInt64LE(44n, 4)
    rec.writeUInt16LE(45, 12)
    rec.writeUInt16LE(45, 14)
    rec.writeBigUInt64LE(BigInt(entries.length), 24)
    rec.writeBigUInt64LE(BigInt(entries.length), 32)
    rec.writeBigUInt64LE(BigInt(cd.length), 40)
    rec.writeBigUInt64LE(BigInt(off), 48)
    const loc = Buffer.alloc(20)
    loc.writeUInt32LE(0x07064b50, 0)
    loc.writeBigUInt64LE(BigInt(off + cd.length), 8)
    loc.writeUInt32LE(1, 16)
    end.writeUInt16LE(0xffff, 8)
    end.writeUInt16LE(0xffff, 10)
    end.writeUInt32LE(0xffffffff, 12)
    end.writeUInt32LE(0xffffffff, 16)
    return Buffer.concat([...parts, cd, rec, loc, end])
  }
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(off, 16)
  return Buffer.concat([...parts, cd, end])
}

// --- the cases -------------------------------------------------------------------------------------------------------
let seed = 7
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
/** A binary STL with `n` random triangles, two in three repeated (compresses about like a real mesh). */
function stl(n) {
  const b = Buffer.alloc(84 + 50 * n)
  b.writeUInt32LE(n, 80)
  const tri = Buffer.alloc(50)
  for (let i = 0; i < n; i++) {
    if (i % 3 === 0) for (let k = 0; k < 12; k++) tri.writeFloatLE(rand() * 2 - 1, k * 4)
    tri.copy(b, 84 + 50 * i)
  }
  return b
}
const urdf = (name, meshes) =>
  Buffer.from(
    `<?xml version="1.0"?>\n<robot name="${name}">\n` +
      `  <link name="base"><visual><geometry><mesh filename="${meshes[0]}"/></geometry></visual></link>\n` +
      `  <link name="arm">${meshes.slice(1).map((m) => `<visual><geometry><mesh filename="${m}"/></geometry></visual>`).join('')}</link>\n` +
      `  <joint name="j1" type="revolute"><parent link="base"/><child link="arm"/><axis xyz="0 0 1"/>` +
      `<limit lower="-1" upper="1" effort="1" velocity="1"/></joint>\n</robot>\n`,
  )
const robot = (name) => ({
  'robot/model.urdf': urdf(name, ['meshes/a.stl', 'meshes/b.stl', 'meshes/été.stl']),
  'robot/meshes/a.stl': stl(2000),
  'robot/meshes/b.stl': stl(3000),
  'robot/meshes/été.stl': stl(500),
})
const entriesOf = (files, method) => [{ name: 'robot/', method: 0 }, ...Object.entries(files).map(([name, data]) => ({ name, data, method }))]
const good = (files, title) => ({ ok: true, files, title })
const bad = (reason) => ({ ok: false, reason })

const cases = []
const add = (name, bytes, want) => cases.push({ name, bytes, want })
{
  const f = robot('zip_normal')
  add('normal', zip([...entriesOf(f, 8), { name: '__MACOSX/robot/._model.urdf', data: Buffer.from('mac extra') }, { name: 'robot/.DS_Store', data: Buffer.from('x') }]),
    good(f, 'zip normal'))
}
add('dotdot', zip([{ name: 'ok.txt', data: Buffer.from('ok') }, { name: '../x', data: Buffer.from('bad') }]), bad('name'))
{
  const f = robot('zip_stored')
  add('normal_stored', zip(entriesOf(f, 0)), good(f, 'zip stored'))
}
add('abs', zip([{ name: 'ok.txt', data: Buffer.from('ok') }, { name: '/abs', data: Buffer.from('bad') }]), bad('name'))
{
  const f = { 'robot/model.urdf': urdf('zip_big', ['meshes/m00.stl', 'meshes/m01.stl']) }
  for (let i = 0; i < 40; i++) f[`robot/meshes/m${String(i).padStart(2, '0')}.stl`] = stl(50000)
  add('big', zip(entriesOf(f, 8)), good(f, 'zip big'))
}
add('backslash', zip([{ name: 'ok.txt', data: Buffer.from('ok') }, { name: 'a\\..\\..\\x', data: Buffer.from('bad') }]), bad('name'))
add('many', zip(Array.from({ length: 20000 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x'), method: 0 }))), bad('entries'))
add('drive', zip([{ name: 'ok.txt', data: Buffer.from('ok') }, { name: 'C:/x', data: Buffer.from('bad') }]), bad('name'))
add('bomb', zip([{ name: 'zeros.bin', data: Buffer.alloc(100 * 2 ** 20), level: 9 }]), bad('ratio'))
add('nul', zip([{ name: 'ok.txt', data: Buffer.from('ok') }, { name: Buffer.from('a\0b'), data: Buffer.from('bad') }]), bad('name'))
add('symlink', zip([{ name: 'robot/link', data: Buffer.from('/etc/passwd'), host: 3, attr: (0o120777 << 16) >>> 0 }]), bad('symlink'))
add('notzip', Buffer.from('this is not a zip file at all'.repeat(10)), bad('not a zip'))
add('duplicate', zip([{ name: 'a.txt', data: Buffer.from('1') }, { name: 'a.txt', data: Buffer.from('2') }]), bad('duplicate'))
add('total', zip([0, 1, 2].map((i) => ({ name: `part${i}.bin`, data: Buffer.alloc(16, 0x70), method: 0, cd: { csize: 1_800_000, usize: 180 * 2 ** 20 } }))), bad('total'))
add('lying', zip([{ name: 'mesh.stl', data: stl(200000).subarray(0, 10 * 2 ** 20), usize: 1024 }]), bad('crc'))
add('encrypted_flag', zip([{ name: 's.txt', data: Buffer.from('secret'), cdFlags: 1 }]), bad('encrypted'))
add('truncated', cases[0].bytes.subarray(0, cases[0].bytes.length >> 1), bad('not a zip'))
// beyond S6's 17: the per-file cap, zip64 directories, data descriptors, unknown methods
add('toobig', zip([{ name: 'robot/model.urdf', data: Buffer.alloc(16, 0x20), method: 0, cd: { csize: 16, usize: 40 * 2 ** 20 } }]), bad('too big'))
{
  const f = robot('zip_zip64')
  add('zip64', zip(entriesOf(f, 8), { zip64: true }), good(f, 'zip zip64'))
}
{
  // a stored entry relabelled as method 12 (bzip2) in both headers
  const b = zip([{ name: 'a.txt', data: Buffer.from('x'), method: 0 }])
  b.writeUInt16LE(12, 8)
  b.writeUInt16LE(12, b.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 10)
  add('method', b, bad('method'))
}
{
  const f = robot('zip_descriptor')
  add('descriptor', zip(entriesOf(f, 8).map((e) => ({ ...e, descriptor: true }))), good(f, 'zip descriptor'))
}
if (memory) {
  // 200 meshes of 2.5 MB: about 477 MiB unpacked, just under the 512 MiB total
  const f = { 'robot/model.urdf': urdf('zip_near', ['meshes/m000.stl', 'meshes/m001.stl']) }
  const base = stl(4096)
  for (let i = 0; i < 200; i++) {
    const m = Buffer.alloc(84 + 50 * 50000)
    m.writeUInt32LE(50000, 80)
    for (let t = 0; t < 50000; t++) base.copy(m, 84 + 50 * t, 84 + 50 * ((t * 2654435761 + i) % 4093), 84 + 50 * ((t * 2654435761 + i) % 4093) + 50)
    f[`robot/meshes/m${String(i).padStart(3, '0')}.stl`] = m
  }
  add('near', zip(Object.entries(f).map(([name, data]) => ({ name, data, level: 1 }))), good(f, 'zip near'))
}

// --- description files ----------------------------------------------------------------------------------------------
const X = 'xmlns:xacro="http://www.ros.org/wiki/xacro"'
const XML = '<?xml version="1.0"?>\n'
/** A xacro whose macro m<levels> calls m<levels-1> `width` times, down to m0, whose body is `body`: width^levels copies. */
const fan = (name, levels, width, body, before = '') => {
  let t = `${XML}<robot ${X} name="${name}">\n${before}  <xacro:macro name="m0" params="">${body}</xacro:macro>\n`
  for (let l = 1; l <= levels; l++) t += `  <xacro:macro name="m${l}" params="">${`<xacro:m${l - 1}/>`.repeat(width)}</xacro:macro>\n`
  return Buffer.from(`${t}  <link name="base"/>\n  <xacro:m${levels}/>\n</robot>\n`)
}
const xacro = (name, inner) => Buffer.from(`${XML}<robot ${X} name="${name}">\n${inner}\n</robot>\n`)
// "billion laughs": each entity is ten of the one before, so nine levels make 10^9 copies of ten characters
const lol = (root) =>
  Buffer.from(
    `${XML}<!DOCTYPE ${root} [\n  <!ENTITY e0 "laughlaugh">\n` +
      Array.from({ length: 9 }, (_, i) => `  <!ENTITY e${i + 1} "${`&e${i};`.repeat(10)}">`).join('\n') +
      `\n]>\n<${root} name="lol"><link name="&e9;"/></${root}>\n`,
  )
const zipOf = (files) => zip(Object.entries(files).map(([name, data]) => ({ name, data, method: 0 })))
const joint = '<link name="base"/><link name="arm"/><joint name="j1" type="revolute"><parent link="base"/><child link="arm"/><axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint>'

const xmlCases = []
/**
 * `files` go in a stored zip, or `loose` as separate files; the page must show every string in `want` within `ms`.
 * `browserCsp`: the file is not well-formed, and Chrome's DOMParser puts its error in an element with an inline style, which
 * the CSP blocks and reports. That report, and only that one, is expected from such a case.
 */
const addXml = (name, { files, loose, browserCsp = false }, want, ms = 35_000) => xmlCases.push({ name, files, loose, browserCsp, want, ms })
const BROWSER_CSP = 'Error: CSP blocked inline (style-src-attr)'
{
  const { refusalMessage: why } = await (async () => {
    const b = await rolldown({ input: fileURLToPath(new URL('src/utils/importLimits.ts', root)), logLevel: 'silent' })
    const { output } = await b.generate({ format: 'esm' })
    await b.close()
    return import('data:text/javascript;base64,' + Buffer.from(output[0].code).toString('base64'))
  })()
  const prefix = (reason) => why(reason, '\u0000').split('\u0000')[0]
  addXml('good_xacro', { files: {
    'robot/good.xacro': xacro('good_xacro', '  <xacro:property name="r" value="0.1"/>\n  <xacro:include filename="parts.xacro"/>\n  <xacro:arm/>'),
    'robot/parts.xacro': xacro('parts', `  <xacro:macro name="arm" params="">${joint.replace('<link name="arm"/>', '<link name="arm"><visual><geometry><sphere radius="${r}"/></geometry></visual></link>')}</xacro:macro>`),
  } }, ['Imported good xacro (1 joint)!'])
  // no xmlns:xacro: the namespace is added before parsing, so this imports with no CSP report
  addXml('no_namespace', { files: { 'robot/nons.xacro': Buffer.from(`${XML}<robot name="nons_xacro">\n  <xacro:property name="r" value="1"/>\n  ${joint}\n</robot>\n`) } },
    ['Imported nons xacro (1 joint)!'])
  addXml('entity_urdf', { files: { 'robot/lol.urdf': lol('robot') } }, [why('entity', 'robot/lol.urdf')])
  addXml('too_deep', { files: { 'robot/loop.xacro': xacro('loop', '  <xacro:macro name="loop" params=""><link name="x"/><xacro:loop/></xacro:macro>\n  <xacro:loop/>') } },
    [why('depth', 'xacro:loop is called 17 macros deep')])
  addXml('entity_mjcf', { files: { 'robot/lol.xml': lol('mujoco') } }, [why('entity', 'robot/lol.xml')])
  addXml('expression', { files: { 'robot/long.xacro': xacro('long', `  <xacro:property name="p" value="\${${'1+'.repeat(5001)}1}"/>\n  ${joint}`) } },
    [prefix('expression'), `(${'1+'.repeat(20)}…)`])
  addXml('entity_include', { files: {
    'robot/main.xacro': xacro('inc', `  <xacro:include filename="ent.xacro"/>\n  ${joint}`),
    'robot/ent.xacro': lol('robot'),
  } }, [why('entity', 'ent.xacro')])
  addXml('circular', { files: {
    'robot/main.xacro': xacro('circ', `  <xacro:include filename="one.xacro"/>\n  ${joint}`),
    'robot/one.xacro': xacro('one', '  <xacro:include filename="two.xacro"/>'),
    'robot/two.xacro': xacro('two', '  <xacro:include filename="one.xacro"/>'),
  } }, [why('depth', "circular xacro:include of 'one.xacro'")])
  {
    const files = { 'robot/deep.xacro': xacro('deep', `  <xacro:include filename="i1.xacro"/>\n  ${joint}`) }
    for (let i = 1; i <= 9; i++) files[`robot/i${i}.xacro`] = xacro(`i${i}`, i < 9 ? `  <xacro:include filename="i${i + 1}.xacro"/>` : '')
    addXml('include_depth', { files }, [why('depth', "xacro:include 'i9.xacro' is 9 includes deep")])
  }
  addXml('broken_urdf', { files: { 'robot/broken.urdf': Buffer.from(`${XML}<robot name="b">\n  <link name="a">\n</robot>\n`) }, browserCsp: true },
    [prefix('xml'), 'robot/broken.urdf, line '])
  // a value that doubles at each property: the fifth is 16 000 characters (properties are lazy, so a link uses it)
  addXml('doubling', { files: { 'robot/dbl.xacro': xacro('dbl', `  <xacro:property name="p0" value="${'x'.repeat(1000)}"/>\n` +
    [1, 2, 3, 4, 5].map((i) => `  <xacro:property name="p${i}" value="\${p${i - 1}}\${p${i - 1}}"/>`).join('\n') + `\n  <link name="\${p5}"/>\n  ${joint}`) } },
    [prefix('expression'), 'is 16000 characters'])
  addXml('big_text', { loose: { 'big.urdf': Buffer.alloc(33 * 2 ** 20, 0x20) } }, [why('too big', 'big.urdf: 33 MiB')])
  // 10^7 elements if nothing stopped it
  addXml('elements', { files: { 'robot/fan.xacro': fan('fan', 6, 10, '<link name="l"/>'.repeat(10)) } }, [prefix('elements')])
  // 10^6 elements, each with a 9 000-character expression: under the element cap, over the time limit
  addXml('slow', { files: { 'robot/slow.xacro': fan('slow', 6, 10, `<link name="l" x="\${${'v+'.repeat(4499)}v}"/>`, '  <xacro:property name="v" value="1"/>\n') } },
    [prefix('timeout')], 35_000)
  // a 3-million-triangle mesh imports, with both triangle warnings; last, as the 3D view then draws it
  addXml('triangles', { files: {
    'robot/tri.urdf': urdf('tri', ['meshes/huge.stl', 'meshes/small.stl']),
    'robot/meshes/huge.stl': stl(3_000_000),
    'robot/meshes/small.stl': stl(100),
  } }, ['A mesh has more than 500,000 triangles', 'robot/meshes/huge.stl: 3,000,000', 'The meshes have 3,000,100 triangles in all'])
}

const dir = mkdtempSync(join(tmpdir(), 'roco-hostile-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true })) // also when a helper exits early
for (const c of cases) {
  c.path = join(dir, `${c.name}.zip`)
  writeFileSync(c.path, c.bytes)
}
for (const c of xmlCases) {
  if (c.files) {
    c.paths = [join(dir, `xml_${c.name}.zip`)]
    writeFileSync(c.paths[0], zipOf(c.files))
  } else {
    c.paths = Object.entries(c.loose).map(([name, data]) => {
      const p = join(dir, name)
      writeFileSync(p, data)
      return p
    })
  }
}
const sha = (b) => createHash('sha256').update(b).digest('hex')
const { check, finish } = tally()

try {
  // --- 1. the worker's code, in Node ---------------------------------------------------------------------------------
  const b = await rolldown({ input: fileURLToPath(new URL('src/workers/zipWorker.ts', root)), logLevel: 'silent' })
  const { output } = await b.generate({ format: 'esm' })
  await b.close()
  const { readZip } = await import('data:text/javascript;base64,' + Buffer.from(output[0].code).toString('base64'))
  for (const c of cases) {
    const t0 = performance.now()
    let got
    try {
      got = { ok: true, files: readZip(new Uint8Array(c.bytes)) }
    } catch (err) {
      got = { ok: false, reason: err.reason, message: err.message }
    }
    c.ms = performance.now() - t0
    c.message = got.message
    if (c.want.ok) {
      const want = Object.entries(c.want.files)
      const files = new Map((got.files ?? []).map((f) => [f.path, f.data]))
      check(got.ok && files.size === want.length && want.every(([p, d]) => files.has(p) && sha(files.get(p)) === sha(d)),
        `${c.name}: unpacks to exactly its ${want.length} files, byte-equal (got ${got.ok ? `${files.size} files` : got.reason})`)
    } else {
      check(!got.ok && got.reason === c.want.reason && typeof got.message === 'string' && got.message.length > 0,
        `${c.name}: refused as '${c.want.reason}' (got ${got.ok ? 'unpacked' : `'${got.reason}'`})`)
    }
  }
  check(!cases.find((c) => c.name === 'normal').bytes.equals(Buffer.alloc(0)), 'the fixtures were written')

  // --- 2. the built page ---------------------------------------------------------------------------------------------
  const { url, browser, close } = await startBrowser('check-hostile-files')
  try {
    const page = await browser.newPage()
    await guardCsp(page)
    await page.addInitScript(() => {
      try {
        localStorage.setItem('roco.tour.v1', '1')
      } catch {
        /* the tour shows; the clicks below would then fail and say so */
      }
    })
    const pageErrors = []
    const assetFails = []
    let workerLoads = 0
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    page.on('console', (m) => {
      if (/failed to load robot asset/.test(m.text())) assetFails.push(m.text())
    })
    page.on('request', (r) => {
      if (/\/zipWorker-[^/]*\.js$/.test(r.url())) workerLoads++
    })
    await page.goto(url)
    await page.locator('[data-action="settings"]').first().waitFor({ timeout: PAGE_READY_MS })
    const input = page.locator('input[type=file]:not([webkitdirectory])')
    const openDialog = async () => {
      if (await input.count()) return
      await page.locator('[data-action="settings"]').first().click()
      await page.getByRole('button', { name: /Import model/ }).click()
      await input.waitFor({ state: 'attached' })
    }
    // the page shows the same text for two cases in a row only if they are the same case
    const shown = (c) => (c.want.ok ? `Imported ${c.want.title} (1 joint)!` : c.message)
    for (let i = 1; i < cases.length; i++) {
      check(shown(cases[i]) !== shown(cases[i - 1]), `${cases[i].name}: its expected text differs from the case before it`)
    }
    for (const c of cases) {
      await openDialog()
      const fails = assetFails.length
      const t0 = Date.now()
      const rss0 = memory && c.name === 'near' ? rssByProcess() : null
      let peak = 0
      const timer = rss0 ? setInterval(() => (peak = Math.max(peak, maxGrowth(rss0))), 20) : null
      await input.setInputFiles(c.path)
      const ok = await page
        .waitForFunction((t) => document.body.innerText.includes(t), shown(c), { timeout: 90_000 })
        .then(() => true, () => false)
      if (timer) clearInterval(timer)
      const ms = Date.now() - t0
      check(ok, `${c.name}: the page shows "${shown(c)}" (waited ${ms} ms)`)
      if (c.want.ok) {
        await page.waitForTimeout(1500) // the twin loads the meshes
        check(assetFails.length === fails, `${c.name}: every mesh loads in the 3D view (${assetFails.length - fails} failed)`)
      }
      if (rss0) console.log(`near-limit zip: ${(c.bytes.length / 2 ** 20).toFixed(0)} MiB zip, ${(Object.values(c.want.files).reduce((s, d) => s + d.length, 0) / 2 ** 20).toFixed(0)} MiB unpacked; ${ms} ms in the page; peak memory growth of one browser process ${(peak / 1024).toFixed(0)} MiB`)
      console.log(`  ${c.name}: node ${c.ms.toFixed(0)} ms, page ${ms} ms`)
    }

    for (let i = 1; i < xmlCases.length; i++) {
      check(xmlCases[i].want[0] !== xmlCases[i - 1].want[0], `${xmlCases[i].name}: its expected text differs from the case before it`)
    }
    const unexpected = pageErrors.slice() // from the zip cases, which expect none
    for (const c of xmlCases) {
      await openDialog()
      const errors0 = pageErrors.length
      const t0 = Date.now()
      await input.setInputFiles(c.paths)
      const ok = await page
        .waitForFunction((want) => want.every((t) => document.body.innerText.includes(t)), c.want, { timeout: c.ms + 30_000 })
        .then(() => true, () => false)
      const ms = Date.now() - t0
      const shownText = ok ? '' : ` (the dialog says: ${JSON.stringify((await page.locator('[role=dialog]').first().innerText().catch(() => '')).slice(0, 300))})`
      check(ok && ms <= c.ms, `${c.name}: the page shows ${c.want.map((t) => JSON.stringify(t)).join(' and ')} within ${c.ms / 1000} s (took ${ms} ms)${shownText}`)
      await page.waitForTimeout(300) // the CSP guard reports from a timer
      const mine = pageErrors.slice(errors0)
      if (c.browserCsp) check(mine.length > 0 && mine.every((e) => e === BROWSER_CSP), `${c.name}: its only page errors are the browser's own parse-error style (${mine.join(' | ') || 'none'})`)
      else unexpected.push(...mine.map((e) => `${c.name}: ${e}`))
      console.log(`  ${c.name}: page ${ms} ms, ${mine.length} page errors`)
    }
    check(workerLoads > 0, `the page unpacked in its zip worker (${workerLoads} worker loads)`)
    check(unexpected.length === 0, `no other page errors or CSP violations (${unexpected.length}: ${unexpected.slice(0, 3).join(' | ')})`)
  } finally {
    await close()
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
finish('check-hostile-files')

/** VmRSS (KiB) of each process started below this one: the browser's renderer holds the page and its workers. */
function rssByProcess() {
  const kids = new Map()
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const st = readFileSync(`/proc/${d}/stat`, 'utf8')
      const ppid = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1]
      if (!kids.has(ppid)) kids.set(ppid, [])
      kids.get(ppid).push(+d)
    } catch {
      /* the process ended */
    }
  }
  const per = new Map()
  const stack = [process.pid]
  while (stack.length) {
    for (const c of kids.get(stack.pop()) ?? []) {
      stack.push(c)
      try {
        const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${c}/status`, 'utf8'))
        if (m) per.set(c, +m[1])
      } catch {
        /* the process ended */
      }
    }
  }
  return per
}
function maxGrowth(base) {
  let g = 0
  for (const [p, r] of rssByProcess()) g = Math.max(g, r - (base.get(p) ?? 0))
  return g
}
