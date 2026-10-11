/**
 * Semantic-memory store merge: union of the caller's snapshot with what is
 * currently on disk, by entry id.
 *
 * Without the merge, every writer would rewrite the whole store from its
 * own in-memory snapshot: with several live pi processes the last writer
 * erases whatever the other processes wrote since its load, and a
 * `recall()` that only wants to bump access counters erases new entries
 * the same way. The merge makes the disk store the shared baseline:
 * entries this caller has never seen are preserved, and same-id conflicts
 * reconcile field-wise.
 *
 * The merge cannot express deletion by itself — a caller that removed ids
 * from its snapshot looks exactly like a caller that never saw them. Callers
 * with deletion intent pass those ids in `removeIds`; they are dropped from
 * the merged store instead of resurrected.
 */

import type { CognitiveMemoryEntry, CognitiveMemoryStore } from "./types.js";

export interface MergeStoresOptions {
  /**
   * Ids the caller deliberately removed since its last load (delete,
   * consolidation merge, prune, expiry cleanup). Absent from the local
   * snapshot for any other reason means "never seen", not "deleted".
   */
  removeIds?: ReadonlySet<string>;
  /**
   * Skip the union entirely and write the caller's store as-is. Only for
   * explicit wipe semantics (`clear()`); the normal path must never drop
   * entries the caller has not seen.
   */
  replaceAll?: boolean;
}

/**
 * Merge the caller's local store into the current disk store.
 * Pure: no I/O, no clock. `disk` may be null (no file yet).
 */
export function mergeStores(
  disk: CognitiveMemoryStore | null,
  local: CognitiveMemoryStore,
  opts: MergeStoresOptions = {},
): CognitiveMemoryStore {
  if (opts.replaceAll) {
    return { ...local };
  }

  const byId = new Map<string, CognitiveMemoryEntry>();
  for (const entry of disk?.memories ?? []) {
    if (opts.removeIds?.has(entry.id)) continue;
    byId.set(entry.id, entry);
  }
  for (const entry of local.memories) {
    const existing = byId.get(entry.id);
    byId.set(entry.id, existing ? reconcileEntry(existing, entry) : entry);
  }

  const migratedAt = Math.max(disk?.migratedAt ?? 0, local.migratedAt ?? 0);
  return {
    version: 1,
    memories: [...byId.values()],
    lastConsolidation: Math.max(disk?.lastConsolidation ?? 0, local.lastConsolidation),
    turnCount: Math.max(disk?.turnCount ?? 0, local.turnCount),
    ...(migratedAt > 0 ? { migratedAt } : {}),
  };
}

/**
 * Same-id conflict: entries with one id share one creation event, so the
 * immutable fields are identical by construction. Mutable fields follow
 * their natural direction:
 *   - counters (accessCount, lastAccessed) and scores (utility, importance)
 *     are monotonic maxima — a bump from either process must survive;
 *   - tags/related prefer the longer array — both processes only ever
 *     append to them in normal operation (union approximation);
 *   - expiresAt prefers a set value (a stale process must not drop a TTL
 *     another process set).
 * Rarer conflicts (a same-id tag rewrite racing another process's tag
 * rewrite) resolve to whichever side won the max above; that remainder is
 * documented in the memory durability report.
 */
function reconcileEntry(
  disk: CognitiveMemoryEntry,
  local: CognitiveMemoryEntry,
): CognitiveMemoryEntry {
  return {
    ...disk,
    accessCount: Math.max(disk.accessCount ?? 0, local.accessCount ?? 0),
    lastAccessed: Math.max(disk.lastAccessed ?? 0, local.lastAccessed ?? 0),
    utility: Math.max(disk.utility ?? 0, local.utility ?? 0),
    importance: Math.max(disk.importance ?? 0, local.importance ?? 0),
    tags: local.tags.length >= (disk.tags?.length ?? 0) ? local.tags : (disk.tags ?? []),
    related:
      local.related && local.related.length > (disk.related?.length ?? 0)
        ? local.related
        : disk.related,
    expiresAt: local.expiresAt !== undefined ? local.expiresAt : disk.expiresAt,
  };
}
