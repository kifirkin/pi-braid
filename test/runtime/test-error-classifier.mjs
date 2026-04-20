const ROOT = "/Users/kifir/projects/agents/pi-braid";
const { classifyError, isRetryable, getErrorCategory, isCompactionRetryable } = await import(`${ROOT}/dist/lib/error-classifier.js`);

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log("  ✅ "+msg)) : (failed++, console.log("  ❌ "+msg));

console.log("\n[1] Rate limit");
assert(classifyError("429 rate limit").category === "TRANSIENT", "429 TRANSIENT");
assert(classifyError("429 rate limit").retryable === true, "429 retryable");

console.log("\n[2] Server errors");
assert(classifyError("500 error").category === "TRANSIENT", "500 TRANSIENT");
assert(classifyError("502 bad gateway").category === "TRANSIENT", "502 TRANSIENT");
assert(classifyError("503 unavailable").category === "TRANSIENT", "503 TRANSIENT");
assert(classifyError("529 overloaded").category === "TRANSIENT", "529 TRANSIENT");

console.log("\n[3] Auth errors");
assert(classifyError("401 unauthorized").category === "CLIENT_ERROR", "401 CLIENT_ERROR");
assert(classifyError("401 unauthorized").retryable === false, "401 not retryable");
assert(classifyError("403 forbidden").category === "CLIENT_ERROR", "403 CLIENT_ERROR");

console.log("\n[4] Context overflow");
assert(classifyError("context_length_exceeded").category === "CONTEXT_OVERFLOW", "context_overflow");

console.log("\n[5] Unknown");
assert(classifyError("something went wrong").category === "UNKNOWN", "unknown category");
assert(classifyError("").category === "UNKNOWN", "empty error");

console.log("\n[6] HTTP status");
assert(classifyError("500 Internal").httpStatus === 500, "HTTP 500 extracted");
assert(classifyError("429 rate limit").httpStatus === 429, "HTTP 429 extracted");

console.log("\n[7] isRetryable helper");
assert(isRetryable("429 rate limit") === true, "429 retryable");
assert(isRetryable("500 server error") === true, "500 retryable");
assert(isRetryable("401 unauthorized") === false, "401 not retryable");

console.log("\n[8] isCompactionRetryable");
assert(isCompactionRetryable("429 rate limit") === true, "429 compaction-retryable");
assert(isCompactionRetryable("401 unauthorized") === false, "401 not compaction-retryable");

console.log("\n"+("=".repeat(50)));
console.log("Error Classifier: "+passed+" passed, "+failed+" failed");
if (failed > 0) process.exit(1);
