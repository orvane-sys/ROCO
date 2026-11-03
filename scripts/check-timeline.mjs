// Checks the Step 6 logic that a screenshot cannot show: the plot sets resolve to lines that never share a unit across two axes or
// exceed four per plot, the plot history is searched correctly, the CSV and the Markdown report carry the right numbers, the
// timeline keeps alerts across replay seeks without counting one twice, and the saved plot sets and marks survive a reload
// (and a damaged store). It bundles the pure modules with rolldown (already installed for vite) and runs them in memory.
//
//   node scripts/check-timeline.mjs
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = new URL('..', import.meta.url)
const path = (p) => fileURLToPath(new URL(p, root))
let n = 0
async function bundle(input) {
  const b = await rolldown({ input: path(input), logLevel: 'silent' })
  const { output } = await b.generate({ format: 'esm' })
  await b.close()
  return import('data:text/javascript;base64,' + Buffer.from(output[0].code.replaceAll('import.meta.env.BASE_URL', '"/"') + `\n//load ${n++}`).toString('base64'))
}

let failed = 0
let passed = 0
function check(ok, what) {
  if (ok) passed++
  else {
    failed++
    console.error('FAIL: ' + what)
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const memory = new Map()
globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, String(v)), removeItem: (k) => void memory.delete(k) }

const sets = await bundle('src/config/plotSets.ts')
const pm = await bundle('src/utils/plotModel.ts')
const ringMod = await bundle('src/services/plotRing.ts')
const tl = await bundle('src/utils/timelineModel.ts')
const registry = await bundle('src/config/robotRegistry.ts')
const report = await bundle('src/utils/sessionReport.ts')
const alertModel = await bundle('src/utils/alertModel.ts')
const procs = await bundle('src/config/procedures/g1_type6.ts')
const procModel = await bundle('src/utils/procedureModel.ts')
const conn = await bundle('src/utils/connectionChecks.ts')
const profile = registry.G1_29DOF_WAIST_LOCKED_PROFILE
const { PLOT_SLOTS, PLOT_CAPACITY, PlotRing } = ringMod

// -- the plot ring ----------------------------------------------------------------------------------------------------------
check(PLOT_CAPACITY >= 3600, 'the history holds the 60 s window plus room to look back (' + PLOT_CAPACITY + ' samples)')
const zeros = new Array(PLOT_SLOTS).fill(0)
function ringOf(count, t0 = 100, dt = 0.02, fill) {
  const r = new PlotRing()
  for (let i = 0; i < count; i++) {
    const q = zeros.map((_, s) => fill?.q?.(i, s) ?? 0)
    const qc = zeros.map((_, s) => fill?.qc?.(i, s) ?? 0)
    const tau = zeros.map((_, s) => fill?.tau?.(i, s) ?? 0)
    const dem = zeros.map((_, s) => fill?.dem?.(i, s) ?? 0)
    const pk = zeros.map((_, s) => fill?.pk?.(i, s) ?? 0)
    r.push(t0 + i * dt, q, qc, tau, dem, pk, fill?.roll?.(i) ?? 0, fill?.pitch?.(i) ?? 0)
  }
  return r
}
{
  const r = ringOf(100)
  check(r.firstTime() === 100 && Math.abs(r.latestTime() - 101.98) < 1e-9, 'first and latest time')
  check(r.lowerBound(100) === 0 && r.lowerBound(100.021) === 2 && r.lowerBound(999) === 100 && r.lowerBound(0) === 0, 'lowerBound finds the first sample at or after a time')
  check(r.nearest(100.011) === 1 && r.nearest(100.009) === 0 && r.nearest(50) === 0 && r.nearest(500) === 99, 'nearest picks the closer sample and clamps at the ends')
  check(new PlotRing().nearest(1) === null && new PlotRing().firstTime() === null, 'an empty history has no nearest sample')
  const big = ringOf(PLOT_CAPACITY + 500)
  check(big.count === PLOT_CAPACITY && Math.abs(big.firstTime() - (100 + 500 * 0.02)) < 1e-6, 'a full ring forgets the oldest samples')
  check(big.nearest(big.latestTime()) === PLOT_CAPACITY - 1 && big.nearest(big.firstTime()) === 0 && big.t[big.index(big.nearest(big.firstTime() + 10.01))] > 0, 'nearest works after the ring wraps')
  const c = r.clone()
  c.push(500, zeros, zeros, zeros, zeros, zeros, 0, 0)
  check(r.count === 100 && c.count === 101, 'a clone is independent of the live history')
}

// -- plot set data ----------------------------------------------------------------------------------------------------------
const ids = new Set()
for (const s of sets.SHIPPED_SETS) {
  check(!ids.has(s.id), `unique set id ${s.id}`)
  ids.add(s.id)
  check(s.label.length > 2 && s.hint.length > 10, `${s.id}: has a label and a hint`)
  for (const p of s.panels) {
    check(p.joints.length <= sets.MAX_JOINTS_PER_PANEL, `${s.id}: at most two joints in a plot`)
    for (const j of p.joints) check(profile.joints.some((d) => d.id === j), `${s.id}: joint ${j} exists in the G1 profile`)
  }
}
for (const need of ['selected', 'ankles', 'knees', 'balance', 'squat']) check(ids.has(need), `the ${need} set ships with ROCO`)
check(same(sets.PLOT_WINDOWS, [5, 10, 30, 60]), 'windows are 5, 10, 30 and 60 s')

// -- resolving a set --------------------------------------------------------------------------------------------------------
const slotOf = (id) => {
  const i = profile.joints.findIndex((j) => j.id === id)
  return profile.joints[i].sdkMotorIndex ?? i
}
const byId = (id) => sets.SHIPPED_SETS.find((s) => s.id === id)
const sel = pm.resolveSet(byId('selected'), profile, 'left_knee_joint', false)
check(sel.panels.length === 3 && sel.panels.map((p) => p.kind).join() === 'angle,torque,tilt', 'the selected-joint set has angle, torque and tilt plots')
check(sel.panels[0].series.length === 2 && sel.panels[0].series[0].measure === 'q' && !sel.panels[0].series[0].dashed && sel.panels[0].series[1].measure === 'qCmd' && sel.panels[0].series[1].dashed, 'one joint: measured solid, the command dashed')
check(sel.panels[0].series[0].entity === 0 && sel.panels[0].series[1].entity === 1 && !sel.panels[0].byJoint, 'one joint: colour tells measured from command')
check(sel.panels[0].series[0].slot === slotOf('left_knee_joint'), 'the selected joint is read from its motor slot')
const cmp = pm.resolveSet(byId('selected'), profile, 'left_knee_joint', true)
check(cmp.panels[1].series.length === 4 && cmp.panels[1].byJoint, 'left and right: four lines in the torque plot')
check(same(cmp.panels[1].series.map((s) => [s.entity, s.dashed]), [[0, false], [0, true], [1, false], [1, true]]), 'left and right: colour tells the sides apart, dashes tell measured from command')
check(cmp.panels[1].joints.map((j) => j.id).join() === 'left_knee_joint,right_knee_joint', 'left first, right second')
const fromRight = pm.resolveSet(byId('selected'), profile, 'right_hip_roll_joint', true)
check(fromRight.panels[0].joints.map((j) => j.id).join() === 'right_hip_roll_joint,left_hip_roll_joint', 'the selected joint stays the first line, its counterpart the second')
const waist = pm.resolveSet(byId('selected'), profile, 'waist_yaw_joint', true)
check(waist.panels[0].joints.length === 1 && waist.notes.length === 1, 'a joint with no counterpart is plotted alone and the plot says so')
check(pm.mirrorOf(profile, 'left_ankle_pitch_joint')?.id === 'right_ankle_pitch_joint' && pm.mirrorOf(profile, 'waist_yaw_joint') === null, 'mirrorOf swaps left and right only')
check(sel.panels[2].series.map((s) => s.measure).join() === 'roll,pitch' && sel.panels[2].joints.length === 0, 'the tilt plot has roll and pitch and no joint')
const noSel = pm.resolveSet(byId('selected'), profile, null, false)
check(noSel.panels[0].joints.length === 1, 'with nothing selected a default joint is plotted')
for (const s of sets.SHIPPED_SETS) {
  for (const cmpOn of [false, true]) {
    const r = pm.resolveSet(s, profile, 'left_ankle_pitch_joint', cmpOn)
    check(r.panels.length > 0, `${s.id}: resolves to plots`)
    for (const p of r.panels) {
      const unit = new Set(p.series.map((x) => x.unit))
      check(unit.size === 1, `${s.id}/${p.id}: one unit on one axis`)
      check(p.series.length <= 4 && p.series.length >= 1, `${s.id}/${p.id}: at most four lines`)
      check(new Set(p.series.map((x) => x.key)).size === p.series.length, `${s.id}/${p.id}: no line twice`)
      check(p.series.every((x) => !(x.entity === 0 && x.dashed && !p.byJoint)) , `${s.id}/${p.id}: in a one-joint plot the first line is solid`)
    }
  }
}
const ank = pm.resolveSet(byId('ankles'), profile, null, false)
check(ank.panels[0].joints.map((j) => j.id).join() === 'left_ankle_pitch_joint,right_ankle_pitch_joint', 'the Ankles set names its joints')
const lacking = pm.resolveSet({ id: 'x', label: 'X', hint: 'y', panels: [{ kind: 'torque', joints: ['left_knee_joint', 'no_such_joint'], command: true }] }, profile, null, false)
check(lacking.panels[0].joints.length === 1 && lacking.notes.length === 1, 'a joint the robot lacks drops out and a note says so')
const none = pm.resolveSet({ id: 'x', label: 'X', hint: 'y', panels: [{ kind: 'torque', joints: ['no_such_joint'], command: true }] }, profile, null, false)
check(none.panels.length === 0, 'a plot with no joint left is dropped')
check(followsSelection(byId('selected')) && !followsSelection(byId('ankles')), 'only the selected-joint set follows the table')
function followsSelection(s) { return pm.followsSelection(s) }
const snap = pm.snapshotSet(cmp, 'user-1', 'Mine')
const back = pm.resolveSet(snap, profile, 'something_else', false)
check(same(back.panels.map((p) => p.series.map((s) => s.key)), cmp.panels.map((p) => p.series.map((s) => s.key))), 'a saved set plots the same lines whatever is selected later')

// -- values and the CSV -----------------------------------------------------------------------------------------------------
const ls = slotOf('left_ankle_pitch_joint')
const rs = slotOf('right_ankle_pitch_joint')
const R = ringOf(500, 1000, 0.02, {
  q: (i, s) => (s === ls ? Math.PI / 6 : s === rs ? -0.1 : 0),
  qc: (i, s) => (s === ls ? Math.PI / 4 : NaN),
  tau: (i, s) => (s === ls ? 6.5 + i * 0.01 : s === rs ? -3 : 0),
  dem: (i, s) => (s === ls ? -12.5 : 2),
  pk: (i, s) => (s === ls ? 15 : 3),
  roll: () => 0.01,
  pitch: () => -0.02,
})
const ser = (measure, slot) => ({ measure, slot })
check(Math.abs(pm.sampleValue(R, 0, ser('q', ls)) - 30) < 1e-4, 'angles are shown in degrees')
check(Math.abs(pm.sampleValue(R, 0, ser('qCmd', ls)) - 45) < 1e-4 && Number.isNaN(pm.sampleValue(R, 0, ser('qCmd', rs))), 'a target that is not held is no value, not zero')
check(Math.abs(pm.sampleValue(R, 3, ser('tau', ls)) - 6.53) < 1e-4 && Math.abs(pm.sampleValue(R, 0, ser('roll', 0)) - 0.5729578) < 1e-4, 'torque in Nm, tilt in degrees')
check(pm.demandPeak(R, 0, ls) === -15 && pm.demandPeak(R, 0, rs) === 3, 'the PD demand peak takes the sign of the demand')
check(pm.tableStep(5) === 0.5 && pm.tableStep(30) === 1 && pm.tableStep(60) === 2 && pm.tickStep(5) === 1 && pm.tickStep(60) === 10, 'table rows and axis ticks scale with the window')
const csv = pm.buildPlotCsv(R, ank.panels, 1000 + 2, 1000 + 4, 1000)
const lines = csv.trim().split('\n')
const head = lines[0].split(',')
check(head[0] === 't' && head[1] === 't_rel_s', 'the CSV starts with the unix time, as PlotJuggler expects')
check(head.length === new Set(head).size, 'CSV column names are unique')
check(head.some((h) => /left_ankle_pitch_joint\.tau_nm/.test(h)) && head.some((h) => /demand_peak/.test(h)) && head.some((h) => /\.q_deg/.test(h)), 'CSV columns name the joint, the signal and the unit')
check(lines.length - 1 === 101 && Math.abs(Number(lines[1].split(',')[0]) - 1002) < 1e-6 && Math.abs(Number(lines[lines.length - 1].split(',')[0]) - 1004) < 1e-6, 'the CSV holds the samples of the window, both ends included (' + (lines.length - 1) + ')')
const row0 = lines[1].split(',')
check(Math.abs(Number(row0[1]) - 2) < 1e-6, 't_rel_s counts from the start given')
const col = (name) => row0[head.findIndex((h) => h.includes(name))]
check(Math.abs(Number(col('left_ankle_pitch_joint.tau_nm')) - (6.5 + 100 * 0.01)) < 1e-3, 'CSV torque equals the plotted torque')
check(col('left_ankle_pitch_joint.q_deg') === '30' || Math.abs(Number(col('left_ankle_pitch_joint.q_deg')) - 30) < 1e-4, 'CSV angle is in degrees')
check(csv.split('\n').every((l) => !/NaN|undefined/.test(l)), 'no NaN text in the CSV: missing values are empty cells')
check(lines.slice(1).every((l) => l.split(',').length === head.length), 'every CSV row has every column')

// -- plot preferences (saved sets) ------------------------------------------------------------------------------------------
{
  const loadPrefs = () => bundle('src/services/plotPrefs.ts')
  memory.clear()
  let pp = await loadPrefs()
  check(pp.getPlotPrefs().windowS === 10 && pp.getPlotPrefs().setId === 'selected' && !pp.getPlotPrefs().compare, 'defaults: 10 s, the selected joint, no overlay')
  pp.setWindow(60)
  pp.setCompare(true)
  pp.setPlotSet('ankles')
  pp.setPlotSet('no-such-set')
  check(pp.getPlotPrefs().setId === 'ankles', 'an unknown set id is ignored')
  const ok = pp.saveUserSet('  My ankles ', (id, label) => pm.snapshotSet(cmp, id, label))
  check(ok && pp.getPlotPrefs().userSets.length === 1 && pp.getPlotPrefs().userSets[0].label === 'My ankles' && pp.getPlotPrefs().setId === pp.getPlotPrefs().userSets[0].id, 'a saved set is kept under its trimmed name and becomes the current one')
  check(!pp.saveUserSet('', (id, l) => pm.snapshotSet(cmp, id, l)), 'an empty name is refused')
  check(!pp.saveUserSet('ankles', (id, l) => pm.snapshotSet(cmp, id, l)) && !pp.saveUserSet('KNEES', (id, l) => pm.snapshotSet(cmp, id, l)), 'a name used by a shipped set is refused')
  pp.saveUserSet('my ankles', (id, l) => pm.snapshotSet(cmp, id, l))
  check(pp.getPlotPrefs().userSets.length === 1, 'saving under an existing name replaces it')
  for (let i = 0; i < 10; i++) pp.saveUserSet('set ' + i, (id, l) => pm.snapshotSet(cmp, id, l))
  check(pp.getPlotPrefs().userSets.length === 8, 'at most eight saved sets')
  const savedId = pp.getPlotPrefs().userSets[0].id
  pp = await loadPrefs()
  check(pp.getPlotPrefs().windowS === 60 && pp.getPlotPrefs().compare && pp.getPlotPrefs().userSets.length === 8, 'a reload keeps window, overlay and saved sets')
  pp.setPlotSet(savedId)
  pp.deleteUserSet(savedId)
  check(pp.getPlotPrefs().userSets.length === 7 && pp.getPlotPrefs().setId === 'selected', 'deleting the current set goes back to the selected-joint set')
  for (const bad of ['{', 'null', '[]', '"x"', JSON.stringify({ windowS: 7, setId: 9, userSets: 'no' }), JSON.stringify({ windowS: 30, setId: 'gone', userSets: [{ id: 'a', label: 'A', panels: [{ kind: 'bogus', joints: [] }] }, { id: 'selected', label: 'S', panels: [{ kind: 'tilt', joints: [] }] }, { id: 'ok', label: 'Ok', panels: [{ kind: 'torque', joints: ['left_knee_joint', 'b', 'c'], command: true }] }] })]) {
    memory.set('roco.plots.v1', bad)
    pp = await loadPrefs()
    const g = pp.getPlotPrefs()
    check([5, 10, 30, 60].includes(g.windowS) && ['selected', 'ok'].includes(g.setId) && g.userSets.every((s) => s.panels.every((p) => ['angle', 'torque', 'tilt'].includes(p.kind) && p.joints.length <= 2)), `damaged plot preferences (${bad.slice(0, 18)}) fall back safely`)
  }
  memory.set('roco.plots.v1', JSON.stringify({ windowS: 30, setId: 'gone', userSets: [{ id: 'selected', label: 'S', panels: [{ kind: 'tilt', joints: [] }] }] }))
  pp = await loadPrefs()
  check(pp.getPlotPrefs().windowS === 30 && pp.getPlotPrefs().setId === 'selected' && pp.getPlotPrefs().userSets.length === 0, 'a saved set cannot take a shipped set\'s id')
  globalThis.localStorage = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  pp = await loadPrefs()
  pp.setWindow(5)
  check(pp.getPlotPrefs().windowS === 5, 'with storage blocked the choices still apply for this page')
  globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, String(v)), removeItem: (k) => void memory.delete(k) }
}

// -- marks ------------------------------------------------------------------------------------------------------------------
{
  const loadMarks = () => bundle('src/services/marksStore.ts')
  memory.clear()
  let mk = await loadMarks()
  const live = mk.marksStore('live')
  const rep = mk.marksStore('replay')
  const a = live.add(50, 'second')
  const b = live.add(10)
  check(live.get().map((m) => m.t).join() === '10,50' && live.get().length === 2, 'marks are kept in time order')
  check(live.add(NaN) === null && live.add(Infinity) === null, 'a mark without a real time is refused')
  live.setNote(b, 'x'.repeat(500))
  check(live.get()[0].note.length === mk.MAX_MARK_NOTE, 'a note is cut to its limit')
  live.setNote(a, 'rope slack')
  mk = await loadMarks()
  check(mk.marksStore('live').get().length === 2 && mk.marksStore('live').get()[1].note === 'rope slack', 'a reload the same day keeps the marks')
  rep.add(5, 'recording')
  check(JSON.parse(memory.get('roco.marks.v1')).marks.length === 2 && rep.get().length === 1, 'marks on a replay stay in memory')
  mk = await loadMarks()
  check(mk.marksStore('replay').get().length === 0, 'replay marks are gone after a reload')
  mk.marksStore('live').remove(a)
  check(mk.marksStore('live').get().length === 1, 'a mark can be deleted')
  mk.marksStore('live').clear()
  check(mk.marksStore('live').get().length === 0, 'all marks can be cleared')
  const stale = { day: '2000-01-01', marks: [{ id: 'm1', t: 1, note: '' }] }
  memory.set('roco.marks.v1', JSON.stringify(stale))
  mk = await loadMarks()
  check(mk.marksStore('live').get().length === 0, "another day's marks are discarded")
  for (const bad of ['{', 'null', '[]', JSON.stringify({ day: new Date().toLocaleDateString('sv'), marks: [1, null, { id: 5 }, { id: 'a', t: 'x', note: '' }, { id: 'ok', t: 3, note: 'fine' }] })]) {
    memory.set('roco.marks.v1', bad)
    mk = await loadMarks()
    check(mk.marksStore('live').get().every((m) => typeof m.id === 'string' && Number.isFinite(m.t)) && mk.marksStore('live').get().length <= 1, `damaged marks (${bad.slice(0, 18)}) are dropped, valid ones kept`)
  }
  let heard = 0
  const un = mk.marksStore('live').subscribe(() => heard++)
  mk.marksStore('live').add(1)
  un()
  mk.marksStore('live').add(2)
  check(heard === 1, 'subscribers hear each change once, and none after unsubscribing')
}

// -- timeline model ---------------------------------------------------------------------------------------------------------
const ev = (t, text, extra = {}) => ({ t, level: 'info', text, ...extra })
const chg = (t, from, to) => ev(t, `FSM: Change state from ${from} to ${to}`, { from, to })
const alertOf = (id, since, level = 'warn', extra = {}) => ({ id, kind: id.split(':')[0], joint: 4, level, peakLevel: level, value: 1, peak: 1, since, last: since + 1, text: id, ...extra })
const live = (extra = {}) => ({
  hello: { source: 'sim', limits: { jointNames: profile.joints.map((j) => j.id), ankleMotorPeak: 24.8, lockedJoints: [], tiltWarnDeg: 20, modeMachine: 6 }, bridge: 'b', protocol: 1, rateHz: 50 },
  aux: { t: 200, alerts: [], link: { lowstateHz: 500, lowstateAgeMs: 3 } },
  fsm: { state: 'Velocity', since: 120, events: [ev(100, 'Config: x', { session: true }), chg(110, 'Passive', 'FixStand'), chg(120, 'FixStand', 'Velocity')], segments: [], segment: null },
  replay: null,
  alertLog: [],
  ...extra,
})
{
  const m = tl.buildTimeline(live(), [], [], { first: 150, last: 200 })
  check(m.t0 === 100 && m.t1 === 200 && !m.replay, 'live: the timeline runs from the latest g1_ctrl run to the newest data')
  check(same(m.spans.map((s) => [s.state, s.t0, s.t1]), [['Passive', 100, 110], ['FixStand', 110, 120], ['Velocity', 120, 200]]), 'live: one span per state, the last one running to now')
  const older = tl.buildTimeline(live({ fsm: { ...live().fsm, events: [chg(110, 'Passive', 'FixStand')] } }), [], [], { first: 150, last: 200 })
  check(older.t0 === 110 && older.spans[0].state === 'FixStand', 'live without a run start: from the first change')
  const empty = tl.buildTimeline(live({ fsm: { state: null, since: null, events: [], segments: [], segment: null }, aux: null }), [], [], { first: null, last: null })
  check(empty.t1 > empty.t0 && empty.spans.length === 1 && empty.spans[0].state === null, 'nothing yet: a one-second timeline with an unknown state')
  const withMarks = tl.buildTimeline(live(), [], [{ id: 'a', t: 150, note: '' }, { id: 'b', t: 50, note: 'old run' }, { id: 'c', t: 999, note: 'future' }], { first: 150, last: 200 })
  check(withMarks.marks.length === 1 && withMarks.marks[0].id === 'a', 'marks outside the current run are not drawn')
  const early = tl.buildTimeline(live(), [], [{ id: 'p', t: 95, note: 'before the run' }, { id: 'q', t: 50, note: 'before the page' }], { first: 90, last: 200 })
  check(early.t0 === 95 && early.marks.length === 1 && early.marks[0].id === 'p', 'a mark made since the page started, before the run began, stretches the timeline back to it; older ones stay out')
  const rp = { file: 'x', store: 's', t0: 1000, t1: 1100, t: 1030, speed: 1, playing: false, ended: false, indexing: false, busy: null, speeds: [1] }
  const frame = { type: 'timeline', t0: 1000, states: [{ t: 1010, from: 'Passive', to: 'FixStand', session: false }, { t: 1000.5, from: null, to: 'Passive', session: true }, { t: 1060, from: 'FixStand', to: 'Velocity', session: false }] }
  const full = tl.buildTimeline(live({ replay: rp, timeline: frame, fsm: { ...live().fsm, events: [] } }), [], [], { first: null, last: null })
  check(full.t0 === 1000 && full.t1 === 1100 && full.replay && full.playedTo === 1030, 'replay: the whole recording, with how far it has played')
  check(same(full.spans.map((s) => [s.state, s.t0, s.t1]), [[null, 1000, 1000.5], ['Passive', 1000.5, 1010], ['FixStand', 1010, 1060], ['Velocity', 1060, 1100]]) || same(full.spans.map((s) => [s.state, s.t0, s.t1]), [['Passive', 1000, 1010], ['FixStand', 1010, 1060], ['Velocity', 1060, 1100]]), 'replay: the bridge\'s list gives every state, in time order, before they are played')
  const noFrame = tl.buildTimeline(live({ replay: rp, fsm: { ...live().fsm, events: [chg(1010, 'Passive', 'FixStand')] } }), [], [], { first: null, last: null })
  check(noFrame.spans[noFrame.spans.length - 1].state === null && noFrame.spans[noFrame.spans.length - 1].t0 === 1030 && noFrame.spans[noFrame.spans.length - 1].t1 === 1100, 'replay on an older bridge: known only as far as it has played, the rest marked unknown')
  const running = tl.buildTimeline(live({ replay: { ...rp, t1: null, t: 1005 }, timeline: frame }), [], [], { first: null, last: null })
  check(running.t1 > running.t0, 'a recording whose end is not indexed yet still has a span')
  check(Math.abs(tl.timeAtX({ t0: 0, t1: 10 }, 150, 50, 100) - 10) < 1e-9 && tl.timeAtX({ t0: 0, t1: 10 }, -20, 50, 100) === 0 && tl.timeAtX({ t0: 0, t1: 10 }, 900, 50, 100) === 10, 'x to time clamps to the band')
  check(Math.abs(tl.xAtTime({ t0: 0, t1: 10 }, 5, 50, 100) - 100) < 1e-9, 'time to x')
}

// alerts remembered across seeks
const itemOf = (a, active, level = a.level, durationS) => ({ key: `${a.id}@${a.since}`, alert: a, active, level, durationS })
const viewOf = ({ active = [], closed = [], info = [] } = {}) => ({
  groups: active.length ? [{ id: 'g', first: active[0], rest: active.slice(1), cause: null, level: 'warn', unacknowledged: 1 }] : [],
  info,
  shelved: [],
  closed,
  counts: {},
  firstOut: null,
})
{
  let mem = tl.mergeTimelineAlerts([], viewOf({ active: [itemOf(alertOf('pd_demand:4', 120), true), itemOf(alertOf('tilt:null', 121, 'critical'), true)] }), null)
  check(mem.length === 2 && mem[0].until === null && mem[1].level === 'critical', 'open alerts are remembered with no end yet')
  const same1 = tl.mergeTimelineAlerts(mem, viewOf({ active: [itemOf(alertOf('pd_demand:4', 120), true), itemOf(alertOf('tilt:null', 121, 'critical'), true)] }), null)
  check(same1 === mem, 'nothing new: the same list comes back (no re-render)')
  const a2 = alertOf('pd_demand:4', 120, 'warn')
  mem = tl.mergeTimelineAlerts(mem, viewOf({ closed: [itemOf({ ...a2, last: 125 }, false, 'critical', 4)], active: [itemOf(alertOf('tilt:null', 121, 'critical'), true)] }), null)
  const pd = mem.find((x) => x.id === 'pd_demand:4')
  check(pd.until === 124 && pd.level === 'critical', 'a closed alert gets its end, and the highest level it reached')
  mem = tl.mergeTimelineAlerts(mem, viewOf({ active: [itemOf(alertOf('pd_demand:4', 130), true)] }), null)
  check(mem.filter((x) => x.id === 'pd_demand:4').length === 2, 'the same alert opening again later is a second occurrence')
  // replay: seek back to 122; the bridge restarts, tilt (opened at 121, still open) opens again at 122
  const before = mem.length
  mem = tl.mergeTimelineAlerts(mem, viewOf({ active: [itemOf(alertOf('tilt:null', 122, 'critical'), true)] }), 122)
  check(mem.length === before, 'a replay seek does not count an alert that was already open as a new one')
  check(mem.find((x) => x.id === 'tilt:null').t === 121, 'it keeps its real start time')
  mem = tl.mergeTimelineAlerts(mem, viewOf({ active: [itemOf(alertOf('knee:3', 200), true)] }), 122)
  check(mem.length === before + 1, 'a genuinely new alert after a seek is added')
  const info = tl.mergeTimelineAlerts([], viewOf({ info: [itemOf(alertOf('joint_range:3', 10, 'warn'), true, 'info')] }), null)
  check(info.length === 1 && info[0].level === 'info', 'an alert lowered by a severity rule is kept at info')
  const order = tl.mergeTimelineAlerts([], viewOf({ active: [itemOf(alertOf('b:1', 5), true), itemOf(alertOf('a:1', 5), true), itemOf(alertOf('c:1', 3), true)] }), null)
  check(order.map((x) => x.id).join() === 'c:1,a:1,b:1', 'alerts are listed by time, ties by key')
}
{
  const m = tl.buildTimeline(live(), [{ key: 'k', id: 'pd_demand:4', kind: 'pd_demand', joint: 4, level: 'critical', t: 150, until: 155 }], [{ id: 'm1', t: 130, note: 'lowered' }, { id: 'm2', t: 170, note: '' }], { first: 150, last: 200 })
  const rows = tl.timelineRows(m, (a) => 'Joint range ' + a.id, (s) => `${s} s`)
  check(rows.map((r) => r.kind).join() === 'state,state,mark,state,alert,mark' || rows.map((r) => r.kind).join() === 'state,state,state,mark,alert,mark', 'the table lists states, alerts and marks in time order (' + rows.map((r) => r.kind).join() + ')')
  check(rows.every((r, i) => i === 0 || rows[i - 1].t <= r.t), 'rows are sorted by time')
  check(rows.find((r) => r.kind === 'alert').text.startsWith('Critical:') && rows.find((r) => r.kind === 'alert').text.includes('for 5 s'), 'an alert row says its level in words and how long it was open')
  check(rows.find((r) => r.kind === 'mark').text === 'Mark 1: lowered', 'a mark row carries its number and note')
  check(rows[0].text === 'State: Passive' && rows[1].text === 'State changes to FixStand', 'the first row names the starting state')
}

// -- the report -------------------------------------------------------------------------------------------------------------
{
  const seg = { name: 'Velocity', t0: 120, durS: 80.04, ankPitchDemandMax: 7.123, ankPitchDemandPct: 28.7, overMs: 0, overRunMs: 0, tauAnkP: 6.51, tauAnkR: 1.2, tauKnee: 3.5, legErrMaxDeg: 4.44, legDqMax: 0.321, tiltDeg: [-0.8, 1.2], gyroMax: 0.55, samples: 4000 }
  const state = live({ fsm: { ...live().fsm, segments: [{ ...seg, name: 'FixStand', t0: 110, durS: 10 }], segment: seg } })
  const m = tl.buildTimeline(state, [{ key: 'k', id: 'pd_demand:4', kind: 'pd_demand', joint: 4, level: 'warn', t: 150, until: 152 }, { key: 'k2', id: 'tilt:null', kind: 'tilt', joint: null, level: 'critical', t: 160, until: null }], [{ id: 'm1', t: 130, note: 'pipe | in note\nnew line' }], { first: 150, last: 200 })
  const proc = procModel.evaluateProcedure(procs.PROCEDURES[0], state, procModel.NO_OPS)
  const abort = alertModel.evaluateAbortChecks(state)
  const md = report.buildReport({ state, profileName: 'Unitree G1 (29-DOF, waist locked)', generatedAt: new Date('2026-11-02T10:00:00Z'), timeline: m, alertTitle: (a) => 'Alert ' + a.id, abortChecks: abort, procedure: proc })
  for (const h of ['# ROCO session report', '## 1. Summary', '## 2. Setup', '## 3. Timeline', '## 4. Per state (as real_log.py)', '## 5. Guided checks', '## 6. Abort checks', '## 7. Alerts', '## 8. Operator marks']) check(md.includes(h), `report has "${h}"`)
  check(/g1_ctrl states: Passive → FixStand → Velocity/.test(md), 'the summary lists the states visited in order')
  check(/Alerts: 1 critical, 1 warning, 0 info/.test(md), 'the summary counts alerts by level')
  check(md.includes('| Velocity (now) | 02:02:00.000'.slice(0, 16)) || md.includes('Velocity (now)'), 'the current state is marked in the per-state table')
  check(md.includes('7.1 Nm 29%') && md.includes('6.5 / 1.2 / 3.5') && md.includes('-0.8° / 1.2°') && md.includes('80.0 s'), 'per-state numbers use the same rounding as the page')
  check(md.includes('pipe \\| in note new line') && !/pipe \| in note/.test(md), 'a pipe or line break in a note cannot break a table')
  check(md.includes('still open'), 'an open alert says so')
  check(!/\bsafe to (start|continue|proceed)\b/i.test(md.replace(/is not "safe to continue"/g, '')) && /not a clearance/.test(md), 'the report never calls the robot safe and says it is not a clearance')
  const lines = md.split('\n').filter((l) => l.startsWith('|'))
  check(lines.length > 10, 'tables are present')
  const tables = md.split('\n\n').filter((b) => b.startsWith('| '))
  check(tables.every((t) => { const rows = t.split('\n'); const cols = (r) => r.replace(/\\\|/g, '').split('|').length; return rows.every((r) => cols(r) === cols(rows[0])) }), 'every table row has the same number of columns')
  const noProc = report.buildReport({ state, profileName: 'x', generatedAt: new Date(), timeline: m, alertTitle: () => '', abortChecks: abort, procedure: null })
  check(!noProc.includes('Guided checks') && noProc.includes('## 5. Abort checks'), 'without a procedure the sections renumber')
  const rep = report.buildReport({ state: { ...state, replay: { file: 'stand_cal16', store: 's', t0: 100, t1: 200, t: 150, speed: 1, playing: false, ended: false, indexing: false, busy: null, speeds: [1] }, hello: { ...state.hello, source: 'replay', replay: { file: 'stand_cal16', store: 'z.zip', notes: [] } } }, profileName: 'x', generatedAt: new Date(), timeline: { ...m, replay: true, playedTo: 150 }, alertTitle: () => 'a', abortChecks: abort, procedure: null })
  check(rep.includes('REPLAY stand_cal16') && rep.includes('played to 50.0 s'), 'a recording\'s report names the recording and how far it was played')
}

// -- connection checks ------------------------------------------------------------------------------------------------------
{
  const none = conn.connectionChecks({ hello: null, aux: null, fsm: { state: null, events: [], segments: [], segment: null }, replay: null, alertLog: [] }, 'ws://localhost:8765')
  check(none.length === 3 && none.every((c) => !c.ok) && none[0].text.includes('ws://localhost:8765'), 'nothing answers: three checks, none passing, the address shown')
  const hello = conn.connectionChecks(live({ aux: null, fsm: { state: null, events: [], segments: [], segment: null } }), 'x')
  check(hello[0].ok && !hello[1].ok && !hello[2].ok && hello[1].text.includes('interface'), 'bridge up but no robot state: the second check says what to look at')
  const all = conn.connectionChecks(live(), 'x')
  check(all.every((c) => c.ok), 'a running session passes all three')
  const stale = conn.connectionChecks(live({ aux: { t: 1, alerts: [], link: { lowstateHz: 500, lowstateAgeMs: 4000 } } }), 'x')
  check(!stale[1].ok, 'robot state that stopped arriving is not "OK"')
}

console.log(`check-timeline: ${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`)
if (failed) process.exit(1)
