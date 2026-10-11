/**
 * Regression tests: persisted-timer recovery is scoped to the owning session.
 *
 * Defect: recoverPersistedTimers swept the whole per-project store and
 * processed every record regardless of sessionId — a fresh session in an
 * existing project received overdue wake fires belonging to EARLIER sessions
 * (delivered right at its turn settle), and recovery re-armed foreign
 * cadences into this process. The store is shared per project CWD (two panes
 * keep their own timers in one file), so the sweep must never deliver,
 * re-arm, or restore a record whose sessionId differs from the current
 * session, and must prune foreign zombies only when the owner is provably
 * gone (never delete a live sibling's record).
 *
 * Contract:
 * - recoverPersistedTimers(pi, currentSessionId): records with a matching
 *   sessionId recover exactly as before; foreign records are inert here.
 * - recoverPersistedTimers(pi): legacy unscoped sweep (session id unknown —
 *   the direct test surface); production always passes the id.
 * - Foreign prune policy: overdue beyond FOREIGN_TIMER_PRUNE_OVERDUE_MS (the
 *   owner had ample polls to service it and did not) AND owner shows no
 *   session-store activity within FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS
 *   (session file missing or stale). Unexpired foreign records are never
 *   touched.
 *
 * Run: node test/runtime/lib/test-timer-recovery-session-scope.mjs
 */

import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const { recoverPersistedTimers, _setSessionsDirForTests } =
  await import("../../../dist/extensions/scheduling/timer/recovery.js");
const { FOREIGN_TIMER_PRUNE_OVERDUE_MS, FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS } =
  await import("../../../dist/extensions/scheduling/timer/recovery.js");
const { timerManager } = await import("../../../dist/extensions/scheduling/timer/index.js");
const { wakeRetryQueue } = await import("../../../dist/extensions/scheduling/timer/wake-retry.js");
const { getTimerFilePath } = await import("../../../dist/lib/config/braid-paths.js");

// ── Fixtures ───────────────────────────────────────────────────────────────

const originalCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "braid-timer-scope-"));
// Pin braid's persistent tree into a private tmpdir: fixture timers must
// never write the live store (braidDir() honors BRAID_HOME per call).
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-timer-home-scope-"));
process.env.BRAID_HOME = BRAID_HOME;
const fakeSessionsDir = join(tmp, "sessions-store");

function makeFakePi() {
  const sent = [];
  return {
    sent,
    sendMessage(params, options) {
      sent.push({ params, options });
    },
    on() {},
  };
}

function writeTimerFile(lines) {
  const file = getTimerFilePath(process.cwd());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return file;
}

function readTimerFile() {
  const file = getTimerFilePath(process.cwd());
  let raw;
  try {
    raw = readFileSync(file, "utf-8").trim();
  } catch {
    return [];
  }
  if (!raw) return [];
  return raw.split("\n").map((l) => JSON.parse(l));
}

/** Create a session-store fixture file for one session id, with a
 *  backdatable mtime (owner-liveness evidence), and point the recovery
 *  module's liveness lookup at the fixture store. */
function writeSessionFile(sessionId, ageMs) {
  // Real layout: sessions/<project>/<...>_<sessionId>.jsonl — the liveness
  // walk descends into project dirs only.
  const projectDir = join(fakeSessionsDir, "proj");
  mkdirSync(projectDir, { recursive: true });
  _setSessionsDirForTests(fakeSessionsDir);
  const file = join(projectDir, `ts_${sessionId}.jsonl`);
  writeFileSync(file, "{}\n", "utf-8");
  const stamp = new Date(Date.now() - ageMs);
  utimesSync(file, stamp, stamp);
  return file;
}

after(() => {
  const file = getTimerFilePath(process.cwd());
  process.chdir(originalCwd);
  try {
    rmSync(dirname(file), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(fakeSessionsDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

afterEach(() => {
  wakeRetryQueue.resetForTests();
  for (const sid of ["sess-current-fresh", "sess-ghost-old", "sess-sibling-live", "sess-legacy"]) {
    timerManager.clearSession(sid);
  }
  _setSessionsDirForTests(null);
  rmSync(getTimerFilePath(process.cwd()), { force: true });
});

describe("owning-session scoping (recoverPersistedTimers with a session id)", () => {
  it("REPRODUCER: foreign record overdue at load is not delivered into the current session", () => {
    process.chdir(tmp);
    const current = "sess-current-fresh";
    const foreign = {
      id: "t-ghost",
      sessionId: "sess-ghost-old",
      firesAt: Date.now() - 5000,
      reason: "old cadence",
      tag: "periodic-status",
      createdAt: Date.now() - 3600000,
      wake: true,
      intervalMs: 1800000,
      count: 100000,
      fires: 40,
    };
    writeTimerFile([foreign]);
    const pi = makeFakePi();

    recoverPersistedTimers(pi, current);

    assert.equal(
      wakeRetryQueue.deferredRecoveredCount(),
      0,
      "foreign overdue fire must not be parked for delivery into this process",
    );
    assert.equal(
      timerManager.listTimers("sess-ghost-old").length,
      0,
      "foreign record must not be re-armed into memory",
    );
    assert.equal(
      timerManager.listTimers(current).length,
      0,
      "nothing restored for the current session",
    );
    assert.equal(pi.sent.length, 0, "no direct delivery either");
    const onDisk = readTimerFile();
    assert.equal(onDisk.length, 1, "young foreign record stays on disk (owner may still be live)");
    assert.equal(onDisk[0].id, "t-ghost", "foreign record id untouched");
    assert.equal(onDisk[0].fires, 40, "foreign record cadence untouched");
  });

  it("same-session overdue record is still recovered through the scoped call", () => {
    process.chdir(tmp);
    const current = "sess-current-fresh";
    const own = {
      id: "t-own",
      sessionId: current,
      firesAt: Date.now() - 5000,
      reason: "my cadence",
      tag: "periodic-status",
      createdAt: Date.now() - 3600000,
      wake: true,
      intervalMs: 1800000,
      count: 100000,
      fires: 3,
    };
    writeTimerFile([own]);
    const pi = makeFakePi();

    recoverPersistedTimers(pi, current);

    assert.equal(
      wakeRetryQueue.deferredRecoveredCount(),
      1,
      "own fire parked for post-settle flush",
    );
    const live = timerManager.listTimers(current);
    assert.equal(live.length, 1, "recurrence re-armed for the owning session");
    assert.equal(live[0].fires, 4, "fires counter advanced");
    assert.equal(readTimerFile()[0].fires, 4, "disk carries the advanced counter");
  });

  it("foreign record from a provably dead session is pruned (overdue + owner inactive)", () => {
    process.chdir(tmp);
    const current = "sess-current-fresh";
    // Owner silent in the session store far beyond the inactivity window,
    // record overdue far beyond the servicing grace: the owner had every
    // poll to service this fire and never did — it is gone.
    writeSessionFile("sess-ghost-old", FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS * 2);
    const zombie = {
      id: "t-zombie",
      sessionId: "sess-ghost-old",
      firesAt: Date.now() - FOREIGN_TIMER_PRUNE_OVERDUE_MS * 4,
      reason: "dead session cadence",
      tag: "periodic-status",
      createdAt: Date.now() - FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS * 4,
      wake: true,
      intervalMs: 1800000,
      count: 100000,
      fires: 9,
    };
    writeTimerFile([zombie]);
    const pi = makeFakePi();

    recoverPersistedTimers(pi, current);

    assert.equal(wakeRetryQueue.deferredRecoveredCount(), 0, "zombie fire is not delivered");
    assert.deepEqual(readTimerFile(), [], "zombie record pruned from the store");
    assert.equal(timerManager.listTimers("sess-ghost-old").length, 0, "nothing re-armed");
  });

  it("foreign overdue record from a live sibling session is kept untouched", () => {
    process.chdir(tmp);
    const current = "sess-current-fresh";
    // A live sibling (session file freshly written) may be busy mid-tool:
    // its poller defers the overdue fire, so the record can sit overdue far
    // beyond the servicing grace. The fresh session-store activity proves
    // the owner is alive — its record must survive byte-identical.
    writeSessionFile("sess-sibling-live", 0);
    const sibling = {
      id: "t-sibling",
      sessionId: "sess-sibling-live",
      firesAt: Date.now() - FOREIGN_TIMER_PRUNE_OVERDUE_MS * 4,
      reason: "sibling cadence",
      tag: "periodic-status",
      createdAt: Date.now() - 7200000,
      wake: true,
      intervalMs: 1800000,
      count: 100000,
      fires: 12,
    };
    writeTimerFile([sibling]);
    const pi = makeFakePi();

    recoverPersistedTimers(pi, current);

    assert.equal(wakeRetryQueue.deferredRecoveredCount(), 0, "sibling fire is not delivered here");
    assert.equal(timerManager.listTimers("sess-sibling-live").length, 0, "not re-armed here");
    const onDisk = readTimerFile();
    assert.equal(onDisk.length, 1, "live sibling's record survives");
    assert.equal(onDisk[0].id, "t-sibling", "id untouched");
    assert.equal(onDisk[0].fires, 12, "cadence untouched");
    assert.equal(onDisk[0].firesAt, sibling.firesAt, "fire time untouched");
  });

  it("foreign UNexpired record is kept even when the owner looks dead", () => {
    process.chdir(tmp);
    const current = "sess-current-fresh";
    // An unexpired record may still be serviced by its owner when it
    // returns — pruning it would kill a future wake. Only overdue records
    // (past the servicing grace) are prunable.
    writeSessionFile("sess-ghost-old", FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS * 2);
    const future = {
      id: "t-future",
      sessionId: "sess-ghost-old",
      firesAt: Date.now() + 3600000,
      reason: "future wake",
      tag: "morning-report",
      createdAt: Date.now() - FOREIGN_TIMER_PRUNE_OWNER_INACTIVITY_MS * 2,
      wake: true,
      intervalMs: 86400000,
      count: 7,
      fires: 1,
    };
    writeTimerFile([future]);
    const pi = makeFakePi();

    recoverPersistedTimers(pi, current);

    assert.equal(wakeRetryQueue.deferredRecoveredCount(), 0);
    const onDisk = readTimerFile();
    assert.equal(onDisk.length, 1, "unexpired foreign record kept");
    assert.equal(onDisk[0].id, "t-future");
    assert.equal(timerManager.listTimers("sess-ghost-old").length, 0, "not re-armed into memory");
  });

  it("legacy one-shot record (no intervalMs) parses and stays scoped", () => {
    process.chdir(tmp);
    const current = "sess-current-fresh";
    // Backward-compatible shape: a plain one-shot with no intervalMs field.
    const legacyForeign = {
      id: "t-legacy-foreign",
      sessionId: "sess-ghost-old",
      firesAt: Date.now() - 5000,
      reason: "old one-shot",
      createdAt: Date.now() - 60000,
      wake: true,
    };
    const legacyOwn = {
      id: "t-legacy-own",
      sessionId: current,
      firesAt: Date.now() - 5000,
      reason: "own one-shot",
      createdAt: Date.now() - 60000,
      wake: true,
    };
    writeTimerFile([legacyForeign, legacyOwn]);
    const pi = makeFakePi();

    recoverPersistedTimers(pi, current);

    assert.equal(wakeRetryQueue.deferredRecoveredCount(), 1, "only the own one-shot parks");
    assert.equal(
      timerManager.listTimers("sess-ghost-old").length,
      0,
      "foreign one-shot not re-armed",
    );
    const onDisk = readTimerFile();
    assert.equal(onDisk.length, 1, "young foreign one-shot stays on disk");
    assert.equal(onDisk[0].id, "t-legacy-foreign");
  });

  it("legacy call signature (no session id) keeps the unscoped sweep", () => {
    process.chdir(tmp);
    const own = {
      id: "t-direct",
      sessionId: "sess-direct",
      firesAt: Date.now() - 5000,
      reason: "direct surface",
      tag: "periodic-status",
      createdAt: Date.now() - 3600000,
      wake: true,
      intervalMs: 1800000,
      count: 100000,
      fires: 2,
    };
    writeTimerFile([own]);
    timerManager.clearSession("sess-direct");
    const pi = makeFakePi();

    // Session id unknown (direct/test surface): the legacy sweep applies —
    // production callers always pass the owning session id.
    recoverPersistedTimers(pi);

    assert.equal(wakeRetryQueue.deferredRecoveredCount(), 1, "legacy sweep still recovers");
    assert.equal(timerManager.listTimers("sess-direct").length, 1, "legacy sweep still re-arms");
  });
});
