/**
 * Bounded-collection helpers for memory-leak containment.
 *
 * Long-lived in-memory accumulators that grow one entry per event for the
 * lifetime of a session are the OOM failure mode (multi-GB RSS across
 * several live pi processes): keep a bounded ring/FIFO and drop the OLDEST
 * entries beyond the cap.
 *
 * Caps are chosen at or above every existing consumer lookback so
 * behavior is preserved (detectors only read recent windows today). Where
 * a consumer needs an exact full-session count, the count is maintained as
 * a scalar counter next to the capped array (see heartbeat/analytics).
 *
 * These helpers are intentionally tiny and dependency-free so any
 * enforcement/heartbeat/memory call site can bound its accumulator in one
 * line without importing heavier state machinery.
 */

/**
 * Append `item` to `arr`, then FIFO-evict from the FRONT (oldest) while the
 * array exceeds `cap`. Mutation is in place; insertion order = recency order
 * (index 0 is oldest, length-1 is newest).
 */
export function pushBounded<T>(arr: T[], item: T, cap: number): void {
  arr.push(item);
  while (arr.length > cap) arr.shift();
}

/**
 * Insert `key`/`value` into `map` (Map preserves insertion order), then
 * evict the OLDEST entries (first inserted, not yet re-set) while the map
 * exceeds `cap`. Re-setting an existing key does NOT change its eviction
 * order (Map semantics); callers that need refresh-on-touch should delete
 * before setting.
 */
export function mapInsertBounded<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/**
 * Add `item` to `set`, then evict the OLDEST members while the set exceeds
 * `cap`. The item is re-inserted (delete+add) so its eviction order tracks
 * the most recent add, not the first.
 */
export function setAddBounded<T>(set: Set<T>, item: T, cap: number): void {
  set.delete(item);
  set.add(item);
  while (set.size > cap) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
}
