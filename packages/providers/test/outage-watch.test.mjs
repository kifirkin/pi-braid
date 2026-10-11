#!/usr/bin/env node
/**
 * outage-watch.test.mjs
 *
 * Offline regression suite for packages/providers/outage-watch.ts: the
 * connectivity-failure classifier, the circuit breaker's transitions and
 * half-open gate, the terminal text pi-core must not read as retryable, the
 * machine-global notify floor (claim file) and message rendering, and the
 * stalled-session visibility line. No network: the probe and the sender and
 * the clock and the tick scheduler are all injected.
 *
 * Harness: the REAL modules (outage-watch, ring-lifecycle, key-ring,
 * route-state, log) are compiled with the package's local tsc (CJS emit) into
 * <repoRoot>/.outage-watch-build/ and loaded in-process. Every case injects
 * its own claim path under a temp root, so nothing touches the real
 * ~/.pi/agent.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");

let failures = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name}${extra ? " (" + extra + ")" : ""}`);
  }
}

function loadModule() {
  const buildDir = mkdtempSync(join(tmpdir(), "outage-watch-build-"));
  mkdirSync(buildDir, { recursive: true });
  const args = [
    tscBin,
    "--ignoreConfig",
    join(pkgRoot, "outage-watch.ts"),
    "--outDir",
    buildDir,
    "--module",
    "commonjs",
    "--target",
    "ES2022",
    "--lib",
    "ES2022",
    "--strict",
    "--esModuleInterop",
    "--skipLibCheck",
    "--forceConsistentCasingInFileNames",
    "--types",
    "node",
  ];
  const tsc = spawnSync("node", args, { cwd: pkgRoot, encoding: "utf-8" });
  if (tsc.status !== 0) {
    console.error(
      "tsc emit failed:\n" + (tsc.stdout || "") + (tsc.stderr || ""),
    );
    process.exit(1);
  }
  const require = createRequire(import.meta.url);
  return {
    outage: require(join(buildDir, "outage-watch.js")),
    log: require(join(buildDir, "log.js")),
  };
}

const { outage, log } = loadModule();
const tmpRoot = mkdtempSync(join(tmpdir(), "outage-watch-"));
let caseSeq = 0;
function claimPathFor(name) {
  caseSeq++;
  return join(tmpRoot, `case-${caseSeq}-${name}.json`);
}

/** Fake clock: explicit ms, advanced only by the test. */
function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      return t;
    },
  };
}

/** Captured tick scheduler; returns the manual pump. */
function makeScheduler() {
  const fns = [];
  return {
    scheduleTick: (fn) => {
      fns.push(fn);
      return () => {
        const i = fns.indexOf(fn);
        if (i >= 0) fns.splice(i, 1);
      };
    },
    pump() {
      for (const fn of [...fns]) fn();
    },
    count() {
      return fns.length;
    },
  };
}

function fail(providerId, errorMessage, stopReason = "error") {
  return { provider: providerId, stopReason, errorMessage };
}

const ROUTE = "route-a";
const TARGETS = [{ providerId: ROUTE, url: "http://route-a.invalid/v1" }];

/** Let injected async deps (probe/sender) settle between synchronous pumps. */
const settle = () => new Promise((r) => setTimeout(r, 5));

// ── 1. classification ───────────────────────────────────────────────────────

console.log("\nclassification:");
for (const text of [
  "Request timed out",
  "ETIMEDOUT: connection timed out",
  "connect ECONNREFUSED 127.0.0.1:443",
  "socket hang up",
  "fetch failed",
  "other side closed",
  "502 Bad Gateway",
  "503 Service Unavailable",
  "upstream connect error or disconnect/reset before headers",
  "Overloaded",
]) {
  check(
    `connectivity: ${JSON.stringify(text.slice(0, 48))}`,
    outage.classifyConnectivityFailure(text) === true,
  );
}
for (const text of [
  "429 Too Many Requests",
  "rate limit exceeded",
  "too many requests",
  "401 Unauthorized",
  "invalid api key",
  "403 Forbidden",
  "402 Payment Required: insufficient balance",
  "quota exceeded",
  "413 Request Entity Too Large",
  "context_length_exceeded",
  "400 Bad Request",
  "AbortError: The operation was aborted",
  "",
]) {
  check(
    `not connectivity: ${JSON.stringify(text.slice(0, 48))}`,
    outage.classifyConnectivityFailure(text) === false,
  );
}
check(
  "not connectivity: edge/WAF block page",
  outage.classifyConnectivityFailure(
    "<html><head><title>Blocked</title></head><body>Access denied by edge</body></html>",
  ) === false,
);

// ── 2. breaker transitions ──────────────────────────────────────────────────

console.log("\nbreaker:");
{
  const clock = makeClock();
  const scheduler = makeScheduler();
  const sent = [];
  const w = outage.createOutageWatch({
    targets: TARGETS,
    config: { failureThreshold: 3, notifyFloorMs: 60_000 },
    now: clock.now,
    sender: (text) => {
      sent.push(text);
      return true;
    },
    scheduleTick: scheduler.scheduleTick,
    claimPath: claimPathFor("breaker"),
    log: () => {},
  });

  check("closed before any failure", w.admit(ROUTE, clock.now()) === true);
  w.observe(fail(ROUTE, "Request timed out"), "/sessions/a.jsonl", clock.now());
  w.observe(fail(ROUTE, "ETIMEDOUT"), "/sessions/a.jsonl", clock.now());
  check("still closed at 2 failures", w.admit(ROUTE, clock.now()) === true);
  check("no message before the threshold", sent.length === 0);
  w.observe(fail(ROUTE, "socket hang up"), "/sessions/a.jsonl", clock.now());
  check(
    "open at 3 consecutive failures",
    w.admit(ROUTE, clock.now()) === false,
  );
  check("one owner message at the down transition", sent.length === 1);
  check(
    "down message names route, count and next check",
    sent[0].includes(`"${ROUTE}"`) &&
      sent[0].includes("3 consecutive") &&
      sent[0].includes("next check"),
    sent[0],
  );
  const blocked = w.blockedText(ROUTE, clock.now());
  check(
    "blocked text names route, count and notifier status",
    blocked.includes(`"${ROUTE}"`) &&
      blocked.includes("3 consecutive") &&
      blocked.includes("Owner alert sent"),
    blocked,
  );
  // pi-core's retryable-provider-error vocabulary, curated from the installed
  // pi-ai pattern (RETRYABLE_PROVIDER_ERROR_PATTERN). A blocked text matching
  // any of these would flip pi-core back into the retry storm.
  const RETRYABLE_CANARY =
    /overloaded|high demand|at capacity|rate.?limit|too many requests|429|50[0234]|520|524|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|timed? out|timeout|terminated|websocket|ended without|stream ended before|retry delay|retry your request/i;
  check(
    "blocked text is NOT retryable to pi-core",
    !RETRYABLE_CANARY.test(blocked),
    blocked,
  );

  // The counter keeps growing while open; the display must never sprout a
  // three-digit number that pi-core reads as a 5xx status.
  for (let i = 0; i < 200; i++) {
    w.observe(
      fail(ROUTE, "Request timed out"),
      "/sessions/a.jsonl",
      clock.now(),
    );
  }
  const blockedHigh = w.blockedText(ROUTE, clock.now());
  check(
    "high failure counts stay outside the retry vocabulary",
    blockedHigh.includes("99 consecutive") &&
      !RETRYABLE_CANARY.test(blockedHigh),
    blockedHigh,
  );

  // repeat failures while open: no second message, no reopen transition
  w.observe(fail(ROUTE, "Request timed out"), "/sessions/a.jsonl", clock.now());
  w.observe(fail(ROUTE, "Request timed out"), "/sessions/a.jsonl", clock.now());
  check("no repeat message while open", sent.length === 1);

  // half-open: one call after the cooldown, then closed again
  check(
    "half-open refuses before the cooldown",
    w.admit(ROUTE, clock.now()) === false,
  );
  clock.advance(60_001);
  check("half-open admits one call", w.admit(ROUTE, clock.now()) === true);
  check("half-open slot is single-use", w.admit(ROUTE, clock.now()) === false);
  w.observe(fail(ROUTE, "Request timed out"), "/sessions/a.jsonl", clock.now());
  check(
    "failed half-open attempt re-arms the cooldown",
    w.admit(ROUTE, clock.now()) === false,
  );

  // recovery via a real call
  clock.advance(60_001);
  check(
    "admitted again after the new cooldown",
    w.admit(ROUTE, clock.now()) === true,
  );
  w.observe(
    { provider: ROUTE, stopReason: "stop" },
    "/sessions/a.jsonl",
    clock.now(),
  );
  check("success closes the breaker", w.admit(ROUTE, clock.now()) === true);
  check("openRoutes empty after recovery", w.openRoutes().length === 0);
  check(
    "recovery message sent",
    sent.length === 2 && sent[1].includes("RECOVERED"),
  );

  w.stop();
}

// ── 3. non-connectivity classes never open ──────────────────────────────────

console.log("\nnon-connectivity classes:");
{
  const clock = makeClock();
  const scheduler = makeScheduler();
  const sent = [];
  const w = outage.createOutageWatch({
    targets: TARGETS,
    config: { failureThreshold: 2 },
    now: clock.now,
    sender: (text) => {
      sent.push(text);
      return true;
    },
    scheduleTick: scheduler.scheduleTick,
    claimPath: claimPathFor("classes"),
    log: () => {},
  });
  w.observe(fail(ROUTE, "429 Too Many Requests"), "/s.jsonl", clock.now());
  w.observe(fail(ROUTE, "429 Too Many Requests"), "/s.jsonl", clock.now());
  w.observe(fail(ROUTE, "402 insufficient balance"), "/s.jsonl", clock.now());
  check(
    "throttle/quota never open the breaker",
    w.admit(ROUTE, clock.now()) === true,
  );
  check("no message for non-connectivity", sent.length === 0);
  w.stop();
}

// ── 4. the failure window ───────────────────────────────────────────────────

console.log("\nfailure window:");
{
  const clock = makeClock();
  const w = outage.createOutageWatch({
    targets: TARGETS,
    config: {
      failureThreshold: 3,
      failureWindowMs: 10_000,
      notifyFloorMs: 1000,
    },
    now: clock.now,
    sender: () => true,
    scheduleTick: makeScheduler().scheduleTick,
    claimPath: claimPathFor("window"),
    log: () => {},
  });
  w.observe(fail(ROUTE, "Request timed out"), "/s.jsonl", clock.now());
  w.observe(fail(ROUTE, "Request timed out"), "/s.jsonl", clock.now());
  clock.advance(10_001); // the streak is now older than the window
  w.observe(fail(ROUTE, "Request timed out"), "/s.jsonl", clock.now());
  check(
    "stale streak restarts instead of opening",
    w.admit(ROUTE, clock.now()) === true,
  );
  w.observe(fail(ROUTE, "Request timed out"), "/s.jsonl", clock.now());
  w.observe(fail(ROUTE, "Request timed out"), "/s.jsonl", clock.now());
  check(
    "a fresh in-window streak opens",
    w.admit(ROUTE, clock.now()) === false,
  );
  w.stop();
}

// ── 5. notify floor / claim file ────────────────────────────────────────────

console.log("\nnotify claim:");
{
  const clock = makeClock();
  const claimPath = claimPathFor("claim");
  const sentA = [];
  const first = outage.createOutageWatch({
    targets: TARGETS,
    config: { failureThreshold: 2, notifyFloorMs: 60_000 },
    now: clock.now,
    sender: (t) => {
      sentA.push(t);
      return true;
    },
    scheduleTick: makeScheduler().scheduleTick,
    claimPath,
    log: () => {},
  });
  first.observe(fail(ROUTE, "Request timed out"), "/s.jsonl", clock.now());
  first.observe(fail(ROUTE, "Request timed out"), "/s.jsonl", clock.now());
  check("first process sends the down message", sentA.length === 1);
  const fileText = readFileSync(claimPath, "utf-8");
  check(
    "claim file records the transition",
    fileText.includes("down"),
    fileText,
  );

  // A second process (fresh watcher, same host) must not repeat the message.
  const sentB = [];
  const second = outage.createOutageWatch({
    targets: TARGETS,
    config: { failureThreshold: 2, notifyFloorMs: 60_000 },
    now: clock.now,
    sender: (t) => {
      sentB.push(t);
      return true;
    },
    scheduleTick: makeScheduler().scheduleTick,
    claimPath,
    log: () => {},
  });
  second.observe(fail(ROUTE, "Request timed out"), "/s.jsonl", clock.now());
  second.observe(fail(ROUTE, "Request timed out"), "/s.jsonl", clock.now());
  check("second process on the host is floored", sentB.length === 0);
  check(
    "floored process reports the alert as already sent",
    second.blockedText(ROUTE, clock.now()).includes("already sent"),
    second.blockedText(ROUTE, clock.now()),
  );

  // A recovery is a different status: it is not floored by the down record.
  clock.advance(1000);
  first.observe(
    { provider: ROUTE, stopReason: "stop" },
    "/s.jsonl",
    clock.now(),
  );
  check(
    "recovery message is not suppressed by the down floor",
    sentA.length === 2,
  );

  // A failed send releases the claim so another process can deliver.
  const claimPath2 = claimPathFor("claim-release");
  const sentC = [];
  const failing = outage.createOutageWatch({
    targets: TARGETS,
    config: { failureThreshold: 1, notifyFloorMs: 60_000 },
    now: clock.now,
    sender: () => false,
    scheduleTick: makeScheduler().scheduleTick,
    claimPath: claimPath2,
    log: () => {},
  });
  failing.observe(fail(ROUTE, "Request timed out"), "/s.jsonl", clock.now());
  check(
    "failed send reports the failure",
    failing.blockedText(ROUTE, clock.now()).includes("failed"),
  );
  failing.observe(
    { provider: ROUTE, stopReason: "stop" },
    "/s.jsonl",
    clock.now(),
  );
  const retry = outage.createOutageWatch({
    targets: TARGETS,
    config: { failureThreshold: 1, notifyFloorMs: 60_000 },
    now: clock.now,
    sender: (t) => {
      sentC.push(t);
      return true;
    },
    scheduleTick: makeScheduler().scheduleTick,
    claimPath: claimPath2,
    log: () => {},
  });
  retry.observe(fail(ROUTE, "Request timed out"), "/s.jsonl", clock.now());
  check("released claim lets a later process deliver", sentC.length === 1);
  first.stop();
  second.stop();
  failing.stop();
  retry.stop();
}

// ── 6. probe loop and recovery ──────────────────────────────────────────────

console.log("\nprobe loop:");
{
  const clock = makeClock();
  const scheduler = makeScheduler();
  const sent = [];
  const probes = [];
  let probeUp = false;
  const w = outage.createOutageWatch({
    targets: TARGETS,
    config: {
      failureThreshold: 1,
      probeIntervalMs: 30_000,
      probeTimeoutMs: 1234,
    },
    now: clock.now,
    sender: (t) => {
      sent.push(t);
      return true;
    },
    probe: async (url, timeoutMs) => {
      probes.push({ url, timeoutMs });
      return probeUp;
    },
    scheduleTick: scheduler.scheduleTick,
    claimPath: claimPathFor("probe"),
    log: () => {},
  });
  w.observe(fail(ROUTE, "Request timed out"), "/s.jsonl", clock.now());
  check("open after the first failure", w.admit(ROUTE, clock.now()) === false);
  check("a tick was scheduled", scheduler.count() === 1);

  // No probe before the interval elapses.
  scheduler.pump();
  check("no probe before the interval", probes.length === 0);
  clock.advance(30_001);
  scheduler.pump();
  await settle();
  check("one probe with the configured budget", probes.length === 1);
  check(
    "probe target is the route's own URL",
    probes[0].url === TARGETS[0].url && probes[0].timeoutMs === 1234,
    JSON.stringify(probes[0]),
  );
  check(
    "a failed probe keeps the breaker open",
    w.admit(ROUTE, clock.now()) === false,
  );
  check("no recovery message for a failed probe", sent.length === 1);

  probeUp = true;
  clock.advance(30_001);
  scheduler.pump();
  await settle();
  check(
    "a passing probe closes the breaker",
    w.admit(ROUTE, clock.now()) === true,
  );
  check(
    "recovery message names the probe result",
    sent.length === 2 && sent[1].includes("RECOVERED"),
    JSON.stringify(sent),
  );
  w.stop();
}

// ── 7. stall visibility ─────────────────────────────────────────────────────

console.log("\nstall visibility:");
{
  const clock = makeClock();
  const scheduler = makeScheduler();
  const lines = [];
  const sent = [];
  const w = outage.createOutageWatch({
    targets: TARGETS,
    config: { failureThreshold: 99, stallThresholdMs: 600_000 },
    now: clock.now,
    sender: (t) => {
      sent.push(t);
      return true;
    },
    scheduleTick: scheduler.scheduleTick,
    claimPath: claimPathFor("stall"),
    log: (level, scope, message) => lines.push(`${level}:${scope}:${message}`),
  });
  w.observe(
    fail(ROUTE, "Request timed out"),
    "/sessions/stuck.jsonl",
    clock.now(),
  );
  clock.advance(599_999);
  scheduler.pump();
  await settle();
  check(
    "no stall line before the threshold",
    lines.length === 0 && sent.length === 0,
  );
  clock.advance(1);
  scheduler.pump();
  await settle();
  check(
    "stall line at the threshold (log + Telegram)",
    lines.length === 1 &&
      sent.length === 1 &&
      sent[0].includes("stuck") &&
      lines[0].includes("stuck"),
    JSON.stringify({ lines, sent }),
  );
  check(
    "stall line names the failing span",
    sent[0].includes("10 min") && sent[0].includes(`"${ROUTE}"`),
    sent[0],
  );
  clock.advance(5_000);
  scheduler.pump();
  await settle();
  check("one stall line per episode", lines.length === 1 && sent.length === 1);
  w.observe(
    { provider: ROUTE, stopReason: "stop" },
    "/sessions/stuck.jsonl",
    clock.now(),
  );
  clock.advance(600_001);
  scheduler.pump();
  await settle();
  check(
    "a success ends the span",
    scheduler.count() === 0 || lines.length === 1,
  );
  w.stop();
}

// ── 8. dispatch guard ───────────────────────────────────────────────────────

console.log("\ndispatch guard:");
{
  const clock = makeClock();
  const w = outage.createOutageWatch({
    targets: TARGETS,
    config: { failureThreshold: 1, notifyFloorMs: 60_000 },
    now: clock.now,
    sender: () => true,
    scheduleTick: makeScheduler().scheduleTick,
    claimPath: claimPathFor("guard"),
    log: () => {},
  });
  const calls = [];
  const streams = {
    stream: (model, context, options) => {
      calls.push(["stream", model, options]);
      return "stream-result";
    },
    streamSimple: (model, context, options) => {
      calls.push(["streamSimple", model, options]);
      return "simple-result";
    },
    fetchDeferred: () => "deferred-untouched",
    marker: "kept",
  };
  const guarded = outage.withBreakerStreams(streams, w.guard(ROUTE));
  check("guarded copy keeps every other field", guarded.marker === "kept");
  check(
    "deferred path is deliberately unwrapped",
    guarded.fetchDeferred() === "deferred-untouched",
  );
  check(
    "closed gate passes both calls through",
    guarded.stream("m", "c", {}) === "stream-result" &&
      guarded.streamSimple("m", "c", {}) === "simple-result",
  );
  check("original streams received the calls", calls.length === 2);

  w.observe(fail(ROUTE, "Request timed out"), "/s.jsonl", clock.now());
  let threw = null;
  try {
    guarded.streamSimple("m", "c", {});
  } catch (err) {
    threw = err;
  }
  check("open gate throws on streamSimple", threw instanceof Error);
  check(
    "thrown text is the blocked text",
    threw && threw.message.includes("paused by the connectivity watchdog"),
    threw && threw.message,
  );
  let threwStream = null;
  try {
    guarded.stream("m", "c", {});
  } catch (err) {
    threwStream = err;
  }
  check("open gate throws on stream", threwStream instanceof Error);
  check("no further original calls while open", calls.length === 2);

  // Provider-shaped wrap: the api map form (pi-ai's union).
  const provider = {
    id: ROUTE,
    name: "route",
    models: [],
    api: {
      "some-api": { streamSimple: () => "mapped" },
      "other-api": { stream: () => "other" },
    },
  };
  const wrapped = outage.withBreakerApi(provider, w.guard(ROUTE));
  check(
    "provider fields survive the wrap",
    wrapped.id === ROUTE && wrapped.name === "route",
  );
  let mappedThrew = false;
  try {
    wrapped.api["some-api"].streamSimple();
  } catch {
    mappedThrew = true;
  }
  check("api-map entries are gated too", mappedThrew === true);
  check(
    "unrelated api-map entries kept",
    typeof wrapped.api["other-api"].stream === "function",
  );
  check(
    "original provider object untouched",
    typeof provider.api["some-api"].streamSimple === "function" &&
      provider.id === ROUTE,
  );
  w.stop();
}

// ── 9. config resolution ────────────────────────────────────────────────────

console.log("\nconfig:");
{
  const cfg = outage.resolveOutageConfig({
    braid: {
      providers: {
        outage: {
          failures: 5,
          windowMs: 60_000,
          probeIntervalMs: 30_000,
          probeTimeoutMs: 2500,
          stallMs: 120_000,
          notifyFloorMs: 90_000,
          enabled: false,
        },
      },
    },
  });
  check(
    "settings override every field",
    cfg.failureThreshold === 5 &&
      cfg.failureWindowMs === 60_000 &&
      cfg.probeIntervalMs === 30_000 &&
      cfg.probeTimeoutMs === 2500 &&
      cfg.stallThresholdMs === 120_000 &&
      cfg.notifyFloorMs === 90_000 &&
      cfg.enabled === false,
    JSON.stringify(cfg),
  );
  const bad = outage.resolveOutageConfig({
    braid: { providers: { outage: { failures: -1, probeTimeoutMs: "soon" } } },
  });
  check(
    "invalid fields fall back to defaults",
    bad.failureThreshold === outage.DEFAULT_OUTAGE_CONFIG.failureThreshold &&
      bad.probeTimeoutMs === outage.DEFAULT_OUTAGE_CONFIG.probeTimeoutMs,
  );
  check(
    "absent block resolves to defaults",
    JSON.stringify(outage.resolveOutageConfig({})) ===
      JSON.stringify(outage.DEFAULT_OUTAGE_CONFIG),
  );

  const settingsPath = join(tmpRoot, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({ braid: { providers: { outage: { failures: 7 } } } }),
  );
  check(
    "loadOutageConfig reads the file",
    outage.loadOutageConfig(settingsPath).failureThreshold === 7,
  );
  writeFileSync(settingsPath, "{ not json");
  check(
    "a corrupt settings file resolves to defaults",
    outage.loadOutageConfig(settingsPath).failureThreshold ===
      outage.DEFAULT_OUTAGE_CONFIG.failureThreshold,
  );
  check(
    "an absent settings file resolves to defaults",
    outage.loadOutageConfig(join(tmpRoot, "nope.json")).failureThreshold ===
      outage.DEFAULT_OUTAGE_CONFIG.failureThreshold,
  );
}

// ── 10. rendering and the seam literal ──────────────────────────────────────

console.log("\nrendering:");
{
  const downText = outage.renderOwnerDownText({
    providerId: ROUTE,
    failures: 4,
    firstFailureAt: new Date(2026, 0, 2, 15, 40, 12).getTime(),
    openedAt: new Date(2026, 0, 2, 15, 40, 12).getTime(),
    nextProbeAt: new Date(2026, 0, 2, 15, 41, 12).getTime(),
    lastError: "Request timed out after 300000ms",
    notify: "sent",
    sessionsFailing: 2,
  });
  check(
    "down message carries route, count, next probe, sessions",
    downText.includes(`"${ROUTE}"`) &&
      downText.includes("4 consecutive") &&
      downText.includes("Sessions failing right now: 2") &&
      downText.includes("Last failure"),
    downText,
  );
  const upText = outage.renderOwnerUpText({
    providerId: ROUTE,
    downSince: new Date(2026, 0, 2, 15, 40, 0).getTime(),
    recoveredAt: new Date(2026, 0, 2, 15, 52, 0).getTime(),
  });
  check(
    "up message carries the down duration",
    upText.includes("RECOVERED") && upText.includes("12 min"),
    upText,
  );
  check(
    "absent-channel label is explicit",
    outage
      .renderBlockedText({
        providerId: ROUTE,
        failures: 3,
        firstFailureAt: 0,
        openedAt: 0,
        nextProbeAt: 0,
        notify: "absent",
        sessionsFailing: 0,
      })
      .includes("No owner alert channel"),
  );
  check(
    "session label strips the path and extension",
    outage.sessionLabel("state/sessions/abc123.jsonl") === "abc123",
  );
  check(
    "the seam literal matches the telegram publisher",
    outage.PROVIDER_OUTAGE_NOTIFY_KEY === "__braid_provider_outage_notify",
  );
  check(
    "readOutageNotifySender finds a published function",
    (() => {
      const fn = () => true;
      globalThis[outage.PROVIDER_OUTAGE_NOTIFY_KEY] = fn;
      const found = outage.readOutageNotifySender();
      delete globalThis[outage.PROVIDER_OUTAGE_NOTIFY_KEY];
      return found === fn;
    })(),
  );
  check(
    "readOutageNotifySender is null when the slot is empty",
    outage.readOutageNotifySender() === null,
  );
}

// ── 11. the watcher never throws into the caller ────────────────────────────

console.log("\nfault containment:");
{
  const clock = makeClock();
  const w = outage.createOutageWatch({
    targets: TARGETS,
    config: { failureThreshold: 1 },
    now: clock.now,
    sender: () => {
      throw new Error("sender exploded");
    },
    scheduleTick: makeScheduler().scheduleTick,
    claimPath: claimPathFor("fault"),
    log: () => {},
  });
  let threw = false;
  try {
    w.observe(fail(ROUTE, "Request timed out"), "/s.jsonl", clock.now());
  } catch {
    threw = true;
  }
  check("a throwing sender is contained", threw === false);
  check("the breaker still opened", w.admit(ROUTE, clock.now()) === false);
  check(
    "the failed alert is reported",
    w.blockedText(ROUTE, clock.now()).includes("failed"),
  );
  w.stop();

  // A foreign provider (another extension's provider) is ignored entirely.
  const clock2 = makeClock();
  const w2 = outage.createOutageWatch({
    targets: TARGETS,
    config: { failureThreshold: 1 },
    now: clock2.now,
    sender: () => true,
    scheduleTick: makeScheduler().scheduleTick,
    claimPath: claimPathFor("foreign"),
    log: () => {},
  });
  w2.observe(
    fail("someone-else", "Request timed out"),
    "/s.jsonl",
    clock2.now(),
  );
  check("foreign providers are not tracked", w2.openRoutes().length === 0);
  w2.stop();
}

// ── report ──────────────────────────────────────────────────────────────────

console.log(`\n${total - failures}/${total} checks passed`);
rmSync(tmpRoot, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
