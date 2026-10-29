/**
 * check-commit-subjects.mjs — the history gate is shown red on a planted
 * subject, red on the subject git derives from a branch name, and green on a
 * range with nothing to report.
 *
 * The production gate reads the repository it is pointed at, so each case builds
 * a throwaway git tree and runs a copy of the gate against it through `--cwd`.
 * The real checkout is never touched, and the gate's `lib/label-tokens.mjs`
 * import comes along with the copy.
 *
 * The label tokens are composed at runtime, never written literally: the source
 * gate refuses them in files, and this fixture must not plant what it tests.
 *
 * Cases:
 *   1. clean at the tag: exit 0, one summary line naming the range and baseline
 *   2. a planted task label: exit 1, exactly one hit for the bad commit naming
 *      its sha, token and subject, with the clean commit beside it unreported;
 *      with the planted commit removed, the same tree is green
 *   3. no reachable tag: exit 1 with the reason, never a green line over a range
 *      nobody can name
 *   4. the merge subject git derives from a worker branch: exit 1, exactly one
 *      problem line, and the token it names is the bare handle the namespace
 *      carries
 *   5. a handle in the lowercase spelling (`w<digits>:`), with four near-misses
 *      beside it in the same population: exactly one problem, and the
 *      near-misses add none
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCRIPT = join(ROOT, "scripts", "check-commit-subjects.mjs");
const LIB = join(ROOT, "scripts", "lib", "label-tokens.mjs");

// Composed, never literal: the source gate refuses these tokens in files, the
// placement gate refuses a bare one in a string, and this fixture must not plant
// what it tests.
const LABEL_TOKEN = "W" + "123";
const LABEL_SUBJECT = `${LABEL_TOKEN}: tighten the retry path`;
const CLEAN_SUBJECT = "retry: the backoff names the failure it waits for";
// The lowercase spelling of the same label. The shared vocabulary covers either
// case, so the source gate refuses this one in files and this gate refuses it in
// subjects; the case proves the history surface reads the spelling.
const LOWERCASE_HANDLE = "w" + "556";
const LOWERCASE_SUBJECT = `${LOWERCASE_HANDLE}: gate the internal-label surfaces`;
// A worker branch carries the bare handle and git derives the merge subject from
// it. Three digits, like every task label, and composed for the same reason.
const BRANCH_HANDLE = "w" + "999";
const MERGE_BRANCH = `worker/${BRANCH_HANDLE}/subject-leak`;
// One boundary away from a hit on each side: a leading word character, a short
// digit run, a long one, and a calendar week that only looks like a label.
const TWO_DIGIT_RUN = "w" + "55";
const FOUR_DIGIT_RUN = "w" + "5566";
const CALENDAR_WEEK = "2026-W" + "35";
const NEAR_MISSES = [
  `search: a local named network_a${LOWERCASE_HANDLE} stays clean`,
  `search: a two-digit run ${TWO_DIGIT_RUN} is not a handle`,
  `search: a four-digit run ${FOUR_DIGIT_RUN} is not the spelling either`,
  `search: the calendar week ${CALENDAR_WEEK} is not a label`,
];

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

/** A throwaway tree holding a copy of the gate beside an empty git repository. */
function makeCase() {
  const tree = mkdtempSync(join(tmpdir(), "commit-subject-gate-"));
  const scripts = join(tree, "scripts");
  mkdirSync(join(scripts, "lib"), { recursive: true });
  cpSync(SCRIPT, join(scripts, "check-commit-subjects.mjs"));
  cpSync(LIB, join(scripts, "lib", "label-tokens.mjs"));

  const repo = join(tree, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "gate@example.com");
  git(repo, "config", "user.name", "gate");
  git(repo, "config", "commit.gpgsign", "false");

  let counter = 0;
  return {
    repo,
    /** Commit one file; returns the full sha of the new commit. */
    commit(subject) {
      counter += 1;
      const file = join(repo, `file-${counter}.txt`);
      writeFileSync(file, `${subject}\n`);
      git(repo, "add", "--", file);
      git(repo, "commit", "-q", "-m", subject);
      return git(repo, "rev-parse", "HEAD");
    },
    run() {
      const r = spawnSync(
        "node",
        [join(scripts, "check-commit-subjects.mjs"), "--cwd", repo],
        { encoding: "utf8" },
      );
      return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
    cleanup() {
      rmSync(tree, { recursive: true, force: true });
    },
  };
}

test("clean at the tag: the range is empty and the summary names it", () => {
  const c = makeCase();
  try {
    c.commit("base: the tree before the cut");
    git(c.repo, "tag", "v1.0.0");
    const { status, out } = c.run();
    assert.equal(status, 0, out);
    assert.match(out, /check-commit-subjects: clean: 0 hits in 0 commit\(s\)/, out);
    assert.match(out, /range v1\.0\.0\.\.HEAD/, out);
    assert.match(out, /baseline v1\.0\.0, head [0-9a-f]{12}/, out);
  } finally {
    c.cleanup();
  }
});

test("a planted task label is one hit naming sha, token and subject; removed, the tree is green", () => {
  const c = makeCase();
  try {
    c.commit("base: the tree before the cut");
    git(c.repo, "tag", "v1.0.0");
    const cleanTip = git(c.repo, "rev-parse", "HEAD");
    const badSha = c.commit(LABEL_SUBJECT);
    const goodSha = c.commit(CLEAN_SUBJECT);

    const { status, out } = c.run();
    assert.equal(status, 1, out);
    const hits = out
      .split("\n")
      .filter((line) => line.startsWith(`${badSha.slice(0, 12)}  `));
    assert.equal(hits.length, 1, out);
    assert.ok(hits[0].includes(LABEL_TOKEN), `the hit must name the token\n${out}`);
    assert.ok(hits[0].includes(LABEL_SUBJECT), `the hit must name the subject\n${out}`);
    assert.match(out, /1 problem\(s\)/, out);
    // The clean commit is HEAD, so its sha legitimately appears in the summary's
    // `head` field: only a problem line would make it reported.
    const goodLines = out
      .split("\n")
      .filter((line) => line.startsWith(`${goodSha.slice(0, 12)}  `));
    assert.equal(goodLines.length, 0, `a clean subject must not be reported\n${out}`);

    // The reset below is what proves the red was the subject and not the tree:
    // the same tree goes green once the planted commit is gone.
    git(c.repo, "reset", "--hard", cleanTip);
    const after = c.run();
    assert.equal(after.status, 0, after.out);
    assert.match(after.out, /clean: 0 hits in 0 commit\(s\)/, after.out);
  } finally {
    c.cleanup();
  }
});

test("no reachable tag: exit 1 with the reason, never a green line over an unnamed range", () => {
  const c = makeCase();
  try {
    c.commit("base: the tree before the cut");
    const { status, out } = c.run();
    assert.equal(status, 1, out);
    assert.match(out, /no reachable tag/, out);
    assert.match(out, /cannot certify a commit range/, out);
    assert.ok(!/clean:/.test(out), `a tagless tree must not print a clean line\n${out}`);
  } finally {
    c.cleanup();
  }
});

test("a lowercase handle is a hit in the shared vocabulary while four near-misses add none", () => {
  const c = makeCase();
  try {
    c.commit("base: the tree before the cut");
    git(c.repo, "tag", "v1.0.0");
    const badSha = c.commit(LOWERCASE_SUBJECT);
    for (const subject of NEAR_MISSES) c.commit(subject);

    const { status, out } = c.run();
    assert.equal(status, 1, out);
    assert.match(out, /1 problem\(s\)/, out);
    const hits = out
      .split("\n")
      .filter((line) => line.startsWith(`${badSha.slice(0, 12)}  `));
    assert.equal(hits.length, 1, out);
    assert.ok(hits[0].includes(LOWERCASE_HANDLE), `the hit must name the token\n${out}`);
    assert.ok(hits[0].includes(LOWERCASE_SUBJECT), `the hit must name the subject\n${out}`);
    for (const subject of NEAR_MISSES) {
      assert.ok(!out.includes(subject), `a near-miss must not be reported\n${out}`);
    }
  } finally {
    c.cleanup();
  }
});

test("the subject git derives from a worker branch is reported once as the bare handle", () => {
  const c = makeCase();
  try {
    c.commit("base: the tree before the branch point");
    git(c.repo, "tag", "v1.0.0");

    git(c.repo, "checkout", "-q", "-b", MERGE_BRANCH);
    c.commit("worker: the commit that landed");
    git(c.repo, "checkout", "-q", "main");
    c.commit("base: a commit after the branch point");
    // The subject is git's own, not written by this fixture.
    git(c.repo, "merge", "--no-edit", MERGE_BRANCH);
    const derived = git(c.repo, "log", "-1", "--format=%s", "HEAD");
    assert.equal(derived, `Merge branch '${MERGE_BRANCH}'`, "fixture sanity: git derived the subject");

    const { status, out } = c.run();
    assert.equal(status, 1, out);
    const problems = out.split("\n").filter((line) => /^[0-9a-f]{12} {2}/.test(line));
    assert.equal(problems.length, 1, `one subject, one problem line\n${out}`);
    assert.ok(
      problems[0].includes(`  ${BRANCH_HANDLE}  `),
      `the reported token is the bare handle, not the namespace\n${out}`,
    );
    assert.ok(problems[0].endsWith(derived), `the subject must be echoed\n${out}`);
  } finally {
    c.cleanup();
  }
});
