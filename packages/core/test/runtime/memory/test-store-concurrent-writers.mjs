/**
 * Regression test: concurrent memory writers must not erase each other.
 *
 * Measured defect (memory audit): every semantic-memory writer rewrote
 * semantic.json from its own in-memory snapshot, and recall() rewrote the
 * whole store just to bump access counters. Two live processes therefore
 * erased each other's writes: of 60 write decisions across six days only
 * 3 rows reached the disk store.
 *
 * Behaviors pinned here:
 *   A. A stale snapshot cannot erase a concurrent writer's entry: process B
 *      loads before A stores, then B persists (recall bump) — A's entry must
 *      survive on disk.
 *   B. A stale process adopts concurrent writes: after its first persist the
 *      previously-missing entry is visible to B's recall.
 *   C. Two interleaved writers, one write each: both entries survive on disk.
 *   D. A recall counter bump from one process survives another process's
 *      independent write (bump + new entry both on disk).
 *   E. Two OS processes appending episodes concurrently: every appended line
 *      survives and parses.
 *
 * Hermetic: HOME is redirected to a temp dir before the dist imports, so the
 * live memory stores are never touched. Child processes inherit the same
 * fake HOME and write the same episodes.jsonl.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// Resolve dist from the test file, never from cwd: the spawned child imports
// these paths directly, so the suite must run from any cwd.
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, "..", "..", "..");
const FAKE_HOME = mkdtempSync(join(tmpdir(), "store-concurrency-test-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), "{}\n");

const { CognitiveMemory } = await import("../../../dist/lib/memory/index.js");
const { SEMANTIC_MEMORY_FILE, EPISODES_FILE } = await import(
  "../../../dist/lib/config/braid-paths.js"
);
const distThreeMem = join(CORE_ROOT, "dist", "extensions", "memory", "three-memory-stores");

console.log("=== concurrent memory writers ===\n");

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

function readDisk() {
  if (!existsSync(SEMANTIC_MEMORY_FILE)) return null;
  return JSON.parse(readFileSync(SEMANTIC_MEMORY_FILE, "utf8"));
}

function diskHasMemoryId(id) {
  const disk = readDisk();
  return (disk?.memories ?? []).some((m) => m.id === id);
}

function diskMemoryById(id) {
  const disk = readDisk();
  return (disk?.memories ?? []).find((m) => m.id === id);
}

function episodeLines() {
  if (!existsSync(EPISODES_FILE)) return [];
  return readFileSync(EPISODES_FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

async function pollUntil(predicate, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ── A + B. Stale snapshot must not erase a concurrent writer's entry ─────────
await testAsync("a stale recall() cannot erase an entry another writer stored", async () => {
  const writerA = new CognitiveMemory();
  const recallerB = new CognitiveMemory();
  await writerA.init(); // both load the same (empty) disk store
  await recallerB.init();

  const content = "Xyzzy durable insight about concurrent memory writers alpha bravo";
  const stored = await writerA.store(content, "pattern", { source: "test" });

  // B's snapshot predates A's store; its recall persists its snapshot.
  const firstResults = await recallerB.recall("concurrent memory writers alpha");
  const landedAfterBump = await pollUntil(() => diskHasMemoryId(stored.id));
  assert.equal(
    landedAfterBump,
    true,
    "B's post-load persist erased A's entry from semantic.json",
  );

  // After adopting the merged store, the previously-invisible entry surfaces.
  const secondResults = await recallerB.recall("concurrent memory writers alpha");
  assert.equal(
    secondResults.some((r) => r.memory.id === stored.id),
    true,
    "the concurrent entry stayed invisible to the stale process after its persist",
  );
  assert.equal(firstResults.length, 0, "pre-adopt recall correctly saw nothing");
});

// ── C. Two interleaved writers, both entries survive ─────────────────────────
await testAsync("two interleaved writers both land on disk", async () => {
  const writerA = new CognitiveMemory();
  const writerB = new CognitiveMemory();
  await writerA.init();
  await writerB.init();

  const a = await writerA.store("First interleaved durable writer entry charlie delta", "pattern", {
    source: "test",
  });
  const b = await writerB.store("Second interleaved durable writer entry echo foxtrot", "pattern", {
    source: "test",
  });

  const both = await pollUntil(() => diskHasMemoryId(a.id) && diskHasMemoryId(b.id));
  assert.equal(both, true, "one of the two interleaved writes was lost");
});

// ── D. Counter bumps survive another process's independent write ─────────────
await testAsync("a recall bump survives another writer's later persist", async () => {
  const bumperA = new CognitiveMemory();
  const writerB = new CognitiveMemory();
  await bumperA.init();
  await writerB.init();

  const stored = await bumperA.store(
    "Zapped utility counter probe golf hotel india juliet",
    "pattern",
    { source: "test" },
  );
  await bumperA.recall("utility counter probe golf"); // bumps accessCount and persists

  await writerB.store("Kilo lima mike november outstanding second probe", "pattern", {
    source: "test",
  });

  const survived = await pollUntil(() => diskHasMemoryId(stored.id));
  assert.equal(survived, true, "B's persist erased A's bumped entry");
  const onDisk = diskMemoryById(stored.id);
  assert.equal(onDisk?.accessCount ?? 0, 1, "the access bump was not preserved on disk");
});

// ── E. Two OS processes appending episodes concurrently ──────────────────────
await testAsync("two processes appending episodes concurrently keep every line", async () => {
  const episodesDist = join(distThreeMem, "episodes.js");
  const flushDist = join(distThreeMem, "episodes-disk.js");

  const childCode = `
    const { addEpisode } = await import(process.argv[2]);
    const { flushEpisodeAppends } = await import(process.argv[3]);
    const state = { episodes: [], heuristics: [], toolStats: new Map(), currentSessionId: "child" };
    const prefix = process.argv[4];
    for (let i = 0; i < 3; i++) {
      addEpisode(state, prefix + " concurrent episode task " + i, "solution body " + i, "success", ["bash"]);
    }
    await flushEpisodeAppends();
    console.log("child done: " + prefix);
  `;

  const runChild = (prefix) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["-e", childCode, "child", episodesDist, flushDist, prefix],
        { env: process.env, cwd: process.cwd() },
      );
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out }));
    });

  const [a, b] = await Promise.all([runChild("procA"), runChild("procB")]);
  assert.equal(a.code, 0, `child A failed: ${a.out}`);
  assert.equal(b.code, 0, `child B failed: ${b.out}`);

  const landed = await pollUntil(
    () => episodeLines().filter((l) => l.includes("concurrent episode task")).length >= 6,
  );
  assert.equal(landed, true, "fewer than 6 concurrent episode lines survived on disk");

  const appended = episodeLines().filter((l) => l.includes("concurrent episode task"));
  assert.equal(appended.length, 6, "expected exactly the six appended lines");
  const ids = new Set();
  for (const line of appended) {
    const ep = JSON.parse(line);
    assert.ok(ep.id, "appended line parses and carries an id");
    assert.ok(ep.task && ep.solution && ep.outcome, "appended line carries the loader's fields");
    ids.add(ep.id);
  }
  assert.equal(ids.size, 6, "duplicate ids on disk");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== concurrent memory writer tests passed ===");
