/**
 * Test: durable worker resume — a checkpoint plus a request id turn a crashed
 * worker's row into something the next parent can resume instead of guess at.
 *
 * Pins four properties of the registry's durability path:
 * 1. A `working` entry whose session has frozen (what a parent crash leaves
 *    behind) reports `resumable` when it carries a checkpoint, and the verdict
 *    names the phase, the last completed step, and the request id to resume
 *    under. The same frozen row without a checkpoint still reports `stalled`,
 *    so the checkpoint is what changes the verdict.
 * 2. Evidence of completion outranks the resume point: a frozen `working` row
 *    whose output file exists and whose session ends in a valid result block
 *    reports `completed`, not `resumable`.
 * 3. Re-issuing the admission — the retry a restarted parent makes — reuses the
 *    entry under the same request id: one row, one branch, the original
 *    spawnedAt, and a reuse report. A different request id, or the same id
 *    describing different files, is refused loudly and admits nothing.
 * 4. A row written before these fields existed (no requestId, no checkpoint)
 *    still reads: its verdict carries nulls, a new request cannot adopt it, and
 *    the entry keeps working exactly as it did.
 *
 * The crash is simulated the way one process can: the entry is written as
 * `working` with a session file frozen past the stall window, and every
 * assertion after that reads the registry the way a fresh parent would (a
 * fresh read from disk, no live status, no pane). Nothing here consults herdr.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports
 * (os.homedir() reads $HOME on POSIX), so the real ~/.pi/agent is untouched.
 *
 * Run: node test/runtime/orchestrator/test-durable-worker-resume.mjs (after npm run build)
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "durable-resume-"));
process.env.HOME = FAKE_HOME;

const { getWorkersFilePath } = await import("../../../dist/lib/config/braid-paths.js");
const { readWorkers, deriveRequestId, resolveRequestId } = await import(
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

// ── fixtures ────────────────────────────────────────────────────────────────

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

/** Fresh git repo on main with one base commit — one registry per repo path. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "durable-repo-"));
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.email", "test@example.com");
  gitIn(repo, "config", "user.name", "test");
  gitIn(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "base.txt"), "base\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return repo;
}

function branchNames(repo) {
  return gitIn(repo, "branch", "--list", "worker/*")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function workerIds(repo) {
  return Object.keys(readWorkers(repo).workers);
}

function assistantTurn(text) {
  return JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function resultBlock(fields) {
  return `\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``;
}

/** A session file whose mtime is two hours old: past the 600s stall window. */
function writeFrozenSession(repo, lines) {
  const session = join(repo, "session.jsonl");
  writeFileSync(session, `${lines.join("\n")}\n`, "utf-8");
  const frozen = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(session, frozen, frozen);
  return session;
}

/** Land one commit on a worker branch without leaving the repo on it. */
function commitOnBranch(repo, branch, file) {
  gitIn(repo, "checkout", "-q", branch);
  writeFileSync(join(repo, file), "work\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "work");
  gitIn(repo, "checkout", "-q", "main");
}

/**
 * A worker admitted, then crashed mid-flight: the row is `working` on disk,
 * the session is frozen past the stall window, and no pane is live. The
 * checkpoint is what a crashed worker leaves behind; without one the row has
 * no resume point at all.
 */
async function crashedWorker({ workerId = "wc", checkpoint = true } = {}) {
  const repo = makeRepo();
  const outputFile = join(repo, "report.md");
  const files = [join(repo, "a.ts")];
  await runTool({
    action: "spawn-worker",
    workerId,
    slug: "durable-resume",
    files,
    spec: "impl",
    outputFile,
    cwd: repo,
  });
  const session = writeFrozenSession(repo, [assistantTurn("working on the first file")]);
  const patch = {
    action: "update-worker",
    workerId,
    workerSession: session,
    status: "working",
    cwd: repo,
  };
  if (checkpoint) {
    patch.phase = "impl";
    patch.lastStep = "commit";
  }
  await runTool(patch);
  return { repo, workerId, files, outputFile, session, branch: `worker/${workerId}/durable-resume` };
}

console.log("durable worker resume test\n");

// ── request identity ────────────────────────────────────────────────────────

test("deriveRequestId composes the (workerId, step) key", () => {
  assert.equal(deriveRequestId("w7"), "w7:1", "first submission is step 1");
  assert.equal(deriveRequestId("w7", 2), "w7:2", "a later submission gets its own key");
  assert.equal(resolveRequestId("w7"), "w7:1", "no explicit id derives the first step");
  assert.equal(resolveRequestId("w7", "custom-key"), "custom-key");
  assert.equal(resolveRequestId("w7", "  "), "w7:1", "blank falls back to the derived key");
});

// ── the acceptance case: a crashed worker reads as resumable ───────────────

await testAsync("a crashed working entry with a checkpoint reports resumable", async () => {
  const { repo, workerId, session } = await crashedWorker();
  const before = readWorkers(repo).workers[workerId];
  assert.equal(before.status, "working", "crash leaves the stored status as it was");
  assert.equal(before.requestId, `${workerId}:1`, "admission recorded the derived request id");
  assert.equal(before.checkpoint.phase, "impl");
  assert.equal(before.checkpoint.step, "commit");
  assert.ok(!Number.isNaN(Date.parse(before.checkpoint.at)), "checkpoint carries a write time");
  assert.equal(before.workerSession, session);

  const verdict = await runTool({ action: "check-worker", workerId, cwd: repo });
  assert.equal(verdict.details.status, "resumable", "no live status, frozen session, checkpoint");
  assert.equal(verdict.details.requestId, `${workerId}:1`);
  assert.equal(verdict.details.checkpoint.step, "commit");
  assert.match(verdict.details.reason, /session frozen/);
  assert.match(verdict.details.reason, /resume from checkpoint impl\/commit/);
  assert.match(toolText(verdict), /status: resumable/);
  assert.match(toolText(verdict), /checkpoint: impl\/commit/);
  assert.match(toolText(verdict), new RegExp(`requestId: ${workerId}:1`));
  assert.doesNotMatch(toolText(verdict), /status: working/);

  const after = readWorkers(repo);
  assert.deepEqual(workerIds(repo), [workerId], "checking writes no second entry");
  assert.equal(after.workers[workerId].status, "working", "checking changes no stored status");
  assert.equal(after.workers[workerId].closedAt, null);
});

// ── resume: the retry reuses the entry instead of duplicating it ───────────

await testAsync("re-issuing the admission reuses the entry: no duplicate row or branch", async () => {
  const { repo, workerId, files, outputFile, branch } = await crashedWorker();
  const before = readWorkers(repo).workers[workerId];
  const verdict = await runTool({ action: "check-worker", workerId, cwd: repo });
  assert.equal(verdict.details.status, "resumable");

  // The retry a restarted parent makes: same worker, same work. Once without
  // naming the request id (derived), once with the id the verdict echoed.
  const derived = await runTool({
    action: "spawn-worker",
    workerId,
    slug: "durable-resume",
    files,
    spec: "impl",
    outputFile,
    cwd: repo,
  });
  assert.equal(derived.details.reused, true);
  assert.match(toolText(derived), new RegExp(`already admitted under requestId ${workerId}:1`));
  assert.match(toolText(derived), /no duplicate was created/);
  assert.match(toolText(derived), /Checkpoint: impl\/commit/);
  assert.match(toolText(derived), new RegExp(`Branch: ${branch} \\(existing\\)`));

  const echoed = await runTool({
    action: "spawn-worker",
    workerId,
    slug: "resume-again",
    files,
    spec: "impl",
    outputFile,
    cwd: repo,
    requestId: verdict.details.requestId,
  });
  assert.equal(echoed.details.reused, true);

  const after = readWorkers(repo).workers;
  assert.deepEqual(Object.keys(after), [workerId], "one row, not one per attempt");
  assert.equal(after[workerId].spawnedAt, before.spawnedAt, "the original admission stands");
  assert.equal(after[workerId].requestId, before.requestId);
  assert.equal(after[workerId].branch, branch);
  assert.equal(after[workerId].checkpoint.step, "commit", "reuse does not touch the checkpoint");
  assert.deepEqual(branchNames(repo), [branch], "no second branch, slug notwithstanding");
});

await testAsync("a different request id is refused loudly while the entry is live", async () => {
  const { repo, workerId, files, outputFile, branch } = await crashedWorker();
  await assert.rejects(
    () =>
      runTool({
        action: "spawn-worker",
        workerId,
        slug: "durable-resume",
        files,
        spec: "impl",
        outputFile,
        cwd: repo,
        requestId: `${workerId}:2`,
      }),
    /is a different request/,
  );
  assert.deepEqual(workerIds(repo), [workerId]);
  assert.deepEqual(branchNames(repo), [branch]);
});

await testAsync("the same request id describing different files is refused", async () => {
  const { repo, workerId, outputFile, branch } = await crashedWorker();
  await assert.rejects(
    () =>
      runTool({
        action: "spawn-worker",
        workerId,
        slug: "durable-resume",
        files: [join(repo, "other.ts")],
        spec: "impl",
        outputFile,
        cwd: repo,
      }),
    /describes different work/,
  );
  assert.deepEqual(workerIds(repo), [workerId]);
  assert.deepEqual(branchNames(repo), [branch]);
});

await testAsync("a spawn retry reuses an entry admitted through register-worker", async () => {
  const repo = makeRepo();
  const workerId = "wr";
  const files = [join(repo, "a.ts")];
  const outputFile = join(repo, "report.md");
  await runTool({
    action: "register-worker",
    workerId,
    spec: "impl",
    cwd: repo,
    files,
    branch: `worker/${workerId}/manual`,
    outputFile,
  });
  const before = readWorkers(repo).workers[workerId];
  assert.equal(before.requestId, `${workerId}:1`, "both admission paths record the same key");

  const retry = await runTool({
    action: "spawn-worker",
    workerId,
    slug: "durable-resume",
    files,
    spec: "impl",
    outputFile,
    cwd: repo,
  });
  assert.equal(retry.details.reused, true);
  assert.match(toolText(retry), new RegExp(`Branch: worker/${workerId}/manual \\(existing\\)`));
  assert.deepEqual(branchNames(repo), [], "a reuse takes no branch, not even under the new slug");
  assert.equal(
    readWorkers(repo).workers[workerId].spawnedAt,
    before.spawnedAt,
    "the entry admitted first stands",
  );
});

// ── what the checkpoint must not override ─────────────────────────────────

await testAsync("a frozen entry with no checkpoint still reports stalled", async () => {
  const { repo, workerId } = await crashedWorker({ workerId: "wn", checkpoint: false });
  const verdict = await runTool({ action: "check-worker", workerId, cwd: repo });
  assert.equal(verdict.details.status, "stalled", "no resume point, so no resume verdict");
  assert.equal(verdict.details.checkpoint, null);
  assert.match(verdict.details.reason, /session frozen for \d+s with no output/);
  assert.doesNotMatch(toolText(verdict), /resumable/);
});

await testAsync("evidence of completion outranks the checkpoint", async () => {
  const repo = makeRepo();
  const workerId = "wd";
  const outputFile = join(repo, "report.md");
  await runTool({
    action: "spawn-worker",
    workerId,
    slug: "durable-resume",
    files: [join(repo, "a.ts")],
    spec: "impl",
    outputFile,
    cwd: repo,
  });
  commitOnBranch(repo, `worker/${workerId}/durable-resume`, "a.ts");
  writeFileSync(outputFile, "delivered\n", "utf-8");
  const session = writeFrozenSession(repo, [
    assistantTurn(
      resultBlock({
        worker: workerId,
        spec: "impl",
        status: "completed",
        output_file: outputFile,
      }),
    ),
  ]);
  await runTool({
    action: "update-worker",
    workerId,
    workerSession: session,
    status: "working",
    phase: "impl",
    lastStep: "report",
    cwd: repo,
  });

  const verdict = await runTool({ action: "check-worker", workerId, cwd: repo });
  assert.equal(verdict.details.status, "completed", "output + schema + commit verify the work");
  assert.equal(verdict.details.checkpoint.step, "report", "the resume point is still reported");
});

// ── backward compatibility ────────────────────────────────────────────────

await testAsync("a row written before request ids reads and cannot be adopted", async () => {
  const repo = makeRepo();
  const workerId = "wl";
  const workersFile = getWorkersFilePath(repo);
  mkdirSync(dirname(workersFile), { recursive: true });
  writeFileSync(
    workersFile,
    JSON.stringify(
      {
        version: 1,
        workers: {
          [workerId]: {
            workerId,
            spec: "impl",
            status: "working",
            cwd: repo,
            pane: null,
            workspace: null,
            workerSession: null,
            outputFile: null,
            branch: `worker/${workerId}/legacy`,
            files: [],
            spawnedAt: new Date().toISOString(),
            lastSeenAt: null,
            resultAt: null,
            mergeSha: null,
            mergedAt: null,
            closedAt: null,
            gates: [],
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const verdict = await runTool({ action: "check-worker", workerId, cwd: repo });
  assert.equal(verdict.details.status, "working", "an unadopted legacy row keeps its reading");
  assert.equal(verdict.details.requestId, null);
  assert.equal(verdict.details.checkpoint, null);
  assert.match(toolText(verdict), /requestId: -/);
  assert.match(toolText(verdict), /checkpoint: -/);

  await assert.rejects(
    () =>
      runTool({
        action: "spawn-worker",
        workerId,
        slug: "legacy",
        files: [join(repo, "a.ts")],
        spec: "impl",
        outputFile: join(repo, "report.md"),
        cwd: repo,
      }),
    /no requestId recorded/,
  );
  assert.deepEqual(workerIds(repo), [workerId], "the legacy row is not silently adopted");
  const persisted = readWorkers(repo).workers[workerId];
  assert.equal(persisted.requestId, null, "an upgrade is not a migration");
  assert.equal(persisted.closedAt, null);
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
