#!/usr/bin/env node
/**
 * route-usable.test.mjs
 *
 * The auxiliary path's query on the ring-feedback seam (packages/providers):
 * `routeUsable(modelId, providerId)` answers whether a (model id, provider)
 * pair can serve a request right now, so an auxiliary call that cannot be
 * redirected can skip a pair the provider layer knows is unusable.
 *
 * Behavior pinned here:
 *
 *   1. The published handler object carries the query beside reportFailure /
 *      reportSuccess, and the process-global slot core reads exposes it.
 *   2. A pair no configured route owns answers true (a built-in provider, an
 *      id no route serves, or no routes at all): the seam has nothing to say.
 *   3. A route with a usable key and no recorded death answers true.
 *   4. A route whose every key is spent answers false (ring health decides).
 *   5. A fresh request-shape death for the same model id answers false, and
 *      the answer flips back to true once the freshness bound passes; a death
 *      for another model id does not park the route, and a bound of 0 or less
 *      turns the death leg off.
 *   6. Fail open: an unreadable ring state file leaves the route usable.
 *   7. A shape text fed to reportKeyRingFailure is not a key-rotation error:
 *      it returns false and leaves the ring untouched.
 *   8. A models-map key is part of the route's surface: the query parks the
 *      pair on a fresh death for the key, matching the walk's
 *      `resolveRouteModel`, which resolves that same key through the map.
 *
 * Harness (the pattern route-walk-classes.test.mjs establishes): the REAL
 * modules (ring-lifecycle, key-ring, log, route-state) are compiled with the
 * package's own local tsc (CJS emit) into a temp dir OUTSIDE the repo and
 * driven with no network and no pi-ai import. HOME is redirected to an
 * isolated temp dir, so no ring/route state file outside it is touched, and
 * the keyspace is sanitized so ambient keys cannot leak into the rings. Routes
 * are registered through the real registerRoute seam with real rings from
 * createKeyRing.
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

const MODEL = "shared/aux-model";
const UNKNOWN_MODEL = "shared/unknown-model";
const MAPPED_KEY = "shared/mapped-key";
const MAPPED_VALUE = "shared/mapped-value";
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

async function run() {
  const scratch = mkdtempSync(join(tmpdir(), "pi-braid-route-usable-"));
  const buildDir = mkdtempSync(join(tmpdir(), "pi-braid-route-usable-build-"));
  try {
    process.env.HOME = scratch;
    const owned = /^(ALPHA_KEY|BETA_KEY|DELTA_KEY|EPSILON_KEY)(_P\d+)?$/;
    for (const key of Object.keys(process.env)) {
      if (owned.test(key)) delete process.env[key];
    }
    process.env.ALPHA_KEY = "alpha-key-0";
    process.env.BETA_KEY = "beta-key-0";
    process.env.DELTA_KEY = "delta-key-0";
    process.env.EPSILON_KEY = "epsilon-key-0";

    const { rl, keyRing, log, rs } = loadModules(buildDir);
    const agentDir = join(scratch, ".pi", "agent");
    const ringStatePath = (routeId) =>
      join(agentDir, `.key-ring-state-${routeId}.json`);

    log.setProvidersLogSink(() => {});

    const register = (providerId, prefix) => {
      rl.registerRoute({
        providerId,
        keys: prefix,
        modelIds: [MODEL],
        ring: keyRing.createKeyRing({
          prefix,
          stateFile: providerId,
          healthInRotationInfo: true,
        }),
      });
    };
    register("alpha", "ALPHA_KEY");
    register("beta", "BETA_KEY");
    register("delta", "DELTA_KEY");

    /** Ask the published handler object, guarding against its absence. */
    const handler = rl.createKeyRingFeedbackHandler();
    const ask = (modelId, providerId) =>
      typeof handler.routeUsable === "function"
        ? handler.routeUsable(modelId, providerId)
        : undefined;

    // ── 1. The handler carries the query ──────────────────────────────────
    check(
      "the published handler answers routeUsable beside its report methods",
      typeof handler.routeUsable === "function" &&
        typeof handler.reportFailure === "function" &&
        typeof handler.reportSuccess === "function",
      JSON.stringify(Object.keys(handler ?? {})),
    );
    rl.publishKeyRingFeedback();
    const published = globalThis[rl.KEY_RING_FEEDBACK_KEY];
    check(
      "the process-global slot core reads exposes the same query",
      typeof published?.routeUsable === "function" &&
        typeof published?.reportFailure === "function",
      JSON.stringify(Object.keys(published ?? {})),
    );

    // ── 2. A pair no configured route owns answers true ───────────────────
    check(
      "an unregistered provider answers true (fail open)",
      ask(MODEL, "not-a-route") === true,
    );
    check(
      "a model id no route serves answers true",
      ask(UNKNOWN_MODEL, undefined) === true,
    );
    rl.clearRouteRegistry();
    check(
      "with no routes configured at all the answer is true",
      ask(MODEL, "alpha") === true,
    );
    register("alpha", "ALPHA_KEY");
    register("beta", "BETA_KEY");
    register("delta", "DELTA_KEY");

    // ── 3. A healthy route with no recorded death is usable ───────────────
    check(
      "a route with a usable key and no death answers true",
      ask(MODEL, "alpha") === true,
    );

    // ── 4. Ring health decides: every key spent ⇒ false ───────────────────
    {
      const exhausted = rl.reportKeyRingFailure(
        MODEL,
        "alpha",
        "403 no quota left",
      );
      check(
        "the key-class report exhausts the route's key",
        exhausted === true && rl.getKeyRingStatusForTest("alpha").usable === 0,
        JSON.stringify(rl.getKeyRingStatusForTest("alpha")),
      );
      check(
        "a route whose every key is spent answers false",
        ask(MODEL, "alpha") === false,
      );
    }

    // ── 5. A fresh shape death parks the pair until the bound passes ──────
    {
      rs.recordDeath("beta", {
        class: "request-shape",
        at: NOW,
        modelId: MODEL,
        status: 400,
      });
      check(
        "a fresh request-shape death for the same model id answers false",
        rl.routeUsable(MODEL, "beta", {
          now: () => NOW,
          probeFreshnessMs: FRESHNESS_MS,
        }) === false,
      );
      check(
        "past the freshness bound the pair is usable again",
        rl.routeUsable(MODEL, "beta", {
          now: () => NOW + FRESHNESS_MS + 1,
          probeFreshnessMs: FRESHNESS_MS,
        }) === true,
      );
      check(
        "a death recorded for another model id does not park this pair",
        rl.routeUsable(UNKNOWN_MODEL, "beta", {
          now: () => NOW,
          probeFreshnessMs: FRESHNESS_MS,
        }) === true,
      );
      check(
        "a freshness bound of 0 or less turns the death leg off",
        rl.routeUsable(MODEL, "beta", {
          now: () => NOW,
          probeFreshnessMs: 0,
        }) === true &&
          rl.routeUsable(MODEL, "beta", {
            now: () => NOW,
            probeFreshnessMs: -1,
          }) === true,
      );
      // A death recorded for a different model id leaves beta usable for
      // MODEL; rewrite the record so later boundaries are unaffected.
      rs.recordDeath("beta", {
        class: "request-shape",
        at: NOW,
        modelId: UNKNOWN_MODEL,
        status: 400,
      });
      check(
        "a paired death for a different model id is not acted on",
        ask(MODEL, "beta") === true,
      );
      // Restore a fresh same-model death with a real-clock timestamp so the
      // published handler still parks beta.
      rs.recordDeath("beta", {
        class: "request-shape",
        at: Date.now(),
        modelId: MODEL,
        status: 400,
      });
      check(
        "the published handler parks the pair on a real-clock fresh death",
        ask(MODEL, "beta") === false,
      );
    }

    // ── 6. Fail open: an unreadable ring state file ───────────────────────
    {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(ringStatePath("delta"), "{ this is not json", "utf8");
      check(
        "an unreadable ring state file leaves the route usable",
        ask(MODEL, "delta") === true,
      );
      check(
        "the unreadable file was not touched by the query",
        readFileSync(ringStatePath("delta"), "utf8") === "{ this is not json",
      );
    }

    // ── 7. A shape text is not a key-rotation error ───────────────────────
    {
      const ringBefore = rl.getKeyRingStatusForTest("delta");
      const returned = rl.reportKeyRingFailure(
        MODEL,
        "delta",
        "400 request rejected by the provider",
      );
      check(
        "a shape text returns false and leaves the ring untouched",
        returned === false &&
          JSON.stringify(rl.getKeyRingStatusForTest("delta")) ===
            JSON.stringify(ringBefore),
        JSON.stringify(rl.getKeyRingStatusForTest("delta")),
      );
    }

    // ── 8. A models-map key is served, matching the walk ──────────────────
    // The walk resolves a dead request id through the route's models map, so
    // the route serves that key. The seam reads the same table through
    // routeServesModelId, so a fresh death recorded for the key must park the
    // pair; the map's value (the id a redirected turn arrives with) and the
    // descriptor's own model ids are served the same way.
    {
      rl.registerRoute({
        providerId: "epsilon",
        keys: "EPSILON_KEY",
        modelIds: ["shared/epsilon-native"],
        models: { [MAPPED_KEY]: MAPPED_VALUE },
        ring: keyRing.createKeyRing({
          prefix: "EPSILON_KEY",
          stateFile: "epsilon",
        }),
      });
      rs.recordDeath("epsilon", {
        class: "request-shape",
        at: NOW,
        modelId: MAPPED_KEY,
        status: 400,
      });
      check(
        "a models-map key is served: a fresh death for it parks the pair",
        rl.routeUsable(MAPPED_KEY, "epsilon", {
          now: () => NOW,
          probeFreshnessMs: FRESHNESS_MS,
        }) === false,
      );
      check(
        "the same route's models-map value and model ids answer via ring health",
        rl.routeUsable(MAPPED_VALUE, "epsilon", {
          now: () => NOW,
          probeFreshnessMs: FRESHNESS_MS,
        }) === true &&
          rl.routeUsable("shared/epsilon-native", "epsilon", {
            now: () => NOW,
            probeFreshnessMs: FRESHNESS_MS,
          }) === true,
      );
      check(
        "an id the route neither lists nor maps answers true (fail open)",
        rl.routeUsable("shared/epsilon-unknown", "epsilon", {
          now: () => NOW,
          probeFreshnessMs: FRESHNESS_MS,
        }) === true,
      );
    }

    if (failures > 0) {
      console.error(`\n${total - failures}/${total} checks passed`);
      process.exit(1);
    }
    console.log(`\n${total}/${total} checks passed`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
  }
}

run();
