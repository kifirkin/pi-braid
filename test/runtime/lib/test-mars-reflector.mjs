/**
 * MARS Reflector — runtime tests (BR1 self-reflection validation)
 * Tests generateAdvice() directly with SessionPattern objects.
 * Run: node test/runtime/test-mars-reflector.mjs
 */
const ROOT = "/Users/kifir/projects/agents/pi-braid";
const { buildPattern, generateAdvice, resetMARS } = await import(`${ROOT}/dist/lib/reasoning/mars-reflector.js`);

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log(`  ✅ ${msg}`)) : (failed++, console.log(`  ❌ ${msg}`));

function makePattern(overrides = {}) {
	return {
		toolDistribution: new Map(),
		errorTypes: new Map(),
		confidenceTrend: [],
		stabilityTrend: [],
		errorRate: 0,
		consecutiveErrors: 0,
		...overrides,
	};
}

console.log("\n🧪 MARS Reflector — Unit Tests\n");
console.log("── BR1: Self-Reflection Validation ──\n");

// ── [1] generateAdvice: tool overuse + failure ───────────────────────────
console.log("[1] Tool overuse with failure → advice");
{
	// Formula: avgPerTool = total/numTools, threshold = avgPerTool * 3
	// With 4 tools: bash=40, others avg=4 → total=52, avg=13, threshold=39
	// 40 > 39 → overused
	const pattern = makePattern({
		toolDistribution: new Map([
			["bash", 40],
			["read", 4],
			["edit", 4],
			["grep", 4],
		]),
	});
	const successRates = new Map([["bash", 0.3]]); // failing
	const advice = generateAdvice(pattern, null, successRates);
	assert(advice !== null, "Advice generated");
	assert(advice?.type === "tool_overuse", `Type = tool_overuse (got ${advice?.type})`);
	assert(advice?.message.includes("bash"), "Mentions bash");
	assert(advice?.severity === "warn", "Severity = warn");
}

// ── [2] generateAdvice: learning phase exemption ─────────────────────────
console.log("\n[2] Learning phase: ≤5 calls → no advice");
{
	const pattern = makePattern({
		toolDistribution: new Map([["read", 5], ["edit", 1], ["bash", 1]]),
	});
	const advice = generateAdvice(pattern, null);
	assert(advice === null, "No advice during learning phase");
}

// ── [3] generateAdvice: error recurrence (≥3 consecutive errors) ─────────
console.log("\n[3] Error recurrence (3 consecutive errors) → advice");
{
	const pattern = makePattern({ consecutiveErrors: 3 });
	const advice = generateAdvice(pattern, null);
	assert(advice !== null, "Advice for error recurrence");
	assert(advice?.type === "error_recurrence", `Type = error_recurrence (got ${advice?.type})`);
}

// ── [4] generateAdvice: stability decline ────────────────────────────────
console.log("\n[4] Stability decline → advice");
{
	const curr = makePattern({ stabilityTrend: [0.3, 0.2, 0.1] });
	const prev = makePattern({ stabilityTrend: [0.9, 0.9, 0.8] });
	const advice = generateAdvice(curr, prev);
	assert(advice !== null, "Advice for stability decline");
	assert(advice?.type === "stability_decline", `Type = stability_decline (got ${advice?.type})`);
}

// ── [5] generateAdvice: overused but highly successful → NO advice ───────
console.log("\n[5] Overused but successful tool → no advice (by design)");
{
	const pattern = makePattern({
		toolDistribution: new Map([
			["bash", 30],
			["read", 5], ["edit", 5], ["grep", 5], // avg other = 5
			// threshold = max(5*3, 5) = 15
		]),
	});
	const successRates = new Map([["bash", 0.95]]); // 95% success
	const advice = generateAdvice(pattern, null, successRates);
	assert(advice === null, "No advice — successful tool not flagged even if overused");
}

// ── [6] generateAdvice: empty pattern → no advice ────────────────────────
console.log("\n[6] Empty pattern → no advice");
{
	const advice = generateAdvice(makePattern(), null);
	assert(advice === null, "No advice for empty pattern");
}

// ── [7] generateAdvice: borderline overuse (threshold boundary) ──────────
console.log("\n[7] Borderline overuse: at threshold → no advice");
{
	// 4 tools: bash=15, read=5, edit=5, grep=5 → total=30, avg=7.5, threshold=22.5
	// 15 < 22.5, not overused
	const pattern = makePattern({
		toolDistribution: new Map([
			["bash", 15],
			["read", 5], ["edit", 5], ["grep", 5],
		]),
	});
	const advice = generateAdvice(pattern, null, new Map([["bash", 0.0]]));
	assert(advice === null, "No advice — below threshold");
}

// ── [8] generateAdvice: well above overuse threshold ─────────────────────
console.log("\n[8] Above threshold + failure → advice");
{
	// 4 tools: bash=50, read=4, edit=4, grep=2 → total=60, avg=15, threshold=45
	// 50 > 45, overused
	const pattern = makePattern({
		toolDistribution: new Map([
			["bash", 50],
			["read", 4], ["edit", 4], ["grep", 2],
		]),
	});
	const advice = generateAdvice(pattern, null, new Map([["bash", 0.0]]));
	assert(advice !== null, "Advice for severely overused + failing tool");
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
