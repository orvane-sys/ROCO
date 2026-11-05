import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import URDFLoader, { type URDFRobot } from 'urdf-loader'
import type { ConnectionStatus } from '../types/telemetry'
import { telemetryService } from '../services/telemetryStream'
import { PLOT_SLOTS } from '../services/plotRing'
import { cursorSample, useCursorSample } from '../services/viewStore'
import { formatDataTime, positionText, replayBadge } from '../utils/monitorFormat'
import { setScene3d, themeVar, useUiPrefs } from '../services/uiPrefs'
import { recordFrame, setRenderState, useRenderStats } from '../services/renderStats'
import type { RobotProfile } from '../config/robotRegistry'
import {
  Eye,
  RotateCcw,
  Maximize2,
  Layers,
  Loader2,
  AlertCircle,
  Compass,
  Navigation,
  RefreshCw,
  X,
  Upload,
} from 'lucide-react'
import {
  collectDroppedFiles,
  configureMultiFormatMeshLoader,
  getImportedAssetResolver,
  importRobotFiles,
} from '../utils/robotImporter'
import { parseRobotDescription } from '../utils/modelFormatParser'

// Standard/physical materials expose `emissive`; others (basic, line) do not, which the code checks at runtime.
type EmissiveMaterial = THREE.Material & { emissive: THREE.Color; emissiveIntensity: number }

interface DigitalTwinProps {
  status: ConnectionStatus
  activeProfile?: RobotProfile
  selectedJointId?: string | null
  /** How much to draw. `off` builds no renderer at all. See `resolveScene3d`. */
  quality?: SceneQuality
}

export type SceneQuality = 'full' | 'low' | 'off'

// `low` is for the machine that also runs the policy (TEST_MANUAL section 4): a quarter of the frames, one pixel
// per CSS pixel and no shadow pass. `full` is the smooth view for desk use.
const QUALITY = {
  full: { fps: 0, dpr: 2, shadows: true },
  low: { fps: 15, dpr: 1, shadows: false },
} as const

// Fallback package root for resolving mesh relative paths ("meshes/*.STL")
const URDF_ROOT = `${import.meta.env.BASE_URL}models/g1_description/`

// Chase camera: look-at height and default offset (three.js space) — behind-right of the robot.
const CAMERA_TARGET_HEIGHT = 0.75
const CAMERA_OFFSET = new THREE.Vector3(-2.4, 0.75, 1.6)
const WORLD_UP = new THREE.Vector3(0, 1, 0)
// ROS (Z-up) → Three.js (Y-up) frame change, used to express the REP-103 attitude R = Rz·Ry·Rx exactly.
const ROS_TO_THREE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
const THREE_TO_ROS = ROS_TO_THREE.clone().invert()

// Exponential smoothing rate (1/s) applied identically to base pose and joints so they stay in sync.
const SMOOTHING_RATE = 25
// Pose jumps larger than this (m) are treated as a teleport/odometry reset and snapped.
const TELEPORT_DISTANCE = 2.0

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

function disposeObject(root: THREE.Object3D) {
  const materials = new Set<THREE.Material>()
  root.traverse((object) => {
    const renderable = object as THREE.Mesh
    renderable.geometry?.dispose()
    if (Array.isArray(renderable.material)) {
      renderable.material.forEach((m) => materials.add(m))
    } else if (renderable.material) {
      materials.add(renderable.material)
    }
  })
  materials.forEach((m) => m.dispose())
}

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return gl !== null
  } catch {
    return false
  }
}

const WEBGL_UNAVAILABLE_MESSAGE =
  '3D view unavailable: WebGL could not start in this browser. Teleop and telemetry still work.'

export function DigitalTwin({ status, activeProfile, selectedJointId, quality = 'full' }: DigitalTwinProps) {
  const containerRef = useRef<HTMLElement | null>(null)
  const mountRef = useRef<HTMLDivElement | null>(null)
  // Recolours the scene (background, floor, grid, markers) from the --scene-* tokens; set while the scene exists.
  const sceneThemeRef = useRef<(() => void) | null>(null)
  const { resolvedTheme } = useUiPrefs()
  const enabled = quality !== 'off'
  const draw = useRenderStats()
  const qualityRef = useRef<keyof typeof QUALITY>(quality === 'low' ? 'low' : 'full')
  // Re-applies resolution and shadows to the live renderer when the quality changes; set while the scene exists.
  const applyQualityRef = useRef<(() => void) | null>(null)

  const profile = activeProfile ?? telemetryService.getActiveRobotProfile()
  const cursor = useCursorSample()
  const monitorNow = telemetryService.getMonitorState()
  const activeRobotRef = useRef<URDFRobot | null>(null)
  const highlightedMeshesRef = useRef<Map<THREE.Mesh, { emissive: THREE.Color; intensity: number }>>(new Map())

  // Probed once up front so a browser without WebGL shows a message instead of throwing in the effect.
  const [webglSupported] = useState<boolean>(supportsWebGL)
  const [wireframe, setWireframe] = useState<boolean>(false)
  const [followHeading, setFollowHeading] = useState<boolean>(true)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number }>({ loaded: 0, total: 0 })
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState<boolean>(false)
  // Bumped by Retry and after a WebGL context restore to rebuild the whole scene from scratch.
  const [reloadKey, setReloadKey] = useState(0)
  const [robotLoaded, setRobotLoaded] = useState(0)
  const [hudPose, setHudPose] = useState<{ x: number; y: number; yaw: number }>({ x: 0, y: 0, yaw: 0 })

  const controlsRef = useRef<OrbitControls | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const materialsRef = useRef<Set<THREE.Material>>(new Set())
  const wireframeRef = useRef(wireframe)
  const followHeadingRef = useRef(followHeading)
  // Smoothed robot position in three.js space + ROS yaw, used by the camera reset button.
  const robotAnchorRef = useRef<{ position: THREE.Vector3; yaw: number }>({
    position: new THREE.Vector3(),
    yaw: 0,
  })

  useEffect(() => {
    const container = mountRef.current
    if (!container || !webglSupported || !enabled) return
    setIsLoading(true)
    setLoadProgress({ loaded: 0, total: 0 })
    const highlightedMeshes = highlightedMeshesRef.current

    // Everything below is owned by this effect run. React StrictMode mounts → unmounts → remounts,
    // so async loader callbacks from a torn-down run must check `disposed` and clean up after themselves.
    let disposed = false
    materialsRef.current = new Set()
    robotAnchorRef.current = { position: new THREE.Vector3(), yaw: 0 }

    const width = Math.max(1, container.clientWidth)
    const height = Math.max(1, container.clientHeight)

    // Scene setup
    const scene = new THREE.Scene()
    // colours here are placeholders; applySceneTheme() below sets them from the tokens
    scene.background = new THREE.Color()
    scene.fog = new THREE.FogExp2(0x000000, 0.03) // colour-ok: placeholder, replaced by applySceneTheme()

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 100)
    camera.position.set(0, CAMERA_TARGET_HEIGHT, 0).add(CAMERA_OFFSET)
    cameraRef.current = camera

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[qualityRef.current].dpr))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.3
    container.appendChild(renderer.domElement)

    const handleContextLost = (event: Event) => {
      event.preventDefault() // lets the browser attempt a restore
      setLoadError('3D view lost its graphics context. Recovering…')
    }
    const handleContextRestored = () => {
      setLoadError(null)
      setIsLoading(true)
      setLoadProgress({ loaded: 0, total: 0 })
      setReloadKey((k) => k + 1)
    }
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost)
    renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = Math.PI / 2 - 0.01 // Prevent clipping under floor
    controls.minDistance = 0.8
    controls.maxDistance = 18.0
    controls.target.set(0, CAMERA_TARGET_HEIGHT, 0)
    controls.update()
    controlsRef.current = controls

    // Lighting — key light (with its shadow frustum) and rim light follow the robot.
    scene.add(new THREE.AmbientLight(0xffffff, 0.8)) // colour-ok: scene lighting, same in every theme

    const keyLight = new THREE.DirectionalLight(0xf0f9ff, 2.4) // colour-ok: scene lighting, same in every theme
    const keyLightOffset = new THREE.Vector3(3, 6, 2.5)
    keyLight.position.copy(keyLightOffset)
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(2048, 2048)
    keyLight.shadow.camera.near = 0.5
    keyLight.shadow.camera.far = 20
    keyLight.shadow.camera.left = -2.5
    keyLight.shadow.camera.right = 2.5
    keyLight.shadow.camera.top = 2.5
    keyLight.shadow.camera.bottom = -2.5
    keyLight.shadow.bias = -0.0005
    scene.add(keyLight)
    scene.add(keyLight.target)

    const applyQuality = () => {
      const q = QUALITY[qualityRef.current]
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.dpr))
      if (container.clientWidth > 0 && container.clientHeight > 0) renderer.setSize(container.clientWidth, container.clientHeight)
      keyLight.castShadow = q.shadows
    }
    applyQualityRef.current = applyQuality
    applyQuality()

    const fillLight = new THREE.DirectionalLight(0x38bdf8, 1.4) // colour-ok: scene lighting, same in every theme
    fillLight.position.set(-4, 3, -3)
    scene.add(fillLight)

    const rimLight = new THREE.PointLight(0x06b6d4, 2.8, 10) // colour-ok: scene lighting, same in every theme
    const rimLightOffset = new THREE.Vector3(0, 0.4, -1.5)
    rimLight.position.copy(rimLightOffset)
    scene.add(rimLight)

    // Infinite ground: grid snaps to 1 m cells under the robot, the uniform floor simply follows.
    const makeGrid = () => {
      const g = new THREE.GridHelper(50, 50, themeVar('--scene-grid-main'), themeVar('--scene-grid-sub'))
      g.position.y = 0.001
      return g
    }
    let gridHelper = makeGrid()
    scene.add(gridHelper)

    const floorMaterial = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.15 })
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      floorMaterial
    )
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    scene.add(floor)

    // Dedicated floating-base parent in world scene.
    // Dynamic 6-DOF translation (x, y, z) and RPY attitude are applied to pelvisGroup.
    // Attitude is set from a quaternion (see the render loop) so it matches ROS fixed-axis RPY exactly.
    const pelvisGroup = new THREE.Group()
    scene.add(pelvisGroup)
    const attitudeEuler = new THREE.Euler(0, 0, 0, 'ZYX')
    const attitudeQuat = new THREE.Quaternion()

    // Ground footprint ring + heading arrow in Three.js XZ plane (Y = 0)
    const groundMarker = new THREE.Group()
    scene.add(groundMarker)

    const footprintMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3, side: THREE.DoubleSide })
    const footprintRing = new THREE.Mesh(new THREE.RingGeometry(0.04, 0.38, 32), footprintMaterial)
    footprintRing.rotation.x = -Math.PI / 2 // Flat in XZ plane
    footprintRing.position.y = 0.002
    groundMarker.add(footprintRing)

    const headingMaterial = new THREE.MeshBasicMaterial()
    const headingArrow = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.18, 16), headingMaterial)
    headingArrow.rotation.z = -Math.PI / 2 // Apex points along +X (robot forward)
    headingArrow.position.set(0.42, 0.003, 0)
    groundMarker.add(headingArrow)

    const applySceneTheme = () => {
      const bg = themeVar('--scene-bg')
      ;(scene.background as THREE.Color).set(bg)
      ;(scene.fog as THREE.FogExp2).color.set(bg)
      floorMaterial.color.set(themeVar('--scene-floor'))
      // GridHelper bakes its colours into the geometry, so it is rebuilt (keeping its snapped position)
      const old = gridHelper
      gridHelper = makeGrid()
      gridHelper.position.copy(old.position)
      scene.remove(old)
      old.geometry.dispose()
      ;(old.material as THREE.Material).dispose()
      scene.add(gridHelper)
      footprintMaterial.color.set(themeVar('--scene-grid-main'))
      headingMaterial.color.set(themeVar('--scene-mark'))
    }
    applySceneTheme()
    sceneThemeRef.current = applySceneTheme

    // ---- URDF loading -------------------------------------------------------------------------
    // URDFLoader's onLoad fires once the XML is parsed — BEFORE any STL has arrived. A dedicated
    // LoadingManager tells us when every mesh is actually loaded (for shadows, materials, foot bounds).
    let robot: URDFRobot | null = null
    let robotFinalized = false
    let failedMeshes = 0
    const nominalPelvis = profile.nominalPelvisHeight ?? 0.793
    let calibratedPelvisHeight = nominalPelvis
    const soleProbes: { mesh: THREE.Mesh; corners: THREE.Vector3[] }[] = []
    const probePoint = new THREE.Vector3()

    /** World height of the lowest sole point, given the current base/joint transforms. */
    const lowestSoleHeight = () => {
      let minHeight = Infinity
      for (const { mesh, corners } of soleProbes) {
        for (const corner of corners) {
          minHeight = Math.min(minHeight, probePoint.copy(corner).applyMatrix4(mesh.matrixWorld).y)
        }
      }
      return minHeight
    }

    const manager = new THREE.LoadingManager()
    manager.onProgress = (_url, loaded, total) => {
      if (!disposed) setLoadProgress({ loaded, total })
    }
    manager.onError = (url) => {
      failedMeshes++
      console.error('ROCO: failed to load robot asset', url)
    }
    manager.onLoad = () => {
      if (!robot || robotFinalized) return
      robotFinalized = true
      if (disposed) {
        disposeObject(robot)
        return
      }

      activeRobotRef.current = robot

      const materials = materialsRef.current
      robot.traverse((child) => {
        const mesh = child as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.castShadow = true
        mesh.receiveShadow = true
        const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        meshMaterials.forEach((m) => {
          if ('wireframe' in m) (m as THREE.MeshPhongMaterial).wireframe = wireframeRef.current
          materials.add(m)
        })
      })

      // Sole contact probes: the 8 corners of each contact link mesh's local AABB.
      soleProbes.length = 0
      for (const linkName of (profile.groundContactLinks ?? [])) {
        robot.links[linkName]?.traverse((child) => {
          const mesh = child as THREE.Mesh
          if (!mesh.isMesh) return
          mesh.geometry.computeBoundingBox()
          const { min, max } = mesh.geometry.boundingBox!
          const corners: THREE.Vector3[] = []
          for (const x of [min.x, max.x])
            for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) corners.push(new THREE.Vector3(x, y, z))
          soleProbes.push({ mesh, corners })
        })
      }

      // Fallback to all robot meshes if no contact links matched
      if (soleProbes.length === 0) {
        robot.traverse((child) => {
          const mesh = child as THREE.Mesh
          if (!mesh.isMesh) return
          mesh.geometry.computeBoundingBox()
          const { min, max } = mesh.geometry.boundingBox!
          const corners: THREE.Vector3[] = []
          for (const x of [min.x, max.x])
            for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) corners.push(new THREE.Vector3(x, y, z))
          soleProbes.push({ mesh, corners })
        })
      }

      // Mount robot as child of pelvisGroup with strictly fixed ROS to Three.js orientation:
      // URDF is REP-103 (+X fwd, +Y left, +Z up).
      // Rotation -90° about X maps: URDF +Z -> Three.js +Y, URDF +X -> Three.js +X, URDF +Y -> Three.js -Z.
      robot.position.set(0, 0, 0)
      robot.rotation.set(-Math.PI / 2, 0, 0)
      pelvisGroup.add(robot)

      // Initial ground contact calibration: measure sole height at nominal standing posture
      pelvisGroup.position.set(0, nominalPelvis, 0)
      pelvisGroup.rotation.set(0, 0, 0)
      pelvisGroup.updateMatrixWorld(true)

      const initialLowestSole = lowestSoleHeight()
      if (Number.isFinite(initialLowestSole)) {
        calibratedPelvisHeight = nominalPelvis - initialLowestSole
        pelvisGroup.position.y = calibratedPelvisHeight
        pelvisGroup.updateMatrixWorld(true)
      }

      if (failedMeshes > 0) {
        setLoadError(`${failedMeshes} mesh file(s) failed to load — see console`)
      }
      setIsLoading(false)
      setRobotLoaded((k) => k + 1)
    }

    const loader = new URDFLoader(manager)
    const importedResolver = getImportedAssetResolver(profile.id)
    if (importedResolver) {
      // Imported robots live in memory: let the importer's blob map answer every mesh request, and keep
      // package:// references resolvable ("<pkg>/<rel path>" is matched by file name).
      manager.setURLModifier(importedResolver)
      loader.packages = (pkg: string) => pkg
    } else {
      loader.packages = profile.packages || { g1_description: URDF_ROOT, '': URDF_ROOT }
    }
    configureMultiFormatMeshLoader(loader, manager)

    // Preprocess model files (supporting .urdf, .xacro, and MuJoCo .xml)
    fetch(profile.urdfPath)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
        return res.text()
      })
      .then((rawText) => {
        if (disposed) return
        const processedUrdf = parseRobotDescription(rawText, profile.urdfPath)
        // parse() does not know where the file came from: without a working path "meshes/x.STL"
        // resolves against the page root instead of the URDF's directory.
        loader.workingPath = THREE.LoaderUtils.extractUrlBase(profile.urdfPath)
        const parsed = loader.parse(processedUrdf)
        robot = parsed
      })
      .catch((err) => {
        console.error(`Error loading robot model (${profile.id}):`, err)
        if (disposed) return
        setLoadError(`Failed to load ${profile.name} robot model description`)
        setIsLoading(false)
      })

    // Resize Handler
    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth
      const h = container.clientHeight
      if (w === 0 || h === 0) return
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    })
    resizeObserver.observe(container)

    // ---- Render loop (60–144 Hz, decoupled from React) -------------------------------------------
    const smoothedPose = { x: 0, y: 0, roll: 0, pitch: 0, yaw: 0, initialized: false }
    const smoothedJoints = new Map<string, number>()
    const robotPosition = new THREE.Vector3()
    const lastRobotPosition = new THREE.Vector3()
    const cameraOffset = new THREE.Vector3()
    let lastYaw = 0

    let animationFrameId = 0
    let lastTime = performance.now()
    let lastHudUpdateTime = 0
    let lastDrawTime = 0

    // Nothing is drawn while the view is scrolled out of sight, behind another workspace, or in a hidden tab.
    let onScreen = true
    const isPaused = () => !onScreen || document.hidden

    const animate = () => {
      if (isPaused()) {
        animationFrameId = 0
        setRenderState('paused')
        return
      }
      animationFrameId = requestAnimationFrame(animate)

      const now = performance.now()
      const fpsCap = QUALITY[qualityRef.current].fps
      if (fpsCap > 0 && now - lastDrawTime < 1000 / fpsCap - 3) return
      lastDrawTime = now
      const dt = Math.min(0.1, (now - lastTime) / 1000)
      lastTime = now
      // Frame-rate independent exponential smoothing toward the latest 50 Hz sample.
      const alpha = 1 - Math.exp(-SMOOTHING_RATE * dt)

      const snapshot = telemetryService.getLatestSnapshot()
      const livePose = snapshot?.basePose
      // In a replay the shared time cursor (hovering a plot or the timeline) shows the joint angles and body tilt of that moment.
      const cs = telemetryService.getMonitorState().replay ? cursorSample() : null
      const pose =
        livePose && cs
          ? {
              ...livePose,
              roll: Number.isFinite(cs.ring.roll[cs.i]) ? cs.ring.roll[cs.i] : livePose.roll,
              pitch: Number.isFinite(cs.ring.pitch[cs.i]) ? cs.ring.pitch[cs.i] : livePose.pitch,
            }
          : livePose

      if (snapshot && pose && robot && robotFinalized) {
        // 1. Joint articulation
        const defs = cs ? telemetryService.getActiveRobotProfile().joints : null
        const rb = robot
        snapshot.joints.forEach((joint, idx) => {
          let target = joint.position
          if (cs && defs) {
            const slot = defs[idx]?.sdkMotorIndex ?? idx
            const q = slot >= 0 ? cs.ring.q[cs.i * PLOT_SLOTS + slot] : NaN
            if (Number.isFinite(q)) target = q
          }
          const current = smoothedJoints.get(joint.id)
          const next = current === undefined ? target : current + (target - current) * alpha
          smoothedJoints.set(joint.id, next)
          rb.joints[joint.id]?.setJointValue(next)
        })

        // 2. Floating-base pose smoothing (ROS frame)
        const sp = smoothedPose
        if (!sp.initialized || Math.hypot(pose.x - sp.x, pose.y - sp.y) > TELEPORT_DISTANCE) {
          Object.assign(sp, { x: pose.x, y: pose.y, roll: pose.roll, pitch: pose.pitch, yaw: pose.yaw })
          sp.initialized = true
          lastRobotPosition.set(sp.x, 0, -sp.y)
          lastYaw = sp.yaw
          controls.target.set(sp.x, CAMERA_TARGET_HEIGHT, -sp.y)
          camera.position.copy(CAMERA_OFFSET).applyAxisAngle(WORLD_UP, sp.yaw).add(controls.target)
          controls.update()
        } else {
          sp.x += (pose.x - sp.x) * alpha
          sp.y += (pose.y - sp.y) * alpha
          sp.roll += (pose.roll - sp.roll) * alpha
          sp.pitch += (pose.pitch - sp.pitch) * alpha
          sp.yaw = wrapAngle(sp.yaw + wrapAngle(pose.yaw - sp.yaw) * alpha)
        }

        // 3. Dynamic Base Positioning on pelvisGroup (Three.js coordinates)
        // ROS +X forward maps to Three.js +X. ROS +Y left maps to Three.js -Z.
        const nominalHeight = (pose.z ?? nominalPelvis) + (calibratedPelvisHeight - nominalPelvis)
        pelvisGroup.position.set(sp.x, nominalHeight, -sp.y)
        // ROS attitude R = Rz(yaw)·Ry(pitch)·Rx(roll) (BasePose contract), conjugated into Three.js axes.
        attitudeEuler.set(sp.roll, sp.pitch, sp.yaw, 'ZYX')
        pelvisGroup.quaternion
          .copy(ROS_TO_THREE)
          .multiply(attitudeQuat.setFromEuler(attitudeEuler))
          .multiply(THREE_TO_ROS)
        pelvisGroup.updateMatrixWorld(true)

        // 4. Dynamic Foot-to-Ground Contact Locking
        // Pull/push base vertically so the lowest sole rests exactly on y = 0.0
        if (soleProbes.length > 0) {
          const soleHeight = lowestSoleHeight()
          if (Number.isFinite(soleHeight)) {
            pelvisGroup.position.y -= soleHeight
            pelvisGroup.updateMatrixWorld(true)
          }
        }

        // 5. Update ground footprint marker at ground plane (y = 0.002)
        groundMarker.position.set(sp.x, 0.002, -sp.y)
        groundMarker.rotation.y = sp.yaw

        // 6. Chase camera: carry orbit target and smooth heading follow
        robotPosition.set(sp.x, 0, -sp.y)
        const yawDelta = wrapAngle(sp.yaw - lastYaw)
        lastYaw = sp.yaw
        const moveX = robotPosition.x - lastRobotPosition.x
        const moveZ = robotPosition.z - lastRobotPosition.z
        lastRobotPosition.copy(robotPosition)

        controls.target.x += moveX
        controls.target.z += moveZ
        camera.position.x += moveX
        camera.position.z += moveZ

        // OrbitControls state: -1 is STATE.NONE (idle). When state !== -1, user is actively orbiting/panning.
        const isUserInteracting =
          (controls as unknown as { state?: number }).state !== -1 &&
          (controls as unknown as { state?: number }).state !== undefined

        if (followHeadingRef.current && yawDelta !== 0 && !isUserInteracting) {
          cameraOffset.subVectors(camera.position, controls.target).applyAxisAngle(WORLD_UP, yawDelta)
          camera.position.copy(controls.target).add(cameraOffset)
        }
        robotAnchorRef.current.position.copy(robotPosition)
        robotAnchorRef.current.yaw = sp.yaw

        // The key light stays fixed in world space (stable shadows); the rim light is carried around
        // with the robot's heading so its glow stays behind it when it turns.
        keyLight.position.copy(robotPosition).add(keyLightOffset)
        keyLight.target.position.copy(robotPosition)
        rimLight.position
          .copy(rimLightOffset)
          .applyAxisAngle(WORLD_UP, sp.yaw)
          .add(robotPosition)
        floor.position.set(robotPosition.x, 0, robotPosition.z)
        gridHelper.position.x = Math.floor(robotPosition.x)
        gridHelper.position.z = Math.floor(robotPosition.z)

        // Throttle HUD display text update to ~10 Hz
        if (now - lastHudUpdateTime >= 100) {
          lastHudUpdateTime = now
          setHudPose({ x: sp.x, y: sp.y, yaw: sp.yaw })
        }
      }

      controls.update()
      renderer.render(scene, camera)
      recordFrame(performance.now() - now)
    }

    const resume = () => {
      if (animationFrameId !== 0 || isPaused()) return
      lastTime = performance.now()
      setRenderState('running')
      animationFrameId = requestAnimationFrame(animate)
    }
    const visibility = new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1]?.isIntersecting ?? true
      resume()
    })
    visibility.observe(container)
    document.addEventListener('visibilitychange', resume)

    setRenderState('running')
    animationFrameId = requestAnimationFrame(animate)

    return () => {
      disposed = true
      sceneThemeRef.current = null
      activeRobotRef.current = null
      highlightedMeshes.clear()
      cancelAnimationFrame(animationFrameId)
      visibility.disconnect()
      document.removeEventListener('visibilitychange', resume)
      applyQualityRef.current = null
      setRenderState('off')
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost)
      renderer.domElement.removeEventListener('webglcontextrestored', handleContextRestored)
      resizeObserver.disconnect()
      controls.dispose()
      if (controlsRef.current === controls) controlsRef.current = null
      if (cameraRef.current === camera) cameraRef.current = null

      // If the robot never got attached (unmounted mid-load), dispose it here; manager.onLoad
      // handles robots whose meshes finish loading after this point.
      if (robot && !robot.parent) disposeObject(robot)
      disposeObject(scene)
      materialsRef.current = new Set()

      renderer.dispose()
      renderer.forceContextLoss()
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, profile.id, enabled])

  // Emissive highlighting for the active joint's link mesh
  useEffect(() => {
    const robot = activeRobotRef.current
    const highlighted = highlightedMeshesRef.current

    // Restore previous materials
    highlighted.forEach((orig, mesh) => {
      const mat = mesh.material as EmissiveMaterial | EmissiveMaterial[]
      if (Array.isArray(mat)) {
        mat.forEach((m) => {
          if ('emissive' in m && orig.emissive) m.emissive.copy(orig.emissive)
          if ('emissiveIntensity' in m) m.emissiveIntensity = orig.intensity
        })
      } else if (mat) {
        if ('emissive' in mat && orig.emissive) mat.emissive.copy(orig.emissive)
        if ('emissiveIntensity' in mat) mat.emissiveIntensity = orig.intensity
      }
    })
    highlighted.clear()

    if (!robot || !selectedJointId) return

    // Find the link corresponding to this joint.
    // In G1 URDF, joints are named e.g. 'left_knee_joint' and child links are 'left_knee_link'.
    const linkName = selectedJointId.replace(/_joint$/, '_link')
    const targetObject =
      robot.links[linkName] ??
      robot.joints[selectedJointId] ??
      robot.links[selectedJointId]

    if (targetObject) {
      targetObject.traverse((child) => {
        const mesh = child as THREE.Mesh
        if (!mesh.isMesh) return

        const mat = mesh.material as EmissiveMaterial | EmissiveMaterial[]
        if (Array.isArray(mat)) {
          mat.forEach((m) => {
            if ('emissive' in m) {
              if (!highlighted.has(mesh)) {
                highlighted.set(mesh, {
                  emissive: m.emissive ? m.emissive.clone() : new THREE.Color(0, 0, 0),
                  intensity: m.emissiveIntensity ?? 1,
                })
              }
              m.emissive.set(themeVar('--scene-emissive'))
              m.emissiveIntensity = 1.0
            }
          })
        } else if (mat && 'emissive' in mat) {
          if (!highlighted.has(mesh)) {
            highlighted.set(mesh, {
              emissive: mat.emissive ? mat.emissive.clone() : new THREE.Color(0, 0, 0),
              intensity: mat.emissiveIntensity ?? 1,
            })
          }
          mat.emissive.set(themeVar('--scene-emissive'))
          mat.emissiveIntensity = 1.0
        }
      })
    }

    return () => {
      highlighted.forEach((orig, mesh) => {
        const mat = mesh.material as EmissiveMaterial | EmissiveMaterial[]
        if (Array.isArray(mat)) {
          mat.forEach((m) => {
            if ('emissive' in m && orig.emissive) m.emissive.copy(orig.emissive)
            if ('emissiveIntensity' in m) m.emissiveIntensity = orig.intensity
          })
        } else if (mat) {
          if ('emissive' in mat && orig.emissive) mat.emissive.copy(orig.emissive)
          if ('emissiveIntensity' in mat) mat.emissiveIntensity = orig.intensity
        }
      })
      highlighted.clear()
    }
  }, [selectedJointId, reloadKey, profile.id, robotLoaded, resolvedTheme])

  useEffect(() => {
    sceneThemeRef.current?.()
  }, [resolvedTheme])

  useEffect(() => {
    qualityRef.current = quality === 'low' ? 'low' : 'full'
    applyQualityRef.current?.()
  }, [quality])

  // Toggle wireframe on all robot mesh materials
  useEffect(() => {
    wireframeRef.current = wireframe
    materialsRef.current.forEach((material) => {
      if ('wireframe' in material) {
        ;(material as THREE.MeshPhongMaterial).wireframe = wireframe
      }
    })
  }, [wireframe])

  useEffect(() => {
    followHeadingRef.current = followHeading
  }, [followHeading])

  const resetCamera = () => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!camera || !controls) return
    const { position, yaw } = robotAnchorRef.current
    controls.target.set(position.x, CAMERA_TARGET_HEIGHT, position.z)
    camera.position.copy(CAMERA_OFFSET).applyAxisAngle(WORLD_UP, yaw).add(controls.target)
    controls.update()
  }

  const retryLoad = () => {
    setLoadError(null)
    setIsLoading(true)
    setLoadProgress({ loaded: 0, total: 0 })
    setReloadKey((k) => k + 1)
  }

  const toggleFullscreen = () => {
    if (!containerRef.current) return
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
  }

  const toolbarButton = (active: boolean) =>
    `p-2.5 rounded-lg border backdrop-blur-md transition-colors flex items-center justify-center ${
      active
        ? 'bg-accent-solid/30 border-accent text-accent-ink'
        : 'bg-surface/85 border-line-strong text-ink-soft hover:text-ink hover:bg-raised/90'
    }`

  const displayedError = webglSupported ? loadError : WEBGL_UNAVAILABLE_MESSAGE
  const showLoading = webglSupported && enabled && isLoading && !loadError

  const progressPercent =
    loadProgress.total > 0 ? Math.round((loadProgress.loaded / loadProgress.total) * 100) : 0

  const posNow = positionText(monitorNow, hudPose, 2)
  const posAria = positionText(monitorNow, hudPose, 1).recorded
    ? `at x ${positionText(monitorNow, hudPose, 1).x} metres, y ${positionText(monitorNow, hudPose, 1).y} metres`
    : 'position not recorded'
  const statusLabel =
    replayBadge(monitorNow) ??
    (status === 'LIVE'
      ? 'Live'
      : status === 'SAFETY_HALT'
      ? 'Halted'
      : status === 'CONNECTING'
      ? 'Connecting'
      : 'Offline')

  return (
    <section
      ref={containerRef}
      aria-label="Unitree G1 digital twin"
      onDragOver={(e) => {
        e.preventDefault()
        setIsDragOver(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        setIsDragOver(false)
      }}
      onDrop={async (e) => {
        e.preventDefault()
        setIsDragOver(false)
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          try {
            const { warnings } = await importRobotFiles(await collectDroppedFiles(e.dataTransfer))
            if (warnings.length > 0) console.warn('Robot import warnings:', warnings)
          } catch (err) {
            setLoadError(err instanceof Error ? err.message : 'Failed to import robot files')
          }
        }
      }}
      className="relative w-full h-full min-h-[19rem] bg-sunken rounded-xl overflow-hidden border border-line/80 shadow-2xl flex flex-col"
    >
      {/* Drag & Drop Visual Overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 bg-accent-soft/85 backdrop-blur-md border-2 border-dashed border-accent rounded-xl flex flex-col items-center justify-center gap-3 pointer-events-none p-6 text-center animate-in fade-in duration-150">
          <Upload className="w-12 h-12 text-accent-ink animate-bounce" />
          <h3 className="text-lg font-bold text-ink">Drop Robot Description or Folder to Import</h3>
          <p className="text-xs text-accent-ink max-w-sm">
            Supports .urdf, .xacro, MuJoCo .xml with .stl, .dae, .obj, .glb, or full robot description directories.
          </p>
        </div>
      )}

      {/* 3D Canvas Mount Point */}
      <div
        ref={mountRef}
        role="img"
        aria-label={!enabled ? '3D view is off' : `3D view of the Unitree G1 robot ${posAria}, heading ${Math.round((hudPose.yaw * 180) / Math.PI)} degrees`}
        className="w-full flex-1 min-h-0 cursor-grab active:cursor-grabbing"
      />

      {webglSupported && !enabled && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm font-semibold text-ink">3D view is off</p>
          <p className="text-xs text-ink-soft max-w-xs">Nothing is drawn, so it takes no time from this PC. Position and joints are still in the panels.</p>
          <button
            type="button"
            onClick={() => setScene3d('full')}
            className="px-3 py-2 min-h-11 rounded-lg bg-accent-solid hover:bg-accent-solid/85 text-on-accent text-sm font-semibold"
          >
            Turn on 3D
          </button>
        </div>
      )}

      {/* Loading Overlay */}
      {showLoading && (
        <div
          role="status"
          className="absolute inset-0 bg-sunken/90 backdrop-blur-md flex flex-col items-center justify-center gap-3 z-10 pointer-events-none px-6"
        >
          <Loader2 className="w-8 h-8 text-accent animate-spin" aria-hidden="true" />
          <span className="text-sm font-semibold text-ink">Loading robot model…</span>
          <div
            role="progressbar"
            aria-label="Robot model download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent}
            className="w-56 h-2 rounded-full bg-raised overflow-hidden"
          >
            <div
              className="h-full bg-accent transition-[width] duration-200"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className="text-xs text-ink-soft tabular-nums">
            {loadProgress.total > 0 ? `${loadProgress.loaded} of ${loadProgress.total} files` : 'Reading robot description…'}
          </span>
        </div>
      )}

      {/* Load Error Alert */}
      {displayedError && (
        <div
          role="alert"
          className="absolute top-16 left-3 right-3 bg-crit-soft/95 border border-crit-line p-3 rounded-xl flex items-start gap-3 text-crit-ink z-10 text-sm shadow-xl"
        >
          <AlertCircle className="w-5 h-5 text-crit shrink-0 mt-0.5" aria-hidden="true" />
          <span className="flex-1">{displayedError}</span>
          {webglSupported && (
          <button
            type="button"
            onClick={retryLoad}
            className="px-2.5 py-1 rounded-md bg-crit-ink text-crit-soft font-semibold hover:bg-crit-ink/85 flex items-center gap-1.5 shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            Retry
          </button>
          )}
          <button
            type="button"
            onClick={() => (webglSupported ? setLoadError(null) : undefined)}
            aria-label="Dismiss message"
            className="p-1 rounded-md text-crit-ink hover:bg-crit-soft shrink-0"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Top Overlay Badge & Controls */}
      <div className="absolute top-3 left-3 right-3 flex items-center justify-between gap-2 pointer-events-none">
        <div className="flex items-center gap-2 pointer-events-auto bg-surface/90 backdrop-blur-md px-3 py-2 rounded-lg border border-line-strong text-sm min-w-0">
          <div
            aria-hidden="true"
            className={`w-2 h-2 rounded-full ${
              status === 'LIVE'
                ? 'bg-ok'
                : status === 'SAFETY_HALT'
                ? 'bg-crit'
                : 'bg-warn'
            }`}
          />
          <span className="font-semibold text-ink truncate min-w-0">
            {profile.name}
            <span className="hidden sm:inline"> · Digital twin</span>
          </span>
          <span className="text-accent-ink text-xs hidden sm:inline shrink-0">{statusLabel}</span>
        </div>

        <div className="flex items-center gap-1.5 pointer-events-auto shrink-0">
          <button
            type="button"
            onClick={() => setFollowHeading(!followHeading)}
            aria-pressed={followHeading}
            aria-label="Camera follows robot heading"
            title={followHeading ? 'Camera follows heading (click for free orbit)' : 'Free orbit (click to follow heading)'}
            className={toolbarButton(followHeading)}
          >
            <Navigation className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setWireframe(!wireframe)}
            aria-pressed={wireframe}
            aria-label="Wireframe view"
            title="Toggle wireframe"
            className={toolbarButton(wireframe)}
          >
            <Layers className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={resetCamera}
            aria-label="Reset camera behind robot"
            title="Reset camera"
            className={toolbarButton(false)}
          >
            <RotateCcw className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label="Toggle fullscreen"
            title="Toggle fullscreen"
            className={toolbarButton(false)}
          >
            <Maximize2 className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Status strip under the canvas: a fixed height, so a longer text never resizes the 3D view. */}
      <div className="shrink-0 h-9 border-t border-line/80 bg-surface/90 px-3 flex items-center gap-3 text-xs text-ink-soft tabular-nums">
        {cursor && monitorNow.replay ? (
          <div role="status" className="min-w-0 flex-1 truncate text-ink" title={`Joint angles and tilt at ${formatDataTime(cursor.t, monitorNow)} (time cursor).${posNow.recorded ? ' Position is current.' : ''}`}>
            Joint angles and tilt at {formatDataTime(cursor.t, monitorNow)} (time cursor).{posNow.recorded ? ' Position is current.' : ''}
          </div>
        ) : (
          <div
            className="min-w-0 flex-1 truncate flex items-center gap-2"
            title={enabled && draw.state === 'running' ? `${draw.fps.toFixed(0)} fps, ${draw.avgMs.toFixed(1)} ms a frame` : undefined}
          >
            <Eye className="w-4 h-4 text-ink shrink-0" aria-hidden="true" />
            <span className="truncate">
              {followHeading ? 'Chase camera' : 'Free orbit'}
              {enabled && (quality === 'low' ? ` · Reduced 3D · ${QUALITY.low.fps} fps` : ' · 3D')}
              {enabled && quality !== 'low' && draw.state === 'running' && ` · ${draw.fps.toFixed(0)} fps`}
            </span>
          </div>
        )}
        <div className="shrink-0 flex items-center gap-3 text-ink">
          <Compass className="w-4 h-4 text-accent-ink" aria-hidden="true" />
          {posNow.recorded ? (
            <>
              <span>x {posNow.x} m</span>
              <span>y {posNow.y} m</span>
            </>
          ) : (
            <span>position not recorded</span>
          )}
          <span>heading {((hudPose.yaw * 180) / Math.PI).toFixed(0)}°</span>
        </div>
      </div>
    </section>
  )
}
