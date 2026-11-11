/**
 * git tool: argv-only git, read-only by default.
 *
 * Every claim is re-derived with the test's own git process instead of the
 * tool's output, because a check that shares the instrument proves nothing. The
 * repositories are throwaway trees under a temporary $HOME, and the extension's
 * own `processStarts` counter is the evidence that a refusal never reached the
 * operating system.
 *
 * Run: node packages/contrib/test/git-tool.test.mjs
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRIB = join(HERE, "..");
const ROOT = mkdtempSync(join(tmpdir(), "git-tool-"));

// The extension reads its contrib toggle from $HOME, and its child inherits the
// environment this file sets: a throwaway home, a global git config that cannot
// inject a signing hook, fixed identities, and C messages.
process.env.HOME = ROOT;
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_AUTHOR_NAME = "Fixture";
process.env.GIT_AUTHOR_EMAIL = "fixture@example.invalid";
process.env.GIT_COMMITTER_NAME = "Fixture";
process.env.GIT_COMMITTER_EMAIL = "fixture@example.invalid";
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.LC_ALL = "C";
mkdirSync(join(ROOT, ".pi", "agent"), { recursive: true });
writeFileSync(join(ROOT, ".pi", "agent", "settings.json"), "{}");

register(new URL("./lib/ts-resolve.mjs", import.meta.url));

const { default: gitExtension, processStarts } = await import(
  pathToFileURL(join(CONTRIB, "git", "index.ts")).href
);

function gitIn(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: process.env,
  });
}

function seedRepo(name, { commits = 1 } = {}) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  gitIn(dir, ["init", "-q", "--initial-branch=main"]);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  gitIn(dir, ["add", "seed.txt"]);
  gitIn(dir, ["commit", "-q", "-m", "fixture: seed"]);
  for (let index = 2; index <= commits; index++) {
    gitIn(dir, [
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `fixture commit ${index}`,
    ]);
  }
  return dir;
}

const registered = [];
gitExtension({
  registerTool: (tool) => registered.push(tool),
  registerCommand: () => {},
  on: () => {},
  setActiveTools: () => {},
  getAllTools: () => [],
});

const gitTool = registered.find((candidate) => candidate.name === "git");

const call = (params) => gitTool.execute("fixture-call", params);

/** Process-table lines matching `pattern`, or "" when none do. */
function survivors(pattern) {
  try {
    return execFileSync("pgrep", ["-fl", pattern], { encoding: "utf-8" })
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .join("\n");
  } catch {
    return "";
  }
}
const textOf = (result) => result.content.map((part) => part.text).join("\n");

const repos = {};

before(() => {
  repos.plain = seedRepo("plain");
  repos.dirty = seedRepo("dirty");
  repos.clean = seedRepo("clean");
  repos.bulky = seedRepo("bulky", { commits: 40 });
  repos.branches = seedRepo("branches");
  writeFileSync(join(repos.dirty, "dirty.txt"), "uncommitted\n");
  gitIn(repos.branches, ["branch", "merged"]);
  gitIn(repos.branches, ["checkout", "-q", "-b", "side"]);
  writeFileSync(join(repos.branches, "side.txt"), "side\n");
  gitIn(repos.branches, ["add", "side.txt"]);
  gitIn(repos.branches, ["commit", "-q", "-m", "fixture: side work"]);
  gitIn(repos.branches, ["checkout", "-q", "main"]);
});

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("git tool", () => {
  it("registers one tool named git", () => {
    assert.ok(gitTool, "the extension registers no tool named git");
  });

  it("runs a read subcommand and returns git's own exit status and stdout", async () => {
    const before = processStarts.count;
    const result = await call({
      sub: "rev-parse",
      args: ["HEAD"],
      cwd: repos.plain,
    });
    const head = gitIn(repos.plain, ["rev-parse", "HEAD"]).trim();

    assert.ok(
      processStarts.count > before,
      "the process counter is the instrument the refusal cases lean on, so it must move on a run",
    );

    assert.equal(result.details.exit, 0, textOf(result));
    assert.equal(textOf(result).includes(head), true, "stdout is missing HEAD");
    assert.equal(result.details.stdout_bytes, head.length + 1);
    assert.equal(result.details.wrote, false);
    assert.equal(result.details.truncated, false);
    assert.equal(result.details.refused, undefined);
  });

  it("refuses a subcommand outside the read set and names write: true", async () => {
    const before = processStarts.count;
    const result = await call({
      sub: "commit",
      args: ["-m", "no write flag"],
      cwd: repos.plain,
    });

    assert.equal(result.details.refused, "write-not-granted");
    assert.equal(result.details.exit, null);
    assert.match(textOf(result), /write: true/);
    assert.equal(
      processStarts.count,
      before,
      "a refused call must not start a process",
    );
  });

  it("refuses a write on a dirty tree and names the path", async () => {
    const before = gitIn(repos.dirty, ["rev-list", "--count", "HEAD"]).trim();
    const result = await call({
      sub: "commit",
      args: ["-m", "committed over a dirty tree"],
      cwd: repos.dirty,
      write: true,
    });

    assert.equal(result.details.refused, "dirty-tree");
    assert.equal(result.details.wrote, false);
    assert.match(textOf(result), /dirty\.txt/);
    assert.equal(
      gitIn(repos.dirty, ["rev-list", "--count", "HEAD"]).trim(),
      before,
      "the refused commit must not have landed",
    );
  });

  it("runs a write on a clean tree and the commit is visible to git log", async () => {
    const result = await call({
      sub: "commit",
      // The gate as specified refuses every mutating call on a tree carrying
      // any change, so the fixture commits nothing to stay on a clean tree.
      args: ["--allow-empty", "-m", "fixture: empty commit"],
      cwd: repos.clean,
      write: true,
    });

    assert.equal(result.details.exit, 0, textOf(result));
    assert.equal(result.details.wrote, true);
    assert.match(
      gitIn(repos.clean, ["log", "--format=%s", "-1"]).trim(),
      /fixture: empty commit/,
    );
  });

  it("refuses push --force, in both spellings, before starting anything", async () => {
    for (const flag of ["--force", "-f"]) {
      const before = processStarts.count;
      const result = await call({
        sub: "push",
        args: [flag, "origin", "main"],
        cwd: repos.plain,
        write: true,
      });

      assert.equal(result.details.refused, "push-force", `push ${flag}`);
      assert.equal(result.details.exit, null);
      assert.match(textOf(result), /force-push/);
      assert.equal(
        processStarts.count,
        before,
        "a refused call must not start a process",
      );
    }
  });

  it("refuses clean -fdx and clean -fd with a message for each", async () => {
    const ignored = await call({
      sub: "clean",
      args: ["-fdx"],
      cwd: repos.plain,
      write: true,
    });
    assert.equal(ignored.details.refused, "clean-forced-ignored");
    assert.match(textOf(ignored), /ignored files/);

    const directories = await call({
      sub: "clean",
      args: ["-fd"],
      cwd: repos.plain,
      write: true,
    });
    assert.equal(directories.details.refused, "clean-forced-directories");
    assert.match(textOf(directories), /untracked file/);
  });

  it("kills a process that outlives timeout_ms and says so", async () => {
    // A `git` earlier on PATH than the real one: the only way to hold the tool
    // inside a process this long without depending on a repository's size.
    const shimDir = join(ROOT, "shim");
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, "git");
    // A distinctive duration, so the process table names this sleeper and no
    // other: the survivor check below is what tells a group kill from a kill of
    // the leader alone.
    writeFileSync(shim, "#!/bin/sh\nsleep 37\n");
    chmodSync(shim, 0o755);

    const savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${savedPath}`;
    try {
      const started = Date.now();
      const result = await call({
        sub: "status",
        cwd: repos.plain,
        timeout_ms: 1000,
      });
      const elapsed = Date.now() - started;

      assert.equal(result.details.timed_out, true, textOf(result));
      assert.equal(result.details.timeout_ms, 1000);
      assert.ok(
        elapsed < 15_000,
        `the call returned after ${elapsed}ms, so the 37s shim was not killed`,
      );
      assert.match(textOf(result), /killed after 1000 ms/);
      assert.equal(
        survivors("sleep 37"),
        "",
        "the sleeper outlived the kill: the direct child was signalled, its own child was not",
      );
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("refuses a cwd outside the workspace and $HOME, naming the resolved path", async () => {
    const absolute = await call({ sub: "status", cwd: "/" });
    assert.equal(absolute.details.refused, "cwd-outside-workspace");
    assert.match(textOf(absolute), /cwd resolves to \/, which is outside/);

    const escaped = await call({
      sub: "status",
      cwd: "../../../../../../../..",
    });
    assert.equal(escaped.details.refused, "cwd-outside-workspace");
  });

  it("refuses reset --hard before starting anything", async () => {
    const before = processStarts.count;
    const result = await call({
      sub: "reset",
      args: ["--hard", "HEAD~1"],
      cwd: repos.plain,
      write: true,
    });

    assert.equal(result.details.refused, "reset-hard");
    assert.equal(processStarts.count, before);
  });

  it("refuses an argument carrying a shell metacharacter", async () => {
    const before = processStarts.count;
    const result = await call({
      sub: "log",
      args: ["--oneline; rm -rf /"],
      cwd: repos.plain,
    });

    assert.equal(result.details.refused, "shell-metacharacter");
    assert.match(textOf(result), /argv array/);
    assert.equal(
      processStarts.count,
      before,
      "a refused call must not start a process",
    );
  });

  it("keeps a read-set subcommand's shape honest: tag lists, tag -d writes", async () => {
    const listed = await call({ sub: "tag", cwd: repos.plain });
    assert.equal(listed.details.exit, 0, textOf(listed));
    assert.equal(listed.details.wrote, false);

    const deleted = await call({
      sub: "tag",
      args: ["-d", "v1.0.0"],
      cwd: repos.plain,
    });
    assert.equal(deleted.details.refused, "write-not-granted");
  });

  it("reads config only through its read flags", async () => {
    const read = await call({
      sub: "config",
      args: ["--get", "user.name"],
      cwd: repos.plain,
    });
    assert.equal(read.details.exit, 1, "an unset key exits 1, not 0");
    assert.equal(read.details.refused, undefined);

    const write = await call({
      sub: "config",
      args: ["user.name", "Fixture"],
      cwd: repos.plain,
    });
    assert.equal(write.details.refused, "write-not-granted");
  });

  it("truncates at max_output_bytes and reports the bytes and lines kept", async () => {
    const full = await call({
      sub: "log",
      args: ["--format=%H"],
      cwd: repos.bulky,
    });
    assert.equal(full.details.truncated, false);
    assert.equal(full.details.stdout_kept_bytes, full.details.stdout_bytes);

    const capped = await call({
      sub: "log",
      args: ["--format=%H"],
      cwd: repos.bulky,
      max_output_bytes: 1024,
    });

    assert.equal(capped.details.truncated, true);
    assert.equal(capped.details.max_output_bytes, 1024);
    assert.equal(capped.details.stdout_kept_bytes, 1024);
    assert.ok(
      capped.details.stdout_bytes > 1024,
      "the count is of what git wrote, not of what was kept",
    );
    assert.ok(capped.details.stdout_kept_lines > 0);
    assert.ok(capped.details.stdout_kept_lines < 40);
    assert.match(textOf(capped), /\[truncated: kept 1024 of \d+ stdout bytes/);
  });

  it("returns a non-zero exit instead of throwing", async () => {
    const result = await call({
      sub: "show",
      args: ["refs/heads/does-not-exist"],
      cwd: repos.plain,
    });

    assert.ok(typeof result.details.exit === "number");
    assert.notEqual(result.details.exit, 0);
    assert.ok(result.details.stderr_bytes > 0);
    assert.match(textOf(result), /fatal/);
  });

  it("refuses branch -D on an unmerged branch and deletes a merged one", async () => {
    const unmerged = await call({
      sub: "branch",
      args: ["-D", "side"],
      cwd: repos.branches,
      write: true,
    });
    assert.equal(unmerged.details.refused, "branch-delete-unmerged");
    assert.match(textOf(unmerged), /side/);
    assert.equal(
      gitIn(repos.branches, ["branch", "--list", "side"]).trim(),
      "side",
      "the refused deletion must leave the branch in place",
    );

    const merged = await call({
      sub: "branch",
      args: ["-D", "merged"],
      cwd: repos.branches,
      write: true,
    });
    assert.equal(merged.details.exit, 0, textOf(merged));
    assert.equal(merged.details.wrote, true);
    assert.equal(
      gitIn(repos.branches, ["branch", "--list", "merged"]).trim(),
      "",
      "the merged branch should be gone",
    );
  });
});
