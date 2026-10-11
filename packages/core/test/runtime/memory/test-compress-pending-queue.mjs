/**
 * context_compress pending-compaction queue: drain and coalesce at a safe
 * boundary (settle pinned here).
 *
 * The batch-settle scheduler keeps a bounded pending LIST now. At a safe
 * boundary (agent_settled pinned here; turn_end joins it as a boundary) the
 * queue drains into ONE compaction:
 *   - a pending slide subsumes a pending archive: the cut lands at the
 *     EARLIEST declared boundary (the archive's firstKeptEntryId), the
 *     archive anchor/summary record (inside the kept span) survives, and
 *     only one aborting compact fires;
 *   - LLM-class-only queues fire the first-armed trigger (its range/anchor
 *     state was persisted at arm time);
 *   - a single pending entry behaves exactly as before.
 *
 * Old behavior (regression guarded here): `pending` was ONE slot; a second
 * armed compaction (e.g. the live slide at 12:04:30Z after the 11:58 archive)
 * silently OVERWROTE the first — the archive's compaction never existed
 * anywhere afterwards (forensics V1, "single-slot clobber").
 *
 * Run: node test/runtime/memory/test-compress-pending-queue.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic settings: pin the window braid resolves (the archive handler's
// percent math decides whether a follow-up compact is armed) so the fixture
// never depends on the live settings.json.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w218-queue-home-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(FAKE_HOME, ".pi", "agent", "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: 200_000 } } }),
);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const D = join(ROOT, "dist");

const { registerContextCompress } = await import(
  join(D, "extensions/memory/context-manager/handlers/tools/context-compress.js")
);
const { getCmState } = await import(
  join(D, "extensions/memory/context-manager/handlers/shared.js")
);

console.log("=== context_compress pending queue: drain + coalesce ===\n");

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

const ACT_KEEP = 40;
const ENTRIES = 60;

/**
 * Synthetic session with a REAL, growable branch array: appendCustomEntry
 * pushes into the branch (the archive anchor record must be a real branch
 * entry for the coalescing boundary math, as it is in pi).
 */
let worldSeq = 0;
function makeWorld(entries = ENTRIES) {
  const branch = [];
  for (let i = 0; i < entries; i++) {
    // ~1333 tokens per entry: the default 60 entries = ~80k tokens = 40% of
    // the pinned 200k window — above the <30% skip guards in the
    // slide/archive paths.
    branch.push({
      id: `e${i}`,
      type: "message",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: [{ type: "text", text: `msg ${i} ${"x".repeat(5327)}` }],
      },
    });
  }
  // Unique session file per world: extension state (pending queue, slideMode)
  // is keyed on the session file — a constant would share state across tests.
  const sessionFile = `/tmp/w218-queue-${++worldSeq}.jsonl`;
  const ctx = {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    compactCalls: [],
    compact(options) {
      this.compactCalls.push(options);
    },
    sessionManager: {
      getSessionId: () => `w218-queue-${worldSeq}`,
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

async function settle(pi, ctx) {
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);
}

/** Run one tool call inside a live batch (inFlight>0): pendings stay parked until settle. */
async function runInBatch(pi, tool, ctx, toolCallId, params) {
  await pi._emit({ type: "tool_execution_start", toolCallId, toolName: "context_compress" }, ctx);
  const result = await tool.execute(toolCallId, params, undefined, undefined, ctx);
  await pi._emit(
    { type: "tool_execution_end", toolCallId, toolName: "context_compress", result: {} },
    ctx,
  );
  return result;
}

await test("archive pending, then slide pending: ONE compaction at the earliest declared boundary", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  assert.ok(tool, "context_compress registered");
  // 100 entries: the slide's own cut (keep=40 -> index 60) lands LATER than
  // the archive's declared boundary (index 30), so the archive's declaration
  // is the decisive earliest cut — the coalesced compaction must honor it.
  const world = makeWorld(100);
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  // 1. Archive [0..29] declared: firstKeptEntryId = branch[30]. The anchor
  //    record (context_compression custom entry) lands at the branch end.
  const result = await runInBatch(pi, tool, ctx, "cc-1", {
    action: "archive",
    startIndex: 0,
    endIndex: 29,
    topic: "w218 phase",
    summary: "Owner: did X. Braid: did Y.",
  });
  assert.ok(!result.details?.error, `archive accepted: ${result.content?.[0]?.text ?? ""}`);
  const branchAtAnchor = ctx.sessionManager.getBranch();
  const anchorIndex = branchAtAnchor.findIndex((e) => e.id === "custom-100");
  assert.ok(anchorIndex > 0, "archive anchor record appended to the branch");
  const archiveBoundaryId = branchAtAnchor[30].id;

  // 2. Slide armed while the archive is still pending (the 12:04:30Z clobber
  //    shape): the slide's own cut is the last 40 entries.
  await runInBatch(pi, tool, ctx, "cc-2", { action: "slide", keep: ACT_KEEP });

  // 3. Settle: exactly ONE aborting compact, coalesced to the slide trigger
  //    with the cut re-pointed at the EARLIEST boundary (the archive's).
  await settle(pi, ctx);
  assert.equal(
    ctx.compactCalls.length,
    1,
    "the queue must drain into exactly one compaction (no second aborting compact)",
  );
  assert.match(
    String(ctx.compactCalls[0]?.customInstructions ?? ""),
    /SLIDE_MODE/,
    "the fired compaction is the deterministic slide",
  );
  const slide = getCmState(ctx).slideMode;
  assert.ok(slide?.active, "slide state armed for the compaction branch");
  assert.equal(
    slide.cutEntryId,
    archiveBoundaryId,
    "cut coalesced to the EARLIEST declared boundary (the archive's firstKeptEntryId), " +
      `got ${slide.cutEntryId}, want ${archiveBoundaryId}`,
  );
  assert.ok(
    slide.keepCount > ACT_KEEP,
    "the coalesced slide keeps MORE than the plain slide cut (the archive span is preserved)",
  );
  assert.ok(anchorIndex > 30, "archive anchor record survives inside the kept span");
});

await test("single pending entry still fires exactly once (previous contract preserved)", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld();
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  await runInBatch(pi, tool, ctx, "cc", { action: "slide", keep: ACT_KEEP });
  await sleep(20);
  assert.equal(ctx.compactCalls.length, 0, "parked until settle");

  await settle(pi, ctx);
  assert.equal(ctx.compactCalls.length, 1, "one pending compaction fires once at settle");
  assert.match(String(ctx.compactCalls[0]?.customInstructions ?? ""), /SLIDE_MODE/);
});

await test("two slides pending: coalesce to the earliest cut, one compaction", async () => {
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  const world = makeWorld();
  const ctx = world.ctx;
  pi.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);

  await runInBatch(pi, tool, ctx, "cc-1", { action: "slide", keep: 50 });
  await runInBatch(pi, tool, ctx, "cc-2", { action: "slide", keep: ACT_KEEP });
  await settle(pi, ctx);

  assert.equal(ctx.compactCalls.length, 1, "coalesced into one compaction");
  const slide = getCmState(ctx).slideMode;
  const branch = ctx.sessionManager.getBranch();
  // The earliest DECLARED cut: the keep=50 slide armed when the branch held
  // 60 entries (before its own audit entry), so its cut is index 10.
  const declaredEarliest = world.branch[10].id;
  assert.equal(
    slide.cutEntryId,
    declaredEarliest,
    "the earliest cut (keep=50, armed first) wins over the later smaller cut",
  );
  assert.ok(
    slide.keepCount > 50,
    "the coalesced keep window covers everything after the earliest cut",
  );
  void branch;
});

try {
  rmSync(FAKE_HOME, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
