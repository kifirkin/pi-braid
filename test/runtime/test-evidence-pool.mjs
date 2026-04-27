/**
 * Evidence Pool — runtime tests
 * Run: node test/runtime/test-evidence-pool.mjs
 */
const ROOT = "/Users/kifir/projects/agents/pi-braid";
const { addEvidence, getEvidence, getUnresolvedConflicts, detectConflicts, resolveConflict, clearEvidence } = await import(`${ROOT}/dist/lib/evidence-pool.js`);

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log(`  ✅ ${msg}`)) : (failed++, console.log(`  ❌ ${msg}`));

// Use fresh ctx per test
const fresh = () => {
    const ctx = {};
    clearEvidence(ctx);
    return ctx;
};

// ── Basic evidence ────────────────────────────────────────────────────────
console.log("\n[1] Basic evidence operations");
{
    const ctx = fresh();
    const id1 = addEvidence(ctx, "The bug is in the null check", "memory", "I found the bug", 0.9);
    assert(id1.startsWith("e"), `addEvidence returns ID: ${id1}`);
    const evidence = getEvidence(ctx);
    assert(evidence.length === 1, `getEvidence returns 1: ${evidence.length}`);
    assert(evidence[0].confidence === 0.9, `confidence preserved: ${evidence[0].confidence}`);
    assert(evidence[0].source === "memory", `source: memory`);
}

// ── Source filtering ──────────────────────────────────────────────────────
console.log("\n[2] Source filtering");
{
    const ctx = fresh();
    addEvidence(ctx, "Use regex", "web", "Regex is best", 0.8);
    addEvidence(ctx, "Use string", "docs", "String recommended", 0.7);
    assert(getEvidence(ctx).length === 2, `all 2: ${getEvidence(ctx).length}`);
    assert(getEvidence(ctx, { source: "memory" }).length === 0, `memory filter: 0`);
    assert(getEvidence(ctx, { source: "web" }).length === 1, `web filter: 1`);
}

// ── Conflict detection (via addEvidence) ─────────────────────────────────
// Note: detectConflictsFor runs inside addEvidence — conflicts are auto-detected
console.log("\n[3] Conflict detection");
{
    const ctx = fresh();
    addEvidence(ctx, "Use regex for pattern matching", "web", "Regex is best", 0.9);
    addEvidence(ctx, "Use string methods for pattern matching", "docs", "String recommended", 0.6);
    // Conflict auto-detected by detectConflictsFor inside addEvidence
    const unresolved = getUnresolvedConflicts(ctx);
    assert(unresolved.length >= 1, `unresolved conflicts: ${unresolved.length}`);
    assert(unresolved[0].for[0].source === "web", `for=higher confidence source`);
}

// ── Same source should not conflict ────────────────────────────────────────
console.log("\n[4] Same source no conflict");
{
    const ctx = fresh();
    addEvidence(ctx, "Use regex for matching", "memory", "Memory A", 0.8);
    addEvidence(ctx, "Use regex for matching", "memory", "Memory B", 0.9);
    assert(getUnresolvedConflicts(ctx).length === 0, `same source no conflict`);
}

// ── Conflict resolution ───────────────────────────────────────────────────
console.log("\n[5] Conflict resolution");
{
    const ctx = fresh();
    addEvidence(ctx, "Bug is null reference exception in auth module", "memory", "Memory", 0.9);
    addEvidence(ctx, "Bug is null reference error in authentication module", "web", "Web", 0.7);
    const before = getUnresolvedConflicts(ctx);
    assert(before.length >= 1, `before resolution: ${before.length}`);
    resolveConflict(ctx, before[0].id, "resolved_for", "memory more recent");
    const after = getUnresolvedConflicts(ctx);
    assert(after.length === 0, `after resolution: ${after.length}`);
}

// ── Clear ─────────────────────────────────────────────────────────────────
console.log("\n[6] Clear");
{
    const ctx = fresh();
    addEvidence(ctx, "Test claim", "memory", "Test content", 0.5);
    assert(getEvidence(ctx).length === 1, `before clear: 1`);
    clearEvidence(ctx);
    assert(getEvidence(ctx).length === 0, `after clear: ${getEvidence(ctx).length}`);
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(50));
console.log(`Evidence Pool: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log("✅ All evidence pool tests passed!");
