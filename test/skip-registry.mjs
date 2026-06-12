/**
 * Skip Registry - central registry for intentionally skipped tests.
 *
 * Every skipped test must:
 * 1. Have a documented reason
 * 2. Have an expiry date (ISO date string)
 * 3. Be registered here AND the test must call `isSkipped(name)` + return early
 *
 * Tests with expired skip dates are flagged at runtime.
 * No indefinite skips - every skip must have an expiry.
 *
 * Usage:
 *   import { isSkipped } from "../skip-registry.mjs";
 *   if (isSkipped("my-test-name")) return;
 */

const SKIPPED = {};

export function isSkipped(name) {
  const entry = SKIPPED[name];
  if (!entry) return false;
  const expired = new Date(entry.expiry) < new Date();
  if (expired) {
    console.error(`⚠️  SKIP EXPIRED: "${name}" - expired ${entry.expiry}, fix or extend`);
  }
  return true;
}

export function getSkipReason(name) {
  const entry = SKIPPED[name];
  return entry ? entry.reason : undefined;
}

export function listSkipped() {
  return Object.entries(SKIPPED).map(([name, entry]) => ({
    name,
    reason: entry.reason,
    expiry: entry.expiry,
    expired: new Date(entry.expiry) < new Date(),
  }));
}
