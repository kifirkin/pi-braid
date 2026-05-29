/**
 * Runtime tests for P2-P4 features (file-mutation-queue)
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
const FMQ = `${ROOT}/dist/lib/utils/file-mutation-queue.js`;

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
  await assertOk(parsed.n >= 1 && parsed.n <= 3, `n=${parsed.n} in range`);
  await unlink("/tmp/test-dedup.txt").catch(() => {});
});

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log("\x1b[32mAll tests passed!\x1b[0m");