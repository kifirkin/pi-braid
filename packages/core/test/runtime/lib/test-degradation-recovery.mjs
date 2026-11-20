/**
 * Regression test: degradation verdict recovery + provider attribution.
 *
 * Root cause: the degradation verdict consumed the session-CUMULATIVE error
 * share (errors/toolCalls over the whole trajectory). The share decays
 * asymptotically, so a resolved error storm kept the verdict negative for
 * dozens of clean turns (a live whisper fired 23 minutes into
 * a healthy session because 3 overnight errors held the cumulative rate
 * above 10%). Compounding it, the storm clause used
 * `recent.some(m => m.consecutiveErrors >= max)` — ONE stale storm entry
 * kept the session degraded while the newest entry had consecutiveErrors 0.
 * And auto-recovery fired a generic agent-degradation whisper for what was
 * actually a provider outage (session-health mode != healthy).
 *
 * Pins five invariants:
 * 1. Evidence pattern: high cumulative share, clean trailing entries →
 *    healthy verdict, no reasons (pre-fix: DEGRADED).
 * 2. A live storm still trips: newest entry consecutiveErrors >= 3 →
 *    degraded with the consecutive-errors reason.
 * 3. Recovery boundary: 1 clean entry after a storm → still degraded
 *    (window still dirty); 2 consecutive clean entries → healthy.
 * 4. Attribution: session-health mode != healthy → the whisper names the
 *    external cause and recommends NO health-checking or re-planning;
 *    healthy mode → agent-degradation whisper (unchanged).
 * 5. Feed honesty: the verdict is driven by the trailing window (deltas),
 *    never by the asymptotically decaying cumulative share.
 * 6. Route exhaustion: a route whose every key is spent is named once per
 *    episode with the ring's own counts and the earliest key's return (the one
 *    clock formatter), never twice for the same episode, again after a real
 *    recovery, and never at all while a key remains or once its named return
 *    time has passed. The record is read from the process-global slot the
 *    providers package publishes, through the reader's own validation.
 *
 * Fixture style: HOME redirect BEFORE the first dist import (braid-paths
 * resolves DEGRADATION_FILE from os.homedir() at module-eval), mirroring
 * test-degradation-session-scoping.mjs.
 *
 * Run: node test/runtime/lib/test-degradation-recovery.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const tmpBase = mkdtempSync(join(tmpdir(), "degradation-recovery-"));
process.env.HOME = tmpBase; // must precede the dist imports below

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const { isDegraded, getDegradationReasons, recordTurnMetrics, resetMetrics } = await import(
  join(ROOT, "dist/lib/detection/degradation-detector.js")
);
const { buildDegradationWhisper, buildRouteExhaustionWhisper, default: autoRecoveryExtension } =
  await import(join(ROOT, "dist/extensions/self/auto-recovery/index.js"));
const { ROUTE_EXHAUSTION_SLOT_KEY, readExhaustedRoutes } = await import(
  join(ROOT, "dist/lib/state/global-state.js")
);
const { formatLocalTime } = await import(join(ROOT, "dist/lib/utils/local-time.js"));
const { beginTurn } = await import(join(ROOT, "dist/lib/enforcement/turn-dedup.js"));
const { clearAllBuckets } = await import(join(ROOT, "dist/lib/utils/injection-tracker.js"));

function makeCtx(sessionId) {
  return {
    sessionManager: {
      getSessionFile: () => sessionId,
      getSessionId: () => sessionId,
    },
  };
}

/** Heartbeat-shaped entry: cumulative errors/toolCalls like the real feed
 *  (totalToolsUsed / trajectory error totals), plus the trailing-error
 *  streak the scheduler counts at snapshot time. */
function entry(turnNumber, toolCalls, errors, consecutiveErrors, errorRate) {
  return {
    turnNumber,
    avgTurnDurationMs: 1000,
    toolCalls,
    errors,
    inputTokens: 100,
    outputTokens: 50,
    errorRate: errorRate ?? (toolCalls > 0 ? errors / toolCalls : 0),
    toolSuccessRate: toolCalls > 0 ? ((toolCalls - errors) / toolCalls) * 100 : 100,
    memoryUsagePercent: 40,
    consecutiveErrors,
    tokenUsage: { input: 100, output: 50 },
  };
}

function feed(ctx, entries) {
  for (const e of entries) recordTurnMetrics(ctx, e);
}

test("evidence pattern: stale cumulative rate, clean newest entry → healthy", () => {
  const ctx = makeCtx("stale-evidence");
  resetMetrics(ctx);
  // Live telemetry mirror, abridged: an overnight provider storm left
  // 3 errors in the trajectory; the newest heartbeat snapshots are clean.
  feed(ctx, [
    entry(2, 8, 0, 0), // pre-storm healthy warm-up
    entry(5, 12, 2, 1), // 0.1667 cumulative
    entry(10, 20, 3, 0), // 0.1500 — the whisper fired on this state
    entry(12, 23, 3, 0), // 0.1304
    entry(16, 28, 3, 0), // 0.1071 — still above the 10% threshold
  ]);

  // Cumulative share is 10.7% and the 5-entry average of the errorRate
  // fields is ~13.8% — both above errorRateMax. The verdict must NOT be
  // degraded: the newest entry is clean and no errors are recent.
  assert.equal(isDegraded(ctx), false, "clean newest entries must clear the verdict");
  const reasons = getDegradationReasons(ctx);
  assert.equal(
    reasons.some((r) => /error rate|consecutive/i.test(r)),
    false,
    `no cumulative-history reasons, got: ${JSON.stringify(reasons)}`,
  );
});

test("live storm still trips: newest entry consecutiveErrors >= 3", () => {
  const ctx = makeCtx("live-storm");
  resetMetrics(ctx);
  feed(ctx, [
    entry(1, 4, 0, 0),
    entry(2, 7, 1, 1),
    entry(3, 9, 2, 2),
    entry(4, 10, 3, 3), // trailing streak at the threshold — still firing
    entry(5, 12, 5, 5),
  ]);

  assert.equal(isDegraded(ctx), true, "a genuine storm must still trip");
  const reasons = getDegradationReasons(ctx);
  assert.ok(
    reasons.some((r) => /consecutive/i.test(r)),
    `storm reason must name consecutive errors, got: ${JSON.stringify(reasons)}`,
  );
});

test("recovery boundary: 1 clean entry stays degraded, 2 clear it", () => {
  const ctx = makeCtx("recovery-boundary");
  resetMetrics(ctx);
  feed(ctx, [
    entry(1, 6, 0, 0),
    entry(2, 9, 1, 1),
    entry(3, 11, 3, 3), // storm entry
    entry(4, 14, 3, 0), // first clean snapshot — window still carries the storm
  ]);
  assert.equal(isDegraded(ctx), true, "one clean entry must not clear the verdict yet");

  recordTurnMetrics(
    ctx,
    entry(5, 17, 3, 0), // second consecutive clean snapshot
  );
  assert.equal(isDegraded(ctx), false, "two consecutive clean entries clear the verdict");
  assert.deepEqual(
    getDegradationReasons(ctx).filter((r) => /error rate|consecutive/i.test(r)),
    [],
    "no stale storm reasons after recovery",
  );
});

test("attribution: provider session-health mode names the external cause", () => {
  const external = buildDegradationWhisper(["High error rate: 20.8%"], "balance");
  assert.match(external, /balance/i, "external whisper names the session-health mode");
  assert.match(external, /provider|external/i, "external whisper labels the cause as external");
  assert.doesNotMatch(
    external,
    /re-plan|different approach|health_maintenance/i,
    "external whisper must not recommend health-checking or re-planning",
  );

  const agent = buildDegradationWhisper(["High error rate: 20.8%"], "healthy");
  assert.match(agent, /health_maintenance/i, "agent whisper keeps the self-check advice");
  assert.match(agent, /re-plan|different approach/i, "agent whisper keeps the re-plan advice");
});

// Route-exhaustion reporting
//
// The record core reads is published by the providers package into a
// process-global slot (ring-health.ts publishRouteExhaustion). These cases
// write that slot the way the publisher does and drive the real extension's
// turn_start, so what is asserted is the whisper a session actually gets and
// when it is allowed to exist.

/** Minimal ExtensionAPI double: captures handlers and every delivered message. */
function fakePi() {
  const handlers = new Map();
  const sent = [];
  return {
    sent,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    handlersFor: (event) => handlers.get(event) ?? [],
    registerTool() {},
    getAllTools: () => [],
    getActiveTools: () => [],
    sendMessage(params, options) {
      sent.push({ params, options });
    },
    sendUserMessage() {},
    appendEntry() {},
  };
}

/** A route out of keys, in the shape the publisher writes. */
function exhaustedRoute(over = {}) {
  const now = Date.now();
  return {
    routeId: "route-a",
    usable: 0,
    total: 3,
    nextRetryAt: now + 5 * 60_000,
    observedAt: now,
    ...over,
  };
}

/** Write the slot exactly as one publisher process would. */
function publishRoutes(routes) {
  globalThis[ROUTE_EXHAUSTION_SLOT_KEY] = new Map(
    routes.map((route) => [route.routeId, route]),
  );
}

test("route-exhaustion whisper names the route, the counts and the return time", () => {
  const retryAt = Date.UTC(2026, 10, 20, 15, 4);
  const text = buildRouteExhaustionWhisper(exhaustedRoute({ nextRetryAt: retryAt }));
  assert.match(text, /route-a/, "the route is named");
  assert.match(text, /\*\*0 of 3\*\*/, "the counts are the ring's own");
  assert.ok(
    text.includes(formatLocalTime(new Date(retryAt), true)),
    `the return time is the one clock formatter, with the date: ${text}`,
  );
  assert.doesNotMatch(
    text,
    new RegExp(String(retryAt)),
    "a raw epoch is not a time a person can act on",
  );
  assert.match(text, /wait for|run the work on another configured route/i, "the choice left is stated");
  assert.match(
    text,
    /retrying before that time cannot change it/i,
    "a retry after the named return is the one that works, so the sentence bounds the wait",
  );
  assert.doesNotMatch(text, /health_maintenance|consider re-planning/i, "a spent key is not a matter for self-review");
});

test("route-exhaustion whisper with no known return says so instead of inventing a time", () => {
  const text = buildRouteExhaustionWhisper(exhaustedRoute({ nextRetryAt: null }));
  assert.match(text, /no key is due back on a known schedule/i);
  assert.doesNotMatch(text, /Invalid Date|NaN|undefined/);
});

test("one whisper per episode: the same record on the next turn is silent", async () => {
  clearAllBuckets();
  publishRoutes([exhaustedRoute()]);
  const pi = fakePi();
  autoRecoveryExtension(pi);
  const turnStart = pi.handlersFor("turn_start")[0];
  const ctx = makeCtx("route-exhaustion-once");

  beginTurn();
  await turnStart({}, ctx);
  assert.equal(pi.sent.length, 1, "the first turn names the route once");
  assert.match(pi.sent[0].params.content[0].text, /route-a/);

  // The platform's own suppressors are cleared so a second send WOULD have
  // been delivered: only that makes "no second whisper" evidence about the
  // episode latch rather than about the flood cap or the re-prime window. The
  // re-prime window matters here specifically: it collapses standalone digits,
  // so two episodes of one route share a body key even when the counts and the
  // return time differ.
  clearAllBuckets();
  beginTurn();
  await turnStart({}, ctx);
  assert.equal(pi.sent.length, 1, "the same episode is not whispered again");
});

test("recovery closes the episode: a fresh exhaustion speaks again", async () => {
  clearAllBuckets();
  publishRoutes([exhaustedRoute()]);
  const pi = fakePi();
  autoRecoveryExtension(pi);
  const turnStart = pi.handlersFor("turn_start")[0];
  const ctx = makeCtx("route-exhaustion-episodes");

  beginTurn();
  await turnStart({}, ctx);
  assert.equal(pi.sent.length, 1, "episode one speaks");

  // The provider observed a usable key: the record is withdrawn, and the turn
  // that sees the withdrawal says nothing.
  publishRoutes([]);
  clearAllBuckets();
  beginTurn();
  await turnStart({}, ctx);
  assert.equal(pi.sent.length, 1, "a recovered route is not reported");

  // A later ring, spent again, is a new episode: it speaks with its own counts.
  publishRoutes([
    exhaustedRoute({ total: 4, nextRetryAt: Date.now() + 9 * 60_000 }),
  ]);
  clearAllBuckets();
  beginTurn();
  await turnStart({}, ctx);
  assert.equal(pi.sent.length, 2, "the next exhaustion of the same route is news again");
  assert.match(pi.sent[1].params.content[0].text, /\*\*0 of 4\*\*/);
});

test("control: no whisper while a key remains, and none for a record already out of date", async () => {
  clearAllBuckets();
  publishRoutes([exhaustedRoute({ usable: 1 })]);
  const pi = fakePi();
  autoRecoveryExtension(pi);
  const turnStart = pi.handlersFor("turn_start")[0];
  const ctx = makeCtx("route-exhaustion-control");

  beginTurn();
  await turnStart({}, ctx);
  assert.equal(pi.sent.length, 0, "a route with a usable key is not out of keys");

  clearAllBuckets();
  publishRoutes([exhaustedRoute({ nextRetryAt: Date.now() - 60_000 })]);
  beginTurn();
  await turnStart({}, ctx);
  assert.equal(
    pi.sent.length,
    0,
    "a record whose named return time has passed is a claim the ring no longer stands behind",
  );
});

test("the slot read fails open: a stranger's value is empty, an unreadable record is skipped", () => {
  globalThis[ROUTE_EXHAUSTION_SLOT_KEY] = "not a map";
  assert.deepEqual(readExhaustedRoutes(), [], "an unexpected slot value reads as no routes");
  globalThis[ROUTE_EXHAUSTION_SLOT_KEY] = new Map([
    ["bad", { routeId: "" }],
    ["good", exhaustedRoute()],
  ]);
  const routes = readExhaustedRoutes();
  assert.equal(routes.length, 1, "an unreadable record is skipped, the readable one survives");
  assert.equal(routes[0].routeId, "route-a");
  routes[0].total = 99;
  assert.equal(
    readExhaustedRoutes()[0].total,
    3,
    "the reader returns copies, so a consumer cannot edit the publisher's state",
  );
});

test("cleanup", () => {
  delete globalThis[ROUTE_EXHAUSTION_SLOT_KEY];
  rmSync(tmpBase, { recursive: true, force: true });
});
