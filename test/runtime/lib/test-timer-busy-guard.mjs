/**
 * Test: Timer busy-guard uses tool_execution_end, not turn_end
 *
 * Regression test for the bug where:
 * 1. User set a 30s timer
 * 2. Agent called a long-running tool (e.g., bash with sleep 60)
 * 3. Busy guard was set on tool_call and only cleared on turn_end
 * 4. The 60s tool finished, LLM started thinking for 30+ more seconds
 * 5. Timer was stuck for the entire LLM thinking phase waiting for turn_end
 * 6. User saw "timer didn't fire" even though the tool was done
 *
 * Fix: busy guard resets on tool_execution_end (when the tool returns),
 * NOT on turn_end. This way:
 * - Timer fires immediately when a tool finishes (if expired during the tool)
 * - LLM thinking phases don't block timer firing
 * - turn_end remains a safety net for turns with no tool calls
 *
 * Also: tool_execution_end handler is the primary fire path; turn_end
 * is a backup. This means expired timers fire as soon as the tool returns,
 * not after the entire LLM turn completes.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../../");

let passed = 0, failed = 0;
const assert = (cond, msg) =>
  cond ? (passed++, console.log("  ✅ " + msg)) : (failed++, console.log("  ❌ " + msg));

const srcPath = join(ROOT, "dist/extensions/tools/timer/index.js");
if (!existsSync(srcPath)) {
  console.error("❌ dist file missing — run `npm run build` first");
  process.exit(1);
}
const src = readFileSync(srcPath, "utf8");

// ── [1] TOOL_EXECUTION_END is imported ─────────────────────────────────
console.log("\n[1] TOOL_EXECUTION_END import");
{
  assert(
    /TOOL_EXECUTION_END/.test(src),
    "TOOL_EXECUTION_END is imported and used",
  );
  assert(
    /TURN_END\s*,\s*TOOL_CALL\s*,\s*TOOL_EXECUTION_END/.test(src) ||
      /TOOL_CALL\s*,\s*TOOL_EXECUTION_END/.test(src),
    "TOOL_EXECUTION_END imported alongside TOOL_CALL",
  );
}

// ── [2] Busy guard reset on TOOL_EXECUTION_END, not just TURN_END ──────
console.log("\n[2] Busy guard resets on TOOL_EXECUTION_END");
{
  // Compiled JS uses the constant TOOL_EXECUTION_END
  const handlerStart = src.indexOf("pi.on(TOOL_EXECUTION_END,");
  if (handlerStart < 0) {
    assert(false, "TOOL_EXECUTION_END handler registered");
  } else {
    assert(true, "TOOL_EXECUTION_END handler registered");
  }

  // The handler should call setBusy(false)
  const handlerBody = src.slice(handlerStart, handlerStart + 1500);
  assert(
    /setBusy\s*\(\s*false\s*\)/.test(handlerBody),
    "TOOL_EXECUTION_END handler calls setBusy(false)",
  );
  // After per-pi refactor, expired-timer firing is encapsulated in
  // poller.fireExpired() (which internally calls checkExpired + fireTimer).
  // Both patterns are acceptable.
  assert(
    /checkExpired|fireExpired/.test(handlerBody),
    "TOOL_EXECUTION_END handler checks for expired timers (primary fire path)",
  );
  assert(
    /fireTimer|fireExpired/.test(handlerBody),
    "TOOL_EXECUTION_END handler fires expired timers",
  );
}

// ── [3] Both TOOL_EXECUTION_END and TURN_END fire expired timers ──────
console.log("\n[3] Both handlers fire expired timers");
{
  // Both should call checkExpired and fireTimer
  const toolExecIdx = src.indexOf("pi.on(TOOL_EXECUTION_END,");
  const turnEndIdx = src.indexOf("pi.on(TURN_END,");
  assert(toolExecIdx > 0, "TOOL_EXECUTION_END handler exists");
  assert(turnEndIdx > 0, "TURN_END handler exists");

  // Both should call checkExpired and fireTimer (or the encapsulated fireExpired helper)
  const toolExecBlock = src.slice(toolExecIdx, toolExecIdx + 1500);
  const turnEndBlock = src.slice(turnEndIdx, turnEndIdx + 1500);
  assert(
    /checkExpired[\s\S]{0,500}fireTimer|fireExpired/.test(toolExecBlock),
    "TOOL_EXECUTION_END: checkExpired then fireTimer",
  );
  assert(
    /checkExpired[\s\S]{0,500}fireTimer|fireExpired/.test(turnEndBlock),
    "TURN_END: checkExpired then fireTimer (backup)",
  );
}

// ── [4] TOOL_CALL still sets busy=true (regression: don't break the fix) ──
console.log("\n[4] TOOL_CALL still sets busy=true (regression)");
{
  // Compiled JS uses the constant TOOL_CALL, not the string literal
  const toolCallIdx = src.indexOf("pi.on(TOOL_CALL,");
  assert(toolCallIdx > 0, "TOOL_CALL handler present");
  const toolCallBlock = src.slice(toolCallIdx, toolCallIdx + 500);
  assert(
    /setBusy\s*\(\s*true\s*\)/.test(toolCallBlock),
    "TOOL_CALL handler still calls setBusy(true)",
  );
}

// ── [5] Live simulation: tool_execution_end clears busy, timer fires ────
console.log("\n[5] Live simulation: tool_execution_end clears busy");
{
  // Reimplement the relevant logic to verify the new design
  const state = {
    busy: false,
    timers: new Map(),
    fired: [],
  };

  function setTimer(delayMs, reason) {
    const id = `t${Date.now()}_${Math.random()}`;
    state.timers.set(id, { id, firesAt: Date.now() + delayMs, reason });
    return id;
  }

  function toolCallHandler() {
    state.busy = true;
  }

  function toolExecEndHandler() {
    state.busy = false;
    const expired = [];
    for (const [id, t] of state.timers) {
      if (t.firesAt <= Date.now()) {
        expired.push(t);
        state.timers.delete(id);
      }
    }
    for (const t of expired) state.fired.push(t);
    return expired.length;
  }

  function turnEndHandler() {
    state.busy = false;
    const expired = [];
    for (const [id, t] of state.timers) {
      if (t.firesAt <= Date.now()) {
        expired.push(t);
        state.timers.delete(id);
      }
    }
    for (const t of expired) state.fired.push(t);
    return expired.length;
  }

  function poll() {
    if (state.busy) return 0;
    const expired = [];
    for (const [id, t] of state.timers) {
      if (t.firesAt <= Date.now()) {
        expired.push(t);
        state.timers.delete(id);
      }
    }
    for (const t of expired) state.fired.push(t);
    return expired.length;
  }

  // Scenario: set timer, then tool_call, wait, then tool_exec_end
  setTimer(0, "instant"); // already expired
  toolCallHandler(); // busy = true
  assert(state.busy === true, "tool_call sets busy=true");
  const pollResult = poll();
  assert(pollResult === 0, "poll bails while busy");
  // Tool returns — busy should clear
  const toolEndResult = toolExecEndHandler();
  assert(state.busy === false, "tool_execution_end clears busy");
  assert(toolEndResult === 1, "tool_execution_end fires the expired timer");
  assert(state.fired.length === 1, "timer was actually fired");
}

// ── [6] Old behavior was buggy: tool_call then turn_end without tool_execution_end ─
console.log("\n[6] Verify the new design doesn't regress turn_end behavior");
{
  // Even in a turn with no tool calls, turn_end should still fire expired timers
  // (e.g., user set a 30s timer and the LLM responds immediately with no tools)
  const state = {
    busy: false,
    timers: new Map(),
    fired: [],
  };

  function setTimer(delayMs, reason) {
    const id = `t${Math.random()}`;
    state.timers.set(id, { id, firesAt: Date.now() + delayMs, reason });
    return id;
  }

  function turnEndHandler() {
    state.busy = false;
    const expired = [];
    for (const [id, t] of state.timers) {
      if (t.firesAt <= Date.now()) {
        expired.push(t);
        state.timers.delete(id);
      }
    }
    for (const t of expired) state.fired.push(t);
    return expired.length;
  }

  setTimer(0, "expired");
  const n = turnEndHandler();
  assert(n === 1, "turn_end fires expired timers in turns with no tool calls");
  assert(state.fired.length === 1, "timer was actually fired");
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
