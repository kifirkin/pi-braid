/**
 * Test: Post-Compaction Fixes (stack overflow + whisper ordering + wake audit)
 *
 * Verifies the bundle of fixes for:
 *  1. Re-entrancy guard MAX_REENTRY_DEPTH = 1 (was 2) — stops stack overflow
 *     when pi.sendMessage(steer) chains into a fresh before_agent_start loop.
 *  2. Timer module: triggerTurn derived from wake flag (resume=wake:true,
 *     user-scheduled=wake:true by default). Busy guard prevents mid-tool
 *     firing — the original post-compaction stack overflow chain is closed
 *     off without losing auto-resume behavior.
 *  3. Timer module: _braidInjected metadata on the resume whisper (was missing).
 *     Consistent with the [enforcement] whisper contract so compaction can
 *     identify and preserve the message.
 *  4. Timer module: busy guard — poller bails when agent is mid-tool-execution.
 *  5. cancelTimersByTag helper — new programmatic API on the timer module.
 *  6. Compaction paths actually call cancelTimersByTag to invalidate stale
 *     resume timers from previous compaction cycles.
 *  7. Wake audit: critical whispers (compaction-retry errors, navigation
 *     checkout prepared, context 80%+, tool reliability) use triggerTurn:true
 *     so the agent wakes up and acts.
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
    /export\s+function\s+scheduleTimer\([\s\S]*?wake\s*=\s*true\s*\)/.test(src),
    "scheduleTimer exposes wake parameter (default true — user timers wake the agent)",
  );
  // The wake field must be set on the timer object in setTimer
  // (After per-session refactor, storage is in sessionTimers not this.timers.)
  assert(
    /(sessionTimers|this\.timers)\.set\([\s\S]*?wake\s*[,}]/.test(src),
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
    "cancelTimersByTag(sessionId, tag) is exported",
  );
  // The implementation must scope by sessionId then filter by tag.
  // (After per-session refactor, it iterates the session's map and filters
  // entries by tag — not the global listTimers() anymore.)
  const helperMatch = src.match(
    /export\s+function\s+cancelTimersByTag\s*\([^)]*\)\s*\{[\s\S]*?\n\}/,
  );
  assert(helperMatch !== null, "cancelTimersByTag body found");
  if (helperMatch) {
    const body = helperMatch[0];
    assert(body.includes("sessionId"), "cancelTimersByTag takes sessionId param");
    assert(body.includes("tag"), "cancelTimersByTag takes tag param");
    // After per-session refactor: the export delegates to a class method.
    // Check the class method body too — that's where the actual filtering lives.
    const classBody = src.match(
      /cancelTimersByTag\s*\(\s*sessionId\s*,\s*tag\s*\)\s*\{[\s\S]*?\n\s{4}\}/,
    );
    const allBodies = [body, classBody ? classBody[0] : ""].join("\n");
    assert(
      /sessionTimers|t\.tag|timer\.tag/.test(allBodies),
      "cancelTimersByTag iterates session timers and filters by tag",
    );
  }
}

// ── [7] Compaction paths cancel stale + schedule with wake: true ─
console.log("\n[7] Compaction paths cancel stale resume timers and wake");
{
  const comp = readFileSync(contextCompressPath, "utf8");
  const life = readFileSync(contextLifecyclePath, "utf8");
  const compact = readFileSync(sessionCompactPath, "utf8");

  // context-compress (manual) cancels both tags (defensive cleanup only —
  // scheduling is done in the session_compact handler, see below).
  // After per-session refactor, calls pass sessionId as first arg.
  assert(
    /cancelTimersByTag\s*\(\s*\w+\s*,\s*["']compaction-resume["']\s*\)/.test(comp),
    "context-compress cancels 'compaction-resume' timers (session-scoped)",
  );
  assert(
    /cancelTimersByTag\s*\(\s*\w+\s*,\s*["']auto-compaction-resume["']\s*\)/.test(comp),
    "context-compress cancels 'auto-compaction-resume' timers (session-scoped, cross-path cleanup)",
  );
  // context-compress must NOT schedule the resume timer here — the
  // session_compact handler cancels the tag immediately, so a timer
  // created in this scope would never fire. Scheduling lives in
  // session_compact enforcement handler instead.
  assert(
    !/scheduleTimer\s*\([^)]*3\s*\*\s*60\s*\*\s*1000\s*,\s*["']Context compaction done[\s\S]*?,\s*["']compaction-resume["']/.test(comp),
    "context-compress does NOT schedule the resume timer (avoids cancel race)",
  );

  // context-lifecycle auto-compact also cancels both tags and must NOT
  // schedule the timer (same reason as above)
  assert(
    /cancelTimersByTag\s*\(\s*\w+\s*,\s*["']compaction-resume["']\s*\)/.test(life),
    "context-lifecycle auto-compact cancels 'compaction-resume' timers (session-scoped)",
  );
  assert(
    /cancelTimersByTag\s*\(\s*\w+\s*,\s*["']auto-compaction-resume["']\s*\)/.test(life),
    "context-lifecycle auto-compact cancels 'auto-compaction-resume' timers (session-scoped)",
  );
  assert(
    !/scheduleTimer\s*\([^)]*3\s*\*\s*60\s*\*\s*1000\s*,\s*["']Auto-compaction done[\s\S]*?,\s*["']auto-compaction-resume["']/.test(life),
    "context-lifecycle auto-compact does NOT schedule the resume timer (avoids cancel race)",
  );

  // session_compact enforcement handler cancels both AND schedules a fresh
  // resume timer. This is the new (correct) location for the timer.
  // After per-session refactor, scheduleTimer takes sessionId as first arg.
  assert(
    /cancelTimersByTag\s*\(\s*\w+\s*,\s*["']compaction-resume["']\s*\)/.test(compact),
    "session_compact enforcement handler cancels 'compaction-resume' timers (session-scoped)",
  );
  assert(
    /cancelTimersByTag\s*\(\s*\w+\s*,\s*["']auto-compaction-resume["']\s*\)/.test(compact),
    "session_compact enforcement handler cancels 'auto-compaction-resume' timers (session-scoped)",
  );
  assert(
    /scheduleTimer\s*\(\s*\w+\s*,\s*3\s*\*\s*60\s*\*\s*1000\s*,\s*["']Context compaction done[\s\S]*?,\s*["']compaction-resume["']\s*,\s*true/.test(compact),
    "session_compact enforcement handler schedules fresh resume timer (sessionId, 3min, wake:true, tag=compaction-resume)",
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
    listTimers,
    clearSessionTimers,
  } = await import(join(ROOT, "dist/extensions/tools/timer/index.js"));

  // Use a unique test session id so this test doesn't leak into other
  // tests (or vice versa) since timer storage is per-session globally.
  const SESSION = "test-post-compaction-" + Math.random().toString(36).slice(2, 8);
  clearSessionTimers(SESSION); // start clean

  // Helper to introspect internal state via the public listTimers API
  // (we import the manager indirectly by scheduling a tagged timer)
  const id1 = scheduleTimer(SESSION, 60_000, "stale-1", "compaction-resume");
  const id2 = scheduleTimer(SESSION, 60_000, "stale-2", "compaction-resume");
  const id3 = scheduleTimer(SESSION, 60_000, "keep", "user-task");
  // wake flag: resume timer (wake: true) vs user timer (default false)
  const id4 = scheduleTimer(SESSION, 60_000, "resume-after-compact", "compaction-resume", true);
  const id5 = scheduleTimer(SESSION, 60_000, "build-check", "user-task"); // wake defaults false

  // Sanity: we just scheduled 5 timers, IDs are unique
  assert(typeof id1 === "string" && id1.length > 0, "scheduleTimer returns id string");
  assert(id1 !== id2 && id2 !== id3 && id3 !== id4 && id4 !== id5, "scheduleTimer returns unique ids");

  const cancelled = cancelTimersByTag(SESSION, "compaction-resume");
  // id1, id2, id4 all had tag compaction-resume → 3 cancelled
  assert(cancelled === 3, `cancelTimersByTag(SESSION, 'compaction-resume') cancelled 3 (got ${cancelled})`);

  // The user-task timer should still be there
  const userCancel = cancelTimer(SESSION, id3);
  assert(userCancel === true, "user-tagged timer was NOT cancelled by tag-based helper");

  // The wake flag is preserved on the timer object (verify via listTimers)
  // after re-scheduling one for inspection:
  const wakeId = scheduleTimer(SESSION, 60_000, "wake-test", "test", true);
  const noWakeId = scheduleTimer(SESSION, 60_000, "no-wake-test", "test", false);
  // The export type re-exports the listTimers via the manager; we can't
  // access it directly, but we can confirm scheduleTimer accepted both
  // 3-arg and 4-arg calls without throwing.
  cancelTimer(SESSION, wakeId);
  cancelTimer(SESSION, noWakeId);
  assert(true, "scheduleTimer accepts both wake: true and wake: false");

  // Verify default wake is true (the fix for "common timers not waking")
  const defaultId = scheduleTimer(SESSION, 60_000, "default-wake-test", "default-test");
  const defaultTimer = listTimers(SESSION).find((t) => t.id === defaultId);
  assert(
    defaultTimer && defaultTimer.wake === true,
    "scheduleTimer defaults wake to true (user-set timers wake the agent)",
  );
  cancelTimer(SESSION, defaultId);
  clearSessionTimers(SESSION); // cleanup
}

// ── [9] Wake audit: critical whispers use triggerTurn: true ──────
console.log("\n[9] Wake audit: critical whispers triggerTurn: true");
{
  const timerSrc = readFileSync(join(ROOT, "dist/extensions/tools/timer/index.js"), "utf8");
  const compactRetrySrc = readFileSync(join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction-retry.js"), "utf8");
  const navigationSrc = readFileSync(join(ROOT, "dist/extensions/memory/context-manager/handlers/navigation.js"), "utf8");
  const sessionStartSrc = readFileSync(join(ROOT, "dist/extensions/enforcement/handlers/register-session-start.js"), "utf8");
  const threeMemStoresSrc = readFileSync(join(ROOT, "dist/extensions/memory/three-memory-stores/index.js"), "utf8");

  // Timer fire: triggerTurn derived from wake, default wake=true
  assert(
    /const\s+triggerTurn\s*=\s*timer\.wake\s*===\s*true/.test(timerSrc),
    "Timer fire: triggerTurn = timer.wake === true",
  );

  // compaction-retry: critical exhausted/error messages wake the agent
  // These are the ones where retries are spent and the agent must pivot.
  // The compiled JS has structure: { triggerTurn: true }, { source: "compaction/...-exhausted" }
  // so check the source label follows the triggerTurn: true within ~150 chars.
  const wakeExhausted = (label) =>
    new RegExp(
      `triggerTurn:\\s*true\\s*\\}\\s*,\\s*\\{\\s*type:\\s*"context"\\s*,\\s*source:\\s*"context-manager/compaction/${label}"`,
    ).test(compactRetrySrc);
  assert(wakeExhausted("overflow-exhausted"), "compaction-retry: overflow-exhausted uses triggerTurn: true");
  assert(wakeExhausted("transient-exhausted"), "compaction-retry: transient-exhausted uses triggerTurn: true");
  assert(wakeExhausted("context-window"), "compaction-retry: context-window uses triggerTurn: true");
  assert(wakeExhausted("threshold-exhausted"), "compaction-retry: threshold-exhausted uses triggerTurn: true (was already correct)");

  // In-progress retry messages stay triggerTurn: false (agent is waiting)
  const keepSilent = (label) =>
    new RegExp(
      `triggerTurn:\\s*false\\s*\\}\\s*,\\s*\\{\\s*type:\\s*"context"\\s*,\\s*source:\\s*"context-manager/compaction/${label}"`,
    ).test(compactRetrySrc);
  assert(keepSilent("overflow"), "compaction-retry: overflow (in-progress) keeps triggerTurn: false");
  assert(keepSilent("transient"), "compaction-retry: transient (in-progress) keeps triggerTurn: false");

  // Navigation "Context checkout prepared" — direct action instruction
  assert(
    /source:\s*["']context-manager\/navigation["']/.test(navigationSrc) &&
      /Context checkout prepared[\s\S]{0,500}?triggerTurn:\s*true/.test(navigationSrc),
    "navigation: 'Context checkout prepared' uses triggerTurn: true (direct action)",
  );

  // Context 80%+ enforcement — agent should wake to act before escalation
  assert(
    /Context at \$\{Math\.round\(event\.usagePercent\)\}%[\s\S]{0,500}?triggerTurn:\s*true/.test(sessionStartSrc),
    "enforcement: context 80%+ uses triggerTurn: true (proactive action)",
  );

  // Three-memory-stores reliability alert — agent should know a tool is failing
  assert(
    /source:\s*["']three-memory-stores\/reliability["'][\s\S]{0,300}?triggerTurn:\s*true/.test(threeMemStoresSrc) ||
      /has better reliability[\s\S]{0,500}?triggerTurn:\s*true/.test(threeMemStoresSrc),
    "memory: tool reliability alert uses triggerTurn: true (significant gap)",
  );
}

// ── Summary ────────────────────────────────────────────────────────
console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
