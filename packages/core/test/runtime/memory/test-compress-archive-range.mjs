/**
 * Fixture test: context_compress(action="archive") must make the user's
 * DECLARED range the real compaction boundary and render the user summary into
 * the compaction instructions (commitment-preserving anchor).
 *
 * The archive action sets cmState.rangeMode; session_before_compact consumes it:
 * - prep.firstKeptEntryId = <entry AFTER the declared span> (endIndex+1)
 * - prep.messagesToSummarize = the declared span (kept, NOT emptied)
 * - prep.turnPrefixMessages = [] and isSplitTurn = false
 * - event.customInstructions carries the user summary as an anchor
 * - rangeMode is reset (one-shot) so later compactions are unaffected.
 *
 * Old behavior: the declared range was write-only metadata; pi-core used its own
 * token-budget boundary and the user summary was dropped. This test fails on
 * that code (firstKeptEntryId never lands after the declared span) and passes
 * once rangeMode is honored.
 *
 * Run: node test/runtime/memory/test-compress-archive-range.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Hermeticity pin - MUST run before the dist import below. The usage percent
// that arms the follow-up compact comes from the resolved context window:
// resolveWindow() reads braid.context.contextLimitTokens from the agent
// settings.json. Left unpointed, that is the operator's live file (a
// 384000-token window here), the branch below measures ~23% instead of 45%,
// the archive path reads "already low" (<30%) and never arms a compact - 0
// compact events where this test expects 1. Own the input instead: HOME and
// PI_CODING_AGENT_DIR point at a temp dir whose settings.json fixes the
// 200000-token window the branch sizes assume.
const FIXTURE_HOME = mkdtempSync(join(tmpdir(), "compress-archive-range-home-"));
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
const { registerBeforeCompactHandler } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);
const { getCmState } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
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
    // The API seam; this suite points it at the fake session manager below.
    appendEntry() {},
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
function makeFakeCtx({ percent = 45, branchLength = 12 } = {}) {
  const sessionId = `sess-${++sessionSeq}`;
  const branch = [];
  for (let i = 0; i < branchLength; i++) {
    branch.push({
      id: `e${i}`,
      type: "message",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: [
          {
            type: "text",
            // Branch content sized so the session-tree measure (the live
            // metric's source) reports the intended percent; the fake
            // accessor below stays in agreement with the branch.
            text: `msg ${i} ${"x".repeat(
              Math.max(0, Math.round(((percent / 100) * 200000 * 4) / branchLength) - 7),
            )}`,
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
    getContextUsage: () => ({
      percent,
      tokens: Math.round((percent / 100) * 200000),
      contextWindow: 200000,
    }),
    compactCalls: [],
    compact(options) {
      this.compactCalls.push(options);
    },
    lastCustomEntry: null,
    sessionManager: {
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-1",
      getBranch: () => branch,
      getTree: () => branch.map((e) => ({ entry: { id: e.id, type: e.type } })),
      getChildren: () => [],
      getLabel: () => undefined,
      appendCustomEntry: (kind, data) => {
        ctx.lastCustomEntry = { kind, data };
      },
    },
  };
  return ctx;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("=== context_compress archive range-mode ===\n");

await test("archive honors declared range: boundary after span + summary anchor", async () => {
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 45, branchLength: 12 });
  pi.appendEntry = (kind, data) => ctx.sessionManager.appendCustomEntry(kind, data);
  registerContextCompress(pi);
  registerBeforeCompactHandler(pi);

  const tool = pi.tools.get("context_compress");
  assert.ok(tool, "context_compress tool registered");

  const summary = "USER-ANCHOR: refactored X into Y; decision to use Z; next step is W.";
  const result = await tool.execute(
    "ac-1",
    { action: "archive", startIndex: 2, endIndex: 7, topic: "refactor", summary },
    undefined,
    undefined,
    ctx,
  );

  // rangeMode must be persisted with the entry AFTER the declared span as boundary.
  const rangeMode = getCmState(ctx).rangeMode;
  assert.ok(rangeMode, "rangeMode persisted by archive action");
  assert.equal(rangeMode.active, true);
  assert.equal(rangeMode.endIndex, 7);
  assert.equal(rangeMode.firstKeptEntryId, "e8", "boundary lands at branch entry endIndex+1 (=e8)");
  assert.equal(rangeMode.boundaryIsBranchEnd, false);
  assert.equal(rangeMode.summary, summary);

  // The compaction is triggered (real usage 45% >= 30%, not skipped on an estimate).
  await sleep(30);
  assert.equal(ctx.compactCalls.length, 1, "compact fires for mid-context archive");
  assert.ok(result.details.honorRange === true, "details mark honorRange");

  // Now simulate pi-core's compact() firing session_before_compact.
  const prep = {
    firstKeptEntryId: "whatever",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
  };
  const evt = { type: "session_before_compact", preparation: prep };
  await pi._emit(evt, ctx);

  assert.equal(
    prep.firstKeptEntryId,
    "e8",
    "declared endIndex becomes the compaction boundary (firstKeptEntryId after the span)",
  );
  assert.equal(
    prep.messagesToSummarize.length,
    6,
    "declared span [2..7] is the summarize set (6 messages), not emptied",
  );
  assert.equal(prep.turnPrefixMessages.length, 0, "no turn-prefix summary for a declared span");
  assert.equal(prep.isSplitTurn, false);
  assert.ok(
    String(evt.customInstructions).includes("---ANCHOR---"),
    "compaction instructions carry the anchor marker",
  );
  assert.ok(
    String(evt.customInstructions).includes(summary),
    "user summary text reaches the compaction instructions",
  );

  // One-shot: rangeMode reset after consumption.
  assert.equal(getCmState(ctx).rangeMode, null, "rangeMode reset after consumption");
});

await test("rangeMode does not leak into a later normal compaction", async () => {
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 45, branchLength: 12 });
  pi.appendEntry = (kind, data) => ctx.sessionManager.appendCustomEntry(kind, data);
  registerContextCompress(pi);
  registerBeforeCompactHandler(pi);
  const tool = pi.tools.get("context_compress");

  await tool.execute(
    "ac-2",
    { action: "archive", startIndex: 0, endIndex: 3, topic: "t", summary: "S" },
    undefined,
    undefined,
    ctx,
  );
  await sleep(30);
  assert.equal(ctx.compactCalls.length, 1);

  // Consume rangeMode once.
  const prepA = { messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false };
  await pi._emit({ type: "session_before_compact", preparation: prepA }, ctx);
  assert.equal(getCmState(ctx).rangeMode, null, "rangeMode null after one consumption");

  // A second compaction (new cycle) must NOT re-apply the consumed range.
  const prepB = { messagesToSummarize: ["m"], turnPrefixMessages: ["x"], isSplitTurn: true };
  await pi._emit({ type: "session_before_compact", preparation: prepB }, ctx);
  assert.notEqual(
    prepB.firstKeptEntryId,
    "e4",
    "a later (non-range) compaction must not inherit the consumed range boundary",
  );
});

rmSync(FIXTURE_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
