import { useSyncExternalStore } from 'react'
import type { ProcOps } from '../utils/procedureModel'
import { PROCEDURES } from '../config/procedures/g1_type6'

/**
 * What the operator did with the guided checks: which procedure and stage is open, what was ticked, skipped, confirmed by hand,
 * and which stages were marked done. Only the operator moves a stage on, because ROCO cannot see the room.
 *
 * Live data keeps its choices in localStorage for the rest of the day (a page reload must not lose a ticked checklist, and
 * yesterday's ticks must not count today). A replay keeps them in memory only and forgets them when another recording opens,
 * so ticks made while reviewing a recording never reach a real session.
 */

export type ProcScope = 'live' | 'replay'

interface ProcData {
  stage: string
  ticked: string[]
  skipped: string[]
  confirmed: string[]
  done: string[]
}

interface ScopeData {
  procedure: string
  byProc: Record<string, ProcData>
}

export interface ProcedureState {
  procedure: string
  byProc: Record<string, ProcData>
}

const STORAGE_KEY = 'roco.proc.v1'
const today = (): string => new Date().toLocaleDateString('sv')

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 500) : [])

function loadScope(): ScopeData {
  const empty: ScopeData = { procedure: PROCEDURES[0].id, byProc: {} }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const p: unknown = JSON.parse(raw)
    if (typeof p !== 'object' || p === null) return empty
    const o = p as Record<string, unknown>
    if (o.day !== today() || typeof o.live !== 'object' || o.live === null) return empty
    const live = o.live as Record<string, unknown>
    const byProc: Record<string, ProcData> = {}
    if (typeof live.byProc === 'object' && live.byProc !== null) {
      for (const proc of PROCEDURES) {
        const d = (live.byProc as Record<string, unknown>)[proc.id]
        if (typeof d !== 'object' || d === null) continue
        const x = d as Record<string, unknown>
        byProc[proc.id] = {
          stage: typeof x.stage === 'string' && proc.stages.some((s) => s.id === x.stage) ? x.stage : proc.stages[0].id,
          ticked: stringList(x.ticked),
          skipped: stringList(x.skipped),
          confirmed: stringList(x.confirmed),
          done: stringList(x.done),
        }
      }
    }
    const procedure = typeof live.procedure === 'string' && PROCEDURES.some((p) => p.id === live.procedure) ? live.procedure : empty.procedure
    return { procedure, byProc }
  } catch {
    return empty
  }
}

function makeStore(persist: boolean) {
  let data: ScopeData = persist ? loadScope() : { procedure: PROCEDURES[0].id, byProc: {} }
  const listeners = new Set<() => void>()

  const save = () => {
    if (!persist) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ day: today(), live: data }))
    } catch {
      // blocked or full: the ticks still apply until the page is closed
    }
  }
  const commit = (next: ScopeData) => {
    data = next
    save()
    listeners.forEach((l) => l())
  }
  const procData = (id: string): ProcData => {
    const proc = PROCEDURES.find((p) => p.id === id) ?? PROCEDURES[0]
    return data.byProc[proc.id] ?? { stage: proc.stages[0].id, ticked: [], skipped: [], confirmed: [], done: [] }
  }
  const update = (id: string, fn: (d: ProcData) => ProcData) => commit({ ...data, byProc: { ...data.byProc, [id]: fn(procData(id)) } })
  const toggle = (list: string[], v: string): string[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  return {
    get: (): ProcedureState => data,
    procData,
    subscribe(l: () => void) {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    setProcedure(procedure: string) {
      if (PROCEDURES.some((p) => p.id === procedure) && procedure !== data.procedure) commit({ ...data, procedure })
    },
    setStage(proc: string, stage: string) {
      update(proc, (d) => (d.stage === stage ? d : { ...d, stage }))
    },
    toggleTick(proc: string, item: string) {
      update(proc, (d) => ({ ...d, ticked: toggle(d.ticked, item) }))
    },
    toggleSkip(proc: string, item: string) {
      update(proc, (d) => ({ ...d, skipped: toggle(d.skipped, item) }))
    },
    toggleConfirm(proc: string, item: string) {
      update(proc, (d) => ({ ...d, confirmed: toggle(d.confirmed, item) }))
    },
    toggleDone(proc: string, stage: string) {
      update(proc, (d) => ({ ...d, done: toggle(d.done, stage) }))
    },
    /** Forget every tick, skip, confirmation and done mark of one procedure (the stage stays). */
    clear(proc: string) {
      update(proc, (d) => ({ ...d, ticked: [], skipped: [], confirmed: [], done: [] }))
    },
    /** Forget everything: a different recording was opened. */
    reset() {
      if (Object.keys(data.byProc).length) commit({ procedure: data.procedure, byProc: {} })
    },
  }
}

const stores = { live: makeStore(true), replay: makeStore(false) }

export const procedureStore = (scope: ProcScope) => stores[scope]

export function opsOf(d: { ticked: string[]; skipped: string[]; confirmed: string[]; done: string[] }): ProcOps {
  return { ticked: new Set(d.ticked), skipped: new Set(d.skipped), confirmed: new Set(d.confirmed), done: new Set(d.done) }
}

export function useProcedureState(scope: ProcScope): ProcedureState {
  const s = stores[scope]
  return useSyncExternalStore(s.subscribe, s.get)
}

/** The stage and ops of one procedure, from the state a component got from `useProcedureState`. */
export function procDataOf(state: ProcedureState, procId: string): { stage: string; ticked: string[]; skipped: string[]; confirmed: string[]; done: string[] } {
  const proc = PROCEDURES.find((p) => p.id === procId) ?? PROCEDURES[0]
  return state.byProc[proc.id] ?? { stage: proc.stages[0].id, ticked: [], skipped: [], confirmed: [], done: [] }
}
