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
 *   (h) a relative or blank HOME refuses at braidDir(), not at the writer;
 *   (i) the two store locks resolve under the pin and keep the store's
 *       `<file>.lock` name rule, so a lock that falls back to a folded
 *       constant (or drifts its suffix) is caught;
 *   (j) the five per-project stores share one projects leg and keep their
 *       file names, so a filename drift in any of them is caught even though
 *       the census writers drive only three of the five;
 *   (k) the resumption reader builds its prior-state section from the pinned
 *       scratchpad tree: two goals are planted, one per tree, and the resume
 *       must carry the pinned one;
 *   (l) the prompt's memory pointer lines resolve the live store paths, and
 *       name no path at all when no absolute root resolves;
 *   (m) the legacy-memory migration source follows the live root: a pinned
 *       run does not import a pre-braid store left under the default tree.
 *
 * Bound: the tree assertions below are a FINAL-STATE snapshot. A directory
 * created and removed between samples, a write outside the checked roots (a
 * sibling of the project dir), and a write through a pre-existing symlink are
 * all invisible to them; a created symlink is visible (the entry is collected
 * regardless of its type). The runtime containment legs and the source-level
 * write gate are the nets for those shapes.
 *
 * Isolation: BRAID_HOME, pi's agent dir and the project dir are throwaway
 * temp dirs before any dist import, so the developer's live braid tree is
 * never read or written. The one case that plants state in the default tree
 * writes a competing scratchpad goal under the throwaway HOME's tree, never
 * the real one.
 *
 * Run: node test/runtime/lib/test-braid-home-containment.mjs
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
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
const { episodesLockFilePath } = await import(
  join(ROOT, "dist", "extensions", "memory", "three-memory-stores", "episodes-disk.js")
);
const { semanticStoreLockFilePath } = await import(
  join(ROOT, "dist", "lib", "memory", "storage.js")
);
const { projectSlugFromCwd } = await import(
  join(ROOT, "dist", "extensions", "memory", "scratchpad", "persistence.js")
);
const { reconstructMemorySection } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "memory-section.js")
);
const {
  default: threeMemoryStoresExtension,
  getState: memoryStoresState,
} = await import(join(ROOT, "dist", "extensions", "memory", "three-memory-stores", "index.js"));

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

/** Relative entry list under a root (files and directories, sorted); [] when
 *  absent. Directories carry no trailing separator, so a refused writer's
 *  `mkdir` shows up in the same list a file write would. */
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
      out.push(childRel);
      if (e.isDirectory()) walk(join(dir, e.name), childRel);
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

await test("(k) the resume payload carries the pinned scratchpad's goal", async () => {
  // One goal per tree: the reader must build its prior-state section from the
  // tree the scratchpad writer wrote to, so the default tree's copy - the one
  // a folded constant resolves - must never reach the resume.
  const pi = makeFakePi();
  registerSessionShutdownResumption(pi);
  const ctx = makeFakeCtx(pi, PROJECT);
  const slug = projectSlugFromCwd(PROJECT);
  for (const [root, goal] of [
    [join(paths.AGENT, "braid"), "DEFAULT-TREE-GOAL"],
    [BRAID_HOME, "PIN-TREE-GOAL"],
  ]) {
    mkdirSync(join(root, "scratchpads", slug), { recursive: true });
    writeFileSync(
      join(root, "scratchpads", slug, "latest.json"),
      JSON.stringify({ goal, plans: [] }),
    );
  }

  await firstHandler(pi, "session_shutdown")({}, ctx);
  const resume = JSON.parse(
    readFileSync(join(BRAID_HOME, "sessions", slug, "resume.json"), "utf-8"),
  );
  assert.equal(
    resume.goal,
    "PIN-TREE-GOAL",
    "the resumed goal must come from the pinned scratchpad tree",
  );
});

await test("(d) the project the session ran in gained nothing", () => {
  assert.deepEqual(
    tree(PROJECT),
    [],
    "no sink may create a file or directory in the project directory",
  );
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
  let unhandled;
  try {
    const parsed = JSON.parse(line ?? "");
    rows = parsed.rows ?? [];
    unhandled = parsed.unhandled ?? [];
  } catch {
    rows = [];
    unhandled = [];
  }
  return { status: r.status, stderr: r.stderr ?? "", rows, unhandled, project, fixtureRoot };
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
    // The tool_error entry point must report its refusal at warn too - the
    // dropped-promise path left no log line at all.
    const errors = run.rows.find((row) => row.family === "errors");
    assert.equal(
      errors?.level,
      "warn",
      `a refused tool_error capture must warn, not go unreported (level=${errors?.level})`,
    );
    // No listener may leave a rejection undrained: Node's default for an
    // unhandled rejection is to throw, so this is the crash the bus path must
    // not arm. The child collects and reports them.
    assert.deepEqual(
      run.unhandled,
      [],
      `no listener may leave a rejected promise undrained: ${JSON.stringify(run.unhandled)}`,
    );
    assert.deepEqual(
      tree(run.project),
      [],
      `no writer may create a file or directory in the project: ${JSON.stringify(tree(run.project))}`,
    );
    const stray = tree(run.fixtureRoot).filter(
      (f) => !/^probe-[^/]+$/.test(f) && !/^probe-[^/]+\/touched\.txt$/.test(f),
    );
    assert.deepEqual(
      stray,
      [],
      `no writer may create anything beside the fixture: ${JSON.stringify(stray)}`,
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
    assert.deepEqual(
      run.unhandled,
      [],
      `a pinned run must drain every listener rejection: ${JSON.stringify(run.unhandled)}`,
    );
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
      [paths.OFFLOAD_DIR, paths.offloadDir()],
      [paths.PENDING_TIMERS_FILE, paths.getTimerFilePath()],
      [paths.TELEMETRY_DIR, paths.telemetryDir()],
      [paths.HEALTHCHECK_DIR, paths.healthcheckDir()],
      [paths.LEGACY_MEMORY_FILE, paths.legacyMemoryFilePath()],
      [paths.SHOWN_SIGNALS_FILE, paths.shownSignalsFilePath()],
      [paths.LOCK_FILE, paths.getLockFilePath()],
      [paths.WORKERS_FILE, paths.getWorkersFilePath()],
      // The store locks have no constant of their own: their precomputed
      // spelling is the store constant plus `.lock`.
      [`${paths.EPISODES_FILE}.lock`, episodesLockFilePath()],
      [`${paths.SEMANTIC_MEMORY_FILE}.lock`, semanticStoreLockFilePath()],
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

await test("(i) the store locks follow the pin and keep their file-name rule", () => {
  // With BRAID_HOME pinned, a lock that fell back to a folded constant (the
  // regression) resolves the default tree while the live store resolves the
  // pin, so the pinned equality fails; a `.lock` suffix drift fails it too.
  assert.equal(
    episodesLockFilePath(),
    `${paths.episodesFilePath()}.lock`,
    "the episodes lock must be named beside the live episodes store",
  );
  assert.equal(
    semanticStoreLockFilePath(),
    `${paths.semanticMemoryFilePath()}.lock`,
    "the semantic lock must be named beside the live semantic store",
  );
  assert.ok(
    episodesLockFilePath().startsWith(BRAID_HOME + sep),
    `the episodes lock must resolve under the pin: ${episodesLockFilePath()}`,
  );
  assert.ok(
    semanticStoreLockFilePath().startsWith(BRAID_HOME + sep),
    `the semantic lock must resolve under the pin: ${semanticStoreLockFilePath()}`,
  );
});

await test("(j) the per-project stores share one leg and keep their file names", () => {
  // Only locks, workers and timers are driven by the census probe, so the
  // other two stores' file names and the shared projects leg are pinned here;
  // a `projectsDir()` change moves all five and is caught by (f) through the
  // driven families.
  const expected = [
    ["locks.json", paths.getLockFilePath(PROJECT)],
    ["workers.json", paths.getWorkersFilePath(PROJECT)],
    ["pending-timers.jsonl", paths.getTimerFilePath(PROJECT)],
    ["module-overrides.json", paths.getModuleOverridesFilePath(PROJECT)],
    ["deliverables.jsonl", paths.getDeliverablesFilePath(PROJECT)],
  ];
  for (const [name, file] of expected) {
    assert.equal(basename(file), name, `the per-project store keeps its file name: ${file}`);
    assert.ok(
      file.startsWith(paths.projectsDir() + sep),
      `the per-project store shares the projects leg: ${file}`,
    );
  }
});

await test("(l) the prompt pointer lines resolve live and degrade on a refused root", async () => {
  const pinnedBlock = await reconstructMemorySection(makeFakeCtx(makeFakePi(), PROJECT));
  assert.ok(
    pinnedBlock.includes(paths.episodesFilePath()),
    `the episodes pointer must name the pinned store: ${pinnedBlock}`,
  );
  assert.ok(
    pinnedBlock.includes(paths.semanticMemoryFilePath()),
    `the semantic pointer must name the pinned store: ${pinnedBlock}`,
  );
  assert.ok(
    !pinnedBlock.includes(paths.EPISODES_FILE),
    `the pointer must not name the folded default spelling: ${pinnedBlock}`,
  );

  const savedHome = process.env.HOME;
  const savedPin = process.env.BRAID_HOME;
  try {
    delete process.env.BRAID_HOME;
    process.env.HOME = ".";
    const hostileBlock = await reconstructMemorySection(makeFakeCtx(makeFakePi(), PROJECT));
    assert.match(hostileBlock, /episodes/, `the store concepts still render: ${hostileBlock}`);
    assert.match(hostileBlock, /semantic/, `the store concepts still render: ${hostileBlock}`);
    assert.equal(
      /(?:episodes|semantic) at [^(\s]/.test(hostileBlock),
      false,
      `a refused root must name no store path: ${hostileBlock}`,
    );
  } finally {
    process.env.HOME = savedHome;
    process.env.BRAID_HOME = savedPin;
  }
});

await test("(m) the legacy migration source follows the live root", async () => {
  // The pre-braid store is planted in the shape the old layout used, under
  // the default tree's home. A pinned run reads its own predecessor, so the
  // planted store must not be imported.
  const project = mkdtempSync(join(tmpdir(), "braid-home-legacy-"));
  const legacyDir = join(process.env.HOME, ".pi", "memory");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(
    join(legacyDir, "memory.json"),
    JSON.stringify({
      memories: [
        {
          id: "legacy-ep-1",
          type: "episodic",
          content: "DEFAULT-TREE-LEGACY-EPISODE",
          timestamp: Date.now(),
        },
      ],
    }),
  );
  assert.equal(
    existsSync(paths.legacyMemoryFilePath()),
    false,
    `the pin's predecessor must be absent for this case: ${paths.legacyMemoryFilePath()}`,
  );

  const pi = makeFakePi();
  threeMemoryStoresExtension(pi);
  const ctx = makeFakeCtx(pi, project);
  await firstHandler(pi, "session_start")({}, ctx);
  const state = memoryStoresState(ctx);
  assert.equal(
    state.episodes.some((e) => e.task.includes("DEFAULT-TREE-LEGACY-EPISODE")),
    false,
    `a pinned run must not import the default tree's pre-braid store: ${JSON.stringify(state.episodes.map((e) => e.task))}`,
  );
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
