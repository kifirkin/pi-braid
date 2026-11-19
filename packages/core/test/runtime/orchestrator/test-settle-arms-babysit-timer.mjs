/**
 * A settled turn does not leave a live worker unwatched.
 *
 * The seat arms its own babysit timers, and every one of those arms is a
 * discretionary tool call made after a dispatch. Measured over the seat's own
 * session corpus, that call follows a registry write 87% of the time, follows
 * nothing at all when the dispatch ends the turn (0%), and a timer is already
 * pending on 88% of worker-target dispatch turns but names the dispatched
 * worker on only 48%. There is no coupling to fix inside the turn, so the
 * device lives at the turn end: the state it acts on (a session settling with a
 * live worker nothing names) is true exactly there.
 *
 * What this pins:
 *   1. a live row and no timer naming it, at a project this session
 *      orchestrated in, arms exactly one timer whose reason names the worker,
 *      with an interval set and the seat's own session on it;
 *   2. a pending timer that already names the worker leaves the count
 *      unchanged, and no second timer id appears;
 *   3. a fleet whose rows are all closed arms nothing;
 *   4. a session with no project and a project with no registry arm nothing and
 *      throw nothing;
 *   5. a timer store that cannot be written still completes the turn end, and
 *      the arm survives in memory.
 *
 * The control for this file is a planted regression, not an assertion: with the
 * turn-end registration removed, case 1 fails on `0 timers` rather than on a
 * crash. It was run that way and the failure is quoted in the report.
 *
 * Hermetic: HOME and PI_CODING_AGENT_DIR are pinned into a scratch root and
 * BRAID_HOME is cleared before the dist imports, so every registry read, timer
 * write and settings read lands in the scratch tree. HERDR_ENV is cleared
 * because this device never speaks to herdr, and a test that inherits the live
 * one would be one accident away from it.
 *
 * Run: node packages/core/test/runtime/orchestrator/test-settle-arms-babysit-timer.mjs
 * (after npm run build)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "settle-arm-"));
process.env.HOME = FAKE_HOME;
process.env.PI_CODING_AGENT_DIR = join(FAKE_HOME, ".pi", "agent");
delete process.env.BRAID_HOME;
delete process.env.HERDR_ENV;
delete process.env.HERDR_PANE_ID;

const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);
const { default: timerExtension } = await import(
  "../../../dist/extensions/scheduling/timer/index.js"
);
const { listTimers, scheduleTimer } = await import(
  "../../../dist/extensions/scheduling/timer/index.js"
);
const { getTimerFilePath } = await import("../../../dist/lib/config/braid-paths.js");
const { getTimerExtensionFactoryState } = await import("../../../dist/lib/state/global-state.js");

// The scheduling module is registered in this process, as it is in every
// shipped configuration, and it is registered on its own surface so the
// orchestrator's handlers stay the only ones this file drives. Without it the
// arm has nothing that polls its store and declines to write one.
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

const run = (ctx, params) =>
  orchestrateTool.execute("call-1", params, new AbortController().signal, undefined, ctx);

/** A project directory with no registry of its own. */
const scratchProject = () => mkdtempSync(join(tmpdir(), "settle-arm-project-"));

/** Admit one live row at `cwd` through the tool, which is also what claims the project. */
const admit = (ctx, cwd, workerId) =>
  run(ctx, {
    action: "register-worker",
    workerId,
    spec: "impl",
    cwd,
    outputFile: join(cwd, "report.md"),
  });

describe("turn-end babysit arm", () => {
  it("arms one timer naming a live worker nothing names", async () => {
    assert.equal(
      typeof turnEnd,
      "function",
      "the extension registers no turn-end handler, so nothing arms a timer",
    );
    const repo = scratchProject();
    const ctx = sessionCtx("sess-arm");
    await admit(ctx, repo, "w-live-one");
    assert.equal(listTimers("sess-arm").length, 0, "nothing is armed before the turn ends");

    turnEnd({}, ctx);

    const timers = listTimers("sess-arm");
    assert.equal(timers.length, 1, "exactly one timer after the turn end");
    assert.match(timers[0].reason, /w-live-one/, "the reason names the worker it watches");
    assert.ok(
      typeof timers[0].intervalMs === "number" && timers[0].intervalMs > 0,
      "the arm is a recurrence, not a single fire",
    );
    assert.equal(timers[0].sessionId, "sess-arm", "the fire is attributed to the seat's session");
    assert.equal(timers[0].wake, true, "the fire must start a turn, or it wakes nobody");
    assert.equal(timers[0].tag, "orchestrator-babysit", "the cadence is identifiable for withdrawal");
    assert.ok(timers[0].firesAt > Date.now(), "the first fire is ahead of the settle, not behind it");
  });

  it("leaves the count unchanged when a pending timer already names the worker", async () => {
    const repo = scratchProject();
    const ctx = sessionCtx("sess-covered");
    await admit(ctx, repo, "w-covered");
    const armed = scheduleTimer("sess-covered", 60_000, "check w-covered progress", undefined, false);

    turnEnd({}, ctx);

    const timers = listTimers("sess-covered");
    assert.equal(timers.length, 1, "the existing timer is enough: no second one");
    assert.equal(timers[0].id, armed, "the pre-existing timer is the one that stands");
  });

  it("arms nothing for a fleet whose rows are all closed", async () => {
    const repo = scratchProject();
    const ctx = sessionCtx("sess-closed");
    await admit(ctx, repo, "w-finished");
    await run(ctx, { action: "close-worker", workerId: "w-finished", outcome: "closed", cwd: repo });

    turnEnd({}, ctx);

    assert.equal(listTimers("sess-closed").length, 0, "a closed row is not a fleet to watch");
  });

  it("arms nothing, and throws nothing, with no fleet to watch", async () => {
    const ctx = sessionCtx("sess-empty");
    assert.doesNotThrow(() => turnEnd({}, ctx), "a session that never orchestrated settles quietly");
    assert.equal(listTimers("sess-empty").length, 0);

    // A project the session looked at but where no registry file exists: the
    // read is an empty registry, not an error, and it is not a fleet either.
    const empty = scratchProject();
    await run(ctx, { action: "list-workers", cwd: empty });
    assert.doesNotThrow(() => turnEnd({}, ctx), "a project with no registry settles quietly");
    assert.equal(listTimers("sess-empty").length, 0);
  });

  it("writes nothing when the scheduling module is not registered", async () => {
    const repo = scratchProject();
    const ctx = sessionCtx("sess-no-scheduler");
    await admit(ctx, repo, "w-unscheduled");

    // The factory counter is the lib-level fact that the scheduling module is in
    // this process. Without it the store has no poller, so an arm would be a
    // timer that never fires: visible as installed, waking nobody.
    const counter = getTimerExtensionFactoryState();
    const registered = counter.callCount;
    counter.callCount = 0;
    try {
      turnEnd({}, ctx);
    } finally {
      counter.callCount = registered;
    }

    assert.equal(
      listTimers("sess-no-scheduler").length,
      0,
      "no timer is written into a store nothing polls",
    );
  });

  it("completes the turn end when the timer store cannot be written", async () => {
    const repo = scratchProject();
    const ctx = sessionCtx("sess-readonly");
    await admit(ctx, repo, "w-unwritable");

    const storeDir = dirname(getTimerFilePath(process.cwd()));
    mkdirSync(storeDir, { recursive: true });
    chmodSync(storeDir, 0o555);
    try {
      assert.doesNotThrow(
        () => turnEnd({}, ctx),
        "an unwritable store is a warning, never a broken turn end",
      );
    } finally {
      chmodSync(storeDir, 0o755);
    }

    assert.equal(
      listTimers("sess-readonly").length,
      1,
      "the arm is held in memory even when the store cannot take it",
    );
  });
});
