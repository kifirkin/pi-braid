/**
 * Retry extension — runtime tests.
 *
 * Tests state management (session-scoped), error classification,
 * and auto-retry strategy logic.
 */

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "../..");

// ── Types (re-import from dist) ──────────────────────────────────────────────

const { classifyRetryError, ErrorCategory, transientRetryStrategy, DEFAULT_RETRY_CONFIG } = await import(
	join(ROOT, "dist/extensions/retry/retry/types.js")
);

// ── Error Classification Tests ───────────────────────────────────────────────

{
	console.log("=== Error Classification ===");

	// Transient errors
	const cases = [
		{ msg: "Connection timeout", status: null, expected: "transient", retryable: true },
		{ msg: "Internal Server Error", status: 500, expected: "transient", retryable: true },
		{ msg: "Bad Gateway", status: 502, expected: "transient", retryable: true },
		{ msg: "Service Unavailable", status: 503, expected: "transient", retryable: true },
		{ msg: "fetch failed", status: null, expected: "transient", retryable: true },
		{ msg: "ECONNRESET", status: null, expected: "transient", retryable: true },
		{ msg: "network error", status: null, expected: "transient", retryable: true },

		// Quota / rate-limit
		{ msg: "Rate limit exceeded", status: 429, expected: "quota_exceeded", retryable: false },
		{ msg: "You exceeded your quota", status: null, expected: "quota_exceeded", retryable: true },
		{ msg: "Too many requests", status: null, expected: "quota_exceeded", retryable: true },

		// Auth errors
		{ msg: "Unauthorized", status: 401, expected: "auth_error", retryable: false },
		{ msg: "Forbidden", status: 403, expected: "auth_error", retryable: false },
		{ msg: "Invalid API key", status: null, expected: "auth_error", retryable: false },

		// Context overflow
		{ msg: "Context window exceeded", status: null, expected: "context_overflow", retryable: false },
		{ msg: "Token limit reached", status: null, expected: "context_overflow", retryable: false },

		// Tool errors
		{ msg: "Tool execution error", status: null, expected: "tool_error", retryable: false },
		{ msg: "Tool timeout occurred", status: null, expected: "transient", retryable: true },

		// Unknown
		{ msg: "Something weird happened", status: null, expected: "unknown", retryable: false },
		{ msg: "random message", status: 418, expected: "unknown", retryable: false },
	];

	let passed = 0;
	for (const { msg, status, expected, retryable } of cases) {
		const result = classifyRetryError(msg, status);
		assert.strictEqual(result.category, expected, `classify(${JSON.stringify(msg)}, ${status}).category`);
		assert.strictEqual(result.retryable, retryable, `classify(${JSON.stringify(msg)}, ${status}).retryable`);
		passed++;
	}
	console.log(`  ✅ Classification: ${passed}/${cases.length} passed`);
}

// ── Transient Retry Strategy Tests ───────────────────────────────────────────

{
	console.log("=== Transient Retry Strategy ===");

	assert.strictEqual(transientRetryStrategy.name, "transient");

	// Should auto-retry transient errors up to max attempts
	assert.strictEqual(
		transientRetryStrategy.shouldAutoRetry({ message: "timeout", category: "transient", httpStatus: null, attempt: 1 }),
		true,
		"attempt 1 should retry"
	);
	assert.strictEqual(
		transientRetryStrategy.shouldAutoRetry({ message: "timeout", category: "transient", httpStatus: null, attempt: 2 }),
		true,
		"attempt 2 should retry"
	);
	assert.strictEqual(
		transientRetryStrategy.shouldAutoRetry({ message: "timeout", category: "transient", httpStatus: null, attempt: 3 }),
		false,
		"attempt 3 should NOT retry (maxAttempts=3, check is attempt < 3)"
	);

	// Should NOT auto-retry non-transient errors
	assert.strictEqual(
		transientRetryStrategy.shouldAutoRetry({ message: "bad key", category: "auth_error", httpStatus: 401, attempt: 1 }),
		false,
		"auth_error should not retry"
	);

	// Exponential backoff
	assert.strictEqual(transientRetryStrategy.getDelay(1), 2000, "delay for attempt 1");
	assert.strictEqual(transientRetryStrategy.getDelay(2), 4000, "delay for attempt 2");
	assert.strictEqual(transientRetryStrategy.getDelay(3), 8000, "delay for attempt 3");
	assert.strictEqual(transientRetryStrategy.getDelay(10), 30000, "delay capped at maxDelayMs");

	assert.strictEqual(transientRetryStrategy.maxAttempts, 3);
	console.log("  ✅ Strategy logic: all assertions passed");
}

// ── Default Config Tests ─────────────────────────────────────────────────────

{
	console.log("=== Default Config ===");

	assert.strictEqual(DEFAULT_RETRY_CONFIG.autoRetryEnabled, true);
	assert.strictEqual(DEFAULT_RETRY_CONFIG.maxAutoRetryAttempts, 3);
	assert.strictEqual(DEFAULT_RETRY_CONFIG.baseDelayMs, 2000);
	assert.strictEqual(DEFAULT_RETRY_CONFIG.maxDelayMs, 30000);
	assert.deepStrictEqual(DEFAULT_RETRY_CONFIG.strategies, []);
	console.log("  ✅ Default config: all assertions passed");
}

// ── State Management Tests ───────────────────────────────────────────────────

{
	console.log("=== State Management (session-scoped) ===");

	// Import state module
	const stateMod = await import(join(ROOT, "dist/extensions/retry/retry/state.js"));

	// Test initState creates clean state
	stateMod.initState();
	const state = stateMod.getState();
	assert.strictEqual(state.lastUserMessage, null, "initial lastUserMessage is null");
	assert.strictEqual(state.lastError, null, "initial lastError is null");
	assert.strictEqual(state.failureCount, 0, "initial failureCount is 0");
	assert.strictEqual(state.errorPhase, "initial", "initial errorPhase is 'initial'");
	assert.strictEqual(state.version, 4, "version is 4");

	// Test getState returns session state (without ctx, uses module default)
	const state2 = stateMod.getState();
	assert.strictEqual(state2, state, "getState() returns same reference without ctx");

	// Test isAutoRetryPending returns false initially
	assert.strictEqual(stateMod.isAutoRetryPending(), false, "no auto-retry pending initially");
	assert.strictEqual(stateMod.getAutoRetryAttempt(), 0, "attempt count is 0 initially");

	// Test clearAutoRetry is safe to call when no timer is active
	stateMod.clearAutoRetry();
	assert.strictEqual(stateMod.isAutoRetryPending(), false, "clearAutoRetry is idempotent");

	console.log("  ✅ State management: all assertions passed");
}

console.log("\n=== Results: All tests passed ===");
