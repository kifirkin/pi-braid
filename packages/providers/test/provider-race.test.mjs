#!/usr/bin/env node
/**
 * provider-race.test.mjs
 *
 * Revert-proof deterministic regression test for the provider race in
 * packages/providers.
 *
 * Regression:
 *   The provider handlers used a module-global `lastRequestProvider` (written
 *   in before_provider_request, read in after_provider_response / message_end)
 *   to pick the key ring. With two turns in flight the global is last-writer-
 *   wins:
 *
 *     before(agent-zero) -> before(fixture) -> message_end(agent-zero error)
 *
 *   ends up rotating the FIXTURE key ring instead of the agent-zero ring the
 *   event actually belongs to.
 *
 * This test drives the REAL handler functions from ring-lifecycle.ts (the same
 * module index.ts wires into pi) — no network — in that offending interleaved
 * order and asserts the VENICE ring receives the rotation and the fixture
 * ring (a test-local synthetic secondary, registered via the module's
 * registerRoute seam) is untouched.
 *
 * Revert-proof: point PI_BRAID_PROVIDER_SRC_DIR at a copy of the pre-fix
 * handler module (with the module-global restored) and this test FAILS;
 * against the fixed module it PASSES.
 *
 * Runtime: no npm install, no network. The handler module is compiled with the
 * package's own local tsc (CJS emit) into <repoRoot>/.race-build/ (inside the
 * repo so @earendil-works types resolve; the module itself has no pi-ai runtime
 * import, so no ESM-only package is loaded). HOME is redirected to an isolated
 * temp dir so key-ring persistence never touches the real ~/.pi/agent.
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
// Built at the repo ROOT, not under packages/providers: the providers
// package.json has "type": "module" (which would make emitted .js load as ESM
// and break CJS "exports"), while the repo root has no "type" (CJS default).
// The dir is transient and cleaned after every run.
const buildDir = join(repoRoot, ".race-build");

const VENICE_MODEL = "deepseek-v4-pro-0813";
// Test-local synthetic provider routes (registerRoute seam) — three rings in
// total once agent-zero is counted, so N-route attribution and the interleaved-turn
// race get real regression coverage without extra production providers.
const FIXTURE_PROVIDER = "fixture";
const FIXTURE_MODEL = "fixture/model-a";
const FIXTURE2_PROVIDER = "fixture-2";
const FIXTURE2_MODEL = "fixture2/model-a";
// A third synthetic route that shares fixture-2's model id, so the engine can
// re-serve a fixture-2 death over it (scenario G).
const FIXTURE3_PROVIDER = "fixture-3";

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

  // Source-directory override lets us run the identical test against a pre-fix
  // copy of the handler module to prove revert-proofness.
  const srcDir = process.env.PI_BRAID_PROVIDER_SRC_DIR || pkgRoot;

  const args = [
    tscBin,
    "--ignoreConfig", // sources passed on CLI; the package tsconfig.json is intentionally bypassed
    join(srcDir, "ring-lifecycle.ts"),
    join(srcDir, "key-ring.ts"),
    join(srcDir, "log.ts"),
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
    mod: require(join(buildDir, "ring-lifecycle.js")),
    keyRingMod: require(join(buildDir, "key-ring.js")),
  };
}

async function run() {
  const scratch = mkdtempSync(join(tmpdir(), "pi-braid-provider-race-"));
  try {
    // Isolated key-ring persistence; deterministic fresh state every run.
    process.env.HOME = scratch;
    // Sanitize the keyspace so ambient AGENT_ZERO_API_KEY_P* / FIXTURE_API_KEY*
    // env vars (which the real setup may export) cannot leak into the rings.
    for (const key of Object.keys(process.env)) {
      if (
        /^(AGENT_ZERO_API_KEY|FIXTURE_API_KEY|FIXTURE2_API_KEY|FIXTURE3_API_KEY)(_P\d+)?$/.test(
          key,
        )
      ) {
        delete process.env[key];
      }
    }
    process.env.AGENT_ZERO_API_KEY = "venice-test-key-1";
    process.env.FIXTURE_API_KEY = "fx-test-key-1";
    process.env.FIXTURE2_API_KEY = "fx2-test-key-1";
    process.env.FIXTURE3_API_KEY = "fx3-test-key-1";

    const { mod, keyRingMod } = loadHandlers();
    // Test-local synthetic routes: preserve the multi-route interleaving
    // coverage (per-event attribution, race isolation) without extra
    // production providers.
    mod.registerRoute({
      providerId: FIXTURE_PROVIDER,
      keys: "FIXTURE_API_KEY",
      modelIds: [FIXTURE_MODEL],
      ring: keyRingMod.createKeyRing({
        prefix: "FIXTURE_API_KEY",
        stateFile: "fixture",
        healthInRotationInfo: true,
      }),
    });
    mod.registerRoute({
      providerId: FIXTURE2_PROVIDER,
      keys: "FIXTURE2_API_KEY",
      modelIds: [FIXTURE2_MODEL],
      ring: keyRingMod.createKeyRing({
        prefix: "FIXTURE2_API_KEY",
        stateFile: "fixture-2",
        healthInRotationInfo: true,
      }),
    });
    mod.registerRoute({
      providerId: FIXTURE3_PROVIDER,
      keys: "FIXTURE3_API_KEY",
      modelIds: [FIXTURE2_MODEL],
      ring: keyRingMod.createKeyRing({
        prefix: "FIXTURE3_API_KEY",
        stateFile: "fixture-3",
        healthInRotationInfo: true,
      }),
    });
    const before = mod.handleBeforeProviderRequest;
    const after = mod.handleAfterProviderResponse;
    const msgEnd = mod.handleMessageEnd;
    const usable = (p) => mod.getKeyRingStatusForTest(p)?.usable;

    check(
      "all handler functions exported",
      typeof before === "function" &&
        typeof after === "function" &&
        typeof msgEnd === "function",
    );

    // ── Scenario A: the interleaved-turn race (primary revert-proof gate) ────
    // before(agent-zero) -> before(fixture) -> message_end(agent-zero, auth error).
    // The agent-zero ring must be exhausted; the fixture ring must be untouched.
    before({ model: VENICE_MODEL, messages: [] });
    before({ model: FIXTURE_MODEL, messages: [] });
    msgEnd({
      message: {
        provider: "agent-zero",
        model: VENICE_MODEL,
        stopReason: "error",
        errorMessage: "401 invalid api key",
      },
    });
    check(
      "A: agent-zero ring exhausted by its own error (usable 0)",
      usable("agent-zero") === 0,
    );
    check(
      "A: fixture ring NOT rotated by agent-zero's error (usable 1)",
      usable(FIXTURE_PROVIDER) === 1,
    );

    // ── Scenario B: markSuccess heals the turn's own ring ────────────────────
    // agent-zero is still exhausted from A. A successful agent-zero turn must heal the
    // VENICE ring (not the fixture) before the interleaved fixture request.
    before({ model: VENICE_MODEL, messages: [] });
    before({ model: FIXTURE_MODEL, messages: [] });
    msgEnd({
      message: {
        provider: "agent-zero",
        model: VENICE_MODEL,
        stopReason: "stop",
      },
    });
    check(
      "B: agent-zero markSuccess heals its own ring (usable 1)",
      usable("agent-zero") === 1,
    );
    check(
      "B: fixture ring stays untouched (usable 1)",
      usable(FIXTURE_PROVIDER) === 1,
    );

    // ── Scenario F: three-ring interleave (N-route attribution) ──────────────
    // Three turns in flight, the LAST-arriving event belongs to the middle
    // request: before(agent-zero) -> before(fixture) -> before(fixture-2) ->
    // message_end(fixture-2, auth error). Only fixture-2's ring rotates; agent-zero
    // (healthy after B) and fixture stay untouched. A stale global or a table
    // that mis-orders routes would rotate the wrong ring here.
    before({ model: VENICE_MODEL, messages: [] });
    before({ model: FIXTURE_MODEL, messages: [] });
    before({ model: FIXTURE2_MODEL, messages: [] });
    msgEnd({
      message: {
        provider: FIXTURE2_PROVIDER,
        model: FIXTURE2_MODEL,
        stopReason: "error",
        errorMessage: "401 invalid api key",
      },
    });
    check(
      "F: fixture-2 ring exhausted by its own error (usable 0)",
      usable(FIXTURE2_PROVIDER) === 0,
    );
    check(
      "F: agent-zero ring untouched by fixture-2's error (usable 1)",
      usable("agent-zero") === 1,
    );
    check(
      "F: fixture ring untouched by fixture-2's error (usable 1)",
      usable(FIXTURE_PROVIDER) === 1,
    );

    // ── Scenario C: a foreign-model turn must not touch our rings ────────────
    // A foreign (non-our-provider) error turn after an agent-zero request must not
    // exhaust the agent-zero ring (a stale global would have).
    before({ model: VENICE_MODEL, messages: [] });
    msgEnd({
      message: {
        provider: "openai",
        model: "gpt-4.1",
        stopReason: "error",
        errorMessage: "401 invalid api key",
      },
    });
    check(
      "C: foreign-model error does not exhaust agent-zero (usable 1)",
      usable("agent-zero") === 1,
    );
    check(
      "C: foreign-model error does not exhaust the fixture ring (usable 1)",
      usable(FIXTURE_PROVIDER) === 1,
    );

    // ── Scenario D: model-id fallback attribution (no provider field) ────────
    // When message.provider is absent, resolution falls back to message.model.
    // The agent-zero error must still rotate only the agent-zero ring.
    before({ model: VENICE_MODEL, messages: [] });
    before({ model: FIXTURE_MODEL, messages: [] });
    msgEnd({
      message: {
        model: VENICE_MODEL,
        stopReason: "error",
        errorMessage: "403 forbidden",
      },
    });
    check(
      "D: model-only agent-zero error exhausts agent-zero (usable 0)",
      usable("agent-zero") === 0,
    );
    check(
      "D: model-only agent-zero error does not touch the fixture ring (usable 1)",
      usable(FIXTURE_PROVIDER) === 1,
    );

    // ── Scenario E: after_provider_response cannot misroute (no identity) ───
    // post-fix: after_provider_response never mutates a ring (the event has no
    // model/request id). agent-zero stays exhausted from D; the fixture stays fresh.
    before({ model: FIXTURE_MODEL, messages: [] });
    after({ status: 200, headers: {} });
    check(
      "E: after_provider_response(200) does not heal the wrong ring (agent-zero usable 0)",
      usable("agent-zero") === 0,
    );
    check(
      "E: after_provider_response(200) does not mis-mark the fixture ring (usable 1)",
      usable(FIXTURE_PROVIDER) === 1,
    );
    check(
      "E: fixture-2 stays exhausted from F (never mis-healed, usable 0)",
      usable(FIXTURE2_PROVIDER) === 0,
    );

    // ── Scenario G: the engine path keeps the interleave isolated ───────────
    // A fixture-2 death (its ring is at usable 0 from F) with the rotation
    // hook wired: the engine walks [fixture-2, fixture-3], skips the dead
    // route, and engages fixture-3 — which shares fixture-2's model id. Other
    // rings (agent-zero, fixture) are never consulted or mutated.
    {
      const engine = mod.createRotationEngine({
        order: [FIXTURE2_PROVIDER, FIXTURE3_PROVIDER],
      });
      const calls = { setModel: [], notify: [] };
      const result = await msgEnd(
        {
          message: {
            provider: FIXTURE2_PROVIDER,
            model: FIXTURE2_MODEL,
            stopReason: "error",
            errorMessage: "401 invalid api key",
          },
        },
        {
          rotation: {
            onRingExhausted: (providerId, errText, modelId) =>
              engine.maybeEngage(providerId, errText, modelId, {
                setModel: (provider, model) => {
                  calls.setModel.push({ provider, model });
                  return true;
                },
                notify: (text) => calls.notify.push(text),
              }),
          },
        },
      );
      check(
        "G: engine engages the first live route serving the dead turn's model id",
        calls.setModel.length === 1 &&
          calls.setModel[0].provider === FIXTURE3_PROVIDER &&
          calls.setModel[0].model === FIXTURE2_MODEL &&
          calls.notify.length === 1 &&
          !!result?.message?.errorMessage?.includes(
            "rotated to the next configured route",
          ),
        JSON.stringify(calls),
      );
      check(
        "G: the agent-zero ring is neither consulted nor mutated by the fixture-2 death",
        usable("agent-zero") === 0 && usable(FIXTURE_PROVIDER) === 1,
      );
      check(
        "G: the engaged fixture-3 ring is untouched (engage is a setModel, not a ring write)",
        usable(FIXTURE3_PROVIDER) === 1,
      );
    }

    // ── Scenario H: attribution and the Venice payload tweak follow the
    // route descriptor, not a model-id literal ─────────────────────────────
    check(
      "H: a configured route's modelIds resolves that route's ring",
      mod.resolveRingForModelId(FIXTURE2_MODEL) ===
        mod.resolveRingForMessage(FIXTURE2_PROVIDER, undefined),
    );
    check(
      "H: an id no route owns resolves no ring",
      mod.resolveRingForModelId("unconfigured/model") === null,
    );
    check(
      "H: the fallback gateway route takes the Venice payload tweak",
      (() => {
        const shaped = before({ model: VENICE_MODEL, messages: [] });
        return (
          shaped?.venice_parameters?.include_venice_system_prompt === false
        );
      })(),
    );
    check(
      "H: a route that did not ask for the tweak leaves the payload untouched",
      before({ model: FIXTURE_MODEL, messages: [] }) === undefined,
    );
    {
      const TWEAK_PROVIDER = "fixture-tweak";
      const TWEAK_MODEL = "fixture-tweak/model-a";
      mod.registerRoute({
        providerId: TWEAK_PROVIDER,
        keys: "FIXTURE_TWEAK_API_KEY",
        modelIds: [TWEAK_MODEL],
        venicePayload: true,
        ring: keyRingMod.createKeyRing({
          prefix: "FIXTURE_TWEAK_API_KEY",
          stateFile: "fixture-tweak",
        }),
      });
      check(
        "H: venicePayload on a configured descriptor turns the tweak on",
        (() => {
          const shaped = before({ model: TWEAK_MODEL, messages: [] });
          return (
            shaped?.venice_parameters?.include_venice_system_prompt === false
          );
        })(),
      );
      check(
        "H: the tweak follows the owning route, not the model id",
        before({ model: "unconfigured/model", messages: [] }) === undefined,
      );
    }

    // ── Scenario I: a configured route table carries no built-in entry ─────
    // The composition root clears the registration table when the settings
    // carry a `routes` key and then registers exactly the configured routes;
    // the built-in fallback must not survive that rebuild, so no unconfigured
    // route is attributed or rotated to.
    mod.clearRouteRegistry();
    mod.registerRoute({
      providerId: "configured-only",
      keys: "CONFIGURED_ONLY_API_KEY",
      modelIds: [VENICE_MODEL],
      venicePayload: true,
      ring: keyRingMod.createKeyRing({
        prefix: "CONFIGURED_ONLY_API_KEY",
        stateFile: "configured-only",
      }),
    });
    check(
      "I: the rebuilt table holds exactly the configured route",
      JSON.stringify(mod.listRouteIdsForTest()) ===
        JSON.stringify(["configured-only"]),
      JSON.stringify(mod.listRouteIdsForTest()),
    );
    check(
      "I: no built-in entry survives a configured-table rebuild",
      !mod.listRouteIdsForTest().includes("agent-zero") &&
        mod.resolveRingForMessage("agent-zero", undefined) === null,
    );
    check(
      "I: the configured route, not the built-in one, owns the shared model id",
      mod.resolveRingForModelId(VENICE_MODEL) ===
        mod.resolveRingForMessage("configured-only", undefined),
    );
    // The composition root's other branch: no `routes` key at all, so the
    // table is rebuilt from the fallback entry alone and that entry owns the
    // gateway's own model ids.
    mod.clearRouteRegistry();
    mod.installDefaultGatewayRoute();
    check(
      "I: the fallback install restores the built-in entry",
      JSON.stringify(mod.listRouteIdsForTest()) ===
        JSON.stringify(["agent-zero"]) &&
        mod.resolveRingForModelId(VENICE_MODEL) === mod.veniceKeyRing,
      JSON.stringify(mod.listRouteIdsForTest()),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(buildDir, { recursive: true, force: true });
  }

  console.log(`\n📊 ${checks.length - failures} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
