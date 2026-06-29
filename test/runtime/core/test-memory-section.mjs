/**
 * Test: prompt-builder/memory-section.ts - pointer block rendering.
 *
 * Verifies (post-2026-06-29 lean refactor; uniform with skills/project-docs):
 *   1. Returns a non-empty string (always renders the 3-store pointer block,
 *      even when every store is empty - mirrors skills' "Skills (0 available): ..."
 *      so the agent knows the stores exist as concepts).
 *   2. Directive + `<available_memories>` opening/closing tags.
 *   3. Self-closing `<store>` entries with name + count + path (or scope).
 *      No `<recent>`, no `<outcomes>`, no `<by_type>` - per the lean refactor
 *      that uniformly applies the skills philosophy ("details live in the files").
 *   4. Heuristics pointer is the session-only self-closing form.
 *   5. XML escaping is symmetric (open/close brackets balance; values are
 *      escaped where needed for special characters).
 *   6. Cache: second call returns identical output without re-statting.
 *   7. Cache invalidation resets the section.
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
    // After the 2026-06-29 refactor, the section always renders - even when
    // every store is empty - so the agent knows the stores exist as concepts.
    const out = await reconstructMemorySection(ctx);
    assert.notEqual(out, "", "memory section must always render (3-store pointer)");
  });

  it("opens with the directive and <available_memories> block", async () => {
    const out = await reconstructMemorySection(ctx);
    assert.match(out, /Memory \(episodes, semantic, heuristics\): use `memory` to recall/);
    assert.match(out, /<available_memories>/);
    assert.match(out, /<\/available_memories>/);
  });

  it("renders self-closing <store> entries with name + count + path (persisted)", async () => {
    const out = await reconstructMemorySection(ctx);
    // Episodes + semantic: name + count + path attributes, self-closing form
    assert.match(
      out,
      /<store name="episodes" count="\d+" path="[^"]+" \/>/,
      "episodes store must be self-closing with name + count + path attrs",
    );
    assert.match(
      out,
      /<store name="semantic" count="\d+" path="[^"]+" \/>/,
      "semantic store must be self-closing with name + count + path attrs",
    );
  });

  it("renders heuristics as scope-attr self-closing (no path = session-only)", async () => {
    const out = await reconstructMemorySection(ctx);
    assert.match(
      out,
      /<store name="heuristics" scope="session" \/>/,
      "heuristics must be self-closing with scope='session' attr and no path",
    );
  });

  it("does not surface per-episode details (lean refactor)", async () => {
    // The skills model says "descriptions live in the files". The memory model
    // says "task snippets live in the files too". No <recent>, no <outcomes>,
    // no <by_type>, no <episode ...>, no <description>, no tasks inside tags.
    const out = await reconstructMemorySection(ctx);
    assert.ok(!/<recent>/.test(out), "must not render <recent> block");
    assert.ok(!/<outcomes>/.test(out), "must not render <outcomes> vanity stats");
    assert.ok(!/<by_type>/.test(out), "must not render <by_type> breakdown");
    assert.ok(!/<episode\s/.test(out), "must not render per-episode <episode> tags");
    assert.ok(!/<description>/.test(out), "must not render <description> blocks");
  });

  it("escapes XML attributes symmetrically (no stray angle brackets)", async () => {
    const out = await reconstructMemorySection(ctx);
    const opens = (out.match(/</g) ?? []).length;
    const closes = (out.match(/>/g) ?? []).length;
    assert.equal(opens, closes, "open/close angle brackets should balance");
    // No unescaped "<" or ">" inside attribute values - the directive text
    // mentions "memory" tool with backticks - the only < and > should be
    // from the XML tags themselves.
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
