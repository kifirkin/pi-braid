/**
 * Conflict QA — runtime tests
 * Run: node test/runtime/test-conflict-qa.mjs
 */
const ROOT = "/Users/kifir/projects/agents/pi-braid";
const { addEvidence, detectConflicts, clearEvidence } = await import(`${ROOT}/dist/lib/evidence-pool.js`);
const {
	processConflicts,
	getPendingQAs,
	resolveQA,
	getQAStats,
	getRelevantQA,
	getAllQAs,
	formatConflictWhisper,
} = await import(`${ROOT}/dist/lib/conflict-qa.js`);

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log(`  ✅ ${msg}`)) : (failed++, console.log(`  ❌ ${msg}`));

const fresh = () => {
	const ctx = {};
	clearEvidence(ctx);
	return ctx;
};

// ── No conflicts → no QAs ────────────────────────────────────────────
console.log("\n[1] No conflicts produces no QAs");
{
	const ctx = fresh();
	const qas = processConflicts(ctx);
	assert(qas.length === 0, `No conflicts → 0 QAs: ${qas.length}`);
	const pending = getPendingQAs(ctx);
	assert(pending.length === 0, `No pending QAs: ${pending.length}`);
}

// ── Direct conflict → QA generated ────────────────────────────────────
console.log("\n[2] Direct conflict produces QA");
{
	const ctx = fresh();
	// Add conflicting evidence
	addEvidence(ctx, "Use TypeScript", "code", "The codebase uses TypeScript", 0.9);
	addEvidence(ctx, "Use JavaScript", "session", "The project requires JavaScript", 0.7);

	const conflicts = detectConflicts(ctx);
	assert(conflicts.length >= 1, `Detected ${conflicts.length} conflict(s)`);

	if (conflicts.length > 0) {
		const qas = processConflicts(ctx);
		assert(qas.length >= 1, `Generated ${qas.length} QA(s)`);

		if (qas.length > 0) {
			const qa = qas[0];
			assert(qa.type === "direct" || qa.type === "implication", `QA type: ${qa.type}`);
			assert(qa.question.length > 0, `Question has content`);
			assert(qa.resolutionStrategy.length > 0, `Strategy defined: ${qa.resolutionStrategy}`);
			assert(qa.conflictId.length > 0, `Conflict ID present`);
			assert(qa.sources.length >= 2, `Has 2+ sources: ${qa.sources.length}`);
		}
	}
}

// ── Resolve QA ────────────────────────────────────────────────────────
console.log("\n[3] Resolve QA");
{
	const ctx = fresh();
	addEvidence(ctx, "Always use npm", "docs", "npm is recommended", 0.8);
	addEvidence(ctx, "Use yarn instead", "web", "yarn is faster", 0.7);
	detectConflicts(ctx);

	const qas = processConflicts(ctx);
	if (qas.length > 0) {
		const qa = qas[0];
		resolveQA(ctx, qa.id, "prefer npm for compatibility");
		const pending = getPendingQAs(ctx);
		assert(pending.length === qas.length - 1, `1 less pending: ${pending.length}`);

		const stats = getQAStats(ctx);
		assert(stats.totalResolved === 1, `1 resolved: ${stats.totalResolved}`);
	}
}

// ── QA stats ──────────────────────────────────────────────────────────
console.log("\n[4] QA stats");
{
	const ctx = fresh();
	const stats = getQAStats(ctx);
	assert(typeof stats.totalGenerated === "number", `totalGenerated is number`);
	assert(typeof stats.totalResolved === "number", `totalResolved is number`);
	assert(typeof stats.pendingCount === "number", `pendingCount is number`);
}

// ── Format conflict whisper ───────────────────────────────────────────
console.log("\n[5] Format conflict whisper");
{
	const result = formatConflictWhisper([]);
	assert(result === "", `Empty QAs → empty whisper`);

	const qas = [{
		id: "qa-test",
		conflictId: "c-test",
		type: "direct",
		question: "TypeScript vs JavaScript?",
		resolutionStrategy: "favor_text",
		sources: [
			{ type: "code", content: "Use TypeScript", confidence: 0.9 },
			{ type: "session", content: "Use JavaScript", confidence: 0.7 },
		],
		createdAt: Date.now(),
	}];
	const whisper = formatConflictWhisper(qas);
	assert(whisper.includes("[conflict-qa]"), `Whisper has header`);
	assert(whisper.includes("direct"), `Whisper has type`);
	assert(whisper.includes("TypeScript"), `Whisper has question content`);
}

// ── Get relevant QA ───────────────────────────────────────────────────
console.log("\n[6] Get relevant QA by topic");
{
	const ctx = fresh();
	// No QAs → null
	const none = getRelevantQA(ctx, "TypeScript");
	assert(none === null, `No QAs → null: ${none}`);

	// Add conflict QAs
	addEvidence(ctx, "Use TypeScript", "code", "Codebase uses TypeScript", 0.9);
	addEvidence(ctx, "Use JavaScript", "session", "Use JavaScript", 0.7);
	detectConflicts(ctx);
	processConflicts(ctx);

	const relevant = getRelevantQA(ctx, "TypeScript");
	assert(relevant !== null || getPendingQAs(ctx).length === 0, `Found relevant QA or no QAs exist`);
}

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Conflict QA Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);