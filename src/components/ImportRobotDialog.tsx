import { useState, useRef } from 'react'
import { Dialog } from './Dialog'
import { FolderUp, FileCode, Upload, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { collectDroppedFiles, importRobotFiles } from '../utils/robotImporter'
import type { RobotProfile } from '../config/robotRegistry'

interface ImportRobotDialogProps {
  isOpen: boolean
  onClose: () => void
  onImportSuccess?: (profile: RobotProfile) => void
}

export function ImportRobotDialog({ isOpen, onClose, onImportSuccess }: ImportRobotDialogProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successProfile, setSuccessProfile] = useState<RobotProfile | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const folderInputRef = useRef<HTMLInputElement>(null)
  const filesInputRef = useRef<HTMLInputElement>(null)

  if (!isOpen) return null

  const handleProcessFiles = async (files: FileList | File[]) => {
    setError(null)
    setSuccessProfile(null)
    setWarnings([])
    setIsLoading(true)

    try {
      const { profile, warnings: importWarnings } = await importRobotFiles(files)
      setSuccessProfile(profile)
      setWarnings(importWarnings)
      setIsLoading(false)
      onImportSuccess?.(profile)
      // Close on a clean import; keep the dialog open so the user can read any warnings.
      if (importWarnings.length === 0) {
        setTimeout(() => {
          onClose()
        }, 900)
      }
    } catch (err) {
      console.error('Import error:', err)
      setError(err instanceof Error && err.message ? err.message : 'Failed to parse and import robot description.')
      setIsLoading(false)
    }
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleProcessFiles(await collectDroppedFiles(e.dataTransfer))
    }
  }

  return (
    <Dialog title="Import Custom Robot Model" onClose={onClose}>
      <div className="flex flex-col gap-4 text-ink">
        <p className="text-xs text-ink-soft leading-relaxed">
          Upload any robot description (<strong>.urdf</strong>, <strong>.xacro</strong>, or MuJoCo{' '}
          <strong>.xml</strong>) along with its visual meshes (<strong>.stl</strong>, <strong>.dae</strong>,{' '}
          <strong>.obj</strong>, <strong>.glb</strong>).
        </p>

        {/* Drop Zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={(e) => {
            e.preventDefault()
            setIsDragging(false)
          }}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center gap-3 transition-colors ${
            isDragging
              ? 'border-accent bg-accent-soft/40 text-accent-ink'
              : 'border-line-strong bg-surface/60 hover:border-line-bold text-ink-muted'
          }`}
        >
          {isLoading ? (
            <div className="flex flex-col items-center gap-2 py-4">
              <Loader2 className="w-8 h-8 text-accent animate-spin" />
              <span className="text-sm font-semibold text-ink">
                Parsing kinematics &amp; building profile…
              </span>
            </div>
          ) : successProfile ? (
            <div className="flex flex-col items-center gap-2 py-4 text-ok">
              <CheckCircle2 className="w-8 h-8" />
              <span className="text-sm font-semibold text-ok-ink">
                Imported {successProfile.name} ({successProfile.joints.length} joint{successProfile.joints.length === 1 ? '' : 's'})!
              </span>
            </div>
          ) : (
            <>
              <Upload className={`w-8 h-8 ${isDragging ? 'text-accent' : 'text-ink-muted'}`} />
              <div className="text-center">
                <span className="text-sm font-semibold text-ink">
                  Drag and drop files or a folder here
                </span>
                <p className="text-xs text-ink-muted mt-0.5">
                  or choose an upload method below
                </p>
              </div>
            </>
          )}
        </div>

        {/* Error Alert */}
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-crit-soft/60 border border-crit-line/60 text-xs text-crit-ink">
            <AlertCircle className="w-4 h-4 text-crit shrink-0 mt-0.5" />
            <span className="flex-1">{error}</span>
          </div>
        )}

        {/* Import warnings (missing meshes, unsupported xacro/MJCF features) */}
        {warnings.length > 0 && (
          <div role="status" className="p-3 rounded-lg bg-warn-soft/60 border border-warn-line/60 text-xs text-warn-ink">
            <p className="font-semibold mb-1">Imported with {warnings.length} warning{warnings.length === 1 ? '' : 's'}:</p>
            <ul className="list-disc pl-4 space-y-1 max-h-40 overflow-y-auto">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 px-3 py-1.5 rounded bg-warn-ink text-warn-soft font-semibold text-xs hover:bg-warn-ink/85"
            >
              Done
            </button>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center gap-3 pt-1">
          {/* Hidden inputs */}
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error webkitdirectory is standard across modern Chromium/Firefox/Safari
            webkitdirectory="true"
            directory="true"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleProcessFiles(e.target.files)
              }
            }}
          />
          <input
            ref={filesInputRef}
            type="file"
            multiple
            accept=".urdf,.xacro,.xml,.stl,.dae,.obj,.glb,.gltf"
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleProcessFiles(e.target.files)
              }
            }}
          />

          <button
            type="button"
            disabled={isLoading}
            onClick={() => folderInputRef.current?.click()}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-raised hover:bg-high border border-line-strong text-xs font-semibold text-ink transition-colors disabled:opacity-50 cursor-pointer"
          >
            <FolderUp className="w-4 h-4 text-accent" />
            Select Robot Folder
          </button>

          <button
            type="button"
            disabled={isLoading}
            onClick={() => filesInputRef.current?.click()}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-accent-solid hover:bg-accent-solid/85 text-xs font-semibold text-on-accent transition-colors disabled:opacity-50 cursor-pointer"
          >
            <FileCode className="w-4 h-4" />
            Select Model Files
          </button>
        </div>
      </div>
    </Dialog>
  )
}

