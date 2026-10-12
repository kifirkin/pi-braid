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
 *       containment rule the loader store is pinned by.
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
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
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

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
