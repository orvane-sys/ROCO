// Checks the guided-check logic that a screenshot cannot show: the procedure data is well formed, every rule judges what the
// manual says it should, a person can confirm a check but never over a stop, and a simulator figure is never shown as the
// real robot's. It bundles the procedure data and src/utils/procedureModel.ts with rolldown (already installed for vite)
// and runs them in memory, so it needs no new package and writes no file.
//
//   node scripts/check-procedures.mjs
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = new URL('..', import.meta.url)
const path = (p) => fileURLToPath(new URL(p, root))

async function bundle(input) {
  const b = await rolldown({ input: path(input), logLevel: 'silent' })
  const { output } = await b.generate({ format: 'esm' })
  await b.close()
  return import('data:text/javascript;base64,' + Buffer.from(output[0].code).toString('base64'))
}
const data = await bundle('src/config/procedures/g1_type6.ts')
const model = await bundle('src/utils/procedureModel.ts')
const { PROCEDURES, MANUAL_SHA256 } = data
const { evaluateItem, evaluateProcedure, manualStatus, referencesFor, suggestStage, NO_OPS } = model

let failed = 0
let passed = 0
function check(ok, what) {
  if (ok) passed++
  else {
    failed++
    console.error('FAIL: ' + what)
  }
}

// -- the data ---------------------------------------------------------------------------------------------------------------
const AUTO = new Set(['startTemps', 'startMotorstate', 'policyInterval', 'first2s', 'segment', 'squatLean', 'legSpeed', 'lowcmdRate', 'lowstateGap', 'squatCount'])
check(PROCEDURES.length >= 2, 'at least two procedures (the real test and the simulator rehearsal)')
const procIds = new Set()
for (const proc of PROCEDURES) {
  check(!procIds.has(proc.id), `unique procedure id ${proc.id}`)
  procIds.add(proc.id)
  check(/^[0-9a-f]{64}$/.test(proc.manual.sha256), `${proc.id}: manual hash is a SHA-256`)
  check(proc.stages.length > 0, `${proc.id}: has stages`)
  const stageIds = new Set()
  const itemIds = new Set()
  for (const stage of proc.stages) {
    check(!stageIds.has(stage.id), `${proc.id}: unique stage id ${stage.id}`)
    stageIds.add(stage.id)
    check(stage.items.length > 0, `${proc.id}/${stage.id}: has items`)
    for (const it of stage.items) {
      const where = `${proc.id}/${stage.id}/${it.id}`
      check(!itemIds.has(it.id), `${where}: item id is unique in the procedure`)
      itemIds.add(it.id)
      check(typeof it.text === 'string' && it.text.length > 3, `${where}: has text`)
      check(/^§/.test(it.ref), `${where}: ref starts with §`)
      check(['auto', 'log', 'manual'].includes(it.kind), `${where}: known kind`)
      if (it.kind === 'auto') check(it.auto && AUTO.has(it.auto.type), `${where}: auto item has a known rule`)
      if (it.kind === 'log') check(it.log && (it.log.seen || it.log.stop || it.log.stopLevels?.length || it.log.okWhenNone), `${where}: log item has a rule`)
      if (it.kind === 'manual') check(!it.auto && !it.log, `${where}: manual item has no rule`)
      if (it.refs) check(Boolean(it.refs.sim || it.refs.real), `${where}: refs carry a sim or real value`)
    }
  }
}

// the hash the procedure was written for must be the manual's, while the manual is on this machine
const deployDir = process.env.ROCO_DEPLOY_DIR || `${homedir()}/unitree_rl_mjlab/deploy_lock`
const manualPath = process.env.ROCO_MANUAL || `${deployDir}/TEST_MANUAL.md`
if (existsSync(manualPath)) {
  const actual = createHash('sha256').update(readFileSync(manualPath)).digest('hex')
  check(actual === MANUAL_SHA256, `MANUAL_SHA256 matches ${manualPath} (is ${actual}). Read the manual's diff, update the items, then the hash`)
} else console.log(`note: ${manualPath} not found, so the manual hash was not compared`)

// -- fixtures ---------------------------------------------------------------------------------------------------------------
const ev = (t, text, extra = {}) => ({ t, level: 'info', text, ...extra })
const seg = (name, extra = {}) => ({
  name, t0: 100, durS: 5, ankPitchDemandMax: 0, ankPitchDemandPct: 0, overMs: 0, overRunMs: 0, tauAnkP: 0, tauAnkR: 0, tauKnee: 0,
  legErrMaxDeg: 0, legDqMax: 0, tiltDeg: [0, 0], gyroMax: 0, samples: 100, ...extra,
})
function mk({ source = 'sim', events = [], state = 'Passive', segments = [], segment = null, link = null, manual } = {}) {
  const hello = { source, limits: { states: ['Passive', 'FixStand', 'Velocity', 'squat'] } }
  if (manual !== undefined) hello.manual = manual
  return {
    hello,
    aux: link ? { t: 1000, link } : { t: 1000, link: null },
    fsm: { state, since: 0, events: [ev(50, 'Config: g1_ctrl.yaml', { session: true }), ...events], segments, segment },
    replay: null,
    alertLog: [],
  }
}
const G1 = PROCEDURES.find((p) => p.id === 'g1_type6')
const SIM = PROCEDURES.find((p) => p.id === 'g1_type6_sim')
const item = (id) => {
  for (const p of PROCEDURES) for (const s of p.stages) for (const i of s.items) if (i.id === id) return i
  throw new Error('no item ' + id)
}
const ev1 = (id, state, ops = NO_OPS) => evaluateItem(item(id), state, ops)
const ops = (o = {}) => ({ ...NO_OPS, ticked: new Set(o.ticked ?? []), skipped: new Set(o.skipped ?? []), confirmed: new Set(o.confirmed ?? []), done: new Set(o.done ?? []) })

// -- log items --------------------------------------------------------------------------------------------------------------
check(ev1('t0-reports-6', mk()).status === 'pending', 'log "robot reports 6": waiting with no lines')
check(ev1('t0-reports-6', mk({ events: [ev(60, 'Robot type: config mode_machine 6, robot reports 6 (0 = simulator); locked joints: 13,14')] })).status === 'ok', 'robot reports 6 is seen')
check(ev1('t0-reports-6', mk({ events: [ev(60, 'Robot type: config mode_machine 6, robot reports 5 (0 = simulator); locked joints: 13,14')] })).status === 'stop', 'robot reports 5 is a stop')
check(ev1('t0-reports-6', mk({ events: [ev(60, 'Robot type: config mode_machine 6, robot reports 0 (0 = simulator)')] })).status === 'stop', 'robot reports 0 is a stop (not 6)')
check(ev1('t0-locked', mk({ events: [ev(60, 'locked joints: 13,14')] })).status === 'ok', 'locked joints 13,14 seen')
check(ev1('t0-locked', mk({ events: [ev(60, 'locked joints: 13')] })).status === 'pending', 'locked joints 13 alone does not pass')
const bare = mk()
bare.fsm.events = []
check(ev1('t0-no-critical', bare).status === 'pending', 'no-critical: cannot say with no lines')
check(ev1('t0-no-critical', mk({ events: [ev(60, 'hello')] })).status === 'ok', 'no-critical: ok once lines exist and none is critical')
check(ev1('t0-no-critical', mk({ events: [ev(60, 'hello'), ev(61, 'Refusing to start: x', { level: 'critical' })] })).status === 'stop', 'Refusing to start is a stop')
check(ev1('t0-no-critical', mk({ events: [ev(60, 'something', { level: 'critical' })] })).status === 'stop', 'a critical line is a stop')
check(ev1('t1-log-p', mk({ events: [ev(60, "FSM: keyboard abort 'p' -> Passive", { level: 'warning' })] })).status === 'ok', "keyboard abort 'p' seen is ok for the check that wants it")
check(ev1('t4-n-refused', mk({ events: [ev(60, 'FSM: robot did not stand still on loaded feet within 6.0s, request cancelled (x need >= 1.5)', { level: 'warning' })] })).status === 'ok', 'request cancelled seen')
// only the latest run counts
const old = [ev(10, 'Config: old', { session: true }), ev(11, 'locked joints: 13,14'), ev(40, 'Config: new', { session: true })]
const twoRuns = { ...mk(), fsm: { ...mk().fsm, events: old } }
check(ev1('t0-locked', twoRuns).status === 'pending', 'a line from the previous run does not count')

// -- auto items -------------------------------------------------------------------------------------------------------------
const temps = (maxC, motors = 29) => ev(60, 'Safety: motor temperatures at start', { health: { kind: 'startTemps', maxC, motors } })
check(ev1('t0-temps', mk()).status === 'pending', 'start temps: waiting without the line')
check(ev1('t0-temps', mk({ events: [temps(41)] })).status === 'ok', 'start temps 41 is ok')
check(ev1('t0-temps', mk({ events: [temps(59)] })).status === 'ok', 'start temps 59 is ok')
check(ev1('t0-temps', mk({ events: [temps(60)] })).status === 'stop', 'start temps 60 is a stop (at or above)')
check(ev1('t0-temps', mk({ events: [temps(0)], source: 'sim' })).status === 'ok', 'start temps 0 is fine in the simulator')
check(ev1('t0-temps', mk({ events: [temps(0)], source: 'robot' })).status === 'stop', 'start temps all 0 on the real robot is a stop')
check(ev1('t0-temps', mk({ events: [temps(null)] })).status === 'check', 'start temps with no readings needs a look')
const ms = (nonzero) => ev(61, 'Safety: motorstate at start', { health: { kind: 'startMotorstate', nonzero, motors: 29 } })
check(ev1('t0-motorstate', mk({ events: [ms([])] })).status === 'ok', 'motorstate all 0 is ok')
check(ev1('t0-motorstate', mk({ events: [ms([3, 4])] })).status === 'check', 'motorstate non-zero asks for a look, not a stop')
const lowcmd = (hz) => ({ lowcmdHz: hz, lowstateHz: 500, lowstateCount: 100, lowstateGapMaxMs: 3 })
check(ev1('t0-one-sender', mk({ link: lowcmd(0) })).status === 'pending', 'lowcmd rate: nothing yet at 0 Hz')
check(ev1('t0-one-sender', mk({ link: lowcmd(500) })).status === 'ok', 'lowcmd 500 Hz is ok')
check(ev1('t0-one-sender', mk({ link: lowcmd(1500) })).status === 'ok', 'lowcmd exactly 1500 Hz is not over the limit')
check(ev1('t0-one-sender', mk({ link: lowcmd(1501) })).status === 'stop', 'lowcmd 1501 Hz is a stop (a second sender)')
const first2 = (state, legs, arms, sl, sa) => ev(70, `first 2s in ${state}`, { health: { kind: 'first2s', state, cmdStepLegs: legs, cmdStepArms: arms, speedLegs: sl, speedArms: sa } })
check(ev1('t2-step', mk({ events: [first2('FixStand', 0.4, 0.2, 0.3, 0.2)] })).status === 'ok', 'FixStand step 0.4 is ok')
check(ev1('t2-step', mk({ events: [first2('FixStand', 0.4, 1.2, 0.3, 0.2)] })).status === 'stop', 'FixStand arm step 1.2 is a stop (legs and arms)')
check(ev1('t2-speed', mk({ events: [first2('FixStand', 0.4, 0.2, 0.3, 1.5)] })).status === 'stop', 'FixStand arm speed 1.5 is a stop')
check(ev1('t2-step', mk({ events: [first2('Velocity', 5, 5, 5, 5)] })).status === 'pending', 'a first-2s line of another state does not count')
check(ev1('t4-step', mk({ events: [first2('Velocity', 2.9, 9, 1, 9)] })).status === 'ok', 'Velocity judges the legs only (arms ignored)')
check(ev1('t4-step', mk({ events: [first2('Velocity', 3.1, 0, 1, 0)] })).status === 'stop', 'Velocity leg step 3.1 is a stop')
check(ev1('t6-speed', mk({ events: [first2('squat', 1, 0, 2.5, 0)] })).status === 'stop', 'squat leg speed 2.5 is a stop')
const timing = (ms, policy = 'Velocity') => ev(80, `${policy} policy timing`, { health: { kind: 'policyTiming', policy, steps: 100, firstMs: 3, intervalMaxMs: ms } })
check(ev1('t4-interval', mk()).status === 'pending', 'policy interval: waiting')
check(ev1('t4-interval', mk({ events: [timing(20), timing(50)] })).status === 'ok', 'interval 50 ms is not over the limit')
check(ev1('t4-interval', mk({ events: [timing(20), timing(50.5)] })).status === 'stop', 'interval 50.5 ms is a stop')
check(ev1('t4-interval', mk({ events: [timing(20, 'squat'), timing(60, 'squat')] })).detail.includes('squat'), 'interval detail names the policy')

const velocitySeg = (extra) => seg('Velocity', extra)
check(ev1('t5-ankle', mk()).status === 'pending', 'ankle torque: no visit yet')
check(ev1('t5-ankle', mk({ segments: [velocitySeg({ tauAnkP: 1.5 })] })).status === 'ok', 'ankle 1.5 Nm ok on a visit')
check(ev1('t5-ankle', mk({ segments: [velocitySeg({ tauAnkP: 15.5 })] })).status === 'stop', 'ankle 15.5 Nm is a stop')
check(ev1('t5-ankle', mk({ segments: [velocitySeg({ tauAnkP: 1 })], state: 'Velocity', segment: seg('Velocity', { tauAnkP: 16 }) })).status === 'stop', 'the visit in progress counts')
check(ev1('t5-ankle', mk({ segments: [velocitySeg({ tauAnkP: 99, t0: 10 })] })).status === 'pending', 'a visit before this run does not count')
check(ev1('t5-knee', mk({ segments: [velocitySeg({ tauKnee: 25 })] })).status === 'ok', 'knee exactly 25 is not over')
check(ev1('t5-knee', mk({ segments: [velocitySeg({ tauKnee: 26 })] })).status === 'stop', 'knee 26 Nm is a stop')
check(ev1('t6-knee', mk({ segments: [seg('squat', { tauKnee: 44 })] })).status === 'ok', 'squat knee 44 ok')
check(ev1('t6-knee', mk({ segments: [seg('squat', { tauKnee: 46 })] })).status === 'stop', 'squat knee 46 is a stop')
check(ev1('t6-ankle', mk({ segments: [seg('squat', { tauAnkP: 16 })] })).status === 'stop', 'squat ankle 16 is a stop')
check(ev1('t6-lean', mk({ segments: [seg('squat', { tiltDeg: [1, 12.5] })] })).status === 'ok', 'lean 12.5 ok')
check(ev1('t6-lean', mk({ segments: [seg('squat', { tiltDeg: [1, 14] })] })).status === 'check', 'lean 14 asks for a look')
check(ev1('t6-lean', mk({ segments: [seg('squat', { tiltDeg: [1, 16] })] })).status === 'stop', 'lean 16 is a stop')
check(ev1('t7-gap', mk({ link: { ...lowcmd(500), lowstateGapMaxMs: 10 } })).status === 'ok', 'gap 10 ms ok')
check(ev1('t7-gap', mk({ link: { ...lowcmd(500), lowstateGapMaxMs: 120 } })).status === 'check', 'gap 120 ms asks for a look')
check(ev1('t7-gap', mk({ link: { ...lowcmd(500), lowstateGapMaxMs: 150 } })).status === 'stop', 'gap 150 ms is a stop')
check(ev1('t7-gap', mk({ link: { ...lowcmd(500), lowstateCount: 0 } })).status === 'pending', 'gap: no lowstate yet')
check(ev1('t7-legspeed', mk({ segments: [velocitySeg({ legDqMax: 4 })] })).status === 'ok', 'leg speed 4 ok')
check(ev1('t7-legspeed', mk({ segments: [seg('Velocity', { legDqMax: 15 })] })).status === 'stop', 'leg speed 15 is a stop (15 or more)')
check(ev1('t7-legspeed', mk({ segments: [seg('Passive', { legDqMax: 30 })] })).status === 'pending', 'Passive is not counted for leg speed')
const squats = (n) => Array.from({ length: n }, () => seg('squat'))
check(ev1('t8-count', mk({ segments: squats(5) })).status === 'ok', '5 squats ok')
check(ev1('t8-count', mk({ segments: squats(6) })).status === 'check', '6 squats asks for a look, not a stop')
check(ev1('t8-count', mk()).status === 'pending', 'no squat yet')
// after a replay seek the bridge's visits start at the seek: the verdicts say so, and say nothing different otherwise
const replayed = (statsFrom, extra = {}) => ({ ...mk(extra), replay: { file: 'f', store: 's', t0: 1000, t1: 1300, t: 1200, statsFrom, speed: 1, playing: false, ended: false, indexing: false, busy: null, speeds: [1] } })
check(ev1('t8-count', mk()).detail === 'No squat in this run yet.', 'live, no squat: the usual wording')
check(ev1('t8-count', replayed(1000)).detail === 'No squat in this run yet.', 'a recording played from its start: the usual wording')
check(ev1('t8-count', replayed(undefined)).detail === 'No squat in this run yet.', 'an older bridge (no statsFrom): the usual wording')
check(ev1('t8-count', replayed(1000.4)).detail === 'No squat in this run yet.', 'a seek to within 0.5 s of the start counts as the start')
check(ev1('t8-count', replayed(1063)).detail === 'No squat since 63.0 s (the recording was started there).', 'a seeked recording, no squat: says since when')
check(ev1('t8-count', replayed(1063, { segments: squats(2) })).detail === '2 of about 5 squats since 63.0 s (the recording was started there).', 'a seeked recording: the squat count says since when')
check(ev1('t6-knee', replayed(1063)).detail === 'No squat visit since 63.0 s (the recording was started there).', 'a seeked recording: the knee peak says since when')
check(ev1('t6-knee', replayed(1063, { segments: [seg('squat', { tauKnee: 30 })] })).detail.endsWith('(max over both sides) since 63.0 s (the recording was started there).'), 'a seeked recording: a peak says since when')
check(ev1('t6-lean', replayed(1063)).detail === 'No squat since 63.0 s (the recording was started there).', 'a seeked recording: the lean says since when')
check(ev1('t6-lean', replayed(1063, { segments: [seg('squat', { tiltDeg: [1, 14] })] })).detail.includes('“much more” since 63.0 s'), 'a seeked recording: the lean check wording keeps its sentence')
check(ev1('t6-lean', replayed(1000, { segments: [seg('squat', { tiltDeg: [1, 14] })] })).detail.endsWith('“much more”.'), 'a recording from its start: the lean check wording is unchanged')

// -- manual items, skip, confirm --------------------------------------------------------------------------------------------
check(ev1('pre-rope', mk()).status === 'pending', 'manual item is not ticked by default')
check(ev1('pre-rope', mk(), ops({ ticked: ['pre-rope'] })).status === 'ok', 'manual item ticked')
check(ev1('pre-rope', mk(), ops({ ticked: ['pre-rope'] })).word === 'Ticked', 'ticked word')
check(ev1('pre-rope', mk(), ops({ skipped: ['pre-rope'] })).status === 'skipped', 'manual item skipped')
check(ev1('t5-ankle', mk(), ops({ confirmed: ['t5-ankle'] })).status === 'ok', 'a pending auto item can be confirmed by hand')
check(ev1('t5-ankle', mk(), ops({ confirmed: ['t5-ankle'] })).byYou, 'confirmed item says it was you')
check(ev1('t5-ankle', mk(), ops({ confirmed: ['t5-ankle'] })).word === 'Checked by you', 'confirmed word')
check(ev1('t6-lean', mk({ segments: [seg('squat', { tiltDeg: [0, 14] })] }), ops({ confirmed: ['t6-lean'] })).status === 'ok', 'a check can be confirmed by hand')
check(ev1('t5-ankle', mk({ segments: [velocitySeg({ tauAnkP: 20 })] }), ops({ confirmed: ['t5-ankle'] })).status === 'stop', 'a stop is never confirmed away')
check(ev1('t5-ankle', mk({ segments: [velocitySeg({ tauAnkP: 20 })] }), ops({ skipped: ['t5-ankle'] })).status === 'stop', 'a stop is never hidden by Not applicable')
check(ev1('t5-ankle', mk({ segments: [velocitySeg({ tauAnkP: 5 })] }), ops({ skipped: ['t5-ankle'] })).status === 'skipped', 'a skipped item inside its limit stays skipped')
check(ev1('t0-reports-6', mk(), ops({ ticked: ['t0-reports-6'] })).status === 'pending', 'ticking cannot confirm an auto/log item')
const words = new Set()
for (const p of PROCEDURES) for (const s of p.stages) for (const i of s.items) for (const st of ['ok', 'stop', 'check', 'pending', 'skipped'])
  words.add(model.statusWord(i.kind, st, false, i.log))
check([...words].every((w) => w && w.length > 2), 'every status has a word')
check(!words.has('Safe') && !words.has('Ready') && !words.has('Pass'), 'no status says safe, ready or pass')

// -- procedure level --------------------------------------------------------------------------------------------------------
const bad = mk({ state: 'Velocity', segments: [velocitySeg({ tauAnkP: 20 }), seg('squat', { tauKnee: 50 })] })
const res = evaluateProcedure(G1, bad, NO_OPS)
check(res.stages.length === G1.stages.length, 'a result for every stage')
check(res.counts.total === G1.stages.flatMap((s) => s.items).length, 'total counts every item')
const sum = (c) => c.ok + c.stop + c.check + c.pending + c.skipped
check(sum(res.counts) === res.counts.total, 'counts add up to the total')
check(res.counts.stop === 2, `two stops overall (got ${res.counts.stop})`)
const t5 = res.stages.find((s) => s.stage.id === 'T5')
check(t5.matchesState, 'T5 covers Velocity')
check(res.stages.filter((x) => x.counts.stop > 0).map((x) => x.stage.id).join() === 'T5,T6', 'the stops are counted in the stage they belong to (T5 and T6)')
check(res.stages.find((x) => x.stage.id === 'T0').counts.stop === 0, 'a stage without a stop shows none')
const done = evaluateProcedure(G1, mk({ state: 'FixStand' }), ops({ done: ['T2'] }))
check(done.stages.find((s) => s.stage.id === 'T2').done, 'done flag from the operator')
check(suggestStage(done, 'FixStand')?.stage.id !== 'T2' || done.stages.filter((s) => s.matchesState).every((s) => s.done), 'a done stage is not suggested while another fits')
check(suggestStage(done, null) === null, 'no suggestion without a state')
check(suggestStage(evaluateProcedure(G1, mk({ state: 'Velocity' }), NO_OPS), 'Velocity')?.stage.id === 'T4', 'Velocity suggests the first stage that covers it')
const skippedAll = evaluateProcedure(SIM, mk(), ops({ skipped: SIM.stages.flatMap((s) => s.items.map((i) => i.id)) }))
check(skippedAll.counts.total === 0 && skippedAll.counts.skipped > 0, 'skipped items leave the "N of M" total')

// -- references by source ---------------------------------------------------------------------------------------------------
const refs = { sim: 'about 6 to 7.5 Nm', real: 'left 1 to 1.2 Nm' }
const lab = (s) => referencesFor(refs, s).map((r) => `${r.label}:${r.text}`)
check(lab('sim').length === 1 && lab('sim')[0].startsWith('Simulator:'), 'sim shows the simulator value only')
check(!lab('sim').join().includes('1.2'), 'sim never shows the real value')
check(lab('robot').length === 1 && lab('robot')[0].startsWith('Real robot:') && lab('robot')[0].includes('1.2'), 'robot shows the real value only')
check(!lab('robot').join().includes('7.5'), 'robot never shows the simulator value')
check(lab('replay').length === 2, 'replay shows both, labelled')
check(lab(null).length === 2, 'unknown source shows both, labelled')
const simOnly = referencesFor({ sim: 'about 6 to 7.5 Nm' }, 'robot')
check(simOnly.length === 1 && !simOnly[0].text.includes('7.5'), 'robot with only a sim figure says there is no real reference and hides the figure')
check(referencesFor({ real: 'x' }, 'sim').length === 0, 'sim with only a real figure shows nothing')
check(referencesFor(undefined, 'sim').length === 0, 'no refs: nothing')
// the manual's two ankle numbers must never end up in the same label
const ankle = item('t5-ankle')
check(Boolean(ankle.refs?.sim) && Boolean(ankle.refs?.real), 'T5 ankle carries both a sim and a real reference')
check(!referencesFor(ankle.refs, 'robot').some((r) => /7\.5/.test(r.text)), 'T5 ankle on the robot does not show the simulator figure')
check(!referencesFor(ankle.refs, 'sim').some((r) => /2026/.test(r.text)), 'T5 ankle in the sim does not show the real-robot figure')

// -- the manual hash --------------------------------------------------------------------------------------------------------
const hashOf = (m) => manualStatus(G1, mk({ manual: m })).status
check(hashOf({ file: 'TEST_MANUAL.md', sha256: G1.manual.sha256, bytes: 1 }) === 'match', 'same hash matches')
check(hashOf({ file: 'TEST_MANUAL.md', sha256: '0'.repeat(64), bytes: 1 }) === 'changed', 'a different hash is changed')
check(hashOf(null) === 'missing', 'a null manual is missing')
check(hashOf(undefined) === 'unknown', 'an older bridge (no field) is unknown')
check(manualStatus(G1, { ...mk(), hello: null }).status === 'unknown', 'no hello is unknown')

// -- what the operator did (procedureStore) ---------------------------------------------------------------------------------
// localStorage is a plain object here; each load below is a fresh copy of the module, as after a page reload
const memory = new Map()
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => void memory.set(k, String(v)),
  removeItem: (k) => void memory.delete(k),
}
async function loadStore(n) {
  const b = await rolldown({ input: path('src/services/procedureStore.ts'), logLevel: 'silent' })
  const { output } = await b.generate({ format: 'esm' })
  await b.close()
  return import('data:text/javascript;base64,' + Buffer.from(output[0].code + `\n//load ${n}`).toString('base64'))
}
const KEY = 'roco.proc.v1'
let st = await loadStore(1)
let live = st.procedureStore('live')
check(live.get().procedure === 'g1_type6' && Object.keys(live.get().byProc).length === 0, 'a fresh store starts empty on the first procedure')
live.toggleTick('g1_type6', 'pre-rope')
live.toggleSkip('g1_type6', 'pre-wifi')
live.toggleConfirm('g1_type6', 't5-ankle')
live.toggleDone('g1_type6', 'Before')
live.setStage('g1_type6', 'T5')
live.setProcedure('g1_type6_sim')
check(memory.has(KEY), 'live choices are written to localStorage')
check(JSON.parse(memory.get(KEY)).day === new Date().toLocaleDateString('sv'), 'the stored choices carry today as a local-day stamp')
const dOf = (store, id) => st.procDataOf(store.get(), id)
let d = dOf(live, 'g1_type6')
check(d.ticked.join() === 'pre-rope' && d.skipped.join() === 'pre-wifi' && d.confirmed.join() === 't5-ankle' && d.done.join() === 'Before' && d.stage === 'T5', 'tick, skip, confirm, done and stage are kept')
live.toggleTick('g1_type6', 'pre-rope')
check(dOf(live, 'g1_type6').ticked.length === 0, 'ticking again unticks')
live.toggleTick('g1_type6', 'pre-rope')
const replay = st.procedureStore('replay')
const before = memory.get(KEY)
replay.toggleTick('g1_type6', 'pre-battery')
check(dOf(replay, 'g1_type6').ticked.join() === 'pre-battery', 'the replay scope keeps its ticks in memory')
check(memory.get(KEY) === before, 'the replay scope never writes to localStorage')
check(dOf(live, 'g1_type6').ticked.join() === 'pre-rope', 'replay ticks do not reach the live scope')
replay.reset()
check(dOf(replay, 'g1_type6').ticked.length === 0, 'a new recording clears the replay ticks')
let seen = 0
const un = live.subscribe(() => seen++)
live.toggleTick('g1_type6', 'pre-battery')
un()
live.toggleTick('g1_type6', 'pre-battery')
check(seen === 1, 'subscribers hear one change per action, and none after unsubscribing')
live.setStage('g1_type6', 'T5')
const n0 = seen
live.setProcedure('g1_type6_sim')
check(seen === n0, 'setting what is already set changes nothing')
live.setProcedure('nonsense')
check(live.get().procedure === 'g1_type6_sim', 'an unknown procedure id is ignored')
live.clear('g1_type6')
d = dOf(live, 'g1_type6')
check(d.ticked.length + d.skipped.length + d.confirmed.length + d.done.length === 0 && d.stage === 'T5', 'clear forgets ticks, skips, confirmations and done marks but keeps the stage')
live.toggleTick('g1_type6', 'pre-rope')
// a page reload the same day keeps them
st = await loadStore(2)
live = st.procedureStore('live')
check(dOf(live, 'g1_type6').ticked.join() === 'pre-rope' && dOf(live, 'g1_type6').stage === 'T5' && live.get().procedure === 'g1_type6_sim', 'a reload on the same day keeps the checklist')
// yesterday's ticks do not count today
const stale = JSON.parse(memory.get(KEY))
stale.day = '2000-01-01'
memory.set(KEY, JSON.stringify(stale))
st = await loadStore(3)
check(Object.keys(st.procedureStore('live').get().byProc).length === 0, "another day's ticks are discarded")
// damaged storage never breaks the page
for (const bad of ['{', 'null', '[]', '"x"', JSON.stringify({ day: new Date().toLocaleDateString('sv'), live: 5 }), JSON.stringify({ day: new Date().toLocaleDateString('sv'), live: { procedure: 7, byProc: { g1_type6: { stage: 99, ticked: 'no', skipped: [1, 'a'] } } } })]) {
  memory.set(KEY, bad)
  st = await loadStore('bad' + bad.length)
  const g = st.procedureStore('live').get()
  const dd = st.procDataOf(g, 'g1_type6')
  check(g.procedure === 'g1_type6' && dd.ticked.length === 0 && dd.stage === 'Before', `damaged storage (${bad.slice(0, 20)}) falls back to defaults`)
}
memory.set(KEY, JSON.stringify({ day: new Date().toLocaleDateString('sv'), live: { procedure: 'g1_type6', byProc: { g1_type6: { stage: 'T3', ticked: ['x', 4, 'y'] } } } }))
st = await loadStore('partial')
check(st.procDataOf(st.procedureStore('live').get(), 'g1_type6').ticked.join() === 'x,y' && st.procDataOf(st.procedureStore('live').get(), 'g1_type6').stage === 'T3', 'non-string entries are dropped, valid ones kept')
memory.set(KEY, JSON.stringify({ day: new Date().toLocaleDateString('sv'), live: { procedure: 'g1_type6', byProc: { g1_type6: { stage: 'gone' } } } }))
st = await loadStore('stage')
check(st.procDataOf(st.procedureStore('live').get(), 'g1_type6').stage === 'Before', 'a stage id that no longer exists falls back to the first stage')
globalThis.localStorage = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
st = await loadStore('blocked')
st.procedureStore('live').toggleTick('g1_type6', 'pre-rope')
check(st.procDataOf(st.procedureStore('live').get(), 'g1_type6').ticked.join() === 'pre-rope', 'with storage blocked the ticks still work for this page')


// -- numbers that start after the recording does (1.5 B3) -------------------------------------------------------------------
const rep = (extra = {}) => ({ type: 'replay', file: 'x', store: 'x', t0: 1000, t1: 1236, t: 1100, statsFrom: 1000, speed: 1, playing: true, ended: false, indexing: false, busy: null, speeds: [1], ...extra })
const inReplay = (state, replay, t) => ({ ...state, hello: { ...state.hello, source: 'replay' }, aux: state.aux ? { ...state.aux, t: t ?? state.aux.t } : state.aux, replay })
const velo = [seg('Velocity', { t0: 1010, tauAnkP: 6 })]
const whole = ev1('t5-ankle', inReplay(mk({ segments: velo, state: 'Velocity' }), rep()))
check(whole.status === 'ok' && whole.word === 'Within limit', 'numbers from the recording start: plain "Within limit"')
const late = ev1('t5-ankle', inReplay(mk({ segments: velo, state: 'Velocity' }), rep({ statsFrom: 1228 })))
check(late.status === 'ok' && late.word === 'Within limit since 228.0 s', `numbers from a jump to 228 s: the word says since when (is "${late.word}")`)
check(ev1('t5-ankle', inReplay(mk({ segments: velo, state: 'Velocity' }), rep({ statsFrom: 1000.4 }))).word === 'Within limit', 'a start within 0.5 s of the recording start is the whole run')
check(ev1('t5-ankle', inReplay(mk({ segments: [seg('Velocity', { tauAnkP: 30 })], state: 'Velocity' }), rep({ statsFrom: 1228 }))).word === 'Stop limit crossed', 'a stop reads Stop limit crossed whatever the start')
check(ev1('t5-ankle', mk({ segments: velo, state: 'Velocity' })).word === 'Within limit', 'live: plain "Within limit"')
check(ev1('t0-one-sender', inReplay(mk({ link: lowcmd(500) }), rep({ statsFrom: 1228 }))).word === 'Within limit', 'a check of the present moment does not claim a start')
check(ev1('t5-ankle', inReplay(mk({ segments: velo, state: 'Velocity' }), rep({ statsFrom: 1228 })), ops({ confirmed: ['t5-ankle'] })).word === 'Within limit since 228.0 s', 'confirmed by you does not change an ok verdict')

// -- a check of the present moment stays confirmed in a replay (1.5 W6) ------------------------------------------------------
const L = model.newReachedOk
const at = (link, t, latch, extra = {}) => ev1('t0-one-sender', inReplay(mk({ link }), rep({ t, ...extra }), t), { ...NO_OPS, latch })
{
  const latch = L()
  check(at(lowcmd(500), 1060, latch).status === 'ok', 'latch: reads ok at 60 s')
  const gone = at(lowcmd(0), 1070, latch)
  check(gone.status === 'ok' && /Confirmed at 60\.0 s; now: No rt\/lowcmd/.test(gone.detail), `latch: stays ok when the rate drops to nothing (is "${gone.detail}")`)
  check(at(lowcmd(1600), 1080, latch).status === 'stop', 'latch: a stop always shows')
  check(at(lowcmd(0), 1090, latch).status === 'ok', 'latch: after a stop and back to nothing it is still confirmed')
  check(at(lowcmd(0), 1050, latch).status === 'pending', 'latch: a seek back before the confirmation drops it')
  check(at(lowcmd(500), 1055, latch).status === 'ok' && at(lowcmd(0), 1056, latch).detail.includes('Confirmed at 55.0 s'), 'latch: confirmed again at the new time')
  const other = L()
  check(at(lowcmd(0), 1070, other).status === 'pending', 'latch: a fresh latch (new file) has nothing')
  check(ev1('t0-one-sender', mk({ link: lowcmd(0) }), { ...NO_OPS, latch }).status === 'pending', 'latch: not used live')
}
{
  const latch = L()
  const gap = (g, t, run = []) => ev1('t7-gap', inReplay(mk({ link: { ...lowcmd(500), lowstateGapMaxMs: g }, events: run }), rep({ t }), t), { ...NO_OPS, latch })
  check(gap(10, 1060).status === 'ok', 'latch gap: ok at 60 s')
  check(gap(120, 1070).status === 'check', 'latch gap: a gap that asks for a look is shown as it is')
  check(gap(150, 1080).status === 'stop', 'latch gap: a stop shows')
  const noLink = ev1('t7-gap', inReplay(mk({ link: null }), rep({ t: 1090 }), 1090), { ...NO_OPS, latch })
  check(noLink.status === 'ok' && noLink.detail.startsWith('Confirmed at 60.0 s'), 'latch gap: no link frame right now keeps the confirmation')
  const newRun = gap(10, 1095, [ev(1094, 'Config: again', { session: true })])
  check(newRun.status === 'ok', 'latch gap: a new run reads fresh')
  const afterNewRun = ev1('t7-gap', inReplay(mk({ link: null, events: [ev(1094, 'Config: again', { session: true })] }), rep({ t: 1096 }), 1096), { ...NO_OPS, latch })
  check(afterNewRun.status === 'ok' && afterNewRun.detail.includes('Confirmed at 95.0 s'), 'latch gap: after a new run only that run counts')
}


// -- the Review card's progress text -----------------------------------------------------------------------------------------
const fmt = await bundle('src/utils/monitorFormat.ts')
const pass = (r) => ({ hello: { source: 'replay' }, replay: rep(r) })
check(fmt.statsPassNote(pass({ statsPass: 'running', statsReady: 1118 })) === 'Preparing numbers for jumps (50 %)', 'progress text: half way')
check(fmt.statsPassNote(pass({ statsPass: 'running', statsReady: 1000 })) === 'Preparing numbers for jumps (0 %)', 'progress text: at the start')
check(fmt.statsPassNote(pass({ statsPass: 'done', statsReady: 1236 })) === null, 'progress text: gone when done')
check(fmt.statsPassNote(pass({ statsPass: 'off', statsReady: null })) === null, 'progress text: gone when off')
check(fmt.statsPassNote(pass({ statsPass: 'running', statsReady: 1118, t1: null })) === null, 'progress text: none before the length is known')
check(fmt.statsPassNote(pass({})) === null && fmt.statsPassNote({ hello: null, replay: null }) === null, 'progress text: none from an older bridge or live')

console.log(`check-procedures: ${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`)
if (failed) process.exit(1)
