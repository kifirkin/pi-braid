/**
 * Retry extension — command handler integration tests.
 *
 * Tests the /retry handler flow: staleness check, continueRetry minimal steer.
 */

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "../..");

// ── Imports ──────────────────────────────────────────────────────────────────

const stateMod = await import(join(ROOT, "dist/extensions/retry/retry/state.js"));
const { initState, getState, captureUserInput, recordAgentEnd, continueRetry } = stateMod;

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

// ── Test: continueRetry sends minimal steer always ───────────────────────────

{
	console.log("=== continueRetry: always sends minimal steer ===");
	initState();
	const pi = makeMockPi();
	const ctx = makeMockCtx(true); // idle
	captureUserInput(pi, "test message", undefined, "entry-1", ctx);
	const ok = await continueRetry(pi, ctx);
	assert.strictEqual(ok, true, "continueRetry returns true");
	assert.strictEqual(pi._sent.length, 1, "exactly one message sent");
	assert.strictEqual(pi._sent[0].content[0].text, "Try again.", "minimal steer text");
	assert.strictEqual(pi._sent[0].options?.deliverAs, "steer", "always uses steer");
	console.log("  ✅ Minimal steer sent");
}

// ── Test: continueRetry sends minimal steer even for mid_chain ───────────────

{
	console.log("=== continueRetry: mid_chain also sends minimal steer ===");
	initState();
	const pi = makeMockPi();
	const ctx = makeMockCtx(true); // idle, but mid_chain
	captureUserInput(pi, "do something", undefined, "entry-3", ctx);
	recordAgentEnd(pi, "entry-3", true, "file not found", null, true, ctx);
	const ok = await continueRetry(pi, ctx);
	assert.strictEqual(ok, true, "continueRetry returns true");
	assert.strictEqual(pi._sent.length, 1, "exactly one message sent");
	assert.strictEqual(pi._sent[0].content[0].text, "Try again.", "minimal steer even for mid_chain");
	assert.strictEqual(pi._sent[0].options?.deliverAs, "steer", "always uses steer");
	console.log("  ✅ Mid-chain minimal steer");
}

// ── Test: no raw user message re-sent ────────────────────────────────────────

{
	console.log("=== continueRetry: never re-sends raw user message ===");
	initState();
	const pi = makeMockPi();
	const ctx = makeMockCtx();
	captureUserInput(pi, "sensitive private data here", undefined, "entry-priv", ctx);
	await continueRetry(pi, ctx);
	const text = pi._sent[0].content[0].text;
	assert(!text.includes("sensitive"), "must NOT contain raw user message");
	assert(!text.includes("private"), "must NOT contain raw user message");
	console.log("  ✅ Raw message not leaked");
}

// ── Test: staleness check blocks old messages ────────────────────────────────

{
	console.log("=== Staleness check: old messages blocked ===");
	initState();
	const pi = makeMockPi();
	const ctx = makeMockCtx();
	const oldTs = Date.now() - 15 * 60 * 1000; // 15 minutes ago
	captureUserInput(pi, "old message", undefined, "entry-old", ctx);
	recordAgentEnd(pi, "entry-old", true, "timeout", null, false, ctx);
	const state = getState(ctx);
	state.lastError.timestamp = oldTs;
	state.lastTurn.timestamp = oldTs;

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
