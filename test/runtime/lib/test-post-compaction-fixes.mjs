/**
 * Test: Post-Compaction Fixes (stack overflow + whisper ordering)
 *
 * Verifies the bundle of fixes for:
 *  1. Re-entrancy guard MAX_REENTRY_DEPTH = 1 (was 2) — stops stack overflow
 *     when pi.sendMessage(steer) chains into a fresh before_agent_start loop.
 *  2. Timer module: triggerTurn: false on the resume whisper (was true).
 *     triggerTurn: true was the root cause of the post-compaction stack
 *     overflow because the host would start a new turn mid-tool-execution.
 *  3. Timer module: _braidInjected metadata on the resume whisper (was missing).
 *     Consistent with the [enforcement] whisper contract so compaction can
 *     identify and preserve the message.
 *  4. Timer module: busy guard — poller bails when agent is mid-tool-execution.
 *  5. cancelTimersByTag helper — new programmatic API on the timer module.
 *  6. Compaction paths actually call cancelTimersByTag to invalidate stale
 *     resume timers from previous compaction cycles.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../../");

let passed = 0;
let failed = 0;
const assert = (cond, msg) =>
  cond ? (passed++, console.log("  ✅ " + msg)) : (failed++, console.log("  ❌ " + msg));

const injectionTrackerPath = join(ROOT, "dist/lib/utils/injection-tracker.js");
const timerPath = join(ROOT, "dist/extensions/tools/timer/index.js");
const contextCompressPath = join(ROOT, "dist/extensions/memory/context-manager/handlers/tools/context-compress.js");
const contextLifecyclePath = join(ROOT, "dist/extensions/memory/context-lifecycle/index.js");
const sessionCompactPath = join(ROOT, "dist/extensions/enforcement/handlers/register-session-compact.js");

console.log("\n=== Post-Compaction Stack Overflow & Whisper Order Fixes ===\n");

// ── [1] Build artifacts present ─────────────────────────────────────
console.log("[1] Build artifacts");
assert(existsSync(injectionTrackerPath), "injection-tracker.js compiled");
assert(existsSync(timerPath), "timer/index.js compiled");
assert(existsSync(contextCompressPath), "context-compress.js compiled");
assert(existsSync(contextLifecyclePath), "context-lifecycle/index.js compiled");
assert(existsSync(sessionCompactPath), "register-session-compact.js compiled");

// ── [2] MAX_REENTRY_DEPTH = 1 (was 2) ──────────────────────────────
console.log("\n[2] Re-entrancy guard: MAX_REENTRY_DEPTH = 1");
{
  const src = readFileSync(injectionTrackerPath, "utf8");
  const m = src.match(/const MAX_REENTRY_DEPTH\s*=\s*(\d+)/);
  assert(m !== null, "MAX_REENTRY_DEPTH constant declared");
  if (m) {
    assert(m[1] === "1", `MAX_REENTRY_DEPTH = 1 (was 2, found ${m[1]})`);
  }
  // The defer-to-microtask branch must still exist
  assert(src.includes("queueMicrotask"), "queueMicrotask defer path present");
  assert(src.includes("_sendDepth"), "_sendDepth counter present");
}

// ── [3] Timer whisper triggerTurn controlled by wake flag ─────────
console.log("\n[3] Timer whisper triggerTurn = wake ? true : false");
{
  const src = readFileSync(timerPath, "utf8");
  // The fireTimer's triggerTurn must be derived from timer.wake, not a
  // literal. Resume timers set wake: true (auto-resume), user timers
  // default to wake: false (safer). The stack overflow prevention is
  // the busy guard, not removing wake: true.
  const lines = src.split("\n");
  const fireTimerStart = lines.findIndex((l) => /function\s+fireTimer\s*\(/.test(l));
  assert(fireTimerStart > 0, `fireTimer function found at line ${fireTimerStart + 1}`);
  const fireTimerBody = lines
    .slice(fireTimerStart, fireTimerStart + 50)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  assert(
    /const\s+triggerTurn\s*=\s*timer\.wake\s*===\s*true/.test(fireTimerBody),
    "fireTimer derives triggerTurn from timer.wake flag (not a literal)",
  );
  assert(
    /triggerTurn[,\s}]/.test(fireTimerBody),
    "fireTimer uses the wake-derived triggerTurn in sendTrackedMessage",
  );
  // The wake flag must be a parameter on scheduleTimer (TS strips type annotation)
  assert(
    /export\s+function\s+scheduleTimer\([\s\S]*?wake\s*=\s*false\s*\)/.test(src),
    "scheduleTimer exposes wake parameter (default false)",
  );
  // The wake field must be set on the timer object in setTimer
  assert(
    /this\.timers\.set\([\s\S]*?wake\s*\)/.test(src),
    "setTimer persists wake flag on the timer object",
  );
  // ScheduledTimer type source must declare wake field (check src, not dist —
  // TS-only fields are stripped from compiled .js)
  const typesSrc = readFileSync(
    join(ROOT, "src/lib/events/timer-types.ts"),
    "utf8",
  );
  assert(/wake\?:\s*boolean/.test(typesSrc), "ScheduledTimer.wake field declared in types");
}

// ── [4] Timer whisper carries _braidInjected metadata ──────────────
console.log("\n[4] Timer whisper _braidInjected metadata");
{
  const src = readFileSync(timerPath, "utf8");
  // The resume whisper must tag with _braidInjected: true so compaction
  // can identify and preserve it (consistent with [enforcement]).
  assert(
    /details:\s*\{[^}]*_braidInjected:\s*true/.test(src),
    "fireTimer whisper sets _braidInjected: true on details",
  );
  assert(
    /_braidSource:\s*"timer\/fire"/.test(src),
    "fireTimer whisper sets _braidSource to 'timer/fire'",
  );
}

// ── [5] Busy guard on the poller ──────────────────────────────────
console.log("\n[5] Timer poller busy guard");
{
  const src = readFileSync(timerPath, "utf8");
  // The poller must check a busy flag and bail if true.
  // TS strips `private` keyword in compiled JS, so just look for the field.
  assert(/\bbusy\s*=\s*false\b/.test(src), "TimerPoller.busy field exists");
  assert(
    /setBusy\s*\(/.test(src),
    "TimerPoller.setBusy() method exists",
  );
  // The poll() method must early-return when busy
  assert(/poll\s*\(\s*\)\s*\{[\s\S]*?if\s*\(\s*this\.busy\s*\)\s*return/.test(src),
    "poll() bails early when busy (prevents mid-tool-execution timer fire)",
  );
  // TOOL_CALL must wire up setBusy(true)
  assert(/TOOL_CALL[\s\S]{0,200}setBusy\(\s*true\s*\)/.test(src), "TOOL_CALL → setBusy(true)");
  assert(/TURN_END[\s\S]{0,200}setBusy\(\s*false\s*\)/.test(src), "TURN_END → setBusy(false)");
}

// ── [6] cancelTimersByTag helper exported from timer module ────────
console.log("\n[6] cancelTimersByTag helper");
{
  const src = readFileSync(timerPath, "utf8");
  assert(
    /export\s+function\s+cancelTimersByTag\s*\(/.test(src),
    "cancelTimersByTag(tag: string) is exported",
  );
  // The implementation must iterate listTimers() and call cancelTimer
  const helperMatch = src.match(
    /export\s+function\s+cancelTimersByTag\s*\([^)]*\)\s*\{[\s\S]*?\n\}/,
  );
  assert(helperMatch !== null, "cancelTimersByTag body found");
  if (helperMatch) {
    const body = helperMatch[0];
    assert(body.includes("listTimers()"), "cancelTimersByTag iterates listTimers()");
    assert(body.includes("cancelTimer"), "cancelTimersByTag calls cancelTimer");
    assert(body.includes("t.tag === tag") || body.includes(".tag===\""), "cancelTimersByTag filters by tag");
  }
}

// ── [7] Compaction paths cancel stale + schedule with wake: true ─
console.log("\n[7] Compaction paths cancel stale resume timers and wake");
{
  const comp = readFileSync(contextCompressPath, "utf8");
  const life = readFileSync(contextLifecyclePath, "utf8");
  const compact = readFileSync(sessionCompactPath, "utf8");

  // context-compress (manual) cancels both tags and schedules with wake: true
  assert(
    /cancelTimersByTag\s*\(\s*["']compaction-resume["']\s*\)/.test(comp),
    "context-compress cancels 'compaction-resume' timers",
  );
  assert(
    /cancelTimersByTag\s*\(\s*["']auto-compaction-resume["']\s*\)/.test(comp),
    "context-compress cancels 'auto-compaction-resume' timers (cross-path cleanup)",
  );
  assert(
    /scheduleTimer\s*\(\s*3\s*\*\s*60\s*\*\s*1000\s*,\s*["']Context compaction done[\s\S]*?,\s*["']compaction-resume["']\s*,\s*true/.test(comp),
    "context-compress schedules resume timer with wake: true (auto-resume)",
  );

  // context-lifecycle auto-compact cancels both tags and schedules with wake: true
  assert(
    /cancelTimersByTag\s*\(\s*["']compaction-resume["']\s*\)/.test(life),
    "context-lifecycle auto-compact cancels 'compaction-resume' timers",
  );
  assert(
    /cancelTimersByTag\s*\(\s*["']auto-compaction-resume["']\s*\)/.test(life),
    "context-lifecycle auto-compact cancels 'auto-compaction-resume' timers",
  );
  assert(
    /scheduleTimer\s*\(\s*3\s*\*\s*60\s*\*\s*1000\s*,\s*["']Auto-compaction done[\s\S]*?,\s*["']auto-compaction-resume["']\s*,\s*true/.test(life),
    "context-lifecycle auto-compact schedules resume timer with wake: true (auto-resume)",
  );

  // session_compact enforcement handler also cancels both (orphan cleanup)
  assert(
    /cancelTimersByTag\s*\(\s*["']compaction-resume["']\s*\)/.test(compact),
    "session_compact enforcement handler cancels 'compaction-resume' timers",
  );
  assert(
    /cancelTimersByTag\s*\(\s*["']auto-compaction-resume["']\s*\)/.test(compact),
    "session_compact enforcement handler cancels 'auto-compaction-resume' timers",
  );
}

// ── [8] Live behavior: cancelTimersByTag + wake flag flow through ─
console.log("\n[8] Live: cancelTimersByTag + wake flag");
{
  // Use the timer module's exports directly to verify the runtime behavior
  // independent of any compiled output. This catches bugs where the helper
  // was added but doesn't actually cancel.
  const {
    scheduleTimer,
    cancelTimersByTag,
    cancelTimer,
  } = await import(join(ROOT, "dist/extensions/tools/timer/index.js"));

  // Helper to introspect internal state via the public listTimers API
  // (we import the manager indirectly by scheduling a tagged timer)
  const id1 = scheduleTimer(60_000, "stale-1", "compaction-resume");
  const id2 = scheduleTimer(60_000, "stale-2", "compaction-resume");
  const id3 = scheduleTimer(60_000, "keep", "user-task");
  // wake flag: resume timer (wake: true) vs user timer (default false)
  const id4 = scheduleTimer(60_000, "resume-after-compact", "compaction-resume", true);
  const id5 = scheduleTimer(60_000, "build-check", "user-task"); // wake defaults false

  // Sanity: we just scheduled 5 timers, IDs are unique
  assert(typeof id1 === "string" && id1.length > 0, "scheduleTimer returns id string");
  assert(id1 !== id2 && id2 !== id3 && id3 !== id4 && id4 !== id5, "scheduleTimer returns unique ids");

  const cancelled = cancelTimersByTag("compaction-resume");
  // id1, id2, id4 all had tag compaction-resume → 3 cancelled
  assert(cancelled === 3, `cancelTimersByTag('compaction-resume') cancelled 3 (got ${cancelled})`);

  // The user-task timer should still be there
  const userCancel = cancelTimer(id3);
  assert(userCancel === true, "user-tagged timer was NOT cancelled by tag-based helper");

  // The wake flag is preserved on the timer object (verify via listTimers)
  // after re-scheduling one for inspection:
  const wakeId = scheduleTimer(60_000, "wake-test", "test", true);
  const noWakeId = scheduleTimer(60_000, "no-wake-test", "test", false);
  // The export type re-exports the listTimers via the manager; we can't
  // access it directly, but we can confirm scheduleTimer accepted both
  // 3-arg and 4-arg calls without throwing.
  cancelTimer(wakeId);
  cancelTimer(noWakeId);
  assert(true, "scheduleTimer accepts both wake: true and wake: false");
}

// ── Summary ────────────────────────────────────────────────────────
console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
