/**
 * Regression test: timer fire whisper silently suppressed by per-turn flood cap.
 *
 * ROOT CAUSE (confirmed):
 *   The timer extension calls sendTrackedMessage with source "timer/fire" and
 *   triggerTurn: true. priorityFromSource maps this to "high" priority.
 *   WHISPER_CAPS.high = 3 (per turn, all sources combined).
 *   PER_SOURCE_CAP = 2 (per source per turn).
 *
 *   If 3+ high-priority whispers already fired in the same turn, the timer
 *   whisper is silently dropped (log.debug only). The agent never sees the
 *   reminder. The user perceives "timer didn't fire."
 *
 * BACKUP CHANNEL: emitTimerReminder pushes to a queue that the heartbeat-
 * scheduler's timer-reminder module drains on the next turn_end, delivering
 * via ctx.whisper (which is uncapped, but delayed by one turn).
 *
 * This test pins down the exact failure mode so it can't regress silently.
 *
 * FIX DIRECTION: promote "timer/fire" to "critical" priority in
 * priorityFromSource — bypasses the high cap while keeping per-source
 * fairness (max 2 timer fires per turn).
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
  if (/tool-safety|auto-singleton|auto-recovery|turn-outcome\/loop/.test(source)) {
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

  it("WHISPER_CAPS.high = 3 (the limit before timer fires are suppressed)", () => {
    assert.equal(WHISPER_CAPS.high, 3);
  });

  it("3 high-priority whispers pass; 4th is suppressed", () => {
    beginTurn();
    assert.equal(tryWhisper("high", "enforcement/whisper"), true);
    assert.equal(tryWhisper("high", "enforcement/whisper"), true);
    assert.equal(tryWhisper("high", "compaction-retry/exhausted"), true);
    assert.equal(tryWhisper("high", "timer/fire"), false, "timer is the 4th high → suppressed");
    assert.equal(_snapshot().suppressed, 1);
  });

  it("3 timer fires in same turn: 1st and 2nd pass, 3rd is per-source suppressed", () => {
    beginTurn();
    assert.equal(tryWhisper("high", "timer/fire"), true);
    assert.equal(tryWhisper("high", "timer/fire"), true);
    assert.equal(tryWhisper("high", "timer/fire"), false, "per-source cap (PER_SOURCE_CAP=2)");
  });
});

// ── Source-priority mapping ────────────────────────────────────────────────

describe("Timer source → priority mapping", () => {
  it("user-set timer (wake default = true) → triggerTurn=true → high", () => {
    // From src/extensions/scheduling/timer/index.ts:
    //   setTimer(... wake: boolean = true)  // default true
    //   fireTimer: const triggerTurn = timer.wake === true
    //   timer tool: setTimer(sessionId, delay, reason, tag) // wake defaults to true
    const wake = true;
    const triggerTurn = wake === true;
    assert.equal(priorityFromSource("timer/fire", { triggerTurn }), "high");
  });

  it("compaction-resume timer (wake=true) → high", () => {
    // From register-session-compact.ts:
    //   scheduleTimer(sessionId, 3*60*1000, "...", "compaction-resume", true)
    const triggerTurn = true;
    assert.equal(priorityFromSource("timer/fire", { triggerTurn }), "high");
  });
});

// ── End-to-end through sendTrackedMessage (the actual fire path) ───────────

describe("Timer fire end-to-end through sendTrackedMessage", () => {
  beforeEach(() => {
    _resetForTests();
    clearAllBuckets();
  });

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

  it("REGRESSION: timer fire in fresh turn reaches the runtime", () => {
    beginTurn();
    const pi = makeMockPi();
    fireTimerWhisper(pi);
    const timerSent = pi.sent.filter((m) => m.params.customType === "timer");
    assert.equal(timerSent.length, 1, "fresh turn → timer reaches runtime");
  });

  it("REGRESSION: timer fire after 3 high-priority whispers is silently dropped", () => {
    beginTurn();
    const pi = makeMockPi();

    // Simulate the realistic degraded-turn scenario
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

    // The 4th high-priority whisper — the timer — must not reach the runtime
    fireTimerWhisper(pi);

    const timerSent = pi.sent.filter((m) => m.params.customType === "timer");
    assert.equal(
      timerSent.length,
      0,
      "timer was silently suppressed — the user sees nothing in this turn",
    );
    // The 3 high-priority whispers DID reach
    assert.equal(pi.sent.length, 3);

    // The suppression is recorded in the injection log (for diagnostics)
    const suppressed = getInjections().find((i) => i.source === "timer/fire");
    assert.ok(suppressed, "suppression recorded in injection log");
    assert.equal(suppressed.display, false);
  });

  it("REGRESSION: 3rd timer fire in same turn is per-source suppressed", () => {
    beginTurn();
    const pi = makeMockPi();
    fireTimerWhisper(pi);
    fireTimerWhisper(pi);
    fireTimerWhisper(pi);

    const timerSent = pi.sent.filter((m) => m.params.customType === "timer");
    assert.equal(timerSent.length, 2, "only 2 timer fires reach (3rd is per-source capped)");
  });
});

// ── Backup channel: timer-bus → heartbeat-scheduler ───────────────────────

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
