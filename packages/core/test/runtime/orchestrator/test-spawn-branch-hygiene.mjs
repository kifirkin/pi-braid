/**
 * Test: orchestrate spawn-worker leaves the caller's repository untouched.
 *
 * spawn-worker must create the worker branch, and it runs in the caller's own
 * worktree. Creating a branch is a ref operation; implementing it as a checkout
 * leaves the seat standing on the worker branch, so the seat's next commit
 * lands on the worker's work instead of on the branch it was on.
 *
 * Each test drives the real registered tool against a scratch repo and asserts
 * the ref is created while the caller's HEAD position and working set are
 * unchanged, across the states a caller can be found in:
 *   - the root is on main (the common case)
 *   - the root is on another branch, not main
 *   - the root is in detached HEAD
 *   - the base branch does not exist (creation falls back to HEAD)
 * The worker branch is also asserted to point at the tip the base had before,
 * so a fix that creates the ref at the wrong commit cannot pass by leaving HEAD
 * alone.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports
 * (os.homedir() reads $HOME on POSIX), so the real ~/.pi/agent is untouched.
 *
 * Run: node test/runtime/orchestrator/test-spawn-branch-hygiene.mjs (after npm run build)
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "spawn-branch-home-"));
process.env.HOME = FAKE_HOME;

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

// ── git fixtures ────────────────────────────────────────────────────────────

function gitIn(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}
function branchExistsIn(repo, branch) {
  return gitIn(repo, "branch", "--list", branch).length > 0;
}
/** "HEAD" when detached, otherwise the branch name. */
function headBranch(repo) {
  return gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD");
}
/** Working-set signature: tracked changes and staged content, not ref state. */
function porcelain(repo) {
  return gitIn(repo, "status", "--porcelain", "--untracked-files=no");
}

/** Fresh git repo on main with one base commit. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "spawn-branch-repo-"));
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.email", "test@example.com");
  gitIn(repo, "config", "user.name", "test");
  gitIn(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "base.txt"), "base\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return repo;
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

const spawn = (repo, workerId, slug) =>
  runTool({
    action: "spawn-worker",
    workerId,
    slug,
    files: [join(repo, "work.txt")],
    spec: "impl",
    outputFile: join(repo, "out.md"),
    cwd: repo,
  });

console.log("spawn-worker leaves the caller's repository where it found it\n");

await testAsync("S1 root on main: the branch is created and the root stays on main", async () => {
  const repo = makeRepo();
  const baseTip = gitIn(repo, "rev-parse", "main");
  // Make the worktree dirty: a checkout-based implementation would carry or
  // refuse this edit, and the ref creation must ignore it entirely.
  writeFileSync(join(repo, "base.txt"), "base\nlocal edit\n");
  const statusBefore = porcelain(repo);

  const text = toolText(await spawn(repo, "bh1", "hygiene"));
  assert.match(text, /ready and registered/, text);

  assert.equal(headBranch(repo), "main", "spawn-worker moved the caller's HEAD");
  assert.equal(porcelain(repo), statusBefore, "spawn-worker changed the working set");
  assert.ok(branchExistsIn(repo, "worker/bh1/hygiene"), "the worker branch must exist");
  assert.equal(
    gitIn(repo, "rev-parse", "worker/bh1/hygiene"),
    baseTip,
    "the worker branch must point at the base tip",
  );
});

await testAsync("S2 root on another branch: the root stays on that branch", async () => {
  const repo = makeRepo();
  gitIn(repo, "checkout", "-q", "-b", "worker/bh2/existing");
  const baseTip = gitIn(repo, "rev-parse", "main");
  assert.equal(headBranch(repo), "worker/bh2/existing", "fixture must not start on main");

  await spawn(repo, "bh2b", "hygiene");

  assert.equal(
    headBranch(repo),
    "worker/bh2/existing",
    "spawn-worker moved the caller off its branch",
  );
  assert.ok(branchExistsIn(repo, "worker/bh2b/hygiene"), "the worker branch must exist");
  assert.equal(
    gitIn(repo, "rev-parse", "worker/bh2b/hygiene"),
    baseTip,
    "the worker branch must point at the base tip, not at the caller's branch",
  );
});

await testAsync("S3 root in detached HEAD: the root stays detached at the same commit", async () => {
  const repo = makeRepo();
  gitIn(repo, "checkout", "-q", "--detach", "main");
  const shaBefore = gitIn(repo, "rev-parse", "HEAD");
  const baseTip = gitIn(repo, "rev-parse", "main");
  assert.equal(headBranch(repo), "HEAD", "fixture must start detached");

  await spawn(repo, "bh3", "hygiene");

  assert.equal(headBranch(repo), "HEAD", "spawn-worker attached the caller's detached HEAD");
  assert.equal(gitIn(repo, "rev-parse", "HEAD"), shaBefore, "spawn-worker moved the detached HEAD");
  assert.ok(branchExistsIn(repo, "worker/bh3/hygiene"), "the worker branch must exist");
  assert.equal(gitIn(repo, "rev-parse", "worker/bh3/hygiene"), baseTip);
});

await testAsync("S4 base branch absent: the ref is still created without switching", async () => {
  const repo = makeRepo();
  gitIn(repo, "branch", "-m", "main", "trunk");
  const headTip = gitIn(repo, "rev-parse", "HEAD");
  assert.equal(headBranch(repo), "trunk", "fixture must be on trunk");
  assert.equal(branchExistsIn(repo, "main"), false, "fixture must have no main");

  await spawn(repo, "bh4", "hygiene");

  assert.equal(headBranch(repo), "trunk", "spawn-worker moved the caller when the base was absent");
  assert.ok(branchExistsIn(repo, "worker/bh4/hygiene"), "the worker branch must exist");
  assert.equal(
    gitIn(repo, "rev-parse", "worker/bh4/hygiene"),
    headTip,
    "with no base the branch must fall back to HEAD, not to nothing",
  );
});

// ── summary ────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
