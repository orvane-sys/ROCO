// Unpacks an imported zip off the page's main thread. The zip is untrusted, so the whole central directory is checked
// against the limits before anything is inflated: names that leave the folder, symbolic links, duplicates, encryption,
// unknown methods, too many entries, too much data, and compression ratios like a zip bomb's. Entries are then inflated
// one at a time from their own local headers (this file does not trust a library's walk of the zip), each stopped as
// soon as it produces more than its declared size, and each checked against its CRC-32. Peak memory stays near the zip
// plus the unpacked files, and the page stops this worker if it runs too long.
import { Inflate } from 'fflate'
import { LIMITS, ImportRefused, refuse, sizeLimitFor } from '../utils/importLimits'

export interface ZipEntry {
  name: string
  flags: number
  method: number
  /** The "version made by" host byte: 3 is Unix, whose mode bits are in the top of `attr`. */
  host: number
  csize: number
  usize: number
  attr: number
  crc: number
  /** Offset of the entry's local header. */
  local: number
}

export interface UnzippedFile {
  path: string
  data: Uint8Array
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})

export function crc32(d: Uint8Array): number {
  let c = -1
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 255] ^ (c >>> 8)
  return ~c >>> 0
}

const MAX32 = 0xffffffff

/** Reads the central directory (zip64 included). Throws `not a zip` for anything malformed, `entries` above the cap. */
export function centralDirectory(d: Uint8Array): ZipEntry[] {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  let e = -1
  for (let i = d.length - 22; i >= Math.max(0, d.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      e = i
      break
    }
  }
  if (e < 0) throw refuse('not a zip', 'no end record')
  let count = v.getUint16(e + 10, true)
  let off = v.getUint32(e + 16, true)
  if (count === 0xffff || off === MAX32) {
    if (e < 20 || v.getUint32(e - 20, true) !== 0x07064b50) throw refuse('not a zip', 'zip64 locator missing')
    const z = Number(v.getBigUint64(e - 12, true))
    if (z + 56 > d.length || v.getUint32(z, true) !== 0x06064b50) throw refuse('not a zip', 'zip64 record missing')
    count = Number(v.getBigUint64(z + 32, true))
    off = Number(v.getBigUint64(z + 48, true))
  }
  if (count > LIMITS.zipEntries) throw refuse('entries', `${count} files`)
  const out: ZipEntry[] = []
  for (let i = 0, o = off; i < count; i++) {
    if (o + 46 > d.length || v.getUint32(o, true) !== 0x02014b50) throw refuse('not a zip', `bad directory entry ${i}`)
    const flags = v.getUint16(o + 8, true)
    const method = v.getUint16(o + 10, true)
    let csize = v.getUint32(o + 20, true)
    let usize = v.getUint32(o + 24, true)
    const nl = v.getUint16(o + 28, true)
    const xl = v.getUint16(o + 30, true)
    const cl = v.getUint16(o + 32, true)
    let local = v.getUint32(o + 42, true)
    if (o + 46 + nl + xl > d.length) throw refuse('not a zip', `directory entry ${i} runs past the end`)
    const raw = d.subarray(o + 46, o + 46 + nl)
    let name: string
    try {
      name = flags & 0x800 ? new TextDecoder('utf-8', { fatal: true }).decode(raw) : String.fromCharCode(...raw)
    } catch {
      throw refuse('name', `entry ${i} is not valid UTF-8`)
    }
    // zip64 extra field: each value stored there in order when its 32-bit field is 0xffffffff
    for (let x = o + 46 + nl; x + 4 <= o + 46 + nl + xl; ) {
      const id = v.getUint16(x, true)
      const sz = v.getUint16(x + 2, true)
      if (id === 1) {
        let p = x + 4
        const end = x + 4 + sz
        const next = () => {
          if (p + 8 > end) throw refuse('not a zip', `entry ${i} has a short zip64 field`)
          const n = Number(v.getBigUint64(p, true))
          p += 8
          return n
        }
        if (usize === MAX32) usize = next()
        if (csize === MAX32) csize = next()
        if (local === MAX32) local = next()
      }
      x += 4 + sz
    }
    out.push({ name, flags, method, host: d[o + 5], csize, usize, attr: v.getUint32(o + 38, true), crc: v.getUint32(o + 16, true), local })
    o += 46 + nl + xl + cl
  }
  return out
}

const isDir = (e: ZipEntry) => e.name.endsWith('/')

/** Throws the first limit the directory breaks. Nothing has been inflated yet. */
export function checkEntries(entries: ZipEntry[]): void {
  const seen = new Set<string>()
  let total = 0
  for (const e of entries) {
    const n = e.name
    if (!n || n.includes('\0') || /^[\\/]/.test(n) || /^[A-Za-z]:/.test(n) || n.split(/[\\/]/).includes('..')) {
      throw refuse('name', JSON.stringify(n))
    }
    if (e.host === 3 && ((e.attr >>> 16) & 0o170000) === 0o120000) throw refuse('symlink', n)
    if (seen.has(n)) throw refuse('duplicate', n)
    seen.add(n)
    if (e.flags & 1) throw refuse('encrypted', n)
    if (isDir(e)) continue
    if (e.method !== 0 && e.method !== 8) throw refuse('method', `${n}: method ${e.method}`)
    if (e.usize > sizeLimitFor(n)) throw refuse('too big', n)
    total += e.usize
  }
  if (total > LIMITS.zipTotal) throw refuse('total', `${Math.round(total / 2 ** 20)} MiB`)
  for (const e of entries) {
    if (e.usize > LIMITS.zipRatioFloor && e.usize > LIMITS.zipRatio * Math.max(e.csize, 1)) {
      throw refuse('ratio', `${e.name}: ${e.usize} from ${e.csize} bytes`)
    }
  }
}

/** Input is fed to the inflater in slices this big, so an entry that lies about its size is stopped early. */
const SLICE = 64 * 1024

/** The entry's bytes: copied when stored, inflated when deflated. Never more than its declared size. */
function extract(d: Uint8Array, e: ZipEntry): Uint8Array {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  if (e.local + 30 > d.length || v.getUint32(e.local, true) !== 0x04034b50) throw refuse('not a zip', `no local header for ${e.name}`)
  const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true)
  if (start + e.csize > d.length) throw refuse('not a zip', `${e.name} runs past the end`)
  const raw = d.subarray(start, start + e.csize)
  let data: Uint8Array
  if (e.method === 0) {
    if (e.csize !== e.usize) throw refuse('crc', e.name)
    data = raw.slice()
  } else {
    data = new Uint8Array(e.usize)
    let got = 0
    const inflater = new Inflate((chunk) => {
      if (got + chunk.length > e.usize) throw refuse('crc', `${e.name} is larger than recorded`)
      data.set(chunk, got)
      got += chunk.length
    })
    try {
      for (let p = 0; p < raw.length; p += SLICE) inflater.push(raw.subarray(p, p + SLICE), false)
      inflater.push(new Uint8Array(0), true)
    } catch (err) {
      if (err instanceof ImportRefused) throw err
      throw refuse('crc', `${e.name} is damaged`)
    }
    if (got !== e.usize) throw refuse('crc', `${e.name} is smaller than recorded`)
  }
  if (crc32(data) !== e.crc) throw refuse('crc', e.name)
  return data
}

/** Files a Mac adds to zips it makes (`__MACOSX/`, `.DS_Store`): never part of a robot. */
const MAC_EXTRA = /(^|\/)(__MACOSX\/|\.DS_Store$)/

/** Checks and unpacks a whole zip. `onProgress` gets unpacked and total bytes. */
export function readZip(d: Uint8Array, onProgress?: (done: number, total: number) => void): UnzippedFile[] {
  const entries = centralDirectory(d)
  checkEntries(entries)
  const wanted = entries.filter((e) => !isDir(e) && !MAC_EXTRA.test(e.name))
  const total = wanted.reduce((s, e) => s + e.usize, 0)
  const files: UnzippedFile[] = []
  let done = 0
  for (const e of wanted) {
    files.push({ path: e.name.replace(/\\/g, '/'), data: extract(d, e) })
    done += e.usize
    onProgress?.(done, total)
  }
  return files
}

/** Messages to the page. */
export type ZipReply =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; files: { path: string; buf: ArrayBuffer }[] }
  | { type: 'refused'; reason: string; detail: string }
  | { type: 'error'; detail: string }

// Register the handler only inside a worker, so the functions above can also be loaded on their own for tests.
if (typeof window === 'undefined' && typeof self !== 'undefined') {
  const post = (msg: ZipReply, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })
  self.onmessage = ({ data }: MessageEvent<{ buf: ArrayBuffer }>) => {
    try {
      let last = 0
      const files = readZip(new Uint8Array(data.buf), (done, total) => {
        const now = performance.now()
        if (now - last > 100 || done === total) {
          last = now
          post({ type: 'progress', done, total })
        }
      })
      // each file's bytes move to the page instead of being copied
      const out = files.map((f) => ({ path: f.path, buf: f.data.buffer as ArrayBuffer }))
      post({ type: 'done', files: out }, out.map((f) => f.buf))
    } catch (err) {
      post(err instanceof ImportRefused ? { type: 'refused', reason: err.reason, detail: err.detail } : { type: 'error', detail: String((err as Error)?.message ?? err) })
    }
  }
}
