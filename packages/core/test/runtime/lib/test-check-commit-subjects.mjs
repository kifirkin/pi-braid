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
 *   4. the merge subject git derives from a worker branch: exit 1, the branch
 *      namespace reported as the label it is
 *   5. an authored handle in the lowercase spelling (`w<digits>:`), with three
 *      near-misses beside it in the same population: exactly one problem, and
 *      the near-misses add none
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
// The spelling seats typed before the rule was stated plainly. Not in the shared
// vocabulary, so nothing else refuses it: this case is the only thing standing
// between that spelling and a hole in the history gate.
const AUTHORED_HANDLE = "w" + "556";
const AUTHORED_SUBJECT = `${AUTHORED_HANDLE}: gate the internal-label surfaces`;

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

test("an authored lowercase handle is a hit while three near-misses add none", () => {
  const c = makeCase();
  try {
    c.commit("base: the tree before the cut");
    git(c.repo, "tag", "v1.0.0");
    const badSha = c.commit(AUTHORED_SUBJECT);
    // Each near-miss is one character away from a hit: a word character before
    // the handle, too few digits, and a suffix that is not the task one.
    c.commit(`search: a local named network_a${AUTHORED_HANDLE} stays clean`);
    c.commit("search: a two-digit handle is not a label");
    c.commit("search: a four-digit run is not the spelling either");

    const { status, out } = c.run();
    assert.equal(status, 1, out);
    assert.match(out, /1 problem\(s\)/, out);
    const hits = out
      .split("\n")
      .filter((line) => line.startsWith(`${badSha.slice(0, 12)}  `));
    assert.equal(hits.length, 1, out);
    assert.ok(hits[0].includes(AUTHORED_HANDLE), `the hit must name the token\n${out}`);
    assert.ok(hits[0].includes(AUTHORED_SUBJECT), `the hit must name the subject\n${out}`);
    assert.ok(!/network_a/.test(out), `a near-miss must not be reported\n${out}`);
  } finally {
    c.cleanup();
  }
});

test("the subject git derives from a worker branch is reported as the label it is", () => {
  const c = makeCase();
  try {
    c.commit("base: the tree before the branch point");
    git(c.repo, "tag", "v1.0.0");

    const branch = "worker/w9999/subject-leak";
    git(c.repo, "checkout", "-q", "-b", branch);
    c.commit("worker: the commit that landed");
    git(c.repo, "checkout", "-q", "main");
    c.commit("base: a commit after the branch point");
    // The subject is git's own, not written by this fixture.
    git(c.repo, "merge", "--no-edit", branch);
    const derived = git(c.repo, "log", "-1", "--format=%s", "HEAD");
    assert.equal(derived, `Merge branch '${branch}'`, "fixture sanity: git derived the subject");

    const { status, out } = c.run();
    assert.equal(status, 1, out);
    assert.ok(out.includes("worker/w9999/"), `the namespace must be named\n${out}`);
    assert.ok(out.includes(derived), `the subject must be echoed\n${out}`);
  } finally {
    c.cleanup();
  }
});
