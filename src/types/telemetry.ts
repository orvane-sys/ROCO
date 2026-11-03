export type JointGroup =
  | 'left_leg'
  | 'right_leg'
  | 'waist'
  | 'left_arm'
  | 'right_arm'

export interface JointDefinition {
  id: string
  name: string
  group: JointGroup | string
  limitMin: number
  limitMax: number
  maxEffort: number
  defaultPos: number
  sdkMotorIndex?: number
  /** Motor exists in the telemetry frame but is mechanically/firmware locked at defaultPos. */
  locked?: boolean
}

export interface JointState {
  id: string
  name: string
  group?: JointGroup | string
  position: number // radians
  velocity: number // rad/s
  torque: number // Nm
  temperature: number // Celsius
  limitMin?: number
  limitMax?: number
  maxEffort?: number
  // Raw LowState_ motor fields (binary bridges only)
  temp0?: number // temperature[0], °C
  temp1?: number // temperature[1], °C
  voltage?: number // V
  motorState?: number // fault bits; 0 = none
  motorMode?: number
  // Controller command and statistics (read-only DDS bridge `aux` frames only)
  qCmd?: number
  dqCmd?: number
  kp?: number
  kd?: number
  tauCmd?: number
  /** kp*(q_cmd-q)+kd*(dq_cmd-dq)+tau, Nm: what the PD loop asks of the motor. */
  pdDemand?: number
  /** Max |PD demand| over every sample since the previous aux frame. */
  pdDemandMax?: number
  /** Max |q_cmd - q| where kp > 0, same window, rad. */
  pdErrMax?: number
}

export interface ImuState {
  quaternion: [number, number, number, number] // w, x, y, z
  gyroscope: [number, number, number] // rad/s
  accelerometer: [number, number, number] // m/s²
  temperature: number
}

export type ConnectionStatus =
  | 'LIVE'
  | 'MOCK'
  | 'SAFETY_HALT'
  | 'DISCONNECTED'
  | 'CONNECTING'

/**
 * Floating-base (pelvis) pose in the ROS world/odom frame (REP-103):
 * +X forward, +Y left, +Z up. Angles are URDF/ROS fixed-axis RPY in radians,
 * i.e. R = Rz(yaw) · Ry(pitch) · Rx(roll). Positive pitch = nose down.
 */
export interface BasePose {
  x: number
  y: number
  z: number
  roll: number
  pitch: number
  yaw: number
}

export interface RobotTelemetry {
  timestamp: number
  joints: JointState[]
  batteryVoltage: number
  batteryPercentage: number
  pingLatency: number
  linearVelocity: { x: number; y: number }
  /**
   * False when the source cannot measure body linear velocity (a real LowState_ frame carries only IMU
   * rates), so the UI shows "n/a" instead of a misleading 0. Undefined means valid (JSON bridge, sim).
   */
  linearVelocityValid?: boolean
  angularVelocity: { z: number }
  basePose?: BasePose
  gaitBlend?: number
  emergencyStopped: boolean
  modeMachine?: number
  /** Binary frames only. */
  imu?: ImuState
  tick?: number
}

export interface VelocityCommand {
  vx: number
  vy: number
  vz: number
}

export interface TelemetryConfig {
  wsUrl: string
  heartbeatTimeoutMs: number
  mockFallbackDelayMs: number
}

export const G1_JOINT_GROUPS: { id: JointGroup; label: string; shortLabel: string; count: number }[] = [
  { id: 'left_leg', shortLabel: 'L Leg', label: 'Left Leg (6-DOF)', count: 6 },
  { id: 'right_leg', shortLabel: 'R Leg', label: 'Right Leg (6-DOF)', count: 6 },
  { id: 'waist', shortLabel: 'Waist', label: 'Waist (3-DOF)', count: 3 },
  { id: 'left_arm', shortLabel: 'L Arm', label: 'Left Arm (7-DOF)', count: 7 },
  { id: 'right_arm', shortLabel: 'R Arm', label: 'Right Arm (7-DOF)', count: 7 },
]

export const G1_29DOF_JOINTS: JointDefinition[] = [
  // Left Leg (6 DOF)
  {
    id: 'left_hip_pitch_joint',
    name: 'Left Hip Pitch',
    group: 'left_leg',
    limitMin: -2.53,
    limitMax: 2.88,
    maxEffort: 88,
    defaultPos: -0.16,
  },
  {
    id: 'left_hip_roll_joint',
    name: 'Left Hip Roll',
    group: 'left_leg',
    limitMin: -0.52,
    limitMax: 2.97,
    maxEffort: 88,
    defaultPos: 0.0,
  },
  {
    id: 'left_hip_yaw_joint',
    name: 'Left Hip Yaw',
    group: 'left_leg',
    limitMin: -2.76,
    limitMax: 2.76,
    maxEffort: 88,
    defaultPos: 0.0,
  },
  {
    id: 'left_knee_joint',
    name: 'Left Knee',
    group: 'left_leg',
    limitMin: -0.09,
    limitMax: 2.88,
    maxEffort: 139,
    defaultPos: 0.32,
  },
  {
    id: 'left_ankle_pitch_joint',
    name: 'Left Ankle Pitch',
    group: 'left_leg',
    limitMin: -0.87,
    limitMax: 0.52,
    maxEffort: 35,
    defaultPos: -0.16,
  },
  {
    id: 'left_ankle_roll_joint',
    name: 'Left Ankle Roll',
    group: 'left_leg',
    limitMin: -0.26,
    limitMax: 0.26,
    maxEffort: 35,
    defaultPos: 0.0,
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
  },
  {
    id: 'right_hip_roll_joint',
    name: 'Right Hip Roll',
    group: 'right_leg',
    limitMin: -2.97,
    limitMax: 0.52,
    maxEffort: 88,
    defaultPos: 0.0,
  },
  {
    id: 'right_hip_yaw_joint',
    name: 'Right Hip Yaw',
    group: 'right_leg',
    limitMin: -2.76,
    limitMax: 2.76,
    maxEffort: 88,
    defaultPos: 0.0,
  },
  {
    id: 'right_knee_joint',
    name: 'Right Knee',
    group: 'right_leg',
    limitMin: -0.09,
    limitMax: 2.88,
    maxEffort: 139,
    defaultPos: 0.32,
  },
  {
    id: 'right_ankle_pitch_joint',
    name: 'Right Ankle Pitch',
    group: 'right_leg',
    limitMin: -0.87,
    limitMax: 0.52,
    maxEffort: 35,
    defaultPos: -0.16,
  },
  {
    id: 'right_ankle_roll_joint',
    name: 'Right Ankle Roll',
    group: 'right_leg',
    limitMin: -0.26,
    limitMax: 0.26,
    maxEffort: 35,
    defaultPos: 0.0,
  },

  // Waist (3 DOF)
  {
    id: 'waist_yaw_joint',
    name: 'Waist Yaw',
    group: 'waist',
    limitMin: -2.62,
    limitMax: 2.62,
    maxEffort: 88,
    defaultPos: 0.0,
  },
  {
    id: 'waist_roll_joint',
    name: 'Waist Roll',
    group: 'waist',
    limitMin: -0.52,
    limitMax: 0.52,
    maxEffort: 35,
    defaultPos: 0.0,
  },
  {
    id: 'waist_pitch_joint',
    name: 'Waist Pitch',
    group: 'waist',
    limitMin: -0.52,
    limitMax: 0.52,
    maxEffort: 35,
    defaultPos: 0.0,
  },

  // Left Arm (7 DOF)
  {
    id: 'left_shoulder_pitch_joint',
    name: 'Left Shoulder Pitch',
    group: 'left_arm',
    limitMin: -3.09,
    limitMax: 2.67,
    maxEffort: 25,
    defaultPos: 0.2,
  },
  {
    id: 'left_shoulder_roll_joint',
    name: 'Left Shoulder Roll',
    group: 'left_arm',
    limitMin: -1.59,
    limitMax: 2.25,
    maxEffort: 25,
    defaultPos: 0.15,
  },
  {
    id: 'left_shoulder_yaw_joint',
    name: 'Left Shoulder Yaw',
    group: 'left_arm',
    limitMin: -2.62,
    limitMax: 2.62,
    maxEffort: 25,
    defaultPos: 0.0,
  },
  {
    id: 'left_elbow_joint',
    name: 'Left Elbow',
    group: 'left_arm',
    limitMin: -1.05,
    limitMax: 2.09,
    maxEffort: 25,
    defaultPos: 0.9,
  },
  {
    id: 'left_wrist_roll_joint',
    name: 'Left Wrist Roll',
    group: 'left_arm',
    limitMin: -1.97,
    limitMax: 1.97,
    maxEffort: 25,
    defaultPos: 0.0,
  },
  {
    id: 'left_wrist_pitch_joint',
    name: 'Left Wrist Pitch',
    group: 'left_arm',
    limitMin: -1.61,
    limitMax: 1.61,
    maxEffort: 5,
    defaultPos: 0.0,
  },
  {
    id: 'left_wrist_yaw_joint',
    name: 'Left Wrist Yaw',
    group: 'left_arm',
    limitMin: -1.61,
    limitMax: 1.61,
    maxEffort: 5,
    defaultPos: 0.0,
  },

  // Right Arm (7 DOF)
  {
    id: 'right_shoulder_pitch_joint',
    name: 'Right Shoulder Pitch',
    group: 'right_arm',
    limitMin: -3.09,
    limitMax: 2.67,
    maxEffort: 25,
    defaultPos: 0.2,
  },
  {
    id: 'right_shoulder_roll_joint',
    name: 'Right Shoulder Roll',
    group: 'right_arm',
    limitMin: -2.25,
    limitMax: 1.59,
    maxEffort: 25,
    defaultPos: -0.15,
  },
  {
    id: 'right_shoulder_yaw_joint',
    name: 'Right Shoulder Yaw',
    group: 'right_arm',
    limitMin: -2.62,
    limitMax: 2.62,
    maxEffort: 25,
    defaultPos: 0.0,
  },
  {
    id: 'right_elbow_joint',
    name: 'Right Elbow',
    group: 'right_arm',
    limitMin: -1.05,
    limitMax: 2.09,
    maxEffort: 25,
    defaultPos: 0.9,
  },
  {
    id: 'right_wrist_roll_joint',
    name: 'Right Wrist Roll',
    group: 'right_arm',
    limitMin: -1.97,
    limitMax: 1.97,
    maxEffort: 25,
    defaultPos: 0.0,
  },
  {
    id: 'right_wrist_pitch_joint',
    name: 'Right Wrist Pitch',
    group: 'right_arm',
    limitMin: -1.61,
    limitMax: 1.61,
    maxEffort: 5,
    defaultPos: 0.0,
  },
  {
    id: 'right_wrist_yaw_joint',
    name: 'Right Wrist Yaw',
    group: 'right_arm',
    limitMin: -1.61,
    limitMax: 1.61,
    maxEffort: 5,
    defaultPos: 0.0,
  },
]
