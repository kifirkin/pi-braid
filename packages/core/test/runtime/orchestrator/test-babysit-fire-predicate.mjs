/**
 * A babysit wake re-derives its fact at fire time, not at arm time.
 *
 * The settle-time device arms one single-fire timer whose reason asserts that a
 * set of live workers has no timer naming them. That set is measured at the
 * turn end and the whisper is delivered `settleDelayMs` later. A seat that arms
 * its own checkpoint timer in that window (the normal case - the seat is
 * working the same dispatch) leaves the wake carrying a sentence that is
 * already false, and the wake costs a turn that had nothing to do.
 *
 * What this pins:
 *   1. reproduction: a cadence whose named worker gains a naming timer after
 *      the arm delivers no whisper, while the cadence itself is still dropped
 *      like any other fired timer. This case is red on the unfixed tree.
 *   2. positive control: the same cadence with no naming timer still fires,
 *      still wakes, and still carries its reason - a suppression that silences
 *      this case is worse than the duplicate it prevents.
 *   3. redelivery: a fire parked by a busy session is withheld when a naming
 *      timer appears before its late delivery, and delivered when none does.
 *
 * The wake is read where the agent reads it: the fake `pi.sendMessage`. A fire
 * that is withheld leaves the buffer empty; the store's own log still records
 * that the timer fired and that its whisper was withheld.
 *
 * Hermetic: HOME and PI_CODING_AGENT_DIR are pinned into a scratch root and
 * BRAID_HOME is cleared before the dist imports, so every registry read, timer
 * write and settings read lands in the scratch tree. HERDR_ENV is cleared
 * because this device never speaks to herdr, and the role marker is cleared so
 * no worker role leaks in from the shell that runs the suite.
 *
 * Run: node --test packages/core/test/runtime/orchestrator/test-babysit-fire-predicate.mjs
 * (after npm run build)
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "babysit-fire-"));
process.env.HOME = FAKE_HOME;
process.env.PI_CODING_AGENT_DIR = join(FAKE_HOME, ".pi", "agent");
delete process.env.BRAID_HOME;
delete process.env.HERDR_ENV;
delete process.env.HERDR_PANE_ID;
delete process.env.BRAID_SESSION_ROLE;

const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);
const { default: timerExtension, listTimers, scheduleTimer } = await import(
  "../../../dist/extensions/scheduling/timer/index.js"
);
const { wakeRetryQueue, WAKE_RETRY_BACKOFF_MS } = await import(
  "../../../dist/extensions/scheduling/timer/wake-retry.js"
);
const { registerWakeGate, resetWakeGateForTests } = await import(
  "../../../dist/lib/utils/wake-gate.js"
);
const { clearLogBuffer, getLogBuffer } = await import("../../../dist/lib/core/logger.js");
const { getSettingsPath } = await import("../../../dist/lib/config/per-tool-settings.js");

/** The tag the device puts on every timer it arms. */
const BABYSIT_TAG = "orchestrator-babysit";

/** A settle delay short enough to expire inside a test, long enough to be a gap. */
const SETTLE_DELAY_MS = 30;

/**
 * A whole extension stack over one fake session: the timer store, the wake gate
 * (production wiring, and what tells the send whether the session is busy) and
 * the orchestrator. One harness per test, because the timer extension's poller
 * is a factory closure bound to the session it started with.
 */
function makeHarness() {
  const handlers = new Map();
  const sent = [];
  const pi = {
    tools: [],
    sent,
    registerTool(definition) {
      this.tools.push(definition);
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(params, options) {
      sent.push({ params, options });
    },
  };
  timerExtension(pi);
  registerWakeGate(pi);
  orchestratorExtension(pi);
  return {
    sent,
    orchestrate: pi.tools.find((tool) => tool.name === "orchestrate"),
    emit(event, payload = {}, ctx = {}) {
      for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
    },
  };
}

/** A session context whose liveness the wake gate and the timer poller can read. */
function sessionCtx(sessionId, isIdle = () => true) {
  const file = join(FAKE_HOME, `${sessionId}.jsonl`);
  return {
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => sessionId,
    },
    isIdle,
    signal: undefined,
  };
}

const scratchProject = () => mkdtempSync(join(tmpdir(), "babysit-fire-project-"));

const run = (harness, ctx, params) =>
  harness.orchestrate.execute(
    "call-1",
    params,
    new AbortController().signal,
    undefined,
    ctx,
  );

/** Admit one row at `cwd`; this is also what claims the project for the session. */
const admit = (harness, ctx, cwd, workerId) =>
  run(harness, ctx, {
    action: "register-worker",
    workerId,
    spec: "impl",
    cwd,
    outputFile: join(cwd, "r.md"),
  });

const babysitTimers = (sessionId) =>
  listTimers(sessionId).filter((timer) => timer.tag === BABYSIT_TAG);

/** Run `body` with a settle delay short enough to expire in the same test. */
function withSettleDelay(delayMs, body) {
  const file = getSettingsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ broker: { orchestrator: { settleDelayMs: delayMs } } }));
  try {
    return body();
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * Two macrotask hops: the fire path defers twice (fireExpired's setTimeout(0)
 * then sendTrackedMessage's own setTimeout(0) for a triggerTurn send).
 */
function flushDeferred() {
  return new Promise((resolve) => setTimeout(() => setTimeout(resolve, 0), 0));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The timer module's own lines, newest last. */
const timerLines = () =>
  getLogBuffer()
    .filter((entry) => entry.source === "timer")
    .map((entry) => entry.message)
    .join("\n");

afterEach(() => {
  wakeRetryQueue.resetForTests();
  wakeRetryQueue._setClockForTests(null);
  resetWakeGateForTests();
  clearLogBuffer();
});

describe("babysit fire-time predicate", () => {
  it("withholds the wake when a timer naming the worker was armed after the cadence", async () => {
    const repo = scratchProject();
    const ctx = sessionCtx("sess-fire-covered");
    const harness = makeHarness();
    harness.emit("session_start", {}, ctx);
    await admit(harness, ctx, repo, "w-fire-covered");

    withSettleDelay(SETTLE_DELAY_MS, () => harness.emit("turn_end", {}, ctx));
    const [cadence] = babysitTimers("sess-fire-covered");
    assert.ok(cadence, "pre-condition: the settle armed a cadence");
    assert.match(cadence.reason, /babysit w-fire-covered:/);

    // The seat's own checkpoint timer, armed AFTER the cadence, names the same
    // worker: the sentence the cadence carries is now false.
    const naming = scheduleTimer(
      "sess-fire-covered",
      60_000,
      "check w-fire-covered progress before the merge",
      undefined,
      false,
    );

    await sleep(SETTLE_DELAY_MS + 50);
    harness.emit("tool_execution_end", {}, ctx);
    await flushDeferred();

    assert.equal(
      harness.sent.length,
      0,
      "no whisper: the fact the cadence would assert was re-derived and no longer holds",
    );
    assert.deepEqual(
      listTimers("sess-fire-covered").map((timer) => timer.id),
      [naming],
      "the cadence is dropped like any fired timer; the seat's naming timer stands",
    );
    assert.match(timerLines(), /fire withheld/, "the suppression is logged, not silent");
    harness.emit("session_shutdown", {}, ctx);
  });

  it("still fires and carries its reason when nothing names the worker", async () => {
    const repo = scratchProject();
    const ctx = sessionCtx("sess-fire-open");
    const harness = makeHarness();
    harness.emit("session_start", {}, ctx);
    await admit(harness, ctx, repo, "w-fire-open");

    withSettleDelay(SETTLE_DELAY_MS, () => harness.emit("turn_end", {}, ctx));
    assert.equal(babysitTimers("sess-fire-open").length, 1, "the settle armed a cadence");

    await sleep(SETTLE_DELAY_MS + 50);
    harness.emit("tool_execution_end", {}, ctx);
    await flushDeferred();

    assert.equal(harness.sent.length, 1, "the wake is delivered");
    const [fire] = harness.sent;
    assert.equal(fire.options.triggerTurn, true, "it still wakes the seat");
    const text = fire.params.content[0].text;
    assert.match(text, /babysit w-fire-open:/, "it still names the worker it watches");
    assert.match(
      text,
      /live worker\(s\) this session owns with no timer naming them/,
      "the reason is not rewritten",
    );
    assert.equal(listTimers("sess-fire-open").length, 0, "the fire leaves nothing behind");
    harness.emit("session_shutdown", {}, ctx);
  });

  it("withholds a parked fire's late delivery when a naming timer appears meanwhile", async () => {
    const repo = scratchProject();
    let idle = false; // busy: no wake can be sent inline
    const ctx = sessionCtx("sess-fire-parked-covered", () => idle);
    const harness = makeHarness();
    wakeRetryQueue._setMaxAttemptsForTests(1); // one busy rung, then the fire parks
    harness.emit("session_start", {}, ctx);
    await admit(harness, ctx, repo, "w-fire-parked");

    withSettleDelay(SETTLE_DELAY_MS, () => harness.emit("turn_end", {}, ctx));
    await sleep(SETTLE_DELAY_MS + 50);
    harness.emit("tool_execution_end", {}, ctx); // expire: send is held by the busy session
    await flushDeferred();
    assert.equal(harness.sent.length, 0, "pre-condition: the send was held");

    // The one busy rung redelivers into a still-busy session: the ladder is
    // spent and the fire is parked, never dropped.
    wakeRetryQueue._setClockForTests(() => Date.now() + WAKE_RETRY_BACKOFF_MS[0]);
    harness.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(harness.sent.length, 0, "pre-condition: still held");
    assert.equal(wakeRetryQueue.outstandingCount(), 1, "pre-condition: the fire is parked");

    // The seat re-arms its own checkpoint timer while the fire waits.
    scheduleTimer(
      "sess-fire-parked-covered",
      60_000,
      "check w-fire-parked progress before the merge",
      undefined,
      false,
    );

    // The session goes idle: the parked fire gets its one late delivery.
    idle = true;
    harness.emit("agent_settled", {}, ctx);
    await flushDeferred();

    assert.equal(harness.sent.length, 0, "the late delivery is withheld, not delivered");
    assert.equal(wakeRetryQueue.outstandingCount(), 0, "the fire is dropped, not re-queued");
    assert.match(timerLines(), /fire withheld/, "the suppression is logged, not silent");
    harness.emit("session_shutdown", {}, ctx);
  });

  it("delivers a parked fire's late delivery when nothing names the worker", async () => {
    const repo = scratchProject();
    let idle = false;
    const ctx = sessionCtx("sess-fire-parked-open", () => idle);
    const harness = makeHarness();
    wakeRetryQueue._setMaxAttemptsForTests(1);
    harness.emit("session_start", {}, ctx);
    await admit(harness, ctx, repo, "w-fire-parked-open");

    withSettleDelay(SETTLE_DELAY_MS, () => harness.emit("turn_end", {}, ctx));
    await sleep(SETTLE_DELAY_MS + 50);
    harness.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    wakeRetryQueue._setClockForTests(() => Date.now() + WAKE_RETRY_BACKOFF_MS[0]);
    harness.emit("tool_execution_end", {}, ctx);
    await flushDeferred();
    assert.equal(harness.sent.length, 0, "pre-condition: the fire is parked");
    assert.equal(wakeRetryQueue.outstandingCount(), 1);

    idle = true;
    harness.emit("agent_settled", {}, ctx);
    await flushDeferred();

    assert.equal(harness.sent.length, 1, "the parked fire is delivered late");
    const text = harness.sent[0].params.content[0].text;
    assert.match(text, /babysit w-fire-parked-open:/, "it still carries its reason");
    assert.match(text, /held while the session was busy/, "and states the hold honestly");
    harness.emit("session_shutdown", {}, ctx);
  });
});
