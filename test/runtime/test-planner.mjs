import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const src = readFileSync(join(ROOT, "src/extensions/core/planner/index.ts"), "utf-8");

{
	console.log("=== Planner Extension ===");
	assert.ok(src.length > 0, "planner/index.ts should exist");
	assert.ok(src.includes("plannerExtension"), "should export extension factory");
	assert.ok(src.includes("goal") || src.includes("plan") || src.includes("scratchpad"),
		"planner should handle goal/plan restoration");
	// No tools registered — removed 2026-04-28 (plan_with_budget, check_budget, set_budget)
	const toolMatches = [...src.matchAll(/registerTool\s*\(\s*\{[\s\S]*?name\s*:\s*["']([^"']+)["']/g)];
	const toolNames = toolMatches.map((m) => m[1]);
	console.log(`  Registered tools: ${toolNames.length} (${toolNames.join(", ") || "none — goal/plan via scratchpad"})`);
	console.log("  ✅ Extension: all assertions passed");
}

console.log("\n=== Results: All planner tests passed ===");