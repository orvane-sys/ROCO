import type { RobotTelemetry, JointDefinition } from '../types/telemetry'
import { G1_29DOF_JOINTS } from '../types/telemetry'
import type { RobotProfile } from '../config/robotRegistry'
import { getModeMachineForProfile, MODE_MACHINE_G1_29DOF } from '../config/robotRegistry'

export const LOW_STATE_BYTE_LENGTH = 2092
export const LOW_CMD_BYTE_LENGTH = 1004
export const TELEOP_CMD_BYTE_LENGTH = 32
export const TELEOP_MAGIC = 0x524f434f // 'ROCO' in ASCII

export const CRC32_POLYNOMIAL = 0x04c11db7

// Byte offsets for LowState_ (size 2092)
export const OFFSET_VERSION_0 = 0
export const OFFSET_VERSION_1 = 4
export const OFFSET_MODE_PR = 8
export const OFFSET_MODE_MACHINE = 9
export const OFFSET_TICK = 12

// IMUState_ offsets (size 56 bytes, starts at 16)
export const OFFSET_IMU_STATE = 16
export const OFFSET_IMU_QUATERNION = 16 // 4 x float32 (16B)
export const OFFSET_IMU_GYROSCOPE = 32 // 3 x float32 (12B)
export const OFFSET_IMU_ACCELEROMETER = 44 // 3 x float32 (12B)
export const OFFSET_IMU_RPY = 56 // 3 x float32 (12B: roll, pitch, yaw)
export const OFFSET_IMU_TEMP = 68 // int16 (2B)

// MotorState_ array (35 motors, stride 56 bytes, starts at 72)
export const OFFSET_MOTOR_STATE_ARRAY = 72
export const MOTOR_STATE_STRIDE = 56
export const MOTOR_COUNT = 35
export const G1_NUM_JOINTS = 29

// Relative offsets inside MotorState_ (stride 56)
export const REL_MOTOR_MODE = 0 // uint8
export const REL_MOTOR_Q = 4 // float32
export const REL_MOTOR_DQ = 8 // float32
export const REL_MOTOR_DDQ = 12 // float32
export const REL_MOTOR_TAU_EST = 16 // float32
export const REL_MOTOR_TEMP_0 = 20 // int16 temperature[0], °C
export const REL_MOTOR_TEMP_1 = 22 // int16 temperature[1], °C
export const REL_MOTOR_VOL = 24 // float32
export const REL_MOTOR_SENSOR_0 = 28 // uint32
export const REL_MOTOR_SENSOR_1 = 32 // uint32
export const REL_MOTOR_MOTORSTATE = 36 // uint32
export const REL_MOTOR_RESERVE = 40 // uint32[4] (16B)

// Trailing fields in LowState_
export const OFFSET_WIRELESS_REMOTE = 2032 // uint8[40]
export const OFFSET_STATE_RESERVE = 2072 // uint32[4] (16B)
export const OFFSET_CRC = 2088 // uint32 (4B)

// Relative offsets inside MotorCmd_ (stride 28)
export const MOTOR_CMD_STRIDE = 28
export const REL_CMD_MODE = 0 // uint8
export const REL_CMD_Q = 4 // float32
export const REL_CMD_DQ = 8 // float32
export const REL_CMD_TAU = 12 // float32
export const REL_CMD_KP = 16 // float32
export const REL_CMD_KD = 20 // float32
export const REL_CMD_RESERVE = 24 // uint32

let teleopSeqCounter = 0

/**
 * Calculates Unitree standard 32-bit CRC (polynomial 0x04C11DB7, MSB-first per 32-bit word).
 */
export function calcCRC32(words: Uint32Array, wordCount?: number): number {
  let crc = 0xffffffff
  const count = wordCount !== undefined ? wordCount : words.length

  for (let i = 0; i < count; i++) {
    const w = words[i]
    let bit = 0x80000000
    for (let b = 0; b < 32; b++) {
      if ((crc & 0x80000000) !== 0) {
        crc = (((crc << 1) >>> 0) ^ CRC32_POLYNOMIAL) >>> 0
      } else {
        crc = (crc << 1) >>> 0
      }
      if ((w & bit) !== 0) {
        crc = (crc ^ CRC32_POLYNOMIAL) >>> 0
      }
      bit = bit >>> 1
    }
  }
  return crc >>> 0
}

/**
 * Decodes a binary Unitree G1 LowState_ frame (2092 bytes) into targetSnapshot.
 * Allocation-light: it writes into the existing snapshot (no per-joint or per-frame result objects).
 * The only per-call allocations are the DataView (and, when verifying, Uint32Array) views over the
 * incoming buffer, which a new ArrayBuffer per frame makes unavoidable.
 */
export function decodeLowState(
  buffer: ArrayBuffer,
  targetSnapshot: RobotTelemetry,
  verifyChecksum = false,
  profile?: RobotProfile
): boolean {
  if (buffer.byteLength < LOW_STATE_BYTE_LENGTH) {
    return false
  }

  const view = new DataView(buffer)

  // Verify CRC32 checksum over 522 32-bit words if requested
  if (verifyChecksum) {
    const u32Words = new Uint32Array(buffer, 0, (LOW_STATE_BYTE_LENGTH >> 2) - 1)
    const calculatedCrc = calcCRC32(u32Words)
    const packetCrc = view.getUint32(OFFSET_CRC, true)
    if (calculatedCrc !== packetCrc) {
      return false
    }
  }

  targetSnapshot.timestamp = Date.now()
  targetSnapshot.modeMachine = view.getUint8(OFFSET_MODE_MACHINE)
  targetSnapshot.tick = view.getUint32(OFFSET_TICK, true)

  // 1. Read IMU Euler RPY and angular rates
  const roll = view.getFloat32(OFFSET_IMU_RPY, true)
  const pitch = view.getFloat32(OFFSET_IMU_RPY + 4, true)
  const yaw = view.getFloat32(OFFSET_IMU_RPY + 8, true)
  const gz = view.getFloat32(OFFSET_IMU_GYROSCOPE + 8, true)

  const imu =
    targetSnapshot.imu ??
    (targetSnapshot.imu = { quaternion: [1, 0, 0, 0], gyroscope: [0, 0, 0], accelerometer: [0, 0, 0], temperature: 0 })
  for (let k = 0; k < 4; k++) imu.quaternion[k] = view.getFloat32(OFFSET_IMU_QUATERNION + 4 * k, true)
  for (let k = 0; k < 3; k++) {
    imu.gyroscope[k] = view.getFloat32(OFFSET_IMU_GYROSCOPE + 4 * k, true)
    imu.accelerometer[k] = view.getFloat32(OFFSET_IMU_ACCELEROMETER + 4 * k, true)
  }
  imu.temperature = view.getInt16(OFFSET_IMU_TEMP, true)

  if (!targetSnapshot.basePose) {
    targetSnapshot.basePose = {
      x: 0,
      y: 0,
      z: profile?.nominalPelvisHeight ?? 0.75,
      roll: 0,
      pitch: 0,
      yaw: 0,
    }
  }

  targetSnapshot.basePose.roll = roll
  targetSnapshot.basePose.pitch = pitch
  targetSnapshot.basePose.yaw = yaw

  // Read world translation from LowState_.reserve[0..2] if populated/bridged
  const resX = view.getFloat32(OFFSET_STATE_RESERVE, true)
  const resY = view.getFloat32(OFFSET_STATE_RESERVE + 4, true)
  const resZ = view.getFloat32(OFFSET_STATE_RESERVE + 8, true)

  if (
    Number.isFinite(resX) &&
    Number.isFinite(resY) &&
    Number.isFinite(resZ) &&
    (resX !== 0 || resY !== 0 || resZ !== 0)
  ) {
    targetSnapshot.basePose.x = resX
    targetSnapshot.basePose.y = resY
    targetSnapshot.basePose.z = resZ
  }

  // Yaw rate comes from the gyro. LowState_ carries no body linear velocity (gyro x/y are roll/pitch
  // RATES, not m/s), so linearVelocity is left to the caller instead of being faked from them.
  if (targetSnapshot.angularVelocity) targetSnapshot.angularVelocity.z = gz
  else targetSnapshot.angularVelocity = { z: gz }
  targetSnapshot.linearVelocityValid = false

  // 2. Decode joints from motor slots mapped by sdkMotorIndex
  ensureJointsArray(targetSnapshot, profile)
  const jointDefs = profile?.joints ?? G1_29DOF_JOINTS

  for (let i = 0; i < targetSnapshot.joints.length; i++) {
    const motorIdx = jointDefs[i]?.sdkMotorIndex ?? i
    if (motorIdx < 0 || motorIdx >= MOTOR_COUNT) continue

    const offset = OFFSET_MOTOR_STATE_ARRAY + motorIdx * MOTOR_STATE_STRIDE
    const q = view.getFloat32(offset + REL_MOTOR_Q, true)
    const dq = view.getFloat32(offset + REL_MOTOR_DQ, true)
    const tauEst = view.getFloat32(offset + REL_MOTOR_TAU_EST, true)
    const temp0 = view.getInt16(offset + REL_MOTOR_TEMP_0, true)
    const temp1 = view.getInt16(offset + REL_MOTOR_TEMP_1, true)

    const joint = targetSnapshot.joints[i]
    joint.position = q
    joint.velocity = dq
    joint.torque = tauEst
    joint.temperature = Math.max(temp0, temp1)
    joint.temp0 = temp0
    joint.temp1 = temp1
    joint.voltage = view.getFloat32(offset + REL_MOTOR_VOL, true)
    joint.motorState = view.getUint32(offset + REL_MOTOR_MOTORSTATE, true)
    joint.motorMode = view.getUint8(offset + REL_MOTOR_MODE)
  }

  return true
}

/**
 * Reads mode_machine (byte 9) directly from a 2092-byte LowState_ buffer without creating a snapshot.
 */
export function getLowStateModeMachine(buffer: ArrayBuffer): number {
  if (buffer.byteLength < 10) return 0
  const view = new DataView(buffer)
  return view.getUint8(OFFSET_MODE_MACHINE)
}

/**
 * Packs outgoing teleop velocity and E-Stop commands into a compact binary frame (32 bytes).
 */
export function encodeTeleopCmd(
  vx: number,
  vy: number,
  wz: number,
  eStop: boolean,
  modeMachine = 0
): ArrayBuffer {
  const buffer = new ArrayBuffer(TELEOP_CMD_BYTE_LENGTH)
  const view = new DataView(buffer)

  teleopSeqCounter = (teleopSeqCounter + 1) >>> 0

  view.setUint32(0, TELEOP_MAGIC, true) // Magic: 'ROCO'
  view.setUint32(4, teleopSeqCounter, true)
  view.setFloat32(8, vx, true)
  view.setFloat32(12, vy, true)
  view.setFloat32(16, wz, true)
  view.setUint8(20, eStop ? 1 : 0)
  view.setUint8(21, modeMachine & 0xff) // Profile mode_machine (Unitree: 4 = 23-DoF, 5 = 29-DoF)
  view.setUint16(22, 0, true) // Pad
  view.setFloat64(24, Date.now(), true) // Timestamp

  return buffer
}

/**
 * Unpacks a 32-byte ROCO teleop command frame.
 */
export function decodeTeleopCmd(buffer: ArrayBuffer): {
  seq: number
  vx: number
  vy: number
  wz: number
  eStop: boolean
  modeMachine: number
  timestamp: number
} | null {
  if (buffer.byteLength < TELEOP_CMD_BYTE_LENGTH) return null
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== TELEOP_MAGIC) return null
  return {
    seq: view.getUint32(4, true),
    vx: view.getFloat32(8, true),
    vy: view.getFloat32(12, true),
    wz: view.getFloat32(16, true),
    eStop: view.getUint8(20) !== 0,
    modeMachine: view.getUint8(21),
    timestamp: view.getFloat64(24, true),
  }
}

/**
 * Packs outgoing robot commands into an authentic Unitree LowCmd_ binary frame (1004 bytes) with CRC.
 */
export function encodeLowCmd(
  jointTargets?: { q: number; dq: number; kp: number; kd: number; tau: number }[]
): ArrayBuffer {
  const buffer = new ArrayBuffer(LOW_CMD_BYTE_LENGTH)
  const view = new DataView(buffer)

  view.setUint8(0, 0) // mode_pr
  view.setUint8(1, 0) // mode_machine

  if (jointTargets) {
    const count = Math.min(jointTargets.length, MOTOR_COUNT)
    for (let i = 0; i < count; i++) {
      const offset = 4 + i * MOTOR_CMD_STRIDE
      const cmd = jointTargets[i]
      view.setUint8(offset + REL_CMD_MODE, 1) // PMSM mode
      view.setFloat32(offset + REL_CMD_Q, cmd.q, true)
      view.setFloat32(offset + REL_CMD_DQ, cmd.dq, true)
      view.setFloat32(offset + REL_CMD_TAU, cmd.tau, true)
      view.setFloat32(offset + REL_CMD_KP, cmd.kp, true)
      view.setFloat32(offset + REL_CMD_KD, cmd.kd, true)
    }
  }

  // Calculate CRC for 250 32-bit words (1000 bytes)
  const words = new Uint32Array(buffer, 0, (LOW_CMD_BYTE_LENGTH >> 2) - 1)
  const crc = calcCRC32(words)
  view.setUint32(1000, crc, true)

  return buffer
}

/**
 * Creates an authentic 2092-byte Unitree LowState_ binary buffer from a RobotTelemetry snapshot.
 * Used for binary loopback testing and validation.
 */
export function createMockLowStateBuffer(
  telemetry: RobotTelemetry,
  tick = 0,
  profile?: RobotProfile
): ArrayBuffer {
  const buffer = new ArrayBuffer(LOW_STATE_BYTE_LENGTH)
  const view = new DataView(buffer)

  // 1. Header
  view.setUint32(OFFSET_VERSION_0, 1, true)
  view.setUint32(OFFSET_VERSION_1, 0, true)
  view.setUint8(OFFSET_MODE_PR, 0)
  view.setUint8(OFFSET_MODE_MACHINE, profile ? getModeMachineForProfile(profile) : MODE_MACHINE_G1_29DOF)
  view.setUint32(OFFSET_TICK, tick, true)

  // 2. IMUState_
  const pose = telemetry.basePose
  const roll = pose?.roll ?? 0
  const pitch = pose?.pitch ?? 0
  const yaw = pose?.yaw ?? 0

  // Standard Euler to quaternion conversion
  const cy = Math.cos(yaw * 0.5)
  const sy = Math.sin(yaw * 0.5)
  const cp = Math.cos(pitch * 0.5)
  const sp = Math.sin(pitch * 0.5)
  const cr = Math.cos(roll * 0.5)
  const sr = Math.sin(roll * 0.5)

  const qw = cr * cp * cy + sr * sp * sy
  const qx = sr * cp * cy - cr * sp * sy
  const qy = cr * sp * cy + sr * cp * sy
  const qz = cr * cp * sy - sr * sp * cy

  view.setFloat32(OFFSET_IMU_QUATERNION, qw, true)
  view.setFloat32(OFFSET_IMU_QUATERNION + 4, qx, true)
  view.setFloat32(OFFSET_IMU_QUATERNION + 8, qy, true)
  view.setFloat32(OFFSET_IMU_QUATERNION + 12, qz, true)

  view.setFloat32(OFFSET_IMU_GYROSCOPE, 0, true)
  view.setFloat32(OFFSET_IMU_GYROSCOPE + 4, 0, true)
  view.setFloat32(OFFSET_IMU_GYROSCOPE + 8, telemetry.angularVelocity?.z ?? 0, true)

  // Specific force of a body at constant velocity: gravity only (velocity is not an acceleration).
  view.setFloat32(OFFSET_IMU_ACCELEROMETER, 0, true)
  view.setFloat32(OFFSET_IMU_ACCELEROMETER + 4, 0, true)
  view.setFloat32(OFFSET_IMU_ACCELEROMETER + 8, 9.81, true)

  view.setFloat32(OFFSET_IMU_RPY, roll, true)
  view.setFloat32(OFFSET_IMU_RPY + 4, pitch, true)
  view.setFloat32(OFFSET_IMU_RPY + 8, yaw, true)

  view.setInt16(OFFSET_IMU_TEMP, 38, true)

  // 3. MotorState_ array (35 motors mapped by sdkMotorIndex)
  const jointDefs = profile?.joints ?? G1_29DOF_JOINTS
  const jointCount = Math.min(telemetry.joints.length, jointDefs.length)
  for (let i = 0; i < jointCount; i++) {
    const motorIdx = jointDefs[i]?.sdkMotorIndex ?? i
    if (motorIdx < 0 || motorIdx >= MOTOR_COUNT) continue

    const offset = OFFSET_MOTOR_STATE_ARRAY + motorIdx * MOTOR_STATE_STRIDE
    const joint = telemetry.joints[i]

    view.setUint8(offset + REL_MOTOR_MODE, 1) // PMSM mode active
    view.setFloat32(offset + REL_MOTOR_Q, joint.position, true)
    view.setFloat32(offset + REL_MOTOR_DQ, joint.velocity, true)
    view.setFloat32(offset + REL_MOTOR_DDQ, 0, true)
    view.setFloat32(offset + REL_MOTOR_TAU_EST, joint.torque, true)

    const temp = Math.round(joint.temperature)
    view.setInt16(offset + REL_MOTOR_TEMP_0, temp, true)
    view.setInt16(offset + REL_MOTOR_TEMP_1, Math.max(25, temp - 3), true)
    view.setFloat32(offset + REL_MOTOR_VOL, telemetry.batteryVoltage, true)
    view.setUint32(offset + REL_MOTOR_SENSOR_0, 1000 + i, true)
    view.setUint32(offset + REL_MOTOR_SENSOR_1, 2000 + i, true)
    view.setUint32(offset + REL_MOTOR_MOTORSTATE, 0, true)
  }

  // 4. Pack 6-DOF world position into reserve[0..2] (offsets 2072..2083) for loopback continuity
  if (telemetry.basePose) {
    view.setFloat32(OFFSET_STATE_RESERVE, telemetry.basePose.x, true)
    view.setFloat32(OFFSET_STATE_RESERVE + 4, telemetry.basePose.y, true)
    view.setFloat32(OFFSET_STATE_RESERVE + 8, telemetry.basePose.z, true)
  }

  // 5. Trailing CRC32 checksum over first 522 32-bit words
  const words = new Uint32Array(buffer, 0, (LOW_STATE_BYTE_LENGTH >> 2) - 1)
  const crc = calcCRC32(words)
  view.setUint32(OFFSET_CRC, crc, true)

  return buffer
}

/**
 * Ensures the pre-allocated joint telemetry array exists in targetSnapshot.
 */
function ensureJointsArray(snapshot: RobotTelemetry, profile?: RobotProfile): void {
  const jointDefs = profile?.joints ?? G1_29DOF_JOINTS
  if (!snapshot.joints || snapshot.joints.length !== jointDefs.length) {
    snapshot.joints = jointDefs.map((def: JointDefinition) => ({
      id: def.id,
      name: def.name,
      group: def.group,
      position: def.defaultPos,
      velocity: 0,
      torque: 0,
      temperature: 38.0,
      limitMin: def.limitMin,
      limitMax: def.limitMax,
      maxEffort: def.maxEffort,
    }))
  }
}
