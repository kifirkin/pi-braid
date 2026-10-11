#!/usr/bin/env node
/**
 * venice-direct-route.test.mjs
 *
 * Route-module regression suite for the venice-direct route
 * (packages/providers/venice-direct.ts).
 *
 * The route's rotation behavior is covered by rotation-engine.test.mjs and
 * route-failback.test.mjs; this suite pins the module's own surface:
 *   1. Its exported identity constants (provider id, credential namespace,
 *      base URL) — the values index.ts registers the provider with.
 *   2. The legacy settings resolver `resolveLastResortMap` (still read by the
 *      settings reader for its routes-transition diagnostic).
 *   3. `directModelConfigs`: ids pass through, per-model `baseUrl` overrides
 *      are stripped so the route's own base URL applies to every model.
 *   4. Ring attribution: a failure reported against the direct route exhausts
 *      the DIRECT ring only (the gateway ring is untouched), and a reported
 *      success heals it.
 *   5. Secret discipline: no key value or key-value prefix reaches any log
 *      line the rings emit.
 *
 * Harness: the REAL modules (venice-direct, ring-lifecycle, key-ring, log) are
 * compiled with the package's own local tsc (CJS emit) into
 * <repoRoot>/.direct-build/ and driven with no network and no pi-ai import.
 * HOME is redirected to an isolated temp dir so key-ring persistence never
 * touches the real ~/.pi/agent, and the keyspace is sanitized so ambient
 * AGENT_ZERO_API_KEY* / VENICE_API_KEY* env vars cannot leak into the rings.
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
const buildDir = join(repoRoot, ".direct-build");

// The model id both routes share (catalog-derived; the direct provider
// registers exactly the catalog ids).
const VENICE_MODEL = "deepseek-v4-pro-0813";
// Key VALUES the fixtures plant; the secrets check asserts neither these
// nor any prefix fragment of them ever reaches log text.
const GATEWAY_KEY = "gateway-test-key-0";
const DIRECT_KEY = "direct-test-key-0";

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
    join(pkgRoot, "venice-direct.ts"),
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
    direct: require(join(buildDir, "venice-direct.js")),
    rl: require(join(buildDir, "ring-lifecycle.js")),
    log: require(join(buildDir, "log.js")),
  };
}

async function run() {
  const scratch = mkdtempSync(join(tmpdir(), "pi-braid-venice-direct-"));
  try {
    // Isolated key-ring persistence; deterministic fresh state every run.
    process.env.HOME = scratch;
    // Sanitize the keyspace so ambient AGENT_ZERO_API_KEY* / VENICE_API_KEY*
    // env vars (which the real setup may export) cannot leak into the rings.
    for (const key of Object.keys(process.env)) {
      if (/^(AGENT_ZERO_API_KEY|VENICE_API_KEY)(_P\d+)?$/.test(key)) {
        delete process.env[key];
      }
    }
    process.env.AGENT_ZERO_API_KEY_P0 = GATEWAY_KEY;
    process.env.VENICE_API_KEY = DIRECT_KEY;

    const { direct, rl, log } = loadModules();

    // ── 1. Exported identity constants ───────────────────────────────────
    check(
      "identity: provider id, credential namespace and base URL",
      direct.VENICE_DIRECT_ID === "venice-direct" &&
        direct.VENICE_DIRECT_KEY_PREFIX === "VENICE_API_KEY" &&
        direct.VENICE_DIRECT_BASE_URL === "https://api.venice.ai/api/v1",
    );
    check(
      "identity: the direct ring uses the direct credential namespace",
      direct.veniceDirectKeyRing.getActiveKey() === DIRECT_KEY,
    );

    // ── 2. Legacy lastResort resolver matrix (settings shape) ────────────
    check(
      'resolveLastResortMap: { "agent-zero": venice-direct} → entry',
      (() => {
        const m = rl.resolveLastResortMap({ "agent-zero": "venice-direct" });
        return m.size === 1 && m.get("agent-zero") === "venice-direct";
      })(),
    );
    check(
      "resolveLastResortMap: absent/non-object/array/{} → empty map",
      rl.resolveLastResortMap(undefined).size === 0 &&
        rl.resolveLastResortMap(null).size === 0 &&
        rl.resolveLastResortMap("x").size === 0 &&
        rl.resolveLastResortMap([]).size === 0 &&
        rl.resolveLastResortMap({}).size === 0,
    );
    check(
      "resolveLastResortMap: trims keys/values, skips non-string/empty values",
      (() => {
        const m = rl.resolveLastResortMap({
          " agent-zero ": " venice-direct ",
          numeric: 7,
          missing: null,
          blank: "",
        });
        return (
          m.size === 1 &&
          m.get("agent-zero") === "venice-direct" &&
          m.get("numeric") === undefined &&
          m.get("blank") === undefined
        );
      })(),
    );

    // ── 3. Model configs derive from the catalog (data, not a hardcode) ──
    const configs = direct.directModelConfigs([
      {
        id: VENICE_MODEL,
        name: "V",
        reasoning: false,
        input: ["text"],
        cost: { currency: "USD", input: 0, output: 0 },
        contextWindow: 163840,
        baseUrl: "https://gateway.example/v1",
      },
    ]);
    check(
      "directModelConfigs: keeps ids, strips per-model baseUrl override",
      configs.length === 1 &&
        configs[0].id === VENICE_MODEL &&
        configs[0].baseUrl === undefined,
    );

    // Capture every log line the rings emit from here on (the notify-shaped
    // seam the extension binds at session_start).
    const logLines = [];
    log.setProvidersLogSink((message) => logLines.push(String(message)));

    // ── 4. Ring attribution: the failure exhausts the DIRECT ring only ───
    {
      // Mirror index.ts's production registration: the module's own direct
      // ring joins the seam under the venice-direct id.
      rl.registerRoute({
        providerId: direct.VENICE_DIRECT_ID,
        keys: "VENICE_API_KEY",
        modelIds: [VENICE_MODEL],
        ring: direct.veniceDirectKeyRing,
      });
      const gwBefore = JSON.stringify(rl.getKeyRingStatusForTest("agent-zero"));
      const activeBefore = rl.getActiveKeyForTest("venice-direct");
      rl.reportKeyRingFailure(
        VENICE_MODEL,
        direct.VENICE_DIRECT_ID,
        '403 {"error":{"message":"no quota left"}}',
      );
      const activeAfter = rl.getActiveKeyForTest("venice-direct");
      check(
        "attribution: a venice-direct failure exhausts the DIRECT ring only",
        activeBefore !== null && activeBefore !== activeAfter,
      );
      check(
        "attribution: the gateway ring was untouched by the direct failure",
        JSON.stringify(rl.getKeyRingStatusForTest("agent-zero")) === gwBefore,
      );
      rl.reportKeyRingSuccess(VENICE_MODEL, direct.VENICE_DIRECT_ID);
      check(
        "attribution: a reported success heals the direct ring",
        rl.getKeyRingStatusForTest("venice-direct").usable === 1,
      );
    }

    // ── 5. No key material in any emitted log line ───────────────────────
    {
      const all = logLines.join("\n");
      const prefixes = [GATEWAY_KEY, DIRECT_KEY].map((k) => k.slice(0, 12));
      check(
        "secrets: no key value or key-value prefix in logs",
        !all.includes(GATEWAY_KEY) &&
          !all.includes(DIRECT_KEY) &&
          prefixes.every((p) => !all.includes(p)),
      );
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
