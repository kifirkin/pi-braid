/**
 * Fixture test (P2a/P2c from COMPACTION-LOSS-INVESTIGATION item 4):
 * compaction loss telemetry.
 *
 * Coverage:
 *  (a) An aborted compaction is recorded into CompactionHealth, counted
 *      distinctly from failures/successes (totalAborted), and tagged in-flight
 *      (inFlightAborted) when the aborted cycle began while another compaction
 *      was already in-flight (the inFlightBefore capture at session_before_compact
 *      top). Fails pre-fix: the abort branch recorded nothing.
 *  (b) context_inspect detail=quick includes the compact loss line once
 *      telemetry is nonzero. Fails pre-fix: getCompactionHealth had zero
 *      consumers, so no loss line was rendered.
 *
 * Run: node test/runtime/memory/test-compaction-loss-telemetry.mjs
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
      console.log(`  [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(`  [x] ${name}: ${e.message}`);
      failed++;
    });
}

const {
  registerBeforeCompactHandler,
  registerSessionCompactFailedHandler,
} = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);
// resetCompactionHealth is new in this round; guard so the P2a/P2c assertions
// run standalone against pre-fix code (where the reset does not exist yet).
const sharedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);
const { getCompactionHealth } = sharedMod;
const resetCompactionHealth = sharedMod.resetCompactionHealth ?? (() => {});
const { registerContextInspect } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/tools/context-inspect.js")
);
// Drift-signals module is new in this round; guard so the P2a/P2c assertions
// run standalone against pre-fix code (where the module does not exist yet).
const driftMod = await import(join(ROOT, "dist/lib/telemetry/drift-signals.js")).catch(() => null);
const resetDriftTelemetry = driftMod?.resetDriftTelemetry ?? (() => {});

function makeFakePi() {
  const handlers = new Map();
  const tools = [];
  return {
    handlers,
    tools,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      for (const h of handlers.get(name) ?? []) {
        await Promise.resolve(h(event, ...args)).catch((e) => {
          throw e;
        });
      }
    },
  };
}

let sessionSeq = 0;
function makeFakeCtx({ percent = 50, branchLength = 10 } = {}) {
  const sessionId = `sess-${++sessionSeq}`;
  const branch = [];
  for (let i = 0; i < branchLength; i++) {
    branch.push({
      id: `e${i}`,
      type: "message",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: [{ type: "text", text: `msg ${i}` }],
        timestamp: 1000 + i,
      },
    });
  }
  return {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    getContextUsage: () => ({
      percent,
      tokens: Math.round((percent / 100) * 200000),
      contextWindow: 200000,
    }),
    sessionManager: {
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-1",
      getBranch: () => branch,
      getTree: () => branch.map((e) => ({ entry: { id: e.id, type: e.type } })),
      getChildren: () => [],
      getLabel: () => undefined,
      appendCustomEntry: () => {},
    },
  };
}

function makePrep() {
  return { messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false };
}

async function fireBeforeCompact(pi, ctx) {
  const evt = { type: "session_before_compact", preparation: makePrep() };
  await pi._emit(evt, ctx);
  return evt.customInstructions !== undefined;
}

/**
 * Run one aborted compaction cycle where a second firing began while the
 * cycle was already in-flight (the inFlightBefore tag path).
 */
async function runInFlightAbortedCycle(pi, ctx) {
  // Firing 1: cycle starts (no compaction in-flight yet).
  await fireBeforeCompact(pi, ctx);
  // Firing 2: begins while the compaction is in-flight -> inFlightBefore=true.
  await fireBeforeCompact(pi, ctx);
  // User cancels -> session_compact_failed with aborted=true.
  await pi._emit(
    { type: "session_compact_failed", reason: "threshold", aborted: true, willRetry: false },
    ctx,
  );
}

console.log("=== compaction loss telemetry: aborts + context_inspect (P2a/P2c) ===\n");

await test("(a) an aborted compaction increments the in-flight-aborted counter", async () => {
  resetCompactionHealth();
  resetDriftTelemetry();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50, branchLength: 10 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  await runInFlightAbortedCycle(pi, ctx);

  const health = getCompactionHealth();
  assert.equal(health.lastOutcome, "aborted", "lastOutcome must reflect the abort");
  assert.equal(health.totalAborted, 1, "abort must be counted distinctly in totalAborted");
  assert.equal(
    health.inFlightAborted,
    1,
    "an abort while a compaction was in-flight must increment inFlightAborted",
  );
  assert.equal(health.totalFailures, 0, "aborts must NOT count as failures");
  assert.equal(health.totalCompactions, 0, "aborts must NOT count as successes");
});

await test("(b) context_inspect detail=quick includes the compaction loss line", async () => {
  resetCompactionHealth();
  resetDriftTelemetry();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 40, branchLength: 12 });
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);
  registerContextInspect(pi);

  await runInFlightAbortedCycle(pi, ctx);

  // Sanity: telemetry is nonzero so the line must render.
  assert.equal(getCompactionHealth().inFlightAborted, 1);

  const tool = pi.tools.find((t) => t.name === "context_inspect");
  assert.ok(tool, "context_inspect tool must be registered");
  const res = await tool.execute("call-1", { detail: "quick" }, null, null, ctx);
  const text = res.content[0].text;
  assert.match(
    text,
    /compaction loss: 1 in-flight aborts/,
    `detail=quick must include the loss line, got:\n${text}`,
  );
  // Detailed audit should include the loss section too.
  const detailed = await tool.execute("call-2", { detail: "detailed" }, null, null, ctx);
  const detailedText = detailed.content[0].text;
  assert.match(
    detailedText,
    /Compaction Loss \/ Drift Health/,
    "detailed audit must surface the loss section",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
