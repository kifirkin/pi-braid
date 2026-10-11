/**
 * Fixture: a manual compaction must be a full stop: after it completes, no
 * assistant turn starts from pre-compaction input.
 *
 * The turn source is pi-core's TUI: input submitted while a compaction runs is
 * queued in the TUI's compaction queue, and at compaction end
 * flushCompactionQueue() replays the first queued message via
 * session.prompt(text, {streamingBehavior}): a real assistant turn fired
 * without new input. The TUI layer is unreachable from a headless harness, so
 * this fixture drives the equivalent path against the compiled handlers in
 * pi-core's documented order:
 *
 *   1. session_before_compact (reason manual|auto)   -> cycle opens
 *   2. input event (operator types mid-compaction)   -> capture
 *   3. session_compact                               -> park (pre-append) + arm
 *   4. session_compact closes the cycle (pi-core 0.85.1 has no
 *      compaction_end extension event; the parking stage marks inactive)
 *   5. flush emulation: emitInput over registered input handlers with the
 *      exact call shape flushCompactionQueue uses: text + streamingBehavior
 *      set (pi-core passes firstPrompt.mode; a genuinely new operator input
 *      carries no streamingBehavior). "continue" from the chain means
 *      session.prompt proceeds into _runAgentPrompt -> TURN_WOULD_START;
 *      "handled" means the prompt was swallowed -> no turn.
 *
 * The auto (threshold/overflow) control cases assert the same flush still
 * starts the turn: for automatic compactions the flush replay IS the resume.
 *
 * Run: node test/runtime/memory/test-manual-compaction-stop.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

const cm = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);

console.log("=== manual compaction is a full stop (no stale-prompt replay turn) ===\n");

// ── Fixtures ────────────────────────────────────────────────────────────────

let sessionSeq = 0;

function makeFakeCtx() {
  const sessionFile = `/tmp/w198-fixture-${++sessionSeq}.jsonl`;
  let entrySeq = 0;
  const appended = [];
  const branch = [
    {
      id: "e0",
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "earlier" }] },
    },
    {
      id: "e1",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    },
  ];
  const sm = {
    getSessionFile: () => sessionFile,
    getSessionId: () => sessionFile,
    getLeafId: () => "leaf",
    getBranch: () => branch,
    getTree: () => branch.map((b) => ({ entry: b })),
    getLabel: () => undefined,
    appendMessage: (msg) => {
      const id = `app-${++entrySeq}`;
      appended.push({ id, msg });
      return id;
    },
  };
  return {
    cwd: "/tmp/w198-fixture",
    mode: "test",
    hasUI: false,
    sessionManager: sm,
    modelRegistry: { find: () => undefined, getAll: () => [] },
    ui: { notify: () => {}, setStatus: () => {} },
    _appended: appended,
    _sm: sm,
  };
}

// The real ExtensionAPI carries no sessionManager; restore reads the
// manager off ctx. The fake stays faithful to that shape so a restore that
// depends on pi.sessionManager cannot pass here.
function makeFakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage() {},
    sendUserMessage() {},
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      for (const h of handlers.get(name) ?? []) {
        await Promise.resolve(h(event, ...args)).catch((e) => {
          console.error(`  ! handler error on ${name}:`, e);
          throw e;
        });
      }
    },
  };
}

// pi-core runner.emitInput semantics (dist/core/extensions/runner.js):
// handlers chain in registration order; "handled" short-circuits;
// "transform" rewrites the payload. "continue" means session.prompt proceeds
// into _runAgentPrompt — a real assistant turn.
async function emitInput(pi, ctx, text, streamingBehavior) {
  let currentText = text;
  for (const handler of pi.handlers.get("input") ?? []) {
    const event = {
      type: "input",
      text: currentText,
      images: undefined,
      source: "interactive",
      streamingBehavior,
    };
    const result = await handler(event, ctx);
    if (result?.action === "handled") return "handled";
    if (result?.action === "transform") currentText = result.text;
  }
  return currentText !== text ? "transform" : "continue";
}

function turnVerdict(action) {
  // pi-core: input action "handled" short-circuits session.prompt — no run.
  // "continue"/"transform" fall through to the pre-flight and _runAgentPrompt.
  return action === "handled" ? "NO_TURN (prompt swallowed)" : "TURN_WOULD_START";
}

/**
 * Drive the documented compaction cycle: session_before_compact (opens the
 * cycle, marks compaction active) -> operator types T mid-compaction ->
 * session_compact (park + arm, closes the cycle) -> TUI flush replay of T.
 */
async function runCompactionWithQueuedText({ reason, queuedText, compactionId = "c1" }) {
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  cm.registerBeforeCompactHandler(pi);
  cm.registerSessionCompactHandler(pi);

  // 1. cycle opens (sets compaction active)
  await pi._emit(
    { type: "session_before_compact", reason, preparation: undefined, willRetry: false },
    ctx,
  );
  // 2. operator types T during the compaction (idle submit, no streamingBehavior)
  if (queuedText !== undefined) {
    await pi._emit({ type: "input", text: queuedText, source: "interactive" }, ctx);
  }
  // 3. compaction succeeded
  await pi._emit(
    {
      type: "session_compact",
      reason,
      willRetry: false,
      compactionEntry: { id: compactionId, summary: "s" },
    },
    ctx,
  );
  // 4. flushCompactionQueue: session.prompt(T, {streamingBehavior})
  const flushAction =
    queuedText === undefined ? undefined : await emitInput(pi, ctx, queuedText, "steer");
  return { pi, ctx, flushAction };
}

// ── The repro (fails pre-fix: flush replays the stale prompt as a turn) ─────

await test("manual: queued message + flush -> flush replay must NOT start a turn", async () => {
  const { flushAction } = await runCompactionWithQueuedText({
    reason: "manual",
    queuedText: "hold this",
  });
  assert.equal(
    flushAction,
    "handled",
    `manual compaction must be a full stop: flush replay must be swallowed, got ${flushAction} -> ${turnVerdict(flushAction)}`,
  );
});

await test("manual: parked text observable in the session (no silent loss)", async () => {
  const { ctx } = await runCompactionWithQueuedText({ reason: "manual", queuedText: "hold this" });
  const parked = ctx._appended.filter((a) => a.msg?.content?.[0]?.text === "hold this");
  assert.equal(
    parked.length,
    1,
    "queued text must be parked in the session exactly once (pre-append)",
  );
});

await test("manual: flush window closed -> genuinely new input still starts a turn", async () => {
  const { pi, ctx } = await runCompactionWithQueuedText({
    reason: "manual",
    queuedText: "hold this",
  });
  // Operator's next genuinely new message: idle submit, no streamingBehavior.
  const newAction = await emitInput(pi, ctx, "fresh prompt after compaction", undefined);
  assert.equal(newAction, "continue", "a genuinely new operator input must never be swallowed");
  // Byte-identical re-submit (no streamingBehavior) must also flow: it is new input.
  const resubmitAction = await emitInput(pi, ctx, "hold this", undefined);
  assert.equal(resubmitAction, "continue", "byte-identical new input must start a turn");
});

await test("manual: second compaction cycle holds ITS queued text (no stale capture)", async () => {
  const { pi, ctx } = await runCompactionWithQueuedText({
    reason: "manual",
    queuedText: "first queued",
  });
  // Cycle 1's flush was consumed inside the helper (its flushAction was the
  // swallowed replay). Drive a second cycle on the same session: the operator
  // types different text during that compaction.
  await pi._emit(
    { type: "session_before_compact", reason: "manual", preparation: undefined, willRetry: false },
    ctx,
  );
  await pi._emit({ type: "input", text: "second queued", source: "interactive" }, ctx);
  await pi._emit(
    {
      type: "session_compact",
      reason: "manual",
      willRetry: false,
      compactionEntry: { id: "c2", summary: "s2" },
    },
    ctx,
  );
  const flushAction = await emitInput(pi, ctx, "second queued", "steer");
  assert.equal(flushAction, "handled", "each manual cycle holds its own queued text");
});

await test("manual: compaction ABORTED -> no arm, flush input flows normally", async () => {
  // A failed/aborted manual compaction never reaches session_compact (success
  // only), so the hold must never arm: the queue replays as a normal prompt
  // into an intact (pre-compaction) context — pre-existing behavior.
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  cm.registerBeforeCompactHandler(pi);
  cm.registerSessionCompactHandler(pi);
  await pi._emit(
    { type: "session_before_compact", reason: "manual", preparation: undefined, willRetry: false },
    ctx,
  );
  await pi._emit({ type: "input", text: "queued while aborting", source: "interactive" }, ctx);
  // No session_compact — the cycle aborted before it (the failure shape).
  const action = await emitInput(pi, ctx, "queued while aborting", "steer");
  assert.equal(
    action,
    "continue",
    "aborted compaction must not arm the hold; queue replays normally",
  );
});

await test("manual: unspent hold does not leak into a later AUTO cycle's flush", async () => {
  // Cycle A manual with parked text whose flush produced no input event (e.g.
  // the queue replayed as commands/steers). Cycle B is AUTO: its before_compact
  // must clear the stale hold so cycle B's flush replay still resumes the turn.
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  cm.registerBeforeCompactHandler(pi);
  cm.registerSessionCompactHandler(pi);
  // Cycle A: park + arm with NO flush input afterwards.
  await pi._emit(
    { type: "session_before_compact", reason: "manual", preparation: undefined, willRetry: false },
    ctx,
  );
  await pi._emit({ type: "input", text: "parked in A", source: "interactive" }, ctx);
  await pi._emit(
    {
      type: "session_compact",
      reason: "manual",
      willRetry: false,
      compactionEntry: { id: "a1", summary: "s" },
    },
    ctx,
  );
  // Cycle B: auto. No input event between the two cycles.
  await pi._emit(
    {
      type: "session_before_compact",
      reason: "threshold",
      preparation: undefined,
      willRetry: false,
    },
    ctx,
  );
  await pi._emit({ type: "input", text: "queued in B", source: "interactive" }, ctx);
  await pi._emit(
    {
      type: "session_compact",
      reason: "threshold",
      willRetry: false,
      compactionEntry: { id: "b1", summary: "s" },
    },
    ctx,
  );
  const flushB = await emitInput(pi, ctx, "queued in B", "steer");
  assert.equal(flushB, "continue", "auto cycle B's flush must resume despite cycle A's stale hold");
});

await test("restore: message_end removes the intercept wrapper off the ctx manager", async () => {
  // The intercept install (session_compact) wraps sessionManager.appendMessage
  // via the ctx-derived manager; the restore must find the SAME instance off
  // ctx. A restore that reads pi.sessionManager finds nothing on the real
  // ExtensionAPI and silently leaves the wrapper installed for the session.
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  const origAppend = ctx._sm.appendMessage;
  cm.registerBeforeCompactHandler(pi);
  cm.registerSessionCompactHandler(pi);
  // The production wiring registers the outcome stage too; its MESSAGE_END
  // backup owns the intercept restore.
  cm.registerSessionCompactOutcomeHandler(pi);
  await pi._emit(
    { type: "session_before_compact", reason: "threshold", preparation: undefined, willRetry: false },
    ctx,
  );
  await pi._emit({ type: "input", text: "queued", source: "interactive" }, ctx);
  await pi._emit(
    {
      type: "session_compact",
      reason: "threshold",
      willRetry: false,
      compactionEntry: { id: "r1", summary: "s" },
    },
    ctx,
  );
  const wrapper = ctx._sm.appendMessage;
  assert.notEqual(wrapper, origAppend, "session_compact must install the appendMessage intercept");
  await pi._emit({ type: "message_end", message: { role: "assistant", content: [] } }, ctx);
  assert.notEqual(
    ctx._sm.appendMessage,
    wrapper,
    "message_end must remove the intercept wrapper (restore reads the sessionManager off ctx)",
  );
});

await test("manual: no queued text -> flush input flows (nothing held)", async () => {
  const { pi, ctx } = await runCompactionWithQueuedText({
    reason: "manual",
    queuedText: undefined,
  });
  const action = await emitInput(pi, ctx, "operator prompt", undefined);
  assert.equal(action, "continue", "no parked message -> nothing to hold; input flows");
});

// ── Auto control cases: the flush replay IS the resume (must stay a turn) ───

await test("auto threshold: queued message + flush -> resume turn preserved", async () => {
  const { flushAction } = await runCompactionWithQueuedText({
    reason: "threshold",
    queuedText: "resume work",
  });
  assert.equal(
    flushAction,
    "continue",
    `auto compaction must keep the flush as its resume: got ${flushAction} -> ${turnVerdict(flushAction)}`,
  );
});

await test("auto overflow: queued message + flush -> resume turn preserved", async () => {
  const { flushAction } = await runCompactionWithQueuedText({
    reason: "overflow",
    queuedText: "resume work",
  });
  assert.equal(flushAction, "continue", "overflow resume must stay unchanged");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
