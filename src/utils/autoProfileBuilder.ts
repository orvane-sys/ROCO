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
  const activeJoints = jointEntries.filter(([, joint]) => {
    return (
      joint.jointType === 'revolute' ||
      joint.jointType === 'continuous' ||
      joint.jointType === 'prismatic'
    )
  })

  // The binary LowState_ frame has a fixed number of motor slots; extra joints would be dropped silently.
  if (activeJoints.length > MOTOR_COUNT) {
    throw new Error(
      `This robot has ${activeJoints.length} actuated joints, but the LowState_ protocol carries at most ${MOTOR_COUNT} motor slots. ` +
        `Remove or fix the extra joints (for example finger joints) and import again.`
    )
  }
  if (activeJoints.length === 0) {
    throw new Error('This robot description has no movable joints (revolute, continuous or prismatic).')
  }

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
      sdkMotorIndex: idx,
    })
  })

  // Detect category
  const groupIds = new Set(jointDefs.map((j) => j.group))
  let category: RobotCategory = 'fixed_manipulator'
  if (groupIds.has('front_left') && groupIds.has('front_right')) {
    category = 'quadruped'
  } else if (groupIds.has('left_leg') && groupIds.has('right_leg')) {
    category = 'biped'
  }

  // Calculate bounding box to estimate nominal base height
  const box = new THREE.Box3().setFromObject(robot)
  const height = box.max.y - box.min.y
  let nominalPelvisHeight = 0.5
  if (category === 'biped') {
    nominalPelvisHeight = Number.isFinite(height) && height > 0.2 ? Number((height * 0.55).toFixed(3)) : 0.793
  } else if (category === 'quadruped') {
    nominalPelvisHeight = Number.isFinite(height) && height > 0.2 ? Number((height * 0.8).toFixed(3)) : 0.4
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
  }

  registerCustomRobotProfile(profile)
  return profile
}

