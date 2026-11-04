// Checks how alerts survive a page reload and a bridge restart: the monitor reducer (hello / fsm / aux frames), the per-day store
// in localStorage, and the alert view's first-out for an alert the earlier bridge also had open. It bundles the three sources with
// rolldown and runs them in memory with a fake localStorage, so it needs no browser and writes no file.
//
//   node scripts/check-alert-history.mjs
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = new URL('..', import.meta.url)
const path = (p) => fileURLToPath(new URL(p, root))

// a localStorage that counts its writes and can be made to fail; the store reads the global when it runs
const backing = new Map()
const calls = { set: 0, failSet: false, failGet: false }
globalThis.localStorage = {
  getItem: (k) => {
    if (calls.failGet) throw new Error('blocked')
    return backing.has(k) ? backing.get(k) : null
  },
  setItem: (k, v) => {
    if (calls.failSet) throw new Error('full')
    calls.set++
    backing.set(k, String(v))
  },
  removeItem: (k) => backing.delete(k),
}

const load = async (file) => {
  const b = await rolldown({ input: path(file), logLevel: 'silent' })
  const { output } = await b.generate({ format: 'esm' })
  await b.close()
  return import('data:text/javascript;base64,' + Buffer.from(output[0].code).toString('base64'))
}
const { alertHistoryStore: store, alertScopeKey, flush, MAX_STORED_EVENTS } = await load('src/services/alertHistoryStore.ts')
const { reduceHello, reduceFsm, reduceAux, CARRY_WINDOW_S, MAX_ALERT_LOG } = await load('src/services/monitorReducer.ts')
const { buildAlertView } = await load('src/utils/alertModel.ts')

let failed = 0
let passed = 0
function check(ok, what) {
  if (ok) passed++
  else {
    failed++
    console.error('FAIL: ' + what)
  }
}
const KEY = 'roco.alertHistory.v1'
const fresh = () => {
  backing.clear()
  store.reset()
  calls.set = 0
  calls.failSet = false
  calls.failGet = false
}

// -- a page: what telemetryStream does with the three frames, without the socket -----------------------------------------------
const baseState = () => ({
  hello: null,
  aux: null,
  fsm: { state: 'Velocity', since: 0, events: [], segments: [], segment: null },
  replay: null,
  alertLog: [],
})
class Page {
  constructor() {
    this.state = baseState()
    this.scope = null
  }
  persist(p) {
    if (!p || !this.scope) return
    store.add(this.scope.scope, this.scope.sid, p.events)
    if (p.carry) store.setCarry(this.scope.scope, this.scope.sid, p.carry)
  }
  hello(h) {
    store.end()
    this.state = baseState()
    if (h.source === 'replay') {
      this.scope = null
      this.state = { ...this.state, ...reduceHello(h, null, '') }
    } else {
      const scope = alertScopeKey(h)
      this.scope = { scope, sid: h.session.id }
      const restored = store.load(scope)
      store.begin(scope, h.session.id)
      this.state = { ...this.state, ...reduceHello(h, restored, h.session.id) }
    }
  }
  fsm(history) {
    const r = reduceFsm(this.state, { type: 'fsm', full: true, state: 'Velocity', since: 0, events: [], segment: null, alertHistory: history })
    this.state = { ...this.state, ...r.patch }
    this.persist(r.persist)
  }
  aux(t, alerts = [], alertEvents = []) {
    const r = reduceAux(this.state, { type: 'aux', t, alerts, alertEvents, demand: [], segment: null })
    this.state = { ...this.state, ...r.patch }
    this.persist(r.persist)
    store.touch(t)
  }
  view() {
    return buildAlertView(this.state)
  }
}
const helloOf = (id, startedAt, extra = {}) => ({
  type: 'hello',
  source: 'sim',
  iface: 'lo',
  domain: 42,
  session: { id, startedAt },
  limits: { jointNames: [] },
  ...extra,
})
const alert = (id, since, extra = {}) => ({
  id, kind: 'tilt', joint: null, level: 'warn', peakLevel: 'warn', value: 30, peak: 30, since, last: since + 1, text: `tilt ${id}`, ...extra,
})
const open = (a) => ({ event: 'open', ...a })
const close = (a, last, durationS) => ({ event: 'close', ...a, last, durationS })

// -- 1. a page reload on the same bridge: nothing twice, nothing marked earlier -----------------------------------------------------
{
  fresh()
  const a = new Page()
  a.hello(helloOf('A', 1000))
  a.fsm([])
  a.aux(1010, [], [open(alert('tilt', 1010))])
  a.aux(1011, [alert('tilt', 1010)])
  a.aux(1020, [], [close(alert('tilt', 1010), 1015, 5)])
  flush()
  const b = new Page() // the reload: the bridge sends its own history again
  b.hello(helloOf('A', 1000))
  b.fsm([open(alert('tilt', 1010)), close(alert('tilt', 1010), 1015, 5)])
  check(b.state.alertLog.length === 2, `reload on the same bridge keeps each event once (${b.state.alertLog.length})`)
  check(b.state.alertLog.every((e) => !e.earlier), 'reload on the same bridge marks nothing as earlier')
  check(b.view().closed.length === 1 && !b.view().closed[0].earlier, 'reload: one cleared alert, not tagged')
  // the stored copy alone (the bridge sent nothing) gives the same view
  const c = new Page()
  c.hello(helloOf('A', 1000))
  check(c.state.alertLog.length === 2, 'the store alone brings the history back before the first frame')
}

// -- 2. a bridge restart: earlier events are tagged ------------------------------------------------------------------------------
{
  fresh()
  const a = new Page()
  a.hello(helloOf('A', 1000))
  a.fsm([])
  a.aux(1010, [], [open(alert('tilt', 1010))])
  a.aux(1012, [], [close(alert('tilt', 1010), 1011, 1)])
  flush()
  const b = new Page()
  b.hello(helloOf('B', 2000))
  b.fsm([])
  check(b.state.alertLog.length === 2 && b.state.alertLog.every((e) => e.earlier), 'after a restart the stored events are tagged earlier')
  const v = b.view()
  check(v.closed.length === 1 && v.closed[0].earlier === true, 'a cleared alert of the earlier session shows the earlier tag')
  check(v.groups.length === 0 && v.firstOut === null, 'an earlier alert is never current')
  check(b.state.alertCarry === undefined, 'a closed alert is not carried')
}

// -- 3. an alert open when the bridge stopped and open again within 5 s keeps its first time ------------------------------------------
{
  fresh()
  const a = new Page()
  a.hello(helloOf('A', 1000))
  a.fsm([])
  a.aux(1010, [], [open(alert('tilt', 1010))])
  a.aux(1050, [alert('tilt', 1010)])
  flush()
  const b = new Page()
  b.hello(helloOf('B', 2000)) // bridge restarted; A was last heard at 1050
  check(b.state.alertCarry?.tilt?.since === 1010 && b.state.alertCarry.tilt.gapFrom === 1050 && b.state.alertCarry.tilt.gapTo === 2000, 'the open alert is a carry candidate with the gap')
  b.fsm([])
  b.aux(2001, [])
  b.aux(2002, [alert('tilt', 2002)], [open(alert('tilt', 2002))])
  b.aux(2003, [alert('tilt', 2002)])
  const v = b.view()
  check(v.groups.length === 1 && v.firstOut?.alert.since === 1010, `first-out keeps the first time (${v.firstOut?.alert.since})`)
  check(v.firstOut?.carried?.gapFrom === 1050 && v.firstOut.carried.gapTo === 2000, 'the item carries the gap')
  check(v.closed.length === 0, 'the earlier open is the same occurrence, not listed twice')
  check(b.state.alertLog.filter((e) => e.id === 'tilt').length === 1, 'one open event in the log (the earlier one is replaced by the remapped one)')
  // the window passes with the alert still open: nothing synthetic
  b.aux(2000 + CARRY_WINDOW_S + 1, [alert('tilt', 2002)])
  check(!b.state.alertLog.some((e) => e.endedByRestart), 'a carried alert is not ended by the window')
  check(b.state.alertCarryUntil === undefined && b.state.alertCarry?.tilt?.newSince === 2002, 'the window is settled and the carry kept')
  flush()
  // a reload in the new session: the carry comes from the store and the bridge's history is remapped
  const c = new Page()
  c.hello(helloOf('B', 2000))
  check(c.state.alertCarry?.tilt?.newSince === 2002, 'the carry survives a page reload')
  c.fsm([open(alert('tilt', 2002))])
  c.aux(2020, [alert('tilt', 2002)])
  const w = c.view()
  check(w.firstOut?.alert.since === 1010 && w.groups.length === 1, 'after a reload the first-out time is still the first one')
  check(c.state.alertLog.filter((e) => e.id === 'tilt').length === 1, 'after a reload the occurrence is still listed once')
  // the alert clears: the close joins the same occurrence
  c.aux(2030, [], [close(alert('tilt', 2002), 2028, 26)])
  const x = c.view()
  check(x.closed.length === 1 && x.closed[0].alert.since === 1010 && Math.abs(x.closed[0].alert.last - 2028) < 1e-9, 'the close belongs to the first time')
  check(x.closed[0].durationS !== undefined && Math.abs(x.closed[0].durationS - (2028 - 1010)) < 1e-6, 'the carried alert is open for the whole time')
}

// -- 4. open again after 5 s: a new occurrence; the earlier one ended with its bridge ----------------------------------------------
{
  fresh()
  const a = new Page()
  a.hello(helloOf('A', 1000))
  a.fsm([])
  a.aux(1010, [], [open(alert('tilt', 1010))])
  a.aux(1050, [alert('tilt', 1010)])
  flush()
  const b = new Page()
  b.hello(helloOf('B', 2000))
  b.fsm([])
  b.aux(2002, [])
  check(b.state.alertCarryUntil === 2000 + CARRY_WINDOW_S, 'the window is open until 5 s after the start')
  b.aux(2000 + CARRY_WINDOW_S + 1, [])
  check(b.state.alertCarryUntil === undefined && b.state.alertCarry === undefined, 'the window closes with nothing carried')
  const ended = b.state.alertLog.find((e) => e.endedByRestart)
  check(ended && ended.event === 'close' && ended.since === 1010 && ended.last === 1050, 'the unmatched alert gets a close at the last time it was seen')
  b.aux(2020, [alert('tilt', 2020)], [open(alert('tilt', 2020))])
  const v = b.view()
  check(v.firstOut?.alert.since === 2020 && !v.firstOut.carried, 'an alert opening after the window is new')
  check(v.closed.length === 1 && v.closed[0].endedByRestart === true && v.closed[0].alert.since === 1010, 'the old one is cleared and says it ended when the bridge stopped')
  flush()
  const c = new Page() // a later reload: the synthetic close is stored, so the old one is not a candidate again
  c.hello(helloOf('B', 2000))
  check(c.state.alertCarry === undefined && c.state.alertCarryUntil === undefined, 'a reload does not carry an alert that was already ended')
  check(c.state.alertLog.find((e) => e.endedByRestart)?.earlier === true, 'the ended-by-restart close stays tagged after a reload')
}

// the first frame after the window already carries the event: it is judged by its own time, not by the frame's
{
  fresh()
  const a = new Page()
  a.hello(helloOf('A', 1000))
  a.fsm([])
  a.aux(1010, [], [open(alert('tilt', 1010))])
  a.aux(1050, [alert('tilt', 1010)])
  flush()
  const b = new Page()
  b.hello(helloOf('B', 2000))
  b.fsm([])
  b.aux(2000 + CARRY_WINDOW_S + 4, [alert('tilt', 2000 + CARRY_WINDOW_S + 3)], [open(alert('tilt', 2000 + CARRY_WINDOW_S + 3))])
  const v = b.view()
  check(v.firstOut?.alert.since === 2000 + CARRY_WINDOW_S + 3 && !v.firstOut.carried, 'an event that opened after the window is not carried even in the first frame that shows it')
  check(b.state.alertLog.some((e) => e.endedByRestart && e.since === 1010), 'and the earlier one is ended')
  flush()
  const c = new Page() // reload: the bridge's history holds the same late open
  c.hello(helloOf('B', 2000))
  c.fsm([open(alert('tilt', 2000 + CARRY_WINDOW_S + 3))])
  c.aux(2020, [alert('tilt', 2000 + CARRY_WINDOW_S + 3)])
  check(c.view().firstOut?.alert.since === 2000 + CARRY_WINDOW_S + 3, 'a reload keeps it a new occurrence')
}

// -- 5. three bridge sessions in a row: the first time holds -------------------------------------------------------------------------
{
  fresh()
  const a = new Page()
  a.hello(helloOf('A', 1000))
  a.fsm([])
  a.aux(1010, [], [open(alert('tilt', 1010))])
  a.aux(1050, [alert('tilt', 1010)])
  flush()
  const b = new Page()
  b.hello(helloOf('B', 2000))
  b.fsm([])
  b.aux(2002, [alert('tilt', 2002)], [open(alert('tilt', 2002))])
  b.aux(2100, [alert('tilt', 2002)])
  flush()
  const c = new Page()
  c.hello(helloOf('C', 3000))
  c.fsm([])
  c.aux(3003, [alert('tilt', 3003)], [open(alert('tilt', 3003))])
  const v = c.view()
  check(v.firstOut?.alert.since === 1010, `three sessions: first-out is still the first time (${v.firstOut?.alert.since})`)
  check(v.firstOut?.carried?.gapFrom === 2100 && v.firstOut.carried.gapTo === 3000, 'three sessions: the gap is the last one')
  check(c.state.alertLog.filter((e) => e.id === 'tilt' && e.event === 'open').length === 1, 'three sessions: one open event')
}

// -- 6. other days, damaged and blocked storage ------------------------------------------------------------------------------------
{
  fresh()
  backing.set(KEY, JSON.stringify({ day: '2000-01-01', scopes: { 'sim|lo|42': { events: [{ ...open(alert('tilt', 5)), session: 'A' }], ends: {}, carry: {} } } }))
  check(store.load('sim|lo|42').events.length === 0, 'another day gives an empty history')
  for (const bad of ['{not json', 'null', '[]', '"x"', '{"day":1}']) {
    fresh()
    backing.set(KEY, bad)
    let ok = true
    try {
      ok = store.load('sim|lo|42').events.length === 0
    } catch {
      ok = false
    }
    check(ok, `damaged storage (${bad}) gives an empty history without throwing`)
  }
  fresh()
  const day = new Date().toLocaleDateString('sv')
  backing.set(KEY, JSON.stringify({ day, scopes: { 'sim|lo|42': { events: [{ event: 'open', id: 3 }, { ...open(alert('tilt', 5)), session: 'A' }, null], ends: { A: 'x', B: 7 }, carry: { tilt: { since: 'a' } } } } }))
  const s = store.load('sim|lo|42')
  check(s.events.length === 1 && s.ends.B === 7 && s.ends.A === undefined && Object.keys(s.carry).length === 0, 'damaged entries are dropped, the rest kept')

  fresh()
  calls.failSet = true
  store.add('k', 'A', [open(alert('tilt', 1))])
  flush()
  check(store.load('k').events.length === 1, 'setItem throwing leaves the history in memory')
  fresh()
  calls.failGet = true
  check(store.load('k').events.length === 0, 'getItem throwing gives an empty history')
  store.add('k', 'A', [open(alert('tilt', 1))])
  check(store.load('k').events.length === 1, 'getItem throwing: the memory path works')
}

// -- 7. the 200-event cap, one write for many events, replay writes nothing ---------------------------------------------------------------
{
  fresh()
  const many = Array.from({ length: MAX_STORED_EVENTS + 50 }, (_, i) => open(alert(`a${i}`, 100 + i)))
  store.add('k', 'A', many)
  flush()
  const s = store.load('k')
  check(s.events.length === MAX_STORED_EVENTS && s.events[s.events.length - 1].id === `a${MAX_STORED_EVENTS + 49}`, `the store keeps the newest ${MAX_STORED_EVENTS}`)

  fresh()
  for (let i = 0; i < 50; i++) store.add('k', 'A', [open(alert(`b${i}`, 100 + i))])
  check(calls.set === 0, 'queued events are not written one by one')
  flush()
  check(calls.set === 1, `50 queued events make one write (${calls.set})`)
  store.add('k', 'A', [open(alert('b0', 100))]) // the same event again
  flush()
  check(calls.set === 1, 'an event already stored is not written again')

  fresh()
  const p = new Page()
  p.hello(helloOf('R', 1, { source: 'replay' }))
  p.aux(5, [alert('tilt', 4)], [open(alert('tilt', 4))])
  p.aux(6, [], [close(alert('tilt', 4), 5, 1)])
  flush()
  check(calls.set === 0 && !backing.has(KEY), 'replay stores nothing')
  check(p.state.alertLog.length === 2 && p.state.alertLog.every((e) => !e.earlier), 'replay still collects the events in memory')

  fresh()
  const q = new Page()
  q.hello(helloOf('A', 1000))
  q.fsm([])
  for (let t = 1001; t < 1100; t++) q.aux(t, [])
  flush()
  check(calls.set === 0, 'frames without alert events write nothing')
}

// -- 8. the common aux frame costs nothing extra ---------------------------------------------------------------------------------------------
{
  fresh()
  const p = new Page()
  p.hello(helloOf('A', 1000))
  p.fsm([])
  const before = p.state.alertLog
  const r = reduceAux(p.state, { type: 'aux', t: 1001, alerts: [], alertEvents: [], demand: [], segment: null })
  check(r.persist === null && r.patch.alertLog === undefined, 'an aux frame without events leaves the log alone')
  p.aux(1001, [])
  check(p.state.alertLog === before, 'the log array is the same object after a quiet frame')
  const old = new Page() // an older bridge: no session, the page makes one up
  old.hello({ ...helloOf('', 0), session: { id: 'page-x', startedAt: undefined } })
  old.fsm([])
  old.aux(5, [], [open(alert('tilt', 5))])
  check(old.state.alertLog.length === 1 && old.state.alertCarry === undefined, 'a bridge without a start time never carries')
  check(MAX_ALERT_LOG === 200, 'the log cap is unchanged')
}

store.reset()
if (failed) {
  console.error(`\n${failed} alert-history check(s) failed (${passed} passed)`)
  process.exit(1)
}
console.log(`alert history: all ${passed} checks passed`)
