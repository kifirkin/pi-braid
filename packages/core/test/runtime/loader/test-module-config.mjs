/**
 * Test: loader settings integrity - module resolution, runtime toggling, and
 * settings persistence.
 *
 * Verifies that the settings surface tells the truth and never destroys data:
 *   - a persisted `false` entry disables a default-enabled extension on boot
 *   - runtime overrides overlay the resolved base (settings additions and
 *     env-var enables survive an unrelated toggle; getModuleStates agrees
 *     with resolveEnabledExtensions in the same process)
 *   - toggle flips the effective state, not just the runtime map
 *   - persisted writes merge into the existing settings file (sibling keys
 *     and untouched module entries survive), create `.pi/` when missing,
 *     and refuse to overwrite an unreadable file
 *   - an unreadable settings file warns once per process instead of
 *     silently reverting every braid setting
 *   - /modules-reset clears the runtime layer without destroying persisted
 *     settings
 *
 * Each case runs in its own child process with a fake HOME and a throwaway
 * project dir: the loader resolves its settings paths from `homedir()` and
 * `process.cwd()` at module load, so isolation requires a fresh process with
 * a controlled environment (same shape as the audit's /tmp probes).
 *
 * The cases share nothing the others read - each child owns its HOME, its cwd
 * and its tmp dir - so they are driven a few at a time by the pool below.
 * What cost ~4s per case was the queue, not the isolation.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded } from "../../helpers/bounded-pool.mjs";

// Five cases at a time. Not more: a wider fan-out divides the machine between
// more children, and each child's wall time is what the cap below measures
// (on an 8-core box: five at a time puts a healthy driver at 6.4-7.1s at load
// 15 and at 9.5-11.3s at load 32; running all nine at once pushed each past
// 11s). Not fewer: nine cases in two waves is the minimum width.
const CASE_CONCURRENCY = 5;

// The cap is a hang detector, not a performance budget. A healthy driver's
// work is about 1.7s of CPU (one loader import); what makes a healthy driver
// slow is a busy box, and only a wedged one fails to finish at all. Sizing
// the cap near the loaded wall time of a healthy driver turns "the box is
// busy" into "the loader is broken": with this cap at 12s the file reported
// five of nine cases as `driver died on SIGKILL` at load 32 on an 8-core box,
// while the same drivers passed at load 9. 60s is over five times the highest
// loaded wall time measured here (11.3s), so the machine would have to be an
// order of magnitude busier to trip it, and a wedged driver still dies at the
// cap. The runner carries the matching allowance for this file (two waves of
// the worst case, see scripts/run-tests.mjs), so a stuck driver is reported
// here, by name, instead of becoming an opaque runner timeout.
const DRIVER_CAP_MS = 60_000;

const here = dirname(fileURLToPath(import.meta.url));
const LOADER_PATH = join(here, "..", "..", "..", "dist", "loader", "loader.js");
const LOGGER_PATH = join(here, "..", "..", "..", "dist", "lib", "core", "logger.js");
const BRAID_SETTINGS_PATH = join(here, "..", "..", "..", "dist", "lib", "config", "braid-settings.js");

// Scenario driver, materialized into each throwaway dir and run as a child.
// HOME is reassigned BEFORE the loader import: os.homedir() reads $HOME on
// POSIX, and the loader computes its settings paths at module load. Each
// scenario prints one JSON object of observations (no assertions here; the
// parent asserts so a driver bug cannot masquerade as a passed expectation).
const DRIVER = `
const scenario = process.argv[2];
process.env.HOME = process.env.FAKE_HOME;
const { readFileSync, existsSync } = await import("node:fs");
const { join } = await import("node:path");
const loader = await import(process.env.LOADER_PATH);
const { getLogBuffer } = await import(process.env.LOGGER_PATH);
const braidSettings = await import(process.env.BRAID_SETTINGS_PATH);
const warnCount = () => getLogBuffer().filter((e) => e.level === "warn").length;
const projectPath = () => join(process.cwd(), ".pi", "settings.json");
const readProject = () => { try { return JSON.parse(readFileSync(projectPath(), "utf-8")); } catch { return null; } };
const readProjectRaw = () => { try { return readFileSync(projectPath(), "utf-8"); } catch { return null; } };
const snap = () => {
  const r = loader.resolveEnabledExtensions();
  return {
    source: r.source,
    enforcement: r.enabled.includes("enforcement"),
    topicDrift: r.enabled.includes("topic-drift"),
    errorTracking: r.enabled.includes("error-tracking"),
    healthMaintenance: r.enabled.includes("health-maintenance"),
  };
};
const scenarios = {
  "settings-false-entry": () => ({ boot: snap() }),
  "runtime-branch": () => {
    const out = { boot: snap() };
    out.enableOptIn = loader.enableModule("health-maintenance");
    out.afterEnable = snap();
    out.disableDefault = loader.disableModule("topic-drift");
    out.afterDisable = snap();
    const states = loader.getModuleStates();
    out.stateErrorTracking = states["error-tracking"].enabled;
    out.stateHealthMaintenance = states["health-maintenance"].enabled;
    out.stateTopicDrift = states["topic-drift"].enabled;
    return out;
  },
  "toggle-default": () => {
    const out = { before: snap() };
    out.toggled = loader.toggleModule("topic-drift");
    out.after = snap();
    return out;
  },
  "env-precedence": () => {
    const out = { boot: snap() };
    loader.disableModule("topic-drift");
    out.after = snap();
    return out;
  },
  "merge-write": () => {
    const out = { disabled: loader.disableModule("topic-drift") };
    out.file = readProject();
    return out;
  },
  "mkdir-write": () => {
    const out = { piExistedBefore: existsSync(join(process.cwd(), ".pi")) };
    out.disabled = loader.disableModule("topic-drift");
    out.fileExistsAfter = existsSync(projectPath());
    out.file = readProject();
    return out;
  },
  "unreadable-warn": () => {
    // Per-source counts: the loader's import chain can fire the braid-settings
    // warning itself (top-level reader calls in extension modules), so only
    // per-reader counts are stable.
    const bySource = () => {
      const c = { modules: 0, "braid-settings": 0 };
      for (const e of getLogBuffer()) if (e.level === "warn" && e.source in c) c[e.source]++;
      return c;
    };
    const before = bySource();
    loader.resolveEnabledExtensions();
    const afterLoader = bySource();
    const nudgesDisabled = braidSettings.areCognitiveNudgesDisabled();
    const afterBraid = bySource();
    loader.resolveEnabledExtensions();
    braidSettings.areCognitiveNudgesDisabled();
    const final = bySource();
    return { before, afterLoader, nudgesDisabled, afterBraid, final };
  },
  "corrupt-write": () => {
    const out = { rawBefore: readProjectRaw() };
    out.disabled = loader.disableModule("topic-drift");
    out.rawAfter = readProjectRaw();
    out.warns = warnCount();
    return out;
  },
  "reset-preserves": () => {
    const out = { disabled: loader.disableModule("topic-drift") };
    loader.resetModuleOverrides();
    out.file = readProject();
    out.afterReset = snap();
    return out;
  },
};
if (!scenarios[scenario]) {
  console.error(JSON.stringify({ error: "unknown scenario", scenario }));
  process.exit(2);
}
console.log(JSON.stringify(scenarios[scenario]()));
`;

/**
 * A driver that outlived DRIVER_CAP_MS, as distinct from one that crashed.
 * The cap cannot tell a wedged driver from a starved one, so the parent says
 * which one it killed instead of dressing it up as a loader failure.
 */
class DriverTimeout extends Error {
  constructor(scenario, capMs, signal) {
    super(
      `driver ${scenario} was killed after the ${capMs}ms cap (${signal ?? "no signal"}) - it never finished, which is what the cap exists to catch`,
    );
    this.name = "DriverTimeout";
  }
}

/** Drive one child to completion; resolve with its exit status and output. */
function runDriver(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let capped = false;
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const cap = setTimeout(() => {
      capped = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const settle = (result) => {
      clearTimeout(cap);
      resolve({ stdout, stderr, ...result, capped });
    };
    child.on("close", (status, signal) => settle({ status, signal }));
    child.on("error", (error) => settle({ status: null, signal: null, error }));
  });
}

async function runScenario(scenario, { home, homeRaw, project, projectRaw, env = {} } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "loader-config-test-"));
  const homeDir = join(dir, "home");
  const projectDir = join(dir, "proj");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const driverPath = join(dir, "driver.mjs");
  writeFileSync(driverPath, DRIVER);
  if (home !== undefined || homeRaw !== undefined) {
    mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
    writeFileSync(join(homeDir, ".pi", "agent", "settings.json"), homeRaw ?? JSON.stringify(home));
  }
  if (project !== undefined) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(project));
  } else if (projectRaw !== undefined) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "settings.json"), projectRaw);
  }
  try {
    const childEnv = { ...process.env, ...env, FAKE_HOME: homeDir, LOADER_PATH, LOGGER_PATH, BRAID_SETTINGS_PATH };
    if (env.BRAID_MODULES === undefined) delete childEnv.BRAID_MODULES;
    const result = await runDriver([driverPath, scenario], {
      cwd: projectDir,
      env: childEnv,
      timeoutMs: DRIVER_CAP_MS,
    });
    // The cap firing is its own outcome; only what the cap did NOT cause is
    // reported as a driver failure.
    if (result.capped) throw new DriverTimeout(scenario, DRIVER_CAP_MS, result.signal);
    assert.equal(
      result.status,
      0,
      `driver ${result.status === null ? `died on ${result.signal ?? "an error"}` : `exited ${result.status}`}\nstderr: ${(result.stderr || "").slice(-800)}`,
    );
    const lines = (result.stdout || "").split("\n").filter((l) => l.trim());
    assert.ok(lines.length > 0, "driver printed no observation");
    return JSON.parse(lines[lines.length - 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

console.log("loader settings-integrity test\n");

test("a persisted false entry disables a default-enabled extension on boot", async () => {
  const obs = await runScenario("settings-false-entry", {
    home: { braid: { modules: { enforcement: false, "health-maintenance": true } } },
  });
  assert.equal(obs.boot.source, "settings-json");
  assert.equal(obs.boot.enforcement, false, "persisted false must disable a default-enabled extension");
  assert.equal(obs.boot.healthMaintenance, true);
  assert.equal(obs.boot.topicDrift, true, "defaults not mentioned in settings stay enabled");
});

test("runtime overrides overlay the resolved base (settings additions and opt-in enables survive)", async () => {
  const obs = await runScenario("runtime-branch", {
    project: { braid: { modules: { "error-tracking": true } } },
  });
  assert.equal(obs.boot.source, "settings-json");
  assert.equal(obs.boot.errorTracking, true);
  assert.equal(obs.enableOptIn, true);
  assert.equal(obs.afterEnable.source, "runtime-api");
  assert.equal(obs.afterEnable.healthMaintenance, true, "runtime enable of an opt-in id must appear in the resolver");
  assert.equal(obs.afterEnable.errorTracking, true, "settings additions must survive an unrelated runtime override");
  assert.equal(obs.disableDefault, true);
  assert.equal(obs.afterDisable.topicDrift, false);
  assert.equal(obs.afterDisable.errorTracking, true, "settings additions must survive a runtime disable of another id");
  assert.equal(obs.stateHealthMaintenance, obs.afterEnable.healthMaintenance, "getModuleStates must agree with the resolver");
  assert.equal(obs.stateErrorTracking, obs.afterDisable.errorTracking, "getModuleStates must agree with the resolver");
  assert.equal(obs.stateTopicDrift, obs.afterDisable.topicDrift, "getModuleStates must agree with the resolver");
});

test("toggle flips the effective state of a default-enabled extension", async () => {
  const obs = await runScenario("toggle-default");
  assert.equal(obs.before.topicDrift, true);
  assert.equal(obs.before.source, "defaults");
  assert.equal(obs.toggled, false, "toggling an enabled extension must turn it OFF");
  assert.equal(obs.after.topicDrift, false);
});

test("BRAID_MODULES resolution survives a runtime override", async () => {
  const obs = await runScenario("env-precedence", { env: { BRAID_MODULES: "+health-maintenance" } });
  assert.equal(obs.boot.source, "env-var");
  assert.equal(obs.boot.healthMaintenance, true, "env enable of an opt-in id must appear in the resolver");
  assert.equal(obs.after.source, "runtime-api");
  assert.equal(obs.after.healthMaintenance, true, "env-resolved base must survive an unrelated runtime disable");
  assert.equal(obs.after.topicDrift, false);
});

test("a persisted write merges: sibling keys and untouched module entries survive", async () => {
  const obs = await runScenario("merge-write", {
    project: {
      braid: { telegram: { maxChars: 2000 }, modules: { "error-tracking": true } },
      unrelated: { keep: true },
    },
  });
  assert.equal(obs.disabled, true);
  assert.deepEqual(obs.file.unrelated, { keep: true }, "top-level siblings must survive a module write");
  assert.deepEqual(obs.file.braid.telegram, { maxChars: 2000 }, "braid siblings must survive a module write");
  assert.equal(obs.file.braid.modules["error-tracking"], true, "untouched module entries must survive a module write");
  assert.equal(obs.file.braid.modules["topic-drift"], false);
});

test("a persisted write creates the .pi directory when missing", async () => {
  const obs = await runScenario("mkdir-write");
  assert.equal(obs.piExistedBefore, false);
  assert.equal(obs.disabled, true);
  assert.equal(obs.fileExistsAfter, true, "the write must create .pi/ instead of failing silently");
  assert.equal(obs.file.braid.modules["topic-drift"], false);
});

test("an unreadable settings file warns once per process, not silently", async () => {
  // Corrupt GLOBAL file: both the loader reader and the braid-settings
  // reader hit it; each warns on its first read and never again.
  const obs = await runScenario("unreadable-warn", { homeRaw: "{ not json" });
  assert.equal(obs.before.modules, 0, "no loader settings reads happen before the first resolve");
  assert.equal(obs.afterLoader.modules, 1, "loader must warn exactly once on the first unreadable read");
  assert.ok(obs.afterBraid["braid-settings"] >= 1, "braid-settings reader must warn on an unreadable file");
  assert.equal(obs.final.modules, obs.afterLoader.modules, "a second loader read must not warn again (once per process)");
  assert.equal(obs.final["braid-settings"], obs.afterBraid["braid-settings"], "a second braid-settings read must not warn again (once per process)");
});

test("a toggle never overwrites an unreadable project settings file", async () => {
  const corrupt = "{ not json";
  const obs = await runScenario("corrupt-write", { projectRaw: corrupt });
  assert.equal(obs.rawBefore, corrupt);
  assert.equal(obs.rawAfter, corrupt, "an unreadable file must be left untouched, not overwritten");
  assert.ok(obs.warns >= 1, "the refusal must be visible in the log");
});

test("reset clears the runtime layer without destroying persisted settings", async () => {
  const obs = await runScenario("reset-preserves", {
    project: { braid: { modules: { "error-tracking": true } } },
  });
  assert.equal(obs.disabled, true);
  assert.equal(obs.file.braid.modules["error-tracking"], true, "reset must not destroy persisted module entries");
  assert.equal(obs.file.braid.modules["topic-drift"], false);
  assert.equal(obs.afterReset.source, "settings-json", "persisted settings keep applying after a reset");
  assert.equal(obs.afterReset.errorTracking, true);
  assert.equal(obs.afterReset.topicDrift, false);
});

// Registration order decides the report order; completion order is the pool's
// business, and each case's own assertions run in this process.
const results = await runBounded(
  cases.map((c) => c.fn),
  CASE_CONCURRENCY,
);

let passed = 0;
let failed = 0;
let timedOut = 0;
for (const [index, result] of results.entries()) {
  if (result.status === "fulfilled") {
    passed++;
    console.log(`  [ok] ${cases[index].name}`);
  } else if (result.reason instanceof DriverTimeout) {
    timedOut++;
    console.log(`  [timeout] ${cases[index].name}: ${result.reason.message}`);
  } else {
    failed++;
    console.log(`  [fail] ${cases[index].name}: ${result.reason?.message ?? result.reason}`);
  }
}

// Three categories for the same reason the runner reports three: a wedged
// driver and a wrong answer call for different reactions. Both still exit
// non-zero, so a hang stops the suite exactly as a failure does.
console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${timedOut} timed out`);
if (failed > 0 || timedOut > 0) process.exit(1);
