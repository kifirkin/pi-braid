/**
 * Regression test: timer fire delivery architecture.
 *
 * HISTORY (see commit messages and scratchpad):
 *   Initial wake:true used `pi.sendUserMessage`, which per the SDK
 *   contract "sends an actual user message that appears as if typed by
 *   the user." For an automatic timer (no human typing), this filled
 *   the input box with [TIMER FIRED] text. FIX: switched to
 *   `pi.sendMessage({customType, content, display:true},
 *   {triggerTurn: true})` which is a CustomMessage (whisper-style in
 *   TUI) that wakes the agent.
 *
 *   Second bug: wake:false (silent reminder) used `sendTrackedMessage`,
 *   which routes through `turn-dedup.tryWhisper` and applies a
 *   per-source flood cap of 2. If 3 timer fires happened in the same
 *   turn (user scheduled multiple timers), the 3rd was silently
 *   dropped. User reported: "timer_set sometimes doesn't fire."
 *
 * PROPER FIX (this test pins the architecture):
 *   Both wake:true and wake:false now go through `sendTrackedMessage`
 *   with `{ bypassFloodCap: true }`. The flood cap still applies to
 *   system whispers (enforcement, dreamer, heartbeats) but timer
 *   fires are user/agent-contracted events that must always reach the
 *   agent. The unified path gives us:
 *     - trackInjection observability for both branches
 *     - re-entry depth guard for both branches
 *     - explicit bypassFloodCap flag (vs. forking into 2 paths)
 *     - one delivery code path = one place to fix bugs
 *
 * This is a source-level regression test. It reads timer/index.ts and
 * asserts the architecture. It does NOT exercise pi runtime (that
 * requires a full session). The runtime behavior is verified by the
 * user manually in their session.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const TIMER_SRC = readFileSync(
  join(ROOT, "src/extensions/scheduling/timer/index.ts"),
  "utf-8",
);
const TRACKER_SRC = readFileSync(
  join(ROOT, "src/lib/utils/injection-tracker.ts"),
  "utf-8",
);

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(`  [x] ${name}: ${e.message}`);
    failures.push({ name, error: e.message });
    failed++;
  }
}

console.log("=== Timer fire delivery architecture (unified path) ===");

// ── Layer 1: sendTrackedMessage supports bypassFloodCap ───────────────

test("Layer 1: sendTrackedMessage accepts a bypass object as 5th arg", () => {
  // The function signature must accept `{ bypassFloodCap: true }`.
  // JSDoc on the parameter documents the contract.
  assert.match(
    TRACKER_SRC,
    /export\s+function\s+sendTrackedMessage\s*\([\s\S]*?bypass\s*:\s*\{[^}]*bypassFloodCap\?[\s\S]*?\}/,
    "sendTrackedMessage must accept `bypass: { bypassFloodCap?: boolean }` as 5th arg",
  );
});

test("Layer 1: bypassFloodCap:true skips the tryWhisper flood cap", () => {
  // The implementation must guard tryWhisper with `if (!bypass.bypassFloodCap)`.
  // That's the only way the bypass flag has any effect.
  const fnStart = TRACKER_SRC.indexOf("export function sendTrackedMessage");
  assert.ok(fnStart >= 0, "sendTrackedMessage function must exist");
  const fnBody = TRACKER_SRC.slice(fnStart, fnStart + 4000);
  assert.match(
    fnBody,
    /if\s*\(\s*!\s*bypass\.bypassFloodCap\s*\)/,
    "sendTrackedMessage must guard tryWhisper with `if (!bypass.bypassFloodCap)`",
  );
});

// ── Layer 2: both timer branches use sendTrackedMessage with bypassFloodCap ─

test("Layer 2: both wake:true and wake:false use sendTrackedMessage (unified path)", () => {
  // The fireTimer function has an if/else split on timer.wake. Both
  // branches must use sendTrackedMessage so observability (trackInjection)
  // and the re-entry guard apply uniformly.
  const wakeIdx = TIMER_SRC.indexOf("if (timer.wake === true)");
  assert.ok(wakeIdx > 0, "wake:true branch must exist");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeIdx);
  assert.ok(elseIdx > 0, "wake:true/wake:false if/else split must exist");

  const wakeTrueBranch = TIMER_SRC.slice(wakeIdx, elseIdx);
  const wakeFalseCatch = TIMER_SRC.indexOf("} catch (e)", elseIdx);
  const wakeFalseBranch = TIMER_SRC.slice(elseIdx, wakeFalseCatch + 1);

  assert.match(
    wakeTrueBranch,
    /sendTrackedMessage\s*\(/,
    "wake:true branch must use sendTrackedMessage (unified delivery path)",
  );
  assert.match(
    wakeFalseBranch,
    /sendTrackedMessage\s*\(/,
    "wake:false branch must use sendTrackedMessage (unified delivery path)",
  );
});

test("Layer 2: both branches pass bypassFloodCap: true", () => {
  // Timer fires are user/agent-contracted events. The flood cap (per-
  // source = 2 per turn) must not drop the 3rd timer the user scheduled
  // that expires in the same turn. Both branches must opt in to bypass.
  const wakeIdx = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeIdx);
  const wakeTrueBranch = TIMER_SRC.slice(wakeIdx, elseIdx);
  const wakeFalseCatch = TIMER_SRC.indexOf("} catch (e)", elseIdx);
  const wakeFalseBranch = TIMER_SRC.slice(elseIdx, wakeFalseCatch + 1);

  assert.match(
    wakeTrueBranch,
    /bypassFloodCap:\s*true/,
    "wake:true must pass bypassFloodCap: true (3rd timer in same turn must not be dropped)",
  );
  assert.match(
    wakeFalseBranch,
    /bypassFloodCap:\s*true/,
    "wake:false must pass bypassFloodCap: true (3rd timer in same turn must not be dropped)",
  );
});

test("Layer 2: wake:true uses triggerTurn: true (wakes the agent)", () => {
  // The wake:true branch is for user-scheduled and post-compaction
  // auto-resume timers - it must trigger a new turn.
  const wakeIdx = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeIdx);
  const wakeTrueBranch = TIMER_SRC.slice(wakeIdx, elseIdx);
  assert.match(
    wakeTrueBranch,
    /triggerTurn:\s*true/,
    "wake:true must set triggerTurn: true to wake the agent",
  );
});

test("Layer 2: wake:false uses triggerTurn: false (silent reminder)", () => {
  // The wake:false branch is for background heartbeats. The reminder
  // appears in TUI but does NOT force a new turn.
  const wakeIdx = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeIdx);
  const wakeFalseCatch = TIMER_SRC.indexOf("} catch (e)", elseIdx);
  const wakeFalseBranch = TIMER_SRC.slice(elseIdx, wakeFalseCatch + 1);
  assert.match(
    wakeFalseBranch,
    /triggerTurn:\s*false/,
    "wake:false must set triggerTurn: false (silent reminder, no forced turn)",
  );
});

test("Layer 2: neither branch uses sendUserMessage (input-box bug)", () => {
  // sendUserMessage fills the TUI input box. For automatic timers
  // (no human typing), that's wrong. The user reported this exact bug
  // in 2026-06; the fix is to use sendMessage (CustomMessage whisper)
  // for all timer delivery.
  const wakeIdx = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeIdx);
  const wakeTrueBranch = TIMER_SRC.slice(wakeIdx, elseIdx);
  const wakeFalseCatch = TIMER_SRC.indexOf("} catch (e)", elseIdx);
  const wakeFalseBranch = TIMER_SRC.slice(elseIdx, wakeFalseCatch + 1);

  assert.ok(
    !wakeTrueBranch.includes("sendUserMessage"),
    "wake:true must NOT use sendUserMessage (input-box fill bug)",
  );
  assert.ok(
    !wakeFalseBranch.includes("sendUserMessage"),
    "wake:false must NOT use sendUserMessage (input-box fill bug)",
  );
});

// ── Layer 3: text format is unambiguous ─────────────────────────────

test("Layer 3: wake:true text includes [TIMER FIRED prefix + elapsed + Resume", () => {
  const wakeIdx = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeIdx);
  const wakeTrueBranch = TIMER_SRC.slice(wakeIdx, elseIdx);
  assert.match(wakeTrueBranch, /\[TIMER FIRED/, "wake:true text must start with [TIMER FIRED");
  assert.match(wakeTrueBranch, /elapsed/, "wake:true text must include elapsed time");
  assert.match(wakeTrueBranch, /Resume/, "wake:true text must include 'Resume' action hint");
});

test("Layer 3: wake:false text is shorter form (no elapsed, no Resume)", () => {
  const elseIdx = TIMER_SRC.indexOf("} else {");
  const wakeFalseCatch = TIMER_SRC.indexOf("} catch (e)", elseIdx);
  const wakeFalseBranch = TIMER_SRC.slice(elseIdx, wakeFalseCatch + 1);
  assert.match(wakeFalseBranch, /\[TIMER FIRED\]/, "wake:false must use [TIMER FIRED] shorter form");
  // The shorter form has no 'elapsed' (no timer state) and no 'Resume' (silent).
  assert.ok(
    !wakeFalseBranch.includes("Resume"),
    "wake:false must not include 'Resume' (silent reminder, no action hint)",
  );
});

test("Layer 3: distinct customTypes ('timer-fire' vs 'timer') for recognizers", () => {
  // The wake:true customType is "timer-fire" (was the original direct-
  // pi.sendMessage customType). The wake:false customType is "timer"
  // (matches the long-standing pre-fix value). Both are stable
  // contracts for downstream recognizers (renderer, analytics).
  const wakeIdx = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeIdx);
  const wakeTrueBranch = TIMER_SRC.slice(wakeIdx, elseIdx);
  const wakeFalseCatch = TIMER_SRC.indexOf("} catch (e)", elseIdx);
  const wakeFalseBranch = TIMER_SRC.slice(elseIdx, wakeFalseCatch + 1);

  assert.match(wakeTrueBranch, /customType:\s*"timer-fire"/, 'wake:true uses customType: "timer-fire"');
  assert.match(wakeFalseBranch, /customType:\s*"timer"/, 'wake:false uses customType: "timer"');
});

// ── Sanity: priority mapping preserved ──────────────────────────────

test("Sanity: priorityFromSource still maps timer/fire to critical (Layer 1)", () => {
  // The critical-priority mapping is what made timer fires bypass the
  // per-priority cap. With bypassFloodCap now in place, the critical
  // mapping is belt-and-suspenders - the bypass flag is the primary
  // mechanism. We keep the critical mapping because other call sites
  // (e.g., unit tests, third-party consumers) still rely on it.
  const fnStart = TRACKER_SRC.indexOf("function priorityFromSource");
  const fnBody = TRACKER_SRC.slice(fnStart, fnStart + 800);
  const hasTimerFire = fnBody.includes("timer\\/fire") || fnBody.includes("timer/fire");
  assert.ok(hasTimerFire, "priorityFromSource critical regex must include timer/fire");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log("=== Timer fire delivery architecture tests passed ===");
