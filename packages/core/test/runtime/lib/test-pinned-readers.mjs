/**
 * Pinned readers: the prior-state readers resolve the live braid root.
 *
 * Both readers used to read a module-load constant (`MEMORY_DIR`,
 * `SCRATCHPAD_DIR`, `EPISODES_FILE`, `SEMANTIC_MEMORY_FILE`), so under a
 * BRAID_HOME pin they looked in the default tree under HOME - the developer's
 * real store - instead of the tree the writers wrote to. A pinned test could
 * then pass or fail on state nobody in the test created.
 *
 * Contract pinned here:
 *   (a) `searchPastInsights` reads the episode store under BRAID_HOME;
 *   (b) the session-start discoverability handler emits its scratchpad and
 *       memory signals from the pinned tree;
 *   (c) with no absolute home (relative HOME, no BRAID_HOME) both readers
 *       degrade - no throw, no unhandled rejection, no whisper.
 *
 * Isolation: HOME and BRAID_HOME are throwaway temp dirs before any dist
 * import, so the developer's live braid tree is never read or written.
 *
 * Run: node test/runtime/lib/test-pinned-readers.mjs
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

// ── Isolation, before any dist import ──────────────────────────────────────
process.env.HOME = mkdtempSync(join(tmpdir(), "pinned-readers-home-"));
const BRAID_HOME = mkdtempSync(join(tmpdir(), "pinned-readers-pin-"));
process.env.BRAID_HOME = BRAID_HOME;

const unhandled = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(reason instanceof Error ? reason.message : String(reason));
});

const { searchPastInsights } = await import(join(ROOT, "dist", "lib", "memory", "past-insights.js"));
const { projectSlugFromCwd } = await import(
  join(ROOT, "dist", "extensions", "memory", "scratchpad", "persistence.js")
);
const { registerSessionStartDiscoverability } = await import(
  join(ROOT, "dist", "extensions", "enforcement", "handlers", "register-session-start-discoverability.js")
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

/** One fresh project with prior state written under the pin; returns its cwd. */
function writePinnedState() {
  const project = mkdtempSync(join(tmpdir(), "pinned-readers-project-"));
  const slug = projectSlugFromCwd(project);
  mkdirSync(join(BRAID_HOME, "scratchpads", slug), { recursive: true });
  writeFileSync(
    join(BRAID_HOME, "scratchpads", slug, "latest.json"),
    JSON.stringify({ goal: "pinned goal", plans: [{ done: false }] }),
  );
  mkdirSync(join(BRAID_HOME, "memory"), { recursive: true });
  writeFileSync(
    join(BRAID_HOME, "memory", "episodes.jsonl"),
    JSON.stringify({
      id: "pin-episode",
      task: "pinned episode task",
      solution: "pinned solution",
      outcome: "success",
      timestamp: Date.now(),
    }) + "\n",
  );
  writeFileSync(
    join(BRAID_HOME, "memory", "semantic.json"),
    JSON.stringify([{ id: "pin-semantic", content: "pinned semantic memory" }]),
  );
  return project;
}

/** Drive the discoverability handler and return the whisper bodies it sent. */
async function driveDiscoverability(cwd) {
  const sent = [];
  const handlers = [];
  const pi = {
    on: (event, handler) => handlers.push([event, handler]),
    sendMessage: (params) => sent.push(params),
    sendUserMessage: () => {},
    registerTool: () => {},
  };
  registerSessionStartDiscoverability(pi);
  const sessionStart = handlers.find(([event]) => event === "session_start");
  assert.ok(sessionStart, "the discoverability coordinator must register a session_start handler");

  const sessionId = `pinned-${Math.random().toString(36).slice(2, 8)}`;
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
  getState(ctx).enforcementActive = true;
  await sessionStart[1]({}, ctx);
  // SessionPhase.Background handlers are fire-and-forget: let them land.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return sent.map((params) => JSON.stringify(params.content)).join("\n");
}

console.log("pinned readers test\n");

await test("(a) searchPastInsights reads the pinned episode store", async () => {
  const project = writePinnedState();
  const insights = await searchPastInsights(project);
  assert.ok(
    insights.some((i) => i.content.includes("pinned episode task")),
    `the pinned episode must be read, got ${JSON.stringify(insights)}`,
  );
});

await test("(b) discoverability emits scratchpad and memory signals from the pin", async () => {
  const project = writePinnedState();
  const text = await driveDiscoverability(project);
  assert.match(text, /Prior scratchpad data/, `scratchpad signal missing: ${text}`);
  assert.match(text, /Prior episodes/, `memory signal missing: ${text}`);
});

for (const hostileHome of [".", ""]) {
  await test(`(c) HOME=${JSON.stringify(hostileHome)}: both readers degrade`, async () => {
    const pinnedHome = process.env.HOME;
    const pinnedBraid = process.env.BRAID_HOME;
    try {
      delete process.env.BRAID_HOME;
      process.env.HOME = hostileHome;
      const project = mkdtempSync(join(tmpdir(), "pinned-readers-hostile-"));
      const insights = await searchPastInsights(project);
      assert.deepEqual(insights, [], "a refused root must degrade to no insights");
      const text = await driveDiscoverability(project);
      assert.equal(text, "", `no whisper may come from a refused root: ${text}`);
      assert.deepEqual(
        unhandled,
        [],
        `no reader may leave a rejection undrained: ${JSON.stringify(unhandled)}`,
      );
    } finally {
      process.env.HOME = pinnedHome;
      process.env.BRAID_HOME = pinnedBraid;
    }
  });
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
