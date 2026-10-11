/**
 * Prompt-entry wake-window stress fixture — proves the residual competing-run
 * window is closed while the system is under load.
 *
 * THE WINDOW: pi-core's session.prompt() pre-flight (model/auth checks,
 * compaction, before_agent_start dispatch) runs with the session isStreaming
 * flag false. A triggerTurn wake landing there starts a COMPETING agent run
 * that dies on pi-core's activeRun guard. Braid closes the window from
 * prompt() entry: the `input` event (documented: streamingBehavior is set
 * exactly when the input is a steer/followUp into an ACTIVE run, undefined
 * when idle) arms the wake-gate, and gateTriggerTurnOptions drops triggerTurn
 * for any wake landing before agent_start, so the wake takes the live shape
 * (steer into a streaming run, append to the session in the pre-flight).
 *
 * THE LOAD SHAPES (all through the real wiring: timer extension factory +
 * registerWakeGate + the sendTrackedMessage delivery path):
 *   - two concurrent tool executions with the timer expiring mid-tool (the
 *     busy guard defers the fire to the TOOL_EXECUTION_END fireExpired path),
 *   - the deferred wake landing after prompt() entry but before
 *     before_agent_start (the narrow residual window),
 *   - a pi-core auto-retry cycle in progress (retryable agent_end with no
 *     settle — the retryable-failure hold must suppress mid-cycle arming).
 *
 * ASSERTION SET:
 *   1. No lost wake / no competing run: an in-window wake reaches
 *      pi.sendMessage exactly once as {deliverAs:"steer"} (the live shape).
 *   2. No double delivery: after the run settles, advancing the clock past
 *      the 240s outcome window and draining arms nothing — the gated steer
 *      delivery already resolved at settle.
 *   3. No cross-run leak: the input-armed gate releases at agent_start of
 *      the same prompt cycle; run N+1's wakes are triggerTurn-capable and
 *      its own window gates only its own in-window wakes.
 *   4. retryHoldUntil: poll ticks past the outcome window during a simulated
 *      auto-retry arm nothing; the settle releases the hold (success → no
 *      redelivery ever; final failure → exactly one ladder, delivered once).
 *   5. Drop policy: the only drop reachable under load is cap exhaustion —
 *      the fire gets a visible exhausted notice, and the redelivery label
 *      reads the LIVE effective cap (maxWakeAttempts pickup evidence).
 *
 * Run: node test/runtime/lib/test-wake-window-stress.mjs
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin braid's persistent tree into a private tmpdir. The fixtures schedule
// real timers through the extension, and every schedule persists through
// getTimerFilePath(cwd), which resolves under the LIVE braid home unless
// BRAID_HOME overrides it (braidDir() honors the override per call). Unpinned,
// a run writes a store into ~/.pi/agent/braid/projects/<tmp-cwd>/ and leaves
// it behind whenever the process dies before the store empties, which is what
// the runner's timeout kill does.
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-timer-home-wake-window-stress-"));
process.env.BRAID_HOME = BRAID_HOME;

const timerMod = await import("../../../dist/extensions/scheduling/timer/index.js");
const { wakeRetryQueue, WAKE_OUTCOME_TIMEOUT_MS, WAKE_RETRY_BACKOFF_MS } =
  await import("../../../dist/extensions/scheduling/timer/wake-retry.js");
const { registerWakeGate, resetWakeGateForTests, isRunRegionActive } =
  await import("../../../dist/lib/utils/wake-gate.js");
const { clearAllBuckets } = await import("../../../dist/lib/utils/injection-tracker.js");

const originalCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "braid-wake-window-stress-"));
process.chdir(tmp); // a throwaway project key: the store is per-CWD

process.on("exit", () => {
  process.chdir(originalCwd);
  for (const dir of [tmp, BRAID_HOME]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

const CTX = { sessionManager: { getSessionId: () => "w140" } };

/** Three macrotask hops: fireExpired's deferral → sendTrackedMessage's
 *  triggerTurn deferral → the actual pi.sendMessage. Two hops only unwind
 *  the first two; the third guarantees the send landed. */
function flushDeferred() {
  return new Promise((resolve) => setTimeout(() => setTimeout(() => setTimeout(resolve, 0), 0), 0));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wire the full delivery pipeline exactly as production does: timer
 *  extension (poller, fire path, retry wiring) + wake gate. */
function makePi() {
  const pi = {
    sent: [],
    handlers: {},
    registerTool() {},
    on(name, fn) {
      (this.handlers[name] ??= []).push(fn);
    },
    emit(name, event = {}, ctx = {}) {
      for (const fn of this.handlers[name] ?? []) fn(event, ctx);
    },
    sendMessage(params, options) {
      this.sent.push({ params, options });
    },
  };
  timerMod.default(pi);
  registerWakeGate(pi);
  return pi;
}

/** A user prompt enters session.prompt(): the `input` event fires at entry,
 *  with streamingBehavior set only when it queues into an ACTIVE run. */
function userPromptEnters(p, streamingBehavior) {
  p.emit("input", {
    type: "input",
    text: "continue the task",
    source: "interactive",
    ...(streamingBehavior ? { streamingBehavior } : {}),
  });
}

/** Schedule a short wake timer and let it expire while tool A is in flight —
 *  the busy guard holds the fire until the TOOL_EXECUTION_END tick claims it.
 *  Deterministic: the 1s poller bails while busy, so fireExpired is the only
 *  claimant, and checkExpired removes the claimed timer from the map. */
async function fireWakeMidTool(p) {
  timerMod.scheduleTimer("w140", 30, "resume the deploy", undefined, true);
  p.emit("tool_call", { type: "tool_call", toolCallId: "a" }, CTX); // tool A in flight
  await sleep(60); // timer expires mid-tool
  p.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "a" }, CTX);
  await flushDeferred();
}

function settleRun(p, failed, errorMessage) {
  if (failed) {
    p.emit(
      "agent_end",
      { messages: [{ role: "assistant", stopReason: "error", errorMessage }] },
      CTX,
    );
  } else {
    p.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, CTX);
  }
  p.emit("agent_settled", {}, CTX);
}

let pi;

afterEach(() => {
  // session_shutdown stops the 1s poller interval — without it the live
  // setInterval keeps the event loop alive and the runner never exits.
  if (pi) pi.emit("session_shutdown", {}, CTX);
  pi = undefined;
  wakeRetryQueue.resetForTests();
  wakeRetryQueue._setClockForTests(null);
  resetWakeGateForTests();
  clearAllBuckets();
  timerMod.timerManager.clearSession("w140");
});

describe("wake window: wake landing in the pre-before_agent_start window under tool load", () => {
  it("delivers exactly once as a queued steer (no lost wake, no competing run)", async () => {
    pi = makePi();
    pi.emit("session_start", {}, CTX);

    // Prompt entry arms the gate (idle input — no streamingBehavior), then
    // the wake expires mid-tool and lands before before_agent_start.
    userPromptEnters(pi);
    assert.equal(isRunRegionActive(), true, "prompt() entry must arm the gate");
    await fireWakeMidTool(pi);

    assert.equal(pi.sent.length, 1, "in-window wake must not be dropped");
    assert.equal(pi.sent[0].params.customType, "timer-fire");
    assert.equal(
      pi.sent[0].options.triggerTurn,
      undefined,
      "in-window wake must not start a competing run",
    );
    assert.equal(pi.sent[0].options.deliverAs, "steer", "in-window wake rides as a live steer");

    // The run then proceeds normally; the steer rides it.
    pi.emit("before_agent_start", { type: "before_agent_start" }, CTX);
    pi.emit("agent_start", { type: "agent_start" }, CTX);
    assert.equal(isRunRegionActive(), false, "agent_start releases the gate mid-cycle");
    settleRun(pi, false);

    // 2. No double delivery: after settle, the outcome window elapsed must
    //    arm nothing — the steer delivery resolved as succeeded.
    const fireTime = Date.now();
    wakeRetryQueue._setClockForTests(() => fireTime + WAKE_OUTCOME_TIMEOUT_MS + 60_000);
    pi.emit("tool_execution_end", {}, CTX); // poll-tick equivalent drain
    pi.emit("turn_end", {}, CTX);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "settled wake must never be re-delivered");
    assert.equal(wakeRetryQueue.outstandingCount(), 0);
    assert.equal(wakeRetryQueue.pendingRetryCount(), 0);
  });

  it("second fire in the same window also delivers exactly once (no double delivery per fire)", async () => {
    pi = makePi();
    pi.emit("session_start", {}, CTX);
    userPromptEnters(pi);

    await fireWakeMidTool(pi);
    // A second timer expires in the same window: each fire delivers exactly
    // once, as its own queued steer.
    pi.emit("tool_call", { type: "tool_call", toolCallId: "b" }, CTX);
    timerMod.scheduleTimer("w140", 20, "second reminder", undefined, true);
    await sleep(50);
    pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "b" }, CTX);
    await flushDeferred();

    assert.equal(pi.sent.length, 2, "two distinct fires, two distinct deliveries");
    for (const s of pi.sent) {
      assert.equal(s.options.triggerTurn, undefined);
      assert.equal(s.options.deliverAs, "steer");
    }
    settleRun(pi, false);
    assert.equal(wakeRetryQueue.getStats().succeeded, 2, "both steers resolved at settle");
    assert.equal(wakeRetryQueue.pendingRetryCount(), 0);
  });
});

describe("wake window: no cross-run leak from the input-armed gate", () => {
  it("gate releases at agent_start; idle wake after run N is triggerTurn-capable", async () => {
    pi = makePi();
    pi.emit("session_start", {}, CTX);

    // Run N: prompt entry arms; wake in the window delivers as steer; the
    // run starts (releases) and settles.
    userPromptEnters(pi);
    await fireWakeMidTool(pi);
    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].options.triggerTurn, undefined);
    pi.emit("before_agent_start", { type: "before_agent_start" }, CTX);
    pi.emit("agent_start", { type: "agent_start" }, CTX);
    settleRun(pi, false);

    // Idle between runs: a fresh wake is a real turn trigger — the gate
    // armed by run N's prompt entry must NOT suppress or steer it.
    pi.emit("tool_call", { type: "tool_call", toolCallId: "c" }, CTX);
    timerMod.scheduleTimer("w140", 20, "idle follow-up", undefined, true);
    await sleep(50);
    pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "c" }, CTX);
    await flushDeferred();
    assert.equal(pi.sent.length, 2);
    assert.equal(
      pi.sent[1].options.triggerTurn,
      true,
      "idle wake after run N settled must start its own turn",
    );
    assert.equal(pi.sent[1].options.deliverAs, undefined);

    // Run N+1: its prompt entry re-arms; only its own in-window wakes gate.
    userPromptEnters(pi);
    assert.equal(isRunRegionActive(), true, "run N+1's prompt entry re-arms the gate");
    pi.emit("before_agent_start", { type: "before_agent_start" }, CTX);
    pi.emit("agent_start", { type: "agent_start" }, CTX);
    assert.equal(isRunRegionActive(), false);
    settleRun(pi, false);
  });

  it("mid-run wake (gate released) is triggerTurn:true — pi-core's own queueing owns it", async () => {
    pi = makePi();
    pi.emit("session_start", {}, CTX);
    userPromptEnters(pi);
    pi.emit("before_agent_start", { type: "before_agent_start" }, CTX);
    pi.emit("agent_start", { type: "agent_start" }, CTX);

    pi.emit("tool_call", { type: "tool_call", toolCallId: "d" }, CTX);
    timerMod.scheduleTimer("w140", 20, "mid-run reminder", undefined, true);
    await sleep(50);
    pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "d" }, CTX);
    await flushDeferred();

    assert.equal(pi.sent.length, 1);
    assert.equal(
      pi.sent[0].options.triggerTurn,
      true,
      "post-agent_start wake stays triggerTurn (native isStreaming queueing)",
    );
    settleRun(pi, false);
  });
});

describe("retryHoldUntil: simulated pi-core auto-retry holds redelivery, settle releases it", () => {
  it("poll ticks past the outcome window during the retry cycle arm nothing; recovered run redelivers never", async () => {
    pi = makePi();
    pi.emit("session_start", {}, CTX);

    // Idle delivery (no run): the wake is a real triggerTurn turn.
    pi.emit("tool_call", { type: "tool_call", toolCallId: "e" }, CTX);
    timerMod.scheduleTimer("w140", 30, "resume the deploy", undefined, true);
    await sleep(60);
    pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "e" }, CTX);
    await flushDeferred();
    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].options.triggerTurn, true, "idle wake is a real turn");
    assert.equal(wakeRetryQueue.outstandingCount(), 1);

    // pi-core auto-retry in progress: the FIRST attempt fails retryable and
    // there is NO settle yet. Pin the clock past the 240s outcome window so
    // every drain tick would arm, were the hold not active.
    const fireTime = Date.now();
    wakeRetryQueue._setClockForTests(() => fireTime + WAKE_OUTCOME_TIMEOUT_MS + 10_000);
    wakeRetryQueue._setRetryHoldForTests(300_000);
    pi.emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "Connection error: socket hang up",
          },
        ],
      },
      CTX,
    );
    pi.emit("tool_execution_end", {}, CTX); // tick during the retry cycle
    pi.emit("turn_end", {}, CTX);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "hold active: no mid-retry-cycle redelivery");
    assert.equal(wakeRetryQueue.pendingRetryCount(), 0, "nothing armed during the hold");

    // pi-core's retry succeeds: final outcome success — the hold releases
    // and the outstanding wake resolves. No redelivery is ever armed.
    settleRun(pi, false);
    pi.emit("tool_execution_end", {}, CTX);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "recovered run: no redelivery ever fires");
    assert.equal(wakeRetryQueue.outstandingCount(), 0);
    assert.equal(wakeRetryQueue.pendingRetryCount(), 0);
  });

  it("hold releases at a FAILED settle: exactly one ladder, delivered exactly once", async () => {
    pi = makePi();
    pi.emit("session_start", {}, CTX);

    pi.emit("tool_call", { type: "tool_call", toolCallId: "f" }, CTX);
    timerMod.scheduleTimer("w140", 30, "resume the build", undefined, true);
    await sleep(60);
    pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "f" }, CTX);
    await flushDeferred();
    assert.equal(pi.sent.length, 1);

    // pi-core retry cycle: attempt 1 fails retryable (hold starts), the
    // cycle exhausts, the settle reports the final failure — the hold is
    // void and exactly ONE ladder arms.
    pi.emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "Connection error: other side closed",
          },
        ],
      },
      CTX,
    );
    settleRun(pi, true, "Connection error: other side closed");
    assert.equal(wakeRetryQueue.pendingRetryCount(), 1, "exactly one retry armed at settle");

    // The ladder's backoff elapses → one redelivery, labelled with the LIVE
    // effective cap (default 3 — the maxWakeAttempts pickup at HEAD).
    const fireTime = Date.now();
    wakeRetryQueue._setClockForTests(() => fireTime + WAKE_RETRY_BACKOFF_MS[0]);
    pi.emit("tool_execution_end", {}, CTX);
    await flushDeferred();
    assert.equal(pi.sent.length, 2, "ladder delivers once");
    assert.equal(pi.sent[1].options.triggerTurn, true, "redelivery is a wake");
    assert.match(pi.sent[1].params.content[0].text, /wake retry 1\/3/);
    settleRun(pi, false);
    assert.equal(wakeRetryQueue.pendingRetryCount(), 0);
  });
});

describe("drop policy: cap exhaustion is the only under-load drop, and it is visible", () => {
  it("exhausted fire gets the exhausted notice; the redelivery label reads the LIVE effective cap", async () => {
    pi = makePi();
    pi.emit("session_start", {}, CTX);
    wakeRetryQueue._setMaxAttemptsForTests(1); // pin a 1-redelivery cap

    pi.emit("tool_call", { type: "tool_call", toolCallId: "g" }, CTX);
    timerMod.scheduleTimer("w140", 30, "resume the release", undefined, true);
    await sleep(60);
    pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "g" }, CTX);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "original fire delivered");

    // First failure: attempt 1 arms (1 <= cap). Its redelivery label must
    // interpolate the EFFECTIVE cap (1 here) — proof the label template
    // reads getMaxAttempts(), not a hardcoded denominator.
    settleRun(pi, true, "HTTP 401");
    const t0 = Date.now();
    wakeRetryQueue._setClockForTests(() => t0 + WAKE_RETRY_BACKOFF_MS[0]);
    pi.emit("tool_execution_end", {}, CTX);
    await flushDeferred();
    assert.equal(pi.sent.length, 2, "redelivery 1 delivered");
    assert.match(
      pi.sent[1].params.content[0].text,
      /wake retry 1\/1/,
      "label reads the live effective cap through getMaxAttempts()",
    );

    // Second failure: attempt 2 > cap → exhausted, with a VISIBLE final
    // notice (never a silent drop).
    settleRun(pi, true, "HTTP 401");
    assert.equal(wakeRetryQueue.pendingRetryCount(), 0, "nothing armed past the cap");
    assert.equal(wakeRetryQueue.getStats().exhausted, 1, "exhaustion counted");
    pi.emit("tool_execution_end", {}, CTX); // drain surfaces the exhausted notice
    await flushDeferred();
    assert.equal(pi.sent.length, 3, "exhausted fire surfaces a final notice");
    assert.match(pi.sent[2].params.content[0].text, /permanently undelivered after 1 retries/);
    settleRun(pi, false);
  });
});
