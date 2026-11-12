// Checks how an imported robot's joints are tied to motor slots (src/utils/motorMatch.ts) and that the decoder leaves a joint with no
// motor (slot -1) alone, and that an imported file is told MJCF from URDF by its root element. Bundles the sources with rolldown
// in memory, like check-alerts.mjs.
//
//   node scripts/check-profiles.mjs
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = new URL('..', import.meta.url)
const path = (p) => fileURLToPath(new URL(p, root))
const load = async (input) => {
  const b = await rolldown({ input: path(input), logLevel: 'silent', transform: { define: { 'import.meta.env.BASE_URL': '"/"' } } })
  const { output } = await b.generate({ format: 'esm' })
  await b.close()
  return import('data:text/javascript;base64,' + Buffer.from(output[0].code).toString('base64'))
}
const m = await load('src/utils/motorMatch.ts')
const codec = await load('src/utils/unitreeBinaryCodec.ts')

let failed = 0
let passed = 0
function check(ok, what) {
  if (ok) passed++
  else {
    failed++
    console.error('FAIL: ' + what)
  }
}
const def = (id, i) => ({ id, name: id, group: 'g', limitMin: -1, limitMax: 1, maxEffort: 10, defaultPos: 0, sdkMotorIndex: i })
const NAMES = ['left_hip_joint', 'left_knee_joint', 'right_hip_joint', 'right_knee_joint']
const slots = (r) => r.joints.map((j) => j.sdkMotorIndex)

// same order as the bridge
let r = m.matchMotorSlots(NAMES.map(def), NAMES)
check(JSON.stringify(slots(r)) === '[0,1,2,3]' && !r.match.reordered && r.match.source === 'bridge', 'same order gives the identity mapping')
check(r.match.unmatchedJoints.length === 0 && r.match.unusedSlots.length === 0 && r.match.clashes.length === 0, 'same order: nothing unmatched, unused or clashing')

// the file lists the joints in another order
r = m.matchMotorSlots([...NAMES].reverse().map(def), NAMES)
check(JSON.stringify(slots(r)) === '[3,2,1,0]' && r.match.reordered, 'a reversed file is matched by name, not by place')

// case, punctuation and the _joint suffix do not matter
r = m.matchMotorSlots(['Left-Knee', 'RIGHT_HIP', 'left_hip', 'right_knee_joint'].map(def), NAMES)
check(JSON.stringify(slots(r)) === '[1,2,0,3]', 'case, punctuation and the _joint suffix are ignored')
check(m.matchMotorSlots([def('left_knee_joint', 0)], NAMES).joints[0].sdkMotorIndex === 1, 'an exact name wins over the place in the file')

// a joint the bridge does not have, and a motor no joint reads from
r = m.matchMotorSlots(['left_hip_joint', 'tail_joint', 'right_hip_joint'].map(def), NAMES)
check(JSON.stringify(slots(r)) === '[0,-1,2]' && r.match.unmatchedJoints[0] === 'tail_joint', 'a joint with no motor gets slot -1 and is listed')
check(JSON.stringify(r.match.unusedSlots) === '[1,3]', 'motors no joint reads from are listed')

// two joints for one motor: the first keeps it
r = m.matchMotorSlots([def('left_knee', 0), def('Left_Knee_Joint', 1)], NAMES)
check(JSON.stringify(slots(r)) === '[1,-1]' && r.match.clashes.length === 1, 'a motor goes to one joint only; the second is a clash and shows no data')

// no names: the file's order is kept, and the note says it was not checked
const plain = NAMES.map(def)
r = m.matchMotorSlots(plain, [])
check(r.joints === plain && r.match.source === 'fileOrder', 'without motor names the joints are returned as they are')
check(/not checked/i.test(m.motorOrderNote('fileOrder', r.match) ?? ''), 'note says the order was not checked')
check(/not checked/i.test(m.motorOrderNote('fileOrder', undefined) ?? ''), 'note says not checked before any hello')
check(m.motorOrderNote(undefined, undefined) === null && m.motorOrderNote('fixed', undefined) === null, 'a built-in robot gets no note')
r = m.matchMotorSlots(['left_hip_joint', 'tail_joint'].map(def), NAMES)
check(/1 joint is not in the bridge/.test(m.motorOrderNote('fileOrder', r.match)), 'note counts joints that have no motor')
check(/matched to motors by name/i.test(m.motorOrderNote('fileOrder', m.matchMotorSlots(NAMES.map(def), NAMES).match)), 'note says joints were matched by name')

// the decoder reads each joint from its slot and leaves a slot -1 joint at its rest values
const profile = { id: 'x', name: 'x', joints: [def('a', 2), def('b', -1), def('c', 0)] }
const buf = new ArrayBuffer(codec.LOW_STATE_BYTE_LENGTH)
const view = new DataView(buf)
for (let k = 0; k < codec.MOTOR_COUNT; k++) {
  view.setFloat32(codec.OFFSET_MOTOR_STATE_ARRAY + k * codec.MOTOR_STATE_STRIDE + codec.REL_MOTOR_Q, 0.1 * (k + 1), true)
}
const snap = {}
check(codec.decodeLowState(buf, snap, false, profile) === true, 'decoder accepts the frame')
const q = snap.joints.map((j) => Math.round(j.position * 10) / 10)
check(q[0] === 0.3 && q[2] === 0.1, 'decoder reads joints from their matched slots')
check(q[1] === 0, 'a joint with slot -1 keeps its rest position')

// an imported file is told MJCF from URDF by its root element (src/utils/modelFormatParser.ts isMuJoCoModel)
const fmt = await load('src/utils/modelFormatParser.ts')
const models = readdirSync(path('public/models/g1_description')).filter((f) => /\.(xml|urdf)$/.test(f))
check(models.some((f) => f.endsWith('.xml')) && models.some((f) => f.endsWith('.urdf')), 'the G1 models include both .xml and .urdf files')
for (const f of models) {
  const t = readFileSync(path('public/models/g1_description/' + f), 'utf8')
  check(fmt.isMuJoCoModel(t) === f.endsWith('.xml'), `${f} is read as ${f.endsWith('.xml') ? 'MJCF' : 'URDF (its embedded <mujoco> block is not the root)'}`)
}
const mjcf = {
  '﻿  \n<mujoco model="x">': 'a byte order mark and white space before the root',
  '<?xml version="1.0"?>\n<!-- a --><!-- b -->\n<!DOCTYPE mujoco>\n<!-- c -->\n<mujoco>': 'a declaration, comments and a DOCTYPE before the root',
  '<MuJoCo\tmodel="x">': 'the root in any case, followed by a tab',
}
for (const [t, what] of Object.entries(mjcf)) check(fmt.isMuJoCoModel(t), `MJCF: ${what}`)
const notMjcf = {
  '<!-- open <mujoco>': 'a comment that never closes',
  '<mujocoinclude>': 'a <mujocoinclude> root',
  '<!-- head -->\n<robot name="g1">\n<!-- ext -->\n<mujoco><compiler/></mujoco></robot>': 'a URDF that starts with a comment and has one before its <mujoco> block',
  '': 'an empty file',
}
for (const [t, what] of Object.entries(notMjcf)) check(!fmt.isMuJoCoModel(t), `not MJCF: ${what}`)
// a header of many comments once backtracked exponentially (24 repeats took about 3 s and froze the tab); the scan is linear
for (const n of [24, 100000]) {
  const t = '<!--' + '--><!--'.repeat(n) + 'x'
  const t0 = performance.now()
  const res = fmt.isMuJoCoModel(t)
  const ms = performance.now() - t0
  check(res === false && ms < (n === 24 ? 5 : 100), `a header of ${t.length} comment characters is read in ${ms.toFixed(2)} ms`)
}

console.log(`profiles: ${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
