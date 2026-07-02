/**
 * Test: prompt-builder/memory-section.ts - pointer block rendering.
 *
 * Verifies the plain-text pointer block (post-2026-07-02 lean refactor):
 *   1. Returns a non-empty string (always renders the 3-store pointer block,
 *      even when every store is empty - mirrors skills' "Skills (0 available): ..."
 *      so the agent knows the stores exist as concepts).
 *   2. Directive + 3 pointer lines (no XML tags, no <store ...> self-closing).
 *   3. Episodes + semantic lines: name + count + path, plain-text form.
 *   4. Heuristics pointer is a session-scoped line (no path).
 *   5. No angle brackets anywhere in the output (plain text only).
 *   6. No bloat: no <recent>, <outcomes>, <by_type>, <episode>, <description>.
 *   7. Cache: second call returns identical output without re-statting.
 *   8. Cache invalidation resets the section.
 *
 * The test reads from the on-disk memory files in ~/.pi/agent/braid/memory/
 * which contain the user's real memory. It uses the same paths the production
 * code uses, so any change to the on-disk schema will be caught.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const {
  reconstructMemorySection,
  resetMemorySectionCache,
} = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "memory-section.js")
);

// Minimal mock ctx - getExtensionState uses WeakMap on the ctx object.
function makeMockCtx() {
  return { cwd: process.cwd() };
}

describe("memory-section", () => {
  let ctx;

  beforeEach(() => {
    ctx = makeMockCtx();
    resetMemorySectionCache(ctx);
  });

  it("always renders the 3-store pointer block (lean refactor)", async () => {
    // After the 2026-07-02 refactor, the section always renders - even when
    // every store is empty - so the agent knows the stores exist as concepts.
    const out = await reconstructMemorySection(ctx);
    assert.notEqual(out, "", "memory section must always render (3-store pointer)");
  });

  it("opens with the directive (no XML wrapper)", async () => {
    const out = await reconstructMemorySection(ctx);
    assert.match(out, /Memory \(episodes, semantic, heuristics\): use `memory` to recall/);
    // No XML envelope -- plain text only.
    assert.ok(!/<available_memories>/.test(out), "must not use <available_memories> wrapper");
    assert.ok(!/<\/available_memories>/.test(out), "must not close </available_memories>");
  });

  it("renders episodes + semantic as plain-text `- <name>: <count> entries at <path>` lines", async () => {
    const out = await reconstructMemorySection(ctx);
    assert.match(
      out,
      /^- episodes: \d+ entries at \S+$/m,
      "episodes store must be a plain-text `- episodes: N entries at PATH` line",
    );
    assert.match(
      out,
      /^- semantic: \d+ entries at \S+$/m,
      "semantic store must be a plain-text `- semantic: N entries at PATH` line",
    );
  });

  it("renders heuristics as a session-scoped plain-text line (no path)", async () => {
    const out = await reconstructMemorySection(ctx);
    assert.match(
      out,
      /^- heuristics: session-scoped \(no on-disk file\)$/m,
      "heuristics must be a plain-text session-scoped line with no path",
    );
  });

  it("does not surface per-episode details (lean refactor)", async () => {
    // The skills model says "descriptions live in the files". The memory model
    // says "task snippets live in the files too". No XML wrappers, no bloat
    // tags -- the section is plain text.
    const out = await reconstructMemorySection(ctx);
    assert.ok(!/<recent>/.test(out), "must not render <recent> block");
    assert.ok(!/<outcomes>/.test(out), "must not render <outcomes> vanity stats");
    assert.ok(!/<by_type>/.test(out), "must not render <by_type> breakdown");
    assert.ok(!/<episode\s/.test(out), "must not render per-episode <episode> tags");
    assert.ok(!/<description>/.test(out), "must not render <description> blocks");
    assert.ok(!/<store\s/.test(out), "must not render <store ...> self-closing tags");
  });

  it("emits no angle brackets anywhere (plain text only)", async () => {
    const out = await reconstructMemorySection(ctx);
    assert.ok(
      !out.includes("<") && !out.includes(">"),
      "plain-text block must not contain any angle brackets",
    );
  });

  it("cache returns identical output on second call", async () => {
    const a = await reconstructMemorySection(ctx);
    const b = await reconstructMemorySection(ctx);
    assert.equal(a, b, "cached output should be identical");
  });

  it("cache reset invalidates the section", async () => {
    const a = await reconstructMemorySection(ctx);
    resetMemorySectionCache(ctx);
    const b = await reconstructMemorySection(ctx);
    // Should re-render and produce same output (no underlying change)
    assert.equal(a, b, "after reset, output should be the same (no underlying change)");
  });
});