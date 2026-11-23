// Reads a robot model from a public GitHub repository at one commit into in-memory files for importRobotFiles. Only two hosts
// are asked, the two the page's Content Security Policy allows (vite.config.ts): api.github.com for the commit and the file
// list, and raw.githubusercontent.com for the files. No token is ever sent, so only public repositories can be read, and the
// API allows 60 calls an hour from one network: a look-up makes at most 4 (3 tries at the branch or tag, then the file list).
// Symbolic links in the repository are not followed: they are listed, like Git LFS files, and not downloaded.
// Loaded only by the import dialog. The limits are in docs/import-formats.md.
import { TEXT_FILE, refuse, sizeLimitFor } from './importLimits'

const MiB = 2 ** 20

export const GITHUB_LIMITS = {
  files: 2000,
  bytes: 512 * MiB,
  /** Files downloaded at once. */
  parallel: 6,
  /** A look-up, and then the download, each stop after this long. */
  ms: 120_000,
  /** Ways a link's `<ref>/<path>` is split when the branch or tag name may hold a slash. */
  refSplits: 3,
} as const

/** The files the importer reads: descriptions (TEXT_FILE), meshes, and the textures and buffers meshes name. */
export const FETCHED = /\.(urdf|xacro|xml|sdf|config|ya?ml|stl|dae|obj|glb|gltf|bin|png|jpe?g)$/i

const OWNER = /^[A-Za-z0-9-]{1,39}$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
const SHA = /^[0-9a-f]{40}$/
const LFS = 'version https://git-lfs.github.com/spec/'

export type GithubErrorCode = 'url' | 'not found' | 'path' | 'rate' | 'truncated' | 'too many' | 'lfs' | 'network' | 'time' | 'http'

/** A look-up or download that stopped. `code` is stable (the checks match on it); `message` is for the user. */
export class GithubError extends Error {
  readonly code: GithubErrorCode
  constructor(code: GithubErrorCode, message: string) {
    super(message)
    this.name = 'GithubError'
    this.code = code
  }
}

/** A link, read but not yet looked up. `rest` is what follows the repository: the branch, tag or commit, then the path. */
export interface GithubLink {
  owner: string
  repo: string
  rest: string[]
  /** The commit of a shared link (`gh:owner/repo@sha/path`): `rest` is then only the path, empty for the top of the repository. */
  sha?: string
  /** A folder link (`/tree/`) may name the top of the repository, with no path after the branch. */
  folder: boolean
}

const badUrl = (why: string) =>
  new GithubError('url', `That is not a GitHub link ROCO can read (${why}). Paste a github.com link to a file or folder, like https://github.com/owner/repo/blob/main/urdf/robot.urdf.`)

/** Decoded path segments; a segment that is empty, `.`, `..` or holds a slash, backslash or NUL is refused. */
function segments(parts: string[], allowTrailingSlash: boolean): string[] {
  const out = parts.map((p) => {
    try {
      return decodeURIComponent(p)
    } catch {
      throw badUrl('a part of its path is not valid')
    }
  })
  if (allowTrailingSlash && out.length > 0 && out[out.length - 1] === '') out.pop()
  for (const s of out) {
    if (s === '' || s === '.' || s === '..' || /[/\\\0]/.test(s)) throw badUrl('its path has an empty, "." or ".." part')
  }
  return out
}

/** 2 when `rest` names its branch or tag in full (`refs/heads/<name>`, `refs/tags/<name>`, as GitHub's Raw button does), else 0. */
const refsPrefix = (rest: string[]) => (rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags') ? 2 : 0)

function ownerRepo(owner: string, repo: string): { owner: string; repo: string } {
  if (!OWNER.test(owner)) throw badUrl('the owner name is not a GitHub name')
  if (!REPO.test(repo) || repo === '.' || repo === '..') throw badUrl('the repository name is not a GitHub name')
  return { owner, repo }
}

/**
 * Reads a link to a file or folder in a GitHub repository: `https://github.com/<owner>/<repo>/blob|raw|tree/<ref>/<path>`,
 * `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`, or a shared link's `gh:<owner>/<repo>@<40-hex sha>/<path>`
 * (an empty path is the top of the repository). `<ref>` may be written in full, `refs/heads/<name>` or `refs/tags/<name>`.
 * Nothing is fetched. Throws GithubError 'url'.
 */
export function parseGithubUrl(input: string): GithubLink {
  const s = input.trim()
  if (s.length === 0) throw badUrl('it is empty')
  if (s.length > 2048) throw badUrl('it is longer than 2048 characters')
  const shared = /^gh:([^/@]+)\/([^/@]+)@([^/]+)\/(.*)$/.exec(s)
  if (shared) {
    if (!SHA.test(shared[3])) throw badUrl('a shared link names a full 40-character commit')
    return { ...ownerRepo(shared[1], shared[2]), sha: shared[3], rest: segments(shared[4].split('/'), true), folder: true }
  }
  // checked before parsing: a web address resolves `.` and `..` (also written %2e), which could point at another repository
  if (/(?:^|[/\\])(?:\.|%2e){1,2}(?:[/\\?#]|$)/i.test(s)) throw badUrl('its path has a "." or ".." part')
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`)
  } catch {
    throw badUrl('it is not a web address')
  }
  if (url.protocol !== 'https:') throw badUrl('it does not start with https://')
  if (url.username || url.password || url.port) throw badUrl('it names a user, password or port')
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').slice(1)
  if (host === 'github.com' || host === 'www.github.com') {
    const [owner, repo, kind, ...rest] = parts
    // /raw/ is the Raw link of a file, which GitHub sends on to raw.githubusercontent.com
    if (kind !== 'blob' && kind !== 'raw' && kind !== 'tree') throw badUrl('a github.com link names /blob/ or /raw/ (a file) or /tree/ (a folder) after the repository')
    const link = { ...ownerRepo(owner ?? '', repo ?? ''), rest: segments(rest, kind === 'tree'), folder: kind === 'tree' }
    if (link.rest.length < (link.folder ? 1 : 2) + refsPrefix(link.rest)) throw badUrl('it names no branch and file')
    return link
  }
  if (host === 'raw.githubusercontent.com') {
    const [owner, repo, ...rest] = parts
    const link = { ...ownerRepo(owner ?? '', repo ?? ''), rest: segments(rest, false), folder: false }
    if (link.rest.length < 2 + refsPrefix(link.rest)) throw badUrl('it names no branch and file')
    return link
  }
  throw badUrl('it is not on github.com')
}

/** The shared link's value for `?model=`: the repository, the commit and the path, so it always shows the same files. */
export const sharedModel = (owner: string, repo: string, sha: string, path: string): string =>
  `gh:${owner}/${repo}@${sha}/${path.split('/').map(encodeURIComponent).join('/')}`

const enc = (segs: string[]) => segs.map(encodeURIComponent).join('/')
const clock = (epochSeconds: number) => new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The error for a GitHub answer that is not 200. */
async function answerError(res: Response, what: string): Promise<GithubError> {
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    if (res.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > 0) {
      return new GithubError('rate', `GitHub allows 60 requests an hour to its API from one network without signing in (a look-up uses up to 4), and they are used up. Try again after ${clock(reset)}, or download the repository as a zip and import that.`)
    }
    const wait = Number(res.headers.get('retry-after'))
    return new GithubError('rate', `GitHub is refusing more requests for now${Number.isFinite(wait) && wait > 0 ? `; try again in ${Math.ceil(wait / 60)} min` : '; try again in a few minutes'}, or download the repository as a zip and import that.`)
  }
  if (res.status === 404) return new GithubError('not found', `${what} was not found, or the repository is private. ROCO reads public repositories only.`)
  return new GithubError('http', `GitHub answered ${res.status} for ${what.toLowerCase()}.`)
}

/** Ends `inner` when `outer` ends (the dialog closed) or after the time limit, whichever comes first. */
function deadline(outer: AbortSignal | undefined): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const ctl = new AbortController()
  let late = false
  const timer = setTimeout(() => {
    late = true
    ctl.abort()
  }, GITHUB_LIMITS.ms)
  const stop = () => ctl.abort()
  if (outer?.aborted) ctl.abort()
  outer?.addEventListener('abort', stop)
  return {
    signal: ctl.signal,
    timedOut: () => late,
    // also stops the downloads still running when one of them failed
    done: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', stop)
      ctl.abort()
    },
  }
}

/** One request with no cookies and no referrer; a failure to connect (offline, or blocked) becomes GithubError 'network'. */
async function get(url: string, signal: AbortSignal, accept?: string): Promise<Response> {
  try {
    return await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', ...(accept ? { headers: { Accept: accept } } : {}) })
  } catch (e) {
    if (signal.aborted) throw e
    throw new GithubError('network', 'Could not reach GitHub. Check the connection, or download the repository as a zip and import that.')
  }
}

const api = (path: string, signal: AbortSignal, accept = 'application/vnd.github+json') => get(`https://api.github.com${path}`, signal, accept)

interface TreeBlob {
  path: string
  size: number
}

/** What a look-up found: the commit, the files to download (description files first) and their size. */
export interface GithubPlan {
  owner: string
  repo: string
  sha: string
  /** The linked file or folder, in the repository ('' for its top). */
  path: string
  isFile: boolean
  /** The folders whose files are taken: the linked file's package, and any other package of the repository it names. */
  scopes: string[]
  files: TreeBlob[]
  bytes: number
  /** Files that are Git LFS pointers, not the file itself; ROCO does not download from Git LFS. */
  lfs: string[]
  /** Symbolic links in the folders taken, of any name (a link to a folder of meshes matters too); ROCO does not follow them. */
  links: string[]
  /** API calls this look-up made. */
  calls: number
  /** The description files, already downloaded to find the packages they name. */
  texts: Map<string, Blob>
}

const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const under = (dir: string, p: string) => dir === '' || p.startsWith(`${dir}/`)

/** The package names a description file reaches for: `package://X/`, `$(find X)` and `model://X/`. */
export function namedPackages(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/(?:package|model):\/\/([^/\s"'<>]+)|\$\(find\s+([^)\s]+)\)/g)) {
    const name = m[1] ?? m[2]
    if (name && !/[$\\{}]/.test(name)) out.add(name)
  }
  return out
}

const isLfs = async (b: Blob) => b.size < 1024 && (await b.slice(0, LFS.length).text()) === LFS

/** Downloads `items` from raw.githubusercontent.com at `sha`, `parallel` at a time. */
async function download(plan: Pick<GithubPlan, 'owner' | 'repo' | 'sha'>, items: TreeBlob[], signal: AbortSignal, onDone?: () => void): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>()
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      const res = await get(`https://raw.githubusercontent.com/${enc([plan.owner, plan.repo, plan.sha])}/${enc(item.path.split('/'))}`, signal)
      if (!res.ok) throw await answerError(res, `The file ${item.path}`)
      const blob = await res.blob()
      // the file list gave its size; anything else means the answer is not that file
      if (blob.size !== item.size) throw new GithubError('http', `GitHub sent ${blob.size} bytes for ${item.path}, which is ${item.size} bytes at this commit.`)
      out.set(item.path, blob)
      onDone?.()
    }
  }
  await Promise.all(Array.from({ length: Math.min(GITHUB_LIMITS.parallel, items.length) }, worker))
  return out
}

/** Refuses a plan over the file-count or size cap, or holding a file over its own size cap, before anything is downloaded. */
function checkCaps(files: TreeBlob[]): number {
  if (files.length > GITHUB_LIMITS.files) {
    throw new GithubError('too many', `The model's folder holds ${files.length} files ROCO would read; the limit is ${GITHUB_LIMITS.files}. Download the repository as a zip and import the robot's folder.`)
  }
  let bytes = 0
  for (const f of files) {
    if (f.size > sizeLimitFor(f.path)) throw refuse('too big', `${f.path}: ${Math.round(f.size / MiB)} MiB`)
    bytes += f.size
  }
  if (bytes > GITHUB_LIMITS.bytes) {
    throw new GithubError('too many', `The model's folder holds ${Math.round(bytes / MiB)} MiB of files ROCO would read; the limit is ${GITHUB_LIMITS.bytes / MiB} MiB. Download the repository as a zip and import the robot's folder.`)
  }
  return bytes
}

/**
 * Looks a link up: finds its commit (a branch or tag is tried at up to 3 splits, since its name may hold a slash), lists the
 * repository's files at that commit once, and picks the folder to take: the nearest one above the linked file holding a
 * package.xml or model.config, or else the file's own folder. Its description files are downloaded, and any other package of
 * the same repository they name is taken too. Meshes are not downloaded yet. At most 4 API calls.
 */
export async function lookUp(input: string, outer?: AbortSignal): Promise<GithubPlan> {
  const link = parseGithubUrl(input)
  const { signal, timedOut, done } = deadline(outer)
  try {
    return await lookUpLink(link, signal)
  } catch (e) {
    if (timedOut()) throw new GithubError('time', `Looking the link up took longer than ${GITHUB_LIMITS.ms / 1000} s, so it was stopped.`)
    throw e
  } finally {
    done()
  }
}

async function lookUpLink(link: GithubLink, signal: AbortSignal): Promise<GithubPlan> {
  const { owner, repo } = link
  const base = `/repos/${enc([owner, repo])}`
  let calls = 0
  let sha = link.sha
  let pathSegs = link.rest
  if (!sha && SHA.test(link.rest[0])) {
    sha = link.rest[0]
    pathSegs = link.rest.slice(1)
  }
  if (!sha) {
    // a blob link needs at least one path segment after the ref; a folder link may stop at the ref. A ref written in full
    // (refs/heads/<name>) is tried from its name on: GitHub reads commits/refs/heads/<name> as the branch (seen 2026-11-23)
    const skip = refsPrefix(link.rest)
    const tries = Math.min(GITHUB_LIMITS.refSplits, (link.folder ? link.rest.length : link.rest.length - 1) - skip)
    for (let i = skip + 1; i <= skip + tries && !sha; i++) {
      calls++
      const res = await api(`${base}/commits/${enc(link.rest.slice(0, i))}`, signal, 'application/vnd.github.sha')
      // an unknown branch or tag is 422 "No commit found for SHA" (seen 2026-11-23); a missing or private repository is 404
      if (res.status === 422) continue
      if (!res.ok) throw await answerError(res, `The repository ${owner}/${repo}`)
      const got = (await res.text()).trim()
      if (!SHA.test(got)) throw new GithubError('http', 'GitHub did not answer with a commit for that branch or tag.')
      sha = got
      pathSegs = link.rest.slice(i)
    }
    if (!sha) throw new GithubError('not found', `No branch, tag or commit in the link was found in ${owner}/${repo}.`)
  }
  calls++
  const res = await api(`${base}/git/trees/${sha}?recursive=1`, signal)
  // a commit the repository does not have is 422 "Invalid object requested. SHA must identify a commit or a tree." (seen 2026-11-23)
  if (res.status === 422) throw new GithubError('not found', `The commit ${sha.slice(0, 7)} is not in ${owner}/${repo}. Check the link, or link to a branch instead.`)
  if (!res.ok) throw await answerError(res, `The commit ${sha.slice(0, 7)} of ${owner}/${repo}`)
  const tree: unknown = await res.json().catch(() => null)
  if (typeof tree !== 'object' || tree === null || !Array.isArray((tree as { tree?: unknown }).tree)) {
    throw new GithubError('http', 'GitHub did not answer with a file list.')
  }
  if ((tree as { truncated?: unknown }).truncated === true) {
    throw new GithubError('truncated', 'The repository is too large for GitHub to list in one answer. Download it as a zip and import the robot\'s folder.')
  }
  const blobs = new Map<string, number>()
  const symlinks = new Set<string>()
  const dirs = new Set<string>([''])
  for (const e of (tree as { tree: unknown[] }).tree) {
    const { path, type, size, mode } = (e ?? {}) as { path?: unknown; type?: unknown; size?: unknown; mode?: unknown }
    if (typeof path !== 'string') continue
    // a symbolic link is a blob of mode 120000 holding the path it points to, not the file it points to
    if (type === 'blob' && mode === '120000') symlinks.add(path)
    else if (type === 'blob' && typeof size === 'number' && Number.isFinite(size) && size >= 0) blobs.set(path, size)
    else if (type === 'tree') dirs.add(path)
  }

  const path = pathSegs.join('/')
  if (symlinks.has(path)) throw new GithubError('path', `${path} is a symbolic link, which ROCO does not follow. Link to the file it points to.`)
  const isFile = blobs.has(path)
  if (!isFile && !dirs.has(path)) throw new GithubError('path', `${path || 'That path'} is not in ${owner}/${repo} at commit ${sha.slice(0, 7)}.`)
  if (isFile && !/\.(urdf|xacro|xml|sdf)$/i.test(path)) throw new GithubError('path', `${path} is not a robot description (.urdf, .xacro, MuJoCo .xml or .sdf). Link to one, or to its folder.`)
  const isPackage = (d: string) => blobs.has(joinPath(d, 'package.xml')) || blobs.has(joinPath(d, 'model.config'))
  const start = isFile ? dirname(path) : path
  let scope = start
  for (let d = start; ; d = dirname(d)) {
    if (isPackage(d)) {
      scope = d
      break
    }
    if (d === '') break
  }

  const scopes: string[] = []
  const files: TreeBlob[] = []
  const taken = new Set<string>()
  const lfs: string[] = []
  const links: string[] = []
  const texts = new Map<string, Blob>()
  const take = async (dir: string) => {
    scopes.push(dir)
    for (const p of symlinks) if (under(dir, p) && !links.includes(p)) links.push(p)
    const add = [...blobs].filter(([p]) => under(dir, p) && FETCHED.test(p) && !taken.has(p)).map(([p, size]) => ({ path: p, size }))
    for (const f of add) taken.add(f.path)
    files.push(...add)
    checkCaps(files)
    const got = await download({ owner, repo, sha }, add.filter((f) => TEXT_FILE.test(f.path)), signal)
    const named = new Set<string>()
    for (const [p, blob] of got) {
      if (await isLfs(blob)) {
        lfs.push(p)
        continue
      }
      texts.set(p, blob)
      for (const n of namedPackages(await blob.text())) named.add(n)
    }
    return named
  }
  const queue = [...(await take(scope))]
  const seen = new Set<string>()
  while (queue.length) {
    const name = queue.shift() as string
    if (seen.has(name)) continue
    seen.add(name)
    // another package of this repository: a folder of that name holding a package.xml or model.config, not already taken
    const dir = [...dirs].find((d) => d.split('/').pop() === name && isPackage(d))
    if (dir === undefined || scopes.some((s) => under(s, dir) || dir === s)) continue
    queue.push(...(await take(dir)))
  }
  if (isFile && lfs.includes(path)) {
    throw new GithubError('lfs', `${path} is stored in Git LFS, which ROCO does not download. Download the repository with Git LFS and import the folder.`)
  }
  files.sort((a, b) => Number(TEXT_FILE.test(b.path)) - Number(TEXT_FILE.test(a.path)))
  return { owner, repo, sha, path, isFile, scopes, files, bytes: checkCaps(files), lfs, links, calls, texts }
}

/**
 * Downloads the rest of a plan's files (the description files are already in it) and returns them as files for
 * importRobotFiles, each with its path in the repository under the repository's name, as a folder upload of a clone would
 * give them. Git LFS pointers are left out and listed, and so are the plan's symbolic links. `onProgress` gets the files done
 * and the total.
 */
export async function fetchPlan(
  plan: GithubPlan,
  outer?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<{ files: File[]; mainFile?: string; lfs: string[]; links: string[] }> {
  const { signal, timedOut, done } = deadline(outer)
  try {
    const rest = plan.files.filter((f) => TEXT_FILE.test(f.path) === false)
    const total = plan.files.length
    let count = total - rest.length
    onProgress?.(count, total)
    const got = await download(plan, rest, signal, () => onProgress?.(++count, total))
    const lfs = [...plan.lfs]
    const files: File[] = []
    const add = (p: string, blob: Blob) => {
      const file = new File([blob], p.split('/').pop() as string)
      Object.defineProperty(file, 'webkitRelativePath', { value: `${plan.repo}/${p}`, configurable: true })
      files.push(file)
    }
    for (const [p, blob] of plan.texts) add(p, blob)
    for (const [p, blob] of got) {
      if (await isLfs(blob)) lfs.push(p)
      else add(p, blob)
    }
    return { files, lfs, links: [...plan.links], ...(plan.isFile ? { mainFile: `${plan.repo}/${plan.path}` } : {}) }
  } catch (e) {
    if (timedOut()) throw new GithubError('time', `Downloading the files took longer than ${GITHUB_LIMITS.ms / 1000} s, so it was stopped. Download the repository as a zip and import that.`)
    throw e
  } finally {
    done()
  }
}
