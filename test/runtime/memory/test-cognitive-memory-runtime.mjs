/**
 * Test: CognitiveMemory — in-memory store, recall, search, and lifecycle.
 *
 * Uses highly differentiated content to avoid Jaccard-similarity dedup.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { CognitiveMemory } = await import(
  "../../../dist/lib/memory/index.js"
);

function uid() {
  return Math.random().toString(36).slice(2, 12);
}

describe("CognitiveMemory", () => {
  let cm;

  beforeEach(() => {
    cm = new CognitiveMemory();
  });

  it("starts with empty memory", () => {
    assert.equal(cm.getAll().length, 0);
  });

  it("stores and retrieves an entry", async () => {
    const content = `fZxQbWmKpLvN ${uid()}`;
    const entry = await cm.store(content, "insight", {
      tags: ["research"],
      importance: 0.9,
    });
    assert.ok(entry.id);
    assert.equal(entry.content, content);
    assert.equal(entry.type, "insight");
    assert.equal(entry.importance, 0.9);
  });

  it("stores error and goal types unconditionally", async () => {
    const e = await cm.store(`err_${uid()}`, "error", { tags: ["e"] });
    assert.ok(e.id, "error stored");
    const g = await cm.store(`goal_${uid()}`, "goal", { tags: ["g"] });
    assert.ok(g.id, "goal stored");
  });

  it("stores multiple memory types with unique content", async () => {
    await cm.store(`insight_alpha_${uid()}`, "insight", { tags: ["a"] });
    await cm.store(`pattern_beta_${uid()}`, "pattern", { tags: ["b"] });
    await cm.store(`preference_gamma_${uid()}`, "preference", { tags: ["c"] });
    await cm.store(`episodic_delta_${uid()}`, "episodic", { tags: ["d"] });

    assert.equal(cm.getByType("insight").length, 1);
    assert.equal(cm.getByType("pattern").length, 1);
    assert.equal(cm.getByType("preference").length, 1);
    assert.equal(cm.getByType("episodic").length, 1);
  });

  it("searches by tags", async () => {
    await cm.store(`tagged_foo_${uid()}`, "semantic", { tags: ["foo", "bar"] });
    await cm.store(`tagged_baz_${uid()}`, "semantic", { tags: ["baz"] });
    assert.equal(cm.searchByTags(["foo"]).length, 1);
    assert.equal(cm.searchByTags(["baz"]).length, 1);
  });

  it("lists recent ordered by recency", async () => {
    await cm.store(`first_entry_${uid()}`, "insight", { tags: [] });
    await cm.store(`second_entry_${uid()}`, "insight", { tags: [] });
    await cm.store(`third_entry_${uid()}`, "insight", { tags: [] });
    const recent = cm.getRecent(2);
    assert.equal(recent.length, 2);
    assert.ok(recent[0].content.startsWith("third_entry"));
  });

  it("deletes a memory entry", async () => {
    const entry = await cm.store(`delete_me_${uid()}`, "insight", { tags: [] });
    assert.equal(cm.getAll().length, 1);
    assert.ok(await cm.delete(entry.id));
    assert.equal(cm.getAll().length, 0);
  });

  it("boosts importance", async () => {
    const entry = await cm.store(`boost_test_${uid()}`, "insight", {
      tags: [],
      importance: 0.5,
    });
    assert.ok(await cm.boost(entry.id, 0.3));
    const found = await cm.getById(entry.id);
    assert.ok(found.importance >= 0.5);
  });

  it("updates tags", async () => {
    const entry = await cm.store(`tag_update_${uid()}`, "insight", { tags: ["old"] });
    assert.ok(await cm.updateTags(entry.id, ["new", "updated"]));
    assert.deepEqual((await cm.getById(entry.id)).tags, ["new", "updated"]);
  });

  it("links two memories", async () => {
    const a = await cm.store(`factorySettings_${uid()}`, "insight", { tags: [] });
    const b = await cm.store(`grapefruitExplosion_${uid()}`, "insight", { tags: [] });
    assert.ok(await cm.link(a.id, b.id, "related"));
    const related = cm.getRelated(a.id, "related");
    assert.ok(related.length >= 1);
    assert.equal(related[0].id, b.id);
  });

  it("provides stats", async () => {
    await cm.store(`statisticalInsightRecord_${uid()}`, "insight", { tags: [], importance: 0.9 });
    await cm.store(`distinctPatternAnalysis_${uid()}`, "pattern", { tags: [], importance: 0.5 });
    const stats = cm.getStats();
    assert.ok(stats.total >= 2, `expected total>=2 got ${stats.total}`);
    assert.equal(stats.byType?.insight, 1);
    assert.equal(stats.byType?.pattern, 1);
  });

  it("clears all memories", async () => {
    await cm.store(`clear_test_${uid()}`, "insight", { tags: [] });
    assert.equal(cm.getAll().length, 1);
    cm.clear();
    assert.equal(cm.getAll().length, 0);
  });

  it("handles nonexistent ids gracefully", async () => {
    assert.equal(await cm.getById("__nonexistent__"), undefined);
    assert.equal(await cm.delete("__nonexistent__"), false);
    assert.equal(await cm.boost("__nonexistent__"), false);
    assert.equal(await cm.updateTags("__nonexistent__", ["x"]), false);
  });

  it("gives memory store access", () => {
    const store = cm.getMemoryStore();
    assert.ok(store);
    assert.equal(store.version, 1);
    assert.ok(Array.isArray(store.memories));
  });
});
