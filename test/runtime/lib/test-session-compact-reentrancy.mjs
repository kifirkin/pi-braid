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
 *   1. Per-session `inHandler` re-entrancy guard in
 *      `enforcement/handlers/register-session-compact.ts` (mirrors the
 *      `inBeforeAgentStart` pattern from context-lifecycle).
 *   2. The scratchpad read + whisper delivery side-effects are deferred
 *      via `queueMicrotask` so the handler returns synchronously. This
 *      is the KEY fix -- by the time pi-core's synchronous event chain
 *      (TOOL_EXECUTION_END -> fireExpired -> pi.sendMessage) wants to fire,
 *      we have already returned and the call stack is short.
 *   3. State writes (lastCompactionTurn, etc.) stay synchronous because
 *      downstream handlers (turn_end, message_end) read them on the
 *      same tick.
 *   + Bumped MAX_REENTRY_DEPTH from 1 to 3 in injection-tracker.ts.
 *
 * ARCHITECTURE CHANGE (2026-07-13):
 *   The re-orientation whisper was moved from `session_compact` to
 *   `compaction_end` so it arrives AFTER compaction fully completes
 *   (not during). The whisper uses `triggerTurn: true` so the agent
 *   actually wakes up and continues its loop automatically.
 *
 *   - `session_compact` handler: state resets only (synchronous, no whispers)
 *   - `compaction_end` handler: scratchpad read + whisper delivery
 *     (deferred via queueMicrotask, with triggerTurn: true)
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Import the compiled handler. We mock the deps it pulls in via the
// imported module's closure (the test injects a fake pi + ctx).
const { registerSessionCompactHandler } = await import(
  "../../../dist/extensions/enforcement/handlers/register-session-compact.js"
);

// Import the turn-dedup reset helper -- the whisper flood cap is
// process-global state. Without resetting between tests, the cap from
// previous tests in the same process suppresses our whispers.
const { _resetForTests: resetDedup, beginTurn } = await import(
  "../../../dist/lib/enforcement/turn-dedup.js"
);

// ── Test helpers ──────────────────────────────────────────────────────────

/**
 * Build a fake pi object with the minimum surface area the handler uses.
 * Captures both session_compact and compaction_end handlers so tests can
 * call them directly.
 */
function makeFakePi() {
  const handlers = new Map();
  const eventHandlers = new Map();
  const sent = [];

  return {
    handlers,
    sent,
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    events: {
      on: (event, handler) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, []);
        eventHandlers.get(event).push(handler);
      },
      emit: (event, payload) => {
        const list = eventHandlers.get(event) ?? [];
        for (const h of list) h(payload);
      },
    },
    sendMessage: (params, options) => {
      sent.push({ params, options });
    },
  };
}

/**
 * Build a fake ctx with a synchronous scratchpad tool. The scratchpad
 * tool just returns a stub result immediately so we don't have to
 * manage async timing in the test.
 *
 * `learnings` defaults to []; pass `[{ content, category, persisted }, ...]`
 * to exercise the unpersisted-learnings branch.
 */
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

/**
 * Build a fake enforcement state object for the handler.
 * getState(ctx) must return this object.
 */
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

/**
 * Attach a fake getState to the context so the handler can find enforcement state.
 */
function attachState(ctx, state) {
  ctx.__enforcementState = state;
}

/**
 * Yield to the microtask queue. Each round drains one microtask. Use
 * multiple rounds to allow chained async continuations to fully resolve.
 */
async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// ── Layer 1 tests: re-entrancy guard + state resets (session_compact) ──────

describe("session_compact handler (state resets only)", () => {
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

  it("FIX: handler body is synchronous - no scratchpad or whisper calls during execution", async () => {
    // The crucial property: when session_compact fires, the handler's
    // synchronous body must NOT call ctx.tools.scratchpad or send whispers.
    // Those side-effects are now handled by the compaction_end handler.
    const ctx = makeFakeCtx("test-sync-body");
    attachState(ctx, makeFakeState());

    // Synchronously call the handler.
    const handlerPromise = handler({}, ctx);

    // Before yielding to microtasks, nothing should have happened.
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

    await handlerPromise;
    await flushMicrotasks();

    // Even after microtasks drain, no whispers or scratchpad calls should
    // happen from the session_compact handler - they're on compaction_end now.
    assert.equal(
      ctx.calls.scratchpad,
      0,
      "scratchpad must NOT be called from session_compact handler (moved to compaction_end)",
    );
    assert.equal(
      pi.sent.length,
      0,
      "no whispers must fire from session_compact handler (moved to compaction_end)",
    );
  });

  it("FIX: re-entrancy guard is per-session (two sessions can run independently)", async () => {
    // The guard is keyed on sessionManager.getSessionFile() via
    // getExtensionState. Two sessions with different sessionManagers
    // must each have their own flag.
    const ctxA = makeFakeCtx("session-A");
    attachState(ctxA, makeFakeState());
    const ctxB = makeFakeCtx("session-B");
    attachState(ctxB, makeFakeState());

    const promiseA = handler({}, ctxA);
    // Immediately start session B without awaiting A.
    const promiseB = handler({}, ctxB);

    await promiseA;
    await promiseB;
    await flushMicrotasks();

    // Both should complete without errors and without whispers.
    assert.equal(
      pi.sent.length,
      0,
      "no whispers from session_compact handler for either session",
    );
  });
});

// ── Layer 2 tests: compaction_end handler (whisper delivery) ───────────────

describe("compaction_end handler (whisper delivery with triggerTurn: true)", () => {
  let pi;
  let handler;

  beforeEach(() => {
    resetDedup();
    beginTurn();
    pi = makeFakePi();
    registerSessionCompactHandler(pi);
    handler = pi.handlers.get("compaction_end");
    assert.ok(handler, "handler must be registered on pi.on('compaction_end')");
  });

  it("FIX: handler sends re-orient whisper with triggerTurn: true", async () => {
    const ctx = makeFakeCtx("test-reorient-wake");
    attachState(ctx, makeFakeState());

    // Simulate a successful compaction event
    const event = { result: { status: "success" } };
    await handler(event, ctx);
    await flushMicrotasks();

    // With empty learnings, exactly one whisper (the re-orient) fires.
    assert.equal(pi.sent.length, 1, "exactly one whisper (re-orient) must fire");
    assert.equal(
      pi.sent[0].options.triggerTurn,
      true,
      "re-orient whisper must have triggerTurn: true to wake the agent",
    );
    // Must be delivered as a steer (not a user message).
    assert.equal(pi.sent[0].params.customType, "enforcement");
  });

  it("FIX: handler sends NO whisper on failed compaction (event.result is falsy)", async () => {
    const ctx = makeFakeCtx("test-failed-compaction");
    attachState(ctx, makeFakeState());

    // Simulate a failed compaction
    const event = { result: null, errorMessage: "something went wrong" };
    await handler(event, ctx);
    await flushMicrotasks();

    assert.equal(pi.sent.length, 0, "no whispers on failed compaction");
  });

  it("FIX: handler sends NO whisper on aborted compaction", async () => {
    const ctx = makeFakeCtx("test-aborted-compaction");
    attachState(ctx, makeFakeState());

    const event = { aborted: true, result: undefined };
    await handler(event, ctx);
    await flushMicrotasks();

    assert.equal(pi.sent.length, 0, "no whispers on aborted compaction");
  });

  it("FIX: handler sends unpersisted learnings whisper + re-orient whisper", async () => {
    const ctx = makeFakeCtx("test-with-learnings", {
      learnings: [
        { content: "test learning 1", category: "pattern", persisted: false },
        { content: "test learning 2", category: "fix", persisted: false },
      ],
    });
    attachState(ctx, makeFakeState());

    const event = { result: { status: "success" } };
    await handler(event, ctx);
    await flushMicrotasks();

    assert.equal(pi.sent.length, 2, "two whispers fire when unpersisted learnings exist");
    // First whisper: unpersisted learnings (no triggerTurn override)
    assert.equal(pi.sent[0].options.triggerTurn, false, "unpersisted learnings whisper does NOT wake agent");
    // Second whisper: re-orient (triggerTurn: true)
    assert.equal(pi.sent[1].options.triggerTurn, true, "re-orient whisper wakes agent");
  });

  it("FIX: deferred scratchpad failures are caught and logged, soft fallback", async () => {
    // The queueMicrotask wraps the entire side-effect chain in try/catch.
    // If callScratchpadTool returns undefined (its own internal catch
    // swallows the throw), the handler still sends the re-orient whisper
    // so the agent knows compaction happened.
    const ctx = makeFakeCtx("test-fail-soft");
    attachState(ctx, makeFakeState());
    // Force callScratchpadTool to throw
    ctx.tools.scratchpad = async () => {
      ctx.calls.scratchpad++;
      throw new Error("simulated scratchpad failure");
    };

    const event = { result: { status: "success" } };
    // Must not throw.
    await handler(event, ctx);
    await flushMicrotasks();

    assert.equal(ctx.calls.scratchpad, 1, "scratchpad was attempted");
    // callScratchpadTool's internal catch returns undefined, so the
    // handler proceeds to the re-orient whisper path. Exactly 1 whisper
    // fires (the re-orient; unpersisted learnings block is skipped
    // because learnings is undefined).
    assert.equal(
      pi.sent.length,
      1,
      "re-orient whisper must still fire even if scratchpad read fails",
    );
    // And the re-orient whisper must have triggerTurn: true
    assert.equal(pi.sent[0].options.triggerTurn, true, "re-orient whisper must still wake agent");
  });
});

// ── Source-level assertions: pin the design invariants ─────────────────────

describe("session_compact handler source invariants", () => {
  it("FIX: session_compact handler no longer has queueMicrotask for whisper delivery", async () => {
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

    // The session_compact handler (first onEvent block) should NOT contain
    // the deferred side-effects. The compaction_end handler (second onEvent
    // block) should have queueMicrotask instead.
    const sessionCompactStart = src.indexOf('onEvent(pi, "session_compact"');
    const compactionEndStart = src.indexOf('onEvent(pi, "compaction_end"');
    assert.ok(sessionCompactStart !== -1, "session_compact handler must exist");
    assert.ok(compactionEndStart !== -1, "compaction_end handler must exist");

    // The session_compact handler body should NOT have queueMicrotask
    const sessionCompactBody = src.slice(sessionCompactStart, compactionEndStart);
    assert.ok(
      !sessionCompactBody.includes("queueMicrotask"),
      "session_compact handler must NOT have queueMicrotask (whisper moved to compaction_end)",
    );
    // The session_compact handler should still have state resets
    assert.ok(
      sessionCompactBody.includes("contextNudgeSent"),
      "session_compact handler must still reset state synchronously",
    );

    // The compaction_end handler should have queueMicrotask for deferral
    const compactionEndBody = src.slice(compactionEndStart);
    assert.ok(
      compactionEndBody.includes("queueMicrotask"),
      "compaction_end handler must use queueMicrotask to defer side-effects",
    );
    // callScratchpadTool must be inside the queueMicrotask
    const microtaskStart = compactionEndBody.indexOf("queueMicrotask(");
    const scratchpadCall = compactionEndBody.indexOf("callScratchpadTool(ctx");
    assert.ok(
      microtaskStart !== -1 && scratchpadCall !== -1 && scratchpadCall > microtaskStart,
      "callScratchpadTool must be inside the deferred microtask, not synchronous",
    );

    // The re-entrancy guard must be present in session_compact.
    assert.ok(
      /reentrancy\.inHandler\s*=\s*true/.test(sessionCompactBody),
      "session_compact handler must set the inHandler flag before scheduling work",
    );
    assert.ok(
      /reentrancy\.inHandler\s*=\s*false/.test(sessionCompactBody),
      "session_compact handler must clear the inHandler flag in finally{}",
    );
  });

  it("FIX: MAX_REENTRY_DEPTH bumped from 1 to 3", async () => {
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
      /const MAX_REENTRY_DEPTH\s*=\s*3\b/.test(src),
      "MAX_REENTRY_DEPTH must be bumped from 1 to 3 (post-compaction stack overflow fix)",
    );
    assert.ok(
      !/const MAX_REENTRY_DEPTH\s*=\s*1\b/.test(src),
      "MAX_REENTRY_DEPTH must NOT be 1 (the value that allowed the stack overflow)",
    );
  });
});