import type { JointDefinition } from '../types/telemetry'

/**
 * Which motor slot each joint of an imported robot reads from. An imported file lists its joints in its own order, which need not
 * be the robot's motor order; the bridge sends the motor names in motor order (hello.limits.jointNames), so joints are matched by name.
 */
export interface MotorMatch {
  /** bridge: matched by the bridge's motor names. fileOrder: no names to match against, the file's order is used as it is. */
  source: 'bridge' | 'fileOrder'
  /** At least one joint reads from a different slot than its place in the file. */
  reordered: boolean
  /** Joints the bridge's motor list does not have (or that lost a clash). They show no data. */
  unmatchedJoints: string[]
  /** Motor slots no joint reads from. */
  unusedSlots: number[]
  /** Joints that matched a slot another joint had already taken. */
  clashes: string[]
}

/** Lower case, non-alphanumerics as `_`, without a trailing `_joint`: `Left-Knee_Joint` and `left_knee` are the same name. */
export function motorKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_joint$/, '')
}

/**
 * Gives every joint the slot of the motor with its name: exact name first, then the same name without case, punctuation and a
 * `_joint` suffix. A joint with no such motor gets -1 (the decoder skips negative slots, so it shows no data rather than another
 * motor's). A slot is given to one joint only; the first wins. With no names the joints are returned as they are.
 */
export function matchMotorSlots(
  joints: JointDefinition[],
  jointNames: readonly string[] | null | undefined,
): { joints: JointDefinition[]; match: MotorMatch } {
  if (!jointNames || jointNames.length === 0) {
    return { joints, match: { source: 'fileOrder', reordered: false, unmatchedJoints: [], unusedSlots: [], clashes: [] } }
  }
  const exact = new Map<string, number>()
  const loose = new Map<string, number>()
  jointNames.forEach((n, i) => {
    if (!exact.has(n)) exact.set(n, i)
    const k = motorKey(n)
    if (k && !loose.has(k)) loose.set(k, i)
  })
  const taken = new Set<number>()
  const unmatchedJoints: string[] = []
  const clashes: string[] = []
  let reordered = false
  const out = joints.map((j, place) => {
    const slot = exact.get(j.id) ?? loose.get(motorKey(j.id))
    if (slot === undefined) {
      unmatchedJoints.push(j.name)
      return { ...j, sdkMotorIndex: -1 }
    }
    if (taken.has(slot)) {
      clashes.push(j.name)
      unmatchedJoints.push(j.name)
      return { ...j, sdkMotorIndex: -1 }
    }
    taken.add(slot)
    if (slot !== place) reordered = true
    return { ...j, sdkMotorIndex: slot }
  })
  const unusedSlots = jointNames.map((_, i) => i).filter((i) => !taken.has(i))
  return { joints: out, match: { source: 'bridge', reordered, unmatchedJoints, unusedSlots, clashes } }
}

/** One line for the operator: how this imported robot's joints were tied to motors. Null for a robot with a fixed motor order. */
export function motorOrderNote(motorOrder: 'fixed' | 'fileOrder' | undefined, match: MotorMatch | undefined): string | null {
  if (motorOrder !== 'fileOrder') return null
  if (!match || match.source === 'fileOrder') {
    return 'Motor order not checked: joints follow the file’s order (first joint = motor 0) because the bridge sent no motor names.'
  }
  const n = match.unmatchedJoints.length
  if (n > 0) {
    return `${n} joint${n === 1 ? ' is' : 's are'} not in the bridge’s motor list and ${n === 1 ? 'shows' : 'show'} no data:${match.unmatchedJoints.slice(0, 4).join(', ')}${n > 4 ? ', …' : ''}.`
  }
  return match.reordered ? 'Joints matched to motors by name (the file’s order differs from the motor order).' : 'Joints matched to motors by name.'
}
