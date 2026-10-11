/**
 * Conflict QA registry reset visibility - processConflicts rebuilds the
 * process-global QA registry from the current unresolved conflicts, so a
 * record generated in one turn can vanish on the next. The stats must make
 * that reset countable instead of silent.
 *
 * Run: node test/runtime/lib/test-conflict-qa-reset-visible.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HOME = mkdtempSync(join(tmpdir(), "conflict-qa-home-"));

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const qa = await import(join(ROOT, "dist", "lib", "store", "conflict-qa.js"));
const pool = await import(join(ROOT, "dist", "lib", "store", "evidence-pool.js"));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [fail] ${name}: ${e.message}`);
  }
}

test("a registry reset is reader-visible in the stats", () => {
  const ctx = {};
  pool.addEvidence(ctx, "alpha beta gamma delta", "memory", "first", 0.7);
  pool.addEvidence(ctx, "alpha beta gamma epsilon", "web", "second", 0.9);

  const generated = qa.processConflicts(ctx);
  assert.equal(generated.length, 1, "one unresolved conflict must generate one QA record");

  let stats = qa.getConflictQAStats(ctx);
  assert.equal(stats.retainedCount, 1, `retainedCount=${stats.retainedCount}`);
  assert.equal(stats.totalGenerated, 1, `totalGenerated=${stats.totalGenerated}`);
  assert.equal(stats.droppedByReset, 0, `droppedByReset=${stats.droppedByReset}`);

  // Resolving the conflict makes the next regenerate find nothing: the
  // registry is cleared and the record is dropped.
  pool.resolveConflict(ctx, generated[0].conflictId, "resolved_for", "test");
  const regenerated = qa.processConflicts(ctx);
  assert.equal(regenerated.length, 0, "no unresolved conflicts means no new records");

  stats = qa.getConflictQAStats(ctx);
  assert.equal(stats.retainedCount, 0, `retainedCount=${stats.retainedCount}`);
  assert.equal(stats.totalGenerated, 1, "lifetime generated must survive the reset");
  assert.ok(stats.droppedByReset >= 1, `droppedByReset=${stats.droppedByReset}`);
});

console.log(`\ntest-conflict-qa-reset-visible: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
