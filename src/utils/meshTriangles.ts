/**
 * Triangle counts read from a mesh file without drawing it, so the import can warn before a heavy robot slows the page.
 * Each format is read the cheapest way it allows: a binary STL's header, a glTF's JSON, the primitive counts a COLLADA file
 * declares, and the face lines of an OBJ or an ASCII STL. Nothing here builds geometry.
 */

export interface TriangleCount {
  triangles: number
  /** False when the file gives only a lower bound (COLLADA polygons, counted as one triangle each). */
  exact: boolean
}

/** A glTF JSON chunk larger than this is not read (its geometry is in the binary chunk, so this is generous). */
const MAX_GLTF_JSON = 32 * 2 ** 20

/** The triangles in one mesh file, or null when its format is not one of these or it cannot be read as one. */
export async function countTriangles(file: Blob, name: string): Promise<TriangleCount | null> {
  switch (name.toLowerCase().split('.').pop()) {
    case 'stl':
      return countStl(file)
    case 'glb':
      return countGlb(file)
    case 'gltf':
      return countGltfJson(await file.text())
    case 'dae':
      return countDae(await file.text())
    case 'obj':
      return { triangles: countObjFaces(await file.text()), exact: true }
    default:
      return null
  }
}

async function countStl(file: Blob): Promise<TriangleCount> {
  if (file.size >= 84) {
    const n = new DataView(await file.slice(80, 84).arrayBuffer()).getUint32(0, true)
    if (84 + 50 * n === file.size) return { triangles: n, exact: true }
  }
  // an ASCII STL: one `endfacet` per triangle
  const text = await file.text()
  const re = /endfacet/gi
  let n = 0
  while (re.exec(text)) n++
  return { triangles: n, exact: true }
}

async function countGlb(file: Blob): Promise<TriangleCount | null> {
  if (file.size < 20) return null
  const head = new DataView(await file.slice(0, 20).arrayBuffer())
  // 'glTF', then the first chunk's length and type 'JSON'
  if (head.getUint32(0, true) !== 0x46546c67 || head.getUint32(16, true) !== 0x4e4f534a) return null
  const len = head.getUint32(12, true)
  if (len > MAX_GLTF_JSON || 20 + len > file.size) return null
  return countGltfJson(await file.slice(20, 20 + len).text())
}

/** Every primitive of every mesh, once: triangles (mode 4) and strips and fans (5, 6); points and lines draw none. */
export function countGltfJson(text: string): TriangleCount | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  const j = json as { meshes?: { primitives?: { mode?: number; indices?: number; attributes?: { POSITION?: number } }[] }[]; accessors?: { count?: number }[] }
  const accessors = Array.isArray(j?.accessors) ? j.accessors : []
  let triangles = 0
  for (const mesh of Array.isArray(j?.meshes) ? j.meshes : []) {
    for (const p of Array.isArray(mesh?.primitives) ? mesh.primitives : []) {
      const at = p?.indices ?? p?.attributes?.POSITION
      const n = typeof at === 'number' ? accessors[at]?.count : undefined
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) continue
      const mode = p.mode ?? 4
      if (mode === 4) triangles += Math.floor(n / 3)
      else if (mode === 5 || mode === 6) triangles += Math.max(0, n - 2)
    }
  }
  return { triangles, exact: true }
}

/**
 * The `count` each COLLADA primitive declares. `<triangles>` gives triangles; `<polylist>` and `<polygons>` give polygons,
 * each at least one triangle, so their sum is a lower bound. Strips and fans declare strips, not triangles, and are left out.
 */
export function countDae(text: string): TriangleCount {
  let triangles = 0
  let exact = true
  for (const tag of ['triangles', 'polylist', 'polygons']) {
    const open = `<${tag}`
    for (let i = text.indexOf(open); i >= 0; i = text.indexOf(open, i + open.length)) {
      const after = text.charCodeAt(i + open.length)
      // `<triangles ` or `<triangles>`, not `<trianglesX`
      if (!(after === 0x20 || after === 0x09 || after === 0x0a || after === 0x0d || after === 0x3e || after === 0x2f)) continue
      // the start tag only, and never far: a tag with no `>` near it is not one
      const window = text.slice(i, i + 2000)
      const end = window.indexOf('>')
      if (end < 0) continue
      const m = /\scount\s*=\s*["'](\d{1,12})["']/.exec(window.slice(0, end))
      if (!m) continue
      triangles += Number(m[1])
      if (tag !== 'triangles') exact = false
    }
  }
  return { triangles, exact }
}

/** An OBJ's faces as triangles: a face line with k vertices is k - 2 triangles (a fan), as three.js's OBJLoader draws it. */
export function countObjFaces(text: string): number {
  let triangles = 0
  let i = 0
  const n = text.length
  while (i < n) {
    // skip the line's leading blanks
    let c = text.charCodeAt(i)
    while (c === 0x20 || c === 0x09) c = text.charCodeAt(++i)
    const next = text.charCodeAt(i + 1)
    if (c === 0x66 /* f */ && (next === 0x20 || next === 0x09)) {
      let tokens = 0
      let inToken = false
      for (i += 1; i < n; i++) {
        c = text.charCodeAt(i)
        if (c === 0x0a || c === 0x0d) break
        const blank = c === 0x20 || c === 0x09
        if (!blank && !inToken) tokens++
        inToken = !blank
      }
      if (tokens > 2) triangles += tokens - 2
    }
    const eol = text.indexOf('\n', i)
    if (eol < 0) break
    i = eol + 1
  }
  return triangles
}
