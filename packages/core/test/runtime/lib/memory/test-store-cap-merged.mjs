/**
 * The semantic store's cap is a property of the file, not of a writer.
 *
 * Measured defect: the only thing that trimmed the store was a guard in
 * CognitiveMemory.store(), phrased on the writer's own snapshot
 * (`memories.length > MAX_ENTRIES`). A process that loaded 199 entries while
 * another process brought the file to 200 reaches 200 in its own snapshot
 * after one store(), so the guard is false, the merge writes both populations,
 * and the file ends at 201. Writes from two long-lived snapshots grew a copy
 * to 207 in eight alternating writes, and the live store was found holding 203
 * entries against MAX_ENTRIES = 200.
 *
 * Behavior pinned here, all through the shipped write path (saveMemory, the
 * same call the class persists through):
 *
 *   A. A write whose merged population is over the cap persists the cap, and
 *      the entry that leaves is the one the store's own rule ranks last.
 *   B. The caller adopts what was written: the returned store is the file's
 *      store, id for id.
 *   C. Alternating writes from two stale snapshots never leave the file over
 *      the cap.
 *   D. Two live instances taking turns in store() never leave the file over
 *      the cap.
 *   E. A write under the cap is told apart from one at the cap: it neither
 *      reorders nor drops anything.
 *   F. A file that is already over the cap is brought back to it by the next
 *      write.
 *   G. An explicit wipe still replaces the store; the cap path does not
 *      interfere with it.
 *
 * Hermetic: PI_CODING_AGENT_DIR and BRAID_HOME are pinned to temp directories
 * before the first store call - the settings path is pi's, not braid's, so a
 * live reserved-provenance setting would otherwise reach this fixture - and
 * each case gets its own BRAID_HOME so cases do not share a file.
 */
import test from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "memory-cap-agent-"));

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CORE_DIST = join(CORE_ROOT, "dist");
const DIST = join(CORE_DIST, "lib", "memory");

const { saveMemory } = await import(join(DIST, "storage.js"));
const { CognitiveMemory } = await import(join(DIST, "index.js"));
const { MAX_ENTRIES } = await import(join(DIST, "constants.js"));
const { semanticMemoryFilePath } = await import(join(CORE_DIST, "lib", "config", "braid-paths.js"));

const HOUR = 60 * 60 * 1000;

/** Pin this case's store into its own temp BRAID_HOME; return the file's path. */
function pinStore(label) {
  const home = mkdtempSync(join(tmpdir(), `memory-cap-${label}-`));
  process.env.BRAID_HOME = home;
  mkdirSync(join(home, "memory"), { recursive: true });
  return semanticMemoryFilePath();
}

/**
 * One synthetic entry. `lastAccessed` two hours back keeps it out of the
 * five-minute recency window, so the cap competition sees it as an ordinary
 * resident; cases that want a recent entry say so. The content carries two
 * tokens of its own so no two seeds reach the consolidator's merge threshold:
 * a fixture that quietly merged its population would measure a store that has
 * fewer entries than the scenario seeded.
 */
function entry(index, overrides = {}) {
  const id = `s${String(index).padStart(3, "0")}`;
  const timestamp = Date.now() - (index + 2) * HOUR;
  return {
    id,
    content: `synthetic entry ${id} q${index}marker durable convention record`,
    type: "insight",
    tags: ["synthetic"],
    timestamp,
    accessCount: 0,
    lastAccessed: timestamp,
    source: "synthetic",
    importance: 0.8,
    utility: 0.8,
    ...overrides,
  };
}

/** Write a store file as the previous writer left it, and return its entries. */
function seedStore(path, entries) {
  writeFileSync(
    path,
    `${JSON.stringify(
      { version: 1, memories: entries, lastConsolidation: 0, turnCount: 0, migratedAt: 1 },
      null,
      2,
    )}\n`,
  );
  return entries;
}

/** The store as the file holds it: what a reader, not a caller, would see. */
function onDisk(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("a write whose merged population is over the cap persists the cap", async () => {
  const path = pinStore("merged-over");
  const residents = seedStore(
    path,
    Array.from({ length: MAX_ENTRIES }, (_, i) => entry(i)),
  );
  const newest = entry(MAX_ENTRIES, {
    id: "newcomer",
    content: "a newcomer the second writer just minted about the durable convention",
    timestamp: Date.now(),
    lastAccessed: Date.now(),
  });
  // The second writer's snapshot: the store as it stood at MAX_ENTRIES - 1,
  // plus its own entry. Its count is MAX_ENTRIES, so a guard phrased on the
  // caller's count sees nothing to trim; the file, after the merge, holds both
  // populations.
  const staleSnapshot = {
    version: 1,
    memories: [...residents.slice(0, MAX_ENTRIES - 1), newest],
    lastConsolidation: 0,
    turnCount: 1,
    migratedAt: 1,
  };

  const returned = await saveMemory(staleSnapshot);
  const file = onDisk(path);

  assert.equal(
    file.memories.length,
    MAX_ENTRIES,
    `the file holds ${file.memories.length} entries against a cap of ${MAX_ENTRIES}`,
  );
  const ids = new Set(file.memories.map((m) => m.id));
  assert.equal(ids.size, file.memories.length, "the file carries a duplicate id");
  assert.ok(ids.has("newcomer"), "the write dropped the caller's own new entry");
  const departed = residents.filter((m) => !ids.has(m.id));
  assert.equal(departed.length, 1, "a write at the cap must shed exactly the entries over it");
  // Every resident carries the same utility and the newcomers are protected by
  // the recency window, so the rule ranks the oldest resident last.
  assert.equal(
    departed[0].id,
    residents[MAX_ENTRIES - 1].id,
    "the entry that left is not the one the store's own rule ranks last",
  );
  assert.deepEqual(
    returned.memories.map((m) => m.id),
    file.memories.map((m) => m.id),
    "the store handed back to the caller is not the store that was written",
  );
});

test("alternating writes from two stale snapshots never leave the file over the cap", async () => {
  const path = pinStore("stale-snapshots");
  const residents = seedStore(
    path,
    Array.from({ length: MAX_ENTRIES - 1 }, (_, i) => entry(i)),
  );
  // Neither caller re-reads: each write unions its own view into the file.
  const snapshots = [0, 1].map(() => ({
    version: 1,
    memories: [...residents],
    lastConsolidation: 0,
    turnCount: 0,
    migratedAt: 1,
  }));

  for (let step = 1; step <= 8; step += 1) {
    const snapshot = snapshots[(step - 1) % 2];
    const now = Date.now();
    snapshot.memories.push(
      entry(1000 + step, {
        id: `stale-${step}`,
        content: `stale snapshot write number ${step} about the durable convention in the store`,
        timestamp: now,
        lastAccessed: now,
      }),
    );
    await saveMemory(snapshot);
    const count = onDisk(path).memories.length;
    assert.ok(
      count <= MAX_ENTRIES,
      `write ${step} left the file holding ${count} entries against a cap of ${MAX_ENTRIES}`,
    );
  }
});

test("two live instances taking turns never leave the file over the cap", async () => {
  const path = pinStore("two-instances");
  seedStore(
    path,
    Array.from({ length: MAX_ENTRIES - 1 }, (_, i) => entry(i)),
  );

  const writers = [new CognitiveMemory(), new CognitiveMemory()];
  await Promise.all(writers.map((writer) => writer.init()));

  // Content with no two entries sharing a token: the store's own duplicate gate
  // refuses near-identical writes, and a refused write would hide the count.
  const topics = [
    "chronology deduplication ledger",
    "watermark rotation policy",
    "cursor pagination boundary",
    "schema migration checksum",
    "shard rebalancing timetable",
    "quota accounting ceiling",
  ];
  for (const [index, topic] of topics.entries()) {
    await writers[index % 2].store(topic, "insight", { source: "cap-fixture", importance: 0.8 });
    const count = onDisk(path).memories.length;
    assert.ok(
      count <= MAX_ENTRIES,
      `store() ${index + 1} left the file holding ${count} entries against a cap of ${MAX_ENTRIES}`,
    );
  }
});

test("a write under the cap neither reorders nor drops", async () => {
  const path = pinStore("under-cap");
  const residents = seedStore(path, [0, 1, 2, 3, 4].map((i) => entry(i)));
  const now = Date.now();
  const local = {
    version: 1,
    memories: [
      ...residents,
      entry(5, { id: "fresh", timestamp: now, lastAccessed: now, utility: 0.2 }),
    ],
    lastConsolidation: 0,
    turnCount: 1,
    migratedAt: 1,
  };

  await saveMemory(local);
  const file = onDisk(path);
  assert.equal(file.memories.length, residents.length + 1, "a write under the cap lost an entry");
  assert.deepEqual(
    file.memories.slice(0, residents.length).map((m) => m.id),
    residents.map((m) => m.id),
    "a write under the cap reordered the residents: the cap path ran where nothing needed trimming",
  );
  assert.equal(file.memories.at(-1).id, "fresh", "the new entry is not last in the written store");
});

test("a file already over the cap is brought back to it by the next write", async () => {
  const path = pinStore("already-over");
  const residents = seedStore(
    path,
    Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => entry(i)),
  );
  const now = Date.now();
  const local = {
    version: 1,
    memories: [
      ...residents,
      entry(500, { id: "healer", timestamp: now, lastAccessed: now, utility: 0.9 }),
    ],
    lastConsolidation: 0,
    turnCount: 1,
    migratedAt: 1,
  };

  assert.equal(onDisk(path).memories.length, MAX_ENTRIES + 5, "the seeded file is not over the cap");
  await saveMemory(local);
  assert.equal(
    onDisk(path).memories.length,
    MAX_ENTRIES,
    "one write did not bring an over-cap file back to the cap",
  );
});

test("an explicit wipe still replaces the store", async () => {
  const path = pinStore("wipe");
  seedStore(path, [0, 1, 2].map((i) => entry(i)));
  await saveMemory({ version: 1, memories: [], lastConsolidation: 0, turnCount: 0 }, { replaceAll: true });
  assert.equal(onDisk(path).memories.length, 0, "a wipe left entries behind");
});
