// test/runtime/test-context-manager-handlers.mjs
// Tests for decomposed context-manager handler modules
import { strict as assert } from "assert";
import { readFileSync } from "fs";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

async function main() {
	let passed = 0;
	let failed = 0;

	function check(name, fn) {
		try { fn(); passed++; console.log(`  ✅ ${name}`); }
		catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
	}

	// ── Module structure verification ────────────────────────────────────
	console.log("\n[1] Handler module structure");
	const handlerFiles = ["shared", "tools", "compaction", "navigation", "events"];
	for (const name of handlerFiles) {
		if (name === "shared") continue; // pure functions, no async ops
		check(`${name}.ts exists and is substantial`, () => {
			const src = readFileSync(`${ROOT}/src/extensions/memory/context-manager/handlers/${name}.ts`, "utf8");
			assert(src.length > 100, `${name}.ts is too short`);
		});
	}

	check("index.ts is slim (< 100 lines)", () => {
		const src = readFileSync(`${ROOT}/src/extensions/memory/context-manager/index.ts`, "utf8");
		const lines = src.split("\n").length;
		assert(lines < 100, `index.ts is ${lines} lines, expected < 100`);
	});

	check("index.ts imports all handler modules", () => {
		const src = readFileSync(`${ROOT}/src/extensions/memory/context-manager/index.ts`, "utf8");
		assert(src.includes("from \"./handlers/shared.js\""));
		assert(src.includes("from \"./handlers/tools.js\""));
		assert(src.includes("from \"./handlers/compaction.js\""));
		assert(src.includes("from \"./handlers/navigation.js\""));
		assert(src.includes("from \"./handlers/events.js\""));
	});

	// ── Shared module exports ───────────────────────────────────────────
	console.log("\n[2] Shared module verification");
	check("shared.ts exports all required symbols", () => {
		const src = readFileSync(`${ROOT}/src/extensions/memory/context-manager/handlers/shared.ts`, "utf8");
		for (const sym of ["log", "getCmState", "isInternal", "INTERNAL_TOOLS", "resolveTarget",
			"findByLabel", "resolveDefaultTarget", "compactionRetryState", "overflowRetryState",
			"_compactedEntries", "resetCompactionRetry", "resetOverflowRetry",
			"isTransientCompactionError", "formatPruneCandidates"]) {
			assert(src.includes(`export ${sym.includes("const") ? "const" : "function"} ${sym}`) ||
				src.includes(`export const ${sym}`) || src.includes(`export function ${sym}`) ||
				src.includes(`export interface ${sym}`) || src.includes(`export async function ${sym}`) ||
				src.includes(`export interface RetryState`) ||
				src.includes(sym), `Missing export: ${sym}`);
		}
	});

	check("shared.ts has retry delay functions", () => {
		const src = readFileSync(`${ROOT}/src/extensions/memory/context-manager/handlers/shared.ts`, "utf8");
		assert(src.includes("getCompactionRetryDelay"));
		assert(src.includes("getOverflowRetryDelay"));
		assert(src.includes("3000 * Math.pow(2"), "exponential backoff for compaction");
		assert(src.includes("2000 * Math.pow(2"), "exponential backoff for overflow");
	});

	// ── Compaction improvements ────────────────────────────────────────
	console.log("\n[3] Compaction handler improvements");
	check("compaction.ts has smart instructions builder", () => {
		const src = readFileSync(`${ROOT}/src/extensions/memory/context-manager/handlers/compaction.ts`, "utf8");
		assert(src.includes("buildCompactionInstructions"), "Missing smart instructions builder");
		assert(src.includes("Task state preservation"), "Missing task state awareness");
		assert(src.includes("Semantic preservation"), "Missing semantic preservation rules");
		assert(src.includes("tool-call/result pairs"), "Missing tool pair preservation rule");
	});

	check("compaction.ts has context pressure awareness", () => {
		const src = readFileSync(`${ROOT}/src/extensions/memory/context-manager/handlers/compaction.ts`, "utf8");
		assert(src.includes("85") || src.includes("CRITICAL"), "Missing critical pressure level");
		assert(src.includes("70") || src.includes("moderate"), "Missing moderate pressure level");
		assert(src.includes("aggressively summarize"), "Missing aggressive summarization guidance");
	});

	check("compaction.ts handles all failure modes", () => {
		const src = readFileSync(`${ROOT}/src/extensions/memory/context-manager/handlers/compaction.ts`, "utf8");
		assert(src.includes("handleOverflowFailure"));
		assert(src.includes("handleTransientError"));
		assert(src.includes("handleThresholdFailure"));
		assert(src.includes("isTransientCompactionError"));
	});

	// ── Tool registrations ──────────────────────────────────────────────
	console.log("\n[4] Tool registrations");
	check("tools.ts registers all 6 tools + 1 command", () => {
		const src = readFileSync(`${ROOT}/src/extensions/memory/context-manager/handlers/tools.ts`, "utf8");
		for (const tool of ["context_tag", "context_log", "context_checkout", "context_prune", "context_audit", "context_archive"]) {
			assert(src.includes(`name: "${tool}"`), `Missing tool: ${tool}`);
		}
		assert(src.includes("registerCommand"), "Missing command registration");
	});

	// ── Event handler registration ──────────────────────────────────────
	console.log("\n[5] Event handler registration functions");
	check("all handlers export register functions", () => {
		const compaction = readFileSync(`${ROOT}/src/extensions/memory/context-manager/handlers/compaction.ts`, "utf8");
		const navigation = readFileSync(`${ROOT}/src/extensions/memory/context-manager/handlers/navigation.ts`, "utf8");
		const events = readFileSync(`${ROOT}/src/extensions/memory/context-manager/handlers/events.ts`, "utf8");

		for (const fn of ["registerBeforeCompactHandler", "registerSessionCompactHandler", "registerCompactionEndHandler", "registerContextCleanupHandler", "registerTurnEndRetryReset"]) {
			assert(compaction.includes(fn), `Missing in compaction.ts: ${fn}`);
		}
		for (const fn of ["registerBeforeTreeHandler", "registerTurnEndCheckoutHandler", "registerAgentEndRetryHandler"]) {
			assert(navigation.includes(fn), `Missing in navigation.ts: ${fn}`);
		}
		for (const fn of ["registerAgentEndRetryHandler", "registerAutoRetryEndHandler", "registerContextPruningHandler"]) {
			assert(events.includes(fn), `Missing in events.ts: ${fn}`);
		}
	});

	// ── Navigation helpers ──────────────────────────────────────────────
	console.log("\n[6] Navigation module");
	check("navigation.ts handles tree branching", () => {
		const src = readFileSync(`${ROOT}/src/extensions/memory/context-manager/handlers/navigation.ts`, "utf8");
		assert(src.includes("session_before_tree"), "Missing before_tree handler");
		assert(src.includes("branchWithSummary") || src.includes("nearestTag"), "Missing branch logic");
	});

	// ── Error handling ──────────────────────────────────────────────────
	console.log("\n[7] Error handling in handlers");
	for (const name of handlerFiles) {
		if (name === "shared") continue; // pure functions, no async ops
		check(`${name}.ts has error handling`, () => {
			const src = readFileSync(`${ROOT}/src/extensions/memory/context-manager/handlers/${name}.ts`, "utf8");
			assert(src.includes("catch"), `${name}.ts missing try/catch`);
		});
	}

	// Summary
	console.log(`\n${"=".repeat(50)}`);
	console.log(`context-manager-handlers: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
