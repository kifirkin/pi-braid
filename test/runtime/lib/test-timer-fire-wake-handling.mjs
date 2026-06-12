/**
 * Regression test: timer fire wake: true must use pi.sendMessage
 * (CustomMessage, not user-style input) so the wake appears as a
 * whisper in the TUI, not as text filled into the user input box.
 *
 * HISTORY (see docs/TIMER-DELIVERY-INVESTIGATION.md and scratchpad
 * lrn-1781126547564-7kp):
 *   Initial wake:true used pi.sendUserMessage, which per the SDK
 *   contract "Always triggers a turn" by sending "an actual user
 *   message that appears as if typed by the user." For an automatic
 *   timer (no human is typing), this is wrong: the [TIMER FIRED]
 *   text was filling the input box.
 *
 *   Why sendUserMessage fails here: the input polisher intercepts
 *   the message, treats it as user input, and re-fills the input
 *   box (without actually sending). So the message sits in the
 *   input unsent, looking like the user started typing. This is
 *   why we now avoid sendUserMessage entirely for automatic timers.
 *
 * FIX (2026-06, in src/extensions/scheduling/timer/index.ts):
 *   For wake: true, route through pi.sendMessage({customType:
 *   "timer-fire", content, display: true}, {triggerTurn: true}).
 *   This is a CustomMessage (whisper-style in TUI) that wakes the
 *   agent. No input-box fill, no polisher interception. For
 *   wake: false, keep the existing sendTrackedMessage path with
 *   `[TIMER FIRED] <reason>` text.
 *
 * NOTE: there is no TIMER_FIRE_HANDLING section in the prompt-builder.
 * Earlier versions added one, but it was removed because timer-handling
 * instructions in the system prompt are unnecessary noise. The
 * `[TIMER FIRED]` prefix in the message itself is sufficient signal.
 *
 * This is a source-level regression test. It reads the source files and
 * verifies the text/branching contracts. It does NOT exercise pi runtime
 * (that requires a full session). The runtime behavior is verified by
 * the user manually in their session.
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

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failures.push({ name, error: e.message });
    failed++;
  }
}

console.log("=== Timer fire wake: true handling (whisper not user input) ===");

// ── Layer 2: wake: true uses sendMessage (whisper), NOT sendUserMessage ──────────

test("Layer 2: wake: true branch calls pi.sendMessage (whisper)", () => {
  // The wake:true branch should use sendMessage (CustomMessage whisper),
  // not sendUserMessage (which would fill the input box).
  assert.ok(
    /if\s*\(\s*timer\.wake\s*===\s*true\s*\)/.test(TIMER_SRC),
    "must have an `if (timer.wake === true)` branch in fireTimer",
  );
  const wakeBranchIdx = TIMER_SRC.indexOf("if (timer.wake === true)");
  assert.ok(wakeBranchIdx > 0, "wake:true branch exists");
  const sendMessageIdx = TIMER_SRC.indexOf("pi.sendMessage(", wakeBranchIdx);
  assert.ok(
    sendMessageIdx > wakeBranchIdx,
    "pi.sendMessage must be called within the wake:true branch",
  );
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeBranchIdx);
  if (elseIdx > 0) {
    assert.ok(
      sendMessageIdx < elseIdx,
      "pi.sendMessage must be in wake:true branch, not wake:false",
    );
  }
});

test("Layer 2: wake: true does NOT use sendUserMessage (the bug we're fixing)", () => {
  // The wake:true branch must NOT call sendUserMessage. That API
  // "sends an actual user message that appears as if typed by the
  // user" - wrong for an automatic timer. Use sendMessage instead.
  const wakeBranchStart = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeBranchStart);
  if (elseIdx < 0) {
    throw new Error("could not find else branch");
  }
  const wakeBranch = TIMER_SRC.slice(wakeBranchStart, elseIdx);
  assert.ok(
    !wakeBranch.includes("sendUserMessage"),
    "wake:true branch must NOT use sendUserMessage (use pi.sendMessage instead)",
  );
});

test("Layer 2: sendMessage uses triggerTurn: true to wake the agent", () => {
  // The sendMessage call must set triggerTurn: true so the agent wakes.
  // We do NOT use deliverAs: 'steer' because that defers delivery until
  // the current tool call finishes, which would delay post-compaction
  // resume timers. triggerTurn:true is direct.
  const wakeBranchStart = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeBranchStart);
  const wakeBranch = TIMER_SRC.slice(wakeBranchStart, elseIdx);
  assert.ok(
    /triggerTurn:\s*true/.test(wakeBranch),
    "wake:true must set triggerTurn: true to wake the agent",
  );
});

test("Layer 2: sendMessage call is inside a try/catch (defensive against void throw)", () => {
  // ExtensionContext.sendMessage is declared as returning `void`, so
  // wrapping in try/catch is the correct defensive pattern.
  const wakeBranchStart = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeBranchStart);
  const wakeBranch = TIMER_SRC.slice(wakeBranchStart, elseIdx);
  const tryIdx = wakeBranch.indexOf("try {");
  assert.ok(tryIdx >= 0, "wake:true must have a try { ... } block");
  const tryEnd = wakeBranch.indexOf("} catch", tryIdx);
  assert.ok(tryEnd > tryIdx, "wake:true must have a catch clause after try");
  const tryBlock = wakeBranch.slice(tryIdx, tryEnd);
  assert.ok(
    /pi\.sendMessage\s*\(/.test(tryBlock),
    "try block must contain the pi.sendMessage call",
  );
  assert.ok(
    !/\.catch\(/.test(tryBlock),
    "try block must NOT chain .catch() on the void return value",
  );
});

test("Layer 2: sendMessage uses a distinct customType (timer-fire)", () => {
  // Use a distinct customType so renderers can recognize timer fires
  // separately from the silent-reminder customType ("timer").
  const wakeBranchStart = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeBranchStart);
  const wakeBranch = TIMER_SRC.slice(wakeBranchStart, elseIdx);
  assert.ok(
    /customType:\s*"timer-fire"/.test(wakeBranch),
    'wake:true must use customType: "timer-fire" (distinct from wake:false\'s "timer")',
  );
});

// ── Layer 3: text format is unambiguous ─────────────────────────────────

test("Layer 3: wake: true text includes [TIMER FIRED prefix", () => {
  const wakeBranchStart = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeBranchStart);
  const wakeBranch = TIMER_SRC.slice(wakeBranchStart, elseIdx);
  assert.ok(
    /\[TIMER FIRED/.test(wakeBranch),
    "wake:true text must start with [TIMER FIRED prefix",
  );
});

test("Layer 3: wake: true text includes elapsed time", () => {
  const wakeBranchStart = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeBranchStart);
  const wakeBranch = TIMER_SRC.slice(wakeBranchStart, elseIdx);
  assert.ok(
    /elapsed/.test(wakeBranch),
    "wake:true text must include elapsed time for context",
  );
});

test("Layer 3: wake: true text includes reason and 'Resume'", () => {
  const wakeBranchStart = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeBranchStart);
  const wakeBranch = TIMER_SRC.slice(wakeBranchStart, elseIdx);
  assert.ok(
    /timer\.reason/.test(wakeBranch) && /Resume/.test(wakeBranch),
    "wake:true text must include timer.reason and 'Resume' action hint",
  );
});

test("Layer 3: wake: false text is shorter form (whisper only)", () => {
  // The wake:false branch should use sendTrackedMessage with a shorter
  // [TIMER FIRED] text (no elapsed time, no 'Resume').
  const elseIdx = TIMER_SRC.indexOf("} else {");
  const afterElse = TIMER_SRC.slice(elseIdx, elseIdx + 2000);
  assert.ok(
    /\[TIMER FIRED\]/.test(afterElse) && !/\[TIMER FIRED \u2014/.test(afterElse),
    "wake:false text must be [TIMER FIRED] (no em-dash, no elapsed)",
  );
});

// ── Sanity: previous regression test still passes (priority fix) ─────

test("Sanity: priorityFromSource still maps timer/fire to critical (Layer 1)", () => {
  // The previous fix (Layer 1) - priority:critical - must still hold.
  const trackerSrc = readFileSync(
    join(ROOT, "src/lib/utils/injection-tracker.ts"),
    "utf-8",
  );
  // Scope to priorityFromSource function body (avoids doc comments and
  // unrelated occurrences of "timer/fire").
  const fnStart = trackerSrc.indexOf("function priorityFromSource");
  const fnBody = fnStart >= 0 ? trackerSrc.slice(fnStart, fnStart + 800) : trackerSrc;
  // Direct string check: source contains the literal substring "timer\/fire"
  // (the backslash is part of a regex-literal escape in the source code).
  const hasTimerFire = fnBody.includes("timer\\/fire") || fnBody.includes("timer/fire");
  assert.ok(
    hasTimerFire,
    "priorityFromSource critical regex must include timer/fire",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log("=== Timer fire wake handling tests passed ===");
