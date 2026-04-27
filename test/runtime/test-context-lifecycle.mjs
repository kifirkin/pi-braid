import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const src = readFileSync(join(ROOT, "src/extensions/memory/context-lifecycle/index.ts"), "utf-8");

{
	console.log("=== Context Lifecycle ===");
	assert.ok(src.length > 0, "context-lifecycle/index.ts should exist");
	assert.ok(src.includes("getExtensionState"), "should use session-scoped state");
	assert.ok(src.includes("registerTool"), "should register tools");
	assert.ok(src.includes("session_start"), "should handle session_start");
	assert.ok(src.includes("turn_end"), "should handle turn_end");
	const toolMatches = [...src.matchAll(/registerTool\s*\(\s*\{[\s\S]*?name\s*:\s*["']([^"']+)["']/g)];
	const toolNames = toolMatches.map((m) => m[1]);
	console.log(`  Registered tools: ${toolNames.length} (${toolNames.join(", ")})`);
	assert.ok(toolNames.length >= 2, `expected ≥2 tools, got ${toolNames.length}`);
	console.log("  ✅ All assertions passed");
}

console.log("\n=== Results: All context-lifecycle tests passed ===");
