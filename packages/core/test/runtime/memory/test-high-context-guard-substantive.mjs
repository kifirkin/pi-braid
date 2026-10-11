/**
 * Fixture test (Option A,): STEP 0.75 high-context guard substantive
 * summarization.
 *
 * The defect (parent-pinned): at >70% usage the guard set
 * prep.messagesToSummarize = [] and returned early, so pi-core 0.84.2's native
 * summarizer received an EMPTY batch and emitted the misleading boilerplate
 * "## Goal - (No explicit goal stated — the conversation is empty.)"at the
 * exact moment context is most precious (81-97% usage).
 *
 * Coverage:
 * (a) Regression (fails pre-fix): after firing session_before_compact at
 * percent=80, prep.messagesToSummarize.length > 0. Pre-fix it was []
 * (length 0). Post-fix it is the DROPPED span [0..cutIndex-1].
 * (b) Guard fields preserved: firstKeptEntryId === branch[cutIndex].id,
 * turnPrefixMessages empty, isSplitTurn false — the deterministic-cut
 * crash-avoidance intent is unchanged.
 * (c) Dropped-span provenance: the summarize set holds the OLDER entries
 * (first message is e0) and excludes the kept recent entries (no e70/e99).
 * (d) Below threshold (percent=50): guard does NOT fire — firstKeptEntryId
 * untouched, messagesToSummarize still holds the pre-filled span (recent
 * entries beyond the would-be cut present).
 *
 * NOTE: STEP 1 (pre-filter) and STEP 1.5 (semantic compression) run on the
 * summarize set after the guard; in this fake env they may transform it, so we
 * assert non-empty + guard fields + loose provenance, NOT exact content
 * equality (per the brief's test contract).
 *
 * Run: node test/runtime/memory/test-high-context-guard-substantive.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── Hermetic settings isolation (re-baseline) ──────────────────────
// The STEP 0.75 guard reads usage through analyzeSession, whose percent flows
// through the ONE resolver (lib/config/braid-settings.ts) reading
// <homedir()>/.pi/agent/settings.json — the live 262k override recomputed the
// fixture's 200k-window percent (80% → ~61%) and the guard went silent.
// Redirect HOME to a temp dir BEFORE the dist imports (os.homedir() reads
// $HOME on POSIX — same seam as test-context-limit-config.mjs;
// mock.method(os, "homedir") is not viable because braid-settings captures
// the named import and bakes SETTINGS_PATH at module-eval time) and write the
// EXPLICIT contextLimitTokens this scenario pins: 200_000 — the provider
// window the fixtures were written against (now pinned explicitly so the
// suite passes regardless of live settings.json).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w85b-high-context-guard-"));
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

const { registerBeforeCompactHandler } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);

function makeFakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
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

let sessionSeq = 0;
function makeFakeCtx({ percent = 50, branchLength = 100 } = {}) {
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
  return {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    // analyzeSession reads ctx.getContextUsage() — this is what the guard's
    // usagePercent comes from.
    getContextUsage: () => ({
      percent,
      tokens: Math.round((percent / 100) * 200000),
      contextWindow: 200000,
    }),
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

/** Pre-fill messagesToSummarize with the full branch (pi-core's token-based span). */
function makePrep(branch) {
  return {
    messagesToSummarize: branch.map((e) => e.message),
    turnPrefixMessages: [],
    isSplitTurn: false,
  };
}

function textOf(msg) {
  return msg?.content?.[0]?.text ?? "";
}

async function fireBeforeCompact(pi, ctx, prep) {
  const evt = { type: "session_before_compact", preparation: prep };
  await pi._emit(evt, ctx);
  return evt;
}

/** Deterministic cut formula from the guard (mirrors compaction.ts STEP 0.75). */
function guardCut(branchLength) {
  const keepCount = Math.min(50, Math.max(10, Math.floor(branchLength * 0.3)));
  const cutIndex = Math.max(0, branchLength - keepCount);
  return { keepCount, cutIndex };
}

console.log("=== STEP 0.75 high-context guard: substantive dropped-span summary ===\n");

const BRANCH_LEN = 100;

await test("(a) regression: >70% usage yields a non-empty dropped-span summarize set", async () => {
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 80, branchLength: BRANCH_LEN });
  const prep = makePrep(ctx.sessionManager.getBranch());
  registerBeforeCompactHandler(pi);

  await fireBeforeCompact(pi, ctx, prep);

  // Pre-fix: guard set messagesToSummarize = [] (length 0) -> empty-batch
  // boilerplate summary. Post-fix: the dropped span [0..cutIndex-1].
  assert.ok(
    prep.messagesToSummarize.length > 0,
    `messagesToSummarize must be non-empty after the guard, got length ${prep.messagesToSummarize.length}`,
  );
  assert.ok(
    prep.messagesToSummarize.length < BRANCH_LEN,
    `dropped span must be smaller than the branch (${BRANCH_LEN}), got ${prep.messagesToSummarize.length}`,
  );
  assert.equal(
    textOf(prep.messagesToSummarize[0]).startsWith("msg 0 "),
    true,
    "dropped span must start at the oldest entry (e0)",
  );
});

await test("(b) guard fields preserved: firstKeptEntryId, turnPrefixMessages, isSplitTurn", async () => {
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 80, branchLength: BRANCH_LEN });
  const prep = makePrep(ctx.sessionManager.getBranch());
  registerBeforeCompactHandler(pi);

  await fireBeforeCompact(pi, ctx, prep);

  const { cutIndex } = guardCut(BRANCH_LEN);
  assert.equal(
    prep.firstKeptEntryId,
    ctx.sessionManager.getBranch()[cutIndex].id,
    `firstKeptEntryId must be branch[cutIndex].id (e${cutIndex})`,
  );
  assert.equal(prep.turnPrefixMessages.length, 0, "turnPrefixMessages must be empty");
  assert.equal(prep.isSplitTurn, false, "isSplitTurn must be false");
});

await test("(c) dropped-span provenance: older entries in, kept recent entries out", async () => {
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 80, branchLength: BRANCH_LEN });
  const prep = makePrep(ctx.sessionManager.getBranch());
  registerBeforeCompactHandler(pi);

  await fireBeforeCompact(pi, ctx, prep);

  const texts = prep.messagesToSummarize.map(textOf);
  assert.ok(
    texts.some((t) => t.startsWith("msg 0 ")),
    "dropped span must include the oldest entry (e0)",
  );
  const { cutIndex } = guardCut(BRANCH_LEN);
  assert.ok(
    !texts.includes(`msg ${cutIndex}`),
    `dropped span must exclude the first kept entry (e${cutIndex})`,
  );
  assert.ok(
    !texts.some((t) => t.startsWith("msg 99 ")),
    "dropped span must exclude the newest entry (e99)",
  );
});

await test("(d) below threshold (50%): guard does NOT fire", async () => {
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ percent: 50, branchLength: BRANCH_LEN });
  const prep = makePrep(ctx.sessionManager.getBranch());
  registerBeforeCompactHandler(pi);

  await fireBeforeCompact(pi, ctx, prep);

  assert.equal(prep.firstKeptEntryId, undefined, "guard must not set firstKeptEntryId below 70%");
  // The pre-filled span must survive (not be replaced by the dropped span):
  // a recent entry beyond the would-be cut (e98, user role) is still present.
  const texts = prep.messagesToSummarize.map(textOf);
  assert.ok(
    texts.some((t) => t.startsWith("msg 98 ")),
    "pre-filled span must still hold recent entries below 70% (guard did not fire)",
  );
  assert.ok(prep.messagesToSummarize.length > 0, "pre-filled span must remain non-empty");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
