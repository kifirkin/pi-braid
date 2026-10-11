/**
 * RSS telemetry ring tests.
 *
 * Gate covered:
 * (c) RSS ring stays ≤ 24 samples; boot baseline set once per boot;
 * sustained-growth verdict fires only on a FULL ring entirely above
 * 2x baseline; integration: collectAndEmitContextHeartbeat maintains
 * the ring across ticks and the verdict flips only after saturation.
 *
 * Run: node test/runtime/heartbeat/test-rss-ring.mjs (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const D = join(ROOT, "dist");

// Hermetic HOME BEFORE dist imports (braid-paths + settings eval-time capture).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w97-rss-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), JSON.stringify({}));

const { pushRssSample, assessSustainedRssGrowth } = await import(
  "file://" + join(D, "lib/telemetry/rss-telemetry.js")
);
const { resetRssBootTelemetry, getRssBootTelemetry, getRssGrowthWhisperShown } = await import(
  "file://" + join(D, "lib/state/global-state.js")
);
const { collectAndEmitContextHeartbeat } = await import(
  "file://" + join(D, "lib/telemetry/context-heartbeat.js")
);

console.log("=== RSS ring telemetry ===\n");

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

// ── (c1) pure ring: bounded at 24, FIFO ───────────────────────────────���────

await test("pushRssSample: ring stays ≤ 24 and evicts the oldest samples", () => {
  const ring = [];
  for (let i = 0; i < 30; i++) pushRssSample(ring, 1000 + i);
  assert.equal(ring.length, 24, "ring bounded at RSS_RING_CAP");
  assert.equal(ring[0], 1006, "oldest 6 samples evicted (0..5 gone)");
  assert.equal(ring[ring.length - 1], 1029, "newest sample at the tail");
});

// ── (c2) sustained-growth predicate ────────────────────────────────────────

await test("assessSustainedRssGrowth: fires only on a FULL ring above 2x baseline", () => {
  const MB = 1048576;
  assert.equal(assessSustainedRssGrowth([], 100 * MB), false, "empty ring never fires");
  assert.equal(
    assessSustainedRssGrowth([250 * MB, 260 * MB], 100 * MB),
    false,
    "partial ring never fires",
  );
  assert.equal(
    assessSustainedRssGrowth(Array(24).fill(250 * MB), null),
    false,
    "no baseline never fires",
  );
  assert.equal(
    assessSustainedRssGrowth(Array(24).fill(200 * MB), 100 * MB),
    false,
    "exactly 2x (not >) does not fire",
  );
  assert.equal(
    assessSustainedRssGrowth(Array(24).fill(201 * MB), 100 * MB),
    true,
    "full ring strictly above 2x fires",
  );
  assert.equal(
    assessSustainedRssGrowth([...Array(23).fill(250 * MB), 150 * MB], 100 * MB),
    false,
    "one below-threshold sample in the ring blocks the verdict",
  );
  assert.equal(assessSustainedRssGrowth(Array(24).fill(1), 0), false, "zero baseline never fires");
});

// ── (c3) integration: heartbeat tick maintains ring + boot baseline ────────

function makeRssCtx(tmp, sessionKey) {
  const f = join(tmp, "s.jsonl");
  writeFileSync(f, "", "utf-8");
  return {
    cwd: tmp,
    getContextUsage: () => ({ tokens: 1000, contextWindow: 1_000_000, percent: 0.1 }),
    sessionManager: {
      getSessionFile: () => f,
      getSessionId: () => sessionKey,
      getEntries: () => [],
    },
    model: { id: "m" },
  };
}

await test("integration: 30 heartbeat ticks keep the RSS ring ≤ 24 and set the boot baseline once", () => {
  resetRssBootTelemetry();
  const tmp = mkdtempSync(join(tmpdir(), "w97-rss2-"));
  const ctx = makeRssCtx(tmp, "w97-rss2");
  const sink = join(tmp, "hb.jsonl");
  try {
    const rss = 120 * 1048576;
    const origMemoryUsage = process.memoryUsage.bind(process);
    process.memoryUsage = () => ({ rss, heapUsed: 1, external: 0, arrayBuffers: 0 });
    try {
      let last = null;
      for (let i = 0; i < 30; i++) {
        last = collectAndEmitContextHeartbeat(ctx, { source: "heartbeat", sinkFile: sink });
      }
      assert.equal(last.rssRing.length, 24, "ring bounded at 24 after 30 ticks");
      assert.ok(getRssBootTelemetry(), "boot telemetry slot exists");
      assert.equal(
        getRssBootTelemetry().baselineBytes,
        rss,
        "baseline = FIRST tick's RSS (set-once semantics)",
      );
      assert.equal(last.rssSustainedGrowth, false, "flat RSS does not fire the verdict");
    } finally {
      process.memoryUsage = origMemoryUsage;
      rmDir(tmp);
    }
  } catch (e) {
    rmDir(tmp);
    throw e;
  }
});

await test("integration: sustained >2x growth across a full ring raises the verdict; latch untouched", async () => {
  resetRssBootTelemetry();
  const tmp = mkdtempSync(join(tmpdir(), "w97-rss3-"));
  const ctx = makeRssCtx(tmp, "w97-rss3");
  const sink = join(tmp, "hb.jsonl");
  try {
    const MB = 1048576;
    const origMemoryUsage = process.memoryUsage.bind(process);
    // Tick 1: baseline set at 100MB.
    let rss = 100 * MB;
    process.memoryUsage = () => ({ rss, heapUsed: 1, external: 0, arrayBuffers: 0 });
    let s = collectAndEmitContextHeartbeat(ctx, { source: "heartbeat", sinkFile: sink });
    // Ticks 2..25: 250MB (>2x baseline). The verdict may only flip once the
    // ring is FULL with every sample above 2x — i.e. from tick 25 onward.
    const verdicts = [];
    for (let i = 0; i < 24; i++) {
      rss = 250 * MB;
      s = collectAndEmitContextHeartbeat(ctx, { source: "heartbeat", sinkFile: sink });
      verdicts.push(s.rssSustainedGrowth);
    }
    assert.equal(verdicts[22], false, "ring not yet full at overall tick 24");
    assert.equal(verdicts[23], true, "verdict fires once the ring saturates");
    assert.equal(s.rssRing.length, 24, "ring at cap");
    assert.ok(
      !getRssGrowthWhisperShown(),
      "latch not set by telemetry alone (the tick owns delivery)",
    );
    process.memoryUsage = origMemoryUsage;
  } catch (e) {
    rmDir(tmp);
    throw e;
  }
  rmDir(tmp);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
