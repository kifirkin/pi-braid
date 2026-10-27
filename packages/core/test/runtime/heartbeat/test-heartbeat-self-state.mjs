/**
 * Part 2 + Part 4: heartbeat self-state line.
 *
 * Every heartbeat delivery carries ONE self-state line so the agent knows the
 * size of its own context. The line's contract is deliberately small:
 *
 * 1. one meter reading - token count and percent from the same snapshot;
 * 2. the meter's own provenance word beside the percent, because a percentage
 *    with no provenance cannot be told from a badly counted one;
 * 3. no metric that names no action (cache-hit share, near-duplicate count,
 *    tok/s trend, hygiene acts live in the telemetry JSONL and the tools an
 *    agent calls while diagnosing);
 * 4. n/a tolerance - a missing reading renders "n/a", NEVER zero;
 * 5. summary integration - the line lands after the clock line in both
 *    single-message and batched forms; absent sample = no line (compat).
 *
 * The sample is also pinned for the one-instrument rule: size, percent and
 * provenance come from the meter, and when the meter has nothing the line says
 * n/a rather than borrowing the provider accessor's number.
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

/**
 * A context whose session tree carries one assistant message with provider
 * usage, so the meter has a real anchor to measure.
 */
function makeCtx(sessionId) {
  return {
    sessionManager: {
      getSessionFile: () => `fake-${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getEntries: () => [],
      getBranch: () => [
        // The turn's prompt first: the meter walks from the compaction
        // boundary (or index 0) and anchors on the assistant message after it.
        { type: "message", message: { role: "user", content: "go" } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: "ok",
            stopReason: "end_turn",
            usage: { totalTokens: 237_785, input: 237_000, output: 785 },
          },
        },
      ],
    },
    model: { contextWindow: 1_000_000 },
    getContextUsage: () => ({ percent: 23, tokens: 237_785, contextWindow: 1_000_000 }),
  };
}

/** A context with no session tree at all: the meter has nothing to measure. */
function makeEmptyTreeCtx() {
  return {
    sessionManager: {
      getSessionFile: () => "fake-empty.jsonl",
      getSessionId: () => "empty-tree",
      getEntries: () => [],
      getBranch: () => [],
    },
    getContextUsage: () => ({ percent: 23, tokens: 237_785, contextWindow: 1_000_000 }),
  };
}

// ── 1. Line format ───────────────────────────────────────────────────────────

await test("1. renders the count with the percent and the meter's provenance word", () => {
  const line = buildSelfStateLine({
    contextTokens: 237_785,
    contextPercent: 23.7785,
    contextProvenance: "measured",
  });
  assert.equal(line, "self-state: ctx 238K tok (23.8% measured)");
});

await test("2. a percent without a provenance word is not rendered at all", () => {
  // The guard is structural: an unlabelled percentage is the class that cost a
  // session its window, so the renderer refuses to print one.
  const line = buildSelfStateLine({ contextTokens: 237_785, contextPercent: 23.7785 });
  assert.equal(line, "self-state: ctx 238K tok");
  assert.doesNotMatch(line, /%/, "no percentage without provenance");
});

await test("3. an unavailable reading renders n/a, never zero", () => {
  const line = buildSelfStateLine({});
  assert.equal(line, "self-state: ctx n/a");
  assert.doesNotMatch(line, /ctx 0K/, "no zero masquerading as a healthy reading");
  const nullLine = buildSelfStateLine({
    contextTokens: null,
    contextPercent: null,
    contextProvenance: null,
  });
  assert.equal(nullLine, line, "null and missing behave identically");
});

await test("4. the line carries no metric a reader cannot act on", () => {
  const line = buildSelfStateLine({
    contextTokens: 237_785,
    contextPercent: 23.7785,
    contextProvenance: "estimated",
    cacheHitShare: 96.4,
    nearDupCount: 39,
    tpsEma: 87.2,
    hygieneActs: 0,
  });
  for (const dropped of ["cache", "dup", "tps", "acts"]) {
    assert.ok(!line.includes(dropped), `"${dropped}" names no action: ${line}`);
  }
});

await test("5. the line is compact (one line, bounded length)", () => {
  const line = buildSelfStateLine({
    contextTokens: 237_785,
    contextPercent: 23.7785,
    contextProvenance: "measured + 12K estimated x1.05",
  });
  assert.ok(!line.includes("\n"), `one line: ${line}`);
  assert.ok(line.length <= 90, `line too long (${line.length} chars): ${line}`);
});

// ── 2. Summary integration (both builders' shared renderer) ──────────────────

await test("6. single-message summary gains the self-state line after the clock", () => {
  const sent = [];
  flushWhisperBuffer(
    [{ message: "m1", priority: "low" }],
    (text) => sent.push(text),
    "self-state: ctx 1K tok (1.0% measured)",
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^now: .+\nself-state: .+\nm1$/s);
});

await test("7. batched summary: line between clock and numbered items", () => {
  const sent = [];
  flushWhisperBuffer(
    [
      { message: "m1", priority: "low" },
      { message: "m2", priority: "low" },
    ],
    (text) => sent.push(text),
    "self-state: ctx 1K tok (1.0% measured)",
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\[Heartbeat Summary\]\nnow: .+\nself-state: .+\n1\. m1\n2\. m2/);
});

await test("8. absent sample: no self-state line (backward compatible)", () => {
  const sent = [];
  flushWhisperBuffer([{ message: "m1", priority: "low" }], (text) => sent.push(text));
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /self-state:/);
});

// ── 3. The sample: one instrument, telemetry preserved ──────────────────────

await test("9. size, percent and provenance come from one meter reading", () => {
  const ctx = makeCtx("self-state-9");
  noteAssistantMessageEnd(ctx, {
    role: "assistant",
    timestamp: Date.now() - 5000,
    usage: { input: 1000, output: 500, cacheRead: 24_000, cacheWrite: 0 },
  });
  const sample = getSelfStateSample(ctx);
  assert.equal(sample.contextTokens, 237_785, "the usage anchor is the count");
  assert.ok(
    sample.contextPercent !== null && Math.abs(sample.contextPercent - 23.7785) < 0.01,
    `percent derived from the same reading: ${sample.contextPercent}`,
  );
  assert.equal(sample.contextProvenance, "measured", "an API count anchors it");
  // Cache-hit share is no longer rendered, but it is still sampled: the
  // telemetry JSONL and the diagnosing tools read it.
  assert.ok(
    sample.cacheHitShare !== null && Math.abs(sample.cacheHitShare - 96) < 0.1,
    `cacheHitShare=${sample.cacheHitShare}`,
  );
});

await test("10. no session tree: n/a rather than a second instrument's number", () => {
  const sample = getSelfStateSample(makeEmptyTreeCtx());
  assert.equal(sample.contextTokens, null, "the meter has nothing to measure");
  assert.equal(sample.contextPercent, null);
  assert.equal(sample.contextProvenance, null);
  assert.match(buildSelfStateLine(sample), /ctx n\/a/);
});

await test("11. near-dup count still flows from the density evaluator state", () => {
  const ctx = makeCtx("self-state-11");
  let sample = getSelfStateSample(ctx);
  assert.equal(sample.nearDupCount, null, "no density state yet -> n/a");
  getExtensionState(ctx, "context-density", () => ({ duplicates: 0 })).duplicates = 39;
  sample = getSelfStateSample(ctx);
  assert.equal(sample.nearDupCount, 39, "sampled even though the line no longer prints it");
});

await test("12. empty ctx: every field n/a, line renders, never throws", () => {
  const sample = getSelfStateSample({});
  assert.equal(sample.contextTokens, null);
  assert.equal(sample.cacheHitShare, null);
  assert.equal(sample.tpsEma, null);
  assert.match(buildSelfStateLine(sample), /self-state: ctx n\/a/);
});

await test("13. JSONL telemetry entry carries cacheHitShare (scalar, bounded)", () => {
  const dir = mkdtempSync(join(tmpdir(), "selfstate-"));
  const sink = join(dir, "hb.jsonl");
  try {
    const ctx = makeCtx("self-state-13");
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
