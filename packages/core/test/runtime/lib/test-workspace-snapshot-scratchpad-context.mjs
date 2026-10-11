/**
 * Workspace snapshots must read scratchpad state through a surface that exists.
 *
 * `callScratchpadTool` probed `ctx.tools.scratchpad` — a name-keyed record
 * that pi never builds. On a tool context `tools` is `readonly AgentTool[]`
 * (an array), and on an event context the member is absent entirely, so every
 * call returned `undefined`: the unpersisted-learnings advisory after
 * compaction never fired and snapshots never captured goal/plan/decision
 * counts. (Even a successful call would not have helped: the scratchpad
 * tool's result details carry `{action, prior_goal, plan: <count>, save_error}`,
 * not the fields these two readers use.)
 *
 * The scratchpad's session cache is the sanctioned in-process read surface —
 * the same `scratchpad-cache` bucket finalize.ts reads. This drives the real
 * `captureSnapshot` and asserts the working context lands in the snapshot
 * metadata, then pins the compaction reader to the same helper.
 *
 * Run: node test/runtime/lib/test-workspace-snapshot-scratchpad-context.mjs
 *      (after npm run build — this test reads dist, not src)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// HOME isolation before the dist imports: snapshots land under the braid
// directory, which braid-paths bakes at module-eval time.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "snapshot-scratchpad-"));
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "..", "..", "src");

const { captureSnapshot } = await import("../../../dist/lib/state/workspace-snapshot.js");
const { getExtensionState } = await import("../../../dist/lib/state/extension-state.js");

console.log("=== snapshot scratchpad context ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

let seq = 0;

function makeCtx() {
  const file = `snapshot-${seq++}-${Date.now()}.jsonl`;
  return {
    cwd: FAKE_HOME,
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => file,
      getLeafId: () => "leaf-1",
      getLabel: () => undefined,
    },
  };
}

/** Seed the scratchpad session cache the way the scratchpad extension does. */
function seedScratchpad(ctx, pad) {
  const cache = getExtensionState(ctx, "scratchpad-cache", () => ({ pad: null }));
  cache.pad = pad;
}

await test("captureSnapshot records goal/plan/decision/learning counts", async () => {
  const ctx = makeCtx();
  seedScratchpad(ctx, {
    goal: "Ship the phantom fixes",
    plan: [{ id: "pl-1" }, { id: "pl-2" }],
    decisions: [{ id: "d-1" }],
    key_learnings: [{ id: "l-1", persisted: false }, { id: "l-2", persisted: true }],
  });

  const file = join(FAKE_HOME, "sample.ts");
  writeFileSync(file, "export const x = 1;\n");

  const meta = await captureSnapshot(ctx, "test capture", [file], FAKE_HOME);
  assert.ok(meta, "a snapshot with one readable file must be produced");
  assert.deepEqual(
    meta.context,
    {
      goal: "Ship the phantom fixes",
      planStepCount: 2,
      decisionCount: 1,
      learningCount: 2,
    },
    "working context must come from the scratchpad session state",
  );
});

await test("cold scratchpad cache leaves context unset (no crash, no fake zeros)", async () => {
  const ctx = makeCtx();
  const file = join(FAKE_HOME, "sample2.ts");
  writeFileSync(file, "export const y = 2;\n");

  const meta = await captureSnapshot(ctx, "test capture 2", [file], FAKE_HOME);
  assert.ok(meta, "snapshot still produced");
  assert.equal(meta.context, undefined, "no scratchpad state means no context block");
});

await test("the compaction reader uses the same scratchpad state helper", () => {
  const src = readFileSync(
    join(SRC, "extensions/enforcement/handlers/register-session-compact.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes("readScratchpadState("),
    "register-session-compact must read scratchpad state through the shared helper",
  );
  assert.ok(
    !/\.tools\?\.?\s*(?:scratchpad|\w+)/.test(src),
    "register-session-compact must not probe the phantom ctx.tools record",
  );
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== snapshot scratchpad context tests passed ===");
