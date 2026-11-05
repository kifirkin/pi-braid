/**
 * Test: a prepared worktree resolves what the primary resolves.
 *
 * The failure this pins: a detached worktree carries source only. The primary
 * has a root `node_modules` and, in this repo, package-local installs (the
 * providers package carries its own typescript). A chain that spawns a
 * package-local binary then fails with MODULE_NOT_FOUND in the worktree, and a
 * worker reads that as "the branch is broken". Three workers did exactly that
 * in one day.
 *
 * 1. The script links the package-local install and the dependency resolves from
 *    the package directory in the worktree.
 * 2. The control: the same ref checked out by plain `git worktree add` does NOT
 *    resolve it, so the script is what makes the difference and not the
 *    environment it ran in.
 * 3. A second run on a prepared worktree keeps it usable and does not double-link.
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "..", "..", "scripts", "prepare-worktree.mjs");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
    encoding: "utf-8",
  });
}

function primaryRepo() {
  const repo = mkdtempSync(join(tmpdir(), "prepare-worktree-"));
  mkdirSync(join(repo, "packages", "alpha"), { recursive: true });
  writeFileSync(join(repo, "packages", "alpha", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true }), "utf-8");
  git(repo, "init", "--quiet");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "fixture");

  // An install that exists only in the working tree, the way npm leaves a
  // package-local dependency behind: not tracked, present on disk.
  const installed = join(repo, "packages", "alpha", "node_modules", "alpha-dep");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "alpha-dep", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(installed, "index.js"), "module.exports = 42;\n");
  return repo;
}

function resolves(cwd, name) {
  const r = spawnSync(process.execPath, ["-e", "require.resolve(process.argv[1])", name], { cwd, encoding: "utf-8" });
  return r.status === 0;
}

function prepare(repo, path) {
  return spawnSync(process.execPath, [SCRIPT, "--path", path, "--ref", "HEAD", "--primary", repo], { encoding: "utf-8" });
}

test("the script links the package-local install and it resolves there", () => {
  const repo = primaryRepo();
  const prepared = join(mkdtempSync(join(tmpdir(), "prepare-wt-")), "wt");
  const run = prepare(repo, prepared);
  assert.equal(run.status, 0, `script exits 0: ${run.stdout}${run.stderr}`);
  const link = join(prepared, "packages", "alpha", "node_modules");
  assert.ok(existsSync(link), "the package-local node_modules is linked");
  assert.ok(lstatSync(link).isSymbolicLink(), "the link is a symlink, not a copy");
  assert.ok(resolves(join(prepared, "packages", "alpha"), "alpha-dep"), "the dependency resolves in the worktree");
  assert.match(run.stdout, /1 link\(s\) made, 1 probed by resolution/, "the run names its own population");
});

test("the control: a plain worktree does not resolve it", () => {
  const repo = primaryRepo();
  const bare = join(mkdtempSync(join(tmpdir(), "prepare-bare-")), "wt");
  git(repo, "worktree", "add", bare, "HEAD");
  assert.equal(
    resolves(join(bare, "packages", "alpha"), "alpha-dep"),
    false,
    "without the script the dependency is missing: the script, not the machine, is what fixes it",
  );
});

test("a second run finds the worktree, makes no new link, and leaves it usable", () => {
  const repo = primaryRepo();
  const prepared = join(mkdtempSync(join(tmpdir(), "prepare-again-")), "wt");
  assert.equal(prepare(repo, prepared).status, 0, "first run");
  const again = prepare(repo, prepared);
  assert.equal(again.status, 0, `second run exits 0: ${again.stdout}${again.stderr}`);
  assert.match(again.stdout, /already holds a worktree/, "the second run says what it found instead of re-adding");
  assert.match(again.stdout, /0 link\(s\) made/, "the second run makes no new link");
  assert.ok(resolves(join(prepared, "packages", "alpha"), "alpha-dep"), "and the worktree still resolves");
});
