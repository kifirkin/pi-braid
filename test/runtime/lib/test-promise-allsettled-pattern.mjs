/**
 * Test: Promise.allSettled pattern for LLM critic calls.
 *
 * Locks Q8 (lint rule for Promise.all vs allSettled). The pattern:
 *   - When awaiting multiple LLM/critic calls in parallel, use
 *     Promise.allSettled so one failure doesn't drop the others.
 *   - Wrap each result in an unwrap() helper that returns null on
 *     rejection and the value on fulfillment.
 *   - All sites in the codebase that fan out LLM calls must use
 *     allSettled; only sites with no I/O (local glob, queue ops)
 *     are exempt.
 *
 * This test scans src/ for Promise.all followed by a callback
 * that contains a `classify(` or `checkContradiction(` etc.,
 * and asserts that the call is actually allSettled.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = join(ROOT, "src");

// ── Collect all .ts files in src/ ──────────────────────────────────────────

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      yield* walk(full);
    } else if (entry.endsWith(".ts")) {
      yield full;
    }
  }
}

const LLM_FUNCTIONS = [
  "classify(",
  "checkContradiction(",
  "checkSupport(",
  "checkOverconfidence(",
  "sendSmartNudge(",
  "hintRelevanceFallback(",
];

// Files exempt from the pattern (no I/O in their all-of-something):
// - file-mutation-queue.ts: queue ops, not LLM
// - explore-paths.ts: local glob (no LLM in the all()s)
const EXEMPT_FILES = new Set([
  "src/lib/utils/file-mutation-queue.ts",
  "src/extensions/memory/memory-agent-bridge/explore-paths.ts",
  "src/extensions/memory/memory-agent-bridge/index.ts", // one Promise.all that's not LLM
]);

const violations = [];
const scanned = [];

for (const file of walk(SRC)) {
  const rel = file.replace(ROOT + "/", "");
  if (EXEMPT_FILES.has(rel)) continue;
  const src = readFileSync(file, "utf-8");

  // Find every Promise.all([ ... ]) or Promise.all(map(...)) block.
  // Heuristic: a multi-line Promise.all followed within ~20 lines by
  // a callback that contains one of LLM_FUNCTIONS.
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/Promise\.all\(/.test(line)) continue;
    if (/Promise\.allSettled/.test(line)) continue; // already migrated

    // Look ahead up to 20 lines for an LLM function.
    const block = lines.slice(i, i + 25).join("\n");
    const hasLlm = LLM_FUNCTIONS.some((fn) => block.includes(fn));
    if (hasLlm) {
      violations.push({
        file: rel,
        line: i + 1,
        snippet: line.trim(),
      });
    }
  }
  scanned.push(rel);
}

if (violations.length > 0) {
  console.error("[fail] Found Promise.all with LLM calls. Use Promise.allSettled:");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
  }
  assert.equal(
    violations.length,
    0,
    `Found ${violations.length} Promise.all with LLM calls (should be allSettled)`,
  );
}

console.log(
  `[ok] Promise.allSettled pattern: scanned ${scanned.length} files, 0 violations.`,
);
console.log("    (all LLM-fanout Promise.all blocks use allSettled)");
