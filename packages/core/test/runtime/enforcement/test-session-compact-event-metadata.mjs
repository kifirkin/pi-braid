/**
 * Test: register-session-compact consumer respects pi 0.79.10+ event metadata.
 *
 * Background:
 * pi-core 0.79.10 added `reason`and `willRetry`to session_compact events
 * so extensions can distinguish manual, threshold, and overflow flows.
 * pi 0.80.x added `reason`and `willRetry`to both session_before_compact
 * and session_compact (consolidated in the type definitions).
 *
 * The braid handler at `src/extensions/enforcement/handlers/register-session-compact.ts`
 * uses these fields to decide whether to auto-resume (wake the agent via
 * triggerTurn: true) after compaction completes:
 *
 * - willRetry === true → overflow recovery → pi WILL retry the aborted
 * turn automatically. Skip auto-resume; the retry
 * IS the resume mechanism. Waking again risks
 * re-entering the pre-compaction chain the
 * setTimeout(0) deferral was added to prevent
 * (see file-level stack-overflow comment).
 * - reason === "threshold" | "overflow" (willRetry false)
 * → auto-compaction → auto-resume.
 * - reason === "manual" → check autoResumeAfterCompaction substate flag:
 * Flag set (context_compress tool) → resume.
 * Flag unset (user typed /compress) → skip.
 *
 * Failure mode being guarded: handler ignores willRetry and wakes the agent
 * during overflow recovery. pi then both retries the original turn AND
 * receives a fresh turn trigger → double-wake → potential stack overflow
 * from the very chain this handler patched to defer.
 *
 * Run: node test/runtime/enforcement/test-session-compact-event-metadata.mjs
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { waitOutSilence } from "../lib/deferred-delivery.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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

console.log("=== session_compact handler: event metadata consumption tests ===\n");

// ── compile-time check: the handler source must reference _event.willRetry ──
// Catches the regression class where someone refactors and drops the gate.
// The negative-path behavioral tests below cover the salient case (willRetry:true
// → no wake); the structural check protects the design intent.

{
  const src = readFileSync(
    join(ROOT, "src/extensions/enforcement/handlers/register-session-compact.ts"),
    "utf8",
  );
  assert.ok(
    /_event\.willRetry/.test(src),
    "register-session-compact.ts must reference _event.willRetry (structural guard)",
  );
  assert.ok(
    /!_event\.willRetry/.test(src),
    "register-session-compact.ts must gate auto-resume on !_event.willRetry",
  );
  console.log(" [v] source references _event.willRetry (structural guard)");
  passed++;
}

// ── Imports (compiled dist) ────────────────────────────────────────────────

const { registerSessionCompactHandler } = await import(
  join(ROOT, "dist/extensions/enforcement/handlers/register-session-compact.js")
);
const { getState } = await import(join(ROOT, "dist/extensions/enforcement/state.js"));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFakePi() {
  const handlers = new Map();
  return {
    sendMessageCalls: [],
    sendUserMessageCalls: [],
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(msg) {
      this.sendMessageCalls.push(msg);
    },
    sendUserMessage(content) {
      this.sendUserMessageCalls.push(content);
    },
    _emit(event, ...args) {
      const list = handlers.get(event) ?? [];
      for (const h of list) {
        Promise.resolve(h(...args)).catch(() => {});
      }
    },
  };
}

/**
 * Create a ctx with session-backed enforcement state.
 *
 * The handler's `getState(ctx)`goes through getExtensionState which
 * creates a session-scoped state object. We call `getState(ctx)`in
 * test setup to ensure the state is created in the session bucket,
 * then mutate it directly. The handler will see the same object.
 */
function makeFakeCtx() {
  const sessionId = "test-session-" + Math.random().toString(36).slice(2, 8);
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
    ui: {
      notify: () => {},
      setStatus: () => {},
    },
  };
  return ctx;
}

// ── Negative-path tests (handler returns early, no side effects) ────────────

await test("willRetry: true → handler returns early, no pi.sendMessage", async () => {
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  registerSessionCompactHandler(pi);

  pi._emit(
    "session_compact",
    {
      type: "session_compact",
      reason: "overflow",
      willRetry: true,
      compactionEntry: { id: "test-compact-retry", summary: "test" },
      fromExtension: false,
    },
    ctx,
  );

  // The handler returns before scheduling anything here, so there is no
  // arrival to poll for; the window is the evidence that it stayed silent.
  await waitOutSilence();

  assert.equal(
    pi.sendMessageCalls.length,
    0,
    "pi.sendMessage must NOT be called when willRetry=true (pi handles the retry)",
  );
  assert.equal(pi.sendUserMessageCalls.length, 0);
});

await test("reason='manual' + flag unset (user /compress) → handler returns early", async () => {
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  registerSessionCompactHandler(pi);

  pi._emit(
    "session_compact",
    {
      type: "session_compact",
      reason: "manual",
      willRetry: false,
      compactionEntry: { id: "test-compact-manual", summary: "test" },
      fromExtension: false,
    },
    ctx,
  );

  await waitOutSilence();

  assert.equal(
    pi.sendMessageCalls.length,
    0,
    "pi.sendMessage must NOT be called for user-initiated /compress without agent flag",
  );
});

await test("flag is one-shot: handler clears autoResumeAfterCompaction on every emit", async () => {
  // Set the flag via getState(ctx) — this touches the SAME session-bucket
  // state object that the handler's getState(ctx) will read and mutate.
  const ctx = makeFakeCtx();
  const state = getState(ctx);
  state.autoResumeAfterCompaction = true;
  state.enforcementActive = true;

  // Patch sessionManager to throw — so the deferred setTimeout(0) path
  // (callScratchpadTool) crashes harmlessly in the try/catch.
  ctx.sessionManager.getSessionId = () => {
    throw new Error("scratchpad disabled intentionally for this test");
  };

  const pi = makeFakePi();
  registerSessionCompactHandler(pi);

  // Emit with reason=manual + willRetry=false — handler should see flag,
  // set shouldAutoResume=true, clear flag, then fall through to setTimeout.
  pi._emit(
    "session_compact",
    {
      type: "session_compact",
      reason: "manual",
      willRetry: false,
      compactionEntry: { id: "first", summary: "test" },
      fromExtension: false,
    },
    ctx,
  );

  // No wait: the handler clears the flag in its synchronous body, before it
  // schedules either setTimeout(0) side-effect. The assertion reads a state
  // write that has already happened by the time _emit returns.
  assert.equal(
    getState(ctx).autoResumeAfterCompaction,
    false,
    "flag is one-shot: handler must clear autoResumeAfterCompaction on every emit",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
