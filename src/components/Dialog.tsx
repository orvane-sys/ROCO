import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface DialogProps {
  title: string
  icon?: ReactNode
  onClose: () => void
  children: ReactNode
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Modal dialog with Escape-to-close, backdrop click, a Tab focus trap, and focus restore to the
 * element that opened it. Focus lands on the first form field (else the first control) on open.
 */
export function Dialog({ title, icon, onClose, children }: DialogProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    if (!panel) return

    const focusables = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
    const initial =
      panel.querySelector<HTMLElement>('input:checked') ??
      panel.querySelector<HTMLElement>('input, select, textarea') ??
      focusables()[0]
    initial?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      opener?.focus?.()
    }
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-sunken/80 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-surface border border-line-strong rounded-2xl w-full max-w-md p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute top-3 right-3 p-2 rounded-lg text-ink-soft hover:text-ink hover:bg-raised transition-colors"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
        <div className="flex items-center gap-2.5 mb-4 pr-10">
          {icon}
          <h2 id={titleId} className="text-base font-semibold text-ink">
            {title}
          </h2>
        </div>
        {children}
      </div>
    </div>
  )
}
