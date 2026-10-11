/**
 * test-tag-prerelease.mjs — the tag path, exercised against throwaway repos.
 *
 * Every refusal is a state a tag must not be written from, and each case
 * asserts the same two things: a non-zero exit whose message names the reason,
 * and no tag left on the repo. The happy path asserts the tag is annotated,
 * points at HEAD, and left no commit or manifest edit behind it. No case ever
 * runs against the repository under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "../../../scripts/tag-prerelease.mjs");
const MANIFEST = JSON.stringify({ name: "fixture", version: "0.40.0" }, null, 2) + "\n";

/** Run a git command in `cwd`, trimmed; "" when git fails. */
function sh(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

/** A throwaway repo holding packages/core/package.json, committed once. */
function fixtureRepo(manifest = MANIFEST) {
  const dir = mkdtempSync(join(tmpdir(), "tag-prerelease-"));
  sh("git init -q -b main", dir);
  sh("git config user.email test@test.local", dir);
  sh("git config user.name test", dir);
  mkdirSync(join(dir, "packages", "core"), { recursive: true });
  writeFileSync(join(dir, "packages", "core", "package.json"), manifest);
  sh("git add -A", dir);
  sh("git commit -qm init", dir);
  return dir;
}

function runTag(repo, args = []) {
  const result = spawnSync("node", [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function tags(repo) {
  return sh("git tag --list", repo).split("\n").filter(Boolean);
}

test("a clean main at base 0.40.0 gets the annotated iteration tag", () => {
  const repo = fixtureRepo();
  const pkgPath = join(repo, "packages", "core", "package.json");
  const headBefore = sh("git rev-parse HEAD", repo);
  const manifestBefore = readFileSync(pkgPath, "utf8");

  const { code, out } = runTag(repo);
  assert.equal(code, 0, out);
  assert.match(out, /created annotated tag v0\.40\.0-main\.0/);

  assert.deepEqual(tags(repo), ["v0.40.0-main.0"]);
  assert.equal(sh("git cat-file -t v0.40.0-main.0", repo), "tag", "the tag must be annotated");
  assert.equal(sh("git rev-parse v0.40.0-main.0^{commit}", repo), headBefore, "tag must point at HEAD");
  assert.equal(sh("git rev-parse HEAD", repo), headBefore, "no commit may be created");
  assert.equal(readFileSync(pkgPath, "utf8"), manifestBefore, "package.json must not change");
  assert.match(sh("git tag -n1 -l v0.40.0-main.0", repo), /fixture 0\.40\.0-main\.0/);
});

test("the tag carries the sanitized branch and its commit count", () => {
  const repo = fixtureRepo();
  sh("git checkout -qb feature/ctx-budget", repo);
  writeFileSync(join(repo, "packages", "core", "note.txt"), "work\n");
  sh("git add -A", repo);
  sh("git commit -qm work", repo);

  const { code } = runTag(repo);
  assert.equal(code, 0);
  assert.deepEqual(tags(repo), ["v0.40.0-feature-ctx-budget.1"]);
});

test("refuses when the tag already exists", () => {
  const repo = fixtureRepo();
  assert.equal(runTag(repo).code, 0);

  const second = runTag(repo);
  assert.equal(second.code, 1);
  assert.match(second.err, /refusing: tag v0\.40\.0-main\.0 already exists/);
  assert.deepEqual(tags(repo), ["v0.40.0-main.0"]);
});

test("refuses a tree with an untracked file", () => {
  const repo = fixtureRepo();
  writeFileSync(join(repo, "packages", "core", "note.txt"), "uncommitted\n");

  const { code, err } = runTag(repo);
  assert.equal(code, 1);
  assert.match(err, /the tree is dirty/);
  assert.match(err, /note\.txt/);
  assert.deepEqual(tags(repo), []);
});

test("refuses a tree with a modified tracked file", () => {
  const repo = fixtureRepo();
  const pkgPath = join(repo, "packages", "core", "package.json");
  writeFileSync(pkgPath, MANIFEST.replace("0.40.0", "0.40.1"));

  const { code, err } = runTag(repo);
  assert.equal(code, 1);
  assert.match(err, /M packages\/core\/package\.json/);
  assert.deepEqual(tags(repo), []);
});

test("refuses a detached HEAD", () => {
  const repo = fixtureRepo();
  sh("git checkout -q --detach HEAD", repo);

  const { code, err } = runTag(repo);
  assert.equal(code, 1);
  assert.match(err, /refusing: HEAD is detached/);
  assert.deepEqual(tags(repo), []);
});

test("refuses a version that does not sort above the highest tag", () => {
  const repo = fixtureRepo();
  sh("git tag -a v9.9.9 -m future", repo);

  const { code, err } = runTag(repo);
  assert.equal(code, 1);
  assert.match(err, /does not sort strictly above the highest existing tag v9\.9\.9/);
  assert.deepEqual(tags(repo), ["v9.9.9"]);
});

test("refuses a base that is not a version", () => {
  const repo = fixtureRepo(JSON.stringify({ name: "fixture", version: "not-a-version" }) + "\n");

  const { code, err } = runTag(repo);
  assert.equal(code, 1);
  assert.match(err, /not valid semver/);
  assert.deepEqual(tags(repo), []);
});

test("refuses an unreadable manifest with a message, not a stack trace", () => {
  const repo = fixtureRepo("not json at all\n");

  const { code, err } = runTag(repo);
  assert.equal(code, 1);
  assert.match(err, /cannot read a version from/);
  assert.ok(!err.includes("SyntaxError"), err);
  assert.deepEqual(tags(repo), []);
});

test("refuses outside a git work tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "tag-prerelease-norepo-"));

  const { code, err } = runTag(dir);
  assert.equal(code, 1);
  assert.match(err, /not inside a git work tree/);
});

test("refuses an unknown package name", () => {
  const repo = fixtureRepo();

  const { code, err } = runTag(repo, ["telegram"]);
  assert.equal(code, 1);
  assert.match(err, /unknown package "telegram"/);
  assert.deepEqual(tags(repo), []);
});
