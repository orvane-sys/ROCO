// Used by scripts/regress.py (case R4): the report of a recording that was played to a moment must equal the report of a page that
// jumped to that moment. Each argument is a file of the frames one dashboard received (one JSON text frame per line; a line
// {"seek": t} marks where that page asked for the jump). The frames go through the page's own code, as telemetryStream and App do
// with them: monitorReducer (hello / fsm / aux), the timeline's alert merge, and the session report.
//
//   node scripts/check-regress-report.mjs play.jsonl seek.jsonl      (SHOW=1 also prints the played run's report)
//
// The two reports must be equal, apart from these named differences:
//   * the time the report was made: not in the text here (the same fixed date is given to both);
//   * seconds into the recording of an alert's start or end: the bridge stamps alert rows in batches of its 500 Hz samples and a jump
//     restarts that batching, so such a time may differ by up to ALERT_TIME_TOL_S;
//   * a segment's durations: the bridge works them out from its latest median sample time when it sends them, so a page that jumped has
//     them from a later median than one that played past the segment's end. They may differ by SEGMENT_TIME_TOL, or by the fraction
//     given with --segment-tol: the simulator's sample interval jitters around 1.1 ms, so its median keeps moving by about 1 % over a run,
//     where a robot's stays put. scripts/check-demo.mjs measures how far it moved in its sample and passes that.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = new URL('..', import.meta.url)
const path = (p) => fileURLToPath(new URL(p, root))
const ALERT_TIME_TOL_S = 0.3
const argv = process.argv.slice(2)
const tolAt = argv.indexOf('--segment-tol')
const SEGMENT_TIME_TOL = tolAt >= 0 ? Number(argv.splice(tolAt, 2)[1]) : 0.002

const load = async (file) => {
  const b = await rolldown({ input: path(file), logLevel: 'silent' })
  const { output } = await b.generate({ format: 'esm' })
  await b.close()
  return import('data:text/javascript;base64,' + Buffer.from(output[0].code.replaceAll('import.meta.env.BASE_URL', '"/"')).toString('base64'))
}
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const { reduceHello, reduceFsm, reduceAux } = await load('src/services/monitorReducer.ts')
const { buildAlertView } = await load('src/utils/alertModel.ts')
const { mergeTimelineAlerts, buildTimeline } = await load('src/utils/timelineModel.ts')
const { buildReport } = await load('src/utils/sessionReport.ts')

const [playFile, seekFile] = argv
if (!playFile || !seekFile) {
  console.error('usage: node scripts/check-regress-report.mjs play.jsonl seek.jsonl')
  process.exit(2)
}

/** What a dashboard that received these frames shows in its report. */
function run(file) {
  let state = { hello: null, aux: null, fsm: { state: null, since: null, events: [], segments: [], segment: null }, replay: null, alertLog: [] }
  let alerts = []
  let seekT = null
  let n = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    const f = JSON.parse(line)
    if (f.seek !== undefined) {
      seekT = f.seek
      continue
    }
    if (f.type === 'hello') {
      state = { ...state, ...{ aux: null, fsm: { state: null, since: null, events: [], segments: [], segment: null }, replay: null, timeline: undefined, alertLog: [] }, ...reduceHello(f, null, '') }
      alerts = []
    } else if (f.type === 'fsm') state = { ...state, ...reduceFsm(state, f).patch }
    else if (f.type === 'aux') state = { ...state, ...reduceAux(state, f).patch }
    else if (f.type === 'replay') state = { ...state, replay: f }
    else if (f.type === 'timeline') state = { ...state, timeline: f }
    else continue
    n++
    alerts = mergeTimelineAlerts(alerts, buildAlertView(state), seekT)
  }
  const timeline = buildTimeline(state, alerts, [], { first: null, last: null })
  const text = buildReport({
    state,
    profileName: 'regress',
    generatedAt: new Date(0),
    timeline,
    alertTitle: (a) => a.id,
    abortChecks: [],
    procedure: null,
  })
  return { text, frames: n, t: state.replay?.t, t0: state.replay?.t0 }
}

const play = run(playFile)
if (process.env.SHOW) console.log(play.text)
const seek = run(seekFile)
const lines = (s) => s.text.split('\n')
const a = lines(play)
const b = lines(seek)

// "12.3 s" tokens and the time column of a table row, the times of the recording
const TIME = /(-?\d+(?:\.\d+)?) s\b|^\| (-?\d+(?:\.\d+)?)(?= \|)/g
const times = (s) => [...s.matchAll(TIME)].map((m) => Number(m[1] ?? m[2]))
const shape = (s) => s.replace(TIME, '# s')
// a table row's "12.3 s", "3235 ms" and the "(3229)" of the longest run
const DURATION = /(\d+(?:\.\d+)?)(?= m?s\b|\))/g
const durations = (s) => [...s.matchAll(DURATION)].map((m) => Number(m[1]))
// one unit of a shown duration's last digit: with a moving median, 9.649 s and 9.651 s round to 9.6 and 9.7
const units = (s) => [...s.matchAll(DURATION)].map((m) => 10 ** -(m[1].split('.')[1]?.length ?? 0))
const segmentShape = (s) => s.replace(DURATION, '#')

const problems = []
let tolerated = 0
let segmentRows = 0
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  const x = a[i] ?? '(missing)'
  const y = b[i] ?? '(missing)'
  if (x === y) continue
  const alertLine = /\balert|tilt|motorstate|temp:|range:/i.test(x) || /\balert|tilt|motorstate|temp:|range:/i.test(y)
  const tx = times(x)
  const ty = times(y)
  const close = tx.length === ty.length && tx.every((v, k) => Math.abs(v - ty[k]) <= ALERT_TIME_TOL_S + 0.051)
  if (alertLine && shape(x) === shape(y) && close) {
    tolerated++
    continue
  }
  const dx = durations(x)
  const dy = durations(y)
  const ux = units(x)
  const slack = (v, k) => (SEGMENT_TIME_TOL > 0.002 ? ux[k] : 0) + SEGMENT_TIME_TOL * Math.max(v, dy[k])
  if (x.startsWith('|') && segmentShape(x) === segmentShape(y) && dx.every((v, k) => Math.abs(v - dy[k]) <= slack(v, k) + 1e-9)) {
    segmentRows++
    continue
  }
  problems.push(`line ${i + 1}:\n    played: ${x}\n    jumped: ${y}`)
}
if (play.t === undefined || Math.abs(play.t - seek.t) > 0.05) problems.unshift(`the two pages are not at the same moment (${play.t} / ${seek.t})`)

if (problems.length) {
  console.error(`the report after a jump differs from the played one in ${problems.length} place(s):`)
  for (const p of problems.slice(0, 8)) console.error('  ' + p)
  process.exit(1)
}
console.log(`reports equal: ${a.length} lines at ${(play.t - play.t0).toFixed(1)} s${tolerated ? `, ${tolerated} alert time(s) within ${ALERT_TIME_TOL_S} s` : ''}${segmentRows ? `, ${segmentRows} segment row(s) within ${(SEGMENT_TIME_TOL * 100).toFixed(2)} %` : ''}`)
