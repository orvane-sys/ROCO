import { CircleCheck, CircleDashed } from 'lucide-react'
import type { ConnectionCheck } from '../utils/connectionChecks'
import { cn } from '../utils/cn'

/** Three rows with an icon and a word as well as colour: "OK" or "Not yet". */
export function ConnectionChecks({ checks, heading = 'Checks' }: { checks: ConnectionCheck[]; heading?: string }) {
  return (
    <section aria-label={heading} className="rounded-xl border border-line bg-surface/80 p-3 flex flex-col gap-2">
      <h2 className="text-base font-semibold text-ink">{heading}</h2>
      <ol className="flex flex-col gap-1.5" role="list">
        {checks.map((c, n) => (
          <li key={c.id} className="flex items-start gap-2 text-sm">
            {c.ok ? <CircleCheck className="w-4 h-4 mt-0.5 text-ok shrink-0" aria-hidden="true" /> : <CircleDashed className="w-4 h-4 mt-0.5 text-warn shrink-0" aria-hidden="true" />}
            <span className="min-w-0">
              <span className="text-ink font-medium">
                {n + 1}. {c.label}
              </span>
              <span className={cn('ml-2 text-xs font-semibold px-1.5 py-0.5 rounded border', c.ok ? 'text-ok-ink bg-ok-soft border-ok-line' : 'text-warn-ink bg-warn-soft border-warn-line')}>{c.ok ? 'OK' : 'Not yet'}</span>
              <span className="block text-ink-soft break-words">{c.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
