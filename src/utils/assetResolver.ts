// Finds the imported file a robot description refers to. Robot files name their meshes and includes in many ways
// (package://, model://, file://, $(find pkg), paths relative to the file, absolute paths from the author's PC), and the
// files the user imports are only ever in memory. Every reference resolves to an imported file or to nothing: the
// resolver fetches nothing, and a path that climbs out of the imported folder is not followed. When a reference is
// matched other than exactly, the import report says so.
import type { ImportReport } from './importReport'

/** The path part of a reference: no query or fragment, forward slashes, percent-decoded, no `blob:` prefix. */
function cleanRef(raw: string): string {
  const p = raw.split('?')[0].split('#')[0].replace(/\\/g, '/').replace(/^blob:/i, '')
  try {
    return decodeURIComponent(p)
  } catch {
    return p // keep the undecoded path
  }
}

/** Lower-cased, scheme/host-free, `.`/`..`-collapsed path. `package://pkg/a/../b.stl` -> `pkg/b.stl`. */
export function normalizeAssetPath(raw: string): string {
  let p = cleanRef(raw)
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(p)
  if (m) {
    p = /^https?$/i.test(m[1]) ? m[2].split('/').slice(1).join('/') : m[2] // drop host:port, keep package name
  }
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg.toLowerCase())
  }
  return out.join('/')
}

/** `dir` (normalized segments) joined with a relative reference; null when `..` climbs above the top of the import. */
export function joinBundlePath(dir: string[], rel: string): string | null {
  const out = [...dir]
  for (const seg of cleanRef(rel).split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(seg.toLowerCase())
  }
  return out.join('/')
}

interface AssetEntry {
  segs: string[]
  url: string
  path: string
}

export interface AssetMatch {
  url: string | null
  /** The imported file's normalized path, or null when nothing matched. */
  path: string | null
  /** Other files that matched equally well; non-empty means the choice was a guess. */
  ambiguousWith: string[]
  /** How many trailing path segments the match shares with the request. */
  shared: number
}

export interface Resolved extends AssetMatch {
  /** `exact`: the file the reference names. `substituted`: a file matched another way (reported). `missing`: none. */
  how: 'exact' | 'substituted' | 'missing'
}

export interface ResolveOptions {
  /** The imported file the reference is written in; relative references are read against its folder. */
  from?: string
  report?: ImportReport
}

const NONE: AssetMatch = { url: null, path: null, ambiguousWith: [], shared: 0 }

/** Number of trailing path segments two paths share. */
function commonSuffix(a: string[], b: string[]): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

function commonPrefix(a: string[], b: string[]): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

const dirSegs = (path: string): string[] => (path ? path.split('/').slice(0, -1) : [])

const AMBIGUOUS_HINT = 'Import the whole robot folder so the paths can tell them apart.'

export class AssetIndex {
  private byBase = new Map<string, AssetEntry[]>()
  private byPath = new Map<string, AssetEntry[]>()

  add(path: string, url: string): void {
    const norm = normalizeAssetPath(path)
    const segs = norm.split('/')
    const entry = { segs, url, path: norm }
    const base = segs[segs.length - 1]
    this.byBase.set(base, [...(this.byBase.get(base) ?? []), entry])
    this.byPath.set(norm, [...(this.byPath.get(norm) ?? []), entry])
  }

  /** The file at exactly this path (case-insensitive). */
  exact(path: string): AssetMatch {
    const norm = normalizeAssetPath(path)
    const hits = this.byPath.get(norm)
    if (!hits) return NONE
    const others = hits.slice(1).filter((h) => h.url !== hits[0].url)
    return { url: hits[0].url, path: hits[0].path, ambiguousWith: others.map((h) => h.path), shared: hits[0].segs.length }
  }

  /**
   * Picks the file sharing the most trailing path segments with the request. A tie goes to the file nearest `near`
   * (the referring file's folder), and is reported as ambiguous only when that does not settle it.
   */
  find(request: string, near: string[] = []): AssetMatch {
    const segs = normalizeAssetPath(request).split('/')
    const candidates = this.byBase.get(segs[segs.length - 1])
    if (!candidates) return NONE
    let best = -1
    let winners: AssetEntry[] = []
    for (const c of candidates) {
      const score = commonSuffix(segs, c.segs)
      if (score > best) {
        best = score
        winners = [c]
      } else if (score === best) {
        winners.push(c)
      }
    }
    if (winners.length > 1 && near.length > 0) {
      const closeness = winners.map((w) => commonPrefix(near, w.segs))
      const top = Math.max(...closeness)
      winners = winners.filter((_, i) => closeness[i] === top)
    }
    const distinct = new Set(winners.map((w) => w.url))
    return {
      url: winners[0].url,
      path: winners[0].path,
      ambiguousWith: distinct.size > 1 ? winners.slice(1).map((w) => w.path) : [],
      shared: best,
    }
  }

  /** Resolves a reference as a robot file writes it. Matches that are not exact are added to the report. */
  resolve(ref: string, opts: ResolveOptions = {}): Resolved {
    const raw = ref.trim()
    const report = opts.report
    if (!raw) return { ...NONE, how: 'missing' }
    if (/^data:/i.test(raw)) return { ...NONE, url: raw, how: 'exact' }
    const near = opts.from ? dirSegs(normalizeAssetPath(opts.from)) : []
    const done = (m: AssetMatch, how: 'exact' | 'substituted', message: string, where = raw): Resolved => {
      if (!m.url) return { ...m, how: 'missing' }
      if (m.ambiguousWith.length > 0) {
        report?.add('substitution', 'A file name matches several imported files; one was picked.', { where: raw, hint: AMBIGUOUS_HINT })
      }
      if (how === 'substituted') report?.add('substitution', message, { where })
      return { ...m, how }
    }

    // package://pkg/rel, model://pkg/rel and $(find pkg)/rel: the package is a folder somewhere in the import
    const pkg = /^\$\(find\s+([^)\s]+)\)[/\\]*(.*)$/.exec(raw) ?? /^(?:package|model):\/\/([^/\\]+)[/\\]*(.*)$/i.exec(raw)
    if (pkg) {
      const [, name, rel] = pkg
      const relSegs = normalizeAssetPath(rel).split('/').filter(Boolean)
      if (relSegs.length === 0) return { ...NONE, how: 'missing' }
      const want = [name.toLowerCase(), ...relSegs]
      const m = this.find(want.join('/'), near)
      if (!m.url) return { ...m, how: 'missing' }
      if (m.shared >= want.length) return done(m, 'exact', '')
      const label = raw.startsWith('$(') ? `$(find ${name})` : `${raw.slice(0, raw.indexOf('://') + 3)}${name}`
      if (m.shared === relSegs.length) {
        const folder = m.path!.split('/').slice(0, -relSegs.length).join('/')
        return done(m, 'substituted', `${label} is not a folder in the import; it was read from ${folder ? `${folder}/` : 'the top of the import'}.`)
      }
      return done(m, 'substituted', `${label} files were matched by name, not by their full path.`, `${raw} → ${m.path}`)
    }

    // file:// and absolute paths (POSIX, Windows, UNC) are from the author's PC: match them by their end
    const file = /^file:\/\/(?:localhost)?(.*)$/i.exec(raw)
    if (file || /^(?:[a-z]:)?[\\/]/i.test(raw)) {
      const m = this.find(normalizeAssetPath(file ? file[1] : raw), near)
      return done(m, 'substituted', 'An absolute file path was matched to an imported file by the end of its path.', `${raw} → ${m.path}`)
    }

    // any other scheme (http, https, ...) is never fetched
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      const m = this.find(normalizeAssetPath(raw), near)
      return done(m, 'substituted', 'A web address is never fetched; an imported file with the same name was used.', `${raw} → ${m.path}`)
    }

    // a path relative to the referring file
    const joined = joinBundlePath(near, raw)
    if (joined !== null) {
      const e = this.exact(joined)
      if (e.url) return done(e, 'exact', '')
    } else {
      report?.add('limit', 'A relative path climbs out of the imported folder, so it was not followed.', { where: raw })
    }
    const m = this.find(normalizeAssetPath(raw), near)
    return done(m, 'substituted', 'A relative path did not lead to an imported file; a file with the same name was used.', `${raw} → ${m.path}`)
  }
}
