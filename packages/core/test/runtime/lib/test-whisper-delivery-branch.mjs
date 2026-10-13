/**
 * Branch pin: the injection funnel's delivery contract, asserted against the
 * real installed pi-core `AgentSession.sendCustomMessage`.
 *
 * WHY THIS EXISTS
 * pi 0.84.2 changed what `pi.sendMessage(..., { triggerTurn: false })` does
 * while a run is streaming: it no longer steers, it parks the message to the
 * end-of-turn flush (branch 4). Braid's funnel used that shape for every
 * non-waking whisper, so whispers meant for the running loop were silently
 * deferred. The funnel now takes an explicit delivery class ("live" | "park")
 * and translates it into the pi-core option shape; the wake-gate rewrites a
 * gated wake to the live shape. This test pins the BRANCH each shape takes
 * against the installed runtime, not the option strings: a future pi change
 * to the branch order fails here loudly instead of silently re-routing the
 * channel.
 *
 * HOW
 * A session double built on the REAL AgentSession prototype (the fields the
 * method reads are stubbed; the branch logic is the installed code), a fake
 * `pi.sendMessage` that forwards to it, and sends driven through the built
 * funnel (`sendTrackedMessage`) and the built wake-gate. The five branches:
 *   1. deliverAs "nextTurn"        -> _pendingNextTurnMessages
 *   2. streaming, triggerTurn !== false -> agent.steer()/followUp() (the only
 *      branch that reaches a live run)
 *   3. triggerTurn (truthy)        -> _runAgentPrompt (starts a run)
 *   4. streaming                   -> _pendingCustomMessages (end-of-turn park)
 *   5. otherwise                   -> _appendCustomMessage (appended now)
 *
 * RED before the funnel class translation: the "park" case steers (branch 2)
 * and the gated wake parks (branch 4). GREEN after.
 *
 * NOTE: depends on braid.suppressNudges not being true in settings.json
 * (sendTrackedMessage bails when cognitive nudges are disabled globally).
 *
 * The last three cases pin the unresolved-advisory registry against the same
 * real prototype: an advisory send registers an in-flight entry whose id
 * rides in the message details, and the real append path's
 * message_start/message_end events retire it; a suppressed send never
 * registers. The registry is what an emitter checks to refuse stacking a
 * second advisory behind one that has not landed yet.
 *
 * Run: node test/runtime/lib/test-whisper-delivery-branch.mjs
 *      (after npm run build - this test reads dist, not src)
 */

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Real installed pi-core, resolved like the other runtime tests. Subpath
// imports of the package are not exported; import the dist file by URL.
const piEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const piDist = dirname(fileURLToPath(piEntryUrl));
const { AgentSession } = await import(
  pathToFileURL(join(piDist, "core", "agent-session.js")).href
);

const { sendTrackedMessage, clearAllBuckets, registerInjectionTracker, hasUnresolvedAdvisory } =
  await import("../../../dist/lib/utils/injection-tracker.js");
const { registerWakeGate, resetWakeGateForTests } =
  await import("../../../dist/lib/utils/wake-gate.js");

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

console.log("=== whisper delivery branch pin (real pi-core sendCustomMessage) ===\n");

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Session double on the real prototype: `isStreaming` reads
 * `_isAgentRunActive`, and every branch effect is recorded. Branch 3/5
 * effects are stubbed - the branch DECISION is what is pinned.
 */
function makeSession({ streaming, emit }) {
  const calls = { steer: [], followUp: [], append: [], run: [] };
  const session = Object.create(AgentSession.prototype);
  session._isAgentRunActive = streaming;
  session._isEmittingAgentSettled = false;
  session._deferredSettledActions = [];
  session._pendingNextTurnMessages = [];
  session._pendingCustomMessages = [];
  session.agent = {
    steer: (m) => calls.steer.push(m),
    followUp: (m) => calls.followUp.push(m),
  };
  session._runAgentPrompt = (m) => {
    calls.run.push(m);
    return Promise.resolve();
  };
  session._appendCustomMessage = (m) => {
    calls.append.push(m);
    // Real pi-core emits both events at append (`_appendCustomMessage`,
    // agent-session.js:1821-1828). The double replays them through the fake
    // pi so the extension handlers see what a real append delivers.
    emit?.({ type: "message_start", message: m });
    emit?.({ type: "message_end", message: m });
  };
  return { session, calls };
}

function makePi(session) {
  const handlers = new Map();
  return {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(params, options) {
      void session.sendCustomMessage(params, options);
    },
    sendUserMessage() {},
    _emit(event, payload) {
      for (const h of handlers.get(event) ?? []) {
        Promise.resolve(h(payload ?? event)).catch(() => {});
      }
    },
  };
}

let seq = 0;
/**
 * One send through the funnel. The default body embeds the sequence inside a
 * word (`s1x`) so the digit-collapsing reprime key stays unique per call; a
 * caller that passes `body` opts into repeat suppression deliberately.
 */
function send(pi, options, meta = {}, body) {
  seq++;
  return sendTrackedMessage(
    pi,
    {
      customType: "branch-probe",
      content: [{ type: "text", text: body ?? `branch probe s${seq}x` }],
      display: true,
    },
    options,
    { type: "context", source: `branch-probe/${seq}`, ...meta },
    { bypassFloodCap: true },
  );
}

function fresh(streaming) {
  resetWakeGateForTests();
  clearAllBuckets();
  let pi;
  const { session, calls } = makeSession({
    streaming,
    emit: (event) => pi?._emit(event.type, event),
  });
  pi = makePi(session);
  // The registry's retirement path is the tracker's message_start/message_end
  // handlers; register them like the enforcement bootstrap does.
  registerInjectionTracker(pi);
  return { session, calls, pi };
}

/** pi's own end-of-turn flush, called on the real prototype. */
function flushParked(session) {
  AgentSession.prototype._flushPendingCustomMessages.call(session);
}

/** sendTrackedMessage defers triggerTurn sends to setTimeout(0). */
function flushDeferred() {
  return new Promise((r) => setTimeout(r, 30));
}

// ── Branch pins ─────────────────────────────────────────────────────────────

await test("live class while streaming -> branch 2 (agent.steer), never parked", () => {
  const { session, calls, pi } = fresh(true);
  const accepted = send(pi, { delivery: "live", deliverAs: "steer" });
  assert.equal(accepted, true, "send must be accepted (nudges not disabled)");
  assert.equal(calls.steer.length, 1, "branch 2: agent.steer must be invoked");
  assert.equal(calls.followUp.length, 0, "steer, not followUp");
  assert.equal(session._pendingCustomMessages.length, 0, "branch 4 must not run");
  assert.equal(calls.append.length, 0, "branch 5 must not run");
  assert.equal(calls.run.length, 0, "a live send must not start a run");
});

await test("park class while streaming -> branch 4 (_pendingCustomMessages), never steers", () => {
  const { session, calls, pi } = fresh(true);
  const accepted = send(pi, { delivery: "park", deliverAs: "steer" });
  assert.equal(accepted, true, "send must be accepted (nudges not disabled)");
  assert.equal(calls.steer.length, 0, "branch 2 must not run: park must not steer");
  assert.equal(session._pendingCustomMessages.length, 1, "branch 4: parked to the end-of-turn flush");
  assert.equal(calls.append.length, 0, "branch 5 must not run");
  assert.equal(calls.run.length, 0);
});

await test("wake while idle -> branch 3 (_runAgentPrompt starts a run)", async () => {
  const { calls, pi } = fresh(false);
  send(pi, { triggerTurn: true });
  await flushDeferred();
  assert.equal(calls.run.length, 1, "branch 3: an idle wake starts a run");
  assert.equal(calls.steer.length, 0, "branch 2 must not run while idle");
});

await test("gated wake while streaming -> branch 2 (steer), not branch 4 (park)", async () => {
  const { session, calls, pi } = fresh(true);
  registerWakeGate(pi);
  pi._emit("session_before_compact"); // run region armed while the run streams
  send(pi, { triggerTurn: true });
  await flushDeferred();
  assert.equal(calls.steer.length, 1, "a gated wake must steer the live run (branch 2)");
  assert.equal(session._pendingCustomMessages.length, 0, "a gated wake must not park (branch 4)");
  assert.equal(calls.run.length, 0, "a gated wake must not start a competing run (branch 3)");
});

await test("gated wake in the pre-flight (idle, region armed) -> branch 5 (append), no run", async () => {
  const { calls, pi } = fresh(false);
  registerWakeGate(pi);
  pi._emit("before_agent_start"); // pre-flight tail: no run started yet
  send(pi, { triggerTurn: true });
  await flushDeferred();
  assert.equal(calls.append.length, 1, "pre-flight gated wake is appended for the imminent run (branch 5)");
  assert.equal(calls.run.length, 0, "must not start a competing run (branch 3)");
  assert.equal(calls.steer.length, 0, "branch 2 must not run while idle");
});

await test("live class while idle -> branch 5 (append), no run", () => {
  const { calls, pi } = fresh(false);
  send(pi, { delivery: "live", deliverAs: "steer" });
  assert.equal(calls.append.length, 1, "branch 5: appended for the next run");
  assert.equal(calls.run.length, 0, "a live whisper never starts a run by itself");
});

await test("park class while idle -> branch 5 (append)", () => {
  const { calls, pi } = fresh(false);
  send(pi, { delivery: "park", deliverAs: "steer" });
  assert.equal(calls.append.length, 1, "branch 5: appended for the next run");
  assert.equal(calls.run.length, 0);
});

await test("legacy shape (no class) passes through unchanged -> branch 4 while streaming", () => {
  const { session, calls, pi } = fresh(true);
  send(pi, { deliverAs: "steer", triggerTurn: false });
  assert.equal(calls.steer.length, 0, "a classless send must not be reinterpreted as live");
  assert.equal(session._pendingCustomMessages.length, 1, "branch 4: the legacy shape still parks");
});

await test("deliverAs nextTurn while streaming -> branch 1 (queued), untouched", () => {
  const { session, calls, pi } = fresh(true);
  send(pi, { deliverAs: "nextTurn" });
  assert.equal(
    session._pendingNextTurnMessages.length,
    1,
    "branch 1: queued for the next user prompt",
  );
  assert.equal(calls.steer.length, 0, "branch 1 must win over branch 2");
  assert.equal(session._pendingCustomMessages.length, 0);
});

await test("advisory send parks while streaming; the real append path retires it", () => {
  const { session, calls, pi } = fresh(true);
  const accepted = send(pi, { delivery: "park", deliverAs: "steer" }, { advisory: "probe" });
  assert.equal(accepted, true, "send must be accepted");
  assert.equal(calls.steer.length, 0, "the advisory must not steer");
  assert.equal(session._pendingCustomMessages.length, 1, "branch 4: parked for the turn-end flush");
  const parked = session._pendingCustomMessages[0];
  assert.equal(typeof parked.details?._braidId, "string", "the advisory id rides in details");
  assert.equal(hasUnresolvedAdvisory("probe"), true, "registered in flight at emission");

  flushParked(session);
  assert.equal(calls.append.length, 1, "the parked message is appended at the flush");
  assert.equal(hasUnresolvedAdvisory("probe"), false, "message_start/message_end retired it");
});

await test("advisory send while idle appends and retires in the same call", () => {
  const { calls, pi } = fresh(false);
  const accepted = send(pi, { delivery: "park", deliverAs: "steer" }, { advisory: "probe" });
  assert.equal(accepted, true, "send must be accepted");
  assert.equal(calls.append.length, 1, "branch 5: appended now");
  assert.equal(hasUnresolvedAdvisory("probe"), false, "the immediate append retired it");
});

await test("a suppressed repeat never registers an advisory", () => {
  const { session, pi } = fresh(true);
  const body = "advisory suppression probe";
  const first = send(pi, { delivery: "park", deliverAs: "steer" }, { advisory: "probe" }, body);
  assert.equal(first, true, "first occurrence passes");
  assert.equal(hasUnresolvedAdvisory("probe"), true, "first occurrence registers");
  const second = send(pi, { delivery: "park", deliverAs: "steer" }, { advisory: "probe" }, body);
  assert.equal(second, false, "the exact-repeat body is suppressed inside the reprime window");
  assert.equal(session._pendingCustomMessages.length, 1, "only the first occurrence was parked");
  flushParked(session);
  assert.equal(
    hasUnresolvedAdvisory("probe"),
    false,
    "the suppressed send left no in-flight entry behind",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
