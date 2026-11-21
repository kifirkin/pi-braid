/**
 * A babysit timer names workers once, and only workers that still exist.
 *
 * The turn-end device arms one timer whose reason is a snapshot: the live
 * workers that no pending timer names. Armed as a recurrence, that sentence is
 * re-delivered every interval for as long as the process lives, whether or not
 * the workers it names still exist, and the store keeps one such timer for every
 * dispatch the session ever left uncovered: one seat session held four at once,
 * three of them naming workers that had already closed, and each fire cost a
 * wake and a manual cancel.
 *
 * What this pins:
 *   1. an uncovered live worker gets exactly one timer, and it is a single fire;
 *   2. a fire removes that timer, and the next turn end re-derives a new one
 *      from the registry instead of letting the old sentence repeat;
 *   3. a worker closed between turn ends is not named by the next arm;
 *   4. a timer whose every named worker has closed is withdrawn, and the
 *      withdrawal is reported in the settle line;
 *   5. an empty fleet withdraws everything and arms nothing;
 *   6. control: a pending timer that names an open worker is left untouched and
 *      the timer count does not change - an arm that withdrew everything would
 *      pass 3-5 and fail this one;
 *   7. a worker id carrying a dot is matched, so a seat's own timer for such a
 *      worker still counts.
 *
 * Hermetic: HOME and PI_CODING_AGENT_DIR are pinned into a scratch root and
 * BRAID_HOME is cleared before the dist imports, so every registry read, timer
 * write and settings read lands in the scratch tree. HERDR_ENV is cleared
 * because this device never speaks to herdr, and the role marker is cleared so
 * no worker role leaks in from the shell that runs the suite.
 *
 * Run: node --test packages/core/test/runtime/orchestrator/test-babysit-cadence.mjs
 * (after npm run build)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "babysit-cadence-"));
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
const { timerManager } = await import(
  "../../../dist/extensions/scheduling/timer/timer-manager.js"
);
const { clearLogBuffer, getLogBuffer } = await import("../../../dist/lib/core/logger.js");
const { getSettingsPath } = await import("../../../dist/lib/config/per-tool-settings.js");

// The scheduling module is registered in this process, as it is in every shipped
// configuration, and on its own surface so the orchestrator's handlers stay the
// only ones this file drives. Without it the arm has nothing that polls its store
// and declines to write one.
timerExtension({ tools: [], registerTool() {}, on() {} });

/** Every event the extension registered, so the turn end can be driven by hand. */
const handlers = new Map();
const fakePi = {
  tools: [],
  registerTool(definition) {
    this.tools.push(definition);
  },
  on(event, handler) {
    handlers.set(event, handler);
  },
};
orchestratorExtension(fakePi);
const orchestrateTool = fakePi.tools.find((tool) => tool.name === "orchestrate");
const turnEnd = handlers.get("turn_end");

/** The tag the device puts on every timer it arms. */
const BABYSIT_TAG = "orchestrator-babysit";

/**
 * The reason shape the device writes. The withdrawal decision reads it back, so
 * a planted timer that is meant to look like one of the device's own carries the
 * same shape.
 */
const reasonFor = (...workerIds) =>
  `babysit ${workerIds.join(", ")}: live worker(s) this session owns with no timer naming them`;

/** A session context: the state key and the timer scope both read it. */
function sessionCtx(sessionId) {
  const file = join(FAKE_HOME, `${sessionId}.jsonl`);
  return {
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => sessionId,
    },
  };
}

/** A project directory with no registry of its own. */
const scratchProject = () => mkdtempSync(join(tmpdir(), "babysit-project-"));

const run = (ctx, params) =>
  orchestrateTool.execute("call-1", params, new AbortController().signal, undefined, ctx);

/** Admit one row at `cwd`; this is also what claims the project for the session. */
const admit = (ctx, cwd, workerId) =>
  run(ctx, { action: "register-worker", workerId, spec: "impl", cwd, outputFile: join(cwd, "r.md") });

const close = (ctx, cwd, workerId) =>
  run(ctx, { action: "close-worker", workerId, outcome: "closed", cwd });

const babysitTimers = (sessionId) =>
  listTimers(sessionId).filter((timer) => timer.tag === BABYSIT_TAG);

/** The settle lines the turn-end handler wrote, newest last. */
const settleLines = () =>
  getLogBuffer()
    .filter((entry) => entry.source === "orchestrator" && entry.message.includes("settle:"))
    .map((entry) => entry.message);
const lastSettleLine = () => settleLines().at(-1) ?? "";

/** Drive a turn end with the settle line captured from a clean buffer. */
function settle(ctx) {
  clearLogBuffer();
  turnEnd({}, ctx);
  return lastSettleLine();
}

/** Run `body` with a settle delay short enough to expire in the same tick. */
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

describe("babysit cadence", () => {
  it("arms one single-fire timer naming an uncovered live worker", async () => {
    const repo = scratchProject();
    const ctx = sessionCtx("sess-cadence-one");
    await admit(ctx, repo, "w-live-one");
    assert.equal(listTimers("sess-cadence-one").length, 0, "nothing is armed before the turn ends");

    turnEnd({}, ctx);

    const timers = listTimers("sess-cadence-one");
    assert.equal(timers.length, 1, "exactly one timer after the turn end");
    assert.match(timers[0].reason, /babysit w-live-one:/, "the reason names the worker it watches");
    assert.equal(
      timers[0].intervalMs,
      undefined,
      "a single fire: a sentence about who is unwatched cannot be re-delivered on a cadence",
    );
    assert.equal(timers[0].count, undefined, "no repeat count either");
    assert.equal(timers[0].sessionId, "sess-cadence-one", "the fire is attributed to the seat's session");
    assert.equal(timers[0].wake, true, "the fire must start a turn, or it wakes nobody");
    assert.equal(timers[0].tag, BABYSIT_TAG, "the arm is identifiable for the next withdrawal");
    assert.ok(timers[0].firesAt > Date.now(), "the fire is ahead of the settle, not behind it");
  });

  it("re-derives after the fire instead of letting one sentence repeat", async () => {
    const repo = scratchProject();
    const ctx = sessionCtx("sess-cadence-refire");
    await admit(ctx, repo, "w-live-two");

    const first = withSettleDelay(5, () => {
      turnEnd({}, ctx);
      const armed = listTimers("sess-cadence-refire");
      assert.equal(armed.length, 1, "the first turn end arms");
      // A fire is the manager's own removal at expiry, not a cancel: the wake is
      // delivered and the timer is gone. Driving the same removal here is what
      // makes "a second turn end with the worker still uncovered" reachable
      // without waiting out a real delay.
      const fired = timerManager.checkExpired("sess-cadence-refire", Date.now() + 50);
      assert.equal(fired.length, 1, "the timer expired");
      assert.equal(
        listTimers("sess-cadence-refire").length,
        0,
        "a single fire leaves nothing behind, so the sentence cannot repeat",
      );
      return armed[0].id;
    });

    turnEnd({}, ctx);

    const rearmed = listTimers("sess-cadence-refire");
    assert.equal(rearmed.length, 1, "the next turn end arms again while the worker is uncovered");
    assert.notEqual(rearmed[0].id, first, "it is a new timer, not the fired one");
    assert.match(rearmed[0].reason, /babysit w-live-two:/, "and it names the worker from the registry");
  });

  it("never names a worker closed between turn ends", async () => {
    const repo = scratchProject();
    const ctx = sessionCtx("sess-cadence-closed");
    await admit(ctx, repo, "w-open-then-closed");
    turnEnd({}, ctx);
    const [first] = babysitTimers("sess-cadence-closed");
    assert.ok(first, "the first turn end arms for the open worker");

    await close(ctx, repo, "w-open-then-closed");
    await admit(ctx, repo, "w-newly-live");
    const note = settle(ctx);

    const timers = babysitTimers("sess-cadence-closed");
    assert.equal(timers.length, 1, "one cadence, not one per worker the session ever dispatched");
    assert.notEqual(timers[0].id, first.id, "the timer that named the closed worker is gone");
    assert.match(timers[0].reason, /babysit w-newly-live:/, "the next arm names the worker that is open");
    assert.doesNotMatch(timers[0].reason, /w-open-then-closed/, "the closed worker is not named again");
    assert.match(note, /withdrew 1/, "the withdrawal is reported, not silent");
  });

  it("withdraws a timer whose every named worker has closed, and reports it", async () => {
    const repo = scratchProject();
    const ctx = sessionCtx("sess-cadence-withdraw");
    await admit(ctx, repo, "w-gone");
    await close(ctx, repo, "w-gone");
    await admit(ctx, repo, "w-still-open");
    const stale = scheduleTimer(
      "sess-cadence-withdraw",
      60_000,
      reasonFor("w-gone"),
      BABYSIT_TAG,
      true,
      300_000,
    );

    const note = settle(ctx);

    const timers = babysitTimers("sess-cadence-withdraw");
    assert.equal(timers.length, 1, "the stale cadence is withdrawn and one fresh timer stands");
    assert.notEqual(timers[0].id, stale, "the withdrawn timer is the one that named only a closed worker");
    assert.match(timers[0].reason, /babysit w-still-open:/, "the surviving timer names the open worker");
    assert.match(note, /withdrew 1 babysit timer/, "the settle line reports the withdrawal");
    assert.match(note, /w-still-open/, "and names what it armed");
  });

  it("withdraws every cadence and arms nothing when the fleet is empty", async () => {
    const repo = scratchProject();
    const ctx = sessionCtx("sess-cadence-empty");
    await admit(ctx, repo, "w-closed-a");
    await admit(ctx, repo, "w-closed-b");
    await close(ctx, repo, "w-closed-a");
    await close(ctx, repo, "w-closed-b");
    scheduleTimer("sess-cadence-empty", 60_000, reasonFor("w-closed-a"), BABYSIT_TAG, true, 300_000);
    scheduleTimer("sess-cadence-empty", 60_000, reasonFor("w-closed-b"), BABYSIT_TAG, true, 300_000);

    const note = settle(ctx);

    assert.equal(listTimers("sess-cadence-empty").length, 0, "nothing is left watching a closed fleet");
    assert.match(note, /withdrew 2 babysit timer/, "both withdrawals are reported in one line");
    assert.doesNotMatch(note, /armed/, "an empty fleet is not a reason to wake the seat");
  });

  it("leaves a pending cadence that names an open worker untouched", async () => {
    const repo = scratchProject();
    const ctx = sessionCtx("sess-cadence-control");
    await admit(ctx, repo, "w-covered");
    const cadence = scheduleTimer(
      "sess-cadence-control",
      60_000,
      reasonFor("w-covered"),
      BABYSIT_TAG,
      true,
    );
    const seatTimer = scheduleTimer(
      "sess-cadence-control",
      60_000,
      "check w-covered progress before the merge",
      undefined,
      false,
    );

    settle(ctx);

    const timers = listTimers("sess-cadence-control");
    assert.equal(timers.length, 2, "a timer that names an open worker is never withdrawn, tagged or not");
    const ids = timers.map((timer) => timer.id);
    assert.ok(ids.includes(cadence), "the tagged cadence still names an open worker, so it stands");
    assert.ok(ids.includes(seatTimer), "a timer this device did not arm is never touched");
    assert.equal(
      timers.find((timer) => timer.id === cadence).reason,
      reasonFor("w-covered"),
      "and its reason is not rewritten under it",
    );
  });

  it("matches a worker id that carries a dot", async () => {
    const repo = scratchProject();
    const ctx = sessionCtx("sess-cadence-dotted");
    await admit(ctx, repo, "w-live.2");
    const mine = scheduleTimer(
      "sess-cadence-dotted",
      60_000,
      "check w-live.2 before the merge",
      undefined,
      false,
    );

    const note = settle(ctx);

    const timers = listTimers("sess-cadence-dotted");
    assert.equal(timers.length, 1, "the named timer covers the worker: no cadence is added");
    assert.equal(timers[0].id, mine, "the seat's timer stands");
    assert.doesNotMatch(note, /armed/, "nothing was armed");
  });
});
