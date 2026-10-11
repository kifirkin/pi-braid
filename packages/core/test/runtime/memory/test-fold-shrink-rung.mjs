/**
 * Fixture tests: the fold-shrink rung always makes progress.
 *
 * Background: a chunk merge whose OUTPUT is the merged running summary can be
 * length-stopped by the FOLD itself. The previous rung tried one rewrite and,
 * when it was refused, kept the fold and fell through to splitting the chunk's
 * INPUT, which cannot shrink the fold: the chain burned its call budget down
 * to a single unit and aborted as summary-cap, and the session then could not
 * compact. The fix is a two-step rung that always ends below the material
 * share: one bounded rewrite attempt, then a deterministic head-and-tail
 * reduction with no model call that names the elision. Contracts asserted
 * here:
 *  (1) a rewrite that ALWAYS length-stops does not wall the chain: the
 *      deterministic reduction lands, the chain completes inside the call
 *      budget, the fold is not re-attempted, and the elision is named;
 *  (2) a rewrite that refuses AND a fold that cannot be shrunk by compression
 *      still falls to the deterministic floor, and the retry merge no longer
 *      length-stops because the fold is below the material share;
 *  (3) the deterministic reduction lands the fold strictly below the material
 *      share and keeps head+tail (the loss is the middle, and it is named);
 *  (4) a summary-cap terminal failure lands the deterministic cut and clears
 *      the retry guard; a stale retry guard is cleared and dispatched instead
 *      of becoming the terminal "Retry skipped - already active".
 *
 * Run: node test/runtime/memory/test-fold-shrink-rung.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Hermetic settings isolation: the window a cycle reads comes from ctx.model.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "fold-shrink-rung-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), JSON.stringify({}));

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

const llmCallMod = await import(join(ROOT, "dist/lib/ai/llm-call.js"));
const chunkedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction-chunked.js")
);
const compactionMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);
const retryMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction-retry.js")
);
const sharedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);
const { getLogBuffer, clearLogBuffer } = await import(join(ROOT, "dist/lib/core/logger.js"));

const { __setCompleteSimpleForTest } = llmCallMod;
const {
  summarizeSpanInChunks,
  __setChunkedSummaryFailureForTest,
  __reduceFoldForTest,
  CHUNK_FOLD_TARGET_TOKENS,
  CHUNK_FOLD_CHARS_PER_TOKEN,
  CHUNK_SPLIT_CALL_BUDGET,
} = chunkedMod;
const { registerBeforeCompactHandler, registerSessionCompactFailedHandler } = compactionMod;
const { triggerCompactionRetry } = retryMod;
const { getCmState, resetCompactionRetry } = sharedMod;
const logs = () => getLogBuffer().map((l) => l.message ?? String(l)).join("\n");

let sessionSeq = 0;
function makeCtx({ branch = [], contextWindow = 128000 } = {}) {
  const sessionId = `fold-shrink-rung-${++sessionSeq}`;
  const compactCalls = [];
  return {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    model: { contextWindow, maxTokens: 32768, reasoning: true, provider: "test" },
    getContextUsage: () => ({ percent: 50, tokens: 64000, contextWindow }),
    compact: (options) => compactCalls.push(options ?? {}),
    compactCalls,
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

function makeFakePi() {
  const handlers = new Map();
  const sendMessageCalls = [];
  return {
    handlers,
    sendMessageCalls,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(params, options) {
      sendMessageCalls.push({ params, options });
    },
    async _emit(event, ctx) {
      const name = typeof event === "string" ? event : event.type;
      let last;
      for (const h of handlers.get(name) ?? []) {
        const r = await h(event, ctx);
        if (r !== undefined) last = r;
      }
      return last;
    },
  };
}

function makeMsg(i, text) {
  return {
    role: i % 2 ? "assistant" : "user",
    content: [{ type: "text", text: text ?? `msg ${i}` }],
    timestamp: 1000 + i,
  };
}

const USAGE = { input: 10, output: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0 };

// Prose on purpose: a repeated-character run is redacted as a base64 payload by
// request hygiene before it reaches the stub.
const BIG_FOLD = Array.from(
  { length: 500 },
  (_, i) => `note ${i}: the running summary keeps exact paths, identifiers, and error text`,
).join(" ");

// A cap threshold that forces the first merge to length-stop while leaving the
// reduced fold (well under it) enough headroom for the retry merge to succeed.
const FOLD_LIMIT = Math.floor(BIG_FOLD.length * 0.7);

function installFoldStub({
  foldLimit = FOLD_LIMIT,
  compressText = (fold) => fold.slice(0, Math.floor(fold.length * 0.6)),
  compressStopReason = "end_turn",
  partial = (fold) => fold.slice(0, Math.floor(fold.length / 2)),
} = {}) {
  const calls = [];
  __setCompleteSimpleForTest(async (_model, context, options) => {
    const userText =
      typeof context.messages?.[0]?.content === "string" ? context.messages[0].content : "";
    const isCompress = userText.includes("grown too long");
    const fold = (userText.match(/<running-summary>([\s\S]*?)<\/running-summary>/) ?? [])[1] ?? "";
    calls.push({ isCompress, foldChars: fold.length, maxTokens: options.maxTokens });
    if (isCompress) {
      const text = typeof compressText === "function" ? compressText(fold) : compressText;
      return { content: [{ type: "text", text }], stopReason: compressStopReason, usage: USAGE };
    }
    if (fold.length > foldLimit) {
      return { content: [{ type: "text", text: partial(fold) }], stopReason: "length", usage: USAGE };
    }
    return {
      content: [{ type: "text", text: `${fold}\nNEW-CONTENT-${calls.length}` }],
      stopReason: "end_turn",
      usage: USAGE,
    };
  });
  return calls;
}

console.log("=== fold-shrink rung: always makes progress ===\n");

// ── (1) a rewrite that always length-stops is followed by the floor ─────────
await test("(1) an always-length-stopped rewrite still lands the fold below the share", async () => {
  const calls = installFoldStub({
    compressText: (fold) => fold.slice(0, 3000),
    compressStopReason: "length",
  });
  const ctx = makeCtx();
  const result = await summarizeSpanInChunks({
    ctx,
    span: [makeMsg(0), makeMsg(1), makeMsg(2)],
    previousSummary: BIG_FOLD,
    logPrefix: "test-rung-progress",
  });
  __setCompleteSimpleForTest(null);
  assert.ok(!("error" in result), `expected a summary, got ${JSON.stringify(result)}`);
  const compressCalls = calls.filter((c) => c.isCompress);
  assert.equal(
    compressCalls.length,
    1,
    "the rung must attempt the rewrite once and then rely on the deterministic floor (no re-loop)",
  );
  assert.match(result.summary, /fold could not be compressed/, "the refusal must be named");
  assert.match(result.summary, /elided deterministically/, "the reduction must be named");
  assert.match(result.summary, /NEW-CONTENT/, "the chain must complete after the reduction");
  assert.ok(
    !result.summary.includes(BIG_FOLD),
    "the length-stopped rewrite must not be consumed as the fold, and the raw fold was elided",
  );
  assert.ok(
    calls.length <= CHUNK_SPLIT_CALL_BUDGET,
    `the chain must stay inside the call budget, got ${calls.length}`,
  );
});

// ── (2) a refused rewrite + an uncompressible fold still falls to the floor ──
await test("(2) an uncompressible fold falls to the floor and the retry merge completes", async () => {
  const calls = installFoldStub({ compressText: "" });
  const ctx = makeCtx();
  const result = await summarizeSpanInChunks({
    ctx,
    span: [makeMsg(0), makeMsg(1), makeMsg(2)],
    previousSummary: BIG_FOLD,
    logPrefix: "test-rung-floor",
  });
  __setCompleteSimpleForTest(null);
  assert.ok(!("error" in result), `expected a summary, got ${JSON.stringify(result)}`);
  assert.match(result.summary, /fold could not be compressed/, "the failed rewrite must be named");
  assert.match(result.summary, /elided deterministically/, "the floor must be named");
  assert.match(
    result.summary,
    /NEW-CONTENT/,
    "the retry merge must no longer length-stop once the fold is below the share",
  );
  assert.equal(calls.filter((c) => c.isCompress).length, 1, "one rewrite attempt");
  assert.equal(
    calls.filter((c) => !c.isCompress).length,
    2,
    "exactly the capped merge and the retry that completes",
  );
});

// ── (3) the deterministic reduction, in isolation ───────────────────────────
await test("(3) the reduction lands strictly below the material share, keeping head and tail", async () => {
  const reduced = __reduceFoldForTest(BIG_FOLD);
  assert.ok(
    Math.ceil(reduced.text.length / CHUNK_FOLD_CHARS_PER_TOKEN) < CHUNK_FOLD_TARGET_TOKENS,
    `the reduced fold must be below the ${CHUNK_FOLD_TARGET_TOKENS}-token material share, ` +
      `got ${Math.ceil(reduced.text.length / CHUNK_FOLD_CHARS_PER_TOKEN)} tokens`,
  );
  assert.ok(reduced.elidedChars > 0, "a material fold must lose something to the elision");
  assert.ok(reduced.text.length < BIG_FOLD.length, "the reduction must actually shrink the fold");
  assert.ok(
    reduced.text.startsWith(BIG_FOLD.slice(0, 100)),
    "the head of the fold must be kept",
  );
  assert.ok(
    reduced.text.endsWith(BIG_FOLD.slice(-100)),
    "the tail of the fold must be kept",
  );
  assert.match(
    reduced.text,
    /\[note: \d+ characters from the middle of the running summary were elided deterministically/,
    "the elision must be marked and its size named",
  );
});

// ── (4) the summary-cap terminal path is never a silent wedge ───────────────
function makeBranch(len) {
  return Array.from({ length: len }, (_, i) => ({
    id: `e${i}`,
    type: "message",
    message: makeMsg(i),
  }));
}

await test("(4a) a bounded failure on the retry cycle lands the deterministic cut", async () => {
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  const branch = makeBranch(40);
  const ctx = makeCtx({ branch });
  const cmState = getCmState(ctx);
  cmState.rangeMode = {
    active: true,
    startIndex: 0,
    endIndex: 3,
    topic: "test-range",
    summary: "anchor summary",
    firstKeptEntryId: "e-kept",
  };
  cmState.compactionRetryActive = true;
  __setChunkedSummaryFailureForTest("summary-cap");
  const result = await pi._emit(
    {
      type: "session_before_compact",
      preparation: {
        messagesToSummarize: [makeMsg(0), makeMsg(1)],
        turnPrefixMessages: [],
        isSplitTurn: false,
        firstKeptEntryId: "e-kept",
        tokensBefore: 12345,
      },
      customInstructions: "",
    },
    ctx,
  );
  __setChunkedSummaryFailureForTest(null);
  assert.ok(result?.compaction, "the terminal path must land a deterministic cut, not a cancel");
  assert.match(result.compaction.summary, /Deterministic cut/);
  assert.equal(getCmState(ctx).compactionRetryActive, false, "the guard must be released");
});

await test("(4b) a stale retry guard is cleared and dispatched, never terminal", async () => {
  clearLogBuffer();
  resetCompactionRetry();
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);
  const ctx = makeCtx();
  // A cancelled cycle set the guard; no cycle is in flight to report an outcome.
  getCmState(ctx).compactionRetryActive = true;
  triggerCompactionRetry(pi, ctx, 1, "stale guard fixture");
  await sleep(3350);
  assert.equal(
    ctx.compactCalls.length,
    1,
    "the stale guard must not turn 'Retry skipped - already active' into the terminal state",
  );
  assert.match(logs(), /stale/, "the recovery of the stale guard must be visible");
  resetCompactionRetry();
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
