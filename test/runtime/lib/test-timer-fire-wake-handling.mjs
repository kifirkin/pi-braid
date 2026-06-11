/**
 * Regression test: timer fire wake: true must use pi.sendUserMessage
 * (not sendMessage/steer) and produce an unambiguous [TIMER FIRED]
 * prefix. Also verifies the prompt-builder emits a TIMER_FIRE_HANDLING
 * section so the agent knows how to react.
 *
 * HISTORY (see scratchpad lrn-1781126547564-7kp):
 *   Layers 2/3/4 timer fire fix. Prior to the fix:
 *     Layer 2 — timer used sendMessage(steer), a SOFT NUDGE the agent
 *               could ignore mid-stream. SDK documents sendUserMessage as
 *               "Always triggers a turn."
 *     Layer 3 — whisper text was `[timer] <reason>` — ambiguous; the
 *               agent's prompt had no instruction for handling it.
 *     Layer 4 — mid-stream triggerTurn: true did not actually interrupt.
 *
 * FIX (single source change in src/extensions/scheduling/timer/index.ts):
 *   For wake: true, route through pi.sendUserMessage(text, {deliverAs:
 *   "followUp"}) with text `[TIMER FIRED — Ns elapsed] <reason> — Resume the task.`
 *   For wake: false, keep the existing sendTrackedMessage path with
 *   `[TIMER FIRED] <reason>` text.
 *   The prompt-builder emits a new TIMER_FIRE_HANDLING section instructing
 *   the agent how to react.
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
const PROMPT_SRC = readFileSync(
  join(ROOT, "src/extensions/core/prompt-builder/index.ts"),
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

console.log("=== Timer fire wake: true handling (Layers 2/3) ===");

// ── Layer 2: wake: true uses sendUserMessage, NOT sendMessage ──────────

test("Layer 2: wake: true branch calls pi.sendUserMessage", () => {
  // The wake:true branch should NOT be inside the sendTrackedMessage call.
  // Look for the conditional structure: `if (timer.wake === true) { ... sendUserMessage ... }`
  assert.ok(
    /if\s*\(\s*timer\.wake\s*===\s*true\s*\)/.test(TIMER_SRC),
    "must have an `if (timer.wake === true)` branch in fireTimer",
  );
  // The branch body must call sendUserMessage (or the cast of it).
  // Check the relative location: sendUserMessage appears AFTER `if (timer.wake === true)` line.
  const wakeBranchIdx = TIMER_SRC.indexOf("if (timer.wake === true)");
  assert.ok(wakeBranchIdx > 0, "wake:true branch exists");
  const sendUserMessageIdx = TIMER_SRC.indexOf("sendUserMessage(", wakeBranchIdx);
  assert.ok(
    sendUserMessageIdx > wakeBranchIdx,
    "sendUserMessage must be called within the wake:true branch",
  );
  // It should be BEFORE the next "} else {" or "if (timer.wake" or "sendTrackedMessage" call.
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeBranchIdx);
  if (elseIdx > 0) {
    assert.ok(
      sendUserMessageIdx < elseIdx,
      "sendUserMessage must be in wake:true branch, not wake:false",
    );
  }
});

test("Layer 2: wake: true does NOT use sendTrackedMessage", () => {
  // The wake:true branch must not wrap sendTrackedMessage.
  // Find the wake:true branch body and check it doesn't contain sendTrackedMessage.
  const wakeBranchStart = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeBranchStart);
  if (elseIdx < 0) {
    throw new Error("could not find else branch");
  }
  const wakeBranch = TIMER_SRC.slice(wakeBranchStart, elseIdx);
  assert.ok(
    !wakeBranch.includes("sendTrackedMessage"),
    "wake:true branch must NOT use sendTrackedMessage (use sendUserMessage instead)",
  );
});

test("Layer 2: sendUserMessage uses deliverAs: followUp", () => {
  // SDK contract: sendUserMessage with deliverAs: followUp forces a turn
  // and queues for the next turn if the agent is streaming.
  const wakeBranchStart = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeBranchStart);
  const wakeBranch = TIMER_SRC.slice(wakeBranchStart, elseIdx);
  assert.ok(
    /deliverAs:\s*"followUp"/.test(wakeBranch),
    'wake:true must use deliverAs: "followUp"',
  );
});

test("Layer 2: sendUserMessage failure is caught and logged", () => {
  // Fire-and-forget — wrap in .catch() so failures are logged, not silent.
  const wakeBranchStart = TIMER_SRC.indexOf("if (timer.wake === true)");
  const elseIdx = TIMER_SRC.indexOf("} else {", wakeBranchStart);
  const wakeBranch = TIMER_SRC.slice(wakeBranchStart, elseIdx);
  assert.ok(
    /\.catch\(/.test(wakeBranch),
    "wake:true sendUserMessage must have .catch() for failure logging",
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

// ── Prompt-builder: TIMER_FIRE_HANDLING section ────────────────────────

test("Prompt: TIMER_FIRE_HANDLING constant exists with [TIMER FIRED] reference", () => {
  assert.ok(
    /const\s+TIMER_FIRE_HANDLING\s*=/.test(PROMPT_SRC),
    "TIMER_FIRE_HANDLING constant must be defined in prompt-builder",
  );
  // Find the constant and check it mentions the prefix
  const constIdx = PROMPT_SRC.indexOf("const TIMER_FIRE_HANDLING =");
  // Find the next backtick close (end of template literal)
  const endIdx = PROMPT_SRC.indexOf("`;", constIdx);
  const literal = PROMPT_SRC.slice(constIdx, endIdx);
  assert.ok(
    /\[TIMER FIRED/.test(literal),
    "TIMER_FIRE_HANDLING must reference [TIMER FIRED] in its prompt",
  );
  assert.ok(
    /Acknowledge/i.test(literal),
    "TIMER_FIRE_HANDLING must tell the agent to acknowledge the timer",
  );
});

test("Prompt: TIMER_FIRE_HANDLING is pushed into the system prompt", () => {
  // Find the parts.push() call for TIMER_FIRE_HANDLING
  assert.ok(
    /parts\.push\(\s*TIMER_FIRE_HANDLING\s*\)/.test(PROMPT_SRC),
    "TIMER_FIRE_HANDLING must be parts.push()'d into the system prompt",
  );
});

// ── Sanity: previous regression test still passes (priority fix) ─────

test("Sanity: priorityFromSource still maps timer/fire to critical (Layer 1)", () => {
  // The previous fix (Layer 1) — priority:critical — must still hold.
  const trackerSrc = readFileSync(
    join(ROOT, "src/lib/utils/injection-tracker.ts"),
    "utf-8",
  );
  // Look for "timer" and "fire" both in the priorityFromSource critical regex
  // (escaped slashes in regex literal: timer\/fire)
  assert.ok(
    /tool-safety[\\|]auto-singleton[\\|]auto-recovery[\\|]turn-outcome[\\]\/loop[\\|]timer[\\]\/fire/.test(
      trackerSrc,
    ),
    "priorityFromSource must still include timer/fire in the critical regex",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log("=== Timer fire wake handling tests passed ===");
