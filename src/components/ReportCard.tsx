import { useState } from 'react'
import { ClipboardCopy, FileText } from 'lucide-react'
import { downloadText, fileStamp } from '../utils/download'

interface ReportCardProps {
  /** Builds the Markdown when asked, so it always has the latest numbers. */
  build: () => string
}

/** Review: the session as Markdown, laid out like the hardware test reports. Built in the browser; nothing is uploaded. */
export function ReportCard({ build }: ReportCardProps) {
  const [status, setStatus] = useState('')
  const save = () => {
    downloadText(`roco_session_${fileStamp()}.md`, build(), 'text/markdown')
    setStatus('Report saved as a Markdown file.')
  }
  const copy = () => {
    navigator.clipboard
      ?.writeText(build())
      .then(() => setStatus('Report copied. Paste it into your test report.'))
      .catch(() => setStatus('The browser did not allow copying. Use Save instead.'))
  }
  return (
    <section data-action="report" aria-labelledby="report-heading" className="bg-surface/80 border border-line/90 rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <FileText className="w-5 h-5 text-accent" aria-hidden="true" />
        <h2 id="report-heading" className="text-base font-semibold text-ink">
          Session report
        </h2>
      </div>
      <p className="text-sm text-ink-soft">
        Summary, setup, timeline, the per-state numbers, the guided checks, abort checks, alerts and your marks, as Markdown in the
        layout of the hardware test reports. It lists what ROCO saw; it is not a clearance.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={save} className="px-3 py-1.5 min-h-8 rounded-lg bg-accent-solid text-on-accent font-semibold text-sm flex items-center gap-1.5">
          <FileText className="w-4 h-4" aria-hidden="true" />
          Save report (.md)
        </button>
        <button type="button" onClick={copy} className="px-3 py-1.5 min-h-8 rounded-lg border border-line-bold text-sm text-ink flex items-center gap-1.5 hover:bg-raised">
          <ClipboardCopy className="w-4 h-4" aria-hidden="true" />
          Copy
        </button>
      </div>
      <p role="status" className="text-xs text-ink-soft min-h-4">
        {status}
      </p>
    </section>
  )
}
