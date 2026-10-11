/**
 * test-watchdog-stall-ladder.mjs — classified stall remediation.
 *
 * The turn-stall condition keeps its original predicate (streaming with no
 * tool-call / turn-complete activity past `stallMult × baseMs`) and its
 * original first bark. This file pins the ladder behind that bark:
 *
 *   - a classification gates actuation — wire silence (no provider stream
 *     activity past `streamSilenceMs`) AND a terminal transcript (a tool
 *     result or provider error with no continuation) AND no wake due;
 *   - the first fire of an episode stays advisory (readiness, not liveness);
 *   - a later confirmed-dead fire persists a resume marker to a durable seat
 *     BEFORE aborting the dead turn, exactly once per episode;
 *   - no durable seat => the turn is marked unready and surfaced, never
 *     killed and forgotten;
 *   - every terminal path ends with an owner page and a stopped ladder
 *     (never an unbounded re-warn over a state that cannot change by being
 *     told about it).
 *
 * Fixture-based: fake clock, fake scheduler, captured whispers/pages/logs,
 * injected stream/transcript feeds, resume-marker/abort/wake-due seams. No pi
 * runtime, no network, no real timers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

const { createWatchdogEngine } = await import(
  join(ROOT, "dist", "extensions", "self", "watchdog", "engine.js")
);

/** Scaled-down config: stall threshold 5000ms, wire silence 3000ms. */
const CONFIG = {
  mode: "on",
  baseMs: 1000,
  hotMs: 200,
  stallMult: 5,
  streamSilenceMs: 3000,
  quotaErrors: 3,
  tunnelFailures: 3,
};

/** The counter-less re-warn fallback: 4 × (2 × hotMs) = 1600ms. */
const LONG_COOLDOWN_MS = 4 * 2 * CONFIG.hotMs;

function makeEngine(config = CONFIG, overrides = {}) {
  let t = 0;
  const clock = {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
  const scheduled = [];
  const calls = { wake: [], quiet: [], tg: [], logs: [] };
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
    log: (level, message) => calls.logs.push(`${level}: ${message}`),
    ...overrides,
  });
  return { engine, clock, scheduled, calls };
}

function stallEpisode(h, key = "s1") {
  return h.engine.getSnapshot().stallEpisodes.find((s) => s.key === key);
}

/** Cross the stall threshold with a streaming turn. */
function crossStallThreshold(h) {
  h.clock.advance(CONFIG.stallMult * CONFIG.baseMs + 1);
}

// ── Classification ──────────────────────────────────────────────────────────

test("classify: a live provider call is not a stall — advisory rung only, no marker, no abort", () => {
  const aborts = [];
  const markers = [];
  const h = makeEngine(CONFIG, {
    persistResumeMarker: (key, marker) => {
      markers.push(marker);
      return true;
    },
    abortTurn: (key) => aborts.push(key),
  });
  h.engine.start();
  h.engine.observeSessionStart("s1");
  h.engine.observeTurnStart("s1");
  // A tool result left the transcript looking terminal, but the provider is
  // streaming on the wire: recent deltas are liveness (heartbeat model).
  h.engine.observeToolResult("s1", "call-1");
  crossStallThreshold(h);
  h.engine.observeStreamActivity("s1", "still generating");
  h.engine.check();

  assert.equal(h.calls.wake.length, 1, "the pre-existing first bark still fires");
  assert.equal(h.calls.tg.length, 1, "the pre-existing out-of-band page still accompanies it");
  assert.equal(aborts.length, 0, "a live call is never aborted");
  assert.equal(markers.length, 0, "no resume marker for a live call");
  assert.equal(stallEpisode(h).classification, "alive");

  // Long cooldown elapses; the call keeps streaming -> the ladder still adds
  // nothing beyond the pre-existing re-warn rung.
  h.clock.advance(LONG_COOLDOWN_MS + 500);
  h.engine.observeStreamActivity("s1", "still generating");
  h.engine.check();
  assert.equal(h.calls.wake.length, 2, "re-warn is the pre-existing rung");
  assert.equal(aborts.length, 0);
  assert.equal(markers.length, 0);
  assert.equal(stallEpisode(h).classification, "alive");
});

test("classify: wire silence + terminal transcript + no wake due → dead; the first fire stays advisory", () => {
  const aborts = [];
  const h = makeEngine(CONFIG, {
    persistResumeMarker: () => true,
    abortTurn: (key) => aborts.push(key),
    isWakeDue: () => false,
  });
  h.engine.start();
  h.engine.observeSessionStart("s1");
  h.engine.observeTurnStart("s1");
  h.engine.observeStreamActivity("s1", "partial output");
  h.engine.observeToolResult("s1", "call-1"); // last transcript event: a result, no continuation
  crossStallThreshold(h);
  h.engine.check();

  assert.equal(h.calls.wake.length, 1, "first fire = the pre-existing advisory bark");
  assert.equal(aborts.length, 0, "the first fire never aborts");
  const ep = stallEpisode(h);
  assert.equal(ep.classification, "dead");
  assert.equal(ep.fires, 1);
  assert.equal(ep.transcriptTerminal, true);
  assert.ok(ep.streamSilentForMs >= 5001, "wire silence is measured from the last stream event");
  assert.ok(
    h.calls.logs.some((line) => /classification dead/.test(line)),
    "the first fire logs the classification",
  );
});

test("classify: a completed assistant message clears the terminal-transcript state (a continuation happened)", () => {
  const aborts = [];
  const h = makeEngine(CONFIG, {
    persistResumeMarker: () => true,
    abortTurn: (key) => aborts.push(key),
    isWakeDue: () => false,
  });
  h.engine.start();
  h.engine.observeSessionStart("s1");
  h.engine.observeTurnStart("s1");
  h.engine.observeStreamActivity("s1");
  h.engine.observeToolResult("s1", "call-1"); // terminal...
  h.engine.observeProgress("s1", "assistant"); // ...until the model continues
  crossStallThreshold(h);
  h.engine.check();
  assert.equal(stallEpisode(h).classification, "silent", "not dead after a continuation");
  h.clock.advance(LONG_COOLDOWN_MS + 100);
  h.engine.check();
  assert.equal(aborts.length, 0, "no abort for a continued turn");
});

test("classify: a due timer/wake keeps the turn non-dead until it is no longer due", () => {
  let wakeDue = true;
  const order = [];
  const h = makeEngine(CONFIG, {
    persistResumeMarker: () => {
      order.push("persist");
      return true;
    },
    abortTurn: () => {
      order.push("abort");
    },
    isWakeDue: () => wakeDue,
  });
  h.engine.start();
  h.engine.observeSessionStart("s1");
  h.engine.observeTurnStart("s1");
  h.engine.observeStreamActivity("s1");
  h.engine.observeToolResult("s1", "call-1");
  crossStallThreshold(h);
  h.engine.check(); // fire 1: silent (a wake is due), advisory
  assert.equal(stallEpisode(h).classification, "silent");
  assert.equal(order.length, 0);

  h.clock.advance(LONG_COOLDOWN_MS + 100);
  h.engine.check(); // fire 2: still wake due -> no actuation
  assert.equal(order.length, 0, "a due wake withholds the abort");
  assert.equal(stallEpisode(h).classification, "silent");

  wakeDue = false;
  h.clock.advance(LONG_COOLDOWN_MS + 100);
  h.engine.check(); // fire 3: silent + terminal + no wake due -> dead -> remediate
  assert.deepEqual(order, ["persist", "abort"]);
});

// ── Ladder ──────────────────────────────────────────────────────────────────

test("ladder: the second confirmed-dead fire persists the marker before aborting once, pages the owner, stops", () => {
  const order = [];
  const h = makeEngine(CONFIG, {
    persistResumeMarker: (key, marker) => {
      order.push(["persist", marker]);
      return true;
    },
    abortTurn: (key) => {
      order.push(["abort", key]);
    },
    isWakeDue: () => false,
  });
  h.engine.start();
  h.engine.observeSessionStart("s1");
  h.engine.observeTurnStart("s1");
  h.engine.observeStreamActivity("s1", "partial output");
  // The dead shape: a tool call was issued and the provider died before it ran.
  h.engine.observeToolCall("s1", {
    toolCallId: "call-7",
    toolName: "bash",
    argsPreview: '{"command":"npm test"}',
  });
  h.engine.observeTranscriptError("s1");
  crossStallThreshold(h);
  h.engine.check(); // fire 1: classify + advisory
  assert.equal(order.length, 0, "the first fire actuates nothing");
  assert.equal(h.calls.wake.length, 1);

  h.clock.advance(LONG_COOLDOWN_MS + 100);
  h.engine.check(); // fire 2: confirmed dead -> remediate
  assert.deepEqual(order.map((e) => e[0]), ["persist", "abort"], "persist strictly before abort");

  const marker = order[0][1];
  assert.equal(marker.pendingToolCall.toolName, "bash");
  assert.equal(marker.pendingToolCall.toolCallId, "call-7");
  assert.match(marker.partialOutput, /partial output/);
  assert.equal(marker.transcriptTerminalKind, "error");
  assert.equal(marker.fires, 2);
  assert.ok(
    h.calls.tg.some((line) => /dead turn aborted/i.test(line)),
    "terminal owner page names the abort",
  );
  assert.ok(
    h.calls.quiet.some((line) => /resume marker/i.test(line)),
    "the session is told to resume from the marker",
  );
  assert.equal(stallEpisode(h).classification, "remediated");
  assert.equal(stallEpisode(h).ended, true);

  // Ladder stopped: repeated ticks neither re-warn nor re-abort.
  h.clock.advance(60_000);
  h.engine.check();
  h.engine.check();
  assert.equal(order.filter((e) => e[0] === "abort").length, 1, "abort invoked exactly once");
  assert.equal(h.calls.wake.length, 1, "no further stall warnings in the episode");
});

test("ladder: no durable seat → unready + surface, no abort", () => {
  for (const seat of ["absent", "refused"]) {
    const aborts = [];
    const overrides = {
      abortTurn: (key) => aborts.push(key),
      isWakeDue: () => false,
    };
    if (seat === "refused") overrides.persistResumeMarker = () => false;
    const h = makeEngine(CONFIG, overrides);
    h.engine.start();
    h.engine.observeSessionStart("s1");
    h.engine.observeTurnStart("s1");
    h.engine.observeStreamActivity("s1");
    h.engine.observeToolResult("s1", "call-1");
    crossStallThreshold(h);
    h.engine.check(); // fire 1: advisory
    h.clock.advance(LONG_COOLDOWN_MS + 100);
    h.engine.check(); // fire 2: dead, but the seat cannot take the marker

    assert.equal(aborts.length, 0, `no abort when the durable seat is ${seat}`);
    assert.ok(
      h.calls.tg.some((line) => /unready/i.test(line)),
      `owner page surfaces the unready turn (seat ${seat})`,
    );
    const ep = stallEpisode(h);
    assert.equal(ep.classification, "unready");
    assert.equal(ep.ended, true);

    h.clock.advance(60_000);
    h.engine.check();
    assert.equal(h.calls.wake.length, 1, `ladder stopped (seat ${seat})`);
  }
});
