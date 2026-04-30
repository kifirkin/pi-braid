import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const src = readFileSync(join(ROOT, "src/extensions/memory/three-memory-stores/index.ts"), "utf-8");

{
	console.log("=== Three Memory Stores ===");
	assert.ok(src.length > 0, "three-memory-stores/index.ts should exist");
	assert.ok(src.includes("registerTool"), "should register tools");
	assert.ok(src.includes("getExtensionState"), "should use session-scoped state");
	const toolMatches = [...src.matchAll(/registerTool\s*\(\s*\{[\s\S]*?name\s*:\s*["']([^"']+)["']/g)];
	const toolNames = toolMatches.map((m) => m[1]);
	console.log(`  Registered tools: ${toolNames.length} (${toolNames.join(", ")})`);
	assert.ok(toolNames.length >= 3, `expected ≥3 tools, got ${toolNames.length}`);
	// heuristics_evaluate removed (2026-04-28) — was rarely used, duplicates session analysis
	console.log("  ✅ All assertions passed");
}

console.log("\n=== Results: All three-memory-stores tests passed ===");
