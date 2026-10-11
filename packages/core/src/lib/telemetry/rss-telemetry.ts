/**
 * RSS Growth Telemetry — pure ring + sustained-growth predicate.
 *
 * Exists so a sustained-RSS-growth incident is diagnosable from logs. The
 * heartbeat tick already samples `process.memoryUsage().rss` per tick
 * (context-heartbeat.ts); this module adds the in-memory pieces:
 *
 *   - a small ring of the last RSS_RING_CAP samples (per heartbeat tick),
 *   - the sustained-growth predicate: every sample in a FULL ring is more
 *     than RSS_GROWTH_FACTOR times the boot baseline.
 *
 * The "boot baseline" is set once per process (lib/state/global-state.ts
 * slot — a new session in the same process is the same boot, so the
 * baseline and the one-advisory-whisper-per-boot latch must survive
 * session_start resets).
 *
 * Design notes:
 *   - "Sustained" = the ENTIRE ring (24 consecutive ticks ≈ 120+ turns)
 *     sits above 2x baseline. This is deliberately conservative: a heavy
 *     but legitimate turn spikes RSS transiently; only persistent
 *     elevation — the accumulator-growth signature — qualifies. The JSONL
 *     sink keeps the per-tick history for post-mortems either way.
 *   - The whisper is emitted by the heartbeat tick (which owns delivery);
 *     this module is pure so the ring bound is unit-testable.
 */

/** Ring size: last 24 heartbeat RSS samples. */
export const RSS_RING_CAP = 24;

/** Sustained-growth threshold: samples must exceed baseline * this factor. */
export const RSS_GROWTH_FACTOR = 2;

/**
 * Push an RSS sample onto the ring, FIFO-evicting beyond RSS_RING_CAP.
 * Mutates and returns `ring` (insertion order = oldest → newest).
 */
export function pushRssSample(ring: number[], rssBytes: number): number[] {
  ring.push(rssBytes);
  while (ring.length > RSS_RING_CAP) ring.shift();
  return ring;
}

/**
 * True when the ring is FULL (RSS_RING_CAP samples) and EVERY sample is
 * strictly above `baseline * factor`. A null/zero baseline or a partial
 * ring never fires — no verdict without a real baseline.
 */
export function assessSustainedRssGrowth(
  ring: number[],
  baseline: number | null | undefined,
  factor: number = RSS_GROWTH_FACTOR,
): boolean {
  if (!baseline || baseline <= 0) return false;
  if (ring.length < RSS_RING_CAP) return false;
  const threshold = baseline * factor;
  return ring.every((bytes) => bytes > threshold);
}
