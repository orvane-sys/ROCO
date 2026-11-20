import * as THREE from 'three'
import type URDFLoader from 'urdf-loader'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

/**
 * Configures URDFLoader to support .stl, .dae, .obj, .glb, and .gltf mesh loading.
 * Preserves embedded materials on .dae and .glb meshes, and provides PBR cockpit
 * materials when missing.
 */
export function configureMultiFormatMeshLoader(
  loader: URDFLoader,
  manager: THREE.LoadingManager,
  /** Gives the packed twin of an STL url (scripts/pack-meshes.mjs), or null when there is none. The STL is the fallback. */
  packedTwin?: (stlUrl: string) => string | null
): void {
  const defaultCockpitMaterial = new THREE.MeshStandardMaterial({
    color: 0x94a3b8, // Slate cockpit grey
    roughness: 0.35,
    metalness: 0.65,
  })

  const stlLoader = new STLLoader(manager)
  const colladaLoader = new ColladaLoader(manager)
  const objLoader = new OBJLoader(manager)
  const gltfLoader = new GLTFLoader(manager)
  gltfLoader.setMeshoptDecoder(MeshoptDecoder)

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

    const loadStl = () =>
      stlLoader.load(
        path,
        (geom) => {
          const mesh = new THREE.Mesh(geom, material || defaultCockpitMaterial.clone())
          done(mesh)
        },
        undefined,
        (err) => done(new THREE.Group(), err as Error)
      )

    if (ext === 'stl') {
      const packed = packedTwin?.(path) ?? null
      if (packed) {
        // same triangles, 6x smaller: quantized and meshopt compressed. The file has no material, so the URDF's or the cockpit grey is used.
        gltfLoader.load(
          packed,
          (gltf) => {
            gltf.scene.traverse((child) => {
              const m = child as THREE.Mesh
              if (m.isMesh) m.material = material || defaultCockpitMaterial.clone()
            })
            done(gltf.scene)
          },
          undefined,
          loadStl
        )
      } else loadStl()
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
