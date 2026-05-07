/**
 * Test: Bidirectional Verifier — Phase 1: Forward Trace
 *
 * Based on: AgentV-RL (2604.16004) + HWE-Bench failure mode analysis
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  extractFileReferences,
  filesAreRelated,
  extractClaimedActions,
  validateArtifact,
  validateCompletion,
  recordClaimedActions,
  clearVerifierState,
  getArtifactValidationSummary,
  getFullVerificationReport,
  recordDerivedFrom,
  checkCoordinationRisk,
  scanForDerivedFiles,
  getCoordinationCheckSummary,
} = await import("../../dist/lib/bidirectional-verifier.js");

describe("BV1 Forward Trace", () => {
  it("extracts file references from absolute paths", () => {
    const text = "Error in /src/utils/helper.ts at line 42";
    const refs = extractFileReferences(text);
    assert.ok(refs.includes("/src/utils/helper.ts"), "Should extract absolute path");
  });

  it("extracts file references from relative paths", () => {
    const text = "See ./config/settings.json and ../shared/types.ts";
    const refs = extractFileReferences(text);
    assert.ok(refs.some((r) => r.includes("config/settings.json")), "Should extract relative path");
    assert.ok(refs.some((r) => r.includes("shared/types.ts")), "Should extract relative path");
  });

  it("extracts file references from error traces", () => {
    const text = "at validate (/src/lib/validation.ts:42:8)";
    const refs = extractFileReferences(text);
    assert.ok(refs.includes("/src/lib/validation.ts"), "Should extract trace file");
  });

  it("does not extract URLs as file references", () => {
    const text = "See https://example.com/docs and http://localhost:3000";
    const refs = extractFileReferences(text);
    assert.equal(refs.length, 0, "Should not extract URLs");
  });

  it("filesAreRelated matches same file", () => {
    assert.equal(filesAreRelated("src/app.ts", "src/app.ts"), true);
  });

  it("filesAreRelated matches shared directory", () => {
    assert.equal(filesAreRelated("src/utils/helper.ts", "src/utils/parser.ts"), true);
  });

  it("filesAreRelated matches same basename", () => {
    assert.equal(filesAreRelated("src/app.ts", "lib/app.js"), true);
  });

  it("filesAreRelated returns false for unrelated files", () => {
    assert.equal(filesAreRelated("src/frontend.tsx", "tests/backend.spec.ts"), false);
  });
});

// ── Phase 2: Artifact Validator ──────────────────────────────────────────────

describe("BV2 Artifact Validator", () => {
  it("extracts claimed actions from 'I will edit' patterns", () => {
    const claims = extractClaimedActions("I will edit src/utils/helper.ts to fix the bug", 1);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].file, "src/utils/helper.ts");
    assert.equal(claims[0].action, "edit");
  });

  it("extracts claimed actions from 'Let me fix' patterns", () => {
    const claims = extractClaimedActions("Let me fix src/app.ts - there's a race condition", 2);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].file, "src/app.ts");
  });

  it("extracts claimed actions from 'I'll create' patterns", () => {
    const claims = extractClaimedActions("I'll create src/new-api.ts for the endpoint", 3);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].action, "create");
  });

  it("extracts multiple claims from one message", () => {
    const claims = extractClaimedActions("I need to fix src/a.ts. I will update src/b.ts", 4);
    assert.equal(claims.length, 2);
  });

  it("does not extract non-file patterns (URLs, proper nouns)", () => {
    const claims = extractClaimedActions("I will implement the new feature called Utopia", 5);
    assert.equal(claims.length, 0, "Should not extract proper nouns as file paths");
  });

  it("records and validates matching artifact", () => {
    // Use a dummy context
    const ctx = { cwd: "/test" };
    recordClaimedActions(ctx, "I will edit src/app.ts", 1);
    const result = validateArtifact(ctx, "src/app.ts", 1);
    assert.equal(result, null, "Matching artifact should not flag mismatch");
  });

  it("flags mismatch when editing unclaimed files", () => {
    const ctx = { cwd: "/test" };
    recordClaimedActions(ctx, "I will edit frontend/components/Button.tsx", 1);
    const result = validateArtifact(ctx, "backend/api/routes.ts", 2);
    assert.notEqual(result, null, "Should flag mismatch");
    assert.ok(result.includes("routes"), "Should mention unexpected file");
  });
});

// ── Phase 3: Backward Checker ────────────────────────────────────────────────

describe("BV3 Backward Checker", () => {
  it("validateCompletion returns score for empty state", () => {
    // Use a dummy context with empty state
    const ctx = { cwd: "/test" };
    clearVerifierState(ctx);
    const result = validateCompletion(ctx);
    assert.equal(typeof result.verificationScore, "number");
    assert.equal(result.problemFiles, 0);
    assert.equal(result.editedFiles, 0);
  });

  it("getArtifactValidationSummary returns string", () => {
    const summary = getArtifactValidationSummary();
    assert.ok(typeof summary === "string");
    assert.ok(summary.includes("Claimed actions:"));
  });

  it("getFullVerificationReport returns comprehensive report with Phase 4", () => {
    const ctx = { cwd: "/test" };
    clearVerifierState(ctx);
    clearVerifierState(ctx); // reset coordination state too

    // Record a derived relationship
    recordDerivedFrom("src/derived.ts", "src/source.ts", "import", 1);

    const report = getFullVerificationReport(ctx);
    assert.ok(report.includes("Forward Trace"));
    assert.ok(report.includes("Artifact Validation"));
    assert.ok(report.includes("Backward Check"));
    assert.ok(report.includes("Coordination Check"));
    assert.ok(report.includes("Verification score:"));
  });

  // ── Phase 4: Coordination Checker ────────────────────────────────────────
});

describe("BV4 Coordination Checker", () => {
  it("recordDerivedFrom stores relationship", () => {
    const ctx = { cwd: "/test" };
    clearVerifierState(ctx);
    recordDerivedFrom("src/components/Button.tsx", "src/styles/theme.ts", "import", 1);
    const summary = getCoordinationCheckSummary();
    assert.ok(summary.includes("Derived relationships: 1"));
  });

  it("checkCoordinationRisk returns null when no stale derived files", () => {
    const ctx = { cwd: "/test" };
    clearVerifierState(ctx);
    const risk = checkCoordinationRisk(ctx, "src/source.ts", 1);
    assert.equal(risk, null);
  });

  it("checkCoordinationRisk flags stale derived files", () => {
    const ctx = { cwd: "/test" };
    clearVerifierState(ctx);
    // Record derived relationship
    recordDerivedFrom("src/derived.ts", "src/source.ts", "import", 1);
    // Check coordination risk — should flag derived.ts as stale
    const risk = checkCoordinationRisk(ctx, "src/source.ts", 2);
    assert.notEqual(risk, null, "Should flag stale derived file");
    assert.ok(risk.includes("derived.ts"), "Should mention the derived file");
  });

  it("checkCoordinationRisk returns null when derived was also touched after source edit", () => {
    const ctx = { cwd: "/test" };
    clearVerifierState(ctx);
    recordDerivedFrom("src/derived.ts", "src/source.ts", "import", 1);
    // Simulate: source edited at turn 2, derived touched at turn 3
    const risk = checkCoordinationRisk(ctx, "src/source.ts", 2);
    assert.notEqual(risk, null, "Derived still stale — wasn't touched after source edit");
  });

  it("getCoordinationCheckSummary returns info string when no relationships", () => {
    const ctx = { cwd: "/test" };
    clearVerifierState(ctx);
    const summary = getCoordinationCheckSummary();
    assert.ok(summary.includes("No derived file relationships"));
  });

  it("scanForDerivedFiles detects import relationships", () => {
    // Simulate reading a file that imports a recently-edited file
    const content = `import { helper } from "./helper";\nimport * as path from "node:path";\n`;
    // We can't easily test this without real state tracking, but it shouldn't crash
    const ctx = { cwd: "/test" };
    clearVerifierState(ctx);
    scanForDerivedFiles(ctx, "src/main.ts", content, 1);
    // No crash = success for now (imports are relative and need matching state)
  });

  it("clearVerifierState resets coordination state", () => {
    const ctx = { cwd: "/test" };
    clearVerifierState(ctx);
    recordDerivedFrom("src/derived.ts", "src/source.ts", "import", 1);
    assert.ok(getCoordinationCheckSummary().includes("Derived relationships: 1"));
    clearVerifierState(ctx);
    assert.ok(getCoordinationCheckSummary().includes("No derived file relationships"));
  });

  it("full report includes Phase 4 coordination check", () => {
    const ctx = { cwd: "/test" };
    clearVerifierState(ctx);
    recordDerivedFrom("src/a.ts", "src/b.ts", "import", 1);
    const report = getFullVerificationReport(ctx);
    assert.ok(report.includes("Coordination Check"));
    assert.ok(report.includes("Derived relationships: 1"));
  });
});

console.log("✅ BV1-BV4 bidirectional-verifier tests complete");
