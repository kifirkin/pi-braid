/**
 * Belief Policy Engine — runtime tests (BR1: reflection_gap rule validation)
 * Run: node test/runtime/test-belief-policy.mjs
 */
const ROOT = "/Users/kifir/projects/agents/pi-braid";
const { emitSignal, getNextRecommendation, getBeliefs, getSignals, clearBeliefEngine } = await import(`${ROOT}/dist/lib/belief-policy-engine.js`);
const extState = await import(`${ROOT}/dist/lib/extension-state.js`);

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log(`  ✅ ${msg}`)) : (failed++, console.log(`  ❌ ${msg}`));

function freshCtx() {
	const ctx = {};
	clearBeliefEngine(ctx);
	// Ensure state is initialized
	extState.getExtensionState(ctx, "belief-policy-engine", () => ({
		signals: [],
		beliefs: new Map(),
		recommendations: [],
		lastRecommendationAt: 0,
		recommendationCooldownMs: 30_000,
	}));
	return ctx;
}

console.log("\n🧪 Belief Policy Engine — Unit Tests\n");
console.log("── BR1: Reflection Gap Rule + Signal System ──\n");

// ── [1] emitSignal: basic signal emission ────────────────────────────────
console.log("[1] emitSignal() — basic signal");
{
	const ctx = freshCtx();
	emitSignal(ctx, "tool-use", "overuse", "warn", false, { tool: "bash", count: 30 });
	const signals = getSignals(ctx);
	assert(signals.length === 1, "Signal stored");
	assert(signals[0].source === "tool-use", "Source = tool-use");
	assert(signals[0].severity === "warn", "Severity = warn");
}

// ── [2] reflection_gap rule: no reflection after 8+ tool calls ───────────
console.log("\n[2] reflection_gap — 8+ tool calls without reflection → recommendation");
{
	const ctx = freshCtx();

	// Emit 8 tool-use signals (no reflection)
	for (let i = 0; i < 8; i++) {
		emitSignal(ctx, "tool-use", "execution", "info", false, { tool: "read", count: i + 1 });
	}

	const rec = getNextRecommendation(ctx);
	assert(rec !== null, "Recommendation generated for reflection gap");
	assert(rec.type === "reflection_gap", "Type = reflection_gap");
	assert(rec.message.includes("reflection"), "Message mentions reflection");
	assert(rec.priority >= 5, "Priority >= 5 (should be exactly 5)");
}

// ── [3] reflection_gap — reflection BEFORE tool gap → no warning ────────
console.log("\n[3] reflection_gap — reflection before tool gap → no warning");
{
	const ctx = freshCtx();

	// Emit reflection signal FIRST, then 8 tool-use signals
	// (order matters: reflection BEFORE the gap is detected)
	emitSignal(ctx, "reflection", "took", "info", false, { type: "think" });
	for (let i = 0; i < 8; i++) {
		emitSignal(ctx, "tool-use", "execution", "info", false, { tool: i % 2 === 0 ? "read" : "edit", count: i + 1 });
	}

	const rec = getNextRecommendation(ctx);
	// Reflection was present throughout, so gap rule should not fire
	assert(rec === null || rec.type !== "reflection_gap", "No reflection_gap when reflection present throughout");
}

// ── [4] cooldown: recommendations respect cooldown ───────────────────────
console.log("\n[4] getNextRecommendation() — cooldown respected");
{
	const ctx = freshCtx();

	// Trigger first recommendation
	for (let i = 0; i < 8; i++) {
		emitSignal(ctx, "tool-use", "execution", "info", false, { tool: "bash", count: i + 1 });
	}

	const rec1 = getNextRecommendation(ctx);
	assert(rec1 !== null, "First recommendation returned");

	// Immediately request another — should be blocked by cooldown
	const rec2 = getNextRecommendation(ctx);
	assert(rec2 === null, "Second recommendation blocked by cooldown");
}

// ── [5] stability_decline rule ───────────────────────────────────────────
console.log("\n[5] stability_decline rule — 3+ stability decline signals");
{
	const ctx = freshCtx();

	for (let i = 0; i < 3; i++) {
		emitSignal(ctx, "stability", "decline", "warn", false, {
			overlap: 0.9 - i * 0.3,
			turn: i + 1,
		});
	}

	const rec = getNextRecommendation(ctx);
	assert(rec !== null, "Recommendation generated for stability decline");
	assert(rec.type === "stability_decline", "Type = stability_decline");
}

// ── [6] conflict_accumulation rule ───────────────────────────────────────
console.log("\n[6] conflict_accumulation rule — 5+ unresolved conflicts");
{
	const ctx = freshCtx();

	for (let i = 0; i < 5; i++) {
		emitSignal(ctx, "conflict", "unresolved", "warn", false, {
			source: `evidence-${i}`,
			claim: `claim-${i}`,
		});
	}

	const rec = getNextRecommendation(ctx);
	assert(rec !== null, "Recommendation generated for conflict accumulation");
	assert(rec.type === "conflict_accumulation", "Type = conflict_accumulation");
	assert(rec.message.includes("unresolved source conflicts"), "Message mentions unresolved conflicts");
}

// ── [7] drift_plus_scatter rule ──────────────────────────────────────────
console.log("\n[7] drift_plus_scatter rule — drift + 2+ tool overuse");
{
	const ctx = freshCtx();

	// Topic drift signal
	emitSignal(ctx, "topic-drift", "detected", "warn", false, { score: 0.7, threshold: 0.5 });

	// 2 tool overuse signals
	emitSignal(ctx, "tool-use", "overuse", "info", false, { tool: "bash", count: 25 });
	emitSignal(ctx, "tool-use", "overuse", "info", false, { tool: "read", count: 20 });

	const rec = getNextRecommendation(ctx);
	assert(rec !== null, "Recommendation generated for drift + scatter");
	assert(rec.type === "drift_plus_scatter", "Type = drift_plus_scatter");
}

// ── [8] clearBeliefEngine: full reset ────────────────────────────────────
console.log("\n[8] clearBeliefEngine() — full state reset");
{
	const ctx = freshCtx();

	emitSignal(ctx, "tool-use", "execution", "info", false, { tool: "bash" });
	emitSignal(ctx, "tool-use", "execution", "info", false, { tool: "read" });

	assert(getSignals(ctx).length === 2, "2 signals before clear");

	clearBeliefEngine(ctx);
	assert(getSignals(ctx).length === 0, "0 signals after clear");
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
