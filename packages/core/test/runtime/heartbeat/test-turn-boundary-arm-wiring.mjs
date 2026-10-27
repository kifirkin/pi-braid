/**
 * The heartbeat's arm wiring.
 *
 * The usage-driven auto-arm fires inside a `turn_end` dispatch. Arming there
 * only queues: the loop polls its steering queue after the handlers return, so
 * no boundary can prove that nothing will be dispatched, and firing the
 * compaction in that dispatch would abort the request a queued steer creates.
 * This fixture drives the real scheduler handler end to end:
 *
 *   1. sustained usage arms THROUGH the handler inside a live-loop boundary
 *      (no compaction fired, one entry queued);
 *   2. no later turn boundary lands it below the 0.90W backstop; the settle
 *      drain does;
 *   3. a boundary that carries no readable stop reason changes nothing, and
 *      the settle drain still lands the queue;
 *   4. at the 0.90W backstop the arm still does not fire in its own dispatch -
 *      the NEXT boundary does, which is the deliberate mid-run cut.
 *
 * Run: node test/runtime/heartbeat/test-turn-boundary-arm-wiring.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic settings and paths BEFORE dist imports: braid's path helpers and
// the settings resolver read the home directory at module eval, and the
// auto-arm percent math needs the pinned 200k window.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "turn-boundary-wiring-home-"));
process.env.HOME = FAKE_HOME;
process.env.BRAID_HOME = join(FAKE_HOME, "braid");
process.env.PI_CODING_AGENT_DIR = join(FAKE_HOME, ".pi", "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
mkdirSync(process.env.BRAID_HOME, { recursive: true });
writeFileSync(
  join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: 200_000 } } }),
);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const D = join(ROOT, "dist");

const heartbeatExtension = (
  await import(join(D, "extensions/heartbeat/heartbeat-scheduler/index.js"))
).default;
const { registerContextCompress, readPendingCompactions } = await import(
  join(D, "extensions/memory/context-manager/handlers/tools/context-compress.js")
);
const { estimateMessagesTokens } = await import(join(D, "lib/detection/context-usage.js"));

console.log("=== heartbeat turn-boundary wiring ===\n");

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ~8k tokens per entry (chars/4): 18 entries = 144,000 tokens = 72% of the
// pinned 200k window. Above the 60% auto-arm threshold, below the 180,000
// (0.90W) hard backstop, so the only thing that can park the arm is the
// boundary the loop left behind.
const ENTRY_TEXT = "x".repeat(31_993);
const ENTRIES = 18;

let worldSeq = 0;
function makeWorld(entryCount = ENTRIES) {
  const branch = [];
  for (let i = 0; i < entryCount; i++) {
    branch.push({
      id: `e${i}`,
      type: "message",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: [{ type: "text", text: `msg ${i} ${ENTRY_TEXT}` }],
      },
    });
  }
  worldSeq += 1;
  const sessionId = `turn-boundary-wiring-${worldSeq}`;
  const ctx = {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    compactCalls: [],
    compact(options) {
      this.compactCalls.push(options);
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getBranch: () => branch,
      getTree: () => branch.map((e) => ({ entry: e, children: [], label: undefined })),
      getChildren: () => [],
      getLabel: () => undefined,
      appendCustomEntry(type, data) {
        branch.push({ id: `custom-${branch.length}`, type, data });
      },
    },
    model: { contextWindow: 200_000 },
  };
  return { ctx, branch };
}

function makeFakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool() {},
    sendMessage() {
      return {};
    },
    appendEntry() {},
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      for (const h of handlers.get(name) ?? []) await Promise.resolve(h(event, ...args));
    },
  };
}

/** One live agent: the drain handler plus the real scheduler handler. */
function makeAgent() {
  const pi = makeFakePi();
  registerContextCompress(pi);
  heartbeatExtension(pi);
  return pi;
}

/**
 * One turn boundary. The assistant message carries the stop reason; the drain
 * below the 0.90W backstop ignores it, and the backstop drain reads usage.
 */
async function endTurn(pi, ctx, turnIndex, stopReason) {
  const message = { role: "assistant", content: [] };
  if (stopReason !== undefined) message.stopReason = stopReason;
  await pi._emit({ type: "turn_end", turnIndex, message, toolResults: [] }, ctx);
  // The drain fires on a deferred macrotask; the tick's modules await real work.
  await sleep(40);
}

/**
 * Emit live-loop boundaries until the auto-arm lands (the hysteresis counter
 * needs two consecutive observations, and the scheduler ticks on its own
 * cadence, so the arming turn is not a constant here). Fails loudly if a
 * compaction fires inside a live-loop boundary: that is the forwarding gap.
 */
async function armAtLiveLoopBoundary(pi, ctx) {
  for (let turn = 1; turn <= 40; turn++) {
    await endTurn(pi, ctx, turn, "toolUse");
    assert.equal(
      ctx.compactCalls.length,
      0,
      `turn ${turn}: a compaction fired inside a live-loop boundary, so the arm ` +
        `did not see the turn_end event it ran inside (the boundary forwarding is gone)`,
    );
    if (readPendingCompactions(ctx).length > 0) return turn;
  }
  assert.fail(
    "sustained usage never armed a compaction through the real turn_end handler " +
      "(the auto-arm never reached the queue)",
  );
}

await test("the real turn_end handler arms inside a live-loop boundary and parks", async () => {
  const pi = makeAgent();
  const { ctx, branch } = makeWorld();

  const planted = estimateMessagesTokens(branch.map((e) => e.message));
  assert.equal(
    planted,
    144_000,
    "planted usage: 18 entries x 8,000 = 144,000 tokens = 72% of the 200k window",
  );

  const armedAt = await armAtLiveLoopBoundary(pi, ctx);
  assert.equal(
    readPendingCompactions(ctx).length,
    1,
    "the arm is queued, waiting for a boundary the loop has nothing left to dispatch at",
  );
  assert.ok(armedAt > 0, "the arm was reached through a real turn_end dispatch");
});

await test("no turn boundary lands the parked arm; agent_settled does", async () => {
  const pi = makeAgent();
  const { ctx } = makeWorld();

  const armedAt = await armAtLiveLoopBoundary(pi, ctx);
  assert.equal(ctx.compactCalls.length, 0, "parked while the loop was live");

  await endTurn(pi, ctx, armedAt + 1, "stop");
  assert.equal(
    ctx.compactCalls.length,
    0,
    "a loop-done boundary does not drain below the backstop (a steer can still dispatch)",
  );
  assert.equal(readPendingCompactions(ctx).length, 1, "the arm stays queued");

  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(40);
  assert.equal(ctx.compactCalls.length, 1, "the settle drain lands exactly one");
  assert.equal(readPendingCompactions(ctx).length, 0, "the landed compaction leaves the queue empty");
  assert.match(
    String(ctx.compactCalls[0]?.customInstructions ?? ""),
    /SLIDE_MODE/,
    "the auto-arm path is the deterministic slide",
  );
});

await test("an unreadable boundary changes nothing; the settle drain lands the arm", async () => {
  const pi = makeAgent();
  const { ctx } = makeWorld();

  const armedAt = await armAtLiveLoopBoundary(pi, ctx);
  assert.equal(ctx.compactCalls.length, 0, "parked at live-loop boundaries");

  await endTurn(pi, ctx, armedAt + 1, undefined);
  assert.equal(ctx.compactCalls.length, 0, "no boundary drain below the backstop");
  assert.equal(readPendingCompactions(ctx).length, 1, "the arm stays queued");

  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(40);
  assert.equal(ctx.compactCalls.length, 1, "agent_settled lands the queued arm");
});

await test("at the 0.90W backstop the arm waits for the next boundary", async () => {
  const pi = makeAgent();
  // 23 entries = 184,000 tokens = 92% of the pinned 200k window, above the
  // 180,000 hard backstop.
  const { ctx } = makeWorld(23);

  const armedAt = await armAtLiveLoopBoundary(pi, ctx);
  assert.equal(
    ctx.compactCalls.length,
    0,
    "the arm dispatch must not fire the compaction it just queued, even at the backstop",
  );

  // The next boundary is the backstop drain: the runaway live loop is cut.
  await endTurn(pi, ctx, armedAt + 1, "toolUse");
  assert.equal(ctx.compactCalls.length, 1, "the next boundary cuts the runaway run (backstop)");
});

try {
  rmSync(FAKE_HOME, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
