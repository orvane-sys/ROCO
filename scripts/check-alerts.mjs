// Checks the alert logic that is not visible in a screenshot: first-out, burst grouping, the "follows Passive" label,
// the state-aware severity rules, shelving, and the manual section 3 abort checks. It bundles src/utils/alertModel.ts with
// rolldown (already installed for vite) and runs it in memory, so it needs no new package and writes no file.
//
//   node scripts/check-alerts.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = new URL('..', import.meta.url)
const path = (p) => fileURLToPath(new URL(p, root))

const bundle = await rolldown({ input: path('src/utils/alertModel.ts'), logLevel: 'silent' })
const { output } = await bundle.generate({ format: 'esm' })
await bundle.close()
const policyBundle = await rolldown({ input: path('src/config/alertPolicy.ts'), logLevel: 'silent' })
const policyOut = (await policyBundle.generate({ format: 'esm' })).output
await policyBundle.close()
const load = async (code) => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const model = await load(output[0].code)
const policy = await load(policyOut[0].code)

let failed = 0
let passed = 0
function check(ok, what) {
  if (ok) passed++
  else {
    failed++
    console.error('FAIL: ' + what)
  }
}

// -- fixtures ---------------------------------------------------------------------------------------------------------
const NAMES = Array.from({ length: 29 }, (_, i) => (i === 3 ? 'left_knee_joint' : i === 9 ? 'right_knee_joint' : i === 4 ? 'left_ankle_pitch_joint' : `joint_${i}`))
const alert = (id, kind, joint, since, level = 'warn', extra = {}) => ({
  id, kind, joint, level, peakLevel: level, value: 1, peak: 1, since, last: since + 1, text: `${kind} ${joint}`, ...extra,
})
const ev = (t, text, extra = {}) => ({ t, level: 'info', text, ...extra })
const change = (t, from, to) => ev(t, `FSM: Change state from ${from} to ${to}`, { from, to })
function mk({ alerts = [], log = [], events = [], state = 'Velocity', segments = [], segment = null } = {}) {
  return {
    hello: { limits: { jointNames: NAMES } },
    aux: { alerts, t: 1000 },
    fsm: { state, since: 0, events, segments, segment },
    replay: null,
    alertLog: log,
  }
}
const open = (a) => ({ event: 'open', ...a })
const close = (a, durationS = 0.5) => ({ event: 'close', ...a, durationS })

// -- every alert kind the bridge raises has a response and a label ---------------------------------------------------------
const bridge = readFileSync(path('scripts/roco_dds_bridge.py'), 'utf8')
const kinds = new Set([...bridge.matchAll(/conds\[[^\]]*\]\s*=\s*\(\s*[^,]+,\s*"(\w+)"/g)].map((m) => m[1]))
check(kinds.size >= 12, `found the bridge alert kinds (${kinds.size})`)
const labels = readFileSync(path('src/utils/monitorFormat.ts'), 'utf8')
for (const k of kinds) {
  check(k in policy.RESPONSES, `response for bridge kind ${k}`)
  check(new RegExp(`\\b${k}:`).test(labels), `label for bridge kind ${k}`)
}
for (const [k, r] of Object.entries(policy.RESPONSES)) {
  check(r.warn.length > 10 && r.critical.length > 10 && r.ref.startsWith('§'), `response text for ${k} is filled in`)
}

// -- state timeline ---------------------------------------------------------------------------------------------------
const changes = model.stateChanges([change(10, 'Passive', 'FixStand'), change(20, 'FixStand', 'Velocity'), ev(30, 'Config: x', { session: true })])
check(changes.length === 3 && changes[2].to === 'Passive' && changes[2].session, 'a Config line is a change to Passive')
check(model.stateAt(5, changes, 'X') === 'Passive', 'state before the first change is its from')
check(model.stateAt(15, changes, 'X') === 'FixStand', 'state between changes')
check(model.stateAt(25, changes, 'X') === 'Velocity', 'state after the second change')
check(model.stateAt(5, [], 'Velocity') === 'Velocity', 'no changes: the current state')

// -- first-out and bursts -----------------------------------------------------------------------------------------------
{
  const a = alert('range:3', 'joint_range', 3, 100, 'warn')
  const b = alert('tilt', 'tilt', null, 100.4, 'critical')
  const c = alert('pd:4', 'pd_demand', 4, 110, 'warn')
  const v = model.buildAlertView(mk({ alerts: [b, c, a] }))
  check(v.groups.length === 2, 'two bursts when 10 s apart')
  check(v.groups[0].level === 'critical' && v.groups[0].first.alert.id === 'range:3', 'critical group first; first-out is the earliest, not the worst')
  check(v.groups[0].rest.length === 1 && v.groups[0].rest[0].alert.id === 'tilt', 'later alert is "after this"')
  check(v.counts.critical === 1 && v.counts.warn === 2, 'counts per level')
  check(v.firstOut.alert.id === 'range:3', 'firstOut is the first of the top group')
}
{
  // alerts opened in the same frame: the first-out must not depend on the order the lists arrive in
  const a = alert('tilt', 'tilt', null, 100, 'critical')
  const b = alert('pd:4', 'pd_demand', 4, 100, 'critical')
  const one = model.buildAlertView(mk({ alerts: [a, b] }))
  const two = model.buildAlertView(mk({ alerts: [b, a] }))
  check(one.groups[0].id === two.groups[0].id, 'same-frame alerts: the group id (and first-out) is the same in either order')
}
{
  // a cleared first-out still leads its burst while a later member is active
  const t = alert('tilt', 'tilt', null, 10, 'critical', { last: 10.5 })
  const r = alert('range:3', 'joint_range', 3, 11, 'warn')
  const v = model.buildAlertView(mk({ alerts: [r], log: [open(t), close(t), open(r)] }))
  check(v.groups.length === 1 && v.groups[0].first.alert.id === 'tilt' && !v.groups[0].first.active, 'cleared first-out leads the burst')
  check(v.groups[0].first.level === 'critical', 'cleared alert shows the level it reached')
  check(v.counts.critical === 0 && v.counts.warn === 1, 'a cleared alert is not counted')
  check(v.closed.length === 1, 'cleared alert is in the history')
}
{
  // a burst with nothing active is not shown as a group
  const t = alert('tilt', 'tilt', null, 10, 'critical', { last: 10.5 })
  const v = model.buildAlertView(mk({ alerts: [], log: [open(t), close(t)] }))
  check(v.groups.length === 0 && v.closed.length === 1, 'a fully cleared burst is history only')
  // an open event with no live alert and no close (a seek or trimmed log) is not active
  const w = model.buildAlertView(mk({ alerts: [], log: [open(t)] }))
  check(w.groups.length === 0 && w.counts.warn === 0 && w.counts.critical === 0, 'a lost open event does not stay active')
}

// -- follows a change into Passive -------------------------------------------------------------------------------------------
{
  const events = [change(100, 'Velocity', 'Passive'), ev(99.8, "FSM: keyboard abort 'p' -> Passive", { level: 'warning' })]
  const early = alert('tilt', 'tilt', null, 99, 'warn')
  const a1 = alert('range:3', 'joint_range', 3, 100.5, 'critical')
  const a2 = alert('range:9', 'joint_range', 9, 101, 'critical')
  const late = alert('pd:4', 'pd_demand', 4, 140, 'warn')
  const v = model.buildAlertView(mk({ alerts: [early, a1, a2, late], events, state: 'Passive' }))
  const by = (id) => [...v.groups.flatMap((g) => [g.first, ...g.rest])].find((i) => i.alert.id === id)
  check(by('tilt').follows === null, 'an alert before the change does not follow it')
  check(by('range:3').follows?.from === 'Velocity', 'an alert just after the change follows it')
  check(by('range:3').follows?.reason?.includes("keyboard abort 'p'"), 'the abort line is given as the reason')
  check(by('pd:4').follows === null, 'an alert more than 10 s later does not follow it')
  const lead = v.groups.find((x) => x.first.alert.id === 'tilt')
  check(lead && lead.cause === null && lead.rest.length === 2 && lead.rest.every((i) => i.follows), 'an alert before the change stays first-out; the ones after it are marked')
  check(v.counts.followOn === 2, 'follow-on count')
  const only = model.buildAlertView(mk({ alerts: [a1, a2], events, state: 'Passive' }))
  const g = only.groups[0]
  check(only.groups.length === 1 && g.cause?.from === 'Velocity' && g.rest.length === 1, 'a burst that starts after the change is labelled with its cause')
  // the next state change ends the window
  const events2 = [change(100, 'Velocity', 'Passive'), change(102, 'Passive', 'FixStand')]
  const after = alert('pd:5', 'pd_demand', 5, 105, 'warn')
  const w = model.buildAlertView(mk({ alerts: [after], events: events2, state: 'FixStand' }))
  check(w.groups[0].first.follows === null, 'an alert after the next state change does not follow')
  // a Config line (new run) is not a cause
  const w2 = model.buildAlertView(mk({ alerts: [alert('pd:5', 'pd_demand', 5, 100.2, 'warn')], events: [ev(100, 'Config: x', { session: true })], state: 'Passive' }))
  check(w2.groups[0].first.follows === null, 'a new run starting in Passive is not a cause')
}

// -- state-aware severity ------------------------------------------------------------------------------------------------
{
  const kneeWarn = alert('range:3', 'joint_range', 3, 100, 'warn')
  const hang = model.buildAlertView(mk({ alerts: [kneeWarn], state: 'FixStand' }))
  check(hang.counts.warn === 0 && hang.counts.info === 1 && hang.info[0].rule?.id === 'knee-range-hanging', 'knee range warning is info in FixStand')
  check(hang.groups.length === 0, 'an info alert is not a group')
  const passive = model.buildAlertView(mk({ alerts: [kneeWarn], state: 'Passive' }))
  check(passive.counts.info === 1, 'knee range warning is info in Passive')
  const vel = model.buildAlertView(mk({ alerts: [kneeWarn], state: 'Velocity' }))
  check(vel.counts.warn === 1 && vel.counts.info === 0, 'knee range warning stays a warning in Velocity')
  const beyond = model.buildAlertView(mk({ alerts: [alert('range:3', 'joint_range', 3, 100, 'critical')], state: 'FixStand' }))
  check(beyond.counts.critical === 1, 'a range alert beyond the limit is never lowered')
  const ankle = model.buildAlertView(mk({ alerts: [alert('range:4', 'joint_range', 4, 100, 'warn')], state: 'FixStand' }))
  check(ankle.counts.warn === 1, 'the rule is for knees only')
  const unknown = model.buildAlertView(mk({ alerts: [kneeWarn], state: null }))
  check(unknown.counts.warn === 1, 'unknown state: no rule applies')
  // the state is the one at the time of the alert, not the current one
  const hist = model.buildAlertView(mk({ alerts: [kneeWarn], events: [change(50, 'Passive', 'FixStand'), change(200, 'FixStand', 'Velocity')], state: 'Velocity' }))
  check(hist.counts.info === 1, 'the state at the time of the alert is used')
  // a first-out is the first real alert, not an informational one before it
  const inf = alert('range:3', 'joint_range', 3, 100, 'warn')
  const real = alert('pd:4', 'pd_demand', 4, 100.5, 'warn')
  const mix = model.buildAlertView(mk({ alerts: [inf, real], state: 'FixStand' }))
  check(mix.groups[0].first.alert.id === 'pd:4' && mix.counts.info === 1, 'info alerts never take the first-out')
}

// -- acknowledge and shelve -------------------------------------------------------------------------------------------------
{
  const w = alert('pd:4', 'pd_demand', 4, 100, 'warn')
  const c = alert('tilt', 'tilt', null, 120, 'critical')
  const k = model.occurrenceKey
  const none = model.buildAlertView(mk({ alerts: [w, c] }))
  check(none.counts.unacknowledged === 2, 'nothing acknowledged at first')
  const acked = model.buildAlertView(mk({ alerts: [w, c] }), { acked: new Set([k(w), k(c)]), shelved: new Set() })
  check(acked.counts.unacknowledged === 0 && acked.counts.warn === 1 && acked.counts.critical === 1, 'acknowledged alerts stay active and counted')
  check(acked.groups.every((g) => g.unacknowledged === 0), 'group unacknowledged count')
  const shelved = model.buildAlertView(mk({ alerts: [w, c] }), { acked: new Set(), shelved: new Set(['pd:4', 'tilt']) })
  check(shelved.counts.warn === 0 && shelved.counts.shelved === 1 && shelved.shelved[0].alert.id === 'pd:4', 'a warning can be shelved and is counted as shelved')
  check(shelved.counts.critical === 1, 'a critical alert is never shelved')
  // a shelved warning that escalates comes back
  const up = model.buildAlertView(mk({ alerts: [{ ...w, level: 'critical', peakLevel: 'critical' }] }), { acked: new Set(), shelved: new Set(['pd:4']) })
  check(up.counts.critical === 1 && up.counts.shelved === 0, 'a shelved alert that turns critical is shown again')
  // a new occurrence of an acknowledged alert is new
  const again = model.buildAlertView(mk({ alerts: [{ ...w, since: 300 }] }), { acked: new Set([k(w)]), shelved: new Set() })
  check(again.counts.unacknowledged === 1, 'a new occurrence is not acknowledged')
}

// -- manual section 3 abort checks --------------------------------------------------------------------------------------------
const timing = (t, ms, policy = 'Velocity') => ev(t, `${policy} policy: 400 steps, first after 3 ms, step interval max ${ms} ms`, { health: { kind: 'policyTiming', policy, steps: 400, firstMs: 3, intervalMaxMs: ms } })
const seg = (name, pitch, t0 = 50) => ({ name, t0, tiltDeg: [1, pitch] })
const byId = (checks, id) => checks.find((c) => c.id === id)
{
  const none = model.evaluateAbortChecks(mk({ events: [] , state: null }))
  check(byId(none, 'step-interval').status === 'unknown', 'no policy timing yet: unknown, not ok')
  check(byId(none, 'log-lines').status === 'unknown', 'no log at all: unknown, not ok')
  check(byId(none, 'squat-lean').status === 'idle', 'no squat yet: not applicable')

  const fine = model.evaluateAbortChecks(mk({ events: [ev(1, 'FSM: Start Passive'), timing(60, 20)] }))
  check(byId(fine, 'step-interval').status === 'ok' && byId(fine, 'log-lines').status === 'ok', 'normal timing and a quiet log: not tripped')

  const edge = model.evaluateAbortChecks(mk({ events: [timing(60, 50)] }))
  check(byId(edge, 'step-interval').status === 'ok', '50 ms exactly is not above the limit')
  const slow = model.evaluateAbortChecks(mk({ events: [timing(60, 20), timing(90, 63.4, 'squat')] }))
  const s = byId(slow, 'step-interval')
  check(s.status === 'trip' && s.key === 'step-interval@90' && s.detail.includes('63.4'), 'a step interval above 50 ms trips, naming the worst')

  const lines = [
    ['SAFETY STOP: leg runaway: motor 3 at 16.0 rad/s', 'critical'],
    ['SAFETY: no robot state (rt/lowstate) for more than 200 ms in Velocity -> Passive', 'warning'],
    ['Safety: motor 12 temperature 66 C (warn 65 C, stop 80 C)', 'warning'],
    ['Safety: motor 5 motorstate 0 -> 8', 'warning'],
    ['anything at all', 'critical'],
    ['anything at all', 'error'],
  ]
  for (const [text, level] of lines) {
    const r = model.evaluateAbortChecks(mk({ events: [ev(70, text, { level })] }))
    check(byId(r, 'log-lines').status === 'trip', `abort line trips: ${text} [${level}]`)
  }
  // lines that must not trip
  const calm = [
    ev(1, 'Safety: motor temperatures [0]/[1] at start: 40/41', { health: { kind: 'startTemps', maxC: 41, motors: 29 } }),
    ev(2, 'Safety: motorstate at start: 0 0 0', { health: { kind: 'startMotorstate', nonzero: [], motors: 29 } }),
    ev(3, 'FSM: remote request for Velocity ignored in FixStand', { level: 'warning' }),
    ev(4, 'Config: x', { session: true }),
    change(5, 'Passive', 'FixStand'),
  ]
  check(byId(model.evaluateAbortChecks(mk({ events: calm })), 'log-lines').status === 'ok', 'start-up lines, ignored keys and state changes do not trip')

  // only the latest g1_ctrl run counts
  const old = [ev(1, 'SAFETY STOP: x', { level: 'critical' }), ev(5, 'Config: x', { session: true }), timing(9, 20)]
  check(byId(model.evaluateAbortChecks(mk({ events: old })), 'log-lines').status === 'ok', 'an abort line from an earlier run does not trip')

  const mild = model.evaluateAbortChecks(mk({ segments: [seg('squat', 12.6), seg('Velocity', 40)] }))
  check(byId(mild, 'squat-lean').status === 'ok', 'squat pitch of 12.6 degrees is within the reference')
  const watch = model.evaluateAbortChecks(mk({ segments: [seg('squat', 13.6)] }))
  check(byId(watch, 'squat-lean').status === 'watch' && byId(watch, 'squat-lean').key === '', 'squat pitch of 13.6 degrees is above the reference but not a trip')
  const lean = model.evaluateAbortChecks(mk({ segments: [seg('squat', 15.4)] }))
  check(byId(lean, 'squat-lean').status === 'trip' && byId(lean, 'squat-lean').key === 'squat-lean@50', 'squat pitch well above 13 degrees trips')
  const live = model.evaluateAbortChecks(mk({ state: 'squat', segment: seg('squat', 15.1, 80) }))
  check(byId(live, 'squat-lean').status === 'trip', 'a squat in progress is checked live')
  const notSquat = model.evaluateAbortChecks(mk({ state: 'Velocity', segment: seg('squat', 15.1, 80) }))
  check(byId(notSquat, 'squat-lean').status === 'idle', 'a leftover current segment outside the squat is ignored')

  const acked = model.evaluateAbortChecks(mk({ events: [timing(90, 63)] }), { acked: new Set(['step-interval@90']), shelved: new Set() })
  check(byId(acked, 'step-interval').acknowledged && byId(acked, 'step-interval').status === 'trip', 'a tripped check can be acknowledged and stays tripped')
}

console.log(`check-alerts: ${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
