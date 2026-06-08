/**
 * Test: Resume timer scheduled in session_compact, not in tool/auto-compact.
 *
 * Regression test for the bug where:
 * 1. context_compress tool or auto-compact path scheduled a 3-min resume timer
 * 2. ctx.compact() was called
 * 3. session_compact event fired
 * 4. register-session-compact.ts handler cancelled the same tag
 * 5. The timer was created and immediately destroyed, never firing
 * 6. Agent never woke up after compaction
 *
 * Fix: schedule the resume timer in the session_compact handler, AFTER
 * the cancellation. The tool and auto-compact paths only cancel stale
 * timers.
 *
 * Also tests: parallel-tool-call warning is in the tool description.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../../");

let passed = 0, failed = 0;
const assert = (cond, msg) =>
  cond ? (passed++, console.log("  ✅ " + msg)) : (failed++, console.log("  ❌ " + msg));

// ── [1] Files exist ─────────────────────────────────────────────────────
console.log("\n[1] Required files");
{
  const paths = [
    "dist/extensions/memory/context-manager/handlers/tools/context-compress.js",
    "dist/extensions/memory/context-lifecycle/index.js",
    "dist/extensions/enforcement/handlers/register-session-compact.js",
  ];
  for (const p of paths) {
    assert(existsSync(join(ROOT, p)), `${p} exists`);
  }
}

const compPath = join(ROOT, "dist/extensions/memory/context-manager/handlers/tools/context-compress.js");
const lifePath = join(ROOT, "dist/extensions/memory/context-lifecycle/index.js");
const compactPath = join(ROOT, "dist/extensions/enforcement/handlers/register-session-compact.js");

// ── [2] context-compress does NOT schedule the resume timer ────────────
console.log("\n[2] context-compress does NOT schedule the resume timer");
{
  const comp = readFileSync(compPath, "utf8");
  // The 3-minute resume timer must NOT be created in this scope
  assert(
    !/scheduleTimer\s*\(\s*3\s*\*\s*60\s*\*\s*1000/.test(comp),
    "context-compress does not call scheduleTimer with 3*60*1000",
  );
  // It should still cancel stale tags (defensive)
  assert(
    /cancelTimersByTag\s*\(\s*["']compaction-resume["']\s*\)/.test(comp),
    "context-compress still cancels 'compaction-resume' tag (defensive cleanup)",
  );
  assert(
    /cancelTimersByTag\s*\(\s*["']auto-compaction-resume["']\s*\)/.test(comp),
    "context-compress still cancels 'auto-compaction-resume' tag (defensive cleanup)",
  );
}

// ── [3] context-lifecycle auto-compact does NOT schedule the resume timer ─
console.log("\n[3] context-lifecycle auto-compact does NOT schedule the resume timer");
{
  const life = readFileSync(lifePath, "utf8");
  assert(
    !/scheduleTimer\s*\(\s*3\s*\*\s*60\s*\*\s*1000/.test(life),
    "context-lifecycle auto-compact does not call scheduleTimer with 3*60*1000",
  );
  assert(
    /cancelTimersByTag\s*\(\s*["']compaction-resume["']\s*\)/.test(life),
    "context-lifecycle still cancels 'compaction-resume' tag (defensive cleanup)",
  );
  assert(
    /cancelTimersByTag\s*\(\s*["']auto-compaction-resume["']\s*\)/.test(life),
    "context-lifecycle still cancels 'auto-compaction-resume' tag (defensive cleanup)",
  );
}

// ── [4] session_compact handler DOES schedule the resume timer ─────────
console.log("\n[4] session_compact handler schedules the fresh resume timer");
{
  const compact = readFileSync(compactPath, "utf8");
  // Must cancel stale timers (current behavior preserved)
  assert(
    /cancelTimersByTag\s*\(\s*["']compaction-resume["']\s*\)/.test(compact),
    "session_compact cancels 'compaction-resume' tag",
  );
  assert(
    /cancelTimersByTag\s*\(\s*["']auto-compaction-resume["']\s*\)/.test(compact),
    "session_compact cancels 'auto-compaction-resume' tag",
  );
  // Must schedule fresh resume timer (NEW behavior)
  assert(
    /scheduleTimer\s*\(\s*3\s*\*\s*60\s*\*\s*1000\s*,\s*["']Context compaction done[\s\S]*?,\s*["']compaction-resume["']\s*,\s*true/.test(compact),
    "session_compact schedules fresh resume timer (3-min, wake:true, tag=compaction-resume)",
  );
  // Schedule must come AFTER the cancel (ordering matters)
  const cancelIdx = compact.indexOf("cancelTimersByTag(\"compaction-resume\")");
  const scheduleIdx = compact.indexOf("scheduleTimer(3 * 60 * 1000");
  assert(
    cancelIdx > 0 && scheduleIdx > 0 && scheduleIdx > cancelIdx,
    "scheduleTimer comes AFTER cancelTimersByTag in source order",
  );
}

// ── [5] Parallel-tool-call warning in tool description ──────────────────
console.log("\n[5] Parallel-tool-call warning in tool description");
{
  const comp = readFileSync(compPath, "utf8");
  // The description text is what the LLM sees
  assert(
    /parallel/i.test(comp) && /abort/i.test(comp),
    "context-compress description mentions parallel-call and abort risk",
  );
  assert(
    /do NOT call this tool in the same parallel batch|parallel batch/i.test(comp),
    "context-compress description has explicit parallel-batch warning",
  );
}

// ── [6] AGENTS.md documents the new design ─────────────────────────────
console.log("\n[6] AGENTS.md documents the new design");
{
  const agentsPath = join(ROOT, "src/extensions/memory/AGENTS.md");
  if (!existsSync(agentsPath)) {
    assert(false, "src/extensions/memory/AGENTS.md exists");
  } else {
    const md = readFileSync(agentsPath, "utf8");
    assert(
      /session_compact[\s\S]{0,200}schedul/i.test(md),
      "AGENTS.md notes session_compact is the scheduling location",
    );
    assert(
      /NOT in the tool|does NOT schedule|never fires|cancel.*race/i.test(md) ||
        /cancel.*and.*schedule|after.*cancel/i.test(md),
      "AGENTS.md explains why the new design avoids the cancel race",
    );
  }
}

// ── [7] Order of operations is correct end-to-end ─────────────────────
console.log("\n[7] End-to-end ordering check");
{
  // Manually re-implement the relevant snippet to verify the flow is correct
  // (defensive in case the regex search miscounts or minified JS differs)
  const compact = readFileSync(compactPath, "utf8");
  // Find the session_compact handler body
  const handlerStart = compact.indexOf("onEvent(pi, \"session_compact\"");
  if (handlerStart < 0) {
    assert(false, "session_compact handler found");
  } else {
    const handlerBody = compact.slice(handlerStart, handlerStart + 4000);
    // The two cancel calls must come before the schedule
    const cancel1 = handlerBody.indexOf("cancelTimersByTag(\"compaction-resume\")");
    const cancel2 = handlerBody.indexOf("cancelTimersByTag(\"auto-compaction-resume\")");
    const schedule = handlerBody.indexOf("scheduleTimer(3 * 60 * 1000");
    assert(cancel1 > 0, "cancel 'compaction-resume' present in handler body");
    assert(cancel2 > 0, "cancel 'auto-compaction-resume' present in handler body");
    assert(schedule > 0, "scheduleTimer call present in handler body");
    assert(schedule > cancel1, "schedule happens AFTER first cancel");
    assert(schedule > cancel2, "schedule happens AFTER second cancel");
  }
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
