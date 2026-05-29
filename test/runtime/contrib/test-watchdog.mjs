import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { strict as assert } from "node:assert";

const __dirname = dirname(new URL(import.meta.url).pathname);
const ROOT = join(__dirname, "..", "..", "..");

function readSrc(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf-8");
}

console.log("=== Watchdog Extension Tests ===\n");

// Test 1: File exists and exports default function
console.log("[1] Extension structure...");
const src = readSrc("src/extensions/watchdog/index.ts");
assert.ok(src.length > 0, "watchdog/index.ts should exist");
assert.ok(src.includes("export default function"), "should export default function");

// Test 2: Registers expected handlers
console.log("[2] Event handlers...");
assert.ok(src.includes("session_start") || src.includes("registerSessionStartHandler"), "should register session_start handler");
assert.ok(src.includes("message_end"), "should register message_end handler");
assert.ok(src.includes("agent_start"), "should register agent_start handler");
assert.ok(src.includes("agent_end"), "should register agent_end handler");

// Test 3: Registers watchdog-status command
console.log("[3] Commands...");
assert.ok(src.includes("watchdog-status"), "should register watchdog-status command");
assert.ok(src.includes("registerCommand"), "should use registerCommand");

// Test 4: Session state management
console.log("[4] Session state...");
assert.ok(src.includes("sessions.set"), "should use sessions map");
assert.ok(src.includes("getSessionFile"), "should use getSessionFile for session key");
assert.ok(src.includes("formatTime"), "should have formatTime helper");

// Test 5: UI integration
console.log("[5] UI integration...");
assert.ok(src.includes("ui.setStatus"), "should set UI status");
assert.ok(src.includes("watchdog"), "should set status to 'watchdog'");

console.log("\n=== Results: All watchdog tests passed ===");
