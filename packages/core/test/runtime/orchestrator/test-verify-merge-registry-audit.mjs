/**
 * Test: a worker merged through `verify-and-merge` keeps a closeable, truthful
 * audit row.
 *
 * The registry is the only record of what a worker was asked to do, which files
 * it held, and what became of it. The invariant pinned here: **a merge that
 * moves the base must leave the worker's row present, marked with the sha it
 * landed on, and findable by `close-worker` afterwards.** A no-op merge marks
 * nothing, and a merge that finds no row at all says so at merge time instead
 * of surfacing as an unexplained "No registry entry" at close time.
 *
 * Every expectation is asserted against the registry FILE (read, parsed, then
 * compared field by field), never against the returned string alone; the merge
 * honesty property itself lives in test-verify-merge-honest.mjs.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports, so the
 * real ~/.pi/agent is untouched.
 *
 * Run: node test/runtime/orchestrator/test-verify-merge-registry-audit.mjs (after npm run build)
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "verify-merge-audit-"));
process.env.HOME = FAKE_HOME;

const { getWorkersFilePath } = await import("../../../dist/lib/config/braid-paths.js");
const { readWorkers } = await import("../../../dist/lib/orchestrator/index.js");
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

// ── fixtures ────────────────────────��───────────────────────────────────────

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

/** Fresh repo on `main` with one base commit. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "verify-merge-audit-repo-"));
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.email", "test@example.com");
  gitIn(repo, "config", "user.name", "test");
  gitIn(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "base.txt"), "base\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return repo;
}

/** Commit a worker's work on the branch the tool created, then park on main. */
function workerCommit(repo, branch) {
  gitIn(repo, "checkout", "-q", branch);
  writeFileSync(join(repo, "work.txt"), "worker\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "worker work");
  const tip = gitIn(repo, "rev-parse", "HEAD");
  gitIn(repo, "checkout", "-q", "main");
  return tip;
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

/** The registry FILE for a project, read and parsed the way a reader would. */
function registryOnDisk(project) {
  const file = getWorkersFilePath(project);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}
const rowOnDisk = (project, workerId) => registryOnDisk(project)?.workers?.[workerId] ?? null;

/** Admit a worker through the tool and return the branch the tool created. */
async function spawn(repo, workerId, slug) {
  const text = toolText(
    await runTool({
      action: "spawn-worker",
      workerId,
      slug,
      cwd: repo,
      files: [join(repo, "work.txt")],
      spec: "impl",
      outputFile: join(repo, "out.md"),
    }),
  );
  assert.match(text, /ready and registered/, `the fixture needs an admitted worker\n${text}`);
  // The branch comes from the admitted row, not from HEAD: spawn-worker leaves
  // the caller's HEAD where it was, so HEAD is not the worker's branch.
  const branch = readWorkers(repo).workers[workerId]?.branch;
  assert.ok(branch, `the admitted worker's row must name its branch\n${text}`);
  return branch;
}

console.log("verify-and-merge registry audit test\n");

// ── T1: the merge must stamp the row it leaves behind ───────────────────────

await testAsync("T1 a performed merge marks the row merged at the new base tip", async () => {
  const repo = makeRepo();
  const branch = await spawn(repo, "m1", "merge-audit");
  const tip = workerCommit(repo, branch);

  const before = rowOnDisk(repo, "m1");
  assert.ok(before, "precondition: the admitted worker has a row on disk");
  assert.equal(before.mergeSha ?? null, null, "precondition: no merge recorded yet");

  const result = await runTool({ action: "verify-and-merge", workerId: "m1", cwd: repo, branch });
  const text = toolText(result);
  assert.ok(SUCCESS_RE.test(text), `the merge must be reported\n${text}`);
  assert.ok(isAncestorIn(repo, tip, "main"), `main must contain the tip\n${text}`);

  const baseTip = gitIn(repo, "rev-parse", "main");
  assert.equal(result.details.mergeSha, baseTip, "the claim travels with the sha it landed on");
  assert.match(text, /Audit row: m1 marked merged at/, `the report names the audit row\n${text}`);

  const after = rowOnDisk(repo, "m1");
  assert.ok(after, "the merged worker keeps its row on disk");
  assert.equal(after.status, "merged", "the row records the merge");
  assert.equal(after.mergeSha, baseTip, "the row records the sha it landed on");
  assert.ok(!Number.isNaN(Date.parse(after.mergedAt)), "mergedAt is an ISO timestamp");
  assert.ok(after.resultAt, "the merge stamps a result time");
  assert.equal(after.branch, branch, "the branch is still on the row");
  assert.equal(after.cwd, repo, "the row keeps its own project key");

  const closed = toolText(
    await runTool({
      action: "close-worker",
      workerId: "m1",
      cwd: repo,
      outcome: "completed",
      gates: [{ cmd: "npm test", exit: 0 }],
    }),
  );
  assert.match(closed, /closed: completed/, `the merged worker must still be closeable\n${closed}`);

  const finalRow = rowOnDisk(repo, "m1");
  assert.equal(finalRow.status, "completed", "the close outcome stands");
  assert.ok(finalRow.closedAt, "the row is closed");
  assert.equal(finalRow.mergeSha, after.mergeSha, "the merge record survives the close");
  assert.equal(finalRow.mergedAt, after.mergedAt, "the merge time survives the close");
});

// ── T2: a no-op merge marks nothing ─────────────────────────────────────────

await testAsync("T2 a merge that merged nothing leaves no merge mark", async () => {
  const repo = makeRepo();
  const branch = await spawn(repo, "m2", "merge-audit");
  const tip = workerCommit(repo, branch);
  gitIn(repo, "merge", "--ff-only", "-q", branch); // the tip is already in main
  assert.ok(isAncestorIn(repo, tip, "main"), "precondition: main holds the tip");

  const text = toolText(
    await runTool({ action: "verify-and-merge", workerId: "m2", cwd: repo, branch }),
  );
  assert.ok(!SUCCESS_RE.test(text), `a no-op must not claim a merge\n${text}`);

  const after = rowOnDisk(repo, "m2");
  assert.ok(after, "the row survives a no-op merge");
  assert.notEqual(after.status, "merged", `a no-op must not mark the row merged\n${text}`);
  assert.equal(after.mergeSha ?? null, null, "no sha is recorded for a merge that did not happen");
  assert.match(
    toolText(
      await runTool({
        action: "close-worker",
        workerId: "m2",
        cwd: repo,
        outcome: "completed",
        gates: [{ cmd: "npm test", exit: 0 }],
      }),
    ),
    /closed: completed/,
    "the row is still closeable after a no-op merge",
  );
});

// ── T3: one project, two spellings, one row ─────────────────────────────────

await testAsync("T3 one row is found from either spelling of the project path", async () => {
  const real = mkdtempSync(join(tmpdir(), "verify-merge-audit-real-"));
  const link = join(mkdtempSync(join(tmpdir(), "verify-merge-audit-link-")), "link");
  symlinkSync(real, link);

  assert.equal(
    dirname(getWorkersFilePath(link)),
    dirname(getWorkersFilePath(real)),
    "a symlinked spelling of one directory must key to one store",
  );

  toolText(
    await runTool({
      action: "register-worker",
      workerId: "s3",
      spec: "impl",
      cwd: link,
      branch: "worker/s3/symlink",
      outputFile: join(real, "out.md"),
    }),
  );
  assert.ok(rowOnDisk(real, "s3"), "the row lands in the store both spellings resolve to");

  const listed = toolText(await runTool({ action: "list-workers", cwd: real }));
  assert.match(listed, /s3/, `the row is visible from the other spelling\n${listed}`);

  const closed = toolText(
    await runTool({
      action: "close-worker",
      workerId: "s3",
      cwd: real,
      outcome: "completed",
      gates: [{ cmd: "npm test", exit: 0 }],
    }),
  );
  assert.match(closed, /closed: completed/, `the row is closeable from the other spelling\n${closed}`);
  assert.equal(rowOnDisk(real, "s3").status, "completed", "the close is persisted");
});

// ── T4: a missing row is reported, never invented ───────────────────────────

await testAsync("T4 a merge with no registry row says so instead of losing the worker", async () => {
  const repo = makeRepo();
  gitIn(repo, "checkout", "-q", "-b", "worker/norow/lock-only");
  writeFileSync(join(repo, "work.txt"), "worker\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "worker work");
  const tip = gitIn(repo, "rev-parse", "HEAD");
  gitIn(repo, "checkout", "-q", "main");
  assert.equal(readWorkers(repo).workers.norow, undefined, "precondition: no row was ever written");

  const text = toolText(
    await runTool({
      action: "verify-and-merge",
      workerId: "norow",
      cwd: repo,
      branch: "worker/norow/lock-only",
    }),
  );

  assert.ok(SUCCESS_RE.test(text), `the merge itself must be reported\n${text}`);
  assert.ok(isAncestorIn(repo, tip, "main"), `main must contain the tip\n${text}`);
  assert.match(
    text,
    /Audit row: NO registry entry for norow/,
    `the missing audit row must be reported at merge time\n${text}`,
  );
  assert.equal(
    readWorkers(repo).workers.norow,
    undefined,
    "the merge invents no row: spec and outputFile are admission's facts",
  );
});

// ── T5: a merged row is not reported as still in flight ────────────────���────

await testAsync("T5 check-worker reports a merged row as merged, not in flight", async () => {
  const repo = makeRepo();
  const branch = await spawn(repo, "m5", "merge-audit");
  workerCommit(repo, branch);
  toolText(await runTool({ action: "verify-and-merge", workerId: "m5", cwd: repo, branch }));

  // The output file is still missing, so the record is incomplete: the verdict
  // must say merged-and-blocked rather than pretending the worker is in flight.
  const verdict = await runTool({ action: "check-worker", workerId: "m5", cwd: repo });
  assert.equal(verdict.details.status, "merged", `expected a merged verdict\n${toolText(verdict)}`);
  assert.match(toolText(verdict), /merged at/, "the verdict names the merge time");
  assert.match(toolText(verdict), /output file missing/, "the verdict names what is still missing");
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
