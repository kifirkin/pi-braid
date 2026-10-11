/**
 * Turn-end hygiene act: the deterministic slide is mode-independent (R2).
 *
 * The act resolves its path from ONE branch snapshot before the mode gate:
 * a slide-eligible droppable range (assistant/tool entries only, no
 * owner/user turns) arms the slide and fires ctx.compact(SLIDE_MODE)
 * regardless of pi's compaction.enabled; only the LLM summarize path
 * stands down to nudge-only when native compaction owns the loop.
 *
 * Old behavior (regression guarded here): with compaction.enabled=true the
 * act downgraded to nudge-only unconditionally, so in the owner's enabled
 * configuration no automatic actor existed at all (the forensics V2
 * verdict): native threshold compaction computed against the provider
 * window and the act stood down — nothing enforced the configured cap.
 *
 * Coverage:
 * 1. enabled=true + slide-eligible branch at the act arm: compact fires
 *    with the SLIDE_MODE marker, slide state armed, act recorded.
 * 2. enabled=true + summarize-eligible branch (owner turns in the
 *    droppable range): no compact — nudge-only still applies to the LLM
 *    path the mode gate owns.
 * 3. Loop-done gate unchanged: a toolUse stop never acts below the
 *    backstop, in either mode.
 *
 * Run: node test/runtime/enforcement/test-act-slide-mode-independent.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic isolation BEFORE any dist import: HOME pins pi's settings
// (compaction mode via the project .pi/settings.json + braid's configured
// contextLimitTokens); BRAID_HOME pins braid's durable tree so the act's
// pre-save resume.json never touches the live tree.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w218-act-home-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(FAKE_HOME, ".pi", "agent", "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: 200_000 } } }),
);
const BRAID_HOME = mkdtempSync(join(tmpdir(), "w218-act-braid-home-"));
process.env.BRAID_HOME = BRAID_HOME;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const D = join(ROOT, "dist");

const { registerTurnEndHygiene } = await import(
  join(D, "extensions/enforcement/handlers/register-turn-end-hygiene.js")
);
const { dispatchTurnEnd, clearHandlers } = await import(
  join(D, "lib/events/turn-end-coordinator.js")
);
const { getState } = await import(join(D, "extensions/enforcement/state.js"));
const { getCmState } = await import(
  join(D, "extensions/memory/context-manager/handlers/shared.js")
);
const { clearAllBuckets } = await import(join(D, "lib/utils/injection-tracker.js"));
const { _resetForTests: resetTurnDedup, beginTurn } = await import(
  join(D, "lib/enforcement/turn-dedup.js")
);
console.log("=== turn-end act: deterministic slide is mode-independent ===\n");

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

const ACT_SLIDE_KEEP = 40;

/** Assistant-only branch (slide-eligible): the droppable range holds no user turns. */
function assistantBranch(entryCount, tokensPerEntry) {
  const text = "x".repeat(tokensPerEntry * 4);
  return Array.from({ length: entryCount }, (_, i) => ({
    id: `a${i}`,
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text }] },
  }));
}

/** Branch with owner turns inside the droppable range (summarize-eligible). */
function mixedBranch(entryCount, tokensPerEntry) {
  const text = "x".repeat(tokensPerEntry * 4);
  return Array.from({ length: entryCount }, (_, i) => ({
    id: `m${i}`,
    type: "message",
    message: { role: i % 4 === 0 ? "user" : "assistant", content: [{ type: "text", text }] },
  }));
}

function makeWorld({ enabled, branch }) {
  clearHandlers();
  clearAllBuckets();
  resetTurnDedup();
  const injections = [];
  const pi = {
    on: () => {},
    registerTool: () => {},
    sendMessage: (params, opts) => injections.push({ params, opts }),
    sendUserMessage: () => {},
  };
  const compactCalls = [];
  const cwd = mkdtempSync(join(tmpdir(), "w218-act-cwd-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled } }));
  const ctx = {
    cwd,
    compact: (opts) => compactCalls.push(opts),
    sessionManager: {
      getSessionId: () => "w218-act",
      getSessionFile: () => join(cwd, "synthetic.jsonl"),
      getBranch: () => branch,
      getLabel: () => undefined,
    },
    model: { contextWindow: 200_000 },
    getContextUsage: () => ({
      tokens: branch.length * 500,
      contextWindow: 200_000,
      percent: ((branch.length * 500) / 200_000) * 100,
    }),
  };
  const state = getState(ctx);
  state.enforcementActive = true;
  state.lastCompactionTurn = -100;
  registerTurnEndHygiene(pi);
  return { ctx, cwd, compactCalls, injections, branch };
}

async function endTurn(ctx, turnIndex, stopReason = "stop") {
  beginTurn();
  await dispatchTurnEnd(
    {
      turnIndex,
      message: { role: "assistant", content: [], stopReason },
      ctx: {
        getContextUsage: () => ({
          tokens: ctx.sessionManager.getBranch().length * 500,
          contextWindow: 200_000,
          percent: ((ctx.sessionManager.getBranch().length * 500) / 200_000) * 100,
        }),
      },
    },
    ctx,
  );
  await new Promise((r) => setTimeout(r, 20));
}

// Branch sized above the act arm (min(0.60W, 130k) at the pinned 200k = 120k tokens):
// 300 entries x 500 tokens = 150k, of which the droppable span (~260 entries)
// is ~130k — comfortably at/above the arm.
const ENTRIES = 300;
const TOKENS_PER_ENTRY = 500;

await test("1. enabled=true + slide-eligible branch: the act still fires the deterministic slide", async () => {
  const { ctx, cwd, compactCalls } = makeWorld({
    enabled: true,
    branch: assistantBranch(ENTRIES, TOKENS_PER_ENTRY),
  });
  try {
    const state = getState(ctx);
    state.enforcementActive = true;
    await endTurn(ctx, 7);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(
      compactCalls.length,
      1,
      "with compaction.enabled=true the slide-eligible act must STILL fire the deterministic slide " +
        `(got ${compactCalls.length} compact calls)`,
    );
    assert.equal(
      compactCalls[0]?.customInstructions,
      "SLIDE_MODE:true",
      "the fired act must be the deterministic slide (SLIDE_MODE marker)",
    );
    const slide = getCmState(ctx).slideMode;
    assert.ok(slide?.active, "slide state armed for the session_before_compact consumer");
    assert.equal(slide.keepCount, ACT_SLIDE_KEEP, "act keeps its keep window");
    assert.equal(slide.droppedCount, ENTRIES - ACT_SLIDE_KEEP, "dropped span recorded");
    assert.equal(getState(ctx).contextHygieneActs.total, 1, "act recorded");
    assert.equal(getState(ctx).contextHygieneActs.byKind.slide, 1, "act kind = slide");
  } finally {
    clearHandlers();
    rmSync(cwd, { recursive: true, force: true });
  }
});

await test("2. enabled=true + owner turns in the droppable range: summarize path stays nudge-only", async () => {
  const { ctx, cwd, compactCalls } = makeWorld({
    enabled: true,
    branch: mixedBranch(ENTRIES, TOKENS_PER_ENTRY),
  });
  try {
    const state = getState(ctx);
    state.enforcementActive = true;
    await endTurn(ctx, 7);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(
      compactCalls.length,
      0,
      "the LLM summarize path must not fire when pi compaction.enabled=true (native compaction owns LLM compaction)",
    );
  } finally {
    clearHandlers();
    rmSync(cwd, { recursive: true, force: true });
  }
});

await test("3. loop-done gate unchanged: a toolUse stop below the backstop never acts", async () => {
  const { ctx, cwd, compactCalls } = makeWorld({
    enabled: true,
    branch: assistantBranch(ENTRIES, TOKENS_PER_ENTRY),
  });
  try {
    const state = getState(ctx);
    state.enforcementActive = true;
    await endTurn(ctx, 7, "toolUse");
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(
      compactCalls.length,
      0,
      "no act on a live loop (toolUse stop) below the 0.90W backstop — mode-independent or not",
    );
    assert.ok((getState(ctx).contextHygieneSkips ?? 0) >= 1, "gated check recorded as a skip");
  } finally {
    clearHandlers();
    rmSync(cwd, { recursive: true, force: true });
  }
});

try {
  rmSync(BRAID_HOME, { recursive: true, force: true });
  rmSync(FAKE_HOME, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
