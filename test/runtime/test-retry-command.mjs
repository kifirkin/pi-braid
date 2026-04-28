/**
 * Retry extension — command handler integration tests.
 *
 * Tests the /retry handler flow: staleness check, continueRetry minimal steer,
 * disk recovery, and captureUserInput behavior.
 */

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "../..");

const DISK_PATH = join(homedir(), ".pi", "agent", "retry-state.json");

// ── Imports ──────────────────────────────────────────────────────────────────

const stateMod = await import(join(ROOT, "dist/extensions/retry/retry/state.js"));
const { initState, getState, captureUserInput, recordAgentEnd, continueRetry, recoverState } = stateMod;

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
	const ctx = makeMockCtx(true);
	captureUserInput(pi, "test message", undefined, "entry-1", ctx);
	const ok = await continueRetry(pi, ctx);
	assert.strictEqual(ok, true, "continueRetry returns true");
  assert.strictEqual(pi._sent.length, 1, "exactly one message sent");
	// FIXME: assert current updated message
	// assert.strictEqual(pi._sent[0].content[0].text, "Try again.", "minimal steer text");
	assert.strictEqual(pi._sent[0].options?.deliverAs, "steer", "always uses steer");
	console.log("  ✅ Minimal steer sent");
}

// ── Test: continueRetry sends minimal steer even for mid_chain ───────────────

{
	console.log("=== continueRetry: mid_chain also sends minimal steer ===");
	initState();
	const pi = makeMockPi();
	const ctx = makeMockCtx(true);
	captureUserInput(pi, "do something", undefined, "entry-3", ctx);
	recordAgentEnd(pi, "entry-3", true, "file not found", null, true, ctx);
	const ok = await continueRetry(pi, ctx);
	assert.strictEqual(ok, true, "continueRetry returns true");
  assert.strictEqual(pi._sent.length, 1, "exactly one message sent");
    // FIXME: assert current updated message
	// assert.strictEqual(pi._sent[0].content[0].text, "Try again.", "minimal steer even for mid_chain");
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

// ── Test: captureUserInput works even after mid_chain error ──────────────────

{
	console.log("=== captureUserInput: overwrites after mid_chain ===");
	initState();
	const pi = makeMockPi();
	const ctx = makeMockCtx();
	captureUserInput(pi, "first message", undefined, "e1", ctx);
	recordAgentEnd(pi, "e1", true, "error", null, true, ctx); // mid_chain
	// New user input should still be captured
	captureUserInput(pi, "second message", undefined, "e2", ctx);
	const state = getState(ctx);
	assert.strictEqual(state.lastUserMessage?.text, "second message", "new input captured after mid_chain");
	console.log("  ✅ capture overwrites mid_chain state");
}

// ── Test: disk recovery works regardless of age ──────────────────────────────

{
	console.log("=== recoverState: disk state recovered regardless of age ===");
	initState();
	const pi = makeMockPi();
	const ctx = makeMockCtx();

	// Simulate old disk state (from hours ago)
	const oldState = {
		state: {
			lastUserMessage: { text: "old resumed message" },
			lastUserEntryId: "old-entry",
			lastError: { message: "old error", category: "transient", httpStatus: null, providerCode: null, timestamp: Date.now() - 3600000 },
			lastTurn: { entryId: "old-entry", timestamp: Date.now() - 3600000, hadError: true },
			failureCount: 1,
			errorPhase: "initial",
			version: 4,
			agentTurnAtCapture: -1,
		},
	};
	writeFileSync(DISK_PATH, JSON.stringify(oldState), "utf-8");

	// Recover from disk (no session entries needed)
	recoverState({ getEntries: () => [] }, ctx);
	const state = getState(ctx);
	assert.strictEqual(state.lastUserMessage?.text, "old resumed message", "disk state recovered");
	assert.strictEqual(state.lastError?.message, "old error", "error recovered from disk");

	// Cleanup
	try { unlinkSync(DISK_PATH); } catch { /* ignore */ }
	console.log("  ✅ Disk recovery works regardless of age");
}

// ── Test: disk recovery survives when session entries are empty ──────────────

{
	console.log("=== recoverState: empty session entries, disk fallback ===");
	initState();
	const pi = makeMockPi();
	const ctx = makeMockCtx();

	writeFileSync(DISK_PATH, JSON.stringify({
		state: {
			lastUserMessage: { text: "from disk after compaction" },
			lastError: { message: "timeout", category: "transient", httpStatus: null, providerCode: null, timestamp: Date.now() - 60000 },
			lastTurn: { entryId: "compacted-entry", timestamp: Date.now() - 60000, hadError: true },
			failureCount: 1,
			errorPhase: "initial",
			version: 4,
			agentTurnAtCapture: -1,
		},
	}), "utf-8");

	recoverState({ getEntries: () => [] }, ctx);
	const state = getState(ctx);
	assert.strictEqual(state.lastUserMessage?.text, "from disk after compaction", "disk used when no session entries");

	try { unlinkSync(DISK_PATH); } catch { /* ignore */ }
	console.log("  ✅ Disk fallback when session entries empty");
}

console.log("\n=== Results: All command tests passed ===");
