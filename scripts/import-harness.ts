// The page side of the import checks (check-import-corpus.mjs and check-import.mjs). The check
// bundles this file with rolldown and loads it into a blank page. It calls the page's own importer, exactly as the import dialog
// does, then reads back the URDF the importer produced and reports its joints and each link's world pose with every joint at zero.
import * as THREE from 'three'
import URDFLoader from 'urdf-loader'
import { configureMultiFormatMeshLoader, getImportedAssetResolver, importFailure, importRobotFiles } from '../src/utils/robotImporter'
import { applyUnitsFix, checkUnits } from '../src/utils/unitsCheck'
import { getRobotProfile } from '../src/config/robotRegistry'
import { isMuJoCoModel, isSdfModel, parseRobotDescription } from '../src/utils/modelFormatParser'
import { checkModel } from '../src/utils/modelChecker'

export interface HarnessFile {
  /** Path as a folder drop gives it (webkitRelativePath), e.g. `unitree_h1/h1.xml`. */
  path: string
  url: string
}

export interface HarnessResult {
  ok: boolean
  error?: string
  ms: number
  robotName?: string
  profileName?: string
  profileJoints?: number
  /** Each profile joint's motor slot (sdkMotorIndex), in profile order. */
  profileSlots?: number[]
  /** The profile's guess at the base height standing, and the links it treats as touching the ground. */
  profile?: { category: string; nominalPelvisHeight: number; groundContactLinks: string[] }
  warnings?: string[]
  joints?: Record<string, { type: string; axis: number[]; lower: number | null; upper: number | null }>
  poses?: Record<string, { xyz: number[]; quat: number[] }>
  /** Mesh references in the produced URDF, and how many name a file that was imported (by its full path). */
  meshes?: { total: number; resolved: number; unresolved: string[] }
  urdf?: string
  /**
   * `want.units`: the robot loaded with its meshes as the twin loads it, what the units check offers, and, with the fix
   * applied, the size of the robot as the twin shows it (Y up, metres) and whether its ground links are at its bottom.
   */
  units?: { offer: ReturnType<typeof checkUnits>; size: number[]; groundAtBottom: boolean }
  /** The import report's items, the notes that are not report lines, the main file and the xacro's arguments (v2 importers). */
  report?: unknown[]
  notes?: string[]
  mainFile?: string
  xacroArgs?: { name: string; value: string | undefined }[]
  /** The model check's findings (stage 1.2 importers). */
  findings?: unknown[]
  /** A failed import's report and xacro arguments, as the dialog gets them. */
  failure?: { report: unknown[]; mainFile?: string; xacroArgs: { name: string; value: string | undefined }[] }
}

/** Loads the imported robot with its meshes, the way DigitalTwin does, turned Z-up to Y-up under a parent. */
async function loadLikeTwin(profileId: string, urdf: string): Promise<{ robot: import('urdf-loader').URDFRobot; scene: THREE.Group }> {
  const manager = new THREE.LoadingManager()
  const resolver = getImportedAssetResolver(profileId)
  if (resolver) manager.setURLModifier(resolver)
  const loader = new URDFLoader(manager)
  loader.packages = (pkg: string) => pkg
  configureMultiFormatMeshLoader(loader, manager)
  let robot: import('urdf-loader').URDFRobot | null = null
  const loaded = new Promise<void>((done) => (manager.onLoad = done))
  robot = loader.parse(urdf)
  // a robot with no meshes never starts the manager, so onLoad never fires
  if (Array.from(new DOMParser().parseFromString(urdf, 'application/xml').querySelectorAll('mesh[filename]')).length > 0) await loaded
  const scene = new THREE.Group()
  robot.rotation.set(-Math.PI / 2, 0, 0)
  scene.add(robot)
  scene.updateMatrixWorld(true)
  return { robot, scene }
}

async function toFiles(list: HarnessFile[]): Promise<File[]> {
  return Promise.all(
    list.map(async ({ path, url }) => {
      const blob = await (await fetch(url)).blob()
      const file = new File([blob], path.split('/').pop() ?? path)
      if (path.includes('/')) Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true })
      return file
    }),
  )
}

/** `want.urdf` also returns the URDF the importer produced (check-import's fixtures read it; the corpus check does not). */
async function run(list: HarnessFile[], options: Record<string, unknown> = {}, want: { urdf?: boolean; units?: boolean } = {}): Promise<HarnessResult> {
  const files = await toFiles(list)
  const t0 = performance.now()
  try {
    // the options are ignored by an importer that takes none (v1), so the same harness measures before and after
    const { profile, warnings, report, notes, mainFile, xacroArgs, findings } = await (importRobotFiles as (f: File[], o?: unknown) => ReturnType<typeof importRobotFiles>)(files, options)
    const ms = performance.now() - t0
    const urdf = await (await fetch(getRobotProfile(profile.id).urdfPath)).text()
    const given = new Set(list.map((f) => f.path.toLowerCase()))
    const refs = Array.from(new DOMParser().parseFromString(urdf, 'application/xml').querySelectorAll('mesh[filename]'), (m) => m.getAttribute('filename') ?? '')
    const decode = (r: string) => r.split('/').map((s) => { try { return decodeURIComponent(s) } catch { return s } }).join('/').toLowerCase()
    const unresolved = refs.filter((r) => !given.has(decode(r)))
    const meshes = { total: refs.length, resolved: refs.length - unresolved.length, unresolved: [...new Set(unresolved)].slice(0, 5) }
    const loader = new URDFLoader(new THREE.LoadingManager())
    loader.loadMeshCb = (_p, _m, _material, done) => done(new THREE.Group())
    const robot = loader.parse(urdf)
    robot.updateMatrixWorld(true)
    const joints: NonNullable<HarnessResult['joints']> = {}
    for (const [name, j] of Object.entries(robot.joints)) {
      const axis = (j.axis ?? new THREE.Vector3(1, 0, 0)).clone().normalize()
      const lim = j.limit as { lower?: number; upper?: number } | undefined
      joints[name] = { type: j.jointType, axis: [axis.x, axis.y, axis.z], lower: lim?.lower ?? null, upper: lim?.upper ?? null }
    }
    const poses: NonNullable<HarnessResult['poses']> = {}
    const p = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    for (const [name, link] of Object.entries(robot.links)) {
      link.matrixWorld.decompose(p, q, s)
      poses[name] = { xyz: [p.x, p.y, p.z], quat: [q.w, q.x, q.y, q.z] }
    }
    let units: HarnessResult['units']
    if (want.units) {
      const { robot: twin, scene } = await loadLikeTwin(profile.id, urdf)
      const offer = checkUnits(twin, profile.groundContactLinks)
      if (offer) applyUnitsFix(twin, offer.fix)
      scene.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(scene)
      const size = box.getSize(new THREE.Vector3())
      const footY = Math.min(...profile.groundContactLinks.map((n) => twin.links[n]).filter(Boolean).map((l) => new THREE.Box3().setFromObject(l).min.y))
      units = { offer, size: [size.x, size.y, size.z], groundAtBottom: Math.abs(footY - box.min.y) <= 1e-6 * Math.max(1, size.y) }
    }
    return { ok: true, ms, units, robotName: robot.robotName, profileName: profile.name, profileJoints: profile.joints.length,
      profileSlots: profile.joints.map((j) => j.sdkMotorIndex ?? -2),
      profile: { category: profile.category, nominalPelvisHeight: profile.nominalPelvisHeight, groundContactLinks: profile.groundContactLinks }, warnings, joints, poses, meshes, ...(want.urdf ? { urdf } : {}),
      report: report?.toJson().items, notes, mainFile, xacroArgs, findings }
  } catch (err) {
    const f = importFailure(err)
    return { ok: false, ms: performance.now() - t0, error: err instanceof Error ? err.message : String(err),
      ...(f ? { failure: { report: f.report.toJson().items, mainFile: f.mainFile, xacroArgs: f.xacroArgs } } : {}) }
  }
}

/**
 * One description file through its converter alone, with what the converter leaves in the context for the model check and
 * the check's findings. `triangles` stands in for the importer's count of each collision mesh, by its filename as written.
 */
function convert(text: string, fileName: string, triangles?: Record<string, number>) {
  const ctx: Parameters<typeof parseRobotDescription>[2] = { warnings: [] }
  const urdf = parseRobotDescription(text, fileName, ctx)
  const findings = checkModel(new DOMParser().parseFromString(urdf, 'application/xml'), {
    format: isMuJoCoModel(text) ? 'mjcf' : isSdfModel(text) ? 'sdf' : 'urdf',
    mjcf: ctx.mjcfInertia,
    sdfAutoInertia: ctx.sdfAutoInertia,
    sdfHelperLinks: ctx.sdfHelperLinks,
    collisionTriangles: triangles ? (f) => (f in triangles ? { triangles: triangles[f], exact: true } : undefined) : undefined,
  })
  return { urdf, warnings: ctx.warnings, mjcfInertia: ctx.mjcfInertia, sdfAutoInertia: ctx.sdfAutoInertia, sdfHelperLinks: ctx.sdfHelperLinks, findings }
}

;(window as unknown as { __rocoImport: unknown }).__rocoImport = { run, convert }
