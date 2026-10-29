/**
 * Regression test: triggerTurn:true whispers must actually wake the agent.
 *
 * HISTORY:
 * After an agent-initiated mid-turn compaction (context_compress tool),
 * the agent stopped and needed a manual nudge. Root cause chain:
 *
 * 1. context_compress schedules ctx.compact() with autoResumeAfterCompaction=true.
 * 2. pi-core's manual compact() (agent-session.js:1367) calls
 * _disconnectFromAgent() + abort(), killing the agent loop, and NEVER
 * calls agent.continue()/prompt() (unlike _runAutoCompaction, which only
 * auto-continues on willRetry or queued messages).
 * 3. The 3-minute fallback resume timer was removed based on
 * the (auto-path-only) assumption that pi-core auto-continues.
 * 4. The replacement resume — register-session-compact.ts re-orientation
 * whisper with { triggerTurn: true } — was silently defeated:
 * sendEnforcementWhisper defaulted deliverAs to "nextTurn", and
 * pi-core's sendCustomMessage routes deliverAs === "nextTurn"to
 * _pendingNextTurnMessages BEFORE evaluating triggerTurn
 * (agent-session.js:1075-1086). The wake was queued for a user prompt
 * that never came; the post-compaction loop stayed dead.
 *
 * FIX: sendEnforcementWhisper only applies the "nextTurn"default when
 * triggerTurn is not explicitly requested. triggerTurn:true now falls
 * through to pi-core's agent.prompt() branch (the same wake path the
 * timer extension uses).
 *
 * These tests pin the options that reach pi.sendMessage: a triggerTurn:true
 * whisper must NOT carry deliverAs:"nextTurn", and the default-only cases
 * deliver as the live class (steer while a run streams; appended when idle -
 * no wake, no loop risk). The live shape omits triggerTurn because pi 0.84.2
 * made `triggerTurn: false` park to the end-of-turn flush (branch 4).
 *
 * NOTE: depends on braid.suppressNudges not being true in settings.json
 * (sendTrackedMessage bails when cognitive nudges are disabled globally).
 *
 * Run: node test/runtime/lib/test-whisper-trigger-turn.mjs
 */

import { strict as assert } from "node:assert";
import { assertExactlyOne, waitForDelivery } from "./deferred-delivery.mjs";
// Compiled runtime (npm test builds first).
const { sendEnforcementWhisper } = await import("../../../dist/extensions/enforcement/whisper.js");
const { registerSessionCompactHandler } =
  await import("../../../dist/extensions/enforcement/handlers/register-session-compact.js");
const { getState } = await import("../../../dist/extensions/enforcement/state.js");
const { _resetForTests } = await import("../../../dist/lib/enforcement/turn-dedup.js");
const { clearAllBuckets } = await import("../../../dist/lib/utils/injection-tracker.js");

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

console.log("=== triggerTurn:true whisper must wake (not nextTurn-queue) ===\n");

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeFakePi() {
  const sent = [];
  return {
    handlers: new Map(),
    sent,
    on(event, handler) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    },
    sendMessage(params, options) {
      sent.push({ params, options });
    },
    sendUserMessage() {},
    _emit(event, ...args) {
      const list = this.handlers.get(event) ?? [];
      for (const h of list) {
        Promise.resolve(h(...args)).catch(() => {});
      }
    },
  };
}

function makeFakeCtx() {
  const sessionId = "whisper-tt-" + Math.random().toString(36).slice(2, 8);
  const ctx = {
    cwd: "/tmp/test-cwd",
    mode: "test",
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
    },
    modelRegistry: {
      find: () => undefined,
      getAll: () => [],
      getApiKeyForProvider: async () => "",
      getAvailable: () => [],
    },
    ui: { notify: () => {}, setStatus: () => {} },
  };
  // Pre-create session-scoped enforcement state (enforcementActive defaults true).
  getState(ctx);
  return ctx;
}

// ── Unit: sendEnforcementWhisper option derivation (the fix) ────────────────

await test("triggerTurn:true must NOT carry deliverAs 'nextTurn' (would queue, not wake)", async () => {
  _resetForTests();
  clearAllBuckets();
  const pi = makeFakePi();
  const ctx = makeFakeCtx();

  sendEnforcementWhisper(pi, ctx, "Context compacted — re-orient and continue.", false, {
    triggerTurn: true,
  });
  await waitForDelivery(pi.sent);

  assertExactlyOne(pi.sent, { what: "whisper" });
  const { options } = pi.sent[0];
  assert.equal(options.triggerTurn, true, "triggerTurn must survive to pi.sendMessage");
  assert.notEqual(
    options.deliverAs,
    "nextTurn",
    "deliverAs must NOT be nextTurn when triggerTurn:true — pi-core routes nextTurn before triggerTurn and never wakes",
  );
});

await test("no options → live class (steer while streaming, append when idle)", async () => {
  _resetForTests();
  clearAllBuckets();
  const pi = makeFakePi();
  const ctx = makeFakeCtx();

  sendEnforcementWhisper(pi, ctx, "advisory");
  await waitForDelivery(pi.sent);

  assertExactlyOne(pi.sent, { what: "whisper" });
  assert.equal(pi.sent[0].options.deliverAs, "steer", "default delivery is steer");
  assert.equal(
    pi.sent[0].options.triggerTurn,
    undefined,
    "live shape omits triggerTurn - pi 0.84.2 parks `triggerTurn: false` (branch 4)",
  );
});

await test("triggerTurn:false → default is deliverAs:'steer'", async () => {
  _resetForTests();
  clearAllBuckets();
  const pi = makeFakePi();
  const ctx = makeFakeCtx();

  sendEnforcementWhisper(pi, ctx, "advisory", false, { triggerTurn: false });
  await waitForDelivery(pi.sent);

  assertExactlyOne(pi.sent, { what: "whisper" });
  assert.equal(pi.sent[0].options.deliverAs, "steer");
});

await test("explicit deliverAs is respected when triggerTurn:true (steer preserved)", async () => {
  _resetForTests();
  clearAllBuckets();
  const pi = makeFakePi();
  const ctx = makeFakeCtx();

  sendEnforcementWhisper(pi, ctx, "steer me", false, {
    triggerTurn: true,
    deliverAs: "steer",
  });
  await waitForDelivery(pi.sent);

  assertExactlyOne(pi.sent, { what: "whisper" });
  assert.equal(pi.sent[0].options.deliverAs, "steer", "explicit deliverAs wins");
  assert.equal(pi.sent[0].options.triggerTurn, true);
});

// ── Integration: post-compaction auto-resume chain (the reported bug) ───────

await test("agent-initiated compaction → session_compact handler sends a REAL wake (triggerTurn survives)", async () => {
  _resetForTests();
  clearAllBuckets();
  const ctx = makeFakeCtx();
  const pi = makeFakePi();

  // Simulate context_compress tool: sets the one-shot resume flag, then
  // pi-core manual compact() emits session_compact (reason=manual,
  // willRetry=false, both present in installed pi-core v0.83.0).
  getState(ctx).autoResumeAfterCompaction = true;

  registerSessionCompactHandler(pi);
  pi._emit(
    "session_compact",
    {
      type: "session_compact",
      reason: "manual",
      willRetry: false,
      compactionEntry: { id: "c1", summary: "test" },
      fromExtension: false,
    },
    ctx,
  );

  // Handler defers (scratchpad read + whisper via setTimeout(0); the whisper
  // defers again inside sendTrackedMessage because triggerTurn is set).
  await waitForDelivery(pi.sent);

  assertExactlyOne(pi.sent, { what: "re-orientation whisper" });
  const wake = pi.sent.find((m) =>
    (m.params.content ?? []).some((c) => /Context compacted/.test(c.text ?? "")),
  );
  assert.ok(wake, "re-orientation whisper must reach pi.sendMessage on agent-initiated compaction");
  assert.equal(wake.options.triggerTurn, true, "auto-resume whisper must carry triggerTurn:true");
  assert.notEqual(
    wake.options.deliverAs,
    "nextTurn",
    "auto-resume whisper must NOT be routed to the nextTurn queue — that is the post-compaction loop stop",
  );
  // One-shot flag: consumed by the handler.
  assert.equal(getState(ctx).autoResumeAfterCompaction, false, "flag is one-shot");
});

// ── Natural stop vs mid-work re-orientation delivery ───────────────
// dispatchTurnEndLoop records lastTurnWasNaturalStop (assistant final response,
// stopReason "stop", no tool calls) on turn_end and handler-registry clears it
// on turn_start. The session_compact re-orientation whisper reads it: a natural
// stop must NOT be forced into a fresh turn by compaction (that is the noise
// the user flagged) — it gets an ADVISORY triggerTurn:false whisper (defaults
// to steer; falls through to a silent push when idle); a mid-work turn keeps triggerTurn:true so
// compaction hands the aborted loop back. State is fabricated via getState(ctx)
// exactly as the fixture already stubs autoResumeAfterCompaction above.

await test("natural stop before compaction → re-orientation is advisory (triggerTurn:false, nextTurn)", async () => {
  _resetForTests();
  clearAllBuckets();
  const ctx = makeFakeCtx();
  const pi = makeFakePi();

  // Agent finished on its own (assistant + stopReason "stop" + no tool calls):
  // turn_end set lastTurnWasNaturalStop=true. Auto-compaction (threshold) fires
  // afterwards → shouldAutoResume is true, but the loop is already at rest.
  getState(ctx).lastTurnWasNaturalStop = true;

  registerSessionCompactHandler(pi);
  pi._emit(
    "session_compact",
    {
      type: "session_compact",
      reason: "threshold",
      willRetry: false,
      compactionEntry: { id: "c-natural", summary: "test" },
      fromExtension: false,
    },
    ctx,
  );

  await waitForDelivery(pi.sent);

  assertExactlyOne(pi.sent, { what: "re-orientation whisper" });
  const advisory = pi.sent.find((m) =>
    (m.params.content ?? []).some((c) => /Context compacted/.test(c.text ?? "")),
  );
  assert.ok(
    advisory,
    "re-orientation whisper must reach pi.sendMessage after a natural stop + compaction",
  );
  assert.equal(
    advisory.options.triggerTurn,
    false,
    "natural stop must downgrade the post-compaction wake to advisory triggerTurn:false",
  );
  assert.equal(
    advisory.options.deliverAs,
    "steer",
    "natural-stop advisory defaults to steer (idle → silent push — no forced turn)",
  );
});

await test("mid-work turn before compaction → re-orientation keeps the wake (triggerTurn:true)", async () => {
  _resetForTests();
  clearAllBuckets();
  const ctx = makeFakeCtx();
  const pi = makeFakePi();

  // Agent was mid-work (tool calls / non-stop stopReason) → turn_end left
  // lastTurnWasNaturalStop=false. Auto-compaction (threshold) aborted the loop;
  // it must be handed back to the agent.
  getState(ctx).lastTurnWasNaturalStop = false;

  registerSessionCompactHandler(pi);
  pi._emit(
    "session_compact",
    {
      type: "session_compact",
      reason: "threshold",
      willRetry: false,
      compactionEntry: { id: "c-midwork", summary: "test" },
      fromExtension: false,
    },
    ctx,
  );

  await waitForDelivery(pi.sent);

  assertExactlyOne(pi.sent, { what: "re-orientation whisper" });
  const wake = pi.sent.find((m) =>
    (m.params.content ?? []).some((c) => /Context compacted/.test(c.text ?? "")),
  );
  assert.ok(wake, "re-orientation whisper must reach pi.sendMessage after a mid-work compaction");
  assert.equal(
    wake.options.triggerTurn,
    true,
    "mid-work compaction must wake the agent: triggerTurn:true",
  );
  assert.notEqual(
    wake.options.deliverAs,
    "nextTurn",
    "mid-work wake must NOT be routed to the nextTurn queue — the loop was aborted and must be handed back",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
