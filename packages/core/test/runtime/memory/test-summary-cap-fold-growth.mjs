/**
 * Fixture test: the chunked summarizer's length-stop ladder + the controller's
 * never-block rung.
 *
 * Background (live incident Sep 26, 2026): the chunked summarizer folds a
 * monotonically growing running summary, and each call's OUTPUT is the merged
 * summary ("output only that summary"). Once the fold approached the merge
 * budget every later chunk was length-stopped no matter how small its own
 * input was - the log's tell was "chunk 6/14: 2 msgs, ~46 tokens est,
 * maxTokens 8192" - and the split-on-cap recovery split the chunk's INPUT,
 * which cannot shrink the fold: the call budget burned down to a single unit,
 * the cycle aborted as summary-cap, and the retry ladder then answered
 * "already active" forever (a cancelled cycle never fires session_compact, so
 * the retry guard it set was never cleared).
 *
 * Contracts asserted here:
 *  (a) fold growth completes: a merge length-stopped by the fold triggers ONE
 *      bounded fold-compression call (its own budget, reasoning off) and the
 *      chain finishes with every part merged;
 *  (b) a partial generation shorter than the running fold is NOT written over
 *      the fold (that would erase a summary that already landed): the fold
 *      survives and the part is recorded as unmerged;
 *  (b2) the fold-compression rung carries the same floor: a rewrite is accepted
 *      only when it is not itself length-stopped AND keeps at least
 *      CHUNK_FOLD_MIN_KEEP_SHARE of the fold. A refused rewrite is not a dead
 *      end: it falls to the deterministic head-and-tail reduction, which lands
 *      the fold below CHUNK_FOLD_TARGET_TOKENS with no model call and names both
 *      the refusal and the elision in the result note;
 *  (c) a partial generation at least as long as the fold is accepted;
 *  (d) an over-cap chunk with a single unit accepts its partial instead of
 *      failing the cycle (no split is possible, and the input is not the axis
 *      that overflowed);
 *  (e) the controller takes the deterministic no-LLM cut when the bounded
 *      summarizer fails on a retry cycle, and clears the retry guard either
 *      way (a cancelled cycle must not wedge the ladder).
 *
 * Run: node test/runtime/memory/test-summary-cap-fold-growth.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Hermetic settings isolation: the window a cycle reads comes from ctx.model
// below, never from the operator's settings.json.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "sumcap-fold-"));
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

const llmCallMod = await import(join(ROOT, "dist/lib/ai/llm-call.js"));
const chunkedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction-chunked.js")
);
const compactionMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);
const sharedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);

const { __setCompleteSimpleForTest } = llmCallMod;
const {
  summarizeSpanInChunks,
  planChunks,
  __setChunkedSummaryFailureForTest,
  CHUNK_SUMMARY_MAX_TOKENS,
  CHUNK_FOLD_COMPRESS_MAX_TOKENS,
  CHUNK_FOLD_MIN_KEEP_SHARE,
  CHUNK_FOLD_TARGET_TOKENS,
  CHUNK_FOLD_CHARS_PER_TOKEN,
  CHUNK_INPUT_TOKEN_FRACTION,
  CHUNK_MIN_INPUT_TOKENS,
} = chunkedMod;
const { registerBeforeCompactHandler } = compactionMod;
const { getCmState } = sharedMod;

let sessionSeq = 0;
function makeCtx({ branch = [], contextWindow = 128000 } = {}) {
  const sessionId = `sumcap-fold-${++sessionSeq}`;
  return {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    model: { contextWindow, maxTokens: 32768, reasoning: true, provider: "test" },
    getContextUsage: () => ({ percent: 50, tokens: 64000, contextWindow }),
    compact: () => {},
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
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
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
    sendMessage() {},
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

/**
 * Stub completeSimple behind callLlm. Merge calls return the fold plus a
 * NEW-CONTENT marker (so merging is observable); a merge whose fold exceeds
 * `foldLimit` chars - or every merge under `alwaysCap` - is length-stopped,
 * returning `partial(fold)` as the generation got that far. Fold-compression
 * calls (they carry the rewrite instruction) return `compressText`.
 */
function installFoldStub({
  foldLimit = FOLD_LIMIT,
  alwaysCap = false,
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
    calls.push({
      isCompress,
      maxTokens: options.maxTokens,
      reasoning: options.reasoning,
      foldChars: fold.length,
    });
    if (isCompress) {
      const text = typeof compressText === "function" ? compressText(fold) : compressText;
      return { content: [{ type: "text", text }], stopReason: compressStopReason, usage: USAGE };
    }
    if (alwaysCap || fold.length > foldLimit) {
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

// Prose on purpose: a long run of a single repeated character is redacted as a
// base64 payload by the request hygiene pass (lib/ai/payload-hygiene.ts) before
// the call, so a repeated-char fold never reaches the stub.
const BIG_FOLD = Array.from(
  { length: 500 },
  (_, i) => `note ${i}: the running summary keeps exact paths, identifiers, and error text`,
).join(" ");

// A cap threshold that forces the first merge to length-stop while leaving the
// honest rewrite (60% of the fold) enough headroom for the retry to fit. It
// must sit above CHUNK_FOLD_MIN_KEEP_SHARE (50%) or no single rewrite could be
// both accepted and small enough to complete the merge.
const FOLD_LIMIT = Math.floor(BIG_FOLD.length * 0.7);

// Exact-length prose for rewrites that must land on the keep floor. Built from
// whole words so no run is a single repeated character (request hygiene
// redacts those) and never ending in whitespace, so the ladder's `.trim()`
// cannot shift the length by one.
const PROSE_WORDS = "verbatim identifiers exact paths and error text must survive".split(" ");
function prose(n) {
  let s = "";
  let i = 0;
  while (s.length < n) {
    const word = PROSE_WORDS[i++ % PROSE_WORDS.length];
    s += (s ? " " : "") + word;
  }
  s = s.slice(0, n);
  return /\s$/.test(s) ? `${s.slice(0, n - 1)}.` : s;
}

// ── (a) fold growth completes through one bounded fold compression ──────────
await test("(a) a merge capped by the fold compresses the fold once and finishes", async () => {
  const calls = installFoldStub();
  const ctx = makeCtx();
  const result = await summarizeSpanInChunks({
    ctx,
    span: [makeMsg(0), makeMsg(1), makeMsg(2)],
    previousSummary: BIG_FOLD,
    logPrefix: "test-fold-growth",
  });
  __setCompleteSimpleForTest(null);
  assert.ok(!("error" in result), `expected a summary, got ${JSON.stringify(result)}`);
  assert.match(result.summary, /NEW-CONTENT/, "every part must be merged into the final summary");
  const compressCalls = calls.filter((c) => c.isCompress);
  assert.equal(compressCalls.length, 1, "exactly one fold compression per capped chunk");
  assert.equal(compressCalls[0].maxTokens, CHUNK_FOLD_COMPRESS_MAX_TOKENS);
  assert.equal(compressCalls[0].reasoning, "off");
  const mergeCalls = calls.filter((c) => !c.isCompress);
  assert.ok(mergeCalls.length >= 2, "the capped merge must be retried after the compression");
  for (const c of mergeCalls) assert.equal(c.maxTokens, CHUNK_SUMMARY_MAX_TOKENS);
});

// ── (b) a partial shorter than the fold must not erase the fold ─────────────
await test("(b) a too-short partial merge keeps the fold and records the part", async () => {
  installFoldStub({ alwaysCap: true, compressText: "", partial: () => "SHORT-PARTIAL-MARKER" });
  const ctx = makeCtx();
  const result = await summarizeSpanInChunks({
    ctx,
    span: [makeMsg(0), makeMsg(1)],
    previousSummary: BIG_FOLD,
    logPrefix: "test-fold-keep",
  });
  __setCompleteSimpleForTest(null);
  assert.ok(!("error" in result), `expected a summary, got ${JSON.stringify(result)}`);
  assert.ok(
    !result.summary.includes("SHORT-PARTIAL-MARKER"),
    "a partial shorter than the fold must not replace it",
  );
  assert.ok(
    result.summary.includes(BIG_FOLD.slice(0, 2000)),
    "the fold's head must survive a shorter partial merge",
  );
  assert.match(result.summary, /\[note: part\(s\) .* were not merged/);
});

// ── (c) a partial at least as long as the fold is accepted ─────────────────
await test("(c) a partial merge that advanced the fold is accepted", async () => {
  installFoldStub({
    alwaysCap: true,
    partial: (fold) => `${fold}\nPARTIAL-NEW${"x".repeat(10)}`,
  });
  const ctx = makeCtx();
  const result = await summarizeSpanInChunks({
    ctx,
    span: [makeMsg(0), makeMsg(1)],
    previousSummary: BIG_FOLD,
    logPrefix: "test-fold-accept",
  });
  __setCompleteSimpleForTest(null);
  assert.ok(!("error" in result), `expected a summary, got ${JSON.stringify(result)}`);
  assert.match(result.summary, /PARTIAL-NEW/, "the partial merge must be accepted");
  assert.doesNotMatch(result.summary, /were not merged/);
});

// ── (d) an over-cap single unit accepts its partial ────────────────────────
await test("(d) an over-cap chunk with one unit accepts its partial", async () => {
  const window = 32768;
  const giant = makeMsg(0, "G".repeat(200000));
  const cap = Math.max(CHUNK_MIN_INPUT_TOKENS, Math.floor(window * CHUNK_INPUT_TOKEN_FRACTION));
  const chunks = planChunks([giant], window);
  assert.ok(chunks && chunks.length === 1, "the giant unit must plan as its own chunk");
  assert.ok(
    chunks[0].estimatedTokens > cap,
    `expected an over-cap chunk (est ${chunks[0].estimatedTokens} > cap ${cap})`,
  );
  installFoldStub({ alwaysCap: true, partial: () => "PARTIAL-TEXT" });
  const ctx = makeCtx({ contextWindow: window });
  const result = await summarizeSpanInChunks({
    ctx,
    span: [giant],
    logPrefix: "test-overcap",
  });
  __setCompleteSimpleForTest(null);
  assert.ok(!("error" in result), `expected a summary, got ${JSON.stringify(result)}`);
  assert.equal(result.summary, "PARTIAL-TEXT");
});

// ── (e) controller: deterministic cut on a retry cycle + guard release ─────
function makeBranch(len) {
  return Array.from({ length: len }, (_, i) => ({
    id: `e${i}`,
    type: "message",
    message: makeMsg(i),
  }));
}

async function fireRangeCycle({ retryCycle }) {
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
  cmState.compactionRetryActive = retryCycle;
  __setChunkedSummaryFailureForTest("summary-cap");
  const prep = {
    messagesToSummarize: [makeMsg(0), makeMsg(1)],
    turnPrefixMessages: [],
    isSplitTurn: false,
    firstKeptEntryId: "e-kept",
    tokensBefore: 12345,
  };
  const result = await pi._emit(
    { type: "session_before_compact", preparation: prep, customInstructions: "" },
    ctx,
  );
  __setChunkedSummaryFailureForTest(null);
  return { result, ctx, branch, cmState };
}

await test("(e) a bounded failure on a retry cycle lands the deterministic cut", async () => {
  const { result, ctx, branch } = await fireRangeCycle({ retryCycle: true });
  assert.ok(result?.compaction, "expected an extension compaction result, not a cancel");
  assert.match(result.compaction.summary, /Deterministic cut after a bounded summarizer failure/);
  const keepCount = Math.min(50, Math.max(10, Math.floor(branch.length * 0.3)));
  const cutIndex = Math.max(0, branch.length - keepCount);
  assert.equal(result.compaction.firstKeptEntryId, branch[cutIndex].id);
  assert.equal(getCmState(ctx).compactionRetryActive, false, "the retry guard must be released");
});

await test("(f) a bounded failure on a first cycle cancels and releases the guard", async () => {
  const { result, ctx } = await fireRangeCycle({ retryCycle: false });
  assert.equal(result?.cancel, true, "a first-cycle bounded failure still cancels");
  assert.equal(getCmState(ctx).cancelSource, "summary-cap");
  assert.equal(
    getCmState(ctx).compactionRetryActive,
    false,
    "a cancelled cycle must not leave the retry guard set (the ladder would answer 'already active' forever)",
  );
});

// ── (g) a length-stopped rewrite keeps the fold and continues the ladder ─────
await test("(g) a length-stopped rewrite is refused and the fold is reduced deterministically", async () => {
  const calls = installFoldStub({
    compressText: (fold) => fold.slice(0, 3000),
    compressStopReason: "length",
  });
  const ctx = makeCtx();
  const result = await summarizeSpanInChunks({
    ctx,
    span: [makeMsg(0), makeMsg(1), makeMsg(2)],
    previousSummary: BIG_FOLD,
    logPrefix: "test-length-stop-refuse",
  });
  __setCompleteSimpleForTest(null);
  assert.ok(!("error" in result), `expected a summary, got ${JSON.stringify(result)}`);
  assert.ok(calls.some((c) => c.isCompress), "the fold compression must have been attempted");
  assert.match(result.summary, /fold could not be compressed/, "the refusal must be named");
  assert.match(result.summary, /elided deterministically/, "the reduction must be named");
  assert.ok(
    !result.summary.includes(BIG_FOLD),
    "a length-stopped rewrite must not be consumed as a successful fold",
  );
  assert.match(result.summary, /NEW-CONTENT/, "the chain must complete after the reduction");
  assert.ok(
    calls.length <= chunkedMod.CHUNK_SPLIT_CALL_BUDGET,
    `the chain must stay inside the call budget, got ${calls.length}`,
  );
});

// ── (h) a degenerate rewrite below the floor is refused ──────────────────────
await test("(h) a sub-floor rewrite is refused and the fold is reduced deterministically", async () => {
  installFoldStub({ compressText: prose(200) });
  const ctx = makeCtx();
  const result = await summarizeSpanInChunks({
    ctx,
    span: [makeMsg(0), makeMsg(1), makeMsg(2)],
    previousSummary: BIG_FOLD,
    logPrefix: "test-short-rewrite-refuse",
  });
  __setCompleteSimpleForTest(null);
  assert.ok(!("error" in result), `expected a summary, got ${JSON.stringify(result)}`);
  assert.match(result.summary, /fold could not be compressed/, "the sub-floor refusal must be named");
  assert.match(result.summary, /elided deterministically/, "the reduction must be named");
  assert.ok(
    !result.summary.includes(BIG_FOLD),
    "a sub-floor rewrite must not be consumed as the fold",
  );
  assert.ok(
    Math.ceil(result.summary.length / CHUNK_FOLD_CHARS_PER_TOKEN) < CHUNK_FOLD_TARGET_TOKENS + 200,
    "the reduced fold must land near the material share, not stay unbounded",
  );
});

// ── (i) an honest rewrite at or above the floor is accepted ──────────────────
await test("(i) an honest rewrite clears the floor and replaces the fold", async () => {
  const calls = installFoldStub({
    compressText: (fold) => `COMPRESSED-MARKER ${prose(Math.floor(fold.length * 0.6))}`,
  });
  const ctx = makeCtx();
  const result = await summarizeSpanInChunks({
    ctx,
    span: [makeMsg(0), makeMsg(1), makeMsg(2)],
    previousSummary: BIG_FOLD,
    logPrefix: "test-honest-rewrite",
  });
  __setCompleteSimpleForTest(null);
  assert.ok(!("error" in result), `expected a summary, got ${JSON.stringify(result)}`);
  assert.match(result.summary, /COMPRESSED-MARKER/, "the accepted rewrite must become the fold");
  assert.match(result.summary, /NEW-CONTENT/, "the merge must complete on the compressed fold");
  assert.ok(!result.summary.includes(BIG_FOLD), "the fold must have been replaced by the rewrite");
  assert.equal(calls.filter((c) => c.isCompress).length, 1, "exactly one fold compression");
  assert.doesNotMatch(result.summary, /fold could not be compressed/);
});

// ── (j) the keep-floor boundary ──────────────────────────────────────────────
await test("(j) exactly the floor is accepted, one char under is refused", async () => {
  const floor = Math.floor(BIG_FOLD.length * CHUNK_FOLD_MIN_KEEP_SHARE);

  installFoldStub({ compressText: () => prose(floor) });
  let ctx = makeCtx();
  let result = await summarizeSpanInChunks({
    ctx,
    span: [makeMsg(0), makeMsg(1), makeMsg(2)],
    previousSummary: BIG_FOLD,
    logPrefix: "test-floor-exact",
  });
  __setCompleteSimpleForTest(null);
  assert.ok(!("error" in result), `expected a summary, got ${JSON.stringify(result)}`);
  assert.match(result.summary, /NEW-CONTENT/, "a rewrite at exactly the floor must be accepted");
  assert.doesNotMatch(result.summary, /fold could not be compressed/);

  installFoldStub({ compressText: () => prose(floor - 1) });
  ctx = makeCtx();
  result = await summarizeSpanInChunks({
    ctx,
    span: [makeMsg(0), makeMsg(1), makeMsg(2)],
    previousSummary: BIG_FOLD,
    logPrefix: "test-floor-under",
  });
  __setCompleteSimpleForTest(null);
  assert.ok(!("error" in result), `expected a summary, got ${JSON.stringify(result)}`);
  assert.match(result.summary, /fold could not be compressed/, "one char under must be refused");
  assert.match(result.summary, /elided deterministically/, "the reduction must be named");
  assert.ok(
    !result.summary.includes(BIG_FOLD),
    "the refused rewrite must not be consumed as the fold",
  );
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);