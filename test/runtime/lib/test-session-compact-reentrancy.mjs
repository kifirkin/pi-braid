/**
 * Regression test: post-compaction "Maximum call stack size exceeded"
 *
 * HISTORY (2026-06-29):
 *   A live trace showed two `Maximum call stack size exceeded` errors
 *   right after the [compaction] summary, followed 180s later by a third
 *   stack overflow when the agent manually called the scratchpad tool.
 *   See scratchpad for the full analysis and links to the affected files.
 *
 * ROOT CAUSE:
 *   The enforcement `session_compact` handler synchronously called
 *   `callScratchpadTool(ctx, {action: "read"})` followed by two
 *   `sendEnforcementWhisper(...)` calls. The scratchpad tool wrapper
 *   in pi-core fires `tool_call` / `tool_execution_end` synchronously,
 *   and the timer extension's `tool_execution_end` handler invokes
 *   `fireExpired()` which can synchronously call `pi.sendMessage` with
 *   `triggerTurn: true` for any timer that expired at the same moment.
 *   That synchronous chain can re-enter the handler (or other handlers)
 *   and overflow the V8 stack before the existing MAX_REENTRY_DEPTH=1
 *   guard in `injection-tracker.ts` gets a chance to defer.
 *
 * FIX (2026-06-29, 3 layers):
 *   1. Per-session `inHandler` re-entrancy guard
 *   2. The scratchpad read + whisper delivery side-effects are deferred
 *      via `setTimeout(0)` so the handler returns synchronously.
 *   3. State writes (lastCompactionTurn, etc.) stay synchronous.
 *   + MAX_REENTRY_DEPTH=1 with setTimeout(0) (microtasks don't break the
 *     call stack; setTimeout creates a macrotask boundary).
 *
 * ARCHITECTURE CLARIFICATION (2026-07-13):
 *   The re-orientation whisper is delivered on `session_compact`, NOT
 *   `compaction_end`. Pi-core's `session_compact` event is dispatched
 *   to extension handlers via `_extensionRunner.emit()`. The
 *   `compaction_end` event is emitted via `this._emit()` which only
 *   reaches internal listeners (TUI) — NOT extension handlers.
 *
 *   The whisper uses `triggerTurn: true` so the agent wakes up and
 *   continues its loop automatically. It fires during compaction
 *   (after LLM summarization, before bookkeeping/TUI rebuild), which
 *   is functionally equivalent to "after compaction completes" from
 *   the agent's perspective.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Import the compiled handler.
const { registerSessionCompactHandler } = await import(
  "../../../dist/extensions/enforcement/handlers/register-session-compact.js"
);

// Import getState for state assertions.
const { getState, createState } = await import(
  "../../../dist/extensions/enforcement/state.js"
);

// Import the turn-dedup reset helper.
const { _resetForTests: resetDedup, beginTurn } = await import(
  "../../../dist/lib/enforcement/turn-dedup.js"
);

// ── Test helpers ──────────────────────────────────────────────────────────

function makeFakePi() {
  const handlers = new Map();
  const sent = [];

  return {
    handlers,
    sent,
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    sendMessage: (params, options) => {
      sent.push({ params, options });
    },
  };
}

function makeFakeCtx(sessionId, { learnings = [] } = {}) {
  const calls = { scratchpad: 0 };

  return {
    sessionManager: {
      getSessionFile: () => `/tmp/sessions/${sessionId}.jsonl`,
      getSessionId: () => sessionId,
    },
    tools: {
      scratchpad: async (params) => {
        calls.scratchpad++;
        return {
          content: [{ type: "text", text: `Goal: test (action=${params.action})` }],
          details: {
            key_learnings: learnings,
            plan: [],
          },
        };
      },
    },
    calls,
  };
}

function makeFakeState() {
  return {
    enforcementActive: true,
    currentTurn: 1,
    contextNudgeSent: false,
    lastContextCheckTurn: 0,
    lastCompactionTurn: 0,
    lastScratchpadNudgeTurn: 0,
    overflowRecently: 0,
    hasCodeChanges: false,
    lastCodeChangeTurn: 0,
    memoryNudgeSent: false,
    turnsSinceMemory: 0,
    conversationEvents: [],
    turnHistory: new Map(),
    toolChain: { lastThinkCall: 0, lastPlanCall: 0 },
    consecutiveErrorTurns: 0,
    uniqueToolsUsed: new Set(),
    originalRequest: "",
    lastUserMessage: "",
    lastFinalizeNudge: -100,
    lastVerifyNudge: -100,
    lastThinkPerTurnNudge: -100,
    lastPhaseNudgeTurn: -100,
    contextCheckInterval: 5,
    lastVerificationJudgeTurn: 0,
    lastJudgeTime: 0,
    verificationJudgeRunning: false,
    pendingFinalize: false,
    validationFailures: 0,
    lastInvestigationToolTurn: 0,
    consecutiveInvestigationTurns: 0,
    taskComplexity: "moderate",
    localizationRisk: "",
    toolsSinceLastPlan: 0,
    nudgeSuppressedCount: 0,
    pendingConflictIds: [],
    conflictDetectionTurn: new Map(),
  };
}

function attachState(ctx, state) {
  ctx.__enforcementState = state;
}

async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// Wait for setTimeout(0) macrotasks to fire. The session_compact handler
// now defers side-effects via setTimeout(0) (not queueMicrotask) to break
// the synchronous call stack. We need to wait for the macrotask queue.
async function flushMacrotasks(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Also flush any microtasks that the macrotask may have scheduled
  await flushMicrotasks();
}

// ── Tests: session_compact handler ─────────────────────────────────────────

describe("session_compact handler", () => {
  let pi;
  let handler;

  beforeEach(() => {
    resetDedup();
    beginTurn();
    pi = makeFakePi();
    registerSessionCompactHandler(pi);
    handler = pi.handlers.get("session_compact");
    assert.ok(handler, "handler must be registered on pi.on('session_compact')");
  });

  it("FIX: synchronous body is fast - no scratchpad or whisper calls during execution", async () => {
    const ctx = makeFakeCtx("test-sync-body");
    attachState(ctx, makeFakeState());

    // Synchronously call the handler without awaiting yet.
    const handlerPromise = handler({ reason: "threshold" }, ctx);

    // During the handler's synchronous body, nothing should have happened.
    assert.equal(
      ctx.calls.scratchpad,
      0,
      "scratchpad must NOT be called during the handler's synchronous body",
    );
    assert.equal(
      pi.sent.length,
      0,
      "no whispers must fire during the handler's synchronous body",
    );

    // Await the handler. The queueMicrotask fires during the microtask
    // checkpoint that processes the resolved promise. The deferred work
    // (callScratchpadTool) runs within that microtask, so by the time
    // await returns, the scratchpad has been called but the async
    // whisper delivery has not completed yet.
    await handlerPromise;

    // The scratchpad was called (microtask fired), but the deferred
    // async work (the IIFE inside queueMicrotask) is still pending.
    // We need to flush microtasks to complete it.
    await flushMacrotasks();

    // Now the deferred whisper should have fired.
    assert.equal(pi.sent.length, 1, "re-orient whisper must fire from deferred microtask");
    assert.equal(pi.sent[0].options.triggerTurn, true, "re-orient whisper must have triggerTurn: true");
  });

  it("FIX: re-entrancy guard is per-session (two sessions can run independently)", async () => {
    const ctxA = makeFakeCtx("session-A");
    attachState(ctxA, makeFakeState());
    const ctxB = makeFakeCtx("session-B");
    attachState(ctxB, makeFakeState());

    const promiseA = handler({ reason: "threshold" }, ctxA);
    const promiseB = handler({ reason: "threshold" }, ctxB);

    await promiseA;
    await promiseB;
    await flushMacrotasks();

    // Both should complete without errors.
    assert.equal(pi.sent.length, 2, "both sessions should fire their re-orient whispers");
  });

  it("FIX: handler sends re-orient whisper with triggerTurn: true", async () => {
    const ctx = makeFakeCtx("test-reorient-wake");
    attachState(ctx, makeFakeState());

    await handler({ reason: "threshold" }, ctx);
    await flushMacrotasks();

    // With empty learnings, exactly one whisper (the re-orient) fires.
    assert.equal(pi.sent.length, 1, "exactly one whisper (re-orient) must fire");
    assert.equal(
      pi.sent[0].options.triggerTurn,
      true,
      "re-orient whisper must have triggerTurn: true to wake the agent",
    );
    assert.equal(pi.sent[0].params.customType, "enforcement");
  });

  it("FIX: handler sends unpersisted learnings whisper + re-orient whisper", async () => {
    const ctx = makeFakeCtx("test-with-learnings", {
      learnings: [
        { content: "test learning 1", category: "pattern", persisted: false },
        { content: "test learning 2", category: "fix", persisted: false },
      ],
    });
    attachState(ctx, makeFakeState());

    await handler({ reason: "threshold" }, ctx);
    await flushMacrotasks();

    assert.equal(pi.sent.length, 2, "two whispers fire when unpersisted learnings exist");
    // First whisper: unpersisted learnings (no triggerTurn override → defaults to false)
    assert.equal(pi.sent[0].options.triggerTurn, false, "unpersisted learnings whisper does NOT wake agent");
    // Second whisper: re-orient (triggerTurn: true)
    assert.equal(pi.sent[1].options.triggerTurn, true, "re-orient whisper wakes agent");
  });

  it("FIX: deferred scratchpad failures are caught and logged, soft fallback", async () => {
    const ctx = makeFakeCtx("test-fail-soft");
    attachState(ctx, makeFakeState());
    ctx.tools.scratchpad = async () => {
      ctx.calls.scratchpad++;
      throw new Error("simulated scratchpad failure");
    };

    // Must not throw.
    await handler({ reason: "threshold" }, ctx);
    await flushMacrotasks();

    assert.equal(ctx.calls.scratchpad, 1, "scratchpad was attempted");
    // callScratchpadTool's internal catch returns undefined, so the
    // handler proceeds to the re-orient whisper. Exactly 1 whisper fires.
    assert.equal(
      pi.sent.length,
      1,
      "re-orient whisper must still fire even if scratchpad read fails",
    );
    assert.equal(pi.sent[0].options.triggerTurn, true, "re-orient whisper must still wake agent");
  });

  it("FIX: state resets happen synchronously during handler execution", async () => {
    const ctx = makeFakeCtx("test-state-resets");
    await handler({ reason: "threshold" }, ctx);

    // State resets are synchronous - applied before the handler returns.
    // Verify by checking that getState(ctx) returns a valid state object
    // and the resets ran without error (no throws).
    const state = getState(ctx);
    assert.ok(state, "getState(ctx) must return a valid state object");
    // lastCompactionTurn is set to currentTurn (0 from createState)
    assert.equal(state.lastCompactionTurn, 0, "lastCompactionTurn must be set");
    assert.equal(typeof state.contextNudgeSent, "boolean", "state must be initialized");
  });
});

// ── Source-level assertions: pin the design invariants ─────────────────────

describe("session_compact handler source invariants", () => {
  it("FIX: only session_compact handler registered, no compaction_end handler", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "src",
        "extensions",
        "enforcement",
        "handlers",
        "register-session-compact.ts",
      ),
      "utf-8",
    );

    // Only session_compact handler should be registered.
    const sessionCompactStart = src.indexOf('onEvent(pi, "session_compact"');
    const compactionEndStart = src.indexOf('onEvent(pi, "compaction_end"');
    assert.ok(sessionCompactStart !== -1, "session_compact handler must exist");
    assert.ok(
      compactionEndStart === -1,
      "compaction_end handler must NOT be registered (event doesn't reach extensions)",
    );

    // The handler body should have setTimeout for deferred side-effects
    assert.ok(
      src.includes("setTimeout("),
      "session_compact handler must use setTimeout(0) to defer side-effects",
    );
    // callScratchpadTool must be inside the setTimeout
    const setTimeoutStart = src.indexOf("setTimeout(() => {");
    const scratchpadCall = src.indexOf("callScratchpadTool(ctx");
    assert.ok(
      setTimeoutStart !== -1 && scratchpadCall !== -1 && scratchpadCall > setTimeoutStart,
      "callScratchpadTool must be inside the deferred setTimeout, not synchronous",
    );

    // The re-entrancy guard must be present.
    assert.ok(
      /reentrancy\.inHandler\s*=\s*true/.test(src),
      "handler must set the inHandler flag before scheduling work",
    );
    assert.ok(
      /reentrancy\.inHandler\s*=\s*false/.test(src),
      "handler must clear the inHandler flag in finally{}",
    );

    // State resets must be present.
    assert.ok(
      src.includes("contextNudgeSent"),
      "handler must reset state synchronously",
    );
  });

  it("FIX: MAX_REENTRY_DEPTH is 1 with setTimeout(0) for stack safety", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "src",
        "lib",
        "utils",
        "injection-tracker.ts",
      ),
      "utf-8",
    );

    assert.ok(
      /const MAX_REENTRY_DEPTH\s*=\s*1\b/.test(src),
      "MAX_REENTRY_DEPTH must be 1 (first send synchronous, re-entrant deferred)",
    );
    assert.ok(
      !/const MAX_REENTRY_DEPTH\s*=\s*3\b/.test(src),
      "MAX_REENTRY_DEPTH must NOT be 3 (was too permissive, stack overflowed)",
    );
    assert.ok(
      src.includes("setTimeout("),
      "re-entry guard must use setTimeout(0) not queueMicrotask",
    );
  });
});