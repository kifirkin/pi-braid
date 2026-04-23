// test/runtime/test-metacognition-handlers.mjs
// Tests for the decomposed metacognition handler modules
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

	// ── Scoring handler (pure functions, can import directly) ──────────────
	console.log("\n[1] Scoring handler — scoreHypothesis");
	const { scoreHypothesis, scoreHypothesisOutput } = await import(
		`${ROOT}/dist/extensions/metacognition/handlers/scoring.js`
	);

	check("scoreHypothesis returns scored object", () => {
		const result = scoreHypothesis("Check src/lib/cache.ts for stale entries", "cache miss errors");
		assert(typeof result.score === "number");
		assert(result.score > 0);
		assert(Array.isArray(result.signals));
		assert(result.title.length > 0);
	});

	check("scoreHypothesis detects specific files", () => {
		const result = scoreHypothesis("The bug is in src/lib/cache.ts", "");
		assert(result.signals.includes("specific-files"));
		assert(result.score >= 0.6);
	});

	check("scoreHypothesis detects verification plan", () => {
		const result = scoreHypothesis("We should verify this by running the test suite", "");
		assert(result.signals.includes("verification-plan"));
	});

	check("scoreHypothesis detects causal reasoning", () => {
		const result = scoreHypothesis("This is caused by a race condition in the async handler", "");
		assert(result.signals.includes("causal-reasoning"));
	});

	check("scoreHypothesis detects proper solution intent", () => {
		const result = scoreHypothesis("The proper fix is to refactor the connection pool", "");
		assert(result.signals.includes("proper-solution"));
	});

	check("scoreHypothesis clamps score to [0, 1]", () => {
		const result = scoreHypothesis(
			"src/lib/cache.ts caused by race in verify check edge case — proper fix with test",
			"cache race condition verify"
		);
		assert(result.score <= 1.0);
		assert(result.score > 0.5);
	});

	check("scoreHypothesis empty input gets baseline", () => {
		const result = scoreHypothesis("", "");
		assert(result.score === 0.5);
		assert(result.signals.length === 0);
	});

	console.log("\n[2] Scoring handler — scoreHypothesisOutput");
	check("scoreHypothesisOutput with multiple blocks", () => {
		const input = "Hypothesis 1: Bug in cache.ts\nDetails here\n\nHypothesis 2: Race condition\nOther details";
		const { scored, annotated } = scoreHypothesisOutput(input, "cache");
		assert(scored.length >= 1);
		assert(annotated.includes("Score:"));
	});

	check("scoreHypothesisOutput single block", () => {
		const input = "The bug is caused by a stale cache entry in src/lib/cache.ts";
		const { scored, annotated } = scoreHypothesisOutput(input, "cache");
		assert(scored.length === 1);
		assert(scored[0].index === 0);
		assert(annotated.includes("Score:"));
	});

	// ── Handler structure verification ──────────────────────────────────────
	console.log("\n[3] Handler module structure");
	for (const name of ["scoring", "think", "hypothesize", "finalize"]) {
		check(`${name}.ts exists and is valid module`, () => {
			const src = readFileSync(
				`${ROOT}/src/extensions/metacognition/handlers/${name}.ts`, "utf8"
			);
			assert(src.length > 100, `${name}.ts is too short (${src.length} chars)`);
			// Check for error handling
			if (name !== "scoring") {
				assert(src.includes("catch") || src.includes("errorMessage"),
					`${name}.ts missing error handling`);
			}
		});
	}

	check("index.ts imports all handlers", () => {
		const src = readFileSync(`${ROOT}/src/extensions/metacognition/index.ts`, "utf8");
		assert(src.includes("from \"./handlers/think.js\""));
		assert(src.includes("from \"./handlers/hypothesize.js\""));
		assert(src.includes("from \"./handlers/finalize.js\""));
		// No cognition-evaluator import (removed with utility model)
	});

	check("index.ts registers all tools", () => {
		const src = readFileSync(`${ROOT}/src/extensions/metacognition/index.ts`, "utf8");
		assert(src.includes("registerThink"));
		assert(src.includes("registerHypothesize"));
		assert(src.includes("registerFinalize"));
	});

	const { evaluateCognition } = await import(`${ROOT}/dist/lib/cognition-evaluator.js`);

	// ── Cognition evaluator thresholds ─────────────────────────────────────
	console.log("\n[4] Cognition evaluator — threshold rationale");
	check("evaluator handles all-zero metrics", () => {
		const r = evaluateCognition({
			thinks: 0, hypothesizes: 0, finalizes: 0, avgConfidence: 0,
			hypothesesGenerated: 0, hypothesesWithVerification: 0,
			finalizationsBlocked: 0, depthDistribution: {}, reasoningTags: {},
		});
		assert(r.overall < 60);
		assert(r.recommendations.length >= 2);
	});

	check("evaluator handles extreme values", () => {
		const r = evaluateCognition({
			thinks: 1000, hypothesizes: 100, finalizes: 50, avgConfidence: 1.0,
			hypothesesGenerated: 300, hypothesesWithVerification: 290,
			finalizationsBlocked: 5,
			depthDistribution: { deep: 800, quick: 200 },
			reasoningTags: { plan: 300, hypothesis: 200, insight: 200, question: 150, assumption: 150 },
		});
		assert(r.overall > 60, `Expected >60, got ${r.overall}`);
		assert(r.reasoningDepth > 60);
		assert(r.hypothesisQuality > 60);
	});

	// Summary
	console.log(`\n${"=".repeat(50)}`);
	console.log(`metacognition-handlers: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
