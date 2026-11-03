// Prints each plan-step-7 target against the observer's results.csv, as counts ("4 of 5"), not percentages.
//   node scripts/summarize-operator-test.mjs docs/operator-test/results.csv
//   node scripts/summarize-operator-test.mjs --self-test
// "Met" means met in this small sample. It says nothing about whether the screen is safe.
import { readFileSync } from 'node:fs'

const COLUMNS = ['participant', 'condition', 'task', 'scene', 'pass', 'seconds', 'help']

export function parseResults(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const header = lines[0].split(',').map((h) => h.trim())
  for (const c of COLUMNS) if (!header.includes(c)) throw new Error(`results.csv has no "${c}" column`)
  return lines.slice(1).map((line) => {
    const f = line.split(',')
    const row = {}
    header.forEach((h, i) => {
      // notes is last and may contain commas
      row[h] = (h === 'notes' && i === header.length - 1 ? f.slice(i).join(',') : (f[i] ?? '')).trim()
    })
    row.ok = row.pass.toLowerCase() === 'yes'
    row.helped = row.help.toLowerCase() === 'yes'
    row.s = row.seconds === '' ? NaN : Number(row.seconds)
    return row
  })
}

const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (v.length === 0) return null
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

export function summarize(rows) {
  const by = (task) => rows.filter((r) => r.task === task)
  const targets = []
  const add = (name, target, list, met) => {
    const hit = list.filter(met).length
    targets.push({ name, target, n: list.length, hit, median: median(list.map((r) => r.s)), people: new Set(list.map((r) => r.participant)).size })
  }
  // a glance row with a time (timed drill, or a longer flash) only counts if it was read within 2 s
  add('Glance 2 s: state and abort answer right', 'every scene right, read within 2 s', by('glance'), (r) => r.ok && !(r.s > 2))
  add('After a fall: first alert named', 'under 10 s', by('first_alert'), (r) => r.ok && r.s < 10)
  add('New user reaches live sim data', 'under 3 min, no help', by('launch'), (r) => r.ok && r.s <= 180 && !r.helped)
  add('Ankle left vs right peak found', 'under 30 s', by('peak'), (r) => r.ok && r.s <= 30)
  add('Keyboard only / screen reader: task completed', 'all completable', rows.filter((r) => r.condition === 'keyboard' || r.condition === 'screenreader'), (r) => r.ok && !r.helped)
  return targets
}

export function render(targets) {
  const out = ['Operator test against the step 7 targets (counts in this sample, not rates)', '']
  for (const t of targets) {
    const state = t.n === 0 ? 'no data yet' : t.hit === t.n ? 'met' : 'NOT met'
    const med = t.median === null ? '' : `, median ${t.median} s`
    out.push(`  [${state}] ${t.name}: ${t.hit} of ${t.n} (${t.people} people)${med}. Target: ${t.target}.`)
  }
  out.push('', 'Read the notes column for why each miss happened. "Met" does not mean safe.')
  return out.join('\n')
}

function selfTest() {
  let ok = true
  const check = (c, what) => { console.log(`  [${c ? '✓' : '✗'}] ${what}`); ok = ok && c }
  const csv = [
    'participant,condition,task,scene,pass,seconds,help,notes',
    'P1,mouse,glance,A,yes,2,no,fine',
    'P1,mouse,glance,B,no,2,no,"said Passive, wrong"',
    'P1,mouse,first_alert,,yes,8,no,',
    'P2,mouse,first_alert,,yes,12,no,slow',
    'P1,mouse,launch,,yes,170,no,',
    'P2,mouse,launch,,yes,100,yes,asked for the command',
    'P1,mouse,glance,C,yes,20.0,no,right answer but read in 20 s',
    'P1,mouse,peak,,yes,30,no,',
    'P2,keyboard,peak,,no,40,no,could not reach the plot',
  ].join('\n')
  const rows = parseResults(csv)
  check(rows.length === 9, 'reads every row')
  check(rows[1].notes === '"said Passive, wrong"', 'keeps commas inside notes')
  const t = summarize(rows)
  check(t[0].hit === 1 && t[0].n === 3, 'glance counts only right scenes read within 2 s (a right answer after 20 s does not count)')
  check(t[1].hit === 1 && t[1].n === 2 && t[1].median === 10, 'first alert: a right answer after 10 s does not count')
  check(t[2].hit === 1 && t[2].n === 2, 'launch: a helped run does not count')
  check(t[3].hit === 1 && t[3].n === 2, 'peak: exactly 30 s counts, a wrong answer does not')
  check(t[4].hit === 0 && t[4].n === 1, 'keyboard row that failed is counted as a miss')
  check(summarize([]).every((x) => x.n === 0), 'empty file: no data, no crash')
  check(!/%/.test(render(t)), 'prints counts, not percentages')
  check(/NOT met/.test(render(t)) && /no data yet/.test(render(summarize([]))), 'says NOT met and no data yet in words')
  let threw = false
  try { parseResults('a,b\n1,2') } catch { threw = true }
  check(threw, 'rejects a file without the expected columns')
  console.log(ok ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED')
  return ok
}

const arg = process.argv[2]
if (arg === '--self-test') process.exit(selfTest() ? 0 : 1)
else if (arg) console.log(render(summarize(parseResults(readFileSync(arg, 'utf8')))))
else if (process.argv[1]?.endsWith('summarize-operator-test.mjs')) { console.error('usage: node scripts/summarize-operator-test.mjs <results.csv> | --self-test'); process.exit(2) }
