/**
 * Test: Slop scanner — echo-comment tiers.
 *
 * Covers the two `//`-comment narration tiers added to the scanner:
 *   echo-imperative  — imperative verb opening a line comment (advisory)
 *   echo-short-form  — imperative verb plus at most five words (hard)
 * plus the existing third-person echo pattern and the JSDoc exemption the
 * slash-only scoping guarantees.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { scanAddedLinesForSlop } = await import(
  "../../../dist/lib/orchestrator/slop-scanner.js"
);

describe("Slop scanner: echo-imperative tier", () => {
  it("flags a full-line imperative narration comment", () => {
    const hits = scanAddedLinesForSlop("+    // Set the value\n+    cache.set(k, v);\n");
    const ids = hits.map((h) => h.pattern);
    assert.ok(ids.includes("echo-imperative"), `expected echo-imperative, got ${ids}`);
  });

  it("flags a trailing imperative comment after code", () => {
    const hits = scanAddedLinesForSlop("+const x = read(); // Get the value\n");
    assert.ok(hits.some((h) => h.pattern === "echo-imperative"));
  });

  it("flags every verb family member sampled from the Class-1 list", () => {
    for (const verb of ["Create", "Update", "Remove", "Extract", "Register", "Validate", "Reset"]) {
      const hits = scanAddedLinesForSlop(`+// ${verb} the entry\n`);
      assert.ok(
        hits.some((h) => h.pattern === "echo-imperative"),
        `${verb} should be flagged`,
      );
    }
  });

  it("does not flag a why-comment that opens with a non-verb word", () => {
    const hits = scanAddedLinesForSlop(
      "+    // Exact id match takes precedence over the text fallback.\n",
    );
    assert.equal(hits.filter((h) => h.pattern.startsWith("echo-")).length, 0);
  });

  it("does not flag imperative voice inside block or JSDoc lines", () => {
    const hits = scanAddedLinesForSlop(
      "+ * Extract the comment portion of a source line.\n+    /* Parse the input here */\n",
    );
    assert.equal(hits.filter((h) => h.pattern.startsWith("echo-")).length, 0);
  });
});

describe("Slop scanner: echo-short-form hard tier", () => {
  it("flags verb + at most five words with hard severity", () => {
    const hits = scanAddedLinesForSlop("+    // Extract name\n+const name = block.match(re);\n");
    const hit = hits.find((h) => h.pattern === "echo-short-form");
    assert.ok(hit, "short-form should be flagged");
    assert.equal(hit.severity, "hard");
  });

  it("five words after the verb is still the hard tier", () => {
    const hits = scanAddedLinesForSlop("+// Check if the file still exists\n");
    const hit = hits.find((h) => h.pattern === "echo-short-form");
    assert.ok(hit, "verb + 5 words should be hard tier");
  });

  it("six words after the verb escapes the hard tier but stays advisory", () => {
    const hits = scanAddedLinesForSlop("+// Check if the file still exists today\n");
    assert.ok(!hits.some((h) => h.pattern === "echo-short-form"));
    assert.ok(hits.some((h) => h.pattern === "echo-imperative"));
  });

  it("longer imperative comments are advisory only, not hard", () => {
    const hits = scanAddedLinesForSlop(
      "+// Set by setCachedSkills() in the current module's sibling index.ts.\n",
    );
    assert.ok(!hits.some((h) => h.pattern === "echo-short-form"));
    assert.ok(hits.some((h) => h.pattern === "echo-imperative"));
  });
});

describe("Slop scanner: existing classes keep working", () => {
  it("still flags third-person narration comments", () => {
    const hits = scanAddedLinesForSlop("+    // Gets the cached value\n+    return cache[k];\n");
    assert.ok(hits.some((h) => h.pattern === "echo-comment"));
  });

  it("still flags wave tokens and swallowed catches", () => {
    const hits = scanAddedLinesForSlop(
      "+// wave 3 cleanup\n+try {\n+  load();\n+} catch {\n+}\n",
    );
    const ids = hits.map((h) => h.pattern);
    assert.ok(ids.includes("wave-word"), `wave-word missing, got ${ids}`);
    assert.ok(ids.includes("swallowed-catch"), `swallowed-catch missing, got ${ids}`);
  });
});
