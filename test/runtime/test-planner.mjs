/**
 * Test: Planner Extension — removed 2026-05-04 (all tools removed, empty shell).
 *
 * Verifies that:
 * 1. The planner directory and file no longer exist
 * 2. The module definitions no longer import or reference planner
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

console.log("=== Planner (removed) ===");

// [1] Planner directory should NOT exist
assert.ok(!existsSync(join(ROOT, "src/extensions/core/planner")), "planner directory removed");

// [2] Module definitions should NOT import planner
const defs = readFileSync(join(ROOT, "src/modules/definitions.ts"), "utf-8");
assert.ok(!defs.includes("corePlannerFn"), "no corePlannerFn import in definitions.ts");
assert.ok(!defs.includes('"planner"'), 'no "planner" extension entry in definitions.ts');

// [3] Core module description should NOT mention planner
const coreDescLine = defs.split("\n").find(l => l.includes('description: "Foundation'));
assert.ok(coreDescLine && !coreDescLine.includes("planner"), "core description no longer mentions planner");

console.log("  ✅ All planner-removal assertions passed");
console.log("\n=== Results: All planner tests passed ===");
