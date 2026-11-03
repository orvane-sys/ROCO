import { G1_29DOF_JOINTS } from '../types/telemetry'
import type { RobotProfile } from '../config/robotRegistry'

/*
 * Kinematic walking-gait synthesizer for the Unitree G1 29-DOF, derived from g1_29dof.urdf.
 *
 * URDF conventions this relies on (verified against the file):
 *  - Robot faces +X, +Y is left, +Z is up.
 *  - Every pitch joint (hip/knee/ankle/shoulder/elbow) has axis (0 1 0): a positive angle
 *    swings the distal link BACKWARD. Hip flexion (leg forward) is therefore NEGATIVE hip
 *    pitch, knee flexion is POSITIVE, ankle dorsiflexion (toe up) is NEGATIVE.
 *  - Hip/ankle roll have axis (1 0 0): positive roll moves a down-pointing leg toward +Y (left).
 *  - The hip_roll origin rpy (-0.1749) and knee origin rpy (+0.1749) cancel, so with zero
 *    roll/yaw the hip-pitch → knee segment is a straight vertical 0.3366 m link and the
 *    knee → ankle-pitch segment is a straight vertical 0.3000 m link.
 */
const THIGH = 0.3366
const SHIN = 0.3
const MAX_REACH = 0.995 * (THIGH + SHIN)

/** Pelvis origin → hip-pitch axis (vertical) and ankle-pitch axis → sole (ankle roll offset + foot mesh). */
export const PELVIS_TO_HIP_Z = 0.1027
export const ANKLE_TO_SOLE_Z = 0.017558 + 0.0354

const DEFAULTS = new Map(G1_29DOF_JOINTS.map((j) => [j.id, j.defaultPos]))
const def = (id: string) => DEFAULTS.get(id) ?? 0

/** Ankle-pitch position relative to hip-pitch axis (x fwd, z up) for given hip/knee angles. */
function legFK(hip: number, knee: number): { x: number; z: number } {
  return {
    x: -THIGH * Math.sin(hip) - SHIN * Math.sin(hip + knee),
    z: -THIGH * Math.cos(hip) - SHIN * Math.cos(hip + knee),
  }
}

/** Sagittal 2-link IK (knee-forward branch). Inverse of legFK. */
function legIK(x: number, z: number): { hip: number; knee: number } {
  const r = Math.min(MAX_REACH, Math.max(Math.abs(THIGH - SHIN) + 1e-3, Math.hypot(x, z)))
  const clampCos = (v: number) => Math.min(1, Math.max(-1, v))
  const knee = Math.PI - Math.acos(clampCos((THIGH * THIGH + SHIN * SHIN - r * r) / (2 * THIGH * SHIN)))
  const alpha = Math.atan2(-x, -z)
  const beta = Math.acos(clampCos((THIGH * THIGH + r * r - SHIN * SHIN) / (2 * THIGH * r)))
  return { hip: alpha - beta, knee }
}

// The default standing crouch, expressed as an ankle target so IK reproduces defaultPos exactly.
const NOMINAL_ANKLE = legFK(def('left_hip_pitch_joint'), def('left_knee_joint'))

/** Standing pelvis height above the ground at the default crouch (~0.784 m). */
export const NOMINAL_PELVIS_HEIGHT = PELVIS_TO_HIP_Z - NOMINAL_ANKLE.z + ANKLE_TO_SOLE_Z

const STEP_HEIGHT = 0.07
const CROUCH_WHEN_WALKING = 0.02
const LATERAL_SWAY = 0.022

export interface GaitInput {
  /** Gait phase in radians; left leg uses phase, right leg phase + π. */
  phase: number
  /** Gait cycle period in seconds (one full left+right stride). */
  period: number
  /** 0 = standing still, 1 = full-speed gait. */
  blend: number
  /** Body-frame velocity command currently being tracked. */
  vx: number
  vy: number
  wz: number
  /** Current base attitude, compensated so stance feet stay flat on the ground. */
  basePitch: number
  baseRoll: number
}

export interface GaitOutput {
  joints: Record<string, number>
  /** Per-leg stance flag, useful for synthesizing load torques. */
  leftStance: boolean
  rightStance: boolean
  /** Pelvis height implied by the stance leg (informational; renderer ground-locks the feet). */
  pelvisHeight: number
}

interface FootTarget {
  along: number // -0.5 … +0.5 position along the stride (forward = +)
  lift: number // 0 … 1 swing clearance profile
  stance: boolean
}

/** 50 % duty-factor foot trajectory: linear stance sweep, cosine-eased swing with a sine lift arc. */
function footTrajectory(phase: number): FootTarget {
  const s = (((phase / (2 * Math.PI)) % 1) + 1) % 1
  if (s < 0.5) {
    return { along: 0.5 - s / 0.5, lift: 0, stance: true }
  }
  const u = (s - 0.5) / 0.5
  return { along: -0.5 + (1 - Math.cos(Math.PI * u)) / 2, lift: Math.sin(Math.PI * u), stance: false }
}

export function synthesizeG1Gait(input: GaitInput, profile?: RobotProfile): GaitOutput {
  const { phase, period, blend, vx, vy, wz, basePitch, baseRoll } = input

  // Fixed manipulator (upper-body torso): anchor base and articulate coordinated dual-arm gestures
  if (profile?.category === 'fixed_manipulator') {
    const joints: Record<string, number> = {}
    const defaultMap = new Map(profile.joints.map((j) => [j.id, j.defaultPos]))
    const pDef = (id: string) => defaultMap.get(id) ?? 0

    const reach = vx * 0.6
    const spread = vy * 0.4
    const twist = wz * 0.5
    const wave = Math.sin(phase) * 0.2 * Math.max(0.2, blend)

    joints.left_shoulder_pitch_joint = pDef('left_shoulder_pitch_joint') + reach + wave
    joints.left_shoulder_roll_joint = pDef('left_shoulder_roll_joint') + spread
    joints.left_shoulder_yaw_joint = pDef('left_shoulder_yaw_joint') + twist
    joints.left_elbow_joint = pDef('left_elbow_joint') + 0.5 * reach + 0.5 * wave
    joints.left_wrist_roll_joint = pDef('left_wrist_roll_joint') + twist
    joints.left_wrist_pitch_joint = pDef('left_wrist_pitch_joint') - 0.3 * reach
    joints.left_wrist_yaw_joint = pDef('left_wrist_yaw_joint') + twist

    joints.right_shoulder_pitch_joint = pDef('right_shoulder_pitch_joint') + reach - wave
    joints.right_shoulder_roll_joint = pDef('right_shoulder_roll_joint') - spread
    joints.right_shoulder_yaw_joint = pDef('right_shoulder_yaw_joint') - twist
    joints.right_elbow_joint = pDef('right_elbow_joint') + 0.5 * reach - 0.5 * wave
    joints.right_wrist_roll_joint = pDef('right_wrist_roll_joint') - twist
    joints.right_wrist_pitch_joint = pDef('right_wrist_pitch_joint') - 0.3 * reach
    joints.right_wrist_yaw_joint = pDef('right_wrist_yaw_joint') - twist

    return {
      joints,
      leftStance: true,
      rightStance: true,
      pelvisHeight: profile.nominalPelvisHeight,
    }
  }

  // Bipedal kinematics
  const validJointIds = profile ? new Set(profile.joints.map((j) => j.id)) : null
  const defaultMap = profile ? new Map(profile.joints.map((j) => [j.id, j.defaultPos])) : DEFAULTS
  const getDef = (id: string) => defaultMap.get(id) ?? def(id)

  // Foot displacement over one stance phase (half a cycle) at the commanded body velocity,
  // so planted feet move backward relative to the pelvis at exactly the base speed (no skating).
  const strideX = vx * (period / 2)
  const strideY = vy * (period / 2)
  const strideYaw = wz * (period / 2)

  const legHeight = -NOMINAL_ANKLE.z - CROUCH_WHEN_WALKING * blend
  // Pelvis shifts over the stance foot (left stance while sin(phase) > 0) → feet shift opposite.
  const sway = -LATERAL_SWAY * blend * Math.sin(phase)

  const cosP = Math.cos(-basePitch)
  const sinP = Math.sin(-basePitch)

  const rawJoints: Record<string, number> = {}

  const solveLeg = (side: 'left' | 'right', legPhase: number) => {
    const foot = footTrajectory(legPhase)
    const xLevel = NOMINAL_ANKLE.x + strideX * foot.along
    const zLevel = -legHeight + STEP_HEIGHT * blend * foot.lift
    // Rotate the gravity-aligned target into the (pitched) pelvis frame.
    const x = xLevel * cosP + zLevel * sinP
    const z = -xLevel * sinP + zLevel * cosP
    const { hip, knee } = legIK(x, z)

    const lateral = strideY * foot.along + sway
    const hipRoll = Math.atan2(lateral, legHeight) - baseRoll
    const toeUp = -0.12 * blend * foot.lift

    rawJoints[`${side}_hip_pitch_joint`] = hip
    rawJoints[`${side}_hip_roll_joint`] = getDef(`${side}_hip_roll_joint`) + hipRoll
    rawJoints[`${side}_hip_yaw_joint`] = getDef(`${side}_hip_yaw_joint`) + strideYaw * foot.along
    rawJoints[`${side}_knee_joint`] = knee
    // Keep the sole parallel to the ground: foot pitch in world = basePitch + hip + knee + ankle.
    rawJoints[`${side}_ankle_pitch_joint`] = -(basePitch + hip + knee) + toeUp
    rawJoints[`${side}_ankle_roll_joint`] = getDef(`${side}_ankle_roll_joint`) - (baseRoll + hipRoll)

    return { xLevel, stance: foot.stance }
  }

  const left = solveLeg('left', phase)
  const right = solveLeg('right', phase + Math.PI)

  // Contralateral arm swing: an arm swings back (positive shoulder pitch) as its same-side foot
  // swings forward. Elbow flexes a little more (smaller angle) as the arm comes forward.
  const leftArm = 1.6 * (left.xLevel - NOMINAL_ANKLE.x)
  const rightArm = 1.6 * (right.xLevel - NOMINAL_ANKLE.x)

  // Thorax counter-rotates against the pelvis (right shoulder forward when left foot forward).
  rawJoints.waist_yaw_joint = getDef('waist_yaw_joint') + 0.3 * (left.xLevel - right.xLevel)
  rawJoints.left_shoulder_pitch_joint = getDef('left_shoulder_pitch_joint') + leftArm
  rawJoints.right_shoulder_pitch_joint = getDef('right_shoulder_pitch_joint') + rightArm
  rawJoints.left_elbow_joint = getDef('left_elbow_joint') + 0.6 * leftArm
  rawJoints.right_elbow_joint = getDef('right_elbow_joint') + 0.6 * rightArm

  // Filter joints to only those present in the active profile
  const filteredJoints: Record<string, number> = {}
  for (const [k, v] of Object.entries(rawJoints)) {
    if (!validJointIds || validJointIds.has(k)) {
      filteredJoints[k] = v
    }
  }

  const nominalPelvis = profile?.nominalPelvisHeight ?? (PELVIS_TO_HIP_Z + legHeight + ANKLE_TO_SOLE_Z)
  return {
    joints: filteredJoints,
    leftStance: left.stance,
    rightStance: right.stance,
    pelvisHeight: nominalPelvis,
  }
}
