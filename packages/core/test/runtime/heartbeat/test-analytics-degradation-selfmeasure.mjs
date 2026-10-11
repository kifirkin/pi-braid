/**
 * SELF-MEASUREMENT — degradation whisper enriched with round-21t
 * counters.
 *
 * The heartbeat/analytics turn_end degradation branch now appends compaction
 * loss + drift-signal summaries (via the canonical formatCompactionLossLine /
 * formatDriftLine one-liners) to the emitSignal payload and the event-bus
 * analytics_alert. The tracked-message whisper is FOLDED (whisper-REVIEW .3):
 * self/auto-recovery is the single degradation emitter; the signal data still
 * tells WHY beyond raw error count.
 *
 * This fixture drives the REAL analytics turn_end handler on a mock pi+ctx
 * (same harness as test-loop-emitter-consolidation.mjs), asserts:
 * 1. With nonzero compaction-loss/drift telemetry, the stability/decline
 * signal data carries `compactionLoss` + `drift`, and NO degradation
 * whisper is delivered (folded — self/auto-recovery is the emitter).
 * 2. With nothing loss-worthy (formatters return null), behavior is
 * byte-identical to pre-change: no compactionLoss/drift keys in the
 * signal data, and no whisper delivered.
 *
 * Run: node test/runtime/heartbeat/test-analytics-degradation-selfmeasure.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const D = join(ROOT, "dist");

// Compiled runtime (npm test builds first).
const { default: analyticsExtension } = await import(
  "file://" + join(D, "extensions/heartbeat/analytics/index.js")
);
const { getSignals } = await import("file://" + join(D, "lib/reasoning/belief-policy-engine.js"));
const { recordTurnMetrics } = await import(
  "file://" + join(D, "lib/detection/degradation-detector.js")
);
const { resetCompactionHealth, recordCompactionOutcome } = await import(
  "file://" + join(D, "extensions/memory/context-manager/handlers/shared.js")
);
const { resetDriftTelemetry, recordDriftSignal } = await import(
  "file://" + join(D, "lib/telemetry/drift-signals.js")
);
const { clearAllBuckets } = await import("file://" + join(D, "lib/utils/injection-tracker.js"));
const { _resetForTests } = await import("file://" + join(D, "lib/enforcement/turn-dedup.js"));

const TURN_END = "turn_end";

console.log("=== Self-measurement: degradation whisper enriched with loss/drift ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch(async (e) => {
      await new Promise((r) => setTimeout(r, 20));
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

/** Fake pi: multi-handler per event (like pi-core), records sendMessage. */
function makePi() {
  const sent = [];
  const pi = {
    handlers: new Map(),
    sent,
    on(event, handler) {
      const arr = this.handlers.get(event) || [];
      arr.push(handler);
      this.handlers.set(event, arr);
    },
    async fire(event, ...args) {
      for (const h of this.handlers.get(event) || []) {
        await Promise.resolve()
          .then(() => h(...args))
          .catch(() => {});
      }
    },
    sendMessage(params, options) {
      sent.push({ params, options });
    },
    sendUserMessage() {},
    sendRegisteredMessages() {},
    registerTool() {},
    registerCommand() {},
  };
  return pi;
}

/** Fresh world per scenario: whisper flood buckets + dedup state cleared. */
function freshWorld() {
  _resetForTests();
  clearAllBuckets();
}

/**
 * Build a degraded ctx: plain object + settingsManager so degradation-detector's
 * isCtx() routes recordTurnMetrics to the ctx-scoped state (0.84.4 guard:
 * sessionManager/modelRegistry presence; per-session Map keyed by the
 * fixture's unique getSessionId — isolated per object).
 */
function degradedCtx(cwd) {
  const ctx = {
    cwd,
    // 0.84.4 ExtensionContext shape: settingsManager REMOVED; the
    // degradation-detector isCtx() guard keys on sessionManager instead.
    sessionManager: { getSessionId: () => `selfmeasure-${cwd}` },
  };
  recordTurnMetrics(ctx, { toolCalls: 3, errors: 3 });
  return ctx;
}

async function fireDegradedTurnEnd(pi, ctx) {
  await pi.fire(
    TURN_END,
    { message: { role: "assistant", content: [], stopReason: "end_turn" } },
    ctx,
  );
}

// ── Scenario A: nonzero compaction-loss + drift -> enriched whisper + signal ─
await test("nonzero loss/drift enriches the degradation whisper + signal data", async () => {
  freshWorld();
  resetCompactionHealth();
  resetDriftTelemetry();

  // Seed BOTH round-21t telemetry singletons with loss-worthy state.
  recordCompactionOutcome("failure", { errorMessage: "boom" });
  recordCompactionOutcome("aborted", { inFlight: true, errorMessage: "cancelled" });
  recordDriftSignal("rereads", 1);
  recordDriftSignal("stalePaths", 2);

  const pi = makePi();
  analyticsExtension(pi);
  const ctx = degradedCtx("/tmp/selfmeasure-a");

  await fireDegradedTurnEnd(pi, ctx);

  assert.equal(
    pi.sent.length,
    0,
    `degradation whisper folded (whisper-REVIEW §4.3) — no tracked message delivered, got ${pi.sent.length}`,
  );

  // emitSignal payload carries the same lines under their own keys.
  const signals = getSignals(ctx);
  const sig = signals.find((s) => s.source === "stability" && s.type === "decline");
  assert.ok(sig, "a stability/decline signal was emitted");
  assert.equal(
    sig.data.compactionLoss,
    "compaction loss: 1 in-flight aborts, 1 failures, 0 compacts",
  );
  assert.equal(
    sig.data.drift,
    "drift signals: 1 re-reads, 0 repeated failures, 1 stale paths, 0 goal shifts",
  );
  assert.equal(sig.data.consecutiveErrors, 3);
  assert.equal(
    sig.data.reason,
    "High consecutive errors (max: 3)",
    "existing reason field preserved alongside the new keys",
  );
});

// ── Scenario B: nothing loss-worthy -> byte-identical to pre-change ─────────
await test("nothing loss-worthy: no extra text, no new signal-data keys", async () => {
  freshWorld();
  resetCompactionHealth();
  resetDriftTelemetry();

  const pi = makePi();
  analyticsExtension(pi);
  const ctx = degradedCtx("/tmp/selfmeasure-b");

  await fireDegradedTurnEnd(pi, ctx);

  assert.equal(
    pi.sent.length,
    0,
    `degradation whisper folded — no tracked message delivered, got ${pi.sent.length}`,
  );

  const sig = getSignals(ctx).find((s) => s.source === "stability" && s.type === "decline");
  assert.ok(sig, "a stability/decline signal was emitted");
  assert.ok(
    !("compactionLoss" in sig.data) && !("drift" in sig.data),
    "signal data has no compactionLoss/drift keys when nothing loss-worthy",
  );
  assert.deepEqual(
    { reason: sig.data.reason, consecutiveErrors: sig.data.consecutiveErrors },
    { reason: "High consecutive errors (max: 3)", consecutiveErrors: 3 },
    "existing data shape unchanged",
  );
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
