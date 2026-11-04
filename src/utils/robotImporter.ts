import * as THREE from 'three'
import URDFLoader, { type URDFRobot } from 'urdf-loader'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { parseRobotDescription } from './modelFormatParser'
import { buildProfileFromParsedRobot } from './autoProfileBuilder'
import { motorOrderNote } from './motorMatch'
import { getRobotProfile, unregisterRobotProfile, type RobotProfile } from '../config/robotRegistry'
import { telemetryService } from '../services/telemetryStream'

/**
 * Configures URDFLoader to support .stl, .dae, .obj, .glb, and .gltf mesh loading.
 * Preserves embedded materials on .dae and .glb meshes, and provides PBR cockpit
 * materials when missing.
 */
export function configureMultiFormatMeshLoader(loader: URDFLoader, manager: THREE.LoadingManager): void {
  const defaultCockpitMaterial = new THREE.MeshStandardMaterial({
    color: 0x94a3b8, // Slate cockpit grey
    roughness: 0.35,
    metalness: 0.65,
  })

  const stlLoader = new STLLoader(manager)
  const colladaLoader = new ColladaLoader(manager)
  const objLoader = new OBJLoader(manager)
  const gltfLoader = new GLTFLoader(manager)

  // URDFLoader invokes loadMeshCb as: (path, manager, material, onComplete)
  type MeshDone = (mesh: THREE.Object3D, err?: Error) => void
  loader.loadMeshCb = (
    path: string,
    _mgr: THREE.LoadingManager,
    materialOrDone: THREE.Material | null | MeshDone,
    doneMaybe?: MeshDone
  ) => {
    let material: THREE.Material | null = null
    let done: MeshDone

    if (typeof materialOrDone === 'function') {
      done = materialOrDone
    } else {
      material = materialOrDone
      done = doneMaybe || (() => {})
    }

    const cleanPath = path.split('?')[0].split('#')[0]
    const ext = cleanPath.split('.').pop()?.toLowerCase() ?? ''

    if (ext === 'stl') {
      stlLoader.load(
        path,
        (geom) => {
          const mesh = new THREE.Mesh(geom, material || defaultCockpitMaterial.clone())
          done(mesh)
        },
        undefined,
        (err) => done(new THREE.Group(), err as Error)
      )
    } else if (ext === 'dae') {
      colladaLoader.load(
        path,
        (collada) => {
          if (collada?.scene) {
            done(collada.scene)
          } else {
            done(new THREE.Group())
          }
        },
        undefined,
        (err) => done(new THREE.Group(), err as Error)
      )
    } else if (ext === 'obj') {
      objLoader.load(
        path,
        (obj) => {
          obj.traverse((child) => {
            const m = child as THREE.Mesh
            if (m.isMesh && (!m.material || (Array.isArray(m.material) && m.material.length === 0))) {
              m.material = material || defaultCockpitMaterial.clone()
            }
          })
          done(obj)
        },
        undefined,
        (err) => done(new THREE.Group(), err as Error)
      )
    } else if (ext === 'glb' || ext === 'gltf') {
      gltfLoader.load(
        path,
        (gltf) => {
          done(gltf.scene)
        },
        undefined,
        (err) => done(new THREE.Group(), err as Error)
      )
    } else {
      stlLoader.load(
        path,
        (geom) => {
          const mesh = new THREE.Mesh(geom, material || defaultCockpitMaterial.clone())
          done(mesh)
        },
        undefined,
        (err) => done(new THREE.Group(), err as Error)
      )
    }
  }
}

// -----------------------------------------------------------------------------
// Imported-asset bookkeeping
// -----------------------------------------------------------------------------
interface ImportedAssets {
  /** Every blob URL created for this import; revoked together when the profile is evicted. */
  urls: string[]
  resolve: (url: string) => string
}
const importedAssets = new Map<string, ImportedAssets>()
/** Imported robots kept in memory at once. Older ones are unregistered and their blobs revoked. */
const MAX_IMPORTED_PROFILES = 3

export function getImportedAssetResolver(profileId: string): ((url: string) => string) | undefined {
  return importedAssets.get(profileId)?.resolve
}

/** Unregisters an imported robot and frees its blob URLs. Built-in profiles are left alone. */
export function disposeImportedProfile(profileId: string): void {
  const assets = importedAssets.get(profileId)
  if (!assets) return
  for (const url of assets.urls) URL.revokeObjectURL(url)
  importedAssets.delete(profileId)
  unregisterRobotProfile(profileId)
}

function evictOldImports(keepId: string): void {
  for (const id of Array.from(importedAssets.keys())) {
    if (importedAssets.size <= MAX_IMPORTED_PROFILES) break
    if (id !== keepId && id !== telemetryService.getActiveRobotProfile().id) disposeImportedProfile(id)
  }
}

// -----------------------------------------------------------------------------
// Path-aware asset lookup
// -----------------------------------------------------------------------------
/** Lower-cased, scheme/host-free, `.`/`..`-collapsed path. `package://pkg/a/../b.stl` -> `pkg/b.stl`. */
export function normalizeAssetPath(raw: string): string {
  let p = raw.split('?')[0].split('#')[0].replace(/\\/g, '/').replace(/^blob:/i, '')
  try {
    p = decodeURIComponent(p)
  } catch {
    // keep the undecoded path
  }
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

interface AssetEntry {
  segs: string[]
  url: string
  path: string
}

export interface AssetMatch {
  url: string | null
  /** Other files that matched equally well; non-empty means the choice was a guess. */
  ambiguousWith: string[]
}

/** Number of trailing path segments two paths share. */
function commonSuffix(a: string[], b: string[]): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

class AssetIndex {
  private byBase = new Map<string, AssetEntry[]>()
  add(path: string, url: string): void {
    const norm = normalizeAssetPath(path)
    const segs = norm.split('/')
    const base = segs[segs.length - 1]
    const list = this.byBase.get(base) ?? []
    list.push({ segs, url, path: norm })
    this.byBase.set(base, list)
  }
  /** Picks the file sharing the most trailing path segments with the request. */
  find(request: string): AssetMatch {
    const segs = normalizeAssetPath(request).split('/')
    const candidates = this.byBase.get(segs[segs.length - 1])
    if (!candidates) return { url: null, ambiguousWith: [] }
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
    const distinct = new Set(winners.map((w) => w.url))
    return {
      url: winners[0].url,
      ambiguousWith: distinct.size > 1 ? winners.slice(1).map((w) => w.path) : [],
    }
  }
}

/**
 * Flattens a drag-and-drop payload into files. `dataTransfer.files` only yields a folder as an opaque
 * zero-byte entry, so directories are walked through the (webkit) FileSystem entry API. Each file keeps
 * its folder path in `webkitRelativePath` so same-named meshes in different folders stay distinguishable.
 */
export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = []
  for (const item of Array.from(dataTransfer.items ?? [])) {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null
    if (entry) entries.push(entry)
  }
  if (entries.length === 0) return Array.from(dataTransfer.files)

  const out: File[] = []
  const readAll = (reader: FileSystemDirectoryReader) =>
    new Promise<FileSystemEntry[]>((resolve, reject) => {
      const all: FileSystemEntry[] = []
      const next = () =>
        reader.readEntries((batch) => {
          if (batch.length === 0) resolve(all)
          else {
            all.push(...batch)
            next() // readEntries returns at most ~100 entries per call
          }
        }, reject)
      next()
    })
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      const relative = entry.fullPath.replace(/^\/+/, '')
      if (relative.includes('/')) {
        Object.defineProperty(file, 'webkitRelativePath', { value: relative, configurable: true })
      }
      out.push(file)
    } else if (entry.isDirectory) {
      for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader())) await walk(child)
    }
  }
  for (const entry of entries) await walk(entry)
  return out
}

const filePath = (f: File): string => f.webkitRelativePath || f.name

export interface ImportResult {
  profile: RobotProfile
  /** Problems the user should know about (missing meshes, ambiguous names, unsupported xacro/MJCF features). */
  warnings: string[]
}

const summarize = (names: string[], max = 5): string =>
  names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`

/**
 * Picks the entry-point description. A `.urdf` wins; among xacro/xml files the one that no other
 * candidate includes is the top-level file.
 */
function pickMainFile(files: File[], texts: Map<File, string>): File | undefined {
  const urdfs = files.filter((f) => /\.urdf$/i.test(f.name))
  if (urdfs.length > 0) return urdfs[0]
  const candidates = files.filter((f) => /\.(xacro|xml)$/i.test(f.name))
  const xacros = candidates.filter((f) => /\.xacro$/i.test(f.name))
  const pool = xacros.length > 0 ? xacros : candidates
  const included = (f: File) =>
    pool.some((other) => other !== f && (texts.get(other) ?? '').toLowerCase().includes(f.name.toLowerCase()))
  return pool.find((f) => !included(f)) ?? pool[0]
}

/**
 * Imports robot description files (.urdf, .xacro, MuJoCo .xml) and associated meshes
 * from a FileList, drag-and-drop event, or directory upload.
 * Builds a dynamic RobotProfile, registers it, and switches the active robot profile.
 */
export async function importRobotFiles(files: FileList | File[]): Promise<ImportResult> {
  const fileArray = Array.from(files)
  if (fileArray.length === 0) {
    throw new Error('No files provided for robot import.')
  }
  const warnings: string[] = []

  // 1. Read every description-like file once: xacro includes need the text synchronously.
  const texts = new Map<File, string>()
  await Promise.all(
    fileArray
      .filter((f) => /\.(urdf|xacro|xml)$/i.test(f.name))
      .map(async (f) => texts.set(f, await f.text()))
  )

  const mainFile = pickMainFile(fileArray, texts)
  if (!mainFile) {
    throw new Error(
      'Could not find a robot description file (.urdf, .xacro, or .xml) among the imported files.'
    )
  }

  // 2. Parse first, so a bad file fails before any blob URL exists (nothing to leak or revoke).
  const textFileIndex = new AssetIndex()
  const textByUrl = new Map<string, string>()
  for (const [f, text] of texts) {
    textByUrl.set(filePath(f), text)
    textFileIndex.add(filePath(f), filePath(f))
  }
  const processedUrdf = parseRobotDescription(texts.get(mainFile) ?? '', mainFile.name, {
    warnings,
    resolveInclude: (filename) => {
      const hit = textFileIndex.find(filename)
      return hit.url ? textByUrl.get(hit.url) : undefined
    },
  })

  // 3. Parse the URDF for kinematics only. Meshes are loaded later by the digital twin, so skip them here
  // instead of downloading every file twice into a robot that is thrown away.
  const kinematicsLoader = new URDFLoader(new THREE.LoadingManager())
  kinematicsLoader.loadMeshCb = (_path, _mgr, _material, done) => done(new THREE.Group())
  const parsedRobot: URDFRobot = kinematicsLoader.parse(processedUrdf)

  // 4. Only now map files to blob URLs. Description files are included too (the twin may re-fetch them).
  const urls: string[] = []
  const makeUrl = (blob: Blob): string => {
    const u = URL.createObjectURL(blob)
    urls.push(u)
    return u
  }
  let profile: RobotProfile
  try {
    const index = new AssetIndex()
    for (const f of fileArray) index.add(filePath(f), makeUrl(f))
    const urdfBlobUrl = makeUrl(new Blob([processedUrdf], { type: 'text/xml' }))
    const ownUrls = new Set(urls)

    const resolveAsset = (url: string): string => {
      if (ownUrls.has(url) || /^data:/i.test(url)) return url
      return index.find(url).url ?? url
    }

    // 5. Check every mesh the robot references now, so problems show up in the dialog instead of
    // as a half-empty robot later.
    const meshRefs = Array.from(processedUrdf.matchAll(/<mesh\b[^>]*\bfilename\s*=\s*["']([^"']+)["']/g), (m) => m[1])
    const missing: string[] = []
    const guessed: string[] = []
    for (const ref of new Set(meshRefs)) {
      const match = index.find(ref)
      if (!match.url) missing.push(ref.split('/').pop() ?? ref)
      else if (match.ambiguousWith.length > 0) guessed.push(ref)
    }
    if (missing.length > 0) {
      warnings.push(`${missing.length} mesh file(s) referenced by the robot were not imported: ${summarize(missing)}.`)
    }
    if (guessed.length > 0) {
      warnings.push(
        `${guessed.length} mesh name(s) match several imported files and one was picked arbitrarily: ${summarize(guessed)}. ` +
          'Import the whole robot folder so paths can disambiguate them.'
      )
    }

    // 6. Build dynamic RobotProfile (throws if it has more joints than LowState_ has motor slots)
    const modelName = parsedRobot.robotName || mainFile.name.replace(/\.[^.]+$/, '')
    profile = buildProfileFromParsedRobot(parsedRobot, modelName, urdfBlobUrl)
    importedAssets.set(profile.id, { urls, resolve: resolveAsset })
  } catch (err) {
    for (const u of urls) URL.revokeObjectURL(u)
    throw err
  }

  // 7. Activate the imported profile, then free robots we no longer keep.
  telemetryService.setActiveRobotProfile(profile.id)
  evictOldImports(profile.id)

  // the file's joint order need not be the robot's motor order: say how the joints were tied to motors (always shown, so the dialog stays open)
  const active = telemetryService.getActiveRobotProfile()
  const orderNote = motorOrderNote(active.motorOrder, active.motorMatch)
  if (orderNote) {
    const unchecked = !active.motorMatch || active.motorMatch.source === 'fileOrder'
    warnings.push(
      unchecked
        ? `${orderNote} When a ROCO bridge connects they are matched to its motors by name. Check that each joint moves with the right motor.`
        : orderNote,
    )
  }

  return { profile: getRobotProfile(profile.id), warnings }
}
