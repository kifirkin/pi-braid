/**
 * Wake-delivery stall alerting — the dead-wake page.
 *
 * Incident shape: the agent loop wedged (a tool call never returned); every
 * timer wake injection then waited the 240s outcome timeout for a settle that
 * could not come, retried three times, and was dropped as permanently
 * undelivered — the timer subsystem knew (its own logs said so) and told
 * nobody outside the session. This fixture proves the feed that closes that
 * gap: the real timer extension (fake pi) forwards threshold-crossing facts
 * through the global-state seam to a real watchdog engine, which escalates
 * out of band (captured whisper + tg) — exactly one alert per dead-delivery
 * episode, one recovery line when wakes resume, nothing per retry.
 *
 * Drive: one harness, three phases, all through production paths —
 * session_start starts the real poller; wedges are simulated by never
 * settling (the pinned queue clock elapses outcome windows; the poller's own
 * drain redelivers what it hands back); provider death by fast settle
 * failures. No agent run, no network.
 *
 * Run: node test/runtime/self/test-watchdog-wake-delivery.mjs
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// Pin the whole persistent tree BEFORE the dist imports: braid-settings bakes
// SETTINGS_PATH from homedir() at module-eval time, and the timer store
// resolves through braidDir() per call. No test may read or write live state.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "braid-wake-delivery-home-"));
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-wake-delivery-braid-"));
process.env.HOME = FAKE_HOME;
process.env.BRAID_HOME = BRAID_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
const SETTINGS_FILE = join(FAKE_HOME, ".pi", "agent", "settings.json");

function writeSettings(obj) {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(obj), "utf-8");
}

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

const timerMod = await import(join(ROOT, "dist", "extensions", "scheduling", "timer", "index.js"));
const { wakeRetryQueue, WAKE_OUTCOME_TIMEOUT_MS } = await import(
  join(ROOT, "dist", "extensions", "scheduling", "timer", "wake-retry.js")
);
const { createWatchdogEngine } = await import(
  join(ROOT, "dist", "extensions", "self", "watchdog", "engine.js")
);
const gs = await import(join(ROOT, "dist", "lib", "state", "global-state.js"));
const {
  resolveWakeDeliveryAlertConfig,
  WAKE_DELIVERY_ALERT_DEFAULT,
  WAKE_ALERT_OUTCOME_TIMEOUTS_MAX,
} = await import(join(ROOT, "dist", "lib", "config", "braid-settings.js"));

/** Scaled-down watchdog config (cadences irrelevant — this condition is
 *  event-driven; the monitor loop never needs to fire). */
const WD_CONFIG = {
  mode: "on",
  baseMs: 1000,
  hotMs: 200,
  stallMult: 5,
  quotaErrors: 3,
  tunnelFailures: 3,
};

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

/** The exhausted-notice text the extension sends for a dropped fire. */
function dropNotice(m) {
  return m?.params?.content?.[0]?.text?.includes("permanently undelivered") === true;
}

// ── one harness for the whole fixture (one poller, one episode timeline) ────

writeSettings({});
const pi = makeFakePi();
timerMod.default(pi); // wires the queue observer (threshold forwarding)

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
});
engine.start();
// What watchdog/index.ts publishes at engine build time. Optional chaining
// keeps the fixture loadable against a build without the seam: the feed is
// simply absent, and the scenario asserts below fail on the missing page.
gs.setWatchdogWakeDeliveryFeed?.({
  recordWakeOutcomeTimeout: engine.recordWakeOutcomeTimeout,
  recordWakeUndelivered: engine.recordWakeUndelivered,
  recordWakeDelivered: engine.recordWakeDelivered,
});

let now = Date.now();
wakeRetryQueue._setClockForTests(() => now);
const ctx = { sessionManager: { getSessionId: () => "wake-delivery" }, isIdle: () => true };
pi.emit("session_start", {}, ctx); // starts the poller (sets its piRef)

function makeTimer(id, reason = "babysit deploy checks") {
  return { id, sessionId: "wake-delivery", firesAt: now, reason, createdAt: now, wake: true };
}

/** Advance the queue clock one outcome window (+ worst backoff) and run one
 *  extension drain tick — the same path a poll tick uses. */
async function windowTick() {
  now += WAKE_OUTCOME_TIMEOUT_MS + 6_000;
  pi.emit("tool_execution_end", {}, ctx);
  await sleep(50); // let the drain's deferred redelivery land
  return pi.sent.some(dropNotice);
}

/** Wedge drive: advance until the chain exhausts (bounded), return whether
 *  the exhausted notice landed. */
async function wedgeToExhaustion() {
  for (let i = 0; i < 20; i++) {
    if (await windowTick()) return true;
  }
  return pi.sent.some(dropNotice);
}

afterEach(() => {
  // No cross-test queue state: every scenario starts from an empty queue.
  wakeRetryQueue.resetForTests();
});

describe("wake-delivery stall alerting (timer feed → watchdog)", () => {
  it(
    "wedge → one early page, drop absorbed; recovery line; mode off silences; " +
      "fast-fail drop pages",
    async () => {
      // ── Phase 1: the incident — wedged loop, wakes die, one alert ──
      wakeRetryQueue.trackWake(makeTimer("t-wedge"));

      // Outcome window #1: one timeout is a normal long turn — no page yet.
      await windowTick();
      assert.equal(calls.tg.length, 0, "first outcome timeout must not page");
      assert.equal(calls.wake.length, 0);

      // The wedged loop never settles; the extension redelivers on its own
      // drain path while outcome windows keep elapsing, until exhaustion.
      assert.ok(await wedgeToExhaustion(), "the wake chain must reach exhaustion");

      // Exactly ONE alert for the whole dead-delivery episode: the early
      // repeated-timeout page. The later exhausted drop is absorbed — a
      // wedged loop must not produce one message per retry or per drop.
      assert.equal(calls.tg.length, 1, "one tg page for the episode");
      assert.equal(calls.wake.length, 1, "one waking whisper for the episode");
      assert.match(calls.tg[0], /wake/);
      assert.match(
        calls.tg[0],
        /no active run/,
        "the page states what the queue guarantees: timeouts only arm with no active run",
      );
      assert.ok(
        engine.getSnapshot().openConditions.includes("wake-delivery"),
        "episode stays open",
      );

      // Wakes resume: a fresh fire delivers and its run settles delivered.
      wakeRetryQueue.trackWake(makeTimer("t-recovered"), 0);
      wakeRetryQueue.onAgentEnd(false);
      wakeRetryQueue.onAgentSettled();

      assert.equal(calls.tg.length, 2, "one recovery tg line");
      assert.match(calls.tg[1], /recovered/);
      assert.equal(calls.quiet.length, 1, "one recovery whisper");
      assert.deepEqual(engine.getSnapshot().openConditions, [], "episode closed");

      // ── Phase 2: braid.timers.wakeAlert.mode = "off" — the feed goes
      // silent, delivery itself unchanged ──
      writeSettings({ braid: { timers: { wakeAlert: { mode: "off" } } } });
      wakeRetryQueue.trackWake(makeTimer("t-off"));
      assert.ok(await wedgeToExhaustion(), "delivery still runs its normal chain");
      assert.equal(calls.tg.length, 2, "no page when disabled");
      assert.equal(calls.wake.length, 1);

      // ── Phase 3: settings back on; a fast-fail provider burns the
      // redelivery bound in seconds (no 240s windows) — the exhausted drop
      // is the episode's first event → it pages ──
      writeSettings({});
      const before = calls.tg.length;
      const exhaustedBefore = wakeRetryQueue.getStats().exhausted; // cumulative
      wakeRetryQueue.trackWake(makeTimer("t-drop"));
      const deadline = Date.now() + 20_000;
      while (wakeRetryQueue.getStats().exhausted <= exhaustedBefore &&
             Date.now() < deadline) {
        wakeRetryQueue.onAgentEnd(true, "insufficient_quota");
        wakeRetryQueue.onAgentSettled(); // arms the next redelivery
        now += 150_000; // past every armed backoff tier (5s..2m)
        await sleep(1_200); // the poll tick redelivers via the extension
      }
      assert.ok(
        wakeRetryQueue.getStats().exhausted > exhaustedBefore,
        "chain must exhaust",
      );
      await sleep(1_200); // the poll tick takes the exhausted fire
      assert.equal(calls.tg.length, before + 1, "the drop page is the one alert");
      assert.match(calls.tg[calls.tg.length - 1], /permanently undelivered/);
      assert.equal(calls.wake.length, 2, "one waking whisper for this episode too");

      // And the episode closes with one recovery line.
      const tgBeforeRecovery = calls.tg.length;
      wakeRetryQueue.trackWake(makeTimer("t-healed"), 0);
      wakeRetryQueue.onAgentEnd(false);
      wakeRetryQueue.onAgentSettled();
      assert.equal(calls.tg.length, tgBeforeRecovery + 1, "one recovery tg line");
      assert.match(calls.tg[tgBeforeRecovery], /recovered/);
    },
    { timeout: 30_000 },
  );
});

describe("resolveWakeDeliveryAlertConfig", () => {
  it("absent → defaults; valid overrides pass; invalid fields fall back", () => {
    assert.deepEqual(resolveWakeDeliveryAlertConfig(undefined), WAKE_DELIVERY_ALERT_DEFAULT);
    assert.deepEqual(resolveWakeDeliveryAlertConfig({ mode: "off", outcomeTimeouts: 4 }), {
      mode: "off",
      outcomeTimeouts: 4,
    });
    assert.deepEqual(resolveWakeDeliveryAlertConfig({ mode: "maybe" }), {
      mode: "on",
      outcomeTimeouts: WAKE_DELIVERY_ALERT_DEFAULT.outcomeTimeouts,
    });
    // 1 would page on every normal long turn → default.
    assert.equal(resolveWakeDeliveryAlertConfig({ outcomeTimeouts: 1 }).outcomeTimeouts, 2);
    assert.equal(
      resolveWakeDeliveryAlertConfig({ outcomeTimeouts: WAKE_ALERT_OUTCOME_TIMEOUTS_MAX + 1 })
        .outcomeTimeouts,
      2,
    );
    assert.deepEqual(resolveWakeDeliveryAlertConfig("nope"), WAKE_DELIVERY_ALERT_DEFAULT);
  });
});

describe("long-run grace: an active run is not a dead delivery", () => {
  it(
    "REGRESSION: while the session runs the wake's turn, no timeout arms, nothing redelivers, no page; the settle resolves the fire",
    async () => {
      // Flip the extension's captured ctx to a busy session (isIdle false:
      // a run is in flight — the wake's turn is merely long). tool_call's
      // handler captures ctx; the grace predicate live-reads it.
      const busyCtx = { sessionManager: { getSessionId: () => "wake-delivery" }, isIdle: () => false };
      pi.emit("tool_call", {}, busyCtx);

      const tgBefore = calls.tg.length;
      const wakeBefore = calls.wake.length;
      const retryBefore = pi.sent.filter((m) => m.params?.details?._braidSource === "timer/fire-retry").length;
      wakeRetryQueue.trackWake(makeTimer("t-longrun"));
      for (let i = 0; i < 6; i++) {
        now += WAKE_OUTCOME_TIMEOUT_MS + 6_000; // windows keep elapsing mid-run
        pi.emit("tool_execution_end", {}, busyCtx); // drain ticks re-capture the busy ctx
        await sleep(50);
      }
      assert.equal(
        pi.sent.filter((m) => m.params?.details?._braidSource === "timer/fire-retry").length,
        retryBefore,
        "no redelivery while the run is active (long-run grace)",
      );
      assert.equal(calls.tg.length, tgBefore, "no page for a merely-long run");
      assert.equal(calls.wake.length, wakeBefore, "no waking whisper for a merely-long run");

      // The long run settles delivered: the fire resolves, nothing was armed.
      wakeRetryQueue.onAgentEnd(false);
      wakeRetryQueue.onAgentSettled();
      assert.equal(wakeRetryQueue.outstandingCount(), 0, "the settle resolved the wake");
      assert.equal(wakeRetryQueue.pendingRetryCount(), 0);
      assert.deepEqual(engine.getSnapshot().openConditions, [], "the episode never opened");

      // Restore the idle ctx so later scenarios arm normally.
      pi.emit("tool_execution_end", {}, ctx);
    },
    { timeout: 30_000 },
  );
});
