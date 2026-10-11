/**
 * Test: WHISPER REPRIME SUPPRESSION .
 *
 * Pins the cross-call exact-repeat de-bloat added at sendTrackedMessage, the
 * single delivery chokepoint. turn-dedup.ts only caps whispers WITHIN a single
 * turn — its per-turn window closes on each `input` — so a body that
 * legitimately re-fires after its window closes (turn after turn, each a fresh
 * token load) was previously re-injected with zero dedup. The benchmark
 * measured 41% of 7,690 whisper deliveries (3,129) as exact-repeat bodies
 * re-injected within the same session.
 *
 * Contract:
 * - first occurrence of a body always fires;
 * - an identical body re-fired within REPRIME_COOLDOWN_MS is SUPPRESSED;
 * - a digit-drifting / whitespace-drifting body (same tool, ticking
 * counters) is SUPPRESSED — numeric drift is noise (MARS dedup lesson);
 * - a structurally different body RE-DELIVERS;
 * - triggerTurn:true wakes always pass (a dropped wake is a correctness bug);
 * - after REPRIME_COOLDOWN_MS elapses, the same body re-fires (the cooldown
 * window actually closes — pinned via the exported clock hook).
 *
 * The clock hook (_setReprimeClockForTests) proves the 20-minute window
 * without waiting real minutes; reset to null between tests.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { sendTrackedMessage, clearAllBuckets, REPRIME_COOLDOWN_MS, _setReprimeClockForTests } =
  await import("../../../dist/lib/utils/injection-tracker.js");
const { _resetForTests } = await import("../../../dist/lib/enforcement/turn-dedup.js");

/** Fake pi whose sendMessage records deliveries (nothing else wires up). */
function makeFakePi() {
  const sent = [];
  return {
    sent,
    sendMessage(params, options) {
      sent.push({ params, options });
    },
    sendUserMessage() {},
  };
}

/**
 * Fire a whisper through the real sendTrackedMessage trunk. Same source
 * ("enforcement/whisper") unless overridden, so the envelope prefix matches
 * and only the body determines the reprime key.
 */
function send(pi, body, options, source = "enforcement/whisper") {
  sendTrackedMessage(
    pi,
    {
      customType: "reprime-test",
      content: [{ type: "text", text: body }],
      display: true,
    },
    options,
    { type: "enforcement", source },
  );
}

/** sendTrackedMessage defers triggerTurn:true to setTimeout(0) — flush it. */
function flushDeferred() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("WHISPER REPRIME SUPPRESSION", () => {
  beforeEach(() => {
    _resetForTests(); // fresh per-turn whisper caps (default session)
    clearAllBuckets(); // fresh buckets + per-session reprime state
    _setReprimeClockForTests(null);
  });

  afterEach(() => {
    _setReprimeClockForTests(null);
  });

  it("first occurrence of a body always fires", () => {
    const pi = makeFakePi();
    send(pi, "Some reminder body");
    assert.equal(pi.sent.length, 1, "first occurrence must reach pi.sendMessage");
    assert.match(
      pi.sent[0].params.content[0].text,
      /^\[braid-whisper - enforcement @ [^\]]+\]\nSome reminder body/,
      "the delivered body carries the universal envelope",
    );
  });

  it("suppresses an identical body re-fired within the cooldown", () => {
    const pi = makeFakePi();
    send(pi, "Some reminder body");
    assert.equal(pi.sent.length, 1, "first occurrence fires");

    send(pi, "Some reminder body"); // immediate re-fire, same body
    assert.equal(
      pi.sent.length,
      1,
      "identical re-fire within REPRIME_COOLDOWN_MS must be suppressed",
    );
  });

  it("suppresses a digit-drifting / whitespace-drifting body (ticking counters)", () => {
    const pi = makeFakePi();
    send(pi, "bash used 25/30 tool-turns (83%). Assess intent.");
    assert.equal(pi.sent.length, 1, "first occurrence fires");

    send(pi, "bash used 27/34 tool-turns (79%). Assess intent.");
    assert.equal(pi.sent.length, 1, "ticking counters collapse to '#' — same key, suppressed");

    send(pi, "bash   used  28/35  tool-turns (80%).  Assess intent.");
    assert.equal(pi.sent.length, 1, "whitespace drift also normalizes equal — suppressed");
  });

  it("boundary-aware key: identifier digits stay distinct (30s vs 60s)", () => {
    const pi = makeFakePi();
    send(pi, "[timer] 30s elapsed");
    send(pi, "[timer] 60s elapsed");
    assert.equal(
      pi.sent.length,
      2,
      "digits embedded in a unit are signal — two different timer bodies both deliver",
    );

    // Same body, counter drift -> the reprime target still collapses.
    send(pi, "bash used 25/30 tool-turns (83%). Assess intent.");
    send(pi, "bash used 27/34 tool-turns (79%). Assess intent.");
    assert.equal(pi.sent.length, 3, "standalone counters still collapse to '#' — suppressed");
  });

  it("a structurally different body re-delivers (not suppressed)", () => {
    const pi = makeFakePi();
    send(pi, "watch for edit loops");
    send(pi, "context is at 80% and rising");
    assert.equal(pi.sent.length, 2, "different bodies have different keys and both deliver");
  });

  it("a different source with the same body re-delivers (source is part of the key)", () => {
    const pi = makeFakePi();
    send(pi, "watch for edit loops", undefined, "enforcement/whisper");
    send(pi, "watch for edit loops", undefined, "dreamer/whisper");
    assert.equal(pi.sent.length, 2, "same text from a different subsystem is a different whisper");
  });

  it("triggerTurn:true wakes always pass (never reprime-suppressed)", async () => {
    const pi = makeFakePi();
    send(pi, "wake body", { triggerTurn: true });
    send(pi, "wake body", { triggerTurn: true });
    await flushDeferred();
    assert.equal(
      pi.sent.length,
      2,
      "identical triggerTurn:true wakes must both reach pi.sendMessage (bypass)",
    );
  });

  it("after REPRIME_COOLDOWN_MS elapses, the same body re-fires", () => {
    const pi = makeFakePi();

    _setReprimeClockForTests(10_000);
    send(pi, "persistent nudge");
    assert.equal(pi.sent.length, 1, "first occurrence fires");

    _setReprimeClockForTests(10_000 + REPRIME_COOLDOWN_MS - 1);
    send(pi, "persistent nudge");
    assert.equal(
      pi.sent.length,
      1,
      "1ms before the window closes — still suppressed (now - last < COOLDOWN)",
    );

    _setReprimeClockForTests(10_000 + REPRIME_COOLDOWN_MS + 1);
    send(pi, "persistent nudge");
    assert.equal(pi.sent.length, 2, "after the window closes the same body re-fires");
  });

  it("clearAllBuckets resets reprime state so the same body can fire again", () => {
    const pi = makeFakePi();
    send(pi, "ephemeral body");
    assert.equal(pi.sent.length, 1, "first occurrence fires");

    send(pi, "ephemeral body");
    assert.equal(pi.sent.length, 1, "re-fire suppressed");

    clearAllBuckets(); // session reset (e.g. session_start fresh)
    send(pi, "ephemeral body");
    assert.equal(pi.sent.length, 2, "after a reset the same body is a first occurrence again");
  });
});
