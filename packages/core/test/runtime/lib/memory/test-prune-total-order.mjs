/**
 * The order that decides which entry leaves.
 *
 * Measured defect: the comparator carried a pair-wise tolerance -
 * `if (Math.abs(a.utility - b.utility) > 0.1) return b.utility - a.utility;
 * return b.timestamp - a.timestamp;`. A tolerance cannot be transitive: with
 * utilities 0.84, 0.75 and 0.66 both adjacent pairs fall inside the band and
 * let recency speak, while 0.84 vs 0.66 does not, so `a<b`, `b<c` and `c<a`
 * hold together. Array.prototype.sort on such a comparator returns an order
 * that depends on the input array: 40 determinants of one population produced
 * 40 distinct orders, and on the live store a 0.84 entry was evicted while a
 * 0.605 one stayed.
 *
 * Behavior pinned here, against the comparator's own export:
 *
 *   A. One population sorts to one sequence from every determinant.
 *   B. The relation is transitive, antisymmetric and reflexive.
 *   C. A utility difference of at least a tenth is decided by utility,
 *      whatever the timestamps say; inside a bucket recency decides.
 *   D. Equal utility on equal timestamps is broken by id, so even a tie sorts
 *      the same way from every permutation.
 *   E. At one over the cap, pruneMemories drops the entry the order ranks
 *      last, and no entry with a strictly higher utility bucket is dropped
 *      while a lower-bucket entry stays.
 *
 * Hermetic: PI_CODING_AGENT_DIR and BRAID_HOME are pinned to temp directories
 * before the first call, so pruneMemories reads default settings rather than
 * whatever the live settings.json configures for the reserved-provenance
 * partition.
 */
import test from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "memory-order-"));
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "memory-order-agent-"));

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const DIST = join(CORE_ROOT, "dist", "lib", "memory");

const { byUtilityThenRecency, pruneMemories } = await import(join(DIST, "lifecycle.js"));
const { MAX_ENTRIES } = await import(join(DIST, "constants.js"));

/** A comparator rank is 1-first: negative when `a` outranks `b`. */
const rankOf = (a, b) => byUtilityThenRecency(a, b);

/** Deterministic PRNG so two runs measure the same population. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic permutation of `list`. */
function permuted(list, seed) {
  const out = [...list];
  const pick = rng(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(pick() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Entry-shaped values: the comparator reads utility, timestamp and id only. */
function shaped(id, utility, timestamp) {
  return { id, utility, timestamp };
}

test("one population sorts to one sequence from every determinant", () => {
  const next = rng(20261116);
  const base = 1_700_000_000_000;
  const population = Array.from({ length: 240 }, (_, i) =>
    shaped(`e${String(i).padStart(3, "0")}`, Math.round((0.605 + next() * 0.395) * 1000) / 1000, base + i * 1000),
  );
  const determinants = [population, [...population].reverse()];
  for (let seed = 1; seed <= 38; seed += 1) determinants.push(permuted(population, seed));

  const sequences = new Set(
    determinants.map((determinant) => [...determinant].sort(rankOf).map((e) => e.id).join(",")),
  );
  assert.equal(
    sequences.size,
    1,
    `${determinants.length} determinants of one population produced ${sequences.size} different orders`,
  );
});

test("the relation is transitive, antisymmetric and reflexive", () => {
  const next = rng(7);
  const sample = Array.from({ length: 18 }, (_, i) =>
    shaped(`t${i}`, Math.round((0.6 + next() * 0.4) * 1000) / 1000, 1_700_000_000_000 + i * 10),
  );

  for (const a of sample) {
    assert.equal(rankOf(a, a), 0, `${a.id} does not compare equal to itself`);
    for (const b of sample) {
      assert.ok(
        Math.sign(rankOf(a, b)) === -Math.sign(rankOf(b, a)),
        `${a.id} and ${b.id} do not disagree symmetrically`,
      );
    }
  }

  const violations = [];
  for (const a of sample) {
    for (const b of sample) {
      if (a === b || rankOf(a, b) >= 0) continue;
      for (const c of sample) {
        if (c === a || c === b || rankOf(b, c) >= 0) continue;
        if (rankOf(c, a) < 0) violations.push(`${a.id} < ${b.id} < ${c.id} < ${a.id}`);
      }
    }
  }
  assert.deepEqual(violations.slice(0, 3), [], "the comparator is not transitive");
});

test("at least a tenth apart is decided by utility, inside a bucket by recency", () => {
  const old = 1_700_000_000_000;
  const fresh = old + 30 * 24 * 60 * 60 * 1000;
  const bucket = (utility) => Math.floor(utility * 10);

  // A bucket is a tenth wide: 0.75 and 0.79 share one, 0.8 does not.
  assert.equal(bucket(0.75), bucket(0.79), "a tenth no longer spans one bucket");
  assert.notEqual(bucket(0.79), bucket(0.8), "a bucket is wider than a tenth");

  // At least a tenth apart: utility outranks recency, in both directions.
  assert.ok(
    rankOf(shaped("high-old", 0.9, old), shaped("low-new", 0.8, fresh)) < 0,
    "a 0.9 entry 30 days old ranked behind a 0.8 entry written today",
  );
  assert.ok(
    rankOf(shaped("high-new", 0.8, fresh), shaped("low-old", 0.7, old)) < 0,
    "exactly a tenth of utility did not decide the order",
  );

  // One bucket: the newer entry outranks the older one whatever its utility.
  assert.ok(
    rankOf(shaped("band-new", 0.75, fresh), shaped("band-old", 0.79, old)) < 0,
    "entries in one utility bucket were not ordered by recency",
  );
});

test("equal utility on equal timestamps is broken by id", () => {
  const tied = [shaped("b", 0.8, 1_700_000_000_000), shaped("a", 0.8, 1_700_000_000_000), shaped("c", 0.8, 1_700_000_000_000)];
  const sequences = new Set();
  for (let seed = 0; seed < 6; seed += 1) {
    sequences.add(
      (seed === 0 ? [...tied] : permuted(tied, seed)).sort(rankOf).map((e) => e.id).join(","),
    );
  }
  assert.deepEqual([...sequences], ["a,b,c"], "entries tied on every ranking field still sorted by input order");
});

test("at one over the cap, the entry the order ranks last is the one that leaves", () => {
  const HOUR = 60 * 60 * 1000;
  const older = Date.now() - 3 * HOUR;
  const newest = Date.now() - HOUR;
  const residents = Array.from({ length: MAX_ENTRIES }, (_, i) => ({
    id: `r${String(i).padStart(3, "0")}`,
    content: `resident ${i} durable convention record`,
    type: "insight",
    tags: [],
    timestamp: older,
    accessCount: 0,
    lastAccessed: older,
    importance: 0.8,
    utility: 0.84,
  }));
  // The newcomer carries the lowest utility in the store and the newest
  // timestamp: under the tolerance comparator recency inside the band kept it
  // while a 0.84 resident left. It must leave now.
  const weakest = {
    id: "weakest",
    content: "weakest durable convention record",
    type: "insight",
    tags: [],
    timestamp: newest,
    accessCount: 0,
    lastAccessed: newest,
    importance: 0.6,
    utility: 0.605,
  };

  const pruned = pruneMemories([...residents, weakest]);
  assert.equal(pruned.length, MAX_ENTRIES, `the prune returned ${pruned.length} entries against a cap of ${MAX_ENTRIES}`);
  const kept = new Set(pruned.map((m) => m.id));
  assert.equal(kept.has("weakest"), false, "the newest entry was dropped although a higher-utility one stayed");

  const bucket = (m) => Math.floor(m.utility * 10);
  const dropped = [...residents, weakest].filter((m) => !kept.has(m.id));
  assert.equal(dropped.length, 1, "the prune shed more than the one entry over the cap");
  for (const gone of dropped) {
    for (const survivor of pruned) {
      assert.ok(
        bucket(gone) <= bucket(survivor),
        `an entry in utility bucket ${bucket(gone)} left while ${survivor.id} in bucket ${bucket(survivor)} stayed`,
      );
    }
  }
});

test("at or under the cap the prune keeps every entry", () => {
  const HOUR = 60 * 60 * 1000;
  const atCap = Date.now() - 3 * HOUR;
  const population = Array.from({ length: MAX_ENTRIES }, (_, i) => ({
    id: `k${String(i).padStart(3, "0")}`,
    content: `kept ${i} durable convention record`,
    type: "insight",
    tags: [],
    timestamp: atCap,
    accessCount: 0,
    lastAccessed: atCap,
    importance: 0.8,
    utility: 0.8,
  }));
  const pruned = pruneMemories(population);
  assert.equal(pruned.length, MAX_ENTRIES, "a store at the cap lost an entry");
  assert.deepEqual(
    new Set(pruned.map((m) => m.id)),
    new Set(population.map((m) => m.id)),
    "a store at the cap lost an entry",
  );
});
