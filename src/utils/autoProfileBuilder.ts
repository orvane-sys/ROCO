import * as THREE from 'three'
import type { URDFRobot } from 'urdf-loader'
import type { RobotProfile, RobotCategory, RobotGroup } from '../config/robotRegistry'
import { registerCustomRobotProfile } from '../config/robotRegistry'
import { MOTOR_COUNT } from './unitreeBinaryCodec'
import type { JointDefinition } from '../types/telemetry'

function formatJointName(id: string): string {
  return id
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bJoint\b/i, '')
    .trim()
}

function classifyJoint(id: string): { group: string; label: string; friendlyName: string } {
  const lower = id.toLowerCase()

  // Quadruped legs
  if (/^(fl|front_left)/.test(lower) || /front.*left/.test(lower)) {
    return { group: 'front_left', label: 'Front Left', friendlyName: formatJointName(id) }
  }
  if (/^(fr|front_right)/.test(lower) || /front.*right/.test(lower)) {
    return { group: 'front_right', label: 'Front Right', friendlyName: formatJointName(id) }
  }
  if (/^(rl|rear_left|hl|hind_left)/.test(lower) || /rear.*left/.test(lower)) {
    return { group: 'rear_left', label: 'Rear Left', friendlyName: formatJointName(id) }
  }
  if (/^(rr|rear_right|hr|hind_right)/.test(lower) || /rear.*right/.test(lower)) {
    return { group: 'rear_right', label: 'Rear Right', friendlyName: formatJointName(id) }
  }

  // Biped legs
  if (/(left.*(hip|knee|ankle|foot|leg)|l_hip|l_knee|l_ankle)/.test(lower)) {
    return { group: 'left_leg', label: 'Left Leg', friendlyName: formatJointName(id) }
  }
  if (/(right.*(hip|knee|ankle|foot|leg)|r_hip|r_knee|r_ankle)/.test(lower)) {
    return { group: 'right_leg', label: 'Right Leg', friendlyName: formatJointName(id) }
  }

  // Waist & Torso
  if (/(waist|torso|spine|pelvis|trunk)/.test(lower)) {
    return { group: 'waist', label: 'Waist & Torso', friendlyName: formatJointName(id) }
  }

  // Head & Neck
  if (/(head|neck)/.test(lower)) {
    return { group: 'head', label: 'Head & Neck', friendlyName: formatJointName(id) }
  }

  // Arms & Hands
  if (/(left.*(shoulder|elbow|wrist|arm)|l_shoulder|l_elbow|l_wrist|l_arm)/.test(lower)) {
    return { group: 'left_arm', label: 'Left Arm', friendlyName: formatJointName(id) }
  }
  if (/(right.*(shoulder|elbow|wrist|arm)|r_shoulder|r_elbow|r_wrist|r_arm)/.test(lower)) {
    return { group: 'right_arm', label: 'Right Arm', friendlyName: formatJointName(id) }
  }
  if (/(left.*(hand|finger|gripper|thumb)|l_hand|l_finger)/.test(lower)) {
    return { group: 'left_hand', label: 'Left Hand', friendlyName: formatJointName(id) }
  }
  if (/(right.*(hand|finger|gripper|thumb)|r_hand|r_finger)/.test(lower)) {
    return { group: 'right_hand', label: 'Right Hand', friendlyName: formatJointName(id) }
  }

  // Generic manipulator
  if (/(arm|joint_[0-9]|link_[0-9]|shoulder|elbow|wrist)/.test(lower)) {
    return { group: 'manipulator', label: 'Manipulator', friendlyName: formatJointName(id) }
  }

  return { group: 'actuators', label: 'Actuators', friendlyName: formatJointName(id) }
}

const isActuated = (jointType: string) => jointType === 'revolute' || jointType === 'continuous' || jointType === 'prismatic'

function categoryOf(groupIds: Set<string>): RobotCategory {
  if (groupIds.has('front_left') && groupIds.has('front_right')) return 'quadruped'
  if (groupIds.has('left_leg') && groupIds.has('right_leg')) return 'biped'
  return 'fixed_manipulator'
}

/** The category the profile will get, from the joint names alone: only a biped or quadruped needs its height measured. */
export function robotCategory(robot: URDFRobot): RobotCategory {
  return categoryOf(new Set(Object.entries(robot.joints || {}).filter(([, j]) => isActuated(j.jointType)).map(([id]) => classifyJoint(id).group)))
}

/**
 * Automatically inspects a parsed URDFRobot and builds a strongly-typed RobotProfile.
 * Classifies joints into anatomical groups, determines robot category, estimates
 * nominal pelvis height and ground contact links, and registers the profile in the registry.
 */
export function buildProfileFromParsedRobot(
  robot: URDFRobot,
  modelName: string,
  modelUrl: string,
  packages: Record<string, string> = {}
): RobotProfile {
  const jointEntries = Object.entries(robot.joints || {})
  const activeJoints = jointEntries.filter(([, joint]) => isActuated(joint.jointType))

  // The binary LowState_ frame has MOTOR_COUNT motor slots: joints past them get slot -1 and show no data (robotImporter reports
  // them), unless the bridge's motor names match them to a slot. A robot with no movable joints (a drone) is one rigid body.
  const groupMap = new Map<string, { label: string; count: number }>()
  const jointDefs: JointDefinition[] = []

  activeJoints.forEach(([id, joint], idx) => {
    const { group, label, friendlyName } = classifyJoint(id)

    if (!groupMap.has(group)) {
      groupMap.set(group, { label, count: 0 })
    }
    groupMap.get(group)!.count++

    const limit = joint.limit || { lower: -Math.PI, upper: Math.PI, effort: 100, velocity: 10 }
    const limitMin = Number.isFinite(limit.lower) ? limit.lower : -Math.PI
    const limitMax = Number.isFinite(limit.upper) ? limit.upper : Math.PI
    const maxEffort = Number.isFinite(limit.effort) && limit.effort > 0 ? limit.effort : 80
    // Rest pose = the URDF zero pose, clamped into the joint range. (The range midpoint is wrong for
    // asymmetric limits: e.g. a hip roll of -0.5…3.0 rad would rest at 70°, splaying the legs.)
    const defaultPos = Math.min(limitMax, Math.max(limitMin, 0))

    jointDefs.push({
      id,
      name: friendlyName,
      group,
      limitMin,
      limitMax,
      maxEffort,
      defaultPos,
      sdkMotorIndex: idx < MOTOR_COUNT ? idx : -1,
    })
  })

  // Detect category
  const category = categoryOf(new Set(jointDefs.map((j) => j.group)))

  // Standing height of the base: how far the root link's origin is above the robot's lowest point with every joint at zero.
  // URDF is Z-up and this robot is not turned into the scene yet. robotImporter loads the meshes of a biped's or quadruped's
  // lower links before this runs; without them link origins and primitive shapes give an ankle rather than a sole.
  // A robot hung from a bare `world` link by a floating joint (an MJCF free body) stands on the floating joint's child instead.
  robot.updateMatrixWorld(true)
  const floating = Object.values(robot.joints || {}).find((j) => j.jointType === 'floating')
  const base = (floating?.children.find((c) => (c as { isURDFLink?: boolean }).isURDFLink) as THREE.Object3D | undefined) ?? robot
  const box = new THREE.Box3().setFromObject(robot)
  const at = new THREE.Vector3()
  // from matrixWorld, updated above: getWorldPosition climbs the whole parent chain, too deep for a long chain of links
  for (const link of Object.values(robot.links || {})) if (link !== robot || base === robot) box.expandByPoint(at.setFromMatrixPosition(link.matrixWorld))
  const standing = at.setFromMatrixPosition(base.matrixWorld).z - box.min.z
  let nominalPelvisHeight = 0.5
  if (category === 'biped') {
    nominalPelvisHeight = Number.isFinite(standing) ? Number(standing.toFixed(3)) : 0.793
  } else if (category === 'quadruped') {
    nominalPelvisHeight = Number.isFinite(standing) ? Number(standing.toFixed(3)) : 0.4
  } else {
    nominalPelvisHeight = 0.45
  }

  // Detect ground contact links
  const groundContactLinks: string[] = []
  const linkNames = Object.keys(robot.links || {})
  for (const name of linkNames) {
    const l = name.toLowerCase()
    if (category === 'biped' && /(foot|sole|ankle_roll)/.test(l)) {
      groundContactLinks.push(name)
    } else if (category === 'quadruped' && /(foot|toe|calf|wheel)/.test(l)) {
      groundContactLinks.push(name)
    }
  }
  if (groundContactLinks.length === 0) {
    groundContactLinks.push(linkNames[0] || 'base_link')
  }

  const groups: RobotGroup[] = Array.from(groupMap.entries()).map(([id, { label }]) => ({
    id,
    label,
  }))

  const cleanName = modelName.replace(/\.[^.]+$/, '').replace(/_/g, ' ')
  const sanitizedId = `imported_${cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now().toString(36)}`

  const profile: RobotProfile = {
    id: sanitizedId,
    name: cleanName || 'Imported Robot',
    category,
    urdfPath: modelUrl,
    packages,
    nominalPelvisHeight,
    groundContactLinks,
    codecType: 'unitree_hg_2092',
    groups,
    joints: jointDefs,
    // idx above is only the place in the file: the bridge's motor names decide the real slot (src/utils/motorMatch.ts).
    // A robot with no movable joints has nothing to match, so no motor-order note anywhere.
    ...(jointDefs.length ? { motorOrder: 'fileOrder' as const } : {}),
  }

  registerCustomRobotProfile(profile)
  return profile
}

