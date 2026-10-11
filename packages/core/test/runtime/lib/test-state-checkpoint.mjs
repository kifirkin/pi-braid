/**
 * Test: State Checkpoint - checkpoint creation and lifecycle.
 *
 * Uses unique session IDs per test to avoid state bleeding via
 * getExtensionState's session-keyed state buckets.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { createCheckpoint, getCheckpointInfo, heartbeatCheckpointTick } =
  await import("../../../dist/lib/state/state-checkpoint.js");

function makeCtx(sessionId) {
  return {
    sessionManager: {
      getSessionFile: () => sessionId,
      getSessionId: () => sessionId,
    },
  };
}

describe("State Checkpoint", () => {
  it("returns null before interval is reached", async () => {
    const ctx = makeCtx("test-a");
    const cp = await createCheckpoint(ctx, 5, "test-a");
    assert.equal(cp, null, "no checkpoint before 20-turn interval");
  });

  it("creates a checkpoint at 25 turns", async () => {
    const ctx = makeCtx("test-b");
    const cp = await createCheckpoint(ctx, 25, "test-b");
    assert.ok(cp !== null, "checkpoint created");
    assert.ok(cp.id, "has an id");
    assert.equal(cp.turnCount, 25);
    assert.equal(cp.sessionId, "test-b");
    assert.ok(cp.timestamp > 0, "has timestamp");
  });

  it("returns checkpoint info even when empty", async () => {
    const ctx = makeCtx("test-c");
    const info = getCheckpointInfo(ctx);
    assert.ok(typeof info.count === "number", "count is number");
    assert.ok(info.autoRollback === true, "auto-rollback default enabled");
  });

  it("creates checkpoint on clean heartbeat tick", async () => {
    const ctx = makeCtx("test-d");
    const result = await heartbeatCheckpointTick(ctx, 30, "test-d", false);
    assert.ok(result.checkpointCreated, "checkpoint on clean tick");
    assert.equal(result.rollbackPerformed, false);
  });

  it("does not create checkpoint on degraded heartbeat tick", async () => {
    const ctx = makeCtx("test-e");
    const result = await heartbeatCheckpointTick(ctx, 30, "test-e", true);
    assert.equal(result.checkpointCreated, false, "no new checkpoint on degrade");
    assert.ok(typeof result.rollbackPerformed === "boolean");
  });

  it("supports multiple checkpoints over time with same ctx", async () => {
    const ctx = makeCtx("test-f");
    // Turn 5: too early
    assert.equal(await createCheckpoint(ctx, 5, "test-f"), null);
    // Turn 25: first checkpoint
    const cp1 = await createCheckpoint(ctx, 25, "test-f");
    assert.ok(cp1, "first checkpoint at 25");
    // Turn 30: too soon (only 5 since last)
    assert.equal(await createCheckpoint(ctx, 30, "test-f"), null);
    // Turn 50: second checkpoint
    const cp2 = await createCheckpoint(ctx, 50, "test-f");
    assert.ok(cp2, "second checkpoint at 50");
    assert.equal(cp2.turnCount, 50);
  });
});
