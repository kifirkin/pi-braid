/**
 * Test: verify-and-merge keeps every worktree that has the merge target
 * checked out consistent with the advanced ref.
 *
 * A merge advances the base ref. When the base branch is checked out in a
 * worktree other than the caller's (the normal flow here: the seat's cwd is a
 * worker worktree while the primary checkout holds `main`), advancing only the
 * ref with `git update-ref` moves HEAD to the merge commit but leaves that
 * worktree's index and files on the old tip. `git status` then reads as a
 * staged inverse of the merge and the merged files are absent from the working
 * tree even though HEAD holds them: a gate run there tests a stale tree.
 *
 * The invariant pinned here: **after a merge, any worktree holding the base
 * branch is coherent with the advanced ref — clean status, HEAD equal to the
 * base tip, files present.** A second case pins the tool's existing promise:
 * the caller's own worktree is left on the branch it was on. A third
 * pins the safety half: a holder worktree carrying uncommitted changes is
 * refused, never merged over.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports, so the
 * real ~/.pi/agent is untouched.
 *
 * Run: node test/runtime/orchestrator/test-verify-merge-worktree-consistency.mjs
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "verify-merge-worktree-home-"));
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
/** Working-set signature: tracked/staged state, not ref state. */
function porcelain(repo) {
  return gitIn(repo, "status", "--porcelain", "--untracked-files=no");
}
function headBranch(repo) {
  return gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD");
}

/** Fresh repo on `main` with one base commit; the primary checkout. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "verify-merge-worktree-repo-"));
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.email", "test@example.com");
  gitIn(repo, "config", "user.name", "test");
  gitIn(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "base.txt"), "base\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return repo;
}

/**
 * A second worktree (the worker's seat) on its own branch, branched from
 * `from`. Returns { path, branch }. The primary checkout is left where it was,
 * which is what puts the two worktrees on different branches.
 */
function addWorkerWorktree(repo, workerId, from = "main") {
  const branch = `worker/${workerId}/wt`;
  const path = join(mkdtempSync(join(tmpdir(), "verify-merge-worktree-seat-")), "wt");
  gitIn(repo, "worktree", "add", "-q", path, "-b", branch, from);
  return { path, branch };
}

/** Commit a worker's work inside its own worktree; return the new tip. */
function commitInWorktree(worktree, file) {
  writeFileSync(join(worktree, file), "worker\n");
  gitIn(worktree, "add", "-A");
  gitIn(worktree, "commit", "-q", "-m", "worker work");
  return gitIn(worktree, "rev-parse", "HEAD");
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

const merge = (cwd, workerId, branch) =>
  runTool({ action: "verify-and-merge", workerId, cwd, branch });

console.log("verify-and-merge keeps the merge target's worktree coherent\n");

// ── WT1: the merge target is checked out in another worktree ───────────────

await testAsync("WT1 the worktree holding the base is coherent after a merge", async () => {
  const repo = makeRepo();
  const { path: seat, branch } = addWorkerWorktree(repo, "wt1");
  const tip = commitInWorktree(seat, "work.txt");

  assert.equal(headBranch(repo), "main", "precondition: the primary holds the base");
  assert.equal(headBranch(seat), branch, "precondition: the seat holds the worker branch");
  const primaryBefore = gitIn(repo, "rev-parse", "HEAD");

  const text = toolText(await merge(seat, "wt1", branch));
  assert.match(text, /merged into main/i, `the merge must be reported\n${text}`);

  // The base ref advanced...
  assert.equal(gitIn(repo, "rev-parse", "main"), tip, "main must hold the worker tip");
  assert.equal(gitIn(repo, "rev-parse", "HEAD"), tip, "the primary checkout must read the new tip");

  // ...and the worktree that carries it moved with the ref. Pre-fix this reads
  // as a staged inverse of the merge and the merged file is absent.
  assert.equal(
    porcelain(repo),
    "",
    "the primary worktree must be clean: index and files follow the advanced ref",
  );
  assert.equal(
    gitIn(repo, "show", "HEAD:work.txt").trim(),
    "worker",
    "the merged file must be present in the primary worktree's HEAD",
  );
  assert.ok(primaryBefore.length > 0, "fixture sanity: the primary had a prior tip");
});

// ── WT2: the caller's own worktree/branch is untouched ────────────────────

await testAsync("WT2 the caller's worktree stays on its own branch", async () => {
  const repo = makeRepo();
  const { path: seat, branch } = addWorkerWorktree(repo, "wt2");
  const tip = commitInWorktree(seat, "work.txt");
  const seatStatusBefore = porcelain(seat);

  const text = toolText(await merge(seat, "wt2", branch));
  assert.match(text, /merged into main/i, `the merge must be reported\n${text}`);

  assert.equal(headBranch(seat), branch, "the tool moved the caller's worktree off its branch");
  assert.equal(gitIn(seat, "rev-parse", "HEAD"), tip, "the caller's HEAD moved");
  assert.equal(porcelain(seat), seatStatusBefore, "the caller's working set changed");
  assert.equal(
    gitIn(repo, "branch", "--list", branch).length > 0,
    true,
    "a branch checked out in the caller's worktree must not be force-deleted",
  );
});

// ── WT3: no worktree holds the base — the ref-only advance stays coherent ──

await testAsync("WT3 a base checked out nowhere advances without disturbing any worktree", async () => {
  const repo = makeRepo();
  // Park the primary on another branch so `main` exists as a ref only.
  gitIn(repo, "checkout", "-q", "-b", "seat-branch");
  const primaryTip = gitIn(repo, "rev-parse", "HEAD");
  const { path: seat, branch } = addWorkerWorktree(repo, "wt3");
  const tip = commitInWorktree(seat, "work.txt");

  const text = toolText(await merge(seat, "wt3", branch));
  assert.match(text, /merged into main/i, `the merge must be reported\n${text}`);

  assert.equal(gitIn(repo, "rev-parse", "main"), tip, "main must hold the worker tip");
  assert.equal(headBranch(repo), "seat-branch", "the primary was moved off its branch");
  assert.equal(gitIn(repo, "rev-parse", "HEAD"), primaryTip, "the primary's HEAD moved");
  assert.equal(porcelain(repo), "", "the primary worktree must remain clean");
});

// ── WT4: a dirty holder is refused, never merged over ─────────────────────

await testAsync("WT4 a dirty holder worktree is refused, not merged over", async () => {
  const repo = makeRepo();
  const { path: seat, branch } = addWorkerWorktree(repo, "wt4");
  commitInWorktree(seat, "work.txt");
  const mainBefore = gitIn(repo, "rev-parse", "main");
  // The primary holds an unrelated edit; a merge there would fold it into the
  // ref move, so the tool must refuse and leave both worktrees as they were.
  writeFileSync(join(repo, "base.txt"), "base\nuncommitted seat edit\n");

  const text = toolText(await merge(seat, "wt4", branch));
  assert.ok(!/merged into main/i.test(text), `a dirty holder must not be merged over\n${text}`);
  assert.match(text, /NOT merged: worktree .*uncommitted changes/i, `the refusal must be named\n${text}`);

  assert.equal(gitIn(repo, "rev-parse", "main"), mainBefore, "the base moved despite the refusal");
  assert.equal(
    porcelain(repo),
    "M base.txt",
    "the primary must keep exactly its own edit, with no stale inverse",
  );
  assert.equal(headBranch(seat), branch, "the caller's worktree was moved by a refused merge");
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
