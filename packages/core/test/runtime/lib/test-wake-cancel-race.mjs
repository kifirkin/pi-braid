/**
 * Regression: a CANCELLED timer's wake fire must not be delivered by the
 * deferred send the fire already queued — and must not be re-parked either.
 *
 * Failure mode: every wake send goes through sendTrackedMessage, which
 * defers the actual pi.sendMessage(...) to a macrotask (the V8-stack guard
 * documented in poller.ts). The timer's cancel guards (wakeRetryQueue
 * .isRetired at the ENTRY of fireTimer / redeliverWakeFire /
 * deliverParkedBusyFire) all run before that window, so a cancel landing
 * inside it had nothing left to stop the send: the wake went out as
 * triggerTurn: true for a timer its owner had already cancelled — a fresh
 * agent turn started by a withdrawn fire. The same window covered the other
 * branch: onBusy() re-parked the withdrawn fire (deferBusyWake arms a fresh
 * retry ladder, deferRecoveredFire re-adds a parked recovered fire),
 * resurrecting delivery state that retireTimer had just dropped.
 *
 * Fix: the seam (lib/utils/injection-tracker.ts, wakeDefer hook) takes an
 * optional withdrawal predicate; every wake-send hook in the timer extension
 * whose send can outlive a cancel supplies wakeRetryQueue.isRetired(id). The
 * predicate is asked FIRST: withdrawal is terminal and monotone, busyness is
 * a transient hold, and re-parking a withdrawn send would only be suppressed
 * again by a downstream guard (leaving phantom delivery state behind).
 *
 * REVERT-PROOF: on the pre-fix tree the hook has no withdrawal predicate and
 * the seam ignores one if supplied, so cases A1/A2/B/C deliver a cancelled
 * fire and every "no send" assertion fails. Cases A3/A4/A6 pin the unchanged
 * default (no predicate → the seam behaves exactly as before), so the fix
 * cannot be "suppress everything".
 *
 * Run: node test/runtime/lib/test-wake-cancel-race.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Pin braid's persistent tree into a private tmpdir: fixture timers must
// never write the live store (braidDir() honors BRAID_HOME per call).
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-timer-home-cancel-race-"));
process.env.BRAID_HOME = BRAID_HOME;

const { sendTrackedMessage, clearAllBuckets } =
  await import("../../../dist/lib/utils/injection-tracker.js");
const { _resetForTests: resetDedup } = await import("../../../dist/lib/enforcement/turn-dedup.js");
const { registerWakeGate, resetWakeGateForTests, isAgentBusy } =
  await import("../../../dist/lib/utils/wake-gate.js");
const { wakeRetryQueue, WAKE_OUTCOME_TIMEOUT_MS } =
  await import("../../../dist/extensions/scheduling/timer/wake-retry.js");
const timerMod = await import("../../../dist/extensions/scheduling/timer/index.js");
const { SESSION_START, SESSION_SHUTDOWN, AGENT_END, AGENT_SETTLED } =
  await import("../../../dist/lib/core/event-names.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); // packages/core

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

console.log("=== wake cancel race: a withdrawn fire is neither sent nor re-parked ===\n");

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeFakePi() {
  const sent = [];
  const handlers = new Map();
  return {
    sent,
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    sendMessage(params, options) {
      sent.push({ params, options });
    },
    sendUserMessage() {},
    /** Emit a captured pi event to the extension's registered handlers. */
    _emit(event, payload, ctx) {
      for (const h of handlers.get(event) ?? []) {
        Promise.resolve(h(payload ?? event, ctx)).catch(() => {});
      }
    },
  };
}

/** Live-reader ctx: isIdle/signal read the holder at CALL time, like
 *  pi-core's ExtensionContext (lazy getters over the runner's state). */
function makeCtx({ idle = true, sessionId = "cancel-race" } = {}) {
  const holder = { idle, signal: undefined };
  return {
    holder,
    isIdle: () => holder.idle,
    get signal() {
      return holder.signal;
    },
    sessionManager: { getSessionId: () => sessionId },
  };
}

/** Flush the setTimeout(0) deferral inside sendTrackedMessage. */
function flushDeferred() {
  return new Promise((r) => setTimeout(r, 30));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeTimer(id, sessionId = "cancel-race") {
  return {
    id,
    sessionId,
    firesAt: Date.now(),
    reason: "resume the task",
    createdAt: Date.now() - 1000,
    wake: true,
  };
}

/** The real send shape of a wake fire (identical for all four timer sites):
 *  triggerTurn, the high-priority source, flood-cap bypass. */
function sendWake(pi, wakeDefer) {
  sendTrackedMessage(
    pi,
    {
      customType: "timer-fire",
      content: [{ type: "text", text: "resume the task" }],
      display: true,
      details: { _braidInjected: true, _braidSource: "timer/fire", wake: true },
    },
    { triggerTurn: true },
    { type: "heartbeat", source: "timer/fire" },
    { bypassFloodCap: true },
    wakeDefer,
  );
}

function describeSent(pi) {
  return (
    `${pi.sent.length} pi.sendMessage call(s): ` +
    pi.sent
      .map(
        (s) =>
          `${s.params?.customType}(triggerTurn=${s.options?.triggerTurn === true}, text=${JSON.stringify(
            s.params?.content?.[0]?.text?.slice(0, 40),
          )})`,
      )
      .join("; ")
  );
}

/** Fresh, hermetic seam state: no captured wake-gate ctx (isAgentBusy()
 *  false → the busy branch cannot mask the withdrawal branch), no flood-cap
 *  buckets, no queue state. */
function resetAll() {
  resetWakeGateForTests();
  resetDedup();
  clearAllBuckets();
  wakeRetryQueue.resetForTests();
}

// ── A. The seam contract ────────────────────────────────────────────────────

await test("A1 withdrawn before the macrotask → no send, no re-park", async () => {
  resetAll();
  const pi = makeFakePi();
  const timer = makeTimer("t-a1");
  wakeRetryQueue.trackWake(timer); // fireTimer's own step, BEFORE its send
  let reParked = 0;
  sendWake(pi, {
    isWithdrawn: () => wakeRetryQueue.isRetired(timer.id),
    onBusy: () => {
      reParked++;
      wakeRetryQueue.deferBusyWake(timer, 0);
    },
  });
  // The cancel lands after the send was queued, before its macrotask runs.
  wakeRetryQueue.retireTimer(timer.id);
  await flushDeferred();

  assert.equal(pi.sent.length, 0, `cancelled fire was delivered — ${describeSent(pi)}`);
  assert.equal(reParked, 0, "a withdrawn fire must not be handed to onBusy (re-parked)");
  assert.equal(
    wakeRetryQueue.hasWakeFireState(timer.id),
    false,
    "no delivery state may remain for a retired id",
  );
  assert.equal(wakeRetryQueue.pendingRetryCount(), 0, "no retry ladder for a retired id");
});

await test("A2 a cancel delivered as a microtask (the production ordering) → no send", async () => {
  resetAll();
  const pi = makeFakePi();
  const timer = makeTimer("t-a2");
  wakeRetryQueue.trackWake(timer);
  sendWake(pi, {
    isWithdrawn: () => wakeRetryQueue.isRetired(timer.id),
    onBusy: () => wakeRetryQueue.deferBusyWake(timer, 0),
  });
  // Production shape: an awaited continuation (a tool call, a shutdown
  // handler) resumes in a MICROTASK, which drains after the scheduling
  // macrotask returns and before the send's own macrotask runs.
  queueMicrotask(() => wakeRetryQueue.retireTimer(timer.id));
  await flushDeferred();

  assert.equal(pi.sent.length, 0, `cancelled fire was delivered — ${describeSent(pi)}`);
});

await test("A3 no hook → the send is unchanged (byte-identical default)", async () => {
  resetAll();
  const pi = makeFakePi();
  sendWake(pi);
  await flushDeferred();
  assert.equal(pi.sent.length, 1, "a wake without a hook must send as before");
  assert.equal(pi.sent[0].options.triggerTurn, true, "still a turn-triggering wake");
});

await test("A4 hook without a withdrawal predicate + idle → send unchanged", async () => {
  resetAll();
  const pi = makeFakePi();
  let reParked = 0;
  sendWake(pi, { onBusy: () => reParked++ });
  await flushDeferred();
  assert.equal(pi.sent.length, 1, "an idle session must still deliver the wake");
  assert.equal(reParked, 0, "onBusy is for the busy branch only");
});

await test("A5 a LIVE fire (predicate false) is not over-suppressed", async () => {
  resetAll();
  const pi = makeFakePi();
  const timer = makeTimer("t-a5");
  wakeRetryQueue.trackWake(timer);
  sendWake(pi, { isWithdrawn: () => wakeRetryQueue.isRetired(timer.id), onBusy: () => {} });
  await flushDeferred();
  assert.equal(pi.sent.length, 1, "the predicate must only withdraw id it actually retired");
});

await test("A6 busy + no predicate → onBusy re-parks exactly as before", async () => {
  resetAll();
  const pi = makeFakePi();
  const timer = makeTimer("t-a6");
  wakeRetryQueue.trackWake(timer);
  registerWakeGate(pi);
  pi._emit(SESSION_START, {}, makeCtx({ idle: false }));
  assert.equal(isAgentBusy(), true, "precondition: the session reads as busy");
  let reParked = 0;
  sendWake(pi, {
    onBusy: () => {
      reParked++;
      wakeRetryQueue.deferBusyWake(timer, 0);
    },
  });
  await flushDeferred();
  assert.equal(pi.sent.length, 0, "a busy session must not start a competing run");
  assert.equal(reParked, 1, "the busy branch still owns redelivery");
  assert.equal(wakeRetryQueue.pendingRetryCount(), 1, "the live fire is parked for redelivery");
});

await test("A7 busy AND withdrawn → withdrawal wins (no send, no re-park)", async () => {
  resetAll();
  const pi = makeFakePi();
  const timer = makeTimer("t-a7");
  wakeRetryQueue.trackWake(timer);
  registerWakeGate(pi);
  pi._emit(SESSION_START, {}, makeCtx({ idle: false }));
  let reParked = 0;
  sendWake(pi, {
    isWithdrawn: () => wakeRetryQueue.isRetired(timer.id),
    onBusy: () => {
      reParked++;
      wakeRetryQueue.deferBusyWake(timer, 0);
    },
  });
  wakeRetryQueue.retireTimer(timer.id); // the cancel, inside the window
  await flushDeferred();
  assert.equal(pi.sent.length, 0, `withdrawn fire delivered — ${describeSent(pi)}`);
  assert.equal(reParked, 0, "a retired id must not be re-parked into the ladder");
  assert.equal(wakeRetryQueue.pendingRetryCount(), 0, "no ladder may be armed for a retired id");
});

// ── B. The real fire path (extension → poller → fireTimer → seam) ───────────

/**
 * Drive one real fire of a real timer and time the cancel to the fire's own
 * macrotask — the window between fireTimer's entry guard and the deferred
 * send. wakeRetryQueue.trackWake is the fire path's last step before the
 * send and the only public seam the fire exposes, so the spy is where a
 * cancel delivered by the event loop (a microtask or a queued task) lands.
 * attempt 0 → the primary fire path; attempt >= 1 → the redelivery path.
 */
async function realFireRace({ id, keyOnAttemptAtLeast, expectFires }) {
  resetAll();
  const pi = makeFakePi();
  const sid = `cancel-race-${id}`;
  const ctx = makeCtx({ idle: true, sessionId: sid });
  timerMod.default(pi);
  pi._emit(SESSION_START, {}, ctx);
  assert.equal(isAgentBusy(), false, "precondition: an idle session (the send's busy branch is off)");

  let targetId = null;
  let cancelsSeen = 0;
  const origTrack = wakeRetryQueue.trackWake.bind(wakeRetryQueue);
  wakeRetryQueue.trackWake = (t, attempt = 0, options) => {
    origTrack(t, attempt, options);
    if (t.id === targetId && attempt >= keyOnAttemptAtLeast && cancelsSeen === 0) {
      cancelsSeen++;
      timerMod.cancelTimer(sid, t.id); // the real cancel path, inside the fire's macrotask
    }
  };

  try {
    targetId = timerMod.scheduleTimer(sid, 1000, "race the cancel", undefined, true);
    if (expectFires) {
      // Failure leg: let the first fire land, then fail its run and settle, so
      // the queue arms the redelivery this case races against.
      const early = Date.now();
      while (pi.sent.length === 0 && Date.now() - early < 5000) await sleep(50);
      assert.equal(pi.sent.length, 1, "precondition: the first wake fire was delivered");
      pi._emit(AGENT_END, {
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "401 unauthorized" }],
      });
      pi._emit(AGENT_SETTLED, {});
      assert.equal(wakeRetryQueue.pendingRetryCount(), 1, "precondition: redelivery armed");
      // Make the armed rung due; the next poll tick (<= 1s) hands it to
      // redeliverWakeFire, whose send the spy cancels inside its macrotask.
      wakeRetryQueue._setClockForTests(() => Date.now() + WAKE_OUTCOME_TIMEOUT_MS);
    }
    const start = Date.now();
    while (cancelsSeen === 0 && Date.now() - start < 6000) await sleep(50);
    await flushDeferred();
    assert.equal(cancelsSeen, 1, "the race must actually have been exercised (anti-vacuity)");
    const delivered = expectFires ? pi.sent.length - 1 : pi.sent.length;
    assert.equal(delivered, 0, `the cancelled fire was delivered — ${describeSent(pi)}`);
  } finally {
    wakeRetryQueue.trackWake = origTrack;
    wakeRetryQueue._setClockForTests(null);
    pi._emit(SESSION_SHUTDOWN, {}, ctx);
    timerMod.clearSessionTimers(sid);
    resetAll();
  }
}

await test("B real fireTimer path: cancel inside the deferred send → no wake delivered", async () => {
  await realFireRace({ id: "b", keyOnAttemptAtLeast: 0, expectFires: false });
});

await test("C real redeliverWakeFire path: cancel inside the deferred retry send → no wake", async () => {
  await realFireRace({ id: "c", keyOnAttemptAtLeast: 1, expectFires: true });
});

// ── D. Structural guard: every wake-send hook carries the predicate ─────────

await test("D every wake-send hook in the timer extension carries the predicate", () => {
  // Scoped to the scheduling extension's own send sites: the same race shape
  // also exists on the recovered-fire flush (wake-retry.ts flushRecoveredFires,
  // where deferRecoveredFire would re-park a retired id), which is outside this
  // change's locks. That one gap is asserted as a COUNT so it stays explicit
  // and cannot silently grow: when that site gets its predicate, this guard
  // reports the count change and the fixing change updates it.
  const timerDir = join(ROOT, "src/extensions/scheduling/timer");
  const hooksIn = (f) => readFileSync(join(timerDir, f), "utf8").match(/\bonBusy:/g)?.length ?? 0;
  const predicatesIn = (f) =>
    readFileSync(join(timerDir, f), "utf8").match(/\bisWithdrawn:/g)?.length ?? 0;

  const hooks = hooksIn("index.ts");
  const predicated = predicatesIn("index.ts");
  assert.equal(
    predicated,
    hooks,
    `index.ts: ${hooks} onBusy hook(s) but ${predicated} isWithdrawn predicate(s) — every wake-send ` +
      `hook whose send can outlive a cancel needs the withdrawal predicate`,
  );
  assert.ok(hooks >= 3, `expected the known wake-send hooks in index.ts, found ${hooks}`);

  const gap = hooksIn("wake-retry.ts") - predicatesIn("wake-retry.ts");
  assert.equal(gap, 1, `the known un-predicated wake hook count changed (now ${gap}) — update this guard`);
});

console.log(`\n${passed} passed, ${failed} failed`);
try {
  rmSync(BRAID_HOME, { recursive: true, force: true });
} catch {
  /* best-effort */
}
process.exit(failed > 0 ? 1 : 0);
