/**
 * Conflict classifier failure trace - a classification failure inside the
 * evidence pool must be countable, not silently swallowed.
 *
 * Two silent paths are pinned here:
 *   (a) classifyConflictsWithLLM's per-conflict catch (an error thrown before
 *       classify() is called);
 *   (b) detectSemanticConflicts' per-pair catch (raised while reading the
 *       candidate claims).
 *
 * Run: node test/runtime/lib/test-conflict-classifier-trace.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Disk persistence must land in a scratch dir, never the owner's home.
process.env.HOME = mkdtempSync(join(tmpdir(), "classifier-trace-home-"));

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const pool = await import(join(ROOT, "dist", "lib", "store", "evidence-pool.js"));

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [fail] ${name}: ${e.message}`);
  }
}

const statsOf = (ctx) => {
  assert.equal(
    typeof pool.getConflictClassifierStats,
    "function",
    "evidence pool must expose its classifier failure stats",
  );
  return pool.getConflictClassifierStats(ctx);
};

await test("per-conflict re-classification failure is counted", async () => {
  const ctx = {};
  const conflict = {
    id: "c-trace-1",
    claim: "synthetic",
    for: [null],
    against: [{ id: "e-trace-1", claim: "synthetic against", reliability: 0.5 }],
    verdict: "unresolved",
    classification: "implication",
    detectedAt: Date.now(),
  };

  await pool.classifyConflictsWithLLM(ctx, [conflict]);

  const stats = statsOf(ctx);
  assert.equal(stats.reclassifyFailures, 1, `reclassifyFailures=${stats.reclassifyFailures}`);
  assert.ok(stats.lastError && stats.lastError.length > 0, "lastError must name the failure");
});

await test("semantic pair failure is counted", async () => {
  const ctx = {};
  pool.addEvidence(ctx, "alpha beta gamma delta", "memory", "first", 0.7);
  pool.addEvidence(ctx, "alpha epsilon zeta eta", "web", "second", 0.9);

  const target = pool.getEvidence(ctx).find((e) => e.claim.startsWith("alpha beta gamma"));
  assert.ok(target, "evidence entry must be present");
  Object.defineProperty(target, "claim", {
    configurable: true,
    get() {
      throw new Error("synthetic claim failure");
    },
  });

  await pool.detectSemanticConflicts(ctx);

  const stats = statsOf(ctx);
  assert.equal(stats.semanticFailures, 1, `semanticFailures=${stats.semanticFailures}`);
  assert.ok(stats.lastError && stats.lastError.length > 0, "lastError must name the failure");
});

console.log(`\ntest-conflict-classifier-trace: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
