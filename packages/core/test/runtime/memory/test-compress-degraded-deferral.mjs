/**
 * Fixture test (determinized): the compaction
 * DEGRADED path. When batch-settle bookkeeping is unavailable (extension
 * state fails — "state unavailable"), context_compress compact must defer
 * the aborting ctx.compact() by a BOUNDED amount (DEGRADED_DEFERRAL_MS,
 * named + exported so it is the assert target) — never synchronously, and
 * never a raw setTimeout(0) macrotask (that is the exact mid-batch abort
 * race the batch-settle scheduler exists to remove: a still-running
 * parallel sibling's result would be discarded).
 *
 * DETERMINIZED: the original suite probed the real clock with
 * sleeps (`await sleep(min(30, DEFERRAL-1))`vs a 150ms bound) — a
 * load-sensitive race that flaked in full-suite runs. Now a fake setTimeout
 * queue + deterministic `advance()`proves the SAME invariants with zero
 * wall-clock dependence:
 * 1. Direct: scheduleDegradedCompact() — nothing fires synchronously,
 * nothing fires before DEGRADED_DEFERRAL_MS of scheduler time, exactly
 * one fire at the boundary (a setTimeout(0) regression fires during the
 * first advance and is caught).
 * 2. Through the tool: a broken ctx (no valid extension-state resolution)
 * forces scheduleCompactionAtBatchSettle into its catch; spy on the
 * setTimeout schedule and assert it is DEGRADED_DEFERRAL_MS — never 0.
 *
 * Run: node test/runtime/memory/test-compress-degraded-deferral.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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

const { registerContextCompress, scheduleDegradedCompact, DEGRADED_DEFERRAL_MS } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/tools/context-compress.js")
);

function makeFakePi() {
  const handlers = new Map();
  const tools = new Map();
  return {
    handlers,
    tools,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
  };
}

/**
 * Deterministic scheduler: replaces global setTimeout with a queue.
 * Nothing fires until advance(ms) moves fake time forward; only callbacks
 * whose deadline has been reached fire, in schedule order.
 */
function installFakeTimers() {
  const queue = [];
  let now = 0;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => {
    queue.push({ fn, at: now + (typeof ms === "number" ? ms : 0) });
    return queue.length;
  };
  return {
    queue,
    now: () => now,
    advance(deltaMs) {
      now += deltaMs;
      const due = queue.filter((t) => t.at <= now);
      for (const t of due) queue.splice(queue.indexOf(t), 1);
      for (const t of due) t.fn();
      return due.length;
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
    },
  };
}

console.log("=== context_compress degraded-path deferral (deterministic) ===\n");

await test("DEGRADED_DEFERRAL_MS is exported and a positive bounded delay (the assertion target)", () => {
  assert.equal(typeof DEGRADED_DEFERRAL_MS, "number", "constant must be exported from the module");
  assert.ok(
    Number.isInteger(DEGRADED_DEFERRAL_MS) && DEGRADED_DEFERRAL_MS > 0,
    "deferral must be a positive bounded delay",
  );
});

await test("degraded deferral fires exactly at DEGRADED_DEFERRAL_MS — not synchronously, not setTimeout(0) (fake timers)", () => {
  const firedAt = [];
  const timers = installFakeTimers();
  try {
    scheduleDegradedCompact(() => firedAt.push(timers.now()));

    assert.equal(
      firedAt.length,
      0,
      "must NOT fire synchronously (before returning to the event loop)",
    );
    assert.equal(timers.queue.length, 1, "exactly one deferral scheduled");
    assert.equal(
      timers.queue[0].at,
      DEGRADED_DEFERRAL_MS,
      `scheduled at exactly DEGRADED_DEFERRAL_MS (${DEGRADED_DEFERRAL_MS}ms) — a raw setTimeout(0) would schedule at 0`,
    );

    // A raw setTimeout(0) macrotask would have fired within this window;
    // the bounded deferral must still be parked.
    timers.advance(DEGRADED_DEFERRAL_MS - 1);
    assert.equal(
      firedAt.length,
      0,
      `must NOT fire before ${DEGRADED_DEFERRAL_MS}ms of scheduler time (a setTimeout(0) would have)`,
    );

    timers.advance(1);
    assert.equal(firedAt.length, 1, "must fire exactly once at the boundary");
    assert.ok(
      firedAt[0] >= DEGRADED_DEFERRAL_MS,
      `fired at scheduler time ${firedAt[0]}ms — must be >= DEGRADED_DEFERRAL_MS (${DEGRADED_DEFERRAL_MS}ms)`,
    );
  } finally {
    timers.restore();
  }
});

await test("tool compact on a broken ctx reaches the degraded deferral (bounded by DEGRADED_DEFERRAL_MS, never a 0ms schedule)", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  assert.ok(tool, "context_compress tool registered");

  // A ctx with no valid extension-state resolution: getExtensionState throws
  // for a non-object key, so scheduleCompactionAtBatchSettle enters its catch →
  // the bounded degraded deferral ("state unavailable").
  const ctx = null;

  const scheduled = [];
  const realSetTimeout = globalThis.setTimeout;
  // Record-only spy: capture the scheduled delay but NEVER arm a real timer.
  // Arming the real 150ms deferral raced tool.execute(): if the awaited execute
  // took longer than DEGRADED_DEFERRAL_MS under load, the fired trigger called
  // ctx.compact on a null ctx and crashed the process (uncaught TypeError) —
  // a real-timer flake on top of the fake-timer determinization. The
  // contract under test here is the SCHEDULE (the exact fire timing is test
  // 2's job, via fake timers), so the deferral must never fire at all.
  globalThis.setTimeout = (fn, ms) => {
    void fn;
    scheduled.push({ ms });
    return 0; // dummy handle — nothing was armed
  };
  let result;
  try {
    result = await tool.execute("cc", { action: "compact", keep: 50 }, undefined, undefined, ctx);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  void result; // the exact result text on a broken ctx is not the contract — the SCHEDULE is.

  assert.ok(
    scheduled.length >= 1,
    `the degraded path must schedule the deferred compact — got ${JSON.stringify(scheduled)}`,
  );
  assert.ok(
    scheduled.some((s) => s.ms === DEGRADED_DEFERRAL_MS),
    `deferral must be scheduled with DEGRADED_DEFERRAL_MS (${DEGRADED_DEFERRAL_MS}) — got ${JSON.stringify(scheduled)}`,
  );
  assert.ok(
    !scheduled.some((s) => s.ms === 0),
    `the degraded path must NEVER schedule a raw setTimeout(0) — got ${JSON.stringify(scheduled)}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
