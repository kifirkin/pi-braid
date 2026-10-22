/**
 * context_compress armed-compaction drain boundaries.
 *
 * Defect: the batch-settle scheduler drained the pending queue ONLY at
 * agent_settled. A run kept alive by continuous steers never settles, so an
 * armed compaction stalled behind live work while usage kept climbing: the
 * queue drains at the first turn boundary instead.
 *
 * Pinned here:
 *   1. The never-lands reproduction: armed mid-batch, steered turns keep the
 *      run alive, agent_settled never fires — the compaction must land at the
 *      FIRST turn boundary and never re-fire on later boundaries.
 *   2. Never mid-batch: turn_end with a sibling still in-flight must not drain
 *      (the tool-batch safety contract extends to the new boundary). The
 *      batch's completion is read from tool-call IDENTITY: a sibling whose
 *      tool_execution_end was missed but whose result is persisted in the
 *      boundary event's toolResults releases the batch there, while an id
 *      absent from those results (and a malformed result entry) keeps it
 *      parked. An unidentifiable start carries a symbol marker, so no
 *      persisted call id can release it early.
 *   3. Settle path preserved: agent_settled still drains (backstop), and a
 *      queue already drained at turn_end does not double-fire at settle.
 *   4. No drain while a compaction cycle is already active.
 *   5. Queue integrity: a second LLM-class arm while one is pending is refused
 *      honestly (the first-armed trigger fires with the FIRST declaration's
 *      range — not the second arm's clobbered state), and repeated slide arms
 *      can never drop the firing (earliest-cut) entry via the queue cap.
 *   6. Usage-driven auto-arm: sustained usage above the configured threshold
 *      arms ONE deterministic slide; the knob can disable it.
 *   7. The pending-state advisory line (shared by context_inspect and the
 *      heartbeat) names the armed state and the turn-boundary landing.
 *   8. A live loop is not a drain boundary: a turn_end whose assistant message
 *      carries stopReason "toolUse" leaves the queue armed (the deferred
 *      compact would abort the request the loop is dispatching), the 0.90W
 *      hard backstop cuts anyway, and agent_settled still lands it.
 *   9. Arming is not a drain boundary either: an arm made inside a turn
 *      boundary dispatch (the heartbeat's usage-driven auto-arm hands that
 *      event in) drains only where that boundary is safe to abort on, so a
 *      "toolUse" stop below the 0.90W backstop queues instead of tearing the
 *      dispatch. The 0.90W exception still cuts at the arm, the next loop-done
 *      boundary lands a parked entry, and agent_settled catches the rest.
 *
 * Run: node test/runtime/memory/test-compress-drain-boundaries.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic settings: the window the archive/slide percent math resolves
// against must be pinned, or the fixture depends on the live settings.json.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "drain-boundaries-home-"));
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

const compressMod = await import(
  join(D, "extensions/memory/context-manager/handlers/tools/context-compress.js")
);
const sharedMod = await import(
  join(D, "extensions/memory/context-manager/handlers/shared.js")
);
const { registerContextCompress, readPendingCompactions, formatPendingCompactionsLine } =
  compressMod;
const { getCmState, setCompactionActive } = sharedMod;
const { estimateMessagesTokens } = await import(
  join(D, "lib/detection/context-usage.js")
);

console.log("=== context_compress drain boundaries ===\n");

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

// ~8k tokens per entry (chars/4): 10 entries = ~40% of the pinned 200k window
// (above the <30% skip guards), 18 entries = ~72% (above the 60% auto-arm
// threshold).
const ENTRY_TEXT = "x".repeat(31_993);

let worldSeq = 0;
function makeWorld(entryCount = 10) {
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
  const sessionFile = `/tmp/drain-boundaries-${++worldSeq}.jsonl`;
  const ctx = {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    compactCalls: [],
    compact(options) {
      this.compactCalls.push(options);
    },
    sessionManager: {
      getSessionId: () => `drain-boundaries-${worldSeq}`,
      getSessionFile: () => sessionFile,
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
          throw e;
        });
      }
    },
  };
}

/** Run one tool call inside a live batch (tool call id active): pendings stay parked until settle. */
async function runInBatch(pi, tool, ctx, toolCallId, params) {
  await pi._emit({ type: "tool_execution_start", toolCallId, toolName: "context_compress" }, ctx);
  const result = await tool.execute(toolCallId, params, undefined, undefined, ctx);
  await pi._emit(
    { type: "tool_execution_end", toolCallId, toolName: "context_compress", result: {} },
    ctx,
  );
  return result;
}

async function emitTurnEnd(pi, ctx, turnIndex, toolResults = [], stopReason = "stop") {
  await pi._emit(
    {
      type: "turn_end",
      turnIndex,
      message: { role: "assistant", stopReason },
      toolResults,
    },
    ctx,
  );
  await sleep(30);
}

// ── 1. The never-lands reproduction ─────────────────────────────────────────

await test("armed drain lands at the FIRST turn boundary of a run that never settles", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld();
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  await runInBatch(pi, tool, ctx, "cc", { action: "slide", keep: 4 });
  await sleep(20);
  assert.equal(ctx.compactCalls.length, 0, "parked at arm time (mid-batch)");

  // The run stays alive: steered turns complete one after another and
  // agent_settled NEVER fires. The compaction must land at the first one.
  await emitTurnEnd(pi, ctx, 0);
  assert.equal(
    ctx.compactCalls.length,
    1,
    "the armed compaction must land at the first turn boundary (steered-run defect)",
  );

  await emitTurnEnd(pi, ctx, 1);
  await emitTurnEnd(pi, ctx, 2);
  assert.equal(
    ctx.compactCalls.length,
    1,
    "drained boundaries must not re-fire on later turn ends",
  );

  // The settle backstop finds the queue empty: no second compaction.
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  assert.equal(ctx.compactCalls.length, 1, "settle after a turn_end drain must not double-fire");
});

// ── 2. Never mid-batch at the new boundary ──────────────────────────────────

await test("turn_end with a sibling tool still in-flight does not drain", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld();
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  await pi._emit({ type: "tool_execution_start", toolCallId: "cc", toolName: "context_compress" }, ctx);
  await pi._emit({ type: "tool_execution_start", toolCallId: "sib", toolName: "slow_tool" }, ctx);
  await tool.execute("cc", { action: "slide", keep: 4 }, undefined, undefined, ctx);
  await pi._emit(
    { type: "tool_execution_end", toolCallId: "cc", toolName: "context_compress", result: {} },
    ctx,
  );

  // The batch is still live (the sibling has not ended): a turn boundary must
  // not drain it — the sibling's result would be dropped by the abort.
  await emitTurnEnd(pi, ctx, 0);
  assert.equal(
    ctx.compactCalls.length,
    0,
    "turn_end must not drain while a parallel sibling tool is still executing",
  );

  // Sibling lands; its result is in before the next boundary drains.
  await pi._emit(
    { type: "tool_execution_end", toolCallId: "sib", toolName: "slow_tool", result: {} },
    ctx,
  );
  await emitTurnEnd(pi, ctx, 1);
  assert.equal(ctx.compactCalls.length, 1, "drains once the batch has fully landed");
});

await test("a persisted result releases its call id at turn_end when the end event is missed", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld();
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  await pi._emit({ type: "tool_execution_start", toolCallId: "cc", toolName: "context_compress" }, ctx);
  await pi._emit({ type: "tool_execution_start", toolCallId: "sib", toolName: "slow_tool" }, ctx);
  await tool.execute("cc", { action: "slide", keep: 4 }, undefined, undefined, ctx);
  await pi._emit(
    { type: "tool_execution_end", toolCallId: "cc", toolName: "context_compress", result: {} },
    ctx,
  );

  // The sibling's tool result IS persisted, its tool_execution_end is NOT:
  // the boundary event carries the same toolCallId. A count decremented only
  // by the end event stays positive here and parks the armed compaction until
  // agent_settled, which a run kept alive by steers never reaches.
  await emitTurnEnd(pi, ctx, 0, [
    { role: "toolResult", toolCallId: "sib", toolName: "slow_tool", content: [] },
  ]);
  assert.equal(
    ctx.compactCalls.length,
    1,
    "the persisted sibling result must release the batch at the turn boundary (missed tool_execution_end)",
  );

  // The backstop still runs, but the queue is already empty: no second fire.
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  assert.equal(ctx.compactCalls.length, 1, "settle after the boundary drain must not double-fire");
});

await test("results that name no active call id keep the batch parked", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld();
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  await pi._emit({ type: "tool_execution_start", toolCallId: "cc", toolName: "context_compress" }, ctx);
  await pi._emit({ type: "tool_execution_start", toolCallId: "sib", toolName: "slow_tool" }, ctx);
  await tool.execute("cc", { action: "slide", keep: 4 }, undefined, undefined, ctx);
  await pi._emit(
    { type: "tool_execution_end", toolCallId: "cc", toolName: "context_compress", result: {} },
    ctx,
  );

  // A foreign result and a malformed entry (no toolCallId) name nothing the
  // batch is waiting on: the active sibling must stay protective.
  await emitTurnEnd(pi, ctx, 0, [
    { role: "toolResult", toolCallId: "other", toolName: "other_tool", content: [] },
    { role: "toolResult", toolName: "slow_tool", content: [] },
  ]);
  assert.equal(
    ctx.compactCalls.length,
    0,
    "a result that names no active call id must not release the batch",
  );

  // The sibling's own identity finally arrives: that boundary drains.
  await emitTurnEnd(pi, ctx, 1, [
    { role: "toolResult", toolCallId: "sib", toolName: "slow_tool", content: [] },
  ]);
  assert.equal(ctx.compactCalls.length, 1, "drains once the awaited identity lands");
});

await test("a start event with no call id keeps every boundary parked until settle", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld();
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  await pi._emit({ type: "tool_execution_start", toolCallId: "cc", toolName: "context_compress" }, ctx);
  // pi-core always names a call id (pi-agent-core emits `toolCallId: toolCall.id`
  // on start, end, and the persisted result). An emitter that does not leaves
  // the call unidentifiable: its completion can never be proven from a
  // boundary's toolResults, so the boundary stays conservative and the settle
  // backstop owns the release.
  await pi._emit({ type: "tool_execution_start", toolName: "unknown_tool" }, ctx);
  await tool.execute("cc", { action: "slide", keep: 4 }, undefined, undefined, ctx);
  await pi._emit(
    { type: "tool_execution_end", toolCallId: "cc", toolName: "context_compress", result: {} },
    ctx,
  );

  await emitTurnEnd(pi, ctx, 0);
  assert.equal(
    ctx.compactCalls.length,
    0,
    "an unidentifiable start must not be released by a boundary that cannot name it",
  );
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  assert.equal(ctx.compactCalls.length, 1, "the settle backstop clears it and drains");
});

await test("a persisted result cannot release an unidentifiable start", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld();
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  await pi._emit({ type: "tool_execution_start", toolCallId: "cc", toolName: "context_compress" }, ctx);
  await pi._emit({ type: "tool_execution_start", toolName: "unknown_tool" }, ctx);
  await tool.execute("cc", { action: "slide", keep: 4 }, undefined, undefined, ctx);
  await pi._emit(
    { type: "tool_execution_end", toolCallId: "cc", toolName: "context_compress", result: {} },
    ctx,
  );

  // The unidentifiable start's completion cannot be proven from a boundary.
  // A marker that is a legal call id string would be released by a result
  // that names it, and the drain would fire while that call may still be
  // live. This result names the exact text a string marker would use.
  const collidingId = String.fromCharCode(0) + "unidentified-tool-call";
  await emitTurnEnd(pi, ctx, 0, [
    { role: "toolResult", toolCallId: collidingId, toolName: "unknown_tool", content: [] },
  ]);
  assert.equal(
    ctx.compactCalls.length,
    0,
    "no persisted call id may release an unidentifiable start",
  );
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  assert.equal(ctx.compactCalls.length, 1, "the settle backstop clears it and drains");
});

// ── 3. Settle path preserved ────────────────────────────────────────────────

await test("agent_settled still drains a queue that no turn boundary reached", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld();
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  await runInBatch(pi, tool, ctx, "cc", { action: "slide", keep: 4 });
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  assert.equal(ctx.compactCalls.length, 1, "settle remains a drain boundary");
});

// ── 4. No drain while a compaction cycle is active ──────────────────────────

await test("turn_end does not drain while a compaction cycle is already active", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld();
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  setCompactionActive(true, ctx);
  try {
    await runInBatch(pi, tool, ctx, "cc", { action: "slide", keep: 4 });
    await emitTurnEnd(pi, ctx, 0);
    assert.equal(
      ctx.compactCalls.length,
      0,
      "an active compaction cycle must not be aborted by a boundary drain",
    );
  } finally {
    setCompactionActive(false, ctx);
  }
  await emitTurnEnd(pi, ctx, 1);
  assert.equal(ctx.compactCalls.length, 1, "drains once the cycle is over");
});

// ── 5. Queue integrity ──────────────────────────────────────────────────────

await test("second archive while one is pending is refused honestly; the first range stands", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld(100);
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  const first = await runInBatch(pi, tool, ctx, "cc-1", {
    action: "archive",
    startIndex: 0,
    endIndex: 29,
    topic: "first phase",
    summary: "Owner: phase one. Braid: recorded.",
  });
  assert.ok(!first.details?.error, `first archive accepted: ${first.content?.[0]?.text ?? ""}`);

  const second = await runInBatch(pi, tool, ctx, "cc-2", {
    action: "archive",
    startIndex: 0,
    endIndex: 59,
    topic: "second phase",
    summary: "Owner: phase two. Braid: recorded.",
  });
  assert.match(
    String(second.content?.[0]?.text ?? ""),
    /already armed/i,
    "the second LLM-class arm must be refused with an honest already-armed note",
  );

  // The first declaration must stand: the pending trigger fires with the
  // FIRST archive's range, not a range state clobbered by the second arm.
  const rangeMode = getCmState(ctx).rangeMode;
  assert.ok(rangeMode?.active, "rangeMode armed for the compaction branch");
  assert.equal(
    rangeMode.endIndex,
    29,
    "the first archive's declared range must survive the second arm (clobber-class loss)",
  );
  assert.equal(readPendingCompactions(ctx).length, 1, "one LLM-class entry, not two");

  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  assert.equal(ctx.compactCalls.length, 1, "exactly one compaction lands");
});

await test("repeated slide arms never drop the earliest-cut (firing) entry", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld(60);
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  // The first arm's cut is the earliest (branch grows by the audit entry on
  // every later arm, so later arms cut later). Nine arms exceed the queue
  // cap: the drop policy must sacrifice a NEWEST redundant entry, never the
  // entry that will actually fire.
  for (let i = 0; i < 9; i++) {
    await runInBatch(pi, tool, ctx, `cc-${i}`, { action: "slide", keep: 4 });
  }
  assert.ok(
    readPendingCompactions(ctx).length <= 8,
    "queue stays under its cap",
  );

  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  assert.equal(ctx.compactCalls.length, 1, "one coalesced compaction lands");
  const slide = getCmState(ctx).slideMode;
  const firstCut = world.branch[60 - 4 - 1]?.id; // arm 1: branch 60 entries + its own audit lands after the cut read
  // The first arm saw a 60-entry branch: cut at index 60 - 4 = 56.
  const declaredFirstCut = world.branch[56]?.id;
  assert.equal(
    slide?.cutEntryId,
    declaredFirstCut ?? firstCut,
    `the earliest declared cut must survive repeated arms (got ${slide?.cutEntryId}, want ${declaredFirstCut})`,
  );
});

// ── 6. Usage-driven auto-arm ────────────────────────────────────────────────

await test("sustained usage above the threshold arms exactly one slide", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const world = makeWorld(18); // ~72% of the pinned 200k window
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  const first = compressMod.maybeArmAutoCompaction(pi, ctx);
  assert.equal(
    first.armed,
    false,
    "first observation above the threshold only warms the hysteresis counter",
  );
  assert.equal(ctx.compactCalls.length, 0, "nothing armed on a single observation");

  const second = compressMod.maybeArmAutoCompaction(pi, ctx);
  assert.equal(second.armed, true, "sustained high usage arms the auto compaction");
  await sleep(30); // the drain is a deferred macrotask, as for every boundary
  assert.equal(ctx.compactCalls.length, 1, "one auto-armed compaction queued");
  assert.match(
    String(ctx.compactCalls[0]?.customInstructions ?? ""),
    /SLIDE_MODE/,
    "the auto arm is the deterministic slide path",
  );

  const third = compressMod.maybeArmAutoCompaction(pi, ctx);
  assert.equal(third.armed, false, "a pending compaction suppresses re-arming");
  assert.equal(ctx.compactCalls.length, 1, "no second compaction queued");
});

await test("usage below the threshold never arms and resets the hysteresis counter", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const world = makeWorld(18);
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  // Warm the counter high, then let usage drop: the counter must not carry
  // stale credit across a below-threshold observation.
  compressMod.maybeArmAutoCompaction(pi, ctx);
  world.branch.splice(8); // down to 8 entries (~32%)
  const low = compressMod.maybeArmAutoCompaction(pi, ctx);
  assert.equal(low.armed, false, "low usage never arms");
  world.branch.push(
    { id: `e-hi-a`, type: "message", message: { role: "user", content: [{ type: "text", text: `a ${ENTRY_TEXT}` }] } },
    { id: `e-hi-b`, type: "message", message: { role: "assistant", content: [{ type: "text", text: `b ${ENTRY_TEXT}` }] } },
    { id: `e-hi-c`, type: "message", message: { role: "user", content: [{ type: "text", text: `c ${ENTRY_TEXT}` }] } },
    { id: `e-hi-d`, type: "message", message: { role: "assistant", content: [{ type: "text", text: `d ${ENTRY_TEXT}` }] } },
    { id: `e-hi-e`, type: "message", message: { role: "user", content: [{ type: "text", text: `e ${ENTRY_TEXT}` }] } },
    { id: `e-hi-f`, type: "message", message: { role: "assistant", content: [{ type: "text", text: `f ${ENTRY_TEXT}` }] } },
    { id: `e-hi-g`, type: "message", message: { role: "user", content: [{ type: "text", text: `g ${ENTRY_TEXT}` }] } },
    { id: `e-hi-h`, type: "message", message: { role: "assistant", content: [{ type: "text", text: `h ${ENTRY_TEXT}` }] } },
    { id: `e-hi-i`, type: "message", message: { role: "user", content: [{ type: "text", text: `i ${ENTRY_TEXT}` }] } },
    { id: `e-hi-j`, type: "message", message: { role: "assistant", content: [{ type: "text", text: `j ${ENTRY_TEXT}` }] } },
  );
  const back = compressMod.maybeArmAutoCompaction(pi, ctx);
  assert.equal(
    back.armed,
    false,
    "a single observation after a below-threshold reset must not arm (stale credit cleared)",
  );
  assert.equal(ctx.compactCalls.length, 0);
});

// ── 7. Pending-state advisory line ──────────────────────────────────────────

await test("pending advisory names the armed state and the turn-boundary landing", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld();
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  assert.equal(
    formatPendingCompactionsLine(ctx),
    null,
    "no fabricated pending state when the queue is empty",
  );

  await runInBatch(pi, tool, ctx, "cc", { action: "slide", keep: 4 });
  const line = formatPendingCompactionsLine(ctx);
  assert.ok(line, "pending state is visible while armed");
  assert.match(line, /slide armed/, "the line names the armed kind");
  assert.match(
    line,
    /next turn boundary/,
    "the line states the landing boundary (not settle-only)",
  );
});

// ── 8. A live loop is not a drain boundary ──────────────────────────────────

// Each world entry carries a `msg N` label plus 31,993 chars of text, which
// the shared chars/4 estimator reads as 8,000 tokens - 4% of the pinned 200k
// window. The hard backstop is 0.90W = 180,000 tokens.

await test("a toolUse turn_end leaves an armed slide parked; the next loop-done boundary lands it", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld(18);
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  const planted = estimateMessagesTokens(world.branch.map((e) => e.message));
  assert.equal(
    planted,
    144_000,
    "planted usage: 18 entries x 8,000 = 144,000 tokens = 72% of the 200k window, below the 180,000 hard backstop",
  );

  // Armed inside the batch: its own call id is still active, so the arm itself
  // cannot fire. The turn then ends with stopReason "toolUse" - the loop
  // dispatches its next request as soon as the handlers return.
  await runInBatch(pi, tool, ctx, "cc", { action: "slide", keep: 4 });
  await emitTurnEnd(
    pi,
    ctx,
    0,
    [{ role: "toolResult", toolCallId: "cc", toolName: "context_compress", content: [] }],
    "toolUse",
  );
  assert.equal(
    ctx.compactCalls.length,
    0,
    "a live-loop boundary must not abort the request the loop is about to dispatch",
  );
  assert.equal(
    readPendingCompactions(ctx).length,
    1,
    "the armed slide stays armed across a live-loop boundary",
  );

  // The next assistant message ends the turn with a done stop reason: the loop
  // has nothing left to dispatch, so the abort lands between turns.
  await emitTurnEnd(pi, ctx, 1, [], "stop");
  assert.equal(ctx.compactCalls.length, 1, "a loop-done boundary lands the armed compaction");
  assert.equal(readPendingCompactions(ctx).length, 0, "the landed compaction leaves the queue empty");
});

await test("a toolUse turn_end at the 0.90W backstop cuts the live loop anyway", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld(23);
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  const planted = estimateMessagesTokens(world.branch.map((e) => e.message));
  assert.equal(
    planted,
    184_000,
    "planted usage: 23 entries x 8,000 = 184,000 tokens = 92% of the 200k window, at/above the 180,000 hard backstop",
  );

  await runInBatch(pi, tool, ctx, "cc", { action: "slide", keep: 4 });
  await emitTurnEnd(
    pi,
    ctx,
    0,
    [{ role: "toolResult", toolCallId: "cc", toolName: "context_compress", content: [] }],
    "toolUse",
  );
  assert.equal(
    ctx.compactCalls.length,
    1,
    "at 184,000 tokens of a 200,000 window the runaway live loop is cut (backstop exception)",
  );
});

await test("agent_settled drains a compaction that a toolUse turn_end left armed", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld(18);
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  await runInBatch(pi, tool, ctx, "cc", { action: "slide", keep: 4 });
  await emitTurnEnd(
    pi,
    ctx,
    0,
    [{ role: "toolResult", toolCallId: "cc", toolName: "context_compress", content: [] }],
    "toolUse",
  );
  assert.equal(ctx.compactCalls.length, 0, "parked at the live-loop boundary");

  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  assert.equal(
    ctx.compactCalls.length,
    1,
    "the settle backstop still lands a queue that a live-loop boundary left armed",
  );
});

// ── 9. The arm path is not a drain boundary ────────────────────────────────

// Same entries as section 8: 8,000 tokens each against the pinned 200k window.
// 18 entries = 144,000 tokens (72%, below the 180,000 hard backstop), 23
// entries = 184,000 tokens (92%, at/above it).

/**
 * The heartbeat's arm site: its scheduler ticks on every Nth turn_end and arms
 * inside that dispatch, handing the boundary it is handling in. Registered
 * after the context-compress handlers, so the arm lands after the boundary
 * those handlers already judged - the shape that aborted the live loop.
 */
function tickArmingOnTurnEnd(pi) {
  const reports = [];
  pi.on("turn_end", (event, c) => {
    reports.push(compressMod.maybeArmAutoCompaction(pi, c, event));
  });
  return reports;
}

await test("an auto-arm inside a toolUse boundary parks; the next loop-done boundary lands it", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const world = makeWorld(18);
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  const planted = estimateMessagesTokens(world.branch.map((e) => e.message));
  assert.equal(
    planted,
    144_000,
    "planted usage: 18 entries x 8,000 = 144,000 tokens = 72% of the 200k window, below the 180,000 hard backstop",
  );

  const reports = tickArmingOnTurnEnd(pi);
  // Hysteresis: the first observation above the threshold only warms the count.
  compressMod.maybeArmAutoCompaction(pi, ctx);

  await emitTurnEnd(
    pi,
    ctx,
    0,
    [{ role: "toolResult", toolCallId: "bash-1", toolName: "bash", content: [] }],
    "toolUse",
  );
  assert.equal(reports.at(-1)?.armed, true, "the tick inside the live-loop boundary arms the slide");
  assert.equal(
    ctx.compactCalls.length,
    0,
    "arming inside a live-loop boundary must not abort the request the loop is about to dispatch",
  );
  assert.equal(readPendingCompactions(ctx).length, 1, "the armed slide stays queued");

  await emitTurnEnd(pi, ctx, 1, [], "stop");
  assert.equal(ctx.compactCalls.length, 1, "the next loop-done boundary lands exactly one");
  assert.equal(readPendingCompactions(ctx).length, 0, "the landed compaction leaves the queue empty");
});

await test("an auto-arm at the 0.90W backstop cuts the live loop anyway", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const world = makeWorld(23);
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  const planted = estimateMessagesTokens(world.branch.map((e) => e.message));
  assert.equal(
    planted,
    184_000,
    "planted usage: 23 entries x 8,000 = 184,000 tokens = 92% of the 200k window, at/above the 180,000 hard backstop",
  );

  const reports = tickArmingOnTurnEnd(pi);
  compressMod.maybeArmAutoCompaction(pi, ctx);

  await emitTurnEnd(pi, ctx, 0, [], "toolUse");
  assert.equal(reports.at(-1)?.armed, true, "the tick inside the boundary arms the slide");
  assert.equal(
    ctx.compactCalls.length,
    1,
    "at 184,000 tokens of a 200,000 window the arm cuts the runaway live loop (backstop exception)",
  );
});

await test("agent_settled lands an auto-arm that a toolUse boundary left queued", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const world = makeWorld(18);
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  tickArmingOnTurnEnd(pi);
  compressMod.maybeArmAutoCompaction(pi, ctx);

  await emitTurnEnd(pi, ctx, 0, [], "toolUse");
  assert.equal(ctx.compactCalls.length, 0, "parked at the live-loop boundary");

  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
  assert.equal(
    ctx.compactCalls.length,
    1,
    "the settle backstop lands it with no loop-done boundary in between",
  );
});

try {
  rmSync(FAKE_HOME, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
