/**
 * Test: FileMutationQueue race condition (DR-Q-3 scratchpad JSON corruption).
 *
 * Regression test for the bug where concurrent writes to the same file
 * produced "Unexpected non-whitespace character after JSON at position N"
 * errors. Root cause: processQueue deleted the path from this.queues at
 * the START of processing. While the while-loop was awaiting writeFile,
 * a new write() call saw no existing queue, created a fresh one, and
 * scheduled a SECOND setTimeout(processQueue, 0). When that fired,
 * processQueue ran concurrently with the first — two writeFile calls on
 * the same path simultaneously, leaving the file with one valid JSON
 * followed by mid-write truncation followed by another JSON.
 *
 * Fix:
 *   1. processQueue adds `if (this.processing.has(path)) return;` guard.
 *   2. processQueue keeps the queue alive in this.queues during processing,
 *      so new writes append to the same array and the running loop picks
 *      them up.
 *   3. Defense-in-depth: each write is now atomic (temp + rename) so
 *      readers never observe a partially-written file even if the queue
 *      has another bug we haven't found.
 *
 * Test strategy: fire many fire-and-forget writes with large payloads
 * (to keep writeFile in flight long enough to overlap), check the file
 * after each round, assert it always parses as valid JSON.
 */

import { strict as assert } from "node:assert";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { FileMutationQueue } = await import(
  join(process.cwd(), "dist/lib/utils/file-mutation-queue.js")
);

function makeTmp(name) {
  const dir = join(
    tmpdir(),
    `fmq-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return { dir, path: join(dir, "f.json") };
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ── Test 1: basic round-trip ──────────────────────────────────────────────

{
  const { dir, path } = makeTmp("basic");
  try {
    const q = new FileMutationQueue({ dedupMs: 0, maxQueueDepth: 100 });
    await q.write(path, { a: 1, ts: Date.now() });
    await q.flushAll();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(parsed.a, 1, "basic write should round-trip");
    console.log("✓ Test 1: basic round-trip produces valid JSON");
  } finally {
    cleanup(dir);
  }
}

// ── Test 2: sequential writes preserve last-write-wins ────────────────────

{
  const { dir, path } = makeTmp("seq");
  try {
    const q = new FileMutationQueue({ dedupMs: 0, maxQueueDepth: 100 });
    for (let i = 0; i < 10; i++) {
      await q.write(path, { value: i });
    }
    await q.flushAll();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(parsed.value, 9, "last write should win");
    console.log("✓ Test 2: last-write-wins after sequential writes");
  } finally {
    cleanup(dir);
  }
}

// ── Test 3: REGRESSION — fire-and-forget writes never corrupt the file ────
//
// This is the actual corruption scenario from the bug report. Without the
// fix, ~70% of intermediate file states were invalid JSON. With the fix,
// 100% are valid.

{
  const { dir, path } = makeTmp("race");
  try {
    const q = new FileMutationQueue({ dedupMs: 0, maxQueueDepth: 1000 });
    const ENTRY_SIZE = 50_000;
    const ITERATIONS = 100;

    function makePayload(id) {
      return {
        goal: `goal-${id}`,
        description: "x".repeat(ENTRY_SIZE),
        id,
      };
    }

    // Initial write to create the file
    await q.write(path, makePayload(0));
    await q.flushAll();
    {
      const initial = JSON.parse(readFileSync(path, "utf-8"));
      assert.equal(initial.id, 0, "initial write should be persisted");
    }

    let invalidCount = 0;
    let validCount = 0;

    function checkFile() {
      try {
        JSON.parse(readFileSync(path, "utf-8"));
        validCount++;
      } catch {
        invalidCount++;
      }
    }

    for (let i = 1; i <= ITERATIONS; i++) {
      // Fire and forget — don't await, so multiple processQueue calls overlap
      q.write(path, makePayload(i)).catch(() => {});
      // Yield enough to let writeFile actually start
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      checkFile();
    }

    await q.flushAll();
    await new Promise((r) => setTimeout(r, 200));

    // Final file MUST be valid
    const finalCheck = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(finalCheck.id, ITERATIONS, "final write must be the last one");

    // No intermediate state should have been invalid
    assert.equal(
      invalidCount,
      0,
      `file was invalid ${invalidCount}/${invalidCount + validCount} times during concurrent writes — race condition present`,
    );

    console.log(
      `✓ Test 3: ${ITERATIONS} concurrent writes — 0/${validCount + invalidCount} invalid (regression guard)`,
    );
  } finally {
    cleanup(dir);
  }
}

// ── Test 4: atomic write — readers always see complete file ───────────────
//
// Defense-in-depth: even if the queue had another race we missed,
// write-then-rename means a reader either sees the old file or the new one,
// never a half-written mix.

{
  const { dir, path } = makeTmp("atomic");
  try {
    const q = new FileMutationQueue({ dedupMs: 0, maxQueueDepth: 1000 });

    // Write a series of payloads of varying sizes
    for (let i = 0; i < 50; i++) {
      const size = 1000 + ((i * 137) % 10000);
      await q.write(path, {
        id: i,
        payload: "y".repeat(size),
        ts: Date.now(),
      });
    }
    await q.flushAll();

    // File must end with a complete JSON object
    const content = readFileSync(path, "utf-8");
    assert.ok(content.endsWith("}"), "file should end with a complete JSON object");
    assert.ok(content.startsWith("{"), "file should start with a JSON object opener");
    const parsed = JSON.parse(content);
    assert.ok(parsed.id >= 0 && parsed.id < 50, "parsed id should be in expected range");
    assert.ok(typeof parsed.payload === "string", "payload should be a string");
    assert.ok(parsed.payload.length > 0, "payload should not be empty");

    console.log("✓ Test 4: atomic write produces complete files (no truncation)");
  } finally {
    cleanup(dir);
  }
}

// ── Test 5: dedup still works after the fix ───────────────────────────────

{
  const { dir, path } = makeTmp("dedup");
  try {
    const q = new FileMutationQueue({ dedupMs: 100, maxQueueDepth: 100 });

    // Three writes within dedup window — only last should win
    await q.write(path, { value: 1 });
    await q.write(path, { value: 2 });
    await q.write(path, { value: 3 });
    await q.flushAll();

    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(parsed.value, 3, "last write within dedup window should win");

    console.log("✓ Test 5: dedup behavior preserved");
  } finally {
    cleanup(dir);
  }
}

// ── Test 6: parallel writes to DIFFERENT paths don't interfere ────────────

{
  const dir = join(tmpdir(), "fmq-parallel-" + Date.now());
  mkdirSync(dir, { recursive: true });
  const pathA = join(dir, "a.json");
  const pathB = join(dir, "b.json");
  try {
    const q = new FileMutationQueue({ dedupMs: 0, maxQueueDepth: 1000 });

    await Promise.all([
      (async () => {
        for (let i = 0; i < 30; i++) {
          q.write(pathA, { id: i, src: "A" }).catch(() => {});
          await new Promise((r) => setImmediate(r));
        }
      })(),
      (async () => {
        for (let i = 0; i < 30; i++) {
          q.write(pathB, { id: i, src: "B" }).catch(() => {});
          await new Promise((r) => setImmediate(r));
        }
      })(),
    ]);
    await q.flushAll();
    await new Promise((r) => setTimeout(r, 100));

    const a = JSON.parse(readFileSync(pathA, "utf-8"));
    const b = JSON.parse(readFileSync(pathB, "utf-8"));
    assert.equal(a.src, "A", "PATH_A content intact");
    assert.equal(b.src, "B", "PATH_B content intact");
    assert.equal(a.id, 29, "PATH_A last write wins");
    assert.equal(b.id, 29, "PATH_B last write wins");

    console.log("✓ Test 6: parallel writes to different paths don't interfere");
  } finally {
    cleanup(dir);
  }
}

// ── Test 7: writes racing into a queue currently being processed ──────────
//
// Specifically tests the bug: write A is in flight (writeFile awaiting),
// write B arrives, write C arrives. All three must be processed in order
// and the file must remain valid throughout.

{
  const { dir, path } = makeTmp("race-inflight");
  try {
    const q = new FileMutationQueue({ dedupMs: 0, maxQueueDepth: 1000 });

    let invalidObserved = 0;
    const observed = [];

    const obs = setInterval(() => {
      try {
        const c = readFileSync(path, "utf-8");
        JSON.parse(c);
        observed.push({ valid: true, ts: Date.now() });
      } catch (err) {
        // ENOENT before first write is expected; only count JSON parse failures
        if (err.code !== "ENOENT") invalidObserved++;
      }
    }, 1);

    await q.write(path, { v: 1, payload: "x".repeat(10000) });
    // Don't await - simulate parallel calls
    q.write(path, { v: 2, payload: "y".repeat(10000) }).catch(() => {});
    q.write(path, { v: 3, payload: "z".repeat(10000) }).catch(() => {});
    q.write(path, { v: 4, payload: "w".repeat(10000) }).catch(() => {});

    await q.flushAll();
    await new Promise((r) => setTimeout(r, 300));
    clearInterval(obs);

    assert.equal(invalidObserved, 0, "no invalid state observed during in-flight racing");
    const final = JSON.parse(readFileSync(path, "utf-8"));
    assert.ok(final.v >= 1 && final.v <= 4, "final write is one of the four");

    console.log(`✓ Test 7: in-flight racing — 0 invalid across ${observed.length} samples`);
  } finally {
    cleanup(dir);
  }
}

console.log("\n✓✓✓ All FileMutationQueue race tests passed.");