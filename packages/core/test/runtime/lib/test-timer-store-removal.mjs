/**
 * Regression test: an emptied per-project timer store must leave nothing
 * behind.
 *
 * The store at getTimerFilePath(cwd) — braidDir()/projects/<sanitized-cwd>/
 * pending-timers.jsonl — was written unconditionally: the write path mkdir'd
 * the project directory and wrote `records.join("\n") + "\n"`, which for an
 * empty list is a ONE-BYTE file (a single newline). Cancelling the last timer
 * of a cwd therefore left the file and the directory behind for ever, one per
 * cwd — including every cwd that existed only for the length of a test run.
 * The live tree held 347 such directories (346 of them one-byte files) and
 * the sweep/recovery rewrites produced the same artefact as zero-byte files.
 *
 * Fix: every writer of this store goes through the store's own write path
 * (timer/store-file.ts), which removes the store when there is nothing to
 * persist and removes the project directory when that leaves it empty.
 * Readers are unaffected: a missing file reads exactly as an empty one
 * (loadPendingTimers, recoverPersistedTimers, sweepProjectStoresRetention).
 *
 * These cases drive the real surface — the timer extension's scheduleTimer /
 * cancelTimer and recoverPersistedTimers — with BRAID_HOME pinned into a
 * private tmpdir and the cwd a temp directory, so the test itself never
 * touches the live store.
 *
 * Run: node test/runtime/lib/test-timer-store-removal.mjs
 */

import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// Pin braid's whole persistent tree into a private tmpdir: fixtures must never
// reach the live store (braidDir() honours BRAID_HOME per call).
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-timer-store-removal-home-"));
process.env.BRAID_HOME = BRAID_HOME;

const { scheduleTimer, cancelTimer } =
  await import("../../../dist/extensions/scheduling/timer/index.js");
const { recoverPersistedTimers, _setSessionsDirForTests, FOREIGN_TIMER_PRUNE_OVERDUE_MS } =
  await import("../../../dist/extensions/scheduling/timer/recovery.js");
const { getTimerFilePath } = await import("../../../dist/lib/config/braid-paths.js");

const SESSION = "sess-store-removal";
const originalCwd = process.cwd();
const tmpCwd = mkdtempSync(join(tmpdir(), "braid-timer-store-removal-cwd-"));
process.chdir(tmpCwd);

const fakeSessionsDir = join(BRAID_HOME, "fake-sessions-store");
const storeFile = getTimerFilePath(process.cwd());
const storeDir = dirname(storeFile);

function fakePi() {
  return { sendMessage() {}, on() {} };
}

/** An overdue record of a session that has no session-store file at all. */
function zombieRecord(id, sessionId) {
  const now = Date.now();
  return {
    id,
    sessionId,
    firesAt: now - FOREIGN_TIMER_PRUNE_OVERDUE_MS * 4,
    reason: "stale cadence",
    tag: "periodic-status",
    createdAt: now - FOREIGN_TIMER_PRUNE_OVERDUE_MS * 8,
    wake: true,
    intervalMs: 600_000,
    fires: 3,
  };
}

after(() => {
  _setSessionsDirForTests(null);
  process.chdir(originalCwd);
  for (const dir of [tmpCwd, BRAID_HOME]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

afterEach(() => {
  _setSessionsDirForTests(null);
  rmSync(storeDir, { recursive: true, force: true });
});

describe("emptied timer store", () => {
  it("sanity: the store resolves under the pinned BRAID_HOME, never the live tree", () => {
    assert.ok(
      storeFile.startsWith(BRAID_HOME),
      `store must live under the pinned BRAID_HOME (${BRAID_HOME}), got ${storeFile}`,
    );
  });

  it("REGRESSION: cancelling the last timer removes the store and its directory", () => {
    const id = scheduleTimer(SESSION, 60_000, "hold the build", undefined, true);
    assert.ok(existsSync(storeFile), "scheduling a timer persists the store");
    assert.equal(cancelTimer(SESSION, id), true, "the cancel finds the live timer");
    assert.equal(
      existsSync(storeFile),
      false,
      "the emptied store is removed, not left behind as a one-byte file",
    );
    assert.equal(existsSync(storeDir), false, "the project directory goes with it");
  });

  it("REGRESSION: recovery that prunes a store to nothing removes it too", () => {
    mkdirSync(fakeSessionsDir, { recursive: true }); // sessions store exists, holds nothing
    _setSessionsDirForTests(fakeSessionsDir);
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(storeFile, JSON.stringify(zombieRecord("t-zombie", "sess-ghost")) + "\n", "utf-8");

    recoverPersistedTimers(fakePi(), SESSION);

    assert.equal(existsSync(storeFile), false, "the pruned-to-nothing store is removed");
    assert.equal(existsSync(storeDir), false, "its directory goes with it");
  });

  it("cancelling one of two timers keeps the store with the remaining record", () => {
    const first = scheduleTimer(SESSION, 60_000, "hold the build", undefined, true);
    const second = scheduleTimer(SESSION, 120_000, "hold the deploy", undefined, true);
    assert.equal(cancelTimer(SESSION, first), true, "the cancel finds the live timer");
    assert.ok(existsSync(storeFile), "the store survives while a record remains");
    const records = readFileSync(storeFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((r) => r.id),
      [second],
      "only the cancelled record is dropped",
    );
  });
});
