#!/usr/bin/env node
/**
 * fallback-policy.test.mjs
 *
 * Legacy-resolver + shared-substrate regression suite for packages/providers.
 *
 * The cross-provider fallback policy was replaced by the route-order rotation
 * engine (rotation-engine.test.mjs); the fail-back controller is covered by
 * route-failback.test.mjs. This suite keeps the pieces that outlived it:
 *
 *   1. `resolveFallbackConfig` / `resolveLastResortMap`: the pure legacy
 *      resolvers the settings reader still runs for its routes-transition
 *      diagnostic. Validated shapes, malformed shapes → inert, never throws.
 *   2. `readProvidersSettingsFromSettings().fallback`: the legacy read path
 *      (routes absent) still returns the fallback block, with the ONE
 *      replacement-shape diagnostic; routes present → the block resolves null
 *      and the diagnostic names it as ignored.
 *   3. `createEngageScaffold`: the shared substrate the rotation engine is
 *      built on — one engage per episode (hysteresis), a single inert notice,
 *      promise transparency, and reset() re-arming the episode.
 *
 * Harness: the REAL ring-lifecycle module is compiled with the package's own
 * local tsc (CJS emit) into <repoRoot>/.race-build/ and driven with no network
 * and no pi-ai import. HOME is redirected to an isolated temp dir so the
 * settings reader never touches the real ~/.pi/agent.
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
const buildDir = join(repoRoot, ".race-build");

let failures = 0;
const checks = [];
function check(name, cond, extra) {
  checks.push({ name, cond, extra });
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name}${extra ? " (" + extra + ")" : ""}`);
  }
}

/** Compile the handler module to CJS in buildDir and load it. */
function loadHandlers() {
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
  return { mod: require(join(buildDir, "ring-lifecycle.js")) };
}

/** Sync fake engage deps: records setModel + notify calls. */
function fakeDeps(setModelResult = true) {
  const calls = { setModel: [], notify: [] };
  return {
    calls,
    engage: {
      setModel: (provider, model) => {
        calls.setModel.push({ provider, model });
        return setModelResult;
      },
      notify: (text) => calls.notify.push(text),
    },
  };
}

async function run() {
  const scratch = mkdtempSync(join(tmpdir(), "pi-braid-fallback-policy-"));
  try {
    process.env.HOME = scratch;
    const { mod } = loadHandlers();

    check(
      "legacy resolvers + scaffold exported",
      typeof mod.resolveFallbackConfig === "function" &&
        typeof mod.resolveLastResortMap === "function" &&
        typeof mod.createEngageScaffold === "function" &&
        typeof mod.readProvidersSettingsFromSettings === "function",
    );

    // ── 1. resolveFallbackConfig matrix ──────────────────────────────────
    {
      const ok = mod.resolveFallbackConfig({ provider: " p ", model: " m " });
      check(
        "resolveFallbackConfig: trims valid config",
        ok && ok.provider === "p" && ok.model === "m",
      );
      check(
        "resolveFallbackConfig: rejects non-object/arrays/partial/empty",
        mod.resolveFallbackConfig(undefined) === null &&
          mod.resolveFallbackConfig(null) === null &&
          mod.resolveFallbackConfig("x") === null &&
          mod.resolveFallbackConfig([]) === null &&
          mod.resolveFallbackConfig({ provider: "", model: "m" }) === null &&
          mod.resolveFallbackConfig({ provider: "p" }) === null &&
          mod.resolveFallbackConfig({ provider: 123, model: "x" }) === null,
      );
    }

    // ── 2. resolveLastResortMap matrix (legacy map resolver) ─────────────
    {
      const m = mod.resolveLastResortMap({ "agent-zero": "venice-direct" });
      check(
        'resolveLastResortMap: { "agent-zero": venice-direct} → entry',
        m.size === 1 && m.get("agent-zero") === "venice-direct",
      );
      check(
        "resolveLastResortMap: absent/non-object/array/{} → empty map",
        mod.resolveLastResortMap(undefined).size === 0 &&
          mod.resolveLastResortMap(null).size === 0 &&
          mod.resolveLastResortMap("x").size === 0 &&
          mod.resolveLastResortMap([]).size === 0 &&
          mod.resolveLastResortMap({}).size === 0,
      );
      const trimmed = mod.resolveLastResortMap({
        " agent-zero ": " venice-direct ",
        numeric: 7,
        blank: "",
      });
      check(
        "resolveLastResortMap: trims keys/values, skips non-string/empty values",
        trimmed.size === 1 &&
          trimmed.get("agent-zero") === "venice-direct" &&
          trimmed.get("numeric") === undefined &&
          trimmed.get("blank") === undefined,
      );
    }

    // ── 3. Settings reader: legacy fallback read path ───────────────────────
    {
      const settingsDir = join(scratch, ".pi", "agent");
      mkdirSync(settingsDir, { recursive: true });
      const settingsFile = join(settingsDir, "settings.json");
      const writeSettings = (providers) =>
        writeFileSync(settingsFile, JSON.stringify({ braid: { providers } }));

      writeSettings({
        fallback: { provider: " fallback-prov ", model: " fallback-model " },
      });
      {
        const read = mod.readProvidersSettingsFromSettings();
        check(
          "reader: routes absent → fallback block read (trimmed) + ONE replacement warn",
          !!read.fallback &&
            read.fallback.provider === "fallback-prov" &&
            read.fallback.model === "fallback-model" &&
            read.routesConfigured === false &&
            read.diagnostics.length === 1 &&
            read.diagnostics[0].includes("routes"),
        );
      }

      writeSettings({ fallback: { provider: "only-provider" } });
      check(
        "reader: partial fallback → null",
        mod.readProvidersSettingsFromSettings().fallback === null,
      );

      writeSettings({
        routes: [{ provider: "agent-zero", keys: "AGENT_ZERO_API_KEY" }],
        fallback: { provider: "legacy", model: "legacy-model" },
      });
      {
        const read = mod.readProvidersSettingsFromSettings();
        check(
          "reader: routes present → fallback ignored (null) + ONE naming warn",
          read.routesConfigured === true &&
            read.fallback === null &&
            read.diagnostics.some((d) => d.includes("ignoring legacy")),
        );
      }

      rmSync(settingsFile);
      check(
        "reader: absent file → fallback null, silent",
        mod.readProvidersSettingsFromSettings().fallback === null,
      );
    }

    // ── 4. createEngageScaffold: the shared substrate ────────────────────
    function makeScaffold(applyResult) {
      const calls = { apply: [], engage: [], inert: [] };
      const scaffold = mod.createEngageScaffold({
        resolve: (providerId, modelId) =>
          providerId === "dead" ? { modelId } : null,
        apply: (target, modelId, engage) => {
          calls.apply.push({ providerId: "leg", modelId });
          return typeof applyResult === "function"
            ? applyResult(target, modelId, engage)
            : applyResult;
        },
        onEngaged: (target, modelId, engage) => {
          calls.engage.push(modelId);
          engage.notify("engaged whisper");
          return "MARKER";
        },
        onInert: (target, modelId, engage) => {
          calls.inert.push(modelId);
          engage.notify("inert notice");
        },
      });
      return { scaffold, calls };
    }

    {
      const { scaffold, calls } = makeScaffold(true);
      const fb = fakeDeps();
      const marker = scaffold.attempt("foreign", fb.engage, "m");
      check(
        "scaffold: an unresolved provider is silent inert (no apply, no notice)",
        marker === null &&
          calls.apply.length === 0 &&
          fb.calls.notify.length === 0 &&
          scaffold.isEngaged() === false,
      );
    }
    {
      const { scaffold, calls } = makeScaffold(true);
      const fb = fakeDeps();
      const first = scaffold.attempt("dead", fb.engage, "m");
      check(
        "scaffold: a resolved engage applies, emits ONE whisper and returns the marker",
        first === "MARKER" &&
          calls.apply.length === 1 &&
          fb.calls.notify.length === 1 &&
          scaffold.isEngaged() === true,
      );
      const second = scaffold.attempt("dead", fb.engage, "m");
      check(
        "scaffold: hysteresis — a second attempt in the episode is inert",
        second === null &&
          calls.apply.length === 1 &&
          fb.calls.notify.length === 1,
      );
      scaffold.reset();
      const afterReset = scaffold.attempt("dead", fb.engage, "m");
      check(
        "scaffold: reset() re-arms the episode",
        afterReset === "MARKER" &&
          calls.apply.length === 2 &&
          fb.calls.notify.length === 2,
      );
    }
    {
      const { scaffold, calls } = makeScaffold(false);
      const fb = fakeDeps();
      const first = scaffold.attempt("dead", fb.engage, "m");
      const second = scaffold.attempt("dead", fb.engage, "m");
      check(
        "scaffold: a failed engage returns null with exactly ONE inert notice",
        first === null &&
          second === null &&
          calls.inert.length === 1 &&
          fb.calls.notify.length === 1 &&
          scaffold.isEngaged() === false,
      );
    }
    {
      let resolveApply;
      const gate = new Promise((r) => (resolveApply = r));
      const { scaffold, calls } = makeScaffold(() => gate.then(() => true));
      const fb = fakeDeps();
      const pending = scaffold.attempt("dead", fb.engage, "m");
      check(
        "scaffold: an async engage returns a promise, not a marker",
        pending instanceof Promise && calls.apply.length === 1,
      );
      resolveApply(true);
      check(
        "scaffold: the async engage resolves to the marker",
        (await pending) === "MARKER" && scaffold.isEngaged() === true,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
  }

  console.log(`\n${checks.length - failures}/${checks.length} checks passed`);
  if (failures > 0) process.exit(1);
}

run().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
