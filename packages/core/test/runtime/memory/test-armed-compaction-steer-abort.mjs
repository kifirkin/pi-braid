/**
 * An armed compaction must not abort the request a boundary steer dispatches.
 *
 * The batch-settle queue fires `ctx.compact()` from a `setTimeout(0)`
 * macrotask. `AgentSession.compact()` calls `abort()` first, so whatever the
 * loop dispatches between the boundary handlers and that macrotask dies. The
 * loop's decision is made by the STEERING QUEUE, polled after `turn_end` is
 * emitted, and this codebase queues a steer at turn boundaries by default (an
 * enforcement whisper with no options is `deliverAs: "steer"`). A boundary
 * that reads as loop-done therefore does not mean "nothing will be
 * dispatched": one queued context advisory is enough.
 *
 * This fixture replays that ordering with the real scheduler handlers, the
 * real arm path, and one reduced turn of the loop:
 *
 *   1. arm a slide inside a live batch (its own call id parks the queue);
 *   2. queue a steer, emit `turn_end` with a loop-done stop reason, then poll
 *      steering exactly where `agent-loop.js` does and dispatch a request;
 *   3. the drain's macrotask lands while that request is in flight.
 *
 * Pre-fix the armed compaction drains at step 3 and aborts the request. After
 * the fix the queue waits for `agent_settled`, which pi-core emits only after
 * the run is inactive, so the request completes and the compaction lands with
 * nothing in flight. The 0.90W hard backstop is the ONE deliberate exception:
 * above it a runaway run is cut even mid-request, because an overflow is worse
 * than the lost turn.
 *
 * Run: node test/runtime/memory/test-armed-compaction-steer-abort.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic settings: the backstop fraction must resolve against a pinned
// window, not the live settings.json.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "steer-abort-home-"));
process.env.HOME = FAKE_HOME;
process.env.PI_CODING_AGENT_DIR = join(FAKE_HOME, ".pi", "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(
  join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: 200_000 } } }),
);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const D = join(ROOT, "dist");

const { registerContextCompress } = await import(
  join(D, "extensions/memory/context-manager/handlers/tools/context-compress.js")
);
const { estimateMessagesTokens } = await import(join(D, "lib/detection/context-usage.js"));

console.log("=== armed compaction vs. a boundary steer ===\n");

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ~8k tokens per entry (chars/4): 10 entries = 80,000 tokens = 40% of the
// pinned 200k window; 23 entries = 184,000 = 92%, above the 180,000 backstop.
const ENTRY_TEXT = "x".repeat(31_993);

let worldSeq = 0;
function makeWorld(entryCount) {
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
  const ctx = {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    compactCalls: [],
    compact(options) {
      this.compactCalls.push(options);
    },
    sessionManager: {
      getSessionId: () => `steer-abort-${worldSeq}`,
      getSessionFile: () => `/tmp/steer-abort-${worldSeq}.jsonl`,
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
  const tools = new Map();
  return {
    handlers,
    tools,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    sendMessage() {},
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      for (const h of handlers.get(name) ?? []) await Promise.resolve(h(event, ...args));
    },
  };
}

/**
 * The reduced loop. `endTurn` is one iteration of pi-agent-core's ordering:
 * extension boundary handlers run, the steering queue is polled, and a
 * non-empty poll dispatches the next request. `ctx.compact()` models
 * `AgentSession.compact()`, which aborts an in-flight request first; the
 * request is "in-flight" from the dispatch until its own short timer resolves,
 * and an abort consumes it.
 */
function makeRun(ctx) {
  const run = {
    steering: [],
    requestState: "idle",
    aborts: 0,
  };
  ctx.compact = (options) => {
    ctx.compactCalls.push(options);
    if (run.requestState === "in-flight") {
      run.requestState = "aborted";
      run.aborts += 1;
    }
  };
  run.endTurn = async (pi, stopReason, turnIndex = 0) => {
    await pi._emit(
      {
        type: "turn_end",
        turnIndex,
        message: { role: "assistant", stopReason },
        toolResults: [],
      },
      ctx,
    );
    // agent-loop.js polls steering immediately after the turn_end emit.
    const pending = run.steering.splice(0);
    if (pending.length > 0) {
      run.requestState = "in-flight";
      setTimeout(() => {
        if (run.requestState === "in-flight") run.requestState = "done";
      }, 10);
    }
    // Let a drain's setTimeout(0) macrotask land inside the request.
    await sleep(30);
  };
  return run;
}

async function runInBatch(pi, tool, ctx, toolCallId, params) {
  await pi._emit({ type: "tool_execution_start", toolCallId, toolName: "context_compress" }, ctx);
  const result = await tool.execute(toolCallId, params, undefined, undefined, ctx);
  await pi._emit(
    { type: "tool_execution_end", toolCallId, toolName: "context_compress", result: {} },
    ctx,
  );
  return result;
}

// ── 1. The defect: a loop-done boundary plus one steer, below the backstop ──

await test("an armed compaction does not abort the request a boundary steer dispatches", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld(10);
  const ctx = world.ctx;
  const run = makeRun(ctx);

  const planted = estimateMessagesTokens(world.branch.map((e) => e.message));
  assert.equal(
    planted,
    80_000,
    "planted usage: 10 entries x 8,000 = 80,000 tokens = 40% of the 200k window, below the 180,000 backstop",
  );

  await runInBatch(pi, tool, ctx, "cc", { action: "slide", keep: 4 });
  assert.equal(ctx.compactCalls.length, 0, "parked at the arm: the batch still holds its own call id");

  // The boundary whisper is delivered as a steer. The run's turn then ends with
  // a loop-done stop reason, which the old rule read as "nothing to dispatch".
  run.steering.push({ role: "custom", text: "context advisory" });
  await run.endTurn(pi, "stop");

  assert.equal(
    run.requestState,
    "done",
    "the request the steer dispatched must complete; the drain fired into it and compact() aborted it mid-flight",
  );
  assert.equal(run.aborts, 0, "no compaction may run while that request is in flight");
  assert.equal(
    ctx.compactCalls.length,
    0,
    "the queue must stay armed at a loop-done boundary: the steering poll may still dispatch a request",
  );

  // The run ends and the settle drain lands the queue with nothing to abort.
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  assert.equal(ctx.compactCalls.length, 1, "agent_settled lands the armed compaction exactly once");
  assert.equal(run.aborts, 0, "the settle drain aborts nothing");
});

// ── 2. The deliberate exception: the 0.90W hard backstop ────────────────────

await test("the 0.90W backstop still cuts a live run (the single deliberate exception)", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld(23);
  const ctx = world.ctx;
  const run = makeRun(ctx);

  const planted = estimateMessagesTokens(world.branch.map((e) => e.message));
  assert.equal(
    planted,
    184_000,
    "planted usage: 23 entries x 8,000 = 184,000 tokens = 92% of the 200k window, above the 180,000 backstop",
  );

  await runInBatch(pi, tool, ctx, "cc", { action: "slide", keep: 4 });
  run.steering.push({ role: "custom", text: "context advisory" });
  await run.endTurn(pi, "toolUse");

  assert.equal(
    ctx.compactCalls.length,
    1,
    "at 184,000 of a 200,000 window the runaway run is cut at the boundary (backstop)",
  );
  assert.equal(
    run.requestState,
    "aborted",
    "the backstop is a deliberate mid-run abort: overflow is the worse failure",
  );
});

// ── 3. The settled drain: a run that reaches no boundary at all ─────────────

await test("a compaction armed in a run that reaches no boundary lands at settle", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld(10);
  const ctx = world.ctx;
  const run = makeRun(ctx);

  await runInBatch(pi, tool, ctx, "cc", { action: "slide", keep: 4 });
  await sleep(20);
  assert.equal(ctx.compactCalls.length, 0, "still armed while the run is live");

  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  assert.equal(ctx.compactCalls.length, 1, "the settle drain lands it");
  assert.equal(run.aborts, 0, "the run was already inactive when the compaction fired");
});

try {
  rmSync(FAKE_HOME, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
