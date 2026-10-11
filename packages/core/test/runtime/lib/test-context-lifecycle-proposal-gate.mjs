/**
 * Context-lifecycle proposal real-need gate + dedupe.
 *
 * A benchmark measured context-lifecycle:proposal as the #1
 * de-bloat target (2,546 deliveries / 69,558 tokens at 4% acted-on), with
 * 33% of deliveries being exact-repeat same-session bodies re-injected turn
 * after turn ("Context at 55%. Consider context_compress(action='archive')"
 * re-armed by the persistent-condition policy on every cooldown).
 *
 * This fixture drives the REAL compiled context-lifecycle before_agent_start
 * hook (deterministic — no LLM calls: usage-based policies don't need topic
 * classification) and pins the contract of the single proposal chokepoint
 * (queueProposal):
 *
 * 1. exact-repeat within a session -> NOT re-sent while still actionable;
 * 2. digit-drifting body (55% -> 66%, same suggestion class) -> NOT re-sent;
 * 3. genuinely urgent nudge (usage >= PROPOSAL_URGENT_USAGE) -> STILL lands
 * (urgency preserved — keep triggerTurn/actionable delivery);
 * 4. no real need (usage below the actionable floor + no compression
 * signal) -> NOT sent at all (gate);
 * 5. agent just acted on context -> advisory class suppressed (gate), BUT
 * a genuinely different event-class suggestion still fires (no
 * over-suppression regression);
 * 6. agent declined the same suggestion class -> suppressed (compliance
 * feedback via the real context_proposals reject tool);
 * 7. same-class suggestion ignored (implicitly approved) -> back off for
 * PROPOSAL_IGNORED_BACKOFF_TURNS (independent compliance-feedback cork);
 * 8. envelope/end-marker invariants survive: every persisted proposal still
 * carries the [braid-whisper - context-lifecycle] envelope and exactly
 * one [braid-whisper-end] marker (proposal-envelope guard).
 *
 * NOTE ON COOLDOWNS: evaluatePolicies() skips a policy inside its own
 * cooldown_ms window even before our gate/dedupe runs. To prove the
 * GATE + DEDUPE (not the policy cooldown) is what suppresses a re-fire, each
 * repeat scenario clears the pressure-proposal cooldown first, forcing the
 * policy to re-evaluate so the suppression decision is ours.
 *
 * Run: node test/runtime/lib/test-context-lifecycle-proposal-gate.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Hermetic settings isolation (re-baseline) ───────────────────────
// The harness drives the REAL compiled context-lifecycle hook, which reads
// usage through the ONE resolver chain (helpers.getContextUsage →
// lib/detection/context-tiers → lib/config/braid-settings) whose reader hits
// <homedir()>/.pi/agent/settings.json — these pins drifted when the live
// config migrated to the . Redirect HOME to a temp
// dir BEFORE the dist imports (os.homedir() reads $HOME on POSIX — same seam
// as test-context-limit-config.mjs; mock.method(os, "homedir") is not viable
// because braid-settings captures the named import and bakes SETTINGS_PATH at
// module-eval time) and write the EXPLICIT contextLimitTokens this scenario
// pins: 200_000 — a sub-1M provider window (the percent-arm regime these
// scenarios exercise). The suite now passes regardless of live settings.json.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "w85b-proposal-gate-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(FAKE_HOME, ".pi", "agent", "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: 200_000 } } }),
);

const { clearAllBuckets } = await import("../../../dist/lib/utils/injection-tracker.js");
const { _resetForTests } = await import("../../../dist/lib/enforcement/turn-dedup.js");
const { clearExtensionState } = await import("../../../dist/lib/state/extension-state.js");
const { _getState } = await import("../../../dist/extensions/memory/context-lifecycle/state.js");
const { proposalKeyFor } =
  await import("../../../dist/extensions/memory/context-lifecycle/helpers.js");
const { default: contextLifecycleExtension } =
  await import("../../../dist/extensions/memory/context-lifecycle/index.js");

console.log("=== context-lifecycle proposal gate + dedupe ===\n");

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

/** Fresh, isolated harness driving the real extension hooks. */
let harnessSeq = 0;
function makeHarness(initialUsage) {
  const entries = [];
  const sessionId = `proposal-gate-${harnessSeq++}-${Date.now()}`;
  let usage = initialUsage;
  const pi = {
    handlers: new Map(),
    tools: null,
    on(event, handler) {
      this.handlers.set(event, handler);
    },
    registerTool(tool) {
      this.tools = tool;
    },
    sendMessage() {},
    sendUserMessage() {},
    // The documented durable-entry seam; this suite asserts other surfaces.
    appendEntry() {},
  };
  const ctx = {
    sessionManager: {
      getSessionFile: () => `fake-${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getEntries: () => entries.slice(),
      getBranch: () => [],
      appendCustomMessageEntry: (type, content, persistent, meta) => {
        // Mirror SessionManager: a persisted custom_message entry whose
        // customType is the proposal type (isProposalEntry checks
        // entry.type === "custom_message" && customType === PROPOSAL_CUSTOM_TYPE).
        const id = `e${entries.length}`;
        entries.push({
          id,
          type: "custom_message",
          customType: type,
          content,
          persistent,
          details: meta,
        });
        return id;
      },
    },
    // tokens null = UNKNOWN (pi-core ContextUsage.tokens is number | null).
    // The old 0 sentinel is a KNOWN zero under the percent recompute in
    // getContextUsage (it would recompute the percent arm to 0% and close the
    // gate); null keeps the percent arm as the only signal, which is what the
    // scenarios here mean. contextWindow matches the explicit
    // contextLimitTokens fixture above, so the normalization is a
    // pass-through and the percent arms are read verbatim.
    getContextUsage: () => ({ percent: usage, tokens: null, contextWindow: 200_000 }),
  };
  contextLifecycleExtension(pi);
  return {
    pi,
    ctx,
    entries,
    setUsage(p) {
      usage = p;
    },
    /** Reset policy cooldowns so the policy re-evaluates and the GATE/DEDUPE
     * (not the policy cooldown) is what decides the re-fire. */
    rearm(...policyIds) {
      const s = _getState(ctx);
      for (const id of policyIds) s.policyEngine.cooldowns.delete(id);
    },
    runTurn() {
      const p = pi.handlers.get("before_agent_start");
      assert.ok(p, "before_agent_start handler must be registered");
      return p({ prompt: "proposal gate fixture" }, ctx);
    },
    callTool(name, input) {
      const p = pi.handlers.get("tool_call");
      assert.ok(p, "tool_call handler must be registered");
      return p({ toolName: name, input }, ctx);
    },
    reject(id) {
      const tool = pi.tools;
      assert.equal(tool?.name, "context_proposals", "context_proposals tool must be registered");
      return tool.execute(`c-${Date.now()}`, { action: "reject", id }, undefined, undefined, ctx);
    },
    state() {
      return _getState(ctx);
    },
  };
}

function freshState(h) {
  clearExtensionState(h.ctx, "context-lifecycle");
  const s = h.state();
  s.proposalKeysSeeded = false;
  s.proposalKeys.clear();
  s.proposalIgnoredTurns.clear();
  s.declinedKeys.clear();
  s.lastContextActionTurn = 0;
}

// The pressure-proposal template renders {percent} as the full "55%" (the
// placeholder owns the sign), so the interpolated body carries one %.
// Mirror it exactly so the fixture's expected keys match the persisted
// bodies.
function advisoryBody(percent) {
  return `Context at ${percent}%. Consider \`context_compress(action="archive")\` for completed tasks.`;
}

function countPolicy(entries, policyId) {
  return entries.filter((e) => e.details?.policy_id === policyId).length;
}

// ── 1. Exact-repeat within session -> NOT re-sent ───────────────────────────

await test("1. exact-repeat same-session proposal is NOT re-sent while still actionable", async () => {
  clearAllBuckets();
  _resetForTests();
  const h = makeHarness(55);
  freshState(h);

  await h.runTurn(); // turn 1: advisory at 55% fires
  assert.equal(h.entries.length, 1, "first occurrence must deliver exactly one proposal");
  assert.equal(h.entries[0].details.policy_id, "pressure-proposal");
  assert.equal(h.state().proposalKeys.size, 1, "the delivered suggestion class is tracked");

  h.rearm("pressure-proposal"); // force the policy to re-evaluate
  await h.runTurn(); // turn 2: same usage, same class -> dedupe suppresses
  assert.equal(
    h.entries.length,
    1,
    "exact-repeat re-fire must not add a second proposal (dedupe, not policy cooldown)",
  );
});

// ── 2. Digit-drifting body (55% -> 66%) -> same suggestion class, suppressed ─

await test("2. digit-drifting repeat (55% -> 66%) is suppressed (ticking counter is noise)", async () => {
  clearAllBuckets();
  _resetForTests();
  const h = makeHarness(55);
  freshState(h);

  await h.runTurn(); // 55% -> key 'context at #%% ... archive'
  assert.equal(h.entries.length, 1, "first advisory (55%) delivers");

  h.setUsage(66); // same suggestion class, % drifted
  h.rearm("pressure-proposal");
  await h.runTurn();
  assert.equal(h.entries.length, 1, "66% advisory normalizes to the same key and is suppressed");

  const driftedKey = proposalKeyFor(advisoryBody(66), "context_compress");
  assert.ok(
    h.state().proposalKeys.has(driftedKey),
    "the drifted body maps to the same dedupe key as the 55% body",
  );
});

// ── 3. Urgent nudge still lands (keep urgency) ───────────────────────────────

await test("3. genuinely urgent proposal (usage >= 75) bypasses gate + dedupe and still lands", async () => {
  clearAllBuckets();
  _resetForTests();
  const h = makeHarness(80); // >= PROPOSAL_URGENT_USAGE
  freshState(h);

  await h.runTurn(); // turn 1: urgent proposal fires
  h.rearm("pressure-proposal");
  await h.runTurn(); // turn 2: SAME urgent class re-fires (urgency preserved)
  assert.equal(
    h.entries.length,
    2,
    "an urgent compact/archive nudge re-fires rather than being swallowed by dedupe",
  );
});

// ── 4. No real need -> gate suppresses entirely ───────────────────────────────

await test("4. advisory below the actionable floor + no compression signal is NOT sent", async () => {
  clearAllBuckets();
  _resetForTests();
  const h = makeHarness(52); // policy threshold 50 fires, but < PROPOSAL_ACTIONABLE_USAGE
  freshState(h);

  await h.runTurn();
  await h.runTurn();
  assert.equal(
    h.entries.length,
    0,
    "usage 52% advisory with no density/duplicate signal has no real need - suppressed",
  );
});

// ── 5. Agent just acted -> advisory suppressed, distinct class still fires ──

await test("5. after agent acts on context, the advisory class is suppressed but a distinct event suggestion fires", async () => {
  clearAllBuckets();
  _resetForTests();
  const h = makeHarness(55);
  freshState(h);

  await h.runTurn(); // turn 1: advisory delivers
  assert.equal(h.entries.length, 1);

  await h.callTool("context_compress", { action: "archive" }); // agent acts
  assert.equal(
    h.state().lastContextActionTurn,
    h.state().turnCount,
    "acting on context records the turn",
  );
  assert.equal(h.state().proposalKeys.size, 0, "acting re-arms the dedupe map");

  h.rearm("pressure-proposal");
  await h.runTurn(); // turn 2
  // The advisory class is suppressed (gate: agent-just-acted) ...
  assert.equal(
    countPolicy(h.entries, "pressure-proposal"),
    1,
    "advisory right after a context action is suppressed (gate: agent-just-acted)",
  );
  // ... while the distinct event-class suggestion (task boundary, queued by
  // the same archive action) STILL fires — no over-suppression.
  assert.equal(
    countPolicy(h.entries, "task-boundary-proposal"),
    1,
    "a distinct, genuinely-warranted event suggestion still fires (no over-suppression)",
  );
  assert.equal(h.entries.length, 2, "exactly the two distinct classes delivered");

  // A wholly different event class (task completion) also lands.
  h.state().detector.pendingSignals.push({
    id: "sig-completion-gate",
    type: "task_completion_candidate",
    timestamp: Date.now(),
    turn: 1,
    data: { topicHistory: [], uniqueTools: 3 },
    confidence: 0.9,
  });
  await h.runTurn(); // turn 3
  assert.equal(
    countPolicy(h.entries, "finalize-suggestion"),
    1,
    "a second distinct event suggestion also fires (no over-suppression)",
  );
});

// ── 6. Declined the same class -> suppressed (compliance feedback) ──────────

await test("6. declining a suggestion class via context_proposals reject suppresses re-proposal", async () => {
  clearAllBuckets();
  _resetForTests();
  const h = makeHarness(55);
  freshState(h);

  await h.runTurn();
  assert.equal(h.entries.length, 1, "advisory delivers");
  const id = h.entries[0].details.id;

  const result = await h.reject(id); // REAL reject tool records the declined class
  assert.ok(
    String(result.content?.[0]?.text ?? "").includes("Rejected"),
    "reject tool resolves the proposal",
  );
  assert.equal(h.state().declinedKeys.size, 1, "declined class is recorded");

  h.rearm("pressure-proposal");
  await h.runTurn(); // same advisory re-fires -> declined-same-class
  assert.equal(h.entries.length, 1, "a declined suggestion class is not re-proposed");
});

// ── 7. Ignored (implicitly approved) -> compliance-feedback backoff ─────────

await test("7. a class the agent ignored backs off for PROPOSAL_IGNORED_BACKOFF_TURNS", async () => {
  clearAllBuckets();
  _resetForTests();
  const h = makeHarness(55);
  freshState(h);

  await h.runTurn();
  assert.equal(h.entries.length, 1, "advisory delivers");
  const key = proposalKeyFor(advisoryBody(55), "context_compress");

  // Simulate the state after the implicit-approval loop marked the class
  // ignored AND the delivery cooldown lapsed / map re-armed: only the
  // independent compliance-feedback cork remains.
  h.state().proposalIgnoredTurns.set(key, 1); // ignored at turn 1
  h.state().proposalKeys.delete(key); // cooldown gone
  h.entries[0].details.resolution = "implicit_approved";

  h.rearm("pressure-proposal");
  await h.runTurn(); // turn 2: within backoff window (2 - 1 <= 8)
  assert.equal(
    h.entries.length,
    1,
    "same-class suggestion the agent ignored is backed off while ignored-backoff holds",
  );

  // After the backoff window lapses, a genuinely-new actionable advisory may
  // fire again (persisted proposal already resolved; only the cork held it).
  h.state().proposalIgnoredTurns.delete(key);
  h.rearm("pressure-proposal");
  await h.runTurn(); // turn 3: backoff cleared -> re-armed
  assert.equal(
    h.entries.length,
    2,
    "after the ignored-backoff window, the class may be proposed again when warranted",
  );
});

// ── 8. Envelope/end-marker invariants survive the gate+dedupe wiring ────────

await test("8. persisted proposals still carry envelope + exactly one end-marker", async () => {
  clearAllBuckets();
  _resetForTests();
  const h = makeHarness(55);
  freshState(h);

  await h.runTurn();
  assert.equal(h.entries.length, 1);
  const e = h.entries[0];
  assert.equal(e.customType, "context-lifecycle:proposal", "proposal custom type unchanged");
  assert.equal(e.type, "custom_message", "persisted as a custom_message entry");
  assert.equal(e.persistent, true, "proposal stays persisted");
  assert.match(
    e.content[0].text,
    /^\[braid-whisper - context-lifecycle @ [^\]]+\]\nContext Suggestion: /,
    "envelope family == body family + T3 generation clock (proposal-envelope guard)",
  );
  const last = e.content[e.content.length - 1];
  assert.equal(last.text, "[braid-whisper-end]", "proposal closes with the end-marker");
  const markers = e.content.filter((c) => c.type === "text" && c.text === "[braid-whisper-end]");
  assert.equal(markers.length, 1, "exactly one end-marker per proposal");
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log("=== proposal gate + dedupe tests passed ===");
