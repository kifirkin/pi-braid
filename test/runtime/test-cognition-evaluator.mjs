// test/runtime/test-cognition-evaluator.mjs
// Tests for the cognition evaluator library
import { strict as assert } from "assert";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

async function main() {
	let passed = 0;
	let failed = 0;

	function check(name, fn) {
		try { fn(); passed++; console.log(`  ✅ ${name}`); }
		catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
	}

	// Import module
	const { evaluateCognition } = await import(`${ROOT}/dist/lib/cognition-evaluator.js`);

	console.log("\n[1] Basic scoring");
	check("returns score object", () => {
		const r = evaluateCognition({
			thinks: 0, hypothesizes: 0, finalizes: 0, avgConfidence: 0,
			hypothesesGenerated: 0, hypothesesWithVerification: 0,
			finalizationsBlocked: 0, depthDistribution: {}, reasoningTags: {},
		});
		assert(typeof r.overall === "number");
		assert(typeof r.reasoningDepth === "number");
		assert(typeof r.hypothesisQuality === "number");
		assert(typeof r.verificationRigor === "number");
		assert(Array.isArray(r.recommendations));
	});

	check("no usage = low score + recommendations", () => {
		const r = evaluateCognition({
			thinks: 0, hypothesizes: 0, finalizes: 0, avgConfidence: 0,
			hypothesesGenerated: 0, hypothesesWithVerification: 0,
			finalizationsBlocked: 0, depthDistribution: {}, reasoningTags: {},
		});
		assert(r.overall < 60);
		assert(r.recommendations.length >= 1);
	});

	console.log("\n[2] Reasoning depth");
	check("thinks with deep = high depth", () => {
		const r = evaluateCognition({
			thinks: 5, hypothesizes: 0, finalizes: 0, avgConfidence: 0.7,
			hypothesesGenerated: 0, hypothesesWithVerification: 0,
			finalizationsBlocked: 0,
			depthDistribution: { deep: 3, quick: 2 },
			reasoningTags: { plan: 2, hypothesis: 1, insight: 2 },
		});
		assert(r.reasoningDepth > 50);
	});

	check("diverse tags boost depth", () => {
		const r1 = evaluateCognition({
			thinks: 5, hypothesizes: 0, finalizes: 0, avgConfidence: 0.5,
			hypothesesGenerated: 0, hypothesesWithVerification: 0,
			finalizationsBlocked: 0,
			depthDistribution: { quick: 5 },
			reasoningTags: { insight: 5 },
		});
		const r2 = evaluateCognition({
			thinks: 5, hypothesizes: 0, finalizes: 0, avgConfidence: 0.5,
			hypothesesGenerated: 0, hypothesesWithVerification: 0,
			finalizationsBlocked: 0,
			depthDistribution: { quick: 5 },
			reasoningTags: { insight: 1, plan: 1, hypothesis: 1, question: 1, assumption: 1 },
		});
		assert(r2.reasoningDepth >= r1.reasoningDepth);
	});

	console.log("\n[3] Hypothesis quality");
	check("hypotheses with verification = high quality", () => {
		const r = evaluateCognition({
			thinks: 0, hypothesizes: 3, finalizes: 0, avgConfidence: 0,
			hypothesesGenerated: 9, hypothesesWithVerification: 7,
			finalizationsBlocked: 0, depthDistribution: {}, reasoningTags: {},
		});
		assert(r.hypothesisQuality > 60);
	});

	check("hypotheses without verification gets recommendation", () => {
		const r = evaluateCognition({
			thinks: 0, hypothesizes: 2, finalizes: 0, avgConfidence: 0,
			hypothesesGenerated: 6, hypothesesWithVerification: 0,
			finalizationsBlocked: 0, depthDistribution: {}, reasoningTags: {},
		});
		assert(r.recommendations.some(rec => rec.includes("verification")));
	});

	console.log("\n[4] Verification rigor");
	check("some blocked finalizations = healthy rigor", () => {
		const r = evaluateCognition({
			thinks: 0, hypothesizes: 0, finalizes: 5, avgConfidence: 0,
			hypothesesGenerated: 0, hypothesesWithVerification: 0,
			finalizationsBlocked: 1, depthDistribution: {}, reasoningTags: {},
		});
		assert(r.verificationRigor >= 70);
	});

	check("all passed = warning about critic", () => {
		const r = evaluateCognition({
			thinks: 0, hypothesizes: 0, finalizes: 5, avgConfidence: 0,
			hypothesesGenerated: 0, hypothesesWithVerification: 0,
			finalizationsBlocked: 0, depthDistribution: {}, reasoningTags: {},
		});
		assert(r.recommendations.some(rec => rec.includes("critic")));
	});

	check("many blocked = quality concern", () => {
		const r = evaluateCognition({
			thinks: 0, hypothesizes: 0, finalizes: 5, avgConfidence: 0,
			hypothesesGenerated: 0, hypothesesWithVerification: 0,
			finalizationsBlocked: 4, depthDistribution: {}, reasoningTags: {},
		});
		assert(r.recommendations.some(rec => rec.includes("quality")));
	});

	console.log("\n[5] Full session scoring");
	check("good session = high score", () => {
		const r = evaluateCognition({
			thinks: 8, hypothesizes: 2, finalizes: 1, avgConfidence: 0.75,
			hypothesesGenerated: 6, hypothesesWithVerification: 4,
			finalizationsBlocked: 0,
			depthDistribution: { deep: 3, quick: 5 },
			reasoningTags: { plan: 3, hypothesis: 2, insight: 2, question: 1 },
		});
		assert(r.overall > 50, `Expected >50, got ${r.overall}`);
	});

	check("bare session = low score + many recommendations", () => {
		const r = evaluateCognition({
			thinks: 0, hypothesizes: 0, finalizes: 1, avgConfidence: 0,
			hypothesesGenerated: 0, hypothesesWithVerification: 0,
			finalizationsBlocked: 0, depthDistribution: {}, reasoningTags: {},
		});
		assert(r.overall < 60);
		assert(r.recommendations.length >= 2);
	});

	// Summary
	console.log(`\n${"=".repeat(50)}`);
	console.log(`cognition-evaluator: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
