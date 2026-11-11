import { useRef, type ReactNode } from 'react'
import { CircleHelp, Command, Settings, SunMoon } from 'lucide-react'
import { WORKSPACES, type Workspace } from '../services/uiPrefs'
import { cn } from '../utils/cn'

interface WorkspaceBarProps {
  /** Null in drive mode, which has no workspaces. */
  workspace: Workspace | null
  onWorkspace: (w: Workspace) => void
  onOpenPalette: () => void
  onOpenHelp: () => void
  onOpenDisplay: () => void
  onOpenSettings: () => void
  /** Tone, voice and battery: shown before the buttons. */
  tools?: ReactNode
}

const iconButton =
  'w-11 h-11 max-md:w-10 max-md:h-10 rounded-lg flex items-center justify-center bg-surface/80 border border-line-strong hover:border-line-hot text-ink-soft hover:text-ink transition-colors'

// Icon and word from 768 px, icon only on phones (the name stays in aria-label)
const labelled = cn(iconButton, 'xl:w-auto xl:px-3 gap-2 text-sm font-semibold')

/** The workspace tabs (keys 1, 2, 3) and the buttons that open the palette, help and settings. */
export function WorkspaceBar({ workspace, onWorkspace, onOpenPalette, onOpenHelp, onOpenDisplay, onOpenSettings, tools }: WorkspaceBarProps) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([])

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    let to: number | null = null
    if (e.key === 'ArrowRight') to = (index + 1) % WORKSPACES.length
    else if (e.key === 'ArrowLeft') to = (index + WORKSPACES.length - 1) % WORKSPACES.length
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = WORKSPACES.length - 1
    if (to === null) return
    e.preventDefault()
    onWorkspace(WORKSPACES[to].id)
    tabs.current[to]?.focus()
  }

  return (
    <nav aria-label="Workspaces and settings" className="border-b border-line/80 bg-surface/60 px-3 lg:px-4 py-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 shrink-0">
      {workspace !== null ? (
        <div role="tablist" aria-label="Workspace" data-action="ws" className="flex items-center gap-1.5">
          {WORKSPACES.map((w, i) => {
            const on = w.id === workspace
            return (
              <button
                key={w.id}
                ref={(el) => {
                  tabs.current[i] = el
                }}
                type="button"
                role="tab"
                id={`tab-${w.id}`}
                aria-selected={on}
                aria-controls="workspace-panel"
                tabIndex={on ? 0 : -1}
                title={w.hint}
                onClick={() => onWorkspace(w.id)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className={cn(
                  'min-h-11 px-2.5 md:px-3 lg:px-4 rounded-lg border text-base font-semibold flex items-center gap-2 transition-colors',
                  on ? 'bg-accent-solid border-accent text-on-accent' : 'bg-surface/80 border-line-strong text-ink hover:border-line-hot hover:bg-raised'
                )}
              >
                <kbd className={cn('hidden lg:inline px-1.5 rounded border font-mono text-xs', on ? 'border-on-accent/60' : 'border-line-bold text-ink-soft')}>{w.key}</kbd>
                {w.label}
              </button>
            )
          })}
        </div>
      ) : null}

      <div className="ml-auto flex items-center gap-1.5">
        {tools}
        <button type="button" onClick={onOpenPalette} className={cn(iconButton, 'w-auto px-3 max-md:px-2.5 gap-2 text-sm')} aria-label="Ctrl+K command palette" title="Command palette (Ctrl+K)" aria-haspopup="dialog">
          <Command className="w-4 h-4" aria-hidden="true" />
          <span className="hidden 2xl:inline">Ctrl+K</span>
        </button>
        <button type="button" data-action="help" onClick={onOpenHelp} className={labelled} aria-label="Help: every action, shortcuts and words (press ?)" title="Help: every action, shortcuts and words (?)" aria-haspopup="dialog">
          <CircleHelp className="w-5 h-5" aria-hidden="true" />
          <span className="hidden xl:inline" aria-hidden="true">Help</span>
        </button>
        <button type="button" data-action="display" onClick={onOpenDisplay} className={labelled} aria-label="Display settings: theme, text size and 3D view" title="Display: theme, text size and 3D view" aria-haspopup="dialog">
          <SunMoon className="w-5 h-5" aria-hidden="true" />
          <span className="hidden xl:inline" aria-hidden="true">Display</span>
        </button>
        <button type="button" data-action="settings" onClick={onOpenSettings} className={labelled} aria-label="Settings: connection, robot and protocol" title="Settings: connection, robot and protocol" aria-haspopup="dialog">
          <Settings className="w-5 h-5" aria-hidden="true" />
          <span className="hidden xl:inline" aria-hidden="true">Settings</span>
        </button>
      </div>
    </nav>
  )
}
