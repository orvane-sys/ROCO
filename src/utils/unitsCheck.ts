import * as THREE from 'three'
import type { URDFRobot } from 'urdf-loader'

// A robot file in millimetres, or modelled Y-up, loads 1000 times too big or lying on its side. URDF and MJCF are metres and
// Z-up, so the twin cannot know; it measures the loaded robot, offers a fix and applies it only when the user says so.

/** How to turn the file into metres and Z-up: a uniform scale, and which way Y points if the file is Y-up (0: it is Z-up). */
export interface UnitsFix {
  scale: number
  upY: 0 | 1 | -1
}

export interface UnitsOffer {
  fix: UnitsFix
  /** What was found, for the user. */
  text: string
}

/** A robot bigger than this cannot be metres; at 1/1000 it has to land in the size range of a real robot. */
const MM_OVER = 20
const ROBOT_SIZE = [0.05, 5] as const

const v = new THREE.Vector3()

/** The link the robot stands on from: the floating joint's child when it hangs from a bare `world` link (an MJCF free body). */
function baseLink(robot: URDFRobot): THREE.Object3D {
  const floating = Object.values(robot.joints || {}).find((j) => j.jointType === 'floating')
  return (floating?.children.find((c) => (c as { isURDFLink?: boolean }).isURDFLink) as THREE.Object3D | undefined) ?? robot
}

/** The meshes' bounding box in the file's own frame: the robot's own scale and turn (and any fix applied) left out. */
function fileBox(robot: URDFRobot): THREE.Box3 {
  robot.updateMatrixWorld(true)
  const toFile = new THREE.Matrix4().copy(robot.matrixWorld).invert()
  const box = new THREE.Box3()
  const m = new THREE.Matrix4()
  const part = new THREE.Box3()
  robot.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    box.union(part.copy(mesh.geometry.boundingBox as THREE.Box3).applyMatrix4(m.multiplyMatrices(toFile, mesh.matrixWorld)))
  })
  return box
}

/** A point of the robot in the file's own frame, after fileBox has updated the world matrices (getWorldPosition would climb the whole parent chain, too deep for a long chain of links). */
function filePoint(robot: URDFRobot, o: THREE.Object3D): THREE.Vector3 {
  return robot.worldToLocal(v.setFromMatrixPosition(o.matrixWorld))
}

/**
 * Looks at a robot whose meshes have loaded and says whether its file seems to be in millimetres or Y-up, or returns null.
 * Millimetres: over 20 m across, and 0.05 to 5 m at 1/1000. Y-up: taller along Y than along X and Z, with the links it
 * stands on well below its base along Y and not along Z. An arm's ground link is its base, so an arm is never taken as Y-up.
 */
export function checkUnits(robot: URDFRobot, groundContactLinks: string[]): UnitsOffer | null {
  const box = fileBox(robot)
  if (box.isEmpty()) return null
  const size = box.getSize(new THREE.Vector3())
  const across = Math.max(size.x, size.y, size.z)
  const scale = across > MM_OVER && across * 0.001 >= ROBOT_SIZE[0] && across * 0.001 <= ROBOT_SIZE[1] ? 0.001 : 1

  let upY: UnitsFix['upY'] = 0
  const base = baseLink(robot)
  const ground = groundContactLinks.map((n) => robot.links?.[n]).filter((l): l is NonNullable<typeof l> => !!l)
  if (ground.length > 0 && size.y > size.x && size.y > size.z) {
    const b = filePoint(robot, base).clone()
    const g = new THREE.Vector3()
    for (const l of ground) g.add(filePoint(robot, l))
    g.divideScalar(ground.length)
    const dy = b.y - g.y
    const dz = b.z - g.z
    if (Math.abs(dy) >= 0.3 * size.y && Math.abs(dy) > 2 * Math.abs(dz)) upY = dy > 0 ? 1 : -1
  }
  if (scale === 1 && upY === 0) return null

  const found: string[] = []
  if (scale !== 1) found.push(`is ${Math.round(across)} m across, so its file is probably in millimetres`)
  if (upY !== 0) found.push(`stands along its ${upY > 0 ? '' : 'minus '}Y axis, so its file is probably Y-up (robot files are Z-up)`)
  const doing = [scale !== 1 ? 'show it at 1/1000 scale' : '', upY !== 0 ? 'stand it up' : ''].filter(Boolean).join(' and ')
  return { fix: { scale, upY }, text: `This robot ${found.join(', and ')}. Fix: ${doing}.` }
}

/** Applies a fix on top of the robot's own scale and turn (the twin's Z-up to Y-up turn): Y-up is turned to Z-up first. */
export function applyUnitsFix(robot: URDFRobot, fix: UnitsFix): void {
  robot.scale.multiplyScalar(fix.scale)
  // +90° about X takes +Y to +Z; -90° takes -Y to +Z
  if (fix.upY !== 0) robot.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (fix.upY * Math.PI) / 2))
  robot.updateMatrixWorld(true)
}

// Fixes the user accepted, by profile id, so the robot comes back fixed when the view reloads (only for this page's life).
const accepted = new Map<string, UnitsFix>()
export const acceptUnitsFix = (profileId: string, fix: UnitsFix): void => void accepted.set(profileId, fix)
export const acceptedUnitsFix = (profileId: string): UnitsFix | undefined => accepted.get(profileId)
