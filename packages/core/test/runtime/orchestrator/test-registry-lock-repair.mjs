/**
 * Test: a worker's declared files become lock rows however it was admitted,
 * and verify-and-merge resolves its branch without depending on those rows.
 *
 * Pins three repairs in the orchestrator registry path:
 * 1. `register-worker` books the files it is given as lock rows at the same
 *    project key spawn-worker uses, so an entry admits nothing unprotected.
 * 2. `update-worker` books the rows an already-registered entry lacks (the
 *    repair path) and never drops rows it already holds.
 * 3. `verify-and-merge` resolves the worker branch from the explicit argument,
 *    the registry entry, or the lock rows — locks are conflict prevention, not
 *    the statement of which branch to merge — and blocks only when none of the
 *    three yields a branch, naming what is missing.
 *
 * Every merge expectation is asserted on git after the call, never on text
 * alone; the honesty invariant itself lives in test-verify-merge-honest.mjs,
 * which stays green.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports
 * (os.homedir() reads $HOME on POSIX), so the real ~/.pi/agent is untouched.
 *
 * Run: node test/runtime/orchestrator/test-registry-lock-repair.mjs (after npm run build)
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "registry-lock-repair-"));
process.env.HOME = FAKE_HOME;

const { acquireLock, getAllLocks, readWorkers } = await import(
  "../../../dist/lib/orchestrator/index.js"
);
const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);

const WORKER = "worker/w1/repair";

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

// ── git fixtures ────────────────────────────────────────────────────────────

function gitIn(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}
function gitOk(repo, ...args) {
  try {
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const branchExistsIn = (repo, branch) => gitIn(repo, "branch", "--list", branch).length > 0;
const isAncestorIn = (repo, a, b) => gitOk(repo, "merge-base", "--is-ancestor", a, b);

/** Fresh repo on `main` with one base commit. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "registry-lock-repo-"));
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.email", "test@example.com");
  gitIn(repo, "config", "user.name", "test");
  gitIn(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "base.txt"), "base\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return repo;
}

/** Commit the worker's work on its branch and leave HEAD on that branch. */
function workerCommit(repo, { file = "work.txt", content = "worker\n" } = {}) {
  gitIn(repo, "checkout", "-q", "-b", WORKER);
  writeFileSync(join(repo, file), content);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "worker work");
  return gitIn(repo, "rev-parse", "HEAD");
}

// ── the tool, driven through the real registered definition ─────────────────

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

const SUCCESS_RE = /\bmerged successfully\b|\bmerged into\b/i;

console.log("registry lock repair test\n");

// ── T1: register-worker books the files it is given ─────────────────────────

await testAsync("T1 register-worker with files writes the entry and its lock rows", async () => {
  const repo = makeRepo();
  const file = join(repo, "work.txt");
  const out = join(repo, "out.md");

  const result = JSON.parse(
    toolText(
      await runTool({
        action: "register-worker",
        workerId: "rw1",
        spec: "impl",
        cwd: repo,
        files: [file],
        branch: WORKER,
        outputFile: out,
      }),
    ),
  );
  assert.equal(result.ok, true, "registration was admitted");
  assert.deepEqual(result.entry.files, [file], "the entry records the files");
  assert.equal(result.entry.branch, WORKER, "the entry records the branch");

  const locks = getAllLocks(repo);
  assert.ok(locks[file], "register-worker booked the file lock");
  assert.equal(locks[file].workerId, "rw1");
  assert.equal(locks[file].branch, WORKER, "the lock row carries the branch");
});

// ── T2: an entry admitted without files is repairable by update-worker ───────

await testAsync("T2 update-worker books the rows a lockless entry lacks", async () => {
  const repo = makeRepo();
  const file = join(repo, "work.txt");
  const out = join(repo, "out.md");

  await runTool({
    action: "register-worker",
    workerId: "uw2",
    spec: "impl",
    cwd: repo,
    outputFile: out,
  });
  assert.deepEqual(getAllLocks(repo), {}, "precondition: the entry holds no rows");

  const text = toolText(
    await runTool({
      action: "update-worker",
      workerId: "uw2",
      cwd: repo,
      branch: WORKER,
      files: [file],
    }),
  );
  assert.match(text, /updated/);
  assert.match(text, /Locks booked/, "the update reports the repair");

  const entry = readWorkers(repo).workers.uw2;
  assert.equal(entry.branch, WORKER, "branch patch persisted");
  assert.deepEqual(entry.files, [file], "files patch persisted");

  const locks = getAllLocks(repo);
  assert.ok(locks[file], "update-worker booked the missing row");
  assert.equal(locks[file].workerId, "uw2");
  assert.equal(locks[file].branch, WORKER);

  const view = toolText(await runTool({ action: "list-workers", cwd: repo }));
  assert.match(view, /uw2/, "the repaired worker is listed");
  assert.match(view, new RegExp(`branch=${WORKER}`), "list-workers shows the branch");
});

// ── T3: updating a worker must not silently drop rows it already holds ──────

await testAsync("T3 update-worker keeps existing rows when files are patched", async () => {
  const repo = makeRepo();
  const fileA = join(repo, "a.txt");
  const fileB = join(repo, "b.txt");
  const out = join(repo, "out.md");

  await runTool({
    action: "register-worker",
    workerId: "up3",
    spec: "impl",
    cwd: repo,
    files: [fileA],
    branch: WORKER,
    outputFile: out,
  });
  assert.ok(getAllLocks(repo)[fileA], "precondition: fileA is held");

  await runTool({
    action: "update-worker",
    workerId: "up3",
    cwd: repo,
    branch: WORKER,
    files: [fileB],
  });

  const locks = getAllLocks(repo);
  assert.ok(locks[fileA], "the pre-existing row was not dropped");
  assert.ok(locks[fileB], "the newly declared file was booked");
  assert.deepEqual(readWorkers(repo).workers.up3.files, [fileB]);
});

// ── T4: verify-and-merge with an explicit branch, lockless worker ───────────

await testAsync("T4 explicit branch merges a worker with no locks and no entry", async () => {
  const repo = makeRepo();
  const tip = workerCommit(repo);
  gitIn(repo, "checkout", "-q", "main");
  assert.deepEqual(getAllLocks(repo), {}, "precondition: no lock rows");
  assert.equal(readWorkers(repo).workers.vl4, undefined, "precondition: no entry");

  const head = gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const text = toolText(
    await runTool({ action: "verify-and-merge", workerId: "vl4", branch: WORKER, cwd: repo }),
  );

  assert.equal(
    gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD"),
    head,
    "the tool moved the worktree's HEAD",
  );
  assert.ok(SUCCESS_RE.test(text), `the merge must be reported\n${text}`);
  assert.ok(isAncestorIn(repo, tip, "main"), `main must contain the tip\n${text}`);
  assert.equal(gitIn(repo, "rev-parse", "main"), tip, "main fast-forwarded to the tip");
});

// ── T4b: the lock check is behind it even when the merge cannot proceed ─────

await testAsync("T4b a lockless diverged branch is refused on divergence, not on locks", async () => {
  const repo = makeRepo();
  const tip = workerCommit(repo);
  gitIn(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "main-advance.txt"), "advance\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "advance main");
  gitIn(repo, "checkout", "-q", WORKER); // HEAD on the worker branch, main diverged
  assert.deepEqual(getAllLocks(repo), {}, "precondition: no lock rows");

  const mainBefore = gitIn(repo, "rev-parse", "main");
  const text = toolText(
    await runTool({ action: "verify-and-merge", workerId: "dl4", branch: WORKER, cwd: repo }),
  );

  assert.match(text, /diverged/i, `the decision reached the merge logic\n${text}`);
  assert.doesNotMatch(text, /no locks/i, `the lock check no longer gates the merge\n${text}`);
  assert.equal(gitIn(repo, "rev-parse", "main"), mainBefore, "main must not move");
  assert.ok(branchExistsIn(repo, WORKER), "the worker branch must be kept");
  assert.ok(isAncestorIn(repo, tip, WORKER), "the worker tip is untouched");
});

// ── T5: the branch resolves from the registry entry ─────────────────────────

await testAsync("T5 the entry's branch is enough when no branch argument is given", async () => {
  const repo = makeRepo();
  const tip = workerCommit(repo);
  gitIn(repo, "checkout", "-q", "main");
  await runTool({
    action: "register-worker",
    workerId: "en5",
    spec: "impl",
    cwd: repo,
    branch: WORKER,
    outputFile: join(repo, "out.md"),
  }); // branch on the entry, no files, so no lock rows

  const text = toolText(
    await runTool({ action: "verify-and-merge", workerId: "en5", cwd: repo }),
  );

  assert.ok(SUCCESS_RE.test(text), `the entry branch must be merged\n${text}`);
  assert.equal(gitIn(repo, "rev-parse", "main"), tip, "main fast-forwarded to the tip");
});

// ── T6: the branch resolves from the lock rows ──────────────────────────────

await testAsync("T6 the lock row's branch is enough when no branch argument is given", async () => {
  const repo = makeRepo();
  const tip = workerCommit(repo);
  gitIn(repo, "checkout", "-q", "main");
  assert.equal(acquireLock([join(repo, "work.txt")], "lr6", WORKER, repo), true, "fixture lock");

  const text = toolText(
    await runTool({ action: "verify-and-merge", workerId: "lr6", cwd: repo }),
  );

  assert.ok(SUCCESS_RE.test(text), `the lock-row branch must be merged\n${text}`);
  assert.equal(gitIn(repo, "rev-parse", "main"), tip, "main fast-forwarded to the tip");
  assert.ok(branchExistsIn(repo, "main"), "main survived the merge");
});

// ── T7: no branch anywhere still blocks, and says what is missing ───────────

await testAsync("T7 no branch from any source blocks with a precise message", async () => {
  const repo = makeRepo();
  const text = toolText(
    await runTool({ action: "verify-and-merge", workerId: "ghost7", cwd: repo }),
  );
  assert.match(text, /no branch to verify/i, "the block names the missing branch source");
  assert.match(text, /branch argument/i);
  assert.match(text, /registry entry/i);
  assert.match(text, /lock rows/i);
  assert.ok(!SUCCESS_RE.test(text), "nothing was claimed merged");
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
