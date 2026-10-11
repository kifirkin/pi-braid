/**
 * Regression test: persisted-timer recovery must not stack or double-fire.
 *
 * pending-timers.jsonl accumulated 5
 * periodic-status timers across 3 sessions, and a single session carried
 * BOTH the original (fires:0, expired) and the re-armed copy (fires:20, live)
 * of the same logical timer. Two defects in recoverPersistedTimers
 * (src/extensions/core/prompt-builder/index.ts):
 *
 * 1. NO DEDUP BY TAG: every stacked copy was re-armed, so the original AND
 * the re-armed copy both fired (double delivery).
 * 2. RE-ARM OF A STILL-LIVE TIMER: recovery runs once per before_agent_start
 * (every turn); restoreTimer() always creates a NEW in-memory timer, so
 * a timer already live in the manager got a duplicate that ALSO fired.
 *
 * Fix:
 * - dedupPersistedTimers collapses stacked (sessionId, tag) copies to the
 * newest (max createdAt, tiebreak max firesAt) BEFORE any fire/re-arm.
 * - hasLiveEquivalent skips fire/re-arm for a timer the poller already owns
 * (same session + tag for tagged timers, same id for untagged).
 *
 * Run: node test/runtime/lib/test-timer-recovery.mjs
 */

import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const { recoverPersistedTimers, dedupPersistedTimers, hasLiveEquivalent } =
  await import("../../../dist/extensions/core/prompt-builder/index.js");
const { timerManager } = await import("../../../dist/extensions/scheduling/timer/index.js");
const { wakeRetryQueue, flushRecoveredFires } =
  await import("../../../dist/extensions/scheduling/timer/wake-retry.js");
const { getTimerFilePath } = await import("../../../dist/lib/config/braid-paths.js");

// ── Fixtures ───────────────────────────────────────────────────────────────

const originalCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "braid-timer-recovery-"));
// Pin braid's persistent tree into a private tmpdir: fixture timers must
// never write the live store (braidDir() honors BRAID_HOME per call).
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-timer-home-recovery-"));
process.env.BRAID_HOME = BRAID_HOME;

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
  const raw = readFileSync(file, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").map((l) => JSON.parse(l));
}

after(() => {
  // Restore cwd and remove the temp project dir under ~/.pi/agent/braid/projects.
  // Compute the path while cwd is still the temp dir: macOS reports the cwd
  // as /private/var/... (symlink-resolved), which sanitizes differently from
  // the literal /var/... tmp string.
  const file = getTimerFilePath(process.cwd());
  process.chdir(originalCwd);
  try {
    rmSync(dirname(file), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

afterEach(() => {
  wakeRetryQueue.resetForTests();
});

describe("dedupPersistedTimers (stacked copies collapse)", () => {
  it("keeps the newest copy per (session, tag) — later firesAt wins on equal createdAt", () => {
    const base = { sessionId: "s1", tag: "periodic-status", createdAt: 1000, id: "x" };
    const stale = { ...base, id: "stale", fires: 0, firesAt: 2000 };
    const live = { ...base, id: "live", fires: 20, firesAt: 9000 };
    const out = dedupPersistedTimers([stale, live]);
    assert.deepEqual(
      out.map((t) => t.id),
      ["live"],
      "stale duplicate dropped, live copy kept",
    );
  });

  it("keeps the newest copy per (session, tag) — later createdAt wins", () => {
    const out = dedupPersistedTimers([
      { id: "old", sessionId: "s1", tag: "periodic-status", createdAt: 1000, firesAt: 5000 },
      { id: "new", sessionId: "s1", tag: "periodic-status", createdAt: 2000, firesAt: 5000 },
    ]);
    assert.deepEqual(
      out.map((t) => t.id),
      ["new"],
    );
  });

  it("does NOT dedup across sessions (timers are session-scoped)", () => {
    const out = dedupPersistedTimers([
      { id: "a", sessionId: "s1", tag: "periodic-status", createdAt: 1000, firesAt: 5000 },
      { id: "b", sessionId: "s2", tag: "periodic-status", createdAt: 2000, firesAt: 5000 },
    ]);
    assert.deepEqual(
      out.map((t) => t.id),
      ["a", "b"],
      "one per session survives",
    );
  });

  it("does NOT dedup different tags or untagged timers", () => {
    const out = dedupPersistedTimers([
      { id: "a", sessionId: "s1", tag: "periodic-status", createdAt: 1000, firesAt: 5000 },
      { id: "b", sessionId: "s1", tag: "babysit", createdAt: 1000, firesAt: 5000 },
      { id: "c", sessionId: "s1", createdAt: 1000, firesAt: 5000 },
      { id: "d", sessionId: "s1", createdAt: 1000, firesAt: 5000 },
    ]);
    assert.deepEqual(
      out.map((t) => t.id),
      ["a", "b", "c", "d"],
      "distinct timers untouched",
    );
  });

  it("returns the input unchanged when nothing is stacked", () => {
    const input = [{ id: "a", sessionId: "s1", tag: "t", createdAt: 1, firesAt: 2 }];
    assert.equal(dedupPersistedTimers(input), input);
  });
});

describe("hasLiveEquivalent (poller already owns the timer)", () => {
  it("true for a tagged timer live in the same session", () => {
    timerManager.clearSession("s1");
    timerManager.setTimer("s1", 100000, "r", "periodic-status", true, 1000);
    assert.equal(hasLiveEquivalent({ sessionId: "s1", tag: "periodic-status", id: "x" }), true);
    assert.equal(
      hasLiveEquivalent({ sessionId: "s2", tag: "periodic-status", id: "x" }),
      false,
      "different session is not live here",
    );
    assert.equal(
      hasLiveEquivalent({ sessionId: "s1", tag: "other", id: "x" }),
      false,
      "different tag is not the same timer",
    );
    timerManager.clearSession("s1");
  });

  it("true for an untagged timer by id (distinct untagged timers)", () => {
    timerManager.clearSession("s1");
    const id = timerManager.setTimer("s1", 100000, "one");
    assert.equal(hasLiveEquivalent({ sessionId: "s1", id }), true);
    assert.equal(hasLiveEquivalent({ sessionId: "s1", id: "not-live" }), false);
    timerManager.clearSession("s1");
  });
});

describe("recoverPersistedTimers end-to-end", () => {
  it("REGRESSION: stacked duplicate + live equivalent → stale dropped, live not re-armed, nothing double-fires", () => {
    process.chdir(tmp);
    const sid = "s1";
    timerManager.clearSession(sid);
    // The poller already owns a live periodic-status timer for this session.
    timerManager.setTimer(sid, 100000, "periodic", "periodic-status", true, 1800000, 100000, 20);
    const createdAt = Date.now() - 1000;
    const stale = {
      id: "stale-0",
      sessionId: sid,
      firesAt: Date.now() - 60000,
      reason: "periodic",
      tag: "periodic-status",
      createdAt,
      wake: true,
      intervalMs: 1800000,
      count: 100000,
      fires: 0,
    };
    const live = {
      id: "live-20",
      sessionId: sid,
      firesAt: Date.now() + 60000,
      reason: "periodic",
      tag: "periodic-status",
      createdAt,
      wake: true,
      intervalMs: 1800000,
      count: 100000,
      fires: 20,
    };
    writeTimerFile([stale, live]);
    const pi = makeFakePi();
    recoverPersistedTimers(pi);

    assert.deepEqual(
      readTimerFile().map((t) => t.id),
      ["live-20"],
      "stale expired duplicate is dropped from disk (dedup), live copy kept",
    );
    assert.equal(pi.sent.length, 0, "nothing fired — the stale duplicate must not double-deliver");
    assert.equal(
      timerManager.listTimers(sid).length,
      1,
      "no duplicate re-arm in the manager (live equivalent skipped)",
    );
  });

  it("REGRESSION: running every turn does not stack duplicates of a live timer", () => {
    process.chdir(tmp);
    const sid = "s2";
    timerManager.clearSession(sid);
    const t = {
      id: "t1",
      sessionId: sid,
      firesAt: Date.now() + 60000,
      reason: "r",
      tag: "periodic-status",
      createdAt: Date.now(),
      wake: true,
      intervalMs: 1800000,
      count: 100000,
      fires: 10,
    };
    writeTimerFile([t]);
    const pi = makeFakePi();
    recoverPersistedTimers(pi); // turn 1: no live equivalent yet → re-arm
    const afterFirst = timerManager.listTimers(sid).length;
    recoverPersistedTimers(pi); // turn 2: live equivalent exists → skip
    const afterSecond = timerManager.listTimers(sid).length;

    assert.equal(afterFirst, 1, "first recovery re-arms the persisted timer");
    assert.equal(afterSecond, 1, "second recovery must NOT duplicate the live timer");
  });

  it("unexpired timer with no live equivalent is re-armed (restart path)", () => {
    process.chdir(tmp);
    const sid = "s3";
    timerManager.clearSession(sid);
    const t = {
      id: "t1",
      sessionId: sid,
      firesAt: Date.now() + 60000,
      reason: "r",
      tag: "periodic-status",
      createdAt: Date.now(),
      wake: true,
      intervalMs: 1800000,
      count: 100000,
      fires: 5,
    };
    writeTimerFile([t]);
    const pi = makeFakePi();
    recoverPersistedTimers(pi);

    const live = timerManager.listTimers(sid);
    assert.equal(live.length, 1, "re-armed into the manager");
    assert.equal(live[0].tag, "periodic-status");
    assert.equal(live[0].fires, 5, "mid-cadence fires counter preserved");
    assert.equal(pi.sent.length, 0, "unexpired → not fired");
    const onDisk = readTimerFile();
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].id, live[0].id, "disk entry rewritten with the new in-memory id");
  });

  it("expired recurring timer with no live equivalent defers the overdue tick and re-arms", async () => {
    process.chdir(tmp);
    const sid = "s4";
    timerManager.clearSession(sid);
    const t = {
      id: "t1",
      sessionId: sid,
      firesAt: Date.now() - 5000,
      reason: "r",
      tag: "periodic-status",
      createdAt: Date.now() - 3600000,
      wake: true,
      intervalMs: 1800000,
      count: 100000,
      fires: 3,
    };
    writeTimerFile([t]);
    const pi = makeFakePi();
    recoverPersistedTimers(pi);

    // recovery must NOT deliver inline (competing-turn window) — the
    // fire is parked and flushed post-settle by flushRecoveredFires.
    assert.equal(pi.sent.length, 0, "no inline delivery in before_agent_start");
    assert.equal(wakeRetryQueue.deferredRecoveredCount(), 1, "fire parked for post-settle flush");
    const live = timerManager.listTimers(sid);
    assert.equal(live.length, 1, "recurrence re-armed after the overdue fire");
    assert.equal(live[0].fires, 4, "fires counter advanced");
    const onDisk = readTimerFile();
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].fires, 4, "disk carries the advanced counter");

    flushRecoveredFires(pi);
    await new Promise((r) => setTimeout(r, 0)); // triggerTurn send is deferred (macrotask)
    assert.equal(pi.sent.length, 1, "overdue tick delivered post-settle");
    assert.equal(
      pi.sent[0].options.triggerTurn,
      true,
      "wake:true recovered fire starts its own post-settle turn",
    );
  });

  it("untagged timers are distinct — never deduped, both re-armed", () => {
    process.chdir(tmp);
    const sid = "s5";
    timerManager.clearSession(sid);
    const a = {
      id: "a1",
      sessionId: sid,
      firesAt: Date.now() + 60000,
      reason: "one",
      createdAt: Date.now(),
      wake: true,
    };
    const b = {
      id: "a2",
      sessionId: sid,
      firesAt: Date.now() + 120000,
      reason: "two",
      createdAt: Date.now(),
      wake: true,
    };
    writeTimerFile([a, b]);
    const pi = makeFakePi();
    recoverPersistedTimers(pi);

    assert.equal(timerManager.listTimers(sid).length, 2, "both untagged timers re-armed");
    assert.equal(readTimerFile().length, 2);
  });
});
