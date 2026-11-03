/**
 * Rolling history for the joint plots: one sample per bridge aux frame (~50 Hz), every motor slot.
 * Fixed typed arrays, written in place; readers draw straight from them (no per-frame allocation).
 * `demandPeak` is the max |PD demand| over all ~1 kHz samples since the previous frame, so a spike
 * shorter than one frame still shows.
 */
export const PLOT_SLOTS = 29
export const PLOT_CAPACITY = 4096 // ~80 s at 50 Hz: the 60 s window plus room to look back from a frozen moment

export class PlotRing {
  readonly t = new Float64Array(PLOT_CAPACITY)
  readonly q = new Float32Array(PLOT_CAPACITY * PLOT_SLOTS)
  readonly qCmd = new Float32Array(PLOT_CAPACITY * PLOT_SLOTS)
  readonly tau = new Float32Array(PLOT_CAPACITY * PLOT_SLOTS)
  readonly demand = new Float32Array(PLOT_CAPACITY * PLOT_SLOTS)
  readonly demandPeak = new Float32Array(PLOT_CAPACITY * PLOT_SLOTS)
  readonly roll = new Float32Array(PLOT_CAPACITY)
  readonly pitch = new Float32Array(PLOT_CAPACITY)
  /** Index the next sample goes to. */
  head = 0
  count = 0
  /** Bumped on every write or clear, so readers can skip redraws. */
  version = 0

  clear(): void {
    this.head = 0
    this.count = 0
    this.version++
  }

  /** Index of the k-th oldest stored sample. */
  index(k: number): number {
    return (this.head - this.count + k + PLOT_CAPACITY) % PLOT_CAPACITY
  }

  /** Independent copy (for a frozen plot). */
  clone(): PlotRing {
    const c = new PlotRing()
    c.t.set(this.t)
    c.q.set(this.q)
    c.qCmd.set(this.qCmd)
    c.tau.set(this.tau)
    c.demand.set(this.demand)
    c.demandPeak.set(this.demandPeak)
    c.roll.set(this.roll)
    c.pitch.set(this.pitch)
    c.head = this.head
    c.count = this.count
    c.version = this.version
    return c
  }

  /** Time of the oldest stored sample. */
  firstTime(): number | null {
    return this.count ? this.t[this.index(0)] : null
  }

  /** Logical index of the first sample at or after time t (count when every sample is older). */
  lowerBound(t: number): number {
    let lo = 0
    let hi = this.count
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (this.t[this.index(m)] < t) lo = m + 1
      else hi = m
    }
    return lo
  }

  /** Logical index of the stored sample nearest to time t, or null when the ring is empty. */
  nearest(t: number): number | null {
    if (!this.count) return null
    const k = this.lowerBound(t)
    if (k <= 0) return 0
    if (k >= this.count) return this.count - 1
    return Math.abs(this.t[this.index(k)] - t) < Math.abs(this.t[this.index(k - 1)] - t) ? k : k - 1
  }

  latestTime(): number | null {
    return this.count ? this.t[(this.head - 1 + PLOT_CAPACITY) % PLOT_CAPACITY] : null
  }

  /** All per-slot arrays are indexed by motor slot; qCmd null = no command yet (stored as NaN). */
  push(
    t: number,
    q: ArrayLike<number>,
    qCmd: ArrayLike<number> | null,
    tau: ArrayLike<number>,
    demand: ArrayLike<number>,
    demandPeak: ArrayLike<number>,
    roll: number,
    pitch: number
  ): void {
    const last = this.latestTime()
    if (last !== null && t < last) this.clear() // time went back: a replay seek or a new session
    const i = this.head
    this.t[i] = t
    const base = i * PLOT_SLOTS
    for (let s = 0; s < PLOT_SLOTS; s++) {
      this.q[base + s] = q[s] ?? NaN
      this.qCmd[base + s] = qCmd ? (qCmd[s] ?? NaN) : NaN
      this.tau[base + s] = tau[s] ?? NaN
      this.demand[base + s] = demand[s] ?? NaN
      this.demandPeak[base + s] = demandPeak[s] ?? NaN
    }
    this.roll[i] = roll
    this.pitch[i] = pitch
    this.head = (i + 1) % PLOT_CAPACITY
    this.count = Math.min(PLOT_CAPACITY, this.count + 1)
    this.version++
  }
}
