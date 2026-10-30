/**
 * Loop/addiction emitters collapsed into ONE signal.
 *
 * Context: one stuck-loop signal class
 * was emitted by THREE independent detectors, each with its own whisper path —
 * ~416 deliveries for a single signal: `[analytics] Tool addiction` (332,
 * heartbeat/analytics), `Repetitive Loop Detected` (73, cognitive/turn-outcome),
 * and enforcement `Tool loop detected` (11, lib/detection/tool-loop-detector.ts).
 *
 * Proposal B keeps the ENFORCEMENT tool-loop detector as the ONE authoritative
 * emitter and folds the other two (their loop/addiction whisper no longer
 * delivers; detection + analytics/BPE side-effects remain). A third fold adds a
 * FOURTH (the dreamer's loop-detector path) and ports the intentional-use
 * filter into the surviving detector. This fixture drives the REAL turn_end
 * handlers of all FOUR emitters on a shared pi+ctx over a simulated stuck-loop
 * (16 consecutive `grep`calls), and asserts:
 *
 * 1. EXACTLY ONE whisper is delivered on the consolidated path — the
 * enforcement "Tool loop detected"signal (customType "enforcement").
 * 2. That whisper does NOT wake the agent: options.triggerTurn === false
 * (park class; enforcement delivers the loop signal as an advisory, never
 * starts a loop turn).
 * 3. Keeping the loop running stays at exactly ONE whisper (surviving
 * detector's markLoopFired + TOOL_LOOP_COOLDOWN_TURNS = per-episode single
 * delivery; no multi-whisper re-emission).
 * 4. The folded analytics path still DETECTS the addiction condition (the
 * dominance precondition is met — pre-fold this would have delivered
 * "[analytics] Tool addiction") but delivers ZERO whispers; fold is
 * deliberate, not a missed trigger. turn-outcome also delivers ZERO.
 * 5. A genuinely NEW stuck-loop (after the loop breaks + cooldown elapses)
 * re-fires the surviving detector exactly once — the fold kept loop
 * coverage, it did not kill it.
 * 6. The dreamer is the 4th emitter — its loop-path whisper is
 * folded. On a pure 16-grep stuck loop the dreamer DETECTS the loop and
 * records advice (fold keeps observation/accuracy tracking) but delivers
 * ZERO whispers.
 * 7. Intentional-use filter: a 16-grep tail WITH a `think`inside
 * the window is NOT a loop — ZERO whispers delivered.
 *
 * Run: node test/runtime/enforcement/test-loop-emitter-consolidation.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const D = join(ROOT, "dist");

// Compiled runtime (npm test builds first).
const { dispatchTurnEndLoop } = await import(
  "file://" + join(D, "extensions/enforcement/handlers/turn-end-handler.js")
);
const {
  recordToolCall,
  getToolLoopState,
  detectToolLoop,
  detectToolLoopFromSequence,
  TOOL_LOOP_THRESHOLD,
} = await import("file://" + join(D, "lib/detection/tool-loop-detector.js"));
const { getState: getEnforcementState } = await import(
  "file://" + join(D, "extensions/enforcement/state.js")
);
const { getPendingAdvice, resetAdviceTracker } = await import(
  "file://" + join(D, "lib/reasoning/advice-tracker.js")
);
const { dreamerHandler } = await import(
  "file://" + join(D, "extensions/enforcement/handlers/analysis/dreamer-handler.js")
);
const { default: analyticsExtension } = await import(
  "file://" + join(D, "extensions/heartbeat/analytics/index.js")
);
const { default: turnOutcomeExtension } = await import(
  "file://" + join(D, "extensions/cognitive/turn-outcome/index.js")
);
const { getAnalyticsStateInternal } = await import(
  "file://" + join(D, "extensions/heartbeat/analytics/shared.js")
);
const { clearAllBuckets } = await import("file://" + join(D, "lib/utils/injection-tracker.js"));
const { _resetForTests } = await import("file://" + join(D, "lib/enforcement/turn-dedup.js"));

const TOOL_EXECUTION_START = "tool_execution_start";
const TOOL_EXECUTION_END = "tool_execution_end";
const TURN_END = "turn_end";

console.log("=== loop/addiction emitter consolidation ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch(async (e) => {
      await new Promise((r) => setTimeout(r, 20));
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

/** Fake pi: multi-handler per event (like pi-core), records sendMessage. */
function makePi() {
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
  return pi;
}

let callId = 0;

/** One tool call the way the real handlers see it. The 4th argument is the
 *  call's arguments: a loop is the same call repeating, so a stuck-loop
 *  scenario passes the same input every time and a chain scenario passes a
 *  new one. */
async function callTool(pi, ctx, tool, input) {
  const id = `call${callId++}`;
  // enforcement tool_call handler records the loop-state entry (tool + the
  // argument identity) and the enforcement toolLog (names only).
  recordToolCall(getToolLoopState(ctx), tool, input);
  getEnforcementState(ctx).toolLog.push(tool);
  // analytics tool_execution_start/end build the per-turn sequence
  await pi.fire(TOOL_EXECUTION_START, { toolCallId: id, toolName: tool }, ctx);
  await pi.fire(TOOL_EXECUTION_END, { toolCallId: id, toolName: tool, isError: false }, ctx);
}

/** One turn-end the way the real handlers see it (all four emitters). */
async function endTurn(pi, ctx, tools) {
  const event = {
    toolResults: tools.map((t) => ({ toolName: t, isError: false })),
    message: { role: "assistant", content: [], stopReason: "tool-calls" },
  };
  // analytics + turn-outcome real turn_end handlers
  await pi.fire(TURN_END, event, ctx);
  // enforcement turn-end loop (surviving detector) — priority 90
  await dispatchTurnEndLoop(pi, event, ctx);
  // dreamer loop/advisory dispatch — priority 80 (runs AFTER enforcement-loop,
  // production order via handler-registry.ts)
  await dreamerHandler(pi, event, ctx);
}

/** The one call a stuck-loop scenario repeats: identical arguments every time. */
const STUCK_GREP = { pattern: "needle", path: "src" };

function whisperText(s) {
  return s.params?.content?.find((c) => c.type === "text")?.text ?? "";
}

function freshWorld() {
  _resetForTests();
  clearAllBuckets();
  resetAdviceTracker();
}

// ── Scenario 1: ONE stuck-loop episode -> EXACTLY ONE whisper, no wake ─────
await test("consolidated stuck-loop delivers exactly ONE whisper (no wake)", async () => {
  freshWorld();
  const pi = makePi();
  analyticsExtension(pi);
  turnOutcomeExtension(pi);
  const ctx = { cwd: "/tmp/loop-emitter" };

  // 8 turns x 2 grep = 16 consecutive -> enforcement fires on the last.
  // (12 turns total: the analytics dominance window needs >=10 per-turn
  // entries to cross its own addiction gate, proving the fold below.)
  for (let turn = 0; turn < 12; turn++) {
    await callTool(pi, ctx, "grep", STUCK_GREP);
    await callTool(pi, ctx, "grep", STUCK_GREP);
    await endTurn(pi, ctx, ["grep", "grep"]);
  }

  assert.equal(pi.sent.length, 1, `exactly one delivered whisper, got ${pi.sent.length}`);
  const only = pi.sent[0];
  assert.equal(
    only.params.customType,
    "enforcement",
    "the single signal is the enforcement loop signal",
  );
  assert.match(
    whisperText(only),
    /Tool loop detected/,
    "body is the enforcement tool-loop message",
  );
  assert.equal(
    only.options.triggerTurn,
    false,
    "the loop whisper must not wake the agent (triggerTurn:false advisory)",
  );
  assert.match(
    whisperText(only),
    /^\[braid-whisper - enforcement @ [^\]]+\]/,
    "delivered via the enforcement envelope (single family)",
  );

  // Fold proof: the analytics path RUNS its addiction check (lastAddictionCheck
  // advanced) and the dominance condition holds (grep = 100% of the window, 1
  // tool) — pre-fold this produced the 332 `[analytics] Tool addiction`
  // deliveries. Post-fold it delivers zero whispers.
  const aState = getAnalyticsStateInternal(ctx);
  const window = aState.turnToolSequence.slice(-50);
  assert.ok(
    aState.lastAddictionCheck >= 1,
    "analytics addiction check actually ran (throttle advanced)",
  );
  assert.ok(window.length >= 10, "analytics window crossed the addiction gate (>=10 tool-turns)");
  assert.ok(
    window.every((t) => t === "grep"),
    "analytics window is 100% grep (dominance > 80%, toolN == 1) — would have warned pre-fold",
  );
  for (const s of pi.sent) {
    assert.equal(
      s.params.customType,
      "enforcement",
      "no [analytics] addiction whisper or turn-outcome loop whisper survived the fold",
    );
  }
});

// ── Scenario 2: the same episode continues -> still exactly ONE whisper ────
await test("continuing the same stuck-loop does not re-emit (per-episode single delivery)", async () => {
  freshWorld();
  const pi = makePi();
  analyticsExtension(pi);
  turnOutcomeExtension(pi);
  const ctx = { cwd: "/tmp/loop-emitter-continued" };

  for (let turn = 0; turn < 8; turn++) {
    await callTool(pi, ctx, "grep", STUCK_GREP);
    await callTool(pi, ctx, "grep", STUCK_GREP);
    await endTurn(pi, ctx, ["grep", "grep"]);
  }
  assert.equal(pi.sent.length, 1, "first episode: one whisper");

  // 4 more turns of the same stuck loop (inside the 8-turn cooldown)
  for (let turn = 8; turn < 12; turn++) {
    await callTool(pi, ctx, "grep", STUCK_GREP);
    await callTool(pi, ctx, "grep", STUCK_GREP);
    await endTurn(pi, ctx, ["grep", "grep"]);
  }

  assert.equal(
    pi.sent.length,
    1,
    "the same stuck-loop episode must stay at exactly one whisper (no multi-whisper re-emission)",
  );
  assert.equal(
    pi.sent[0].options.triggerTurn,
    false,
    "the single delivered signal remains a no-wake advisory",
  );
});

// ── Scenario 3: a NEW stuck-loop re-fires the surviving detector once ──────
await test("a genuinely new stuck-loop re-fires the surviving detector exactly once", async () => {
  freshWorld();
  const pi = makePi();
  analyticsExtension(pi);
  turnOutcomeExtension(pi);
  const ctx = { cwd: "/tmp/loop-emitter-again" };

  // Episode 1: 16 consecutive grep
  for (let turn = 0; turn < 8; turn++) {
    await callTool(pi, ctx, "grep", STUCK_GREP);
    await callTool(pi, ctx, "grep", STUCK_GREP);
    await endTurn(pi, ctx, ["grep", "grep"]);
  }
  assert.equal(pi.sent.length, 1, "episode 1: exactly one whisper");

  // Break the loop for 9 turns (non-grep work; elapses the 8-turn cooldown)
  for (let turn = 0; turn < 9; turn++) {
    await callTool(pi, ctx, "bash", { command: `git status --short # turn ${turn}` });
    await callTool(pi, ctx, "read", { path: `/tmp/wt-break-${turn}.txt` });
    await endTurn(pi, ctx, ["bash", "read"]);
  }

  // Episode 2: 16 consecutive grep again
  for (let turn = 0; turn < 8; turn++) {
    await callTool(pi, ctx, "grep", STUCK_GREP);
    await callTool(pi, ctx, "grep", STUCK_GREP);
    await endTurn(pi, ctx, ["grep", "grep"]);
  }

  assert.equal(
    pi.sent.length,
    2,
    "two distinct episodes => exactly one whisper each from the surviving detector",
  );
  assert.equal(
    pi.sent[1].params.customType,
    "enforcement",
    "second episode signal is still enforcement",
  );
  const loopWhisper = pi.sent.find((m) =>
    (m.params.content ?? []).some((c) => /Tool loop detected/.test(c.text ?? "")),
  );
  assert.ok(loopWhisper, "second episode delivers the enforcement tool-loop whisper");
  assert.equal(loopWhisper.options.triggerTurn, false, "each loop signal stays a no-wake advisory");
});

// ── Scenario 4: intentional use suppresses the loop verdict ────────────────
// Regression test for gap A: the surviving detector had NO intentional-use
// filter, so 16+ same-tool calls with an occasional think/verify still
// false-positived. Now a metacognitive tool anywhere in the window = NOT a loop.
await test("intentional-use inside the window suppresses the loop whisper entirely", async () => {
  freshWorld();
  const pi = makePi();
  analyticsExtension(pi);
  turnOutcomeExtension(pi);
  const ctx = { cwd: "/tmp/intentional-use" };

  // Turn 0 opens with a `think` (metacognitive engagement), then 16 greps run
  // across 8 turns. The tail is STILL 16 consecutive greps — before the filter
  // the
  // authoritative detector fired a loop whisper here (the exact false-positive
  // class the threshold raise targeted).
  await callTool(pi, ctx, "think", { type: "reflect", decision: "re-evaluate the grep target" });
  for (let turn = 0; turn < 8; turn++) {
    await callTool(pi, ctx, "grep", STUCK_GREP);
    await callTool(pi, ctx, "grep", STUCK_GREP);
    await endTurn(pi, ctx, ["grep", "grep"]);
  }

  // The loop state still holds 16 consecutive greps + the think in-window...
  const ls = getToolLoopState(ctx);
  assert.ok(
    ls.history.filter((c) => c.tool === "grep").length >= TOOL_LOOP_THRESHOLD,
    "history recorded 16+ consecutive greps (the fixture genuinely reached the threshold)",
  );
  assert.ok(
    ls.history.some((c) => c.tool === "think"),
    "think is inside the window",
  );
  // ...but the authoritative detector refuses to call it a loop.
  const verdict = detectToolLoop(ls);
  assert.equal(
    verdict.isLoop,
    false,
    "detectToolLoop returns NOT-a-loop when an intentional tool is in the window",
  );
  // Same for the stateless dreamer path on the mirrored sequence.
  const seqVerdict = detectToolLoopFromSequence(ls.history);
  assert.equal(
    seqVerdict.isLoop,
    false,
    "detectToolLoopFromSequence returns NOT-a-loop with an intentional tool in the window",
  );
  // And the full 4-emitter turn-end pipeline delivers ZERO whispers.
  assert.equal(
    pi.sent.length,
    0,
    "zero whispers delivered (intentional use suppresses the loop verdict end-to-end)",
  );
});

// ── Scenario 5: dreamer loop-path whisper folded ──────────────────────────
// The dreamer is the 4th, still-live loop emitter. Fold proof: on a 16-grep
// stuck loop it DETECTS the loop (recordAdvice — kept observationally) but
// delivers ZERO; the single delivery is the enforcement one, no wake.
await test("dreamer loop-path whisper is folded: exactly ONE enforcement delivery, dreamer detects but stays silent", async () => {
  freshWorld();
  const pi = makePi();
  analyticsExtension(pi);
  turnOutcomeExtension(pi);
  const ctx = { cwd: "/tmp/dreamer-fold" };

  // 16 consecutive greps drive path 1 in BOTH the enforcement detector and the
  // dreamer (detectToolLoopFromSequence on gs.toolLog).
  for (let turn = 0; turn < 8; turn++) {
    await callTool(pi, ctx, "grep", STUCK_GREP);
    await callTool(pi, ctx, "grep", STUCK_GREP);
    await endTurn(pi, ctx, ["grep", "grep"]);
  }

  // Fold keeps the observation: the dreamer DETECTED the loop and recorded
  // advice for accuracy tracking — that proves path 1 ran on the same episode.
  const pending = getPendingAdvice();
  assert.ok(
    pending.some((r) => r.source === "dreamer" && r.prediction === "stuck"),
    "dreamer detected the loop and recorded advice (recordAdvice is kept by the fold)",
  );

  // ...but its whisper is folded: exactly ONE delivery, the enforcement one.
  assert.equal(pi.sent.length, 1, `exactly one delivered whisper, got ${pi.sent.length}`);
  const only = pi.sent[0];
  assert.equal(
    only.params.customType,
    "enforcement",
    "the single signal is the enforcement loop signal",
  );
  assert.match(
    whisperText(only),
    /Tool loop detected/,
    "body is the enforcement tool-loop message",
  );
  assert.equal(only.options.triggerTurn, false, "no wake (triggerTurn:false)");
  assert.equal(
    pi.sent.filter((s) => s.params.customType === "context").length,
    0,
    'no dreamer whisper survived the fold (no customType "context" from source "enforcement/dreamer")',
  );
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
