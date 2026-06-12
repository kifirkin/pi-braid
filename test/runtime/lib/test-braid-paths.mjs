/**
 * Test: braid-paths — centralized storage path resolution.
 *
 * Verifies that all exported paths resolve correctly to the expected
 * directory structure under ~/.pi/agent/braid/.
 */

import { strict as assert } from "node:assert";
import * as path from "node:path";
import * as os from "node:os";

const {
  BRAID_DIR, AGENT, MEMORY_DIR, CHECKPOINT_DIR, ERROR_DIR, SCRATCHPAD_DIR, METRICS_DIR,
  SEMANTIC_MEMORY_FILE, EPISODES_FILE, ERROR_LOG_FILE, CONSOLIDATED_HINTS_FILE,
  METRICS_FILE, DEGRADATION_FILE, LEGACY_MEMORY_FILE,
} = await import("../../../dist/lib/config/braid-paths.js");

const HOME = os.homedir();
const PI = path.join(HOME, ".pi");
const EXPECTED_AGENT = path.join(PI, "agent");
const EXPECTED_BRAID = path.join(EXPECTED_AGENT, "braid");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

console.log("braid-paths test\n");

test("AGENT points to ~/.pi/agent", () => {
  assert.equal(AGENT, EXPECTED_AGENT);
});

test("BRAID_DIR points to ~/.pi/agent/braid", () => {
  assert.equal(BRAID_DIR, EXPECTED_BRAID);
});

test("MEMORY_DIR is <braid>/memory", () => {
  assert.equal(MEMORY_DIR, path.join(EXPECTED_BRAID, "memory"));
});

test("CHECKPOINT_DIR is <braid>/checkpoints", () => {
  assert.equal(CHECKPOINT_DIR, path.join(EXPECTED_BRAID, "checkpoints"));
});

test("ERROR_DIR is <braid>/errors", () => {
  assert.equal(ERROR_DIR, path.join(EXPECTED_BRAID, "errors"));
});

test("SCRATCHPAD_DIR is <braid>/scratchpads", () => {
  assert.equal(SCRATCHPAD_DIR, path.join(EXPECTED_BRAID, "scratchpads"));
});

test("METRICS_DIR is <braid>/metrics", () => {
  assert.equal(METRICS_DIR, path.join(EXPECTED_BRAID, "metrics"));
});

test("SEMANTIC_MEMORY_FILE is <memory>/semantic.json", () => {
  assert.equal(SEMANTIC_MEMORY_FILE, path.join(MEMORY_DIR, "semantic.json"));
});

test("EPISODES_FILE is <memory>/episodes.jsonl", () => {
  assert.equal(EPISODES_FILE, path.join(MEMORY_DIR, "episodes.jsonl"));
});

test("ERROR_LOG_FILE is <errors>/errors.jsonl", () => {
  assert.equal(ERROR_LOG_FILE, path.join(ERROR_DIR, "errors.jsonl"));
});

test("CONSOLIDATED_HINTS_FILE is <braid>/consolidated-hints.jsonl", () => {
  assert.equal(CONSOLIDATED_HINTS_FILE, path.join(EXPECTED_BRAID, "consolidated-hints.jsonl"));
});


test("METRICS_FILE is <metrics>/braid-metrics.jsonl", () => {
  assert.equal(METRICS_FILE, path.join(METRICS_DIR, "braid-metrics.jsonl"));
});

test("DEGRADATION_FILE is <metrics>/degradation.json", () => {
  assert.equal(DEGRADATION_FILE, path.join(METRICS_DIR, "degradation.json"));
});

test("LEGACY_MEMORY_FILE is ~/.pi/memory/memory.json", () => {
  assert.equal(LEGACY_MEMORY_FILE, path.join(PI, "memory", "memory.json"));
});

test("SCRATCHPAD_DIR is distinct from MEMORY_DIR", () => {
  assert.notEqual(SCRATCHPAD_DIR, MEMORY_DIR);
});

test("All file paths are under their parent directories", () => {
  assert.ok(SEMANTIC_MEMORY_FILE.startsWith(MEMORY_DIR));
  assert.ok(EPISODES_FILE.startsWith(MEMORY_DIR));
  assert.ok(ERROR_LOG_FILE.startsWith(ERROR_DIR));
  assert.ok(METRICS_FILE.startsWith(METRICS_DIR));
  assert.ok(DEGRADATION_FILE.startsWith(METRICS_DIR));
  assert.ok(CONSOLIDATED_HINTS_FILE.startsWith(BRAID_DIR));
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
