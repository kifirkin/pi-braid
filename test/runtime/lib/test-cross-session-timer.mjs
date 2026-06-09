/**
 * Regression test for the cross-session timer cancellation bug.
 *
 * Bug: TimerManager was a module-level singleton with one Map<string, ScheduledTimer>.
 * When session A called cancelTimersByTag("compaction-resume"), it cancelled
 * session B's resume timer too — because the tag scan was global.
 *
 * Fix: TimerManager is now Map<sessionId, Map<id, timer>>. Every operation
 * takes a sessionId and scopes to that session. The poller is per-pi.
 *
 * This test schedules timers in two simulated sessions and verifies
 * cancellation in one does NOT affect the other. It also verifies
 * clearSessionTimers doesn't leak across sessions.
 */

import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../../");

let passed = 0, failed = 0;
const assert = (cond, msg) =>
  cond ? (passed++, console.log("  ✅ " + msg)) : (failed++, console.log("  ❌ " + msg));

const distPath = join(ROOT, "dist/extensions/tools/timer/index.js");
if (!existsSync(distPath)) {
  console.error("❌ dist file missing — run `npm run build` first");
  process.exit(1);
}

const {
  scheduleTimer,
  cancelTimer,
  cancelTimersByTag,
  listTimers,
  clearSessionTimers,
} = await import(distPath);

const SESSION_A = "test-session-A-" + Math.random().toString(36).slice(2, 8);
const SESSION_B = "test-session-B-" + Math.random().toString(36).slice(2, 8);
const SESSION_C = "test-session-C-" + Math.random().toString(36).slice(2, 8);

// Clean slate
clearSessionTimers(SESSION_A);
clearSessionTimers(SESSION_B);
clearSessionTimers(SESSION_C);

// ── [1] Schedule timers in 3 sessions, verify isolation on list ──────
console.log("\n[1] listTimers is per-session");
{
  scheduleTimer(SESSION_A, 60_000, "A1", "compaction-resume");
  scheduleTimer(SESSION_A, 60_000, "A2", "user-task");
  scheduleTimer(SESSION_B, 60_000, "B1", "compaction-resume");
  scheduleTimer(SESSION_B, 60_000, "B2", "auto-compaction-resume");
  scheduleTimer(SESSION_C, 60_000, "C1", "user-task");

  const a = listTimers(SESSION_A);
  const b = listTimers(SESSION_B);
  const c = listTimers(SESSION_C);

  assert(a.length === 2, `SESSION_A has 2 timers (got ${a.length})`);
  assert(b.length === 2, `SESSION_B has 2 timers (got ${b.length})`);
  assert(c.length === 1, `SESSION_C has 1 timer (got ${c.length})`);
  assert(
    a.every((t) => t.sessionId === SESSION_A),
    "SESSION_A timers have sessionId=A",
  );
  assert(
    b.every((t) => t.sessionId === SESSION_B),
    "SESSION_B timers have sessionId=B",
  );
}

// ── [2] cancelTimersByTag in session A doesn't touch B's timers ──────
console.log("\n[2] cancelTimersByTag is per-session (the original bug)");
{
  // Reset state for clarity
  clearSessionTimers(SESSION_A);
  clearSessionTimers(SESSION_B);
  clearSessionTimers(SESSION_C);

  // Session A has 2 resume timers + 1 user timer
  scheduleTimer(SESSION_A, 60_000, "A-resume-1", "compaction-resume");
  scheduleTimer(SESSION_A, 60_000, "A-resume-2", "compaction-resume");
  scheduleTimer(SESSION_A, 60_000, "A-user", "user-task");

  // Session B has 1 resume timer
  scheduleTimer(SESSION_B, 60_000, "B-resume-1", "compaction-resume");
  scheduleTimer(SESSION_B, 60_000, "B-user", "user-task");

  // Session A cancels its compaction-resume timers
  const cancelled = cancelTimersByTag(SESSION_A, "compaction-resume");
  assert(cancelled === 2, `SESSION_A cancelled 2 of its own resume timers (got ${cancelled})`);

  // Session A should now have just the user timer
  const aRemaining = listTimers(SESSION_A);
  assert(aRemaining.length === 1, `SESSION_A has 1 timer left (got ${aRemaining.length})`);
  assert(
    aRemaining[0].tag === "user-task",
    "SESSION_A's remaining timer is the user-task one",
  );

  // CRITICAL: Session B's resume timer must still be there
  const bRemaining = listTimers(SESSION_B);
  assert(bRemaining.length === 2, `SESSION_B's 2 timers are UNTOUCHED (got ${bRemaining.length})`);
  assert(
    bRemaining.some((t) => t.tag === "compaction-resume"),
    "SESSION_B's compaction-resume timer survives A's cancellation",
  );
  assert(
    bRemaining.some((t) => t.tag === "user-task"),
    "SESSION_B's user-task timer survives A's cancellation",
  );
}

// ── [3] cancelTimersByTag on one session doesn't affect another even with shared tag ─
console.log("\n[3] Cross-session cancellation isolation with same tag");
{
  clearSessionTimers(SESSION_A);
  clearSessionTimers(SESSION_B);

  scheduleTimer(SESSION_A, 60_000, "A-tag-1", "shared-tag");
  scheduleTimer(SESSION_A, 60_000, "A-tag-2", "shared-tag");
  scheduleTimer(SESSION_B, 60_000, "B-tag-1", "shared-tag");
  scheduleTimer(SESSION_B, 60_000, "B-tag-2", "shared-tag");
  scheduleTimer(SESSION_B, 60_000, "B-tag-3", "shared-tag");

  const cancelled = cancelTimersByTag(SESSION_A, "shared-tag");
  assert(cancelled === 2, `SESSION_A cancelled 2 of its shared-tag timers (got ${cancelled})`);

  const bRemaining = listTimers(SESSION_B);
  assert(
    bRemaining.length === 3,
    `SESSION_B still has all 3 shared-tag timers (got ${bRemaining.length})`,
  );
}

// ── [4] clearSessionTimers only touches its own session ──────────────
console.log("\n[4] clearSessionTimers is per-session");
{
  clearSessionTimers(SESSION_A);
  clearSessionTimers(SESSION_B);
  clearSessionTimers(SESSION_C);

  scheduleTimer(SESSION_A, 60_000, "A1");
  scheduleTimer(SESSION_B, 60_000, "B1");
  scheduleTimer(SESSION_B, 60_000, "B2");
  scheduleTimer(SESSION_C, 60_000, "C1");

  const cleared = clearSessionTimers(SESSION_B);
  assert(cleared === 2, `clearSessionTimers(B) returned 2 (got ${cleared})`);

  const a = listTimers(SESSION_A);
  const b = listTimers(SESSION_B);
  const c = listTimers(SESSION_C);

  assert(a.length === 1, `SESSION_A's 1 timer is preserved (got ${a.length})`);
  assert(b.length === 0, `SESSION_B is now empty (got ${b.length})`);
  assert(c.length === 1, `SESSION_C's 1 timer is preserved (got ${c.length})`);
}

// ── [5] cancelTimer (by id) is also per-session ─────────────────────
console.log("\n[5] cancelTimer (by id) is per-session");
{
  clearSessionTimers(SESSION_A);
  clearSessionTimers(SESSION_B);

  // Schedule with the same id-prefix but different sessions
  const aId = scheduleTimer(SESSION_A, 60_000, "task-A");
  const bId = scheduleTimer(SESSION_B, 60_000, "task-B");

  // Try to cancel A's timer from B's session — should return false
  const wrong = cancelTimer(SESSION_B, aId);
  assert(wrong === false, "cancelTimer(B, aId) returns false (aId is in A, not B)");

  // A's timer must still be there
  assert(
    listTimers(SESSION_A).some((t) => t.id === aId),
    "SESSION_A's timer is not affected by B's wrong cancel",
  );

  // Cancel B's timer correctly
  const right = cancelTimer(SESSION_B, bId);
  assert(right === true, "cancelTimer(B, bId) returns true (correct session)");
}

// ── [6] Cancelling in unknown session is safe (no throw) ─────────────
console.log("\n[6] Defensive: unknown session is a no-op");
{
  const cancelled = cancelTimersByTag("never-scheduled-session", "any-tag");
  assert(cancelled === 0, "cancelTimersByTag on unknown session returns 0");

  const list = listTimers("never-scheduled-session");
  assert(list.length === 0, "listTimers on unknown session returns []");

  const clearN = clearSessionTimers("never-scheduled-session");
  assert(clearN === 0, "clearSessionTimers on unknown session returns 0");
}

// Cleanup
clearSessionTimers(SESSION_A);
clearSessionTimers(SESSION_B);
clearSessionTimers(SESSION_C);

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
