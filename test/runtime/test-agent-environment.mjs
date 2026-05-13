import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { strict as assert } from "node:assert";

const __dirname = dirname(new URL(import.meta.url).pathname);
const ROOT = join(__dirname, "..", "..");

function readSrc(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf-8");
}

console.log("=== Agent Environment Extension Tests ===\n");

// Test 1: File exists and exports
console.log("[1] Extension structure...");
const src = readSrc("src/extensions/core/agent-environment/index.ts");
assert.ok(src.length > 0, "agent-environment/index.ts should exist");
assert.ok(src.includes("export default function"), "should export default function");
assert.ok(src.includes("gatherL1Environment"), "should export gatherL1Environment");
assert.ok(src.includes("formatL1EnvironmentSection"), "should export formatL1EnvironmentSection");

// Test 2: L1 state interface
console.log("[2] L1 State...");
assert.ok(src.includes("AgentEnvironmentState"), "should define AgentEnvironmentState interface");
assert.ok(src.includes("sessionStart"), "should track session start");
assert.ok(src.includes("turnCount"), "should track turn count");
assert.ok(src.includes("toolCallStarts"), "should track tool call starts");

// Test 3: L1 environment data interface
console.log("[3] L1 Environment Data...");
assert.ok(src.includes("L1EnvironmentData"), "should define L1EnvironmentData interface");
assert.ok(src.includes("pid:"), "should include PID");
assert.ok(src.includes("sessionElapsedMs"), "should track session elapsed time");
assert.ok(src.includes("avgToolTimeMs"), "should track avg tool time");

// Test 4: Platform detection
console.log("[4] Platform detection...");
assert.ok(src.includes("os.platform()"), "should use os.platform()");
assert.ok(src.includes("darwin") || src.includes("macOS"), "should handle macOS");
assert.ok(src.includes("win32") || src.includes("Windows"), "should handle Windows");
assert.ok(src.includes("linux"), "should handle Linux");

// Test 5: time_status tool
console.log("[5] time_status tool...");
assert.ok(src.includes("time_status"), "should register time_status tool");
assert.ok(src.includes("createTimeStatusTool"), "should have createTimeStatusTool");
assert.ok(src.includes("action:"), "should have action parameter");
assert.ok(src.includes("status") && src.includes("mark") && src.includes("elapsed_since"), "should support all 3 actions");

// Test 6: Tool execution
console.log("[6] Tool execution...");
assert.ok(src.includes("switch (params.action)"), "should switch on action");
assert.ok(src.includes("case \"status\""), "should handle status action");
assert.ok(src.includes("case \"mark\""), "should handle mark action");
assert.ok(src.includes("case \"elapsed_since\""), "should handle elapsed_since action");

// Test 7: Format L1 section
console.log("[7] Format L1 section...");
assert.ok(src.includes("formatL1EnvironmentSection"), "should have format function");
assert.ok(src.includes("Session:") || src.includes("sessionElapsed"), "should format session time");
assert.ok(src.includes("PID:"), "should include PID");
assert.ok(src.includes("Turns:"), "should include turn count");

// Test 8: Session event tracking
console.log("[8] Session tracking...");
assert.ok(src.includes("session_start") || src.includes("registerSessionStartHandler"), "should handle session_start");
assert.ok(src.includes("message_end"), "should handle message_end");
assert.ok(src.includes("turnCount++"), "should increment turn count");

console.log("\n=== Results: All agent-environment tests passed ===");
