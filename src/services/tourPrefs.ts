const KEY = 'roco.tour.v1'

/** Has the first-run tour been shown (or skipped) in this browser? A blocked store counts as seen, so it never nags. */
export function tourSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return true
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    // blocked: nothing to remember it in
  }
}
