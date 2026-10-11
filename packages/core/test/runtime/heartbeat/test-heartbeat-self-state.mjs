/**
 * Part 2 + Part 4: heartbeat self-state line.
 *
 * Owner Refine-2 directive: every heartbeat summary makes the agent
 * self-aware of its own context health. Both summary builders (the tick
 * batcher in whisper-batcher.ts and the delayed-flush builder in
 * heartbeat-scheduler/index.ts) append ONE <=40-token self-state line:
 *
 * self-state: ctx 213K tok · cache 96% · dup 39 · tps-ema 87
 *
 * Pinned here:
 * 1. line format (tokens K / cache % / dup count / tps-ema);
 * 2. n/a tolerance — a missing metric renders "n/a", NEVER zero;
 * 3. summary integration — the line lands after the clock line in both
 * single-message and batched forms; absent sample = no line (compat);
 * 4. telemetry: cache-hit share capture (usage.cacheRead) + the JSONL
 * entry field + the getSelfStateSample accessor (n/a on empty state).
 *
 * Run: node test/runtime/heartbeat/test-heartbeat-self-state.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const D = join(ROOT, "dist");

const { buildSelfStateLine, flushWhisperBuffer } = await import(
  "file://" + join(D, "extensions/heartbeat/heartbeat-scheduler/whisper-batcher.js")
);
const { noteAssistantMessageEnd, getSelfStateSample, collectAndEmitContextHeartbeat } =
  await import("file://" + join(D, "lib/telemetry/context-heartbeat.js"));
const { getExtensionState } = await import("file://" + join(D, "lib/state/extension-state.js"));

console.log("=== heartbeat self-state line ===\n");

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

function makeCtx(sessionId) {
  return {
    sessionManager: {
      getSessionFile: () => `fake-${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getEntries: () => [],
      getBranch: () => [],
    },
    getContextUsage: () => ({ percent: 23, tokens: 237_785, contextWindow: 1_000_000 }),
  };
}

// ── 1. Line format ───────────────────────────────────────────────────────────

await test("1. full sample renders the four metrics", () => {
  const line = buildSelfStateLine({
    contextTokens: 237_785,
    cacheHitShare: 96.4,
    nearDupCount: 39,
    tpsEma: 87.2,
  });
  assert.match(line, /^self-state: ctx 238K tok · cache 96% · dup 39 · tps-ema 87 tok\/s$/, line);
});

await test("2. missing metrics render n/a, never zero", () => {
  const line = buildSelfStateLine({});
  assert.ok(line.includes("ctx n/a"), "context n/a");
  assert.ok(line.includes("cache n/a"), "cache n/a");
  assert.ok(line.includes("dup n/a"), "dup n/a");
  assert.ok(line.includes("tps-ema n/a"), "tps n/a");
  assert.doesNotMatch(line, /ctx 0K/, "no zero masquerading as a healthy reading");
  const nullLine = buildSelfStateLine({
    contextTokens: null,
    cacheHitShare: null,
    nearDupCount: null,
    tpsEma: null,
  });
  assert.equal(nullLine, line, "null and missing behave identically");
});

await test("3. self-state line is compact (<= 40 tokens)", () => {
  const line = buildSelfStateLine({
    contextTokens: 237_785,
    cacheHitShare: 96.4,
    nearDupCount: 39,
    tpsEma: 87.2,
  });
  // 40 tokens ≈ 160 chars; the line must stay comfortably under.
  assert.ok(line.length <= 80, `line too long (${line.length} chars): ${line}`);
});

// ── 2. Summary integration (both builders' shared flusher) ──────────────────

await test("4. single-message summary gains the self-state line after the clock", () => {
  const sent = [];
  flushWhisperBuffer(
    [{ message: "m1", priority: "low" }],
    (text) => sent.push(text),
    "self-state: ctx 1K tok · cache n/a · dup 0 · tps n/a",
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^now: .+\nself-state: .+\nm1$/s);
});

await test("5. batched summary: line between clock and numbered items", () => {
  const sent = [];
  flushWhisperBuffer(
    [
      { message: "m1", priority: "low" },
      { message: "m2", priority: "low" },
    ],
    (text) => sent.push(text),
    "self-state: ctx 1K tok · cache 1% · dup 0 · tps 1 tok/s",
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\[Heartbeat Summary\]\nnow: .+\nself-state: .+\n1\. m1\n2\. m2/);
});

await test("6. absent sample: no self-state line (backward compatible)", () => {
  const sent = [];
  flushWhisperBuffer([{ message: "m1", priority: "low" }], (text) => sent.push(text));
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /self-state:/);
});

// ── 3. Telemetry: cache capture + accessor ──────────────────────────────────

await test("7. cache-hit share captured from usage.cacheRead (w10 signature 94-98%)", () => {
  const ctx = makeCtx("self-state-7");
  noteAssistantMessageEnd(ctx, {
    role: "assistant",
    timestamp: Date.now() - 5000,
    usage: { input: 1000, output: 500, cacheRead: 24_000, cacheWrite: 0 },
  });
  const sample = getSelfStateSample(ctx);
  // 24000/(24000+1000) = 96%
  assert.ok(
    sample.cacheHitShare !== null && Math.abs(sample.cacheHitShare - 96) < 0.1,
    `cacheHitShare=${sample.cacheHitShare}`,
  );
  assert.equal(sample.contextTokens, 237_785, "context tokens are a live read");
  assert.ok(sample.tpsEma !== null, "tps EMA captured from the same message");
});

await test("8. provider without cacheRead -> cache n/a (null, not zero)", () => {
  const ctx = makeCtx("self-state-8");
  noteAssistantMessageEnd(ctx, {
    role: "assistant",
    timestamp: Date.now() - 5000,
    usage: { input: 1000, output: 500 },
  });
  const sample = getSelfStateSample(ctx);
  assert.equal(sample.cacheHitShare, null, "no cacheRead reported -> n/a");
  const line = buildSelfStateLine(sample);
  assert.match(line, /cache n\/a/);
});

await test("9. near-dup count flows from the density evaluator state", () => {
  const ctx = makeCtx("self-state-9");
  let sample = getSelfStateSample(ctx);
  assert.equal(sample.nearDupCount, null, "no density state yet -> n/a");
  // Simulate the context-lifecycle density evaluator having run.
  getExtensionState(ctx, "context-density", () => ({ duplicates: 0 })).duplicates = 39;
  sample = getSelfStateSample(ctx);
  assert.equal(sample.nearDupCount, 39);
});

await test("10. empty ctx: every field n/a, line renders, never throws", () => {
  const sample = getSelfStateSample({});
  assert.equal(sample.contextTokens, null);
  assert.equal(sample.cacheHitShare, null);
  assert.equal(sample.tpsEma, null);
  const line = buildSelfStateLine(sample);
  assert.match(line, /self-state: ctx n\/a/);
});

await test("11. JSONL telemetry entry carries cacheHitShare (scalar, bounded)", () => {
  const dir = mkdtempSync(join(tmpdir(), "w11-selfstate-"));
  const sink = join(dir, "hb.jsonl");
  try {
    const ctx = makeCtx("self-state-11");
    noteAssistantMessageEnd(ctx, {
      role: "assistant",
      timestamp: Date.now() - 5000,
      usage: { input: 1000, output: 500, cacheRead: 24_000 },
    });
    const sample = collectAndEmitContextHeartbeat(ctx, { sinkFile: sink });
    assert.ok(sample.entry.cacheHitShare !== null, "entry.cacheHitShare present");
    const parsed = JSON.parse(readFileSync(sink, "utf-8").trim().split("\n").pop());
    assert.equal(parsed.cacheHitShare, sample.entry.cacheHitShare);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
