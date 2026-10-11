/**
 * test-version-derivation.mjs — one derivation, and the cases it must get
 * right.
 *
 * The publish path and the tag path have to name the same version for the same
 * tree, so the rules live in one module. This pins the rules as a pure
 * function, the git reads behind them against throwaway repos (a branch level
 * with main, a branch with slashes, a detached HEAD, a repo with no main line),
 * and the structural fact that keeps the two paths from drifting: the publish
 * path carries the import, not a copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveVersion,
  deriveVersionFor,
  readVersionInputs,
  sanitizeBranch,
} from "../../../scripts/lib/version-derivation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "../../../scripts");
const BASE = "0.40.0";
const MANIFEST = JSON.stringify({ name: "fixture", version: BASE }) + "\n";

/** Run a git command in `cwd`, trimmed; "" when git fails. */
function sh(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

/** A throwaway repo holding packages/core/package.json, committed once. */
function fixtureRepo(branch) {
  const dir = mkdtempSync(join(tmpdir(), "version-derivation-"));
  sh(`git init -q -b ${branch}`, dir);
  sh("git config user.email test@test.local", dir);
  sh("git config user.name test", dir);
  mkdirSync(join(dir, "packages", "core"), { recursive: true });
  writeFileSync(join(dir, "packages", "core", "package.json"), MANIFEST);
  sh("git add -A", dir);
  sh("git commit -qm init", dir);
  return dir;
}

test("sanitizeBranch: a slash becomes a dash, the rest survives", () => {
  assert.equal(sanitizeBranch("feature/ctx-budget"), "feature-ctx-budget");
  assert.equal(sanitizeBranch("main"), "main");
  assert.equal(sanitizeBranch("release-1.2"), "release-1.2");
  assert.equal(sanitizeBranch("wip@2"), "wip-2");
  assert.equal(sanitizeBranch(""), "");
});

test("deriveVersion: base, sanitized branch, iteration", () => {
  assert.equal(
    deriveVersion({ base: BASE, branch: "feature/x", iterations: "7" }),
    "0.40.0-feature-x.7",
  );
  assert.equal(deriveVersion({ base: BASE, branch: "main", iterations: "0" }), "0.40.0-main.0");
  assert.equal(deriveVersion({ base: BASE, branch: "", iterations: "3" }), "0.40.0-detached.3");
});

test("deriveVersion: a base that already carries a prerelease comes back verbatim", () => {
  assert.equal(
    deriveVersion({ base: "0.40.0-main.3", branch: "main", iterations: "9" }),
    "0.40.0-main.3",
  );
});

test("zero commits: a branch level with main derives iteration 0", () => {
  const pkgDir = join(fixtureRepo("main"), "packages", "core");
  assert.deepEqual(readVersionInputs(pkgDir, sh), { branch: "main", iterations: "0" });
  assert.equal(deriveVersionFor({ base: BASE, pkgDir, sh }).version, "0.40.0-main.0");
});

test("a branch with slashes keeps its commit count and loses its slash", () => {
  const repo = fixtureRepo("main");
  sh("git checkout -qb feature/ctx-budget", repo);
  writeFileSync(join(repo, "packages", "core", "note.txt"), "work\n");
  sh("git add -A", repo);
  sh("git commit -qm work", repo);

  const derived = deriveVersionFor({ base: BASE, pkgDir: join(repo, "packages", "core"), sh });
  // The branch component is the sanitized one everywhere: it is what the
  // version and the tag carry, and what the publish path prints.
  assert.equal(derived.branch, "feature-ctx-budget");
  assert.equal(derived.iterations, "1");
  assert.equal(derived.version, "0.40.0-feature-ctx-budget.1");
});

test("a detached HEAD derives the literal HEAD git answers with", () => {
  const repo = fixtureRepo("main");
  sh("git checkout -q --detach HEAD", repo);

  const derived = deriveVersionFor({ base: BASE, pkgDir: join(repo, "packages", "core"), sh });
  assert.equal(derived.branch, "HEAD");
  assert.equal(derived.version, "0.40.0-HEAD.0");
});

test("a repo with no main line falls back to the short sha", () => {
  const repo = fixtureRepo("trunk");
  const pkgDir = join(repo, "packages", "core");

  const { iterations } = readVersionInputs(pkgDir, sh);
  assert.equal(iterations, sh("git rev-parse --short HEAD", repo));
  assert.match(deriveVersionFor({ base: BASE, pkgDir, sh }).version, /^0\.40\.0-trunk\.[0-9a-f]{7,}$/);
});

test("no repository at all: the branch falls back to detached", () => {
  const silent = () => "";
  assert.deepEqual(readVersionInputs(process.cwd(), silent), {
    branch: "detached",
    iterations: "0",
  });
  assert.equal(deriveVersion({ base: BASE, branch: "detached", iterations: "0" }), "0.40.0-detached.0");
});

test("publish-local.mjs imports the rules instead of keeping a copy", () => {
  const source = readFileSync(join(SCRIPTS, "publish-local.mjs"), "utf8");
  assert.match(source, /from "\.\/lib\/version-derivation\.mjs"/);
  assert.match(source, /deriveVersionFor\(/);

  // The two literals the rules are made of: the sanitizing character class and
  // the prerelease test on a base. Either one here means a second copy of the
  // rules has appeared, and the tarball and the tag can drift apart again.
  assert.ok(!source.includes("[^a-zA-Z0-9.-]"), "publish-local.mjs sanitizes a branch again");
  assert.ok(
    !source.includes("\\d+\\.\\d+\\.\\d+-"),
    "publish-local.mjs tests a base for a prerelease again",
  );
});

test("the tag path and the release check read the same module", () => {
  for (const name of ["tag-prerelease.mjs", "check-release.mjs"]) {
    const source = readFileSync(join(SCRIPTS, name), "utf8");
    assert.match(
      source,
      /from "\.\/lib\/version-derivation\.mjs"/,
      `${name} must derive from the shared module`,
    );
  }
});
