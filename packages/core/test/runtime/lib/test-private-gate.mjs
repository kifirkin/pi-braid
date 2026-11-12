/**
 * test-private-gate.mjs: the private-data gate sees what it claims to see.
 *
 * Five arms, each with a planted positive, because a gate is only worth its
 * refusal: a clean run over a tree nobody polluted proves the scan can print
 * green, not that it can print red. Each arm drives the real script as a child
 * process against a throwaway repository it owns, so the arms are independent
 * of the state of the checkout they run in, and each planted literal is
 * assembled from fragments here for the same reason the pattern module does it:
 * the fixture is one of the files the gate scans.
 *
 *   1. the tree this gate lives in is clean, the census prints a population,
 *      and two runs over the same tree print the same bytes
 *   2. a planted home path in a tracked file: exit 1, the file and the pattern
 *      named, and the matched text itself never echoed into the report
 *   3. a planted path in a commit subject: exit 1 naming the short sha
 *   4. an identity that is neither a noreply alias nor allowlisted: exit 1 with
 *      the address printed. Control: the same commit authored by the noreply
 *      alias: exit 0. An identity rule that refuses everything is not a gate.
 *   5. an allowance covers the line it declares, is printed on a clean run, and
 *      cannot hide a second hit outside its range; an allowance that suppresses
 *      nothing fails the run
 *   6. (beyond the five) a tag annotation is read on a tag checkout, by `--tag`
 *      and by `GITHUB_REF_TYPE`/`GITHUB_REF_NAME`, while a lightweight tag
 *      carries no text to read
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, "../../..");
const REPO = join(CORE, "../..");
const SCRIPT = join(CORE, "scripts", "check-private-paths.mjs");

/** The literals the gate refuses, assembled so this file does not carry one. */
const PLANTED_HOME = ["", "Us" + "ers", "kif" + "ir"].join("/");
const PLANTED_TREE = ["projects", "vi" + "be", "implicit-" + "framing"].join("/");
const NOREPLY = "6573628+kifirkin@users.noreply.github.com";
const FOREIGN = "fixture-author@example.com";

/**
 * Run the gate. The CI variables are dropped so an arm that reads the tag
 * surface sees only what it asked for: a tag build exports them, and a scratch
 * repository has no tag under that name.
 */
function run(args, env = {}) {
  const clean = { ...process.env };
  delete clean.GITHUB_REF_TYPE;
  delete clean.GITHUB_REF_NAME;
  Object.assign(clean, env);
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: clean,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function gitIn(dir, args, env = {}) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

/** A repository of its own: identity configured, no history yet. */
function scratch(t, dir) {
  mkdirSync(dir, { recursive: true });
  gitIn(dir, ["init", "-q", "-b", "main"]);
  gitIn(dir, ["config", "user.name", "Fixture"]);
  gitIn(dir, ["config", "user.email", NOREPLY]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write `files` (path -> text), stage everything, commit, return the sha. */
function commitAll(dir, message, files, env = {}) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", message], env);
  return gitIn(dir, ["rev-parse", "HEAD"]);
}

// ── 1. the checkout this gate lives in ──────────────────────────────────────

test("the checkout is clean, the census prints a population, and two runs agree", () => {
  const first = run(["--cwd", REPO]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /check-private-paths: clean/);
  const tree = first.stdout.match(
    /tree: scanned (\d+) file\(s\) at (\S+) \((\d+) tracked, (\d+) untracked, \d+ unreadable\)/,
  );
  assert.ok(tree !== null, `the census names the tree population: ${first.stdout}`);
  assert.ok(Number(tree[1]) > 0, "the tree population is not empty");
  assert.ok(
    Number(tree[1]) === Number(tree[3]) + Number(tree[4]),
    "the scanned count is the tracked and untracked halves together",
  );
  assert.match(
    first.stdout,
    /history: \d+ commit\(s\) scanned in [0-9a-f]{7}\.\.HEAD \(base [^)]+\)/,
  );
  assert.match(first.stdout, /tag: none \(this checkout is not a tag\)/);

  const second = run(["--cwd", REPO]);
  assert.equal(second.stdout, first.stdout, "two runs over one tree print one report");
});

// ── 2. a planted path in a tracked file ─────────────────────────────────────

test("a home path in a tracked file is refused, and the report does not echo it", (t) => {
  const dir = scratch(t, mkdtempSync(join(tmpdir(), "private-gate-tree-")));
  commitAll(dir, "add a note", {
    "notes/fixture.md": `first line\nworkspace: ${PLANTED_HOME}/work\n`,
  });

  const result = run(["--cwd", dir]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /tree: notes\/fixture\.md: home-dir x1 \(first at line 2\)/);
  assert.ok(
    !result.stderr.includes(PLANTED_HOME),
    "the finding names the path, the pattern and the line, never the matched text",
  );
});

// ── 3. a planted path in a commit message ───────────────────────────────────

test("a path in a commit subject is refused, and the commit is named by sha", (t) => {
  const dir = scratch(t, mkdtempSync(join(tmpdir(), "private-gate-subject-")));
  const base = commitAll(dir, "initial", { "notes/clean.md": "clean\n" });
  commitAll(
    dir,
    `document the ${PLANTED_TREE} layout`,
    { "notes/clean.md": "clean, second version\n" },
  );
  const head = gitIn(dir, ["rev-parse", "--short", "HEAD"]);

  const result = run(["--cwd", dir, "--base", base]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    new RegExp(`history: ${head} subject: private-project-tree x1`),
    result.stderr,
  );
  assert.ok(!result.stderr.includes(PLANTED_TREE), "the message text is not echoed either");
});

// ── 4. an identity the allowlist does not cover ─────────────────────────────

test("a foreign commit address is refused and printed, while the noreply alias passes", (t) => {
  const dir = scratch(t, mkdtempSync(join(tmpdir(), "private-gate-author-")));
  const base = commitAll(dir, "initial", { "notes/clean.md": "clean\n" });

  commitAll(dir, "second", { "notes/clean.md": "second\n" }, { GIT_AUTHOR_EMAIL: FOREIGN });
  const refused = run(["--cwd", dir, "--base", base]);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(
    refused.stderr,
    new RegExp(
      `identity: [0-9a-f]+ author email ${FOREIGN} is neither a noreply alias nor an allowlisted address`,
    ),
    refused.stderr,
  );

  gitIn(dir, ["reset", "-q", "--hard", base]);
  commitAll(dir, "second", { "notes/clean.md": "second\n" }, { GIT_AUTHOR_EMAIL: NOREPLY });
  const allowed = run(["--cwd", dir, "--base", base]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /check-private-paths: clean/);
});

// ── 5. a declared allowance ────────────────────────────────────────────────

test("an allowance covers its declared line, is printed, and hides nothing else", (t) => {
  const dir = scratch(t, mkdtempSync(join(tmpdir(), "private-gate-allow-")));
  commitAll(dir, "add the fixture", {
    "fixtures/planted.md": `planted: ${PLANTED_HOME}/work\nsecond line\n`,
  });
  const allowancePath = join(dir, "allow.mjs");
  writeFileSync(
    allowancePath,
    `export const ALLOWANCES = [
  {
    file: "fixtures/planted.md",
    pattern: "home-dir",
    lines: [1, 1],
    reason: "a fixture whose subject is the gate's refusal",
  },
];
`,
  );

  const covered = run(["--cwd", dir, "--allowances", allowancePath]);
  assert.equal(covered.status, 0, covered.stderr);
  assert.match(
    covered.stdout,
    /allowance applied: fixtures\/planted\.md \[home-dir\] line 1 x1 \(a fixture whose subject is the gate's refusal\)/,
  );

  commitAll(dir, "plant a second one", {
    "fixtures/planted.md": `planted: ${PLANTED_HOME}/work\nsecond line\nagain: ${PLANTED_HOME}/tmp\n`,
  });
  const escaped = run(["--cwd", dir, "--allowances", allowancePath]);
  assert.equal(escaped.status, 1, escaped.stdout);
  assert.match(
    escaped.stderr,
    /tree: fixtures\/planted\.md: home-dir x1 \(first at line 3\)/,
    "a hit outside the declared range is still refused",
  );

  const stale = join(dir, "stale.mjs");
  writeFileSync(
    stale,
    `export const ALLOWANCES = [
  { file: "fixtures/planted.md", pattern: "home-dir", lines: [90, 91], reason: "the line moved" },
];
`,
  );
  const unmatched = run(["--cwd", dir, "--allowances", stale]);
  assert.equal(unmatched.status, 1, unmatched.stdout);
  assert.match(unmatched.stderr, /allowance: fixtures\/planted\.md \[home-dir\] suppresses nothing/);
});

// ── 6. the tag annotation ──────────────────────────────────────────────────

test("a tag annotation is read on a tag checkout, by flag or by CI variable", (t) => {
  const dir = scratch(t, mkdtempSync(join(tmpdir(), "private-gate-tag-")));
  commitAll(dir, "initial", { "notes/clean.md": "clean\n" });
  gitIn(dir, ["tag", "-a", "v9.9.9", "-m", `release notes for ${PLANTED_TREE}`]);
  gitIn(dir, ["tag", "lightweight"]);

  for (const [label, args, env] of [
    ["--tag", ["--tag", "v9.9.9"], {}],
    [
      "GITHUB_REF_TYPE",
      [],
      { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v9.9.9" },
    ],
  ]) {
    const result = run(["--cwd", dir, ...args], env);
    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    assert.match(
      result.stderr,
      /tag: v9\.9\.9 line 1: private-project-tree/,
      `${label}: ${result.stderr}`,
    );
    assert.ok(!result.stderr.includes(PLANTED_TREE), `${label}: the annotation text is not echoed`);
  }

  const lightweight = run(["--cwd", dir, "--tag", "lightweight"]);
  assert.equal(lightweight.status, 0, lightweight.stderr);
  assert.match(lightweight.stdout, /lightweight tag, so it carries no annotated message/);

  const missing = run(["--cwd", dir, "--tag", "v0.0.0"]);
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(missing.stderr, /cannot certify: --tag v0\.0\.0 names no tag/);
});
