// SDFormat (Gazebo's .sdf) to URDF, for the twin. Like the MJCF converter it keeps what drawing and kinematics need (links,
// joints, visuals, meshes, colours) and reports everything else. Frames follow the SDFormat specification (1.4-1.11): each pose
// is read against its `relative_to` frame (or, before 1.7, its `frame`), else its element's default frame; nested models are
// flattened with `::` names, as Gazebo names them; `<include>`d models come from the import.
import { LIMITS, refuse } from './importLimits'
import type { ReportKind } from './importReport'
import { parseXmlSafe } from './safeXml'
import type { ParseContext } from './modelFormatParser'
import { type Pose, type Quat, type Vec3, IDENTITY, axisAngle, compose, esc, fmt, nums, origin, qmul, qnorm, rotate, vec3 } from './mjcfConverter'

const conj = (q: Quat): Quat => [q[0], -q[1], -q[2], -q[3]]
const inverse = (a: Pose): Pose => {
  const q = conj(a.q)
  const p = rotate(q, a.p)
  return { p: [-p[0], -p[1], -p[2]], q }
}
/** `to` seen from `from`. */
const between = (from: Pose, to: Pose): Pose => compose(inverse(from), to)
const isIdentity = (a: Pose) => Math.hypot(...a.p) < 1e-12 && 1 - Math.abs(a.q[0]) < 1e-12

/** SDFormat roll, pitch, yaw: fixed axes x, then y, then z (as URDF). */
const fromRpy = (r: number, p: number, y: number): Quat =>
  qnorm(qmul(qmul(axisAngle([0, 0, 1], y), axisAngle([0, 1, 0], p)), axisAngle([1, 0, 0], r)))

const kids = (el: Element, tag: string) => Array.from(el.children).filter((c) => c.tagName === tag)
const kid = (el: Element | null | undefined, tag: string): Element | null => (el ? (kids(el, tag)[0] ?? null) : null)
const text = (el: Element | null | undefined, tag: string): string | null => {
  const k = kid(el, tag)
  return k ? (k.textContent ?? '').trim() : null
}
const isTrue = (v: string | null | undefined) => v === 'true' || v === '1'

/** A `<pose>`: x y z roll pitch yaw (radians, or degrees with degrees="true"), or x y z qx qy qz qw (rotation_format="quat_xyzw"). */
function readPose(el: Element | null): Pose {
  if (!el) return IDENTITY
  const n = nums(el.textContent)
  const p: Vec3 = [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0]
  if (el.getAttribute('rotation_format') === 'quat_xyzw') return { p, q: qnorm([n[6] ?? 1, n[3] ?? 0, n[4] ?? 0, n[5] ?? 0]) }
  const k = isTrue(el.getAttribute('degrees')) ? Math.PI / 180 : 1
  return { p, q: fromRpy((n[3] ?? 0) * k, (n[4] ?? 0) * k, (n[5] ?? 0) * k) }
}

/** The frame a pose is written in, if it names one. */
const poseFrame = (el: Element): string | null => {
  const p = kid(el, 'pose')
  return p?.getAttribute('relative_to') || p?.getAttribute('frame') || null
}

/** SDFormat writes an unlimited joint as ±1e16 (its default). */
const INFINITE = 1e16

/** Where names are looked up: `prefix` is put before each name; `model` is the frame `__model__` means ('' = the top model). */
interface Scope {
  prefix: string
  model: string
  version: number
  /** The file the scope's elements are written in. */
  file: string
}

interface Frame {
  raw: Pose
  /** The frame the pose is written in, as written; null means the element's default. */
  rel: string | null
  fallback: string
  scope: Scope
}

interface Entry {
  name: string
  el: Element
  scope: Scope
}

const WORLD = '\u0000world'

/**
 * Converts an SDFormat document into a URDF that draws and moves the same way at every joint's zero. A file with several models
 * (a world) gives its model with the most joints. `<include>`d models come from `ctx.resolveInclude`; what cannot be converted
 * goes to `ctx.report` (or `ctx.warnings`).
 */
export function convertSdfToUrdf(sdfText: string, modelName = 'sdf_robot', ctx: ParseContext = {}): string {
  const mainName = ctx.fileName || `${modelName}.sdf`
  // the importer gives included files' paths in lower case; paths in the import are matched without regard to case
  const mainKey = mainName.toLowerCase()
  const doc = parseXmlSafe(sdfText, mainName, ctx.deadline)
  const root = doc.documentElement
  if (!root || root.tagName !== 'sdf') return sdfText

  const note = (kind: ReportKind, message: string, where?: string) => {
    if (ctx.report) ctx.report.add(kind, message, where ? { where } : {})
    else ctx.warnings?.push(`SDF: ${message}${where ? ` (${where})` : ''}`)
  }
  const versionOf = (el: Element) => Number.parseFloat(el.getAttribute('version') ?? '') || 1.7

  // 1. Included models, each read once: `model://name` is a model folder whose model.config names its .sdf file.
  let elements = doc.getElementsByTagName('*').length
  if (elements > LIMITS.xacroElements) throw refuse('elements', mainName)
  interface Loaded {
    model: Element
    path: string
    version: number
  }
  // each file is parsed once, however often it is included; every use still counts its elements
  const parsed = new Map<string, { doc: Document; count: number }>()
  const parse = (f: { text: string; path: string }) => {
    let p = parsed.get(f.path)
    if (!p) {
      const d = parseXmlSafe(f.text, f.path, ctx.deadline)
      p = { doc: d, count: d.getElementsByTagName('*').length }
      parsed.set(f.path, p)
    }
    return p
  }
  const load = (uri: string, from: string, stack: string[]): Loaded | null => {
    ctx.deadline?.check('reading SDF includes')
    if (!uri || /^https?:/i.test(uri)) return null
    const base = uri.replace(/\/+$/, '')
    // only the folder the include names, never a file of the same name somewhere else
    const find = (name: string) => ctx.resolveInclude?.(name, from, { exact: true })
    let file = 'model.sdf'
    const config = find(`${base}/model.config`)
    if (config) {
      const sdfs = Array.from(parse(config).doc.getElementsByTagName('sdf'))
      sdfs.sort((a, b) => versionOf(b) - versionOf(a))
      if (sdfs[0]?.textContent?.trim()) file = sdfs[0].textContent.trim()
    }
    const hit = find(`${base}/${file}`) ?? (/\.sdf$/i.test(base) ? find(base) : undefined)
    if (!hit) return null
    if (stack.includes(hit.path.toLowerCase())) throw refuse('depth', `circular include of '${uri}'`)
    if (stack.length > LIMITS.includeDepth) throw refuse('depth', `include '${uri}' is ${stack.length} includes deep`)
    const { doc: incDoc, count } = parse(hit)
    elements += count
    if (elements > LIMITS.xacroElements) throw refuse('elements', `include '${uri}'`)
    const incRoot = incDoc.documentElement
    const model = incRoot.tagName === 'model' ? incRoot : kid(incRoot, 'model')
    if (!model) return null
    return { model, path: hit.path, version: incRoot.tagName === 'sdf' ? versionOf(incRoot) : versionOf(root) }
  }

  // 2. The model: the file's own, or of a world's models (and included models) the one with the most joints.
  const version = versionOf(root)
  interface Candidate extends Loaded {
    name: string
    pose: Element | null
  }
  const candidates: Candidate[] = []
  const missing: string[] = []
  const world = kid(root, 'world')
  for (const holder of world ? [root, world] : [root]) {
    for (const el of Array.from(holder.children)) {
      if (el.tagName === 'model') {
        candidates.push({ model: el, path: mainName, version, name: el.getAttribute('name') || modelName, pose: kid(el, 'pose') })
      } else if (el.tagName === 'include') {
        const uri = text(el, 'uri') ?? ''
        const hit = load(uri, mainName, [mainKey])
        if (!hit) missing.push(uri)
        else candidates.push({ ...hit, name: text(el, 'name') || hit.model.getAttribute('name') || modelName, pose: kid(el, 'pose') ?? kid(hit.model, 'pose') })
      }
    }
  }
  if (missing.length) {
    note('unsupported', 'Models the file includes from outside the import (such as model://sun) are not drawn.', missing.slice(0, 3).join(', '))
  }
  if (!candidates.length) return `<?xml version="1.0"?>\n<robot name="${esc(modelName)}"><link name="world"/></robot>`
  const jointsIn = (c: Candidate) => c.model.getElementsByTagName('joint').length
  const top = candidates.reduce((best, c) => (jointsIn(c) > jointsIn(best) ? c : best))
  if (candidates.length > 1) {
    note('substitution', `The file holds ${candidates.length} models; ${top.name}, the one with the most joints, was used.`,
      candidates.filter((c) => c !== top).slice(0, 3).map((c) => c.name).join(', '))
  }
  // the top model's frame is the URDF's origin, so the world sits at the inverse of the model's pose
  const worldPose = inverse(readPose(top.pose))

  // 3. Every frame, link and joint, with nested and included models flattened into `outer::inner::name`.
  const frames = new Map<string, Frame>()
  const links: Entry[] = []
  const joints: Entry[] = []
  const qualify = (scope: Scope, name: string) => (name === '__model__' ? scope.model : name === 'world' ? WORLD : scope.prefix + name)
  const walk = (model: Element, scope: Scope, stack: string[]) => {
    for (const el of Array.from(model.children)) {
      ctx.deadline?.check('reading the SDF model')
      const tag = el.tagName
      const own = el.getAttribute('name') ?? ''
      const add = (fallback: string) => frames.set(scope.prefix + own, { raw: readPose(kid(el, 'pose')), rel: poseFrame(el), fallback, scope })
      if (tag === 'link') {
        add('__model__')
        links.push({ name: scope.prefix + own, el, scope })
      } else if (tag === 'joint') {
        add(text(el, 'child') ?? kid(el, 'child')?.getAttribute('link') ?? '__model__')
        joints.push({ name: scope.prefix + own, el, scope })
      } else if (tag === 'frame') {
        add(el.getAttribute('attached_to') || '__model__')
      } else if (tag === 'model') {
        add('__model__')
        const name = scope.prefix + own
        walk(el, { prefix: `${name}::`, model: name, version: scope.version, file: scope.file }, stack)
      } else if (tag === 'include') {
        const uri = text(el, 'uri') ?? ''
        const hit = load(uri, scope.file, stack)
        if (!hit) {
          note('error', 'An included model was not imported, so its parts are missing.', uri)
          continue
        }
        const name = scope.prefix + (text(el, 'name') || hit.model.getAttribute('name') || 'model')
        const pose = kid(el, 'pose') ?? kid(hit.model, 'pose')
        frames.set(name, { raw: readPose(pose), rel: pose?.getAttribute('relative_to') || null, fallback: '__model__', scope })
        // merge="true" puts the included model's parts in this model, under their own names
        const merged = isTrue(text(el, 'merge'))
        walk(hit.model, { prefix: merged ? scope.prefix : `${name}::`, model: name, version: hit.version, file: hit.path }, [...stack, hit.path.toLowerCase()])
      }
    }
  }
  walk(top.model, { prefix: '', model: '', version: top.version, file: top.path }, [...new Set([mainKey, top.path.toLowerCase()])])

  // 4. Poses in the top model's frame, each through the frame it is written in.
  const solved = new Map<string, Pose>()
  const solving = new Set<string>()
  /** The full name of the frame `name` means in `scope`; one that does not exist is reported and the model frame used. */
  const frameRef = (scope: Scope, name: string, where: string): string => {
    const q = qualify(scope, name)
    if (q === scope.model || q === WORLD || frames.has(q)) return q
    note('error', 'A pose or axis refers to a frame that does not exist; the model frame is used.', `${where} → ${name}`)
    return scope.model
  }
  /** Follows the chain of frames each pose is written in to one already known, then solves back along it (no recursion: a file may chain 100 000 frames). */
  const poseOf = (start: string): Pose => {
    const chain: Frame[] = []
    const names: string[] = []
    let name = start
    let pose: Pose
    for (;;) {
      if (name === '') {
        pose = IDENTITY
        break
      }
      if (name === WORLD) {
        pose = worldPose
        break
      }
      const done = solved.get(name)
      if (done) {
        pose = done
        break
      }
      const f = frames.get(name)
      if (!f) {
        pose = IDENTITY
        break
      }
      if (solving.has(name)) {
        note('error', 'Poses refer to each other in a loop; the model frame is used.', name)
        name = f.scope.model
        continue
      }
      solving.add(name)
      chain.push(f)
      names.push(name)
      name = frameRef(f.scope, f.rel ?? f.fallback, name)
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      pose = compose(pose, chain[i].raw)
      solving.delete(names[i])
      solved.set(names[i], pose)
    }
    return pose
  }

  // 5. The tree: each link is the child of at most one joint, and no chain of joints may close on itself.
  const linkNames = new Set(links.map((l) => l.name))
  interface Edge {
    joint: Entry
    parent: string
    child: string
  }
  const parentOf = new Map<string, Edge>()
  for (const j of joints) {
    ctx.deadline?.check('converting the SDF joints')
    const end = (tag: string) => text(j.el, tag) || kid(j.el, tag)?.getAttribute('link') || ''
    const parent = qualify(j.scope, end('parent'))
    const child = qualify(j.scope, end('child'))
    if ((parent !== WORLD && !linkNames.has(parent)) || !linkNames.has(child)) {
      note('error', 'A joint names a parent or child link that does not exist, so it is left out.', j.name)
      continue
    }
    if (parentOf.has(child)) {
      note('error', 'A link is the child of two joints (a closed loop); only the first joint is kept.', j.name)
      continue
    }
    parentOf.set(child, { joint: j, parent, child })
  }
  for (const start of linkNames) {
    const seen = new Set<string>()
    for (let at: string | undefined = start; at && at !== WORLD && parentOf.has(at); at = parentOf.get(at)?.parent) {
      if (seen.has(at)) {
        note('error', 'Joints form a closed loop; one of them is left out.', parentOf.get(at)!.joint.name)
        parentOf.delete(at)
        break
      }
      seen.add(at)
    }
  }

  // 6. The URDF. Each SDF link keeps its frame; a joint whose frame is not its child's ends at a helper link, anchored to the child.
  const used = new Set([...linkNames])
  const unique = (name: string) => {
    let n = name
    while (used.has(n)) n += '_'
    used.add(n)
    return n
  }
  const helperLinks: string[] = []
  const jointXml: string[] = []
  const emit = (name: string, type: string, parent: string, child: string, pose: Pose, extra = '') =>
    jointXml.push(`  <joint name="${esc(name)}" type="${type}">\n    <parent link="${esc(parent)}"/>\n    <child link="${esc(child)}"/>\n    ${origin(pose)}${extra}\n  </joint>`)

  const roots = links.filter((l) => !parentOf.has(l.name)).map((l) => l.name)
  const toWorld = [...parentOf.values()].some((e) => e.parent === WORLD)
  // a model with one free link where the model frame is gives a URDF rooted at that link, as a URDF import would be
  const plainRoot = roots.length === 1 && !toWorld && isIdentity(poseOf(roots[0])) ? roots[0] : null
  const worldLink = plainRoot ? '' : unique('world')
  if (roots.length > 1) note('approx', 'Several links are not joined to the rest by a joint; each is shown fixed where it starts.', roots.slice(0, 3).join(', '))
  for (const r of plainRoot ? [] : roots) emit(unique(`world_to_${r}`), 'fixed', worldLink, r, poseOf(r))

  /** The joint's axis in the joint's frame, from the frame each SDFormat version writes it in. */
  const axisOf = (axisEl: Element | null, j: Entry, jointPose: Pose): Vec3 => {
    const xyz = kid(axisEl, 'xyz')
    const raw = vec3(xyz?.textContent, [0, 0, 1])
    const n = Math.hypot(...raw) || 1
    let a: Vec3 = [raw[0] / n, raw[1] / n, raw[2] / n]
    let frame: Pose | null = null
    if (j.scope.version >= 1.7) {
      const e = xyz?.getAttribute('expressed_in')
      if (e) frame = poseOf(frameRef(j.scope, e, j.name))
    } else if (j.scope.version < 1.5 || isTrue(text(axisEl, 'use_parent_model_frame'))) {
      frame = poseOf(j.scope.model)
    }
    if (frame) a = rotate(conj(jointPose.q), rotate(frame.q, a))
    return a
  }
  const limitXml = (axisEl: Element | null, j: Entry, jointPose: Pose, prismatic: boolean): { type: string; xml: string } => {
    const lim = kid(axisEl, 'limit')
    const lower = Number(text(lim, 'lower') ?? -INFINITE)
    const upper = Number(text(lim, 'upper') ?? INFINITE)
    const unlimited = !(Math.abs(lower) < INFINITE && Math.abs(upper) < INFINITE)
    const [lo, hi] = unlimited ? [-Math.PI, Math.PI] : [lower, upper]
    const type = prismatic ? 'prismatic' : unlimited ? 'continuous' : 'revolute'
    return { type, xml: `\n    <axis xyz="${fmt(axisOf(axisEl, j, jointPose))}"/>\n    <limit lower="${fmt([lo])}" upper="${fmt([hi])}" effort="100" velocity="10"/>` }
  }

  for (const { joint: j, parent, child } of parentOf.values()) {
    ctx.deadline?.check('converting the SDF joints')
    const J = poseOf(j.name)
    const from = parent === WORLD ? worldLink : parent
    const at = between(parent === WORLD ? IDENTITY : poseOf(parent), J)
    const offset = between(J, poseOf(child))
    let end = child
    if (!isIdentity(offset)) {
      end = unique(`${child}__joint`)
      helperLinks.push(end)
      emit(unique(`${child}__anchor`), 'fixed', end, child, offset)
    }
    const type = (j.el.getAttribute('type') ?? '').toLowerCase()
    const axis = kid(j.el, 'axis')
    if (type === 'revolute' || type === 'continuous' || type === 'prismatic' || type === 'screw') {
      const l = limitXml(axis, j, J, type === 'prismatic')
      if (type === 'screw') note('approx', 'A screw joint is shown turning only; its sliding is not shown.', j.name)
      emit(j.name, type === 'continuous' ? 'continuous' : l.type, from, end, at, l.xml)
    } else if (type === 'universal' || type === 'revolute2') {
      // two revolute joints: the first turns a helper link about axis, the second turns the child about axis2
      const mid = unique(`${child}__j1`)
      helperLinks.push(mid)
      const l1 = limitXml(axis, j, J, false)
      emit(j.name, l1.type, from, mid, at, l1.xml)
      const l2 = limitXml(kid(j.el, 'axis2'), j, J, false)
      emit(unique(`${j.name}__2`), l2.type, mid, end, IDENTITY, l2.xml)
    } else {
      if (type === 'ball') note('approx', 'A ball joint is shown fixed.', j.name)
      else if (type === 'gearbox') note('approx', 'A gearbox joint is shown fixed.', j.name)
      else if (type !== 'fixed') note('unsupported', `A ${type || 'typeless'} joint is shown fixed.`, j.name)
      emit(j.name, 'fixed', from, end, at)
    }
  }

  // 7. Visuals (collisions are not drawn).
  let ellipsoids = false
  let scripted = false
  const visualsOf = (link: Entry): string[] => {
    const out: string[] = []
    const linkPose = poseOf(link.name)
    for (const v of kids(link.el, 'visual')) {
      ctx.deadline?.check('converting the SDF visuals')
      const geometry = kid(v, 'geometry')
      const shape = geometry?.firstElementChild
      if (!shape) continue
      const rel = poseFrame(v)
      const raw = readPose(kid(v, 'pose'))
      const local = rel && qualify(link.scope, rel) !== link.name ? between(linkPose, compose(poseOf(frameRef(link.scope, rel, link.name)), raw)) : raw
      const material = kid(v, 'material')
      if (kid(material, 'script')) scripted = true
      const colour = nums(text(material, 'diffuse') ?? text(material, 'ambient'))
      const transparency = Number(text(v, 'transparency') ?? 0) || 0
      let rgba: number[] | null = colour.length >= 3 ? [colour[0], colour[1], colour[2], colour[3] ?? 1] : null
      if (rgba && transparency > 0) rgba[3] = 1 - transparency
      if (rgba && rgba[3] <= 0) continue
      const mat = rgba ? `\n      <material><color rgba="${fmt(rgba)}"/></material>` : ''
      const one = (at: Pose, geom: string) => out.push(`    <visual>\n      ${origin(at)}\n      <geometry>${geom}</geometry>${mat}\n    </visual>`)
      const num = (tag: string) => nums(text(shape, tag))[0] ?? 0
      switch (shape.tagName) {
        case 'box':
          one(local, `<box size="${fmt(vec3(text(shape, 'size'), [1, 1, 1]))}"/>`)
          break
        case 'sphere':
          one(local, `<sphere radius="${fmt([num('radius')])}"/>`)
          break
        case 'cylinder':
          one(local, `<cylinder radius="${fmt([num('radius')])}" length="${fmt([num('length')])}"/>`)
          break
        case 'capsule': {
          const r = num('radius')
          const half = num('length') / 2
          one(local, `<cylinder radius="${fmt([r])}" length="${fmt([2 * half])}"/>`)
          one(compose(local, { p: [0, 0, half], q: [1, 0, 0, 0] }), `<sphere radius="${fmt([r])}"/>`)
          one(compose(local, { p: [0, 0, -half], q: [1, 0, 0, 0] }), `<sphere radius="${fmt([r])}"/>`)
          break
        }
        case 'ellipsoid':
          ellipsoids = true
          one(local, `<sphere radius="${fmt([Math.max(...vec3(text(shape, 'radii'), [0, 0, 0]))])}"/>`)
          break
        case 'mesh': {
          let uri = text(shape, 'uri') ?? ''
          // a relative uri in an included file is read from that file's folder; the importer reads it from the main file's
          if (link.scope.file.toLowerCase() !== mainKey && uri && !/^[a-z][a-z0-9+.-]*:/i.test(uri) && !uri.startsWith('/')) uri = rebase(uri, link.scope.file, mainName)
          if (kid(shape, 'submesh')) note('approx', 'A submesh is not picked out; the whole mesh is drawn.', uri)
          one(local, `<mesh filename="${esc(uri)}" scale="${fmt(vec3(text(shape, 'scale'), [1, 1, 1]))}"/>`)
          break
        }
        case 'plane':
        case 'empty':
          break
        default:
          note('unsupported', `A ${shape.tagName} visual is not drawn.`, link.name)
      }
    }
    return out
  }
  const linkXml = (name: string, visuals: string[]) => (visuals.length ? `  <link name="${esc(name)}">\n${visuals.join('\n')}\n  </link>` : `  <link name="${esc(name)}"/>`)
  const linkParts = [
    ...(worldLink ? [linkXml(worldLink, [])] : []),
    ...links.map((l) => linkXml(l.name, visualsOf(l))),
    ...helperLinks.map((h) => linkXml(h, [])),
  ]
  if (ellipsoids) note('approx', 'An ellipsoid is drawn as a sphere of its largest radius.')
  if (scripted) note('approx', 'Gazebo material scripts are not read; the colour given beside them (or the default) is used.')

  return `<?xml version="1.0"?>\n<robot name="${esc(top.name)}">\n${linkParts.join('\n')}\n\n${jointXml.join('\n')}\n</robot>\n`
}

/** `ref`, written in the file `from`, as a path relative to the file `main` (both are paths in the import). */
function rebase(ref: string, from: string, main: string): string {
  const target = from.split('/').slice(0, -1)
  for (const seg of ref.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') target.pop()
    else target.push(seg)
  }
  const mainDir = main.split('/').slice(0, -1)
  let common = 0
  while (common < mainDir.length && common < target.length - 1 && mainDir[common].toLowerCase() === target[common].toLowerCase()) common++
  return [...mainDir.slice(common).map(() => '..'), ...target.slice(common)].join('/')
}
