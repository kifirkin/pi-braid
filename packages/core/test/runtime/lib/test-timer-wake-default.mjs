/**
 * fix 1 + fix 4 (part A): wake-by-default at the tool surface, and the
 * deferred-fire liveness pins for TimerPoller.
 *
 * Fix 1 (wake-by-default): the timer TOOL surface used to default recurring
 * timers (interval_seconds set) to wake:false ("Recurring timers are silent
 * (advisory) by default") even though the manager-level default is wake:true.
 * Owner escalation: recurring fires only arrived as whispers attached to the
 * NEXT user turn (3+ stacked overnight, delivered 18h late). Post-fix, EVERY
 * timer created through the tool wakes by default — recurring included;
 * silence requires an explicit wake:false.
 *
 * Fix 4 part A (deferred-fire liveness pins): a timer expiring while the
 * poller is busy (mid-tool / mid-turn) must fire on the next non-busy tick
 * or TURN_END-path fireExpired() — never wait for a user turn. These pins
 * also lock the load-bearing setTimeout(0) guard: onFire must never run
 * synchronously inside fireExpired()/poll() (V8-stack protection, do not
 * remove).
 *
 * Run: node test/runtime/lib/test-timer-wake-default.mjs
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const timerMod = await import("../../../dist/extensions/scheduling/timer/index.js");
const { TimerPoller } = await import("../../../dist/extensions/scheduling/timer/poller.js");
const { TimerManager } = await import("../../../dist/extensions/scheduling/timer/timer-manager.js");

const originalCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "braid-timer-wake-default-"));
// Pin braid's persistent tree into a private tmpdir: fixture timers must
// never write the live store (braidDir() honors BRAID_HOME per call).
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-timer-home-wake-default-"));
process.env.BRAID_HOME = BRAID_HOME;

function makeFakePi() {
  const registered = {};
  const sent = [];
  return {
    registered,
    sent,
    registerTool(tool) {
      registered[tool.name] = tool;
    },
    on() {},
    sendMessage(params, options) {
      sent.push({ params, options });
    },
  };
}

function flushDeferred() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

after(() => {
  process.chdir(originalCwd);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("fix 1: timer tool surface wakes by default (recurring included)", () => {
  function getTool() {
    const pi = makeFakePi();
    timerMod.default(pi);
    const tool = pi.registered.timer;
    assert.ok(tool, "timer tool registered");
    return tool;
  }

  async function setTimer(tool, params) {
    return tool.execute(
      "call-1",
      { action: "set", ...params },
      {},
      {},
      {
        sessionManager: { getSessionId: () => "w114" },
      },
    );
  }

  it("REGRESSION: recurring timer (interval_seconds, no wake param) defaults to wake:true", async () => {
    const tool = getTool();
    const res = await setTimer(tool, {
      delay_seconds: 5,
      reason: "babysit",
      interval_seconds: 60,
    });
    assert.equal(
      res.details.wake,
      true,
      "recurring timer must WAKE by default at the tool surface (silent only via explicit wake:false)",
    );
    assert.match(res.content[0].text, /\(waking\)/, "confirmation states waking");
    assert.equal(res.details.recurring, true);
    timerMod.clearSessionTimers("w114");
  });

  it("REGRESSION: bounded recurring timer (interval_seconds + count) also wakes by default", async () => {
    const tool = getTool();
    const res = await setTimer(tool, {
      delay_seconds: 5,
      reason: "cron",
      interval_seconds: 30,
      count: 5,
    });
    assert.equal(res.details.wake, true, "cron-style bounded recurrence wakes by default");
    timerMod.clearSessionTimers("w114");
  });

  it("explicit wake:false still produces a silent (advisory) recurring timer", async () => {
    const tool = getTool();
    const res = await setTimer(tool, {
      delay_seconds: 5,
      reason: "heartbeat",
      interval_seconds: 60,
      wake: false,
    });
    assert.equal(res.details.wake, false, "explicit opt-out preserved");
    assert.match(res.content[0].text, /\(silent\)/);
    timerMod.clearSessionTimers("w114");
  });

  it("one-shot default stays wake:true (unchanged legacy)", async () => {
    const tool = getTool();
    const res = await setTimer(tool, { delay_seconds: 5, reason: "reminder" });
    assert.equal(res.details.wake, true);
    timerMod.clearSessionTimers("w114");
  });

  it("tool docs no longer claim recurring timers are silent by default", () => {
    const tool = getTool();
    assert.ok(
      !tool.description.includes("Recurring timers are silent"),
      "description must not advertise the old recurring-silent default",
    );
    const wakeParam = tool.parameters?.properties?.wake;
    assert.ok(wakeParam, "wake parameter documented");
    assert.ok(
      !wakeParam.description.includes("Recurring timers default to silent"),
      "param description must not advertise the old recurring-silent default",
    );
  });

  it("the scheduled timer carries wake=true into the manager + disk persistence", async () => {
    process.chdir(tmp);
    const tool = getTool();
    await setTimer(tool, { delay_seconds: 5, reason: "persist", interval_seconds: 60 });
    const live = timerMod.listTimers("w114");
    assert.equal(live.length, 1);
    assert.equal(live[0].wake, true, "manager entry is waking");
    timerMod.clearSessionTimers("w114");
  });
});

describe("fix 4 part A: timers expiring while busy fire on TURN_END/poll tick", () => {
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  it("busy poller bails; TOOL_EXECUTION_END/TURN_END path (fireExpired) delivers after unbusy", async () => {
    const m = new TimerManager();
    const fired = [];
    const poller = new TimerPoller(
      "busy-1",
      (sid, now) => m.checkExpired(sid, now),
      (t, _pi) => fired.push(t),
      { info: () => {} },
    );
    poller.setPiRef({ sendMessage() {} });
    m.setTimer("busy-1", 30, "mid-tool expiry", undefined, true);

    poller.setBusy(true); // tool_call: poller must NOT fire mid-tool
    await sleep(60); // timer expires while "busy"

    poller.poll(); // busy tick must bail
    await flushDeferred();
    assert.equal(
      fired.length,
      0,
      "busy poll tick must not fire (bail - defer to next non-busy tick or TURN_END)",
    );

    // TURN_END / TOOL_EXECUTION_END path: busy=false + fireExpired
    poller.setBusy(false);
    const expired = poller.fireExpired();
    assert.equal(expired.length, 1, "expired timer recovered on the TURN_END-path fire");
    assert.equal(fired.length, 0, "setTimeout(0) GUARD: onFire must not run synchronously");
    await flushDeferred();
    assert.equal(fired.length, 1, "deferred fire delivers on the next macrotask");
    assert.equal(fired[0].reason, "mid-tool expiry");
  });

  it("LOAD-BEARING: fireExpired() never calls onFire synchronously (V8-stack guard)", async () => {
    const m = new TimerManager();
    const fired = [];
    const poller = new TimerPoller(
      "guard-1",
      (sid, now) => m.checkExpired(sid, now),
      (t) => fired.push(t),
      { info: () => {} },
    );
    poller.setPiRef({ sendMessage() {} });
    m.setTimer("guard-1", 1, "guard", undefined, true);
    await sleep(15); // let the 1ms timer actually expire
    const expired = poller.fireExpired();
    assert.equal(expired.length, 1);
    assert.equal(fired.length, 0, "onFire deferred to setTimeout(0) — must stay");
    await flushDeferred();
    assert.equal(fired.length, 1);
  });

  it("expired-during-busy timer fires on the next REAL poll tick (no user turn)", async () => {
    const m = new TimerManager();
    const fired = [];
    const poller = new TimerPoller(
      "tick-1",
      (sid, now) => m.checkExpired(sid, now),
      (t) => fired.push(t),
      { info: () => {} },
    );
    poller.setPiRef({ sendMessage() {} });
    poller.start();
    m.setTimer("tick-1", 50, "tick expiry", undefined, true);

    poller.setBusy(true); // agent mid-turn
    await sleep(150); // timer expires while busy
    poller.setBusy(false); // turn ends — no explicit fireExpired call

    // The 1s poll interval must pick it up on the next non-busy tick.
    const startedAt = Date.now();
    while (fired.length === 0 && Date.now() - startedAt < 2500) {
      await sleep(50);
    }
    poller.stop();
    assert.equal(fired.length, 1, "poll tick fires the expired timer without any user turn");
  });
});
