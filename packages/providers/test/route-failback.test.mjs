#!/usr/bin/env node
/**
 * route-failback.test.mjs
 *
 * Bounded fail-back regression suite for the route-order rotation engine
 * (packages/providers; guard G1 of the 401-compaction incident report).
 *
 * The engage is one-way within an episode: once a route engages, the primary is
 * only re-probed at the next session start unless the engine's fail-back
 * controller returns the session to it. This suite pins that controller:
 *
 *   1. Never engaged → maybeFailBack is inert (no probe, no notify,
 *      byte-identical to a build without the feature).
 *   2. Probe success after the primary recovers → setModel back to the
 *      captured (fromRoute, modelId), exactly ONE fail-back whisper, engine
 *      fully re-armed (a later primary death re-engages with fresh state).
 *   3. Probe failure → keep serving via the rotated route; the next probe is
 *      allowed only after the full interval (cadence bounded: N turn boundaries
 *      inside one interval → ≤1 probe; interval elapsed → 1 probe).
 *   4. Single-flight: a second maybeFailBack while a probe is still pending
 *      must not start a second probe.
 *   5. reset() (the session_start seam) clears the fail-back state.
 *   6. Honest markers: exactly one engage whisper and one fail-back whisper
 *      per episode; the engage whisper never claims "for the rest of this
 *      session" (the one-way wording the fail-back retires).
 *   7. Constants: probe interval is 10 minutes and sits ABOVE the key-ring
 *      5-minute backoff cap, so a probe always finds a usable ring key
 *      (no transient-exhaustion sentinel false negative); probe timeout is
 *      positive and finite.
 *   8. End-to-end: a real agent-zero ring death through handleMessageEnd engages the
 *      configured route, then maybeFailBack returns the session to the primary.
 *
 * Harness: same as rotation-engine.test.mjs — the REAL modules (ring-lifecycle,
 * key-ring, log) are compiled with the package's own local tsc (CJS emit) into
 * <repoRoot>/.failback-build/ and driven with no network and no pi-ai import.
 * HOME is redirected to an isolated temp dir, and the keyspace is sanitized so
 * ambient AGENT_ZERO_API_KEY* / VENICE_API_KEY* env vars cannot leak into the
 * rings. The probe, setModel and notify are fakes; the engine's clock is
 * injected.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
const buildDir = join(repoRoot, ".failback-build");

const VENICE_MODEL = "deepseek-v4-pro-0813";
const GATEWAY_KEY = "gateway-test-key-0";
const SOURCE = "agent-zero";
const LEG = "venice-direct";

let failures = 0;
let totalChecks = 0;
function check(name, cond, extra) {
  totalChecks++;
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name}${extra ? " (" + extra + ")" : ""}`);
  }
}

/** Compile the handler modules to CJS in buildDir and load them. */
function loadModules() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  const args = [
    tscBin,
    "--ignoreConfig", // sources passed on CLI; the package tsconfig.json is intentionally bypassed
    join(pkgRoot, "ring-lifecycle.ts"),
    join(pkgRoot, "key-ring.ts"),
    join(pkgRoot, "log.ts"),
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
    rl: require(join(buildDir, "ring-lifecycle.js")),
    keyRing: require(join(buildDir, "key-ring.js")),
    log: require(join(buildDir, "log.js")),
  };
}

/** An agent-zero-gateway turn that died with a quota/auth error (real 403 shape). */
function veniceDeathEvent(errorMessage, model) {
  return {
    message: {
      role: "assistant",
      provider: SOURCE,
      model: model ?? VENICE_MODEL,
      content: [{ type: "text", text: "" }],
      usage: { input: 0, output: 0, totalTokens: 0 },
      stopReason: "error",
      errorMessage:
        errorMessage ?? '403 {"error":{"message":"User has no quota left"}}',
      timestamp: Date.now(),
    },
  };
}

/** Fake fail-back deps: counts probes, records setModel + notify. */
function failBackDeps(probeOutcome = true) {
  const calls = { probe: [], setModel: [], notify: [] };
  return {
    calls,
    engage: {
      probe: (source, modelId) => {
        calls.probe.push({ source, modelId });
        return typeof probeOutcome === "function"
          ? probeOutcome()
          : probeOutcome;
      },
      setModel: (provider, model) => {
        calls.setModel.push({ provider, model });
        return true;
      },
      notify: (text) => calls.notify.push(text),
    },
  };
}

async function run() {
  const scratch = mkdtempSync(join(tmpdir(), "pi-braid-route-failback-"));
  try {
    // Isolated key-ring persistence; deterministic fresh state every run.
    process.env.HOME = scratch;
    for (const key of Object.keys(process.env)) {
      if (/^(AGENT_ZERO_API_KEY|VENICE_API_KEY)(_P\d+)?$/.test(key)) {
        delete process.env[key];
      }
    }
    process.env.AGENT_ZERO_API_KEY_P0 = GATEWAY_KEY;
    process.env.VENICE_API_KEY = "direct-test-key-0";

    const { rl, keyRing, log } = loadModules();

    // Register the venice-direct route the way index.ts does (its own ring),
    // so the engine's walk finds it after the agent-zero route.
    rl.registerRoute({
      providerId: LEG,
      keys: "VENICE_API_KEY",
      modelIds: [VENICE_MODEL],
      ring: keyRing.createKeyRing({
        prefix: "VENICE_API_KEY",
        stateFile: "venice-direct",
        healthInRotationInfo: true,
      }),
    });

    // ── Constants + rationale pins ────────────────────────────────────
    check(
      "constants: interval is 10 minutes, above the key-ring 5-min backoff cap",
      rl.FAILBACK_PROBE_INTERVAL_MS === 10 * 60 * 1000 &&
        rl.FAILBACK_PROBE_INTERVAL_MS > 300_000,
    );
    check(
      "constants: probe timeout is positive and finite",
      Number.isFinite(rl.FAILBACK_PROBE_TIMEOUT_MS) &&
        rl.FAILBACK_PROBE_TIMEOUT_MS > 0,
    );

    // Injected clock: the engine's now() advances in test steps.
    let nowMs = 1_000_000;
    const makeEngine = () =>
      rl.createRotationEngine({ order: [SOURCE, LEG], now: () => nowMs });

    /** Engage a fresh engine through the real death path; returns deps. */
    async function engagedEngine(probeOutcome = true) {
      const engine = makeEngine();
      const fb = failBackDeps(probeOutcome);
      const marker = await engine.maybeEngage(
        SOURCE,
        "403 no quota left",
        VENICE_MODEL,
        fb.engage,
      );
      return { engine, fb, marker };
    }

    // ── Case 1: never engaged → inert (zero probes, zero logs) ───────
    {
      const engine = makeEngine();
      const fb = failBackDeps(true);
      const outcome = await engine.maybeFailBack(fb.engage);
      check(
        "inert: never-engaged engine probes nothing, notifies nothing",
        outcome === null &&
          fb.calls.probe.length === 0 &&
          fb.calls.setModel.length === 0 &&
          fb.calls.notify.length === 0,
      );
      // Also inert with a probe that would throw if called (belt).
      const fbThrow = failBackDeps(() => {
        throw new Error("probe must not be called");
      });
      check(
        "inert: maybeFailBack never reaches the probe while disengaged",
        (await engine.maybeFailBack(fbThrow.engage)) === null,
      );
    }

    // ── Case 2: probe failure — stay on the route, cadence bounded ────
    {
      const { engine, fb } = await engagedEngine(false);
      check("setup: engine engaged", engine.isEngaged() === true);
      const t0 = nowMs; // engage time; the first probe waits a full interval
      const early = await engine.maybeFailBack(fb.engage);
      check(
        "cadence: no probe inside the interval after engage",
        early === null && fb.calls.probe.length === 0,
      );
      nowMs = t0 + rl.FAILBACK_PROBE_INTERVAL_MS - 1;
      const justBefore = await engine.maybeFailBack(fb.engage);
      check(
        "cadence: interval-1ms still gates the probe",
        justBefore === null && fb.calls.probe.length === 0,
      );
      nowMs = t0 + rl.FAILBACK_PROBE_INTERVAL_MS;
      const atInterval = await engine.maybeFailBack(fb.engage);
      check(
        "probe dead: outcome probed-dead, no swap to the primary, stays engaged",
        atInterval === "probed-dead" &&
          fb.calls.setModel.every((c) => c.provider === LEG) &&
          engine.isEngaged() === true &&
          fb.calls.probe.length === 1 &&
          fb.calls.probe[0].source === SOURCE &&
          fb.calls.probe[0].modelId === VENICE_MODEL,
      );
      // Same instant + many turn boundaries inside the new interval window:
      // the probe runs at most once.
      for (let i = 0; i < 5; i++) {
        nowMs += 1;
        const again = await engine.maybeFailBack(fb.engage);
        if (again !== null) {
          check("cadence: repeat boundary inside interval probes again", false);
          break;
        }
      }
      check(
        "cadence: 5 more boundaries inside one interval → still exactly 1 probe",
        fb.calls.probe.length === 1,
      );
      nowMs += rl.FAILBACK_PROBE_INTERVAL_MS;
      await engine.maybeFailBack(fb.engage);
      check(
        "cadence: interval elapsed → exactly one more probe",
        fb.calls.probe.length === 2,
      );
    }

    // ── Case 3: probe success — clean fail-back + full re-arm ─────────
    {
      const { engine, fb, marker } = await engagedEngine(true);
      check(
        "setup: engage returned the retry marker",
        typeof marker === "string",
      );
      nowMs += rl.FAILBACK_PROBE_INTERVAL_MS;
      const outcome = await engine.maybeFailBack(fb.engage);
      check("fail-back: outcome failed-back", outcome === "failed-back");
      check(
        "fail-back: setModel back to the captured source + dead turn's model id",
        // The engage swap (provider === LEG) already ran at engage time; the
        // fail-back adds exactly one more swap, back to the primary.
        fb.calls.setModel.filter((c) => c.provider === SOURCE).length === 1 &&
          fb.calls.setModel.some(
            (c) => c.provider === SOURCE && c.model === VENICE_MODEL,
          ) &&
          fb.calls.setModel.filter((c) => c.provider === LEG).length === 1,
      );
      check(
        "fail-back: exactly ONE fail-back whisper, names the route",
        fb.calls.notify.length === 2 &&
          fb.calls.notify[1].includes(SOURCE) &&
          fb.calls.notify[1].includes("fail"),
      );
      check("fail-back: engine disengaged", engine.isEngaged() === false);
      check(
        "fail-back: no further probe after the swap (serving the primary)",
        (await engine.maybeFailBack(fb.engage)) === null &&
          fb.calls.probe.length === 1,
      );

      // Re-arm: the primary dies again → a fresh engage episode with fresh
      // state (one-shot flags cleared, no stale target).
      const marker2 = await engine.maybeEngage(
        SOURCE,
        "403 no quota left",
        VENICE_MODEL,
        fb.engage,
      );
      check(
        "re-arm: a later primary death re-engages with a fresh marker + whisper",
        typeof marker2 === "string" &&
          engine.isEngaged() === true &&
          fb.calls.notify.length === 3,
      );
    }

    // ── Case 4: tamper guards — honest engage wording ─────────────────
    {
      const { fb } = await engagedEngine(true);
      const engageWhisper = fb.calls.notify[0];
      check(
        "tamper guard: engage whisper no longer claims 'for the rest of this session'",
        !engageWhisper.includes("for the rest of this session"),
      );
      check(
        "tamper guard: engage whisper still names the route (existing pin)",
        engageWhisper.includes(LEG),
      );
      check(
        "tamper guard: engage whisper states the bounded probe",
        engageWhisper.includes("probe"),
      );
    }

    // ── Case 5: single-flight — no second probe while one is pending ───
    {
      const engine = makeEngine();
      const calls = { probe: [], setModel: [], notify: [] };
      let releaseProbe;
      const gate = new Promise((r) => (releaseProbe = r));
      await engine.maybeEngage(SOURCE, "403 no quota left", VENICE_MODEL, {
        setModel: () => true,
        notify: (t) => calls.notify.push(t),
      });
      nowMs += rl.FAILBACK_PROBE_INTERVAL_MS;
      const pending = engine.maybeFailBack({
        probe: () => {
          calls.probe.push(1);
          return gate.then(() => false);
        },
        setModel: (p, m) => {
          calls.setModel.push({ p, m });
          return true;
        },
        notify: (t) => calls.notify.push(t),
      });
      check(
        "single-flight: probe dispatch returns a promise",
        pending instanceof Promise,
      );
      const second = await engine.maybeFailBack({
        probe: () => {
          calls.probe.push(1);
          return false;
        },
        setModel: () => true,
        notify: () => {},
      });
      check(
        "single-flight: pending probe gates the second boundary",
        second === null && calls.probe.length === 1,
      );
      releaseProbe(false);
      check(
        "single-flight: settled probe outcome is probed-dead",
        (await pending) === "probed-dead",
      );
    }

    // ── Case 6: reset() clears the fail-back state ────────────────────
    {
      const { engine, fb } = await engagedEngine(true);
      engine.reset(); // the session_start seam
      nowMs += rl.FAILBACK_PROBE_INTERVAL_MS;
      const outcome = await engine.maybeFailBack(fb.engage);
      check(
        "reset: fail-back is inert after reset (no probe, no notify)",
        outcome === null &&
          fb.calls.probe.length === 0 &&
          engine.isEngaged() === false,
      );
    }

    // ── Case 7: no candidate route → inert engage, zero probes ─────────
    {
      const engine = rl.createRotationEngine({
        order: [SOURCE],
        now: () => nowMs,
      });
      const fb = failBackDeps(true);
      const engageMarker = await engine.maybeEngage(
        SOURCE,
        "403 no quota left",
        VENICE_MODEL,
        fb.engage,
      );
      nowMs += rl.FAILBACK_PROBE_INTERVAL_MS * 10;
      const outcome = await engine.maybeFailBack(fb.engage);
      check(
        "no-candidate: engage inert, zero probes after many intervals",
        engageMarker === null &&
          outcome === null &&
          fb.calls.probe.length === 0 &&
          fb.calls.notify.length === 0,
      );
    }

    // ── Case 8: end-to-end through handleMessageEnd (wiring parity) ────
    {
      const engine = makeEngine();
      const fb = failBackDeps(true);
      const hooks = {
        rotation: {
          onRingExhausted: (providerId, errText, modelId) =>
            engine.maybeEngage(providerId, errText, modelId, fb.engage),
        },
      };
      const engaged = await rl.handleMessageEnd(veniceDeathEvent(), hooks);
      check(
        "end-to-end: agent-zero ring death engages the configured route",
        engine.isEngaged() === true &&
          !!engaged?.message?.errorMessage?.includes(
            "rotated to the next configured route",
          ),
      );
      nowMs += rl.FAILBACK_PROBE_INTERVAL_MS;
      const outcome = await engine.maybeFailBack(fb.engage);
      check(
        "end-to-end: fail-back returns the session to the primary",
        outcome === "failed-back" &&
          fb.calls.setModel.some(
            (c) => c.provider === SOURCE && c.model === VENICE_MODEL,
          ) &&
          engine.isEngaged() === false,
      );
    }

    // ── Case 9: probe-failure logging is bounded (stated bound) ────────
    {
      const logLines = [];
      log.setProvidersLogSink((message) => logLines.push(String(message)));
      const { engine } = await engagedEngine(false);
      const t0 = nowMs;
      // Probes spaced a full interval apart; the boundaries between them
      // must produce NO line (the interval is the log bound).
      for (let i = 0; i < 3; i++) {
        nowMs = t0 + rl.FAILBACK_PROBE_INTERVAL_MS * (i + 1);
        await engine.maybeFailBack(failBackDeps(false).engage);
        // Several closely-spaced boundaries right after each probe:
        for (let j = 0; j < 3; j++) {
          nowMs += 1;
          await engine.maybeFailBack(failBackDeps(false).engage);
        }
      }
      const failbackLines = logLines.filter((l) =>
        l.includes("Fail-back probe"),
      );
      check(
        "log bound: 3 spaced probes → exactly 3 lines, intra-interval boundaries silent",
        failbackLines.length === 3,
      );
      check(
        "log bound: the line states the interval bound",
        failbackLines.every((l) => l.includes("probe")),
      );
      log.setProvidersLogSink(undefined);
    }
  } finally {
    delete process.env.AGENT_ZERO_API_KEY_P0;
    delete process.env.VENICE_API_KEY;
    rmSync(scratch, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
  }

  console.log(`\n${totalChecks - failures}/${totalChecks} checks passed`);
  if (failures > 0) process.exit(1);
}

run().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
