// Posing a robot by hand in the 3D view. Only the view changes: nothing here reaches the bridge socket or the robot.
// Posing is offered only while no live robot feed is on (poseAllowed); the 3D view stops it when one starts.
import type { ConnectionStatus } from '../types/telemetry'
import type { MonitorSource } from '../types/monitor'

export type PoseJointKind = 'revolute' | 'continuous' | 'prismatic'

/** One joint the user can move: its range in radians (revolute, continuous) or metres (prismatic). */
export interface PoseJoint {
  name: string
  kind: PoseJointKind
  lower: number
  upper: number
}

export interface ManualPose {
  profileId: string
  joints: readonly PoseJoint[]
  values: ReadonlyMap<string, number>
  /** Goes up on every change, so the render loop applies the pose only when it changed. */
  version: number
}

/** A continuous joint has no limits; its slider covers one turn. */
const TURN = Math.PI

let pose: ManualPose | null = null
let version = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const clamp = (j: PoseJoint, v: number) => Math.min(j.upper, Math.max(j.lower, v))

/** The joints of a loaded robot that can be posed: one-axis joints with a range, mimic joints left out (they follow their joint). */
export function posableJoints(joints: Record<string, { jointType: string; limit: { lower: number; upper: number }; type?: string }>): PoseJoint[] {
  const out: PoseJoint[] = []
  for (const [name, j] of Object.entries(joints)) {
    if (j.type === 'URDFMimicJoint') continue
    if (j.jointType === 'continuous') out.push({ name, kind: 'continuous', lower: -TURN, upper: TURN })
    else if ((j.jointType === 'revolute' || j.jointType === 'prismatic') && Number.isFinite(j.limit.lower) && Number.isFinite(j.limit.upper) && j.limit.upper > j.limit.lower)
      out.push({ name, kind: j.jointType, lower: j.limit.lower, upper: j.limit.upper })
  }
  return out
}

/** Starts posing from the given values (the view's current angles); a value outside a joint's range is brought inside it. */
export function startPose(profileId: string, joints: readonly PoseJoint[], values: ReadonlyMap<string, number>): void {
  const v = new Map<string, number>()
  for (const j of joints) v.set(j.name, clamp(j, values.get(j.name) ?? 0))
  pose = { profileId, joints, values: v, version: ++version }
  emit()
}

export function setPoseJoint(name: string, value: number): void {
  const j = pose?.joints.find((x) => x.name === name)
  if (!pose || !j || !Number.isFinite(value)) return
  pose = { ...pose, values: new Map(pose.values).set(name, clamp(j, value)), version: ++version }
  emit()
}

/** Every joint back to zero, or to the end of its range nearest zero. */
export function resetPose(): void {
  if (!pose) return
  pose = { ...pose, values: new Map(pose.joints.map((j) => [j.name, clamp(j, 0)])), version: ++version }
  emit()
}

export function stopPose(): void {
  if (!pose) return
  pose = null
  emit()
}

export function getPose(): ManualPose | null {
  return pose
}

export function subscribePose(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Posing is allowed only while no live robot feed is on: no bridge (disconnected, connecting), the sample recording, or a
 * bridge replaying a recording. A connected bridge that is not replaying (live sim or robot data, or one that has not said yet)
 * is live, so posing is not allowed.
 */
export function poseAllowed({ status, source, sample }: { status: ConnectionStatus; source: MonitorSource | null; sample: boolean }): boolean {
  if (sample) return true
  if (status === 'DISCONNECTED' || status === 'CONNECTING') return true
  return source === 'replay'
}
