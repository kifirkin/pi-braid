import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const src = readFileSync(join(ROOT, "src/extensions/cognitive/cognitive-systems/index.ts"), "utf-8");

{
	console.log("=== Cognitive Systems Extension ===");
	assert.ok(src.length > 0, "cognitive-systems/index.ts should exist");
	assert.ok(src.includes("ExtensionAPI") || src.includes("ExtensionContext") || src.includes("pi."), "should use pi API");
	console.log("  ✅ Extension: all assertions passed");
}

console.log("\n=== Results: All cognitive-systems tests passed ===");
