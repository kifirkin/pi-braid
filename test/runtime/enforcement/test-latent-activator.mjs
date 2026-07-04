import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../../");
const indexSrc = readFileSync(join(ROOT, "src/extensions/self/latent-activator/index.ts"), "utf-8");
const stateSrc = readFileSync(join(ROOT, "src/extensions/self/latent-activator/state.ts"), "utf-8");

{
	console.log("=== Latent Activator ===");
	assert.ok(indexSrc.length > 0, "latent-activator/index.ts should exist");
	assert.ok(stateSrc.length > 0, "latent-activator/state.ts should exist");
	assert.ok(indexSrc.includes("registerTool"), "index.ts should register tools");
	assert.ok(stateSrc.includes("getExtensionState"), "state.ts should use session-scoped state");
	assert.ok(indexSrc.includes("session_start"), "index.ts should reset state on session_start");
	const toolMatches = [...indexSrc.matchAll(/registerTool\s*\(\s*\{[\s\S]*?name\s*:\s*["']([^"']+)["']/g)];
	const toolNames = toolMatches.map((m) => m[1]);
	console.log(`  Registered tools: ${toolNames.length} (${toolNames.join(", ")})`);
	assert.ok(toolNames.length >= 1, `expected at least 1 tool, got ${toolNames.length}`);
	console.log("  [ok] All assertions passed");
}

console.log("\n=== Results: All latent-activator tests passed ===");