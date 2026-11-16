#!/usr/bin/env node
// check-artifact-staleness.mjs - does an accepted artifact still describe the
// tree it names?
//
// The class this closes (measured over the outcome ledger: 20 surprise reports
// across a week, the highest-signature cluster): an artifact or record that was
// true when it was written and is silently false later. A deck's fetched counts
// outlive their generator; an audit's rows describe code that moved on; a brief
// states a machine-state figure nobody can reproduce. The accepting gate in
// every case took the artifact's word for its own ground.
//
// This gate asserts the one decidable half of the required behaviour: the
// revision an artifact names. If the tree has moved since that revision, the
// artifact's figures are potentially stale and the gate says so, naming the
// files that moved. It cannot tell whether a given figure is still true - that
// stays the seat's re-derivation job - but it refuses to let an artifact be
// consumed as if nothing had changed.
//
//   node check-artifact-staleness.mjs --repo <path> --revision <sha> [--paths <glob>]... [--strict]
//
// Verdicts:
//   exit 0  the revision IS the repo's HEAD, or (report-only) the tree moved and
//           the changed files are named for the reader to judge
//   exit 1  (--strict only) the tree moved since the named revision
//   exit 2  usage, an unresolvable repo, or a revision that is not in it - an
//           artifact naming a revision its repo does not contain cannot be
//           freshness-checked at all, which is a failure, not a warning

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function usage(msg) {
  console.error(msg ? `usage error: ${msg}\n` : "");
  console.error("usage: node check-artifact-staleness.mjs --repo <path> --revision <sha> [--paths <glob>]... [--strict]");
  process.exit(2);
}

const argv = process.argv.slice(2);
let repo = null, revision = null, strict = false;
const paths = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--repo") repo = argv[++i];
  else if (a === "--revision") revision = argv[++i];
  else if (a === "--paths") paths.push(argv[++i]);
  else if (a === "--strict") strict = true;
  else usage(`unknown argument ${a}`);
}
if (!repo || !revision) usage("--repo and --revision are both required");
if (!existsSync(repo)) usage(`repo does not exist: ${repo}`);

const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });

const inside = git("rev-parse", "--is-inside-work-tree");
if (inside.status !== 0 || inside.stdout.trim() !== "true") usage(`not a git work tree: ${repo}`);

const head = git("rev-parse", "HEAD").stdout.trim();
const resolves = git("cat-file", "-e", `${revision}^{commit}`).status === 0;
if (!resolves) {
  console.error(`FAIL: revision ${revision} does not exist in ${repo} - an artifact naming a revision its repo does not contain cannot be freshness-checked`);
  process.exit(2);
}

const full = git("rev-parse", `${revision}^{commit}`).stdout.trim();
if (full === head) {
  console.log(`PASS: artifact revision ${full.slice(0, 12)} IS the repo's HEAD - the tree has not moved`);
  process.exit(0);
}

// The revision is real but not HEAD: which files moved? An ancestor relationship
// is expected (an artifact describes the tree it was written on, and later
// commits build on it); a non-ancestor means the artifact describes a branch
// that never landed, which is a different and worse verdict.
const ancestor = git("merge-base", "--is-ancestor", full, head).status === 0;
const diffArgs = paths.length ? ["diff", "--name-only", `${full}..HEAD`, "--", ...paths] : ["diff", "--name-only", `${full}..HEAD`];
const changed = git(...diffArgs).stdout.trim().split("\n").filter(Boolean);
const scope = paths.length ? paths.join(" ") : "(whole tree)";

console.log(`${ancestor ? "STALE?" : "STALE!"}: artifact revision ${full.slice(0, 12)} is not HEAD (${head.slice(0, 12)}), ${ancestor ? "an ancestor" : "NOT an ancestor of HEAD"}`);
console.log(`  scope:   ${scope}`);
console.log(`  moved:   ${changed.length} file(s) since the artifact's revision`);
for (const f of changed.slice(0, 20)) console.log(`    ${f}`);
if (changed.length > 20) console.log(`    ... and ${changed.length - 20} more`);

if (changed.length === 0) {
  console.log("PASS: the tree moved, but nothing in the artifact's scope changed - its figures still describe this scope");
  process.exit(0);
}
if (!ancestor) {
  console.log("FAIL: the artifact describes a revision that never landed in this branch");
  process.exit(1);
}
if (strict) {
  console.log("FAIL (--strict): the artifact's scope moved since its revision; re-derive its figures before consuming it");
  process.exit(1);
}
console.log("report-only: name the changed files or re-derive the figures; exit 0 by default (pass --strict to fail)");
process.exit(0);
