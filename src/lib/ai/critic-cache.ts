/**
 * Critic Cache - short-window LRU cache for classify() results.
 *
 * ROADMAP Q17: avoid redundant LLM calls when the same critic receives
 * the same (systemPrompt, userPrompt) within a short window.
 *
 * Most useful for the topic-drift 3-call fanout where 2 of the 3 calls
 * often receive identical inputs across consecutive turns. Also helps
 * the consolidation-channel hint-quality critic and other LLM judges
 * that fire every turn with the same prompt template.
 *
 * Design:
 *   - Bounded by LRU eviction (default 1000 entries)
 *   - Time-bounded by TTL (default 60 seconds)
 *   - Per-session, reset on session boundaries via resetCriticCache()
 *   - Cache key is fnv-1a hash of (label, systemPrompt, userPrompt) -
 *     fast, well-distributed, no crypto overhead
 *
 * Stats:
 *   - Cache hits surface as a new "cache" tier in recordCriticCall
 *     so analytics can distinguish "fast free result" (heuristic) from
 *     "fast free result via caching" (cache).
 *
 * NOT thread-safe (Node.js single-threaded; module-level Map is safe
 * within a single agent session).
 */

import type { ClassificationResult } from "./text-classifier.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: ClassificationResult;
  /** Epoch ms after which the entry should be treated as expired. */
  expiresAt: number;
}

// ── Cache store ──────────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

/** Maximum entries before LRU eviction kicks in. */
export const CACHE_MAX_ENTRIES = 1000;

/** Default TTL in ms. Short enough to bound memory, long enough to dedup repeats within a session. */
export const CACHE_DEFAULT_TTL_MS = 60_000;

// ── Hash function ────────────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash. Fast (no crypto API), well-distributed, good
 * enough for cache key uniqueness within a session. We accept the
 * theoretical collision risk: a collision would cause a wrong cache
 * hit, which is a non-fatal degradation (the agent gets an old
 * answer, not garbage).
 */
function fnv1aHash(s: string): string {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime (32-bit)
  }
  // Convert to unsigned 32-bit hex (8 chars)
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Compute the cache key for a classify() call. The key is a hash of
 * the label (so different critics don't share entries), the system
 * prompt, and the post-substitution user message.
 *
 * Public so tests can verify the hash function is stable.
 */
export function getCacheKey(label: string, systemPrompt: string, userPrompt: string): string {
  return fnv1aHash(`${label}\0${systemPrompt}\0${userPrompt}`);
}

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Look up a cached ClassificationResult. Returns null on miss or
 * expiry. On hit, the entry is moved to the end of the LRU order
 * (most recently used) so it doesn't get evicted.
 */
export function getCachedResult(key: string): ClassificationResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  // LRU: move to end. Map preserves insertion order; delete+set
  // re-inserts at the tail.
  cache.delete(key);
  cache.set(key, entry);
  return entry.result;
}

/**
 * Store a ClassificationResult in the cache. If the cache is at
 * capacity, the oldest entry (first in iteration order) is evicted.
 */
export function setCachedResult(
  key: string,
  result: ClassificationResult,
  ttlMs: number = CACHE_DEFAULT_TTL_MS,
): void {
  // LRU eviction: if at max, remove oldest (first key in iteration)
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { result, expiresAt: Date.now() + ttlMs });
}

/**
 * Clear all cached entries. Call on session boundaries
 * (`session_end`) and on test teardown.
 */
export function resetCriticCache(): void {
  cache.clear();
}

/**
 * Current cache size (for tests and observability). Includes
 * expired entries that haven't been evicted yet (they're cleaned
 * up on next lookup).
 */
export function getCriticCacheSize(): number {
  return cache.size;
}
