/**
 * Regression test: the post-compaction resume wake must SURVIVE the per-turn
 * whisper flood cap, not merely be requested through it.
 *
 * THE BUG this guards:
 * The re-orientation wake after an agent-initiated compaction
 * (`context_compress` -> `session_compact`, autoResumeAfterCompaction=true)
 * is the only thing that hands the agent loop back, because pi aborts the
 * turn aborted by the tool and does not retry it. It fires through
 * `sendEnforcementWhisper` with `triggerTurn: true`, which lands in the
 * shared `enforcement/whisper` source bucket at `high` priority. Once three
 * enforcement whispers have already been delivered in the same turn, the
 * per-source cap (PER_SOURCE_CAP_OVERRIDES["enforcement/whisper"] = 3) is
 * spent, `tryWhisper` returns false, the send is tracked as display:false
 * and returned from before `pi.sendMessage`. The wake is gone and the
 * session halts.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM test-post-compaction-resume.mjs:
 * that test calls `resetTurnDedup()` before its assertions (the flood caps
 * are module-global, so a fixture wants a clean bucket). Resetting
 * guarantees the wake fits, so it can only observe that the wake is
 * REQUESTED with triggerTurn:true: never that it is DROPPED. This file
 * never resets between the fills and the wake: the bucket is spent at the
 * per-source cap first, then the handler runs, exactly as in a live turn
 * where enforcement has already spoken three times.
 *
 * THE FIX: `sendEnforcementWhisper` forwards `bypassFloodCap: true` to the
 * funnel at this one call site (the resume wake). The wrapper's default
 * stays false, so every other enforcement whisper keeps the cap; the test at
 * the bottom pins that default so the bypass cannot drift into the wrapper.
 *
 * Runs against the compiled dist (npm test builds first).
 *
 * Run: node test/runtime/enforcement/test-post-compaction-resume-flood-cap.mjs
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
const { sendEnforcementWhisper } = await import(
  join(ROOT, "dist/extensions/enforcement/whisper.js")
);
const { getState } = await import(join(ROOT, "dist/extensions/enforcement/state.js"));
const { getExtensionState } = await import(join(ROOT, "dist/lib/state/extension-state.js"));
const { registerWakeGate, resetWakeGateForTests } = await import(
  join(ROOT, "dist/lib/utils/wake-gate.js")
);
const {
  _resetForTests: resetTurnDedup,
  _snapshot: snapshotTurnDedup,
  getPerSourceCap,
  WHISPER_CAPS,
} = await import(join(ROOT, "dist/lib/enforcement/turn-dedup.js"));
const { clearAllBuckets, sendTrackedMessage } = await import(
  join(ROOT, "dist/lib/utils/injection-tracker.js")
);

const RESUME_SOURCE = "enforcement/whisper";

console.log("=== post-compaction resume wake vs. the whisper flood cap ===\n");

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
  const sessionId = "resume-cap-" + Math.random().toString(36).slice(2, 8);
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

/** Both the handler's setTimeout(0) and the funnel's triggerTurn deferral. */
const settle = () => new Promise((r) => setTimeout(r, 120));

/**
 * Fresh process-global turn state, then three enforcement whispers into the
 * SAME source and priority tier as the resume wake, delivered in this turn.
 * Nothing resets the cap after this point: that omission IS the test.
 */
async function spentTurn(pi, ctx) {
  resetWakeGateForTests();
  resetTurnDedup();
  clearAllBuckets();
  registerWakeGate(pi);
  registerSessionCompactHandler(pi);

  const state = getState(ctx);
  state.enforcementActive = true;
  state.lastTurnWasNaturalStop = true;
  state.autoResumeAfterCompaction = true;

  const cap = getPerSourceCap(RESUME_SOURCE);
  assert.equal(cap, 3, "fixture assumes the enforcement/whisper per-source cap is 3");
  assert.ok(
    WHISPER_CAPS.high <= cap,
    `fixture assumes the high tier cap (${WHISPER_CAPS.high}) is not looser than the per-source cap (${cap})`,
  );
  for (let i = 0; i < cap; i++) {
    sendEnforcementWhisper(pi, ctx, `filler enforcement whisper ${i + 1}`, false, {
      triggerTurn: true,
    });
  }
  await settle();
  assert.equal(
    pi.sent.length,
    cap,
    `all ${cap} filler whispers must be delivered before the bucket counts as spent`,
  );
  assert.equal(
    snapshotTurnDedup().whisperBySource[RESUME_SOURCE],
    cap,
    "the enforcement/whisper bucket is spent at its per-source cap",
  );
  return cap;
}

async function emitAgentRequestedCompact(pi, ctx) {
  const before = pi.sent.length;
  await pi._emit(
    {
      type: "session_compact",
      reason: "manual",
      willRetry: false,
      compactionEntry: { id: "c1", summary: "test" },
      fromExtension: true,
    },
    ctx,
  );
  await settle();
  return pi.sent.slice(before);
}

function isWake(s) {
  return s.options?.triggerTurn === true && s.options?.deliverAs === undefined;
}

function bodyOf(s) {
  return (s.params?.content ?? []).map((c) => c.text ?? "").join(" ");
}

// ── The regression ──────────────────────────────────────────────────────────

await test("3 enforcement whispers spent this turn → the resume wake still reaches pi.sendMessage", async () => {
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  await spentTurn(pi, ctx);

  // No reset between the fills and the wake: that is the whole point.
  const after = await emitAgentRequestedCompact(pi, ctx);

  assert.equal(
    after.length,
    1,
    "exactly one re-orientation message must reach pi.sendMessage even though the " +
      "enforcement/whisper bucket was already spent at its cap; got " +
      `${after.length} (the wake was dropped, the loop is never handed back)`,
  );
  assert.ok(
    isWake(after[0]),
    `the surviving message must be the wake (triggerTurn:true, deliverAs undefined); got ` +
      `triggerTurn=${after[0].options?.triggerTurn} deliverAs=${after[0].options?.deliverAs}`,
  );
  const suppressionRecorded =
    snapshotTurnDedup().suppressed > 0 || snapshotTurnDedup().whisperBySource[RESUME_SOURCE] === 3;
  assert.ok(
    suppressionRecorded,
    "sanity: the spent turn state is still in place after the wake (no reset happened)",
  );
});

await test("a turn whose high tier is spent by OTHER sources → the resume wake still arrives", async () => {
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  resetWakeGateForTests();
  resetTurnDedup();
  clearAllBuckets();
  registerWakeGate(pi);
  registerSessionCompactHandler(pi);
  const state = getState(ctx);
  state.enforcementActive = true;
  state.lastTurnWasNaturalStop = true;
  state.autoResumeAfterCompaction = true;

  // Spend the high TIER (WHISPER_CAPS.high, all sources combined) without
  // touching the enforcement/whisper bucket: proof that the wake survives the
  // funnel's cap, not just a raised per-source number.
  const spenders = [
    { source: "compaction-retry", count: 2 },
    { source: "threshold-exhausted", count: 1 },
  ];
  for (const spender of spenders) {
    for (let i = 0; i < spender.count; i++) {
      sendTrackedMessage(
        pi,
        { customType: "other", content: [{ type: "text", text: `${spender.source} ${i}` }] },
        { triggerTurn: true },
        { type: "other", source: spender.source },
      );
    }
  }
  await settle();
  assert.equal(pi.sent.length, 3, "the three high-tier spenders must be delivered");
  assert.equal(
    snapshotTurnDedup().whisperCounts.high,
    WHISPER_CAPS.high,
    "the high tier is spent (total cap reached) before the wake",
  );
  assert.equal(
    snapshotTurnDedup().whisperBySource[RESUME_SOURCE],
    undefined,
    "the enforcement/whisper bucket itself is untouched in this fixture",
  );

  const after = await emitAgentRequestedCompact(pi, ctx);
  assert.equal(
    after.length,
    1,
    "the resume wake must not be blocked by a high tier spent by other sources; got " +
      `${after.length}`,
  );
  assert.ok(isWake(after[0]), "the surviving message must be the wake");
});

await test("the same spent turn still caps the unpersisted-learnings advisory", async () => {
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  await spentTurn(pi, ctx);
  // Plant an unpersisted learning so the handler's OTHER whisper (the
  // nextTurn advisory, not a wake) fires in the same deferred batch.
  getExtensionState(ctx, "scratchpad-cache", () => ({
    pad: {
      key_learnings: [{ content: "a learning worth keeping", category: "insight", persisted: false }],
    },
  }));

  const after = await emitAgentRequestedCompact(pi, ctx);

  assert.equal(after.length, 1, "only the wake may get through a spent bucket");
  assert.ok(isWake(after[0]), "the single surviving message must be the wake");
  assert.ok(
    !after.some((s) => bodyOf(s).includes("not yet persisted")),
    "the unpersisted-learnings advisory is not a wake and must stay capped",
  );
});

await test("spent turn + auto threshold after a natural stop → the parked re-orientation is delivered too", async () => {
  // The re-orientation call has two delivery arms; the park arm is the auto
  // path where the agent finished before compaction. It is still the message
  // that carries the post-compaction context, so it opts into the same bypass
  // Rewritten as an assertion so a future narrowing of the bypass to one arm
  // shows up as a failure rather than as a silent scope change.
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  await spentTurn(pi, ctx);
  const state = getState(ctx);
  state.autoResumeAfterCompaction = false; // the agent did not request the resume
  state.lastTurnWasNaturalStop = true;

  const before = pi.sent.length;
  await pi._emit(
    {
      type: "session_compact",
      reason: "threshold",
      willRetry: false,
      compactionEntry: { id: "c1", summary: "test" },
    },
    ctx,
  );
  await settle();
  const after = pi.sent.slice(before);
  assert.equal(
    after.length,
    1,
    "the parked re-orientation must survive a spent bucket; got " + `${after.length}`,
  );
  assert.equal(
    after[0].options?.triggerTurn,
    false,
    "the park arm must stay advisory (no forced continuation turn)",
  );
  assert.equal(after[0].options?.deliverAs, "steer", "the park arm keeps its steer delivery class");
});

await test("bypass is per call: a spent turn still suppresses a plain wrapper send", async () => {
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  await spentTurn(pi, ctx);

  const before = pi.sent.length;
  sendEnforcementWhisper(pi, ctx, "post-cap enforcement whisper without the bypass", false, {
    triggerTurn: true,
  });
  await settle();
  assert.equal(
    pi.sent.length,
    before,
    "sendEnforcementWhisper must keep the flood cap by default (bypassFloodCap is opt-in)",
  );

  sendEnforcementWhisper(pi, ctx, "enforcement whisper that opts into the bypass", false, {
    triggerTurn: true,
    bypassFloodCap: true,
  });
  await settle();
  assert.equal(pi.sent.length, before + 1, "bypassFloodCap:true must skip the spent cap");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
