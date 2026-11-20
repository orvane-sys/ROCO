import * as THREE from 'three'
import URDFLoader, { type URDFRobot } from 'urdf-loader'
import { isMuJoCoModel, isSdfModel, parseRobotDescription, type ParseContext } from './modelFormatParser'
import { checkModel, type CheckFinding } from './modelChecker'
import { AssetIndex, type Resolved } from './assetResolver'
import { ImportReport } from './importReport'
import { LIMITS, TEXT_FILE, refuse, sizeLimitFor } from './importLimits'
import { Deadline, parseXmlSafe } from './safeXml'
import { isZip, unpackZip } from './zipBundle'
import { countTriangles, type TriangleCount } from './meshTriangles'
import { buildProfileFromParsedRobot, robotCategory } from './autoProfileBuilder'
import { motorOrderNote } from './motorMatch'
import { MOTOR_COUNT } from './unitreeBinaryCodec'
import { getRobotProfile, type RobotProfile } from '../config/robotRegistry'
import { telemetryService } from '../services/telemetryStream'
import { configureMultiFormatMeshLoader } from './meshLoaders'
import { evictOldImports, importedAssets } from './importedAssets'

// Kept light for the first visit: these live in their own modules so the 3D view can use them without loading the importer.
// Re-exported here so existing imports keep working.
export { configureMultiFormatMeshLoader } from './meshLoaders'
export { disposeImportedProfile, getImportedAssetResolver } from './importedAssets'
export { collectDroppedFiles } from './droppedFiles'

type MeshStub = { path: string; group: THREE.Group }

/** How long the meshes measured at import may take to load; a slow one is left out and the twin measures it later. */
const LOW_MESH_MS = 10_000

/**
 * Loads, into the kinematics-only robot of step 4, the meshes of the links in the lower half of the robot (by link origin,
 * every joint at zero), the way the twin's loader places them. Returns what was added, to dispose after measuring.
 */
async function loadLowMeshes(robot: URDFRobot, stubs: MeshStub[], resolve: (url: string) => string, deadline: Deadline): Promise<THREE.Object3D[]> {
  if (stubs.length === 0) return []
  robot.updateMatrixWorld(true)
  // a robot hung from a bare `world` link by a floating joint: the world link's origin is not part of the robot
  const floating = Object.values(robot.joints || {}).some((j) => j.jointType === 'floating')
  const at = new THREE.Vector3()
  const linkZ = new Map<THREE.Object3D, number>()
  let lowest = Infinity
  let highest = -Infinity
  // from matrixWorld, updated above: getWorldPosition climbs the whole parent chain, too deep for a long chain of links
  for (const link of Object.values(robot.links || {})) {
    if (floating && link === robot) continue
    const z = at.setFromMatrixPosition(link.matrixWorld).z
    linkZ.set(link, z)
    lowest = Math.min(lowest, z)
    highest = Math.max(highest, z)
  }
  if (linkZ.size === 0) return []
  const middle = (lowest + highest) / 2
  const low = stubs.filter((s) => {
    let p: THREE.Object3D | null = s.group
    while (p && !linkZ.has(p)) p = p.parent
    return p !== null && (linkZ.get(p) as number) <= middle
  })
  // the loader picks the format by the file's extension, so it gets the path and the manager swaps in the blob URL
  const manager = new THREE.LoadingManager()
  manager.setURLModifier(resolve)
  const loader = new URDFLoader(manager)
  configureMultiFormatMeshLoader(loader, manager)
  const material = new THREE.MeshBasicMaterial() // only measured, never drawn
  const added: THREE.Object3D[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const all = Promise.all(
    low.map(
      (s) =>
        new Promise<void>((done) =>
          loader.loadMeshCb(s.path, manager, material, (obj: THREE.Object3D, err?: Error) => {
            // a mesh that fails to load is reported by the twin; here it is only left out of the measurement
            if (!err && obj) {
              obj.position.set(0, 0, 0)
              obj.quaternion.identity()
              s.group.add(obj)
              added.push(obj)
            }
            done()
          })
        )
    )
  )
  await Promise.race([all, new Promise<void>((done) => (timer = setTimeout(done, LOW_MESH_MS)))])
  clearTimeout(timer)
  deadline.check('measuring the robot height')
  return added
}

function disposeObject(root: THREE.Object3D): void {
  root.removeFromParent()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    m.geometry?.dispose()
    for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mat.dispose()
  })
}

// Path-aware asset lookup lives in assetResolver.ts; re-exported so existing imports keep working.
export { normalizeAssetPath, type AssetMatch } from './assetResolver'

const filePath = (f: File): string => f.webkitRelativePath || f.name

export interface ImportResult {
  profile: RobotProfile
  /** Problems the user should know about (missing meshes, ambiguous names, unsupported xacro/MJCF features). */
  warnings: string[]
  /** Everything the import fixed, approximated, substituted or could not use. Its lines are also in `warnings`. */
  report: ImportReport
  /** The warnings that are not report lines (how the joints were tied to motors). */
  notes: string[]
  /** The main description file used, by its path in the import (pass it back as `mainFile` to import again). */
  mainFile: string
  /** The xacro's arguments, in the order it met them; empty for any other file. */
  xacroArgs: XacroArg[]
  /** The model check (src/utils/modelChecker.ts): masses, inertias, axes, limits and meshes a simulator would refuse. */
  findings: CheckFinding[]
}

/** One xacro argument for the dialog's form: its value in this import, or `undefined` when the file needs one and has none. */
export interface XacroArg {
  name: string
  value: string | undefined
}

/** What a failed import got to before it stopped, so the dialog can still show the report and the xacro's arguments. */
export interface ImportFailure {
  report: ImportReport
  mainFile?: string
  xacroArgs: XacroArg[]
}
const failures = new WeakMap<object, ImportFailure>()

/** The report and arguments of an import that threw `err`, if `err` came from `importRobotFiles`. */
export function importFailure(err: unknown): ImportFailure | undefined {
  return typeof err === 'object' && err !== null ? failures.get(err) : undefined
}

/** Where a failed import had got to: filled in by `importFiles` as it goes. */
interface ImportProgress {
  report?: ImportReport
  mainFile?: string
  xacroArgsUsed?: Map<string, string | undefined>
}
const argList = (used?: Map<string, string | undefined>): XacroArg[] => Array.from(used ?? [], ([name, value]) => ({ name, value }))

/**
 * A file the import does not have is never asked of a web server: the path could name the user's own folders. Requests
 * for it get this blob URL instead, which names no blob, so the load fails inside the browser.
 */
const nowhere = (): string => `blob:${location.origin}/00000000-0000-4000-8000-000000000000`

/**
 * The files that could be the entry-point description, best first. A `.urdf` wins; among xacro/xml/sdf files a top-level
 * file is one that no other candidate includes (an SDF model is included as `model://<its folder>`). More than one means
 * the choice was a guess.
 */
function pickMainFiles(files: File[], texts: Map<File, string>): File[] {
  const urdfs = files.filter((f) => /\.urdf$/i.test(f.name))
  if (urdfs.length > 0) return urdfs
  const candidates = files.filter((f) => /\.(xacro|xml|sdf)$/i.test(f.name))
  const xacros = candidates.filter((f) => /\.xacro$/i.test(f.name))
  const pool = xacros.length > 0 ? xacros : candidates
  const included = (f: File) => {
    const names = [f.name.toLowerCase()]
    const folder = filePath(f).split('/').slice(-2, -1)[0]
    if (/\.sdf$/i.test(f.name) && folder) names.push(`model://${folder.toLowerCase()}`)
    return pool.some((other) => {
      const t = other === f ? '' : (texts.get(other) ?? '').toLowerCase()
      return names.some((n) => t.includes(n))
    })
  }
  const top = pool.filter((f) => !included(f))
  return top.length ? top : pool.slice(0, 1)
}

/**
 * Points every `<mesh>` and `<texture>` filename in the URDF at the imported file it resolves to, written as that file's
 * path in the import. The twin then finds each file by its full path instead of guessing from the name, so a
 * relative path keeps its folder. References that resolve to nothing are left as written.
 */
function rewriteAssetRefs(urdf: string, doc: Document, resolve: (ref: string) => Resolved): { urdf: string; meshes: Map<string, Resolved> } {
  const meshes = new Map<string, Resolved>()
  let changed = false
  for (const el of Array.from(doc.querySelectorAll('mesh[filename], texture[filename]'))) {
    const ref = el.getAttribute('filename') ?? ''
    const hit = resolve(ref)
    if (el.tagName === 'mesh') meshes.set(ref, hit)
    if (hit.path) {
      el.setAttribute('filename', hit.path.split('/').map(encodeURIComponent).join('/'))
      changed = true
    }
  }
  return { urdf: changed ? new XMLSerializer().serializeToString(doc) : urdf, meshes }
}

/**
 * Imports robot description files (.urdf, .xacro, MuJoCo .xml, SDFormat .sdf) and associated meshes
 * from a FileList, drag-and-drop event, or directory upload.
 * Builds a dynamic RobotProfile, registers it, and switches the active robot profile.
 */
export interface ImportOptions {
  /** The main description file, by its path in the import (as `webkitRelativePath` gives it); otherwise it is picked. */
  mainFile?: string
  /** Values for the xacro's `$(arg name)`. */
  xacroArgs?: Record<string, string>
}

export async function importRobotFiles(files: FileList | File[], options: ImportOptions = {}): Promise<ImportResult> {
  const progress: ImportProgress = {}
  try {
    return await importFiles(files, options, progress)
  } catch (e) {
    // the converters and three.js walk the link tree recursively: a chain thousands of links long overflows the stack
    // (Chrome's RangeError, Firefox's InternalError "too much recursion")
    const err = e instanceof Error && /call stack size|too much recursion/i.test(e.message) ? refuse('depth', 'its links or bodies chain thousands deep') : e
    if (progress.report && typeof err === 'object' && err !== null) {
      failures.set(err, { report: progress.report, mainFile: progress.mainFile, xacroArgs: argList(progress.xacroArgsUsed) })
    }
    throw err
  }
}

async function importFiles(files: FileList | File[], options: ImportOptions, progress: ImportProgress): Promise<ImportResult> {
  const given = Array.from(files)
  if (given.length === 0) {
    throw new Error('No files provided for robot import.')
  }
  // A zip is unpacked (in a worker, under its limits) into the files it holds; every file must be under its size cap
  // before any of it is read.
  const fileArray: File[] = []
  for (const f of given) {
    if (isZip(f)) fileArray.push(...(await unpackZip(f)))
    else fileArray.push(f)
  }
  for (const f of fileArray) {
    if (f.size > sizeLimitFor(f.name)) throw refuse('too big', `${filePath(f)}: ${Math.round(f.size / 2 ** 20)} MiB`)
  }
  // the time limit starts after unzipping, which has its own
  const deadline = new Deadline()
  const warnings: string[] = []

  // 1. Read every description-like file once: xacro includes need the text synchronously.
  const texts = new Map<File, string>()
  await Promise.all(
    fileArray
      .filter((f) => TEXT_FILE.test(f.name))
      .map(async (f) => texts.set(f, await f.text()))
  )

  const report = new ImportReport()
  progress.report = report
  const tops = pickMainFiles(fileArray, texts)
  let mainFile = tops[0]
  if (options.mainFile !== undefined) {
    mainFile = fileArray.find((f) => filePath(f) === options.mainFile) as File
    if (!mainFile) throw new Error(`The main file ${options.mainFile} is not among the imported files.`)
  } else if (tops.length > 1) {
    report.add('substitution', `Several files could be the main robot description; ${filePath(mainFile)} was used.`, {
      where: tops.slice(1, 4).map(filePath).join(', '),
      hint: 'Import only the files of the robot you want.',
    })
  }
  if (!mainFile) {
    throw new Error(
      'Could not find a robot description file (.urdf, .xacro, .sdf or .xml) among the imported files.'
    )
  }

  // 2. Parse first, so a bad file fails before any blob URL exists (nothing to leak or revoke).
  const mainPath = filePath(mainFile)
  progress.mainFile = mainPath
  const xacroArgsUsed = new Map<string, string | undefined>()
  progress.xacroArgsUsed = xacroArgsUsed
  const textFileIndex = new AssetIndex()
  const textByUrl = new Map<string, string>()
  for (const [f, text] of texts) {
    textByUrl.set(filePath(f), text)
    textFileIndex.add(filePath(f), filePath(f))
  }
  const mainText = texts.get(mainFile) ?? ''
  const ctx: ParseContext = {
    warnings,
    deadline,
    fileName: mainPath,
    report,
    xacroArgs: options.xacroArgs,
    xacroArgsUsed,
    // MuJoCo looks for an include next to the file that includes it, then next to the main file
    resolveInclude: (filename, from, opts) => {
      let hit = from && from !== mainPath ? textFileIndex.resolve(filename, { from }) : undefined
      if (hit?.how !== 'exact') hit = textFileIndex.resolve(filename, { from: mainPath, report: opts?.exact ? undefined : report })
      if (opts?.exact && hit.how !== 'exact') return undefined
      const text = hit.url ? textByUrl.get(hit.url) : undefined
      return text === undefined || !hit.path ? undefined : { text, path: hit.path }
    },
  }
  const parsedUrdf = parseRobotDescription(mainText, mainFile.name, ctx)

  // 3. Resolve every mesh against the imported files and write its path into the URDF, so the twin loads exactly
  // the file it resolved to. Problems show up in the dialog instead of as a half-empty robot later.
  const index = new AssetIndex()
  for (const f of fileArray) index.add(filePath(f), filePath(f))
  // A plain URDF is checked here (entities, well-formed, with the line of any error); a converted one is checked again.
  const urdfDoc = parseXmlSafe(parsedUrdf, mainPath, deadline)
  const { urdf: processedUrdf, meshes } = rewriteAssetRefs(parsedUrdf, urdfDoc, (ref) => index.resolve(ref, { from: mainPath, report }))
  for (const [ref, hit] of meshes) {
    if (!hit.url) {
      report.add('error', 'A mesh file the robot refers to was not imported, so that part is not drawn.', {
        where: ref,
        hint: 'Import the folder that holds the meshes.',
      })
    }
  }

  // Very large meshes draw slowly. Each mesh file is counted the cheapest way its format allows (src/utils/meshTriangles.ts):
  // a binary STL's header is 84 bytes; a COLLADA file with polygons gives only a lower bound ("at least").
  const byPath = new Map(fileArray.map((f) => [filePath(f), f]))
  const count = (n: number) => n.toLocaleString('en-US')
  let triangles = 0
  let exact = true
  const counted = new Map<string, TriangleCount>()
  for (const url of new Set(Array.from(meshes.values(), (h) => h.url))) {
    deadline.check('counting mesh triangles')
    const f = url ? byPath.get(url) : undefined
    const got = f ? await countTriangles(f, f.name) : null
    if (!f || !got) continue
    counted.set(filePath(f), got)
    triangles += got.triangles
    exact &&= got.exact
    if (got.triangles > LIMITS.trianglesMesh) {
      report.add('limit', `A mesh has more than ${count(LIMITS.trianglesMesh)} triangles, so the robot may draw slowly.`, {
        where: `${filePath(f)}: ${got.exact ? '' : 'at least '}${count(got.triangles)}`,
        hint: 'A simplified copy of the mesh draws faster.',
      })
    }
  }
  if (triangles > LIMITS.trianglesTotal) {
    report.add('limit', `The meshes have ${exact ? '' : 'at least '}${count(triangles)} triangles in all, more than ${count(LIMITS.trianglesTotal)}, so the robot may draw slowly.`)
  }

  // The model check reads the URDF as converted, its mesh filenames now the imported paths (each segment URI-encoded).
  const findings = checkModel(urdfDoc, {
    format: isMuJoCoModel(mainText) ? 'mjcf' : isSdfModel(mainText) ? 'sdf' : 'urdf',
    mjcf: ctx.mjcfInertia,
    sdfAutoInertia: ctx.sdfAutoInertia,
    sdfHelperLinks: ctx.sdfHelperLinks,
    collisionTriangles: (filename) => {
      try {
        return counted.get(filename.split('/').map(decodeURIComponent).join('/'))
      } catch {
        return undefined
      }
    },
  })

  // 4. Parse the URDF for kinematics only. Meshes are loaded later by the digital twin, so skip them here
  // instead of downloading every file twice into a robot that is thrown away.
  // Each mesh gets an empty group, kept with its path so step 5 can fill in the few needed to measure the robot's height.
  const kinematicsLoader = new URDFLoader(new THREE.LoadingManager())
  const meshStubs: MeshStub[] = []
  kinematicsLoader.loadMeshCb = (path, _mgr, _material, done) => {
    const group = new THREE.Group()
    meshStubs.push({ path, group })
    done(group)
  }
  const parsedRobot: URDFRobot = kinematicsLoader.parse(processedUrdf)

  // 5. Only now map files to blob URLs. Description files are included too (the twin may re-fetch them).
  const urls: string[] = []
  const makeUrl = (blob: Blob): string => {
    const u = URL.createObjectURL(blob)
    urls.push(u)
    return u
  }
  let profile: RobotProfile
  try {
    const blobIndex = new AssetIndex()
    for (const f of fileArray) blobIndex.add(filePath(f), makeUrl(f))
    const urdfBlobUrl = makeUrl(new Blob([processedUrdf], { type: 'text/xml' }))
    const ownUrls = new Set(urls)

    // The twin asks for "<urdf folder>/<path written in step 3>"; the URDF's own blob folder drops out in
    // normalizeAssetPath, so the full path matches exactly. Anything else falls back to the name match.
    // A blob: URL is never a network request (three.js makes its own for textures inside a glTF); anything else that is
    // not an imported file gets nowhere(), never the page's server.
    const resolveAsset = (url: string): string => {
      if (ownUrls.has(url) || /^data:/i.test(url)) return url
      return blobIndex.exact(url).url ?? blobIndex.find(url).url ?? (/^blob:/i.test(url) ? url : nowhere())
    }

    // 6. Build dynamic RobotProfile. Its standing height needs the robot's lowest point, which is often inside a mesh (a sole
    // below the ankle, a foot inside a calf mesh).
    const modelName = parsedRobot.robotName || mainFile.name.replace(/\.[^.]+$/, '')
    const lowMeshes = robotCategory(parsedRobot) === 'fixed_manipulator' ? [] : await loadLowMeshes(parsedRobot, meshStubs, resolveAsset, deadline)
    try {
      profile = buildProfileFromParsedRobot(parsedRobot, modelName, urdfBlobUrl)
    } finally {
      for (const m of lowMeshes) disposeObject(m)
    }
    importedAssets.set(profile.id, { urls, resolve: resolveAsset })
  } catch (err) {
    for (const u of urls) URL.revokeObjectURL(u)
    throw err
  }
  if (profile.joints.length === 0) {
    report.add('limit', 'The robot has no movable joints (revolute, continuous or prismatic), so it is shown as one rigid body with no joint data.', {
      hint: 'Rotors and wheels written as fixed joints cannot move in the view.',
    })
  }
  const pastSlots = profile.joints.filter((j) => j.sdkMotorIndex === -1)
  for (const j of pastSlots) {
    report.add('limit', `The robot has ${profile.joints.length} movable joints, more than the ${MOTOR_COUNT} motor slots in a LowState_ frame, so the joints after the first ${MOTOR_COUNT} show no data.`, {
      where: j.id,
      hint: 'When a ROCO bridge connects, any of them it names in its motor list is matched to that motor.',
    })
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

  const notes = warnings.slice()
  warnings.push(...report.lines())
  return { profile: getRobotProfile(profile.id), warnings, report, notes, mainFile: mainPath, xacroArgs: argList(xacroArgsUsed), findings }
}
