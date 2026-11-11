// Checks the saved page choices that a screenshot cannot show: the workspace notes (shown once, gone after a reload, back when the
// saved value is damaged or the store is blocked) and that the other choices survive a reload. It bundles src/services/uiPrefs.ts
// with rolldown and runs it with an in-memory localStorage, loading it again for each case as a reload would.
//
//   node scripts/check-prefs.mjs
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = new URL('..', import.meta.url)
const path = (p) => fileURLToPath(new URL(p, root))

const b = await rolldown({ input: path('src/services/uiPrefs.ts'), logLevel: 'silent' })
const { output } = await b.generate({ format: 'esm' })
await b.close()
const code = output[0].code
let loads = 0
const load = () => import('data:text/javascript;base64,' + Buffer.from(code + `\n//load ${loads++}`).toString('base64'))

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

// the bits of the page that applying a choice touches
globalThis.document = { documentElement: { dataset: {}, style: {} }, querySelector: () => null }
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })

let store = new Map()
let blocked = false
globalThis.localStorage = {
  getItem: (k) => {
    if (blocked) throw new Error('blocked')
    return store.has(k) ? store.get(k) : null
  },
  setItem: (k, v) => {
    if (blocked) throw new Error('blocked')
    store.set(k, String(v))
  },
}
const KEY = 'roco.ui.v1'
const reset = (saved) => {
  store = new Map()
  blocked = false
  if (saved !== undefined) store.set(KEY, typeof saved === 'string' ? saved : JSON.stringify(saved))
}

// useUiPrefs needs React, so what is checked is the saved string and loadIntros
const saved = () => JSON.parse(store.get(KEY) ?? 'null')

{
  const m = await load()
  check(same(m.loadIntros(undefined), []), 'loadIntros: nothing saved gives no seen notes')
  check(same(m.loadIntros('run'), []), 'loadIntros: a string gives none')
  check(same(m.loadIntros({ run: true }), []), 'loadIntros: an object gives none')
  check(same(m.loadIntros(['run', 'nope', 3, null, 'review']), ['run', 'review']), 'loadIntros: unknown entries are dropped, the valid ones kept')
  check(same(m.loadIntros(['review', 'run', 'run']), ['run', 'review']), 'loadIntros: each workspace once, in tab order')
}

// first visit: nothing seen, marking saves, a reload keeps it
{
  reset()
  const m = await load()
  m.markIntroSeen('run')
  check(same(saved().intros, ['run']), 'markIntroSeen saves the workspace')
  m.markIntroSeen('run')
  check(same(saved().intros, ['run']), 'marking twice saves it once')
  m.markIntroSeen('review')
  check(same(saved().intros, ['run', 'review']), 'a second workspace is added')
  const again = await load()
  check(same(again.loadIntros(saved().intros), ['run', 'review']), 'after a reload the saved list is read back')
}

// the other choices are kept when a note is marked, and the note survives changing them
{
  reset({ theme: 'light', textScale: 130, workspace: 'review', sound: true, intros: ['run'] })
  const m = await load()
  m.markIntroSeen('analyze')
  m.setTheme('dark')
  const s = saved()
  check(same(s.intros, ['run', 'analyze']), 'a choice changed later keeps the notes')
  check(s.theme === 'dark' && s.textScale === 130 && s.workspace === 'review' && s.sound === true, 'marking a note keeps the other saved choices')
}

// the 3D camera stays still unless the viewer turns heading-follow on, and the choice survives a reload
{
  reset()
  let m = await load()
  m.setTheme('dark')
  check(saved().followHeading === false, 'followHeading: off on a first visit')
  m.setFollowHeading(true)
  check(saved().followHeading === true, 'setFollowHeading saves it')
  m = await load()
  m.setTheme('light')
  check(saved().followHeading === true, 'followHeading: read back after a reload')
  reset({ followHeading: 'yes', theme: 'light' })
  m = await load()
  m.setTextScale(115)
  check(saved().followHeading === false && saved().theme === 'light', 'followHeading: a damaged value gives off, the rest is kept')
}

// damaged stores: the notes show again instead of never, and nothing throws
for (const [what, value] of [
  ['bad JSON', '{not json'],
  ['a number', '5'],
  ['null', 'null'],
  ['intros of the wrong type', { intros: 'run' }],
  ['intros with unknown entries only', { intros: ['x', 4] }],
]) {
  reset(value)
  let ok = true
  try {
    const m = await load()
    m.markIntroSeen('run')
    check(same(saved()?.intros, ['run']), `${what}: marking still saves`)
  } catch (e) {
    ok = false
    console.error(e)
  }
  check(ok, `${what}: loading and marking does not throw`)
}

// a blocked store: marking does not throw and the page keeps working
{
  reset()
  blocked = true
  let ok = true
  try {
    const m = await load()
    m.markIntroSeen('run')
    m.setWorkspace('analyze')
  } catch {
    ok = false
  }
  check(ok, 'a blocked store does not throw on load or save')
}

// a store that fails only on writing (full)
{
  reset()
  const m = await load()
  const set = localStorage.setItem
  localStorage.setItem = () => {
    throw new Error('quota')
  }
  let ok = true
  try {
    m.markIntroSeen('analyze')
  } catch {
    ok = false
  }
  localStorage.setItem = set
  check(ok, 'a full store does not throw when a note is marked')
}

console.log(`check-prefs: ${passed} checks passed`)
if (failed > 0) {
  console.error(`check-prefs: ${failed} FAILED`)
  process.exit(1)
}
