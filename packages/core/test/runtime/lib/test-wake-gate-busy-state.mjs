/**
 * Regression test: a triggerTurn wake must NOT be delivered while the
 * session is busy (ctx.signal === undefined && !ctx.isIdle() — compaction
 * or post-run bookkeeping). It must be handed to the wake-retry queue and
 * redelivered once the session is idle again.
 *
 * The scenario the busy-state check exists for: the run-region flag armed,
 * its fail-safe expired (no release event ever arrived), and the session is
 * STILL busy. The region flag is gone, so the old region gate had nothing
 * to rewrite — the raw wake reached pi.sendMessage and pi-core routed it to
 * _runAgentPrompt while the session was busy, where pi-agent-core's
 * activeRun guard throws "Agent is already processing a prompt. Use
 * steer() or followUp() ...". Post-fix the send consults the live agent
 * state (busy = signal undefined while isIdle is false) and, when the
 * caller supplied a re-queue hook, parks the wake instead of sending.
 *
 * REVERT-PROOF: on the pre-fix tree isAgentBusy/deferBusyWake do not exist
 * and sendTrackedMessage has no busy hook, so the wake reaches
 * pi.sendMessage — every "no send" assertion below fails.
 *
 * Run: node test/runtime/lib/test-wake-gate-busy-state.mjs
 */

import { strict as assert } from "node:assert";
// Compiled runtime (npm test builds first).
const {
  registerWakeGate,
  resetWakeGateForTests,
  isRunRegionActive,
  isAgentBusy,
  _setWakeGateFailSafeMsForTests,
} = await import("../../../dist/lib/utils/wake-gate.js");
const { sendTrackedMessage, clearAllBuckets } =
  await import("../../../dist/lib/utils/injection-tracker.js");
const { wakeRetryQueue, WakeRetryQueue, WAKE_RETRY_BACKOFF_MS, WAKE_RETRY_MAX_ATTEMPTS } =
  await import("../../../dist/extensions/scheduling/timer/wake-retry.js");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

console.log("=== wake-gate busy-state: busy triggerTurn wakes defer to the retry queue ===\n");

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeFakePi() {
  const sent = [];
  return {
    handlers: new Map(),
    sent,
    on(event, handler) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    },
    sendMessage(params, options) {
      sent.push({ params, options });
    },
    sendUserMessage() {},
    _emit(event, payload, ctx) {
      const list = this.handlers.get(event) ?? [];
      for (const h of list) {
        Promise.resolve(h(payload ?? event, ctx)).catch(() => {});
      }
    },
  };
}

/** Live-reader ctx fixture: isIdle/signal read the holder at CALL time,
 *  exactly like pi-core's ExtensionContext (createContext builds lazy
 *  getters over the runner's live functions). Flip holder fields to move
 *  the session between idle/busy after the ctx was captured. */
function makeCtx({ idle = true } = {}) {
  const holder = { idle, signal: undefined };
  return {
    holder,
    isIdle: () => holder.idle,
    get signal() {
      return holder.signal;
    },
  };
}

/** Flush the setTimeout(0) deferral inside sendTrackedMessage. */
function flushDeferred() {
  return new Promise((r) => setTimeout(r, 30));
}

/** Sleep for ms (real wall-clock; used to let the fail-safe timer elapse). */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeTimer(id, reason = "resume the task") {
  return {
    id,
    sessionId: "busy-state",
    firesAt: Date.now(),
    reason,
    createdAt: Date.now() - 1000,
    wake: true,
  };
}

function sendWake(pi, wakeDefer, deliverAs) {
  sendTrackedMessage(
    pi,
    {
      customType: "timer-fire",
      content: [{ type: "text", text: "test wake" }],
      display: true,
      details: { _braidInjected: true, _braidSource: "timer/fire", wake: true },
    },
    { triggerTurn: true, ...(deliverAs ? { deliverAs } : {}) },
    { type: "heartbeat", source: "timer/fire" },
    { bypassFloodCap: true },
    wakeDefer,
  );
}

// ── A. The live busy-state query (wake-gate) ────────────────────────────────

await test("state: no captured ctx → isAgentBusy() false (fail-open, no suppression)", () => {
  resetWakeGateForTests();
  assert.equal(isAgentBusy(), false);
});

await test("state: busy session (signal undefined, isIdle false) → true", () => {
  resetWakeGateForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("session_start", {}, makeCtx({ idle: false }));
  assert.equal(isAgentBusy(), true);
});

await test("state: idle session (signal undefined, isIdle true) → false", () => {
  resetWakeGateForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("session_start", {}, makeCtx({ idle: true }));
  assert.equal(isAgentBusy(), false);
});

await test("state: streaming run (signal defined) → false (mid-run steer is by design)", () => {
  resetWakeGateForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  const ctx = makeCtx({ idle: false });
  ctx.holder.signal = new AbortController().signal;
  pi._emit("session_start", {}, ctx);
  assert.equal(isAgentBusy(), false, "a signal-carrying ctx is a live run, not the busy window");
});

await test("state: read live at query time, not at capture time", () => {
  resetWakeGateForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  const ctx = makeCtx({ idle: true });
  pi._emit("session_start", {}, ctx);
  assert.equal(isAgentBusy(), false);
  ctx.holder.idle = false; // compaction starts after capture
  assert.equal(isAgentBusy(), true, "busy must be evaluated at send time from live state");
});

await test("state: stale ctx (isIdle throws) → false (fail-open)", () => {
  resetWakeGateForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit(
    "session_start",
    {},
    {
      isIdle: () => {
        throw new Error("stale ctx: session replaced");
      },
      signal: undefined,
    },
  );
  assert.equal(isAgentBusy(), false, "an unreadable state must not suppress the wake");
});

await test("state: a ctx-less event keeps the last captured ctx", () => {
  resetWakeGateForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("session_start", {}, makeCtx({ idle: false }));
  assert.equal(isAgentBusy(), true);
  pi._emit("agent_start", {}); // no ctx argument
  assert.equal(isAgentBusy(), true, "capture must not be clobbered by a missing ctx");
});

// ── B. sendTrackedMessage defers busy triggerTurn wakes ─────────────────────

await test("send: busy + onBusy → deferred (onBusy called, pi.sendMessage NOT called)", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  wakeRetryQueue.resetForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("session_start", {}, makeCtx({ idle: false }));
  assert.equal(isRunRegionActive(), false, "control: the region gate is NOT armed here");

  let deferred = 0;
  sendWake(pi, { onBusy: () => deferred++ });
  await flushDeferred();

  assert.equal(deferred, 1, "onBusy must run instead of the send");
  assert.equal(pi.sent.length, 0, "a busy-session wake must NOT be sent");
});

await test("send: idle + onBusy → normal send (triggerTurn preserved)", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  wakeRetryQueue.resetForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("session_start", {}, makeCtx({ idle: true }));

  let deferred = 0;
  sendWake(pi, { onBusy: () => deferred++ });
  await flushDeferred();

  assert.equal(pi.sent.length, 1, "idle wake is delivered");
  assert.equal(pi.sent[0].options.triggerTurn, true, "idle wake keeps its own turn");
  assert.equal(deferred, 0, "no deferral when the session is idle");
});

await test("send: busy + no onBusy → sends as before (fail-open, region gate unchanged)", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  wakeRetryQueue.resetForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("session_start", {}, makeCtx({ idle: false }));

  sendWake(pi); // no re-queue hook
  await flushDeferred();

  assert.equal(pi.sent.length, 1, "wakes without a re-queue path keep today's behavior");
  assert.equal(pi.sent[0].options.triggerTurn, true);
});

await test("send: steer (triggerTurn false) + busy → normal send (never deferred)", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  wakeRetryQueue.resetForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("session_start", {}, makeCtx({ idle: false }));

  let deferred = 0;
  sendTrackedMessage(
    pi,
    {
      customType: "timer",
      content: [{ type: "text", text: "advisory" }],
      display: true,
    },
    { deliverAs: "steer", triggerTurn: false },
    { type: "heartbeat", source: "timer/fire" },
    { bypassFloodCap: true },
    { onBusy: () => deferred++ },
  );
  await flushDeferred();

  assert.equal(pi.sent.length, 1, "non-triggerTurn sends are never deferred");
  assert.equal(deferred, 0);
});

await test("send: busy + onBusy + explicit deliverAs → still deferred (core ignores deliverAs when not streaming)", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  wakeRetryQueue.resetForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("session_start", {}, makeCtx({ idle: false }));

  let deferred = 0;
  sendWake(pi, { onBusy: () => deferred++ }, "steer");
  await flushDeferred();

  assert.equal(deferred, 1, "the busy state is the danger, deliverAs is not consulted by core");
  assert.equal(pi.sent.length, 0);
});

// ── C. The wake-retry queue parks busy-deferred wakes ───────────────────────

await test("queue: deferBusyWake arms a retry; drainDue returns it with cause 'busy'", () => {
  const q = new WakeRetryQueue();
  let now = 1_000_000;
  q._setClockForTests(() => now);
  const timer = makeTimer("busy-1");
  q.trackWake(timer); // as the fire path does before sending
  q.deferBusyWake(timer, 0);

  assert.deepEqual(
    q.drainDue().map((r) => r.timer.id),
    [],
    "inside the first backoff tier: not due yet",
  );
  now += WAKE_RETRY_BACKOFF_MS[0];
  const due = q.drainDue();
  assert.deepEqual(
    due.map((r) => ({ id: r.timer.id, attempt: r.attempt, cause: r.cause })),
    [{ id: "busy-1", attempt: 1, cause: "busy" }],
    "busy-deferred wake redelivers with an honest cause",
  );
});

await test("queue: busy-deferral chain parks at the cap instead of exhausting (no silent drop)", () => {
  const q = new WakeRetryQueue();
  q._setMaxAttemptsForTests(WAKE_RETRY_MAX_ATTEMPTS);
  let now = 2_000_000;
  q._setClockForTests(() => now);
  const timer = makeTimer("busy-2");
  q.trackWake(timer);
  for (let attempt = 1; attempt <= WAKE_RETRY_MAX_ATTEMPTS; attempt++) {
    q.deferBusyWake(timer, attempt - 1);
    now += WAKE_RETRY_BACKOFF_MS[attempt - 1];
    const due = q.drainDue();
    assert.equal(due.length, 1, `busy redelivery ${attempt} due`);
    assert.equal(due[0].cause, "busy");
    q.trackWake(due[0].timer, due[0].attempt); // as the redelivery path does
  }
  q.deferBusyWake(timer, WAKE_RETRY_MAX_ATTEMPTS); // one more deferral → ladder spent
  assert.equal(q.pendingRetryCount(), 0, "no retry armed past the cap");
  assert.equal(q.takeExhausted().length, 0, "a busy-held fire is never dropped");
  assert.equal(q.getStats().exhausted, 0, "the exhaustion counter stays clean");
  assert.equal(q.outstandingCount(), 1, "the fire is parked for a late delivery");

  // Idle now: the parked fire is handed to ONE late delivery, with its hold span.
  const parked = q.drainParkedBusy();
  assert.equal(parked.length, 1, "the held fire is delivered late, exactly once");
  assert.equal(parked[0].timer.id, "busy-2");
  assert.ok(parked[0].heldMs > 0, "the whole hold duration is reported");
});

await test("queue: a settle during a busy-deferral window does not resolve the wake as delivered", () => {
  const q = new WakeRetryQueue();
  let now = 3_000_000;
  q._setClockForTests(() => now);
  const timer = makeTimer("busy-3");
  q.trackWake(timer);
  q.deferBusyWake(timer, 0);

  // An unrelated run settles successfully while the wake is still parked —
  // no turn ever ran for this wake, so the settle must not clear its chain.
  q.onAgentEnd(false);
  q.onAgentSettled();
  assert.equal(q.pendingRetryCount(), 1, "the armed busy retry must survive the settle");

  now += WAKE_RETRY_BACKOFF_MS[0];
  assert.equal(q.drainDue().length, 1, "the wake is still redelivered after the settle");
});

await test("queue: failed-turn retries keep cause 'failed' (redelivery text stays truthful)", () => {
  const q = new WakeRetryQueue();
  let now = 4_000_000;
  q._setClockForTests(() => now);
  q.trackWake(makeTimer("fail-1"));
  q.onAgentEnd(true);
  q.onAgentSettled();
  now += WAKE_RETRY_BACKOFF_MS[0];
  const due = q.drainDue();
  assert.equal(due[0].cause, "failed", "failure-driven redeliveries keep the failure cause");
});

// ── D. Integration: region armed → fail-safe expires → session busy ─────────

await test("integration: armed region, expired fail-safe, busy session → wake parks, no send, redelivered when idle", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  wakeRetryQueue.resetForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);

  // 2. Short fail-safe override FIRST (the bound is snapshotted at arm
  //    time), so the armed window expires quickly without sleeping 120s.
  _setWakeGateFailSafeMsForTests(25);

  // 1. A session prompt enters: `input` fires at prompt() entry and arms
  //    the run region (idle prompt — no streamingBehavior); ctx is captured.
  const ctx = makeCtx({ idle: true });
  pi._emit("input", { type: "input", text: "resume", source: "interactive" }, ctx);
  assert.equal(isRunRegionActive(), true, "prompt entry arms the run region");

  // 2. No release event ever arrives (pre-flight abort, or a compaction
  //    outliving the bound): the fail-safe clears the region on its own.
  await sleep(60);
  assert.equal(isRunRegionActive(), false, "fail-safe cleared the region");

  // 3. The session is STILL busy (e.g. the compaction summarization keeps
  //    running): signal undefined, isIdle false.
  ctx.holder.idle = false;

  // 4. A timer wake fires and tries to start its own turn.
  const timer = makeTimer("wake-busy");
  wakeRetryQueue.trackWake(timer);
  let deferred = 0;
  sendTrackedMessage(
    pi,
    {
      customType: "timer-fire",
      content: [{ type: "text", text: "test wake" }],
      display: true,
      details: { _braidInjected: true, _braidSource: "timer/fire", wake: true },
    },
    { triggerTurn: true },
    { type: "heartbeat", source: "timer/fire" },
    { bypassFloodCap: true },
    {
      onBusy: () => {
        deferred++;
        wakeRetryQueue.deferBusyWake(timer, 0);
      },
    },
  );
  await flushDeferred();

  // (a) no send: the raw wake would have started a competing agent run.
  assert.equal(pi.sent.length, 0, "busy-session wake must NOT be sent");
  assert.equal(deferred, 1, "the wake was handed to the re-queue hook");
  // (b) queued for retry.
  assert.equal(wakeRetryQueue.pendingRetryCount(), 1, "wake parked in the retry queue");

  // 5. The session becomes idle again; the redelivery starts its own turn.
  ctx.holder.idle = true;
  wakeRetryQueue._setClockForTests(() => Date.now() + WAKE_RETRY_BACKOFF_MS[0] + 1);
  const due = wakeRetryQueue.drainDue();
  assert.equal(due.length, 1, "redelivery due once idle");
  assert.equal(due[0].cause, "busy");

  sendWake(pi); // what redeliverWakeFire's send path does
  await flushDeferred();
  assert.equal(pi.sent.length, 1, "redelivered wake reaches pi.sendMessage");
  assert.equal(
    pi.sent[0].options.triggerTurn,
    true,
    "the redelivered wake starts its own turn (idle session)",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
