/**
 * Test: loader settings integrity - module resolution, runtime toggling, and
 * settings persistence.
 *
 * Verifies that the settings surface tells the truth and never destroys data:
 *   - a persisted `false` entry disables a default-enabled extension on boot
 *   - the read order is pi global -> pi project (read-only compatibility) ->
 *     braid's module-overrides store, later source wins per id
 *   - runtime overrides overlay the resolved base (settings additions and
 *     env-var enables survive an unrelated toggle; getModuleStates agrees
 *     with resolveEnabledExtensions in the same process)
 *   - toggle flips the effective state, not just the runtime map
 *   - a persisted write merges into the store (sibling keys and untouched
 *     module entries survive), creates the store directory when missing, and
 *     refuses to overwrite an unreadable store
 *   - an unreadable settings file warns once per process instead of
 *     silently reverting every braid setting
 *   - /modules-reset clears the runtime layer without destroying persisted
 *     settings
 *   - containment: a module write lands in the braid tree (BRAID_HOME) and
 *     the project directory gains nothing - no `.pi/`, no file, ever
 *   - a project-scoped `braid.modules` block is not a source: pi owns that
 *     file and its trust gate, so the read order is the agent-directory
 *     settings file and braid's store only
 *   - the reported `source` names the store when a stored value decided
 *   - a non-absolute HOME refuses the store: the toggle still applies in
 *     memory, the refusal warns, and nothing lands in the project
 *   - a crashed write's stale temp is collected on the next write; a live
 *     writer's temp survives the sweep
 *
 * Each case runs in its own child process with a fake HOME, a pinned
 * BRAID_HOME and a throwaway project dir: the loader resolves its settings
 * paths from `homedir()` and `process.cwd()` at module load, so isolation
 * requires a fresh process with a controlled environment, the same
 * child-process shape the loader's own tests use.
 *
 * The cases share nothing the others read - each child owns its HOME, its
 * BRAID_HOME, its cwd and its tmp dir - so they are driven a few at a time by
 * the pool below. What cost ~4s per case was the queue, not the isolation.
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
// 11s). Not fewer: the cases in two waves is the minimum width.
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
// cap. The runner carries the matching allowance for this file (three waves of
// the worst case, see scripts/run-tests.mjs), so a stuck driver is reported
// here, by name, instead of becoming an opaque runner timeout.
const DRIVER_CAP_MS = 60_000;

const here = dirname(fileURLToPath(import.meta.url));
const LOADER_PATH = join(here, "..", "..", "..", "dist", "loader", "loader.js");
const LOGGER_PATH = join(here, "..", "..", "..", "dist", "lib", "core", "logger.js");
const BRAID_SETTINGS_PATH = join(here, "..", "..", "..", "dist", "lib", "config", "braid-settings.js");
const BRAID_PATHS_PATH = join(here, "..", "..", "..", "dist", "lib", "config", "braid-paths.js");

// Scenario driver, materialized into each throwaway dir and run as a child.
// HOME is reassigned BEFORE the loader import: os.homedir() reads $HOME on
// POSIX, and the loader computes its settings paths at module load. The store
// is discovered by walking BRAID_HOME, never by re-deriving its path here:
// containment is then asserted against the pinned tree itself. Each scenario
// prints one JSON object of observations (no assertions here; the parent
// asserts so a driver bug cannot masquerade as a passed expectation).
const DRIVER = `
const scenario = process.argv[2];
process.env.HOME = process.env.DRIVER_HOME !== undefined ? process.env.DRIVER_HOME : process.env.FAKE_HOME;
const { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, utimesSync } = await import("node:fs");
const { dirname, join } = await import("node:path");
const loader = await import(process.env.LOADER_PATH);
const { getLogBuffer } = await import(process.env.LOGGER_PATH);
const braidSettings = await import(process.env.BRAID_SETTINGS_PATH);
const braidPaths = await import(process.env.BRAID_PATHS_PATH);
const warnCount = () => getLogBuffer().filter((e) => e.level === "warn").length;
const projectPath = () => join(process.cwd(), ".pi", "settings.json");
const readProjectRaw = () => { try { return readFileSync(projectPath(), "utf-8"); } catch { return null; } };
const BRAID = process.env.BRAID_HOME;
/** Relative paths of every file under a root (sorted); [] when absent. */
const tree = (root) => {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), childRel);
      else out.push(childRel);
    }
  };
  walk(root, "");
  return out.sort();
};
const storeFiles = () => tree(BRAID).filter((p) => p.endsWith("module-overrides.json"));
const readStore = () => {
  const hits = storeFiles();
  if (hits.length !== 1) return { files: hits, doc: null, raw: null };
  let raw = null;
  try { raw = readFileSync(join(BRAID, hits[0]), "utf-8"); } catch { /* absent */ }
  let doc = null;
  try { doc = JSON.parse(raw); } catch { /* corrupt fixture */ }
  return { files: hits, doc, raw };
};
/** Seed the store before the loader reads it (fixture, via the package's own
 *  accessor: containment is asserted against the BRAID_HOME walk instead). */
const seedStore = (content) => {
  const path = braidPaths.getModuleOverridesFilePath(process.cwd());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf-8");
  return path;
};
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
  "settings-false-entry": () => ({ boot: snap(), projectTree: tree(process.cwd()) }),
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
    out.store = readStore();
    out.projectTree = tree(process.cwd());
    return out;
  },
  "toggle-default": () => {
    const out = { before: snap() };
    out.toggled = loader.toggleModule("topic-drift");
    out.after = snap();
    out.store = readStore();
    out.projectTree = tree(process.cwd());
    return out;
  },
  "env-precedence": () => {
    const out = { boot: snap() };
    loader.disableModule("topic-drift");
    out.after = snap();
    return out;
  },
  "precedence-three-sources": () => {
    // Store seeded with a value that contradicts the project file for the same
    // id, and with an id no other source names.
    seedStore({
      braid: { modules: { "topic-drift": true, "error-tracking": true }, telegram: { maxChars: 2000 } },
      unrelated: { keep: true },
    });
    const out = { boot: snap() };
    // A toggle persists into the same store: its value must beat both settings
    // files on the next resolve, and the seeded siblings must survive it.
    out.disabled = loader.disableModule("error-tracking");
    out.afterToggle = snap();
    out.store = readStore();
    out.projectTree = tree(process.cwd());
    return out;
  },
  "merge-write": () => {
    seedStore({
      braid: { modules: { "error-tracking": true }, telegram: { maxChars: 2000 } },
      unrelated: { keep: true },
    });
    const out = { disabled: loader.disableModule("topic-drift") };
    out.store = readStore();
    out.projectTree = tree(process.cwd());
    return out;
  },
  "mkdir-write": () => {
    const out = { piExistedBefore: existsSync(join(process.cwd(), ".pi")) };
    out.braidExistedBefore = existsSync(BRAID);
    out.disabled = loader.disableModule("topic-drift");
    out.store = readStore();
    out.projectTree = tree(process.cwd());
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
    const path = seedStore("{ this store is not json");
    const out = { rawBefore: readStore().raw };
    out.seededAt = path;
    out.disabled = loader.disableModule("topic-drift");
    out.store = readStore();
    out.warns = warnCount();
    return out;
  },
  "reset-preserves": () => {
    seedStore({ braid: { modules: { "error-tracking": true } } });
    const out = { disabled: loader.disableModule("topic-drift") };
    loader.resetModuleOverrides();
    out.store = readStore();
    out.afterReset = snap();
    return out;
  },
  "hostile-home": () => {
    // HOME is the relative or blank spelling DRIVER_HOME named (the driver
    // applied it before the loader import) and BRAID_HOME is unset: the store
    // path must refuse, not resolve under the cwd. The toggle still applies in
    // memory for this process.
    delete process.env.BRAID_HOME;
    const out = { disabled: loader.disableModule("topic-drift") };
    out.store = readStore();
    out.warns = getLogBuffer()
      .filter((e) => e.level === "warn")
      .map((e) => e.message);
    out.projectTree = tree(process.cwd());
    return out;
  },
  "stale-temp-sweep": () => {
    // A crashed earlier write left its temp behind (old mtime); a live
    // writer's temp is current. Only the first may be collected.
    const store = braidPaths.getModuleOverridesFilePath(process.cwd());
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, JSON.stringify({ braid: { modules: {} } }), "utf-8");
    const stale = store + ".tmp.4242";
    writeFileSync(stale, "crashed write", "utf-8");
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    const live = store + ".tmp.31337";
    writeFileSync(live, "a live writer", "utf-8");
    const out = { disabled: loader.disableModule("topic-drift") };
    out.storeDirFiles = tree(dirname(store));
    out.staleSurvives = existsSync(stale);
    out.liveSurvives = existsSync(live);
    out.store = readStore();
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
  const braidHome = join(dir, "braid");
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
    const childEnv = {
      ...process.env,
      ...env,
      FAKE_HOME: homeDir,
      BRAID_HOME: braidHome,
      LOADER_PATH,
      LOGGER_PATH,
      BRAID_SETTINGS_PATH,
      BRAID_PATHS_PATH,
    };
    // `BRAID_HOME: null` in `env` asks for an unset override: a scenario that
    // drives a non-absolute HOME needs no pin to fall back to.
    if (env.BRAID_HOME === null) delete childEnv.BRAID_HOME;
    delete childEnv.BRAID_MODULES;
    if (env.BRAID_MODULES !== undefined) childEnv.BRAID_MODULES = env.BRAID_MODULES;
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

/**
 * The containment rule, asserted for every scenario: the project directory is
 * exactly what the fixture put there (a `.pi/settings.json` fixture, or
 * nothing), and every file the loader wrote is under the pinned braid tree.
 */
function assertProjectUntouched(obs, projectFixture) {
  const expected = projectFixture ? [".pi/settings.json"] : [];
  assert.deepEqual(
    obs.projectTree,
    expected,
    "a module toggle must not create anything in the project (no .pi/, no settings.json)",
  );
}

/** One store file, under the pinned tree, carrying a `braid.modules` block. */
function assertStoreShape(store) {
  assert.equal(store.files.length, 1, `exactly one module-overrides store expected, got ${JSON.stringify(store.files)}`);
  assert.ok(
    store.files[0].startsWith("projects/") || store.files[0] === "module-overrides.json",
    `the store must live under the pinned braid tree, got ${store.files[0]}`,
  );
  assert.equal(typeof store.doc?.braid?.modules, "object", "the store must carry a braid.modules block");
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
    home: { braid: { modules: { "error-tracking": true } } },
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
  // The toggle that persisted during this run went to the store, not to the
  // agent-directory settings file the same run read its settings from.
  assertStoreShape(obs.store);
  assertProjectUntouched(obs, false);
});

test("toggle flips the effective state of a default-enabled extension", async () => {
  const obs = await runScenario("toggle-default");
  assert.equal(obs.before.topicDrift, true);
  assert.equal(obs.before.source, "defaults");
  assert.equal(obs.toggled, false, "toggling an enabled extension must turn it OFF");
  assert.equal(obs.after.topicDrift, false);
  assertStoreShape(obs.store);
  assert.equal(obs.store.doc.braid.modules["topic-drift"], false, "the toggle must be readable back from the store");
  assertProjectUntouched(obs, false);
});

test("BRAID_MODULES resolution survives a runtime override", async () => {
  const obs = await runScenario("env-precedence", { env: { BRAID_MODULES: "+health-maintenance" } });
  assert.equal(obs.boot.source, "env-var");
  assert.equal(obs.boot.healthMaintenance, true, "env enable of an opt-in id must appear in the resolver");
  assert.equal(obs.after.source, "runtime-api");
  assert.equal(obs.after.healthMaintenance, true, "env-resolved base must survive an unrelated runtime disable");
  assert.equal(obs.after.topicDrift, false);
});

test("the read order is the settings file, then the store; a project block is ignored", async () => {
  const obs = await runScenario("precedence-three-sources", {
    home: { braid: { modules: { enforcement: false, "health-maintenance": true } } },
    project: { braid: { modules: { enforcement: true, "topic-drift": false } } },
  });
  // The project file says enforcement: true. It is pi's artifact, behind pi's
  // trust gate, and pi's answer is not available while extensions load: braid
  // does not read it, so the settings-file value stands.
  assert.equal(obs.boot.enforcement, false, "the project file must not decide a module state");
  assert.equal(obs.boot.healthMaintenance, true, "a settings-file entry must still apply");
  assert.equal(obs.boot.topicDrift, true, "the store must win over the project file for the same id");
  assert.equal(obs.boot.errorTracking, true, "a store-only entry must apply");
  assert.equal(obs.boot.source, "store", "the store decided the effective values, so it is named");
  assert.equal(obs.disabled, true);
  assert.equal(obs.afterToggle.errorTracking, false, "a persisted toggle must win over the store's own earlier value");
  assert.equal(obs.afterToggle.topicDrift, true, "an id the toggle run did not touch keeps its stored value");
  assertStoreShape(obs.store);
  assert.equal(obs.store.doc.braid.modules["topic-drift"], true, "the seeded store entry must survive the write");
  assert.equal(obs.store.doc.braid.modules["error-tracking"], false);
  assert.deepEqual(obs.store.doc.braid.telegram, { maxChars: 2000 }, "braid siblings must survive a module write");
  assert.deepEqual(obs.store.doc.unrelated, { keep: true }, "top-level siblings must survive a module write");
  assertProjectUntouched(obs, true);
});

test("a persisted write merges: sibling keys and untouched module entries survive", async () => {
  const obs = await runScenario("merge-write", {
    project: { braid: { telegram: { maxChars: 3000 }, modules: { "error-tracking": true } } },
  });
  assert.equal(obs.disabled, true);
  assertStoreShape(obs.store);
  assert.equal(obs.store.doc.braid.modules["error-tracking"], true, "untouched module entries must survive a module write");
  assert.equal(obs.store.doc.braid.modules["topic-drift"], false);
  assert.deepEqual(obs.store.doc.braid.telegram, { maxChars: 2000 }, "store siblings must survive a module write");
  assert.deepEqual(obs.store.doc.unrelated, { keep: true }, "top-level siblings must survive a module write");
  assertProjectUntouched(obs, true);
});

test("a persisted write creates the store directory and never .pi in the project", async () => {
  const obs = await runScenario("mkdir-write");
  assert.equal(obs.piExistedBefore, false);
  assert.equal(obs.braidExistedBefore, false, "the fixture leaves the pinned braid tree absent");
  assert.equal(obs.disabled, true);
  assertStoreShape(obs.store);
  assert.equal(obs.store.doc.braid.modules["topic-drift"], false);
  assertProjectUntouched(obs, false);
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

test("a toggle never overwrites an unreadable store", async () => {
  const obs = await runScenario("corrupt-write");
  assert.equal(obs.rawBefore, "{ this store is not json");
  assert.equal(obs.store.raw, obs.rawBefore, "an unreadable store must be left untouched, not overwritten");
  assert.ok(obs.warns >= 1, "the refusal must be visible in the log");
});

test("reset clears the runtime layer without destroying persisted settings", async () => {
  const obs = await runScenario("reset-preserves", {
    project: { braid: { modules: { "error-tracking": true } } },
  });
  assert.equal(obs.disabled, true);
  assertStoreShape(obs.store);
  assert.equal(obs.store.doc.braid.modules["error-tracking"], true, "reset must not destroy persisted module entries");
  assert.equal(obs.store.doc.braid.modules["topic-drift"], false);
  assert.equal(obs.afterReset.source, "store", "the store keeps applying after a reset, and is named");
  assert.equal(obs.afterReset.errorTracking, true);
  assert.equal(obs.afterReset.topicDrift, false);
});

test("a non-absolute HOME refuses the store instead of writing into the project", async () => {
  for (const homeValue of [".", ""]) {
    const obs = await runScenario("hostile-home", {
      env: { DRIVER_HOME: homeValue, BRAID_HOME: null },
    });
    const where = `HOME=${JSON.stringify(homeValue)}`;
    assert.equal(obs.disabled, true, `${where}: the in-memory toggle still applies`);
    assert.deepEqual(obs.store.files, [], `${where}: no store file may be written`);
    assert.deepEqual(obs.projectTree, [], `${where}: the project must gain nothing`);
    assert.ok(
      obs.warns.some((m) => /store path/.test(m)),
      `${where}: the refusal must be visible in the log: ${JSON.stringify(obs.warns)}`,
    );
  }
});

test("a crashed write's stale temp is collected; a live writer's temp survives", async () => {
  const obs = await runScenario("stale-temp-sweep");
  assert.equal(obs.disabled, true);
  assert.equal(obs.staleSurvives, false, "a temp older than a day is a crash leftover");
  assert.equal(obs.liveSurvives, true, "a concurrent writer's temp must not be swept");
  assert.ok(
    !obs.storeDirFiles.some((f) => f.endsWith(".tmp.4242")),
    `the stale temp must be gone: ${JSON.stringify(obs.storeDirFiles)}`,
  );
  assertStoreShape(obs.store);
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
