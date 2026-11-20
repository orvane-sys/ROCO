/**
 * The model check: problems in a robot description that a simulator refuses or that make the robot wrong, found once per
 * import (never per frame) in the URDF the importer produced. Masses and inertias follow the program that reads each format:
 * MuJoCo 3.17.0 for URDF, xacro and MJCF (src/user/user_objects.cc mjCBody::Compile, src/user/user_model.cc
 * CheckBodyMassInertia, src/xml/xml_urdf.cc), libsdformat 14 with gz-math 7 for SDF (Link.cc, MassMatrix3.hh IsValid).
 * Missing meshes are not repeated here (the import report lists them), nor size and up axis (the 3D view offers a fix).
 */
import type { MjcfInertiaContext } from './modelFormatParser'
import type { TriangleCount } from './meshTriangles'

export type CheckSeverity = 'error' | 'warning'
export type CheckCode = 'mass' | 'inertia-pd' | 'inertia-triangle' | 'moving-massless' | 'axis' | 'limits' | 'mesh-scale' | 'collision-heavy'

export interface CheckFinding {
  severity: CheckSeverity
  code: CheckCode
  /** The links, joints or meshes it applies to. */
  where: string[]
  message: string
  /** What to change in the file. */
  fix: string
}

export interface CheckOptions {
  /** The format of the main file: an `xacro` checks as the URDF it expands to. */
  format: 'urdf' | 'mjcf' | 'sdf'
  /** From the MJCF converter: the compiler settings and the body tree MuJoCo checks. */
  mjcf?: MjcfInertiaContext
  /** From the SDF converter: links whose inertia Gazebo computes from their collisions, and links it added (joint helpers). */
  sdfAutoInertia?: string[]
  sdfHelperLinks?: string[]
  /** The triangles in a collision mesh, by its `filename` as written in the document; undefined when not counted. */
  collisionTriangles?: (filename: string) => TriangleCount | null | undefined
}

/** MuJoCo's mjMINVAL (include/mujoco/mjtype.h) and the eigenvalue floor of mjuu_fullInertia (mjEPS, 1e-14, found by probe). */
const MINVAL = 1e-15
const MIN_EIGEN = 1e-14
/** ROCO's own thresholds for slow collision meshes (not a simulator's limit). */
export const COLLISION_TRIANGLES_MESH = 100_000
export const COLLISION_TRIANGLES_TOTAL = 1_000_000
/** gz-math's GZ_MASSMATRIX3_DEFAULT_TOLERANCE (Helpers.hh). */
const GZ_TOLERANCE = 10

/** A strict number: '' and junk are NaN, not 0. */
const num = (s: string | null | undefined): number => (s == null || s.trim() === '' ? NaN : Number(s))
const nums = (s: string | null | undefined): number[] => (s ?? '').trim().split(/\s+/).filter(Boolean).map(Number)
const kids = (el: Element, tag: string): Element[] => Array.from(el.children).filter((c) => c.tagName === tag)
const kid = (el: Element | undefined, tag: string): Element | undefined => (el ? kids(el, tag)[0] : undefined)

/** An `<inertial>` as written: mass and the six tensor entries (NaN where missing), or what makes it unreadable. */
interface Inertial {
  mass: number
  /** ixx, iyy, izz, ixy, ixz, iyz (MuJoCo's fullinertia order). */
  tensor: number[]
  missing?: 'mass' | 'inertia'
}

function readInertial(link: Element): Inertial | undefined {
  const el = kid(link, 'inertial')
  if (!el) return undefined
  const massEl = kid(el, 'mass')
  const inertiaEl = kid(el, 'inertia')
  const tensor = ['ixx', 'iyy', 'izz', 'ixy', 'ixz', 'iyz'].map((a) => num(inertiaEl?.getAttribute(a)))
  return {
    mass: num(massEl?.getAttribute('value')),
    tensor,
    ...(massEl?.hasAttribute('value') ? (inertiaEl && tensor.every((v) => !Number.isNaN(v)) ? {} : { missing: 'inertia' as const }) : { missing: 'mass' as const }),
  }
}

// ---- MuJoCo's eigen decomposition, ported from src/user/user_util.cc (mjuu_eig3, reltol 4e-15) so that borderline tensors
// (a thin plate, where A + B = C to the last digit) get the same principal moments MuJoCo gets.

const MJ_EPS = 1e-14
function normvec(v: number[]): void {
  let nrm = 0
  for (const x of v) nrm += x * x
  if (nrm < MJ_EPS) return
  nrm = Math.sqrt(nrm)
  if (Math.abs(nrm - 1) > MJ_EPS) for (let i = 0; i < v.length; i++) v[i] /= nrm
}
function mulquat(a: number[], b: number[]): number[] {
  const t = [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ]
  normvec(t)
  return t
}
function quat2mat(q: number[]): number[] {
  if (q[0] === 1 && q[1] === 0 && q[2] === 0 && q[3] === 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const q00 = q[0] * q[0], q01 = q[0] * q[1], q02 = q[0] * q[2], q03 = q[0] * q[3]
  const q11 = q[1] * q[1], q12 = q[1] * q[2], q13 = q[1] * q[3]
  const q22 = q[2] * q[2], q23 = q[2] * q[3], q33 = q[3] * q[3]
  return [
    q00 + q11 - q22 - q33, 2 * (q12 - q03), 2 * (q13 + q02),
    2 * (q12 + q03), q00 - q11 + q22 - q33, 2 * (q23 - q01),
    2 * (q13 - q02), 2 * (q23 + q01), q00 - q11 - q22 + q33,
  ]
}
function mulmat(A: number[], B: number[]): number[] {
  const r = new Array<number>(9)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j]
  return r
}
const transpose = (m: number[]): number[] => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]

/** The principal moments of a symmetric 3×3 (row-major), largest first, as mjuu_eig3 computes them. */
export function principalMoments(mat: number[]): number[] {
  const reltol = 4e-15
  let scale = 0
  for (const x of mat) scale = Math.max(scale, Math.abs(x))
  const tol = scale * Math.max(reltol, 4e-15)
  let quat = [1, 0, 0, 0]
  const eig = [0, 0, 0]
  for (let iter = 0; iter < 500; iter++) {
    const vec = quat2mat(quat)
    const D = mulmat(mulmat(transpose(vec), mat), vec)
    eig[0] = D[0]
    eig[1] = D[4]
    eig[2] = D[8]
    let rk: number, ck: number, rotk: number
    if (Math.abs(D[1]) > Math.abs(D[2]) && Math.abs(D[1]) > Math.abs(D[5])) [rk, ck, rotk] = [0, 1, 2]
    else if (Math.abs(D[2]) > Math.abs(D[5])) [rk, ck, rotk] = [0, 2, 1]
    else [rk, ck, rotk] = [1, 2, 0]
    if (!(Math.abs(D[3 * rk + ck]) > tol)) break
    const tau = (D[4 * ck] - D[4 * rk]) / (2 * D[3 * rk + ck])
    const t = tau >= 0 ? 1 / (tau + Math.sqrt(1 + tau * tau)) : -1 / (-tau + Math.sqrt(1 + tau * tau))
    const h = t / (1 + Math.sqrt(1 + t * t))
    const rot = [1 / Math.sqrt(1 + h * h), 0, 0, 0]
    rot[rotk + 1] = (rotk === 1 ? h : -h) * rot[0]
    quat = mulquat(quat, rot)
    normvec(quat)
  }
  const eps = scale * Math.max(reltol, 1e-12)
  for (let j = 0; j < 3; j++) {
    const j1 = j % 2
    if (eig[j1] + eps < eig[j1 + 1]) [eig[j1], eig[j1 + 1]] = [eig[j1 + 1], eig[j1]]
  }
  return eig
}

const fullMatrix = ([ixx, iyy, izz, ixy, ixz, iyz]: number[]): number[] => [ixx, ixy, ixz, ixy, iyy, iyz, ixz, iyz, izz]
const breaksTriangle = ([a, b, c]: number[]): boolean => a + b < c || a + c < b || b + c < a

/** Findings gathered by code and message, so many links with one problem make one finding. */
class Findings {
  private byKey = new Map<string, CheckFinding>()
  add(severity: CheckSeverity, code: CheckCode, where: string, message: string, fix: string): void {
    const key = `${severity}\u0000${code}\u0000${message}`
    const f = this.byKey.get(key)
    if (f) {
      if (!f.where.includes(where)) f.where.push(where)
    } else this.byKey.set(key, { severity, code, where: where ? [where] : [], message, fix })
  }
  list(): CheckFinding[] {
    const all = [...this.byKey.values()]
    return [...all.filter((f) => f.severity === 'error'), ...all.filter((f) => f.severity === 'warning')]
  }
}

/** The settings MuJoCo applies to masses and inertias; a URDF carries its own in `<mujoco><compiler>` (xml_urdf.cc Parse). */
interface MassRules {
  inertiafromgeom: 'false' | 'true' | 'auto'
  balanceinertia: boolean
  boundmass: number
  boundinertia: number
  /** Static bodies are merged into their parents before the final compile (MuJoCo's default is on for URDF, off for MJCF). */
  fusestatic: boolean
}

function urdfRules(robot: Element): MassRules {
  const c = kid(kid(robot, 'mujoco'), 'compiler')
  const g = c?.getAttribute('inertiafromgeom')
  return {
    inertiafromgeom: g === 'true' || g === 'false' ? g : 'auto',
    balanceinertia: c?.getAttribute('balanceinertia') === 'true',
    boundmass: num(c?.getAttribute('boundmass')) || 0,
    boundinertia: num(c?.getAttribute('boundinertia')) || 0,
    fusestatic: c?.getAttribute('fusestatic') !== 'false',
  }
}

/** One MuJoCo body as the mass check sees it. */
interface Body {
  name: string
  moving: boolean
  children: Body[]
  inertial?: Inertial
  /** Whether MuJoCo would compute its inertia from its geoms, and whether it has any to compute from. */
  inferred: boolean
  geoms: boolean
  /** A full tensor (URDF, MJCF fullinertia): MuJoCo takes its eigenvalues and refuses any below mjEPS. */
  full: boolean
}

const MOVING_URDF = new Set(['revolute', 'continuous', 'prismatic', 'floating', 'planar'])

export function checkModel(doc: Document, opts: CheckOptions): CheckFinding[] {
  const out = new Findings()
  const robot = doc.documentElement
  const links = kids(robot, 'link')
  const linkByName = new Map(links.map((l) => [l.getAttribute('name') ?? '', l]))
  const joints = kids(robot, 'joint')

  if (opts.format === 'sdf') checkSdfMasses(out, links, opts)
  else checkMujocoMasses(out, opts.format === 'mjcf' && opts.mjcf ? mjcfBodies(opts.mjcf, linkByName) : urdfBodies(links, joints), opts.format === 'mjcf' && opts.mjcf ? opts.mjcf : urdfRules(robot), opts.format)

  // joints: a zero axis has no direction; reversed or infinite limits leave no range
  for (const j of joints) {
    const name = j.getAttribute('name') ?? ''
    const type = j.getAttribute('type') ?? ''
    if (type === 'revolute' || type === 'continuous' || type === 'prismatic' || type === 'planar') {
      const axisEl = kid(j, 'axis')
      const axis = axisEl ? nums(axisEl.getAttribute('xyz')) : [1, 0, 0]
      if (axis.length !== 3 || !axis.every(Number.isFinite)) {
        out.add('error', 'axis', name, 'A joint axis is not three numbers.', 'Write the axis as three numbers, e.g. <axis xyz="0 0 1"/>.')
      } else if (Math.hypot(...axis) < MIN_EIGEN) {
        out.add('error', 'axis', name, 'A joint axis is zero, so the joint has no direction.', 'Give the joint a nonzero axis, e.g. <axis xyz="0 0 1"/>.')
      }
    }
    if (type === 'revolute' || type === 'prismatic') {
      const lim = kid(j, 'limit')
      if (lim) {
        const lo = num(lim.getAttribute('lower') ?? '0')
        const hi = num(lim.getAttribute('upper') ?? '0')
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
          out.add('error', 'limits', name, 'A joint limit is not a finite number.', 'Give lower and upper as finite numbers, or make the joint continuous.')
        } else if (lo > hi) {
          out.add('error', 'limits', name, 'A joint\'s lower limit is above its upper limit.', 'Swap lower and upper.')
        }
      }
    }
  }

  // meshes: a zero scale flattens the mesh to nothing
  for (const link of links) {
    for (const part of [...kids(link, 'visual'), ...kids(link, 'collision')]) {
      const mesh = kid(kid(part, 'geometry'), 'mesh')
      if (!mesh?.hasAttribute('scale')) continue
      const s = nums(mesh.getAttribute('scale'))
      if (s.length !== 3 || !s.every((v) => Number.isFinite(v) && v !== 0)) {
        out.add('error', 'mesh-scale', link.getAttribute('name') ?? '', 'A mesh scale has a zero or unreadable part, so the mesh is flat or missing.', 'Write the scale as three nonzero numbers, e.g. scale="0.001 0.001 0.001".')
      }
    }
  }

  // collision meshes: slow contact in any simulator (ROCO's own thresholds)
  if (opts.collisionTriangles) {
    let total = 0
    let exact = true
    for (const link of links) {
      for (const c of kids(link, 'collision')) {
        const file = kid(kid(c, 'geometry'), 'mesh')?.getAttribute('filename')
        const n = file ? opts.collisionTriangles(file) : undefined
        if (!file || !n) continue
        total += n.triangles
        exact &&= n.exact
        if (n.triangles > COLLISION_TRIANGLES_MESH) {
          out.add('warning', 'collision-heavy', `${link.getAttribute('name') ?? ''}: ${decodePath(file)} (${n.exact ? '' : 'at least '}${n.triangles.toLocaleString('en-US')})`,
            `A collision mesh has more than ${COLLISION_TRIANGLES_MESH.toLocaleString('en-US')} triangles (ROCO's own threshold), so contact is slow to simulate.`,
            'Use a simplified mesh or a primitive shape for the collision.')
        }
      }
    }
    if (total > COLLISION_TRIANGLES_TOTAL) {
      out.add('warning', 'collision-heavy', '', `The collision meshes have ${exact ? '' : 'at least '}${total.toLocaleString('en-US')} triangles in all, more than ${COLLISION_TRIANGLES_TOTAL.toLocaleString('en-US')} (ROCO's own threshold).`,
        'Use simplified meshes or primitive shapes for the collisions.')
    }
  }
  return out.list()
}

const decodePath = (p: string): string => p.split('/').map((s) => { try { return decodeURIComponent(s) } catch { return s } }).join('/')

/** URDF links as MuJoCo's URDF reader makes bodies: a root is static, a link under a non-fixed joint moves. */
function urdfBodies(links: Element[], joints: Element[]): Body[] {
  const bodies = new Map<string, Body>()
  for (const l of links) {
    bodies.set(l.getAttribute('name') ?? '', {
      name: l.getAttribute('name') ?? '',
      moving: false,
      children: [],
      inertial: readInertial(l),
      inferred: false,
      // URDF visuals add no mass in MuJoCo (probed: a moving link with only a <visual> is refused); collisions do
      geoms: kids(l, 'collision').length > 0,
      full: false,
    })
  }
  for (const j of joints) {
    const parent = bodies.get(kid(j, 'parent')?.getAttribute('link') ?? '')
    const child = bodies.get(kid(j, 'child')?.getAttribute('link') ?? '')
    if (!parent || !child) continue
    child.moving = MOVING_URDF.has(j.getAttribute('type') ?? '')
    parent.children.push(child)
  }
  for (const b of bodies.values()) {
    // xml_urdf.cc Body: a tensor of six zeros is "not given" (NaN), anything else is a fullinertia
    b.full = !!b.inertial && !b.inertial.missing && b.inertial.tensor.some((v) => v !== 0)
  }
  return [...bodies.values()]
}

/** The MJCF body tree as the converter recorded it, with each body's inertial read from its link. */
function mjcfBodies(mjcf: MjcfInertiaContext, linkByName: Map<string, Element>): Body[] {
  const bodies = new Map<string, Body>()
  for (const b of mjcf.bodies) {
    const link = linkByName.get(b.link)
    bodies.set(b.link, { name: b.link, moving: b.moving, children: [], inertial: link ? readInertial(link) : undefined, inferred: false, geoms: b.geoms, full: b.fullinertia })
  }
  for (const b of mjcf.bodies) {
    const parent = bodies.get(b.parent)
    const child = bodies.get(b.link)
    if (parent && child) parent.children.push(child)
  }
  return [...bodies.values()]
}

/** MuJoCo's checks, in its order: fullinertia eigenvalues, bounds, negatives, A + B >= C, then moving bodies' mass. */
function checkMujocoMasses(out: Findings, bodies: Body[], rules: MassRules, format: 'urdf' | 'mjcf'): void {
  const fromShapes = rules.inertiafromgeom === 'true'
  const tag = format === 'mjcf' ? 'body' : 'link'
  // whether each body ends with a mass and inertia above mjMINVAL; a body MuJoCo refuses outright is reported once, in refused
  const valid = new Map<Body, boolean>()
  // whether compiling changed a body's mass or inertia (bounds, balanceinertia): user_objects.cc inertia_adjusted_; taken as
  // false for a body whose inertia comes from its shapes, whose values the page does not compute
  const adjusted = new Set<Body>()
  const refused = new Set<Body>()
  const refuse = (b: Body, code: CheckCode, message: string, fix: string) => {
    out.add('error', code, b.name, message, fix)
    valid.set(b, false)
    refused.add(b)
  }
  for (const b of bodies) {
    // MuJoCo takes a body's mass from its geoms only when they have some (probed: a body with no geom, or only massless
    // ones, keeps its <inertial> under inertiafromgeom="true", and that inertial is checked as any other)
    b.inferred = (fromShapes || (rules.inertiafromgeom === 'auto' && !b.inertial)) && b.geoms
    const i = b.inertial
    if (i?.missing) {
      refuse(b, i.missing === 'mass' ? 'mass' : 'inertia-pd',
        i.missing === 'mass' ? 'An <inertial> has no <mass value>, which MuJoCo refuses.' : 'An <inertial> has no complete <inertia> (ixx, ixy, ixz, iyy, iyz, izz), which MuJoCo refuses.',
        i.missing === 'mass' ? `Give the ${tag} a <mass value="…"/>.` : `Give the ${tag} all six <inertia> values.`)
      continue
    }
    let moments: number[] | undefined
    if (i && b.full) {
      if (!i.tensor.every(Number.isFinite)) {
        refuse(b, 'inertia-pd', 'An inertia value is not a finite number.', `Give the ${tag} finite inertia values.`)
        continue
      }
      moments = principalMoments(fullMatrix(i.tensor))
      // mjuu_fullInertia runs whatever inertiafromgeom says
      if (moments[2] < MIN_EIGEN) {
        refuse(b, 'inertia-pd', 'An inertia tensor is not positive definite (a principal moment is zero or below), which MuJoCo refuses.',
          `Give the ${tag} an inertia whose principal moments are all above 0, e.g. from the CAD's mass properties.`)
        continue
      }
    }
    if (b.inferred) {
      valid.set(b, true)
      continue
    }
    if (!i) {
      // no inertial and no geom with mass (or inertiafromgeom="false"): mass 0, unless boundmass and boundinertia raise it
      valid.set(b, Math.max(0, rules.boundmass) >= MINVAL && rules.boundinertia >= MINVAL)
      if (rules.boundmass > 0 || rules.boundinertia > 0) adjusted.add(b)
      continue
    }
    const mass = Math.max(i.mass, rules.boundmass)
    const raw = moments ?? [i.tensor[0], i.tensor[1], i.tensor[2]]
    let p = raw.map((v) => Math.max(v, rules.boundinertia))
    if (mass !== i.mass || p.some((v, k) => v !== raw[k])) adjusted.add(b)
    if (!Number.isFinite(i.mass)) {
      refuse(b, 'mass', 'A mass is not a finite number.', `Give the ${tag} a finite mass.`)
      continue
    }
    if (mass < 0 || p.some((v) => v < 0)) {
      if (mass < 0) refuse(b, 'mass', 'A mass is below 0, which MuJoCo refuses.', `Give the ${tag} a mass of 0 or more (above 0 if a joint moves it).`)
      else refuse(b, 'inertia-pd', 'An inertia value is below 0, which MuJoCo refuses.', `Give the ${tag} inertia values of 0 or more.`)
      continue
    }
    // with boundmass and boundinertia at their default 0, MuJoCo reads a value below 0 as 0 (probed: a static body passes)
    if (i.mass < 0) out.add('warning', 'mass', b.name, 'A mass is below 0; MuJoCo reads it as 0.', `Give the ${tag} its real mass.`)
    if (!moments && i.tensor.slice(0, 3).some((v) => v < 0)) out.add('warning', 'inertia-pd', b.name, 'An inertia value is below 0; MuJoCo reads it as 0.', `Give the ${tag} its real inertia.`)
    if (!p.every(Number.isFinite)) {
      refuse(b, 'inertia-pd', 'An inertia value is not a finite number.', `Give the ${tag} finite inertia values.`)
      continue
    }
    if (breaksTriangle(p)) {
      if (rules.balanceinertia) {
        const mean = (p[0] + p[1] + p[2]) / 3
        p = [mean, mean, mean]
        adjusted.add(b)
      } else {
        refuse(b, 'inertia-triangle', 'An inertia breaks A + B ≥ C (no real body has it), which MuJoCo refuses.',
          `Fix the ${tag}'s inertia so each principal moment is at most the sum of the other two, or set <compiler balanceinertia="true"/>.`)
        continue
      }
    }
    valid.set(b, mass >= MINVAL && p.every((v) => v >= MINVAL))
  }

  if (fromShapes) {
    out.add('warning', 'mass', '', `Masses and inertias come from the shapes (inertiafromgeom="true"), so a ${tag}'s <inertial> is checked only when it has no shape with mass.`, 'Nothing to change, unless the shapes are not the real parts.')
  }

  // user_model.cc CheckBodyMassInertia: a moving body needs a mass and inertia, its own or a static child's
  // user_model.cc FuseStatic: with inertiafromgeom="true" and fusestatic, a static body merges into its parent, which then
  // infers its inertia from the shapes of both, so the static body's own <inertial> is lost; unless compiling adjusted
  // either one, when a static body with mass is kept. Its children then hang off the parent. Not modelled: a static body
  // kept because something names it (a sensor, an exclude), or because of gravcomp or fluid forces; nor a sum of two
  // inertias that fusing leaves exactly on the A + B = C edge, which rounding tips either way (fuzzed: 1 model in 6 400).
  // Walked with a stack, not recursion: a chain of fixed links can be thousands long.
  const has = (b: Body, inferredToo: boolean): boolean => {
    const counts = (c: Body) => valid.get(c) === true && (inferredToo || !c.inferred)
    if (counts(b)) return true
    const stack: [Body, Body][] = b.children.filter((c) => !c.moving).map((c) => [c, b])
    for (let item = stack.pop(); item; item = stack.pop()) {
      const [c, parent] = item
      const merged = fromShapes && rules.fusestatic && !adjusted.has(parent) && !adjusted.has(c)
      if (merged ? inferredToo && c.inferred && valid.get(c) === true : counts(c)) return true
      for (const g of c.children) if (!g.moving) stack.push([g, merged ? parent : c])
    }
    return false
  }
  for (const b of bodies) {
    if (!b.moving || refused.has(b)) continue
    if (has(b, false)) continue
    if (has(b, true)) {
      // MJCF computes inertias from geoms by design; a URDF link without an <inertial> is more likely an omission
      if (format === 'urdf' && !fromShapes) {
        out.add('warning', 'moving-massless', b.name, 'A link moved by a joint has no <inertial>, so MuJoCo guesses its mass from its collision shapes.',
          'Give the link an <inertial> with its real mass and inertia.')
      }
      continue
    }
    out.add('error', 'moving-massless', b.name, `A ${tag} moved by a joint has no mass or inertia, nor does any ${tag} fixed to it, which MuJoCo refuses.`,
      `Give the ${tag} (or one fixed to it) a mass and inertia above 0${format === 'urdf' ? ', or a collision shape' : ''}.`)
  }
}

/** libsdformat 14 Link::Load: an inertial gz-math's MassMatrix3::IsValid refuses is an error; a link with none gets 1 kg. */
function checkSdfMasses(out: Findings, links: Element[], opts: CheckOptions): void {
  const helpers = new Set(opts.sdfHelperLinks ?? [])
  const computed = new Set(opts.sdfAutoInertia ?? [])
  for (const link of links) {
    const name = link.getAttribute('name') ?? ''
    if (helpers.has(name) || computed.has(name)) continue
    const i = readInertial(link)
    if (!i) {
      out.add('warning', 'mass', name, 'A link has no <inertial>, so Gazebo gives it 1 kg and an inertia of 1 kg·m² on each axis.', 'Give the link an <inertial> with its real mass and inertia.')
      continue
    }
    if (!(i.mass >= 0)) {
      out.add('error', 'mass', name, 'A mass is below 0 or not a number, which Gazebo refuses ("invalid inertia").', 'Give the link a mass of 0 or more.')
      continue
    }
    const [ixx, iyy, izz, ixy, ixz, iyz] = i.tensor
    if (!i.tensor.every(Number.isFinite)) {
      out.add('error', 'inertia-pd', name, 'An inertia value is not a finite number.', 'Give the link finite inertia values.')
      continue
    }
    // MassMatrix3::Epsilon: tolerance × machine epsilon × the largest possible moment (half the trace)
    const eps = GZ_TOLERANCE * Number.EPSILON * 0.5 * Math.abs(ixx + iyy + izz)
    const det = ixx * (iyy * izz - iyz * iyz) - ixy * (ixy * izz - iyz * ixz) + ixz * (ixy * iyz - iyy * ixz)
    const moments = principalMoments(fullMatrix(i.tensor))
    const nearPositive = ixx + eps >= 0 && ixx * iyy - ixy * ixy + eps >= 0 && det + eps >= 0 && moments.every((m) => m + eps >= 0)
    if (!nearPositive) {
      out.add('error', 'inertia-pd', name, 'An inertia tensor is not positive (a principal moment is below 0), which Gazebo refuses ("invalid inertia").',
        'Give the link an inertia whose principal moments are 0 or more, e.g. from the CAD\'s mass properties.')
    } else if (moments[0] + moments[1] + eps < moments[2] || moments[1] + moments[2] + eps < moments[0] || moments[2] + moments[0] + eps < moments[1]) {
      out.add('error', 'inertia-triangle', name, 'An inertia breaks A + B ≥ C (no real body has it), which Gazebo refuses ("invalid inertia").',
        'Fix the link\'s inertia so each principal moment is at most the sum of the other two.')
    }
  }
}
