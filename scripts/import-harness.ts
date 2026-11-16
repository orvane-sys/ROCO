// The page side of the import checks (check-import-corpus.mjs and check-import.mjs). The check
// bundles this file with rolldown and loads it into a blank page. It calls the page's own importer, exactly as the import dialog
// does, then reads back the URDF the importer produced and reports its joints and each link's world pose with every joint at zero.
import * as THREE from 'three'
import URDFLoader from 'urdf-loader'
import { importRobotFiles } from '../src/utils/robotImporter'
import { getRobotProfile } from '../src/config/robotRegistry'

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
  warnings?: string[]
  joints?: Record<string, { type: string; axis: number[]; lower: number | null; upper: number | null }>
  poses?: Record<string, { xyz: number[]; quat: number[] }>
  /** Mesh references in the produced URDF, and how many name a file that was imported (by its full path). */
  meshes?: { total: number; resolved: number; unresolved: string[] }
  urdf?: string
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
async function run(list: HarnessFile[], options: Record<string, unknown> = {}, want: { urdf?: boolean } = {}): Promise<HarnessResult> {
  const files = await toFiles(list)
  const t0 = performance.now()
  try {
    // the options are ignored by an importer that takes none (v1), so the same harness measures before and after
    const { profile, warnings } = await (importRobotFiles as (f: File[], o?: unknown) => ReturnType<typeof importRobotFiles>)(files, options)
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
    return { ok: true, ms, robotName: robot.robotName, profileName: profile.name, profileJoints: profile.joints.length, warnings, joints, poses, meshes, ...(want.urdf ? { urdf } : {}) }
  } catch (err) {
    return { ok: false, ms: performance.now() - t0, error: err instanceof Error ? err.message : String(err) }
  }
}

;(window as unknown as { __rocoImport: unknown }).__rocoImport = { run }
