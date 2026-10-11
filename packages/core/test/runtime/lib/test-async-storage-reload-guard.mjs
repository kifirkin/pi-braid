/**
 * Test: Async Storage reload-stacking guard.
 *
 * pi /reload re-evaluates the extension import tree, so the module-level
 * `process.on("beforeExit"/"SIGINT"/"SIGTERM")` calls registered a fresh
 * handler trio on EVERY module re-execution -> handler stacking -> redundant
 * flushAll on exit. The fix gates registration on a `globalThis` marker inside
 * `ensureShutdownHandlers()` (registered exactly once per process).
 *
 * Reloads are simulated via cache-busting re-imports (?v=N) of the built
 * module. The module's OWN handler count is measured as the delta from a
 * pre-import baseline (a fresh `node` process sits at 0 for all three
 * signals) rather than as total process listeners, so handlers pi-core or
 * any other module adds are excluded.
 *
 * IMPORTANT: node:test itself registers an extra `beforeExit` listener as
 * soon as the `describe()` call hooks up. All handler-count measurements
 * therefore happen at module top-level BEFORE the describe call, where the
 * process is clean; the `it` blocks assert against those captured snapshots.
 *
 * REVERT-PROOF: pre-fix source (no globalThis marker, module-level process.on
 * re-registers on every load) drives the delta to 4 per signal after the four
 * cache-busted loads below and fails the first assertion.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SIGNALS = ["beforeExit", "SIGINT", "SIGTERM"];

// Baseline measured before any import of the module under test. In a fresh
// `node` process (spawned by scripts/run-tests.mjs) this is 0 for all three
// signals, so the delta isolates this module's own handlers.
const baseline = Object.fromEntries(SIGNALS.map((s) => [s, process.listenerCount(s)]));

// Cache-busting re-imports (?v=N) force module re-execution, simulating the
// /reload re-evaluation of the extension import tree.
const mod = await import("../../../dist/lib/state/async-storage.js?v=1");
await import("../../../dist/lib/state/async-storage.js?v=2");
await import("../../../dist/lib/state/async-storage.js?v=3");
await import("../../../dist/lib/state/async-storage.js?v=4");

// Measured at top level, BEFORE describe() hookup (node:test would otherwise
// add a beforeExit listener and inflate the beforeExit delta by 1).
function measureDeltas() {
  return Object.fromEntries(SIGNALS.map((s) => [s, process.listenerCount(s) - baseline[s]]));
}
const deltasAfterLoads = measureDeltas();

// Direct calls must be idempotent (the exported guard is the testable seam).
mod.ensureShutdownHandlers();
mod.ensureShutdownHandlers();
mod.ensureShutdownHandlers();
const deltasAfterDirectCalls = measureDeltas();

describe("async-storage reload-stacking guard", () => {
  it("registers exactly one handler per signal across simulated reloads", () => {
    for (const signal of SIGNALS) {
      const delta = deltasAfterLoads[signal];
      assert.equal(
        delta,
        1,
        `${signal}: module holds ${delta} handlers after 4 loads (expected 1 — reload-stacking guard failed)`,
      );
    }
  });

  it("ensureShutdownHandlers() is idempotent when called directly", () => {
    assert.deepEqual(deltasAfterDirectCalls, { beforeExit: 1, SIGINT: 1, SIGTERM: 1 });
  });

  it("flushAll still persists pending writes (behavior unchanged)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "braid-async-storage-"));
    const file = join(dir, "state.json");
    try {
      // saveStateImmediate awaits flushAll inline -> deterministic write.
      await mod.saveStateImmediate(file, { hello: "world", n: 1 });
      const content = JSON.parse(await readFile(file, "utf-8"));
      assert.deepEqual(content, { hello: "world", n: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

console.log(
  `\n📊 Results: module handler deltas after 4 cache-busted loads = ${JSON.stringify(deltasAfterLoads)}`,
);
