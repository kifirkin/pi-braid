/**
 * Test: standard-result - ToolResultMeta and withMeta helper.
 *
 * Verifies that withMeta adds standard fields to any tool's return value
 * without overwriting existing tool-specific details.
 */

import { strict as assert } from "node:assert";

const { withMeta } = await import("../../../dist/lib/types/standard-result.js");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

console.log("standard-result test\n");

test("withMeta adds confidence field", () => {
  const result = withMeta({ content: [{ type: "text", text: "hello" }] }, { confidence: 0.8 });
  assert.equal(result.details.confidence, 0.8);
});

test("withMeta adds alternativesConsidered", () => {
  const result = withMeta({ content: [] }, { alternativesConsidered: 3 });
  assert.equal(result.details.alternativesConsidered, 3);
});

test("withMeta adds suggestedNextTool", () => {
  const result = withMeta({ content: [] }, { suggestedNextTool: "explore_paths" });
  assert.equal(result.details.suggestedNextTool, "explore_paths");
});

test("withMeta adds relatedMemoryIds", () => {
  const result = withMeta({ content: [] }, { relatedMemoryIds: ["mem1", "mem2"] });
  assert.deepEqual(result.details.relatedMemoryIds, ["mem1", "mem2"]);
});

test("withMeta does not overwrite existing tool details", () => {
  const result = withMeta(
    { content: [{ type: "text", text: "analysis complete" }], details: { problem: "bug", severity: "high" } },
    { confidence: 0.7 },
  );
  assert.equal(result.details.problem, "bug");
  assert.equal(result.details.severity, "high");
  assert.equal(result.details.confidence, 0.7);
});

test("withMeta passes content through verbatim", () => {
  const content = [{ type: "text", text: "test" }];
  const result = withMeta({ content }, { confidence: 0.5 });
  assert.equal(result.content, content);
  assert.equal(result.content[0].text, "test");
});

test("withMeta returns all fields from the result", () => {
  const result = withMeta(
    { content: [], extraField: "extra" },
    { confidence: 0.9 },
  );
  assert.equal(result.extraField, "extra");
});

test("withMeta handles empty meta", () => {
  const result = withMeta({ content: [] }, {});
  assert.deepEqual(result.details, {});
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
