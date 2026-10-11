/**
 * Auto-tagging must persist through pi.setLabel(), not sessionManager.setLabel().
 *
 * braid's local `SessionManager` interface declared `setLabel(id, label)`, but
 * pi's session manager instance has no such method — the supported path is the
 * extension API's `pi.setLabel()` (agent-session maps it to
 * `appendLabelChange`). Every call site sat inside a "best-effort" try/catch,
 * so the TypeError was swallowed at debug level and the tags never persisted:
 * `/finalize`'s `after-*` checkpoint, post-cycle `cycle-N` tags, and
 * context-lifecycle's `before-*` / escalation tags.
 *
 * The first half drives the real finalize tool through the metacognition
 * extension factory and asserts the label reaches the extension API. The
 * second half scans the remaining call sites, so a future edit that reaches
 * for the instance method again fails here instead of going quiet.
 *
 * Run: node test/runtime/cognitive/test-finalize-label-persistence.mjs
 *      (after npm run build — this test reads dist, not src)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// HOME isolation before the dist imports: finalize persists memory/evidence
// artifacts under the home directory as fire-and-forget work.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "finalize-label-"));
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "..", "..", "src");

const { default: metacognitionExtension } = await import(
  "../../../dist/extensions/cognitive/metacognition/index.js"
);

console.log("=== auto-tagging uses pi.setLabel ===\n");

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

function makePi() {
  const labels = [];
  return {
    tools: [],
    labels,
    registerTool(tool) {
      this.tools.push(tool);
    },
    on() {},
    setLabel(entryId, label) {
      labels.push([entryId, label]);
    },
  };
}

function makeCtx() {
  const file = `finalize-label-${Date.now()}.jsonl`;
  return {
    cwd: FAKE_HOME, // no .git here: deliverables stay out of the repo
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => file,
      getLeafId: () => "leaf-7",
      getLabel: () => undefined,
    },
  };
}

await test("finalize auto-tags the current leaf through pi.setLabel", async () => {
  const pi = makePi();
  metacognitionExtension(pi);
  const finalizeTool = pi.tools.find((t) => t.name === "finalize");
  assert.ok(finalizeTool, "the factory must register the finalize tool");

  const result = await finalizeTool.execute(
    "call-1",
    { summary: "Did a thing", completed: true },
    undefined,
    undefined,
    makeCtx(),
  );

  assert.equal(result.details.finalized, true, "finalize completed");
  assert.deepEqual(
    pi.labels,
    [["leaf-7", "after-did-a-thing"]],
    "the checkpoint label reaches pi.setLabel with the leaf id",
  );
});

// The remaining call sites are pinned structurally: each must reach the
// extension API's setLabel (directly or through the factory's callback) and
// must not reach for the session-manager instance method again.
const LABEL_SITES = [
  // finalize.ts takes the label setter as a callback (wired below).
  ["extensions/cognitive/metacognition/handlers/finalize.ts", /setLabel\(leafId, tagName\)/, 1],
  ["extensions/cognitive/metacognition/index.ts", /pi\.setLabel\(/, 1],
  ["extensions/enforcement/handlers/register-post-cycle-hygiene.ts", /pi\.setLabel\(/, 1],
  ["extensions/memory/context-lifecycle/index.ts", /pi\.setLabel\(/, 2],
];

await test("every auto-tag call site reaches pi.setLabel", () => {
  for (const [rel, needle, count] of LABEL_SITES) {
    const src = readFileSync(join(SRC, rel), "utf-8");
    const hits = src.match(new RegExp(needle.source, "g")) ?? [];
    assert.equal(hits.length, count, `${rel} must call ${needle} ${count}x`);
    assert.ok(
      !/(?:^|[^.\w])(?:sm|sessionManager)\.setLabel\(/.test(src),
      `${rel} must not call the session manager instance method`,
    );
  }
});

await test("the local SessionManager type no longer declares setLabel", () => {
  const src = readFileSync(join(SRC, "lib/state/session-manager.ts"), "utf-8");
  assert.ok(
    !/setLabel\s*\(/.test(src),
    "session-manager.ts must not declare a setLabel the instance does not have",
  );
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== auto-tag label tests passed ===");
