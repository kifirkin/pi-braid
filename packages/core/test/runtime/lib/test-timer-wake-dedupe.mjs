/**
 * Wake-fire dedupe: a wake fire is delivered to the session at most once.
 *
 * Two generators produced live redelivery floods (189 "wake retry" whisper
 * deliveries in a single orchestrator session, 80x1/3 + 59x2/3
 * + 45x3/3):
 *
 * (a) A run that FAILED after the fire's injected message had already landed
 *     in the run's messages re-armed the fire at settle. agent_end carries
 *     the run's messages (pi-agent-core agent-loop builds newMessages from
 *     the run's own prompts), so delivery is confirmable from the messages
 *     themselves — not from the run outcome alone.
 *
 * (b) A newer fire of a recurring timer superseded an older instance while
 *     the older instance's pending redelivery was still armed (the failed
 *     settle cleared the outstanding map but left the armed retry): the
 *     older redelivery then fired alongside the newer delivery — same reason
 *     content, so the pair reads as a duplicate.
 *
 * Run: node test/runtime/lib/test-timer-wake-dedupe.mjs
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { WakeRetryQueue, WAKE_RETRY_BACKOFF_MS } = await import(
  "../../../dist/extensions/scheduling/timer/wake-retry.js"
);

const originalCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "braid-timer-wake-dedupe-"));
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-timer-home-wake-dedupe-"));
process.env.BRAID_HOME = BRAID_HOME;

after(() => {
  process.chdir(originalCwd);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeTimer(id) {
  return {
    id,
    sessionId: "wake-dedupe",
    firesAt: Date.now(),
    reason: "resume the task",
    wake: true,
  };
}

describe("wake-fire dedupe", () => {
  it("REGRESSION (a): a failed run whose fire message IS in the run's messages resolves delivered — no redelivery armed", () => {
    const q = new WakeRetryQueue();
    q.trackWake(makeTimer("t1"));

    // agent_end's third argument: the timer ids whose injected messages are
    // present in the run's messages (extracted from agent_end by the timer
    // extension). The run then failed with a provider error.
    const landed = new Set(["t1"]);
    q.onAgentEnd(true, "HTTP 401", landed);
    q.onAgentSettled();

    assert.equal(
      q.pendingRetryCount(),
      0,
      "a fire whose message already landed in the run's messages must not be re-armed by the failed settle",
    );
    assert.equal(q.outstandingCount(), 0, "the delivery is resolved");
    assert.equal(q.getStats().succeeded, 1, "resolved as delivered, not failed");
    assert.deepEqual(q.drainDue(), [], "nothing left to redeliver at any tick");
  });

  it("REGRESSION (b): a newer fire of the same timer supersedes the older instance's pending redelivery", () => {
    const q = new WakeRetryQueue();
    let now = 1_000_000;
    q._setClockForTests(() => now);
    const timer = makeTimer("t2");

    // Older instance: delivered, turn failed, retry armed.
    q.trackWake(timer);
    q.onAgentEnd(true);
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 1, "older instance armed for redelivery");

    // A newer fire of the SAME timer is delivered (recurring timer overlap):
    // the older instance's pending redelivery must be cancelled, not left to
    // fire alongside the newer delivery.
    q.trackWake(timer);
    assert.equal(
      q.pendingRetryCount(),
      0,
      "newer fire supersedes the older instance's pending redelivery",
    );
    assert.equal(q.outstandingCount(), 1, "the newer delivery is the one whose outcome matters");

    // The newer fire's own chain still works: failed run arms attempt 1 (not
    // an escalated tier inherited from the superseded chain).
    q.onAgentEnd(true);
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 1);
    now += WAKE_RETRY_BACKOFF_MS[0];
    assert.deepEqual(
      q.drainDue().map((r) => r.attempt),
      [1],
      "the superseded chain must not escalate the new fire's attempt tier",
    );
  });
});
