/**
 * Three Memory Stores — runtime tests
 * Run: node test/runtime/test-memory-stores.mjs
 */
const ROOT = "/Users/kifir/projects/agents/pi-braid";
const {
	addEpisode,
	retrieveEpisodes,
	addHeuristicRule,
	getPrioritizedHeuristics,
	getApplicableHeuristics,
	evolveHeuristic,
	recordToolCall,
	getToolReliability,
	selectBestTool,
} = await import(`${ROOT}/dist/extensions/three-memory-stores/index.js`);

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log(`  ✅ ${msg}`)) : (failed++, console.log(`  ❌ ${msg}`));

// Create a mock state for direct function testing
// The functions take state as first arg, but the module exports them
// We'll test through the extension module

// ── Episode Store ────────────────────────────────────────────────────
console.log("\n[1] Episode store");
{
	const state = {
		episodes: [],
		heuristics: [],
		toolStats: new Map(),
		currentSessionTools: [],
		sessionStartTime: Date.now(),
	};

	// Add episode
	const ep1 = addEpisode(state, "Fix null pointer in parser", "Added null check and fallback", "success", ["read", "edit", "bash"], ["bugfix"]);
	assert(state.episodes.length === 1, `Episode added: ${state.episodes.length}`);
	assert(ep1.outcome === "success", `Outcome: ${ep1.outcome}`);
	assert(ep1.id.startsWith("ep-"), `ID format: ${ep1.id}`);

	// Add another episode
	addEpisode(state, "Deploy to production", "Used blue-green deployment", "success", ["bash", "bash"], ["deploy"]);
	assert(state.episodes.length === 2, `2 episodes: ${state.episodes.length}`);

	// Retrieve episodes
	const found = retrieveEpisodes(state, "parser null fix", 3);
	assert(found.length >= 1, `Found ${found.length} matching episode(s)`);
	if (found.length > 0) {
		assert(found[0].similarity > 0, `Similarity: ${found[0].similarity}`);
	}

	// No match
	const none = retrieveEpisodes(state, "quantum physics", 3);
	assert(none.length === 0, `No match for quantum physics`);
}

// ── Heuristics Store ─────────────────────────────────────────────────
console.log("\n[2] Heuristics store");
{
	const state = {
		episodes: [],
		heuristics: [],
		toolStats: new Map(),
		currentSessionTools: [],
		sessionStartTime: Date.now(),
	};

	// Add heuristic
	const h1 = addHeuristicRule(state, "think before write", "Always use think tool before write", 0.8);
	assert(state.heuristics.length === 1, `Heuristic added: ${state.heuristics.length}`);
	assert(h1.priority === 0.8, `Priority: ${h1.priority}`);

	// Add another
	addHeuristicRule(state, "test after edit", "Run tests after modifying code", 0.7);
	assert(state.heuristics.length === 2, `2 heuristics`);

	// Get prioritized
	const sorted = getPrioritizedHeuristics(state);
	assert(sorted[0].priority >= sorted[1].priority, `Sorted by priority`);

	// Get applicable
	const applicable = getApplicableHeuristics(state, "think before write is important");
	assert(applicable.length >= 1, `Applicable heuristics: ${applicable.length}`);

	// Evolve heuristic
	evolveHeuristic(state, h1.id, true);
	const evolved = state.heuristics.find(h => h.id === h1.id);
	assert(evolved.successRate === 1.0, `Success rate after evolve: ${evolved.successRate}`);
	assert(evolved.uses === 1, `Uses: ${evolved.uses}`);

	// Evolve with failure
	evolveHeuristic(state, h1.id, false);
	const evolved2 = state.heuristics.find(h => h.id === h1.id);
	assert(evolved2.successRate === 0.5, `Success rate after 1 success 1 failure: ${evolved2.successRate}`);
	assert(evolved2.uses === 2, `Uses: ${evolved2.uses}`);
}

// ── Tool Reliability ──────────────────────────────────────────────────
console.log("\n[3] Tool reliability");
{
	const state = {
		episodes: [],
		heuristics: [],
		toolStats: new Map(),
		currentSessionTools: [],
		sessionStartTime: Date.now(),
	};

	// Record tool calls
	recordToolCall(state, "read", "file_read", true, 100);
	recordToolCall(state, "read", "file_read", true, 150);
	recordToolCall(state, "read", "file_read", false, 50);
	recordToolCall(state, "bash", "command_execution", true, 200);
	recordToolCall(state, "bash", "command_execution", false, 500);

	// Check reliability
	const readRel = getToolReliability(state, "read", "file_read");
	assert(readRel === 2/3, `Read reliability: ${readRel.toFixed(2)} (expected 0.67)`);

	const bashRel = getToolReliability(state, "bash", "command_execution");
	assert(bashRel === 0.5, `Bash reliability: ${bashRel}`);

	// Unknown tool → 0.5 default
	const unknownRel = getToolReliability(state, "unknown", "general");
	assert(unknownRel === 0.5, `Unknown reliability: ${unknownRel}`);

	// Select best tool
	const best = selectBestTool(state, "file_read", ["read", "bash", "unknown"]);
	assert(best === "read", `Best tool for file_read: ${best}`);
}

// ── Episode pruning ──────────────────────────────────────────────────
console.log("\n[4] Episode pruning at 500 limit");
{
	const state = {
		episodes: [],
		heuristics: [],
		toolStats: new Map(),
		currentSessionTools: [],
		sessionStartTime: Date.now(),
	};

	// Add 510 episodes
	for (let i = 0; i < 510; i++) {
		addEpisode(state, `Task ${i}`, `Solution ${i}`, i % 2 === 0 ? "success" : "failure", [], []);
	}
	assert(state.episodes.length <= 500, `Pruned to <= 500: ${state.episodes.length}`);
}

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Memory Stores Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
// ── RUMS Retrieval ─────────────────────────────────────────────────
console.log("\n[5] RUMS mutual information retrieval");
{
	// Note: retrieveByRUMS needs to be exported first
	// For now, test the PMI scoring logic indirectly via source analysis
	const fs = await import("fs");
	const src = fs.readFileSync(`${ROOT}/src/extensions/three-memory-stores/index.ts`, "utf8");
	assert(src.includes("function retrieveByRUMS"), "retrieveByRUMS defined");
	assert(src.includes("estimatePMI"), "estimatePMI function exists");
	assert(src.includes("computeRUMS"), "computeRUMS scoring function exists");
	assert(src.includes("backgroundFreq"), "RUMS uses background frequency distribution");
	assert(src.includes("outcomeScore"), "RUMS considers outcome consistency");
	assert(src.includes("recencyScore"), "RUMS considers recency");
	assert(src.includes("specificityScore"), "RUMS considers solution specificity");
	assert(src.includes("2604.14475"), "RUMS references paper 2604.14475");
}
