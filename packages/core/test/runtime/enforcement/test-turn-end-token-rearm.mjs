/**
 * turn-end auto-compact token re-arm + hard backstop.
 *
 * Drives the REAL register-turn-end-hygiene handler (via the turn-end
 * coordinator) on a mock pi+ctx with HOME pinned to the configured window
 * (contextLimitTokens: 256000), so the arms are host-independent:
 * act = min(0.60W, 130k) = 130k, soft = 0.18W = 46,080,
 * backstop = 0.90W = 230,400. Usage comes through the live path the handler
 * reads (measureLiveUsage): the mock session tree carries one trailing
 * assistant message whose usage.totalTokens is the turn's token count, and
 * the pinned configured window resolves the percent from it.
 * 1. Token re-arm: compaction fires at >=act once >=3 turns have passed
 *    since the last attempt, and re-arms at the same 3-turn spacing.
 * 2. Hard backstop: >=0.90W fires subject to the same turn-based cooldown
 *    (every arm is cooldown-gated so the act can never run every turn).
 * 3. Below act tokens and below 90%: no auto-compact; the nudge ladder
 *    still fires (the percent soft rung at 30%).
 * 4. Soft band: fires on the crossing, not once per turn in the band; the
 *    warning rung still escalates; a drop below the arm re-arms it.
 * 5. Compact mechanics preserved: ctx.compact called with the canonical
 *    instructions.
 *
 * lastCompactionTurn starts at 0, so turn-since counts from turn 0 (the
 * session's first turn index is 1): the first >=act fire lands at turn 3
 * (the min-turn spacing), not turn 1.
 *
 * Run: node test/runtime/enforcement/test-turn-end-token-rearm.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const D = join(ROOT, "dist");

// ── Hermetic settings isolation ────────────────────────────────────────
// Pin the configured window the arms resolve from: 256_000 is the window
// actually configured and the regime where soft (46,080) < act (130,000).
// Redirect HOME before the dist imports (os.homedir() reads $HOME on POSIX;
// braid-settings bakes SETTINGS_PATH at module-eval time, the same seam as
// the sibling fixtures). Without the pin, the third case's nudge tier (soft
// token arm vs percent tier) would depend on the host's live settings.json.
const W = 256_000;
const FAKE_HOME = mkdtempSync(join(tmpdir(), "rearm-home-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(FAKE_HOME, ".pi", "agent", "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: W } } }),
);

// Compiled runtime (npm test builds first).
const { registerTurnEndHygiene } = await import(
  "file://" + join(D, "extensions/enforcement/handlers/register-turn-end-hygiene.js")
);
const { getState: getEnforcementState } = await import(
  "file://" + join(D, "extensions/enforcement/state.js")
);
const { dispatchTurnEnd, clearHandlers } = await import(
  "file://" + join(D, "lib/events/turn-end-coordinator.js")
);
const { clearAllBuckets, _setReprimeClockForTests, REPRIME_COOLDOWN_MS } = await import(
  "file://" + join(D, "lib/utils/injection-tracker.js")
);
const { _resetForTests: resetTurnDedup, beginTurn } = await import(
  "file://" + join(D, "lib/enforcement/turn-dedup.js")
);
// Arms come from the ONE resolver the handler uses. The pinned configured
// window (above) overrides the mock event's 1M provider window, so these are
// the same arms the handler computes: act = min(0.60W, 130k) = 130k.
const { tokenArms } = await import("file://" + join(D, "lib/detection/context-usage.js"));
const ARMS = tokenArms(W);

console.log("=== turn-end auto-compact token re-arm ===\n");

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

/** Mock pi + ctx (test-loop-emitter-consolidation harness shape). */
function makeWorld() {
  clearHandlers();
  clearAllBuckets(); // flood-cap + reprime state is process-global — reset per test
  resetTurnDedup(); // per-turn whisper caps — same
  const sent = [];
  const pi = {
    handlers: new Map(),
    sent,
    on(event, handler) {
      const arr = this.handlers.get(event) || [];
      arr.push(handler);
      this.handlers.set(event, arr);
    },
    async fire(event, ...args) {
      for (const h of this.handlers.get(event) || []) {
        await Promise.resolve()
          .then(() => h(...args))
          .catch(() => {});
      }
    },
    sendMessage(params, options) {
      sent.push({ params, options });
    },
    sendUserMessage() {},
    sendRegisteredMessages() {},
    registerTool() {},
    registerCommand() {},
  };
  const compactCalls = [];
  const tmp = mkdtempSync(join(tmpdir(), "rearm-"));
  // Pin the compaction mode: the handler re-reads pi's merged settings per
  // act decision (enabled=true means nudge-only). This suite exercises the
  // disabled mode -- the act as the loop's compaction guard.
  mkdirSync(join(tmp, ".pi"), { recursive: true });
  writeFileSync(
    join(tmp, ".pi", "settings.json"),
    JSON.stringify({ compaction: { enabled: false } }),
    "utf-8",
  );
  // Unique session file per world: enforcement state is keyed on it, so a
  // shared key would leak lastCompactionTurn across the test cases.
  const sessionFile = join(tmp, "synthetic-session.jsonl");
  let branch = [];
  const ctx = {
    cwd: tmp,
    compact: (opts) => compactCalls.push(opts),
    sessionManager: {
      getBranch: () => branch,
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionFile,
    },
  };
  registerTurnEndHygiene(pi);
  return { ctx, tmp, sent, compactCalls };
}

/**
 * The live measurement reads the session tree; a trailing assistant message
 * whose usage.totalTokens is `tokens` reports exactly that count.
 */
function setUsage(ctx, tokens, turnIndex) {
  const branch = ctx.sessionManager.getBranch();
  branch.length = 0;
  // Two entries: the usage-backed refinement reads the LAST assistant entry's
  // usage when a preceding entry exists (it scans from the end, exclusive of
  // the start), so the reported count is exactly `tokens`.
  branch.push({
    id: `user-${turnIndex}`,
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "turn" }] },
  });
  branch.push({
    id: `usage-${turnIndex}`,
    type: "message",
    message: {
      role: "assistant",
      content: [],
      stopReason: "stop",
      usage: { totalTokens: tokens },
    },
  });
}

async function endTurn(ctx, tokens, turnIndex) {
  beginTurn(); // each endTurn is a fresh turn window (pi-core `input` semantics)
  setUsage(ctx, tokens, turnIndex);
  const event = {
    turnIndex,
    toolResults: [],
    message: { role: "assistant", content: [], stopReason: "stop" },
  };
  await dispatchTurnEnd(event, ctx);
  // ctx.compact is deferred via setTimeout(0) (agent-loop re-entrancy guard
  // in the handler) — yield a macrotask so the deferral lands before asserts.
  await new Promise((r) => setTimeout(r, 10));
}

function compactionState(ctx) {
  return getEnforcementState(ctx); // ContextHygieneState is flattened into it
}

/** Delivered text bodies across every mock send, in delivery order. */
function nudgeTexts(sent) {
  return sent.flatMap((s) =>
    (s.params?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? ""),
  );
}

/** Soft-band deliveries: the percent soft rung (30%) is the strongest rung
 * reached in the band, so its copy is what the ladder renders there. */
function softNudges(sent) {
  return nudgeTexts(sent).filter((t) => t.includes("Soft whisper"));
}

/** Warning token tier deliveries (0.45W arm). */
function warningNudges(sent) {
  return nudgeTexts(sent).filter(
    (t) => t.includes("tokens (") && t.includes("Pipeline: context_navigate"),
  );
}

await test("token re-arm: compacts at >=act with 3-turn spacing", async () => {
  const { ctx, tmp, compactCalls } = makeWorld();
  try {
    // Turns 1-2: >=act but inside the 3-turn min spacing from turn 0.
    await endTurn(ctx, ARMS.act, 1);
    await endTurn(ctx, ARMS.act + 10_000, 2);
    assert.equal(compactCalls.length, 0, "min-turn spacing gates the first >=act fire");

    // Turn 3: spacing satisfied -> FIRST fire.
    await endTurn(ctx, ARMS.act + 60_000, 3);
    assert.equal(compactCalls.length, 1, "first >=act fire at 3 turns");
    assert.equal(compactionState(ctx).lastCompactionTurn, 3);

    // Turns 4-5: 1 and 2 turns since the attempt -> quiet.
    await endTurn(ctx, ARMS.act + 100_000, 4);
    await endTurn(ctx, ARMS.act + 110_000, 5);
    assert.equal(compactCalls.length, 1, "re-arm waits for the min-turn spacing");

    // Turn 6: 3 turns since the last attempt + >=act -> RE-ARM fires.
    await endTurn(ctx, ARMS.act + 100_000, 6);
    assert.equal(compactCalls.length, 2, "token re-arm fires at 3 turns");
    assert.equal(compactionState(ctx).lastCompactionTurn, 6);

    // Compact mechanics preserved.
    assert.deepEqual(compactCalls[1], { customInstructions: "Keep the most recent 10 messages." });
  } finally {
    clearHandlers();
    rmSync(tmp, { recursive: true, force: true });
  }
});

await test("hard backstop: >=0.90W fires, bounded by the same turn cooldown", async () => {
  const { ctx, tmp, compactCalls } = makeWorld();
  try {
    // Turn 3: regular re-arm fire at act + 50k.
    await endTurn(ctx, ARMS.act + 50_000, 1);
    await endTurn(ctx, ARMS.act + 50_000, 2);
    await endTurn(ctx, ARMS.act + 50_000, 3);
    assert.equal(compactCalls.length, 1, "re-arm fire at turn 3");
    assert.equal(compactionState(ctx).lastCompactionTurn, 3);

    // Turn 4 (1 turn since): below backstop must NOT re-arm yet...
    await endTurn(ctx, ARMS.backstop - 10_000, 4);
    assert.equal(compactCalls.length, 1, "re-arm spacing respected below the backstop");

    // ...and >=0.90W fires only after the cooldown (3 turns since the last
    // attempt, i.e. turn 6): the act can never run every turn.
    await endTurn(ctx, ARMS.backstop, 5);
    assert.equal(compactCalls.length, 1, "backstop respects the turn cooldown");
    await endTurn(ctx, ARMS.backstop + 10_000, 6);
    assert.equal(compactCalls.length, 2, "backstop fires at the cooldown boundary");
    assert.equal(compactionState(ctx).lastCompactionTurn, 6);
  } finally {
    clearHandlers();
    rmSync(tmp, { recursive: true, force: true });
  }
});

await test("below act tokens and below 90%: no auto-compact ever; nudge cascade unaffected", async () => {
  const { ctx, tmp, compactCalls, sent } = makeWorld();
  try {
    for (let turn = 1; turn <= 6; turn++) {
      await endTurn(ctx, Math.round(ARMS.act * 0.8), turn);
    }
    assert.equal(
      compactCalls.length,
      0,
      "below-act tokens never auto-compacts (below the token ACT)",
    );
    // The payload sits in [soft, act): the ladder's strongest reached rung is
    // the percent soft tier (30%), above the 0.18W token rung and below the
    // 0.45W warning rung, so that is the copy delivered here.
    const nudgeTexts = sent.flatMap((s) =>
      (s.params?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? ""),
    );
    assert.ok(
      nudgeTexts.some((t) => t.includes("Soft whisper")),
      "the nudge is the percent soft tier (30%)",
    );
  } finally {
    clearHandlers();
    rmSync(tmp, { recursive: true, force: true });
  }
});

await test("soft band: fires on the crossing, not once per turn in the band", async () => {
  const { ctx, tmp, compactCalls, sent } = makeWorld();
  try {
    // Six turns inside the soft band ([0.18W, 0.45W)), usage growing the way
    // a live session grows. The soft whisper is an event: one delivery for
    // the band entry, not one per turn. Distinct token counts keep the
    // whisper pipeline's exact-repeat suppression out of the count.
    const band = [90_000, 94_000, 98_000, 102_000, 106_000, 110_000];
    for (let i = 0; i < band.length; i++) await endTurn(ctx, band[i], i + 1);
    assert.equal(
      softNudges(sent).length,
      1,
      "the soft tier fires once on the crossing turn, not on every turn in the band",
    );

    // The ladder still escalates: the first turn past the warning arm fires
    // the warning text even though the soft tier already fired.
    await endTurn(ctx, 120_000, 7);
    assert.equal(softNudges(sent).length, 1, "the warning tier does not re-fire the soft text");
    assert.equal(warningNudges(sent).length, 1, "the warning token tier still fires");

    // Re-arm: a genuine drop below the soft arms re-arms the rung, so the
    // next crossing fires it again. The whisper funnel's 20-minute
    // digit-normalized de-bloat would damp the same body, so move past that
    // window: this case measures the latch, not the funnel's repeat layer.
    _setReprimeClockForTests(Date.now() + REPRIME_COOLDOWN_MS + 1000);
    await endTurn(ctx, 40_000, 8);
    await endTurn(ctx, 96_000, 9);
    assert.equal(softNudges(sent).length, 2, "a drop below the arm re-arms the soft tier");

    assert.equal(compactCalls.length, 0, "no auto-compact below the act arm");
  } finally {
    _setReprimeClockForTests(null);
    clearHandlers();
    rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
