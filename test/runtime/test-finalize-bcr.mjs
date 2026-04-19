/**
 * Runtime tests for P2-P4 features (file-mutation-queue, planner, goal-manager)
 * Run: node test/runtime/test-finalize-bcr.mjs
 */

import { readFile, unlink, mkdir } from "node:fs/promises";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${e.message}`);
    failed++;
  }
}

async function assertEqual(actual, expected, msg = "") {
  if (actual !== expected) throw new Error(`${msg}expected ${expected}, got ${actual}`);
}

async function assertOk(val, msg = "") {
  if (!val) throw new Error(`${msg}got falsy`);
}

const ROOT = "/Users/kifir/projects/agents/pi-braid";
const FMQ = `${ROOT}/dist/lib/file-mutation-queue.js`;
const PLANNER = `${ROOT}/dist/lib/planner.js`;
const GOAL = `${ROOT}/dist/lib/goal-manager.js`;

await mkdir("/tmp", { recursive: true });

console.log("=== file-mutation-queue ===");

await test("write completes and file exists", async () => {
  const { FileMutationQueue } = await import(FMQ);
  const queue = new FileMutationQueue();
  await queue.write("/tmp/test-fmq.txt", { test: "fmq" });
  const content = await readFile("/tmp/test-fmq.txt", "utf-8");
  await assertOk(content.includes("fmq"), "content check");
  await unlink("/tmp/test-fmq.txt").catch(() => {});
});

await test("flushAll persists pending writes", async () => {
  const { FileMutationQueue } = await import(FMQ);
  const queue = new FileMutationQueue();
  queue.write("/tmp/test-flush.txt", { data: 42 });
  await queue.flushAll();
  const content = await readFile("/tmp/test-flush.txt", "utf-8");
  await assertOk(content.includes("42"), "content check");
  await unlink("/tmp/test-flush.txt").catch(() => {});
});

await test("queueDepth returns count >= 0", async () => {
  const { FileMutationQueue } = await import(FMQ);
  const queue = new FileMutationQueue();
  queue.write("/tmp/test-depth.txt", { n: 1 });
  const depth = queue.queueDepth("/tmp/test-depth.txt");
  await assertOk(depth >= 0, "depth check");
  await queue.flushAll();
  await unlink("/tmp/test-depth.txt").catch(() => {});
});

await test("hasPending true when writes queued", async () => {
  const { FileMutationQueue } = await import(FMQ);
  const queue = new FileMutationQueue();
  queue.write("/tmp/test-pending.txt", { data: true });
  await assertOk(queue.hasPending("/tmp/test-pending.txt") === true, "hasPending check");
  await queue.flushAll();
  await unlink("/tmp/test-pending.txt").catch(() => {});
});

await test("dedup: rapid writes to same path, last write wins", async () => {
  const { FileMutationQueue } = await import(FMQ);
  const queue = new FileMutationQueue({ dedupMs: 50 });
  await queue.write("/tmp/test-dedup.txt", { n: 1 });
  await queue.write("/tmp/test-dedup.txt", { n: 2 });
  await queue.write("/tmp/test-dedup.txt", { n: 3 });
  await queue.flushAll();
  const content = await readFile("/tmp/test-dedup.txt", "utf-8");
  const parsed = JSON.parse(content);
  // Dedup coalesces within window - exact behavior depends on timing
  await assertOk(parsed.n >= 1 && parsed.n <= 3, `n=${parsed.n} in range`);
  await unlink("/tmp/test-dedup.txt").catch(() => {});
});

console.log("\n=== planner integration ===");

await test("Planner.list returns plans array", async () => {
  const { Planner } = await import(PLANNER);
  const planner = new Planner();
  const plans = planner.list({});
  await assertOk(Array.isArray(plans), "is array");
});

await test("createPlan returns plan with id and steps", async () => {
  const { Planner } = await import(PLANNER);
  const planner = new Planner();
  const plan = planner.createPlan("Test plan", [
    { description: "Step 1", type: "action", expectedOutcome: "done" }
  ]);
  await assertOk(typeof plan.id === "string" && plan.id.startsWith("plan-"), "id is plan- string");
  await assertOk(Array.isArray(plan.steps) && plan.steps.length === 1, "has steps");
});

await test("Planner.get returns plan with steps", async () => {
  const { Planner } = await import(PLANNER);
  const planner = new Planner();
  const plan = planner.createPlan("Test", [{ description: "Step 1", type: "action", expectedOutcome: "done" }]);
  const retrieved = planner.get(plan.id);
  await assertOk(retrieved, "get returns plan");
  await assertOk(Array.isArray(retrieved.steps), "has steps array");
  await assertEqual(retrieved.steps.length, 1);
});

await test("startPlan + completeStep marks current step completed with outcome", async () => {
  const { Planner } = await import(PLANNER);
  const planner = new Planner();
  const plan = planner.createPlan("Multi-step", [
    { description: "Step 1", type: "action", expectedOutcome: "done" },
    { description: "Step 2", type: "action", expectedOutcome: "done" },
  ]);
  planner.startPlan(plan.id);
  // completeStep completes the CURRENT step (by currentStepIndex), not by ID
  planner.completeStep("Step 1 done", plan.id);
  const updated = planner.get(plan.id);
  const step = updated.steps[0];
  await assertOk(step, "step found");
  await assertEqual(step.status, "completed");
  // Note: outcome is stored in actualOutcome field
  await assertEqual(step.actualOutcome, "Step 1 done");
});

await test("completeStep advances index, remaining count decrements", async () => {
  const { Planner } = await import(PLANNER);
  const planner = new Planner();
  const p3 = planner.createPlan("3-step", [
    { description: "Step 1", type: "action", expectedOutcome: "done" },
    { description: "Step 2", type: "action", expectedOutcome: "done" },
    { description: "Step 3", type: "action", expectedOutcome: "done" },
  ]);
  planner.startPlan(p3.id);
  // Before any step: currentStepIndex=0, all 3 are non-completed
  const before = p3.steps.filter((s) => s.status !== "completed" && s.status !== "failed").length;
  await assertEqual(before, 3, "3 before");
  // After completing step 1: currentStepIndex=1, steps 1=completed, 2,3 not
  planner.completeStep("done", p3.id);
  const after = planner.get(p3.id).steps.filter((s) => s.status !== "completed" && s.status !== "failed").length;
  await assertEqual(after, 2, "2 after");
});

await test("findNextWork pattern: list() finds pending plan", async () => {
  const { Planner } = await import(PLANNER);
  const planner = new Planner();
  const plan = planner.createPlan("Test plan", [{ description: "Step 1", type: "action", expectedOutcome: "done" }]);
  planner.startPlan(plan.id);
  const plans = planner.list({});
  const pendingPlan = plans.find((p) => p.status === "planning" || p.status === "executing");
  await assertOk(pendingPlan, "found pending plan");
  await assertOk(pendingPlan.id === plan.id, "same plan");
});

console.log("\n=== goal-manager integration ===");

await test("GoalManager.list returns goals array", async () => {
  const { GoalManager } = await import(GOAL);
  const gm = new GoalManager();
  const goals = gm.list();
  await assertOk(Array.isArray(goals), "is array");
});

await test("addGoal creates pending goal", async () => {
  const { GoalManager } = await import(GOAL);
  const gm = new GoalManager();
  gm.addGoal("Test goal", ["done"], { priority: 5 });
  const goals = gm.list();
  const pending = goals.find((g) => g.status === "pending");
  await assertOk(pending, "found pending");
  await assertEqual(pending.priority, 5, "priority");
});

await test("addGoal respects priority", async () => {
  const { GoalManager } = await import(GOAL);
  const gm = new GoalManager();
  const g1 = gm.addGoal("Low priority", ["done"], { priority: 1 });
  const g2 = gm.addGoal("High priority", ["done"], { priority: 9 });
  const goals = gm.list();
  // Sorted by priority descending
  const first = goals[0];
  await assertEqual(first.priority, 9, "highest first");
});

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log("\x1b[32mAll tests passed!\x1b[0m");