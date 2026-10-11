/**
 * Runtime fixture: context hygiene measures the live working set and acts
 * before sessions grow.
 *
 * Coverage:
 * (a) failing-first: the reported usage must drop when a slide drops entries
 *     (identical usage before/after a slide fails pre-fix); the reported
 *     window must be stable across calls and carry an explicit source label;
 * (b) the turn-end act fires at the fraction-of-window threshold and is
 *     observable (whisper, compaction call, counters);
 * (c) cooldown respected: no second act on the next turn;
 * (d) no-submit invariant: the act path never starts a turn
 *     (sendUserMessage never called; sendMessage never with triggerTurn);
 * (e) durable state preserved across the act (resume.json carries the
 *     scratchpad goal through the pre-save);
 * (f1)-(f5) loop-done gate: a turn_end whose assistant stopReason is "toolUse"
 *     means the loop is live -- the act must never run ctx.compact there
 *     (skip counter incremented); a loop-done stop acts; the 0.90W backstop
 *     still stops a runaway loop mid-loop; the act re-fires after the
 *     cooldown expires; with pi compaction.enabled=true the act nudges only
 *     and the mode is re-read per check, never cached.
 *
 * Runs against dist/ (build first). The session under test is fully
 * synthetic: no live session files are read or written. The only durable
 * write is resume.json under the slug of a mkdtemp() cwd, removed on exit.
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

// Pin braid's whole persistent tree into a private tmpdir BEFORE any dist
// module loads (dynamic imports inside the tests honor this): every durable
// write the act performs lands under BRAID_HOME, never the live tree.
const BRAID_HOME = mkdtempSync(join(tmpdir(), "hygiene-braid-home-"));
process.env.BRAID_HOME = BRAID_HOME;
const LIVE_SCRATCHPAD_ROOT = join(
  typeof process.env.HOME === "string" ? process.env.HOME : "",
  ".pi/agent/braid/scratchpads",
);
const LIVE_SESSIONS_ROOT = join(
  typeof process.env.HOME === "string" ? process.env.HOME : "",
  ".pi/agent/braid/sessions",
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST = join(ROOT, "dist");

console.log("=== context hygiene live usage ===\n");

let passed = 0;
let failed = 0;
let makeSessionSeq = 0;
async function test(name, fn) {
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

// ── Synthetic session ───────────────────────────────────────────────────────

function textEntry(id, role, text) {
  return {
    id,
    parentId: null,
    type: "message",
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: "text", text }] },
  };
}

/** A branch of `n` message entries, each ~`perEntryTokens` tokens. */
function makeBranch(n, perEntryTokens) {
  const chars = perEntryTokens * 4;
  const text = "x".repeat(chars);
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push(textEntry(`e${i}`, i % 2 === 0 ? "user" : "assistant", text));
  }
  return entries;
}

/**
 * Synthetic session manager. getBranch() returns the live branch array;
 * applySlide() mutates it the way the entry-based cut does: entries before
 * the cut are replaced by one compaction entry. Agent-side usage
 * (`agentTokens`) is NOT touched by the slide, mirroring the pi-runtime lag
 * between the session tree and agent state that produced the identical
 * before/after report in the live session.
 */
function makeSession({ branchTokens, modelWindow }) {
  const perEntryTokens = 500;
  const n = Math.max(10, Math.round(branchTokens / perEntryTokens));
  const branch = makeBranch(n, perEntryTokens);
  const labelById = new Map();

  // Unique per session: enforcement state is keyed on getSessionFile(), so a
  // constant would share one state bucket across every synthetic session.
  const sessionFile = join(cwd, `synthetic-session-${makeSessionSeq++}.jsonl`);
  const sm = {
    getBranch: () => branch,
    getTree: () => branch.map((e) => ({ entry: e, children: [], label: labelById.get(e.id) })),
    getLabel: (id) => labelById.get(id),
    getChildren: () => [],
    getSessionId: () => "synthetic",
    getSessionFile: () => sessionFile,
    getSessionName: () => "synthetic",
    getCwd: () => cwd,
    appendCustomEntry: () => {},
    getEntries: () => branch,
  };

  let agentTokens = branchTokens;
  const model = { contextWindow: modelWindow };
  const compactCalls = [];

  const ctx = {
    sessionManager: sm,
    model,
    cwd,
    compact: (opts) => {
      compactCalls.push(opts);
    },
    getContextUsage: () => ({
      tokens: agentTokens,
      contextWindow: model.contextWindow,
      percent: (agentTokens / model.contextWindow) * 100,
    }),
  };

  return {
    ctx,
    sm,
    branch,
    compactCalls,
    model,
    setAgentTokens(t) {
      agentTokens = t;
    },
    /** Entry-based cut: drop everything before the last `keep` entries. */
    applySlide(keep) {
      const cut = branch.length - keep;
      const dropped = branch.slice(0, cut);
      const kept = branch.slice(cut);
      const compaction = {
        id: `compaction-${compactionSeq++}`,
        parentId: dropped.length > 0 ? (dropped[dropped.length - 1].parentId ?? null) : null,
        type: "compaction",
        timestamp: new Date().toISOString(),
        summary: `slide: dropped ${dropped.length}, kept ${kept.length}`,
        tokensBefore: agentTokens,
      };
      branch.length = 0;
      branch.push(compaction, ...kept);
      return { dropped: dropped.length, kept: kept.length };
    },
  };
}

let compactionSeq = 0;
const cwd = mkdtempSync(join(tmpdir(), "hygiene-fixture-"));

// ── (a) failing-first: usage reflects the slide ─────────────────────────────

await test("(a) reported usage drops after a slide drops entries", async () => {
  const { analyzeSession } = await import(
    join(DIST, "extensions/memory/context-manager/analysis.js")
  );
  const session = makeSession({ branchTokens: 60_000, modelWindow: 200_000 });

  const before = analyzeSession(session.ctx).usage;
  const { dropped } = session.applySlide(10);
  assert.ok(dropped > 0, "slide dropped entries");
  const after = analyzeSession(session.ctx).usage;

  assert.ok(
    after.tokens < before.tokens,
    `usage must drop when the slide drops entries: before=${before.tokens} after=${after.tokens} (identical => metric ignores the slide)`,
  );
  assert.ok(
    after.percent < before.percent,
    `percent must drop with the tokens: before=${before.percent} after=${after.percent}`,
  );
});

await test("(a2) window stable across calls, source labeled, branch total labeled", async () => {
  const { analyzeSession } = await import(
    join(DIST, "extensions/memory/context-manager/analysis.js")
  );
  const session = makeSession({ branchTokens: 30_000, modelWindow: 200_000 });

  const before = analyzeSession(session.ctx);
  const after = analyzeSession(session.ctx);
  assert.strictEqual(
    before.usage.contextWindow,
    after.usage.contextWindow,
    "resolved window must not drift between calls",
  );
  assert.ok(before.usage.contextWindow > 0, "window resolved");
  assert.ok(before.usageSource, "window source label present");
  assert.strictEqual(before.usageSource, after.usageSource, "window source stable");
  assert.ok(
    before.branchTokens !== undefined && before.branchTokens >= before.usage.tokens,
    "branch total reported separately (not sent)",
  );
});

await test("(a3) usage source is the session tree, not the agent-state lag", async () => {
  const { analyzeSession } = await import(
    join(DIST, "extensions/memory/context-manager/analysis.js")
  );
  const session = makeSession({ branchTokens: 60_000, modelWindow: 200_000 });
  session.applySlide(10);
  // Agent state still carries the pre-slide number (pi lag).
  const audit = analyzeSession(session.ctx);
  assert.ok(
    audit.usage.tokens < session.ctx.getContextUsage().tokens,
    "reported live usage must track the post-slide branch, not the stale agent-state estimate",
  );
});

// ── Turn-end act harness ────────────────────────────────────────────────────

async function makeActHarness() {
  const { registerTurnEndHygiene } = await import(
    join(DIST, "extensions/enforcement/handlers/register-turn-end-hygiene.js")
  );
  const { dispatchTurnEnd } = await import(join(DIST, "lib/events/turn-end-coordinator.js"));
  const { getState } = await import(join(DIST, "extensions/enforcement/state.js"));
  const { getResolvedContextWindow } = await import(join(DIST, "lib/config/braid-settings.js"));
  const { projectSlugFromCwd } = await import(
    join(DIST, "extensions/memory/scratchpad/persistence.js")
  );

  const injections = [];
  const userInjections = [];
  const whispers = [];
  const fakePi = {
    on: () => {},
    registerTool: () => {},
    sendMessage: (params, opts) => {
      injections.push({ params, opts });
    },
    sendUserMessage: (...args) => {
      userInjections.push(args);
    },
  };

  // The whisper pipeline dedups/flood-caps on process-global state; reset it
  // per harness so each test's whisper assertions measure THIS test only.
  const { _resetForTests: resetTurnDedup } = await import(
    join(DIST, "lib/enforcement/turn-dedup.js")
  );
  const { clearAllBuckets } = await import(join(DIST, "lib/utils/injection-tracker.js"));
  resetTurnDedup();
  clearAllBuckets();

  registerTurnEndHygiene(fakePi);

  return {
    fakePi,
    injections,
    userInjections,
    whispers,
    dispatchTurnEnd,
    getState,
    getResolvedContextWindow,
    projectSlugFromCwd,
  };
}

function armWindow(resolved) {
  assert.ok(resolved > 0, "resolved window known");
  return resolved;
}

function seedScratchpadGoal(harness, goalText) {
  const slug = harness.projectSlugFromCwd(cwd);
  const dir = join(BRAID_HOME, "scratchpads", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "latest.json"),
    JSON.stringify({ goal: goalText, plans: [], decisions: [] }),
    "utf-8",
  );
}

/**
 * Write the project-level compaction mode the act reads per check.
 * cwd/.pi/settings.json merges over the global settings in pi, so this
 * pins the mode deterministically for each test (never the live global).
 */
function setProjectCompactionMode(enabled) {
  const dir = join(cwd, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { enabled } }), "utf-8");
}

/** Prove the act's durable writes never touched the live braid tree. */
function assertLiveTreeUntouched(harness) {
  const slug = harness.projectSlugFromCwd(cwd);
  assert.ok(
    !existsSync(join(LIVE_SCRATCHPAD_ROOT, slug)),
    "live scratchpads dir must not exist for the fixture slug",
  );
  assert.ok(
    !existsSync(join(LIVE_SESSIONS_ROOT, slug)),
    "live sessions dir must not exist for the fixture slug",
  );
}

function cleanupDurable() {
  try {
    rmSync(BRAID_HOME, { recursive: true, force: true });
  } catch {
    /* fixture cleanup best-effort */
  }
}

function settle() {
  return new Promise((r) => setTimeout(r, 20));
}

// ── (b) act fires at the new threshold ──────────────────────────────────────

await test("(b) act fires at the fraction-of-window threshold and is observable", async () => {
  const h = await makeActHarness();
  try {
    setProjectCompactionMode(false);
    const resolved = armWindow(h.getResolvedContextWindow(200_000));
    // Live tokens above the act arm (0.60 W) plus margin, below backstop (0.90 W).
    const actTokens = Math.round(resolved * 0.65);
    const session = makeSession({ branchTokens: actTokens, modelWindow: 200_000 });
    const state = h.getState(session.ctx);
    state.enforcementActive = true;
    state.lastCompactionTurn = -100;

    await h.dispatchTurnEnd({ turnIndex: 7, ctx: session.ctx }, session.ctx);
    await settle();

    assert.strictEqual(session.compactCalls.length, 1, "act called compact once");
    assert.ok(h.injections.length > 0, "act sent its notification whisper");
    assert.strictEqual(state.lastCompactionTurn, 7, "act recorded the turn");
    const counters = state.contextHygieneActs;
    assert.ok(counters, "act counters recorded");
    assert.strictEqual(counters.total, 1, "one act recorded");
    assert.ok(counters.byTrigger, "trigger recorded (token arm)");
    assertLiveTreeUntouched(h);
  } finally {
    cleanupDurable();
  }
});

// ── (c) cooldown respected ──────────────────────────────────────────────────

await test("(c) no second act on the next turn", async () => {
  const h = await makeActHarness();
  try {
    setProjectCompactionMode(false);
    const resolved = armWindow(h.getResolvedContextWindow(200_000));
    const actTokens = Math.round(resolved * 0.65);
    const session = makeSession({ branchTokens: actTokens, modelWindow: 200_000 });
    const state = h.getState(session.ctx);
    state.enforcementActive = true;
    state.lastCompactionTurn = -100;

    await h.dispatchTurnEnd({ turnIndex: 7, ctx: session.ctx }, session.ctx);
    await settle();
    assert.strictEqual(session.compactCalls.length, 1, "first act fired");

    await h.dispatchTurnEnd({ turnIndex: 8, ctx: session.ctx }, session.ctx);
    await settle();
    assert.strictEqual(
      session.compactCalls.length,
      1,
      "cooldown respected: no second act on the next turn",
    );
  } finally {
    cleanupDurable();
  }
});

// ── (d) no-submit invariant ─────────────────────────────────────────────────

await test("(d) act path never submits, injects or re-arms a turn", async () => {
  const h = await makeActHarness();
  try {
    setProjectCompactionMode(false);
    const resolved = armWindow(h.getResolvedContextWindow(200_000));
    const actTokens = Math.round(resolved * 0.65);
    const session = makeSession({ branchTokens: actTokens, modelWindow: 200_000 });
    const state = h.getState(session.ctx);
    state.enforcementActive = true;
    state.lastCompactionTurn = -100;

    await h.dispatchTurnEnd({ turnIndex: 7, ctx: session.ctx }, session.ctx);
    await settle();

    assert.strictEqual(
      h.userInjections.length,
      0,
      "act never calls sendUserMessage (no prompt submission)",
    );
    for (const inj of h.injections) {
      const opts = inj.opts ?? {};
      assert.ok(
        opts.triggerTurn !== true,
        "act injection must not carry triggerTurn (no re-armed turn)",
      );
    }
  } finally {
    cleanupDurable();
  }
});

// ── (e) durable state preserved across the act ──────────────────────────────

await test("(e) act pre-saves durable state (resume.json carries scratchpad goal)", async () => {
  const h = await makeActHarness();
  try {
    setProjectCompactionMode(false);
    seedScratchpadGoal(h, "fixture goal: preserve me");
    const resolved = armWindow(h.getResolvedContextWindow(200_000));
    const actTokens = Math.round(resolved * 0.65);
    const session = makeSession({ branchTokens: actTokens, modelWindow: 200_000 });
    const state = h.getState(session.ctx);
    state.enforcementActive = true;
    state.lastCompactionTurn = -100;

    await h.dispatchTurnEnd({ turnIndex: 7, ctx: session.ctx }, session.ctx);
    await settle();

    const slug = h.projectSlugFromCwd(cwd);
    const resumeFile = join(BRAID_HOME, "sessions", slug, "resume.json");
    assert.ok(existsSync(resumeFile), "resume.json written by the pre-save (under BRAID_HOME)");
    const saved = JSON.parse(readFileSync(resumeFile, "utf-8"));
    assert.strictEqual(saved.goal, "fixture goal: preserve me", "scratchpad goal carried through");
    assert.ok(Array.isArray(saved.uncommittedFiles), "uncommitted files recorded");
    assertLiveTreeUntouched(h);
  } finally {
    cleanupDurable();
  }
});

// ── (f) loop-done gate + mode awareness ─────────────────────────────────────

await test("(f1) toolUse turn_end never acts at the act arm (loop is live)", async () => {
  const h = await makeActHarness();
  try {
    setProjectCompactionMode(false);
    const resolved = armWindow(h.getResolvedContextWindow(200_000));
    const actTokens = Math.round(resolved * 0.65);
    const session = makeSession({ branchTokens: actTokens, modelWindow: 200_000 });
    const state = h.getState(session.ctx);
    state.enforcementActive = true;
    state.lastCompactionTurn = -100;

    await h.dispatchTurnEnd(
      { turnIndex: 7, message: { role: "assistant", stopReason: "toolUse" }, ctx: session.ctx },
      session.ctx,
    );
    await settle();

    assert.strictEqual(
      session.compactCalls.length,
      0,
      "act must not call compact while the loop is live (toolUse stop): " +
        `calls=${session.compactCalls.length}`,
    );
    assert.ok(
      (h.getState(session.ctx).contextHygieneSkips ?? 0) >= 1,
      "gated check recorded as a skip",
    );
    assert.strictEqual(
      h.getState(session.ctx).lastCompactionTurn,
      -100,
      "no act recorded (cooldown anchor untouched)",
    );
  } finally {
    cleanupDurable();
  }
});

await test("(f2) a loop-done stop acts at the same usage", async () => {
  const h = await makeActHarness();
  try {
    setProjectCompactionMode(false);
    const resolved = armWindow(h.getResolvedContextWindow(200_000));
    const actTokens = Math.round(resolved * 0.65);
    const session = makeSession({ branchTokens: actTokens, modelWindow: 200_000 });
    const state = h.getState(session.ctx);
    state.enforcementActive = true;
    state.lastCompactionTurn = -100;

    await h.dispatchTurnEnd(
      { turnIndex: 7, message: { role: "assistant", stopReason: "stop" }, ctx: session.ctx },
      session.ctx,
    );
    await settle();

    assert.strictEqual(session.compactCalls.length, 1, "loop-done stop acts");
    assert.strictEqual(h.getState(session.ctx).lastCompactionTurn, 7, "act recorded");
  } finally {
    cleanupDurable();
  }
});

await test("(f3) backstop still stops a runaway loop mid-loop (disabled mode)", async () => {
  const h = await makeActHarness();
  try {
    setProjectCompactionMode(false);
    const resolved = armWindow(h.getResolvedContextWindow(200_000));
    const backstopTokens = Math.round(resolved * 0.92);
    const session = makeSession({ branchTokens: backstopTokens, modelWindow: 200_000 });
    const state = h.getState(session.ctx);
    state.enforcementActive = true;
    state.lastCompactionTurn = -100;

    await h.dispatchTurnEnd(
      { turnIndex: 7, message: { role: "assistant", stopReason: "toolUse" }, ctx: session.ctx },
      session.ctx,
    );
    await settle();

    assert.strictEqual(
      session.compactCalls.length,
      1,
      "0.90W backstop must act even on a toolUse stop (runaway-loop guard)",
    );
    const counters = h.getState(session.ctx).contextHygieneActs;
    assert.strictEqual(counters.byTrigger.backstop, 1, "trigger recorded as backstop");
  } finally {
    cleanupDurable();
  }
});

await test("(f4) act re-fires after the cooldown expires (second fire)", async () => {
  const h = await makeActHarness();
  try {
    setProjectCompactionMode(false);
    const resolved = armWindow(h.getResolvedContextWindow(200_000));
    const actTokens = Math.round(resolved * 0.65);
    const session = makeSession({ branchTokens: actTokens, modelWindow: 200_000 });
    const state = h.getState(session.ctx);
    state.enforcementActive = true;
    state.lastCompactionTurn = -100;

    await h.dispatchTurnEnd(
      { turnIndex: 7, message: { role: "assistant", stopReason: "stop" }, ctx: session.ctx },
      session.ctx,
    );
    await settle();
    assert.strictEqual(session.compactCalls.length, 1, "first act fired");

    await h.dispatchTurnEnd(
      { turnIndex: 10, message: { role: "assistant", stopReason: "stop" }, ctx: session.ctx },
      session.ctx,
    );
    await settle();
    assert.strictEqual(
      session.compactCalls.length,
      2,
      "act re-arms after HYGIENE_AUTO_COMPACT_MIN_TURNS turns",
    );
    const counters = h.getState(session.ctx).contextHygieneActs;
    assert.strictEqual(counters.total, 2, "both acts recorded");
    assert.strictEqual(h.getState(session.ctx).lastCompactionTurn, 10, "second act recorded");
  } finally {
    cleanupDurable();
  }
});

await test("(f5) compaction.enabled=true: nudge only, mode re-read per check", async () => {
  const h = await makeActHarness();
  try {
    setProjectCompactionMode(true);
    const resolved = armWindow(h.getResolvedContextWindow(200_000));
    const actTokens = Math.round(resolved * 0.65);
    const session = makeSession({ branchTokens: actTokens, modelWindow: 200_000 });
    const state = h.getState(session.ctx);
    state.enforcementActive = true;
    state.lastCompactionTurn = -100;

    await h.dispatchTurnEnd(
      { turnIndex: 7, message: { role: "assistant", stopReason: "stop" }, ctx: session.ctx },
      session.ctx,
    );
    await settle();

    assert.strictEqual(
      session.compactCalls.length,
      0,
      "native compaction owns the loop: act must never call ctx.compact",
    );
    assert.ok(h.injections.length > 0, "act nudges instead of compacting");

    // Flip ONLY the settings file; same ctx, same state. The next check must
    // re-read the mode and act -- proving the mode is never cached.
    setProjectCompactionMode(false);
    await h.dispatchTurnEnd(
      { turnIndex: 8, message: { role: "assistant", stopReason: "stop" }, ctx: session.ctx },
      session.ctx,
    );
    await settle();
    assert.strictEqual(
      session.compactCalls.length,
      1,
      "flipping compaction.enabled=false re-arms the act on the next check",
    );
  } finally {
    cleanupDurable();
  }
});

// ── Skip counter: no fabricated zero ────────────────────────────────────────

await test("turn-end check skipped for lack of a number is counted, never acts on zero", async () => {
  const h = await makeActHarness();
  const session = makeSession({ branchTokens: 10_000, modelWindow: 200_000 });
  // Both sources unavailable: no tree (getBranch throws) and no event ctx usage.
  session.sm.getBranch = () => {
    throw new Error("no tree");
  };
  delete session.ctx.getContextUsage;
  const state = h.getState(session.ctx);
  state.enforcementActive = true;
  state.lastCompactionTurn = -100;

  await h.dispatchTurnEnd({ turnIndex: 7, ctx: session.ctx }, session.ctx);
  await settle();

  assert.strictEqual(session.compactCalls.length, 0, "no act without a number");
  assert.strictEqual(
    h.getState(session.ctx).contextHygieneSkips ?? 0,
    h.getState(session.ctx).contextHygieneSkips,
    "skip counter present",
  );
  assert.ok(
    (h.getState(session.ctx).contextHygieneSkips ?? 0) >= 1,
    "skip recorded when both sources yield nothing",
  );
});

// ── Cleanup ─────────────────────────────────────────────────────────────────

try {
  rmSync(cwd, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
