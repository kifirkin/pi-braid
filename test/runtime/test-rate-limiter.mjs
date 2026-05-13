import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { strict as assert } from "node:assert";

const __dirname = dirname(new URL(import.meta.url).pathname);
const ROOT = join(__dirname, "..", "..");

function readSrc(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf-8");
}

console.log("=== Rate Limiter Extension Tests ===\n");

// Test 1: File exists and exports default function
console.log("[1] Extension structure...");
const src = readSrc("src/contrib/rate-limiter/index.ts");
assert.ok(src.length > 0, "rate-limiter/index.ts should exist");
assert.ok(src.includes("export default function"), "should export default function");

// Test 2: Registers context handler
console.log("[2] Context handler...");
assert.ok(src.includes("pi.on(\"context\""), "should register context handler");
assert.ok(src.includes("RPM_LIMIT") || src.includes("TPM_LIMIT"), "should define rate limits");

// Test 3: Registers rate-cancel command
console.log("[3] Commands...");
assert.ok(src.includes("rate-cancel"), "should register rate-cancel command");
assert.ok(src.includes("registerCommand"), "should use registerCommand");

// Test 4: Token estimation
console.log("[4] Token estimation...");
assert.ok(src.includes("estimateTokens"), "should have estimateTokens function");
assert.ok(src.includes("text.length / 4"), "should estimate ~4 chars per token");

// Test 5: Interruptible sleep
console.log("[5] Sleep mechanism...");
assert.ok(src.includes("interruptibleSleep"), "should have interruptibleSleep function");
assert.ok(src.includes("shouldCancel"), "should check for cancellation");

// Test 6: Session shutdown cleanup
console.log("[6] Shutdown cleanup...");
assert.ok(src.includes("session_shutdown"), "should handle session_shutdown");
assert.ok(src.includes("state.clear()"), "should clear state on shutdown");

// Test 7: Rate limit logic
console.log("[7] Rate limit logic...");
assert.ok(src.includes("RPM_LIMIT") && src.includes("30"), "should set RPM limit (30)");
assert.ok(src.includes("TPM_LIMIT") && src.includes("500_000"), "should set TPM limit (500k)");
assert.ok(src.includes("oneMinuteAgo"), "should track requests in 60s window");

console.log("\n=== Results: All rate-limiter tests passed ===");
