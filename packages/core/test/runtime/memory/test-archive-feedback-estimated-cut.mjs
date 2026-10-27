/**
 * Fixture test (2b + from).
 *
 * Coverage:
 * (2b) context_compress archive + slide feedback is HONEST-BY-UNDERSTATEMENT:
 * no specific-range claims ("Declared range: N entries (a..b)", "Compressed
 * N messages", "Dropped: N entries", "will honor this range") — the tool
 * reports an ESTIMATED cut ("~N entries before the ... point, estimated")
 * plus the REAL before-%, because the actual cut is pi-core's compaction
 * decision. The deferred 2a mechanism (rangeMode) is untouched and keeps
 * working (details.honorRange still true, rangeMode still persisted) —
 * only the claims changed.
 * compaction outcome carries the compacted-vs-kept message counter:
 * recordCompactionOutcome("success") populates the existing (previously
 * dead) totalEntriesRemoved with the cycle's raw summarization input
 * count, and the append-only originals archive line carries both
 * compactedMessages and keptMessages (kept = live messages from the
 * firstKeptEntryId anchor to the branch end). Degraded sources yield
 * absent counts, never wrong ones.
 *
 * Run: node test/runtime/memory/test-archive-feedback-estimated-cut.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── Hermetic settings isolation (same seam as sibling fixtures) ──
const FAKE_HOME = mkdtempSync(join(tmpdir(), "estimated-cut-test-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(FAKE_HOME, ".pi", "agent", "settings.json"),
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
const {
  registerBeforeCompactHandler,
  registerSessionCompactOutcomeHandler,
} = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);
const { getCmState, getCompactionHealth, resetCompactionHealth, formatCompactionLossLine } =
  await import(join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js"));

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
    // The documented durable-entry seam; this suite asserts other surfaces.
    appendEntry() {},
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      let result;
      for (const h of handlers.get(name) ?? []) {
        result = await Promise.resolve(h(event, ...args)).catch((e) => {
          throw e;
        });
        if (result?.cancel) return result;
      }
      return result;
    },
  };
}

let sessionSeq = 0;
function makeFakeCtx({ percent = 45, branchLength = 12 } = {}) {
  const sessionId = `sess-${++sessionSeq}`;
  const tmp = mkdtempSync(join(tmpdir(), "estimated-cut-test-ctx-"));
  const sessionFilePath = join(tmp, "session.jsonl");
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
  const usage = {
    percent,
    tokens: Math.round((percent / 100) * 200000),
    contextWindow: 200000,
  };
  const ctx = {
    cwd: tmp,
    mode: "test",
    hasUI: false,
    getContextUsage: () => usage,
    compactCalls: [],
    compact(options) {
      this.compactCalls.push(options);
    },
    sessionManager: {
      session: { filePath: sessionFilePath },
      getSessionFile: () => sessionFilePath,
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-1",
      getBranch: () => branch,
      getTree: () => branch.map((e) => ({ entry: { id: e.id, type: e.type } })),
      getChildren: () => [],
      getLabel: () => undefined,
      appendLabelChange: () => {},
      appendCustomEntry: () => {},
    },
  };

  // Rescale the branch content so the session-tree measure (the live
  // metric's source) reports `pct` of the 200k window; the fake accessor
  // is synced for any residual reads.
  function setLivePercent(pct) {
    const per = Math.max(0, Math.round(((pct / 100) * 200000 * 4) / branchLength) - 7);
    for (const e of branch) {
      const idx = Number(e.id.slice(1));
      e.message.content[0].text = `msg ${idx} ${"x".repeat(per)}`;
    }
    usage.percent = pct;
    usage.tokens = Math.round((pct / 100) * 200000);
  }

  return { ctx, branch, usage, tmp, sessionId, setLivePercent };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read the single archive line under tmp/archives/, or null if none. */
function readArchiveLine(tmp) {
  const archivesDir = join(tmp, "archives");
  let files;
  try {
    files = readdirSync(archivesDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const raw = readFileSync(join(archivesDir, files[0]), "utf8");
  return JSON.parse(raw.trim());
}

console.log("=== archive/slide honest-estimate feedback (2b) + outcome counters ===\n");

await test("(2b) archive feedback: estimated cut, no specific-range claims, mechanism intact", async () => {
  const { ctx } = makeFakeCtx({ percent: 45, branchLength: 12 });
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  assert.ok(tool, "context_compress tool registered");

  const result = await tool.execute(
    "a-1",
    { action: "archive", startIndex: 0, endIndex: 7, topic: "refactor", summary: "S" },
    undefined,
    undefined,
    ctx,
  );
  // Arming only queues; the settle drain lands the compaction.
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);

  const text = result.content[0].text;
  // Estimated-cut wording present.
  assert.match(
    text,
    /~8 entries before the archive point, estimated/,
    `feedback must report the estimated cut, got:\n${text}`,
  );
  // NO specific-range claims.
  assert.ok(!/Declared range:/.test(text), "must NOT claim the declared range");
  assert.ok(!/Compressed \d+ messages/.test(text), "must NOT claim 'Compressed N messages'");
  assert.ok(!/will honor/.test(text), "must NOT promise a specific honored boundary");
  // REAL before-% still reported (no fabricated post-%).
  assert.match(text, /Before: 45\.0% used/, "the REAL before-% must be reported");
  assert.ok(!/estimated after/.test(text), "must NOT claim an estimated post-%");

  // The compact still fires (mid context) and the deferred 2a mechanism is
  // untouched: honorRange detail + persisted rangeMode with the same boundary.
  assert.equal(ctx.compactCalls.length, 1, "compact fires for mid-context archive");
  assert.equal(result.details.honorRange, true, "honorRange detail unchanged (2a interop)");
  const rangeMode = getCmState(ctx).rangeMode;
  assert.ok(rangeMode, "rangeMode still persisted (mechanism untouched)");
  assert.equal(rangeMode.firstKeptEntryId, "e8", "boundary still endIndex+1 (2a interop)");
  assert.equal(rangeMode.endIndex, 7, "declared span still recorded in rangeMode");
});

await test("(2b) slide feedback: estimated cut instead of a specific dropped claim", async () => {
  const { ctx } = makeFakeCtx({ percent: 45, branchLength: 10 });
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");

  const result = await tool.execute("s-1", { action: "slide", keep: 3 }, undefined, undefined, ctx);
  await pi._emit({ type: "agent_settled" }, ctx);
  await sleep(30);

  const text = result.content[0].text;
  assert.match(
    text,
    /~7 entries before the slide point, estimated/,
    `slide feedback must report the estimated cut, got:\n${text}`,
  );
  assert.ok(!/Dropped: \d+ entries/.test(text), "must NOT claim 'Dropped: N entries'");
  assert.match(text, /Keep recent: 3 entries/, "the requested keep is still reported");
  assert.equal(ctx.compactCalls.length, 1, "slide compact fires");
  assert.match(
    String(ctx.compactCalls[0]?.customInstructions ?? ""),
    /SLIDE_MODE/,
    "slide compact carries the SLIDE_MODE marker",
  );
});

await test("success outcome carries the compacted-vs-kept counter (outcome + archive line)", async () => {
  resetCompactionHealth();
  const { ctx, tmp, setLivePercent } = makeFakeCtx({ percent: 50, branchLength: 20 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  const summarized = [
    { role: "user", content: [{ type: "text", text: "m-a" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "m-b" }], timestamp: 2 },
    { role: "user", content: [{ type: "text", text: "m-c" }], timestamp: 3 },
  ];
  await pi._emit(
    {
      type: "session_before_compact",
      preparation: {
        messagesToSummarize: summarized,
        turnPrefixMessages: [],
        isSplitTurn: false,
        firstKeptEntryId: "e10",
      },
      reason: "threshold",
    },
    ctx,
  );
  // Post-compaction usage drops well below the captured 50% (budget verify).
  setLivePercent(20);
  await pi._emit(
    {
      type: "session_compact",
      reason: "threshold",
      willRetry: false,
      compactionEntry: { id: "c1", summary: "compacted summary", firstKeptEntryId: "e10" },
    },
    ctx,
  );

  // Outcome carries the compacted side (existing counter, now populated).
  const health = getCompactionHealth();
  assert.equal(health.lastOutcome, "success");
  assert.equal(
    health.totalEntriesRemoved,
    3,
    "totalEntriesRemoved must record the cycle's raw summarization input count",
  );

  // The durable archive line carries BOTH sides: compacted=3, kept=10
  // (branch e0..e19, anchor e10 -> e10..e19 are 10 live messages).
  const line = readArchiveLine(tmp);
  assert.ok(line, "archive line written on success");
  assert.equal(line.compactedMessages, 3, "archive line carries compactedMessages");
  assert.equal(line.keptMessages, 10, "archive line carries keptMessages (live from anchor)");
});

await test("degraded sources yield absent counts, never wrong ones", async () => {
  resetCompactionHealth();
  const { ctx, tmp } = makeFakeCtx({ percent: 50, branchLength: 20 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  // session_compact with NO prior session_before_compact: no originals
  // capture — the compacted count must be absent (no crash, no zero
  // masquerading as a measurement); the kept count still measures from the
  // live branch + anchor.
  await pi._emit(
    {
      type: "session_compact",
      reason: "manual",
      willRetry: false,
      compactionEntry: { id: "c2", summary: "s", firstKeptEntryId: "e5" },
    },
    ctx,
  );

  const health = getCompactionHealth();
  assert.equal(health.lastOutcome, "success", "outcome still recorded honestly");
  assert.equal(
    health.totalEntriesRemoved,
    0,
    "no compacted count must be fabricated when the capture is absent",
  );
  assert.equal(readArchiveLine(tmp), null, "no archive line without captured originals");
});

await test("(2b) deep_clean feedback: estimated cut, no specific 'Archived N' claim ", async () => {
  const { ctx } = makeFakeCtx({ percent: 45, branchLength: 12 });
  const pi = makeFakePi();
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");

  const result = await tool.execute(
    "dc-1",
    { action: "deep_clean", topic: "cleanup", summary: "S" },
    undefined,
    undefined,
    ctx,
  );
  await sleep(30);

  const text = result.content[0].text;
  // Estimated-cut wording present (same doctrine as archive/slide).
  assert.match(
    text,
    /~\d+ entries before the tag point, estimated/,
    `deep_clean feedback must report the estimated cut, got:\n${text}`,
  );
  // NO specific-cut claim (the old "Archived N messages before tag").
  assert.ok(!/Archived \d+ messages/.test(text), "must NOT claim 'Archived N messages'");
  // The pipeline still ran: tag + compaction scheduled (details carry the count).
  assert.equal(result.details.action, "deep_clean");
  assert.equal(result.details.compactionTriggered, true);
});

await test("(surface) formatCompactionLossLine carries the last-compaction counters ", async () => {
  resetCompactionHealth();
  const { ctx, setLivePercent } = makeFakeCtx({ percent: 50, branchLength: 20 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  const summarized = [
    { role: "user", content: [{ type: "text", text: "m-a" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "m-b" }], timestamp: 2 },
    { role: "user", content: [{ type: "text", text: "m-c" }], timestamp: 3 },
  ];
  await pi._emit(
    {
      type: "session_before_compact",
      preparation: {
        messagesToSummarize: summarized,
        turnPrefixMessages: [],
        isSplitTurn: false,
        firstKeptEntryId: "e10",
      },
      reason: "threshold",
    },
    ctx,
  );
  setLivePercent(20);
  await pi._emit(
    {
      type: "session_compact",
      reason: "threshold",
      willRetry: false,
      compactionEntry: { id: "c3", summary: "compacted summary", firstKeptEntryId: "e10" },
    },
    ctx,
  );

  const health = getCompactionHealth();
  assert.equal(health.lastCompactedMessages, 3, "last compacted surfaced on the health object");
  assert.equal(health.lastKeptMessages, 10, "last kept surfaced on the health object");
  const line = formatCompactionLossLine();
  assert.ok(line, "loss line present after a successful compaction");
  assert.match(line, /last compaction: 3 compacted → 10 kept/);
});

await test("(surface) degraded sources keep the loss line absent, never wrong ", async () => {
  resetCompactionHealth();
  const { ctx } = makeFakeCtx({ percent: 50, branchLength: 20 });
  const pi = makeFakePi();
  registerSessionCompactOutcomeHandler(pi);

  await pi._emit(
    {
      type: "session_compact",
      reason: "manual",
      willRetry: false,
      compactionEntry: { id: "c4", summary: "s", firstKeptEntryId: "e5" },
    },
    ctx,
  );

  const health = getCompactionHealth();
  assert.equal(health.lastCompactedMessages, undefined, "no compacted count fabricated");
  assert.equal(
    health.lastKeptMessages,
    15,
    "kept IS measured from the live branch + anchor (e5..e19) — independent source",
  );
  assert.equal(formatCompactionLossLine(), null, "no last-compaction measurement → nothing shown");
});

// Clean up temp dirs created by this test run (best-effort).
const base = tmpdir();
for (const n of readdirSync(base).filter((x) => x.startsWith("estimated-cut-test-"))) {
  try {
    const fs = await import("node:fs");
    fs.rmSync(join(base, n), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
