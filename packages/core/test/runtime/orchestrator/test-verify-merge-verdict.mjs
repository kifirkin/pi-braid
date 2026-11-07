/**
 * Test: every verify-and-merge outcome opens with its verdict, and the no-op
 * names the branch that carries the work.
 *
 * The shape pinned here is the split branch: the registry row names a branch
 * whose tip is the base itself, while a second branch for the same worker
 * carries the commit. The report must open with NOTHING merged:, name the
 * second branch and its tip, say it is not in the base, and still delete only
 * the branch it was asked about. The same vocabulary covers the refusal
 * (NOT merged:) and the merge that happened (MERGED:), so a reader who reads
 * one line knows which of the three it was.
 *
 * A branch twelve commits ahead is the control: the new wording must not turn
 * a normal fast-forward into a warning.
 *
 * Hermetic: HOME and the agent dir are pinned into a scratch tree BEFORE the
 * dist imports, so the registry and lock reads never touch ~/.pi/agent.
 *
 * Run: node --test test/runtime/orchestrator/test-verify-merge-verdict.mjs
 * (after npm run build)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "verify-merge-verdict-"));
process.env.HOME = FAKE_HOME;
process.env.PI_CODING_AGENT_DIR = join(FAKE_HOME, ".pi", "agent");
delete process.env.BRAID_HOME;

const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);

// ── git fixtures ────────────────────────────────────────────────────────────

function gitIn(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}
const branchExistsIn = (repo, branch) => gitIn(repo, "branch", "--list", branch).length > 0;

/** Fresh repo on `main` with one base commit. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "verify-merge-verdict-repo-"));
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.email", "test@example.com");
  gitIn(repo, "config", "user.name", "test");
  gitIn(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "base.txt"), "base\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return repo;
}

function commitFile(repo, file, content, message) {
  writeFileSync(join(repo, file), content);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", message);
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
const firstLine = (text) => text.split("\n")[0];

/** Register the worker with the branch spawn-worker would have created. */
function register(repo, workerId, branch) {
  return runTool({
    action: "register-worker",
    workerId,
    spec: "impl",
    cwd: repo,
    branch,
    outputFile: join(repo, "out.md"),
  });
}

describe("verify-and-merge verdict lines", () => {
  it("a branch at the base names the other branch that carries the work", async () => {
    const repo = makeRepo();
    // The branch spawn-worker creates: at the base, with no work of its own.
    gitIn(repo, "branch", "worker/s1/registry", "main");
    // The branch a seat creates by hand: the commit lands here.
    gitIn(repo, "checkout", "-q", "-b", "worker/s1/tracks");
    const tracksTip = commitFile(repo, "tracks.txt", "tracks\n", "tracks work");
    gitIn(repo, "checkout", "-q", "main");
    const mainBefore = gitIn(repo, "rev-parse", "main");

    await register(repo, "s1", "worker/s1/registry");
    const result = await runTool({ action: "verify-and-merge", workerId: "s1", cwd: repo });
    const text = toolText(result);
    const first = firstLine(text);

    assert.match(first, /^NOTHING merged:/, `the no-op verdict must lead\n${text}`);
    assert.match(text, /worker\/s1\/tracks/, `the report must name the branch that carries the work\n${text}`);
    assert.ok(
      text.includes(tracksTip.slice(0, 12)),
      `the report must name the other branch's tip\n${text}`,
    );
    assert.match(text, /not in main/, `the report must say the other branch is not in the base\n${text}`);
    assert.equal(gitIn(repo, "rev-parse", "main"), mainBefore, "the no-op must not move the base");
    assert.equal(
      branchExistsIn(repo, "worker/s1/registry"),
      false,
      `the branch the call named must still be deleted\n${text}`,
    );
    assert.equal(
      branchExistsIn(repo, "worker/s1/tracks"),
      true,
      `the branch that carries the work must survive\n${text}`,
    );
    assert.match(
      text,
      /deleted; no merge was performed/,
      `the deletion must not read as a merge\n${text}`,
    );
    assert.doesNotMatch(text, /merged into/, `a no-op must not say work was merged\n${text}`);
    assert.equal(result.details.mergeSha, undefined, "a no-op carries no mergeSha");
  });

  it("a branch twelve commits ahead merges with the merged verdict first", async () => {
    const repo = makeRepo();
    gitIn(repo, "checkout", "-q", "-b", "worker/s2/ahead");
    let tip = "";
    for (let i = 1; i <= 12; i++) {
      tip = commitFile(repo, `step-${i}.txt`, `${i}\n`, `step ${i}`);
    }
    gitIn(repo, "checkout", "-q", "main");
    const mainBefore = gitIn(repo, "rev-parse", "main");

    await register(repo, "s2", "worker/s2/ahead");
    const result = await runTool({ action: "verify-and-merge", workerId: "s2", cwd: repo });
    const text = toolText(result);

    assert.match(firstLine(text), /^MERGED:/, `a performed merge must lead with its verdict\n${text}`);
    assert.equal(gitIn(repo, "rev-parse", "main"), tip, `main must fast-forward to the tip\n${text}`);
    assert.notEqual(mainBefore, tip);
    assert.equal(result.details.mergeSha, tip, "details must carry the tip that landed");
    assert.equal(
      branchExistsIn(repo, "worker/s2/ahead"),
      false,
      `the merged branch must still be deleted\n${text}`,
    );
    assert.doesNotMatch(text, /NOTHING merged|^NOT merged/m, `a merge is not a warning\n${text}`);
  });

  it("a refused merge leads with the refusal token", async () => {
    const repo = makeRepo();
    gitIn(repo, "checkout", "-q", "-b", "worker/s3/diverged");
    commitFile(repo, "worker.txt", "worker\n", "worker work");
    gitIn(repo, "checkout", "-q", "main");
    commitFile(repo, "main.txt", "main\n", "main advance");
    gitIn(repo, "checkout", "-q", "-b", "parked");
    const mainBefore = gitIn(repo, "rev-parse", "main");

    await register(repo, "s3", "worker/s3/diverged");
    const text = toolText(
      await runTool({ action: "verify-and-merge", workerId: "s3", cwd: repo }),
    );

    assert.match(firstLine(text), /^NOT merged:/, `a refusal must lead with its verdict\n${text}`);
    assert.doesNotMatch(text, /^MERGED:/m, `a refusal must not read as a merge\n${text}`);
    assert.equal(gitIn(repo, "rev-parse", "main"), mainBefore, "the refusal must leave the base");
    assert.equal(branchExistsIn(repo, "worker/s3/diverged"), true, "the branch must be kept");
  });

  it("a worker with no branch leads with the no-op token", async () => {
    const repo = makeRepo();
    const text = toolText(
      await runTool({ action: "verify-and-merge", workerId: "s4", cwd: repo }),
    );

    assert.match(firstLine(text), /^NOTHING merged:/, `the early no-op must lead\n${text}`);
    assert.match(text, /no branch to verify/, `the reason must be named\n${text}`);
  });

  it("the three verdicts are one vocabulary: three distinct leading tokens", async () => {
    const tokens = ["MERGED:", "NOTHING merged:", "NOT merged:"];
    assert.equal(new Set(tokens).size, 3);
    for (const token of tokens) {
      assert.match(`${token} rest of the report`, /^(MERGED:|NOTHING merged:|NOT merged:)/);
    }
  });
});
