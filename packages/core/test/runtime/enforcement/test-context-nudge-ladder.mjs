/**
 * The context-nudge ladder: one scale, both units, one nudge per crossing.
 *
 * Two defects, one cascade:
 *
 * 1. The latch re-armed against a percent bar (`USAGE_FIRED_RESET_BELOW` = 50)
 *    while the arm that fired it is a token fraction (0.45W). 0.45W is 45% of
 *    EVERY window, so between 45% and 50% the latch cleared on the very next
 *    turn and the same whisper repeated every turn. Not a large-window
 *    problem: 0.45W is 45% at every window size, so no window is immune.
 * 2. The cascade tested the token arms before the percent tiers and returned
 *    on the first hit, so from 45% upward the token line won and the advisory
 *    (50), warning (65), critical (75) and compact (80) tiers never rendered:
 *    an agent at 95% read exactly the line an agent at 46% read.
 *
 * The ladder is ordered by position on the axis both units measure (percent of
 * the resolved window), so no rung can shadow a rung above it; the latch
 * records the rung that fired and re-arms in that rung's own unit.
 *
 * Driven through the REAL handler (turn-end coordinator) on a mock pi+ctx with
 * HOME pinned to the arms' window (contextLimitTokens: 256000) and pi's own
 * compaction ENABLED, which is the mode where the nudge ladder is the only
 * channel above the act arm (native compaction owns LLM compaction, so the
 * handler stands down to nudging). Arms at W = 256,000: soft 46,080 (18%),
 * warning 115,200 (45%), act min(0.60W, 130k) = 130,000 (50.8%), backstop
 * 230,400 (90%).
 *
 * lastCompactionTurn is reset to -100 per world so the act cooldown cannot
 * mask the ladder: the observation is what an agent reads at that usage, not
 * whether three turns have passed.
 *
 * Run: node test/runtime/enforcement/test-context-nudge-ladder.mjs
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

// Pin the window the arms resolve from (braid-settings bakes SETTINGS_PATH at
// module-eval time, so HOME is redirected before the dist imports).
const W = 256_000;
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ladder-home-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(FAKE_HOME, ".pi", "agent", "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: W } } }),
);

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
const { tokenArms } = await import("file://" + join(D, "lib/detection/context-usage.js"));
const { resolveContextNudge } = await import("file://" + join(D, "lib/detection/context-tiers.js"));

const ARMS = tokenArms(W);

console.log("=== context-nudge ladder ===\n");

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

/** Mock pi + ctx (test-turn-end-token-rearm harness shape). */
function makeWorld() {
  clearHandlers();
  clearAllBuckets();
  resetTurnDedup();
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
  const tmp = mkdtempSync(join(tmpdir(), "ladder-"));
  // pi's own compaction ENABLED: the mode where the act stands down to
  // nudging and the ladder is the only channel above the act arm.
  mkdirSync(join(tmp, ".pi"), { recursive: true });
  writeFileSync(
    join(tmp, ".pi", "settings.json"),
    JSON.stringify({ compaction: { enabled: true } }),
    "utf-8",
  );
  const sessionFile = join(tmp, "synthetic-session.jsonl");
  const branch = [];
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
  // The act cooldown must not mask the ladder (see the file header).
  getEnforcementState(ctx).lastCompactionTurn = -100;
  return { ctx, tmp, sent, compactCalls };
}

/** A trailing assistant usage entry reports exactly `tokens` (live path). */
function setUsage(ctx, tokens, turnIndex) {
  const branch = ctx.sessionManager.getBranch();
  branch.length = 0;
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
  beginTurn();
  setUsage(ctx, tokens, turnIndex);
  const event = {
    turnIndex,
    toolResults: [],
    message: { role: "assistant", content: [], stopReason: "stop" },
  };
  await dispatchTurnEnd(event, ctx);
  await new Promise((r) => setTimeout(r, 10));
}

/** Delivered text bodies across every mock send, in delivery order. */
function nudgeTexts(sent) {
  return sent.flatMap((s) =>
    (s.params?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? ""),
  );
}

/** The cascade bodies alone (each whisper carries a body and an end marker). */
function bodies(sent) {
  return nudgeTexts(sent).filter((t) => t.includes("Context is ") && !t.includes("-end]"));
}

/** The token-warning rung's copy (0.45W): names the arm, not the count. */
function tokenWarningTexts(sent) {
  return nudgeTexts(sent).filter((t) => t.includes("above the warning arm"));
}

/** The percent soft tier's copy (30%). */
function percentSoftTexts(sent) {
  return nudgeTexts(sent).filter((t) => t.includes("above the soft arm"));
}

/** The percent advisory tier's copy (50%). */
function advisoryTexts(sent) {
  return nudgeTexts(sent).filter((t) => t.includes("above the advisory arm"));
}

const pct = (p) => Math.round((W * p) / 100);

/** What an agent reads at `p` percent, in a world parked at that usage. */
async function observe(p) {
  const { ctx, tmp, sent } = makeWorld();
  try {
    await endTurn(ctx, pct(p), 1);
    const texts = bodies(sent);
    return texts.length > 0 ? texts.join(" | ") : "(no delivery)";
  } finally {
    clearHandlers();
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── the resolver: one ladder, ordered by position ──────────────────────────

await test("resolver: the rung at the highest reached position wins, whatever unit", () => {
  const at45 = resolveContextNudge(45, Math.round(W * 0.45), W);
  assert.equal(at45.id, "tokens:warning", "45%: the 0.45W token arm is the only rung reached");
  const at60 = resolveContextNudge(60, Math.round(W * 0.6), W);
  assert.equal(at60.id, "percent:advisory", "60%: advisory sits above 0.45W and must win");
  const at80 = resolveContextNudge(80, Math.round(W * 0.8), W);
  assert.equal(at80.id, "percent:compact", "80%: compact must win");
  const at95 = resolveContextNudge(95, Math.round(W * 0.95), W);
  assert.equal(at95.id, "percent:compact", "95%: compact is the top rung");
  const below = resolveContextNudge(10, Math.round(W * 0.1), W);
  assert.equal(below, null, "below the first rung there is no nudge");
});

// ── 1. no repeat inside the 45–50% band (the latch) ────────────────────────

await test("latch: at 45–50% the warning fires once and does not repeat", async () => {
  const { ctx, tmp, sent } = makeWorld();
  try {
    await endTurn(ctx, Math.round(W * 0.46), 1);
    assert.equal(tokenWarningTexts(sent).length, 1, "the 0.45W crossing fires the warning rung");
    // 47% is still under the 50% percent bar that the latch used to re-arm
    // against, and above the arm that fired it: unchanged advice, no repeat.
    await endTurn(ctx, Math.round(W * 0.47), 2);
    await endTurn(ctx, Math.round(W * 0.475), 3);
    assert.equal(
      tokenWarningTexts(sent).length,
      1,
      "the same rung may not repeat while usage stays above the arm that fired it",
    );
    assert.equal(
      percentSoftTexts(sent).length + advisoryTexts(sent).length,
      0,
      "no other rung is injected in the band",
    );
  } finally {
    clearHandlers();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 2. re-arm in the unit that fired ───────────────────────────────────────

await test("latch: a drop below the 0.45W arm re-arms, the next crossing fires again", async () => {
  const { ctx, tmp, sent } = makeWorld();
  try {
    await endTurn(ctx, Math.round(W * 0.46), 1);
    assert.equal(tokenWarningTexts(sent).length, 1, "first crossing fires");
    // Below the arm that fired (0.45W), so the latch clears in the unit that
    // armed it rather than against the 50% percent bar. The same rung's body
    // is byte-identical (the copy carries no number), so move past the
    // whisper pipeline's 20-minute exact-repeat window: that layer is not the
    // latch under test.
    await endTurn(ctx, Math.round(W * 0.4), 2);
    _setReprimeClockForTests(Date.now() + REPRIME_COOLDOWN_MS + 1000);
    await endTurn(ctx, Math.round(W * 0.465), 3);
    assert.equal(
      tokenWarningTexts(sent).length,
      2,
      "a genuine drop below the token arm re-arms the rung",
    );
  } finally {
    _setReprimeClockForTests(null);
    clearHandlers();
    rmSync(tmp, { recursive: true, force: true });
  }
});

await test("latch: while usage stays above the arm, ten turns deliver one nudge", async () => {
  const { ctx, tmp, sent } = makeWorld();
  try {
    for (let turn = 1; turn <= 10; turn++) {
      await endTurn(ctx, Math.round(W * 0.46) + turn * 200, turn);
    }
    assert.equal(
      tokenWarningTexts(sent).length,
      1,
      "one crossing, one nudge: the band is not a message-per-turn",
    );
  } finally {
    clearHandlers();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 3. the percent tiers the token arm used to shadow ──────────────────────

await test("ladder: 60% reads the advisory tier, not the 0.45W line", async () => {
  const { ctx, tmp, sent } = makeWorld();
  try {
    await endTurn(ctx, pct(60), 1);
    assert.equal(advisoryTexts(sent).length, 1, "the advisory tier renders at 60%");
    assert.equal(
      tokenWarningTexts(sent).length,
      0,
      "the token arm may not shadow the tier above it",
    );
    // No repeat on the next turn, and a real drop below the tier re-arms it.
    await endTurn(ctx, pct(61), 2);
    assert.equal(advisoryTexts(sent).length, 1, "unchanged usage does not repeat");
    // The whisper funnel has a 20-minute cross-call de-bloat keyed on the
    // digit-normalized body, which is a separate layer from the ladder. Move
    // past that window so this case measures the latch.
    _setReprimeClockForTests(Date.now() + REPRIME_COOLDOWN_MS + 1000);
    await endTurn(ctx, pct(49), 3);
    await endTurn(ctx, pct(51), 4);
    assert.equal(advisoryTexts(sent).length, 2, "a drop below 50% re-arms the tier");
  } finally {
    _setReprimeClockForTests(null);
    clearHandlers();
    rmSync(tmp, { recursive: true, force: true });
  }
});

await test("ladder: the climb 46% -> 60% -> 80% -> 95% delivers three tiers, then holds", async () => {
  const { ctx, tmp, sent, compactCalls } = makeWorld();
  try {
    await endTurn(ctx, pct(46), 1);
    await endTurn(ctx, pct(60), 2);
    await endTurn(ctx, pct(80), 3);
    await endTurn(ctx, pct(95), 4);
    const texts = bodies(sent);
    assert.equal(texts.length, 3, `three rungs crossed, three deliveries (got ${texts.length})`);
    assert.match(texts[0], /above the warning arm/, "46%: the 0.45W token rung");
    assert.match(texts[1], /above the advisory arm/, "60%: the advisory tier");
    assert.match(texts[2], /at the compaction arm/, "80%: the compact tier");
    assert.equal(compactCalls.length, 0, "nudge-only mode: the act never runs");
  } finally {
    clearHandlers();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 3b. the delivery class (a human turn, never the steering queue) ───────

await test("delivery: the context line is queued for the next user prompt, not steered", async () => {
  const { ctx, tmp, sent } = makeWorld();
  try {
    await endTurn(ctx, pct(60), 1);
    const delivery = sent.at(-1)?.options ?? {};
    // pi-core's sendCustomMessage branch 1: deliverAs "nextTurn" is queued for
    // the next user prompt. It never reaches agent.steer() (branch 2), so it
    // cannot keep a run alive across a turn boundary, and no triggerTurn wake
    // starts a run of its own. The owner's next turn is what reads it.
    assert.equal(
      delivery.deliverAs,
      "nextTurn",
      "the context line must be queued for the next user prompt",
    );
    assert.notEqual(delivery.deliverAs, "steer", "it must never enter the steering queue");
    assert.ok(!delivery.triggerTurn, "it must not wake or extend a run");
  } finally {
    clearHandlers();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 4. the four observations (evidence, printed) ───────────────────────────

console.log("\nwhat an agent reads, by usage (window 256000, pi compaction enabled):");
const observations = {};
for (const p of [45, 60, 80, 95]) {
  observations[p] = await observe(p);
  console.log(`  ${p}%: ${observations[p]}`);
}
console.log("");

await test("observations: 45/60/80/95 render four distinct, escalating signals", async () => {
  assert.match(observations[45], /above the warning arm/, "45%: token rung");
  assert.match(observations[60], /above the advisory arm/, "60%: advisory tier");
  assert.match(observations[80], /at the compaction arm/, "80%: compact tier");
  assert.match(observations[95], /at the compaction arm/, "95%: compact tier (top rung)");
  assert.notEqual(observations[45], observations[60], "45% and 60% must not read alike");
  assert.notEqual(observations[60], observations[80], "60% and 80% must not read alike");
});

// ── 5. the act arm is untouched (guardrail: no gate went quiet) ────────────

await test("guardrail: with pi compaction disabled the act arm still compacts", async () => {
  const { ctx, tmp, compactCalls } = makeWorld();
  try {
    // This world's settings file says enabled=true; overwrite it with the
    // native-compaction-off mode, which is when the act must run.
    writeFileSync(
      join(tmp, ".pi", "settings.json"),
      JSON.stringify({ compaction: { enabled: false } }),
      "utf-8",
    );
    await endTurn(ctx, ARMS.act + 60_000, 1);
    assert.equal(compactCalls.length, 1, ">= act compacts once the cooldown allows");
  } finally {
    clearHandlers();
    rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
