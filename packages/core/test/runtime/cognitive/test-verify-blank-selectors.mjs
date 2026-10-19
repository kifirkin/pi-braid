/**
 * Fixture: verify reads blank selectors as absent.
 *
 * A client that fills every schema key sends "" for the ones it does not use.
 * The framework leaves strings blank (only numerics are converted, to 0), so
 * before the fix:
 * - targetText "" skipped the documented auto-detection path and the refusal
 *   misnamed the cause;
 * - confidenceThreshold 0 (a converted blank) disabled the gate entirely;
 * - criteria [""] reached the rubric as an empty entry.
 *
 * After the fix a blank targetText still auto-detects, an unusable threshold
 * falls back to the documented 0.5, and blank criteria elements are dropped.
 * The controls keep the fix from becoming a blanket pass: a real threshold
 * still gates, and auto-detection with nothing to find still refuses.
 *
 * Run: node test/runtime/cognitive/test-verify-blank-selectors.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const { createVerifyTool } = await import(
  join(ROOT, "dist/extensions/cognitive/metacognition/handlers/verify.js")
);

// The defaults are not exported; the code target's rubric is asserted by
// shape (a non-empty list of real strings, no blank survivor) instead of
// identity with a private constant.
const CLEAN_CODE =
  "```js\nconst total = items.reduce((sum, item) => sum + item.price, 0);\n```";
// Three heuristic issues (eval, innerHTML assignment, delete-with-comma) and
// no unresolved-work marker, so the confidence lands between 0 and 0.5.
const RISKY_CODE =
  "```js\neval(payload);\nnode.innerHTML = value;\ndelete cache, { keep: 1 };\n```";

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

/** A fixture ctx whose branch carries one assistant message, or none. */
function makeCtx(text) {
  const branch = [];
  if (text !== undefined) {
    branch.push({
      id: "e0",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: 1,
      },
    });
  }
  return {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    sessionManager: {
      getSessionFile: () => "/tmp/verify-blank-selectors.jsonl",
      getSessionId: () => "verify-blank-selectors",
      getBranch: () => branch,
    },
  };
}

const tool = createVerifyTool();

async function run(args, ctx) {
  return tool.execute("verify-1", args, undefined, undefined, ctx);
}

console.log("=== verify blank selectors ===\n");

await test("blank targetText runs auto-detection (target present)", async () => {
  const ctx = makeCtx(CLEAN_CODE);
  const result = await run(
    { target: "code", targetText: "", confidenceThreshold: "", depth: "quick" },
    ctx,
  );
  assert.equal(result.details.passed, true, `unexpected refusal: ${result.content?.[0]?.text}`);
  assert.deepEqual(result.details.issues, [], "the clean text has no heuristic issue");
  assert.doesNotMatch(
    result.content?.[0]?.text ?? "",
    /Auto-detection ran/,
    "auto-detection found the target, so there is no refusal",
  );
});

await test("blank targetText with nothing to detect names auto-detection", async () => {
  const ctx = makeCtx(undefined);
  const result = await run({ target: "code", targetText: "", depth: "quick" }, ctx);
  assert.equal(result.details.reason, "no-text");
  assert.match(
    result.content?.[0]?.text ?? "",
    /Auto-detection ran over recent context and found no target text/,
    "the refusal says auto-detection ran and found nothing",
  );
});

await test("blank confidenceThreshold applies the documented 0.5", async () => {
  const result = await run(
    { target: "code", targetText: CLEAN_CODE, confidenceThreshold: "", depth: "quick" },
    makeCtx(CLEAN_CODE),
  );
  assert.equal(result.details.confidenceThreshold, 0.5);
  assert.equal(result.details.confidence, 0.7, "the heuristic confidence is unchanged");
  assert.equal(result.details.passed, true, "0.7 clears the default gate");
});

await test("unusable thresholds (0, above 1) fall back to 0.5", async () => {
  for (const value of [0, 1.5]) {
    const result = await run(
      { target: "code", targetText: CLEAN_CODE, confidenceThreshold: value, depth: "quick" },
      makeCtx(CLEAN_CODE),
    );
    assert.equal(
      result.details.confidenceThreshold,
      0.5,
      `confidenceThreshold ${value} must fall back to the documented 0.5`,
    );
    assert.equal(result.details.passed, true, "the default gate passes 0.7");
  }
});

await test("the default gate blocks a confidence between 0 and 0.5", async () => {
  const result = await run(
    { target: "code", targetText: RISKY_CODE, confidenceThreshold: "", depth: "quick" },
    makeCtx(RISKY_CODE),
  );
  assert.equal(result.details.confidenceThreshold, 0.5);
  assert.ok(
    result.details.confidence > 0 && result.details.confidence < 0.5,
    `confidence ${result.details.confidence} must sit under the 0.5 gate`,
  );
  assert.equal(result.details.blockedFinalize, true);
  assert.equal(result.details.passed, false);
});

await test("a real threshold still gates (control)", async () => {
  const result = await run(
    { target: "code", targetText: CLEAN_CODE, confidenceThreshold: 0.9, depth: "quick" },
    makeCtx(CLEAN_CODE),
  );
  assert.equal(result.details.confidenceThreshold, 0.9, "a usable value is kept");
  assert.equal(result.details.confidence, 0.7);
  assert.equal(result.details.passed, false, "0.7 does not clear a 0.9 threshold");
  assert.equal(result.details.blockedFinalize, true);
});

await test("blank criteria elements are dropped", async () => {
  const allBlank = await run(
    { target: "code", targetText: CLEAN_CODE, criteria: ["", "  "], depth: "quick" },
    makeCtx(CLEAN_CODE),
  );
  assert.ok(Array.isArray(allBlank.details.criteria), "the rubric used is reported");
  assert.ok(
    allBlank.details.criteria.length > 0,
    "an all-blank rubric falls back to the target defaults",
  );
  assert.ok(
    allBlank.details.criteria.every((c) => typeof c === "string" && c.trim() !== ""),
    "no blank survivor reaches the rubric",
  );

  const mixed = await run(
    {
      target: "code",
      targetText: CLEAN_CODE,
      criteria: ["", "must mention the guard"],
      depth: "quick",
    },
    makeCtx(CLEAN_CODE),
  );
  assert.deepEqual(mixed.details.criteria, ["must mention the guard"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
