/**
 * EW-7.9: Session Signals bundle is gated per-sub-signal.
 *
 * HISTORY (2026-06-15):
 *   L2 "Session Signals" was bundled into a single string and gated
 *   by `shouldSendNudge("scratchpad", bundled)`. Adding one new L2 line
 *   (e.g. a memory nudge on top of an existing scratchpad nudge) changed
 *   the bundle's hash, which re-armed the entire bundle -- previously
 *   suppressed signals would fire again as soon as anything else was
 *   added. This made the L2 bundle unreliable in long sessions.
 *
 * FIX:
 *   - NudgeManager.shouldSendNudge() now accepts an optional `subKey`
 *     parameter. When set, the call's history (cooldown + dedup) is
 *     isolated from other sub-signals of the same NudgeType.
 *   - Add `"sessionSignals"` to the NudgeType enum with config matching
 *     the old bundle (60s cooldown, dedup true, escalate 2).
 *   - turn-end-handler.ts pushes `{key, content}` per sub-signal and
 *     loops through them, only bundling + sending the ones that pass
 *     the per-signal gate.
 *
 * This test pins the runtime contract (independent per-subKey history).
 */

import { strict as assert } from "node:assert";

// Import the compiled module so we can exercise runtime behavior.
const { NudgeManager, DEFAULT_NUDGE_CONFIGS } = await import(
  "../../../dist/extensions/enforcement/nudge-manager.js"
);

console.log("=== EW-7.9: Session Signals per-signal gating ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(`  [x] ${name}: ${e.message}`);
    failed++;
  }
}

// ── Runtime contract: per-subKey history isolation ──────────────────────

test("sessionSignals is a registered NudgeType", () => {
  assert.ok(
    "sessionSignals" in DEFAULT_NUDGE_CONFIGS,
    "sessionSignals must be in DEFAULT_NUDGE_CONFIGS",
  );
  const cfg = DEFAULT_NUDGE_CONFIGS.sessionSignals;
  assert.equal(typeof cfg.baseCooldownMs, "number");
  assert.equal(typeof cfg.escalateAfter, "number");
  assert.equal(typeof cfg.deduplicate, "boolean");
});

test("sessionSignals config matches the old bundle behavior (60s cooldown, dedup)", () => {
  assert.equal(DEFAULT_NUDGE_CONFIGS.sessionSignals.baseCooldownMs, 60_000);
  assert.equal(DEFAULT_NUDGE_CONFIGS.sessionSignals.deduplicate, true);
  assert.equal(DEFAULT_NUDGE_CONFIGS.sessionSignals.escalateAfter, 2);
});

test("different subKeys have independent cooldown history", () => {
  const nm = new NudgeManager();
  const a1 = nm.shouldSendNudge("sessionSignals", "memory nudge content", "memory", 100_000);
  assert.equal(a1.shouldSend, true, "first memory signal should pass");
  const a2 = nm.shouldSendNudge("sessionSignals", "memory nudge content", "memory", 110_000);
  assert.equal(a2.shouldSend, false, "memory cooldown blocks repeat");
  const b1 = nm.shouldSendNudge(
    "sessionSignals",
    "scratchpad nudge content",
    "scratchpad",
    110_000,
  );
  assert.equal(
    b1.shouldSend,
    true,
    "scratchpad signal should pass at T=110s (independent history from memory)",
  );
});

test("different subKeys have independent dedup history", () => {
  const nm = new NudgeManager();
  assert.equal(
    nm.shouldSendNudge("sessionSignals", "m1", "memory", 100_000).shouldSend,
    true,
  );
  assert.equal(
    nm.shouldSendNudge("sessionSignals", "s1", "scratchpad", 100_000).shouldSend,
    true,
  );
  const scratchpadRepeat = nm.shouldSendNudge(
    "sessionSignals",
    "s2",
    "scratchpad",
    999_999,
  );
  assert.equal(
    scratchpadRepeat.shouldSend,
    true,
    "scratchpad signal re-fires with new content (cross-subKey independence)",
  );
  const memoryRepeat = nm.shouldSendNudge(
    "sessionSignals",
    "m1",
    "memory",
    999_999,
  );
  assert.equal(
    memoryRepeat.shouldSend,
    false,
    "memory signal deduped within its own subKey (m1 already sent)",
  );
});

test("legacy 2-arg call still works (backward compat)", () => {
  const nm = new NudgeManager();
  const r1 = nm.shouldSendNudge("sessionSignals", "no-subKey content", undefined, 100_000);
  assert.equal(r1.shouldSend, true);
  const r2 = nm.shouldSendNudge(
    "sessionSignals",
    "no-subKey content",
    undefined,
    999_999,
  );
  assert.equal(
    r2.shouldSend,
    false,
    "2-arg caller should still dedup (key reduces to type alone)",
  );
});

test("without subKey, two callers share history (legacy behavior)", () => {
  const nm = new NudgeManager();
  assert.equal(
    nm.shouldSendNudge("sessionSignals", "alpha", undefined, 100_000).shouldSend,
    true,
  );
  const r = nm.shouldSendNudge("sessionSignals", "beta", undefined, 110_000);
  assert.equal(r.shouldSend, false, "cooldown blocks subsequent 2-arg calls");
});

test("getHistory returns per-subKey history", () => {
  const nm = new NudgeManager();
  assert.equal(nm.getHistory("sessionSignals", "memory"), undefined);
  nm.shouldSendNudge("sessionSignals", "m-content", "memory", 100_000);
  const h = nm.getHistory("sessionSignals", "memory");
  assert.ok(h, "memory history must exist after fire");
  assert.equal(h.lastSent, 100_000);
  assert.equal(h.count, 1);
  assert.equal(
    nm.getHistory("sessionSignals", "scratchpad"),
    undefined,
    "scratchpad history independent",
  );
});

test("bundling behavior: 4 distinct sub-signals all fire on first turn", () => {
  const nm = new NudgeManager();
  const results = [
    nm.shouldSendNudge("sessionSignals", "memory content", "memory", 100_000),
    nm.shouldSendNudge("sessionSignals", "scratchpad content", "scratchpad", 100_000),
    nm.shouldSendNudge("sessionSignals", "think content", "think", 100_000),
    nm.shouldSendNudge("sessionSignals", "localization content", "localization", 100_000),
  ];
  assert.ok(results.every((r) => r.shouldSend), "all 4 sub-signals fire on first turn");
});

test("the bug: previously-suppressed signal is NOT re-armed by new signals", () => {
  const nm = new NudgeManager();
  nm.shouldSendNudge("sessionSignals", "m-content-v1", "memory", 100_000);
  const turn2Memory = nm.shouldSendNudge(
    "sessionSignals",
    "m-content-v1",
    "memory",
    110_000,
  );
  assert.equal(turn2Memory.shouldSend, false, "memory in cooldown + dedup");
  const turn2Scratchpad = nm.shouldSendNudge(
    "sessionSignals",
    "s-content-v1",
    "scratchpad",
    110_000,
  );
  assert.equal(turn2Scratchpad.shouldSend, true, "scratchpad fires independently");
  const turn3Memory = nm.shouldSendNudge(
    "sessionSignals",
    "m-content-v2",
    "memory",
    170_000,
  );
  assert.equal(
    turn3Memory.shouldSend,
    true,
    "memory fires after cooldown with new content",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== EW-7.9 Session Signals per-signal tests passed ===");