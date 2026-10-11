/**
 * fix 2 + fix 3 + fix 4 (part B): failed-wake retry, recovered-fire
 * deferral, and retry-drain liveness.
 *
 * Fix 2 (failed-wake retry): a wake fire whose turn FAILS (provider 401/413/
 * 5xx -> assistant stopReason "error") used to be lost — the injected
 * CustomMessage sat in history until an unrelated turn processed it. Post-fix
 * the fire is tracked as outstanding; a failed run (agent_end) + settle
 * (agent_settled) schedules a bounded backoff retry (5s/15s/45s/2m/5m,
 * capped — default 3 redeliveries, braid.timers.maxWakeAttempts); the retry
 * is drained on the next poll tick or TOOL_EXECUTION_END/TURN_END. A wake
 * that never gets an outcome (pre-flight abort emits NO event) times out
 * after 240s (was 60s) and retries anyway — never silently lost.
 *
 * Fix 3 (recovery deferral): recoverPersistedTimers used to deliver expired
 * persisted fires INLINE in before_agent_start (competing-turn bug — a turn
 * is already starting). Post-fix the delivery is deferred to post-settle
 * (agent_settled path) where a wake:true fire safely starts its own turn and
 * feeds the failed-wake retry queue.
 *
 * Fix 4 part B (drain liveness): the retry queue is drained by the SAME
 * ticks that fire expired timers (poll tick / fireExpired) — no user turn
 * needed.
 *
 * (success-clear): a redelivered wake fire whose turn SUCCEEDS must
 * clear the pending retry chain. Pre-, the outcome-timeout path armed a
 * retry while a merely-LONG (>60s) wake turn was still running; the later
 * successful settle resolved an empty outstanding map and the armed retry
 * kept firing — burning the 5-cap on duplicates (observed live
 * 19:08-19:54, 5/5 retries on a turn collision). Post-fix the first
 * successful wake turn cancels armed retries for its timer id; genuinely
 * failed fires still retry to the cap.
 *
 * (retryable-failure hold + cap): pi-core auto-retries retryable
 * provider failures (transport/timeout/5xx) inside the SAME run, and those
 * auto_retry events are NOT surfaceable to extensions. A retryable
 * agent_end therefore starts a bounded hold window (pi-core's retry budget:
 * baseDelayMs*2^maxRetries, settings-derived) during which the outcome
 * timeout must NOT arm — only the settle (post-retry by definition) is the
 * arming authority. Also: timeout 240s, cap default 3, and the cap is
 * settings-tunable with test overrides.
 *
 * Run: node test/runtime/lib/test-timer-wake-retry.mjs
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const timerMod = await import("../../../dist/extensions/scheduling/timer/index.js");
const {
  wakeRetryQueue,
  flushRecoveredFires,
  WAKE_OUTCOME_TIMEOUT_MS,
  WAKE_RETRY_MAX_ATTEMPTS,
  WAKE_RETRY_BACKOFF_MS,
} = await import("../../../dist/extensions/scheduling/timer/wake-retry.js");
const pb = await import("../../../dist/extensions/core/prompt-builder/index.js");
const { getTimerFilePath } = await import("../../../dist/lib/config/braid-paths.js");
const { isRetryableWakeError } =
  await import("../../../dist/extensions/scheduling/timer/wake-retry.js");
const {
  resolveMaxWakeAttempts,
  resolveWakeRetryHoldMs,
  MAX_WAKE_ATTEMPTS_DEFAULT,
  WAKE_RETRY_HOLD_MAX_MS,
} = await import("../../../dist/lib/config/braid-settings.js");

const { WakeRetryQueue } = await import("../../../dist/extensions/scheduling/timer/wake-retry.js");
const { getLogBuffer, clearLogBuffer } = await import("../../../dist/lib/core/logger.js");
const { registerWakeGate, resetWakeGateForTests } =
  await import("../../../dist/lib/utils/wake-gate.js");

const originalCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "braid-timer-wake-retry-"));
// Pin braid's persistent tree into a private tmpdir: fixture timers must
// never write the live store (braidDir() honors BRAID_HOME per call).
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-timer-home-wake-retry-"));
process.env.BRAID_HOME = BRAID_HOME;

afterEach(() => {
  wakeRetryQueue.resetForTests();
  wakeRetryQueue._setClockForTests(null);
  resetWakeGateForTests();
});

process.on("exit", () => {
  process.chdir(originalCwd);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeFakePi() {
  const handlers = {};
  const sent = [];
  let failCount = 0;
  return {
    sent,
    handlers,
    failNextSend(n = 1) {
      failCount = n;
    },
    registerTool() {},
    on(name, fn) {
      (handlers[name] ??= []).push(fn);
    },
    emit(name, event = {}, ctx = {}) {
      for (const fn of handlers[name] ?? []) fn(event, ctx);
    },
    sendMessage(params, options) {
      if (failCount > 0) {
        failCount--;
        throw new Error("simulated send failure");
      }
      sent.push({ params, options });
    },
  };
}

function flushDeferred() {
  // Two macrotask hops: the fire path defers TWICE (fireExpired's
  // setTimeout(0) → onFire → sendTrackedMessage's own setTimeout(0) for
  // triggerTurn:true) — one tick only unwinds the first hop.
  return new Promise((resolve) => setTimeout(() => setTimeout(resolve, 0), 0));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeTimer(id, reason = "wake me") {
  return {
    id,
    sessionId: "w114r",
    firesAt: Date.now(),
    reason,
    createdAt: Date.now() - 1000,
    wake: true,
  };
}

// ── Fix 2: WakeRetryQueue unit behavior ──────────────────────────────────────

describe("fix 2: WakeRetryQueue (failed wake fires retry with bounded backoff)", () => {
  it("failed turn -> retry scheduled at backoff[0], drained when due, then cleared", () => {
    const q = new WakeRetryQueue();
    let now = 1_000_000;
    q._setClockForTests(() => now);

    q.trackWake(makeTimer("t1"));
    assert.equal(q.outstandingCount(), 1);

    q.onAgentEnd(true); // provider 401
    q.onAgentSettled();
    assert.equal(q.outstandingCount(), 0, "outstanding wake resolved at settle");
    assert.equal(q.pendingRetryCount(), 1, "undelivered wake scheduled for retry");

    assert.deepEqual(
      q.drainDue().map((r) => r.timer.id),
      [],
      "backoff not elapsed yet",
    );
    now += 5_000;
    const due = q.drainDue();
    assert.deepEqual(
      due.map((r) => ({ id: r.timer.id, attempt: r.attempt })),
      [{ id: "t1", attempt: 1 }],
      "retry due after backoff[0]=5s",
    );
    assert.equal(q.pendingRetryCount(), 0, "drained entry removed (redelivery owns it now)");
  });

  it("successful turn resolves the outstanding wake (no retry)", () => {
    const q = new WakeRetryQueue();
    q.trackWake(makeTimer("t2"));
    q.onAgentEnd(false);
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 0);
    assert.equal(q.getStats().succeeded, 1);
  });

  it("aborted turn is NOT a failure (deliberate stop, content already in history)", () => {
    const q = new WakeRetryQueue();
    q.trackWake(makeTimer("t3"));
    q.onAgentEnd(false); // stopReason "aborted" is not "error"
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 0);
  });

  it("redelivered wake that fails again backs off longer (attempt chain)", () => {
    const q = new WakeRetryQueue();
    let now = 1_000;
    q._setClockForTests(() => now);
    q.trackWake(makeTimer("t4"));

    // failure #1 -> retry attempt 1 after 5s
    q.onAgentEnd(true);
    q.onAgentSettled();
    now += 5_000;
    const first = q.drainDue();
    assert.deepEqual(
      first.map((r) => r.attempt),
      [1],
    );

    // redelivery tracked at attempt 1; fails again -> attempt 2 after 15s
    q.trackWake(first[0].timer, 1);
    q.onAgentEnd(true);
    q.onAgentSettled();
    now += 5_000;
    assert.deepEqual(q.drainDue(), [], "attempt-2 backoff is 15s, not 5s");
    now += 10_000;
    const second = q.drainDue();
    assert.deepEqual(
      second.map((r) => r.attempt),
      [2],
      "second failure escalates the backoff tier",
    );
  });

  it("wake with no outcome (pre-flight abort) times out and retries anyway", () => {
    const q = new WakeRetryQueue();
    let now = 2_000_000;
    q._setClockForTests(() => now);
    q.trackWake(makeTimer("t5"));

    now += WAKE_OUTCOME_TIMEOUT_MS - 1;
    assert.deepEqual(q.drainDue(), [], "inside the outcome window: nothing to do");

    now += 1; // deadline passes — no agent_end/agent_settled ever arrived
    assert.deepEqual(
      q.drainDue().length,
      0,
      "timeout schedules a retry, not an immediate redelivery",
    );
    assert.equal(q.pendingRetryCount(), 1, "timed-out wake re-armed for retry");
    now += 5_000;
    const due = q.drainDue();
    assert.equal(due.length, 1, "retry delivers after its backoff");
    assert.equal(due[0].attempt, 1);
  });

  it("retries are bounded: after MAX redeliveries the fire is marked exhausted", () => {
    const q = new WakeRetryQueue();
    q._setMaxAttemptsForTests(WAKE_RETRY_MAX_ATTEMPTS); // pin the cap (setting could differ)
    let now = 3_000_000;
    q._setClockForTests(() => now);
    q.trackWake(makeTimer("t6"));

    for (let attempt = 1; attempt <= WAKE_RETRY_MAX_ATTEMPTS; attempt++) {
      q.onAgentEnd(true);
      q.onAgentSettled(); // schedule attempt N
      now += WAKE_RETRY_BACKOFF_MS[attempt - 1]; // advance past attempt N's backoff
      const due = q.drainDue();
      assert.equal(due.length, 1, `redelivery ${attempt} due`);
      assert.equal(due[0].attempt, attempt);
      q.trackWake(due[0].timer, due[0].attempt); // redelivery re-tracks
    }

    // The (MAX+1)-th failure exhausts the bound.
    q.onAgentEnd(true);
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 0, "no retry scheduled past the bound");
    assert.equal(q.getStats().exhausted, 1, "exhaustion counted");
    assert.equal(q.takeExhausted().length, 1, "exhausted fire surfaced for a final notice");
    assert.equal(q.takeExhausted().length, 0, "exhausted drain is one-shot");
  });

  it("deferred recovered fires: defer -> take drains once; flush-failure re-defers", () => {
    const q = new WakeRetryQueue();
    q.deferRecoveredFire({ id: "r1", sessionId: "s", reason: "recovered", wake: true });
    q.deferRecoveredFire({ id: "r2", sessionId: "s", reason: "silent one", wake: false });
    assert.equal(q.deferredRecoveredCount(), 2);
    const taken = q.takeRecoveredFires();
    assert.deepEqual(
      taken.map((t) => t.id),
      ["r1", "r2"],
    );
    assert.equal(q.deferredRecoveredCount(), 0);
    q.deferRecoveredFire(taken[0]);
    assert.equal(q.deferredRecoveredCount(), 1, "re-deferral on send failure");
  });
});

// ── a successful wake turn clears the pending retry chain ──────────────

describe("successful wake turn clears the pending retry chain", () => {
  it("REVERT-PROOF: redelivered wake whose turn succeeds cancels the armed retry", () => {
    const q = new WakeRetryQueue();
    let now = 4_000_000;
    q._setClockForTests(() => now);

    // Original fire fails -> retry attempt 1 armed.
    q.trackWake(makeTimer("w119-a"));
    q.onAgentEnd(true);
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 1);

    // Retry pops and is redelivered (tracked at attempt 1).
    now += WAKE_RETRY_BACKOFF_MS[0];
    const due = q.drainDue();
    assert.equal(due.length, 1);
    q.trackWake(due[0].timer, due[0].attempt);

    // The redelivered turn runs LONG (>60s): the outcome window elapses with
    // no settle, so drainDue arms retry attempt 2 while the turn is running.
    now += WAKE_OUTCOME_TIMEOUT_MS;
    q.drainDue();
    assert.equal(
      q.pendingRetryCount(),
      1,
      "retry armed by the outcome timeout during the long turn",
    );

    // The redelivered turn settles SUCCESSFULLY -> the retry chain must clear.
    q.onAgentEnd(false);
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 0, "first successful wake turn clears pending retries");

    // No further redelivery attempt is ever scheduled for the fire.
    now += 10 * 60_000;
    assert.deepEqual(q.drainDue(), [], "retry chain cleared on first success");
  });

  it("original wake whose long turn succeeds also clears the false-timeout retry", () => {
    const q = new WakeRetryQueue();
    let now = 5_000_000;
    q._setClockForTests(() => now);

    q.trackWake(makeTimer("w119-b"));
    now += WAKE_OUTCOME_TIMEOUT_MS;
    q.drainDue(); // outcome timeout during the long turn -> retry armed
    assert.equal(q.pendingRetryCount(), 1);
    assert.equal(q.outstandingCount(), 1, "entry kept (marked) so the settle can still resolve it");

    q.onAgentEnd(false);
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 0, "success clears the armed retry");
    assert.equal(q.getStats().succeeded, 1);
  });

  it("genuinely failed fire still retries to the cap (chain not over-cleared)", () => {
    const q = new WakeRetryQueue();
    q._setMaxAttemptsForTests(WAKE_RETRY_MAX_ATTEMPTS); // pin the cap (setting could differ)
    let now = 6_000_000;
    q._setClockForTests(() => now);

    q.trackWake(makeTimer("w119-c"));
    for (let attempt = 1; attempt <= WAKE_RETRY_MAX_ATTEMPTS; attempt++) {
      q.onAgentEnd(true);
      q.onAgentSettled();
      assert.equal(
        q.pendingRetryCount(),
        1,
        `attempt ${attempt} armed exactly once (no double-arm)`,
      );
      now += WAKE_RETRY_BACKOFF_MS[attempt - 1];
      const drained = q.drainDue();
      assert.equal(drained.length, 1);
      assert.equal(drained[0].attempt, attempt);
      q.trackWake(drained[0].timer, drained[0].attempt);
    }
    q.onAgentEnd(true);
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 0);
    assert.equal(q.getStats().exhausted, 1, "bound still exhausts at the cap");
  });

  it("timeout during a long FAILED turn re-arms once (no double redelivery)", () => {
    const q = new WakeRetryQueue();
    let now = 7_000_000;
    q._setClockForTests(() => now);

    q.trackWake(makeTimer("w119-d"));
    now += WAKE_OUTCOME_TIMEOUT_MS;
    q.drainDue(); // timeout arms retry 1, entry kept + marked
    q.onAgentEnd(true);
    q.onAgentSettled(); // genuine failure escalates the SAME entry
    assert.equal(q.pendingRetryCount(), 1, "settle failure replaces, never stacks");
    now += WAKE_RETRY_BACKOFF_MS[0];
    const due = q.drainDue();
    assert.deepEqual(
      due.map((r) => r.attempt),
      [1],
    );
  });
});

// ── long-turn timeout + retryable-failure hold ──────────────────

describe("outcome timeout 240s covers long legitimate wake turns", () => {
  it("REVERT-PROOF: wake turn still running at 180s -> NO retry armed", () => {
    const q = new WakeRetryQueue();
    let now = 7_500_000;
    q._setClockForTests(() => now);
    q.trackWake(makeTimer("w137-long"));

    // 180s in (a legitimate babysit wake turn), poll ticks keep running.
    now += 180_000;
    q.drainDue();
    assert.equal(
      q.pendingRetryCount(),
      0,
      "a 180s successful wake turn must not arm a redelivery (the old 60s timeout did)",
    );

    // The turn settles successfully — nothing was ever armed.
    q.onAgentEnd(false);
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 0);
    now += 10 * 60_000;
    assert.deepEqual(q.drainDue(), [], "no spurious redelivery ever fires");
  });

  it("a genuinely hung run still times out (240s window, bounded)", () => {
    const q = new WakeRetryQueue();
    let now = 7_600_000;
    q._setClockForTests(() => now);
    q.trackWake(makeTimer("w137-hang"));
    now += WAKE_OUTCOME_TIMEOUT_MS - 1;
    assert.deepEqual(q.drainDue(), [], "inside the (new) outcome window");
    now += 1;
    q.drainDue();
    assert.equal(q.pendingRetryCount(), 1, "hangs still re-arm after 240s");
  });
});

describe("retryable-failure hold defers redelivery during pi-core auto-retry", () => {
  it("REVERT-PROOF: retryable failure mid-retry-cycle does NOT arm a redelivery", () => {
    const q = new WakeRetryQueue();
    let now = 8_000_000;
    q._setClockForTests(() => now);
    q._setRetryHoldForTests(60_000);

    q.trackWake(makeTimer("w137-hold"));
    // pi-core's retry cycle: attempt 1 fails retryable at t+50s...
    now += 50_000;
    q.onAgentEnd(true, "Connection error: socket hang up");
    // ...poll tick at t+70s: pre- this armed the outcome timeout (70s >
    // 60s) and the redelivery fired 5s later, mid-cycle — the flood source.
    now += 20_000;
    assert.deepEqual(q.drainDue(), [], "hold active: outcome timeout must not arm");
    assert.equal(q.pendingRetryCount(), 0, "no mid-cycle redelivery armed");

    // pi-core's retry SUCCEEDS: the run's final agent_end + settle.
    q.onAgentEnd(false);
    q.onAgentSettled();
    assert.equal(q.getStats().succeeded, 1, "run recovered by pi-core's retry");
    now += 10 * 60_000;
    assert.deepEqual(q.drainDue(), [], "no redelivery was ever armed");
  });

  it("hold expiry re-enables the outcome timeout (bounded re-check)", () => {
    const q = new WakeRetryQueue();
    let now = 9_000_000;
    q._setClockForTests(() => now);
    q._setRetryHoldForTests(400_000); // hold LONGER than the 240s outcome window

    q.trackWake(makeTimer("w137-expiry"));
    now += 50_000;
    q.onAgentEnd(true, "upstream request timeout"); // hold until t+450s
    now += 250_000; // t+300s: outcome timeout elapsed BUT hold still active
    q.drainDue();
    assert.equal(q.pendingRetryCount(), 0, "hold outranks the outcome timeout");
    now += 150_000; // t+450s: hold expired, no settle ever came (hung run)
    q.drainDue();
    assert.equal(q.pendingRetryCount(), 1, "arms after the hold expires (bounded)");
    now += 5_000;
    assert.equal(q.drainDue().length, 1, "retry delivers after its backoff");
  });

  it("retryable failures REFRESH the hold on every attempt (long multi-retry cycles stay covered)", () => {
    const q = new WakeRetryQueue();
    let now = 12_000_000;
    q._setClockForTests(() => now);
    q._setRetryHoldForTests(100_000); // per-attempt hold; refresh extends it
    q.trackWake(makeTimer("w137-refresh"));

    now += 200_000;
    q.onAgentEnd(true, "connection error: other side closed"); // hold until +300s
    now += 40_000; // t+240s: outcome window elapsed, hold active -> suppressed
    q.drainDue();
    assert.equal(q.pendingRetryCount(), 0, "hold suppresses past the 240s outcome deadline");
    now += 10_000; // t+250s: pi-core's NEXT retry attempt also fails
    q.onAgentEnd(true, "connection error: other side closed"); // refreshed: +350s
    now += 50_000; // t+300s: the FIRST hold would have expired here
    q.drainDue();
    assert.equal(
      q.pendingRetryCount(),
      0,
      "refreshed hold still suppresses (multi-attempt cycles covered)",
    );
    now += 50_000; // t+350s: last hold expired, no settle ever came (hung run)
    q.drainDue();
    assert.equal(q.pendingRetryCount(), 1, "arms after the LAST hold expires (bounded)");
  });

  it("settle-failure after pi-core retries exhaust arms exactly ONE ladder (hold never suppresses settle)", () => {
    const q = new WakeRetryQueue();
    let now = 11_000_000;
    q._setClockForTests(() => now);
    q._setRetryHoldForTests(60_000);
    q.trackWake(makeTimer("w137-ladder"));

    now += 50_000;
    q.onAgentEnd(true, "connection error: getaddrinfo ENOTFOUND"); // pi-core attempt 1
    now += 6_000; // t+56s: retries exhausted -> settle with final failure
    q.onAgentEnd(true, "connection error: getaddrinfo ENOTFOUND");
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 1, "exactly one retry armed at the settle");

    now += 20_000; // t+76s: the ladder's backoff[0] elapsed at t+61s
    const due = q.drainDue();
    assert.deepEqual(
      due.map((r) => r.attempt),
      [1],
      "exactly ONE ladder, delivered once",
    );
    assert.equal(q.pendingRetryCount(), 0, "drained once — no double-arm residue");
  });

  it("non-retryable failure (auth/quota) arms at settle immediately (no hold)", () => {
    const q = new WakeRetryQueue();
    let now = 10_000_000;
    q._setClockForTests(() => now);
    q.trackWake(makeTimer("w137-auth"));
    q.onAgentEnd(true, "HTTP 401 Unauthorized");
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 1, "non-retryable failures arm at settle");
  });

  it("settle clears an active hold (stale hold never suppresses the NEXT wake)", () => {
    const q = new WakeRetryQueue();
    let now = 13_000_000;
    q._setClockForTests(() => now);
    q._setRetryHoldForTests(600_000);
    q.trackWake(makeTimer("w137-clear-a"));
    q.onAgentEnd(true, "request timeout"); // hold armed
    q.onAgentEnd(false);
    q.onAgentSettled(); // cycle resolved successfully — hold must die with it

    q.trackWake(makeTimer("w137-clear-b"));
    now += WAKE_OUTCOME_TIMEOUT_MS;
    q.drainDue();
    assert.equal(q.pendingRetryCount(), 1, "no stale hold: the fresh wake times out normally");
  });

  it("retryable classification mirrors pi-core's classes (hold scope)", () => {
    // retryable (hold): transport, premature stream end, timeout, 5xx, 429
    assert.equal(isRetryableWakeError("Connection error: other side closed"), true);
    assert.equal(isRetryableWakeError("stream ended without a terminal event"), true);
    assert.equal(isRetryableWakeError("request timed out after 30000ms"), true);
    assert.equal(isRetryableWakeError("HTTP 503 Service Unavailable"), true);
    assert.equal(isRetryableWakeError("terminated"), true);
    assert.equal(isRetryableWakeError("overloaded_error"), true);
    // non-retryable (never hold): auth, quota/billing, context overflow-ish
    assert.equal(isRetryableWakeError("HTTP 401 Unauthorized"), false);
    assert.equal(isRetryableWakeError("HTTP 413 Payload Too Large"), false);
    assert.equal(isRetryableWakeError("insufficient_quota: monthly limit"), false);
    assert.equal(isRetryableWakeError(undefined), false);
    assert.equal(isRetryableWakeError(""), false);
  });

  it("override cap 2 exhausts after 2 redeliveries (setting plumbing)", () => {
    const q = new WakeRetryQueue();
    let now = 14_000_000;
    q._setClockForTests(() => now);
    q._setMaxAttemptsForTests(2);
    q.trackWake(makeTimer("w137-cap"));
    for (let attempt = 1; attempt <= 2; attempt++) {
      q.onAgentEnd(true); // no errorMessage: non-retryable, no hold
      q.onAgentSettled();
      now += WAKE_RETRY_BACKOFF_MS[attempt - 1];
      const due = q.drainDue();
      assert.equal(due.length, 1, `redelivery ${attempt} due under the override cap`);
      q.trackWake(due[0].timer, due[0].attempt);
    }
    q.onAgentEnd(true);
    q.onAgentSettled();
    assert.equal(q.getStats().exhausted, 1, "exhausts at the override cap (2)");
    assert.equal(q.takeExhausted().length, 1);
  });

  it("default cap is 3 and matches the settings default", () => {
    assert.equal(WAKE_RETRY_MAX_ATTEMPTS, 3);
    assert.equal(MAX_WAKE_ATTEMPTS_DEFAULT, 3);
  });
});

// ── honest attribution + cancel retirement + long-run grace ───────────────

describe("honest attribution: a timeout-armed retry never claims a failed turn", () => {
  it("REGRESSION: the outcome-window timeout arms cause 'timeout', not 'failed', for a non-busy wake", () => {
    const q = new WakeRetryQueue();
    let now = 20_000_000;
    q._setClockForTests(() => now);
    q.trackWake(makeTimer("attr-a"));

    now += WAKE_OUTCOME_TIMEOUT_MS;
    q.drainDue(); // window elapsed, no turn outcome ever arrived (pre-flight abort shape)
    assert.equal(q.pendingRetryCount(), 1, "timeout armed a retry");

    now += WAKE_RETRY_BACKOFF_MS[0];
    const due = q.drainDue();
    assert.equal(due.length, 1);
    assert.equal(
      due[0].cause,
      "timeout",
      "no turn ever failed — the armed retry must carry the timeout cause",
    );
    assert.notEqual(due[0].cause, "failed", "'failed' is reserved for genuine settle failures");
  });

  it("a busy-deferred wake's armed retry keeps cause 'busy' and drains at its own backoff", () => {
    const q = new WakeRetryQueue();
    let now = 21_000_000;
    q._setClockForTests(() => now);
    q.trackWake(makeTimer("attr-b"));
    q.deferBusyWake(makeTimer("attr-b"), 0);
    assert.equal(q.pendingRetryCount(), 1);

    now += WAKE_RETRY_BACKOFF_MS[0];
    assert.deepEqual(
      q.drainDue().map((r) => r.cause),
      ["busy"],
      "the send was held, not failed",
    );
    // The busy-deferred entry's ladder is armed; the outcome window must not
    // re-arm (and re-delay) it on later ticks.
    now += WAKE_OUTCOME_TIMEOUT_MS;
    assert.deepEqual(q.drainDue(), [], "no outcome-window re-arm for a busy-deferred entry");
  });
});

// ── busy-held fire: park, then one late delivery (never a silent drop) ───────

describe("busy-held wake: the ladder spends, the fire is parked, then delivered late", () => {
  it("REGRESSION: busy ladder exhaustion parks the fire; the next idle drain hands it off once; nothing is dropped", () => {
    const q = new WakeRetryQueue();
    let now = 50_000_000;
    q._setClockForTests(() => now);
    q._setMaxAttemptsForTests(1); // one busy rung, then the ladder is spent
    let busy = true;
    q.setActiveRunCheck(() => busy);

    // The send is held (session busy): the one busy rung is armed, not dropped.
    q.trackWake(makeTimer("park-a"));
    q.deferBusyWake(makeTimer("park-a"), 0);
    assert.equal(q.pendingRetryCount(), 1, "the busy rung is armed");
    assert.equal(q.takeExhausted().length, 0);
    assert.equal(q.getStats().exhausted, 0);

    // The rung redelivers into a still-busy session -> ladder spent -> PARK.
    now += WAKE_RETRY_BACKOFF_MS[0];
    const due = q.drainDue();
    assert.deepEqual(due.map((r) => r.cause), ["busy"], "the armed rung carries the busy cause");
    q.trackWake(due[0].timer, due[0].attempt); // redelivery re-tracks
    q.deferBusyWake(makeTimer("park-a"), 1); // attempt 2 > cap 1

    assert.equal(q.pendingRetryCount(), 0, "no rung past the bound");
    assert.equal(q.takeExhausted().length, 0, "a busy-held fire is never dropped");
    assert.equal(q.getStats().exhausted, 0, "the exhaustion counter stays clean");
    assert.equal(q.getStats().heldBusy, 1, "the park is counted as held, not dropped");
    assert.equal(q.outstandingCount(), 1, "the fire is parked, not resolved");

    // A still-busy session holds the park (a mid-run send would be re-parked).
    assert.deepEqual(q.drainParkedBusy(), [], "a busy session holds the parked fire");
    assert.equal(q.outstandingCount(), 1);

    // An unrelated run settles while the fire is parked: neither delivered nor
    // cleared — the park outlives a settle that did not run the wake.
    q.onAgentEnd(false);
    q.onAgentSettled();
    assert.equal(q.getStats().succeeded, 0, "an unrelated settle is not a delivery");
    assert.equal(q.outstandingCount(), 1, "the parked fire survives the settle");

    // Idle now: exactly one late delivery, carrying the whole hold span.
    busy = false;
    const parked = q.drainParkedBusy();
    assert.equal(parked.length, 1, "the held fire is delivered late");
    assert.equal(parked[0].timer.id, "park-a");
    assert.equal(parked[0].heldMs, WAKE_RETRY_BACKOFF_MS[0], "the whole hold span is reported");
    assert.deepEqual(q.drainParkedBusy(), [], "handed off exactly once");
    assert.equal(q.takeExhausted().length, 0, "still nothing dropped");
  });

  it("a late-delivered fire whose turn fails still retires at the cap (failed ladder unchanged)", () => {
    const q = new WakeRetryQueue();
    q._setMaxAttemptsForTests(1);
    let now = 51_000_000;
    q._setClockForTests(() => now);
    let busy = true;
    q.setActiveRunCheck(() => busy);

    q.trackWake(makeTimer("park-fail"));
    q.deferBusyWake(makeTimer("park-fail"), 0);
    now += WAKE_RETRY_BACKOFF_MS[0];
    q.trackWake(q.drainDue()[0].timer, 1);
    q.deferBusyWake(makeTimer("park-fail"), 1); // parked

    busy = false;
    const [parked] = q.drainParkedBusy();
    assert.equal(parked.timer.id, "park-fail");

    // The late delivery re-tracks at attempt 0; its turn fails -> one fresh
    // failed redelivery, then the cap drops it exactly as before.
    q.trackWake(parked.timer, 0, { continueHold: true }); // the parked handoff re-tracks its own fire
    q.onAgentEnd(true);
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 1, "the failed turn armed one redelivery");
    now += WAKE_RETRY_BACKOFF_MS[0];
    const due = q.drainDue();
    assert.deepEqual(
      due.map((r) => r.cause),
      ["failed"],
      "'failed' stays reserved for a genuine failed turn",
    );
    q.trackWake(due[0].timer, due[0].attempt);
    q.onAgentEnd(true);
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 0, "the cap still retires a failed chain");
    assert.equal(q.takeExhausted().length, 1, "a genuinely failed chain still drops");
  });

  it("REGRESSION: a cancel during the parked state withdraws the fire", () => {
    const q = new WakeRetryQueue();
    q._setMaxAttemptsForTests(1);
    let now = 52_000_000;
    q._setClockForTests(() => now);
    q.trackWake(makeTimer("park-cancel"));
    q.deferBusyWake(makeTimer("park-cancel"), 0);
    now += WAKE_RETRY_BACKOFF_MS[0];
    q.trackWake(q.drainDue()[0].timer, 1);
    q.deferBusyWake(makeTimer("park-cancel"), 1); // parked
    assert.equal(q.outstandingCount(), 1, "pre-condition: parked");

    q.retireTimer("park-cancel");
    assert.equal(q.outstandingCount(), 0, "the parked fire is withdrawn with the cancel");
    assert.equal(q.isRetired("park-cancel"), true, "retirement marked for in-flight sends");
    assert.deepEqual(q.drainParkedBusy(), [], "a cancelled parked fire never delivers late");
    assert.equal(q.getStats().succeeded, 0, "a cancel is not a delivery");
  });

  it("REGRESSION: a newer fire of the same id reports its OWN hold, not the parked predecessor's chain", () => {
    const q = new WakeRetryQueue();
    q._setMaxAttemptsForTests(1); // one busy rung per fire, then the ladder is spent
    let now = 60_000_000;
    q._setClockForTests(() => now);

    // Fire N of a recurring timer: held from T0, its ladder spent, parked.
    q.trackWake(makeTimer("recur-park"));
    q.deferBusyWake(makeTimer("recur-park"), 0);
    now += WAKE_RETRY_BACKOFF_MS[0];
    q.trackWake(q.drainDue()[0].timer, 1);
    q.deferBusyWake(makeTimer("recur-park"), 1); // parked at T0
    assert.equal(q.getStats().heldBusy, 1, "pre-condition: fire N is parked");

    // Ten minutes later the SAME recurring timer fires again (fire N+1): a
    // different ScheduledTimer instance, so its hold window starts now.
    now += 600_000;
    q.trackWake(makeTimer("recur-park"));
    q.deferBusyWake(makeTimer("recur-park"), 0);
    now += WAKE_RETRY_BACKOFF_MS[0];
    q.trackWake(q.drainDue()[0].timer, 1);
    q.deferBusyWake(makeTimer("recur-park"), 1); // parked at fire N+1's own origin
    now += 5_000;

    const parked = q.drainParkedBusy();
    assert.equal(parked.length, 1, "the newer fire is delivered late once");
    assert.equal(
      parked[0].heldMs,
      WAKE_RETRY_BACKOFF_MS[0] + 5_000,
      "the newer fire reports its own hold, not the predecessor chain's 10-minute hold",
    );
  });

  it("REGRESSION: a park reached through a continueHold re-track keeps the ORIGINAL hold origin", () => {
    // The late handoff re-tracks a parked fire at attempt 0 with continueHold,
    // because it continues the SAME fire's delivery chain. Every hold-origin
    // assertion that rides a numbered (attempt >= 1) re-track survives a
    // half-revert of that rule; this one does not: the continuation is held
    // again, its ladder spends, and the re-park must report the WHOLE window
    // from the chain's origin, not just the stretch since the handoff.
    const q = new WakeRetryQueue();
    q._setMaxAttemptsForTests(1); // one busy rung per fire, then the ladder is spent
    let now = 70_000_000;
    q._setClockForTests(() => now);

    // Fire held at T0, ladder spent, parked.
    q.trackWake(makeTimer("chain-origin"));
    q.deferBusyWake(makeTimer("chain-origin"), 0); // hold origin = T0
    now += WAKE_RETRY_BACKOFF_MS[0];
    q.trackWake(q.drainDue()[0].timer, 1);
    q.deferBusyWake(makeTimer("chain-origin"), 1); // parked; origin stays T0

    // The late handoff: delivered once, then re-tracked as the chain's
    // continuation (attempt 0 + continueHold).
    const [handoff] = q.drainParkedBusy();
    assert.equal(handoff.timer.id, "chain-origin", "pre-condition: the fire is handed off once");
    assert.equal(handoff.heldMs, WAKE_RETRY_BACKOFF_MS[0], "pre-condition: first window");
    q.trackWake(handoff.timer, 0, { continueHold: true });

    // Held again and spent again: the continuation parks.
    now += 12_000;
    q.deferBusyWake(makeTimer("chain-origin"), 0); // held again: one fresh rung
    now += WAKE_RETRY_BACKOFF_MS[0];
    q.trackWake(q.drainDue()[0].timer, 1); // rung re-tracks at attempt 1
    q.deferBusyWake(makeTimer("chain-origin"), 1); // 2 > cap 1 -> park

    const [reparked] = q.drainParkedBusy();
    assert.equal(reparked.timer.id, "chain-origin");
    assert.equal(
      reparked.heldMs,
      2 * WAKE_RETRY_BACKOFF_MS[0] + 12_000,
      "the re-park reports the whole held window from the chain's origin",
    );
  });
});

describe("cancel retires the fire and its ladder", () => {
  it("REGRESSION: retireTimer drops the outstanding wake, the armed ladder, and parked recovered fires", () => {
    const q = new WakeRetryQueue();
    let now = 30_000_000;
    q._setClockForTests(() => now);
    q.trackWake(makeTimer("retire-a"));
    q.onAgentEnd(true);
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 1, "pre-condition: retry armed");
    q.deferRecoveredFire({ id: "retire-a", sessionId: "s", reason: "parked", wake: true });

    q.retireTimer("retire-a");
    assert.equal(q.outstandingCount(), 0, "outstanding wake resolved by the cancel");
    assert.equal(q.pendingRetryCount(), 0, "armed ladder retired by the cancel");
    assert.equal(q.deferredRecoveredCount(), 0, "parked recovered fire for the cancelled id dropped");
    now += 10 * 60_000;
    assert.deepEqual(q.drainDue(), [], "a cancelled timer never redelivers");
    assert.equal(q.isRetired("retire-a"), true, "retirement marked for in-flight send guards");
    assert.equal(q.getStats().succeeded, 0, "a cancel is not a delivery success");
  });

  it("a fresh fire of the same id re-arms after retirement (retirement is per-fire)", () => {
    const q = new WakeRetryQueue();
    q.retireTimer("retire-b");
    assert.equal(q.isRetired("retire-b"), true);
    q.trackWake(makeTimer("retire-b"));
    assert.equal(q.isRetired("retire-b"), false, "trackWake clears the retirement mark");
    assert.equal(q.outstandingCount(), 1);
    q.onAgentEnd(true);
    q.onAgentSettled();
    assert.equal(q.pendingRetryCount(), 1, "the fresh fire's own chain works");
  });
});

describe("long-run grace: an active run is not a lost send", () => {
  it("REGRESSION: no outcome-timeout arming while a run is active; pre-flight-abort recovery intact", () => {
    const q = new WakeRetryQueue();
    let now = 40_000_000;
    q._setClockForTests(() => now);
    let runActive = true;
    q.setActiveRunCheck(() => runActive);

    q.trackWake(makeTimer("grace-a"));
    now += WAKE_OUTCOME_TIMEOUT_MS + 60_000; // window elapsed mid-run
    q.drainDue();
    assert.equal(
      q.pendingRetryCount(),
      0,
      "the fire's turn is merely long — no retry armed mid-run",
    );
    assert.equal(q.outstandingCount(), 1, "the wake stays outstanding while its turn runs");

    q.onAgentEnd(false);
    q.onAgentSettled();
    assert.equal(q.outstandingCount(), 0, "the long run's settle resolves the wake");
    now += 10 * 60_000;
    assert.deepEqual(q.drainDue(), [], "no spurious redelivery ever fires");

    // The 240s window exists for the send that never started a turn: with
    // no run active the timeout must still arm (pre-flight-abort recovery).
    q.trackWake(makeTimer("grace-abort"));
    runActive = false;
    now += WAKE_OUTCOME_TIMEOUT_MS + 1;
    q.drainDue();
    assert.equal(q.pendingRetryCount(), 1, "no run active: the timeout still arms");
  });

  it("a missing or throwing predicate degrades to the old arming behavior (never a lost wake)", () => {
    const q = new WakeRetryQueue();
    let now = 41_000_000;
    q._setClockForTests(() => now);
    q.trackWake(makeTimer("grace-open"));
    now += WAKE_OUTCOME_TIMEOUT_MS;
    q.drainDue();
    assert.equal(q.pendingRetryCount(), 1, "no predicate wired: arm as before");

    const q2 = new WakeRetryQueue();
    q2._setClockForTests(() => now);
    q2.setActiveRunCheck(() => {
      throw new Error("broken reader");
    });
    q2.trackWake(makeTimer("grace-throw"));
    now += WAKE_OUTCOME_TIMEOUT_MS;
    q2.drainDue();
    assert.equal(q2.pendingRetryCount(), 1, "a throwing predicate must not suppress the arming");
  });
});

describe("settings resolvers (braid.timers.maxWakeAttempts + pi retry budget)", () => {
  it("resolveMaxWakeAttempts: default 3, ints 1..10 pass, junk warns + falls back", () => {
    assert.equal(resolveMaxWakeAttempts(undefined), 3);
    assert.equal(resolveMaxWakeAttempts(1), 1);
    assert.equal(resolveMaxWakeAttempts(5), 5);
    assert.equal(resolveMaxWakeAttempts(0), 3);
    assert.equal(resolveMaxWakeAttempts(11), 3);
    assert.equal(resolveMaxWakeAttempts(2.5), 3);
    assert.equal(resolveMaxWakeAttempts("3"), 3);
    assert.equal(resolveMaxWakeAttempts(null), 3);
  });

  it("resolveWakeRetryHoldMs: baseDelayMs * 2^maxRetries, clamped to 5min", () => {
    assert.equal(resolveWakeRetryHoldMs(undefined), 16_000, "pi-core defaults: 2000*2^3");
    assert.equal(resolveWakeRetryHoldMs({ maxRetries: 3, baseDelayMs: 2000 }), 16_000);
    assert.equal(resolveWakeRetryHoldMs({ maxRetries: 0, baseDelayMs: 500 }), 500);
    assert.equal(resolveWakeRetryHoldMs({ maxRetries: 4, baseDelayMs: 1000 }), 16_000);
    assert.equal(
      resolveWakeRetryHoldMs({ maxRetries: 10, baseDelayMs: 60_000 }),
      WAKE_RETRY_HOLD_MAX_MS,
    );
    assert.equal(
      resolveWakeRetryHoldMs({ maxRetries: -1, baseDelayMs: "x" }),
      16_000,
      "junk fields fall back to pi-core defaults",
    );
  });
});

// ── Fix 3: recovery defers recovered fires (no inline before_agent_start fire) ──

// Persisted-store helpers, module-scope: shared by the fix-3 suite and the
// recovered-fire timing-marker suite below.
function writeTimerFile(lines) {
  const file = getTimerFilePath(process.cwd());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
}

function readTimerFile() {
  const raw = readFileSync(getTimerFilePath(process.cwd()), "utf-8").trim();
  return raw ? raw.split("\n").map((l) => JSON.parse(l)) : [];
}

describe("fix 3: recovered persisted fires defer past turn start", () => {
  it("REGRESSION: expired persisted fire is NOT delivered inline in before_agent_start", () => {
    process.chdir(tmp);
    timerMod.timerManager.clearSession("w114c");
    writeTimerFile([
      {
        id: "rec-1",
        sessionId: "w114c",
        firesAt: Date.now() - 5000,
        reason: "recovered work",
        createdAt: Date.now() - 60_000,
        wake: true,
      },
    ]);
    const pi = makeFakePi();
    pb.recoverPersistedTimers(pi);
    assert.equal(pi.sent.length, 0, "competing-turn bug: no inline delivery during turn start");
    assert.equal(wakeRetryQueue.deferredRecoveredCount(), 1, "fire parked for post-settle flush");
  });

  it("flushRecoveredFires delivers wake:true recovered fires as post-settle turns", async () => {
    process.chdir(tmp);
    timerMod.timerManager.clearSession("w114c");
    writeTimerFile([
      {
        id: "rec-1b",
        sessionId: "w114c",
        firesAt: Date.now() - 5000,
        reason: "recovered work",
        createdAt: Date.now() - 60_000,
        wake: true,
      },
    ]);
    const pi = makeFakePi();
    pb.recoverPersistedTimers(pi);
    assert.equal(wakeRetryQueue.deferredRecoveredCount(), 1, "parked by recovery");
    flushRecoveredFires(pi);
    await flushDeferred();
    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].params.customType, "timer-fire");
    assert.equal(pi.sent[0].options.triggerTurn, true, "wake:true -> its own post-settle turn");
    assert.match(pi.sent[0].params.content[0].text, /recovered work/);
    assert.equal(wakeRetryQueue.deferredRecoveredCount(), 0);
  });

  it("wake:false recovered fires flush as advisory steers (no turn)", async () => {
    process.chdir(tmp);
    timerMod.timerManager.clearSession("w114c");
    writeTimerFile([
      {
        id: "rec-silent",
        sessionId: "w114c",
        firesAt: Date.now() - 5000,
        reason: "silent recovery",
        createdAt: Date.now() - 60_000,
        wake: false,
      },
    ]);
    const pi = makeFakePi();
    pb.recoverPersistedTimers(pi);
    flushRecoveredFires(pi);
    await flushDeferred();
    assert.equal(pi.sent.length, 1);
    assert.equal(
      pi.sent[0].options.triggerTurn,
      false,
      "silent recovered fire does not force a turn",
    );
    assert.equal(pi.sent[0].options.deliverAs, "steer");
  });

  it("expired RECURRING persisted fire: overdue tick deferred, recurrence still re-armed", async () => {
    process.chdir(tmp);
    timerMod.timerManager.clearSession("w114c");
    writeTimerFile([
      {
        id: "rec-p",
        sessionId: "w114c",
        firesAt: Date.now() - 5000,
        reason: "periodic",
        tag: "periodic-status",
        createdAt: Date.now() - 3_600_000,
        wake: true,
        intervalMs: 1_800_000,
        count: 100000,
        fires: 3,
      },
    ]);
    const pi = makeFakePi();
    pb.recoverPersistedTimers(pi);

    const live = timerMod.timerManager.listTimers("w114c");
    assert.equal(live.length, 1, "recurrence re-armed during recovery (unchanged)");
    assert.equal(live[0].fires, 4, "fires counter advanced");
    assert.equal(readTimerFile()[0].fires, 4, "disk carries the advanced counter");

    flushRecoveredFires(pi);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "overdue tick delivered post-settle");
    assert.equal(pi.sent[0].options.triggerTurn, true);
  });

  it("flush with an empty queue is a no-op (idempotent double registration)", () => {
    process.chdir(tmp);
    const pi = makeFakePi();
    flushRecoveredFires(pi); // primary listener already drained
    flushRecoveredFires(pi); // fallback listener sees empty queue
    assert.equal(pi.sent.length, 0, "no double delivery from double registration");
  });
});

// ── recovered fires carry the live timing marker ────────────────────────

describe("recovered fire text carries the live timing marker", () => {
  it("REGRESSION: wake:true recovered fire reuses the set-for/fired/drift marker", async () => {
    process.chdir(tmp);
    timerMod.timerManager.clearSession("w234t");
    writeTimerFile([
      {
        id: "rec-timing",
        sessionId: "w234t",
        firesAt: Date.now() - 60_000,
        reason: "recovered timing",
        createdAt: Date.now() - 3_600_000,
        wake: true,
      },
    ]);
    const pi = makeFakePi();
    pb.recoverPersistedTimers(pi);
    flushRecoveredFires(pi);
    await flushDeferred();
    assert.equal(pi.sent.length, 1);
    const text = pi.sent[0].params.content[0].text;
    assert.match(
      text,
      /recovered timing - set for /,
      "marker reused — the fire must not read as on-time scheduled text",
    );
    assert.match(text, /, fired .*drift /, "drift stated like every live fire");
    assert.match(text, /elapsed since scheduled\. Resume the task\./, "live wake tail preserved");
  });

  it("a late recovered fire logs its delay once", async () => {
    process.chdir(tmp);
    timerMod.timerManager.clearSession("w234t");
    writeTimerFile([
      {
        id: "rec-late",
        sessionId: "w234t",
        firesAt: Date.now() - 1_500_000, // 25 min overdue
        reason: "recovered late",
        createdAt: Date.now() - 1_800_000,
        wake: true,
      },
    ]);
    const pi = makeFakePi();
    pb.recoverPersistedTimers(pi);
    clearLogBuffer();
    flushRecoveredFires(pi);
    await flushDeferred();
    const lateLines = getLogBuffer().filter((e) => e.message.includes("delivered late by"));
    assert.equal(lateLines.length, 1, "exactly one log line carries the recovery delay");
    assert.match(lateLines[0].message, /rec-late/, "the fire is identified in the log");
    assert.match(lateLines[0].message, /delivered late by 25m/, "delay in human units");
  });

  it("an on-time recovered fire logs no late line", async () => {
    process.chdir(tmp);
    timerMod.timerManager.clearSession("w234t");
    writeTimerFile([
      {
        id: "rec-ontime",
        sessionId: "w234t",
        firesAt: Date.now() - 5, // drifted less than a second
        reason: "recovered ontime",
        createdAt: Date.now() - 60_000,
        wake: true,
      },
    ]);
    const pi = makeFakePi();
    pb.recoverPersistedTimers(pi);
    clearLogBuffer();
    flushRecoveredFires(pi);
    await flushDeferred();
    assert.equal(
      getLogBuffer().filter((e) => e.message.includes("delivered late by")).length,
      0,
      "no late line for an on-time recovered fire",
    );
  });
});

// ── Fix 2 + 4 e2e: extension wiring (agent_end -> settle -> drain on tick) ──

describe("e2e: failed wake turn retries via poll/TURN_END ticks (no user turn)", () => {
  it("wake fire -> provider error turn -> backoff retry redelivered on next tick", async () => {
    process.chdir(tmp);
    const pi = makeFakePi();
    timerMod.default(pi);
    wakeRetryQueue._setMaxAttemptsForTests(WAKE_RETRY_MAX_ATTEMPTS); // pin the cap
    const ctx = { sessionManager: { getSessionId: () => "w114r" } };
    pi.emit("session_start", {}, ctx);

    timerMod.scheduleTimer("w114r", 30, "resume the build", undefined, true);
    await sleep(80); // let it expire

    // TURN_END/TOOL_EXECUTION_END path delivers the fire (setTimeout(0) guard).
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "wake fire delivered");
    assert.equal(pi.sent[0].options.triggerTurn, true);
    assert.equal(wakeRetryQueue.outstandingCount(), 1, "fire tracked as outstanding");

    // The wake turn FAILS with a provider error (401).
    pi.emit(
      "agent_end",
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 401" }] },
      ctx,
    );
    pi.emit("agent_settled", {}, ctx);
    assert.equal(wakeRetryQueue.outstandingCount(), 0);
    assert.equal(wakeRetryQueue.pendingRetryCount(), 1, "undelivered wake armed for retry");

    // Backoff not yet elapsed: the next tick must NOT redeliver.
    wakeRetryQueue._setClockForTests(() => Date.now());
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "inside backoff window: no redelivery");

    // Backoff elapsed (advance the queue clock past backoff[0]=5s).
    wakeRetryQueue._setClockForTests(() => Date.now() + 5_000);
    pi.emit("tool_execution_end", {}, ctx); // same tick path as TURN_END
    await flushDeferred();
    assert.equal(pi.sent.length, 2, "retry redelivered on the next poll/TURN_END tick");
    assert.equal(pi.sent[1].options.triggerTurn, true, "retry is a wake");
    assert.match(pi.sent[1].params.content[0].text, /retry 1\/3/, "retry marked for the agent");
    assert.match(
      pi.sent[1].params.content[0].text,
      /resume the build/,
      "original reason preserved",
    );
    assert.equal(wakeRetryQueue.outstandingCount(), 1, "redelivery tracked again");

    // The retry turn SUCCEEDS -> no further retries.
    pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    pi.emit("agent_settled", {}, ctx);
    assert.equal(wakeRetryQueue.pendingRetryCount(), 0, "delivered wake not retried");
    pi.emit("session_shutdown", {}, ctx); // stop the real 1s poller interval
  });

  it("successful outcome clears the outstanding wake with no retry scheduled", async () => {
    process.chdir(tmp);
    const pi = makeFakePi();
    timerMod.default(pi);
    const ctx = { sessionManager: { getSessionId: () => "w114s" } };
    pi.emit("session_start", {}, ctx);

    timerMod.scheduleTimer("w114s", 30, "happy path", undefined, true);
    await sleep(60);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1);

    pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    pi.emit("agent_settled", {}, ctx);
    assert.equal(wakeRetryQueue.pendingRetryCount(), 0, "success: no retry");
    assert.equal(wakeRetryQueue.getStats().succeeded >= 1, true);
    pi.emit("session_shutdown", {}, ctx); // stop the poller interval
  });

  it("e2e: retryable provider error holds the redelivery while pi-core retries (wiring: agent_end errorMessage -> queue)", async () => {
    process.chdir(tmp);
    const pi = makeFakePi();
    timerMod.default(pi);
    const ctx = { sessionManager: { getSessionId: () => "w137e" } };
    pi.emit("session_start", {}, ctx);

    timerMod.scheduleTimer("w137e", 30, "resume the deploy", undefined, true);
    await sleep(80);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "wake fire delivered");

    // Pin the clock 250s past the delivery: pre- (60s timeout) — and
    // even post- without the hold — this tick would arm a retry.
    const fireTime = Date.now();
    wakeRetryQueue._setClockForTests(() => fireTime + 250_000);
    wakeRetryQueue._setRetryHoldForTests(300_000); // hold past the pinned clock
    // The wake turn fails with a RETRYABLE provider error (pi-core is
    // auto-retrying inside the same run — no settle yet).
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
      ctx,
    );
    // Poll ticks keep running during pi-core's retry cycle.
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "hold active: NO mid-retry-cycle redelivery");
    assert.equal(wakeRetryQueue.pendingRetryCount(), 0, "nothing armed");

    // pi-core's retry succeeds: final outcome success.
    wakeRetryQueue._setClockForTests(() => fireTime + 260_000);
    pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    pi.emit("agent_settled", {}, ctx);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "recovered run: no redelivery ever fires");
    pi.emit("session_shutdown", {}, ctx); // stop the poller interval
  });

  it("REGRESSION: a timeout-armed redelivery says 'no turn outcome within the window', never 'turn failed'", async () => {
    process.chdir(tmp);
    const pi = makeFakePi();
    timerMod.default(pi);
    const ctx = { sessionManager: { getSessionId: () => "honest-e2e" } };
    pi.emit("session_start", {}, ctx);

    timerMod.scheduleTimer("honest-e2e", 30, "resume the audit", undefined, true);
    await sleep(80);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "wake fire delivered");

    // The wake's send never produces a turn (pre-flight abort shape): the
    // outcome window elapses, the timeout arms, the backoff elapses.
    wakeRetryQueue._setClockForTests(() => Date.now() + WAKE_OUTCOME_TIMEOUT_MS + 1_000);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(wakeRetryQueue.pendingRetryCount(), 1, "timeout armed");
    assert.equal(pi.sent.length, 1, "backoff pending: nothing redelivered yet");

    wakeRetryQueue._setClockForTests(() => Date.now() + WAKE_OUTCOME_TIMEOUT_MS + 12_000);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 2, "timeout-armed retry redelivered");
    const text = pi.sent[1].params.content[0].text;
    assert.match(text, /no turn outcome within the window; re-delivered/);
    assert.doesNotMatch(text, /turn failed/, "no turn ever failed — the text must not say so");
    pi.emit("session_shutdown", {}, ctx); // stop the poller interval
  });

  it("REGRESSION: cancel retires the fire — no redelivery after a cancel by id", async () => {
    process.chdir(tmp);
    const pi = makeFakePi();
    timerMod.default(pi);
    const ctx = { sessionManager: { getSessionId: () => "retire-e2e" } };
    pi.emit("session_start", {}, ctx);

    const id = timerMod.scheduleTimer("retire-e2e", 30, "babysit the deploy", undefined, true, 60_000);
    await sleep(80);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "wake fire delivered");

    // The wake turn fails -> the ladder arms (the incident's pre-cancel state).
    pi.emit(
      "agent_end",
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 401" }] },
      ctx,
    );
    pi.emit("agent_settled", {}, ctx);
    assert.equal(wakeRetryQueue.pendingRetryCount(), 1, "retry armed (pre-condition)");

    // The timer is RECURRING (the incident's babysit shape): the first fire
    // re-arms the next one, so the manager entry is still live at cancel
    // time — cancel removes it AND retires the armed ladder.
    assert.equal(timerMod.cancelTimer("retire-e2e", id), true, "owner cancels");
    assert.equal(wakeRetryQueue.pendingRetryCount(), 0, "cancel retires the armed ladder");

    wakeRetryQueue._setClockForTests(() => Date.now() + 60_000);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "no redelivery after the cancel");
    pi.emit("session_shutdown", {}, ctx); // stop the poller interval
  });

  it("REGRESSION: cancel-by-id retires a FIRED one-shot's armed ladder (the manager lookup misses it)", async () => {
    process.chdir(tmp);
    const pi = makeFakePi();
    timerMod.default(pi);
    const ctx = { sessionManager: { getSessionId: () => "retire-shot" } };
    pi.emit("session_start", {}, ctx);

    const id = timerMod.scheduleTimer("retire-shot", 30, "one-shot babysit", undefined, true);
    await sleep(80);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "fired");
    pi.emit(
      "agent_end",
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 401" }] },
      ctx,
    );
    pi.emit("agent_settled", {}, ctx);
    assert.equal(wakeRetryQueue.pendingRetryCount(), 1, "ladder armed");
    assert.equal(
      timerMod.timerManager.listTimers("retire-shot").length,
      0,
      "one-shot deleted from the manager at expiry (delete-on-detection)",
    );

    assert.equal(
      timerMod.cancelTimer("retire-shot", id),
      false,
      "the manager lookup misses the fired one-shot",
    );
    assert.equal(wakeRetryQueue.pendingRetryCount(), 0, "the ladder retired anyway");
    wakeRetryQueue._setClockForTests(() => Date.now() + 60_000);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "no redelivery after the cancel");
    pi.emit("session_shutdown", {}, ctx); // stop the poller interval
  });

  it("REGRESSION: cancelTimersByTag retires every matching fire and ladder", async () => {
    process.chdir(tmp);
    const pi = makeFakePi();
    timerMod.default(pi);
    const ctx = { sessionManager: { getSessionId: () => "retire-tag" } };
    pi.emit("session_start", {}, ctx);

    timerMod.scheduleTimer("retire-tag", 30, "tagged babysit a", "retire-tag", true);
    timerMod.scheduleTimer("retire-tag", 60_000, "tagged babysit b", "retire-tag", true);
    await sleep(80);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "the first timer fired");
    pi.emit(
      "agent_end",
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 401" }] },
      ctx,
    );
    pi.emit("agent_settled", {}, ctx);
    assert.equal(wakeRetryQueue.pendingRetryCount(), 1, "ladder armed");

    const n = timerMod.cancelTimersByTag("retire-tag", "retire-tag");
    assert.equal(n, 1, "the surviving tagged timer cancelled");
    assert.equal(wakeRetryQueue.pendingRetryCount(), 0, "ladder retired with the tag cancel");

    wakeRetryQueue._setClockForTests(() => Date.now() + 120_000);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "no redelivery after the tag cancel");
    pi.emit("session_shutdown", {}, ctx); // stop the poller interval
  });

  it("REGRESSION: a cancel inside the deferred-fire window suppresses the fire itself", async () => {
    process.chdir(tmp);
    const pi = makeFakePi();
    timerMod.default(pi);
    const ctx = { sessionManager: { getSessionId: () => "retire-defer" } };
    pi.emit("session_start", {}, ctx);

    const id = timerMod.scheduleTimer("retire-defer", 30, "babysit the build", undefined, true);
    await sleep(80); // expired in the map, not yet fired
    pi.emit("tool_execution_end", {}, ctx); // checkExpired returns it; fire deferred via setTimeout(0)
    // The fire already left the manager map (delete-on-detection; the
    // deferred delivery holds it), so the manager lookup misses — the
    // cancel's whole effect is the retirement: the deferred fire is
    // suppressed, nothing is tracked, nothing ever sends.
    assert.equal(
      timerMod.cancelTimer("retire-defer", id),
      false,
      "the manager lookup misses — the fire left the map with the deferred delivery",
    );
    await flushDeferred();
    assert.equal(pi.sent.length, 0, "the cancelled timer's fire is suppressed");
    assert.equal(wakeRetryQueue.outstandingCount(), 0, "nothing tracked for a suppressed fire");
    pi.emit("session_shutdown", {}, ctx); // stop the poller interval
  });

  it("REGRESSION: the extension wires the active-run predicate — busy session suppresses, idle arms with the honest cause", async () => {
    process.chdir(tmp);
    const pi = makeFakePi();
    timerMod.default(pi);
    let idle = false; // session busy: a run is in flight
    const ctx = { sessionManager: { getSessionId: () => "grace-e2e" }, isIdle: () => idle };
    pi.emit("session_start", {}, ctx);

    timerMod.scheduleTimer("grace-e2e", 30, "resume the audit", undefined, true);
    await sleep(80);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "wake fire delivered mid-run");
    assert.equal(wakeRetryQueue.outstandingCount(), 1);

    // The wake's turn runs long; the outcome window elapses mid-run.
    wakeRetryQueue._setClockForTests(() => Date.now() + WAKE_OUTCOME_TIMEOUT_MS + 60_000);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(
      wakeRetryQueue.pendingRetryCount(),
      0,
      "grace: no retry armed while the run is active",
    );
    assert.equal(pi.sent.length, 1, "no redelivery mid-run");

    // The long run settles successfully.
    pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    pi.emit("agent_settled", {}, ctx);
    assert.equal(wakeRetryQueue.outstandingCount(), 0, "settle resolves the wake");

    // Later, an idle session: the timeout must arm (pre-flight-abort recovery).
    wakeRetryQueue._setClockForTests(() => Date.now());
    idle = true;
    timerMod.scheduleTimer("grace-e2e", 30, "resume the audit again", undefined, true);
    await sleep(80);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 2, "second fire delivered (idle session)");

    wakeRetryQueue._setClockForTests(() => Date.now() + WAKE_OUTCOME_TIMEOUT_MS + 1_000);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(
      wakeRetryQueue.pendingRetryCount(),
      1,
      "idle session: the timeout still arms",
    );
    wakeRetryQueue._setClockForTests(() => Date.now() + WAKE_OUTCOME_TIMEOUT_MS + 12_000);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 3, "retry redelivered");
    assert.match(
      pi.sent[2].params.content[0].text,
      /no turn outcome within the window; re-delivered/,
      "the idle-session timeout carries the honest text",
    );
    pi.emit("session_shutdown", {}, ctx); // stop the poller interval
  });

  it("REGRESSION: a wake held while the session is busy past the ladder is delivered late once, with the honest held text", async () => {
    process.chdir(tmp);
    const pi = makeFakePi();
    timerMod.default(pi);
    registerWakeGate(pi); // isAgentBusy() reads the session ctx wake-gate captures
    wakeRetryQueue._setMaxAttemptsForTests(1); // one busy rung, then the ladder is spent

    let idle = false; // busy: a run / pre-flight window holds a raw triggerTurn
    const ctx = {
      sessionManager: { getSessionId: () => "busy-e2e" },
      isIdle: () => idle,
      signal: undefined,
    };
    pi.emit("session_start", {}, ctx);
    clearLogBuffer();

    timerMod.scheduleTimer("busy-e2e", 30, "resume the deploy", undefined, true);
    await sleep(80);

    // The send is held at the busy state check (nothing delivered, nothing
    // failed): the one busy rung is armed.
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 0, "the send is held while the session is busy");
    assert.equal(wakeRetryQueue.pendingRetryCount(), 1, "the busy rung is armed");

    // The rung redelivers into a still-busy session: the ladder is spent and
    // the fire is PARKED, not dropped.
    wakeRetryQueue._setClockForTests(() => Date.now() + WAKE_RETRY_BACKOFF_MS[0]);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 0, "still held");
    assert.equal(wakeRetryQueue.pendingRetryCount(), 0, "no rung past the bound");
    assert.equal(wakeRetryQueue.takeExhausted().length, 0, "nothing dropped for a busy hold");
    assert.equal(wakeRetryQueue.getStats().exhausted, 0);

    // The session settles (idle): the parked fire gets its one late delivery.
    idle = true;
    pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    pi.emit("agent_settled", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "the held fire is delivered late, exactly once");
    assert.equal(pi.sent[0].options.triggerTurn, true, "it is still a wake");
    assert.match(
      pi.sent[0].params.content[0].text,
      /held while the session was busy for \d/,
      "the text states the busy hold and its duration",
    );
    assert.doesNotMatch(pi.sent[0].params.content[0].text, /turn failed/, "no turn ever failed");

    // The log distinguishes "held while busy, delivered late" from "dropped".
    const lines = getLogBuffer()
      .map((e) => e.message)
      .join("\n");
    assert.match(lines, /held while the session was busy for \d/, "the late delivery is logged");
    assert.equal(
      (lines.match(/delivered late/g) ?? []).length,
      1,
      "exactly one late-delivery log line",
    );
    assert.doesNotMatch(
      lines,
      /permanently undelivered/,
      "a busy hold is never logged as a drop",
    );

    // Nothing further fires once the late delivery is tracked.
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "one late delivery, no repeat");
    assert.equal(wakeRetryQueue.takeExhausted().length, 0, "never dropped");
    pi.emit("session_shutdown", {}, ctx); // stop the poller interval
  });

  it("REGRESSION: a late handoff held again logs no delivery - the log agrees with the send", async () => {
    process.chdir(tmp);
    const pi = makeFakePi();
    timerMod.default(pi);
    registerWakeGate(pi); // isAgentBusy() reads the session ctx wake-gate captures
    wakeRetryQueue._setMaxAttemptsForTests(1); // one busy rung, then the ladder is spent

    let idle = false; // busy: a run / pre-flight window holds a raw triggerTurn
    const ctx = {
      sessionManager: { getSessionId: () => "handoff-busy-e2e" },
      isIdle: () => idle,
      signal: undefined,
    };
    pi.emit("session_start", {}, ctx);
    clearLogBuffer();

    // Walk the fire to the parked state: its one busy rung is spent and the
    // session stays busy throughout.
    timerMod.scheduleTimer("handoff-busy-e2e", 30, "resume the migration", undefined, true);
    await sleep(80);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    wakeRetryQueue._setClockForTests(() => Date.now() + WAKE_RETRY_BACKOFF_MS[0]);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 0, "pre-condition: the fire is parked, nothing sent");
    assert.equal(wakeRetryQueue.pendingRetryCount(), 0, "pre-condition: the ladder is spent");

    const lateDeliveryLines = () =>
      getLogBuffer()
        .map((e) => e.message)
        .join("\n")
        .match(/delivered late/g) ?? [];
    assert.equal(lateDeliveryLines().length, 0, "pre-condition: nothing delivered yet");

    // The settle drain hands the parked fire off while the session reads idle,
    // then the session goes busy again INSIDE the handoff window: the send is
    // held again, so this handoff delivered nothing and must not be logged as
    // a delivery.
    idle = true;
    pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    pi.emit("agent_settled", {}, ctx);
    idle = false;
    await flushDeferred();

    assert.equal(pi.sent.length, 0, "the handoff is held again, not sent");
    assert.equal(
      lateDeliveryLines().length,
      0,
      "no late-delivery line for a handoff the hold withdrew",
    );
    assert.equal(
      wakeRetryQueue.pendingRetryCount(),
      1,
      "the held-again handoff arms one fresh rung",
    );

    // Still busy: the fresh rung is spent and the fire parks again.
    wakeRetryQueue._setClockForTests(() => Date.now() + 2 * WAKE_RETRY_BACKOFF_MS[0]);
    pi.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 0, "still held");
    assert.equal(lateDeliveryLines().length, 0, "still nothing delivered, still nothing logged");
    assert.equal(wakeRetryQueue.takeExhausted().length, 0, "nothing dropped for a busy hold");

    // Idle: the parked fire gets its one real late delivery, and exactly one
    // late-delivery line matches it.
    idle = true;
    pi.emit("agent_settled", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "the parked fire is delivered late, exactly once");
    assert.match(
      pi.sent[0].params.content[0].text,
      /held while the session was busy for \d/,
      "the text states the busy hold and its duration",
    );
    assert.equal(
      lateDeliveryLines().length,
      1,
      "one late-delivery line for the one delivery that happened",
    );
    assert.equal(wakeRetryQueue.takeExhausted().length, 0, "never dropped");
    pi.emit("session_shutdown", {}, ctx); // stop the poller interval
  });
});
