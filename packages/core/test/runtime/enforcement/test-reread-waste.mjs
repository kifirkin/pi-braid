/**
 * Re-read waste detection - a file read again with no edit/write/bash in
 * between must be reported, and progress between the two reads must clear it.
 *
 * The state under test is the path map the tool-call handler fills; these
 * cases drive the same handlers production does (recordToolCall then
 * recordToolInput) so the assertion covers the wiring, not a helper alone.
 *
 * Run: node test/runtime/enforcement/test-reread-waste.mjs
 */

import { strict as assert } from "node:assert";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { getState } = await import(join(ROOT, "dist", "extensions", "enforcement", "state.js"));
const { recordToolCall, recordToolInput } = await import(
  join(ROOT, "dist", "extensions", "enforcement", "handlers", "tool-tracker.js")
);
const { validateTurn } = await import(
  join(ROOT, "dist", "extensions", "enforcement", "validation.js")
);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [fail] ${name}: ${e.message}`);
  }
}

function turnState(actualTools) {
  return {
    turnIndex: 1,
    plannedTools: [],
    actualTools,
    toolOutputs: [],
    scratchpadUpdated: false,
    memoryUpdated: false,
    sequenceRepetitionCount: 0,
    thinkCalledBeforeEdit: false,
    planCalledForBugFix: false,
  };
}

/** Mirror the tool-call handler order: count the call, then record its input. */
function issueToolCall(ctx, toolName, input) {
  recordToolCall(toolName, ctx);
  recordToolInput(toolName, input, getState(ctx));
}

const read = (ctx, path) => issueToolCall(ctx, "read", { path });

test("re-read with no intervening progress is reported", () => {
  const ctx = {};
  read(ctx, "/tmp/reread-a.ts");
  read(ctx, "/tmp/reread-b.ts");
  read(ctx, "/tmp/reread-a.ts");
  read(ctx, "/tmp/reread-c.ts");

  const result = validateTurn(undefined, turnState(["read", "read", "read", "read"]), ctx);
  assert.ok(
    result.issues.some((i) => i.includes("/tmp/reread-a.ts")),
    `expected the re-read issue to name /tmp/reread-a.ts; issues: ${JSON.stringify(result.issues)}`,
  );
});

test("progress between reads clears the waste", () => {
  const ctx = {};
  read(ctx, "/tmp/reread-d.ts");
  issueToolCall(ctx, "edit", { path: "/tmp/reread-d.ts" });
  read(ctx, "/tmp/reread-d.ts");
  read(ctx, "/tmp/reread-e.ts");

  const result = validateTurn(undefined, turnState(["read", "read", "read"]), ctx);
  assert.ok(
    !result.issues.some((i) => i.includes("/tmp/reread-d.ts")),
    `edit before the second read must clear the waste; issues: ${JSON.stringify(result.issues)}`,
  );
});

test("first-time reads are never reported as waste", () => {
  const ctx = {};
  read(ctx, "/tmp/reread-f.ts");
  read(ctx, "/tmp/reread-g.ts");

  const result = validateTurn(undefined, turnState(["read", "read"]), ctx);
  assert.ok(
    !result.issues.some((i) => i.includes("/tmp/reread-f.ts") || i.includes("/tmp/reread-g.ts")),
    `two distinct first reads must not be flagged; issues: ${JSON.stringify(result.issues)}`,
  );
});

console.log(`\ntest-reread-waste: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
