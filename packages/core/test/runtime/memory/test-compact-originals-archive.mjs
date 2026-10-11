/**
 * Fixture test (Option B,): always-on append-only originals archive.
 *
 * The verify stage detects a compaction that "succeeded"but destroyed context
 * (empty/boilerplate summary or budget not recovered) and sets
 * cmState.verifyFailed. (Option A) made recovery concrete on the
 * verify-failure path: the exact dropped originals are batched into an
 * explicit on-disk archive (<sessionDir>/archives/<sessionId>-<leafId>-<epoch>.jsonl,
 * pi-condense's post-hoc recovery-archive pattern). Option B flips the
 * archive to always-on / append-only (lossless default): EVERY compaction that
 * proceeded writes its raw originals (healthy or verify-failed), so originals
 * are never silently discarded from the live branch just because verification
 * happened to pass.
 *
 * Coverage:
 * (a) verifyFailed compaction (empty summary) -> archive file created under
 * <tmp>/archives/, contains the exact captured originals + verify reason +
 * timestamp; verifyFailed cleared; capture cleared.
 * (b) successful coherent compaction (no verifyFailed) -> archive IS written
 * (always-on, reason="compact"), content byte-matches the captured
 * originals; capture cleared.
 * (c) aborted / no compaction -> no archive write, no stale capture.
 * (d) archive content byte-matches the RAW originals captured pre-compression:
 * a compressible reasoning chain (semanticCompress collapses 7->2) is
 * archived in full, proving capture happens before the semantic-compression
 * block (which replaces prep.messagesToSummarize in place).
 *
 * Run: node test/runtime/memory/test-compact-originals-archive.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── Hermetic settings isolation (re-baseline) ───────────────────────
// The compaction handlers verify budgets through analyzeSession, whose usage
// flows through the ONE resolver (lib/config/braid-settings.ts) reading
// <homedir()>/.pi/agent/settings.json — the live 262k override recomputed the
// fixture's 200k-window percent (tokens stayed fixed while tests mutate
// percent between phases) and broke the budget-verify pins. Redirect HOME to
// a temp dir BEFORE the dist imports (os.homedir() reads $HOME on POSIX —
// same seam as test-context-limit-config.mjs; mock.method(os, "homedir") is
// not viable because braid-settings captures the named import and bakes
// SETTINGS_PATH at module-eval time) and write the EXPLICIT contextLimitTokens
// this scenario pins: 200_000 — the provider window the fixtures were written
// against (now pinned explicitly so the suite passes regardless of live
// settings.json).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w85b-originals-archive-"));
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

const {
  registerBeforeCompactHandler,
  registerSessionCompactOutcomeHandler,
  registerSessionCompactFailedHandler,
} = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);
const sharedMod = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/shared.js")
);
const { getCmState } = sharedMod;

function makeFakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    // Mirrors installed pi-core runner.js emit(): returns the handler result
    // and short-circuits when a session-before handler returns .cancel.
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

/**
 * Fake ctx whose sessionManager points its session.filePath into a real temp
 * dir (rotation.ts statSync access pattern — READ-ONLY for the session file).
 */
function makeFakeCtx({ percent = 50, branchLength = 20 } = {}) {
  const sessionId = `sess-${++sessionSeq}`;
  const tmp = mkdtempSync(join(tmpdir(), "cm-originals-archive-"));
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
  // Mutable usage so a test can drop usage between session_before_compact
  // (pre-compaction capture) and session_compact (post-compaction recompute).
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
    sessionManager: {
      session: { filePath: sessionFilePath },
      getSessionFile: () => sessionFilePath,
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-1",
      getBranch: () => branch,
      getTree: () => branch.map((e) => ({ entry: { id: e.id, type: e.type } })),
      getChildren: () => [],
      getLabel: () => undefined,
      appendCustomEntry: () => {},
    },
  };
  // Rescale the branch content so the session-tree measure (the live
  // metric's source) reports `pct` of the 200k window. Keeps ids/keeps
  // intact; the fake accessor is synced for any residual reads.
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

/**
 * Pre-fill messagesToSummarize with the given messages (or the full branch)
 * and firstKeptEntryId (pi-core's prepareCompaction always sets it).
 */
function makePrep(messages, firstKeptEntryId) {
  return {
    messagesToSummarize: messages,
    turnPrefixMessages: [],
    isSplitTurn: false,
    firstKeptEntryId,
  };
}

/**
 * A reasoning chain that semanticCompress WILL collapse (7 -> first+last):
 * 7 consecutive assistant messages matching reasoning markers. If the originals
 * capture happened AFTER the semantic-compression block, the archive would hold
 * the 2 collapsed messages, not the 7 raw ones.
 */
function makeReasoningChain() {
  const texts = [
    "I think the root cause is the missing guard.",
    "Let me trace the data flow through the handler.",
    "Therefore the fix must gate on the verify flag.",
    "Based on the evidence, the archive write is gated.",
    "Perhaps the capture belongs before the compression block.",
    "My reasoning is that the snapshot must be immutable.",
    "I think we can prove this with a byte-match assertion.",
  ];
  return texts.map((text, i) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 1000 + i,
  }));
}

/** Kick off a compaction cycle (captures originals + pre-compaction usage). */
async function startCompact(pi, ctx, branch, messages) {
  await pi._emit(
    {
      type: "session_before_compact",
      preparation: makePrep(messages ?? branch.map((e) => e.message), "e10"),
      reason: "threshold",
    },
    ctx,
  );
}

function makeCompactEvent({ summary, firstKeptEntryId = "e10" } = {}) {
  return {
    type: "session_compact",
    reason: "threshold",
    willRetry: false,
    compactionEntry: { id: "c1", summary: summary ?? "s1", firstKeptEntryId },
  };
}

/** Read the (single) archive line under tmp/archives/, or null if none. */
function readArchiveLine(tmp) {
  const archivesDir = join(tmp, "archives");
  let files;
  try {
    files = readdirSync(archivesDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  assert.equal(files.length, 1, "exactly one archive line expected per compaction");
  const raw = readFileSync(join(archivesDir, files[0]), "utf8");
  assert.ok(raw.endsWith("\n"), "archive must be a single newline-terminated JSON line");
  return JSON.parse(raw.trim());
}

console.log("=== always-on append-only originals archive (lossless default) ===\n");

await test("(a) verifyFailed compaction -> archive written with exact originals + reason + timestamp, flags cleared", async () => {
  const { ctx, branch, tmp, sessionId, setLivePercent } = makeFakeCtx({
    percent: 50,
    branchLength: 20,
  });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  const capturedOriginals = JSON.stringify(branch.map((e) => e.message));
  await startCompact(pi, ctx, branch);
  // Budget WOULD pass; coherence must fail first (blank summary) -> verifyFailed.
  setLivePercent(20);
  await pi._emit(makeCompactEvent({ summary: "   " }), ctx);

  const line = readArchiveLine(tmp);
  assert.ok(line, "archive file must be created on verify failure");
  assert.equal(line.sessionId, sessionId, "line must carry the session id");
  assert.equal(line.leafId, "leaf-1", "line must carry the leaf id");
  assert.match(
    line.reason ?? "",
    /^coherence: compaction summary is empty/,
    "line must carry the verify reason",
  );
  assert.ok(line.timestamp, "line must carry a timestamp");
  assert.equal(line.originals, capturedOriginals, "line must carry the exact captured originals");
  assert.equal(
    getCmState(ctx).verifyFailed,
    false,
    "verifyFailed must be cleared after the archive write (the archive write owns the flag lifecycle)",
  );
  assert.equal(
    getCmState(ctx).pendingCompactionOriginals,
    undefined,
    "pendingCompactionOriginals must be cleared after the outcome stage",
  );
});

await test("(b) successful coherent compaction -> archive IS written (always-on, reason=compact), byte-matches originals, capture cleared", async () => {
  const { ctx, branch, tmp, sessionId, setLivePercent } = makeFakeCtx({
    percent: 50,
    branchLength: 20,
  });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  const capturedOriginals = JSON.stringify(branch.map((e) => e.message));
  await startCompact(pi, ctx, branch);
  // Post-compaction: budget dropped well below the captured 50%.
  setLivePercent(20);
  await pi._emit(makeCompactEvent({ summary: "compacted summary", firstKeptEntryId: "e10" }), ctx);

  const line = readArchiveLine(tmp);
  assert.ok(line, "archive file must be created on a healthy compaction (always-on)");
  assert.equal(line.reason, "compact", "line must carry reason=compact on the healthy path");
  assert.equal(line.sessionId, sessionId, "line must carry the session id");
  assert.equal(
    line.originals,
    capturedOriginals,
    "line must carry the exact captured originals (byte-match)",
  );
  assert.equal(getCmState(ctx).verifyFailed, false, "verifyFailed must stay false on success");
  assert.equal(
    getCmState(ctx).pendingCompactionOriginals,
    undefined,
    "capture must be cleared on the success path",
  );
});

await test("(c) aborted / no compaction -> no archive write, no stale capture", async () => {
  const { ctx, branch, tmp } = makeFakeCtx({ percent: 50, branchLength: 20 });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactFailedHandler(pi);

  await startCompact(pi, ctx, branch);
  await pi._emit(
    { type: "session_compact_failed", reason: "threshold", aborted: true, willRetry: false },
    ctx,
  );

  assert.equal(readArchiveLine(tmp), null, "no archive write when no compaction completed (abort)");
  assert.equal(getCmState(ctx).verifyFailed, false, "verifyFailed must stay false on abort");
  assert.equal(
    getCmState(ctx).pendingCompactionOriginals,
    undefined,
    "no stale capture may leak into a later cycle",
  );
});

await test("(d) archive byte-matches the RAW originals captured pre-compression", async () => {
  const { ctx, branch, tmp, setLivePercent } = makeFakeCtx({
    percent: 50,
    branchLength: 20,
  });
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  registerSessionCompactOutcomeHandler(pi);

  const chain = makeReasoningChain();
  await startCompact(pi, ctx, branch, chain);
  // Verify fails (blank summary) -> archive write path.
  setLivePercent(20);
  await pi._emit(makeCompactEvent({ summary: "   " }), ctx);

  const line = readArchiveLine(tmp);
  assert.ok(line, "archive file must be created on verify failure");
  assert.equal(
    line.originals,
    JSON.stringify(chain),
    "archive must hold the full RAW reasoning chain (7 msgs) — not the 2 collapsed " +
      "by semanticCompress — proving capture happens before the semantic-compression block",
  );
  assert.equal(
    JSON.parse(line.originals).length,
    chain.length,
    "all raw originals must be preserved in the archive",
  );
});

// Clean up temp dirs created by this test run (best-effort).
const base = tmpdir();
const leftovers = readdirSync(base).filter((n) => n.startsWith("cm-originals-archive-"));
for (const n of leftovers) {
  try {
    rmSync(join(base, n), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
