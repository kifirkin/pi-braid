/**
 * Braid-home containment: the relocated state sinks resolve and write under
 * BRAID_HOME, and nothing here lands in the project.
 *
 * Contract pinned here:
 *   (a) the sinks that used to be hardcoded `~/.pi/agent/braid/<name>` literals
 *       (adherence, telemetry, tags, sessions) resolve under the pinned root,
 *       the module-overrides store and the offload root included;
 *   (b) with BRAID_HOME unset they resolve the default tree, unchanged;
 *   (c) each writer really writes there: an adherence report, a heartbeat line,
 *       a tag, a resume file;
 *   (d) the project directory the session runs in gains nothing - the same
 *       containment rule the loader store is pinned by;
 *   (e) every writer family that resolves a precomputed path constant refuses
 *       under `HOME=.` and `HOME=""` (nothing in the project, a loud refusal
 *       per family, and a warn — never a silent debug — for the refused tag
 *       write), driven in a child so the hostile HOME is real;
 *   (f) the same families follow an absolute BRAID_HOME pin: the file lands
 *       under the pin, the default tree under HOME and the project stay empty;
 *   (g) each live accessor equals its precomputed constant under a default
 *       home, so the two spellings of one layout cannot drift;
 *   (h) a relative or blank HOME refuses at braidDir(), not at the writer.
 *
 * Isolation: BRAID_HOME, pi's agent dir and the project dir are throwaway
 * temp dirs before any dist import, so the developer's live braid tree is
 * never written (and the one live-tree READ here - the scratchpad lookup the
 * shutdown handler does through the precomputed SCRATCHPAD_DIR - is scoped to
 * a slug no real project has).
 *
 * Run: node test/runtime/lib/test-braid-home-containment.mjs
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

// ── Isolation, before any dist import ──────────────────────────────────────
// HOME is pinned too, also before any dist import: a regression that resolves
// a state path through a module-load `os.homedir()` would otherwise write
// into the developer's live tree while this case fails, which makes the
// failure part of the damage.
process.env.HOME = mkdtempSync(join(tmpdir(), "braid-home-home-"));
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-home-contain-"));
const PROJECT = mkdtempSync(join(tmpdir(), "braid-home-project-"));
process.env.BRAID_HOME = BRAID_HOME;
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "braid-home-agent-"));

const paths = await import(join(ROOT, "dist", "lib", "config", "braid-paths.js"));
const { adherenceDir, writeAdherenceReport } = await import(
  join(ROOT, "dist", "lib", "enforcement", "adherence-meter.js")
);
const { contextHeartbeatFilePath, appendContextHeartbeatLine } = await import(
  join(ROOT, "dist", "lib", "telemetry", "context-heartbeat.js")
);
const { registerToolCallHandler } = await import(
  join(ROOT, "dist", "extensions", "enforcement", "handlers", "register-tool-call.js")
);
const { registerSessionShutdownResumption } = await import(
  join(ROOT, "dist", "extensions", "enforcement", "handlers", "register-session-shutdown-resumption.js")
);
const { getState } = await import(join(ROOT, "dist", "extensions", "enforcement", "state.js"));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [fail] ${name}: ${e.message}`);
  }
}

/** Relative file list under a root (sorted); [] when absent. */
function tree(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}${sep}${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), childRel);
      else out.push(childRel);
    }
  };
  walk(root, "");
  return out.sort();
}

function makeFakePi() {
  return {
    handlers: new Map(),
    on(event, handler) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    },
    sendMessage() {},
    sendUserMessage() {},
  };
}

function makeFakeCtx(pi, cwd) {
  const sessionId = `contain-${Math.random().toString(36).slice(2, 8)}`;
  const ctx = {
    __sessionId: sessionId,
    cwd,
    mode: "test",
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(tmpdir(), `${sessionId}.jsonl`),
      getBranch: () => [],
    },
    modelRegistry: {
      find: () => undefined,
      getAll: () => [],
      getApiKeyForProvider: async () => "",
      getAvailable: () => [],
    },
    ui: { notify: () => {}, setStatus: () => {} },
  };
  getState(ctx);
  return ctx;
}

function firstHandler(pi, event) {
  const list = pi.handlers.get(event) ?? [];
  assert.ok(list.length > 0, `${event} handler must be registered`);
  return list[0];
}

console.log("braid-home containment test\n");

await test("(a) the relocated sinks resolve under the pinned braid home", () => {
  const expected = {
    moduleStoreForCwd: join(BRAID_HOME, "projects"),
    offloadDir: join(BRAID_HOME, "offload"),
    adherence: join(BRAID_HOME, "adherence"),
    telemetry: join(BRAID_HOME, "telemetry"),
  };
  assert.equal(
    paths.getModuleOverridesFilePath(PROJECT).startsWith(expected.moduleStoreForCwd + sep),
    true,
    "the per-cwd store must live under the pinned projects/ tree",
  );
  assert.equal(paths.offloadDir(), expected.offloadDir);
  assert.throws(
    () => paths.getModuleOverridesFilePath(),
    /cwd/,
    "the store path requires a project cwd: a braid-root store has no writer",
  );
  assert.ok(
    paths.getOffloadFilePath("sess", "call", "bash").startsWith(expected.offloadDir + sep),
    "the flush path must live under the pinned offload root",
  );
  assert.equal(adherenceDir(), expected.adherence);
  assert.equal(contextHeartbeatFilePath(), join(expected.telemetry, "context-heartbeat.jsonl"));
});

await test("(b) with BRAID_HOME unset the sinks resolve the default tree, unchanged", () => {
  const pinned = process.env.BRAID_HOME;
  const defaultRoot = join(paths.AGENT, "braid");
  try {
    delete process.env.BRAID_HOME;
    assert.equal(paths.braidDir(), defaultRoot);
    assert.equal(paths.offloadDir(), join(defaultRoot, "offload"));
    assert.equal(adherenceDir(), join(defaultRoot, "adherence"));
    assert.equal(contextHeartbeatFilePath(), join(defaultRoot, "telemetry", "context-heartbeat.jsonl"));
  } finally {
    process.env.BRAID_HOME = pinned;
  }
});

await test("(c) an adherence report and a heartbeat line land under the pin", () => {
  const written = writeAdherenceReport({
    entries: [],
    sessionId: "containment-fixture",
    sessionFile: join(PROJECT, "session.jsonl"),
    cwd: PROJECT,
  });
  assert.equal(written.ok, true, `adherence write must succeed: ${written.error ?? ""}`);
  assert.ok(written.path.startsWith(adherenceDir() + sep), `report under the pin: ${written.path}`);

  assert.equal(appendContextHeartbeatLine({ ts: 1, source: "containment" }), true);
  assert.ok(existsSync(contextHeartbeatFilePath()), "heartbeat line must land at the pinned sink");
});

await test("(c) a tag and a resume file land under the pin", async () => {
  const pi = makeFakePi();
  registerToolCallHandler(pi);
  registerSessionShutdownResumption(pi);
  const ctx = makeFakeCtx(pi, PROJECT);

  await firstHandler(pi, "tool_call")(
    { toolName: "context_navigate", input: { action: "tag", name: "containment-probe" } },
    ctx,
  );
  const tagFiles = tree(join(BRAID_HOME, "tags"));
  assert.equal(tagFiles.length, 1, `exactly one tag file expected, got ${JSON.stringify(tagFiles)}`);
  assert.equal(
    tagFiles[0],
    `${paths.tagsSlugFromCwd(PROJECT)}.json`,
    "the tag file must carry the name the discoverability reader looks for",
  );
  assert.ok(
    Object.keys(
      JSON.parse(readFileSync(join(BRAID_HOME, "tags", tagFiles[0]), "utf-8")),
    ).includes("containment-probe"),
    "the tag must be readable back from the pinned tags file",
  );

  await firstHandler(pi, "session_shutdown")({}, ctx);
  const resumeFiles = tree(join(BRAID_HOME, "sessions"));
  assert.ok(
    resumeFiles.some((p) => p.endsWith(`${sep}resume.json`)),
    `resume.json must land under the pinned sessions tree, got ${JSON.stringify(resumeFiles)}`,
  );
});

await test("(d) the project the session ran in gained nothing", () => {
  assert.deepEqual(tree(PROJECT), [], "no sink may create a file in the project directory");
});

// ── The census families: one durable write each, three shapes ────────────────

const PROBE_CHILD = join(ROOT, "test", "helpers", "braid-writer-probe-child.mjs");
const DIST = join(ROOT, "dist");

/**
 * Drive every census writer family in a child process, with HOME and
 * BRAID_HOME as given. Returns the child's rows plus the trees the assertions
 * read. `fixtureRoot` is outside the project on purpose: the snapshot drive
 * needs one touched file and the project must stay empty.
 */
function runWriterProbe({ home, braidHome }) {
  const project = mkdtempSync(join(tmpdir(), "braid-writers-project-"));
  const fixtureRoot = mkdtempSync(join(tmpdir(), "braid-writers-fixture-"));
  const env = { ...process.env, HOME: home };
  if (braidHome === null) delete env.BRAID_HOME;
  else env.BRAID_HOME = braidHome;
  const r = spawnSync(process.execPath, [PROBE_CHILD, DIST, fixtureRoot], {
    cwd: project,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  const line = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  let rows;
  try {
    rows = JSON.parse(line ?? "").rows ?? [];
  } catch {
    rows = [];
  }
  return { status: r.status, stderr: r.stderr ?? "", rows, project, fixtureRoot };
}

/** Every family the census sweep closed must appear in the child's report. */
const CENSUS_FAMILIES = [
  "write-log",
  "episodes",
  "scratchpad",
  "semantic",
  "locks",
  "workers",
  "checkpoint",
  "errors",
  "evidence-pool",
  "degradation",
  "metrics",
  "hints",
  "snapshot",
  "skills-sessions",
  "skills-usage",
  "tags",
];

/** Where each family's file must land under a pinned root. */
const PINNED_PATHS = {
  "write-log": ["memory/write-log.jsonl"],
  episodes: ["memory/episodes.jsonl"],
  scratchpad: ["scratchpads/"],
  semantic: ["memory/semantic.json"],
  locks: ["projects/", "/locks.json"],
  workers: ["projects/", "/workers.json"],
  checkpoint: ["checkpoints/"],
  errors: ["errors/errors.jsonl"],
  "evidence-pool": ["evidence-pool.json"],
  degradation: ["metrics/degradation.json"],
  metrics: ["metrics/braid-metrics.jsonl"],
  hints: ["consolidated-hints.jsonl"],
  snapshot: ["snapshots/"],
  "skills-sessions": ["skills-sessions.jsonl"],
  "skills-usage": ["skills-usage.json"],
  tags: ["tags/"],
};

for (const hostileHome of [".", ""]) {
  await test(`(e) HOME=${JSON.stringify(hostileHome)}: every census writer refuses`, () => {
    const run = runWriterProbe({ home: hostileHome, braidHome: null });
    assert.equal(run.status, 0, `the child must exit 0, not crash: ${run.stderr}`);
    assert.equal(
      run.rows.length,
      CENSUS_FAMILIES.length,
      `every family must report: ${JSON.stringify(run.rows.map((r) => r.family))}`,
    );
    for (const row of run.rows) {
      assert.equal(
        row.refused,
        true,
        `${row.family}: the write must refuse loudly (threw=${row.threw}, level=${row.level})`,
      );
    }
    // A refused tag write must be visible at default verbosity: a debug-only
    // refusal never reaches the log buffer, so this pins the level, not the fact.
    const tags = run.rows.find((row) => row.family === "tags");
    assert.equal(
      tags?.level,
      "warn",
      `a refused tag write must warn, not go quiet (level=${tags?.level})`,
    );
    assert.deepEqual(
      tree(run.project),
      [],
      `no writer may create anything in the project: ${JSON.stringify(tree(run.project))}`,
    );
    assert.deepEqual(
      tree(run.fixtureRoot),
      tree(run.fixtureRoot).filter((f) => /^probe-[^/]+\/touched\.txt$/.test(f)),
      `no writer may create anything beside the fixture: ${JSON.stringify(tree(run.fixtureRoot))}`,
    );
    rmSync(run.project, { recursive: true, force: true });
    rmSync(run.fixtureRoot, { recursive: true, force: true });
  });
}

await test("(f) every census writer follows an absolute BRAID_HOME pin", () => {
  const pin = mkdtempSync(join(tmpdir(), "braid-writers-pin-"));
  const home = mkdtempSync(join(tmpdir(), "braid-writers-home-"));
  try {
    const run = runWriterProbe({ home, braidHome: pin });
    assert.equal(run.status, 0, `the child must exit 0: ${run.stderr}`);
    const files = tree(pin);
    for (const family of CENSUS_FAMILIES) {
      const needles = PINNED_PATHS[family];
      assert.ok(
        files.some((f) => needles.every((n) => f.includes(n))),
        `${family}: expected a file under the pin matching ${JSON.stringify(needles)}, got ${JSON.stringify(files)}`,
      );
    }
    assert.deepEqual(
      tree(join(home, ".pi", "agent", "braid")),
      [],
      "a pinned writer must not touch the default tree under HOME",
    );
    assert.deepEqual(tree(run.project), [], "a pinned writer must not touch the project");
    rmSync(run.project, { recursive: true, force: true });
    rmSync(run.fixtureRoot, { recursive: true, force: true });
  } finally {
    rmSync(pin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

await test("(g) every live accessor equals its precomputed constant by default", () => {
  const pinned = process.env.BRAID_HOME;
  try {
    delete process.env.BRAID_HOME;
    const pairs = [
      [paths.BRAID_DIR, paths.braidDir()],
      [paths.MEMORY_DIR, paths.memoryDir()],
      [paths.CHECKPOINT_DIR, paths.checkpointDir()],
      [paths.ERROR_DIR, paths.errorDir()],
      [paths.SCRATCHPAD_DIR, paths.scratchpadDir()],
      [paths.METRICS_DIR, paths.metricsDir()],
      [paths.SEMANTIC_MEMORY_FILE, paths.semanticMemoryFilePath()],
      [paths.EPISODES_FILE, paths.episodesFilePath()],
      [paths.WRITE_LOG_FILE, paths.writeLogFilePath()],
      [paths.ERROR_FILE, paths.errorsFilePath()],
      [paths.CONSOLIDATED_HINTS_FILE, paths.consolidatedHintsFilePath()],
      [paths.METRICS_FILE, paths.metricsFilePath()],
      [paths.DEGRADATION_FILE, paths.degradationFilePath()],
      [paths.EVIDENCE_POOL_FILE, paths.evidencePoolFilePath()],
      [paths.SKILLS_USAGE_FILE, paths.getSkillsUsageFilePath()],
      [paths.SKILLS_SESSIONS_FILE, paths.getSkillsSessionsFilePath()],
      [paths.BRAID_CONFIG_FILE, paths.getBraidConfigFilePath()],
      [paths.LOCK_FILE, paths.getLockFilePath()],
      [paths.WORKERS_FILE, paths.getWorkersFilePath()],
    ];
    for (const [constant, live] of pairs) {
      assert.equal(live, constant, `the live accessor must equal its constant: ${constant}`);
    }
  } finally {
    process.env.BRAID_HOME = pinned;
  }
});

await test("(h) a relative or blank HOME refuses at the base, not at the writer", () => {
  const pinnedHome = process.env.HOME;
  const pinnedBraid = process.env.BRAID_HOME;
  try {
    delete process.env.BRAID_HOME;
    for (const hostile of [".", ""]) {
      process.env.HOME = hostile;
      assert.throws(() => paths.braidDir(), /absolute/, `HOME=${JSON.stringify(hostile)}`);
      assert.throws(() => paths.writeLogFilePath(), /absolute/, "a family accessor refuses too");
      assert.throws(() => paths.getWorkersFilePath(), /absolute/, "the workers accessor refuses");
    }
  } finally {
    process.env.HOME = pinnedHome;
    process.env.BRAID_HOME = pinnedBraid;
  }
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
