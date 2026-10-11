/**
 * Regression test: a concurrent prune must not drop another writer's checkpoint.
 *
 * The scratchpad checkpoint log is append-only, but saveScratchpadToDisk also
 * prunes it: it reads the whole file and rewrites the last MAX_CHECKPOINT_LINES
 * lines. That read-modify-write ran unlocked, justified by "at most one active
 * session per project" - false in this system, where several live processes
 * share one scratchpad file per project. An append landing between the prune's
 * read and its rewrite was silently dropped, and a checkpoint line is 20-80KB
 * of state.
 *
 * Pinned here: with one writer paused inside the prune window, a second
 * writer's save must still land. Before the fix the second checkpoint is
 * erased by the first writer's stale rewrite; after the fix the store lock
 * serializes the two saves, so both checkpoints survive and the save that
 * finished last is the effective state.
 *
 * The pause uses the persistence module's test seam: the window between the
 * prune's read and its rewrite is not reachable from outside the module.
 *
 * Hermetic: HOME is redirected to a temp dir before the dist imports, so the
 * live scratchpad tree is never touched.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "scratchpad-race-test-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), "{}\n");

const {
  createScratchpad,
  saveScratchpadToDisk,
  loadScratchpadFromDisk,
  __setPruneWriteHookForTest,
} = await import("../../../dist/extensions/memory/scratchpad/persistence.js");
const { SCRATCHPAD_DIR } = await import("../../../dist/lib/config/braid-paths.js");

const SLUG = "scratchpad-race-fixture";
const EVENTS_FILE = join(SCRATCHPAD_DIR, SLUG, "events.jsonl");
const GOAL_A = "writer-A-goal";
const GOAL_B = "writer-B-goal";
/** Retention bound from persistence.ts: MAX_CHECKPOINT_LINES. */
const MAX_CHECKPOINT_LINES = 50;

console.log("=== scratchpad checkpoint prune race ===\n");

let passed = 0;
let failed = 0;
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

function checkpointLines(file = EVENTS_FILE) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

function diskHasGoal(goal) {
  return checkpointLines().some((l) => {
    try {
      return JSON.parse(l).state.goal === goal;
    } catch {
      return false;
    }
  });
}

function diskLastGoal() {
  const lines = checkpointLines();
  if (lines.length === 0) return null;
  return JSON.parse(lines[lines.length - 1]).state.goal;
}

async function pollUntil(predicate, timeoutMs, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// Seed more lines than the retention bound, so the next save prunes.
mkdirSync(join(SCRATCHPAD_DIR, SLUG), { recursive: true });
const seeds = [];
for (let i = 0; i < MAX_CHECKPOINT_LINES + 5; i++) {
  seeds.push(JSON.stringify({ ts: Date.now(), state: createScratchpad(`seed-${i}`, SLUG) }));
}
writeFileSync(EVENTS_FILE, seeds.join("\n") + "\n", "utf-8");

await testAsync("a checkpoint appended inside another save's prune window survives", async () => {
  let readReached;
  const readGate = new Promise((resolve) => {
    readReached = resolve;
  });
  let releaseRead;
  const releaseGate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  let paused = false;
  __setPruneWriteHookForTest(async () => {
    if (paused) return;
    paused = true;
    readReached();
    await releaseGate;
  });

  const saveA = saveScratchpadToDisk(createScratchpad(GOAL_A, SLUG));
  await readGate; // A is between the prune's read and its rewrite

  let bSettled = false;
  const saveB = saveScratchpadToDisk(createScratchpad(GOAL_B, SLUG));
  saveB.then(
    () => {
      bSettled = true;
    },
    () => {
      bSettled = true;
    },
  );

  // While A is paused: with the save lock B cannot reach its append, so it
  // stays pending. Without the lock B appends and completes, and A's stale
  // rewrite then erases B's line.
  const bFinishedInsideWindow = await pollUntil(() => bSettled, 2000);

  releaseRead();
  await saveA;
  await saveB;
  __setPruneWriteHookForTest(null);

  assert.equal(
    diskHasGoal(GOAL_B),
    true,
    "the concurrent writer's checkpoint was dropped by the other writer's prune " +
      `(B settled inside the prune window: ${bFinishedInsideWindow})`,
  );
  assert.equal(diskLastGoal(), GOAL_B, "the last checkpoint on disk is not the save that finished last");
});

await testAsync("a save below the retention bound still appends and loads back", async () => {
  const slug = "scratchpad-race-small";
  const file = join(SCRATCHPAD_DIR, slug, "events.jsonl");
  await saveScratchpadToDisk(createScratchpad("single-writer-goal", slug));
  assert.equal(existsSync(file), true, "no checkpoint file was written");
  assert.equal(checkpointLines(file).length, 1, "expected exactly one checkpoint line");
  const loaded = await loadScratchpadFromDisk(slug);
  assert.equal(loaded?.goal, "single-writer-goal", "the saved checkpoint did not load back");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== scratchpad checkpoint prune race tests passed ===");
