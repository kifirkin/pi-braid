/**
 * Test: Bidirectional Verifier - File Touch Tracking
 *
 * Tests the remaining externally-called functions after Phase 2/4 removal:
 *   extractFileReferences, filesAreRelated, clearVerifierState
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  extractFileReferences,
  filesAreRelated,
  clearVerifierState,
  getVerifierState,
} = await import("../../../dist/lib/store/bidirectional-verifier.js");

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

describe("State Reset", () => {
  it("clearVerifierState clears session state without errors", () => {
    const ctx = { cwd: "/test" };
    clearVerifierState(ctx);
    const state = getVerifierState(ctx);
    assert.equal(state.problemFiles.size, 0);
    assert.equal(state.readFiles.size, 0);
    assert.equal(state.editedFiles.size, 0);
  });
});

console.log("✅ Bidirectional verifier tests complete");