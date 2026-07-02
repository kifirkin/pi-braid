/**
 * Tests for extension-utils pure functions.
 * APIs discovered through runtime inspection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  textResult,
  textParts,
  formatBytes,
  formatDuration,
  clamp,
  debounce,
  looksLikeFilePath,
} = await import("../../../dist/lib/utils/extension-utils.js");

describe("textResult", () => {
  it("returns content array with text entry", () => {
    const r = textResult("hello");
    assert.equal(r.content[0].type, "text");
    assert.equal(r.content[0].text, "hello");
  });
});

describe("textParts", () => {
  it("returns multiple text entries", () => {
    const r = textParts("a", "b");
    assert.equal(r.content.length, 2);
    assert.equal(r.content[0].text, "a");
    assert.equal(r.content[1].text, "b");
  });
});

describe("formatBytes", () => {
  it("formats zero bytes as 0B", () => {
    assert.equal(formatBytes(0), "0B");
  });

  it("formats 1024 as 1.0KB", () => {
    assert.equal(formatBytes(1024), "1.0KB");
  });

  it("formats 1MB as 1.0MB", () => {
    assert.equal(formatBytes(1048576), "1.0MB");
  });

  it("formats 1GB with GB suffix", () => {
    assert.ok(formatBytes(1073741824).includes("GB"));
  });
});

describe("formatDuration", () => {
  it("formats milliseconds", () => {
    assert.equal(formatDuration(500), "500ms");
  });

  it("formats seconds", () => {
    assert.equal(formatDuration(5000), "5.0s");
  });

  it("formats minutes", () => {
    assert.equal(formatDuration(125000), "2.1m");
  });

  it("formats large durations as minutes", () => {
    assert.equal(formatDuration(3600000), "60.0m");
  });
});

describe("clamp", () => {
  it("clamps below min", () => {
    assert.equal(clamp(-5, 0, 10), 0);
  });

  it("clamps above max", () => {
    assert.equal(clamp(15, 0, 10), 10);
  });

  it("passes through in range", () => {
    assert.equal(clamp(5, 0, 10), 5);
  });
});

describe("looksLikeFilePath", () => {
  it("returns true for path with extension", () => {
    assert.equal(looksLikeFilePath("src/lib/foo.ts"), true);
  });

  it("returns true for path with slash", () => {
    assert.equal(looksLikeFilePath("src/foo"), true);
  });
});

describe("debounce", () => {
  it("returns a function", () => {
    const fn = debounce(() => {}, 100);
    assert.equal(typeof fn, "function");
  });
});

console.log("[ok] Extension-utils tests complete");
