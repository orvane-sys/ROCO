import { useId } from 'react'
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCheck, CircleDashed, ClipboardCheck, CircleHelp, Hand, OctagonAlert, RotateCcw, SkipForward } from 'lucide-react'
import type { MonitorState } from '../types/monitor'
import { PROCEDURES } from '../config/procedures/g1_type6'
import {
  manualStatus,
  referencesFor,
  suggestStage,
  type ItemResult,
  type ItemStatus,
  type ProcedureResult,
  type StageResult,
} from '../utils/procedureModel'
import { procedureStore, procDataOf, type ProcScope, type ProcedureState } from '../services/procedureStore'
import { formatDataTime } from '../utils/monitorFormat'
import { cn } from '../utils/cn'

const STATUS: Record<ItemStatus, { icon: typeof Check; row: string; color: string }> = {
  stop: { icon: OctagonAlert, row: 'border-crit-line/80 bg-crit-soft/50', color: 'text-crit-ink' },
  check: { icon: AlertTriangle, row: 'border-warn-line/70 bg-warn-soft/40', color: 'text-warn-ink' },
  ok: { icon: Check, row: 'border-line bg-sunken/60', color: 'text-ok' },
  pending: { icon: CircleDashed, row: 'border-line bg-sunken/40', color: 'text-ink-muted' },
  skipped: { icon: SkipForward, row: 'border-line bg-sunken/30', color: 'text-ink-muted' },
}

const btn = 'inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg border border-line-bold bg-surface text-xs text-ink hover:bg-raised'
const btnRun = 'inline-flex items-center gap-1.5 min-h-11 px-3 rounded-lg border border-line-bold bg-surface text-sm text-ink hover:bg-raised disabled:opacity-50 disabled:pointer-events-none'

/** "3 of 11 confirmed", never "ready" or "safe". */
function confirmedText(r: { ok: number; total: number }): string {
  return `${r.ok} of ${r.total} confirmed`
}

function Row({ r, state, proc, scope, big }: { r: ItemResult; state: MonitorState; proc: string; scope: ProcScope; big: boolean }) {
  const st = STATUS[r.status]
  const Icon = st.icon
  const { item } = r
  const store = procedureStore(scope)
  const boxId = useId()
  const shown = referencesFor(item.refs, state.hello?.source ?? null)
  const canConfirm = item.kind !== 'manual' && (r.status === 'check' || r.status === 'pending' || r.byYou)
  const skipped = r.status === 'skipped'
  return (
    <li className={cn('rounded-lg border px-2.5 py-1.5', st.row)}>
      <div className="flex items-start gap-2">
        {item.kind === 'manual' && !skipped ? (
          <input
            id={boxId}
            type="checkbox"
            checked={r.status === 'ok'}
            onChange={() => store.toggleTick(proc, item.id)}
            className={cn('mt-0.5 shrink-0 accent-[var(--color-accent)]', big ? 'w-7 h-7' : 'w-6 h-6')}
          />
        ) : (
          <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', st.color)} aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            {item.kind === 'manual' && !skipped ? (
              <label htmlFor={boxId} className="text-sm font-semibold text-ink break-words min-w-0">
                {item.text}
              </label>
            ) : (
              <span className={cn('text-sm font-semibold break-words min-w-0', skipped ? 'text-ink-soft line-through' : 'text-ink')}>{item.text}</span>
            )}
            <span className={cn('text-xs font-semibold inline-flex items-center gap-1', r.status === 'stop' ? 'text-crit-ink' : r.status === 'check' ? 'text-warn-ink' : 'text-ink-soft')}>
              {item.kind === 'manual' && <Hand className="w-3 h-3" aria-hidden="true" />}
              {r.word}
              {r.t !== null ? ` at ${formatDataTime(r.t, state)}` : ''}
            </span>
          </div>
          {r.detail && <p className="text-xs text-ink break-words">{r.detail}</p>}
          {item.stop && <p className={cn('text-xs break-words', r.status === 'stop' ? 'text-crit-ink font-semibold' : 'text-ink-soft')}>Stop: {item.stop}</p>}
          {shown.map((s) => (
            <p key={s.label} className="text-xs text-ink-soft break-words">
              <span className="font-semibold">{s.label}:</span> {s.text}
            </p>
          ))}
          {item.note && <p className="text-xs text-ink-muted break-words">{item.note}</p>}
          <p className="text-xs text-ink-muted">Manual {item.ref}</p>
        </div>
      </div>
      <div className="mt-1 pl-6 flex flex-wrap gap-1.5">
        {canConfirm && (
          <button type="button" aria-pressed={r.byYou} onClick={() => store.toggleConfirm(proc, item.id)} className={btn}>
            <CheckCheck className="w-3.5 h-3.5" aria-hidden="true" />
            {r.byYou ? 'Undo: I checked this' : 'I checked this'}
            <span className="sr-only">: {item.text}</span>
          </button>
        )}
        {r.status !== 'stop' && (
          <button type="button" onClick={() => store.toggleSkip(proc, item.id)} className={btn}>
            {skipped ? <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> : <SkipForward className="w-3.5 h-3.5" aria-hidden="true" />}
            {skipped ? 'Include again' : 'Not applicable'}
            <span className="sr-only">: {item.text}</span>
          </button>
        )}
      </div>
    </li>
  )
}

function groupItems(items: ItemResult[]): { group: string | null; items: ItemResult[] }[] {
  const out: { group: string | null; items: ItemResult[] }[] = []
  for (const r of items) {
    const g = r.item.group ?? null
    const last = out[out.length - 1]
    if (last && last.group === g) last.items.push(r)
    else out.push({ group: g, items: [r] })
  }
  return out
}

/**
 * The guided checks of the test manual for one procedure: the stage the operator is on, what ROCO can measure, what a log line
 * must show, and what only a person can judge. A stage moves on only when the operator says so, because ROCO cannot see the room.
 */
export function GuidedChecks({
  state,
  scope,
  procState,
  result,
  big,
}: {
  state: MonitorState
  scope: ProcScope
  procState: ProcedureState
  result: ProcedureResult
  /** Run workspace: 44 px targets. */
  big: boolean
}) {
  const store = procedureStore(scope)
  const proc = result.procedure
  const data = procDataOf(procState, proc.id)
  const selected: StageResult = result.stages.find((s) => s.stage.id === data.stage) ?? result.stages[0]
  const idx = result.stages.indexOf(selected)
  const manual = manualStatus(proc, state)
  const hint = suggestStage(result, state.fsm.state)
  const stops = result.counts.stop
  const b = big ? btnRun : btn
  const headId = useId()
  const selId = useId()
  const sc = selected.counts

  return (
    <section
      id="guided-checks"
      tabIndex={-1}
      aria-labelledby={headId}
      className="bg-surface/80 border border-line/90 rounded-xl p-3 flex flex-col gap-2 outline-none focus-visible:outline-2 focus-visible:outline-focus"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <ClipboardCheck className="w-5 h-5 text-accent" aria-hidden="true" />
        <h2 id={headId} className="text-base font-semibold text-ink">
          Guided checks
        </h2>
        <span className="text-xs px-2 py-0.5 rounded bg-raised border border-line-strong text-ink tabular-nums">{confirmedText(result.counts)}</span>
        {stops > 0 && (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-crit-solid text-on-solid font-semibold tabular-nums">
            <OctagonAlert className="w-3 h-3" aria-hidden="true" />
            {stops} guided-check stop {stops > 1 ? 'limits' : 'limit'} crossed
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap text-sm">
        <label htmlFor={selId} className="text-ink-soft">
          Procedure
        </label>
        <select
          id={selId}
          value={proc.id}
          onChange={(e) => store.setProcedure(e.target.value)}
          className={cn('rounded-lg border border-line-bold bg-surface text-ink px-2 min-w-0 max-w-full', big ? 'min-h-11' : 'min-h-9')}
        >
          {PROCEDURES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-ink-soft">{proc.summary}</p>

      {manual.status === 'changed' && (
        <p role="note" className="flex items-start gap-2 rounded-lg border border-warn-line/70 bg-warn-soft/40 px-2.5 py-1.5 text-xs text-warn-ink">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {proc.manual.file} on this PC is not the version these checks were written from, so some limits here may be out of date. Read the manual before
            you trust a pass.
          </span>
        </p>
      )}
      {manual.status === 'missing' && (
        <p role="note" className="flex items-start gap-2 rounded-lg border border-line bg-sunken/50 px-2.5 py-1.5 text-xs text-ink-soft">
          <CircleHelp className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>The bridge cannot find {proc.manual.file} on this PC, so ROCO cannot tell whether these checks match your manual.</span>
        </p>
      )}
      {manual.status === 'unknown' && (
        <p role="note" className="flex items-start gap-2 rounded-lg border border-line bg-sunken/50 px-2.5 py-1.5 text-xs text-ink-soft">
          <CircleHelp className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>This bridge does not report the manual, so ROCO cannot tell whether these checks match it.</span>
        </p>
      )}

      <nav aria-label="Stages" className="flex flex-wrap gap-1.5 xl:sticky xl:top-0 xl:bottom-0 z-10 bg-surface">
        {result.stages.map((s) => {
          const here = s.stage.id === selected.stage.id
          const word = s.counts.stop > 0 ? 'stop limit crossed' : s.done ? 'marked done' : s.matchesState ? 'robot is in this state' : ''
          return (
            <button
              key={s.stage.id}
              type="button"
              aria-current={here ? 'step' : undefined}
              onClick={() => store.setStage(proc.id, s.stage.id)}
              className={cn(
                'inline-flex items-center gap-1 rounded-lg border px-2.5 text-sm tabular-nums',
                big ? 'min-h-11' : 'min-h-9',
                here ? 'border-accent bg-accent-solid text-on-accent font-semibold' : 'border-line-bold bg-surface text-ink hover:bg-raised',
              )}
            >
              {s.counts.stop > 0 ? <OctagonAlert className="w-3.5 h-3.5" aria-hidden="true" /> : s.done ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : null}
              {s.stage.id}
              {word && <span className="sr-only">, {word}</span>}
            </button>
          )
        })}
      </nav>

      {hint && hint.stage.id !== selected.stage.id && (
        <div role="note" className="flex items-center gap-2 flex-wrap text-xs text-info-ink rounded-lg border border-info-line/70 bg-info-soft/40 px-2.5 py-1.5">
          <span>
            The robot is in {state.fsm.state}, which {hint.stage.id} ({hint.stage.title}) covers. ROCO never moves on by itself.
          </span>
          <button type="button" onClick={() => store.setStage(proc.id, hint.stage.id)} className={btn}>
            Show {hint.stage.id}
          </button>
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold text-ink">
          {selected.stage.id}: {selected.stage.title}
        </h3>
        {selected.stage.where && <p className="text-xs text-ink-soft">{selected.stage.where}</p>}
        {selected.stage.keys && <p className="text-xs text-ink">Keys: {selected.stage.keys}</p>}
        {selected.stage.intro && <p className="text-xs text-ink-soft">{selected.stage.intro}</p>}
        <p className="text-xs text-ink-muted tabular-nums">
          {confirmedText(sc)}
          {sc.skipped ? `, ${sc.skipped} not applicable` : ''}
          {sc.check ? `, ${sc.check} to check` : ''}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {groupItems(selected.items).map((g, i) => (
          <div key={g.group ?? i} className="flex flex-col gap-1.5">
            {g.group && <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{g.group}</h4>}
            <ul className="flex flex-col gap-1.5">
              {g.items.map((r) => (
                <Row key={r.item.id} r={r} state={state} proc={proc.id} scope={scope} big={big} />
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <button type="button" className={b} disabled={idx <= 0} onClick={() => store.setStage(proc.id, result.stages[idx - 1].stage.id)}>
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          Previous
        </button>
        <button type="button" className={b} aria-pressed={selected.done} onClick={() => store.toggleDone(proc.id, selected.stage.id)}>
          <Check className="w-4 h-4" aria-hidden="true" />
          {selected.done ? `${selected.stage.id} marked done: undo` : `Mark ${selected.stage.id} done`}
        </button>
        <button type="button" className={b} disabled={idx >= result.stages.length - 1} onClick={() => store.setStage(proc.id, result.stages[idx + 1].stage.id)}>
          Next
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </button>
        <button type="button" className={b} onClick={() => store.clear(proc.id)}>
          <RotateCcw className="w-4 h-4" aria-hidden="true" />
          Clear my ticks
        </button>
      </div>

      <p className="text-xs text-ink-muted">
        ROCO cannot see the rope, the spotter or the room. “Within limit” is not “safe to continue”, and you decide when a stage is done.
        {scope === 'replay' ? ' Ticks made on a recording are kept in memory only.' : ' Your ticks are kept in this browser for today only.'}
      </p>
    </section>
  )
}
