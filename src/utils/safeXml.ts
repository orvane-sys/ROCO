// XML parsing for imported files, and the import's time limit. The files are untrusted: one DOMParser call cannot be
// interrupted, so its input is bounded first (the text size cap, and no entities, which are how a small file expands into a
// huge one). Every converter loop then checks the Deadline, so a file that expands slowly ends in an error, never a hang.
import { LIMITS, ImportRefused, refuse, refusalMessage } from './importLimits'

/** The import ran past its time limit. */
export class ImportTimeout extends ImportRefused {
  constructor(detail: string) {
    super('timeout', detail, refusalMessage('timeout', detail))
    this.name = 'ImportTimeout'
  }
}

/** The import's time limit. `check()` is cheap enough to call once per element. */
export class Deadline {
  private readonly end: number
  constructor(ms: number = LIMITS.importMs) {
    this.end = performance.now() + ms
  }
  /** Throws ImportTimeout once the time is up; `where` says what was running. */
  check(where: string): void {
    if (performance.now() > this.end) throw new ImportTimeout(where)
  }
}

// An ENTITY declaration can only appear inside a DOCTYPE, but refusing the text anywhere keeps the check simple: no robot
// description format uses entities, and a file that mentions one in a comment is still not a robot worth the risk.
const ENTITY = /<!ENTITY/i

/** Where a DOMParser error was, from the text Chrome (`error on line 3 at column 5: ...`) or Firefox (`Line Number 3, Column 5`) gives. */
function parseErrorText(err: Element): string {
  const text = err.textContent ?? ''
  const chrome = /error on line (\d+) at column (\d+):\s*([^\n]*)/i.exec(text)
  if (chrome) return `line ${chrome[1]}, column ${chrome[2]}: ${chrome[3].trim()}`
  const firefox = /Line Number (\d+), Column (\d+)/i.exec(text)
  if (firefox) return `line ${firefox[1]}, column ${firefox[2]}`
  return text.trim().split('\n')[0].slice(0, 200) || 'parse error'
}

/**
 * Parses one imported description file. Throws ImportRefused: `too big` over the text cap, `entity` when it declares an
 * entity, `xml` (with the line and column) when it is not well-formed.
 */
export function parseXmlSafe(text: string, name: string, deadline?: Deadline): Document {
  // a JS string's length is at most its UTF-8 size, so this never refuses a file under the cap
  if (text.length > LIMITS.textFile) throw refuse('too big', `${name}: ${Math.round(text.length / 2 ** 20)} MiB`)
  if (ENTITY.test(text)) throw refuse('entity', name)
  deadline?.check(`reading ${name}`)
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  const err = doc.getElementsByTagName('parsererror')[0]
  if (err) throw refuse('xml', `${name}, ${parseErrorText(err)}`)
  return doc
}
