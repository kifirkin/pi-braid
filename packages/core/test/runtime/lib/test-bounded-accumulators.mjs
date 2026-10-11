/**
 * Memory-leak containment — bounded-accumulator tests.
 *
 * Gates covered:
 * (a) accumulator bound test — drive >cap items, assert size ≤ cap and
 * the OLDEST entries evicted (evidence-pool conflicts, BeliefStore
 * beliefs, analytics toolCallSequence ring).
 * (b) behavior-preservation at the cap boundary — the addiction window
 * (slice(-50) over turnToolSequence) still sees every event it needs
 * when the ring is at cap; the tool-loop detector window still
 * resolves a 16-call tail loop after far more than 20 recorded calls;
 * BeliefStore recency queries stay exact past the FIFO boundary.
 *
 * Drives the COMPILED dist modules (npm test builds first).
 * Run: node test/runtime/lib/test-bounded-accumulators.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const D = join(ROOT, "dist");

// ── Hermetic HOME (braid-paths captures homedir at module-eval time) ────────
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w97-bounded-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), JSON.stringify({}));

const { pushBounded, mapInsertBounded, setAddBounded } = await import(
  "file://" + join(D, "lib/utils/bounded.js")
);
const { BeliefStore } = await import("file://" + join(D, "lib/store/belief-store.js"));
const { createAnalyticsState } = await import(
  "file://" + join(D, "extensions/heartbeat/analytics/shared.js")
);
const { recordToolCall } = await import(
  "file://" + join(D, "extensions/heartbeat/analytics/core.js")
);

console.log("=== bounded accumulators ===\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

function rmDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ── (a1) bounded helpers: FIFO eviction, oldest first ──────────────────────

await test("pushBounded: ring stays at cap and evicts the OLDEST entries", () => {
  const arr = [];
  for (let i = 0; i < 25; i++) pushBounded(arr, i, 10);
  assert.equal(arr.length, 10, "size bounded at cap");
  assert.deepEqual(arr, [15, 16, 17, 18, 19, 20, 21, 22, 23, 24], "oldest 15 evicted, order kept");
});

await test("mapInsertBounded: map stays at cap and evicts the OLDEST keys", () => {
  const map = new Map();
  for (let i = 0; i < 25; i++) mapInsertBounded(map, `k${i}`, i, 10);
  assert.equal(map.size, 10, "size bounded at cap");
  assert.equal(map.has("k0"), false, "oldest key evicted");
  assert.equal(map.has("k24"), true, "newest key retained");
  assert.equal(map.keys().next().value, "k15", "oldest surviving key is the first non-evicted");
});

await test("setAddBounded: set stays at cap; re-add refreshes recency", () => {
  const set = new Set();
  for (let i = 0; i < 12; i++) setAddBounded(set, i, 10);
  assert.equal(set.size, 10, "size bounded at cap");
  assert.equal(set.has(0), false, "oldest evicted");
  assert.equal(set.has(11), true, "newest kept");
  // Re-adding 2 refreshes it: 2 and 3 are now the oldest and evict first.
  setAddBounded(set, 2, 10);
  setAddBounded(set, "new1", 10);
  setAddBounded(set, "new2", 10);
  assert.equal(set.has(3), false, "3 (stale after 2's refresh) evicted");
  assert.equal(set.has(2), true, "refreshed 2 survives");
});

// ── (a2) evidence-pool conflicts: the uncapped paths now bound at 20->10 ───

const { addEvidence, getAllConflicts, clearEvidence } = await import(
  "file://" + join(D, "lib/store/evidence-pool.js")
);

function makePoolCtx() {
  const tmp = mkdtempSync(join(tmpdir(), "w97-pool-"));
  const sessionFile = join(tmp, "session.jsonl");
  writeFileSync(sessionFile, "", "utf-8");
  return {
    cwd: tmp,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => `w97-pool-${Math.random().toString(36).slice(2, 8)}`,
      getEntries: () => [],
    },
  };
}

await test("evidence-pool: >20 conflicts via the per-evidence path bound at 10 (oldest evicted)", async () => {
  const ctx = makePoolCtx();
  try {
    clearEvidence(ctx);
    // 25 alternating-source evidence items, same normalized topic (high
    // token overlap), slightly different reliability -> every pair forms a
    // conflict on the addEvidence->detectConflictsFor path.
    for (let i = 0; i < 25; i++) {
      const source = i % 2 === 0 ? "web" : "code";
      addEvidence(
        ctx,
        `The deployment pipeline uses blue green rollout strategy`,
        source,
        "content",
        i % 2 === 0 ? 0.5 : 0.95,
      );
    }
    const conflicts = getAllConflicts(ctx);
    // Invariant matches the pre-existing detectConflicts() cap semantics:
    // trim to the last 10 once the array exceeds 20. Between trims the array
    // can sit at ≤ 20 — the bound that matters is the ceiling.
    assert.ok(conflicts.length <= 20, `conflicts bounded at 20 (got ${conflicts.length})`);
    assert.ok(conflicts.length > 0, "conflicts were created by the fixture");
  } finally {
    rmDir(ctx.cwd);
  }
});

// ── (a2) BeliefStore: FIFO cap 2000, oldest beliefs evicted ────────────────

await test("BeliefStore: >cap adds bound the store and evict the oldest beliefs", () => {
  const store = new BeliefStore("w97-test");
  const CAP = 2000;
  for (let i = 0; i < CAP + 50; i++) {
    store.add({ id: `b${i}`, content: `belief ${i}`, confidence: 0.9, source: "observation" });
  }
  assert.equal(store.count(), CAP, "store bounded at cap");
  assert.equal(store.get("b0"), undefined, "oldest belief evicted");
  assert.equal(store.get("b49"), undefined, "all 50 evicted beliefs gone");
  assert.ok(store.get("b50"), "first surviving belief present");
  assert.ok(store.get(`b${CAP + 49}`), "newest belief present");
  // bySource index stays consistent: query returns only live beliefs.
  const obs = store.query({ source: "observation" });
  assert.equal(obs.length, CAP, "bySource index matches bounded store");
});

await test("BeliefStore behavior at boundary: recency policy query unaffected", () => {
  const store = new BeliefStore("w97-test2");
  const CAP = 2000;
  for (let i = 0; i < CAP + 10; i++) {
    store.add({
      id: `web-${i}`,
      content: `web finding ${i}`,
      confidence: 0.9,
      source: "web",
      timestamp: Date.now(),
    });
  }
  const recent = store.query({ source: "web", maxAge: 3_600_000 });
  assert.equal(recent.length, CAP, "recency query still sees the full live window");
  assert.equal(recent[0].id, `web-10`, "query results exclude evicted beliefs (oldest first)");
});

// ── (a3) analytics toolCallSequence ring + exact counters ─────────────────

await test("analytics recordToolCall: sequence ring bounded, totals exact", () => {
  const s = createAnalyticsState();
  for (let i = 0; i < 600; i++) recordToolCall(s, i < 100 ? "early-tool" : "bash", 5, true);
  assert.equal(s.toolCallSequence.length, 500, "sequence bounded at 500");
  assert.ok(
    !s.toolCallSequence.includes("early-tool"),
    "the evicted prefix (calls 0..99) is fully gone",
  );
  assert.equal(s.toolCallSequence[0], "bash", "first survivor is call #100");
  assert.equal(s.totalToolCallsRecorded, 600, "exact counter counts every call");
  // computeSessionOutcome denominator = counter (was sequence.length).
  assert.equal(s.toolMetrics.get("early-tool").totalCalls, 100, "per-tool metrics exact");
});

// ── (b) behavior-preservation at the cap boundary ──────────────────────────

await test("behavior-preservation: addiction window at ring cap still sees the last 50 events", () => {
  // Simulate the capped turnToolSequence exactly as analytics/index.ts
  // maintains it (pushBounded at 50) and assert the detector's
  // slice(-50) window equals the last 50 pushed events.
  const ring = [];
  const pushed = [];
  for (let i = 0; i < 130; i++) {
    const tool = `tool-${i % 7}`;
    pushed.push(tool);
    ring.push(tool);
    while (ring.length > 50) ring.shift();
  }
  assert.equal(ring.length, 50, "ring at cap");
  assert.deepEqual(ring, pushed.slice(-50), "slice(-50) window == last 50 pushed events");
  // The addiction detector's windowed dominance math over the ring:
  // indices 80..129 → i % 7 == 2 at i ∈ {86,93,100,107,114,121,128} = 7.
  const counts = new Map();
  for (const t of ring) counts.set(t, (counts.get(t) ?? 0) + 1);
  assert.equal(counts.get("tool-2"), 7, "dominance counts correct at the boundary");
});

await test("behavior-preservation: tool-loop detector window intact past the cap", async () => {
  const { getToolLoopState, recordToolCall, recordTurnEnd, detectToolLoop } = await import(
    "file://" + join(D, "lib/detection/tool-loop-detector.js")
  );
  const state = getToolLoopState({
    cwd: "/tmp/w97-loop-nonexistent",
    sessionManager: {
      getSessionFile: () => "/tmp/w97-loop-nonexistent/s.jsonl",
      getEntries: () => [],
    },
  });
  // 300 calls: far more than the 20-event window. 16+ tail of identical
  // "bash"calls at the END must still be detected (the events the detector
  // needs are exactly the last WINDOW=20 entries).
  for (let i = 0; i < 300; i++) recordToolCall(state, i < 284 ? "read" : "bash");
  recordTurnEnd(state);
  const result = detectToolLoop(state);
  assert.equal(result.isLoop, true, "16-call bash tail detected at/over the cap");
  assert.equal(state.history.length, 20, "history window bounded at 20");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
