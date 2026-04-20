/**
 * Heartbeat Scheduler — runtime tests
 * Run: node test/runtime/test-heartbeat.mjs
 */
const ROOT = "/Users/kifir/projects/agents/pi-braid";
// Note: heartbeat-scheduler depends on pi extensions, so we test the module logic

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log(`  ✅ ${msg}`)) : (failed++, console.log(`  ❌ ${msg}`));

// ── Module structure tests ──────────────────────────────────────────────
console.log("\n[1] Module exports");
{
	const mod = await import(`${ROOT}/dist/extensions/heartbeat-scheduler/index.js`);
	assert(mod.default !== undefined, `default export exists`);
	assert(typeof mod.default === "function", `default export is function`);
	assert(typeof mod.recallerModule === "object", `recallerModule exported`);
	assert(typeof mod.dreamerModule === "object", `dreamerModule exported`);
	assert(typeof mod.contextHygieneModule === "object", `contextHygieneModule exported`);
}

// ── Module properties ──────────────────────────────────────────────────
console.log("\n[2] Module properties");
{
	const { recallerModule, dreamerModule, contextHygieneModule } = await import(`${ROOT}/dist/extensions/heartbeat-scheduler/index.js`);
	assert(recallerModule.name === "recaller", `recaller name: ${recallerModule.name}`);
	assert(recallerModule.priority === 0.6, `recaller priority: ${recallerModule.priority}`);
	assert(dreamerModule.name === "dreamer", `dreamer name: ${dreamerModule.name}`);
	assert(dreamerModule.priority === 0.4, `dreamer priority: ${dreamerModule.priority}`);
	assert(contextHygieneModule.name === "context-hygiene", `hygiene name: ${contextHygieneModule.name}`);
	assert(contextHygieneModule.priority === 0.8, `hygiene priority: ${contextHygieneModule.priority}`);
}

// ── Activation logic ──────────────────────────────────────────────────
console.log("\n[3] Module activation conditions");
{
	const { recallerModule, dreamerModule, contextHygieneModule } = await import(`${ROOT}/dist/extensions/heartbeat-scheduler/index.js`);

	// Recaller: needs 5+ tool calls and 15+ turns since last activation
	const ctx1 = { lastActivation: new Map([["recaller", 0]]), turnCount: 20, totalToolCalls: 10 };
	assert(recallerModule.shouldActivate(ctx1) === true, `recaller activates with 20 turns, 10 tools`);

	const ctx2 = { lastActivation: new Map([["recaller", 15]]), turnCount: 20, totalToolCalls: 10 };
	assert(recallerModule.shouldActivate(ctx2) === false, `recaller skips: only 5 turns since last`);

	const ctx3 = { lastActivation: new Map([["recaller", 0]]), turnCount: 20, totalToolCalls: 2 };
	assert(recallerModule.shouldActivate(ctx3) === false, `recaller skips: only 2 tool calls`);

	// Hygiene: activates every 20 turns
	const ctx4 = { lastActivation: new Map([["context-hygiene", 0]]), turnCount: 21 };
	assert(contextHygieneModule.shouldActivate(ctx4) === true, `hygiene activates at turn 21`);

	const ctx5 = { lastActivation: new Map([["context-hygiene", 15]]), turnCount: 21 };
	assert(contextHygieneModule.shouldActivate(ctx5) === false, `hygiene skips: only 6 turns since last`);
}

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Heartbeat Scheduler Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);