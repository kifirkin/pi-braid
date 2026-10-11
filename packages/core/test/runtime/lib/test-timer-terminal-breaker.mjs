/**
 * Terminal-error wake breaker: latch + wake gate.
 *
 * Contract (post-change):
 * - Three LLM errors of category auth or balance recorded in one session
 *   since the last clean turn open an in-memory latch. While it is open, a
 *   due wake fire is DEMOTED to the existing non-waking path
 *   ({ deliverAs: "steer", triggerTurn: false }) and is NOT tracked for
 *   retry: the reminder stays visible but starts no provider call.
 * - rate_limit errors never open it — a 429 burst must keep rotating.
 * - The latch closes on session_start, an owner recovery call
 *   (setSessionHealthMode "healthy"), a route change, or a wake turn that
 *   settles without a provider error; the next wake wakes again.
 * - The gate lives in the scheduling wake path, which asks only
 *   isTurnStartBlocked(ctx): no error category, provider id or status code
 *   appears in scheduling/.
 *
 * Run: node test/runtime/lib/test-timer-terminal-breaker.mjs
 */

import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// Pin braid's persistent tree into a private tmpdir so no fixture touches the
// live store (pending-timers.jsonl, session-store liveness reads).
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-timer-tb-home-"));
process.env.BRAID_HOME = BRAID_HOME;

const timerMod = await import("../../../dist/extensions/scheduling/timer/index.js");
const { timerManager } = timerMod;
const { wakeRetryQueue } = await import("../../../dist/extensions/scheduling/timer/wake-retry.js");
const health = await import("../../../dist/extensions/enforcement/session-health.js");
const { classifyLlmError } = await import("../../../dist/lib/errors/llm-error.js");
const { getTimerFilePath } = await import("../../../dist/lib/config/braid-paths.js");
const globalState = await import("../../../dist/lib/state/global-state.js");

// Only the timer extension is loaded here, so publish the turn-start gate
// exactly as the enforcement extension's registerSessionStart does (one
// statement, lib-level seam). The gate's BODY is the real health module: the
// latch logic under test is not stubbed, only its publication is. Guarded so
// this file also loads against a pre-seam dist (RED run): the failure then
// shows up behaviorally at the fire assert, not as an import error.
if (typeof globalState.setTurnStartGate === "function") {
  globalState.setTurnStartGate({
    isBlocked: (ctx, threshold) => health.isTurnStartBlocked(ctx, threshold),
    noteCleanTurn: (ctx) => health.clearTerminalBreaker(ctx),
  });
}

const originalCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "braid-timer-tb-"));

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

/** Let nested macrotasks drain: fireExpired -> setTimeout(0) -> fireTimer ->
 *  sendTrackedMessage's own deferral. Three hops is one more than needed. */
function flushDeferred(hops = 3) {
  return new Promise((resolve) => {
    let n = 0;
    const step = () => {
      n += 1;
      if (n >= hops) resolve();
      else setTimeout(step, 0);
    };
    setTimeout(step, 0);
  });
}

function makeCtx(sid) {
  return {
    sessionManager: {
      getSessionId: () => sid,
      getSessionFile: () => join(tmp, `${sid}.jsonl`),
    },
    isIdle: () => true,
  };
}

function terminalErrors(ctx, n, detail = '401 "Authentication failed"') {
  for (let i = 0; i < n; i++) health.recordLlmError(ctx, classifyLlmError(detail));
}

function rateLimitErrors(ctx, n) {
  for (let i = 0; i < n; i++) health.recordLlmError(ctx, classifyLlmError("429 Too Many Requests"));
}

/** Arm a live one-shot wake that is already due and drive it through the
 *  real fire path (TOOL_EXECUTION_END -> poller.fireExpired -> fireTimer). */
async function driveLiveWake(pi, ctx, sid, reason = "morning report") {
  pi.emit("session_start", {}, ctx);
  timerManager.setTimer(sid, 0, reason, undefined, true);
  pi.emit("tool_execution_end", {}, ctx);
  await flushDeferred();
}

function writeOverdueRecord(id, sid) {
  const file = getTimerFilePath(process.cwd());
  mkdirSync(dirname(file), { recursive: true });
  const record = {
    id,
    sessionId: sid,
    firesAt: Date.now() - 5000,
    reason: "morning report",
    createdAt: Date.now() - 60_000,
    wake: true,
  };
  writeFileSync(file, JSON.stringify(record) + "\n", "utf-8");
}

afterEach(() => {
  for (const sid of ["tb-a", "tb-b", "tb-c", "tb-d", "tb-e", "tb-f", "tb-g"]) {
    timerManager.clearSession(sid);
  }
  wakeRetryQueue.resetForTests();
  wakeRetryQueue._setClockForTests(null);
  rmSync(getTimerFilePath(tmp), { force: true });
});

after(() => {
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

describe("terminal-error wake breaker", () => {
  it("3 auth errors latch: the wake is delivered non-waking, exactly one send, no retry tracked", async () => {
    process.chdir(tmp);
    const sid = "tb-a";
    const ctx = makeCtx(sid);
    terminalErrors(ctx, 3);

    const pi = makeFakePi();
    timerMod.default(pi);
    await driveLiveWake(pi, ctx, sid);

    assert.equal(pi.sent.length, 1, "the reminder is still delivered (demoted, not dropped)");
    assert.equal(pi.sent[0].options.triggerTurn, false, "the breaker-open fire starts no turn");
    assert.equal(pi.sent[0].options.deliverAs, "steer", "it rides the existing non-waking path");
    assert.equal(
      pi.sent.filter((s) => s.options?.triggerTurn === true).length,
      0,
      "no waking send while the breaker is open",
    );
    assert.equal(
      wakeRetryQueue.hasOutstandingRedelivery(),
      false,
      "the demoted fire is not tracked for retry",
    );

    assert.equal(typeof health.isTurnStartBlocked, "function", "isTurnStartBlocked is exported");
    assert.equal(health.isTurnStartBlocked(ctx), true, "the latch reports blocked");

    pi.emit("session_shutdown", {}, ctx);
  });

  it("3 rate_limit errors do NOT latch: the wake still wakes (429 keeps rotating)", async () => {
    process.chdir(tmp);
    const sid = "tb-b";
    const ctx = makeCtx(sid);
    rateLimitErrors(ctx, 3);

    const pi = makeFakePi();
    timerMod.default(pi);
    await driveLiveWake(pi, ctx, sid);

    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].options.triggerTurn, true, "rate-limit errors never gate a wake");
    assert.equal(health.isTurnStartBlocked(ctx), false, "the latch stays closed");

    pi.emit("session_shutdown", {}, ctx);
  });

  it("owner recovery closes the latch: the next wake wakes again", async () => {
    process.chdir(tmp);
    const sid = "tb-c";
    const ctx = makeCtx(sid);
    terminalErrors(ctx, 3);
    assert.equal(health.isTurnStartBlocked(ctx), true);

    health.setSessionHealthMode(ctx, "healthy", "owner topped up");
    assert.equal(health.isTurnStartBlocked(ctx), false, "recovery clears the latch");

    const pi = makeFakePi();
    timerMod.default(pi);
    await driveLiveWake(pi, ctx, sid);

    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0].options.triggerTurn, true, "wakes resume after recovery");

    pi.emit("session_shutdown", {}, ctx);
  });

  it("session_start resets the latch", () => {
    process.chdir(tmp);
    const sid = "tb-d";
    const ctx = makeCtx(sid);
    terminalErrors(ctx, 3);
    assert.equal(health.isTurnStartBlocked(ctx), true);

    health.resetSessionHealth(ctx, { preserveHistory: true });
    assert.equal(health.isTurnStartBlocked(ctx), false, "session_start clears the latch");
  });

  it("a clean wake turn closes the latch (wake-path success observation)", async () => {
    process.chdir(tmp);
    const sid = "tb-e";
    const ctx = makeCtx(sid);
    const pi = makeFakePi();
    timerMod.default(pi);
    pi.emit("session_start", {}, ctx); // capture ctx for the observer wiring

    terminalErrors(ctx, 3);
    assert.equal(health.isTurnStartBlocked(ctx), true);

    const timer = {
      id: "tb-clean-turn",
      sessionId: sid,
      firesAt: Date.now(),
      reason: "wake",
      createdAt: Date.now(),
      wake: true,
    };
    wakeRetryQueue.trackWake(timer);
    wakeRetryQueue.onAgentEnd(false);
    wakeRetryQueue.onAgentSettled(); // run settled without a provider error

    assert.equal(
      health.isTurnStartBlocked(ctx),
      false,
      "a real clean turn resets the counter (not just any LLM call)",
    );
    pi.emit("session_shutdown", {}, ctx);
  });

  it("the health mode auto-clearing does NOT close the latch (not derived from mode)", () => {
    process.chdir(tmp);
    const sid = "tb-g";
    const ctx = makeCtx(sid);
    terminalErrors(ctx, 3);
    assert.equal(health.isTurnStartBlocked(ctx), true);

    // 10 consecutive successes are the health state's own mode auto-clear
    // (HEALTHY_CLEAR_TURNS); the incident's 10.7h storm is built from exactly
    // these quiet gaps, so the latch must survive them.
    for (let i = 0; i < 10; i++) health.recordLlmSuccess(ctx);
    assert.equal(health.getSessionHealth(ctx).mode, "healthy", "mode auto-cleared");
    assert.equal(
      health.isTurnStartBlocked(ctx),
      true,
      "the latch is independent of mode; only the explicit reset signals close it",
    );
  });

  it("recovered persisted fires are demoted too (same consumer gate)", async () => {
    process.chdir(tmp);
    const sid = "tb-f";
    const ctx = makeCtx(sid);
    terminalErrors(ctx, 3);
    writeOverdueRecord("tb-rec-1", sid);

    const pi = makeFakePi();
    timerMod.default(pi);
    pi.emit("session_start", {}, ctx);
    await flushDeferred();

    assert.equal(pi.sent.length, 1, "the recovered reminder is still delivered");
    assert.equal(
      pi.sent[0].options.triggerTurn,
      false,
      "a recovered wake fire is demoted while the breaker is open",
    );
    pi.emit("session_shutdown", {}, ctx);
  });
});
