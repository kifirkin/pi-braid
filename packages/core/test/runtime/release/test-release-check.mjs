/**
 * test-release-check.mjs — the tag and the manifest, checked from both sides.
 *
 * The check has to fail on a tag that matches no manifest and no derivation, on
 * a lightweight tag, on an iteration tag whose release already happened, and on
 * a tree whose derived version sits below a tag that exists; and it has to pass
 * on the states the release flow actually produces. The precedence cases pin
 * the semver rules the ordering rests on, each with its expected sign.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, isValidVersion, parseVersion } from "../../../scripts/lib/semver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "../../../scripts/check-release.mjs");

/** Run a git command in `cwd`, trimmed; "" when git fails. */
function sh(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function writeManifest(repo, dirName, name, version) {
  const dir = join(repo, "packages", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }, null, 2) + "\n");
}

function commitAll(repo, message) {
  sh("git add -A", repo);
  sh(`git commit -qm "${message}"`, repo);
}

/** A throwaway repo with packages/core at `core`, plus any extra packages. */
function fixture({ core = "0.40.0", extra = {} } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "release-check-"));
  sh("git init -q -b main", repo);
  sh("git config user.email test@test.local", repo);
  sh("git config user.name test", repo);
  writeManifest(repo, "core", "pi-braid", core);
  for (const [dirName, version] of Object.entries(extra)) {
    writeManifest(repo, dirName, `pi-braid-${dirName}`, version);
  }
  commitAll(repo, "init");
  return repo;
}

/** The state a released base leaves behind: the tag on the fixture commit, then a commit that moves on. */
function releasedBase(repo, from, to) {
  sh(`git tag -a v${from} -m "pi-braid ${from}"`, repo);
  writeManifest(repo, "core", "pi-braid", to);
  commitAll(repo, "base moves on");
}

function run(repo, args = []) {
  const result = spawnSync("node", [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

// ── precedence, the rule the ordering rests on ──────────────────────────────

test("precedence follows semver.org 2.0.0 rules 10, 11.3 and 11.4", () => {
  const cases = [
    // expected, left, right
    [-1, "0.40.0-main.3", "0.40.0", "a prerelease sorts below the release it precedes"],
    [-1, "0.39.0", "0.40.0-main.3", "the base release is above the previous release"],
    [1, "0.40.0-main.10", "0.40.0-main.3", "numeric identifiers compare numerically, not by text"],
    [1, "0.40.0", "0.40.0-rc.1", "a release sorts above its own prerelease"],
    [-1, "0.40.0-alpha", "0.40.0-alpha.1", "a larger identifier set wins when all preceding match"],
    [-1, "0.40.0-alpha.1", "0.40.0-alpha.beta", "numeric identifiers sort below alphanumeric"],
    [-1, "0.40.0-alpha", "0.40.0-beta", "alphanumeric identifiers compare in ASCII order"],
    [1, "0.40.1", "0.40.0", "patch outranks nothing else"],
    [0, "0.40.0+build.1", "0.40.0+build.2", "build metadata is ignored"],
    [0, "0.40.0", "0.40.0", "identical versions are equal"],
  ];

  for (const [expected, left, right, why] of cases) {
    assert.equal(compareVersions(left, right), expected, `${left} vs ${right}: ${why}`);
    // `-expected` is -0 for the equal case, which assert.equal would reject.
    const reversed = expected === 0 ? 0 : -expected;
    assert.equal(compareVersions(right, left), reversed, `${right} vs ${left}: ${why}`);
  }
});

test("a version has to be a version", () => {
  assert.ok(isValidVersion("0.40.0"));
  assert.ok(isValidVersion("0.40.0-main.3"));
  assert.equal(parseVersion("v0.40.0"), null, "the v prefix belongs to the tag, not the version");
  assert.equal(parseVersion("0.40"), null);
  assert.equal(parseVersion("0.40.0-"), null);
  assert.equal(parseVersion("0.40.0-main..3"), null);
  assert.equal(parseVersion("00.40.0"), null, "a numeric identifier carries no leading zero");
  assert.equal(parseVersion("0.40.0-main.03"), null);
});

// ── the states the release flow produces ────────────────────────────────────

test("clean: an untagged tree whose derived version sorts above the highest tag", () => {
  const repo = fixture({ core: "0.39.0" });
  sh("git tag -a v0.39.0 -m 'pi-braid 0.39.0'", repo);
  writeManifest(repo, "core", "pi-braid", "0.40.0");
  commitAll(repo, "base moves on");

  const { code, out } = run(repo);
  assert.equal(code, 0, out);
  assert.match(out, /ordering: 0\.39\.0 < 0\.40\.0-main\.0/);
});

test("clean: an annotated release tag that matches the manifest", () => {
  const repo = fixture({ core: "0.39.0" });
  releasedBase(repo, "0.39.0", "0.40.0");
  sh("git tag -a v0.40.0 -m 'pi-braid 0.40.0'", repo);

  const { code, out } = run(repo);
  assert.equal(code, 0, out);
  assert.match(out, /v0\.40\.0: annotated, matches pi-braid 0\.40\.0/);
  assert.match(out, /ordering: 0\.39\.0 < 0\.40\.0/);
});

test("clean: the iteration tag the derivation produces at HEAD", () => {
  const repo = fixture({ core: "0.39.0" });
  releasedBase(repo, "0.39.0", "0.40.0");
  sh("git tag -a v0.40.0-main.0 -m 'pi-braid 0.40.0-main.0'", repo);

  const { code, out } = run(repo);
  assert.equal(code, 0, out);
  assert.match(out, /v0\.40\.0-main\.0: annotated, the iteration version this tree derives/);
  assert.match(out, /ordering: 0\.39\.0 < 0\.40\.0-main\.0 < 0\.40\.0/);
});

test("clean: a manifest that already carries the full iteration string", () => {
  const repo = fixture({ core: "0.39.0" });
  sh("git tag -a v0.39.0 -m 'pi-braid 0.39.0'", repo);
  writeManifest(repo, "core", "pi-braid", "0.40.0-main.3");
  commitAll(repo, "release prep");
  sh("git tag -a v0.40.0-main.3 -m 'pi-braid 0.40.0-main.3'", repo);

  const { code, out } = run(repo);
  assert.equal(code, 0, out);
  assert.match(out, /v0\.40\.0-main\.3: annotated, matches pi-braid 0\.40\.0-main\.3/);
});

// ── the states it must refuse ───────────────────────────────────────────────

test("fails: a lightweight tag at HEAD", () => {
  const repo = fixture({ core: "0.39.0" });
  releasedBase(repo, "0.39.0", "0.40.0");
  sh("git tag v0.40.0", repo);

  const { code, err } = run(repo);
  assert.equal(code, 1);
  assert.match(err, /v0\.40\.0: lightweight tag; an annotated tag is required/);
});

test("fails: a tag no manifest holds and no derivation produces", () => {
  const repo = fixture({ core: "0.39.0" });
  releasedBase(repo, "0.39.0", "0.40.0");
  sh("git tag -a v0.40.0-main.7 -m 'pi-braid 0.40.0-main.7'", repo);

  const { code, err } = run(repo);
  assert.equal(code, 1);
  assert.match(err, /v0\.40\.0-main\.7: no workspace manifest holds version "0\.40\.0-main\.7"/);
  assert.match(err, /not the iteration version this tree derives \(0\.40\.0-main\.0\)/);
});

test("fails: an iteration tag whose base release happened on another commit", () => {
  const repo = fixture({ core: "0.39.0" });
  releasedBase(repo, "0.39.0", "0.40.0");
  sh("git tag -a v0.40.0 -m 'pi-braid 0.40.0'", repo);
  writeFileSync(join(repo, "packages", "core", "note.txt"), "more work\n");
  commitAll(repo, "more work");
  sh("git tag -a v0.40.0-main.0 -m 'pi-braid 0.40.0-main.0'", repo);

  const { code, err } = run(repo);
  assert.equal(code, 1);
  assert.match(err, /its base release v0\.40\.0 was already tagged on another commit/);
});

test("fails: a tree whose derived version sits below a tag that exists", () => {
  const repo = fixture({ core: "0.38.0" });
  sh("git tag -a v0.39.0 -m 'pi-braid 0.39.0'", repo);

  const { code, err } = run(repo);
  assert.equal(code, 1);
  assert.match(
    err,
    /0\.38\.0-main\.0: the version derived for this tree sorts at or below the highest existing tag v0\.39\.0/,
  );
});

test("fails: a tag on another version line sorting above this one", () => {
  // One tag namespace, three version lines: the check compares a derived
  // version against every `v*` tag, so a line that has moved above this one
  // reads as a tag this tree has already passed. The consequence is recorded
  // in the report; this pins the behaviour so a change to it is deliberate.
  const repo = fixture({ core: "0.40.0", extra: { providers: "1.0.0" } });
  sh("git tag -a v1.0.0 -m 'pi-braid-providers 1.0.0'", repo);

  const { code, err } = run(repo);
  assert.equal(code, 1);
  assert.match(err, /sorts at or below the highest existing tag v1\.0\.0/);
});

test("a package argument reads that package's manifest", () => {
  const repo = fixture({ core: "0.40.0", extra: { providers: "1.0.0" } });
  sh("git tag -a v1.0.0 -m 'pi-braid-providers 1.0.0'", repo);

  const { code, out } = run(repo, ["providers"]);
  assert.equal(code, 0, out);
  assert.match(out, /package=pi-braid-providers version=1\.0\.0 \(packages\/providers\/package\.json\)/);
});

test("fails: a manifest version that is not valid semver", () => {
  const repo = fixture({ core: "not-a-version" });

  const { code, err } = run(repo);
  assert.equal(code, 1);
  assert.match(err, /packages\/core\/package\.json: version "not-a-version" is not valid semver/);
});

test("usage error: not inside a git work tree, and unknown package", () => {
  const outside = mkdtempSync(join(tmpdir(), "release-check-norepo-"));
  const noRepo = run(outside);
  assert.equal(noRepo.code, 2);
  assert.match(noRepo.err, /not inside a git work tree/);

  const repo = fixture();
  const unknown = run(repo, ["telegram"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /no package\.json at packages\/telegram\/package\.json/);
});
