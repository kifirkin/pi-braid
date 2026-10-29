/**
 * Owner input across the compaction boundary is durable.
 *
 * The invariant this fixture pins: no owner input may exist ONLY in an
 * ephemeral in-memory seat. Owner text that enters a queue the extension
 * cannot verify drains - the compaction intercept capture, or a steer /
 * follow-up into a run - is written to the durable store (`braid_injection`
 * session entries) at receipt, and the compaction failure path re-queues the
 * text instead of wiping it.
 *
 * Cases:
 *   1. seat at receipt during a compaction cycle (full text, no truncation);
 *   2. seat at receipt for a steer into a run; idle prompts are not seated;
 *   3. failed compaction, idle session: parked text is re-queued into the
 *      session (the wipe this fixture exists for);
 *   4. failed compaction, mid-run: no mid-run session write; the settle
 *      boundary delivers the text exactly once;
 *   5. steer the run never consumed: settle re-delivers it once when pi's own
 *      queue is empty, and does NOT double-deliver while pi still holds it;
 *   6. a steer the run consumed (its message_end landed) is confirmed
 *      delivered and never re-delivered;
 *   7. shutdown flushes an undelivered seat into the session before state is
 *      cleared;
 *   8. regressions: manual success still holds its queued text (flush replay
 *      swallowed), auto success keeps the replay as its resume, the text is
 *      parked exactly once, and no second delivery follows.
 *
 * Run: node test/runtime/memory/test-compaction-owner-input-durability.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const cm = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);
const rotation = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/rotation.js")
);
const tracker = await import(join(ROOT, "dist/lib/utils/injection-tracker.js"));

const SEAT_SOURCE = cm.OWNER_INPUT_SEAT_SOURCE ?? "context-manager/owner-input-seat";

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

console.log("=== owner input is durable across the compaction boundary ===\n");

// ── Harness ─────────────────────────────────────────────────────────────────

let sessionSeq = 0;

/**
 * Fake ctx: the session manager is the fake the handlers pre-append through,
 * `isIdle`/`hasPendingMessages` are the live state queries the settle
 * reconciliation consults, and both are mutable so one fixture can move the
 * session from mid-run to settled.
 */
function makeFakeCtx({ idle = true, pendingMessages = false } = {}) {
  const sessionFile = `/tmp/owner-input-fixture-${++sessionSeq}.jsonl`;
  let entrySeq = 0;
  let isIdle = idle;
  let hasPending = pendingMessages;
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
      branch.push({ id, type: "message", message: msg });
      return id;
    },
  };
  let smRef = sm;
  return {
    cwd: "/tmp/owner-input-fixture",
    mode: "test",
    hasUI: false,
    get sessionManager() {
      return smRef;
    },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    ui: { notify: () => {}, setStatus: () => {} },
    isIdle: () => isIdle,
    hasPendingMessages: () => hasPending,
    compact: () => {},
    _appended: appended,
    _sm: sm,
    _setSessionManager: (next) => {
      smRef = next;
    },
    _setIdle: (value) => {
      isIdle = value;
    },
    _setPendingMessages: (value) => {
      hasPending = value;
    },
  };
}

/** Fake pi: records listeners + the durable appendEntry seam, mirrors the real write path. */
function makeFakePi() {
  const handlers = new Map();
  const entries = [];
  return {
    handlers,
    entries,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
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

/** Register the same handler set the context-manager extension registers. */
function registerAll(pi) {
  cm.registerBeforeCompactHandler(pi);
  cm.registerSessionCompactHandler(pi);
  cm.registerSessionCompactOutcomeHandler(pi);
  cm.registerSessionCompactFailedHandler(pi);
  rotation.registerSessionShutdownHandler(pi);
  tracker.registerInjectionTracker(pi);
}

/** Durable seat records (the store the seat writes through). */
function seatTexts(pi) {
  return pi.entries
    .filter((e) => e.customType === tracker.INJECTION_ENTRY_TYPE)
    .filter((e) => e.data?.source === SEAT_SOURCE)
    .map((e) => e.data?.content);
}

function appendedTexts(ctx) {
  return ctx._appended.map((a) => a.msg?.content?.[0]?.text);
}

async function fireBeforeCompact(pi, ctx, reason) {
  await pi._emit(
    { type: "session_before_compact", reason, preparation: undefined, willRetry: false },
    ctx,
  );
}

async function fireCompactSuccess(pi, ctx, reason) {
  await pi._emit(
    {
      type: "session_compact",
      reason,
      willRetry: false,
      compactionEntry: { id: "c1", summary: "s" },
    },
    ctx,
  );
}

async function fireCompactFailed(pi, ctx, event = {}) {
  await pi._emit(
    { type: "session_compact_failed", reason: "threshold", aborted: true, willRetry: false, ...event },
    ctx,
  );
}

async function fireInput(pi, ctx, text, streamingBehavior) {
  await pi._emit({ type: "input", text, source: "interactive", streamingBehavior }, ctx);
}

async function fireMessageEnd(pi, ctx, text) {
  await pi._emit(
    { type: "message_end", message: { role: "user", content: [{ type: "text", text }] } },
    ctx,
  );
}

async function fireSettled(pi, ctx) {
  await pi._emit({ type: "agent_settled", aborted: false }, ctx);
}

// ── 1. Durable seat at receipt ──────────────────────────────────────────────

await test("compaction: owner text typed during a cycle is seated durably at receipt", async () => {
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  registerAll(pi);
  await fireBeforeCompact(pi, ctx, "threshold");
  await fireInput(pi, ctx, "parked during compaction");
  assert.deepEqual(
    seatTexts(pi),
    ["parked during compaction"],
    "the text must land in the durable store the moment it is captured",
  );
  assert.deepEqual(appendedTexts(ctx), [], "receipt alone must not deliver the text");
});

await test("seat keeps the full owner text (no 500-char truncation)", async () => {
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  registerAll(pi);
  const longText = `${"x".repeat(700)}-tail-marker`;
  await fireBeforeCompact(pi, ctx, "threshold");
  await fireInput(pi, ctx, longText);
  assert.deepEqual(seatTexts(pi), [longText], "the seat must be the owner's exact text");
});

await test("steer into a run is seated durably at receipt", async () => {
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  registerAll(pi);
  await fireInput(pi, ctx, "steer text", "steer");
  assert.deepEqual(seatTexts(pi), ["steer text"], "a steer may outlive the run it was queued for");
});

await test("control: an idle prompt is not seated (it is delivered by definition)", async () => {
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  registerAll(pi);
  await fireInput(pi, ctx, "plain prompt", undefined);
  assert.deepEqual(seatTexts(pi), [], "idle prompts do not enter a queue");
});

// ── 2. Non-destructive failure path ─────────────────────────────────────────

await test("failed compaction, idle: parked text is re-queued instead of wiped", async () => {
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  registerAll(pi);
  await fireBeforeCompact(pi, ctx, "threshold");
  await fireInput(pi, ctx, "must survive the failure");
  await fireCompactFailed(pi, ctx);
  assert.deepEqual(
    appendedTexts(ctx),
    ["must survive the failure"],
    "the failure path must re-queue the parked text into the session",
  );
  assert.deepEqual(seatTexts(pi), ["must survive the failure"], "the durable seat stays");
});

await test("failed compaction: no second delivery follows (settle is idempotent)", async () => {
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  registerAll(pi);
  await fireBeforeCompact(pi, ctx, "threshold");
  await fireInput(pi, ctx, "deliver once");
  await fireCompactFailed(pi, ctx);
  await fireSettled(pi, ctx);
  await fireSettled(pi, ctx);
  assert.deepEqual(appendedTexts(ctx), ["deliver once"], "exactly one delivery");
});

await test("failed compaction, mid-run: settle delivers the parked text once", async () => {
  const ctx = makeFakeCtx({ idle: false });
  const pi = makeFakePi();
  registerAll(pi);
  await fireBeforeCompact(pi, ctx, "threshold");
  await fireInput(pi, ctx, "queued while failing");
  await fireCompactFailed(pi, ctx);
  assert.deepEqual(appendedTexts(ctx), [], "no mid-run session write at failure");
  ctx._setIdle(true);
  await fireSettled(pi, ctx);
  assert.deepEqual(appendedTexts(ctx), ["queued while failing"], "settle delivers the held text");
  await fireSettled(pi, ctx);
  assert.deepEqual(appendedTexts(ctx), ["queued while failing"], "second settle does not duplicate");
});

// ── 3. Steer: the run that never consumed it ────────────────────────────────

await test("steer still in pi's queue at settle: extension does not double-deliver", async () => {
  const ctx = makeFakeCtx({ pendingMessages: true });
  const pi = makeFakePi();
  registerAll(pi);
  await fireInput(pi, ctx, "still queued upstream", "steer");
  await fireSettled(pi, ctx);
  assert.deepEqual(
    appendedTexts(ctx),
    [],
    "pi delivers a queued steer at the next run start; re-delivering here would duplicate it",
  );
});

await test("steer lost with the run (queue empty at settle): re-delivered once", async () => {
  const ctx = makeFakeCtx({ pendingMessages: false });
  const pi = makeFakePi();
  registerAll(pi);
  await fireInput(pi, ctx, "lost with the run", "steer");
  await fireSettled(pi, ctx);
  assert.deepEqual(appendedTexts(ctx), ["lost with the run"], "the seat is the only copy left");
  await fireSettled(pi, ctx);
  assert.deepEqual(appendedTexts(ctx), ["lost with the run"], "re-delivery happens once");
});

await test("steer consumed by the run: confirmed delivered, never re-delivered", async () => {
  const ctx = makeFakeCtx({ pendingMessages: false });
  const pi = makeFakePi();
  registerAll(pi);
  await fireInput(pi, ctx, "consumed by the run", "steer");
  await fireMessageEnd(pi, ctx, "consumed by the run");
  await fireSettled(pi, ctx);
  assert.deepEqual(appendedTexts(ctx), [], "a consumed steer is already in the session");
});

// ── 4. Shutdown ─────────────────────────────────────────────────────────────

await test("shutdown flushes an undelivered seat into the session", async () => {
  const ctx = makeFakeCtx({ pendingMessages: true });
  const pi = makeFakePi();
  registerAll(pi);
  await fireInput(pi, ctx, "flush me before exit", "steer");
  await pi._emit({ type: "session_shutdown" }, ctx);
  assert.deepEqual(
    appendedTexts(ctx),
    ["flush me before exit"],
    "a seat still undelivered at shutdown must be written into the session",
  );
});

// ── 5. Success-path regressions ─────────────────────────────────────────────

await test("manual success: parked once and the flush replay is still swallowed", async () => {
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  registerAll(pi);
  await fireBeforeCompact(pi, ctx, "manual");
  await fireInput(pi, ctx, "hold this");
  await fireCompactSuccess(pi, ctx, "manual");
  assert.deepEqual(appendedTexts(ctx), ["hold this"], "parked exactly once");
  const flushAction = await emitInput(pi, ctx, "hold this", "steer");
  assert.equal(flushAction, "handled", "manual compaction remains a full stop");
  await fireSettled(pi, ctx);
  assert.deepEqual(appendedTexts(ctx), ["hold this"], "no second delivery after the hold");
});

await test("auto success: parked once and the flush replay still resumes", async () => {
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  registerAll(pi);
  await fireBeforeCompact(pi, ctx, "threshold");
  await fireInput(pi, ctx, "resume work");
  await fireCompactSuccess(pi, ctx, "threshold");
  assert.deepEqual(appendedTexts(ctx), ["resume work"], "parked exactly once");
  const flushAction = await emitInput(pi, ctx, "resume work", "steer");
  assert.equal(flushAction, "continue", "auto compaction keeps the flush as its resume");
  await fireSettled(pi, ctx);
  assert.deepEqual(appendedTexts(ctx), ["resume work"], "no second delivery after the replay");
});

await test("auto success: the flush replay's persistence does not duplicate the parked entry", async () => {
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  registerAll(pi);
  await fireBeforeCompact(pi, ctx, "threshold");
  await fireInput(pi, ctx, "resume work");
  await fireCompactSuccess(pi, ctx, "threshold");
  // pi-core persistence order for the replay's run: extension message_end
  // handlers first, then sessionManager.appendMessage for the user message.
  await fireMessageEnd(pi, ctx, "resume work");
  const entryId = ctx._sm.appendMessage({
    role: "user",
    content: [{ type: "text", text: "resume work" }],
  });
  assert.deepEqual(
    appendedTexts(ctx),
    ["resume work"],
    "the parked entry must be the only session copy of the text",
  );
  assert.equal(typeof entryId, "string", "the skip returns the parked entry id");
  // The wrapper must not outlive the delivery: an unrelated message_end
  // restores it, so a later genuinely new prompt still lands.
  await pi._emit(
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ctx,
  );
  ctx._sm.appendMessage({ role: "user", content: [{ type: "text", text: "later prompt" }] });
  assert.ok(
    appendedTexts(ctx).includes("later prompt"),
    "the intercept wrapper must be restored after the delivery",
  );
});

await test("a later cycle can seat the same text again (suppression is cycle-scoped)", async () => {
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  registerAll(pi);
  // Cycle 1: park the text and let its flush replay arrive (the replay must
  // not be re-seated as a fresh receipt).
  await fireBeforeCompact(pi, ctx, "threshold");
  await fireInput(pi, ctx, "same text twice");
  await fireCompactSuccess(pi, ctx, "threshold");
  await emitInput(pi, ctx, "same text twice", "steer");
  assert.equal(seatTexts(pi).length, 1, "the replay of a parked text is not a second seat");
  // Cycle 2: the owner types the identical text into a new compaction.
  await fireBeforeCompact(pi, ctx, "threshold");
  await fireInput(pi, ctx, "same text twice");
  assert.equal(
    seatTexts(pi).length,
    2,
    "the replay suppression must not outlive the cycle that armed it",
  );
});

await test("session replacement: a parked seat is delivered to the live manager", async () => {
  const ctx = makeFakeCtx();
  const pi = makeFakePi();
  registerAll(pi);
  // A steer seat that will still be pending when the manager is replaced, and
  // a completed cycle first so the intercept wrapper is bound to the old one.
  await fireInput(pi, ctx, "steer for later", "steer");
  await fireBeforeCompact(pi, ctx, "threshold");
  await fireInput(pi, ctx, "compaction text");
  await fireCompactSuccess(pi, ctx, "threshold");
  const replacementAppended = [];
  const replacement = {
    getSessionFile: () => ctx._sm.getSessionFile(),
    getSessionId: () => ctx._sm.getSessionId(),
    getLeafId: () => "leaf",
    getBranch: () => ctx._sm.getBranch(),
    appendMessage: (msg) => {
      replacementAppended.push(msg);
      return `rep-${replacementAppended.length}`;
    },
  };
  ctx._setSessionManager(replacement);
  await fireSettled(pi, ctx);
  assert.deepEqual(
    replacementAppended.map((m) => m.content?.[0]?.text),
    ["steer for later"],
    "the live session manager must receive the write",
  );
  assert.deepEqual(
    appendedTexts(ctx),
    ["compaction text"],
    "the replaced manager must not receive the seat write",
  );
});

/**
 * pi-core runner.emitInput semantics: handlers chain in registration order;
 * "handled" short-circuits session.prompt; "continue" means the prompt
 * proceeds into a run (the flush replay shape).
 */
async function emitInput(pi, ctx, text, streamingBehavior) {
  for (const handler of pi.handlers.get("input") ?? []) {
    const result = await handler(
      { type: "input", text, images: undefined, source: "interactive", streamingBehavior },
      ctx,
    );
    if (result?.action === "handled") return "handled";
  }
  return "continue";
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
