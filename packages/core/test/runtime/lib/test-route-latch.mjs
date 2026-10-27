/**
 * Route-failure latch: a failing route parks the self-started turns.
 *
 * Contract:
 * - A run that ends on a provider error counts one `routeErrorsSinceHealthyTurn`
 *   (every class except a context-window overflow and an abort). At the
 *   configured threshold (default 3) the latch opens.
 * - While it is open the three seams that self-start a turn are DEMOTED, never
 *   dropped: the timer's due wake keeps its existing park delivery, a watchdog
 *   escalation rides `quietWhisper` while its tg line still fires, and an
 *   explicitly-waking whisper becomes the ordinary non-waking steer. The text
 *   always reaches the session.
 * - Released by a successful provider call, a clean wake turn, a route change,
 *   an owner recovery or a session start. While open, the gate still releases
 *   exactly one turn per `braid.session.routeBreaker.floorMs` and restamps the
 *   clock.
 * - A human turn passes untouched: no seam consults the latch for it.
 * - `braid.session.routeBreaker.enabled = false` makes every part of this inert
 *   (the off-switch family below asserts today's behaviour byte for byte).
 *
 * Everything is driven through production paths: the real `agent_end` feed,
 * the real timer extension, the real watchdog extension wiring (its published
 * wake-delivery feed), the real whisper emitter. Only the clock and the
 * out-of-band tg sender are injected.
 *
 * Run: node test/runtime/lib/test-route-latch.mjs
 * (built first: npm run build)
 */

import { describe, it, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin every persistent tree BEFORE the dist imports: braid-settings resolves
// settings.json from the agent dir at call time, the timer store resolves
// through BRAID_HOME. No test may read or write live state.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "braid-route-latch-home-"));
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-route-latch-braid-"));
const AGENT_DIR = join(FAKE_HOME, ".pi", "agent");
process.env.HOME = FAKE_HOME;
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.BRAID_HOME = BRAID_HOME;
mkdirSync(AGENT_DIR, { recursive: true });
const SETTINGS_FILE = join(AGENT_DIR, "settings.json");

function writeSettings(obj) {
  writeFileSync(SETTINGS_FILE, JSON.stringify(obj), "utf-8");
}

const ROOT = join(import.meta.dirname, "../../..");
const D = join(ROOT, "dist");

const timerMod = await import("file://" + join(D, "extensions/scheduling/timer/index.js"));
const { timerManager } = timerMod;
const { wakeRetryQueue } = await import("file://" + join(D, "extensions/scheduling/timer/wake-retry.js"));
const health = await import("file://" + join(D, "extensions/enforcement/session-health.js"));
const { classifyLlmError } = await import("file://" + join(D, "lib/errors/llm-error.js"));
const { getState } = await import("file://" + join(D, "extensions/enforcement/state.js"));
const globalState = await import("file://" + join(D, "lib/state/global-state.js"));
const { sendEnforcementWhisper } = await import("file://" + join(D, "extensions/enforcement/whisper.js"));
const { registerAgentEndApiErrorHandler } = await import(
  "file://" + join(D, "extensions/enforcement/handlers/register-agent-end-api-error.js")
);
const { createWatchdogEngine } = await import("file://" + join(D, "extensions/self/watchdog/engine.js"));
const { getTimerFilePath } = await import("file://" + join(D, "lib/config/braid-paths.js"));
const { clearAllBuckets } = await import("file://" + join(D, "lib/utils/injection-tracker.js"));
const settingsMod = await import("file://" + join(D, "lib/config/braid-settings.js"));

// The route half of the turn-start question. Optional-chained so this file
// also loads against a pre-latch build: every "latch on" scenario then fails
// on behaviour (the RED run), not on an import.
const routeLatchOpen = (ctx) => health.isRouteLatchOpen?.(ctx) === true;
const resetRouteLatch = (ctx) => {
  if (typeof health.clearTerminalBreaker === "function") health.clearTerminalBreaker(ctx);
  health.recordLlmSuccess(ctx);
};

// Only the timer + the agent_end feed are loaded here, so publish the
// turn-start gate exactly as the enforcement extension's registerSessionStart
// does (one statement, lib-level seam). The gate's BODY is the real health
// module.
if (typeof globalState.setTurnStartGate === "function") {
  globalState.setTurnStartGate({
    isBlocked: (ctx, threshold) => health.isTurnStartBlocked(ctx, threshold),
    noteCleanTurn: (ctx) => health.clearTerminalBreaker(ctx),
  });
}

/** Scaled-down watchdog config: the escalation conditions used here are
 *  event-driven, so no monitor cadence ever has to fire. */
const WD_CONFIG = {
  mode: "on",
  baseMs: 1_000,
  hotMs: 200,
  stallMult: 5,
  quotaErrors: 3,
  tunnelFailures: 3,
};

const originalCwd = process.cwd();
const originalNow = Date.now;
const tmp = mkdtempSync(join(tmpdir(), "braid-route-latch-cwd-"));

function makeFakePi() {
  const handlers = {};
  const sent = [];
  return {
    sent,
    handlers,
    registerTool() {},
    registerCommand() {},
    on(name, fn) {
      (handlers[name] ??= []).push(fn);
    },
    async emit(name, event = {}, ctx = {}) {
      for (const fn of handlers[name] ?? []) await fn(event, ctx);
    },
    sendMessage(params, options) {
      sent.push({ params, options });
    },
  };
}

/** Let nested macrotasks drain: fireExpired -> setTimeout(0) -> fireTimer ->
 *  sendTrackedMessage's own deferral. */
function flushDeferred(hops = 4) {
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
    hasPendingMessages: () => false,
    ui: { setStatus() {} },
    cwd: tmp,
  };
}

/** A run that ended on a provider error: the shape pi delivers on `agent_end`
 *  once the auto-retry budget is spent. */
async function emitRunEndingError(pi, ctx, errText = "Connection error.") {
  await pi.emit(
    "agent_end",
    {
      messages: [
        { role: "user", content: "do the thing" },
        { role: "assistant", role_assistant: true, stopReason: "error", errorMessage: errText },
      ],
    },
    ctx,
  );
}

/** Three run-ending provider errors — the default threshold — through the
 *  real agent_end handler. The nudge cooldown is closed so the handler does
 *  not reach for the classifier: the counter must be recorded BEFORE that
 *  early return, which is exactly what these scenarios rely on. */
async function latchOpen(pi, ctx) {
  getState(ctx).lastNudgeTime = Date.now();
  for (let i = 0; i < 3; i++) await emitRunEndingError(pi, ctx);
  assert.equal(routeLatchOpen(ctx), true, "the latch must be open after the threshold");
  assert.equal(getState(ctx).validationFailures >= 3, true, "the run-ending errors reached the handler");
}

/** Accumulate n run-ending errors of a chosen class through the same real
 *  feed, without leaving a timer extension behind. */
async function feedRouteErrors(ctx, n, errText = "Connection error.") {
  const pi = makeFakePi();
  registerAgentEndApiErrorHandler(pi);
  getState(ctx).lastNudgeTime = Date.now();
  for (let i = 0; i < n; i++) await emitRunEndingError(pi, ctx, errText);
}

/** Arm a live one-shot wake that is already due and drive it through the real
 *  fire path (TOOL_EXECUTION_END -> poller.fireExpired -> fireTimer). */
async function driveLiveWake(pi, ctx, sid, reason = "morning report") {
  timerManager.setTimer(sid, 0, reason, undefined, true);
  await pi.emit("tool_execution_end", {}, ctx);
  await flushDeferred();
}

function wakeSends(pi) {
  return pi.sent.filter((s) => s.params?.customType === "timer-fire");
}

function wakingSends(pi) {
  return pi.sent.filter((s) => s.options?.triggerTurn === true);
}

/** A watchdog engine whose gate is the real route predicate, capturing the
 *  three delivery sinks separately. */
function makeEngine(ctx) {
  const calls = { wake: [], quiet: [], tg: [] };
  const engine = createWatchdogEngine(WD_CONFIG, {
    now: () => Date.now(),
    schedule: () => () => {},
    wakeWhisper: (text) => calls.wake.push(text),
    quietWhisper: (text) => calls.quiet.push(text),
    tgSignal: (text) => calls.tg.push(text),
    subscribeTunnel: () => () => {},
    getTunnelStatus: () => ({ status: "up", failures: 0 }),
    log: () => {},
    isTurnStartBlocked: () => routeLatchOpen(ctx),
  });
  engine.start();
  return { engine, calls };
}

afterEach(() => {
  Date.now = originalNow;
  // The injection funnel's cross-call de-bloat suppresses an identical body
  // inside its window; every scenario here re-uses the same timer reason, and
  // each scenario is an independent session, so start clean.
  clearAllBuckets();
  for (const sid of ["rl-a", "rl-b", "rl-c", "rl-d", "rl-e", "rl-f"]) timerManager.clearSession(sid);
  wakeRetryQueue.resetForTests();
  wakeRetryQueue._setClockForTests(null);
  rmSync(getTimerFilePath(tmp), { force: true });
  writeSettings({});
});

after(() => {
  process.chdir(originalCwd);
  for (const dir of [BRAID_HOME, FAKE_HOME, tmp]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe("route-failure latch", () => {
  describe("on (default settings)", () => {
    it("three run-ending provider errors park the next due wake; the text still lands once", async () => {
      process.chdir(tmp);
      writeSettings({});
      const sid = "rl-a";
      const ctx = makeCtx(sid);
      const pi = makeFakePi();
      timerMod.default(pi);
      registerAgentEndApiErrorHandler(pi);
      await pi.emit("session_start", {}, ctx);

      await latchOpen(pi, ctx);
      assert.equal(
        health.getSessionHealth(ctx).routeErrorsSinceHealthyTurn,
        3,
        "the feed counts every run-ending error (recorded before the nudge cooldown)",
      );

      await driveLiveWake(pi, ctx, sid);

      const wakes = wakeSends(pi);
      assert.equal(wakes.length, 1, "the reminder is still delivered (demoted, not dropped)");
      assert.deepEqual(
        wakes[0].options,
        { deliverAs: "steer", triggerTurn: false },
        "it rides the non-waking park delivery: no triggerTurn, no wake",
      );
      assert.equal(wakingSends(pi).length, 0, "no waking send while the latch is open");
      assert.match(wakes[0].params.content[0].text, /morning report/, "the scheduled content is intact");
      assert.equal(
        wakeRetryQueue.getStats().tracked,
        0,
        "a parked fire is not tracked for retry",
      );
    });

    it("a successful provider call re-opens the gate: the next wake wakes", async () => {
      process.chdir(tmp);
      writeSettings({});
      const sid = "rl-b";
      const ctx = makeCtx(sid);
      const pi = makeFakePi();
      timerMod.default(pi);
      registerAgentEndApiErrorHandler(pi);
      await pi.emit("session_start", {}, ctx);

      await latchOpen(pi, ctx);
      await driveLiveWake(pi, ctx, sid, "first");
      assert.equal(wakingSends(pi).length, 0, "parked while open");

      health.recordLlmSuccess(ctx); // any successful provider call
      assert.equal(routeLatchOpen(ctx), false, "the latch released");

      await driveLiveWake(pi, ctx, sid, "second");
      const second = wakeSends(pi).at(-1);
      assert.deepEqual(second.options, { triggerTurn: true }, "wakes resume after a success");
      assert.match(second.params.content[0].text, /second/);
    });

    it("a human turn passes untouched: no seam consults the latch for it", async () => {
      process.chdir(tmp);
      writeSettings({});
      const sid = "rl-c";
      const ctx = makeCtx(sid);
      const pi = makeFakePi();
      timerMod.default(pi);
      registerAgentEndApiErrorHandler(pi);
      await pi.emit("session_start", {}, ctx);

      // Latch open AND the floor elapsed: any consultation now stamps the
      // release clock, so the stamp is a sentinel that sees every consumer,
      // whether it asks through the published gate or imports the predicate.
      await latchOpen(pi, ctx);
      const t0 = Date.now() + 4 * 3_600_000;
      Date.now = () => t0;

      // A human message, through every event a human turn produces.
      await pi.emit("message_start", { message: { role: "user", content: "human input" } }, ctx);
      await pi.emit("turn_start", {}, ctx);
      await pi.emit("message_end", { message: { role: "user", content: "human input" } }, ctx);
      await pi.emit("agent_start", {}, ctx);
      await pi.emit("agent_end", { messages: [{ role: "user", content: "human input" }] }, ctx);
      await pi.emit("turn_end", {}, ctx);
      await pi.emit("agent_settled", {}, ctx);
      await flushDeferred();

      assert.equal(
        health.getSessionHealth(ctx).routeLatchLastReleaseAt,
        undefined,
        "no seam consulted the latch during the human turn (the floor never released)",
      );
      assert.equal(pi.sent.length, 0, "the human turn produced no injection and no wake");

      // Positive control: the same sentinel fires for a self-started turn, so
      // the assertion above can fail.
      await driveLiveWake(pi, ctx, sid);
      assert.equal(
        health.getSessionHealth(ctx).routeLatchLastReleaseAt,
        t0,
        "a due wake did consult the latch and the floor released it once",
      );
      assert.deepEqual(wakeSends(pi)[0].options, { triggerTurn: true }, "the floor's one turn wakes");
    });

    it("the floor releases exactly one self-started turn per window", async () => {
      process.chdir(tmp);
      writeSettings({});
      const sid = "rl-d";
      const ctx = makeCtx(sid);
      const pi = makeFakePi();
      timerMod.default(pi);
      registerAgentEndApiErrorHandler(pi);
      await pi.emit("session_start", {}, ctx);

      await latchOpen(pi, ctx);
      let now = Date.now();
      Date.now = () => now;

      await driveLiveWake(pi, ctx, sid, "w1");
      assert.equal(wakingSends(pi).length, 0, "parked inside the floor window");

      now += 3_600_000; // floorMs default
      await driveLiveWake(pi, ctx, sid, "w2");
      assert.equal(wakingSends(pi).length, 1, "the floor releases exactly one turn");

      await driveLiveWake(pi, ctx, sid, "w3");
      assert.equal(wakingSends(pi).length, 1, "the next wake inside the new window parks again");

      now += 3_600_000 - 1_000; // one second inside the window
      await driveLiveWake(pi, ctx, sid, "w4");
      assert.equal(wakingSends(pi).length, 1, "one second inside the window: parked");

      now += 1_000;
      await driveLiveWake(pi, ctx, sid, "w5");
      assert.equal(wakingSends(pi).length, 2, "the clock restarted at the release, not at the block");
    });

    it("a configured threshold and floor take effect at the seam", async () => {
      process.chdir(tmp);
      writeSettings({ braid: { session: { routeBreaker: { threshold: 2, floorMs: 120_000 } } } });
      const sid = "rl-o";
      const ctx = makeCtx(sid);
      const pi = makeFakePi();
      timerMod.default(pi);
      registerAgentEndApiErrorHandler(pi);
      await pi.emit("session_start", {}, ctx);

      getState(ctx).lastNudgeTime = Date.now();
      await emitRunEndingError(pi, ctx);
      assert.equal(routeLatchOpen(ctx), false, "one error is below the configured threshold of 2");
      await emitRunEndingError(pi, ctx);
      assert.equal(routeLatchOpen(ctx), true, "two errors reach it");

      let now = Date.now();
      Date.now = () => now;
      await driveLiveWake(pi, ctx, sid, "c1");
      assert.equal(wakingSends(pi).length, 0, "parked inside the configured floor");

      now += 120_000;
      await driveLiveWake(pi, ctx, sid, "c2");
      assert.equal(wakingSends(pi).length, 1, "the configured two-minute floor releases one turn");
    });

    it("a context-window overflow is not evidence about the route: the wake still wakes", async () => {
      process.chdir(tmp);
      writeSettings({});
      const sid = "rl-e";
      const ctx = makeCtx(sid);
      const pi = makeFakePi();
      timerMod.default(pi);
      await pi.emit("session_start", {}, ctx);

      await feedRouteErrors(ctx, 5, "context length exceeded");
      assert.equal(
        health.getSessionHealth(ctx).routeErrorsSinceHealthyTurn ?? 0,
        0,
        "an overflow is the context's fact, not the route's",
      );
      assert.equal(routeLatchOpen(ctx), false);

      await driveLiveWake(pi, ctx, sid);
      assert.deepEqual(wakeSends(pi)[0].options, { triggerTurn: true }, "the wake still wakes");
    });

    it("an abort is not evidence about the route either", (t) => {
      if (typeof health.recordRouteFailure !== "function") {
        t.diagnostic("recordRouteFailure absent (pre-latch build): state-seam exclusion not exercisable");
        return;
      }
      process.chdir(tmp);
      writeSettings({});
      const ctx = makeCtx("rl-e2");
      for (let i = 0; i < 5; i++) health.recordRouteFailure(ctx, "abort");
      assert.equal(health.getSessionHealth(ctx).routeErrorsSinceHealthyTurn, 0);
      assert.equal(routeLatchOpen(ctx), false);
    });

    it("a watchdog escalation parks the turn and keeps its one tg line", async () => {
      process.chdir(tmp);
      writeSettings({});
      const sid = "rl-f";
      const ctx = makeCtx(sid);
      const pi = makeFakePi();
      registerAgentEndApiErrorHandler(pi);
      await latchOpen(pi, ctx);

      const { engine, calls } = makeEngine(ctx);
      engine.recordWakeUndelivered("t-park", "babysit", 3);
      assert.equal(calls.wake.length, 0, "no waking bark while the latch is open");
      assert.equal(calls.quiet.length, 1, "the escalation text still reaches the session");
      assert.match(calls.quiet[0], /permanently undelivered/, "the content is the bark's own text");
      assert.equal(calls.tg.length, 1, "one tg line for the episode");

      // Release: the bark wakes again.
      health.recordLlmSuccess(ctx);
      const next = makeEngine(ctx);
      next.engine.recordWakeUndelivered("t-wake", "babysit", 3);
      assert.equal(next.calls.wake.length, 1, "released: the bark wakes");
      assert.equal(next.calls.quiet.length, 0);
      assert.equal(next.calls.tg.length, 1, "the tg line is unaffected either way");
    });

    it("an explicitly-waking whisper is demoted to the non-waking steer, not dropped", async () => {
      process.chdir(tmp);
      writeSettings({});
      const sid = "rl-g";
      const ctx = makeCtx(sid);
      const pi = makeFakePi();
      registerAgentEndApiErrorHandler(pi);
      await latchOpen(pi, ctx);

      sendEnforcementWhisper(pi, ctx, "resume the task", false, { triggerTurn: true });
      await flushDeferred();
      assert.equal(pi.sent.length, 1, "the advisory is still delivered");
      assert.equal(pi.sent[0].options.triggerTurn, undefined, "no wake while the latch is open");
      assert.equal(pi.sent[0].options.deliverAs, "steer", "it lands as the ordinary steer");
      assert.match(pi.sent[0].params.content[0].text, /resume the task/);

      health.recordLlmSuccess(ctx);
      sendEnforcementWhisper(pi, ctx, "resume again", false, { triggerTurn: true });
      await flushDeferred();
      assert.equal(pi.sent.at(-1).options.triggerTurn, true, "released: the waking whisper wakes");
    });
  });

  describe("off (braid.session.routeBreaker.enabled = false: today's behaviour)", () => {
    const OFF = { braid: { session: { routeBreaker: { enabled: false } } } };

    it("a timer wake wakes, exactly as before the latch existed", async () => {
      process.chdir(tmp);
      writeSettings(OFF);
      const sid = "rl-h";
      const ctx = makeCtx(sid);
      const pi = makeFakePi();
      timerMod.default(pi);
      registerAgentEndApiErrorHandler(pi);
      await pi.emit("session_start", {}, ctx);

      getState(ctx).lastNudgeTime = Date.now();
      for (let i = 0; i < 5; i++) await emitRunEndingError(pi, ctx);
      assert.equal(routeLatchOpen(ctx), false, "the off switch makes the latch answer false");

      await driveLiveWake(pi, ctx, sid);
      assert.deepEqual(
        wakeSends(pi)[0].options,
        { triggerTurn: true },
        "the wake's delivery is byte-identical to the pre-latch path",
      );
      assert.equal(
        wakeRetryQueue.getStats().tracked >= 1,
        true,
        "the waking fire is tracked for retry (unlike the parked one)",
      );
    });

    it("the floor never applies: no wake is parked however many errors accumulated", async () => {
      process.chdir(tmp);
      writeSettings(OFF);
      const sid = "rl-i";
      const ctx = makeCtx(sid);
      const pi = makeFakePi();
      timerMod.default(pi);
      registerAgentEndApiErrorHandler(pi);
      await pi.emit("session_start", {}, ctx);

      getState(ctx).lastNudgeTime = Date.now();
      for (let i = 0; i < 5; i++) await emitRunEndingError(pi, ctx);

      for (const reason of ["w1", "w2", "w3"]) await driveLiveWake(pi, ctx, sid, reason);
      assert.equal(wakingSends(pi).length, 3, "every due wake wakes");
    });

    it("a watchdog escalation wakes and still pages", async () => {
      process.chdir(tmp);
      writeSettings(OFF);
      const ctx = makeCtx("rl-j");
      await feedRouteErrors(ctx, 5);

      const { engine, calls } = makeEngine(ctx);
      engine.recordWakeUndelivered("t-off", "babysit", 3);
      assert.equal(calls.wake.length, 1, "the bark wakes as it always did");
      assert.equal(calls.quiet.length, 0);
      assert.equal(calls.tg.length, 1, "the tg line is unchanged");
    });

    it("an explicitly-waking whisper still wakes", async () => {
      process.chdir(tmp);
      writeSettings(OFF);
      const ctx = makeCtx("rl-k");
      const pi = makeFakePi();
      await feedRouteErrors(ctx, 5);

      sendEnforcementWhisper(pi, ctx, "resume the task", false, { triggerTurn: true });
      await flushDeferred();
      assert.equal(pi.sent.length, 1);
      assert.equal(pi.sent[0].options.triggerTurn, true, "the waking whisper is untouched");
      assert.equal(pi.sent[0].options.deliverAs, undefined, "no delivery class was injected");
    });

    it("the terminal breaker it sits beside is unchanged (3 auth errors still park)", async () => {
      process.chdir(tmp);
      writeSettings(OFF);
      const sid = "rl-l";
      const ctx = makeCtx(sid);
      const pi = makeFakePi();
      timerMod.default(pi);
      await pi.emit("session_start", {}, ctx);

      for (let i = 0; i < 3; i++) health.recordLlmError(ctx, classifyLlmError('401 "Authentication failed"'));
      await driveLiveWake(pi, ctx, sid);
      assert.deepEqual(
        wakeSends(pi)[0].options,
        { deliverAs: "steer", triggerTurn: false },
        "the pre-existing terminal gate is untouched by the off switch",
      );
    });
  });

  describe("braid.session.routeBreaker resolution", () => {
    it("absent block means on with threshold 3 and a one-hour floor; enabled:false is the switch", (t) => {
      if (typeof settingsMod.resolveRouteBreaker !== "function") {
        t.diagnostic("resolveRouteBreaker absent (pre-latch build)");
        return;
      }
      assert.deepEqual(settingsMod.resolveRouteBreaker(undefined), {
        enabled: true,
        threshold: 3,
        floorMs: 3_600_000,
      });
      assert.equal(settingsMod.resolveRouteBreaker({ enabled: false }).enabled, false);
      assert.equal(settingsMod.resolveRouteBreaker(null).enabled, true, "a non-object block is absent");
    });

    it("an invalid threshold or floor falls back to its default; the bounds themselves hold", (t) => {
      if (typeof settingsMod.resolveRouteBreaker !== "function") {
        t.diagnostic("resolveRouteBreaker absent (pre-latch build)");
        return;
      }
      const resolve = settingsMod.resolveRouteBreaker;
      for (const bad of [0, -1, 21, 2.5, "3", null]) {
        assert.equal(resolve({ threshold: bad }).threshold, 3, `threshold ${JSON.stringify(bad)}`);
      }
      for (const bad of [0, 59_999, 86_400_001, 1.5, "3600000"]) {
        assert.equal(resolve({ floorMs: bad }).floorMs, 3_600_000, `floorMs ${JSON.stringify(bad)}`);
      }
      assert.equal(resolve({ threshold: 20, floorMs: 60_000 }).threshold, 20, "the upper bound is accepted");
      assert.equal(resolve({ threshold: 20, floorMs: 60_000 }).floorMs, 60_000, "the lower bound is accepted");
    });
  });

  // The latch must not be a second opinion about the terminal breaker: the
  // two counters answer different questions and neither may move the other.
  describe("the two latches stay independent (default settings)", () => {
    it("terminal errors alone do not open the route latch", () => {
      process.chdir(tmp);
      writeSettings({});
      const ctx = makeCtx("rl-m");
      for (let i = 0; i < 3; i++) health.recordLlmError(ctx, classifyLlmError('401 "Authentication failed"'));
      assert.equal(routeLatchOpen(ctx), false, "a terminal streak is not a route streak");
      assert.equal(health.getSessionHealth(ctx).routeErrorsSinceHealthyTurn ?? 0, 0);
    });

    it("route errors alone close the turn-start gate without moving the terminal counter", async () => {
      process.chdir(tmp);
      writeSettings({});
      const ctx = makeCtx("rl-n");
      resetRouteLatch(ctx);
      await feedRouteErrors(ctx, 3);
      assert.equal(health.getSessionHealth(ctx).terminalErrorsSinceHealthyTurn, 0);
      assert.equal(health.isTurnStartBlocked(ctx), true, "the route disjunct alone closes the gate");
    });
  });
});
