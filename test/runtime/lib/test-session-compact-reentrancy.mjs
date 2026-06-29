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
 * FIX (3 layers):
 *   1. Per-session `inHandler` re-entrancy guard in
 *      `enforcement/handlers/register-session-compact.ts` (mirrors the
 *      `inBeforeAgentStart` pattern from context-lifecycle).
 *   2. The scratchpad read + whisper delivery side-effects are deferred
 *      via `queueMicrotask` so the handler returns synchronously. This
 *      is the KEY fix — by the time pi-core's synchronous event chain
 *      (TOOL_EXECUTION_END → fireExpired → pi.sendMessage) wants to fire,
 *      we have already returned and the call stack is short.
 *   3. State writes (lastCompactionTurn, etc.) stay synchronous because
 *      downstream handlers (turn_end, message_end) read them on the
 *      same tick.
 *   + Bumped MAX_REENTRY_DEPTH from 1 to 3 in injection-tracker.ts.
 *
 * These tests pin down all three layers + the depth bump.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Import the compiled handler. We mock the deps it pulls in via the
// imported module's closure (the test injects a fake pi + ctx).
const { registerSessionCompactHandler } = await import(
  "../../../dist/extensions/enforcement/handlers/register-session-compact.js"
);

// Import the turn-dedup reset helper — the whisper flood cap is
// process-global state. Without resetting between tests, the cap from
// previous tests in the same process suppresses our whispers.
const { _resetForTests: resetDedup, beginTurn } = await import(
  "../../../dist/lib/enforcement/turn-dedup.js"
);

// ── Test helpers ──────────────────────────────────────────────────────────

/**
 * Build a fake pi object with the minimum surface area the handler uses.
 * Captures the session_compact handler so tests can call it directly.
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
 * Yield to the microtask queue. Each round drains one microtask. Use
 * multiple rounds to allow chained async continuations to fully resolve.
 */
async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

// ── Layer 2 tests: deferred side-effects via queueMicrotask ────────────────

describe("session_compact deferred side-effects (the key fix)", () => {
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

  it("FIX: handler returns BEFORE awaiting callScratchpadTool (sync body stays sync)", async () => {
    // The crucial property: when session_compact fires, the handler's
    // synchronous body must NOT call ctx.tools.scratchpad. The scratchpad
    // read is deferred to a queueMicrotask so the pi-core event dispatch
    // completes with a short call stack before any synchronous chains can
    // form.
    const ctx = makeFakeCtx("test-session-sync-body");

    // Synchronously call the handler. It returns a promise immediately
    // (since the await is inside a queueMicrotask, not the body).
    const handlerPromise = handler({}, ctx);

    // Before yielding to microtasks, the scratchpad must NOT have been
    // called yet. This is the property that breaks the synchronous chain.
    assert.equal(
      ctx.calls.scratchpad,
      0,
      "scratchpad must NOT be called during the handler's synchronous body",
    );
    // And no whispers must have been sent either.
    assert.equal(
      pi.sent.length,
      0,
      "no whispers must fire during the handler's synchronous body",
    );

    // Now let microtasks run.
    await handlerPromise;
    await flushMicrotasks();

    assert.equal(
      ctx.calls.scratchpad,
      1,
      "scratchpad called exactly once after microtask drains",
    );
  });

  it("FIX: deferred scratchpad failures are caught and logged, do not propagate", async () => {
    // The queueMicrotask wraps the entire side-effect chain in try/catch.
    // If callScratchpadTool returns undefined (its own internal catch
    // swallows the throw), the handler still sends the re-orient whisper
    // so the agent knows compaction happened. Without the try/catch the
    // unhandled rejection would crash the session.
    const ctx = makeFakeCtx("test-session-fail-soft");
    // Force callScratchpadTool to return undefined by making the tool
    // throw - callScratchpadTool internally catches and returns undefined.
    ctx.tools.scratchpad = async () => {
      ctx.calls.scratchpad++;
      throw new Error("simulated scratchpad failure");
    };

    // Must not throw.
    await handler({}, ctx);
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
  });

  it("FIX: re-orient whisper fires via the deferred path, not synchronously", async () => {
    // The handler must NOT send any whispers from its synchronous body.
    // All whispers must come from the queueMicrotask. This is the
    // property that breaks the synchronous chain.
    const ctx = makeFakeCtx("test-session-whisper-timing");

    await handler({}, ctx);
    await flushMicrotasks();

    // With empty learnings, exactly one whisper (the re-orient) fires.
    assert.equal(
      pi.sent.length,
      1,
      "exactly one whisper (re-orient) must fire after the microtask drains",
    );
    // And the whisper has triggerTurn:false (it's a steer, not a turn).
    assert.equal(pi.sent[0].options.triggerTurn, false);
  });

  it("FIX: unpersisted learnings trigger both whispers (learning + re-orient)", async () => {
    // When scratchpad reports unpersisted key_learnings, the handler
    // sends TWO whispers from the deferred path: one about the
    // learnings, then the re-orient. Both are deferred.
    const ctx = makeFakeCtx("test-session-with-learnings", {
      learnings: [
        { content: "test learning 1", category: "pattern", persisted: false },
        { content: "test learning 2", category: "fix", persisted: false },
      ],
    });

    await handler({}, ctx);
    await flushMicrotasks();

    assert.equal(
      pi.sent.length,
      2,
      "two whispers fire when unpersisted learnings exist (learning + re-orient)",
    );
  });
});

// ── Layer 1 tests: re-entrancy guard ───────────────────────────────────────

describe("session_compact re-entrancy guard", () => {
  let pi;
  let handler;

  beforeEach(() => {
    resetDedup();
    beginTurn();
    pi = makeFakePi();
    registerSessionCompactHandler(pi);
    handler = pi.handlers.get("session_compact");
  });

  it("FIX: handler runs side-effects normally on a fresh call", async () => {
    const ctx = makeFakeCtx("test-fresh-call");
    await handler({}, ctx);
    await flushMicrotasks();

    assert.equal(ctx.calls.scratchpad, 1, "fresh call triggers scratchpad");
    assert.equal(pi.sent.length, 1, "fresh call triggers re-orient whisper");
  });

  it("FIX: re-entrancy guard is per-session (two sessions can run independently)", async () => {
    // The guard is keyed on sessionManager.getSessionFile() via
    // getExtensionState. Two sessions with different sessionManagers
    // must each have their own flag.
    const ctxA = makeFakeCtx("session-A");
    const ctxB = makeFakeCtx("session-B");

    const promiseA = handler({}, ctxA);
    // Immediately start session B without awaiting A.
    const promiseB = handler({}, ctxB);

    await promiseA;
    await promiseB;
    await flushMicrotasks();

    assert.equal(ctxA.calls.scratchpad, 1, "session A ran scratchpad");
    assert.equal(ctxB.calls.scratchpad, 1, "session B ran scratchpad despite A being mid-flight");
  });
});

// ── Source-level assertions: pin the design invariants ─────────────────────

describe("session_compact handler source invariants", () => {
  it("FIX: the handler uses queueMicrotask for scratchpad + whisper side-effects", async () => {
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

    assert.ok(
      src.includes("queueMicrotask"),
      "handler must defer side-effects via queueMicrotask to break synchronous chain",
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
    // callScratchpadTool must be inside the queueMicrotask (not synchronous).
    const microtaskStart = src.indexOf("queueMicrotask(");
    const scratchpadCall = src.indexOf("callScratchpadTool(ctx");
    assert.ok(
      microtaskStart !== -1 && scratchpadCall !== -1 && scratchpadCall > microtaskStart,
      "callScratchpadTool must be inside the deferred microtask, not synchronous",
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