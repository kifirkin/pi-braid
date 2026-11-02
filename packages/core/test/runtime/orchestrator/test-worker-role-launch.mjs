/**
 * The spawn instruction carries the worker role marker into the agent's env.
 *
 * A worker session runs with the seat's bot token and chat id, so the extension
 * that reaches the owner must be told which seat it is in. The marker arrives
 * through the environment, and no tool call can add one afterwards: the only
 * moment it can be set is the launch. That makes the launch step in the
 * spawn-worker result a producer, and a producer that omits the marker leaves
 * every consumer gate inert while looking installed.
 *
 * What this pins:
 *   - the result carries a launch step that exports the marker in the pane shell
 *     BEFORE the agent starts, and then starts the agent through the agent
 *     channel in that same pane: the export is inherited by the agent process,
 *     and the worker stays addressable by name for prompts and reads;
 *   - the command-prefix form is documented as the fallback for a launch that
 *     is not driven through the agent CLI (a one-shot json run);
 *   - the step names the pane split that creates the pane first, because both
 *     the export and the start need a pane to run in;
 *   - the rest of the spawn result is unchanged: branch, locked files, output
 *     path and the verify-and-merge next step.
 *
 * The name is pinned as a literal here on purpose: the telegram package pins
 * its ENV_SESSION_ROLE constant to the same literal, so both ends of the chain
 * move together or one test goes red.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports
 * (os.homedir() reads $HOME on POSIX), and the repo is a scratch git tree.
 *
 * Run: node test/runtime/orchestrator/test-worker-role-launch.mjs (after npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "worker-role-launch-home-"));
process.env.HOME = FAKE_HOME;

const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);

function gitIn(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

/** Fresh git repo on main with one base commit. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "worker-role-launch-repo-"));
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.email", "test@example.com");
  gitIn(repo, "config", "user.name", "test");
  gitIn(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "base.txt"), "base\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return repo;
}

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
  orchestrateTool.execute(
    "call-1",
    params,
    new AbortController().signal,
    undefined,
    undefined,
  );
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

test("P1 the launch step exports BRAID_SESSION_ROLE=worker before the agent starts", async () => {
  const repo = makeRepo();
  const text = toolText(await spawn(repo, "mr1", "role-marker"));

  assert.match(text, /ready and registered/, text);
  // The marker goes into the pane shell before the agent exists: an export on a
  // command line is what a later exec inherits, and the agent-channel start
  // keeps the worker addressable by name.
  assert.ok(
    /command="export BRAID_SESSION_ROLE=worker"/.test(text),
    `the launch must export the marker in the pane shell:\n${text}`,
  );
  assert.ok(
    /herdr_agent action=start pane=<pane-id>/.test(text),
    `the agent must start in that same pane, through the agent channel:\n${text}`,
  );
  assert.ok(
    text.indexOf("export BRAID_SESSION_ROLE=worker") <
      text.indexOf("herdr_agent action=start"),
    `the export must precede the agent start:\n${text}`,
  );
  assert.ok(
    /command="BRAID_SESSION_ROLE=worker pi"/.test(text),
    `the command-prefix fallback must stay documented:\n${text}`,
  );
  // A command needs a pane, and the step must say so: a seat that runs the
  // export without splitting a pane first has nowhere to run it.
  assert.ok(
    /pane_split/.test(text),
    `the launch step must create the pane first:\n${text}`,
  );
});

test("P2 the rest of the spawn result is unchanged", async () => {
  const repo = makeRepo();
  const work = join(repo, "work.txt");
  const out = join(repo, "out.md");
  const text = toolText(await spawn(repo, "mr2", "role-marker-2"));

  assert.ok(
    text.includes("Branch: worker/mr2/role-marker-2"),
    `the branch must still be named:\n${text}`,
  );
  assert.ok(text.includes(work), "the locked file must still be named");
  assert.ok(text.includes(out), "the output path must still be named");
  assert.match(text, /verify-and-merge/);
  assert.equal(
    gitIn(repo, "rev-parse", "--abbrev-ref", "HEAD"),
    "main",
    "the caller's tree stays on its branch",
  );
});
