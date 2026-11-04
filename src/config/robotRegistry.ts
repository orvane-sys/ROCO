import type { MotorMatch } from '../utils/motorMatch'
import type { JointDefinition } from '../types/telemetry'

export type RobotCategory = 'biped' | 'quadruped' | 'fixed_manipulator'
export type CodecType = 'unitree_hg_2092' | 'generic_json'

export interface RobotGroup {
  id: string
  label: string
}

export interface RobotProfile {
  id: string
  name: string
  category: RobotCategory
  urdfPath: string
  mjcfPath?: string
  packages: Record<string, string>
  nominalPelvisHeight: number
  groundContactLinks: string[]
  codecType: CodecType
  /**
   * LowState_/LowCmd_ `mode_machine` byte that identifies this robot on the wire. Omitted for
   * imported robots, which have no hardware identity (they send 0 = "unspecified").
   */
  modeMachine?: number
  groups: RobotGroup[]
  joints: JointDefinition[]
  /**
   * fileOrder: an imported robot whose joints have no known motor slots, so they are matched by name to the bridge's motor list
   * (src/utils/motorMatch.ts). Unset: the joints carry their own slots (built-in robots) and are never remapped.
   */
  motorOrder?: 'fixed' | 'fileOrder'
  /** How the joints were matched to motors at the last bridge hello. Set with the active profile, never stored in the registry. */
  motorMatch?: MotorMatch
}

// Unitree's published G1 type codes: 4 = 23-DoF, 5 = 29-DoF, 6 = 29-DoF with the waist roll/pitch locked
// (Unitree lists it as "27-DoF"; confirmed as 6 on a real 29-DoF EDU with locked waist).
// The dual-arm torso has no Unitree code; 100 is a ROCO simulator-only value that cannot collide.
// KEEP IN SYNC with MODE_MACHINE_* in scripts/mujoco_roco_bridge.py.
export const MODE_MACHINE_G1_23DOF = 4
export const MODE_MACHINE_G1_29DOF = 5
export const MODE_MACHINE_G1_29DOF_WAIST_LOCKED = 6
export const MODE_MACHINE_ROCO_DUAL_ARM_SIM = 100

const URDF_ROOT = `${import.meta.env.BASE_URL}models/g1_description/`

// -----------------------------------------------------------------------------
// Canonical Joint Lists for G1 Variants
// -----------------------------------------------------------------------------

// Leg joints shared by 29-DOF and 23-DOF models
const G1_LEGS: JointDefinition[] = [
  // Left Leg (6 DOF)
  {
    id: 'left_hip_pitch_joint',
    name: 'Left Hip Pitch',
    group: 'left_leg',
    limitMin: -2.53,
    limitMax: 2.88,
    maxEffort: 88,
    defaultPos: -0.16,
    sdkMotorIndex: 0,
  },
  {
    id: 'left_hip_roll_joint',
    name: 'Left Hip Roll',
    group: 'left_leg',
    limitMin: -0.52,
    limitMax: 2.97,
    maxEffort: 88,
    defaultPos: 0.0,
    sdkMotorIndex: 1,
  },
  {
    id: 'left_hip_yaw_joint',
    name: 'Left Hip Yaw',
    group: 'left_leg',
    limitMin: -2.76,
    limitMax: 2.76,
    maxEffort: 88,
    defaultPos: 0.0,
    sdkMotorIndex: 2,
  },
  {
    id: 'left_knee_joint',
    name: 'Left Knee',
    group: 'left_leg',
    limitMin: -0.09,
    limitMax: 2.88,
    maxEffort: 139,
    defaultPos: 0.32,
    sdkMotorIndex: 3,
  },
  {
    id: 'left_ankle_pitch_joint',
    name: 'Left Ankle Pitch',
    group: 'left_leg',
    limitMin: -0.87,
    limitMax: 0.52,
    maxEffort: 35,
    defaultPos: -0.16,
    sdkMotorIndex: 4,
  },
  {
    id: 'left_ankle_roll_joint',
    name: 'Left Ankle Roll',
    group: 'left_leg',
    limitMin: -0.26,
    limitMax: 0.26,
    maxEffort: 35,
    defaultPos: 0.0,
    sdkMotorIndex: 5,
  },

  // Right Leg (6 DOF)
  {
    id: 'right_hip_pitch_joint',
    name: 'Right Hip Pitch',
    group: 'right_leg',
    limitMin: -2.53,
    limitMax: 2.88,
    maxEffort: 88,
    defaultPos: -0.16,
    sdkMotorIndex: 6,
  },
  {
    id: 'right_hip_roll_joint',
    name: 'Right Hip Roll',
    group: 'right_leg',
    limitMin: -2.97,
    limitMax: 0.52,
    maxEffort: 88,
    defaultPos: 0.0,
    sdkMotorIndex: 7,
  },
  {
    id: 'right_hip_yaw_joint',
    name: 'Right Hip Yaw',
    group: 'right_leg',
    limitMin: -2.76,
    limitMax: 2.76,
    maxEffort: 88,
    defaultPos: 0.0,
    sdkMotorIndex: 8,
  },
  {
    id: 'right_knee_joint',
    name: 'Right Knee',
    group: 'right_leg',
    limitMin: -0.09,
    limitMax: 2.88,
    maxEffort: 139,
    defaultPos: 0.32,
    sdkMotorIndex: 9,
  },
  {
    id: 'right_ankle_pitch_joint',
    name: 'Right Ankle Pitch',
    group: 'right_leg',
    limitMin: -0.87,
    limitMax: 0.52,
    maxEffort: 35,
    defaultPos: -0.16,
    sdkMotorIndex: 10,
  },
  {
    id: 'right_ankle_roll_joint',
    name: 'Right Ankle Roll',
    group: 'right_leg',
    limitMin: -0.26,
    limitMax: 0.26,
    maxEffort: 35,
    defaultPos: 0.0,
    sdkMotorIndex: 11,
  },
]

// 7-DOF Left Arm (Pitch, Roll, Yaw, Elbow, Wrist Roll, Wrist Pitch, Wrist Yaw)
const G1_LEFT_ARM_7DOF: JointDefinition[] = [
  {
    id: 'left_shoulder_pitch_joint',
    name: 'Left Shoulder Pitch',
    group: 'left_arm',
    limitMin: -3.09,
    limitMax: 2.67,
    maxEffort: 25,
    defaultPos: 0.2,
    sdkMotorIndex: 15,
  },
  {
    id: 'left_shoulder_roll_joint',
    name: 'Left Shoulder Roll',
    group: 'left_arm',
    limitMin: -1.59,
    limitMax: 2.25,
    maxEffort: 25,
    defaultPos: 0.15,
    sdkMotorIndex: 16,
  },
  {
    id: 'left_shoulder_yaw_joint',
    name: 'Left Shoulder Yaw',
    group: 'left_arm',
    limitMin: -2.62,
    limitMax: 2.62,
    maxEffort: 25,
    defaultPos: 0.0,
    sdkMotorIndex: 17,
  },
  {
    id: 'left_elbow_joint',
    name: 'Left Elbow',
    group: 'left_arm',
    limitMin: -1.05,
    limitMax: 2.09,
    maxEffort: 25,
    defaultPos: 0.9,
    sdkMotorIndex: 18,
  },
  {
    id: 'left_wrist_roll_joint',
    name: 'Left Wrist Roll',
    group: 'left_arm',
    limitMin: -1.97,
    limitMax: 1.97,
    maxEffort: 25,
    defaultPos: 0.0,
    sdkMotorIndex: 19,
  },
  {
    id: 'left_wrist_pitch_joint',
    name: 'Left Wrist Pitch',
    group: 'left_arm',
    limitMin: -1.61,
    limitMax: 1.61,
    maxEffort: 5,
    defaultPos: 0.0,
    sdkMotorIndex: 20,
  },
  {
    id: 'left_wrist_yaw_joint',
    name: 'Left Wrist Yaw',
    group: 'left_arm',
    limitMin: -1.61,
    limitMax: 1.61,
    maxEffort: 5,
    defaultPos: 0.0,
    sdkMotorIndex: 21,
  },
]

// 7-DOF Right Arm (Pitch, Roll, Yaw, Elbow, Wrist Roll, Wrist Pitch, Wrist Yaw)
const G1_RIGHT_ARM_7DOF: JointDefinition[] = [
  {
    id: 'right_shoulder_pitch_joint',
    name: 'Right Shoulder Pitch',
    group: 'right_arm',
    limitMin: -3.09,
    limitMax: 2.67,
    maxEffort: 25,
    defaultPos: 0.2,
    sdkMotorIndex: 22,
  },
  {
    id: 'right_shoulder_roll_joint',
    name: 'Right Shoulder Roll',
    group: 'right_arm',
    limitMin: -2.25,
    limitMax: 1.59,
    maxEffort: 25,
    defaultPos: -0.15,
    sdkMotorIndex: 23,
  },
  {
    id: 'right_shoulder_yaw_joint',
    name: 'Right Shoulder Yaw',
    group: 'right_arm',
    limitMin: -2.62,
    limitMax: 2.62,
    maxEffort: 25,
    defaultPos: 0.0,
    sdkMotorIndex: 24,
  },
  {
    id: 'right_elbow_joint',
    name: 'Right Elbow',
    group: 'right_arm',
    limitMin: -1.05,
    limitMax: 2.09,
    maxEffort: 25,
    defaultPos: 0.9,
    sdkMotorIndex: 25,
  },
  {
    id: 'right_wrist_roll_joint',
    name: 'Right Wrist Roll',
    group: 'right_arm',
    limitMin: -1.97,
    limitMax: 1.97,
    maxEffort: 25,
    defaultPos: 0.0,
    sdkMotorIndex: 26,
  },
  {
    id: 'right_wrist_pitch_joint',
    name: 'Right Wrist Pitch',
    group: 'right_arm',
    limitMin: -1.61,
    limitMax: 1.61,
    maxEffort: 5,
    defaultPos: 0.0,
    sdkMotorIndex: 27,
  },
  {
    id: 'right_wrist_yaw_joint',
    name: 'Right Wrist Yaw',
    group: 'right_arm',
    limitMin: -1.61,
    limitMax: 1.61,
    maxEffort: 5,
    defaultPos: 0.0,
    sdkMotorIndex: 28,
  },
]

// -----------------------------------------------------------------------------
// Robot Profiles
// -----------------------------------------------------------------------------

export const G1_29DOF_PROFILE: RobotProfile = {
  id: 'g1_29dof',
  name: 'Unitree G1 (29-DOF)',
  category: 'biped',
  urdfPath: `${URDF_ROOT}g1_29dof.urdf`,
  modeMachine: MODE_MACHINE_G1_29DOF,
  mjcfPath: `${URDF_ROOT}g1_29dof.xml`,
  packages: { g1_description: URDF_ROOT, '': URDF_ROOT },
  nominalPelvisHeight: 0.793,
  groundContactLinks: ['left_ankle_roll_link', 'right_ankle_roll_link'],
  codecType: 'unitree_hg_2092',
  groups: [
    { id: 'left_leg', label: 'Left Leg' },
    { id: 'right_leg', label: 'Right Leg' },
    { id: 'waist', label: 'Waist' },
    { id: 'left_arm', label: 'Left Arm' },
    { id: 'right_arm', label: 'Right Arm' },
  ],
  joints: [
    ...G1_LEGS,
    // Waist (3 DOF)
    {
      id: 'waist_yaw_joint',
      name: 'Waist Yaw',
      group: 'waist',
      limitMin: -2.62,
      limitMax: 2.62,
      maxEffort: 88,
      defaultPos: 0.0,
      sdkMotorIndex: 12,
    },
    {
      id: 'waist_roll_joint',
      name: 'Waist Roll',
      group: 'waist',
      limitMin: -0.52,
      limitMax: 0.52,
      maxEffort: 35,
      defaultPos: 0.0,
      sdkMotorIndex: 13,
    },
    {
      id: 'waist_pitch_joint',
      name: 'Waist Pitch',
      group: 'waist',
      limitMin: -0.52,
      limitMax: 0.52,
      maxEffort: 35,
      defaultPos: 0.0,
      sdkMotorIndex: 14,
    },
    ...G1_LEFT_ARM_7DOF,
    ...G1_RIGHT_ARM_7DOF,
  ],
}

// Type-6 torque limits that differ from the public g1_29dof.urdf (Nm), from actuatorfrcrange in
// unitree_rl_mjlab deploy_lock/sim/g1/g1_29dof_type6.xml. Each ankle joint is driven by two 5020 motors
// (24.8 Nm peak each), hence 50. A bridge `hello` frame overrides these at runtime.
const G1_TYPE6_EFFORT: Record<string, number> = {
  left_hip_roll_joint: 139,
  right_hip_roll_joint: 139,
  left_ankle_pitch_joint: 50,
  left_ankle_roll_joint: 50,
  right_ankle_pitch_joint: 50,
  right_ankle_roll_joint: 50,
  waist_roll_joint: 50,
  waist_pitch_joint: 50,
}

/**
 * 29-DoF EDU with the waist roll and pitch locked (mode_machine 6). Same body, URDF and 29 motor
 * slots as the free-waist model; the two locked joints keep reporting but their readings are invalid.
 * Any end-effector payload is not modelled: wrist joints stay.
 */
export const G1_29DOF_WAIST_LOCKED_PROFILE: RobotProfile = {
  ...G1_29DOF_PROFILE,
  id: 'g1_29dof_waist_locked',
  name: 'Unitree G1 (29-DOF, waist locked)',
  modeMachine: MODE_MACHINE_G1_29DOF_WAIST_LOCKED,
  joints: G1_29DOF_PROFILE.joints.map((j) => ({
    ...j,
    maxEffort: G1_TYPE6_EFFORT[j.id] ?? j.maxEffort,
    ...(j.id === 'waist_roll_joint' || j.id === 'waist_pitch_joint' ? { locked: true } : {}),
  })),
}

export const G1_23DOF_PROFILE: RobotProfile = {
  id: 'g1_23dof',
  name: 'Unitree G1 (23-DOF)',
  category: 'biped',
  urdfPath: `${URDF_ROOT}g1_23dof.urdf`,
  modeMachine: MODE_MACHINE_G1_23DOF,
  mjcfPath: `${URDF_ROOT}g1_23dof.xml`,
  packages: { g1_description: URDF_ROOT, '': URDF_ROOT },
  nominalPelvisHeight: 0.793,
  groundContactLinks: ['left_ankle_roll_link', 'right_ankle_roll_link'],
  codecType: 'unitree_hg_2092',
  groups: [
    { id: 'left_leg', label: 'Left Leg' },
    { id: 'right_leg', label: 'Right Leg' },
    { id: 'waist', label: 'Waist' },
    { id: 'left_arm', label: 'Left Arm' },
    { id: 'right_arm', label: 'Right Arm' },
  ],
  joints: [
    ...G1_LEGS,
    // Waist (1 DOF only)
    {
      id: 'waist_yaw_joint',
      name: 'Waist Yaw',
      group: 'waist',
      limitMin: -2.62,
      limitMax: 2.62,
      maxEffort: 88,
      defaultPos: 0.0,
      sdkMotorIndex: 12,
    },
    // Left Arm (5 DOF: no wrist pitch/yaw)
    ...G1_LEFT_ARM_7DOF.slice(0, 5),
    // Right Arm (5 DOF: no wrist pitch/yaw)
    ...G1_RIGHT_ARM_7DOF.slice(0, 5),
  ],
}

export const G1_DUAL_ARM_PROFILE: RobotProfile = {
  id: 'g1_dual_arm',
  name: 'Unitree G1 Dual-Arm Torso (14-DOF)',
  category: 'fixed_manipulator',
  urdfPath: `${URDF_ROOT}g1_dual_arm.urdf`,
  modeMachine: MODE_MACHINE_ROCO_DUAL_ARM_SIM,
  mjcfPath: `${URDF_ROOT}g1_dual_arm.xml`,
  packages: { g1_description: URDF_ROOT, '': URDF_ROOT },
  nominalPelvisHeight: 0.45,
  groundContactLinks: ['waist_yaw_link', 'waist_support_link', 'torso_link'],
  codecType: 'unitree_hg_2092',
  groups: [
    { id: 'left_arm', label: 'Left Arm (7 DOF)' },
    { id: 'right_arm', label: 'Right Arm (7 DOF)' },
  ],
  joints: [
    // Left Arm (7 DOF)
    ...G1_LEFT_ARM_7DOF,
    // Right Arm (7 DOF)
    ...G1_RIGHT_ARM_7DOF,
  ],
}

// -----------------------------------------------------------------------------
// Global Registry Store
// -----------------------------------------------------------------------------
const registry = new Map<string, RobotProfile>([
  [G1_29DOF_PROFILE.id, G1_29DOF_PROFILE],
  [G1_29DOF_WAIST_LOCKED_PROFILE.id, G1_29DOF_WAIST_LOCKED_PROFILE],
  [G1_23DOF_PROFILE.id, G1_23DOF_PROFILE],
  [G1_DUAL_ARM_PROFILE.id, G1_DUAL_ARM_PROFILE],
])

export function getRobotProfile(id: string): RobotProfile {
  return registry.get(id) ?? G1_29DOF_PROFILE
}

export function getAllRobotProfiles(): RobotProfile[] {
  return Array.from(registry.values())
}

export function registerCustomRobotProfile(profile: RobotProfile): void {
  registry.set(profile.id, profile)
}

/** Removes an imported profile. Built-in profiles (those with a hardware mode_machine) cannot be removed. */
export function unregisterRobotProfile(id: string): boolean {
  const profile = registry.get(id)
  if (!profile || profile.modeMachine !== undefined) return false
  return registry.delete(id)
}

/**
 * True when the mock simulator has a hand-authored gait for this robot (the built-in G1 variants).
 * Imported robots only get base odometry; their joints hold the rest pose.
 */
export function hasGaitModel(profile: RobotProfile): boolean {
  return profile.modeMachine !== undefined
}

/** Wire `mode_machine` for a profile; 0 means "unspecified" (imported robots), which a bridge ignores. */
export function getModeMachineForProfile(profile: RobotProfile): number {
  return profile.modeMachine ?? 0
}

/**
 * Maps a reported `mode_machine` to a registered profile id. Returns null for 0 (not yet reported)
 * and for values no profile claims; callers must not switch profiles on an unknown value.
 */
export function getProfileIdByModeMachine(modeMachine: number): string | null {
  if (!modeMachine) return null
  for (const prof of registry.values()) {
    if (prof.modeMachine === modeMachine) return prof.id
  }
  return null
}
