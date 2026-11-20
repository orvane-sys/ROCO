// Imported-asset bookkeeping: small, so the 3D view can resolve an imported robot's files without loading the importer.
import { unregisterRobotProfile } from '../config/robotRegistry'
import { telemetryService } from '../services/telemetryStream'

interface ImportedAssets {
  /** Every blob URL created for this import; revoked together when the profile is evicted. */
  urls: string[]
  resolve: (url: string) => string
}
export const importedAssets = new Map<string, ImportedAssets>()
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

export function evictOldImports(keepId: string): void {
  for (const id of Array.from(importedAssets.keys())) {
    if (importedAssets.size <= MAX_IMPORTED_PROFILES) break
    if (id !== keepId && id !== telemetryService.getActiveRobotProfile().id) disposeImportedProfile(id)
  }
}
