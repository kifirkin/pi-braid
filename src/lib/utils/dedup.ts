/**
 * Dedup utilities - shared string hashing for deduplication.
 *
 * Three different "have I seen this before?" patterns exist in the codebase:
 *
 *   1. **Hash equality** (nudge-manager, pruning):
 *      "have I sent this exact text recently?"
 *      Uses a fast stable hash. Collisions are acceptable.
 *
 *   2. **List of items** (claim-tracker):
 *      "what claims has the agent made so far?"
 *      Stored as `Claim[]`. No hash, just an array.
 *
 *   3. **For/against sets** (evidence-pool):
 *      "what evidence supports/contradicts a claim?"
 *      Stored as `for: Evidence[]; against: Evidence[]`.
 *
 *   4. **Map registry** (conflict-qa):
 *      "what conflicts have been registered?"
 *      Stored as `Map<id, ConflictQA>`.
 *
 * Only pattern 1 (hash equality) is meaningfully shared. The others are
 * domain-specific data structures and should NOT be unified into a single
 * abstraction. This file consolidates the hash only.
 *
 * The previous implementations:
 *   - `extensions/enforcement/nudge-manager.ts` had a 16-line cyrb53
 *     (replaced with `node:crypto` SHA-1 in 2026-06-13 batch 1).
 *   - `extensions/memory/context-manager/pruning.ts` had a hand-rolled
 *     32-bit djb2 (`hash << 5 - hash + char`).
 *
 * Both replaced with `hashForDedup()` below.
 *
 * For a true LRU with TTL eviction, see the per-extension history maps
 * (e.g. `NudgeManager.history`); the shared hash is only the key.
 */

import { createHash } from "node:crypto";

/**
 * SHA-1 truncated to 16 base64url chars (~96 bits of entropy).
 *
 * Used only for dedup equality, not security, so SHA-1 is fine. Faster
 * than hand-rolled hashes (cyrb53, djb2) and uses the standard library.
 *
 * @param input - The string to hash. Leading/trailing whitespace is preserved.
 *   Callers that want whitespace-tolerant dedup should `.trim()` first.
 * @returns 16-character base64url hash, suitable as a Map key.
 */
export function hashForDedup(input: string): string {
  return createHash("sha1").update(input).digest("base64url").slice(0, 16);
}
