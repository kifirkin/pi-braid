/**
 * Regression test: agent-initiated compaction
 * (context_compress tool) MUST resume the agent loop after compaction, even
 * when the agent's pre-compaction turn ended as a natural stop.
 *
 * THE BUG this guards (looped stopped in production 0.3.2-main.3):
 * The round-21f natural-stop heuristic downgraded the post-compaction
 * re-orientation wake to an advisory triggerTurn:false whisper whenever
 * lastTurnWasNaturalStop was true. In the agent-initiated path that is the
 * COMMON case: the agent calls context_compress, its final response is
 * "compaction scheduled — will resume automatically" (stopReason "stop", no
 * tool calls → classified natural stop), then ctx.compact() aborts. At
 * session_compact the wake was sent with triggerTurn:false → pi-core queued
 * it for the next USER prompt via _pendingNextTurnMessages → no autonomous
 * turn ever started → post-compaction loop stop.
 *
 * THE FIX: when the agent explicitly requested resume
 * (autoResumeAfterCompaction=true, set by context_compress before ctx.compact),
 * the wake MUST be triggerTurn:true and override the natural-stop downgrade.
 * The downgrade now applies only when the flag is unset (auto threshold /
 * overflow path, where the agent genuinely finished).
 *
 * Runs against the compiled dist (npm test builds first).
 *
 * Run: node test/runtime/enforcement/test-post-compaction-resume.mjs
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

const { registerSessionCompactHandler } = await import(
  join(ROOT, "dist/extensions/enforcement/handlers/register-session-compact.js")
);
const { getState } = await import(join(ROOT, "dist/extensions/enforcement/state.js"));
const { registerWakeGate, resetWakeGateForTests } = await import(
  join(ROOT, "dist/lib/utils/wake-gate.js")
);
const { _resetForTests: resetTurnDedup } = await import(
  join(ROOT, "dist/lib/enforcement/turn-dedup.js")
);
const { clearAllBuckets } = await import(join(ROOT, "dist/lib/utils/injection-tracker.js"));

console.log("=== post-compaction resume: agent-initiated compaction always wakes ===\n");

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeFakePi() {
  const handlers = new Map();
  const sent = [];
  return {
    handlers,
    sent,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(params, options) {
      sent.push({ params, options });
    },
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

function makeFakeCtx() {
  const sessionId = "resume-" + Math.random().toString(36).slice(2, 8);
  return {
    cwd: "/tmp/test-cwd",
    mode: "test",
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
    },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    ui: { notify: () => {}, setStatus: () => {} },
  };
}

// ── Waiting for the deferred chain ──────────────────────────────────────────
//
// The message this fixture counts is produced by work it does not own: the
// handler defers its side-effects with setTimeout(0), the whisper runs through
//
//   setTimeout(0) -> sendEnforcementWhisper -> sendTrackedMessage
//   -> setTimeout(0) for triggerTurn -> gateTriggerTurnOptions -> pi.sendMessage
//
// and a fixed sleep made the wait a guess about how long four deferrals take.
// On a loaded box the guess loses and the count is read before anything has
// arrived, so the assertion blames the product for the fixture's wait.
//
// The wait is a bounded poll on the arrival instead. Arrival is what load can
// delay; the deadline only bounds a chain that never delivers, and the poll
// stops the moment the chain has landed and held still.

/** Upper bound on a delivery the case expects. Load changes WHEN the chain
 *  lands, never WHETHER it does, so this is not the measurement. */
const DELIVERY_DEADLINE_MS = 2000;

/** Once something has arrived, the count must stop moving before it is read. A
 *  duplicate delivery from the same chain lands on the next macrotask, so
 *  reading the instant the first arrives would report a double-send as a
 *  single send - the failure the `exactly one` cases exist to catch. */
const QUIET_MS = 50;

const STEP_MS = 5;

/** A case that expects silence has no arrival to wait for, so it waits out a
 *  window instead. This is the one place in this file where a duration is the
 *  only available evidence, and it is sized from the chain's measured arrival
 *  latency: 5ms p50 and 9ms p99 on an idle box, 101ms worst observed under 16x
 *  CPU oversubscription. A window under that tail would make "nothing arrived"
 *  true because the chain had not finished, not because nothing was sent. */
const SILENCE_WINDOW_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settle(pi, { expectDelivery }) {
  if (!expectDelivery) {
    await sleep(SILENCE_WINDOW_MS);
    return pi.sent;
  }
  const deadline = Date.now() + DELIVERY_DEADLINE_MS;
  let seen = 0;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    if (pi.sent.length !== seen) {
      seen = pi.sent.length;
      stableSince = Date.now();
    } else if (seen > 0 && Date.now() - stableSince >= QUIET_MS) {
      break;
    }
    await sleep(STEP_MS);
  }
  return pi.sent;
}

/** Exactly one message, with a failure that names which way it went wrong. */
function assertExactlyOne(sent) {
  const count = sent.length;
  assert.ok(
    count === 1,
    count === 0
      ? `no re-orientation message reached pi.sendMessage within ${DELIVERY_DEADLINE_MS}ms ` +
        `(the handler's deferred chain never delivered)`
      : `expected exactly one re-orientation message at pi.sendMessage, got ${count} ` +
        `(the wake was delivered more than once)`,
  );
}

async function runSessionCompact({
  flag,
  naturalStop,
  reason = "manual",
  willRetry = false,
  expectDelivery,
}) {
  resetWakeGateForTests();
  resetTurnDedup(); // per-turn whisper flood caps are module-global
  clearAllBuckets(); // clears per-session injection + 20-min reprime state
  const pi = makeFakePi();
  registerWakeGate(pi);
  registerSessionCompactHandler(pi);
  const ctx = makeFakeCtx();
  const state = getState(ctx);
  state.enforcementActive = true;
  state.autoResumeAfterCompaction = flag;
  state.lastTurnWasNaturalStop = naturalStop;

  await pi._emit(
    {
      type: "session_compact",
      reason,
      willRetry,
      compactionEntry: { id: "c1", summary: "test" },
      fromExtension: true,
    },
    ctx,
  );

  return settle(pi, { expectDelivery });
}

function isWake(s) {
  return s.options?.triggerTurn === true && s.options?.deliverAs === undefined;
}
function isAdvisory(s) {
  return s.options?.triggerTurn === false && s.options?.deliverAs === "steer";
}

// ── The regression (fails on 0.3.2-main.3, passes after the fix) ────────────

await test("agent-initiated compact + natural-stop turn → wake is triggerTurn:true (loop resumes)", async () => {
  const sent = await runSessionCompact({ flag: true, naturalStop: true, expectDelivery: true });
  // The dead-stop repro: pre-fix this sent triggerTurn:false/nextTurn (no
  // autonomous turn → loop stop). Post-fix it must be triggerTurn:true.
  assertExactlyOne(sent);
  assert.ok(
    isWake(sent[0]),
    `agent-requested resume must wake (triggerTurn:true, deliverAs undefined) — got triggerTurn=${sent[0].options?.triggerTurn} deliverAs=${sent[0].options?.deliverAs}`,
  );
});

await test("agent-initiated compact + mid-work turn → wake is triggerTurn:true (preserved)", async () => {
  const sent = await runSessionCompact({ flag: true, naturalStop: false, expectDelivery: true });
  assertExactlyOne(sent);
  assert.ok(isWake(sent[0]), "mid-work agent-initiated compact must wake");
});

// ── Round-21f preservation (no regression on the auto/user paths) ───────────

await test("user /compress (no flag) → no wake at all (handler returns early, no forced turn)", async () => {
  const sent = await runSessionCompact({ flag: false, naturalStop: true, expectDelivery: false });
  assert.equal(
    sent.length,
    0,
    "user-initiated /compress without the agent flag must NOT force a fresh turn or emit a wake",
  );
});

await test("auto threshold + natural stop → ADVISORY triggerTurn:false (round-21f kept)", async () => {
  const sent = await runSessionCompact({
    flag: false,
    naturalStop: true,
    reason: "threshold",
    expectDelivery: true,
  });
  assertExactlyOne(sent);
  assert.ok(
    isAdvisory(sent[0]),
    "auto-threshold compaction after a genuine natural stop must stay advisory (triggerTurn:false)",
  );
});

await test("auto threshold (no flag) + mid-work turn → wake is triggerTurn:true", async () => {
  const sent = await runSessionCompact({
    flag: false,
    naturalStop: false,
    reason: "threshold",
    expectDelivery: true,
  });
  assertExactlyOne(sent);
  assert.ok(isWake(sent[0]), "auto-compaction of a mid-work turn must wake");
});

await test("willRetry=true (overflow recovery) → no wake (pi retries itself)", async () => {
  const sent = await runSessionCompact({
    flag: true,
    naturalStop: false,
    reason: "overflow",
    willRetry: true,
    expectDelivery: false,
  });
  assert.equal(sent.length, 0, "willRetry path must not double-wake");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
