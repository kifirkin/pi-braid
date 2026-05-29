/**
 * Test: SOP Extractor — trajectory → structured SOP conversion.
 *
 * Runtime tests importing from dist/lib/utils/sop-extractor.js.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { extractSOP } = await import("../../../dist/lib/utils/sop-extractor.js");

describe("SOP Extractor", () => {
  it("handles empty trajectory", () => {
    const sop = extractSOP({
      task: "Fix the bug",
      trajectory: [],
      solution: "Did nothing",
      outcome: "failure",
    });
    assert.ok(sop.strategicSOP.includes("Fix the bug"));
    assert.equal(sop.functionalSOP.length, 1);
    assert.equal(sop.atomicSOP.length, 0);
  });

  it("extracts read-edit-bash pattern", () => {
    const sop = extractSOP({
      task: "Fix syntax error",
      trajectory: [
        { toolName: "read", success: true },
        { toolName: "edit", success: true },
        { toolName: "bash", success: true },
      ],
      solution: "Fixed the error and verified",
      outcome: "success",
    });
    assert.ok(sop.strategicSOP.includes("Read-Fix-Verify"));
    assert.ok(sop.functionalSOP.length >= 1);
    assert.deepEqual(sop.atomicSOP, ["read", "edit", "bash"]);
  });

  it("extracts read-write-bash pattern", () => {
    const sop = extractSOP({
      task: "Create a new file",
      trajectory: [
        { toolName: "read", success: true },
        { toolName: "write", success: true },
        { toolName: "bash", success: true },
      ],
      solution: "Created and verified",
      outcome: "success",
    });
    assert.ok(sop.strategicSOP.includes("Read-Create-Verify"));
  });

  it("extracts multi-source investigation", () => {
    const sop = extractSOP({
      task: "Research codebase",
      trajectory: [
        { toolName: "read", success: true },
        { toolName: "read", success: true },
        { toolName: "read", success: true },
        { toolName: "grep", success: true },
      ],
      solution: "Found the relevant code",
      outcome: "success",
    });
    assert.ok(sop.strategicSOP);
    assert.equal(sop.functionalSOP.length, 1);
  });

  it("deduplicates consecutive tool repeats in atomic SOP", () => {
    const sop = extractSOP({
      task: "Test multiple times",
      trajectory: [
        { toolName: "bash", success: true },
        { toolName: "bash", success: true },
        { toolName: "bash", success: true },
        { toolName: "read", success: true },
      ],
      solution: "Ran tests",
      outcome: "success",
    });
    assert.ok(sop.atomicSOP.some((s) => s.includes("×")));
  });

  it("works with write-read-bash pattern", () => {
    const sop = extractSOP({
      task: "Implement feature",
      trajectory: [
        { toolName: "write", success: true },
        { toolName: "bash", success: false },
        { toolName: "read", success: true },
        { toolName: "edit", success: true },
        { toolName: "bash", success: true },
      ],
      solution: "Iterated until tests passed",
      outcome: "partial",
    });
    assert.ok(sop.strategicSOP, "has strategic SOP");
    assert.ok(sop.functionalSOP.length > 0, "has functional steps");
    assert.ok(sop.atomicSOP.length > 0, "has atomic steps");
  });

  it("generates functional steps from category summary when no phase transitions", () => {
    const sop = extractSOP({
      task: "Complex task",
      trajectory: [
        { toolName: "grep", success: true },
        { toolName: "find", success: true },
        { toolName: "codebase_tree", success: true },
      ],
      solution: "Used search tools",
      outcome: "success",
    });
    assert.ok(sop.functionalSOP.length > 0);
  });

  it("includes tool counts in strategic SOP on success", () => {
    const sop = extractSOP({
      task: "Verify build",
      trajectory: [
        { toolName: "bash", success: true },
        { toolName: "bash", success: true },
        { toolName: "bash", success: true },
      ],
      solution: "All tests pass",
      outcome: "success",
    });
    assert.ok(sop.strategicSOP.includes("3/3"));
  });
});
