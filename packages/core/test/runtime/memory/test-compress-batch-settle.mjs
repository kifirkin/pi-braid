/**
 * Fixture test: context_compress compact must NOT fire the aborting
 * ctx.compact() while a sibling tool in the same parallel batch is still
 * executing, and must NOT fire at tool/batch end while the agent run is still
 * live (which surfaced a spurious "This operation was aborted"error in the
 * TUI and tore the finishing turn). The compaction is scheduled at a safe
 * boundary from tool_execution_start/tool_execution_end/turn_end/
 * agent_settled events: the active tool call ids decide when a batch is done,
 * and the compaction fires at the first turn_end whose toolResults account for
 * every active id, or at agent_settled when the run fully settles and the
 * session is idle (ctx.compact()'s abort is then a clean no-op).
 *
 * Old behavior (regression guarded here): execute() armed a raw setTimeout(0)
 * macrotask, which landed while the slow sibling was still in-flight — the
 * aborting compact dropped the sibling's result. Batch-settle v1 fired at the
 * first tool_execution_end where the in-flight count hit 0, which aborted the
 * still-live run (spurious abort error). This test fails on both of those and
 * passes on the id-tracked scheduler (see
 * test-compress-drain-boundaries.mjs for the missed-end identity case).
 *
 * Run: node test/runtime/memory/test-compress-batch-settle.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Hermeticity pin - MUST run before the dist import below. The usage percent
// that gates compaction comes from the resolved context window: resolveWindow()
// reads braid.context.contextLimitTokens from the agent settings.json. Left
// unpointed, that is the operator's live file (a 384000-token window here), the
// branch below measures ~21% instead of 40%, and compact(action="compact")
// returns "already low (<30%)" without arming - 0 compact events where this
// test expects 1. Own the input instead: HOME and PI_CODING_AGENT_DIR point at
// a temp dir whose settings.json fixes the 200000-token window the branch sizes
// assume.
const FIXTURE_HOME = mkdtempSync(join(tmpdir(), "compress-batch-settle-home-"));
process.env.HOME = FIXTURE_HOME;
process.env.PI_CODING_AGENT_DIR = join(FIXTURE_HOME, ".pi", "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(
  join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: 200_000 } } }),
);

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

const { registerContextCompress } = await import(
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
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      for (const h of handlers.get(name) ?? []) {
        await Promise.resolve(h(event, ...args)).catch((e) => {
          console.error(`  ! handler error on ${name}:`, e);
          throw e;
        });
      }
    },
  };
}

let sessionSeq = 0;
function makeFakeCtx(timeline) {
  const sessionId = `sess-${++sessionSeq}`;
  const branch = [];
  for (let i = 0; i < 10; i++) {
    branch.push({
      id: `e${i}`,
      type: "message",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: [
          {
            type: "text",
            // Branch content sized so the session-tree measure reports the
            // fake accessor's 40% (80k of a 200k window).
            text: `msg ${i} ${"x".repeat(31_993)}`,
          },
        ],
        timestamp: 1000 + i,
      },
    });
  }
  const ctx = {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    getContextUsage: () => ({ percent: 40, tokens: 80000, contextWindow: 200000 }),
    compactCalls: [],
    compact(options) {
      this.compactCalls.push(options);
      timeline.push("compact_fired");
    },
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
  return ctx;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("=== context_compress batch-settle scheduling ===\n");

await test("parallel batch: compact parks until agent_settled (never at tool end, run still live)", async () => {
  const pi = makeFakePi();
  const timeline = [];
  const ctx = makeFakeCtx(timeline);
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  assert.ok(tool, "context_compress tool registered");

  // Batch: context_compress + a slow sibling.
  await pi._emit(
    { type: "tool_execution_start", toolCallId: "cc-1", toolName: "context_compress" },
    ctx,
  );
  await pi._emit(
    { type: "tool_execution_start", toolCallId: "slow-1", toolName: "slow_tool" },
    ctx,
  );

  // context_compress.execute() returns its result (arming the deferred compact).
  const result = await tool.execute(
    "cc-1",
    { action: "compact", keep: 50 },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(result, "execute returns a result");
  timeline.push("cc_executed");
  const MESSAGE = result?.content?.[0]?.text ?? "";
  assert.ok(!/aborted/i.test(MESSAGE), "tool result must not surface a spurious abort error");

  // Our tool's execution ends while the sibling is STILL in-flight.
  await pi._emit(
    { type: "tool_execution_end", toolCallId: "cc-1", toolName: "context_compress", result: {} },
    ctx,
  );
  timeline.push("end_cc");

  // Let a macrotask elapse: the OLD setTimeout(0) code fired the aborting
  // compact here (dropping the in-flight sibling result). Batch-settle code
  // MUST still be parked because the sibling has not completed.
  await sleep(30);
  assert.equal(
    ctx.compactCalls.length,
    0,
    "compact must NOT fire while a parallel sibling tool is still executing (sibling result would be dropped)",
  );

  // The slow sibling finishes; its result is produced BEFORE its end event.
  timeline.push("slow_result_produced");
  await pi._emit(
    {
      type: "tool_execution_end",
      toolCallId: "slow-1",
      toolName: "slow_tool",
      result: { ok: true },
    },
    ctx,
  );
  timeline.push("end_slow");

  // The agent run is STILL ACTIVE after the batch's tools end (the agent is
  // streaming its response to these results). Firing the aborting compact now
  // would hit the live run and surface a spurious abort error — the scheduler
  // must keep parking until the whole run settles.
  await sleep(30);
  assert.equal(
    ctx.compactCalls.length,
    0,
    "compact must NOT fire at tool/batch end while the agent run is still live (would surface spurious abort error)",
  );

  const idxSlowResult = timeline.indexOf("slow_result_produced");
  assert.ok(idxSlowResult >= 0, "slow result must have been produced");

  // The run settles: agent_settled remains a drain boundary — compact fires
  // with the session idle (ctx.compact() abort is a clean no-op).
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  assert.equal(
    ctx.compactCalls.length,
    1,
    "compact must fire exactly once when the agent run settles (agent_settled)",
  );

  // Ordering proof: the slow result landed well before the aborting compact fired.
  const idxCompact = timeline.indexOf("compact_fired");
  assert.ok(
    idxCompact >= 0 && idxSlowResult < idxCompact,
    `slow tool result (${idxSlowResult}) must land before compact (${idxCompact}) in ${timeline.join(" -> ")}`,
  );
});

await test("agent_settled forces a pending compact even without a sibling end event", async () => {
  const pi = makeFakePi();
  const timeline = [];
  const ctx = makeFakeCtx(timeline);
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");

  // Batch with a sibling whose end event never arrives.
  await pi._emit(
    { type: "tool_execution_start", toolCallId: "cc-2", toolName: "context_compress" },
    ctx,
  );
  await pi._emit(
    { type: "tool_execution_start", toolCallId: "stuck-2", toolName: "stuck_tool" },
    ctx,
  );
  await tool.execute("cc-2", { action: "compact", keep: 50 }, undefined, undefined, ctx);
  await pi._emit(
    { type: "tool_execution_end", toolCallId: "cc-2", toolName: "context_compress", result: {} },
    ctx,
  );
  await sleep(30);
  assert.equal(ctx.compactCalls.length, 0, "still parked (sibling end never arrives)");

  // Turn settles: agent_settled is the robust backstop.
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  assert.equal(ctx.compactCalls.length, 1, "agent_settled fires the pending compact");
});

rmSync(FIXTURE_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
