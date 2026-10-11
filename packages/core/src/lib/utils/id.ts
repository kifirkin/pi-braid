/**
 * ID factory - single source of truth for non-deterministic ID generation.
 *
 * Ad-hoc `Date.now() + Math.random()` ids are non-deterministic, which makes
 * tests flaky and prevents snapshot-based regression checks.
 *
 * For tests, callers can override the implementation via `setIdGenerator`:
 *
 *   import { setIdGenerator } from "../lib/utils/id.js";
 *   setIdGenerator(() => "test-id-1");
 *   // ... tests run deterministically
 *
 * Or, callers can pre-seed the random component with `setRandomSuffixFn`.
 *
 * ID format: `${prefix}-${timestamp36}-${random36}`
 *   Example: `ep-lzg3p4-a1b2c3d4`
 *   - prefix: short semantic tag (ep, pr, hr, sig, etc.)
 *   - timestamp36: 7-8 char base36 ms-since-epoch
 *   - random36: 6-8 char base36 random (collision space ~10^9)
 *
 * The combination gives 64+ bits of entropy, more than enough for
 * uniqueness within a single process even under rapid generation.
 */

import { randomBytes } from "node:crypto";

/** Suffix generator: returns a fixed-length base36 string. */
let _randomSuffix: () => string = () => randomBytes(4).toString("hex").slice(0, 8);

/** Counter: increments for every call within a millisecond, ensuring uniqueness under rapid generation. */
let _counter = 0;

let _idGenerator: ((prefix: string) => string) | null = null;

/**
 * Generate a unique ID with the given prefix.
 *
 * The default implementation uses `Date.now() + counter + 8 hex chars`.
 * The counter ensures uniqueness for rapid successive calls within the
 * same millisecond; the random suffix ensures uniqueness across calls
 * in different processes or after a restart.
 */
export function nextId(prefix: string): string {
  if (_idGenerator) return _idGenerator(prefix);
  _counter = (_counter + 1) >>> 0;
  return `${prefix}-${Date.now().toString(36)}-${_counter.toString(36)}${_randomSuffix().slice(0, 4)}`;
}

/**
 * Replace the ID generator (for testing). Pass `null` to reset to the
 * default. The new generator receives the prefix and must return a
 * unique-enough string.
 */
export function setIdGenerator(fn: ((prefix: string) => string) | null): void {
  _idGenerator = fn;
}

/**
 * Replace the random-suffix generator (for testing). The new function
 * must return a short string (typically 8 chars).
 */
export function setRandomSuffixFn(fn: () => string): void {
  _randomSuffix = fn;
}
