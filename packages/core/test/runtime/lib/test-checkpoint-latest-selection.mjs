/**
 * Regression test: autoRollback's checkpoint merge sorted
 * DESC by timestamp but then selected `[length-1]`as "latest" — which is
 * the OLDEST checkpoint after a descending sort. Restore/rollback decisions
 * were anchored to the wrong checkpoint (e.g. a turn-20 snapshot instead of
 * the turn-60 one).
 *
 * KEEP auto-restore, fix the sort — the array
 * is now kept in CHRONOLOGICAL order (oldest first, matching the push order
 * and the slice(-MAX) prune), so `[length-1]`really is the newest
 * checkpoint everywhere (autoRollback, getCheckpointInfo).
 *
 * Revert-proof: with three checkpoints created at strictly increasing
 * timestamps (pinned via Date.now override), pre-fix code restores the
 * turn-20 snapshot; this test asserts the turn-60 one.
 *
 * HOME is redirected BEFORE the dist imports so checkpoints are written to a
 * throwaway tree, never the user's real checkpoint directory.
 *
 * Run: node test/runtime/lib/test-checkpoint-latest-selection.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const tmpBase = mkdtempSync(join(tmpdir(), "checkpoint-latest-"));
process.env.HOME = tmpBase; // must precede the dist imports below

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const { createCheckpoint, autoRollback, getCheckpointInfo } = await import(
  join(ROOT, "dist/lib/state/state-checkpoint.js")
);
const { CHECKPOINT_DIR } = await import(join(ROOT, "dist/lib/config/braid-paths.js"));

// Sanity: the HOME override redirected checkpoint storage away from real
// user state — never run this suite against ~/.pi.
assert.ok(CHECKPOINT_DIR.startsWith(tmpBase), "CHECKPOINT_DIR redirected to tmp HOME");

function makeCtx(sessionId) {
  return {
    sessionManager: {
      getSessionFile: () => sessionId,
      getSessionId: () => sessionId,
    },
  };
}

/** Run fn with Date.now pinned — deterministic checkpoint timestamps. */
function withPinnedClock(nowMs, fn) {
  const orig = Date.now;
  Date.now = () => nowMs;
  try {
    return fn();
  } finally {
    Date.now = orig;
  }
}

test("autoRollback restores the NEWEST checkpoint (chronological order invariant)", async () => {
  const sid = "w104-latest-sel";
  const ctx = makeCtx(sid);
  const t0 = 1_700_000_000_000;

  // Three checkpoints, strictly increasing timestamps (20-turn interval met).
  const cp1 = await withPinnedClock(t0, () => createCheckpoint(ctx, 20, sid));
  const cp2 = await withPinnedClock(t0 + 60_000, () => createCheckpoint(ctx, 40, sid));
  const cp3 = await withPinnedClock(t0 + 120_000, () => createCheckpoint(ctx, 60, sid));
  assert.ok(cp1 && cp2 && cp3, "all three checkpoints created (turns 20/40/60)");
  assert.equal(cp1.turnCount, 20);
  assert.equal(cp2.turnCount, 40);
  assert.equal(cp3.turnCount, 60);

  // The "latest"checkpoint really is the newest.
  assert.equal(getCheckpointInfo(ctx).latestTurn, 60, "latest selection picks turn 60");
  assert.equal(getCheckpointInfo(ctx).count, 3);

  // Degraded rollback must restore the turn-60 snapshot, not an older one.
  const rb = await autoRollback(ctx, sid);
  assert.equal(rb.restored, true, `rollback restored a checkpoint — note: ${rb.note}`);
  assert.equal(rb.turnCount, 60, "restored from the NEWEST checkpoint (turn 60)");
});

test("cleanup", () => {
  rmSync(tmpBase, { recursive: true, force: true });
});
