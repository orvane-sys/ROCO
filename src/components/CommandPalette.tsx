import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Command as CommandIcon } from 'lucide-react'
import { Dialog } from './Dialog'
import { actionFor } from '../config/actions'

export interface PaletteCommand {
  id: string
  group: string
  label: string
  /** Extra words that should find this command. */
  keywords?: string
  /** Shown to the right, such as a key. */
  hint?: string
  run: () => void
}

const MAX_SHOWN = 40

/** Ctrl+K: type to find a workspace, a joint or a setting, then Enter. A combobox with a listbox, usable by keyboard alone. */
export function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const listRef = useRef<HTMLUListElement | null>(null)

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const scored: { c: PaletteCommand; score: number }[] = []
    for (const c of commands) {
      const shown = `${c.group} ${c.label}`.toLowerCase()
      const hay = `${shown} ${c.keywords ?? ''}`.toLowerCase()
      if (!words.every((w) => hay.includes(w))) continue
      // commands whose visible text starts a word with each typed word come first
      const tokens = shown.split(/[\s:(]+/)
      const atWordStart = words.filter((w) => tokens.some((t) => t.startsWith(w))).length
      scored.push({ c, score: words.length - atWordStart })
    }
    scored.sort((a, b) => a.score - b.score)
    return scored.slice(0, MAX_SHOWN).map((s) => s.c)
  }, [commands, query])

  const current = Math.min(active, Math.max(0, shown.length - 1))
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current, shown])

  const run = (c: PaletteCommand | undefined) => {
    if (!c) return
    onClose()
    // after the dialog has returned focus to where it came from
    setTimeout(c.run, 0)
  }

  return (
    <Dialog title="Command palette" icon={<CommandIcon className="w-5 h-5 text-accent" aria-hidden="true" />} onClose={onClose}>
      <input
        type="text"
        role="combobox"
        aria-label="Type a command, joint or setting"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={shown.length ? `${listId}-${current}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        placeholder="Workspace, joint, theme…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive(Math.min(shown.length - 1, current + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive(Math.max(0, current - 1))
          } else if (e.key === 'Home' && e.ctrlKey) {
            setActive(0)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            run(shown[current])
          }
        }}
        className="w-full bg-sunken border border-line-bold rounded-lg px-3.5 py-2.5 text-sm text-ink focus:border-accent"
      />
      <div role="status" className="sr-only">
        {shown.length === 0 ? 'No matches' : `${shown.length} match${shown.length === 1 ? '' : 'es'}`}
      </div>
      <ul id={listId} ref={listRef} role="listbox" aria-label="Matches" className="mt-2 max-h-[min(50vh,22rem)] overflow-y-auto flex flex-col gap-0.5">
        {shown.map((c, i) => (
          <li
            key={c.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === current}
            onMouseMove={() => i !== current && setActive(i)}
            onClick={() => run(c)}
            className={
              'flex items-center justify-between gap-3 rounded-lg px-3 min-h-9 text-sm cursor-pointer ' +
              (i === current ? 'bg-accent-soft text-ink outline outline-1 outline-accent' : 'text-ink hover:bg-raised')
            }
          >
            <span className="min-w-0 flex flex-col py-1">
              <span className="truncate">
                <span className="text-ink-muted">{c.group}: </span>
                {c.label}
              </span>
              {actionFor(c.id) && <span className="truncate text-xs text-ink-muted">On screen: {actionFor(c.id)?.where}</span>}
            </span>
            {c.hint && <kbd className="shrink-0 px-1.5 rounded bg-raised border border-line-bold font-mono text-xs text-ink-soft">{c.hint}</kbd>}
          </li>
        ))}
        {shown.length === 0 && <li className="px-3 py-2 text-sm text-ink-muted">Nothing matches “{query}”.</li>}
      </ul>
      <p className="mt-3 text-xs text-ink-muted">Up and Down choose, Enter runs, Esc closes.</p>
    </Dialog>
  )
}
