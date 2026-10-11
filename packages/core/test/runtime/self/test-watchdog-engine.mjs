/**
 * test-watchdog-engine.mjs — watchdog liveness state machine.
 *
 * Fixture-based: fake tick clock, fake scheduler, injected tunnel events and
 * LLM/quota feed, captured whisper/tg deliveries. No pi runtime, no network,
 * no real timers. Guards the detection matrix + soft backoff + threshold
 * escalation + milestone-throttled re-warns (sparse {20,50,100,200,500}
 * failure-count milestones for quota/tunnel, 4× cooldown for turn-stall)
 * + config loading.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

const { createWatchdogEngine, DEFAULT_WATCHDOG_CONFIG, formatWatchdogDuration } = await import(
  join(ROOT, "dist", "extensions", "self", "watchdog", "engine.js")
);
const { classifyLlmError } = await import(join(ROOT, "dist", "lib", "errors", "llm-error.js"));
const { loadWatchdogConfig } = await import(
  join(ROOT, "dist", "extensions", "self", "watchdog", "config.js")
);

/** Scaled-down config so the 75-min stall / 15-min cadence are testable. */
const CONFIG = {
  mode: "on",
  baseMs: 1000, // BASE = 1s (test), hot = 200ms
  hotMs: 200, // HOT = 200ms
  stallMult: 5, // stall threshold = 5000ms
  quotaErrors: 3,
  tunnelFailures: 3,
};

function makeEngine(config = CONFIG, overrides = {}) {
  let t = 0;
  const clock = {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
  const scheduled = [];
  const calls = { wake: [], quiet: [], tg: [] };
  const tunnelState = { status: "up", failures: 0 };
  let tunnelSubscriber = null;
  const engine = createWatchdogEngine(config, {
    now: clock.now,
    schedule: (cb, ms) => {
      const entry = { cb, ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    wakeWhisper: (text) => calls.wake.push(text),
    quietWhisper: (text) => calls.quiet.push(text),
    tgSignal: (text) => calls.tg.push(text),
    subscribeTunnel: (fn) => {
      tunnelSubscriber = fn;
      return () => {
        tunnelSubscriber = null;
      };
    },
    getTunnelStatus: () => ({ status: tunnelState.status, failures: tunnelState.failures }),
    log: () => {},
    ...overrides,
  });
  return {
    engine,
    clock,
    scheduled,
    calls,
    fireTunnel: (e) => tunnelSubscriber?.(e),
    isTunnelSubscribed: () => tunnelSubscriber !== null,
    setTunnel: (status, failures) => {
      tunnelState.status = status;
      tunnelState.failures = failures;
    },
    /** Cadence of the currently-armed monitor timer (undefined after stop). */
    latestScheduledMs: () => scheduled.filter((e) => !e.cancelled).at(-1)?.ms,
  };
}

// ── Config loading ──────────────────────────────────────────────────────────

test("config: defaults when settings absent; overrides applied; invalid fields fall back", () => {
  const dir = mkdtempSync(join(tmpdir(), "wd-cfg-"));
  try {
    // Absent file -> pure defaults.
    assert.deepEqual(loadWatchdogConfig(join(dir, "absent.json")), DEFAULT_WATCHDOG_CONFIG);

    // Partial overrides: only the given fields change.
    writeFileSync(
      join(dir, "custom.json"),
      JSON.stringify({ broker: { watchdog: { mode: "off", baseMs: 60000, stallMult: 2 } } }),
    );
    const c2 = loadWatchdogConfig(join(dir, "custom.json"));
    assert.equal(c2.mode, "off");
    assert.equal(c2.baseMs, 60000);
    assert.equal(c2.stallMult, 2);
    assert.equal(c2.hotMs, DEFAULT_WATCHDOG_CONFIG.hotMs, "untouched fields keep defaults");
    assert.equal(c2.quotaErrors, DEFAULT_WATCHDOG_CONFIG.quotaErrors);

    // Invalid fields are rejected -> defaults.
    writeFileSync(
      join(dir, "bad.json"),
      JSON.stringify({ broker: { watchdog: { baseMs: -5, quotaErrors: 2.5, mode: "maybe" } } }),
    );
    const c3 = loadWatchdogConfig(join(dir, "bad.json"));
    assert.equal(c3.baseMs, DEFAULT_WATCHDOG_CONFIG.baseMs);
    assert.equal(c3.quotaErrors, DEFAULT_WATCHDOG_CONFIG.quotaErrors);
    assert.equal(c3.mode, "on");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Turn stall ──────────────────────────────────────────────────────────────

test("turn stall: tool-call activity resets the stall clock; no progress > 5×base escalates; turn-end closes", () => {
  const h = makeEngine();
  h.engine.start();
  h.engine.observeSessionStart("s1");
  h.engine.observeTurnStart("s1");

  // Active tool-calling keeps the clock fresh (stall keyed on last tool-call,
  // not wall clock).
  h.clock.advance(4000);
  h.engine.observeToolCall("s1");
  h.clock.advance(4000); // t=8000; age since tool call = 4000 < 5000.
  h.engine.check();
  assert.equal(h.calls.wake.length, 0, "tool-call activity resets the stall clock");

  // Silence beyond the threshold for the active turn -> escalation.
  h.clock.advance(5001); // age = 9001 > 5000.
  h.engine.check();
  assert.equal(h.calls.wake.length, 1);
  assert.match(h.calls.wake[0], /turn stall detected/i);
  assert.equal(h.calls.tg.length, 1, "optional tg signal accompanies the escalation");
  assert.deepEqual(h.engine.getSnapshot().openConditions, ["turn-stall"]);

  // MESSAGE_END progress resolves the stall without a re-warn.
  h.engine.observeProgress("s1");
  h.engine.check();
  assert.equal(h.calls.wake.length, 1);

  // Ending the turn closes the streaming window for good.
  h.engine.observeTurnComplete("s1");
  h.clock.advance(60000);
  h.engine.check();
  assert.equal(h.calls.wake.length, 1, "no re-escalation after turn complete");
  assert.deepEqual(h.engine.getSnapshot().openConditions, []);
});

test("turn stall: re-warns wait for the LONG stall cooldown (4× the normal 2×hot cooldown) while the session stays stalled", () => {
  const h = makeEngine();
  h.engine.start();
  h.engine.observeSessionStart("s1");
  h.engine.observeTurnStart("s1");

  h.clock.advance(5001);
  h.engine.check();
  assert.equal(h.calls.wake.length, 1);
  assert.equal(h.latestScheduledMs(), CONFIG.hotMs, "hot cadence while the stall is open");

  // The old behavior re-warned every normal cooldown (2×hot = 400ms). The
  // milestone throttle gives counter-less turn-stall a LONG fallback cooldown
  // (4× that): a re-warn at the old cadence is now a regression.
  const normalCooldown = 2 * CONFIG.hotMs; // 400ms
  h.clock.advance(normalCooldown + 200); // 600ms elapsed: past the OLD cadence, far under the long one
  h.engine.check();
  assert.equal(
    h.calls.wake.length,
    1,
    "re-warn suppressed at the old per-cooldown cadence (4× cooldown not elapsed)",
  );

  h.clock.advance(1001); // 1601ms since escalation >= long cooldown, still stalled
  h.engine.check();
  assert.equal(h.calls.wake.length, 2, "persistent stall re-warns after the LONG cooldown");
});

// ── Quota loop (classified LLM failures) ────────────────────────────────────

test("quota-loop: escalates at N consecutive quota-class failures with no success; a success clears", () => {
  const h = makeEngine();
  h.engine.start();

  h.engine.recordLlmFailure("429 Too Many Requests");
  h.engine.recordLlmFailure("401 unauthorized: invalid api key");
  h.clock.advance(5000);
  h.engine.check();
  assert.equal(h.calls.wake.length, 0, "below the threshold stays quiet");

  h.engine.recordLlmFailure("quota exceeded");
  h.engine.check();
  assert.equal(h.calls.wake.length, 1);
  assert.match(h.calls.wake[0], /rate-limit\/quota loop/i);
  assert.equal(h.calls.tg.length, 1);

  // A success clears the streak; the issue closes silently.
  h.engine.recordLlmSuccess();
  h.clock.advance(10000);
  h.engine.check();
  assert.equal(h.calls.wake.length, 1);
  assert.deepEqual(h.engine.getSnapshot().openConditions, []);
});

test("terminal-stop: 3 auth/balance failures emit ONE non-waking whisper; 429s never count", () => {
  const h = makeEngine();
  h.engine.start();

  for (let i = 0; i < 3; i++) h.engine.recordLlmFailure("429 Too Many Requests");
  assert.equal(h.calls.quiet.length, 0, "rate limits never open the terminal-stop episode");

  h.engine.recordLlmFailure("401 unauthorized: invalid api key");
  h.engine.recordLlmFailure("402 API key USD spend limit exceeded");
  assert.equal(h.calls.quiet.length, 0, "below the threshold stays quiet");

  h.engine.recordLlmFailure("402 API key USD spend limit exceeded");
  assert.equal(h.calls.quiet.length, 1, "one emission at the threshold");
  assert.match(h.calls.quiet[0], /terminal provider stop/);
  assert.match(h.calls.quiet[0], /3 auth\/balance errors since/);
  assert.match(h.calls.quiet[0], /last: balance 402/);
  assert.doesNotMatch(h.calls.quiet[0], /USD spend limit/, "no raw provider prose is echoed");
  assert.equal(h.calls.wake.length, 0, "the terminal-stop emission is non-waking");
  assert.deepEqual(h.engine.getSnapshot().openConditions, ["terminal-stop"]);

  // Later failures of the same episode are absorbed: one bark per episode.
  h.engine.recordLlmFailure("401 unauthorized");
  assert.equal(h.calls.quiet.length, 1, "one emission per episode");

  // A success ends the episode; the condition closes silently.
  h.engine.recordLlmSuccess();
  assert.deepEqual(h.engine.getSnapshot().openConditions, []);
});

test("quota-loop: soft backoff — hot while open, base when clean", () => {
  const h = makeEngine();
  h.engine.start();
  for (let i = 0; i < 3; i++) h.engine.recordLlmFailure("429");
  h.engine.check();
  assert.equal(h.latestScheduledMs(), CONFIG.hotMs, "hot cadence while the issue is open");

  h.engine.recordLlmSuccess();
  h.engine.check();
  assert.equal(h.latestScheduledMs(), CONFIG.baseMs, "base cadence when clean");
});

test("quota-loop: transient/unknown failures never count toward the quota streak", () => {
  const h = makeEngine();
  h.engine.start();
  for (const detail of [
    "Error: fetch failed",
    "ETIMEDOUT",
    "Error: fetch failed",
    "socket hang up",
    "ECONNABORTED",
  ]) {
    h.engine.recordLlmFailure(detail);
  }
  h.engine.check();
  assert.equal(h.calls.wake.length, 0, "no escalation whisper for transient-class failures");
  assert.equal(
    h.engine.getSnapshot().quotaConsecutive,
    0,
    "quota streak untouched by transient failures",
  );
  assert.deepEqual(h.engine.getSnapshot().openConditions, []);
});

test("quota-loop: rate-limit failures escalate with honest classification text (no stale 429/403/rotation wording)", () => {
  const h = makeEngine();
  h.engine.start();
  h.engine.recordLlmFailure("HTTP 429 rate limit exceeded");
  h.engine.recordLlmFailure("HTTP 429 rate limit exceeded");
  h.engine.recordLlmFailure("HTTP 429 rate limit exceeded");
  h.engine.check();
  assert.equal(h.calls.wake.length, 1);
  assert.match(h.calls.wake[0], /rate-limit\/quota loop/);
  assert.match(h.calls.wake[0], /3 consecutive rate-limit\/quota\/auth failures/);
  assert.doesNotMatch(h.calls.wake[0], /429\/403\/rotation/);
  assert.match(h.calls.tg[0], /rate-limit\/quota loop/);
});

test("quota-loop: key-ring exhaustion text counts toward the quota loop even without a provider error code", () => {
  const h = makeEngine();
  h.engine.start();
  h.engine.recordLlmFailure("key index 1 exhausted — ALL KEYS EXHAUSTED (0/2 usable)");
  h.engine.recordLlmFailure("key index 1 exhausted — ALL KEYS EXHAUSTED (0/2 usable)");
  h.engine.check();
  assert.equal(h.calls.wake.length, 0, "below threshold stays quiet");

  h.engine.recordLlmFailure("key index 1 exhausted — ALL KEYS EXHAUSTED (0/2 usable)");
  h.engine.check();
  assert.equal(h.calls.wake.length, 1, "ring exhaustion counts as quota-class and escalates");
});

test("quota-loop: recordLlmSuccess resets both the quota and transient streaks", () => {
  const h = makeEngine();
  h.engine.start();
  h.engine.recordLlmFailure("429 rate limit exceeded");
  h.engine.recordLlmFailure("Error: fetch failed");
  h.engine.recordLlmFailure("ETIMEDOUT");
  assert.equal(h.engine.getSnapshot().quotaConsecutive, 1, "only the rate-limit failure counts");

  h.engine.recordLlmSuccess();
  assert.equal(h.engine.getSnapshot().quotaConsecutive, 0, "success resets the quota streak");

  // After the reset the loop re-arms from zero: two more failures stay quiet.
  h.engine.recordLlmFailure("429 rate limit exceeded");
  h.engine.recordLlmFailure("429 rate limit exceeded");
  h.engine.check();
  assert.equal(h.calls.wake.length, 0, "streak restarted from zero — below threshold");

  h.engine.recordLlmFailure("429 rate limit exceeded");
  h.engine.check();
  assert.equal(h.calls.wake.length, 1, "streak re-arms and escalates at threshold after reset");
});

test("quota-loop: re-warns are milestone-throttled while continuously open (crossings at 20/50, silent between)", () => {
  const h = makeEngine();
  h.engine.start();

  // Threshold crossing: 3 consecutive quota failures -> first bark.
  for (let i = 0; i < 3; i++) h.engine.recordLlmFailure("429 rate limit exceeded");
  h.engine.check();
  assert.equal(h.calls.wake.length, 1);

  // Cooldown elapses, count climbs 4..19 (no milestone crossed): silent —
  // the old every-cooldown re-warn would have barked here.
  h.clock.advance(500);
  for (let i = 0; i < 16; i++) h.engine.recordLlmFailure("429 rate limit exceeded"); // 19
  h.engine.check();
  assert.equal(
    h.calls.wake.length,
    1,
    "no re-warn below the first milestone even after the cooldown",
  );

  // Crossing 20 -> second bark.
  h.engine.recordLlmFailure("429 rate limit exceeded"); // 20
  h.engine.check();
  assert.equal(h.calls.wake.length, 2, "milestone 20 crossing fires");

  // 21..49: silent across many cooldowns.
  h.clock.advance(500);
  for (let i = 0; i < 29; i++) h.engine.recordLlmFailure("429"); // 49
  h.engine.check();
  assert.equal(h.calls.wake.length, 2, "no re-warn between milestones");

  // Crossing 50 -> third bark; tg signal accompanies every escalation.
  h.engine.recordLlmFailure("429"); // 50
  h.clock.advance(500);
  h.engine.check();
  assert.equal(h.calls.wake.length, 3, "milestone 50 crossing fires");
  assert.equal(h.calls.tg.length, 3, "tg signal accompanies each escalation");
});

test("quota-loop: flap latch — close→open flap does NOT re-fire the wake bark or reset the ladder; re-arms only on a success streak", () => {
  const h = makeEngine();
  h.engine.start();

  // Episode 1: threshold bark at 3, milestone bark at 20.
  for (let i = 0; i < 3; i++) h.engine.recordLlmFailure("429");
  h.engine.check();
  assert.equal(h.calls.wake.length, 1, "first bark (wake-up feature preserved)");
  h.clock.advance(500);
  for (let i = 0; i < 17; i++) h.engine.recordLlmFailure("429"); // 20
  h.engine.check();
  assert.equal(h.calls.wake.length, 2, "milestone 20 fires in episode 1");

  // TRANSIENT close: failures dip below the threshold (1 success, then quiet
  // below-threshold evals). The bug re-fired the threshold bark here and
  // reset the ladder; the latch must keep the episode open (ladder intact).
  h.engine.recordLlmSuccess();
  h.clock.advance(500);
  for (let i = 0; i < 25; i++) h.engine.recordLlmFailure("429");
  h.engine.check(); // 25 failures -> open, but a single success is NOT a re-arm
  assert.equal(h.calls.wake.length, 2, "flap reopen does NOT re-fire the threshold bark");

  // Same episode: crossing 50 re-warns via the INTACT ladder (not a fresh one).
  h.clock.advance(500);
  for (let i = 0; i < 30; i++) h.engine.recordLlmFailure("429"); // 55
  h.engine.check();
  assert.equal(h.calls.wake.length, 3, "ladder intact across the flap: milestone 50 fires");

  // Flap within 2 evals: close→open→close→open stays silent (same episode).
  h.engine.recordLlmSuccess();
  h.engine.recordLlmFailure("429");
  h.engine.recordLlmFailure("429");
  h.engine.recordLlmFailure("429");
  h.clock.advance(500);
  h.engine.check();
  assert.equal(h.calls.wake.length, 3, "open→close→open within 2 evals: no new bark");

  // 3 consecutive successes = SUCCESS STREAK: latch re-arms with a fresh
  // ladder; the next genuine outage gets its own threshold bark.
  h.engine.recordLlmSuccess();
  h.engine.recordLlmSuccess();
  h.engine.recordLlmSuccess();
  h.clock.advance(500);
  for (let i = 0; i < 3; i++) h.engine.recordLlmFailure("429");
  h.engine.check();
  assert.equal(h.calls.wake.length, 4, "new episode after the success streak barks again");
  assert.deepEqual(h.engine.getSnapshot().openConditions, ["quota-loop"]);
});

test("quota-loop: 3 consecutive healthy evaluations re-arm the latch (no LLM successes needed)", () => {
  const h = makeEngine();
  h.engine.start();

  for (let i = 0; i < 3; i++) h.engine.recordLlmFailure("429");
  h.engine.check();
  assert.equal(h.calls.wake.length, 1);

  // Transient close: failures dip below threshold, then healthy evals accrue.
  h.engine.recordLlmSuccess();
  h.clock.advance(500);
  h.engine.check(); // healthy eval 1
  h.engine.check(); // healthy eval 2
  h.engine.check(); // healthy eval 3 -> re-arm
  assert.deepEqual(h.engine.getSnapshot().openConditions, []);

  h.clock.advance(500);
  for (let i = 0; i < 3; i++) h.engine.recordLlmFailure("429");
  h.engine.check();
  assert.equal(h.calls.wake.length, 2, "re-armed latch fires the next episode's first bark");
});

test("quota-loop: injection budget — past 12 barks only the 500 milestone still escalates", () => {
  const h = makeEngine();
  h.engine.start();

  // 12 complete episodes: (3 successes re-arm) + (3 failures + check) each.
  for (let episode = 0; episode < 12; episode++) {
    h.engine.recordLlmSuccess();
    h.engine.recordLlmSuccess();
    h.engine.recordLlmSuccess();
    h.clock.advance(500);
    for (let i = 0; i < 3; i++) h.engine.recordLlmFailure("429");
    h.engine.check();
  }
  assert.equal(h.calls.wake.length, 12, "budget allows exactly 12 escalations");

  // Episode 13: threshold crossing suppressed by the budget.
  h.engine.recordLlmSuccess();
  h.engine.recordLlmSuccess();
  h.engine.recordLlmSuccess();
  h.clock.advance(500);
  for (let i = 0; i < 3; i++) h.engine.recordLlmFailure("429");
  h.engine.check();
  assert.equal(h.calls.wake.length, 12, "13th episode's first bark is budget-suppressed");

  // The 500-milestone escape hatch still fires when the count crosses 500.
  for (let i = 0; i < 500 - 3; i++) h.engine.recordLlmFailure("429"); // 500
  h.clock.advance(500);
  h.engine.check();
  assert.equal(h.calls.wake.length, 13, "500-milestone rung escapes the budget");
});

test("classifier: sleep/network idioms classify as transient, not unknown", () => {
  assert.equal(classifyLlmError("fetch failed").category, "transient");
  assert.equal(classifyLlmError("UND_ERR_CONNECT_TIMEOUT").category, "transient");
  assert.equal(
    classifyLlmError("ETIMEDOUT").category,
    "transient",
    "pre-existing coverage unchanged",
  );
  assert.equal(
    classifyLlmError("HTTP 429 rate limit exceeded").category,
    "rate_limit",
    "rate-limit patterns untouched",
  );
  assert.equal(
    classifyLlmError("insufficient balance").category,
    "balance",
    "balance patterns untouched",
  );
  assert.equal(classifyLlmError("invalid api key").category, "auth", "auth patterns untouched");
});

// ── Tunnel down/up ──────────────────────────────────────────────────────────

test("tunnel: down event escalates with the telegram-authored message; up event recovers quietly", () => {
  const h = makeEngine();
  h.engine.start();
  assert.ok(h.isTunnelSubscribed(), "engine subscribes at start");

  h.fireTunnel({
    status: "down",
    failures: 3,
    lastError: "Conflict",
    message: "Telegram tunnel DOWN: 3 consecutive getUpdates failures (Conflict).",
  });
  assert.equal(h.calls.wake.length, 1);
  assert.match(h.calls.wake[0], /Telegram tunnel DOWN/);
  assert.equal(h.calls.tg.length, 1, "tg signal sent (remote canary warm while tg out)");

  // Repeated down while already down -> one event per outage, no dup.
  h.fireTunnel({ status: "down", failures: 4, lastError: "Conflict", message: "still down" });
  assert.equal(h.calls.wake.length, 1, "no duplicate down escalation");

  // Recovery -> one quiet whisper + condition closed.
  h.fireTunnel({
    status: "up",
    failures: 0,
    message: "Telegram tunnel recovered after 4 consecutive getUpdates failures.",
  });
  assert.equal(h.calls.quiet.length, 1);
  assert.match(h.calls.quiet[0], /recovered/);
  assert.deepEqual(h.engine.getSnapshot().openConditions, []);
});

test("tunnel: a down event below the configured gate does not escalate; the snapshot seatbelt still fires on check", () => {
  const h = makeEngine(CONFIG);
  h.engine.start();

  // Below gate (2 < 3): push handler stays quiet.
  h.fireTunnel({ status: "down", failures: 2, lastError: "blip", message: "marginal" });
  assert.equal(h.calls.wake.length, 0);

  // Seatbelt: if the shared hub's snapshot shows a gated down (e.g. a down
  // event emitted before we subscribed), the next check catches it. This
  // covers a missed push without the detector wedging.
  h.setTunnel("down", 3);
  h.engine.check();
  assert.equal(h.calls.wake.length, 1);
  assert.ok(h.calls.wake[0]);

  // Restore -> closed.
  h.setTunnel("up", 0);
  h.engine.check();
  assert.deepEqual(h.engine.getSnapshot().openConditions, []);
});

test("tunnel: re-warns are milestone-throttled on failures while continuously down; both call sites gated", () => {
  const h = makeEngine();
  h.engine.start();

  // Threshold crossing via the push handler: first bark always fires.
  h.fireTunnel({ status: "down", failures: 3, lastError: "Conflict", message: "tunnel down" });
  assert.equal(h.calls.wake.length, 1);

  // Cooldown elapses, failures climb to 19 (no milestone): silent.
  h.clock.advance(500);
  h.fireTunnel({ status: "down", failures: 19, message: "still down" });
  assert.equal(h.calls.wake.length, 1, "no re-warn below milestone 20");

  // Crossing 20 -> second bark (push-handler path).
  h.fireTunnel({ status: "down", failures: 20, message: "still down" });
  assert.equal(h.calls.wake.length, 2, "milestone 20 crossing fires via the push handler");

  // 21..49: silent.
  h.clock.advance(500);
  h.fireTunnel({ status: "down", failures: 49, message: "still down" });
  assert.equal(h.calls.wake.length, 2, "no re-warn between milestones");

  // Crossing 50 via the snapshot seatbelt (evaluateTunnel): the scheduled
  // detect pass goes through the same gate as the push handler.
  h.setTunnel("down", 50);
  h.clock.advance(500);
  h.engine.check();
  assert.equal(h.calls.wake.length, 3, "milestone 50 crossing fires via the detect pass");

  // Recovery closes the condition and re-arms the ladder.
  h.fireTunnel({ status: "up", failures: 0, message: "recovered" });
  assert.equal(h.calls.quiet.length, 1, "one quiet recovery whisper");
  h.fireTunnel({ status: "down", failures: 3, message: "down again" });
  assert.equal(h.calls.wake.length, 4, "threshold bark re-fires on the new outage");
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

test("stop cancels the monitor timer and unsubscribes the tunnel", () => {
  const h = makeEngine();
  h.engine.start();
  assert.ok(h.latestScheduledMs() !== undefined);
  assert.ok(h.isTunnelSubscribed());

  h.engine.stop();
  assert.equal(h.latestScheduledMs(), undefined, "timer cancelled");
  assert.equal(h.isTunnelSubscribed(), false, "tunnel subscription disposed");
  assert.equal(h.engine.getSnapshot().enabled, false);
});

test("engine is inert when mode is off", () => {
  const h = makeEngine({ ...CONFIG, mode: "off" });
  h.engine.start();
  assert.equal(h.engine.getSnapshot().enabled, false);
  h.engine.recordLlmFailure("403");
  h.engine.recordLlmFailure("403");
  h.engine.recordLlmFailure("403");
  h.engine.recordLlmFailure("403");
  h.engine.check();
  assert.equal(h.calls.wake.length, 0);
});

test("formatWatchdogDuration renders compact human durations", () => {
  assert.equal(formatWatchdogDuration(45000), "45s");
  assert.equal(formatWatchdogDuration(5 * 60 * 1000), "5m");
  assert.equal(formatWatchdogDuration(2 * 3600 * 1000), "2h");
});
