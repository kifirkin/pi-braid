/**
 * Test: fleet statistics over the worker registry.
 *
 * Pins what a statistics read must do to be honest about its own evidence:
 *
 * 1. The pure summary states its sample. Spawn→result latency is computed only
 *    over rows that recorded a result time, so a worker still in flight cannot
 *    enter the median; the completion rate is over closed rows, and the
 *    latency carries the count it was taken over.
 * 2. The shapes are covered: an empty registry reports nulls rather than a
 *    confident zero, a single row reports its own value, and an even sample
 *    takes the mean of the middle pair.
 * 3. A row with no result time, or a malformed/backwards timestamp pair, is
 *    excluded from the latency rather than counted at its close.
 * 4. A duplicate admission is refused AND recorded: the refusal persists on the
 *    live row with the request id it turned away, so the fleet's refusal count
 *    is registry fact, not an inference.
 * 5. The ordinary `list-workers` output is unchanged; statistics appear only
 *    when a caller asks for them (includeStats), appended after the listing.
 *
 * The pure cases build the registry value directly, so the arithmetic is
 * checked against known timestamps rather than against the writer. The refusal
 * case drives the real tool, because recording is a write path.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports
 * (os.homedir() reads $HOME on POSIX), so the real ~/.pi/agent is untouched.
 *
 * Run: node test/runtime/orchestrator/test-worker-stats.mjs (after npm run build)
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "worker-stats-"));
process.env.HOME = FAKE_HOME;

const { computeWorkerStats, readWorkers } = await import(
  "../../../dist/lib/orchestrator/index.js"
);
const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);

let passed = 0;
let failed = 0;
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed++;
    console.log(`  [fail] ${name}: ${error.message}`);
  }
}
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed++;
    console.log(`  [fail] ${name}: ${error.message}`);
  }
}

// ── fixtures: a registry value with known timestamps ────────────────────────

// A fixed epoch, expressed as a number so no date literal sits in the source.
const T0 = Date.UTC(2026, 0, 1);
const iso = (ms) => new Date(ms).toISOString();

/** A complete-enough row: every field the registry writes, overridable. */
function row(overrides = {}) {
  return {
    workerId: "row",
    spec: "impl",
    status: "closed",
    cwd: "/tmp/project",
    pane: null,
    workspace: null,
    workerSession: null,
    outputFile: null,
    branch: null,
    files: [],
    spawnedAt: iso(T0),
    lastSeenAt: null,
    resultAt: null,
    mergeSha: null,
    mergedAt: null,
    closedAt: null,
    gates: [],
    admissionRefusals: [],
    requestId: "row:1",
    checkpoint: null,
    ...overrides,
  };
}

function registryOf(...entries) {
  const workers = {};
  for (const entry of entries) workers[entry.workerId] = entry;
  return { version: 1, workers };
}

/** A closed, completed row whose result landed `deltaMs` after its spawn. */
function completedRow(workerId, deltaMs, overrides = {}) {
  return row({
    workerId,
    status: "completed",
    spawnedAt: iso(T0),
    resultAt: iso(T0 + deltaMs),
    closedAt: iso(T0 + deltaMs + 1000),
    requestId: `${workerId}:1`,
    ...overrides,
  });
}

// ── the pure summary ────────────────────────────────────────────────────────

console.log("worker fleet statistics\n");

test("an empty registry states nulls, not a confident zero", () => {
  const stats = computeWorkerStats(registryOf());
  assert.equal(stats.total, 0);
  assert.equal(stats.live, 0);
  assert.equal(stats.closed, 0);
  assert.equal(stats.completed, 0);
  assert.equal(stats.completionRate, null, "no closed rows means no rate to state");
  assert.equal(stats.latency.sample, 0);
  assert.equal(stats.latency.medianMs, null);
  assert.equal(stats.latency.minMs, null);
  assert.equal(stats.latency.maxMs, null);
  assert.equal(stats.admissionRefusals, 0);
});

test("a single closed row reports its own value", () => {
  const stats = computeWorkerStats(registryOf(completedRow("solo", 5000)));
  assert.equal(stats.total, 1);
  assert.equal(stats.live, 0);
  assert.equal(stats.closed, 1);
  assert.equal(stats.completed, 1);
  assert.equal(stats.completionRate, 1);
  assert.equal(stats.latency.sample, 1);
  assert.equal(stats.latency.medianMs, 5000);
  assert.equal(stats.latency.minMs, 5000);
  assert.equal(stats.latency.maxMs, 5000);
});

test("known medians and a completion rate over the closed denominator", () => {
  const stats = computeWorkerStats(
    registryOf(
      completedRow("one", 1000),
      completedRow("two", 3000),
      completedRow("three", 2000),
      // Closed as an error: in the completion denominator, out of the latency.
      row({ workerId: "four", status: "error", closedAt: iso(T0 + 9000), requestId: "four:1" }),
      // In flight: no close, no result — neither denominator nor sample.
      row({ workerId: "five", status: "working", requestId: "five:1" }),
    ),
  );
  assert.equal(stats.total, 5);
  assert.equal(stats.live, 1, "one row has no close time");
  assert.equal(stats.closed, 4);
  assert.equal(stats.completed, 3);
  assert.equal(stats.completionRate, 0.75, "3 of 4 closed rows completed");
  assert.equal(stats.latency.sample, 3, "only rows with a result time are sampled");
  assert.equal(stats.latency.medianMs, 2000, "median of 1000, 3000, 2000");
  assert.equal(stats.latency.minMs, 1000);
  assert.equal(stats.latency.maxMs, 3000);
});

test("an even sample takes the mean of the middle pair", () => {
  const stats = computeWorkerStats(registryOf(completedRow("a", 1000), completedRow("b", 3000)));
  assert.equal(stats.latency.sample, 2);
  assert.equal(stats.latency.medianMs, 2000, "the middle pair averages to 2000");
});

test("a landed result counts before the row is closed; an in-flight row without one does not", () => {
  const stats = computeWorkerStats(
    registryOf(
      // Merged but not closed: the work landed (result time set), so its
      // latency is real even though the row still reads as live.
      row({
        workerId: "landed",
        status: "merged",
        resultAt: iso(T0 + 4000),
        mergedAt: iso(T0 + 4000),
        mergeSha: "abc1234",
        requestId: "landed:1",
      }),
      // Truly in flight: no result time, so no latency to contribute.
      row({ workerId: "running", status: "working", requestId: "running:1" }),
    ),
  );
  assert.equal(stats.live, 2, "neither row is closed");
  assert.equal(stats.closed, 0);
  assert.equal(stats.completionRate, null);
  assert.equal(stats.latency.sample, 1, "only the landed result is a delta");
  assert.equal(stats.latency.medianMs, 4000);
});

test("a missing, malformed, or backwards timestamp pair is no delta", () => {
  const stats = computeWorkerStats(
    registryOf(
      completedRow("good", 1000),
      // Closed completed but no result time recorded: excluded.
      row({ workerId: "noresult", status: "completed", closedAt: iso(T0 + 100), requestId: "noresult:1" }),
      // Result time that will not parse: excluded.
      row({
        workerId: "broken",
        status: "completed",
        resultAt: "not-a-time",
        closedAt: iso(T0 + 100),
        requestId: "broken:1",
      }),
      // Result before spawn (a clock/data anomaly): excluded, not clamped.
      row({
        workerId: "backwards",
        status: "completed",
        spawnedAt: iso(T0 + 5000),
        resultAt: iso(T0),
        closedAt: iso(T0 + 6000),
        requestId: "backwards:1",
      }),
    ),
  );
  assert.equal(stats.latency.sample, 1, "only the well-formed delta is sampled");
  assert.equal(stats.latency.medianMs, 1000);
});

test("duplicate refusals are summed from the rows that recorded them", () => {
  const stats = computeWorkerStats(
    registryOf(
      row({
        workerId: "busy",
        admissionRefusals: [
          { requestId: "busy:2", at: iso(T0 + 10) },
          { requestId: "busy:1", at: iso(T0 + 20) },
        ],
      }),
      row({ workerId: "quiet", admissionRefusals: [] }),
      // A legacy row with no field at all must not crash the sum.
      row({ workerId: "legacy", admissionRefusals: undefined }),
    ),
  );
  assert.equal(stats.admissionRefusals, 2, "sums every recorded refusal");
});

// ── the write path: a refusal is recorded, then counted ─────────────────────

const fakePi = {
  tools: [],
  registerTool(definition) {
    this.tools.push(definition);
  },
  on() {},
};
orchestratorExtension(fakePi);
const orchestrateTool = fakePi.tools.find((tool) => tool.name === "orchestrate");
const runTool = (params) =>
  orchestrateTool.execute("call-1", params, new AbortController().signal, undefined, undefined);
const toolText = (result) => result.content[0].text;

function gitIn(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "worker-stats-repo-"));
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.email", "test@example.com");
  gitIn(repo, "config", "user.name", "test");
  gitIn(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "base.txt"), "base\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return repo;
}

await testAsync("a refused duplicate spawn is recorded on the live row, then counted", async () => {
  const repo = makeRepo();
  const workerId = "stats1";
  const files = [join(repo, "a.ts")];
  const outputFile = join(repo, "report.md");
  await runTool({
    action: "spawn-worker",
    workerId,
    slug: "stats-fixture",
    files,
    spec: "impl",
    outputFile,
    cwd: repo,
  });
  const admitted = readWorkers(repo).workers[workerId];
  assert.deepEqual(admitted.admissionRefusals, [], "a fresh admission refused nothing");

  // A different request while the entry is live: refused, and the refusal is
  // the fact the fleet count needs.
  await assert.rejects(
    () =>
      runTool({
        action: "spawn-worker",
        workerId,
        slug: "stats-fixture",
        files,
        spec: "impl",
        outputFile,
        cwd: repo,
        requestId: `${workerId}:2`,
      }),
    /is a different request/,
  );
  const afterFirst = readWorkers(repo).workers[workerId];
  assert.equal(afterFirst.admissionRefusals.length, 1, "the refusal persisted");
  assert.equal(afterFirst.admissionRefusals[0].requestId, `${workerId}:2`);
  assert.ok(
    !Number.isNaN(Date.parse(afterFirst.admissionRefusals[0].at)),
    "the refusal carries a write time",
  );

  // The same request id describing different work is a second refusal.
  await assert.rejects(
    () =>
      runTool({
        action: "spawn-worker",
        workerId,
        slug: "stats-fixture",
        files: [join(repo, "other.ts")],
        spec: "impl",
        outputFile,
        cwd: repo,
      }),
    /describes different work/,
  );
  assert.equal(
    readWorkers(repo).workers[workerId].admissionRefusals.length,
    2,
    "a second refusal is recorded too",
  );
  assert.equal(
    computeWorkerStats(readWorkers(repo)).admissionRefusals,
    2,
    "the summary reads both refusals from the registry",
  );
});

await testAsync("list-workers is unchanged without the flag and appends stats with it", async () => {
  const repo = makeRepo();
  const workerId = "stats2";
  const files = [join(repo, "a.ts")];
  const outputFile = join(repo, "report.md");
  await runTool({
    action: "spawn-worker",
    workerId,
    slug: "stats-fixture",
    files,
    spec: "impl",
    outputFile,
    cwd: repo,
  });
  await assert.rejects(() =>
    runTool({
      action: "spawn-worker",
      workerId,
      slug: "stats-fixture",
      files,
      spec: "impl",
      outputFile,
      cwd: repo,
      requestId: `${workerId}:2`,
    }),
  );

  const plain = await runTool({ action: "list-workers", cwd: repo });
  assert.doesNotMatch(toolText(plain), /stats:/, "the ordinary listing carries no statistics");
  assert.equal(plain.details.stats, undefined, "and no stats details");
  assert.match(toolText(plain), /counts: total=1 live=1 closed=0/, "the counts line is intact");

  const withStats = await runTool({ action: "list-workers", cwd: repo, includeStats: true });
  assert.ok(
    toolText(withStats).startsWith(toolText(plain)),
    "the ordinary output is a byte-for-byte prefix; statistics are appended",
  );
  assert.match(toolText(withStats), /duplicate admissions refused: 1/);
  assert.match(toolText(withStats), /spawn->result: no result times recorded \(sample 0\)/);
  assert.equal(withStats.details.stats.admissionRefusals, 1, "the summary travels in details too");
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
