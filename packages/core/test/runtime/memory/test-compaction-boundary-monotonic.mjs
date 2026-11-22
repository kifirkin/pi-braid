/**
 * A compaction boundary never moves backwards.
 *
 * A compaction entry replaces the context it summarizes, and a superseded
 * compaction entry projects to empty. A compaction whose `firstKeptEntryId`
 * lands in front of the branch's most recent compaction therefore hands back
 * every message that compaction had folded, and the live context grows instead
 * of shrinking. Measured on one seat's session: an archive moved the boundary
 * from chain index 6597 to 101 and the next request went from 168462 tokens to
 * 583671, a 5256-entry span no bounded summarizer could plan.
 *
 * Pinned here:
 *   1. An archive aimed behind the branch's compaction writes that compaction's
 *      own context start (its `firstKeptEntryId`), not the index the range asked
 *      for and not the compaction entry's index.
 *   2. The clamp drops no live message: the canonical live message count after
 *      the entry equals the count before it, exactly. Landing on the compaction
 *      entry instead drops everything between that entry's own boundary and the
 *      entry, which is the silent context change this fixture refuses.
 *   3. That entry's summary begins with the superseded summary, verbatim.
 *   4. `monotonicBoundaryIndex` is the max of the requested index and that
 *      boundary: unchanged for a branch with no compaction entry, for an index
 *      at or past the branch end, and for a compaction whose boundary id does
 *      not resolve on the branch (then the entry index is the floor).
 *   5. The other boundary suppliers clamp too: the deterministic cut the
 *      fail-safe lands, the slide the operator (or the auto-arm) asked for, and
 *      the summary-cap recovery's prepared boundary.
 *   6. The walk a session's branch is audited with (boundary against the
 *      previous compaction's own context start) finds no resurrection on a
 *      fixture branch, and the live count is unchanged across cycles.
 *
 * Run: node test/runtime/memory/test-compaction-boundary-monotonic.mjs
 * (built first: npm run build)
 */

import { after, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Hermeticity pin - MUST run before the dist imports below. The context window
// the chunk planner resolves (and the percent the archive's follow-up arm
// reads) comes from braid.context.contextLimitTokens in the agent
// settings.json; left unpointed it is the operator's live file and the branch
// below sizes against a different window on every machine.
const FIXTURE_HOME = mkdtempSync(join(tmpdir(), "compaction-boundary-monotonic-home-"));
process.env.HOME = FIXTURE_HOME;
process.env.PI_CODING_AGENT_DIR = join(FIXTURE_HOME, ".pi", "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(
  join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: 200_000 } } }),
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const D = join(ROOT, "dist");

const { registerContextCompress } = await import(
  join(D, "extensions/memory/context-manager/handlers/tools/context-compress.js")
);
const { registerBeforeCompactHandler, clampedBoundary } = await import(
  join(D, "extensions/memory/context-manager/handlers/compaction.js")
);
const { monotonicBoundaryIndex } = await import(
  join(D, "extensions/memory/context-manager/handlers/tool-batch-boundary.js")
);
const { getCmState, armCompactionFailsafeCut } = await import(
  join(D, "extensions/memory/context-manager/handlers/shared.js")
);
const { clearCompactionWatchdog } = await import(
  join(D, "extensions/memory/context-manager/handlers/compaction-watchdog.js")
);
const { __setCompleteSimpleForTest } = await import(join(D, "lib/ai/llm-call.js"));
const { getLogBuffer, clearLogBuffer } = await import(join(D, "lib/core/logger.js"));

/** The summary the branch already carries; every later entry must keep it. */
const PRIOR_SUMMARY =
  "S1: the archive planner was refactored to plan in bounded chunks, the chunk output budget was pinned, and the next step is the boundary invariant.";

/** Label a clamped summary must introduce the superseded summary with. */
const CARRIED_LABEL = "Carried from the compaction this entry supersedes:";

// Fixtures

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
    appendEntry() {},
    async _emit(event, ...args) {
      let last;
      for (const h of handlers.get(event.type) ?? []) {
        const r = await Promise.resolve(h(event, ...args)).catch((e) => {
          throw e;
        });
        if (r !== undefined) last = r;
      }
      return last;
    },
  };
}

let sessionSeq = 0;

function makeFakeCtx(branch, { contextWindow = 200_000, percent = 45 } = {}) {
  const sessionId = `boundary-${++sessionSeq}`;
  const customEntries = [];
  return {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    model: {
      id: "deepseek-v4-1-flash",
      provider: "agent-zero",
      contextWindow,
      maxTokens: 32768,
      reasoning: true,
    },
    getContextUsage: () => ({
      percent,
      tokens: Math.round((percent / 100) * contextWindow),
      contextWindow,
    }),
    compactCalls: [],
    compact(options) {
      this.compactCalls.push(options ?? {});
    },
    customEntries,
    sessionManager: {
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      // The leaf follows the branch tip, as pi's does: a compaction entry that
      // landed is a new leaf, so a later cycle is not the same cycle.
      getLeafId: () => branch[branch.length - 1]?.id ?? "leaf-1",
      getBranch: () => branch,
      getTree: () => branch.map((e) => ({ entry: { id: e.id, type: e.type } })),
      getChildren: () => [],
      getLabel: () => undefined,
      appendCustomEntry: (kind, data) => {
        customEntries.push({ kind, data });
        return `custom-${customEntries.length}`;
      },
    },
  };
}

/**
 * A branch that already carries one landed compaction, laid out the way pi
 * writes one: the compaction entry is appended at the leaf, so the entry id it
 * keeps from (`firstKeptEntryId`) sits EARLIER on the branch, with the entries
 * it kept live between that boundary and the entry itself. The compaction entry
 * carries no provider message, so it projects its summary instead.
 *
 * `anchorIndex` is where that kept context starts: entries in
 * [anchorIndex, compactionIndex) were live before any later compaction and must
 * still be live after one.
 */
function makeBranchWithCompaction({
  total = 120,
  compactionIndex = 60,
  anchorIndex = 30,
  anchorId = null,
} = {}) {
  const branch = [];
  for (let i = 0; i < total; i++) {
    if (i === compactionIndex) {
      branch.push({
        id: `c${i}`,
        type: "compaction",
        summary: PRIOR_SUMMARY,
        firstKeptEntryId: anchorId ?? `m${anchorIndex}`,
        tokensBefore: 100_000,
        timestamp: 500 + i,
      });
      continue;
    }
    branch.push({
      id: `m${i}`,
      type: "message",
      message: {
        role: i % 2 ? "assistant" : "user",
        content: [{ type: "text", text: `msg ${i}` }],
        timestamp: 1000 + i,
      },
    });
  }
  return branch;
}

/**
 * Messages the canonical context projects for a branch, mirroring pi's
 * `buildContextEntries`: only the last compaction entry projects, the entries
 * from its own `firstKeptEntryId` up to that entry project only when they are
 * not `system` messages, and every entry after the compaction entry projects.
 * An anchor that does not resolve before the entry keeps nothing from before it,
 * which is what pi does when `foundFirstKept` never flips.
 */
function canonicalLiveMessages(branch) {
  let lastCompaction = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]?.type === "compaction") {
      lastCompaction = i;
      break;
    }
  }
  let live = 0;
  if (lastCompaction < 0) {
    for (const entry of branch) if (entry?.type === "message") live++;
    return live;
  }
  const anchorIndex = anchorIndexOf(branch, lastCompaction);
  for (let i = anchorIndex; i < lastCompaction; i++) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message?.role !== "system") live++;
  }
  for (let i = lastCompaction + 1; i < branch.length; i++) {
    if (branch[i]?.type === "message") live++;
  }
  return live;
}

/** Stub the bounded summarizer: one canned summary per call, no provider. */
function installChunkStub() {
  const calls = [];
  __setCompleteSimpleForTest(async (_model, context, options) => {
    calls.push({
      maxTokens: options.maxTokens,
      reasoning: options.reasoning,
      userText:
        typeof context.messages?.[0]?.content === "string" ? context.messages[0].content : "",
    });
    return {
      content: [{ type: "text", text: "BOUNDED-SUMMARY" }],
      stopReason: "end_turn",
      usage: { input: 100, output: 20, totalTokens: 120, cacheRead: 0, cacheWrite: 0 },
    };
  });
  return calls;
}

let landedSeq = 0;

/**
 * Drive one session_before_compact firing through the registered handlers and
 * return what pi-core would persist: the landed entry (appended to the branch
 * as pi-core does) and the live message count on both sides of it.
 */
async function landCompaction(pi, ctx, branch, prep, event = {}) {
  const liveBefore = canonicalLiveMessages(branch);
  const calls = installChunkStub();
  clearLogBuffer();
  let result;
  try {
    result = await pi._emit(
      { type: "session_before_compact", preparation: prep, ...event },
      ctx,
    );
  } finally {
    __setCompleteSimpleForTest(null);
    // The cycle never reached an outcome event, so the stall watchdog's
    // fifteen-minute deadline is still armed; disarm it or the runner waits.
    clearCompactionWatchdog(ctx);
  }
  const written = result?.compaction;
  if (written) {
    branch.push({
      id: `c-landed-${++landedSeq}`,
      type: "compaction",
      summary: written.summary,
      firstKeptEntryId: written.firstKeptEntryId,
      tokensBefore: written.tokensBefore,
      timestamp: Date.now(),
    });
  }
  return { result, written, calls, liveBefore, liveAfter: canonicalLiveMessages(branch) };
}

function makePrep({ messagesToSummarize = [], firstKeptEntryId = "m-kept" } = {}) {
  return {
    messagesToSummarize,
    turnPrefixMessages: [],
    isSplitTurn: false,
    firstKeptEntryId,
    tokensBefore: 4242,
  };
}

const logs = () => getLogBuffer().map((l) => l.message ?? String(l)).join("\n");
const indexOfId = (branch, id) => branch.findIndex((entry) => entry.id === id);

/**
 * Where a landed compaction's own context starts: its `firstKeptEntryId`
 * resolved to a branch index, or the entry's own index when that id does not
 * resolve before it (pi's default keeps from the entry itself).
 */
function anchorIndexOf(branch, compactionIndex) {
  const anchor = branch[compactionIndex]?.firstKeptEntryId;
  if (!anchor) return compactionIndex;
  for (let i = 0; i < compactionIndex; i++) {
    if (branch[i]?.id === anchor) return i;
  }
  return compactionIndex;
}

/**
 * The walk a session's own branch is audited with: one row per compaction
 * entry, comparing the boundary it wrote against where the compaction before it
 * starts keeping context. A boundary in front of that point re-projects
 * messages the previous compaction had folded (superseded compaction entries
 * project to empty).
 */
function walkCompactions(branch) {
  const indexById = new Map(branch.map((entry, i) => [entry.id, i]));
  const rows = [];
  let previousAnchor = -1;
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (entry?.type !== "compaction") continue;
    const boundary = indexById.get(entry.firstKeptEntryId ?? entry.id);
    rows.push({
      index: i,
      boundary,
      anchor: anchorIndexOf(branch, i),
      previousAnchor,
      behind: previousAnchor >= 0 && boundary !== undefined && boundary < previousAnchor,
    });
    previousAnchor = anchorIndexOf(branch, i);
  }
  return rows;
}

// 1-2: the archive that reaches back past a compaction

test("an archive behind the branch's compaction keeps from the compaction's own boundary", async () => {
  const branch = makeBranchWithCompaction();
  assert.equal(indexOfId(branch, "c60"), 60, "fixture layout: the compaction entry sits at 60");
  assert.equal(
    indexOfId(branch, branch[60].firstKeptEntryId),
    30,
    "fixture layout: its context starts at 30, with 29 messages it kept live in between",
  );
  const pi = makeFakePi();
  const ctx = makeFakeCtx(branch);
  registerContextCompress(pi);
  registerBeforeCompactHandler(pi);

  const tool = pi.tools.get("context_compress");
  const archive = await tool.execute(
    "ac-behind",
    {
      action: "archive",
      startIndex: 0,
      endIndex: 9,
      topic: "old span",
      summary: "ARCHIVE-ANCHOR: entries 0..9 were the planning exchange.",
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(archive.details?.honorRange, true, "the archive declares its range");
  const armLogs = logs();

  const rangeMode = getCmState(ctx).rangeMode;
  assert.ok(rangeMode?.active, "the archive persisted its range mode");
  assert.equal(
    rangeMode.firstKeptEntryId,
    "m30",
    "the armed boundary is where the branch's compaction starts keeping context, not the entry it sits at and not the index the range asked for",
  );

  const landed = await landCompaction(pi, ctx, branch, makePrep());
  assert.equal(
    landed.written?.firstKeptEntryId,
    "m30",
    "the landed entry's firstKeptEntryId is the compaction's own boundary",
  );
  assert.equal(
    indexOfId(branch, landed.written.firstKeptEntryId),
    30,
    "the written boundary sits at chain index 30",
  );
  assert.equal(
    indexOfId(branch, rangeMode.firstKeptEntryId),
    30,
    "the boundary the archive asked for (index 10) was moved forward, not honored",
  );
  assert.match(
    armLogs,
    /boundary index 10 sits behind the branch's compaction at 60 \(its context starts at 30\)/,
    "the clamp names the requested index, the compaction and where it starts keeping context",
  );
});

test("a clamped compaction drops no live message", async () => {
  // The case that separates the two candidate floors. Kept from the
  // compaction's own boundary (30), every message the branch projects before
  // the new entry still projects after it. Kept from the entry index (60)
  // instead, the 29 messages in [30, 60) leave the context unsummarized: 89
  // live messages before the cycle become 59 after it, silently.
  const branch = makeBranchWithCompaction();
  const pi = makeFakePi();
  const ctx = makeFakeCtx(branch);
  registerContextCompress(pi);
  registerBeforeCompactHandler(pi);

  const tool = pi.tools.get("context_compress");
  await tool.execute(
    "ac-live",
    { action: "archive", startIndex: 0, endIndex: 9, topic: "old span", summary: "ANCHOR" },
    undefined,
    undefined,
    ctx,
  );

  const landed = await landCompaction(pi, ctx, branch, makePrep());
  assert.ok(landed.written, "the cycle landed an entry");
  assert.equal(landed.liveBefore, 89, "the branch projects 89 live messages before the cycle");
  assert.equal(
    landed.liveAfter,
    landed.liveBefore,
    `the clamp must keep every live message: ${landed.liveAfter} after vs ${landed.liveBefore} before ` +
      `(a floor at the compaction entry drops ${landed.liveBefore - 59})`,
  );
});

test("a clamped entry's summary begins with the compaction it supersedes", async () => {
  const branch = makeBranchWithCompaction();
  const pi = makeFakePi();
  const ctx = makeFakeCtx(branch);
  registerContextCompress(pi);
  registerBeforeCompactHandler(pi);

  const tool = pi.tools.get("context_compress");
  await tool.execute(
    "ac-carried",
    { action: "archive", startIndex: 0, endIndex: 9, topic: "old span", summary: "ANCHOR" },
    undefined,
    undefined,
    ctx,
  );

  const landed = await landCompaction(pi, ctx, branch, makePrep());
  const summary = landed.written?.summary ?? "";

  assert.ok(summary.includes(PRIOR_SUMMARY), "the superseded summary is carried verbatim");
  assert.ok(summary.includes(CARRIED_LABEL), `the carry is labelled: ${summary.slice(0, 200)}`);
  assert.ok(
    summary.indexOf(PRIOR_SUMMARY) < summary.indexOf("BOUNDED-SUMMARY"),
    "the superseded summary comes first: the entry begins with it",
  );
  assert.ok(
    summary.indexOf(CARRIED_LABEL) < summary.indexOf(PRIOR_SUMMARY),
    "the label introduces the carried text",
  );
});

// 4: the normalizer's own contract

test("monotonicBoundaryIndex is a max against the branch's last compaction", () => {
  const branch = makeBranchWithCompaction();
  assert.equal(indexOfId(branch, "c60"), 60, "fixture layout: the compaction sits at 60");
  assert.equal(anchorIndexOf(branch, 60), 30, "fixture layout: its context starts at 30");

  assert.equal(
    monotonicBoundaryIndex(branch, 10),
    30,
    "an index behind the compaction moves to where its context starts",
  );
  assert.equal(monotonicBoundaryIndex(branch, 30), 30, "an index on that boundary stays put");
  assert.equal(
    monotonicBoundaryIndex(branch, 45),
    45,
    "an index ahead of that boundary is untouched, even though it is behind the compaction entry",
  );
  assert.equal(monotonicBoundaryIndex(branch, 84), 84, "an index after the compaction is untouched");
  assert.equal(
    monotonicBoundaryIndex(branch, branch.length),
    branch.length,
    "an index at the branch end is untouched",
  );

  const messagesOnly = makeBranchWithCompaction({ total: 20, compactionIndex: -1 });
  assert.equal(
    monotonicBoundaryIndex(messagesOnly, 7),
    7,
    "a branch with no compaction entry is untouched",
  );
  assert.equal(monotonicBoundaryIndex([], 3), 3, "an empty branch is untouched");

  // A boundary id that no longer resolves on the branch (the anchor fell off a
  // rewritten branch): the floor is the compaction entry, which resurrects
  // nothing, since the entry itself is where pi's projection starts when the
  // anchor is gone.
  const dangling = makeBranchWithCompaction({ anchorId: "m-gone" });
  assert.equal(anchorIndexOf(dangling, 60), 60, "a dangling anchor resolves to the entry");
  assert.equal(
    monotonicBoundaryIndex(dangling, 10),
    60,
    "a compaction whose boundary id does not resolve falls back to its entry index",
  );

  const clamped = clampedBoundary(branch, 10, "fixture");
  assert.equal(clamped.index, 30, "the clamp reports the index it lands on");
  assert.equal(clamped.clamped, true);
  assert.equal(clamped.carriedSummary, PRIOR_SUMMARY, "the clamp names what the entry owes");
  assert.equal(
    clampedBoundary(branch, 45, "fixture").clamped,
    false,
    "a boundary ahead of the compaction's own boundary is not clamped",
  );
  assert.equal(
    clampedBoundary(branch, 84, "fixture").clamped,
    false,
    "no clamp ahead of the compaction entry, no carry",
  );
});

// 5: the other boundary suppliers

test("the deterministic cut the fail-safe lands clamps and carries", async () => {
  // 70 entries with the compaction at 60, its context starting at 55: the cut
  // wants to keep the recent third (21 entries), which would land at index 49 -
  // in front of where the compaction starts keeping context.
  const branch = makeBranchWithCompaction({ total: 70, compactionIndex: 60, anchorIndex: 55 });
  const pi = makeFakePi();
  const ctx = makeFakeCtx(branch);
  registerBeforeCompactHandler(pi);
  assert.ok(armCompactionFailsafeCut(ctx, "fixture: no cycle landed an entry"), "cut armed");

  const landed = await landCompaction(pi, ctx, branch, makePrep({ messagesToSummarize: [] }));
  assert.equal(landed.written?.firstKeptEntryId, "m55", "the cut lands where the compaction starts, not at 49");
  assert.equal(landed.liveBefore, 14, "the branch projects 14 live messages before the cut");
  assert.equal(landed.liveAfter, landed.liveBefore, "the cut keeps every live message");
  assert.ok(
    (landed.written?.summary ?? "").includes(PRIOR_SUMMARY),
    "the deterministic cut's summary carries the superseded one",
  );
});

test("an operator slide behind the compaction clamps and carries", async () => {
  const branch = makeBranchWithCompaction();
  const pi = makeFakePi();
  const ctx = makeFakeCtx(branch);
  registerBeforeCompactHandler(pi);
  // The slide state an arm 50 entries ago (or the auto-arm keeping half the
  // branch) leaves: a cut at index 20, deep behind the branch's compaction.
  getCmState(ctx).slideMode = {
    active: true,
    cutEntryId: "m20",
    keepCount: 100,
    droppedCount: 20,
    timestamp: Date.now(),
  };

  const landed = await landCompaction(pi, ctx, branch, makePrep(), {
    customInstructions: "SLIDE_MODE:true",
  });
  assert.equal(landed.written?.firstKeptEntryId, "m30", "the slide keeps from the compaction's own boundary");
  assert.equal(landed.liveAfter, landed.liveBefore, "the slide keeps every live message");
  assert.ok(
    (landed.written?.summary ?? "").includes(PRIOR_SUMMARY),
    "the slide's summary carries the superseded one",
  );
});

test("the summary-cap recovery clamps the prepared boundary and carries", async () => {
  const branch = makeBranchWithCompaction();
  const pi = makeFakePi();
  const ctx = makeFakeCtx(branch);
  registerBeforeCompactHandler(pi);
  const span = branch
    .slice(0, 10)
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
  getCmState(ctx).pendingSummaryCapRecovery = {
    attempt: 1,
    armedAt: Date.now(),
  };
  getCmState(ctx).compactionRetryActive = true;

  const landed = await landCompaction(
    pi,
    ctx,
    branch,
    makePrep({ messagesToSummarize: span, firstKeptEntryId: "m10" }),
  );
  assert.ok(landed.written, "the recovery cycle landed an entry");
  assert.equal(
    landed.written.firstKeptEntryId,
    "m30",
    "the recovery inherits a monotonic boundary, not the prepared one at index 10",
  );
  assert.equal(landed.liveAfter, landed.liveBefore, "the recovery keeps every live message");
  assert.ok(
    landed.written.summary.includes(PRIOR_SUMMARY),
    "the recovery's summary carries the superseded one",
  );
  assert.ok(landed.calls.length >= 1, "the bounded summarizer served the span");
  assert.match(
    logs(),
    /Summary-cap recovery boundary: boundary index 10 sits behind the branch's compaction at 60 \(its context starts at 30\)/,
    "a boundary clamped at consumption names both indices",
  );
});

test("the same walk over a fixture branch finds no backward boundary", async () => {
  // Three cycles, each declaring an archive that reaches back past the
  // branch's compaction: the walk a session's own file is audited with must
  // show zero entries on either side of the invariant.
  const branch = makeBranchWithCompaction();
  const pi = makeFakePi();
  const ctx = makeFakeCtx(branch);
  registerContextCompress(pi);
  registerBeforeCompactHandler(pi);
  const tool = pi.tools.get("context_compress");
  const liveCounts = [canonicalLiveMessages(branch)];

  for (let cycle = 0; cycle < 3; cycle++) {
    await tool.execute(
      `ac-walk-${cycle}`,
      { action: "archive", startIndex: 0, endIndex: 9, topic: `cycle ${cycle}`, summary: "ANCHOR" },
      undefined,
      undefined,
      ctx,
    );
    const landed = await landCompaction(pi, ctx, branch, makePrep());
    assert.ok(landed.written, `cycle ${cycle} landed an entry`);
    liveCounts.push(landed.liveAfter);
    // Drain the armed compaction the archive queued: a second LLM-class arm is
    // refused while one is pending (the first declaration stands), which would
    // make later cycles no-ops. The drain only fires the deferred trigger.
    await pi._emit({ type: "agent_settled" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const rows = walkCompactions(branch);
  assert.equal(rows.length, 4, "the fixture branch carries the planted compaction plus three");
  assert.deepEqual(
    rows.filter((row) => row.behind),
    [],
    `no compaction boundary resurrects folded context: ${JSON.stringify(rows)}`,
  );
  for (const row of rows.slice(1)) {
    assert.equal(
      row.boundary,
      row.previousAnchor,
      `every landed boundary is where the compaction before it starts keeping context: ${JSON.stringify(row)}`,
    );
  }
  for (let i = 1; i < liveCounts.length; i++) {
    assert.equal(
      liveCounts[i],
      liveCounts[i - 1],
      `cycle ${i - 1} must leave the live context unchanged: ${JSON.stringify(liveCounts)}`,
    );
  }
});

after(() => {
  try {
    rmSync(FIXTURE_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
