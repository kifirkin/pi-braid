/**
 * Fixture: health_maintenance numeric inputs must be usable numbers.
 *
 * The framework converts a blank optional string to 0 before the handler runs,
 * so a client that fills every schema key can deliver `errorRateMax: 0` and
 * `maxConsecutiveErrors: 0` (thresholds that degrade on the first error), a
 * zeroed `healthcheckMinScore` (the score floor disabled), or a 0% benchmark
 * run. The schema refuses those zeros at validation, and the handler refuses
 * them again for direct callers, merging nothing on a refusal. The valid-call
 * cases are the control: a real config patch still applies and a real
 * benchmark still records.
 *
 * Run: node test/runtime/self/test-health-config-blank-guard.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Hermeticity pin - MUST run before the dist import below. The extension loads
// and periodically saves degradation metrics through paths resolved from HOME,
// so own that input instead of touching the operator's agent directory.
const FIXTURE_HOME = mkdtempSync(join(tmpdir(), "health-config-guard-home-"));
process.env.HOME = FIXTURE_HOME;
process.env.PI_CODING_AGENT_DIR = join(FIXTURE_HOME, ".pi", "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(
  join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
  JSON.stringify({ braid: {} }),
);

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

const { validateToolArguments } = await import("@earendil-works/pi-ai/utils/validation");
const healthModule = await import(
  join(ROOT, "dist/extensions/self/health-maintenance/index.js")
);
const healthMaintenanceExtension = healthModule.default;
const { getConfig } = await import(join(ROOT, "dist/lib/detection/degradation-detector.js"));

function makeFakePi() {
  const tools = new Map();
  const commands = new Map();
  return {
    tools,
    commands,
    on() {},
    registerTool(def) {
      tools.set(def.name, def);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
  };
}

const pi = makeFakePi();
healthMaintenanceExtension(pi);
const tool = pi.tools.get("health_maintenance");
assert.ok(tool, "health_maintenance tool registered");
// The registered tool carries the schema the framework validates against.
const healthMaintenanceSchema = tool.parameters;

// One stable ctx object: extension state falls back to a WeakMap keyed on it,
// so the session-scoped config view must be read through the same object.
const ctx = { cwd: "/tmp/test", mode: "test", hasUI: false };

const DEFAULTS = { healthcheckMinScore: 80, errorRateMax: 0.1, toolSuccessMin: 70 };

function frameworkArgs(args) {
  return validateToolArguments(
    { name: "health_maintenance", parameters: healthMaintenanceSchema },
    { name: "health_maintenance", arguments: args },
  );
}

async function run(action, payload, callId) {
  return tool.execute(callId, { action, ...payload }, undefined, undefined, ctx);
}

console.log("=== health_maintenance blank numeric guard ===\n");

await test("the schema refuses a blank-filled config before the handler", async () => {
  let threw = null;
  try {
    frameworkArgs({
      action: "config",
      config: {
        healthcheckMinScore: "",
        errorRateMax: "",
        toolSuccessMin: "",
        maxConsecutiveErrors: "",
      },
    });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, "framework validation refuses the blank-filled config");
  assert.match(threw.message, /healthcheckMinScore: must be >= 1/);
  assert.equal(
    getConfig().healthcheckMinScore,
    DEFAULTS.healthcheckMinScore,
    "the refused call never reached the merge",
  );
});

await test("the handler refuses blank-derived zeros and merges nothing", async () => {
  const before = getConfig();
  const beforeSession = getConfig(ctx);
  const result = await run(
    "config",
    {
      config: {
        healthcheckMinScore: 0,
        errorRateMax: 0,
        toolSuccessMin: 0,
        maxConsecutiveErrors: 0,
      },
    },
    "hc-blank-1",
  );
  assert.equal(result.details.success, false, "the call is refused");
  assert.match(result.details.error, /healthcheckMinScore must be 1-100/);
  assert.deepEqual(getConfig(), before, "the process config is unchanged");
  assert.deepEqual(getConfig(ctx), beforeSession, "the session view is unchanged");
  assert.equal(
    getConfig().healthcheckMinScore,
    DEFAULTS.healthcheckMinScore,
    "the score floor keeps its value",
  );
});

await test("the handler refuses errorRateMax 0 alone (its band is (0,1])", async () => {
  const before = getConfig();
  const result = await run("config", { config: { errorRateMax: 0 } }, "hc-blank-2");
  assert.equal(result.details.success, false);
  assert.match(result.details.error, /errorRateMax must be \(0, 1\]/);
  assert.deepEqual(getConfig(), before, "nothing is merged");
  assert.equal(getConfig().maxConsecutiveErrors, 3, "the storm threshold is not zeroed");
});

await test("one out-of-band field refuses the whole patch (atomic)", async () => {
  const before = getConfig();
  const result = await run(
    "config",
    { config: { healthcheckMinScore: 95, errorRateMax: 1.5 } },
    "hc-blank-3",
  );
  assert.equal(result.details.success, false);
  assert.match(result.details.error, /errorRateMax must be \(0, 1\]/);
  assert.equal(
    getConfig().healthcheckMinScore,
    DEFAULTS.healthcheckMinScore,
    "the valid sibling is not merged either",
  );
  assert.deepEqual(getConfig(), before, "nothing is merged");
});

await test("a present but empty config object is refused as no values", async () => {
  const result = await run("config", { config: {} }, "hc-blank-4");
  assert.equal(result.details.success, false);
  assert.match(result.details.error, /no config values provided/);
});

await test("a valid config patch still applies (control)", async () => {
  const result = await run(
    "config",
    {
      config: {
        healthcheckMinScore: 90,
        errorRateMax: 0.25,
        toolSuccessMin: 80,
        maxConsecutiveErrors: 5,
      },
    },
    "hc-valid-1",
  );
  assert.equal(result.details.success, true, `refused: ${result.details.error}`);
  const applied = getConfig();
  assert.equal(applied.healthcheckMinScore, 90);
  assert.equal(applied.errorRateMax, 0.25);
  assert.equal(applied.toolSuccessMin, 80);
  assert.equal(applied.maxConsecutiveErrors, 5);
  assert.deepEqual(result.details.data.config, applied, "the tool reports the applied config");
});

await test("config with no patch reads the current config", async () => {
  const result = await run("config", {}, "hc-read-1");
  assert.equal(result.details.success, true);
  assert.deepEqual(result.details.data.config, getConfig());
});

await test("blank-filled benchmark numerics are refused", async () => {
  const result = await run(
    "benchmark",
    { benchmark: { passRate: 0, totalCases: 0, passedCases: 0, failedCases: [] } },
    "hc-bench-1",
  );
  assert.equal(result.details.success, false, "a 0% run is not recorded");
  assert.match(result.details.error, /benchmark\.passRate must be 1-100/);
  assert.equal(result.details.data, undefined, "no benchmark result is returned");
});

await test("the schema refuses blank benchmark numerics through the framework", async () => {
  let threw = null;
  try {
    frameworkArgs({ action: "benchmark", benchmark: { passRate: "", totalCases: "" } });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, "framework validation refuses the blank-filled benchmark");
  assert.match(threw.message, /passRate: must be >= 1/);
});

await test("a real benchmark still records (control)", async () => {
  const result = await run(
    "benchmark",
    { benchmark: { passRate: 75, totalCases: 12, passedCases: 9, failedCases: ["slow-path"] } },
    "hc-bench-2",
  );
  assert.equal(result.details.success, true, `refused: ${result.details.error}`);
  assert.equal(result.details.data.recorded.passRate, 75);
  assert.equal(result.details.data.recorded.totalCases, 12);
  assert.equal(result.details.data.recorded.passedCases, 9);
});

rmSync(FIXTURE_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
