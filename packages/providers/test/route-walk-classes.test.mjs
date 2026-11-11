#!/usr/bin/env node
/**
 * route-walk-classes.test.mjs
 *
 * The route walk's failure class and its bound (packages/providers):
 *
 *   1. Class-triggered walk (shape class). An HTTP 4xx the key classifier does
 *      not claim (neither quota/auth/403 nor a context-window/payload error,
 *      and not a WAF page) reaches the walk WITHOUT touching the key ring: the
 *      ring's usable count and its state file are unchanged, the turn still
 *      gets a retry marker, and the walk engages the next eligible route.
 *   2. Route death record. The rejected (route, request) pair is recorded in
 *      the route-state store: the shape class, the HTTP status and the model
 *      id, and NO key hash. Freshness reuses the walk's existing bound
 *      (`probeFreshnessMs`), so a fresh shape death for the same (model id,
 *      status) is passed over by a later walk and reported once through the
 *      throttled skip channel; past the bound the route is eligible again.
 *   3. Convergence stop. When the route the walk engaged rejects the SAME
 *      request shape with the SAME status, two routes have agreed the request
 *      is at fault: the walk stops, says so once, and engages nothing further.
 *   4. Bounded episode chain (key class). The walk is triggered by the failure
 *      class, not by the ring's health, and once an episode is open only the
 *      death of the route the walk is currently serving advances it. A death
 *      of a route the walk did not choose — including a repeated death of the
 *      route that OPENED the episode — stays inert, and the episode's fail-back
 *      target remains the route that opened it.
 *   5. Bound (shape class). The walk is one-directional within an episode: the
 *      route whose death opened it is never re-engaged, so an episode engages
 *      at most |order| - 1 routes and the last death finds nothing left.
 *   6. Spent allowance (key class). An HTTP 429 that reports a spent usage/
 *      plan allowance ("Go usage limit exceeded") is a key-class death: the
 *      route cannot serve the turn until the allowance resets, so the ring is
 *      exhausted, the walk engages the next route, and the turn is handed the
 *      rotation marker. A plain throttle 429 stays `none` (the deliberate
 *      carve-out), and a bare 429 status is never what classifies.
 *   7. Spent allowance, pi-ai-fatal type name. The same condition reported as
 *      a vendor *type* name (GoUsageLimitError) is on pi-ai's non-retryable
 *      list, so pi-core refuses the turn retry whatever the marker says: the
 *      walk still engages (future turns move to the live route), but no marker
 *      is appended - history keeps its real error.
 *   8. Catalog-route attribution. A route registered through the composition
 *      root's catalog mapping seam carries the descriptor's `models` map, so a
 *      shape rejection of an id only that map can translate still engages the
 *      route (the incident: a turn on opencode-go's own dotted id, with the agent-zero
 *      gateway the one healthy route able to serve it). The failing route's
 *      request-shape death is recorded even when the plan finds no candidate.
 *   9. Capacity refusal (capacity class). A cell-capacity answer
 *      ("prefill_cap_refused ... the cell is at capacity") is a fact about the
 *      model id, not about a key: no ring counter and no key-ring state file
 *      moves, the walk engages a sibling route serving the SAME logical model
 *      through that route's `models` map, and the refusing route records a
 *      `model-capacity` death. That death passes a route over for the same
 *      model id only, for its own short bound, and the no-candidate path names
 *      the fact (the id, the bound, the untouched ring) instead of a credential.
 *      The 403-wrapped form is in the same fixture: a status the key predicate
 *      claims must not outrank the sentence.
 *  10. Transport class (the route never answered). A connect timeout that
 *      reports the route's own host and port (`... attempted address:
 *      <host>:443, timeout: ...`) names no HTTP status, so it must not reach
 *      the walk as a request the route refused: the class is `transport`, the
 *      status is null, no key is exhausted, no plan is built, no notice claims
 *      a refusal and the turn is handed no marker. A status the text frames
 *      (`status 503`, `HTTP 400`, a leading `400 Bad Request`) is still read,
 *      the capacity and payload classes keep their precedence, and the four
 *      key-ness rows stay key-ness. The control beside it is a shape refusal
 *      on the same two routes, which still rotates and still records its death.
 *
 * Harness (the pattern rotation-engine.test.mjs establishes): the REAL modules
 * (ring-lifecycle, key-ring, log, route-state) are compiled with the package's
 * own local tsc (CJS emit) into a temp dir OUTSIDE the repo and driven with no
 * network and no pi-ai import. HOME is redirected to an isolated temp dir, so
 * no ring/route state file outside it is touched, and the keyspace is sanitized
 * so ambient keys cannot leak into the rings. Routes are registered through the
 * real registerRoute seam with real rings from createKeyRing; the walk runs
 * through the real createRotationEngine, and the agent-loop cases enter through
 * the real handleMessageEnd with the rotation hook wired the way the extension
 * wires it (index.ts). Only setModel/notify (the pi-core boundary) are fakes.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");

const SHARED_MODEL = "shared/walk-model";
const NOW = 1_700_000_000_000;
const FRESHNESS_MS = 900_000;

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

/** Compile the real handler modules to CJS in buildDir and load them. */
function loadModules(buildDir) {
  mkdirSync(buildDir, { recursive: true });
  const args = [
    tscBin,
    "--ignoreConfig",
    join(pkgRoot, "ring-lifecycle.ts"),
    join(pkgRoot, "key-ring.ts"),
    join(pkgRoot, "log.ts"),
    join(pkgRoot, "route-state.ts"),
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
    rs: require(join(buildDir, "route-state.js")),
  };
}

/** Engage deps recording every setModel/probe/notify; setModel always OK. */
function engageDeps() {
  const calls = { setModel: [], probe: [], notify: [] };
  return {
    calls,
    deps: {
      setModel: (provider, model) => {
        calls.setModel.push({ provider, model });
        return true;
      },
      notify: (text) => calls.notify.push(text),
    },
    probeDeps: {
      probe: (source, modelId) => {
        calls.probe.push({ source, modelId });
        return true;
      },
      setModel: (provider, model) => {
        calls.setModel.push({ provider, model });
        return true;
      },
      notify: (text) => calls.notify.push(text),
    },
  };
}

const readIfExists = (path) =>
  existsSync(path) ? readFileSync(path, "utf8") : null;

async function run() {
  const scratch = mkdtempSync(join(tmpdir(), "pi-braid-walk-classes-"));
  const buildDir = mkdtempSync(join(tmpdir(), "pi-braid-walk-build-"));
  let logApi = null;
  try {
    process.env.HOME = scratch;
    const owned =
      /^(DEAD_KEY|MIDDLE_KEY|HEALTHY_KEY|OTHER_KEY|AGENT_ZERO_API_KEY|VENICE_API_KEY|OPENROUTER_API_KEY)(_P\d+)?$/;
    for (const key of Object.keys(process.env)) {
      if (owned.test(key)) delete process.env[key];
    }
    process.env.DEAD_KEY = "dead-key-0";
    process.env.MIDDLE_KEY = "middle-key-0";
    process.env.HEALTHY_KEY = "healthy-key-0";
    process.env.OTHER_KEY = "other-key-0";

    const { rl, keyRing, log, rs } = loadModules(buildDir);
    logApi = log;
    const keyRingStatePath = (routeId) =>
      join(scratch, ".pi", "agent", `.key-ring-state-${routeId}.json`);
    const routeStatePath = join(
      scratch,
      ".pi",
      "agent",
      ".provider-route-state.json",
    );
    /** The persisted route-state document, or null when nothing was written. */
    const readRouteStateDisk = () => {
      const raw = readIfExists(routeStatePath);
      return raw ? JSON.parse(raw) : null;
    };

    // Three routes serving one shared model id, in table order, plus a fourth
    // that owns the same model id but is NOT in the walk order (the route whose
    // death the walk did not choose).
    for (const [providerId, prefix] of [
      ["dead", "DEAD_KEY"],
      ["middle", "MIDDLE_KEY"],
      ["healthy", "HEALTHY_KEY"],
      ["other", "OTHER_KEY"],
    ]) {
      rl.registerRoute({
        providerId,
        keys: prefix,
        modelIds: [SHARED_MODEL],
        ring: keyRing.createKeyRing({
          prefix,
          stateFile: providerId,
          healthInRotationInfo: true,
        }),
      });
    }

    // The reset for every route-state test: the store's file must start absent.
    rmSync(routeStatePath, { force: true });

    let nowMs = NOW;

    // The engine, wired the way index.ts wires it: the walk order is the route
    // table, freshness is the bound it already consumes, the recorded deaths
    // are read from the store as data, and a shape death is written through the
    // store's own writer (the walk itself never touches a file).
    const routeDeathsFromStore = () => {
      const verdicts = new Map();
      for (const [routeId, entry] of Object.entries(
        rs.readRouteState().routes,
      )) {
        if (entry.deathClass === null) continue;
        verdicts.set(routeId, {
          class: entry.deathClass,
          modelId: entry.deathModelId ?? null,
          status: entry.deathStatus ?? null,
          at: entry.deathAt,
        });
      }
      return verdicts;
    };
    const engineFor = (order) =>
      rl.createRotationEngine({
        order,
        now: () => nowMs,
        probeFreshnessMs: FRESHNESS_MS,
        routeDeaths: routeDeathsFromStore,
        recordRouteDeath: (providerId, death) =>
          rs.recordDeath(providerId, death),
      });

    // The index.ts wiring for a message_end rotation hook.
    const hooksFor = (engine, fb) => ({
      rotation: {
        onRingExhausted: (providerId, errText, modelId) =>
          engine.maybeEngage(providerId, errText, modelId, fb.deps),
      },
    });
    const deathEvent = (provider, model, errorMessage) => ({
      message: { provider, model, stopReason: "error", errorMessage },
    });
    const shapeEvent = (provider, model, status) =>
      deathEvent(provider, model, `${status} request rejected by the provider`);
    const keyEvent = (provider, model) =>
      deathEvent(provider, model, "403 no quota left");

    const logLines = [];
    log.setProvidersLogSink((message, type) =>
      logLines.push({ message, type }),
    );
    const shapeSkipLines = () =>
      logLines.filter(
        (l) =>
          l.message.includes("rejected this request") &&
          l.message.includes("passed over"),
      );

    // ── Class-triggered walk: the shape class reaches the walk ─────────────
    {
      const fb = engageDeps();
      const engine = engineFor(["dead", "middle", "healthy"]);
      const hooks = hooksFor(engine, fb);
      const ringBefore = rl.getKeyRingStatusForTest("middle");
      const ringFileBefore = readIfExists(keyRingStatePath("middle"));

      const returned = await rl.handleMessageEnd(
        shapeEvent("middle", SHARED_MODEL, 400),
        hooks,
      );

      check(
        "shape: the rejected request still hands the turn a retry marker",
        typeof returned?.message?.errorMessage === "string" &&
          returned.message.errorMessage.includes("Provider returned error") &&
          returned.message.errorMessage.includes("HTTP 400"),
        JSON.stringify(returned),
      );
      check(
        "shape: the marker does not claim the key ring is exhausted",
        typeof returned?.message?.errorMessage === "string" &&
          !returned.message.errorMessage.includes("key ring is exhausted"),
        JSON.stringify(returned?.message?.errorMessage),
      );
      check(
        "shape: the walk engages the next eligible route",
        fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].provider === "dead" &&
          fb.calls.setModel[0].model === SHARED_MODEL,
        JSON.stringify(fb.calls.setModel),
      );
      check(
        "shape: the route's key ring is untouched (same usable count, same state file)",
        JSON.stringify(rl.getKeyRingStatusForTest("middle")) ===
          JSON.stringify(ringBefore) &&
          readIfExists(keyRingStatePath("middle")) === ringFileBefore,
        `${JSON.stringify(rl.getKeyRingStatusForTest("middle"))} vs ${JSON.stringify(ringBefore)}`,
      );
    }

    // ── The route death record: class, status, model id, no key hash ───────
    {
      const onDisk = readRouteStateDisk();
      const entry = onDisk?.routes?.middle;
      check(
        "record: the rejected (route, request) pair is persisted under the redirected HOME",
        !!entry,
        JSON.stringify(onDisk?.routes),
      );
      check(
        "record: the class names the shape death and the status/model id are stored",
        entry?.deathClass === "request-shape" &&
          entry?.deathStatus === 400 &&
          entry?.deathModelId === SHARED_MODEL &&
          entry?.deathAt === NOW,
        JSON.stringify(entry),
      );
      check(
        "record: no key hash is stored (no key was at fault)",
        entry?.deathKeyHash === null || entry?.deathKeyHash === undefined,
        JSON.stringify(entry),
      );
    }

    // ── A fresh shape death is passed over; past the bound it is eligible ──
    {
      const fb = engageDeps();
      const engine = engineFor(["middle", "healthy"]);
      await rl.handleMessageEnd(
        shapeEvent("other", SHARED_MODEL, 400),
        hooksFor(engine, fb),
      );
      check(
        "freshness: a fresh shape death for the same (model id, status) is passed over",
        fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].provider === "healthy",
        JSON.stringify(fb.calls.setModel),
      );
      check(
        "freshness: the pass-over is reported once through the throttled skip channel",
        shapeSkipLines().length === 1 &&
          shapeSkipLines()[0].message.includes("middle"),
        JSON.stringify(logLines),
      );
      check(
        "freshness: the engaged route's own death record is written too",
        JSON.parse(readIfExists(routeStatePath) ?? "null")?.routes?.other
          ?.deathStatus === 400,
      );

      nowMs = NOW + FRESHNESS_MS + 1;
      const staleFb = engageDeps();
      const staleEngine = engineFor(["middle", "healthy"]);
      await rl.handleMessageEnd(
        shapeEvent("other", SHARED_MODEL, 400),
        hooksFor(staleEngine, staleFb),
      );
      check(
        "freshness: past the bound the recorded route is eligible again",
        staleFb.calls.setModel.length === 1 &&
          staleFb.calls.setModel[0].provider === "middle",
        JSON.stringify(staleFb.calls.setModel),
      );
      nowMs = NOW;
    }

    // ── Convergence: two routes agreeing on the status stop the walk ───────
    {
      const fb = engageDeps();
      const engine = engineFor(["dead", "middle", "healthy"]);
      const hooks = hooksFor(engine, fb);
      const first = await rl.handleMessageEnd(
        shapeEvent("middle", SHARED_MODEL, 400),
        hooks,
      );
      check(
        "convergence setup: the first leg engages a second route",
        typeof first?.message?.errorMessage === "string" &&
          fb.calls.setModel.map((c) => c.provider).join(",") === "dead",
        JSON.stringify(fb.calls.setModel),
      );
      const engaged = fb.calls.setModel.length;
      const second = await rl.handleMessageEnd(
        shapeEvent("dead", SHARED_MODEL, 400),
        hooks,
      );
      check(
        "convergence: the engaged route's same-status death stops the walk",
        second === undefined && fb.calls.setModel.length === engaged,
        JSON.stringify({ second, calls: fb.calls.setModel }),
      );
      const notices = () =>
        fb.calls.notify.filter((t) =>
          t.includes("the request itself is at fault"),
        );
      check(
        "convergence: the notice names the agreement, the status and the routes tried",
        notices().length === 1 &&
          notices()[0].includes("HTTP 400") &&
          notices()[0].includes("middle") &&
          notices()[0].includes("dead") &&
          notices()[0].includes("stopped on purpose"),
        JSON.stringify(fb.calls.notify),
      );
      check(
        "convergence: the notice never suggests a credential fix",
        notices().length === 1 &&
          !/credential|api.?key|quota/i.test(notices()[0]),
        JSON.stringify(notices()),
      );
      await rl.handleMessageEnd(shapeEvent("dead", SHARED_MODEL, 400), hooks);
      check(
        "convergence: a repeated agreement neither re-engages nor repeats the notice",
        notices().length === 1 && fb.calls.setModel.length === engaged,
        JSON.stringify(fb.calls),
      );
    }

    // ── Bound: the episode never walks back onto its own origin ────────────
    // The route that opened the episode already refused this request once, so
    // it is the fail-back target and never a candidate again. The statuses here
    // differ on purpose; the design's per-episode bound (at most |order| - 1
    // engages) holds only if the origin is excluded from the walk itself, not
    // just from the fresh-(model id, status) skip.
    {
      const fb = engageDeps();
      const engine = engineFor(["dead", "middle", "healthy"]);
      const hooks = hooksFor(engine, fb);

      const opening = await rl.handleMessageEnd(
        shapeEvent("dead", SHARED_MODEL, 404),
        hooks,
      );
      check(
        "bound: the opening death engages the next eligible route",
        typeof opening?.message?.errorMessage === "string" &&
          fb.calls.setModel.map((c) => c.provider).join(",") === "middle",
        JSON.stringify(fb.calls.setModel),
      );

      // `middle` refuses the same model with a DIFFERENT status, so the fresh
      // (model id, status) skip cannot be what keeps `dead` out of the plan.
      await rl.handleMessageEnd(shapeEvent("middle", SHARED_MODEL, 409), hooks);
      check(
        "bound: the walk moves on instead of back onto the route that opened it",
        fb.calls.setModel.map((c) => c.provider).join(",") === "middle,healthy",
        JSON.stringify(fb.calls.setModel),
      );

      const engaged = fb.calls.setModel.length;
      const walked = await rl.handleMessageEnd(
        shapeEvent("healthy", SHARED_MODEL, 417),
        hooks,
      );
      check(
        "bound: an episode engages at most |order| - 1 routes, then goes inert",
        walked === undefined && fb.calls.setModel.length === engaged,
        JSON.stringify({ walked, calls: fb.calls.setModel }),
      );
    }

    // ── Bounded episode chain: only the served route's death walks on ──────
    {
      const fb = engageDeps();
      const engine = engineFor(["dead", "middle", "healthy"]);
      const hooks = hooksFor(engine, fb);

      const first = await rl.handleMessageEnd(
        keyEvent("dead", SHARED_MODEL),
        hooks,
      );
      check(
        "episode: the opening key death engages the next eligible route",
        typeof first?.message?.errorMessage === "string" &&
          first.message.errorMessage.includes(
            "rotated to the next configured route",
          ) &&
          fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].provider === "middle",
        JSON.stringify(fb.calls.setModel),
      );
      check(
        "episode: the key class still exhausts the ring (the walk is additive)",
        rl.getKeyRingStatusForTest("dead").usable === 0,
      );

      const second = await rl.handleMessageEnd(
        keyEvent("middle", SHARED_MODEL),
        hooks,
      );
      check(
        "episode: the death of the route the walk engaged walks on",
        typeof second?.message?.errorMessage === "string" &&
          second.message.errorMessage.includes(
            "rotated to the next configured route",
          ) &&
          fb.calls.setModel.map((c) => c.provider).join(",") ===
            "middle,healthy",
        JSON.stringify(fb.calls.setModel),
      );

      const engaged = fb.calls.setModel.length;
      const whispers = fb.calls.notify.length;
      const notChosen = await rl.handleMessageEnd(
        keyEvent("other", SHARED_MODEL),
        hooks,
      );
      check(
        "anti-storm: a death of a route the walk did not choose stays inert",
        notChosen === undefined &&
          fb.calls.setModel.length === engaged &&
          fb.calls.notify.length === whispers,
        JSON.stringify({ notChosen, calls: fb.calls }),
      );
      const primaryAgain = await rl.handleMessageEnd(
        keyEvent("dead", SHARED_MODEL),
        hooks,
      );
      check(
        "anti-storm: the route that OPENED the episode dying again stays inert",
        primaryAgain === undefined &&
          fb.calls.setModel.length === engaged &&
          fb.calls.notify.length === whispers,
        JSON.stringify({ primaryAgain, calls: fb.calls }),
      );

      nowMs = NOW + rl.FAILBACK_PROBE_INTERVAL_MS;
      const outcome = await engine.maybeFailBack(fb.probeDeps);
      check(
        "episode: the fail-back target is still the route that opened the episode",
        outcome === "failed-back" &&
          fb.calls.probe.length === 1 &&
          fb.calls.probe[0].source === "dead" &&
          fb.calls.probe[0].modelId === SHARED_MODEL,
        JSON.stringify({ outcome, probe: fb.calls.probe }),
      );
    }

    // ── Payload class keeps its own recovery (no ring, no walk) ────────────
    {
      const fb = engageDeps();
      const engine = engineFor(["dead", "middle", "healthy"]);
      const ringBefore = rl.getKeyRingStatusForTest("healthy");
      const returned = await rl.handleMessageEnd(
        deathEvent(
          "healthy",
          SHARED_MODEL,
          "400 context_length_exceeded: the payload is too large",
        ),
        hooksFor(engine, fb),
      );
      check(
        "payload: a context-window error leaves the ring and the walk alone",
        returned === undefined &&
          fb.calls.setModel.length === 0 &&
          JSON.stringify(rl.getKeyRingStatusForTest("healthy")) ===
            JSON.stringify(ringBefore),
        JSON.stringify({ returned, calls: fb.calls }),
      );
    }

    // ── Precedence: payload beats key when an error carries both signals ───
    // `isKeyRotationError` reads the `403` in `403 context_length_exceeded` as
    // a key problem, but the request is what is too large. Payload is classified
    // first on purpose, so the ring stays untouched and the payload recovery is
    // the path that runs, not a key exhaustion followed by a walk onto another
    // route that would refuse the same oversized body. The `dead` ring's state
    // file (written by the key-class episode above) anchors the contrast: a key
    // death does write one, this overlap must not.
    {
      const fb = engageDeps();
      const engine = engineFor(["dead", "middle", "healthy"]);
      const ringBefore = rl.getKeyRingStatusForTest("healthy");
      const keyRingFileBefore = readIfExists(keyRingStatePath("healthy"));
      const keyClassWroteState = readIfExists(keyRingStatePath("dead"));

      const overlap = "403 context_length_exceeded: the payload is too large";
      check(
        "precedence: a 403 that also names a context-window error classifies as payload",
        rl.classifyFailure(overlap).class === "payload",
        JSON.stringify(rl.classifyFailure(overlap)),
      );

      const returned = await rl.handleMessageEnd(
        deathEvent("healthy", SHARED_MODEL, overlap),
        hooksFor(engine, fb),
      );
      check(
        "precedence: no key is mutated and the ring's usable count is unchanged",
        rl.getKeyRingStatusForTest("healthy").usable === 1 &&
          JSON.stringify(rl.getKeyRingStatusForTest("healthy")) ===
            JSON.stringify(ringBefore),
        `${JSON.stringify(rl.getKeyRingStatusForTest("healthy"))} vs ${JSON.stringify(ringBefore)}`,
      );
      check(
        "precedence: no key-ring state is written (a key-class death does write one)",
        readIfExists(keyRingStatePath("healthy")) === keyRingFileBefore &&
          keyRingFileBefore === null &&
          keyClassWroteState !== null,
        JSON.stringify({
          before: keyRingFileBefore,
          after: readIfExists(keyRingStatePath("healthy")),
          keyClassFile: keyClassWroteState !== null,
        }),
      );
      check(
        "precedence: the payload recovery path runs (no walk, no marker, no whisper)",
        returned === undefined &&
          fb.calls.setModel.length === 0 &&
          fb.calls.notify.length === 0,
        JSON.stringify({ returned, calls: fb.calls }),
      );
    }

    // ── Spent allowance: a usage-limit 429 is a key-class death ────────────
    // A spent subscription/plan refuses the turn until it resets; the 429
    // STATUS alone must never be what classifies, or every throttle would
    // exhaust a healthy key. The classifier reads the allowance family only.
    {
      const spentJson =
        '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}';
      const spentText = "429 Go usage limit exceeded";
      const throttled = "429 Too Many Requests - rate limit exceeded";

      check(
        "spent-allowance: a usage-limit 429 is key-class (JSON error body)",
        rl.classifyFailure(spentJson).class === "key",
        JSON.stringify(rl.classifyFailure(spentJson)),
      );
      check(
        "spent-allowance: a usage-limit 429 is key-class (bare text)",
        rl.classifyFailure(spentText).class === "key",
        JSON.stringify(rl.classifyFailure(spentText)),
      );
      check(
        "spent-allowance: a plain throttle 429 stays none (the 429 carve-out holds)",
        rl.classifyFailure(throttled).class === "none",
        JSON.stringify(rl.classifyFailure(throttled)),
      );
      check(
        "spent-allowance: an oversize payload still classifies payload, never key",
        rl.classifyFailure("429 context_length_exceeded: payload too large")
          .class === "payload",
        JSON.stringify(
          rl.classifyFailure("429 context_length_exceeded: payload too large"),
        ),
      );

      // End-to-end through the real handleMessageEnd + the wired rotation hook.
      // Fresh routes, so the shared rings the earlier cases used stay as they
      // are. `ul-spent` dies on the first case and `ul-live` serves the walk.
      for (const [providerId, prefix] of [
        ["ul-spent", "UL_SPENT_KEY"],
        ["ul-live", "UL_LIVE_KEY"],
      ]) {
        process.env[prefix] = `${providerId}-key-0`;
        rl.registerRoute({
          providerId,
          keys: prefix,
          modelIds: [SHARED_MODEL],
          ring: keyRing.createKeyRing({
            prefix,
            stateFile: providerId,
            healthInRotationInfo: true,
          }),
        });
      }

      const fb = engageDeps();
      const engine = engineFor(["ul-spent", "ul-live"]);
      const returned = await rl.handleMessageEnd(
        deathEvent("ul-spent", SHARED_MODEL, spentText),
        hooksFor(engine, fb),
      );
      check(
        "spent-allowance: the death exhausts the ring, rotates, and hands the turn the rotation marker",
        typeof returned?.message?.errorMessage === "string" &&
          returned.message.errorMessage.includes(
            "rotated to the next configured route",
          ) &&
          fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].provider === "ul-live" &&
          fb.calls.setModel[0].model === SHARED_MODEL &&
          rl.getKeyRingStatusForTest("ul-spent").usable === 0,
        JSON.stringify({
          returned: returned?.message?.errorMessage,
          calls: fb.calls.setModel,
          usable: rl.getKeyRingStatusForTest("ul-spent"),
        }),
      );

      // A third fresh route: the second case dies from `ul-live`, whose walk
      // must not count `ul-spent` (its ring is spent from the first case).
      process.env.UL_SPARE_KEY = "ul-spare-key-0";
      rl.registerRoute({
        providerId: "ul-spare",
        keys: "UL_SPARE_KEY",
        modelIds: [SHARED_MODEL],
        ring: keyRing.createKeyRing({
          prefix: "UL_SPARE_KEY",
          stateFile: "ul-spare",
          healthInRotationInfo: true,
        }),
      });
      const fb2 = engageDeps();
      const engine2 = engineFor(["ul-spent", "ul-live", "ul-spare"]);
      const returned2 = await rl.handleMessageEnd(
        deathEvent("ul-live", SHARED_MODEL, spentJson),
        hooksFor(engine2, fb2),
      );
      check(
        "spent-allowance: a pi-ai-fatal type name still engages the walk (future turns move route)",
        fb2.calls.setModel.length === 1 &&
          fb2.calls.setModel[0].provider === "ul-spare",
        JSON.stringify(fb2.calls.setModel),
      );
      check(
        "spent-allowance: no marker is appended for the fatal type name (history keeps the real error)",
        returned2 === undefined ||
          !returned2.message.errorMessage.includes(
            "rotated to the next configured route",
          ),
        JSON.stringify(returned2),
      );
    }

    // ── A WAF page is not a shape rejection ────────────────────────────────
    {
      const fb = engageDeps();
      const engine = engineFor(["dead", "middle", "healthy"]);
      const returned = await rl.handleMessageEnd(
        deathEvent(
          "healthy",
          SHARED_MODEL,
          "403 <!doctype html><html><head><title>Access denied</title></head></html>",
        ),
        hooksFor(engine, fb),
      );
      check(
        "waf: an edge page still takes the WAF branch (no shape walk, no shape marker)",
        fb.calls.setModel.length === 0 &&
          typeof returned?.message?.errorMessage === "string" &&
          !returned.message.errorMessage.includes("rejected this request") &&
          returned.message.errorMessage.includes("WAF"),
        JSON.stringify({ returned, calls: fb.calls }),
      );
    }

    // ── Catalog-route attribution: the descriptor's model map reaches the walk ──
    // A route whose model surface comes from the venice catalog (the gateway
    // and the direct route) registers through the composition root's own
    // mapping seam, and the walk resolves a dead turn's model id from that
    // registration. The incident this pins: a turn on opencode-go's own dotted
    // id (the id its `models` map produces) was refused with HTTP 400, and the
    // walk found no candidate because the catalog route's registration dropped
    // the descriptor's `models` map - so the one healthy route able to translate
    // that id was passed over, and the turn kept its error. The catalog id the
    // gateway serves is the translated one, which is why the map is the bridge
    // the walk needs.
    {
      const translated = "deepseek-v4-1-flash";
      const dotted = "deepseek-v4.1-flash";
      process.env.CAT_KEY = "cat-key-0";
      process.env.OC_FIX_KEY = "oc-fix-key-0";
      rl.registerCatalogRoute(
        {
          provider: "cat-gateway",
          keys: "CAT_KEY",
          modelIds: ["cat-extra"],
          models: { [dotted]: translated },
          venicePayload: true,
        },
        [translated],
        keyRing.createKeyRing({
          prefix: "CAT_KEY",
          stateFile: "cat-gateway",
          healthInRotationInfo: true,
        }),
        true,
      );
      rl.registerRoute({
        providerId: "opencode-go",
        keys: "OC_FIX_KEY",
        modelIds: [],
        models: { [dotted]: dotted },
        ring: keyRing.createKeyRing({
          prefix: "OC_FIX_KEY",
          stateFile: "opencode-go",
          healthInRotationInfo: true,
        }),
      });

      const registration = rl.getRouteRegistrationForTest("cat-gateway");
      check(
        "catalog route: the registration carries the catalog ids, the descriptor ids and the models map",
        registration !== null &&
          registration.modelIds.includes(translated) &&
          registration.modelIds.includes("cat-extra") &&
          registration.models?.[dotted] === translated &&
          registration.venicePayload === true,
        JSON.stringify(registration),
      );

      const fb = engageDeps();
      const engine = engineFor(["opencode-go", "cat-gateway"]);
      const returned = await rl.handleMessageEnd(
        shapeEvent("opencode-go", dotted, 400),
        hooksFor(engine, fb),
      );
      check(
        "catalog route: a shape rejection of a translated id engages the route's own id",
        fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].provider === "cat-gateway" &&
          fb.calls.setModel[0].model === translated,
        JSON.stringify(fb.calls.setModel),
      );
      check(
        "catalog route: the turn is handed the shape marker (the retry runs on the engaged route)",
        typeof returned?.message?.errorMessage === "string" &&
          returned.message.errorMessage.includes(
            "rotated to the next configured route",
          ) &&
          returned.message.errorMessage.includes("HTTP 400"),
        JSON.stringify(returned?.message?.errorMessage),
      );
      check(
        "catalog route: the failing route records its request-shape death for the freshness window",
        readRouteStateDisk()?.routes?.["opencode-go"]?.deathClass ===
          "request-shape" &&
          readRouteStateDisk()?.routes?.["opencode-go"]?.deathModelId ===
            dotted &&
          readRouteStateDisk()?.routes?.["opencode-go"]?.deathStatus === 400,
        JSON.stringify(readRouteStateDisk()?.routes?.["opencode-go"]),
      );
    }

    // ── An inert plan still records the failing route's shape death ────────
    // The recording happens before the walk decides, so a later request (and a
    // later session) passes the route over even when this walk had nowhere to
    // go. Without this the routing decision would depend on whether a fallback
    // happened to exist at the moment of the first rejection.
    {
      const dotted = "deepseek-v4.1-flash";
      rl.registerRoute({
        providerId: "oc-inert",
        keys: "OC_INERT_KEY",
        modelIds: [],
        models: { [dotted]: dotted },
        ring: keyRing.createKeyRing({
          prefix: "OC_INERT_KEY",
          stateFile: "oc-inert",
          healthInRotationInfo: true,
        }),
      });
      const fb = engageDeps();
      const engine = engineFor(["oc-inert", "dead"]);
      const returned = await rl.handleMessageEnd(
        shapeEvent("oc-inert", dotted, 400),
        hooksFor(engine, fb),
      );
      check(
        "inert plan: nothing is engaged and no retry marker is appended",
        fb.calls.setModel.length === 0 && returned === undefined,
        JSON.stringify({ returned, calls: fb.calls.setModel }),
      );
      check(
        "inert plan: the failing route still records its request-shape death",
        readRouteStateDisk()?.routes?.["oc-inert"]?.deathClass ===
          "request-shape" &&
          readRouteStateDisk()?.routes?.["oc-inert"]?.deathModelId === dotted &&
          readRouteStateDisk()?.routes?.["oc-inert"]?.deathStatus === 400,
        JSON.stringify(readRouteStateDisk()?.routes?.["oc-inert"]),
      );
    }

    // ── Capacity refusal: the model id moves, every key counter stays put ──
    // The morning's two failures, replayed. The cell answers its own refusal
    // ("prefill_cap_refused … the cell is at capacity") for the model id the
    // turn is on; the sibling route serves the SAME logical model under its own
    // spelling, reached through its `models` map. Nothing about a key is at
    // fault, so both rings are held to the counters and the state files they
    // started with, on every path below, and the numbers are printed.
    {
      const logical = "deepseek-v4-1-flash";
      const siblingId = "deepseek-v4.1-flash";
      // The section owns its clock: an earlier case leaves `nowMs` advanced, and
      // the bound check below reads a death recorded in this section.
      nowMs = NOW;
      const CAP_REFUSAL =
        "Upstream request failed: [prefill_cap_refused] the cell is at capacity; retry shortly (after 30 s)";
      // The status in front of the sentence is the gateway's, not the fact's:
      // the same refusal arrives 429 on one edge and 403 on another.
      const capacityEvent = (provider, model, status) =>
        deathEvent(provider, model, `${status}: ${CAP_REFUSAL}`);

      process.env.CAP_AZ_KEY = "cap-az-key-0";
      process.env.CAP_OG_KEY = "cap-og-key-0";
      rl.registerRoute({
        providerId: "agent-zero",
        keys: "CAP_AZ_KEY",
        modelIds: [logical],
        models: { [siblingId]: logical },
        ring: keyRing.createKeyRing({
          prefix: "CAP_AZ_KEY",
          stateFile: "agent-zero",
          healthInRotationInfo: true,
        }),
      });
      rl.registerRoute({
        providerId: "opencode-go",
        keys: "CAP_OG_KEY",
        modelIds: [],
        models: { [logical]: siblingId },
        ring: keyRing.createKeyRing({
          prefix: "CAP_OG_KEY",
          stateFile: "opencode-go",
          healthInRotationInfo: true,
        }),
      });

      const ledger = (ids) =>
        ids
          .map((id) => {
            const h = rl.getKeyRingStatusForTest(id);
            return `${id} ${h.usable}/${h.total}`;
          })
          .join(" | ");
      const ringFiles = (ids) =>
        JSON.stringify(
          Object.fromEntries(
            ids.map((id) => [id, readIfExists(keyRingStatePath(id))]),
          ),
        );
      const replay = ["agent-zero", "opencode-go"];
      const ledgerBefore = ledger(replay);
      const filesBefore = ringFiles(replay);
      console.log(`  ledger before: ${ledgerBefore}`);

      check(
        "capacity: the cell's refusal classifies capacity, with and without a status prefix",
        rl.classifyFailure(CAP_REFUSAL).class === "capacity" &&
          rl.classifyFailure(`429: ${CAP_REFUSAL}`).class === "capacity",
        JSON.stringify([
          rl.classifyFailure(CAP_REFUSAL),
          rl.classifyFailure(`429: ${CAP_REFUSAL}`),
        ]),
      );

      // Incident 1: the gateway route refuses the model id for capacity.
      {
        const fb = engageDeps();
        const engine = engineFor(replay);
        const returned = await rl.handleMessageEnd(
          capacityEvent("agent-zero", logical, 429),
          hooksFor(engine, fb),
        );
        console.log(`  ledger after capacity on agent-zero: ${ledger(replay)}`);
        check(
          "capacity: the walk engages the sibling as the same logical model, through its models map",
          fb.calls.setModel.length === 1 &&
            fb.calls.setModel[0].provider === "opencode-go" &&
            fb.calls.setModel[0].model === siblingId,
          JSON.stringify(fb.calls.setModel),
        );
        check(
          "capacity: the turn is handed the capacity marker and no key-exhaustion claim",
          typeof returned?.message?.errorMessage === "string" &&
            returned.message.errorMessage.includes(
              "the serving cell is at capacity",
            ) &&
            returned.message.errorMessage.includes("no key exhausted") &&
            !returned.message.errorMessage.includes(
              "exhausted the active key",
            ) &&
            !returned.message.errorMessage.includes("key ring is exhausted"),
          JSON.stringify(returned?.message?.errorMessage),
        );
        check(
          "capacity: neither ring's usable count moves",
          ledger(replay) === ledgerBefore,
          `${ledger(replay)} vs ${ledgerBefore}`,
        );
        check(
          "capacity: no key-ring state file is written for either route",
          ringFiles(replay) === filesBefore,
          JSON.stringify({ before: filesBefore, after: ringFiles(replay) }),
        );
        const record = readRouteStateDisk()?.routes?.["agent-zero"];
        check(
          "capacity: the refusing route records a model-capacity death naming the model id",
          record?.deathClass === "model-capacity" &&
            record?.deathModelId === logical &&
            record?.deathStatus === 429 &&
            (record?.deathKeyHash ?? null) === null,
          JSON.stringify(record),
        );
      }

      // Incident 2: the sibling route refuses the same way, behind a 403. The
      // reading under test is the one that burned a key this morning: a status
      // the key predicate claims must not outrank the capacity sentence.
      {
        const fb = engageDeps();
        const engine = engineFor(["opencode-go", "agent-zero"]);
        const returned = await rl.handleMessageEnd(
          capacityEvent("opencode-go", siblingId, 403),
          hooksFor(engine, fb),
        );
        console.log(
          `  ledger after capacity on opencode-go: ${ledger(replay)}`,
        );
        check(
          "capacity: a 403-wrapped refusal still rotates the model, never the key",
          fb.calls.setModel.length === 1 &&
            fb.calls.setModel[0].provider === "agent-zero" &&
            fb.calls.setModel[0].model === logical &&
            typeof returned?.message?.errorMessage === "string" &&
            returned.message.errorMessage.includes(
              "the serving cell is at capacity",
            ),
          JSON.stringify({
            calls: fb.calls.setModel,
            returned: returned?.message?.errorMessage,
          }),
        );
        check(
          "capacity: the 403 wrapper leaves both rings and both state files untouched",
          ledger(replay) === ledgerBefore && ringFiles(replay) === filesBefore,
          JSON.stringify({
            ledger: ledger(replay),
            before: ledgerBefore,
            files: ringFiles(replay),
          }),
        );
        check(
          "capacity: the 403 wrapper records the death with the status it carried",
          readRouteStateDisk()?.routes?.["opencode-go"]?.deathClass ===
            "model-capacity" &&
            readRouteStateDisk()?.routes?.["opencode-go"]?.deathStatus === 403,
          JSON.stringify(readRouteStateDisk()?.routes?.["opencode-go"]),
        );
      }

      // The recorded death is per model id and short. Four routes, one shared
      // id and a second id, so each reading below is the predicate's alone.
      const sharedId = "cap/shared";
      const secondId = "cap/second";
      const canaries = ["cap-cell", "cap-neighbour", "cap-spare"];
      for (const [providerId, modelIds] of [
        ["cap-cell", [sharedId, secondId]],
        ["cap-neighbour", [sharedId]],
        ["cap-spare", [sharedId]],
        ["cap-other", [secondId]],
      ]) {
        const prefix = `CAP_${providerId.replace(/-/g, "_").toUpperCase()}_KEY`;
        process.env[prefix] = `${providerId}-key-0`;
        rl.registerRoute({
          providerId,
          keys: prefix,
          modelIds,
          ring: keyRing.createKeyRing({
            prefix,
            stateFile: providerId,
            healthInRotationInfo: true,
          }),
        });
      }

      // A first refusal on `cap-cell` records its model death and walks on.
      {
        const fb = engageDeps();
        const engine = engineFor(["cap-cell", "cap-neighbour", "cap-spare"]);
        await rl.handleMessageEnd(
          capacityEvent("cap-cell", sharedId, 429),
          hooksFor(engine, fb),
        );
        check(
          "capacity record: the first refusal records the model death and walks on",
          fb.calls.setModel.length === 1 &&
            fb.calls.setModel[0].provider === "cap-neighbour" &&
            readRouteStateDisk()?.routes?.["cap-cell"]?.deathClass ===
              "model-capacity",
          JSON.stringify({
            calls: fb.calls.setModel,
            record: readRouteStateDisk()?.routes?.["cap-cell"],
          }),
        );
      }

      // A fresh death for the SAME id is passed over; the walk moves on.
      {
        const fb = engageDeps();
        const engine = engineFor(["cap-neighbour", "cap-cell", "cap-spare"]);
        const before = ledger(canaries);
        await rl.handleMessageEnd(
          capacityEvent("cap-neighbour", sharedId, 429),
          hooksFor(engine, fb),
        );
        console.log(`  ledger (skip path): ${ledger(canaries)}`);
        check(
          "capacity skip: a fresh model-capacity death for this id is passed over",
          fb.calls.setModel.length === 1 &&
            fb.calls.setModel[0].provider === "cap-spare",
          JSON.stringify(fb.calls.setModel),
        );
        check(
          "capacity skip: the pass-over names the route, the model id and the bound",
          logLines.some(
            (l) =>
              l.message.includes("passed over for " + sharedId) &&
              l.message.includes("cell was at capacity"),
          ),
          JSON.stringify(
            logLines.filter((l) => l.message.includes("passed over for")),
          ),
        );
        check(
          "capacity skip: the passed-over route's key counters do not move",
          ledger(canaries) === before,
          `${ledger(canaries)} vs ${before}`,
        );
      }

      // A death naming ANOTHER model id never skips the route for this one.
      {
        const fb = engageDeps();
        const engine = engineFor(["cap-other", "cap-cell"]);
        await rl.handleMessageEnd(
          capacityEvent("cap-other", secondId, 429),
          hooksFor(engine, fb),
        );
        check(
          "capacity skip: a death for another model id leaves the route eligible",
          fb.calls.setModel.length === 1 &&
            fb.calls.setModel[0].provider === "cap-cell" &&
            fb.calls.setModel[0].model === secondId,
          JSON.stringify(fb.calls.setModel),
        );
      }

      // Past the bound the cell is asked again: the death is minutes, not hours.
      {
        nowMs = NOW + rl.MODEL_CAPACITY_FRESHNESS_MS;
        const fb = engageDeps();
        const engine = engineFor(["cap-neighbour", "cap-cell"]);
        await rl.handleMessageEnd(
          capacityEvent("cap-neighbour", sharedId, 429),
          hooksFor(engine, fb),
        );
        check(
          `capacity skip: past the ${rl.MODEL_CAPACITY_FRESHNESS_MS}ms bound the route is eligible again`,
          fb.calls.setModel.length === 1 &&
            fb.calls.setModel[0].provider === "cap-cell",
          JSON.stringify(fb.calls.setModel),
        );
        nowMs = NOW;
      }

      // No route serves the id: the diagnostic names the truth, and the death
      // is recorded so the next turn reads it instead of re-asking the cell.
      {
        process.env.CAP_ALONE_KEY = "cap-alone-key-0";
        rl.registerRoute({
          providerId: "cap-alone",
          keys: "CAP_ALONE_KEY",
          modelIds: ["cap/alone"],
          ring: keyRing.createKeyRing({
            prefix: "CAP_ALONE_KEY",
            stateFile: "cap-alone",
            healthInRotationInfo: true,
          }),
        });
        const fb = engageDeps();
        const engine = engineFor(["cap-alone", "cap-cell"]);
        const before = ledger(["cap-alone", "cap-cell"]);
        const returned = await rl.handleMessageEnd(
          capacityEvent("cap-alone", "cap/alone", 429),
          hooksFor(engine, fb),
        );
        console.log(
          `  ledger (no candidate): ${ledger(["cap-alone", "cap-cell"])}`,
        );
        check(
          "capacity: with no route serving the id, nothing is engaged and no marker is appended",
          fb.calls.setModel.length === 0 && returned === undefined,
          JSON.stringify({ returned, calls: fb.calls.setModel }),
        );
        check(
          "capacity: the diagnostic names the id, the bound and the untouched key ring",
          fb.calls.notify.length === 1 &&
            fb.calls.notify[0].includes("cap/alone") &&
            fb.calls.notify[0].includes("the serving cell is at capacity") &&
            fb.calls.notify[0].includes("the next 3 minutes") &&
            fb.calls.notify[0].includes("no key exhausted") &&
            !/credential|api.?key|quota/i.test(fb.calls.notify[0]),
          JSON.stringify(fb.calls.notify),
        );
        check(
          "capacity: the inert path records the model death and spends no key",
          readRouteStateDisk()?.routes?.["cap-alone"]?.deathClass ===
            "model-capacity" &&
            readRouteStateDisk()?.routes?.["cap-alone"]?.deathModelId ===
              "cap/alone" &&
            readRouteStateDisk()?.routes?.["cap-alone"]?.deathStatus === 429 &&
            ledger(["cap-alone", "cap-cell"]) === before,
          JSON.stringify({
            record: readRouteStateDisk()?.routes?.["cap-alone"],
            ledger: ledger(["cap-alone", "cap-cell"]),
            before,
          }),
        );
      }

      check(
        "capacity: the replay pair's rings read the same at the end as before the first refusal",
        ledger(replay) === ledgerBefore && ringFiles(replay) === filesBefore,
        JSON.stringify({ ledger: ledger(replay), before: ledgerBefore }),
      );
    }

    // ── Transport: the route did not answer ────────────────────────────────
    // The live failure: a connect timeout to the route's own host. The text
    // carries a host and a port where a status would sit and names no HTTP
    // status at all, so nothing in it says the route refused the request. The
    // old status parser read the port (`:443`) as the status, the walk read
    // HTTP 443 as a 4xx refusal, and the turn was rotated onto another route
    // with a marker that claimed `HTTP 443`. The class is its own now: no key
    // is exhausted, no plan is built, no notice claims a refusal, and the turn
    // keeps its real error, which is what lets pi-core re-send the request.
    {
      const CONNECT_TIMEOUT =
        "Connect Timeout Error (attempted address: llm.agent-zero.ai:443, timeout: 10000ms)";
      const TX_MODEL = "tx/shared";

      // The classifier, row by row: class AND status, because the defect was a
      // status that was never there.
      const transportRows = [
        [
          "connect timeout reporting a port",
          CONNECT_TIMEOUT,
          "transport",
          null,
        ],
        [
          "other side closed",
          "Connection error: other side closed (UND_ERR_SOCKET)",
          "transport",
          null,
        ],
        ["fetch idiom", "fetch failed", "transport", null],
        [
          "dns idiom",
          "getaddrinfo ENOTFOUND api.example.com",
          "transport",
          null,
        ],
        [
          "reset reporting a dotted address and a port",
          "read ECONNRESET at 203.0.113.7:443",
          "transport",
          null,
        ],
        [
          "a transport text that names a framed status keeps it",
          "Connection refused after status 503 from 10.0.0.1:443",
          "transport",
          503,
        ],
        [
          "a text naming only a port carries no status",
          "upstream connect failed on port 443",
          "transport",
          null,
        ],
      ];
      for (const [label, text, cls, status] of transportRows) {
        const got = rl.classifyFailure(text);
        check(
          `transport: ${label}`,
          got.class === cls && got.status === status,
          JSON.stringify({ got, want: { class: cls, status } }),
        );
      }

      // Controls: the four rows that are key-ness stay key-ness, and a status
      // framed by the text is still read. A new class that swallowed any of
      // these would trade this defect for a worse one.
      const controls = [
        [
          "plain throttle 429 stays none",
          "HTTP 429 Too Many Requests",
          "none",
          429,
        ],
        [
          "spent allowance stays key",
          "429 Go usage limit exceeded",
          "key",
          429,
        ],
        ["quota 402 stays key", "402 no quota", "key", 402],
        ["auth text stays key", "invalid api key", "key", null],
        ["leading status token stays shape", "400 Bad Request", "shape", 400],
        ["not-found status stays shape", "404 Not Found", "shape", 404],
        [
          "a real status beside a port classifies by the status",
          "status 400 from 10.0.0.1:443",
          "shape",
          400,
        ],
        [
          "a port does not blind a status the key predicate claims",
          "status 403 from 10.0.0.1:443",
          "key",
          403,
        ],
        [
          "the parenthesised clause pi-ai prints stays a status",
          "Azure OpenAI API error (400): bad request body",
          "shape",
          400,
        ],
        [
          "the vendor SDK's status-code suffix stays a status",
          "Request failed with status code 400",
          "shape",
          400,
        ],
        [
          "the vendor SDK's StatusCode field stays a status",
          "https response error StatusCode: 502, api error",
          "transport",
          502,
        ],
        [
          "the bare status the SDKs print first stays a status",
          "400 status code (no body)",
          "shape",
          400,
        ],
        [
          "a three-digit run inside a longer number is not a status",
          "1429",
          "none",
          null,
        ],
      ];
      for (const [label, text, cls, status] of controls) {
        const got = rl.classifyFailure(text);
        check(
          `transport control: ${label}`,
          got.class === cls && got.status === status,
          JSON.stringify({ got, want: { class: cls, status } }),
        );
      }

      // Precedence: the two classes that own their recovery are not swallowed
      // by the transport vocabulary (`at capacity` reads as availability, and
      // a payload idiom carries no transport word, so the order is what keeps
      // both intact).
      check(
        "transport: a capacity refusal stays capacity, not transport",
        rl.classifyFailure(
          "Upstream request failed: [prefill_cap_refused] the cell is at capacity; retry shortly (after 30 s)",
        ).class === "capacity" &&
          rl.classifyFailure("the cell is at capacity").class === "capacity",
        JSON.stringify(
          rl.classifyFailure(
            "Upstream request failed: [prefill_cap_refused] the cell is at capacity; retry shortly (after 30 s)",
          ),
        ),
      );
      check(
        "transport: an oversized payload stays payload, not transport",
        rl.classifyFailure("429 context_length_exceeded: payload too large")
          .class === "payload",
        JSON.stringify(
          rl.classifyFailure("429 context_length_exceeded: payload too large"),
        ),
      );

      for (const [providerId, prefix] of [
        ["tx-a", "TX_A_KEY"],
        ["tx-b", "TX_B_KEY"],
      ]) {
        process.env[prefix] = `${providerId}-key-0`;
        rl.registerRoute({
          providerId,
          keys: prefix,
          modelIds: [TX_MODEL],
          ring: keyRing.createKeyRing({
            prefix,
            stateFile: providerId,
            healthInRotationInfo: true,
          }),
        });
      }
      const txRings = () =>
        JSON.stringify([
          rl.getKeyRingStatusForTest("tx-a"),
          rl.getKeyRingStatusForTest("tx-b"),
        ]);
      const txRingFiles = () =>
        JSON.stringify([
          readIfExists(keyRingStatePath("tx-a")),
          readIfExists(keyRingStatePath("tx-b")),
        ]);
      const txRingsBefore = txRings();
      const txFilesBefore = txRingFiles();

      // The engine's own guard: the walk consults the class, not the ring.
      {
        const fb = engageDeps();
        const engine = engineFor(["tx-a", "tx-b"]);
        const marker = engine.maybeEngage(
          "tx-a",
          CONNECT_TIMEOUT,
          TX_MODEL,
          fb.deps,
        );
        check(
          "transport: the walk builds no plan for a transport death",
          marker === null &&
            fb.calls.setModel.length === 0 &&
            fb.calls.notify.length === 0,
          JSON.stringify({ marker, calls: fb.calls }),
        );
      }

      // The handler path: the turn keeps its real error, nothing moves.
      {
        const fb = engageDeps();
        const engine = engineFor(["tx-a", "tx-b"]);
        const returned = await rl.handleMessageEnd(
          deathEvent("tx-a", TX_MODEL, CONNECT_TIMEOUT),
          hooksFor(engine, fb),
        );
        check(
          "transport: the turn is handed no marker (no refusal is claimed)",
          returned === undefined,
          JSON.stringify(returned?.message?.errorMessage),
        );
        check(
          "transport: nothing rotates and nothing is notified",
          fb.calls.setModel.length === 0 && fb.calls.notify.length === 0,
          JSON.stringify(fb.calls),
        );
        check(
          "transport: neither ring moves and no key-ring state file is written",
          txRings() === txRingsBefore && txRingFiles() === txFilesBefore,
          JSON.stringify({ ring: txRings(), before: txRingsBefore }),
        );
        check(
          "transport: the route records no request-shape death",
          readRouteStateDisk()?.routes?.["tx-a"] === undefined,
          JSON.stringify(readRouteStateDisk()?.routes?.["tx-a"]),
        );
        check(
          "transport: no episode is opened (there is no fail-back target)",
          engine.isEngaged() === false,
          String(engine.isEngaged()),
        );
      }

      // The control that prices the previous case: same routes, same engine
      // wiring, a refusal instead of a silence, and the walk moves the turn.
      // Without it a null marker could as easily be a broken harness.
      {
        const fb = engageDeps();
        const engine = engineFor(["tx-a", "tx-b"]);
        const returned = await rl.handleMessageEnd(
          shapeEvent("tx-a", TX_MODEL, 400),
          hooksFor(engine, fb),
        );
        check(
          "transport control: a shape refusal on the same pair still rotates",
          fb.calls.setModel.length === 1 &&
            fb.calls.setModel[0].provider === "tx-b" &&
            fb.calls.setModel[0].model === TX_MODEL &&
            typeof returned?.message?.errorMessage === "string" &&
            returned.message.errorMessage.includes("HTTP 400"),
          JSON.stringify({ calls: fb.calls.setModel, returned }),
        );
        check(
          "transport control: the shape rotation still records its death",
          readRouteStateDisk()?.routes?.["tx-a"]?.deathClass ===
            "request-shape",
          JSON.stringify(readRouteStateDisk()?.routes?.["tx-a"]),
        );
      }
    }
  } finally {
    logApi?.setProvidersLogSink?.(undefined);
    rmSync(scratch, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
  }

  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
