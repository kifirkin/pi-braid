/**
 * Belief Policy Engine — Unit Tests
 * Tests that each policy rule fires correctly with proper signal inputs.
 */
import { equal } from "node:assert";

// ── Mock ExtensionContext ─────────────────────────────────────────────────────

function makeCtx() {
	const state = new Map();
	return {
		session: { id: "test-session" },
		workspace: "/tmp",
		extensionState: state,
		getExtensionState: (key, factory) => {
			if (!state.has(key)) state.set(key, factory());
			return state.get(key);
		},
	};
}

// ── Policy Rule Tests ─────────────────────────────────────────────────────────

// Rule 1: stability_decline fires with 3+ stability/decline signals
{
	const ctx = makeCtx();
	const { emitSignal, getNextRecommendation } = await import("../../dist/lib/reasoning/belief-policy-engine.js");

	emitSignal(ctx, "stability", "decline", "warn", false, { overlap: 0.7 });
	emitSignal(ctx, "stability", "decline", "warn", false, { overlap: 0.6 });
	const r1 = getNextRecommendation(ctx);
	equal(r1, null, "Rule 1: 2 stability signals should not fire");

	emitSignal(ctx, "stability", "decline", "warn", false, { overlap: 0.5 });
	const r2 = getNextRecommendation(ctx);
	equal(r2 ? r2.type : null, "stability_decline", "Rule 1: 3 stability signals should fire stability_decline");
	equal(r2 ? r2.priority >= 5 : false, true, "Rule 1: priority should be >= 5");
	console.log("  ✅ Rule 1: stability_decline fires at 3+ signals");
}

// Rule 2: conflict_accumulation fires with 5+ unresolved conflicts
{
	const ctx = makeCtx();
	const { emitSignal, getNextRecommendation } = await import("../../dist/lib/reasoning/belief-policy-engine.js");

	for (let i = 0; i < 4; i++) {
		emitSignal(ctx, "conflict", "unresolved", "info", false, { count: i + 1 });
	}
	const r1 = getNextRecommendation(ctx);
	equal(r1, null, "Rule 2: 4 conflicts should not fire");

	emitSignal(ctx, "conflict", "unresolved", "info", false, { count: 5 });
	const r2 = getNextRecommendation(ctx);
	equal(r2 ? r2.type : null, "conflict_accumulation", "Rule 2: 5 conflicts should fire conflict_accumulation");
	console.log("  ✅ Rule 2: conflict_accumulation fires at 5+ unresolved");
}

// Rule 3: drift_plus_scatter fires with topic-drift + 2+ tool-use
{
	const ctx = makeCtx();
	const { emitSignal, getNextRecommendation } = await import("../../dist/lib/reasoning/belief-policy-engine.js");

	emitSignal(ctx, "topic-drift", "detected", "warn", false, { severity: "strong" });
	emitSignal(ctx, "tool-use", "overuse", "warn", false, { tools: ["bash"] });
	const r1 = getNextRecommendation(ctx);
	equal(r1, null, "Rule 3: drift + 1 tool-use should not fire");

	emitSignal(ctx, "tool-use", "overuse", "warn", false, { tools: ["bash", "grep"] });
	const r2 = getNextRecommendation(ctx);
	equal(r2 ? r2.type : null, "drift_plus_scatter", "Rule 3: drift + 2 tool-use should fire drift_plus_scatter");
	console.log("  ✅ Rule 3: drift_plus_scatter fires with drift + 2+ tool-use");
}

// Rule 4: calibration_error fires with 2+ high-error
{
	const ctx = makeCtx();
	const { emitSignal, getNextRecommendation } = await import("../../dist/lib/reasoning/belief-policy-engine.js");

	emitSignal(ctx, "calibration", "high-error", "warn", false, { error: 0.5 });
	const r1 = getNextRecommendation(ctx);
	equal(r1, null, "Rule 4: 1 calibration error should not fire");

	emitSignal(ctx, "calibration", "high-error", "warn", false, { error: 0.6 });
	const r2 = getNextRecommendation(ctx);
	equal(r2 ? r2.type : null, "calibration_error", "Rule 4: 2 errors should fire calibration_error");
	console.log("  ✅ Rule 4: calibration_error fires at 2+ high-error");
}

// Rule 5: reflection_gap fires with 8+ tool-use without reflection
{
	const ctx = makeCtx();
	const { emitSignal, getNextRecommendation } = await import("../../dist/lib/reasoning/belief-policy-engine.js");

	for (let i = 0; i < 7; i++) {
		emitSignal(ctx, "tool-use", "overuse", "warn", false, { tools: [`tool${i}`] });
	}
	const r1 = getNextRecommendation(ctx);
	equal(r1, null, "Rule 5: 7 tool calls should not fire");

	emitSignal(ctx, "tool-use", "overuse", "warn", false, { tools: ["tool8"] });
	const r2 = getNextRecommendation(ctx);
	equal(r2 ? r2.type : null, "reflection_gap", "Rule 5: 8+ tool calls should fire reflection_gap");
	console.log("  ✅ Rule 5: reflection_gap fires at 8+ tool calls without reflection");
}

// Rule 6: reasoning_plus_conflict
{
	const ctx = makeCtx();
	const { emitSignal, getNextRecommendation } = await import("../../dist/lib/reasoning/belief-policy-engine.js");

	emitSignal(ctx, "reasoning", "decline", "warn", false, { overlap: 0.4 });
	emitSignal(ctx, "conflict", "detected", "warn", false, {});
	const r = getNextRecommendation(ctx);
	equal(r ? r.type : null, "reasoning_plus_conflict", "Rule 6: reasoning decline + conflict fires");
	console.log("  ✅ Rule 6: reasoning_plus_conflict fires");
}

// Signal storage limit
{
	const ctx = makeCtx();
	const { emitSignal, getNextRecommendation } = await import("../../dist/lib/reasoning/belief-policy-engine.js");

	for (let i = 0; i < 60; i++) {
		emitSignal(ctx, "tool-use", "overuse", "warn", false, { tools: [`tool${i}`] });
	}
	const r = getNextRecommendation(ctx);
	equal(r ? r.type : null, "reflection_gap", "Signal cap: 60 emitted, capped to 30, still fires");
	console.log("  ✅ Signal storage: caps at 30, no crash");
}

console.log("\n📊 All belief-policy-engine tests passed");
