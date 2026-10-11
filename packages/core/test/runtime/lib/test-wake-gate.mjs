/**
 * Regression test: triggerTurn wakes must be gated to the live-steer shape during the
 * run region (session prompt pre-flight tail / compaction), but must stay
 * triggerTurn:true when the agent is genuinely idle (no suppression).
 *
 * The compaction/activeRun boundary race:
 * pi-core's sendCustomMessage routes triggerTurn:true to _runAgentPrompt when
 * the SESSION isStreaming flag is false. The session prompt() pre-flight
 * (auth + _checkCompaction + emitBeforeAgentStart) runs with isStreaming=false;
 * a deferred wake landing there starts a COMPETING agent run and the outer
 * prompt() throws pi-core's activeRun guard ("Agent is already processing a
 * prompt"). The wake-gate drops triggerTurn at send time when a run region is
 * active, so pi-core routes the wake by live state (branch 2 steer while a run
 * streams, branch 5 append in the pre-flight). pi 0.84.2 made the old
 * `triggerTurn: false` shape park (branch 4), which is why the gate no longer
 * returns it.
 *
 * REVERT-PROOF: the integration tests assert what reaches pi.sendMessage.
 * If the gate is removed from injection-tracker (or registerWakeGate is never
 * wired), gateTriggerTurnOptions is never consulted, _runRegionActive stays
 * false, and triggerTurn:true passes through ungated — every "gated"assertion
 * below fails. If the gate is left wired but the release-event (agent_start)
 * is removed, the settle-window assertion fails (idle wake suppressed).
 *
 * Run: node test/runtime/lib/test-wake-gate.mjs
 */

import { strict as assert } from "node:assert";
// Compiled runtime (npm test builds first).
const {
  registerWakeGate,
  gateTriggerTurnOptions,
  resetWakeGateForTests,
  isRunRegionActive,
  _setWakeGateFailSafeMsForTests,
  RUN_REGION_MAX_MS,
} = await import("../../../dist/lib/utils/wake-gate.js");
const { sendTrackedMessage, clearAllBuckets } =
  await import("../../../dist/lib/utils/injection-tracker.js");

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

console.log(
  "=== wake-gate: gate triggerTurn at compaction boundary, never suppress idle wake ===\n",
);

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
    _emit(event, payload) {
      const list = this.handlers.get(event) ?? [];
      for (const h of list) {
        // input handlers receive the event OBJECT (pi-core calls
        // handler(event, ctx)); legacy arming handlers ignore the arg, so
        // defaulting to the event name keeps the old fixtures intact.
        Promise.resolve(h(payload ?? event)).catch(() => {});
      }
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

function sendWake(pi) {
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
  );
}

// ── Unit: gateTriggerTurnOptions (pure) ────────────────────────────────────

await test("pure: idle (no run region) → triggerTurn:true passes through unchanged", () => {
  resetWakeGateForTests();
  const out = gateTriggerTurnOptions({ triggerTurn: true });
  assert.deepEqual(out, { triggerTurn: true }, "idle wake must NOT be rewritten");
  assert.equal(isRunRegionActive(), false);
});

await test("pure: run region active → triggerTurn dropped to the live shape", () => {
  resetWakeGateForTests();
  // Simulate before_agent_start having fired: set the flag via the real path.
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("before_agent_start");
  assert.equal(isRunRegionActive(), true, "before_agent_start arms the gate");

  const out = gateTriggerTurnOptions({ triggerTurn: true });
  assert.deepEqual(out, { deliverAs: "steer" });
});

await test("pure: explicit deliverAs preserved when gated", () => {
  resetWakeGateForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("session_before_compact");

  const out = gateTriggerTurnOptions({ deliverAs: "followUp", triggerTurn: true });
  // followUp delivered as a live followUp (triggerTurn dropped, mode kept).
  assert.deepEqual(out, { deliverAs: "followUp" });
});

await test("pure: non-triggerTurn options never touched (even when busy)", () => {
  resetWakeGateForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("before_agent_start");

  assert.deepEqual(gateTriggerTurnOptions({ deliverAs: "steer", triggerTurn: false }), {
    deliverAs: "steer",
    triggerTurn: false,
  });
  assert.deepEqual(gateTriggerTurnOptions(undefined), undefined);
});

await test("pure: agent_start releases the gate (settle window is safe for re-entry)", () => {
  resetWakeGateForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("before_agent_start");
  assert.equal(isRunRegionActive(), true);
  pi._emit("agent_start");
  assert.equal(isRunRegionActive(), false, "agent_start must release the gate");

  const out = gateTriggerTurnOptions({ triggerTurn: true });
  assert.deepEqual(out, { triggerTurn: true }, "after agent_start the wake is triggerTurn again");
});

await test("pure: session_compact releases the gate (manual-compaction auto-resume, item 1)", () => {
  resetWakeGateForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("session_before_compact");
  assert.equal(isRunRegionActive(), true);
  pi._emit("session_compact");
  assert.equal(isRunRegionActive(), false, "session_compact must release the gate");

  const out = gateTriggerTurnOptions({ triggerTurn: true });
  assert.deepEqual(
    out,
    { triggerTurn: true },
    "post-compaction auto-resume wake must stay triggerTurn",
  );
});

// ── Fail-safe (pre-flight abort leaves the gate STUCK true) ──
// pi-core emits NO event when the pre-flight aborts (auth/quota errors:
// before_agent_start fires, agent_start never does). The fail-safe auto-clears
// the gate RUN_REGION_MAX_MS after the last arming event so a stuck gate
// self-heals and wake:true timer fires start a turn again.

await test("fail-safe: pre-flight abort (before_agent_start, no agent_start) auto-clears the gate — wake starts a turn again", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  _setWakeGateFailSafeMsForTests(25);
  const pi = makeFakePi();
  registerWakeGate(pi);

  // Pre-flight tail starts (before_agent_start), then the turn ABORTS —
  // no agent_start, no session_compact, no release event (the stuck case).
  pi._emit("before_agent_start");
  assert.equal(isRunRegionActive(), true);
  await sleep(60); // well past the 25ms fail-safe bound

  assert.equal(
    isRunRegionActive(),
    false,
    "a gate stuck by a pre-flight abort must self-heal after the fail-safe bound",
  );

  // The REAL wake path (sendTrackedMessage, as timer fires use) now reaches
  // pi.sendMessage as triggerTurn:true — it would actually start a turn.
  sendWake(pi);
  await flushDeferred();
  assert.equal(pi.sent.length, 1, "wake reaches pi.sendMessage after the gate self-heals");
  assert.equal(
    pi.sent[0].options.triggerTurn,
    true,
    "the wake is triggerTurn:true again — it starts a turn on its own",
  );
  assert.equal(pi.sent[0].options.deliverAs, undefined);
});

await test("fail-safe: session_before_compact re-arms the window (compaction not cut short)", async () => {
  resetWakeGateForTests();
  _setWakeGateFailSafeMsForTests(40);
  const pi = makeFakePi();
  registerWakeGate(pi);

  pi._emit("before_agent_start"); // arm at t=0, window to t=40
  await sleep(30);
  assert.equal(isRunRegionActive(), true);
  pi._emit("session_before_compact"); // compaction starts: re-arm resets the window (t=30 -> t=70)
  await sleep(30); // t=60 — past the ORIGINAL 40ms bound
  assert.equal(
    isRunRegionActive(),
    true,
    "re-arm must extend the fail-safe window across a compaction (not cut it short)",
  );
  pi._emit("session_compact"); // compaction ends: release
  assert.equal(isRunRegionActive(), false);
});

await test("fail-safe: agent_start release cancels the fail-safe (no spurious re-arm)", async () => {
  resetWakeGateForTests();
  _setWakeGateFailSafeMsForTests(25);
  const pi = makeFakePi();
  registerWakeGate(pi);

  pi._emit("before_agent_start");
  pi._emit("agent_start"); // normal release — cancels the fail-safe timer
  await sleep(60); // well past the bound

  assert.equal(isRunRegionActive(), false, "gate stays released after the bound elapsed");
  assert.deepEqual(
    gateTriggerTurnOptions({ triggerTurn: true }),
    { triggerTurn: true },
    "a released gate is not re-armed by a stale fail-safe timer",
  );
});

await test("fail-safe: default bound is exported and generous (documented constant)", () => {
  resetWakeGateForTests();
  assert.ok(
    RUN_REGION_MAX_MS >= 60_000,
    `RUN_REGION_MAX_MS=${RUN_REGION_MAX_MS} must exceed any single compaction summarization`,
  );
});

// ── Integration: what reaches pi.sendMessage (REVERT-PROOF) ────────────────

await test("integration: idle wake reaches pi.sendMessage as triggerTurn:true", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  const pi = makeFakePi();
  registerWakeGate(pi);

  sendWake(pi);
  await flushDeferred();

  assert.equal(pi.sent.length, 1, "idle wake must reach pi.sendMessage");
  assert.equal(
    pi.sent[0].options.triggerTurn,
    true,
    "idle wake must stay triggerTurn:true (no suppression)",
  );
  assert.equal(pi.sent[0].options.deliverAs, undefined);
});

await test("integration: wake during before_agent_start (pre-flight tail) → live steer, NOT triggerTurn", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  const pi = makeFakePi();
  registerWakeGate(pi);

  // A session prompt() is mid-pre-flight: before_agent_start has fired, the
  // run has not started.
  pi._emit("before_agent_start");
  sendWake(pi);
  await flushDeferred();

  assert.equal(pi.sent.length, 1, "gated wake must still reach pi.sendMessage (never dropped)");
  const { options } = pi.sent[0];
  assert.equal(
    options.triggerTurn,
    undefined,
    "a triggerTurn wake in the run region must not re-enter the agent loop",
  );
  assert.equal(options.deliverAs, "steer", "gated wake is delivered as a live steer");
});

await test("integration: wake during compaction (session_before_compact) → live steer, NOT triggerTurn", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  const pi = makeFakePi();
  registerWakeGate(pi);

  // The compaction boundary: session_before_compact fired (compaction
  // summarization in progress, run not yet started).
  pi._emit("session_before_compact");
  sendWake(pi);
  await flushDeferred();

  assert.equal(pi.sent.length, 1);
  assert.equal(
    pi.sent[0].options.triggerTurn,
    undefined,
    "compaction-boundary wake must not start a competing run",
  );
  assert.equal(pi.sent[0].options.deliverAs, "steer");
});

await test("integration: after agent_start the next wake is triggerTurn again (gate released, no suppression)", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  const pi = makeFakePi();
  registerWakeGate(pi);

  pi._emit("before_agent_start");
  pi._emit("agent_start"); // run now live — native isStreaming queueing takes over

  sendWake(pi);
  await flushDeferred();

  assert.equal(pi.sent.length, 1);
  // Delivered triggerTurn — the gate released; pi-core itself queues when a
  // run is streaming, so we must not hold it busy past agent_start.
  assert.equal(pi.sent[0].options.triggerTurn, true);
});

await test("integration: post-compaction auto-resume wake (item 1) is NOT gated — session_compact releases", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  const pi = makeFakePi();
  registerWakeGate(pi);

  // Manual compaction: session_before_compact armed the gate, then
  // session_compact fires at the end of compaction. The auto-resume wake
  // (register-session-compact, triggerTurn:true) must pass through ungated
  // or the post-compaction loop stops.
  pi._emit("session_before_compact");
  pi._emit("session_compact");

  sendWake(pi);
  await flushDeferred();

  assert.equal(pi.sent.length, 1);
  assert.equal(
    pi.sent[0].options.triggerTurn,
    true,
    "auto-resume wake must stay triggerTurn after session_compact",
  );
});

await test("integration: session_shutdown resets the gate", async () => {
  resetWakeGateForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("before_agent_start");
  assert.equal(isRunRegionActive(), true);
  pi._emit("session_shutdown");
  assert.equal(isRunRegionActive(), false);
});

// ── input-event arming (prompt() entry → before_agent_start window) ──
// pi-core emits `input`to extension handlers at session.prompt() ENTRY
// (agent-session.js:836-845), before the pre-flight (auth/compaction) and
// before before_agent_start. Arming there closes the residual competing-run
// window for extension-originated sends. `streamingBehavior`is set exactly
// when the prompt is a steer/followUp into an ACTIVE run — no run will
// start, so no arm (arming there would leak the gate past the run's end).

await test("input event at prompt() entry (idle) arms the gate — pre-input window closed", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  const pi = makeFakePi();
  registerWakeGate(pi);

  pi._emit("input", { type: "input", text: "resume", source: "interactive" });
  assert.equal(isRunRegionActive(), true, "an idle prompt's input event must arm the run region");

  // A wake lands between prompt entry and before_agent_start.
  sendWake(pi);
  await flushDeferred();
  assert.equal(pi.sent.length, 1, "gated wake still reaches pi.sendMessage");
  assert.equal(
    pi.sent[0].options.triggerTurn,
    undefined,
    "wake in the input-armed window must not start a competing run",
  );
  assert.equal(pi.sent[0].options.deliverAs, "steer");
});

await test("steer delivery (streamingBehavior set) does NOT arm — no leak past the run", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  const pi = makeFakePi();
  registerWakeGate(pi);

  pi._emit("input", {
    type: "input",
    text: "queued",
    source: "interactive",
    streamingBehavior: "steer",
  });
  assert.equal(
    isRunRegionActive(),
    false,
    "a queued steer starts no run — arming would leak past the run's end",
  );

  sendWake(pi);
  await flushDeferred();
  assert.equal(
    pi.sent[0].options.triggerTurn,
    true,
    "idle wake stays triggerTurn (no spurious arm)",
  );
});

await test("agent_start releases the input-armed gate (normal run)", () => {
  resetWakeGateForTests();
  const pi = makeFakePi();
  registerWakeGate(pi);
  pi._emit("input", { type: "input", text: "hi", source: "interactive" });
  assert.equal(isRunRegionActive(), true);
  pi._emit("agent_start");
  assert.equal(isRunRegionActive(), false, "the run started — gate released as before");
});

await test("input arm uses the same fail-safe (pre-flight abort self-heals)", async () => {
  resetWakeGateForTests();
  clearAllBuckets();
  _setWakeGateFailSafeMsForTests(25);
  const pi = makeFakePi();
  registerWakeGate(pi);

  // prompt() entry arms via input, then the pre-flight ABORTS (auth error):
  // no before_agent_start, no agent_start — the stuck case.
  pi._emit("input", { type: "input", text: "hi", source: "interactive" });
  assert.equal(isRunRegionActive(), true);
  await sleep(60); // well past the 25ms fail-safe bound

  assert.equal(
    isRunRegionActive(),
    false,
    "input arms must fail-safe exactly like before_agent_start arms",
  );
  sendWake(pi);
  await flushDeferred();
  assert.equal(
    pi.sent[0].options.triggerTurn,
    true,
    "after the fail-safe heals, a wake starts a turn again",
  );
});

await test("before_agent_start re-arm still works after an input arm (same window)", async () => {
  resetWakeGateForTests();
  _setWakeGateFailSafeMsForTests(40);
  const pi = makeFakePi();
  registerWakeGate(pi);

  pi._emit("input", { type: "input", text: "hi", source: "interactive" }); // arm at t=0
  await sleep(30);
  pi._emit("before_agent_start"); // pre-flight tail: re-arm resets the window
  await sleep(30); // t=60 — past the ORIGINAL input-arm bound
  assert.equal(
    isRunRegionActive(),
    true,
    "before_agent_start re-arm extends the window (compaction still covered)",
  );
  pi._emit("agent_start");
  assert.equal(isRunRegionActive(), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
