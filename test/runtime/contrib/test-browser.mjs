import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";

const browserExtDir = join(os.homedir(), ".pi/agent/extensions/pi-browser/index.ts");

if (!existsSync(browserExtDir)) {
  console.log("=== Browser Extension: SKIPPED (pi-browser extension not installed) ===");
  process.exit(0);
}

const src = readFileSync(browserExtDir, "utf-8");

{
	console.log("=== Browser Extension ===");
	assert.ok(src.length > 0, "browser/index.ts should exist");
	assert.ok(src.includes("registerTool"), "should register tools");
	assert.ok(src.includes("cdp") || src.includes("CDP") || src.includes("Session"), "should have CDP automation");
	const toolMatches = [...src.matchAll(/registerTool\s*\(\s*\{[\s\S]*?name\s*:\s*["']([^"']+)["']/g)];
	const toolNames = toolMatches.map((m) => m[1]);
	console.log(`  Registered tools: ${toolNames.length} (${toolNames.join(", ")})`);
	console.log("  ✅ All assertions passed");
}

console.log("\n=== Results: All browser tests passed ===");
