/**
 * Test: orchestrate action=verify-and-merge reports only merges it performed.
 *
 * Pins the invariant the false-success path this action shipped violated:
 * **the tool may claim a merge only when the base branch actually contains
 * the worker tip afterwards.** A `git merge` exit code is not evidence; the
 * base ref is. The test also pins the two honest non-merges (base already
 * contains the work; merge refused) and the deletion claim (`(deleted)` may
 * only be printed when the branch is gone).
 *
 * Reproduces the incident shape: the worktree HEAD is the worker branch, so a
 * `git merge --squash <its own branch>` answers `Already up to date.` with exit
 * 0 against an unmoved base. Every success expectation here is an assertion on
 * `git merge-base --is-ancestor <tip> <base>` after the call, never on the
 * response text alone.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports
 * (os.homedir() reads $HOME on POSIX), so the real ~/.pi/agent is untouched.
 *
 * Run: node test/runtime/orchestrator/test-verify-merge-honest.mjs (after npm run build)
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "verify-merge-honest-"));
process.env.HOME = FAKE_HOME;

const { acquireLock, getAllLocks } = await import("../../../dist/lib/orchestrator/index.js");
const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);

const WORKER = "worker/w1/honest";

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
  const repo = mkdtempSync(join(tmpdir(), "verify-merge-repo-"));
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

/** Advance a branch with a new commit, then return to the given branch. */
function advance(repo, branch, { file = "main-advance.txt", content = "advance\n", back = null } = {}) {
  gitIn(repo, "checkout", "-q", branch);
  writeFileSync(join(repo, file), content);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", `advance ${branch}`);
  if (back) gitIn(repo, "checkout", "-q", back);
  return gitIn(repo, "rev-parse", branch);
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

/** Lock one file for the worker so verify-and-merge finds it. */
function lockWorker(repo, workerId) {
  const locked = join(repo, "work.txt");
  const ok = acquireLock([locked], workerId, WORKER, repo);
  assert.equal(ok, true, "fixture must hold the worker lock");
  return locked;
}

/**
 * verify-and-merge must never move the shared worktree's HEAD: merging and
 * checkout are separate concerns, and other agents read this worktree.
 */
function assertHeadUnchanged(repo, before, label) {
  assert.equal(
    gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD"),
    before,
    `${label}: the tool moved the worktree's HEAD`,
  );
}

/**
 * The core invariant: a merge claim requires the worker tip to be reachable
 * from the base afterwards; a `(deleted)` claim requires the branch to be gone.
 */
function assertClaimsAreTrue(text, repo, tip, label) {
  if (SUCCESS_RE.test(text)) {
    assert.ok(
      isAncestorIn(repo, tip, "main"),
      `${label}: claimed a merge, but ${tip.slice(0, 8)} is not an ancestor of main\n${text}`,
    );
  }
  if (text.includes("(deleted)")) {
    assert.ok(
      !branchExistsIn(repo, WORKER),
      `${label}: claimed "Branch: ... (deleted)" but the branch still exists\n${text}`,
    );
  }
}

console.log("verify-and-merge honesty test\n");

// ── T1: the incident — HEAD is the worker branch, branch ahead of main ──────

await testAsync("T1 HEAD on the worker branch: no merge claim over an unmoved main", async () => {
  const repo = makeRepo();
  const tip = workerCommit(repo); // HEAD is now WORKER
  lockWorker(repo, "t1");
  const mainBefore = gitIn(repo, "rev-parse", "main");

  const head = gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const text = toolText(
    await runTool({ action: "verify-and-merge", workerId: "t1", branch: WORKER, cwd: repo }),
  );

  assertHeadUnchanged(repo, head, "T1");
  assertClaimsAreTrue(text, repo, tip, "T1");
  const mainAfter = gitIn(repo, "rev-parse", "main");
  assert.ok(
    mainAfter !== mainBefore || !SUCCESS_RE.test(text),
    `T1: main did not move but the response claimed a merge\n${text}`,
  );
  // The base moved, so the performed merge must be reported (not a refusal).
  assert.ok(SUCCESS_RE.test(text), `T1: a performed merge must be reported\n${text}`);
  assert.ok(isAncestorIn(repo, tip, "main"), `T1: main must contain the tip\n${text}`);
});

// ── T2: base already contains the work — no-op, said plainly ────────────────

await testAsync("T2 base already contains the tip: no-op, not 'merged successfully'", async () => {
  const repo = makeRepo();
  const tip = workerCommit(repo);
  gitIn(repo, "checkout", "-q", "main");
  gitIn(repo, "merge", "--ff-only", "-q", WORKER);
  gitIn(repo, "checkout", "-q", WORKER); // HEAD on the worker branch, tip in main
  lockWorker(repo, "t2");
  const mainBefore = gitIn(repo, "rev-parse", "main");

  const head = gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const text = toolText(
    await runTool({ action: "verify-and-merge", workerId: "t2", branch: WORKER, cwd: repo }),
  );

  assertHeadUnchanged(repo, head, "T2");
  assert.ok(!SUCCESS_RE.test(text), `T2: no-op must not claim a merge\n${text}`);
  assert.ok(
    /already|ancestor|nothing to merge|no changes/i.test(text),
    `T2: no-op must say the base already contains the branch\n${text}`,
  );
  assert.equal(gitIn(repo, "rev-parse", "main"), mainBefore, "T2: main must not move");
  assert.ok(isAncestorIn(repo, tip, "main"), "T2: tip must remain in main");
});

// ── T3: the honest positive path — base checked out, branch ahead ───────────

await testAsync("T3 base checked out, branch ahead: real merge, main moves to tip", async () => {
  const repo = makeRepo();
  const tip = workerCommit(repo);
  gitIn(repo, "checkout", "-q", "main");
  lockWorker(repo, "t3");

  const head = gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const text = toolText(
    await runTool({ action: "verify-and-merge", workerId: "t3", branch: WORKER, cwd: repo }),
  );

  assertHeadUnchanged(repo, head, "T3");
  assertClaimsAreTrue(text, repo, tip, "T3");
  assert.ok(SUCCESS_RE.test(text), `T3: a real merge must be reported\n${text}`);
  assert.ok(isAncestorIn(repo, tip, "main"), `T3: main must contain the tip\n${text}`);
  assert.equal(gitIn(repo, "rev-parse", "main"), tip, "T3: main must fast-forward to the tip");
});

// ── T4: diverged, base not checked out — refusal, not a fake merge ──────────

await testAsync("T4 diverged branch, base not checked out: honest refusal, base kept", async () => {
  const repo = makeRepo();
  const tip = workerCommit(repo);
  advance(repo, "main", { back: WORKER }); // main moved; HEAD stays on WORKER
  const locked = lockWorker(repo, "t4");
  const mainBefore = gitIn(repo, "rev-parse", "main");

  const head = gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const text = toolText(
    await runTool({ action: "verify-and-merge", workerId: "t4", branch: WORKER, cwd: repo }),
  );

  assertHeadUnchanged(repo, head, "T4");
  assertClaimsAreTrue(text, repo, tip, "T4");
  assert.ok(!SUCCESS_RE.test(text), `T4: a diverged branch must not be reported merged\n${text}`);
  assert.equal(gitIn(repo, "rev-parse", "main"), mainBefore, "T4: main must not move");
  assert.ok(branchExistsIn(repo, WORKER), "T4: the worker branch must be kept");
  assert.ok(getAllLocks(repo)[locked], "T4: the worker lock must be kept on failure");
});

// ── T5: conflict against the checked-out base — failure, nothing destroyed ──

await testAsync("T5 conflict on the checked-out base: failure, main and branch kept", async () => {
  const repo = makeRepo();
  gitIn(repo, "checkout", "-q", "-b", WORKER);
  writeFileSync(join(repo, "base.txt"), "worker edit\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "worker edit");
  const tip = gitIn(repo, "rev-parse", "HEAD");
  advance(repo, "main", { file: "base.txt", content: "main edit\n", back: "main" });
  const locked = lockWorker(repo, "t5");
  const mainBefore = gitIn(repo, "rev-parse", "main");

  const head = gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const text = toolText(
    await runTool({ action: "verify-and-merge", workerId: "t5", branch: WORKER, cwd: repo }),
  );

  assertHeadUnchanged(repo, head, "T5");
  assertClaimsAreTrue(text, repo, tip, "T5");
  assert.ok(!SUCCESS_RE.test(text), `T5: a conflict must not be reported as a merge\n${text}`);
  assert.equal(gitIn(repo, "rev-parse", "main"), mainBefore, "T5: main must not move");
  assert.ok(branchExistsIn(repo, WORKER), "T5: the worker branch must be kept");
  assert.ok(getAllLocks(repo)[locked], "T5: the worker lock must be kept");
});

// ── T6: explicit base — a baseBranch argument targets that ref, not HEAD ────

await testAsync("T6 explicit baseBranch: merges into the named base, not HEAD", async () => {
  const repo = makeRepo();
  gitIn(repo, "branch", "develop", "main"); // develop exists at the base commit
  const tip = workerCommit(repo); // HEAD on WORKER
  const locked = join(repo, "work.txt");
  assert.equal(acquireLock([locked], "t6", WORKER, repo), true);

  const head = gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const text = toolText(
    await runTool({
      action: "verify-and-merge",
      workerId: "t6",
      branch: WORKER,
      cwd: repo,
      baseBranch: "develop",
    }),
  );

  assertHeadUnchanged(repo, head, "T6");
  assert.ok(isAncestorIn(repo, tip, "develop"), `T6: develop must contain the tip\n${text}`);
  assert.ok(SUCCESS_RE.test(text), `T6: the performed merge must be reported\n${text}`);
  assert.ok(
    !isAncestorIn(repo, tip, "main"),
    `T6: main must be untouched when baseBranch=develop\n${text}`,
  );
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
