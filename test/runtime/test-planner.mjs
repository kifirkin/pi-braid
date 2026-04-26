import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const src = readFileSync(join(ROOT, "src/extensions/core/planner/index.ts"), "utf-8");

{
	console.log("=== Planner Extension ===");
	assert.ok(src.length > 0, "planner/index.ts should exist");
	assert.ok(src.includes("registerTool"), "should register tools");
	const toolMatches = [...src.matchAll(/registerTool\s*\(\s*\{[\s\S]*?name\s*:\s*["']([^"']+)["']/g)];
	const toolNames = toolMatches.map((m) => m[1]);
	console.log(`  Registered tools: ${toolNames.length} (${toolNames.join(", ")})`);
	assert.ok(toolNames.length >= 3, `expected ≥3 tools, got ${toolNames.length}`);
	console.log("  ✅ Extension: all assertions passed");
}

console.log("\n=== Results: All planner tests passed ===");
