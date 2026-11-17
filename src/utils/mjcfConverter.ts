// MuJoCo MJCF to URDF, for the twin. The URDF only has to draw the robot and move its joints, so this keeps what drawing and
// kinematics need (bodies, joints, visual geoms, meshes, colours) and reports everything else instead of dropping it silently.
// Each rule below follows MuJoCo 3.17's compiler, checked against mujoco itself (tools/corpus/reference.py), not the docs alone.
import * as THREE from 'three'
import { LIMITS, refuse } from './importLimits'
import type { ReportKind } from './importReport'
import { parseXmlSafe } from './safeXml'
import type { ParseContext } from './modelFormatParser'

export type Vec3 = [number, number, number]
/** w, x, y, z, as MuJoCo writes it. */
export type Quat = [number, number, number, number]
export interface Pose {
  p: Vec3
  q: Quat
}

export const IDENTITY: Pose = { p: [0, 0, 0], q: [1, 0, 0, 0] }

export const qmul = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
]

export function qnorm(q: Quat): Quat {
  const n = Math.hypot(...q)
  return n > 0 ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : [1, 0, 0, 0]
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  const r = qmul(qmul(q, [0, v[0], v[1], v[2]]), [q[0], -q[1], -q[2], -q[3]])
  return [r[1], r[2], r[3]]
}

export const compose = (a: Pose, b: Pose): Pose => {
  const r = rotate(a.q, b.p)
  return { p: [a.p[0] + r[0], a.p[1] + r[1], a.p[2] + r[2]], q: qnorm(qmul(a.q, b.q)) }
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const isZero = (v: Vec3) => v.every((c) => Math.abs(c) < 1e-12)
const translate = (p: Vec3): Pose => ({ p, q: [1, 0, 0, 0] })

export function axisAngle(axis: Vec3, angle: number): Quat {
  const n = Math.hypot(...axis)
  if (!(n > 0)) return [1, 0, 0, 0]
  const s = Math.sin(angle / 2) / n
  return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s]
}

/** MuJoCo's mju_quatZ2Vec: the rotation taking +z to `v`; a `v` along -z gives a half turn about x. */
function quatZ2Vec(v: Vec3): Quat {
  const n = Math.hypot(...v)
  if (!(n > 0)) return [1, 0, 0, 0]
  const u: Vec3 = [v[0] / n, v[1] / n, v[2] / n]
  const axis: Vec3 = [-u[1], u[0], 0] // z × u
  const s = Math.hypot(...axis)
  if (s < 1e-10) return u[2] < 0 ? [0, 1, 0, 0] : [1, 0, 0, 0]
  return axisAngle(axis, Math.atan2(s, u[2]))
}

function fromAxes(x: Vec3, y: Vec3): Quat {
  // Gram-Schmidt as MuJoCo does it: x is kept, y is made orthogonal to it, z = x × y
  const nx = Math.hypot(...x)
  const ux = new THREE.Vector3(x[0] / nx, x[1] / nx, x[2] / nx)
  const uy = new THREE.Vector3(...y).addScaledVector(ux, -ux.dot(new THREE.Vector3(...y))).normalize()
  const uz = new THREE.Vector3().crossVectors(ux, uy)
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(ux, uy, uz))
  return qnorm([q.w, q.x, q.y, q.z])
}

export const fmt = (v: readonly number[]) => v.map((n) => String(Math.abs(n) < 1e-15 ? 0 : n)).join(' ')

/**
 * URDF roll, pitch, yaw: R = Rz(yaw) Ry(pitch) Rx(roll), which urdf-loader applies as a THREE Euler in 'ZYX' order. Not
 * THREE's own setFromQuaternion: it snaps pitch to ±90° once |sin pitch| > 0.9999999, an error of up to 5e-4 rad that real
 * models hit (leap_hand's near-quarter-turn quats). Pitch from atan2 over a hypot of matrix entries stays exact there.
 */
export function rpy(q: Quat): string {
  const [w, x, y, z] = qnorm(q)
  const r00 = 1 - 2 * (y * y + z * z)
  const r10 = 2 * (x * y + w * z)
  const r20 = 2 * (x * z - w * y)
  const c = Math.hypot(r00, r10)
  const pitch = Math.atan2(-r20, c)
  // at ±90° pitch, only roll - yaw is defined: put it all in roll
  if (c < 1e-9) return fmt([Math.atan2(-2 * (y * z - w * x), 1 - 2 * (x * x + z * z)), pitch, 0])
  return fmt([Math.atan2(2 * (y * z + w * x), 1 - 2 * (x * x + y * y)), pitch, Math.atan2(r10, r00)])
}

export const origin = (pose: Pose) => `<origin xyz="${fmt(pose.p)}" rpy="${rpy(pose.q)}"/>`

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function nums(text: string | null | undefined): number[] {
  if (!text) return []
  return text.trim().split(/\s+/).map(Number).map((n) => (Number.isFinite(n) ? n : 0))
}

export const vec3 = (text: string | null | undefined, fallback: Vec3): Vec3 => {
  const n = nums(text)
  return n.length >= 3 ? [n[0], n[1], n[2]] : fallback
}

const ORIENTATION = ['quat', 'axisangle', 'euler', 'xyaxes', 'zaxis'] as const

/** One `<default>` class: its own settings per element kind, and the class it inherits from. */
interface ClassDef {
  name: string
  parent?: ClassDef
  attrs: Map<string, Map<string, string>>
}

const DEFAULT_RGBA = [0.5, 0.5, 0.5, 1]

/** Elements MJCF can hold that this converter does not model, and what that means for the twin. */
const UNSUPPORTED: [string, string][] = [
  ['tendon', 'Tendons are not modelled; joints they couple move on their own.'],
  ['equality', 'Equality constraints are not modelled; joints they couple move on their own.'],
  ['composite', '<composite> bodies are not drawn.'],
  ['flexcomp', '<flexcomp> bodies are not drawn.'],
  ['flex', 'Flexible (deformable) bodies are not drawn.'],
  ['replicate', '<replicate> is not expanded, so the bodies it makes are missing.'],
  ['attach', '<attach> is not expanded, so the model it attaches is missing.'],
  ['skin', 'Skins are not drawn.'],
]

/**
 * Converts a MuJoCo MJCF document into a URDF that draws and moves the same way at every joint's zero.
 * `<include>` files come from `ctx.resolveInclude`; what cannot be converted goes to `ctx.report` (or `ctx.warnings`).
 */
export function convertMjcfToUrdf(mjcfText: string, modelName = 'mujoco_robot', ctx: ParseContext = {}): string {
  const mainName = ctx.fileName || `${modelName}.xml`
  const doc = parseXmlSafe(mjcfText, mainName, ctx.deadline)
  const root = doc.documentElement
  if (!root || root.tagName !== 'mujoco') return mjcfText

  const note = (kind: ReportKind, message: string, where?: string) => {
    if (ctx.report) ctx.report.add(kind, message, where ? { where } : {})
    else ctx.warnings?.push(`MJCF: ${message}${where ? ` (${where})` : ''}`)
  }

  // 1. Includes, before anything else reads the document: MuJoCo pastes the included file's children in place.
  let elements = doc.getElementsByTagName('*').length
  const grow = (n: number, where: string) => {
    elements += n
    if (elements > LIMITS.xacroElements) throw refuse('elements', where)
  }
  grow(0, mainName)
  const expandIncludes = (container: Element, from: string, stack: string[]) => {
    for (const inc of Array.from(container.getElementsByTagName('include'))) {
      ctx.deadline?.check('expanding MJCF includes')
      const file = inc.getAttribute('file') ?? ''
      const hit = ctx.resolveInclude?.(file, from)
      if (!hit) {
        note('error', 'An included file was not imported, so its contents are missing.', file)
        inc.parentNode?.removeChild(inc)
        continue
      }
      if (stack.includes(hit.path)) throw refuse('depth', `circular include of '${file}'`)
      if (stack.length > LIMITS.includeDepth) throw refuse('depth', `include '${file}' is ${stack.length} includes deep`)
      const incRoot = parseXmlSafe(hit.text, hit.path, ctx.deadline).documentElement
      grow(incRoot.getElementsByTagName('*').length, `include '${file}'`)
      const holder = doc.createElement('include_holder')
      for (const child of Array.from(incRoot.childNodes)) holder.appendChild(doc.importNode(child, true))
      expandIncludes(holder, hit.path, [...stack, hit.path])
      while (holder.firstChild) inc.parentNode?.insertBefore(holder.firstChild, inc)
      inc.parentNode?.removeChild(inc)
    }
  }
  expandIncludes(root, ctx.fileName ?? mainName, [ctx.fileName ?? mainName])

  for (const [tag, message] of UNSUPPORTED) {
    if (doc.getElementsByTagName(tag).length > 0) note('unsupported', message)
  }

  // 2. Compiler settings: every <compiler> counts, a later attribute overriding an earlier one.
  const compiler = new Map<string, string>()
  for (const c of Array.from(doc.getElementsByTagName('compiler'))) {
    for (const a of Array.from(c.attributes)) compiler.set(a.name, a.value)
  }
  const angleUnit = (compiler.get('angle') ?? 'degree').toLowerCase() === 'radian' ? 1 : Math.PI / 180
  const eulerseq = compiler.get('eulerseq') ?? 'xyz'
  const autolimits = (compiler.get('autolimits') ?? 'true') !== 'false'
  const stripPath = compiler.get('strippath') === 'true'
  const meshDir = (compiler.get('meshdir') ?? compiler.get('assetdir') ?? '').replace(/\/+$/, '')
  if (compiler.get('coordinate') === 'global') note('unsupported', 'coordinate="global" is not supported (MuJoCo 3 removed it); poses are read as local.')

  // 3. Default classes. The top-level <default> is "main"; nested ones inherit from the one around them.
  const classes = new Map<string, ClassDef>()
  const main: ClassDef = { name: 'main', attrs: new Map() }
  classes.set('main', main)
  const readDefault = (el: Element, def: ClassDef) => {
    for (const child of Array.from(el.children)) {
      if (child.tagName === 'default') {
        const name = child.getAttribute('class') ?? ''
        const sub: ClassDef = classes.get(name) ?? { name, parent: def, attrs: new Map() }
        classes.set(name, sub)
        readDefault(child, sub)
        continue
      }
      const own = def.attrs.get(child.tagName) ?? new Map<string, string>()
      for (const a of Array.from(child.attributes)) own.set(a.name, a.value)
      def.attrs.set(child.tagName, own)
    }
  }
  for (const d of Array.from(root.children).filter((c) => c.tagName === 'default')) {
    const name = d.getAttribute('class')
    if (!name || name === 'main') readDefault(d, main)
    else {
      const def: ClassDef = classes.get(name) ?? { name, parent: main, attrs: new Map() }
      classes.set(name, def)
      readDefault(d, def)
    }
  }
  const classOf = (el: Element, childclass: string | undefined): ClassDef => {
    const name = el.getAttribute('class') ?? childclass ?? 'main'
    const def = classes.get(name)
    if (!def) note('error', 'An element names a default class that does not exist; the main defaults are used.', name)
    return def ?? main
  }
  /** The element's own attribute, else its class's (or an inherited class's) default. */
  const attr = (el: Element, cls: ClassDef, name: string): string | null => {
    const own = el.getAttribute(name)
    if (own !== null) return own
    for (let c: ClassDef | undefined = cls; c; c = c.parent) {
      const v = c.attrs.get(el.tagName)?.get(name)
      if (v !== undefined) return v
    }
    return null
  }

  // 4. Orientation, in MuJoCo's own rules: one of quat, axisangle, euler, xyaxes, zaxis.
  const orientFrom = (get: (name: string) => string | null | undefined): Quat => {
    const quat = nums(get('quat'))
    if (quat.length >= 4) return qnorm([quat[0], quat[1], quat[2], quat[3]])
    const aa = nums(get('axisangle'))
    if (aa.length >= 4) return axisAngle([aa[0], aa[1], aa[2]], aa[3] * angleUnit)
    const eu = nums(get('euler'))
    if (eu.length >= 3) {
      let q: Quat = [1, 0, 0, 0]
      for (let i = 0; i < 3; i++) {
        const ch = eulerseq[i] ?? 'xyz'[i]
        const axis: Vec3 = [0, 0, 0]
        axis['xyz'.indexOf(ch.toLowerCase())] = 1
        const step = axisAngle(axis, eu[i] * angleUnit)
        // lower case: about the rotated (intrinsic) axes, upper case: about the fixed (extrinsic) ones
        q = ch === ch.toLowerCase() ? qmul(q, step) : qmul(step, q)
      }
      return qnorm(q)
    }
    const xy = nums(get('xyaxes'))
    if (xy.length >= 6) return fromAxes([xy[0], xy[1], xy[2]], [xy[3], xy[4], xy[5]])
    const z = nums(get('zaxis'))
    if (z.length >= 3) return quatZ2Vec([z[0], z[1], z[2]])
    return [1, 0, 0, 0]
  }
  /** pos and orientation; orientation is taken as a group, so an element's own quat replaces a class's euler. */
  const poseOf = (el: Element, cls?: ClassDef): Pose => {
    const p = vec3(cls ? attr(el, cls, 'pos') : el.getAttribute('pos'), [0, 0, 0])
    if (!cls || ORIENTATION.some((o) => el.hasAttribute(o))) return { p, q: orientFrom((n) => el.getAttribute(n)) }
    for (let c: ClassDef | undefined = cls; c; c = c.parent) {
      const own = c.attrs.get(el.tagName)
      if (own && ORIENTATION.some((o) => own.has(o))) return { p, q: orientFrom((n) => own.get(n)) }
    }
    return { p, q: [1, 0, 0, 0] }
  }

  // 5. Assets: meshes (file and scale) and materials (colour).
  const meshes = new Map<string, { file: string; scale: string }>()
  const materials = new Map<string, number[]>()
  let textured = false
  for (const m of Array.from(doc.getElementsByTagName('mesh'))) {
    if (m.parentElement?.tagName !== 'asset') continue
    const cls = classOf(m, undefined)
    let file = m.getAttribute('file')
    const name = m.getAttribute('name') ?? (file ? file.split('/').pop()!.replace(/\.[^.]*$/, '') : '')
    if (!file) {
      note('unsupported', 'A mesh given inline (vertex data, not a file) is not drawn.', name)
      continue
    }
    if (stripPath) file = file.split('/').pop()!
    const path = file.startsWith('/') || !meshDir ? file : `${meshDir}/${file}`
    meshes.set(name, { file: path, scale: fmt(vec3(attr(m, cls, 'scale'), [1, 1, 1])) })
  }
  for (const m of Array.from(doc.getElementsByTagName('material'))) {
    if (m.parentElement?.tagName !== 'asset') continue
    const cls = classOf(m, undefined)
    const rgba = nums(attr(m, cls, 'rgba'))
    if (attr(m, cls, 'texture')) textured = true
    materials.set(m.getAttribute('name') ?? '', rgba.length >= 4 ? rgba.slice(0, 4) : [1, 1, 1, 1])
  }

  const robotName = root.getAttribute('model') || modelName
  // MuJoCo merges every <worldbody> (an included file often brings its own) in document order.
  const worldbodies = Array.from(root.children).filter((c) => c.tagName === 'worldbody')
  if (!worldbodies.length) return `<?xml version="1.0"?>\n<robot name="${esc(robotName)}"><link name="world"/></robot>`

  // 6. Bodies. Each body is a link; its joints become a chain of helper links when there is more than one.
  interface Visual {
    group: number
    xml: string
  }
  const links: { name: string; visuals: Visual[] }[] = [{ name: 'world', visuals: [] }]
  const joints: string[] = []
  let bodyCount = 0
  let jointCount = 0
  let worldGeoms = 0
  let ellipsoids = false
  let fitted = false

  const jointXml = (name: string, type: string, parent: string, child: string, pose: Pose, extra = '') =>
    `  <joint name="${esc(name)}" type="${type}">\n    <parent link="${esc(parent)}"/>\n    <child link="${esc(child)}"/>\n    ${origin(pose)}${extra}\n  </joint>`

  const visualsOf = (geom: Element, cls: ClassDef, frame: Pose): Visual[] => {
    const type = attr(geom, cls, 'type') ?? 'sphere'
    const group = Number(attr(geom, cls, 'group') ?? 0)
    const ownRgba = nums(attr(geom, cls, 'rgba'))
    const matName = attr(geom, cls, 'material')
    let rgba = DEFAULT_RGBA
    if (ownRgba.length >= 4 && ownRgba.some((v, i) => v !== DEFAULT_RGBA[i])) rgba = ownRgba.slice(0, 4)
    else if (matName && materials.has(matName)) rgba = materials.get(matName)!
    if (rgba[3] === 0) return []
    if (type === 'plane' || type === 'hfield' || type === 'sdf') {
      if (type !== 'plane') note('unsupported', `A ${type} geom is not drawn.`, geom.getAttribute('name') ?? undefined)
      return []
    }
    const size = nums(attr(geom, cls, 'size'))
    let pose = poseOf(geom, cls)
    let half = size[1] ?? 0
    const fromto = nums(attr(geom, cls, 'fromto'))
    if (fromto.length >= 6 && ['capsule', 'cylinder', 'box', 'ellipsoid'].includes(type)) {
      const a: Vec3 = [fromto[0], fromto[1], fromto[2]]
      const b: Vec3 = [fromto[3], fromto[4], fromto[5]]
      const d = sub(a, b)
      half = Math.hypot(...d) / 2
      pose = { p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], q: quatZ2Vec(d) }
      if (type === 'box' || type === 'ellipsoid') size.splice(0, 3, size[0] ?? 0, size[0] ?? 0, half)
    }
    pose = compose(frame, pose)
    const material = `<material><color rgba="${fmt(rgba)}"/></material>`
    const one = (at: Pose, shape: string): Visual => ({
      group,
      xml: `    <visual>\n      ${origin(at)}\n      <geometry>${shape}</geometry>\n      ${material}\n    </visual>`,
    })
    const meshName = attr(geom, cls, 'mesh')
    if (type === 'mesh' || meshName) {
      if (type !== 'mesh') fitted = true
      const mesh = meshName ? meshes.get(meshName) : undefined
      if (!mesh) {
        note('error', 'A geom names a mesh that is not in <asset>, so it is not drawn.', meshName ?? geom.getAttribute('name') ?? undefined)
        return []
      }
      return [one(pose, `<mesh filename="${esc(mesh.file)}" scale="${mesh.scale}"/>`)]
    }
    const r = size[0] ?? 0
    switch (type) {
      case 'sphere':
        return [one(pose, `<sphere radius="${fmt([r])}"/>`)]
      case 'ellipsoid':
        ellipsoids = true
        return [one(pose, `<sphere radius="${fmt([Math.max(r, size[1] ?? 0, size[2] ?? 0)])}"/>`)]
      case 'box':
        return [one(pose, `<box size="${fmt([2 * r, 2 * (size[1] ?? 0), 2 * (size[2] ?? 0)])}"/>`)]
      case 'cylinder':
        return [one(pose, `<cylinder radius="${fmt([r])}" length="${fmt([2 * half])}"/>`)]
      case 'capsule':
        // URDF has no capsule: a cylinder and a sphere on each end
        return [
          one(pose, `<cylinder radius="${fmt([r])}" length="${fmt([2 * half])}"/>`),
          one(compose(pose, translate([0, 0, half])), `<sphere radius="${fmt([r])}"/>`),
          one(compose(pose, translate([0, 0, -half])), `<sphere radius="${fmt([r])}"/>`),
        ]
      default:
        note('unsupported', `A ${type} geom is not drawn.`, geom.getAttribute('name') ?? undefined)
        return []
    }
  }

  interface Placed {
    el: Element
    frame: Pose
    childclass?: string
  }
  /** A body's (or the worldbody's) geoms, joints and child bodies, with any <frame> around them composed in. */
  const contents = (container: Element, frame: Pose, childclass: string | undefined) => {
    const out = { geoms: [] as Placed[], joints: [] as Placed[], bodies: [] as Placed[] }
    const walk = (el: Element, at: Pose, cc: string | undefined) => {
      for (const child of Array.from(el.children)) {
        const tag = child.tagName
        if (tag === 'geom') out.geoms.push({ el: child, frame: at, childclass: cc })
        else if (tag === 'body') out.bodies.push({ el: child, frame: at, childclass: cc })
        else if ((tag === 'joint' || tag === 'freejoint') && el === container) out.joints.push({ el: child, frame: at, childclass: cc })
        else if (tag === 'frame') walk(child, compose(at, poseOf(child)), child.getAttribute('childclass') ?? cc)
      }
    }
    walk(container, frame, childclass)
    return out
  }

  const visitBody = ({ el: body, frame, childclass }: Placed, parent: string) => {
    ctx.deadline?.check('converting the MJCF')
    const name = body.getAttribute('name') || `body_${++bodyCount}`
    const cc = body.getAttribute('childclass') ?? childclass
    const X = compose(frame, poseOf(body))
    const inside = contents(body, IDENTITY, cc)
    const link = { name, visuals: [] as Visual[] }
    links.push(link)
    for (const g of inside.geoms) link.visuals.push(...visualsOf(g.el, classOf(g.el, g.childclass), g.frame))

    const js = inside.joints.map(({ el, childclass: jc }) => {
      const cls = classOf(el, jc)
      const type = el.tagName === 'freejoint' ? 'free' : (attr(el, cls, 'type') ?? 'hinge')
      return { el, cls, type, name: el.getAttribute('name') || `joint_${++jointCount}`, pos: vec3(attr(el, cls, 'pos'), [0, 0, 0]) }
    })
    const free = js.find((j) => j.type === 'free')
    if (js.length === 0) {
      joints.push(jointXml(`${parent}_to_${name}`, 'fixed', parent, name, X))
    } else if (free) {
      note('approx', 'A free joint is shown as a floating base.', free.name)
      joints.push(jointXml(free.name, 'floating', parent, name, X))
    } else {
      let prev = parent
      let prevPos: Vec3 = [0, 0, 0]
      js.forEach((j, k) => {
        const at = k === 0 ? compose(X, translate(j.pos)) : translate(sub(j.pos, prevPos))
        const last = k === js.length - 1
        const child = last && isZero(j.pos) ? name : `${name}__j${k + 1}`
        if (child !== name) links.push({ name: child, visuals: [] })
        if (j.type === 'ball') {
          note('approx', 'A ball joint is shown fixed.', j.name)
          joints.push(jointXml(j.name, 'fixed', prev, child, at))
        } else {
          const raw = vec3(attr(j.el, j.cls, 'axis'), [0, 0, 1])
          const n = Math.hypot(...raw) || 1
          const axis = raw.map((c) => c / n)
          const range = nums(attr(j.el, j.cls, 'range'))
          const limited = attr(j.el, j.cls, 'limited') ?? 'auto'
          const isLimited = limited === 'true' || (limited === 'auto' && autolimits && range.length >= 2)
          const unit = j.type === 'slide' ? 1 : angleUnit
          if (Number(attr(j.el, j.cls, 'ref') ?? 0) !== 0) note('approx', 'A joint reference position (ref) is ignored; the joint reads 0 where MuJoCo reads ref.', j.name)
          let type: string
          let lower = -Math.PI
          let upper = Math.PI
          if (j.type === 'slide') type = 'prismatic'
          else type = isLimited ? 'revolute' : 'continuous'
          if (isLimited && range.length >= 2) {
            lower = range[0] * unit
            upper = range[1] * unit
          }
          const extra = `\n    <axis xyz="${fmt(axis)}"/>\n    <limit lower="${fmt([lower])}" upper="${fmt([upper])}" effort="100" velocity="10"/>`
          joints.push(jointXml(j.name, type, prev, child, at, extra))
        }
        prev = child
        prevPos = j.pos
      })
      if (!isZero(prevPos)) joints.push(jointXml(`${name}__anchor`, 'fixed', prev, name, translate([-prevPos[0], -prevPos[1], -prevPos[2]])))
    }
    for (const b of inside.bodies) visitBody(b, name)
  }

  for (const worldbody of worldbodies) {
    const top = contents(worldbody, IDENTITY, worldbody.getAttribute('childclass') ?? undefined)
    for (const g of top.geoms) {
      if ((attr(g.el, classOf(g.el, g.childclass), 'type') ?? 'sphere') !== 'plane') worldGeoms++
    }
    for (const b of top.bodies) visitBody(b, 'world')
  }

  if (worldGeoms) note('unsupported', 'Geoms fixed to the world (scenery) are not drawn.')
  if (ellipsoids) note('approx', 'An ellipsoid geom is drawn as a sphere of its largest radius.')
  if (fitted) note('approx', 'A primitive geom fitted to a mesh is drawn as the mesh.')
  if (textured) note('approx', 'Textures are not drawn; the material colour is used.')

  // MuJoCo's viewer shows geom groups 0-2 by default (collision geoms usually sit in 3); show everything only if that is empty.
  const shown = links.some((l) => l.visuals.some((v) => v.group <= 2))
  if (!shown && links.some((l) => l.visuals.length)) note('approx', 'No geom is in groups 0-2, so every group is drawn.')
  const linkXml = links.map(({ name, visuals }) => {
    const drawn = visuals.filter((v) => !shown || v.group <= 2).map((v) => v.xml)
    return drawn.length ? `  <link name="${esc(name)}">\n${drawn.join('\n')}\n  </link>` : `  <link name="${esc(name)}"/>`
  })
  return `<?xml version="1.0"?>\n<robot name="${esc(robotName)}">\n${linkXml.join('\n')}\n\n${joints.join('\n')}\n</robot>\n`
}
