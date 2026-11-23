/**
 * A timer may carry a fire-time predicate, and the predicate only ever gates
 * the whisper.
 *
 * The store's contract for the opt-in `shouldFire` callback:
 *   1. `false` withholds the delivery and completes the fire exactly like any
 *      other - the timer is removed, the fire is logged, nothing is retried;
 *   2. `true` delivers exactly as an unarmed timer does;
 *   3. a throw is a delivery, never a silence, and the throw is logged;
 *   4. a timer armed without a predicate is unchanged (the compatibility bar);
 *   5. the predicate is consulted again on a redelivery, not cached at the
 *      first delivery - the fact it measures can change in between.
 *
 * Run: node --test packages/core/test/runtime/lib/test-timer-fire-predicate.mjs
 * (after npm run build)
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BRAID_HOME = mkdtempSync(join(tmpdir(), "timer-fire-predicate-"));
process.env.BRAID_HOME = BRAID_HOME;

const timerMod = await import("../../../dist/extensions/scheduling/timer/index.js");
const { wakeRetryQueue, WAKE_RETRY_BACKOFF_MS } = await import(
  "../../../dist/extensions/scheduling/timer/wake-retry.js"
);
const { clearLogBuffer, getLogBuffer } = await import("../../../dist/lib/core/logger.js");

function makeFakePi() {
  const handlers = new Map();
  const sent = [];
  return {
    sent,
    registerTool() {},
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event, payload = {}, ctx = {}) {
      for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
    },
    sendMessage(params, options) {
      sent.push({ params, options });
    },
  };
}

/** Two macrotask hops: fireExpired defers once, a triggerTurn send defers again. */
function flushDeferred() {
  return new Promise((resolve) => setTimeout(() => setTimeout(resolve, 0), 0));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const timerLines = () =>
  getLogBuffer()
    .filter((entry) => entry.source === "timer")
    .map((entry) => entry.message)
    .join("\n");

const ctxFor = (sessionId) => ({
  sessionManager: {
    getSessionFile: () => join(BRAID_HOME, `${sessionId}.jsonl`),
    getSessionId: () => sessionId,
  },
  isIdle: () => true,
  signal: undefined,
});

/** Arm the extension over one session and expire one timer through the poll path. */
async function fireOnce(sessionId, shouldFire) {
  const pi = makeFakePi();
  timerMod.default(pi);
  const ctx = ctxFor(sessionId);
  pi.emit("session_start", {}, ctx);
  timerMod.scheduleTimer(
    sessionId,
    30,
    "watch the deploy",
    undefined,
    true,
    undefined,
    undefined,
    shouldFire,
  );
  await sleep(80);
  pi.emit("tool_execution_end", {}, ctx);
  await flushDeferred();
  return { pi, ctx };
}

afterEach(() => {
  wakeRetryQueue.resetForTests();
  wakeRetryQueue._setClockForTests(null);
  clearLogBuffer();
});

describe("timer fire-time predicate", () => {
  it("withholds the whisper and still completes the fire when it says no", async () => {
    const { pi, ctx } = await fireOnce("fire-no", () => false);

    assert.equal(pi.sent.length, 0, "nothing reaches the agent");
    assert.equal(
      timerMod.listTimers("fire-no").length,
      0,
      "the timer is removed like any fired one-shot",
    );
    assert.equal(wakeRetryQueue.outstandingCount(), 0, "a withheld fire is not tracked for retry");
    assert.match(timerLines(), /fired: timer-/, "the store still records the fire itself");
    assert.match(timerLines(), /fire withheld/, "and records why the whisper did not follow");
    pi.emit("session_shutdown", {}, ctx);
  });

  it("delivers exactly as an unarmed timer when it says yes", async () => {
    const { pi, ctx } = await fireOnce("fire-yes", () => true);

    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].options.triggerTurn, true);
    assert.match(pi.sent[0].params.content[0].text, /watch the deploy/);
    assert.doesNotMatch(timerLines(), /fire withheld/);
    pi.emit("session_shutdown", {}, ctx);
  });

  it("fires, and logs the throw, when the predicate throws", async () => {
    const { pi, ctx } = await fireOnce("fire-throw", () => {
      throw new Error("registry read exploded");
    });

    assert.equal(pi.sent.length, 1, "a throwing predicate must not silence a wake");
    assert.match(timerLines(), /fire predicate threw/);
    assert.match(timerLines(), /registry read exploded/);
    pi.emit("session_shutdown", {}, ctx);
  });

  it("behaves exactly as before when no predicate is armed", async () => {
    const { pi, ctx } = await fireOnce("fire-none", undefined);

    assert.equal(pi.sent.length, 1, "the compatibility bar: every existing caller is untouched");
    assert.match(pi.sent[0].params.content[0].text, /watch the deploy/);
    pi.emit("session_shutdown", {}, ctx);
  });

  it("consults the predicate again on a redelivery, not just once at the first fire", async () => {
    let allow = true;
    const { pi, ctx } = await fireOnce("fire-redelivery", () => allow);
    assert.equal(pi.sent.length, 1, "pre-condition: the first delivery went out");

    // The wake's turn fails, which arms one redelivery.
    pi.emit(
      "agent_end",
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 401" }] },
      ctx,
    );
    pi.emit("agent_settled", {}, ctx);
    assert.equal(wakeRetryQueue.pendingRetryCount(), 1, "pre-condition: a retry is armed");

    allow = false; // the fact changed while the retry waited
    wakeRetryQueue._setClockForTests(() => Date.now() + WAKE_RETRY_BACKOFF_MS[0]);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();

    assert.equal(pi.sent.length, 1, "the redelivery is withheld");
    assert.match(timerLines(), /fire withheld/);
    pi.emit("session_shutdown", {}, ctx);
  });
});
