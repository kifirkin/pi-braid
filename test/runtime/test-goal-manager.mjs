/**
 * Test: GoalManager — goal lifecycle, decomposition, and persistence.
 *
 * Runtime tests importing from dist/lib/goal-manager.js.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { GoalManager } = await import("../../dist/lib/goal-manager.js");

describe("GoalManager", () => {
  let gm;

  beforeEach(() => {
    gm = new GoalManager();
  });

  it("starts with no goals", () => {
    assert.equal(gm.list().length, 0);
  });

  it("adds a goal with description and success criteria", () => {
    const goal = gm.addGoal("Fix the bug", ["tests pass", "code deployed"]);
    assert.ok(goal.id);
    assert.equal(goal.description, "Fix the bug");
    assert.deepEqual(goal.successCriteria, ["tests pass", "code deployed"]);
    assert.equal(goal.status, "pending");
  });

  it("lists all goals", () => {
    gm.addGoal("Goal 1", ["done"]);
    gm.addGoal("Goal 2", ["done"]);
    assert.equal(gm.list().length, 2);
  });

  it("gets goal by id via getById", () => {
    const goal = gm.addGoal("Test goal", ["done"]);
    const found = gm.getById(goal.id);
    assert.ok(found);
    assert.equal(found.description, "Test goal");
  });

  it("gets goal by id via get()", () => {
    const goal = gm.addGoal("Alias test", ["done"]);
    const found = gm.get(goal.id);
    assert.ok(found);
    assert.equal(found.description, "Alias test");
  });

  it("activates a goal", () => {
    const goal = gm.addGoal("Active goal", ["done"]);
    const activated = gm.activateGoal(goal.id);
    assert.ok(activated);
    assert.equal(gm.getActiveGoal()?.id, goal.id);
  });

  it("marks a goal completed", () => {
    const goal = gm.addGoal("Finish task", ["complete"]);
    const completed = gm.markCompleted(goal.id);
    assert.ok(completed);
    assert.equal(gm.getById(goal.id).status, "completed");
  });

  it("marks a goal failed — error stored in metadata", () => {
    const goal = gm.addGoal("Impossible task", ["done"]);
    const result = gm.markFailed(goal.id, "ran out of time");
    assert.ok(result);
    const found = gm.getById(goal.id);
    assert.equal(found.status, "failed");
    assert.equal(found.metadata?.error, "ran out of time");
  });

  it("marks a goal blocked — reason in blockers array", () => {
    const goal = gm.addGoal("Dependent goal", ["done"]);
    const result = gm.markBlocked(goal.id, "Waiting for API key");
    assert.ok(result);
    const found = gm.getById(goal.id);
    assert.equal(found.status, "blocked");
    assert.ok(found.blockers.includes("Waiting for API key"));
  });

  it("sets and gets original request", () => {
    gm.setOriginalRequest("Build a web app");
    assert.equal(gm.getOriginalRequest(), "Build a web app");
  });

  it("decomposes a goal into subgoals", () => {
    const parent = gm.addGoal("Ship feature", ["launched"]);
    gm.decompose(parent.id, [
      { description: "Build backend", successCriteria: ["API works"] },
      { description: "Build frontend", successCriteria: ["UI renders"] },
    ]);
    const updated = gm.getById(parent.id);
    assert.ok(updated, "parent goal retrievable after decompose");
    assert.equal(updated.subgoals.length, 2, "two subgoal ids added");
    // Subgoal IDs reference actual Goal objects in the manager
    const sub1 = gm.getById(updated.subgoals[0]);
    const sub2 = gm.getById(updated.subgoals[1]);
    assert.ok(sub1, "first subgoal exists");
    assert.ok(sub2, "second subgoal exists");
    assert.equal(sub1.description, "Build backend");
    assert.equal(sub2.description, "Build frontend");
  });

  it("lists goals filtered by status", () => {
    gm.addGoal("Pending", ["done"]);
    const active = gm.addGoal("Active", ["done"]);
    gm.activateGoal(active.id);
    const completed = gm.addGoal("Done", ["done"]);
    gm.markCompleted(completed.id);

    assert.equal(gm.list("pending").length, 1);
    assert.equal(gm.list("active").length, 1);
    assert.equal(gm.list("completed").length, 1);
  });

  it("returns null/undefined for nonexistent goal ids", () => {
    assert.equal(gm.getById("nonexistent"), undefined);
    assert.equal(gm.get("nonexistent"), undefined);
    assert.equal(gm.markCompleted("nonexistent"), null);
    assert.equal(gm.markFailed("nonexistent", "reason"), null);
    assert.equal(gm.activateGoal("nonexistent"), null);
  });

  it("clears all goals", () => {
    gm.addGoal("A", ["done"]);
    gm.addGoal("B", ["done"]);
    assert.equal(gm.list().length, 2);
    gm.clear();
    assert.equal(gm.list().length, 0);
  });

  it("provides stats", () => {
    const g1 = gm.addGoal("One", ["done"]);
    gm.addGoal("Two", ["done"]);
    gm.markCompleted(g1.id);
    const stats = gm.getStats();
    assert.ok(stats.total >= 2);
    assert.ok(stats.completed >= 1);
  });

  it("records evidence on a goal", () => {
    const goal = gm.addGoal("Research", ["found"]);
    const withEv = gm.recordEvidence(goal.id, "Found relevant paper");
    assert.ok(withEv);
    const found = gm.getById(goal.id);
    assert.ok(found.evidenceCollected.length >= 1);
  });

  it("returns undefined for getCurrentGoal when none active", () => {
    assert.equal(gm.getCurrentGoal(), undefined);
  });
});
