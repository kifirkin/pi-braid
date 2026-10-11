/**
 * Sliding-window rate limiter for turn-complete auto-notify.
 *
 * Pure + deterministic: `try(now)` takes an explicit timestamp so tests can
 * drive window boundaries without sleeping. The default policy (max N per
 * minute) is a deployment default; the limiter itself is policy-agnostic.
 */

export interface SlidingWindowLimiterOptions {
  /** Max notifications allowed per window. */
  maxPerWindow: number;
  /** Window length in ms. */
  windowMs: number;
}

export class SlidingWindowLimiter {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private hits: number[] = [];

  constructor(opts: SlidingWindowLimiterOptions) {
    if (!(opts.maxPerWindow > 0)) throw new Error("maxPerWindow must be > 0");
    if (!(opts.windowMs > 0)) throw new Error("windowMs must be > 0");
    this.maxPerWindow = opts.maxPerWindow;
    this.windowMs = opts.windowMs;
  }

  /**
   * Attempt to take a slot at `now`. Returns true when the call is allowed
   * (and records it); false when the window is saturated.
   */
  try(now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    this.hits = this.hits.filter((t) => t > cutoff);
    if (this.hits.length >= this.maxPerWindow) return false;
    this.hits.push(now);
    return true;
  }

  /** Clear all recorded hits (test helper / session reset). */
  reset(): void {
    this.hits = [];
  }
}
