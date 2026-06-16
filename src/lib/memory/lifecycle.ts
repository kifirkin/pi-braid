/**
 * Memory lifecycle functions.
 *
 * Extracted from index.ts. These functions decide what to do with
 * memories: whether to store a new one, what utility to assign, and
 * how to prune/merge existing memories.
 *
 * Pure functions - all dependencies are passed in or imported. No
 * coupling to the CognitiveMemory class or to module-level state.
 *
 * The `consolidate` function is the only one that mutates: it merges
 * duplicate memories and decays utility over time. Callers receive
 * a new CognitiveMemoryStore with the consolidated state.
 */

import type { CognitiveMemoryEntry, CognitiveMemoryType, CognitiveMemoryStore } from "./types.js";
import { jaccardSimilarity } from "./utils.js";

// ── Constants ────────────────────────────────────────────────────────────────

const GENERIC_CONTENT_PATTERNS = [/auto-captured memory from enforcement/i, /auto-captured/i];

// Re-exported for the CognitiveMemory class which also gates on these.
export { MAX_ENTRIES, MIN_UTILITY_THRESHOLD, CATEGORY_BASE_UTILITY } from "./constants.js";
import { MAX_ENTRIES, MIN_UTILITY_THRESHOLD, CATEGORY_BASE_UTILITY } from "./constants.js";

/**
 * Decide whether a new memory should be stored, given existing memories.
 *
 * Rules:
 *   - error/goal memories are always stored (high-signal types)
 *   - auto-captured enforcement memories are rejected (generic noise)
 *   - memories shorter than 20 chars are rejected
 *   - duplicate detection via jaccard similarity (60% for same type,
 *     80% for different type)
 */
export function shouldStore(
  content: string,
  type: CognitiveMemoryType,
  existingMemories: CognitiveMemoryEntry[],
): boolean {
  if (type === "error" || type === "goal") return true;
  if (GENERIC_CONTENT_PATTERNS.some((p) => p.test(content))) return false;
  if (content.trim().length < 20) return false;

  const SIMILARITY_THRESHOLD = 0.6;
  const duplicate = existingMemories.find((m) => {
    if (m.type === type) return jaccardSimilarity(m.content, content) > SIMILARITY_THRESHOLD;
    return jaccardSimilarity(m.content, content) > 0.8;
  });
  return !duplicate;
}

/**
 * Calculate utility score for a memory (0-1).
 *
 * Combines the type's base utility with content-based boosts (fix,
 * solution, pattern, important, critical, remember, key) and the
 * caller's importance rating. Final = base * 0.7 + importance * 0.3.
 */
export function calculateUtility(type: CognitiveMemoryType, content: string, importance: number): number {
  let base = CATEGORY_BASE_UTILITY[type] ?? 0.5;
  const boostKeywords = ["fix", "solution", "pattern", "important", "critical", "remember", "key"];
  if (boostKeywords.some((k) => content.toLowerCase().includes(k))) {
    base = Math.min(1.0, base + 0.2);
  }
  return base * 0.7 + importance * 0.3;
}

/**
 * Prune memories down to MAX_ENTRIES, keeping recent-access and
 * high-utility entries. Recent (last 5 min) entries are always kept.
 * Other entries are sorted by utility, then timestamp, and trimmed.
 */
export function pruneMemories(memories: CognitiveMemoryEntry[]): CognitiveMemoryEntry[] {
  const now = Date.now();
  const RECENT_ACCESS_MS = 5 * 60 * 1000;

  const recent = memories.filter((m) => now - m.lastAccessed < RECENT_ACCESS_MS);
  const others = memories.filter((m) => now - m.lastAccessed >= RECENT_ACCESS_MS);

  const sorted = [...others].sort((a, b) => {
    if (Math.abs(a.utility - b.utility) > 0.1) return b.utility - a.utility;
    return b.timestamp - a.timestamp;
  });

  const remainingSlots = Math.max(0, MAX_ENTRIES - recent.length);
  const pruned = sorted
    .filter((m, i) => i < remainingSlots || m.utility >= MIN_UTILITY_THRESHOLD)
    .slice(0, remainingSlots);

  const combined = [...recent, ...pruned];
  return combined
    .sort((a, b) => {
      if (Math.abs(a.utility - b.utility) > 0.1) return b.utility - a.utility;
      return b.timestamp - a.timestamp;
    })
    .slice(0, MAX_ENTRIES);
}

/**
 * Consolidate a memory store: merge near-duplicates, decay old utility.
 *
 * Returns a NEW store (does not mutate the input). Decay: utility
 * scales linearly from 1.0 at access to 0.1 at 168 hours (1 week)
 * since last access or creation.
 */
export function consolidate(store: CognitiveMemoryStore): CognitiveMemoryStore {
  const now = Date.now();
  const DEAD_UTILITY_THRESHOLD = 0.05;

  const alive = store.memories.filter(
    (m) => m.utility >= DEAD_UTILITY_THRESHOLD || m.type === "goal" || m.type === "error",
  );

  const MERGE_THRESHOLD = 0.7;
  const merged: CognitiveMemoryEntry[] = [];
  const mergedIds = new Set<string>();

  for (const memory of alive) {
    if (mergedIds.has(memory.id)) continue;

    const duplicates: CognitiveMemoryEntry[] = [memory];
    for (const other of alive) {
      if (other.id === memory.id || mergedIds.has(other.id)) continue;
      if (other.type !== memory.type) continue;
      if (jaccardSimilarity(memory.content, other.content) > MERGE_THRESHOLD) {
        duplicates.push(other);
        mergedIds.add(other.id);
      }
    }

    if (duplicates.length > 1) {
      duplicates.sort((a, b) => b.utility - a.utility);
      const best = { ...duplicates[0] };
      best.utility = Math.min(1.0, best.utility + 0.1 * (duplicates.length - 1));
      best.tags = [...new Set(duplicates.flatMap((d) => d.tags))];
      best.accessCount = duplicates.reduce((sum, d) => sum + d.accessCount, 0);
      merged.push(best);
      mergedIds.add(memory.id);
    } else if (!mergedIds.has(memory.id)) {
      merged.push(memory);
    }
  }

  const decayed = merged.map((m) => {
    const effectiveTime = Math.max(m.timestamp, m.lastAccessed || m.timestamp);
    const ageHours = (now - effectiveTime) / (1000 * 60 * 60);
    const decayFactor = Math.max(0.1, 1 - ageHours / 168);
    return { ...m, utility: m.utility * decayFactor };
  });

  const pruned = pruneMemories(decayed);
  return { ...store, memories: pruned, lastConsolidation: store.turnCount };
}
