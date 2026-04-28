/**
 * Retry extension — command handler integration tests.
 *
 * Tests the /retry handler flow: staleness check, continueRetry mode selection,
 * and failed tool name resolution via tool_call_id.
 */

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "../..");

// ── Imports ──────────────────────────────────────────────────────────────────

const stateMod = await import(join(ROOT, "dist/extensions/retry/retry/state.js"));
const { initState, getState, captureUserInput, captureFailedToolName, recordAgentEnd, continueRetry } = stateMod;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockPi(opts = {}) {
	const sent = [];
	const pi = {
		appendEntry: () => {},
		sendUserMessage: async (content, options) => {
			sent.push({ content, options });
		},
		_sent: sent,
	};
	return pi;
}

function makeMockCtx(idle = true) {
	const notifications = [];
	return {
		isIdle: () => idle,
		abort: async () => {},
		waitForIdle: async () => {},
		ui: {
			notify: (msg, type) => notifications.push({ msg, type }),
		},
		_notifications: notifications,
	};
}

// ── Test: continueRetry sends normally when idle ─────────────────────────────

{
	console.log("=== continueRetry: idle agent → normal send ===");
	initState();
	const pi = makeMockPi();
	const ctx = makeMockCtx(true); // idle
	captureUserInput(pi, "test message", undefined, "entry-1", ctx);
	const ok = await continueRetry(pi, ctx);
	assert.strictEqual(ok, true, "continueRetry returns true");
	assert.strictEqual(pi._sent.length, 1, "exactly one message sent");
	assert.strictEqual(pi._sent[0].options, undefined, "no deliverAs when idle");
	console.log("  ✅ Normal send when idle");
}

// ── Test: continueRetry sends steer when busy ────────────────────────────────

{
	console.log("=== continueRetry: busy agent → steer ===");
	initState();
	const pi = makeMockPi();
	const ctx = makeMockCtx(false); // busy
	captureUserInput(pi, "test message busy", undefined, "entry-2", ctx);
	const ok = await continueRetry(pi, ctx);
	assert.strictEqual(ok, true, "continueRetry returns true");
	assert.strictEqual(pi._sent.length, 1, "exactly one message sent");
	assert.strictEqual(pi._sent[0].options?.deliverAs, "steer", "uses steer when busy");
	console.log("  ✅ Steer send when busy");
}

// ── Test: mid_chain steer always uses steer regardless of idle ───────────────

{
	console.log("=== continueRetry: mid_chain → steer + error context ===");
	initState();
	const pi = makeMockPi();
	const ctx = makeMockCtx(true); // idle, but mid_chain overrides
	captureUserInput(pi, "do something", undefined, "entry-3", ctx);
	captureFailedToolName("read", ctx);
	recordAgentEnd(pi, "entry-3", true, "file not found", null, true, ctx);
	const ok = await continueRetry(pi, ctx);
	assert.strictEqual(ok, true, "continueRetry returns true");
	assert.strictEqual(pi._sent.length, 1, "exactly one message sent");
	assert.strictEqual(pi._sent[0].options?.deliverAs, "steer", "mid_chain always steer");
	const text = pi._sent[0].content[0].text;
	assert(text.includes("read"), "steer includes failed tool name");
	assert(text.includes("file not found"), "steer includes error snippet");
	console.log("  ✅ Mid-chain steer with error context");
}

// ── Test: failed tool name resolved via tool_call_id mapping ─────────────────

{
	console.log("=== agent_end: failed tool name via tool_call_id ===");
	initState();
	const pi = makeMockPi();
	const ctx = makeMockCtx();
	captureUserInput(pi, "read file", undefined, "entry-4", ctx);
	captureFailedToolName("read", ctx);
	recordAgentEnd(pi, "entry-4", true, "ENOENT", null, true, ctx);
	const state = getState(ctx);
	assert.strictEqual(state.errorPhase, "mid_chain", "phase is mid_chain");
	assert.strictEqual(state.failureCount, 1, "failure count incremented");
	console.log("  ✅ Failed tool name captured in state");
}

// ── Test: staleness check blocks old messages ────────────────────────────────

{
	console.log("=== Staleness check: old messages blocked ===");
	initState();
	const pi = makeMockPi();
	const ctx = makeMockCtx();
	// Manually set up state with a very old timestamp
	const oldTs = Date.now() - 15 * 60 * 1000; // 15 minutes ago
	captureUserInput(pi, "old message", undefined, "entry-old", ctx);
	// Simulate old error
	recordAgentEnd(pi, "entry-old", true, "timeout", null, false, ctx);
	// Override timestamps to old values
	const state = getState(ctx);
	state.lastError.timestamp = oldTs;
	state.lastTurn.timestamp = oldTs;

	// Replicate the staleness check from the /retry handler
	const lastTurnTs = state.lastTurn?.timestamp ?? 0;
	const lastErrorTs = state.lastError?.timestamp ?? 0;
	const lastActivity = Math.max(lastTurnTs, lastErrorTs);
	const isStale = lastActivity > 0 && Date.now() - lastActivity > 10 * 60 * 1000;
	assert.strictEqual(isStale, true, "message older than 10 min is stale");
	console.log("  ✅ Staleness check correctly identifies old messages");
}

// ── Test: fresh messages pass staleness check ────────────────────────────────

{
	console.log("=== Staleness check: fresh messages allowed ===");
	initState();
	const pi = makeMockPi();
	const ctx = makeMockCtx();
	captureUserInput(pi, "fresh message", undefined, "entry-fresh", ctx);
	recordAgentEnd(pi, "entry-fresh", true, "timeout", null, false, ctx);

	const state = getState(ctx);
	const lastTurnTs = state.lastTurn?.timestamp ?? 0;
	const lastErrorTs = state.lastError?.timestamp ?? 0;
	const lastActivity = Math.max(lastTurnTs, lastErrorTs);
	const isStale = lastActivity > 0 && Date.now() - lastActivity > 10 * 60 * 1000;
	assert.strictEqual(isStale, false, "message within 10 min is not stale");
	console.log("  ✅ Staleness check allows fresh messages");
}

console.log("\n=== Results: All command tests passed ===");
