/**
 * Regression test: timer fire whisper must reach the agent even when the
 * per-turn whisper flood cap is saturated by other high-priority whispers.
 *
 * HISTORY (see commit messages & scratchpad):
 *   Prior to the fix, "timer_set sometimes doesn't fire" was traced to
 *   sendTrackedMessage silently dropping the timer whisper when 3+ high-
 *   priority whispers already fired in the same turn. Source "timer/fire"
 *   + triggerTurn: true was mapped to "high" priority, where
 *   WHISPER_CAPS.high = 3 (combined from all sources).
 *
 *   The user scheduled a timer, the agent entered a degraded turn (e.g.,
 *   2 enforcement/whisper + 1 compaction-retry/exhausted), and the timer
 *   whisper - the 4th high-priority - was silently dropped. The user
 *   perceived "timer didn't fire."
 *
 * FIX: priorityFromSource in src/lib/utils/injection-tracker.ts now maps
 * "timer/fire" to "critical" priority. Critical bypasses WHISPER_CAPS.high
 * entirely; it is only subject to PER_SOURCE_CAP (2 per turn from the same
 * source). This is a single-line regex change.
 *
 * WHY "critical" is semantically right: a user-scheduled or compaction-
 * resume timer is time-critical by definition. If 3 other high-priority
 * whispers already fired, dropping the timer is exactly the wrong thing
 * to do - the timer is the one the user is actively waiting on.
 *
 * Per-source cap of 2 still applies: setting 3+ timers that all expire in
 * the same turn will still suppress the 3rd. This is acceptable; the user
 * can stagger their timers.
 *
 * This test pins down both the fixed behavior and the residual constraint
 * so neither can regress silently.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const {
  tryWhisper,
  _resetForTests,
  _snapshot,
  beginTurn,
  WHISPER_CAPS,
} = await import("../../../dist/lib/enforcement/turn-dedup.js");
const {
  sendTrackedMessage,
  getInjections,
  clearAllBuckets,
} = await import("../../../dist/lib/utils/injection-tracker.js");
const {
  emitTimerReminder,
  drainTimerReminders,
  onTimerReminder,
} = await import("../../../dist/lib/events/timer-bus.js");

// ── Re-derive priorityFromSource (must match src/lib/utils/injection-tracker.ts) ──

function priorityFromSource(source, options) {
  if (/auto-recovery|turn-outcome\/loop|timer\/fire/.test(source)) {
    return "critical";
  }
  if (
    /enforcement\/whisper|exhausted|compaction-retry|context-manager\/rotation/.test(source) ||
    options?.triggerTurn === true
  ) {
    return "high";
  }
  if (/analytics|navigation|context-full|register-session-start/.test(source)) {
    return "medium";
  }
  return "low";
}

function makeMockPi() {
  const sent = [];
  return {
    sendMessage: (params, options) => {
      sent.push({ params, options });
    },
    sent,
  };
}

// ── Cap math (whitebox) ────────────────────────────────────────────────────

describe("Whisper cap invariants", () => {
  beforeEach(() => _resetForTests());

  it("WHISPER_CAPS.high = 3 (the limit that USED TO suppress timer fires)", () => {
    assert.equal(WHISPER_CAPS.high, 3);
  });

  it("3 high-priority whispers pass; 4th is suppressed (cap unchanged)", () => {
    beginTurn();
    assert.equal(tryWhisper("high", "enforcement/whisper"), true);
    assert.equal(tryWhisper("high", "enforcement/whisper"), true);
    assert.equal(tryWhisper("high", "compaction-retry/exhausted"), true);
    assert.equal(tryWhisper("high", "context-manager/rotation"), false, "4th high is suppressed");
    assert.equal(_snapshot().suppressed, 1);
  });
});

// ── Source-priority mapping (the fix) ─────────────────────────────────────

describe("Timer source -> priority mapping (post-fix)", () => {
  it("FIX: timer/fire -> critical (bypasses high cap, only per-source capped)", () => {
    assert.equal(priorityFromSource("timer/fire", { triggerTurn: true }), "critical");
  });

  it("FIX: timer/fire is critical even without triggerTurn", () => {
    // The wake flag / triggerTurn no longer affects priority for timer.
    // This is intentional: timer is critical by category, not by trigger.
    assert.equal(priorityFromSource("timer/fire", { triggerTurn: false }), "critical");
  });

  it("FIX: timer/fire is critical regardless of wake flag (the wake flag is still passed to sendTrackedMessage options for runtime wake-up behavior)", () => {
    assert.equal(priorityFromSource("timer/fire", undefined), "critical");
  });

  it("Other critical sources still map to critical (no regression)", () => {
    assert.equal(priorityFromSource("auto-recovery/retry", {}), "critical");
    assert.equal(priorityFromSource("turn-outcome/loop-detected", {}), "critical");
  });

  it("Other high-priority sources still map to high (no regression)", () => {
    assert.equal(priorityFromSource("enforcement/whisper", {}), "high");
    assert.equal(priorityFromSource("compaction-retry/exhausted", {}), "high");
    assert.equal(priorityFromSource("context-manager/rotation", {}), "high");
  });
});

// ── End-to-end through sendTrackedMessage (the actual fire path) ───────────

describe("Timer fire end-to-end through sendTrackedMessage", () => {
  beforeEach(() => {
    _resetForTests();
    clearAllBuckets();
  });

  /**
   * sendTrackedMessage defers triggerTurn:true messages to setTimeout(0)
   * (stack overflow fix). This helper flushes the deferred queue so
   * pi.sent reflects the actual send.
   */
  function flushDeferred() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function fireTimerWhisper(pi) {
    sendTrackedMessage(
      pi,
      {
        customType: "timer",
        content: [{ type: "text", text: "[timer] 30s elapsed" }],
        display: true,
        details: { _braidInjected: true },
      },
      { deliverAs: "steer", triggerTurn: true },
      { type: "heartbeat", source: "timer/fire" },
    );
  }

  it("PASS: timer fire in fresh turn reaches the runtime", async () => {
    beginTurn();
    const pi = makeMockPi();
    fireTimerWhisper(pi);
    await flushDeferred();
    const timerSent = pi.sent.filter((m) => m.params.customType === "timer");
    assert.equal(timerSent.length, 1, "fresh turn -> timer reaches runtime");
    assert.equal(timerSent[0].options.triggerTurn, true, "triggerTurn preserved");
  });

  it("FIX: timer fire is NOT suppressed by 3 high-priority whispers from other sources", async () => {
    beginTurn();
    const pi = makeMockPi();

    // Saturate the high cap: 2 enforcement/whisper + 1 compaction-retry/exhausted
    sendTrackedMessage(
      pi,
      { content: [{ type: "text", text: "v1" }] },
      { triggerTurn: false },
      { type: "enforcement", source: "enforcement/whisper" },
    );
    sendTrackedMessage(
      pi,
      { content: [{ type: "text", text: "v2" }] },
      { triggerTurn: false },
      { type: "enforcement", source: "enforcement/whisper" },
    );
    sendTrackedMessage(
      pi,
      { content: [{ type: "text", text: "exhausted" }] },
      { triggerTurn: false },
      { type: "context", source: "compaction-retry/exhausted" },
    );

    // 4th high would be suppressed, but timer is now critical - must pass
    fireTimerWhisper(pi);
    await flushDeferred();

    const timerSent = pi.sent.filter((m) => m.params.customType === "timer");
    assert.equal(
      timerSent.length,
      1,
      "timer whisper reaches runtime even with 3 high-priority whispers saturating the cap",
    );
    assert.equal(pi.sent.length, 4, "all 4 whispers reach");
  });

  it("FIX: compaction-resume timer also bypasses the high cap", async () => {
    // Compaction-resume timer (tag: "compaction-resume", wake: true) uses
    // source "timer/fire" with triggerTurn: true - same fix path. The
    // post-compaction auto-resume wake-up is now reliable.
    beginTurn();
    const pi = makeMockPi();

    // Saturate the high cap as above
    sendTrackedMessage(
      pi,
      { content: [{ type: "text", text: "v1" }] },
      { triggerTurn: false },
      { type: "enforcement", source: "enforcement/whisper" },
    );
    sendTrackedMessage(
      pi,
      { content: [{ type: "text", text: "v2" }] },
      { triggerTurn: false },
      { type: "enforcement", source: "enforcement/whisper" },
    );
    sendTrackedMessage(
      pi,
      { content: [{ type: "text", text: "exhausted" }] },
      { triggerTurn: false },
      { type: "context", source: "compaction-retry/exhausted" },
    );

    // The post-compaction resume wake-up
    sendTrackedMessage(
      pi,
      {
        customType: "timer",
        content: [{ type: "text", text: "[timer] Context compaction done - continue your task" }],
        display: true,
        details: { _braidInjected: true },
      },
      { deliverAs: "steer", triggerTurn: true },
      { type: "heartbeat", source: "timer/fire" },
    );
    await flushDeferred();

    const timerSent = pi.sent.filter((m) => m.params.customType === "timer");
    assert.equal(timerSent.length, 1, "compaction-resume timer reaches runtime");
  });

  it("RESIDUAL: 3rd timer fire in same turn is per-source suppressed (PER_SOURCE_CAP=2)", async () => {
    // Acceptable: per-source cap of 2 still applies to critical. The user
    // can stagger their timers to avoid this. This documents the constraint
    // so it doesn't regress.
    beginTurn();
    const pi = makeMockPi();
    fireTimerWhisper(pi);
    fireTimerWhisper(pi);
    fireTimerWhisper(pi);
    await flushDeferred();

    const timerSent = pi.sent.filter((m) => m.params.customType === "timer");
    assert.equal(timerSent.length, 2, "only 2 timer fires reach (3rd is per-source capped)");
  });
});

// ── Backup channel: timer-bus -> heartbeat-scheduler ───────────────────────

describe("Timer bus backup channel", () => {
  it("emitTimerReminder pushes; drainTimerReminders reads once", () => {
    const t = { id: "t1", firesAt: Date.now(), reason: "test" };
    emitTimerReminder(t);
    const drained = drainTimerReminders();
    assert.equal(drained.length, 1);
    assert.equal(drained[0].timer.id, "t1");
    assert.equal(drainTimerReminders().length, 0, "drain is one-shot");
  });

  it("onTimerReminder fires synchronously (used by heartbeat-scheduler)", () => {
    const seen = [];
    const unsub = onTimerReminder((r) => seen.push(r));
    emitTimerReminder({ id: "x", firesAt: 0, reason: "x" });
    emitTimerReminder({ id: "y", firesAt: 0, reason: "y" });
    assert.equal(seen.length, 2);
    unsub();
  });
});
