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
 * This test pins both the runtime contract (independent per-subKey
 * history) and the source-level contract (the handler uses the new API).
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  nudgeManager: join(ROOT, "src/extensions/enforcement/nudge-manager.ts"),
  turnEndHandler: join(ROOT, "src/extensions/enforcement/handlers/turn-end-handler.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source file should exist at ${path}`);
}

const nudgeSrc = readFileSync(FILES.nudgeManager, "utf-8");
const handlerSrc = readFileSync(FILES.turnEndHandler, "utf-8");

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
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
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
  // Pre-fix: the bundle used `"scratchpad"` config (60s cooldown, dedup
  // true, escalate 2). The new sessionSignals config should mirror this
  // so per-signal behavior is comparable to the old bundled behavior.
  assert.equal(DEFAULT_NUDGE_CONFIGS.sessionSignals.baseCooldownMs, 60_000);
  assert.equal(DEFAULT_NUDGE_CONFIGS.sessionSignals.deduplicate, true);
  assert.equal(DEFAULT_NUDGE_CONFIGS.sessionSignals.escalateAfter, 2);
});

test("different subKeys have independent cooldown history", () => {
  const nm = new NudgeManager();
  // T=100_000 (past the initial 60s cooldown window from lastSent=0)
  const a1 = nm.shouldSendNudge("sessionSignals", "memory nudge content", "memory", 100_000);
  assert.equal(a1.shouldSend, true, "first memory signal should pass");
  // T=110_000 (within 60s of last memory fire)
  const a2 = nm.shouldSendNudge("sessionSignals", "memory nudge content", "memory", 110_000);
  assert.equal(a2.shouldSend, false, "memory cooldown blocks repeat");
  // Signal B at T=110_000 -- independent history, passes immediately
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
  // Fire memory with content "m1" and scratchpad with content "s1" at
  // T=100_000 (past initial cooldown). Both should fire.
  assert.equal(
    nm.shouldSendNudge("sessionSignals", "m1", "memory", 100_000).shouldSend,
    true,
  );
  assert.equal(
    nm.shouldSendNudge("sessionSignals", "s1", "scratchpad", 100_000).shouldSend,
    true,
  );
  // At T=999_999 (cooldown expired), try NEW content "s2" for
  // scratchpad. The old bundle bug would have hashed the entire bundle
  // including memory's content; cross-subKey independence means
  // scratchpad's content change is enough to re-fire it without
  // memory's involvement.
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
  // Same content "m1" for memory at T=999_999 -- should dedup within
  // memory's own subKey history.
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
  // Same content + same effective key ("sessionSignals" alone) -> deduped
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
  // Different content but same key (no subKey -> key="sessionSignals")
  const r = nm.shouldSendNudge("sessionSignals", "beta", undefined, 110_000);
  // Cooldown blocks (within 60s of last fire)
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
  // Other subKey still empty
  assert.equal(
    nm.getHistory("sessionSignals", "scratchpad"),
    undefined,
    "scratchpad history independent",
  );
});

test("bundling behavior: 4 distinct sub-signals all fire on first turn", () => {
  // This is the user-facing promise: when memory, scratchpad, think,
  // and context signals all trigger in the same turn, they should all
  // appear in the bundle (no cross-subKey dedup).
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
  // Reproduces the original EW-7.9 bug at the unit level.
  const nm = new NudgeManager();
  // Turn 1: memory fires.
  nm.shouldSendNudge("sessionSignals", "m-content-v1", "memory", 100_000);
  // Turn 2 (cooldown still active for memory): memory suppressed
  // because same content repeats within 60s.
  const turn2Memory = nm.shouldSendNudge(
    "sessionSignals",
    "m-content-v1",
    "memory",
    110_000,
  );
  assert.equal(turn2Memory.shouldSend, false, "memory in cooldown + dedup");
  // Same turn, scratchpad fires (different content, independent slot).
  const turn2Scratchpad = nm.shouldSendNudge(
    "sessionSignals",
    "s-content-v1",
    "scratchpad",
    110_000,
  );
  assert.equal(turn2Scratchpad.shouldSend, true, "scratchpad fires independently");
  // Turn 3: memory cooldown expired AND new content. Should fire.
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
  // Old bundle behavior: memory would have been re-armed on Turn 2 by
  // scratchpad's presence in the bundled string. Now memory is
  // decoupled -- adding scratchpad does not touch memory's history.
});

// ── Source-level contract: handler uses per-signal gating ───────────────

test("NudgeType enum includes sessionSignals with EW-7.9 justification comment", () => {
  assert.match(
    nudgeSrc,
    /\|\s*"sessionSignals"\s*;?/,
    "NudgeType union must include sessionSignals",
  );
  assert.match(
    nudgeSrc,
    /EW-7\.9/,
    "EW-7.9 comment must reference the new type or config",
  );
});

test("NudgeManager.shouldSendNudge accepts optional subKey parameter", () => {
  assert.match(
    nudgeSrc,
    /shouldSendNudge\([^)]*subKey\??:/s,
    "shouldSendNudge signature must include subKey param",
  );
});

test("history map key is composite (type + subKey)", () => {
  assert.match(
    nudgeSrc,
    /`\$\{type\}:\$\{subKey[^`]*\}`/,
    "history key must be `${type}:${subKey}` composite",
  );
});

test("turn-end-handler pushes {key, content} per sub-signal (not raw strings)", () => {
  // At least one site must show the new shape with both `key:` and `content:`
  assert.match(
    handlerSrc,
    /sessionSignals\.push\(\s*\{\s*key:\s*"/,
    "turn-end-handler must push {key, content} objects (not strings)",
  );
});

test("turn-end-handler uses per-signal gating loop (not single bundle call)", () => {
  // The handler must loop through sessionSignals and call shouldSendNudge
  // per signal -- NOT a single call with the concatenated bundle.
  assert.match(
    handlerSrc,
    /for\s*\(\s*const\s+sig\s+of\s+sessionSignals\s*\)/,
    "turn-end-handler must iterate sessionSignals",
  );
  // EW-7.2: per-signal gate now routes through a lookup table that
  // resolves sig.key -> {type, subKey}. The handler must consult this
  // table (or equivalent) rather than hardcoding "sessionSignals".
  assert.match(
    handlerSrc,
    /nudgeTypeForKey\(\s*sig\.key\s*\)/,
    "handler must look up NudgeType per sig.key (EW-7.2)",
  );
  // Negative check: the old single-call pattern must be gone
  assert.ok(
    !/shouldSendNudge\(\s*"scratchpad"\s*,\s*bundled\b/.test(handlerSrc),
    "old single-bundle call (shouldSendNudge(\"scratchpad\", bundled)) must be removed",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== EW-7.9 Session Signals per-signal tests passed ===");