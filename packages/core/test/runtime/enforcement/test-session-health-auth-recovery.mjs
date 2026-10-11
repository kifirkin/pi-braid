/**
 * session-health auth/balance probe + recovery .
 *
 * Drives the REAL enforcement/session-health module and asserts:
 * 1. Initial escalation NOT weakened: the FIRST auth error latches mode
 * "auth"immediately (fast latch on a genuine 401 burst).
 * 2. recordConsolidationSkip counts skipped consolidations per mode.
 * 3. Probe path: after the bounded quiet window (5 min), tickSessionHealth
 * clears the error window; the next successful LLM call clears the mode
 * (consolidation unblocked). A fresh 401 re-latches instantly.
 * 4. Streak path: 10 consecutive successes clear the mode even without a
 * probe tick.
 * 5. Balance mode clears the same way (it shared the never-clears bug).
 * 6. recordLlmSuccess still does NOT clear degraded before the healthy
 * turn threshold (existing behavior preserved).
 *
 * Run: node test/runtime/enforcement/test-session-health-auth-recovery.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const D = join(ROOT, "dist");

const {
  getSessionHealth,
  recordLlmError,
  recordLlmSuccess,
  recordConsolidationSkip,
  tickSessionHealth,
  resetSessionHealth,
} = await import("file://" + join(D, "extensions/enforcement/session-health.js"));
const { classifyLlmError } = await import("file://" + join(D, "lib/errors/llm-error.js"));

console.log("=== session-health auth probe/recovery ===\n");

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

function freshCtx() {
  // Plain object: getExtensionState falls back to the WeakMap bucket keyed
  // on the ctx reference — every freshCtx() is a distinct session.
  return { cwd: "/tmp/w9-auth-" + Math.random().toString(36).slice(2) };
}

function classified401() {
  return classifyLlmError("HTTP 401 unauthorized: invalid api key");
}

await test("auth latches FAST on the first 401 (initial escalation not weakened)", () => {
  const ctx = freshCtx();
  assert.equal(getSessionHealth(ctx).mode, "healthy");
  recordLlmError(ctx, classified401());
  const s = getSessionHealth(ctx);
  assert.equal(s.mode, "auth", "one 401 latches auth immediately");
  assert.equal(s.providerErrorsByCategory.auth, 1);
});

await test("consolidation-skips-by-mode counter records skips (baseline metric)", () => {
  const ctx = freshCtx();
  recordLlmError(ctx, classified401());
  recordConsolidationSkip(ctx, "auth");
  recordConsolidationSkip(ctx, "auth");
  recordConsolidationSkip(ctx, "balance");
  const s = getSessionHealth(ctx);
  assert.equal(s.consolidationSkipsByMode.auth, 2);
  assert.equal(s.consolidationSkipsByMode.balance, 1);
  resetSessionHealth(ctx);
  assert.deepEqual(
    getSessionHealth(ctx).consolidationSkipsByMode,
    {},
    "full reset clears the counter",
  );
});

await test("probe path: quiet window + one success clears auth; fresh 401 re-latches instantly", () => {
  const ctx = freshCtx();
  recordLlmError(ctx, classified401());
  assert.equal(getSessionHealth(ctx).mode, "auth");

  // Inside the probe window: tick does nothing.
  tickSessionHealth(ctx);
  assert.equal(getSessionHealth(ctx).mode, "auth", "still inside the bounded quiet window");

  // Jump past the 5-minute quiet window: the tick clears the ERROR WINDOW
  // (probe armed; mode stays latched until a call proves recovery).
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 6 * 60 * 1000;
    tickSessionHealth(ctx);
  } finally {
    Date.now = realNow;
  }
  assert.equal(getSessionHealth(ctx).mode, "auth", "probe arms but does not clear by itself");
  assert.equal(getSessionHealth(ctx).firstErrorAt, undefined, "error window cleared (probe armed)");

  // The next successful LLM call proves the provider is back -> healthy.
  recordLlmSuccess(ctx);
  assert.equal(getSessionHealth(ctx).mode, "healthy", "successful probe clears the mode");

  // A genuine 401 burst re-latches immediately (recovery did not weaken it).
  recordLlmError(ctx, classified401());
  assert.equal(getSessionHealth(ctx).mode, "auth", "fresh 401 re-latches");
});

await test("auth re-latches on error during the probe window (no recovery thrash)", () => {
  const ctx = freshCtx();
  recordLlmError(ctx, classified401());
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 6 * 60 * 1000;
    tickSessionHealth(ctx); // probe armed
  } finally {
    Date.now = realNow;
  }
  // The probe call itself fails with a 401: immediate re-latch, window re-armed.
  recordLlmError(ctx, classified401());
  const s = getSessionHealth(ctx);
  assert.equal(s.mode, "auth");
  assert.ok(s.firstErrorAt != null, "error window re-armed by the failed probe");
});

await test("streak path: 10 consecutive successes clear auth without a probe tick", () => {
  const ctx = freshCtx();
  recordLlmError(ctx, classified401());
  assert.equal(getSessionHealth(ctx).mode, "auth");

  for (let i = 0; i < 9; i++) recordLlmSuccess(ctx);
  assert.equal(getSessionHealth(ctx).mode, "auth", "9 successes: not enough yet");

  recordLlmSuccess(ctx); // 10th
  assert.equal(getSessionHealth(ctx).mode, "healthy", "10-success streak clears auth");
  assert.ok(getSessionHealth(ctx).firstErrorAt == null);
});

await test("balance mode recovers through the same two paths (shared fix)", () => {
  const ctx = freshCtx();
  const balanceErr = classifyLlmError("insufficient balance / 402 payment required");
  assert.equal(balanceErr.category, "balance");
  recordLlmError(ctx, balanceErr);
  assert.equal(getSessionHealth(ctx).mode, "balance");

  // Streak path (no time travel needed).
  for (let i = 0; i < 10; i++) recordLlmSuccess(ctx);
  assert.equal(getSessionHealth(ctx).mode, "healthy", "balance clears via the success streak");
});

await test("degraded still needs the healthy-turn threshold (existing behavior unchanged)", () => {
  const ctx = freshCtx();
  for (let i = 0; i < 3; i++) recordLlmError(ctx, classifyLlmError("ETIMEDOUT"));
  assert.equal(getSessionHealth(ctx).mode, "degraded");
  recordLlmSuccess(ctx);
  assert.equal(getSessionHealth(ctx).mode, "degraded", "one success does not clear degraded");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
