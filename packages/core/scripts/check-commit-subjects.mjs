#!/usr/bin/env node
/**
 * check-commit-subjects — the history surface of the internal-label rule.
 *
 * Why this exists: internal labels belong in a branch name and a report's
 * filename, never in a commit subject, because the subject is the part of a
 * commit a future reader keeps and a reader without the brief cannot resolve
 * what a label points at. The file surface has a gate (`check-labels.mjs`); the
 * subject surface had none, and the rule drifted against itself in the one
 * place both statements were written. Git generates a merge subject from the
 * branch name ("Merge branch 'worker/<handle>/<slug>'"), so every merge out of
 * a worker branch published a handle nobody chose to write. This gate reads the
 * subjects, so the next leak is red instead of argued about.
 *
 * Population: every commit reachable from HEAD that the baseline does not
 * already cover, merges included. The baseline is the newest tag reachable from
 * HEAD (`git describe --tags --abbrev=0 HEAD`), so the range re-anchors itself
 * at each release and no sha or tag is hardcoded; an empty range is clean
 * because the tag already covers those commits. The range is printed on every
 * run, so a population stamp transcribed from the output names the revision it
 * certifies.
 *
 * A subject is a problem when it carries:
 *   - a token from the shared label vocabulary (`lib/label-tokens.mjs`, the same
 *     three-digit task-label tokens and brief identifiers the source gate refuses);
 *   - the branch namespace a merge subject is derived from
 *     (`worker/w<digits>/`), which is the handle without the label spelling.
 *
 * No reachable tag is a problem, never a skip: without a baseline there is no
 * range to certify, and a green run over an unknowable population is worse than
 * no gate. CI checks out full history (fetch-depth 0) so this cannot arise
 * there; a shallow clone reports it rather than passing.
 *
 * `--range <rev-range>` replaces the tag-derived range verbatim (git rev-list
 * syntax) for a reader who needs to hold the gate against history outside that
 * window. The default stays tag-derived; with `--range` the baseline line says
 * so instead of naming a tag.
 *
 * Usage: node packages/core/scripts/check-commit-subjects.mjs [--cwd <dir>] [--range <range>]
 * Exit code: 0 = clean, 1 = problems (a leaking subject, no certifiable range,
 * or a git read this tree could not complete)
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { LABEL_TOKEN_PATTERNS } from "./lib/label-tokens.mjs";

/** Run git in the target tree; undefined on any failure, so a refusal is reported, not thrown. */
function git(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

const USAGE = "usage: check-commit-subjects.mjs [--cwd <dir>] [--range <rev-range>]";

const argv = process.argv.slice(2);
let cwd = process.cwd();
let rangeOverride = "";
let rangeFromFlag = false;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--cwd") cwd = resolve(argv[++i] ?? "");
  else if (arg === "--range") {
    rangeOverride = (argv[++i] ?? "").trim();
    rangeFromFlag = true;
  } else if (arg === "--help" || arg === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(`check-commit-subjects: unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
    process.exit(1);
  }
}

// The worker-branch shape a merge subject inherits. Case-insensitive because the
// handle is internal either way; the shape, not the spelling, is what makes it a
// label.
const BRANCH_NAMESPACE = /\bworker\/w\d+\//i;

const problems = [];
let baseline = "";

if (rangeFromFlag && rangeOverride === "") {
  console.error(`check-commit-subjects: --range needs a value (git rev-list syntax)\n${USAGE}`);
  process.exit(1);
}

if (!rangeFromFlag) {
  baseline = git(cwd, ["describe", "--tags", "--abbrev=0", "HEAD"]) ?? "";
  if (!baseline) {
    console.error(
      `check-commit-subjects: no reachable tag: cannot certify a commit range in ${cwd}. ` +
        "A shallow clone or a tagless tree has no baseline, and a range nobody can name " +
        "certifies nothing. Fetch the tags (fetch-depth 0, or git fetch --tags) or pass --range.",
    );
    process.exit(1);
  }
  rangeOverride = `${baseline}..HEAD`;
}

const headRev = git(cwd, ["rev-parse", "--short=12", "HEAD"]) ?? "unknown";
const baselineLine = rangeFromFlag
  ? `range given by --range, no tag baseline, head ${headRev}`
  : `baseline ${baseline}, head ${headRev}`;

const listing = git(cwd, ["log", "--format=%H%x09%s", rangeOverride]);
if (listing === undefined) {
  console.error(
    `check-commit-subjects: cannot list commits in ${rangeOverride}: the git read failed. ` +
      "An unreadable range certifies nothing, so this is a problem, not a skip.",
  );
  process.exit(1);
}

const commits = listing === "" ? [] : listing.split("\n");

// One line per problem, not per occurrence: a subject that repeats a label is
// still one leaking subject.
const seen = new Set();
for (const row of commits) {
  const tab = row.indexOf("\t");
  const sha = tab === -1 ? row : row.slice(0, tab);
  const subject = tab === -1 ? "" : row.slice(tab + 1);
  const tokens = [];
  for (const pattern of LABEL_TOKEN_PATTERNS) {
    for (const match of subject.matchAll(pattern)) tokens.push(match[0]);
  }
  const branchMatch = subject.match(BRANCH_NAMESPACE);
  if (branchMatch) tokens.push(branchMatch[0]);

  for (const token of tokens) {
    const key = `${sha}\t${token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(`${sha.slice(0, 12)}  ${token}  ${subject}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.log(problem);
  console.log(
    `check-commit-subjects: ${problems.length} problem(s) in ${rangeOverride} (${baselineLine}); ` +
      "a commit subject carries an internal label: name the change the commit makes, not the label it belongs to",
  );
  process.exit(1);
}

console.log(
  `check-commit-subjects: clean: 0 hits in ${commits.length} commit(s), range ${rangeOverride} (${baselineLine})`,
);
