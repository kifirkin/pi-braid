#!/usr/bin/env node
/**
 * route-table.test.mjs
 *
 * Route-table regression suite for packages/providers: the ordered
 * braid.providers.routes config, the settings-reader transition semantics, and
 * the registration table that per-event key-ring attribution resolves from.
 *
 * Covers:
 *   1. The pure resolver `resolveRoutesConfig`: order preserved, fields
 *      trimmed, models map kept; invalid entries SKIPPED with a named
 *      diagnostic carrying index + field (never a silent drop); a malformed
 *      whole-config yields empty routes + one diagnostic; `undefined` means
 *      "not configured" (empty, silent).
 *   2. The settings reader `readProvidersSettingsFromSettings` transition:
 *      routes present → it wins, the legacy fallback/lastResort blocks resolve
 *      empty and ONE diagnostic names them as ignored; routes absent → the
 *      legacy blocks resolve exactly as before, plus ONE replacement-shape
 *      diagnostic when any legacy key is set (nothing to migrate ⇒ silent).
 *   3. `emitProvidersSettingsDiagnostics`: one notify per distinct diagnostic
 *      per throttle window, silent on repeats, distinct diagnostics never
 *      suppress each other.
 *   4. The registration table drives attribution: route order is registration
 *      order, provider-id and model-id lookups return the owning route's ring,
 *      first registration wins an overlapping model id, and a route's keys
 *      prefix + models map are preserved.
 *   5. `createRouteRing`: the route's `keys` prefix is handed to the key ring
 *      and the provider id is the ring's state-file name.
 *   6. The module-load prologue: with a `routes` key present the built-in
 *      gateway fallback is NOT installed (and the gateway model id attributes
 *      nothing); with no settings file the fallback entry IS installed with
 *      its model ids and payload flag. Each arm is observed in a fresh child
 *      process, because the prologue is a module-load side effect this
 *      process already ran.
 *
 * Harness: the REAL modules (ring-lifecycle, key-ring, log) are compiled with
 * the package's own local tsc (CJS emit) into <repoRoot>/.route-build/ and
 * driven with no network and no pi-ai import. HOME is redirected to an
 * isolated temp dir so key-ring persistence never touches the real
 * ~/.pi/agent, and the keyspace is sanitized so ambient keys cannot leak in.
 * The module-load prologue is driven through child processes, one per HOME,
 * so each arm observes a genuinely fresh load.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
const buildDir = join(repoRoot, ".route-build");

// The agent-zero gateway model id (the built-in route's model-only attribution).
const VENICE_MODEL = "deepseek-v4-pro-0813";
// A standalone route's credential namespace, planted for the ring tests.
const ROUTE_KEY_PREFIX = "ROUTE_TEST_API_KEY";
const ROUTE_KEY_VALUE = "route-test-key-0";

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
  if (!process.env.PI_BRAID_PROVIDER_QUIET && tsc.stdout)
    console.log(tsc.stdout.trim());

  const require = createRequire(import.meta.url);
  return {
    rl: require(join(buildDir, "ring-lifecycle.js")),
    keyRing: require(join(buildDir, "key-ring.js")),
    log: require(join(buildDir, "log.js")),
  };
}

/**
 * Load the compiled ring-lifecycle module in a fresh child process under a
 * caller-chosen HOME, so the module-load prologue runs against that HOME's
 * settings and cannot be masked by this process's already-loaded module. The
 * child reports the attribution table before and after it registers the given
 * routes (the composition root's registration job), plus whether the gateway
 * model id resolves to a ring.
 */
const ROUTE_LOAD_CHILD = `
const path = require("node:path");
const rl = require(path.join(process.env.RT_BUILD_DIR, "ring-lifecycle.js"));
const snap = () => {
  const ids = rl.listRouteIdsForTest();
  const regs = {};
  for (const id of ids) regs[id] = rl.getRouteRegistrationForTest(id);
  return { ids, regs };
};
const afterLoad = snap();
const agentZeroAttributed = rl.resolveRingForModelId(${JSON.stringify(VENICE_MODEL)}) !== null;
for (const r of JSON.parse(process.env.RT_REGISTER || "[]")) {
  rl.registerRoute({
    providerId: r.provider,
    keys: r.keys,
    modelIds: r.modelIds || [],
    models: r.models,
    venicePayload: r.venicePayload,
    ring: rl.createRouteRing({ provider: r.provider, keys: r.keys }),
  });
}
process.stdout.write("\\n__ROUTE_LOAD__" + JSON.stringify({ afterLoad, agentZeroAttributed, afterRegister: snap() }));
`;

function loadViaChild(home, register) {
  const res = spawnSync("node", ["-e", ROUTE_LOAD_CHILD], {
    env: {
      ...process.env,
      HOME: home,
      RT_BUILD_DIR: buildDir,
      RT_REGISTER: JSON.stringify(register ?? []),
    },
    encoding: "utf-8",
  });
  if (res.status !== 0)
    throw new Error(`route-load child failed: ${res.stderr || res.stdout}`);
  const line = (res.stdout || "")
    .split("\n")
    .find((l) => l.startsWith("__ROUTE_LOAD__"));
  if (!line)
    throw new Error(`route-load child produced no result: ${res.stdout}`);
  return JSON.parse(line.slice("__ROUTE_LOAD__".length));
}

async function run() {
  const scratch = mkdtempSync(join(tmpdir(), "pi-braid-route-table-"));
  try {
    // Isolated key-ring persistence; deterministic fresh state every run.
    process.env.HOME = scratch;
    // Sanitize the keyspace so ambient keys cannot leak into the rings.
    for (const key of Object.keys(process.env)) {
      if (/^(AGENT_ZERO_API_KEY|ROUTE_TEST_API_KEY)(_P\d+)?$/.test(key)) {
        delete process.env[key];
      }
    }
    process.env.AGENT_ZERO_API_KEY = "gateway-test-key-0";
    process.env[ROUTE_KEY_PREFIX] = ROUTE_KEY_VALUE;

    const settingsDir = join(scratch, ".pi", "agent");
    mkdirSync(settingsDir, { recursive: true });

    const { rl, keyRing, log } = loadModules();

    // Capture every emitted settings diagnostic.
    const lines = [];
    log.setProvidersLogSink((message) => {
      lines.push(String(message));
    });

    // ── 1. The pure resolver ─────────────────────────────────────────────
    check(
      "resolver: undefined → empty routes, no diagnostic (not configured)",
      (() => {
        const r = rl.resolveRoutesConfig(undefined);
        return r.routes.length === 0 && r.diagnostics.length === 0;
      })(),
    );
    check(
      "resolver: order preserved, fields trimmed, models map kept",
      (() => {
        const r = rl.resolveRoutesConfig([
          {
            provider: " agent-zero ",
            keys: " AGENT_ZERO_API_KEY ",
            models: { "m-1": " agent-zero/m-1 " },
          },
          { provider: "b", keys: "B_KEY" },
        ]);
        return (
          r.diagnostics.length === 0 &&
          r.routes.length === 2 &&
          r.routes[0].provider === "agent-zero" &&
          r.routes[0].keys === "AGENT_ZERO_API_KEY" &&
          r.routes[0].models["m-1"] === "agent-zero/m-1" &&
          r.routes[1].provider === "b" &&
          r.routes[1].models === undefined
        );
      })(),
    );
    check(
      "resolver: malformed whole config → empty routes + one diagnostic",
      (() => {
        const s = rl.resolveRoutesConfig("nope");
        const n = rl.resolveRoutesConfig(null);
        return (
          s.routes.length === 0 &&
          s.diagnostics.length === 1 &&
          s.diagnostics[0] === "routes: must be an array of route entries" &&
          n.diagnostics.length === 1
        );
      })(),
    );
    {
      const r = rl.resolveRoutesConfig([
        "not-an-object",
        { keys: "K" },
        { provider: "dup", keys: "" },
        { provider: "dup", keys: "K" },
        { provider: "dup", keys: "K2" },
        { provider: "bad-models", keys: "K", models: "no" },
        { provider: "bad-map", keys: "K", models: { "": "x" } },
        { provider: "ok", keys: "K" },
      ]);
      const d = r.diagnostics;
      check(
        "resolver: invalid entries skipped, only valid ones kept",
        r.routes.length === 2 &&
          r.routes[0].provider === "dup" &&
          r.routes[1].provider === "ok",
        JSON.stringify(r.routes),
      );
      check(
        "resolver: diagnostics name index + field, no silent drops",
        d.length === 6 &&
          d[0] === "routes[0]: must be an object" &&
          d[1] === "routes[1].provider: must be a non-empty string" &&
          d[2] === "routes[2].keys: must be a non-empty string" &&
          d[3] === 'routes[4].provider: duplicate of "dup"' &&
          d[4] ===
            "routes[5].models: must be an object of model-id to provider-model-id strings" &&
          d[5].startsWith('routes[6].models[""]:'),
        JSON.stringify(d),
      );
    }

    {
      const r = rl.resolveRoutesConfig([
        {
          provider: "attributed",
          keys: "K",
          modelIds: [" m-1 ", "m-2"],
          venicePayload: true,
        },
        { provider: "plain", keys: "K" },
      ]);
      check(
        "resolver: modelIds trimmed, venicePayload kept, absent fields omitted",
        r.diagnostics.length === 0 &&
          r.routes.length === 2 &&
          JSON.stringify(r.routes[0].modelIds) ===
            JSON.stringify(["m-1", "m-2"]) &&
          r.routes[0].venicePayload === true &&
          r.routes[1].modelIds === undefined &&
          r.routes[1].venicePayload === undefined,
        JSON.stringify(r.routes),
      );
    }
    {
      const r = rl.resolveRoutesConfig([
        { provider: "bad-ids", keys: "K", modelIds: "no" },
        { provider: "bad-id", keys: "K", modelIds: ["ok", ""] },
        { provider: "bad-flag", keys: "K", venicePayload: "yes" },
        { provider: "explicit-false", keys: "K", venicePayload: false },
      ]);
      const d = r.diagnostics;
      check(
        "resolver: modelIds/venicePayload wrong types are diagnosed, not dropped",
        d.length === 3 &&
          d[0] ===
            "routes[0].modelIds: must be an array of non-empty model ids" &&
          d[1] === "routes[1].modelIds[1]: must be a non-empty string" &&
          d[2] === "routes[2].venicePayload: must be a boolean",
        JSON.stringify(d),
      );
      check(
        "resolver: an explicit false venicePayload survives resolution",
        r.routes.length === 1 &&
          r.routes[0].provider === "explicit-false" &&
          r.routes[0].venicePayload === false,
        JSON.stringify(r.routes),
      );
    }

    // ── 2. Reader transition semantics ───────────────────────────────────
    const settingsFile = join(settingsDir, "settings.json");
    const writeSettings = (providers) =>
      writeFileSync(settingsFile, JSON.stringify({ braid: { providers } }));

    check(
      "reader: absent file → legacy nulls, routes not configured, silent",
      (() => {
        rmSync(settingsFile, { force: true });
        const s = rl.readProvidersSettingsFromSettings();
        return (
          s.routesConfigured === false &&
          s.routes.length === 0 &&
          s.diagnostics.length === 0 &&
          s.fallback === null &&
          s.lastResort.size === 0
        );
      })(),
    );
    check(
      "reader: routes absent + legacy → legacy path + ONE replacement warn",
      (() => {
        writeSettings({ lastResort: { "agent-zero": "venice-direct" } });
        const s = rl.readProvidersSettingsFromSettings();
        return (
          s.routesConfigured === false &&
          s.routes.length === 0 &&
          s.lastResort.get("agent-zero") === "venice-direct" &&
          s.fallback === null &&
          s.diagnostics.length === 1 &&
          s.diagnostics[0].includes("routes") &&
          s.diagnostics[0].includes("<ENV_PREFIX>")
        );
      })(),
    );
    check(
      "reader: routes absent, nothing legacy → silent",
      (() => {
        writeSettings({});
        const s = rl.readProvidersSettingsFromSettings();
        return s.diagnostics.length === 0 && s.lastResort.size === 0;
      })(),
    );
    check(
      "reader: routes present wins; legacy ignored + ONE naming warn",
      (() => {
        writeSettings({
          routes: [
            { provider: "agent-zero", keys: "AGENT_ZERO_API_KEY" },
            { provider: "openai", keys: "OPENAI_API_KEY" },
          ],
          lastResort: { "agent-zero": "venice-direct" },
          fallback: { provider: "x", model: "y" },
        });
        const s = rl.readProvidersSettingsFromSettings();
        return (
          s.routesConfigured === true &&
          s.routes.length === 2 &&
          s.routes[0].provider === "agent-zero" &&
          s.routes[1].provider === "openai" &&
          s.fallback === null &&
          s.lastResort.size === 0 &&
          s.diagnostics.length === 1 &&
          s.diagnostics[0].includes("ignoring legacy") &&
          s.diagnostics[0].includes("braid.providers.fallback") &&
          s.diagnostics[0].includes("braid.providers.lastResort")
        );
      })(),
    );
    check(
      "reader: routes present, nothing legacy → no warn",
      (() => {
        writeSettings({ routes: [{ provider: "agent-zero", keys: "A0_KEY" }] });
        const s = rl.readProvidersSettingsFromSettings();
        return s.routesConfigured === true && s.diagnostics.length === 0;
      })(),
    );
    check(
      "reader: routes present but malformed → configured, empty, diagnosed",
      (() => {
        writeSettings({ routes: "nope" });
        const s = rl.readProvidersSettingsFromSettings();
        return (
          s.routesConfigured === true &&
          s.routes.length === 0 &&
          s.diagnostics.length === 1 &&
          s.diagnostics[0] === "routes: must be an array of route entries"
        );
      })(),
    );

    // ── 3. Diagnostics emission: once per distinct message ───────────────
    {
      lines.length = 0;
      const batch = [
        "routes: must be an array of route entries",
        "braid.providers.routes is not set — replace it",
      ];
      rl.emitProvidersSettingsDiagnostics(batch);
      const first = lines.length;
      rl.emitProvidersSettingsDiagnostics(batch);
      const afterRepeat = lines.length;
      rl.emitProvidersSettingsDiagnostics([
        "routes[0].keys: must be a non-empty string",
      ]);
      check(
        "emit: one line per distinct diagnostic, repeats silent",
        first === 2 && afterRepeat === 2,
        `first=${first} afterRepeat=${afterRepeat}`,
      );
      check(
        "emit: a new distinct diagnostic is never suppressed",
        lines.length === 3,
      );
    }

    // ── 4. Registration table drives attribution ─────────────────────────
    const f1 = keyRing.createKeyRing({
      prefix: "FIXTURE_API_KEY",
      stateFile: "fixture",
      healthInRotationInfo: true,
    });
    const f2 = keyRing.createKeyRing({
      prefix: "FIXTURE2_API_KEY",
      stateFile: "fixture-2",
      healthInRotationInfo: true,
    });
    rl.registerRoute({
      providerId: "fixture",
      keys: "FIXTURE_API_KEY",
      modelIds: ["fixture/model-a"],
      models: { "alias-1": "fixture/model-a" },
      ring: f1,
    });
    rl.registerRoute({
      providerId: "fixture-2",
      keys: "FIXTURE2_API_KEY",
      modelIds: ["fixture2/model-a"],
      ring: f2,
    });
    check(
      "registry: registration order (built-in agent-zero first, then config/order)",
      JSON.stringify(rl.listRouteIdsForTest()) ===
        JSON.stringify(["agent-zero", "fixture", "fixture-2"]),
      JSON.stringify(rl.listRouteIdsForTest()),
    );
    check(
      "registry: provider id resolves the owning route's ring",
      rl.resolveRingForMessage("fixture-2", undefined) === f2 &&
        rl.resolveRingForMessage("fixture", undefined) === f1,
    );
    check(
      "registry: model id resolves the owning route's ring",
      rl.resolveRingForModelId("fixture2/model-a") === f2 &&
        rl.resolveRingForModelId(VENICE_MODEL) === rl.veniceKeyRing,
    );
    check(
      "registry: unknown provider falls back to model-id attribution",
      rl.resolveRingForMessage("not-registered", "fixture/model-a") === f1,
    );
    check(
      "registry: keys prefix, model ids and models map preserved",
      (() => {
        const r = rl.getRouteRegistrationForTest("fixture");
        return (
          r !== null &&
          r.keys === "FIXTURE_API_KEY" &&
          JSON.stringify(r.modelIds) === JSON.stringify(["fixture/model-a"]) &&
          r.models["alias-1"] === "fixture/model-a"
        );
      })(),
    );
    check(
      "registry: venicePayload defaults to false when the descriptor omits it",
      rl.getRouteRegistrationForTest("fixture").venicePayload === false &&
        rl.getRouteRegistrationForTest("fixture-2").venicePayload === false,
    );
    rl.registerRoute({
      providerId: "fixture-3",
      keys: "FIXTURE3_API_KEY",
      modelIds: ["fixture/model-a"],
      ring: keyRing.createKeyRing({
        prefix: "FIXTURE3_API_KEY",
        stateFile: "fixture-3",
      }),
    });
    check(
      "registry: first registration wins an overlapping model id",
      rl.resolveRingForModelId("fixture/model-a") === f1,
    );
    {
      // The attribution surface is the descriptor's modelIds PLUS both sides
      // of its models map: a value is the id a redirected turn arrives with,
      // and a key is a dead id the walk would resolve through the map and
      // serve. Both are served, so both attribute.
      const f4 = keyRing.createKeyRing({
        prefix: "FIXTURE4_API_KEY",
        stateFile: "fixture-4",
      });
      rl.registerRoute({
        providerId: "fixture-map",
        keys: "FIXTURE4_API_KEY",
        modelIds: ["fixture-map/native"],
        models: { "dead-1": "mapped/model-x" },
        ring: f4,
      });
      check(
        "registry: a models-map provider id is attributed to its route",
        rl.resolveRingForModelId("mapped/model-x") === f4,
      );
      check(
        "registry: a models-map key is attributed to the route that serves it",
        rl.resolveRingForModelId("dead-1") === f4,
      );
      check(
        "registry: a descriptor model id is attributed to its route",
        rl.resolveRingForModelId("fixture-map/native") === f4,
      );
      check(
        "registry: an id no route owns resolves no ring",
        rl.resolveRingForModelId("unconfigured/model") === null,
      );
    }

    // ── 5. createRouteRing: keys prefix + state-file name ────────────────
    {
      const ring = rl.createRouteRing({
        provider: "route-test",
        keys: ROUTE_KEY_PREFIX,
      });
      check(
        "createRouteRing: the keys prefix selects the route's keys",
        ring.getActiveKey() === ROUTE_KEY_VALUE,
      );
      ring.exhaustActiveKey();
      check(
        "createRouteRing: state-file name is the provider id",
        existsSync(join(settingsDir, ".key-ring-state-route-test.json")),
      );
      check(
        "createRouteRing: unrelated state files are not written",
        !existsSync(join(settingsDir, ".key-ring-state-agent-zero.json")),
      );
    }

    // ── 6. Module load: the built-in fallback is conditional ─────────────
    {
      // Arm A: a routes key is present. The prologue installs no built-in
      // fallback, so the table holds exactly the configured routes and the
      // gateway model id attributes nothing.
      const routesHome = join(scratch, "arm-routes");
      mkdirSync(join(routesHome, ".pi", "agent"), { recursive: true });
      const configured = [
        { provider: "cfg-a", keys: "CFG_A_KEY", modelIds: ["cfg-a/model-x"] },
        { provider: "cfg-b", keys: "CFG_B_KEY", venicePayload: true },
      ];
      writeFileSync(
        join(routesHome, ".pi", "agent", "settings.json"),
        JSON.stringify({ braid: { providers: { routes: configured } } }),
      );
      const routesArm = loadViaChild(routesHome, configured);
      check(
        "module load: a routes key installs no built-in fallback",
        routesArm.afterLoad.ids.length === 0,
        JSON.stringify(routesArm.afterLoad.ids),
      );
      check(
        "module load: no built-in fallback means the gateway model id attributes nothing",
        routesArm.agentZeroAttributed === false,
      );
      check(
        "module load: the table is exactly the configured routes, no agent-zero",
        JSON.stringify(routesArm.afterRegister.ids) ===
          JSON.stringify(["cfg-a", "cfg-b"]),
        JSON.stringify(routesArm.afterRegister.ids),
      );

      // Arm B: no settings file. The prologue installs exactly the built-in
      // fallback entry, carrying its model ids and the payload flag.
      const defaultHome = join(scratch, "arm-default");
      mkdirSync(defaultHome, { recursive: true });
      const defaultArm = loadViaChild(defaultHome, []);
      const agentZero = defaultArm.afterLoad.regs["agent-zero"];
      check(
        "module load: no settings file installs exactly the built-in fallback",
        JSON.stringify(defaultArm.afterLoad.ids) ===
          JSON.stringify(["agent-zero"]),
        JSON.stringify(defaultArm.afterLoad.ids),
      );
      check(
        "module load: the fallback carries the gateway model id and payload flag",
        !!agentZero &&
          agentZero.keys === "AGENT_ZERO_API_KEY" &&
          JSON.stringify(agentZero.modelIds) ===
            JSON.stringify([VENICE_MODEL]) &&
          agentZero.venicePayload === true,
        JSON.stringify(agentZero),
      );
      check(
        "module load: the fallback attributes the gateway model id to its ring",
        defaultArm.agentZeroAttributed === true,
      );
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
