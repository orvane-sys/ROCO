import { useEffect, useState, useRef } from 'react'
import { Dialog } from './Dialog'
import { FolderUp, FileCode, Upload, CheckCircle2, AlertCircle, Loader2, Download, RotateCcw } from 'lucide-react'
import { collectDroppedFiles, importFailure, importRobotFiles, type ImportOptions, type XacroArg } from '../utils/robotImporter'
import { REPORT_KINDS, type ImportReport, type ReportKind } from '../utils/importReport'
import { downloadText, fileStamp } from '../utils/download'
import type { RobotProfile } from '../config/robotRegistry'

interface ImportRobotDialogProps {
  isOpen: boolean
  onClose: () => void
  onImportSuccess?: (profile: RobotProfile) => void
  /** Files dropped on the 3D view: imported once when the dialog opens, so their report is shown here. */
  initialFiles?: File[] | null
}

const KIND_LABEL: Record<ReportKind, string> = {
  error: 'Problems',
  limit: 'Limits',
  unsupported: 'Not supported',
  approx: 'Approximated',
  substitution: 'Substituted',
  fix: 'Fixed',
}

/** What the last import left to show: its report, notes and the xacro's arguments, whether it worked or not. */
interface Details {
  report: ImportReport | null
  notes: string[]
  mainFile?: string
  xacroArgs: XacroArg[]
}
const NO_DETAILS: Details = { report: null, notes: [], xacroArgs: [] }

export function ImportRobotDialog({ isOpen, onClose, onImportSuccess, initialFiles }: ImportRobotDialogProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successProfile, setSuccessProfile] = useState<RobotProfile | null>(null)
  const [details, setDetails] = useState<Details>(NO_DETAILS)
  // the argument values typed into the form, by name; only these are sent again, so defaults that use other args follow them
  const [argEdits, setArgEdits] = useState<Record<string, string>>({})

  const folderInputRef = useRef<HTMLInputElement>(null)
  const filesInputRef = useRef<HTMLInputElement>(null)
  // the files of the last import and the argument values it was given, for "Import again"
  const lastFiles = useRef<File[]>([])
  const lastArgs = useRef<Record<string, string>>({})
  // the typed value of one argument; own properties only, since an argument may be named `constructor` or `toString`
  const edited = (name: string): string | undefined => (Object.hasOwn(argEdits, name) ? argEdits[name] : undefined)
  // the import function of the latest render, and the dropped files already imported (each drop is imported once)
  const processRef = useRef<((files: File[]) => Promise<void>) | null>(null)
  const importedDrop = useRef<File[] | null>(null)

  const handleProcessFiles = async (files: FileList | File[], options: ImportOptions = {}) => {
    const list = Array.from(files)
    lastFiles.current = list
    lastArgs.current = options.xacroArgs ?? {}
    setError(null)
    setSuccessProfile(null)
    setDetails(NO_DETAILS)
    setArgEdits({})
    setIsLoading(true)

    try {
      const { profile, report, notes, mainFile, xacroArgs } = await importRobotFiles(list, options)
      setSuccessProfile(profile)
      setDetails({ report, notes, mainFile, xacroArgs })
      setIsLoading(false)
      onImportSuccess?.(profile)
      // Close on a clean import; keep the dialog open so the user can read the report or change the xacro's arguments.
      if (report.items.length === 0 && notes.length === 0 && xacroArgs.length === 0) {
        setTimeout(() => {
          onClose()
        }, 900)
      }
    } catch (err) {
      console.error('Import error:', err)
      // the browser refuses to read a chosen file again once it has changed, moved or been deleted on disk
      const gone = err instanceof DOMException && (err.name === 'NotReadableError' || err.name === 'NotFoundError')
      setError(
        gone
          ? 'A chosen file changed, moved or was deleted after it was chosen, so it could not be read. Choose the files again.'
          : err instanceof Error && err.message
            ? err.message
            : 'Failed to parse and import robot description.'
      )
      const failed = importFailure(err)
      if (failed) setDetails({ report: failed.report, notes: [], mainFile: failed.mainFile, xacroArgs: failed.xacroArgs })
      setIsLoading(false)
    }
  }

  useEffect(() => {
    processRef.current = handleProcessFiles
  })
  useEffect(() => {
    if (!isOpen || !initialFiles || importedDrop.current === initialFiles) return
    importedDrop.current = initialFiles
    void processRef.current?.(initialFiles)
  }, [isOpen, initialFiles])

  if (!isOpen) return null

  const importAgain = () => {
    const xacroArgs = { ...lastArgs.current, ...argEdits }
    void handleProcessFiles(lastFiles.current, { mainFile: details.mainFile, xacroArgs })
  }

  const downloadReport = () => {
    const head = [
      'ROCO import report',
      `Model: ${successProfile ? `${successProfile.name} (${successProfile.joints.length} joint${successProfile.joints.length === 1 ? '' : 's'})` : 'not imported'}`,
      ...(details.mainFile ? [`Main file: ${details.mainFile}`] : []),
      ...(error ? [`Error: ${error}`] : []),
      ...details.xacroArgs.map((a) => `xacro arg ${a.name} = ${a.value ?? '(no value)'}`),
      '',
    ]
    const notes = details.notes.length ? ['', 'Notes:', ...details.notes, ''] : []
    downloadText(`roco_import_report_${fileStamp()}.txt`, head.join('\n') + '\n' + (details.report?.toText() ?? 'Nothing to report.\n') + notes.join('\n'))
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleProcessFiles(await collectDroppedFiles(e.dataTransfer))
    }
  }

  const report = details.report
  const hasReport = (report?.items.length ?? 0) > 0 || details.notes.length > 0
  const missingArgs = details.xacroArgs.filter((a) => a.value === undefined && !(edited(a.name) ?? '').length)

  return (
    <Dialog title="Import Custom Robot Model" onClose={onClose}>
      <div className="flex flex-col gap-4 text-ink">
        <p className="text-xs text-ink-soft leading-relaxed">
          Upload a robot description (<strong>.urdf</strong>, <strong>.xacro</strong>, MuJoCo{' '}
          <strong>.xml</strong> or Gazebo <strong>.sdf</strong>) along with its visual meshes (<strong>.stl</strong>, <strong>.dae</strong>,{' '}
          <strong>.obj</strong>, <strong>.glb</strong>), or one <strong>.zip</strong> of the robot folder, to see the
          model in 3D. Live data comes only from a ROCO bridge,
          which reads Unitree LowState, so another robot shows its model with no data.
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
            <span className="flex-1 break-words min-w-0">{error}</span>
          </div>
        )}

        {/* What the import fixed, approximated or could not use, grouped by kind */}
        {!isLoading && hasReport && (
          <section aria-label="Import report" className="p-3 rounded-lg bg-raised border border-line-strong text-xs">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="font-semibold text-ink">Import report</h3>
              <button
                type="button"
                onClick={downloadReport}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-surface hover:bg-high border border-line-strong font-semibold text-ink"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                Download report
              </button>
            </div>
            {/* focusable so the list scrolls from the keyboard when it is longer than its box */}
            <div tabIndex={0} role="group" aria-label="Report items" className="max-h-56 overflow-y-auto space-y-2 pr-1 rounded">
              {REPORT_KINDS.map((kind) => {
                const items = report?.byKind(kind) ?? []
                if (items.length === 0) return null
                return (
                  <div key={kind}>
                    <h4 className={`font-semibold ${kind === 'error' ? 'text-crit-ink' : kind === 'limit' ? 'text-warn-ink' : 'text-ink'}`}>
                      {KIND_LABEL[kind]} ({items.length})
                    </h4>
                    <ul className="list-disc pl-4 space-y-1 mt-0.5 text-ink-soft">
                      {items.map((item, i) => (
                        <li key={i} className="break-words">
                          <span className="text-ink">{item.message}</span>
                          {item.count > 1 && <span> ×{item.count}</span>}
                          {item.where.length > 0 && (
                            <span className="block font-mono text-[11px]">
                              {item.where.join(', ')}
                              {item.count > item.where.length ? ', …' : ''}
                            </span>
                          )}
                          {item.hint && <span className="block">{item.hint}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
              {details.notes.length > 0 && (
                <div>
                  <h4 className="font-semibold text-ink">Notes</h4>
                  <ul className="list-disc pl-4 space-y-1 mt-0.5 text-ink-soft">
                    {details.notes.map((n, i) => (
                      <li key={i} className="break-words">{n}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>
        )}

        {/* The xacro's $(arg) values: change them and import the same files again */}
        {!isLoading && details.xacroArgs.length > 0 && (
          <form
            aria-label="Xacro arguments"
            className="p-3 rounded-lg bg-raised border border-line-strong text-xs flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              importAgain()
            }}
          >
            <h3 className="font-semibold text-ink">Xacro arguments</h3>
            {missingArgs.length > 0 && (
              <p className="text-warn-ink">
                {missingArgs.length === 1 ? 'One argument has' : `${missingArgs.length} arguments have`} no value: give{' '}
                {missingArgs.length === 1 ? 'it' : 'them'} one and import again.
              </p>
            )}
            <div className="max-h-48 overflow-y-auto flex flex-col gap-1.5 pr-1">
              {details.xacroArgs.map((a, i) => {
                const id = `xacro-arg-${i}`
                const missing = a.value === undefined
                return (
                  <div key={a.name} className="flex items-center gap-2 min-w-0">
                    <label htmlFor={id} className="w-2/5 shrink-0 font-mono text-ink truncate" title={a.name}>
                      {a.name}
                      {missing && <span className="text-warn-ink"> (needed)</span>}
                    </label>
                    <input
                      id={id}
                      type="text"
                      value={edited(a.name) ?? a.value ?? ''}
                      placeholder={missing ? 'no value' : undefined}
                      aria-invalid={missing && !(edited(a.name) ?? '').length ? true : undefined}
                      onChange={(e) => setArgEdits((m) => ({ ...m, [a.name]: e.target.value }))}
                      className="flex-1 min-w-0 px-2 py-1 rounded bg-surface border border-line-strong text-ink font-mono"
                    />
                  </div>
                )
              })}
            </div>
            <button
              type="submit"
              className="self-start flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-surface hover:bg-high border border-line-strong font-semibold text-ink"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              Import again with these values
            </button>
          </form>
        )}

        {!isLoading && successProfile && (hasReport || details.xacroArgs.length > 0) && (
          <button
            type="button"
            onClick={onClose}
            className="self-start px-3 py-1.5 rounded bg-accent-solid hover:bg-accent-solid/85 text-on-accent font-semibold text-xs"
          >
            Done
          </button>
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
            accept=".zip,.urdf,.xacro,.xml,.sdf,.config,.stl,.dae,.obj,.glb,.gltf"
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
