/**
 * Regression tests: recovered persisted fires flush at session_start.
 *
 * Defect: a process restart converts ACTIVE timers into PASSIVE persisted
 * records. Recovery (recoverPersistedTimers, in before_agent_start) parks
 * overdue fires and the ONLY delivery point was the post-settle flush
 * (agent_settled) — so a recovered wake fire waited for an unrelated turn to
 * settle. The restart itself delivered nothing: a resumed idle session sat
 * on its overdue fires until some later turn ended. Observed: a wake fire
 * recovered after a restart waited 23 minutes for a turn started for
 * entirely different reasons.
 *
 * Contract (post-fix):
 * - At session_start the timer extension runs the recovery sweep ITSELF (it
 *   must not depend on prompt-builder's before_agent_start), and when the
 *   session is idle with parked fires, flushes on the next macrotask.
 * - A busy session does not flush at session_start; the post-settle flush
 *   stays the fallback.
 * - A flush whose deferred send lands in a busy window is re-parked by the
 *   send-time onBusy hook (flushRecoveredFires) — never a competing
 *   triggerTurn, never lost; the next settle flushes it.
 * - No parked fires -> session_start sends nothing.
 *
 * Run: node test/runtime/lib/test-timer-session-start-flush.mjs
 */

import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// Pin braid's whole persistent tree into a private tmpdir so no test writes
// the live store (pending-timers.jsonl, session-store liveness reads).
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-timer-ssflush-home-"));
process.env.BRAID_HOME = BRAID_HOME;

const timerMod = await import("../../../dist/extensions/scheduling/timer/index.js");
const { wakeRetryQueue } = await import("../../../dist/extensions/scheduling/timer/wake-retry.js");
const { getTimerFilePath } = await import("../../../dist/lib/config/braid-paths.js");
const { registerWakeGate, resetWakeGateForTests } =
  await import("../../../dist/lib/utils/wake-gate.js");

const originalCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "braid-timer-ssflush-"));

function makeFakePi() {
  const handlers = {};
  const sent = [];
  return {
    sent,
    handlers,
    registerTool() {},
    on(name, fn) {
      (handlers[name] ??= []).push(fn);
    },
    emit(name, event = {}, ctx = {}) {
      for (const fn of handlers[name] ?? []) fn(event, ctx);
    },
    sendMessage(params, options) {
      sent.push({ params, options });
    },
  };
}

function flushDeferred() {
  // Two macrotask hops: the session-start flush schedules flushRecoveredFires
  // on a setTimeout(0); its triggerTurn:true send defers once more inside
  // sendTrackedMessage before pi.sendMessage runs.
  return new Promise((resolve) => setTimeout(() => setTimeout(resolve, 0), 0));
}

function writeTimerFile(lines) {
  const file = getTimerFilePath(process.cwd());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return file;
}

function readTimerFile() {
  const file = getTimerFilePath(process.cwd());
  let raw;
  try {
    raw = readFileSync(file, "utf-8").trim();
  } catch {
    return [];
  }
  if (!raw) return [];
  return raw.split("\n").map((l) => JSON.parse(l));
}

function overdueRecord(id, sessionId) {
  return {
    id,
    sessionId,
    firesAt: Date.now() - 5000,
    reason: "morning report",
    createdAt: Date.now() - 60_000,
    wake: true,
  };
}

after(() => {
  // Clean the store dir the tests wrote (computed while cwd is still the
  // temp dir: macOS resolves /var -> /private/var, which sanitizes
  // differently from the literal tmp string) plus the fake braid home.
  const storeDir = dirname(getTimerFilePath(tmp));
  process.chdir(originalCwd);
  try {
    rmSync(storeDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(BRAID_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

afterEach(() => {
  resetWakeGateForTests();
  wakeRetryQueue.resetForTests();
  for (const sid of ["flush-idle", "flush-busy", "flush-deferred", "flush-late"]) {
    timerMod.timerManager.clearSession(sid);
  }
  rmSync(getTimerFilePath(tmp), { force: true });
});

describe("recovered fires flush at session_start (no intervening turn)", () => {
  it("REGRESSION: overdue persisted fire is delivered at session_start when the session is idle", async () => {
    process.chdir(tmp);
    const sid = "flush-idle";
    writeTimerFile([overdueRecord("rec-ss-1", sid)]);
    const pi = makeFakePi();
    timerMod.default(pi);
    const ctx = { sessionManager: { getSessionId: () => sid }, isIdle: () => true };

    pi.emit("session_start", {}, ctx);
    await flushDeferred();

    assert.equal(pi.sent.length, 1, "recovered wake delivered at session_start itself");
    assert.equal(
      pi.sent[0].options.triggerTurn,
      true,
      "wake:true recovered fire starts its own turn",
    );
    assert.match(pi.sent[0].params.content[0].text, /morning report/);
    assert.equal(wakeRetryQueue.deferredRecoveredCount(), 0, "parked set drained by the flush");
    assert.deepEqual(
      readTimerFile().filter((t) => t.id === "rec-ss-1"),
      [],
      "the recovered record left the store (no re-delivery on the next restart)",
    );
    pi.emit("session_shutdown", {}, ctx); // stop the real 1s poller interval
  });

  it("busy session at session_start does not flush; the post-settle flush delivers", async () => {
    process.chdir(tmp);
    const sid = "flush-busy";
    writeTimerFile([overdueRecord("rec-ss-2", sid)]);
    const pi = makeFakePi();
    timerMod.default(pi);
    const ctx = { sessionManager: { getSessionId: () => sid }, isIdle: () => false };

    pi.emit("session_start", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 0, "no competing wake into a busy session");
    assert.equal(
      wakeRetryQueue.deferredRecoveredCount(),
      1,
      "recovery ran at session_start and parked the fire",
    );

    // The post-settle flush remains the fallback for the busy case.
    pi.emit("agent_settled", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "post-settle flush delivers the parked fire");
    assert.equal(pi.sent[0].options.triggerTurn, true);
    pi.emit("session_shutdown", {}, ctx); // stop the real 1s poller interval
  });

  it("REVERT-PROOF: onBusy re-parks a flush whose send lands in a busy window", async () => {
    process.chdir(tmp);
    const sid = "flush-deferred";
    writeTimerFile([overdueRecord("rec-ss-3", sid)]);
    // The wake gate is a real module in production (registered by the
    // enforcement bootstrap); register it here so the send-time busy check
    // is the live one, not the fail-open stub.
    const pi = makeFakePi();
    registerWakeGate(pi);
    timerMod.default(pi);
    const idleCtx = { sessionManager: { getSessionId: () => sid }, isIdle: () => true };
    const busyCtx = {
      sessionManager: { getSessionId: () => sid },
      isIdle: () => false,
      signal: undefined,
    };

    pi.emit("session_start", {}, idleCtx); // idle: flush scheduled
    pi.emit("agent_start", {}, busyCtx); // a run starts before the macrotask fires
    await flushDeferred();

    assert.equal(pi.sent.length, 0, "busy at send time: no competing triggerTurn send");
    assert.equal(
      wakeRetryQueue.deferredRecoveredCount(),
      1,
      "the onBusy hook re-parked the fire",
    );

    // Session idle again: the next settle flush delivers the re-parked fire.
    resetWakeGateForTests();
    pi.emit("agent_settled", {}, idleCtx);
    await flushDeferred();
    assert.equal(pi.sent.length, 1, "re-parked fire delivered on the next settle flush");
    assert.equal(wakeRetryQueue.deferredRecoveredCount(), 0);
    pi.emit("session_shutdown", {}, idleCtx); // stop the real 1s poller interval
  });

  it("no parked fires: session_start sends nothing", async () => {
    process.chdir(tmp);
    const sid = "flush-late";
    const pi = makeFakePi();
    timerMod.default(pi);
    const ctx = { sessionManager: { getSessionId: () => sid }, isIdle: () => true };

    pi.emit("session_start", {}, ctx);
    await flushDeferred();
    assert.equal(pi.sent.length, 0, "empty store: no wake, no whisper");
    assert.equal(wakeRetryQueue.deferredRecoveredCount(), 0);
    pi.emit("session_shutdown", {}, ctx); // stop the real 1s poller interval
  });
});
