/**
 * Test: the orchestrator tool's two published contracts.
 *
 * 1. **A worker registered with its handle is observable.** register-worker
 *    carries `pane` and `workerSession`, list-workers prints both, and
 *    check-worker reads a session file written within the stall window as
 *    `working` instead of the blanket `admitted`/not-yet-observed. The pane is
 *    a handle, never liveness: a pane with no session file stays admitted.
 * 2. **verify-and-merge never switches the caller's worktree.** It merges into
 *    the base ref, leaves the tree on the branch it was on, names that branch in
 *    the report and in details, and tells the caller what a commit made there
 *    would land on. Success still means the base ref advanced.
 *
 * Every assertion here can go red: the two handle assertions pair a carried
 * handle against an uncarried one, and the worktree assertions pair a tree
 * parked on the worker branch against a tree on the base (no warning) and
 * against a merge that did not happen (no success, no mergeSha).
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports
 * (os.homedir() reads $HOME on POSIX), so the real ~/.pi/agent is untouched.
 *
 * Run: node test/runtime/orchestrator/test-tool-contract.mjs (after npm run build)
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "tool-contract-home-"));
process.env.HOME = FAKE_HOME;

const { acquireLock } = await import("../../../dist/lib/orchestrator/index.js");
const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);

const WORKER = "worker/w1/contract";
const STALLED_AFTER_SEC = 600;

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
const isAncestorIn = (repo, a, b) => gitOk(repo, "merge-base", "--is-ancestor", a, b);

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "tool-contract-repo-"));
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

/** A session file whose mtime is `ageSec` in the past. */
function makeSession(dir, name, ageSec) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ type: "message", message: { role: "assistant", content: "hi" } }) + "\n");
  const when = new Date(Date.now() - ageSec * 1000);
  utimesSync(path, when, when);
  return path;
}

function lockWorker(repo, workerId) {
  const locked = join(repo, "work.txt");
  assert.equal(acquireLock([locked], workerId, WORKER, repo), true, "fixture must hold the lock");
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

// ── 1. the handle a registration carries ────────────────────────────────────

console.log("worker handle carried by registration");

await testAsync("T1 register-worker carries pane and workerSession into the row and the listing", async () => {
  const repo = makeRepo();
  const session = makeSession(repo, "w-h1.jsonl", 5);

  const registered = JSON.parse(
    toolText(
      await runTool({
        action: "register-worker",
        workerId: "h1",
        spec: "impl",
        cwd: repo,
        branch: WORKER,
        pane: "pane-7",
        workerSession: session,
      }),
    ),
  );
  assert.equal(registered.ok, true, `registration refused: ${JSON.stringify(registered)}`);
  assert.equal(registered.entry.pane, "pane-7", "the pane must be recorded at admission, not left null");
  assert.equal(registered.entry.workerSession, session, "the session path must be recorded at admission");

  const listed = toolText(await runTool({ action: "list-workers", cwd: repo }));
  assert.match(listed, /pane=pane-7/, `list-workers must show the recorded pane\n${listed}`);
  assert.match(listed, new RegExp(`session=${session.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `list-workers must show the recorded session\n${listed}`);
});

await testAsync("T2 a live session file reads as working; a row with no handle does not", async () => {
  const repo = makeRepo();
  const session = makeSession(repo, "w-h2.jsonl", 5);

  await runTool({
    action: "register-worker",
    workerId: "h2",
    spec: "impl",
    cwd: repo,
    branch: WORKER,
    pane: "pane-8",
    workerSession: session,
  });
  const carried = await runTool({ action: "check-worker", workerId: "h2", cwd: repo });
  assert.equal(carried.details.status, "working", `a live session is the registry's own liveness evidence\n${toolText(carried)}`);
  assert.match(carried.details.reason, /session file active 5s ago/, `the reason must name the evidence and its age\n${toolText(carried)}`);

  // Negative control in the same shape: same spec, same branch, same age of
  // worktree, no handle carried. If the register write were reverted this is
  // the verdict every worker would get.
  await runTool({
    action: "register-worker",
    workerId: "h2b",
    spec: "impl",
    cwd: repo,
    branch: WORKER,
  });
  const bare = await runTool({ action: "check-worker", workerId: "h2b", cwd: repo });
  assert.equal(bare.details.status, "admitted", `a row with no handle must not claim to be running\n${toolText(bare)}`);
  assert.match(bare.details.reason, /not yet observed running/, toolText(bare));
});

await testAsync("T3 a frozen session file with no output still reads as stalled, not working", async () => {
  const repo = makeRepo();
  const session = makeSession(repo, "w-h3.jsonl", STALLED_AFTER_SEC + 100);

  await runTool({
    action: "register-worker",
    workerId: "h3",
    spec: "impl",
    cwd: repo,
    branch: WORKER,
    workerSession: session,
  });
  const verdict = await runTool({ action: "check-worker", workerId: "h3", cwd: repo });
  assert.equal(verdict.details.status, "stalled", `a session frozen ${STALLED_AFTER_SEC + 100}s is not evidence of running\n${toolText(verdict)}`);
  assert.match(verdict.details.reason, /session frozen for 700s/, toolText(verdict));
});

await testAsync("T4 a pane with no session file is a handle, not liveness", async () => {
  const repo = makeRepo();

  await runTool({
    action: "register-worker",
    workerId: "h4",
    spec: "impl",
    cwd: repo,
    branch: WORKER,
    pane: "pane-9",
  });
  const verdict = await runTool({ action: "check-worker", workerId: "h4", cwd: repo });
  assert.equal(verdict.details.status, "admitted", `a pane alone must not be read as running\n${toolText(verdict)}`);
  const listed = toolText(await runTool({ action: "list-workers", cwd: repo }));
  assert.match(listed, /h4\s+spec=impl\s+status=admitted\s+pane=pane-9\s+session=-/, listed);
});

// ── 2. the merge's published contract ───────────────────────────────────────

console.log("verify-and-merge contract");

await testAsync("T5 the tool never switches the caller's tree, and names the branch it stays on", async () => {
  const repo = makeRepo();
  const tip = workerCommit(repo);
  lockWorker(repo, "m5");
  const head = gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD");

  const result = await runTool({ action: "verify-and-merge", workerId: "m5", cwd: repo });
  const text = toolText(result);

  assert.ok(SUCCESS_RE.test(text), `the merge into main must be reported\n${text}`);
  assert.equal(isAncestorIn(repo, tip, "main"), true, `the base must hold the work after a success claim\n${text}`);
  assert.equal(result.details.mergeSha, gitIn(repo, "rev-parse", "main"), `details must carry the new base tip\n${JSON.stringify(result.details)}`);
  assert.equal(gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD"), head, "the tool moved the worktree's HEAD");
  assert.equal(result.details.worktreeBranch, WORKER, `details must carry the branch the tree is on\n${JSON.stringify(result.details)}`);
  assert.match(text, /Worktree: .* stays on worker\/w1\/contract, not main/, `the report must say where the tree is\n${text}`);
  assert.match(text, /so a commit made there now lands on worker\/w1\/contract/, `the report must name where a commit lands\n${text}`);
  assert.match(text, /git -C .* checkout main/, `the report must say what to do about it\n${text}`);
});

await testAsync("T6 a tree already on the base gets no 'stays on' warning (the warning is not unconditional)", async () => {
  const repo = makeRepo();
  gitIn(repo, "checkout", "-q", "-b", WORKER);
  writeFileSync(join(repo, "work.txt"), "worker\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "worker work");
  const tip = gitIn(repo, "rev-parse", "HEAD");
  gitIn(repo, "checkout", "-q", "main");
  lockWorker(repo, "m6");

  const result = await runTool({ action: "verify-and-merge", workerId: "m6", cwd: repo });
  const text = toolText(result);

  assert.ok(SUCCESS_RE.test(text), `the in-place merge must be reported\n${text}`);
  assert.equal(isAncestorIn(repo, tip, "main"), true, text);
  assert.equal(gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "an in-place merge must leave the tree on the base");
  assert.match(text, /Worktree: on main \(the merge target\)\./, `the report must still say where the tree is\n${text}`);
  assert.doesNotMatch(text, /stays on/, `no warning belongs on a tree that is already on the base\n${text}`);
});

await testAsync("T7 a merge that did not happen carries no success and no mergeSha", async () => {
  const repo = makeRepo();
  // Diverge: the base gets its own commit, the worker branch another. Park the
  // worktree on a third branch so the base is not checked out: that is a
  // refusal, not a tree merge.
  workerCommit(repo);
  gitIn(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "main-advance.txt"), "advance\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "advance main");
  gitIn(repo, "checkout", "-q", "-b", "parked");
  const baseBefore = gitIn(repo, "rev-parse", "main");
  lockWorker(repo, "m7");

  const result = await runTool({ action: "verify-and-merge", workerId: "m7", cwd: repo });
  const text = toolText(result);

  assert.doesNotMatch(text, SUCCESS_RE, `a refused merge must not read as a merge\n${text}`);
  assert.equal(result.details.mergeSha, undefined, `no mergeSha for a merge that did not happen\n${JSON.stringify(result.details)}`);
  assert.equal(gitIn(repo, "rev-parse", "main"), baseBefore, "the base must be untouched");
  assert.match(text, /NOT merged/, text);
  assert.equal(result.details.worktreeBranch, "parked", `the worktree branch must be reported on refusals too\n${JSON.stringify(result.details)}`);
});

await testAsync("T8 the tool description publishes both contracts", async () => {
  const description = orchestrateTool.description;
  assert.match(description, /verify-and-merge requires workerId/, description);
  assert.match(description, /never switches a worktree's branch/, description);
  const workerIdParam = orchestrateTool.parameters.properties.workerId.description;
  for (const action of ["spawn-worker", "register-worker", "update-worker", "check-worker", "close-worker", "verify-and-merge"]) {
    assert.match(workerIdParam, new RegExp(action), `workerId must name ${action} as requiring it: ${workerIdParam}`);
  }
  const sessionParam = orchestrateTool.parameters.properties.workerSession.description;
  assert.match(sessionParam, /mtime/, sessionParam);
  assert.match(sessionParam, /register-worker/, sessionParam);
});

// ── summary ────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
