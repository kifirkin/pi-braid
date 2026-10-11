#!/usr/bin/env node
/**
 * rotation-engine.test.mjs
 *
 * Regression suite for the route-order rotation engine (packages/providers):
 * on a death the walk is consulted for, the engine walks the registered routes
 * IN ARRAY ORDER and engages the first route that is not the dead route, has a
 * usable key, and can serve the dead turn's model id — directly or through its
 * `models` map.
 *
 * Covers:
 *   1. Walk order: the first usable + serviceable route wins; the dead route is
 *      skipped; routes that are unconfigured (no keys), fully in backoff, or
 *      unable to serve the model id are passed over and the walk continues; a
 *      route missing from the registration table is passed over too.
 *   2. `models` map mapping: the engage switches the session to the route's OWN
 *      id for that model, not the dead turn's id.
 *   3. Direct id-sharing: a route that natively serves the model id (no map)
 *      engages on the same id — the agent-zero ⇄ venice-direct zero-map property.
 *   4. Engage failure → skip → next candidate: a `setModel` returning false for
 *      one candidate never stops the walk.
 *   5. All candidates skipped/failed → no retry marker, ONE inert notice per
 *      episode attempt (never twice, even across repeated deaths).
 *   6. One engage per route per episode: a second death from the route that
 *      opened the episode is inert, and only the death of the route the walk is
 *      currently serving advances the walk; a fail-back/reset re-arms it.
 *   7. Session reset: `reset()` clears the episode so the next death engages
 *      again with fresh state.
 *   8. Default-pair parity: with the routes array absent (the DEFAULT_ROUTES
 *      order agent-zero then venice-direct), an agent-zero death still engages venice-direct.
 *   9. Probe steering: a route whose recorded probe measured it `unavailable`
 *      is skipped while that verdict is fresh — a fresh verdict moves the walk
 *      on and is reported once through the existing throttled log channel; a
 *      verdict older than the bound, a `degraded` verdict, and no verdict at
 *      all leave the route engaged; `probeFreshnessMs: 0` (and a negative
 *      value) ignores the probe entirely; the state shaped like today's live
 *      file (both live routes `degraded`, agent-zero absent) is asserted byte-identical
 *      to the same walk built without probe steering; and when steering leaves
 *      nothing eligible the existing no-route diagnostic stands.
 *  10. `braid.providers.probeFreshnessMs` resolution: default 15 minutes,
 *      explicit values (0 and a negative value are the off switch, kept
 *      verbatim), and an unusable value keeping the default plus ONE diagnostic.
 *
 * Harness: the REAL modules (ring-lifecycle, key-ring, log) are compiled with
 * the package's own local tsc (CJS emit) into <repoRoot>/.rotation-build/ and
 * driven with no network and no pi-ai import. HOME is redirected to an isolated
 * temp dir so key-ring persistence never touches the real ~/.pi/agent, and the
 * keyspace is sanitized so ambient keys cannot leak into the rings.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
const buildDir = join(repoRoot, ".rotation-build");

const VENICE_MODEL = "deepseek-v4-pro-0813";
const MAPPED_ID = "alpha/served";
const GAMMA_ID = "gamma/served";

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

/** Compile the handler modules to CJS in buildDir and load them. */
function loadModules() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  const args = [
    tscBin,
    "--ignoreConfig",
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

/** Engage deps recording every setModel + notify; setModel outcome by route. */
function engageDeps(okByRoute = {}) {
  const calls = { setModel: [], notify: [] };
  return {
    calls,
    deps: {
      setModel: (provider, model) => {
        calls.setModel.push({ provider, model });
        return okByRoute[provider] ?? true;
      },
      notify: (text) => calls.notify.push(text),
    },
  };
}

async function run() {
  const scratch = mkdtempSync(join(tmpdir(), "pi-braid-rotation-engine-"));
  try {
    process.env.HOME = scratch;
    for (const key of Object.keys(process.env)) {
      if (
        /^(AGENT_ZERO_API_KEY|VENICE_API_KEY|ALPHA_KEY|BETA_KEY|GAMMA_KEY|DELTA_KEY|OPENROUTER_API_KEY)(_P\d+)?$/.test(
          key,
        )
      ) {
        delete process.env[key];
      }
    }
    // agent-zero (built-in) + the direct route + four fixture routes.
    process.env.AGENT_ZERO_API_KEY = "gateway-test-key-0";
    process.env.VENICE_API_KEY = "direct-test-key-0";
    process.env.ALPHA_KEY = "alpha-test-key-0";
    process.env.GAMMA_KEY = "gamma-test-key-0";
    process.env.DELTA_KEY = "delta-test-key-0";
    process.env.OPENROUTER_API_KEY = "openrouter-test-key-0";
    // BETA_KEY intentionally unset → an unconfigured ring (total === 0).

    const { rl, keyRing, log } = loadModules();

    // Register the fixture routes once, in a deterministic table.
    // agent-zero stands in for the registered gateway route (it is the dead route in
    // most blocks, but the parity check needs it as a live candidate too — the
    // live route table registers it first).
    rl.registerRoute({
      providerId: "agent-zero",
      keys: "AGENT_ZERO_API_KEY",
      modelIds: [VENICE_MODEL],
      ring: keyRing.createKeyRing({
        prefix: "AGENT_ZERO_API_KEY",
        stateFile: "agent-zero",
        healthInRotationInfo: true,
      }),
    });
    const directRing = keyRing.createKeyRing({
      prefix: "VENICE_API_KEY",
      stateFile: "venice-direct",
      healthInRotationInfo: true,
    });
    rl.registerRoute({
      providerId: "venice-direct",
      keys: "VENICE_API_KEY",
      modelIds: [VENICE_MODEL],
      ring: directRing,
    });
    rl.registerRoute({
      providerId: "alpha",
      keys: "ALPHA_KEY",
      modelIds: ["alpha/only"],
      models: { [VENICE_MODEL]: MAPPED_ID },
      ring: keyRing.createKeyRing({
        prefix: "ALPHA_KEY",
        stateFile: "alpha",
        healthInRotationInfo: true,
      }),
    });
    rl.registerRoute({
      providerId: "beta",
      keys: "BETA_KEY",
      modelIds: [VENICE_MODEL],
      ring: keyRing.createKeyRing({
        prefix: "BETA_KEY",
        stateFile: "beta",
        healthInRotationInfo: true,
      }),
    });
    rl.registerRoute({
      providerId: "gamma",
      keys: "GAMMA_KEY",
      modelIds: ["gamma/only"],
      models: { [VENICE_MODEL]: GAMMA_ID },
      ring: keyRing.createKeyRing({
        prefix: "GAMMA_KEY",
        stateFile: "gamma",
        healthInRotationInfo: true,
      }),
    });
    rl.registerRoute({
      providerId: "delta",
      keys: "DELTA_KEY",
      modelIds: [VENICE_MODEL],
      ring: keyRing.createKeyRing({
        prefix: "DELTA_KEY",
        stateFile: "delta",
        healthInRotationInfo: true,
      }),
    });
    // The live route table's third entry, with the model surface the live
    // settings give it (a models map, no native id) — an agent-zero death for
    // VENICE_MODEL passes it over for the SAME reason before and after probe
    // steering, which is what the parity check below asserts.
    rl.registerRoute({
      providerId: "openrouter",
      keys: "OPENROUTER_API_KEY",
      modelIds: [],
      models: { "deepseek-v4-1-flash": "deepseek/deepseek-v4-flash" },
      ring: keyRing.createKeyRing({
        prefix: "OPENROUTER_API_KEY",
        stateFile: "openrouter",
        healthInRotationInfo: true,
      }),
    });

    const engineFor = (order) => rl.createRotationEngine({ order });

    // ── 1. First usable + serviceable wins; dead route + unusable skipped ──
    {
      const engine = engineFor(["agent-zero", "alpha", "gamma"]);
      const fb = engageDeps();
      const marker = await engine.maybeEngage(
        "agent-zero",
        "403 no quota left",
        VENICE_MODEL,
        fb.deps,
      );
      check(
        "walk: engage fires on the first usable+serviceable route after the dead one",
        typeof marker === "string" &&
          fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].provider === "alpha",
        JSON.stringify(fb.calls.setModel),
      );
      check(
        "walk: the dead route is never re-engaged",
        fb.calls.setModel.every((c) => c.provider !== "agent-zero"),
      );
      check(
        "walk: exactly ONE engage whisper on success",
        fb.calls.notify.length === 1 &&
          fb.calls.notify[0].includes("agent-zero") &&
          fb.calls.notify[0].includes("alpha"),
      );
    }

    // ── 2. models map: the engage switches to the route's OWN id ──────────
    {
      const engine = engineFor(["agent-zero", "alpha"]);
      const fb = engageDeps();
      await engine.maybeEngage("agent-zero", "403", VENICE_MODEL, fb.deps);
      check(
        "models map: engage uses the mapped id, not the dead turn's id",
        fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].model === MAPPED_ID &&
          fb.calls.setModel[0].model !== VENICE_MODEL,
        JSON.stringify(fb.calls.setModel),
      );
    }

    // ── 3. Unusable/unconfigured routes are skipped, walk continues ───────
    {
      // beta has modelIds [VENICE_MODEL] but no keys (total 0) → skipped;
      // gamma serves it through its models map.
      const engine = engineFor(["agent-zero", "beta", "gamma"]);
      const fb = engageDeps();
      const marker = await engine.maybeEngage(
        "agent-zero",
        "403",
        VENICE_MODEL,
        fb.deps,
      );
      check(
        "walk: an unconfigured route is passed over; the next serviceable one wins",
        typeof marker === "string" &&
          fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].provider === "gamma" &&
          fb.calls.setModel[0].model === GAMMA_ID,
        JSON.stringify(fb.calls.setModel),
      );
    }
    {
      // A ring whose only key is exhausted also reports usable 0 → skipped.
      process.env.EXHAUSTED_KEY = "exhausted-test-key-0";
      const exhausted = rl.createRouteRing({
        provider: "exhausted",
        keys: "EXHAUSTED_KEY",
      });
      exhausted.exhaustActiveKey();
      rl.registerRoute({
        providerId: "exhausted",
        keys: "EXHAUSTED_KEY",
        modelIds: [VENICE_MODEL],
        ring: exhausted,
      });
      const engine = engineFor(["agent-zero", "exhausted", "gamma"]);
      const fb = engageDeps();
      await engine.maybeEngage("agent-zero", "403", VENICE_MODEL, fb.deps);
      check(
        "walk: a fully-exhausted route (usable 0) is passed over",
        fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].provider === "gamma",
        JSON.stringify(fb.calls.setModel),
      );
      delete process.env.EXHAUSTED_KEY;
    }
    {
      // A route in the order that was never registered is passed over too.
      const engine = engineFor(["agent-zero", "ghost", "gamma"]);
      const fb = engageDeps();
      await engine.maybeEngage("agent-zero", "403", VENICE_MODEL, fb.deps);
      check(
        "walk: a route absent from the registration table is passed over",
        fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].provider === "gamma",
        JSON.stringify(fb.calls.setModel),
      );
    }

    // ── 4. Direct id-sharing (zero-map) ───────────────────────────────────
    {
      const engine = engineFor(["agent-zero", "venice-direct"]);
      const fb = engageDeps();
      await engine.maybeEngage("agent-zero", "403", VENICE_MODEL, fb.deps);
      check(
        "direct id-sharing: no models map → the shared id engages verbatim",
        fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].provider === "venice-direct" &&
          fb.calls.setModel[0].model === VENICE_MODEL,
        JSON.stringify(fb.calls.setModel),
      );
    }

    // ── 5. Engage failure → skip → next candidate ─────────────────────────
    {
      const engine = engineFor(["agent-zero", "delta", "gamma"]);
      const fb = engageDeps({ delta: false });
      const marker = await engine.maybeEngage(
        "agent-zero",
        "403",
        VENICE_MODEL,
        fb.deps,
      );
      check(
        "engage failure: a false setModel skips the route and the walk continues",
        typeof marker === "string" &&
          fb.calls.setModel.map((c) => c.provider).join(",") ===
            "delta,gamma" &&
          fb.calls.notify.length === 1 &&
          fb.calls.notify[0].includes("gamma"),
        JSON.stringify(fb.calls),
      );
    }

    // ── 6. All-fail → no marker + ONE inert notice per episode attempt ────
    {
      const engine = engineFor(["agent-zero", "delta", "gamma"]);
      const fb = engageDeps({ delta: false, gamma: false });
      const marker = await engine.maybeEngage(
        "agent-zero",
        "403",
        VENICE_MODEL,
        fb.deps,
      );
      check(
        "all-fail: no retry marker (the turn keeps its real error)",
        marker === null,
      );
      check(
        "all-fail: ONE inert notice naming the model and the passed-over routes",
        fb.calls.notify.length === 1 &&
          fb.calls.notify[0].includes(VENICE_MODEL) &&
          fb.calls.notify[0].includes("engage failed: delta, gamma"),
        JSON.stringify(fb.calls.notify),
      );
      const again = await engine.maybeEngage(
        "agent-zero",
        "403",
        VENICE_MODEL,
        fb.deps,
      );
      check(
        "all-fail: a repeated death re-attempts but the inert notice stays once",
        again === null && fb.calls.notify.length === 1,
        JSON.stringify(fb.calls.notify),
      );
    }

    // ── 7. One engage per route per episode (the bounded walk) ────────────
    // The episode chain advances in one direction only: a death of the route
    // that OPENED the episode is inert (the walk never steps back onto a route
    // it did not choose), while the death of the route the walk engaged
    // continues the walk along the same order. The order here excludes the
    // dead route agent-zero, so the continuation lands on a route other than the
    // episode's own primary.
    {
      const engine = engineFor(["gamma", "delta"]);
      const fb = engageDeps();
      const first = await engine.maybeEngage(
        "agent-zero",
        "403",
        VENICE_MODEL,
        fb.deps,
      );
      check(
        "episode: the opening death engages the first eligible route (one whisper)",
        typeof first === "string" &&
          fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].provider === "gamma" &&
          fb.calls.notify.length === 1,
        JSON.stringify(fb.calls),
      );
      check("episode: engine reports engaged", engine.isEngaged() === true);

      const repeatedOpening = await engine.maybeEngage(
        "agent-zero",
        "403",
        VENICE_MODEL,
        fb.deps,
      );
      check(
        "episode: a second death from the route that opened the episode is inert",
        repeatedOpening === null &&
          fb.calls.setModel.length === 1 &&
          fb.calls.notify.length === 1,
        JSON.stringify(fb.calls),
      );

      const engagedDeath = await engine.maybeEngage(
        "gamma",
        "403",
        VENICE_MODEL,
        fb.deps,
      );
      check(
        "episode: the death of the route the walk engaged walks on",
        typeof engagedDeath === "string" &&
          fb.calls.setModel.map((c) => c.provider).join(",") ===
            "gamma,delta" &&
          fb.calls.setModel[1].model === VENICE_MODEL &&
          fb.calls.notify.length === 2,
        JSON.stringify(fb.calls),
      );
    }

    // ── 8. Session reset re-arms the engine ───────────────────────────────
    {
      const engine = engineFor(["agent-zero", "gamma"]);
      const fb = engageDeps();
      await engine.maybeEngage("agent-zero", "403", VENICE_MODEL, fb.deps);
      engine.reset();
      check("reset: engine disengages", engine.isEngaged() === false);
      const after = await engine.maybeEngage(
        "agent-zero",
        "403",
        VENICE_MODEL,
        fb.deps,
      );
      check(
        "reset: the next death engages again with fresh state",
        typeof after === "string" &&
          fb.calls.setModel.length === 2 &&
          fb.calls.notify.length === 2,
        JSON.stringify(fb.calls),
      );
    }

    // ── 9. Default-pair parity (routes absent → agent-zero then venice-direct) ────
    {
      // The DEFAULT_ROUTES order index.ts uses when settings carry no `routes`
      // key. An agent-zero death must still serve venice-direct exactly as the legacy
      // lastResort { "agent-zero": venice-direct} map did.
      const engine = engineFor(["agent-zero", "venice-direct"]);
      const fb = engageDeps();
      const marker = await engine.maybeEngage(
        "agent-zero",
        "403 no quota left",
        VENICE_MODEL,
        fb.deps,
      );
      check(
        "default-pair parity: an agent-zero death engages venice-direct",
        typeof marker === "string" &&
          fb.calls.setModel.some(
            (c) => c.provider === "venice-direct" && c.model === VENICE_MODEL,
          ),
        JSON.stringify(fb.calls.setModel),
      );
    }

    // ── 10. Nothing to rotate to → silent inert (no notice, no marker) ────
    {
      const engine = engineFor(["agent-zero"]);
      const fb = engageDeps();
      const marker = await engine.maybeEngage(
        "agent-zero",
        "403",
        VENICE_MODEL,
        fb.deps,
      );
      check(
        "empty order: no other route exists → byte-identical silent inert",
        marker === null &&
          fb.calls.setModel.length === 0 &&
          fb.calls.notify.length === 0,
        JSON.stringify(fb.calls),
      );
    }

    // ── Probe steering (R1): skip only what is measured unable, only while
    // the measurement is fresh. The verdict arrives as DATA — a per-route map
    // the caller resolves — so the engine never touches the state file.
    const NOW = 1_000_000_000;
    const lines = [];
    log.setProvidersLogSink((message, type) => lines.push({ message, type }));
    const skipLines = () =>
      lines.filter(
        (l) =>
          l.message.includes("venice-direct") &&
          l.message.includes("no balance") &&
          l.message.includes("passed over"),
      );
    /** One agent-zero death with the given probe deps; returns the routes engaged. */
    const engagedRoute = async (probeDeps) => {
      const engine = rl.createRotationEngine({
        order: ["agent-zero", "venice-direct"],
        now: () => NOW,
        ...probeDeps,
      });
      const fb = engageDeps();
      await engine.maybeEngage("agent-zero", "403", VENICE_MODEL, fb.deps);
      return fb.calls.setModel.map((c) => c.provider).join(",") || "";
    };

    // A fresh `unavailable` verdict moves the walk on, reported once.
    {
      const states = new Map([
        [
          "venice-direct",
          { state: "unavailable", at: NOW - 1_000, reason: "no balance" },
        ],
      ]);
      const engine = rl.createRotationEngine({
        order: ["agent-zero", "venice-direct", "gamma"],
        now: () => NOW,
        probeFreshnessMs: 900_000,
        probeStates: () => states,
      });
      const fb = engageDeps();
      const marker = await engine.maybeEngage(
        "agent-zero",
        "403",
        VENICE_MODEL,
        fb.deps,
      );
      check(
        "probe steering: a fresh unavailable verdict is skipped and the walk continues",
        typeof marker === "string" &&
          fb.calls.setModel.length === 1 &&
          fb.calls.setModel[0].provider === "gamma" &&
          fb.calls.setModel[0].model === GAMMA_ID,
        JSON.stringify(fb.calls.setModel),
      );
      check(
        "probe steering: the skip is reported once, naming the route and the recorded reason",
        skipLines().length === 1 &&
          skipLines()[0].message.includes("no balance"),
        JSON.stringify(lines),
      );
      engine.reset();
      const again = await engine.maybeEngage(
        "agent-zero",
        "403",
        VENICE_MODEL,
        fb.deps,
      );
      check(
        "probe steering: a repeated walk re-skips silently (never a line per attempt)",
        typeof again === "string" &&
          fb.calls.setModel.length === 2 &&
          skipLines().length === 1,
        JSON.stringify(lines),
      );
    }

    // Staleness, degraded, no data, the off switch: engaged as before.
    {
      const unavailable = (ageMs) => () =>
        new Map([
          [
            "venice-direct",
            { state: "unavailable", at: NOW - ageMs, reason: "no balance" },
          ],
        ]);
      check(
        "probe steering: a verdict exactly at the freshness bound is engaged as before",
        (await engagedRoute({
          probeFreshnessMs: 900_000,
          probeStates: unavailable(900_000),
        })) === "venice-direct",
      );
      check(
        "probe steering: a verdict older than the bound is engaged as before",
        (await engagedRoute({
          probeFreshnessMs: 900_000,
          probeStates: unavailable(900_001),
        })) === "venice-direct",
      );
      check(
        "probe steering: degraded stays eligible (the live pool's shape)",
        (await engagedRoute({
          probeFreshnessMs: 900_000,
          probeStates: () =>
            new Map([
              ["venice-direct", { state: "degraded", at: NOW - 1_000 }],
            ]),
        })) === "venice-direct",
      );
      check(
        "probe steering: a route with no recorded probe is never skipped",
        (await engagedRoute({
          probeFreshnessMs: 900_000,
          probeStates: () => new Map(),
        })) === "venice-direct",
      );
      check(
        "probe steering: probeFreshnessMs 0 ignores the probe entirely (off switch)",
        (await engagedRoute({
          probeFreshnessMs: 0,
          probeStates: unavailable(1_000),
        })) === "venice-direct",
      );
      check(
        "probe steering: a negative probeFreshnessMs ignores the probe too",
        (await engagedRoute({
          probeFreshnessMs: -1,
          probeStates: unavailable(1_000),
        })) === "venice-direct",
      );
      check(
        "probe steering: no probe reader at all leaves the walk untouched",
        (await engagedRoute({})) === "venice-direct",
      );
    }

    // Parity acceptance: the probe state shaped like today's live file cannot
    // move the live route choices. The shape that matters is which routes carry
    // a record and in what state — venice-direct and openrouter each recorded
    // `degraded`, agent-zero carries none (it has no probe endpoint by design) — over
    // the live route order, with verdicts young enough to be actionable.
    {
      const liveShape = () =>
        new Map([
          ["venice-direct", { state: "degraded", at: NOW - 30_000 }],
          ["openrouter", { state: "degraded", at: NOW - 30_000 }],
        ]);
      const liveOrder = ["agent-zero", "venice-direct", "openrouter"];
      const walk = async (engine, deadRoute) => {
        const fb = engageDeps();
        const marker = await engine.maybeEngage(
          deadRoute,
          "403 no quota left",
          VENICE_MODEL,
          fb.deps,
        );
        return { marker, calls: fb.calls };
      };
      // One fresh engine per death: the engage is ONE per episode (hysteresis),
      // so reusing an engine would make the second death inert in both arms.
      const steered = () =>
        rl.createRotationEngine({
          order: liveOrder,
          now: () => NOW,
          probeFreshnessMs: 900_000,
          probeStates: liveShape,
        });
      const preSteering = () =>
        rl.createRotationEngine({ order: liveOrder, now: () => NOW });

      const steeredA0 = await walk(steered(), "agent-zero");
      check(
        "parity: the live-shaped probe state picks venice-direct — the frozen pre-change choice",
        typeof steeredA0.marker === "string" &&
          steeredA0.calls.setModel.length === 1 &&
          steeredA0.calls.setModel[0].provider === "venice-direct" &&
          steeredA0.calls.setModel[0].model === VENICE_MODEL,
        JSON.stringify(steeredA0.calls.setModel),
      );

      const preA0 = await walk(preSteering(), "agent-zero");
      check(
        "parity: an agent-zero death has a byte-identical engage trace with and without probe steering",
        preA0.marker === steeredA0.marker &&
          JSON.stringify(preA0.calls) === JSON.stringify(steeredA0.calls),
        `pre=${JSON.stringify(preA0.calls)} steered=${JSON.stringify(steeredA0.calls)}`,
      );

      // With venice-direct dead, agent-zero is the candidate that carries NO probe
      // record — the live state must leave it exactly as eligible as before.
      const steeredDirect = await walk(steered(), "venice-direct");
      const preDirect = await walk(preSteering(), "venice-direct");
      check(
        "parity: a route with no probe record (agent-zero) is engaged identically with and without steering",
        typeof steeredDirect.marker === "string" &&
          steeredDirect.calls.setModel.length === 1 &&
          steeredDirect.calls.setModel[0].provider === "agent-zero" &&
          preDirect.marker === steeredDirect.marker &&
          JSON.stringify(preDirect.calls) ===
            JSON.stringify(steeredDirect.calls),
        `pre=${JSON.stringify(preDirect.calls)} steered=${JSON.stringify(steeredDirect.calls)}`,
      );
    }

    // Probe steering as the ONLY reason nothing is eligible: the existing
    // no-route path and its diagnostic stand, with the reason named.
    {
      const engine = rl.createRotationEngine({
        order: ["agent-zero", "venice-direct"],
        now: () => NOW,
        probeFreshnessMs: 900_000,
        probeStates: () =>
          new Map([
            [
              "venice-direct",
              { state: "unavailable", at: NOW - 1_000, reason: "http 503" },
            ],
          ]),
      });
      const fb = engageDeps();
      const marker = await engine.maybeEngage(
        "agent-zero",
        "403",
        VENICE_MODEL,
        fb.deps,
      );
      check(
        "probe steering: no route left eligible → the existing no-route diagnostic stands",
        marker === null &&
          fb.calls.setModel.length === 0 &&
          fb.calls.notify.length === 1 &&
          fb.calls.notify[0].includes(VENICE_MODEL) &&
          fb.calls.notify[0].includes(
            "probe-measured unavailable: venice-direct",
          ),
        JSON.stringify(fb.calls),
      );
    }

    // ── braid.providers.probeFreshnessMs on the settings surface ────────
    {
      const dir = join(scratch, ".pi", "agent");
      mkdirSync(dir, { recursive: true });
      const settingsFile = join(dir, "settings.json");
      const readWith = (providers) => {
        writeFileSync(settingsFile, JSON.stringify({ braid: { providers } }));
        return rl.readProvidersSettingsFromSettings();
      };
      check(
        "settings: probeFreshnessMs defaults to 15 minutes, silently",
        (() => {
          rmSync(settingsFile, { force: true });
          const s = rl.readProvidersSettingsFromSettings();
          return s.probeFreshnessMs === 900_000 && s.diagnostics.length === 0;
        })(),
      );
      check(
        "settings: an explicit probeFreshnessMs survives resolution",
        readWith({
          routes: [{ provider: "agent-zero", keys: "A0_KEY" }],
          probeFreshnessMs: 60_000,
        }).probeFreshnessMs === 60_000,
      );
      check(
        "settings: 0 and a negative value are the off switch, kept verbatim",
        readWith({
          routes: [{ provider: "agent-zero", keys: "A0_KEY" }],
          probeFreshnessMs: 0,
        }).probeFreshnessMs === 0 &&
          readWith({
            routes: [{ provider: "agent-zero", keys: "A0_KEY" }],
            probeFreshnessMs: -1,
          }).probeFreshnessMs === -1,
      );
      check(
        "settings: an unusable probeFreshnessMs keeps the default and is diagnosed",
        (() => {
          const s = readWith({
            routes: [{ provider: "agent-zero", keys: "A0_KEY" }],
            probeFreshnessMs: "15m",
          });
          return (
            s.probeFreshnessMs === 900_000 &&
            s.diagnostics.length === 1 &&
            s.diagnostics[0] === "probeFreshnessMs: must be a finite number"
          );
        })(),
      );
      check(
        "settings: probeFreshnessMs is read on the legacy path too",
        (() => {
          const s = readWith({
            lastResort: { "agent-zero": "venice-direct" },
            probeFreshnessMs: 120_000,
          });
          return (
            s.probeFreshnessMs === 120_000 &&
            s.routesConfigured === false &&
            s.diagnostics.length === 1 &&
            s.diagnostics[0].includes("lastResort")
          );
        })(),
      );
      rmSync(settingsFile, { force: true });
    }
  } finally {
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
