/**
 * Error Classifier — runtime tests
 * Run: node test/runtime/test-error-classifier.mjs
 */
const ROOT = "/Users/kifir/projects/agents/pi-braid";
const { classifyError, isRetryable, getRetryDelay } = await import(`${ROOT}/dist/lib/error-classifier.js`);

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log(`  ✅ ${msg}`)) : (failed++, console.log(`  ❌ ${msg}`));

// ── Rate limit errors ──────────────────────────────────────────────────
console.log("\n[1] Rate limit errors");
{
	const c = classifyError("Rate limit exceeded: 429 Too Many Requests");
	assert(c.category === "TRANSIENT", `429 is TRANSIENT: ${c.category}`);
	assert(c.retryable === true, `429 is retryable: ${c.retryable}`);

	const c2 = classifyError("API rate limit hit. Please retry after 60 seconds.");
	assert(c2.category === "TRANSIENT", `Rate limit TRANSIENT: ${c2.category}`);
	assert(c2.retryDelay > 0, `Has retry delay: ${c2.retryDelay}`);
}

// ── Server errors ──────────────────────────────────────────────────────
console.log("\n[2] Server errors");
{
	const c = classifyError("500 Internal Server Error");
	assert(c.category === "TRANSIENT", `500 TRANSIENT: ${c.category}`);

	const c2 = classifyError("502 Bad Gateway");
	assert(c2.category === "TRANSIENT", `502 TRANSIENT: ${c2.category}`);

	const c3 = classifyError("503 Service Unavailable");
	assert(c3.category === "TRANSIENT", `503 TRANSIENT: ${c3.category}`);

	const c4 = classifyError("529 Anthropic overloaded");
	assert(c4.category === "TRANSIENT", `529 TRANSIENT: ${c4.category}`);
}

// ── Auth/permission errors ──────────────────────────────────────────────
console.log("\n[3] Auth/permission errors");
{
	const c = classifyError("401 Unauthorized: Invalid API key");
	assert(c.category === "AUTH", `401 AUTH: ${c.category}`);
	assert(c.retryable === false, `401 not retryable`);

	const c2 = classifyError("403 Forbidden: Access denied");
	assert(c2.category === "AUTH", `403 AUTH: ${c2.category}`);
}

// ── Context overflow ────────────────────────────────────────────────────
console.log("\n[4] Context overflow");
{
	const c = classifyError("context_length_exceeded: maximum context length is 128000 tokens");
	assert(c.category === "CONTEXT_OVERFLOW" || c.category === "PERMANENT", `Context overflow category: ${c.category}`);
}

// ── Network errors ────────────────────────────────────────────────────
console.log("\n[5] Network errors");
{
	const c = classifyError("fetch failed: ECONNREFUSED");
	assert(c.category === "TRANSIENT" || c.category === "NETWORK", `Network TRANSIENT: ${c.category}`);

	const c2 = classifyError("Connection timed out after 30000ms");
	assert(c2.category === "TRANSIENT" || c2.category === "NETWORK", `Timeout category: ${c2.category}`);
	assert(c2.retryable === true, `Timeout is retryable`);
}

// ── Unknown errors ────────────────────────────────────────────────────
console.log("\n[6] Unknown errors");
{
	const c = classifyError("Something went wrong");
	assert(c.category === "UNKNOWN", `Unknown category: ${c.category}`);

	const c2 = classifyError("");
	assert(c2.category === "UNKNOWN", `Empty error: ${c2.category}`);
}

// ── isRetryable helper ──────────────────────────────────────────────────
console.log("\n[7] isRetryable helper");
{
	assert(isRetryable("429 rate limit") === true, `429 retryable`);
	assert(isRetryable("500 server error") === true, `500 retryable`);
	assert(isRetryable("401 unauthorized") === false, `401 not retryable`);
	assert(isRetryable("unknown error") === false, `Unknown not retryable by default`);
}

// ── getRetryDelay helper ────────────────────────────────────────────────
console.log("\n[8] getRetryDelay helper");
{
	const d1 = getRetryDelay("429 rate limit");
	assert(typeof d1 === "number", `Delay is number: ${typeof d1}`);
	assert(d1 >= 0, `Delay >= 0: ${d1}`);

	const d2 = getRetryDelay("500 server error");
	assert(d2 >= 0, `Server delay >= 0: ${d2}`);
}

// ── Explicit markers ──────────────────────────────────────────────────
console.log("\n[9] Explicit markers");
{
	const c = classifyError("Error: do not retry this request");
	assert(c.retryable === false, `Explicit no-retry: ${c.retryable}`);

	const c2 = classifyError("Error: please retry this request");
	assert(c2.retryable === true, `Explicit retry: ${c2.retryable}`);
}

// ── Anthropic overloaded ──────────────────────────────────────────────
console.log("\n[10] Anthropic overloaded");
{
	const c = classifyError("Anthropic API error: overloaded_error");
	assert(c.category === "TRANSIENT", `Overloaded TRANSIENT: ${c.category}`);
	assert(c.retryable === true, `Overloaded retryable`);
}

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Error Classifier Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);