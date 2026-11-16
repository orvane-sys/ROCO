/**
 * What an import changed, approximated, could not use or refused, kept so the import dialog can list it and the user can
 * download it. Repeated items (the same kind and message) are counted once, with a few example places.
 */
export type ReportKind = 'fix' | 'approx' | 'unsupported' | 'substitution' | 'limit' | 'error'

export interface ReportItem {
  kind: ReportKind
  message: string
  /** How the user can avoid it, when there is a way. */
  hint?: string
  /** How many times it happened. */
  count: number
  /** Up to MAX_WHERE example places (a file, element or path). */
  where: string[]
}

const MAX_WHERE = 10

export const REPORT_KINDS: readonly ReportKind[] = ['error', 'limit', 'unsupported', 'approx', 'substitution', 'fix']

export class ImportReport {
  readonly items: ReportItem[] = []
  private byKey = new Map<string, ReportItem>()

  add(kind: ReportKind, message: string, opts: { where?: string; hint?: string } = {}): void {
    const key = `${kind}\u0000${message}`
    let item = this.byKey.get(key)
    if (!item) {
      item = { kind, message, count: 0, where: [], ...(opts.hint ? { hint: opts.hint } : {}) }
      this.byKey.set(key, item)
      this.items.push(item)
    }
    item.count++
    if (opts.where && item.where.length < MAX_WHERE && !item.where.includes(opts.where)) item.where.push(opts.where)
  }

  byKind(kind: ReportKind): ReportItem[] {
    return this.items.filter((i) => i.kind === kind)
  }

  /** One line per item, most serious kind first, e.g. `substitution (3): ... (meshes/a.stl, ...)`. */
  lines(): string[] {
    const out: string[] = []
    for (const kind of REPORT_KINDS) {
      for (const i of this.byKind(kind)) {
        const where = i.where.length ? ` (${i.where.join(', ')}${i.count > i.where.length ? ', …' : ''})` : ''
        out.push(`${kind}${i.count > 1 ? ` ×${i.count}` : ''}: ${i.message}${where}${i.hint ? ` ${i.hint}` : ''}`)
      }
    }
    return out
  }

  toText(): string {
    return this.items.length ? this.lines().join('\n') + '\n' : 'Nothing to report.\n'
  }

  toJson(): { version: 1; items: ReportItem[] } {
    return { version: 1, items: this.items.map((i) => ({ ...i, where: [...i.where] })) }
  }
}
