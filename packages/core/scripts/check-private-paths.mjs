#!/usr/bin/env node
/**
 * check-private-paths.mjs: refuse a private literal before it is pushed.
 *
 * A secret audit of this repository found the owner's home directory in 1,890
 * file instances across 64 published tags, a private project tree in five
 * files, and a personal mailbox on a commit no branch pointed at but the host
 * still served by SHA. The scanner that could have caught a pattern had been
 * retired earlier and nothing replaced it, so every one of those was found by
 * hand, after publication. A tag is the worst place for such a literal to sit:
 * it is immutable, it is redistributed by every clone, and deleting it does not
 * delete what a clone already took.
 *
 * Three surfaces, one pattern list (`lib/private-patterns.mjs`):
 *
 *   1. The tree. The content of every file a commit would carry: the paths the
 *      index enumerates plus the working tree's unignored files, through the
 *      same enumeration the doc gates read (`lib/tracked-files.mjs`). The
 *      untracked half matters because a gate that reads only staged content
 *      cannot see the page being written, and the file it cannot see is
 *      exactly the one about to be added. A path with no readable file (a
 *      deletion not yet staged) stays in the population and is counted as
 *      unreadable rather than dropped: a scan that silently covers fewer files
 *      reports less than it checked. A file is read as text, so an ASCII
 *      literal in a binary's bytes is still found and a compressed one is not
 *      (see the bounds below).
 *
 *   2. The commit range. Subject, body, and both addresses of every commit this
 *      checkout adds over the merge base with its base branch. A message that
 *      quotes a home path is the same leak with a longer half-life: it cannot
 *      be edited out of a clone. Only the added commits are read. A full
 *      history scan would fail today on exposures this repository has already
 *      fixed by hand, and a gate that can never go green is a gate people learn
 *      to route around; the population it certifies is the one this checkout
 *      would publish. The base is `--base`, then `GITHUB_BASE_REF`, then `main`,
 *      then `origin/main`, then the newest tag reachable from HEAD (a release
 *      checkout has no base branch, and the commits it carries were gated on
 *      the branch before the tag). Nothing resolving is a refusal, never a
 *      pass.
 *
 *   3. The tag annotation. When the checkout is a tag, the annotation text of
 *      that tag, read when `GITHUB_REF_TYPE` is `tag` or `--tag` names one.
 *      Release prose is written at tag time, after the last commit gate ran,
 *      which is how a path can reach a tag that no branch carries.
 *
 * The identity rule is separate from the content patterns and stricter: an
 * author or committer address is refused unless it is a GitHub noreply alias,
 * which names an account rather than a mailbox, or an address declared in
 * `ALLOWED_EMAILS` with a reason. The address is printed, because it is the git
 * configuration that must change and it is already in the commit under test.
 *
 * A content finding is reported by path, pattern and line, never by content:
 * echoing the offending line would republish it into a CI log, and the fix
 * needs the file and the line rather than a copy of the string.
 *
 * Fail-closed refusals, never skips: a directory that is not a git working
 * tree, a `--base` that names no commit, a merge base that cannot be computed,
 * a `--tag` that names no tag, a patterns module that does not export what it
 * claims, and an allowance that suppresses nothing (a stale entry hides a hole
 * that is no longer there while its reason claims a rule is being kept).
 *
 * Bounds, stated so a green run is not read as more than it is:
 *   - The scan reads each blob as text. A leak inside compressed or encoded
 *     bytes (a PNG, an archive, a base64 payload) is invisible; an ASCII
 *     literal in a binary's plain bytes is not.
 *   - A literal split across a line break is not matched, because matching is
 *     per line (the line number is what the fix needs).
 *   - A leak already inside a published tarball or a pushed tag is outside any
 *     gate: this one stops the next one.
 *   - A tag signature is not read; only the annotation text is.
 *   - The tree surface reads the working tree, so a path deleted from disk but
 *     still in the index is counted as unreadable rather than as clean content.
 *     Ignored paths are outside every surface: an unignored file is scanned
 *     whether or not it has been added yet.
 *
 * Usage: node packages/core/scripts/check-private-paths.mjs
 *          [--cwd <dir>] [--base <ref>] [--tag <name>] [--allowances <file>]
 * Exit code: 0 = clean; 1 = a private literal, a refused identity, or a
 *            refusal to certify; 64 = usage.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { trackedFileSets } from "./lib/tracked-files.mjs";
import {
  ALLOWANCES as REPO_ALLOWANCES,
  ALLOWED_EMAILS,
  NOREPLY_ALIAS,
  PATTERNS,
} from "./lib/private-patterns.mjs";

const USAGE =
  "usage: check-private-paths.mjs [--cwd <dir>] [--base <ref>] [--tag <name>] [--allowances <file>]";

/** `git log` field order. The separators are control characters so a subject
 *  or a body containing a newline or a comma cannot shift a field. */
const LOG_FORMAT = ["%h", "%s", "%b", "%ae", "%ce"].join("%x1f") + "%x1e";

// ── Process helpers ─────────────────────────────────────────────────────────

function usageError(message) {
  console.error(`check-private-paths: ${message}`);
  console.error(`  ${USAGE}`);
  process.exit(64);
}

/** Refuse to certify: a population this run could not establish. */
function refuse(message) {
  console.error(`check-private-paths: cannot certify: ${message}`);
  process.exit(1);
}

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The same read with a failure reported as `undefined`, so a caller can refuse
 *  with its own message instead of throwing git's. */
function tryGit(dir, args) {
  try {
    return git(dir, args);
  } catch {
    return undefined;
  }
}

// ── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let cwd = process.cwd();
let baseFlag = "";
let tagFlag = "";
let allowancesFlag = "";
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--cwd") cwd = resolve(argv[++i] ?? "");
  else if (arg === "--base") baseFlag = argv[++i] ?? "";
  else if (arg === "--tag") tagFlag = argv[++i] ?? "";
  else if (arg === "--allowances") allowancesFlag = resolve(argv[++i] ?? "");
  else if (arg === "--help" || arg === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else usageError(`unknown argument ${JSON.stringify(arg)}`);
}

// ── The population ──────────────────────────────────────────────────────────

const toplevel = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
if (toplevel === undefined) {
  refuse(`${cwd} is not a git working tree, so there is no tracked population to certify`);
}
const root = resolve(toplevel.trim());

/** The scanned population: the index plus the working tree's unignored files,
 *  through the enumeration the doc gates read (`lib/tracked-files.mjs`). */
let tracked = [];
let untracked = [];
let population = [];
try {
  ({ tracked, untracked } = trackedFileSets(root));
  population = [...new Set([...tracked, ...untracked])].sort();
} catch (error) {
  refuse(`${root}: git could not enumerate the tree (${error.message})`);
}

const head = tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() ?? "";
const detached = head === "" || head === "HEAD";
const revision = detached
  ? (tryGit(root, ["rev-parse", "--short", "HEAD"])?.trim() ?? "unknown")
  : head;

// ── Patterns and allowances ─────────────────────────────────────────────────

const problems = [];
const findings = [];

/** Per-line matching: `test` on a pattern without `g`/`y` is stateless, and a
 *  stateful one is refused below. Returns 1-based line numbers. */
function matchingLines(text, pattern) {
  const lines = [];
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i++) {
    if (pattern.regex.test(rows[i])) lines.push(i + 1);
  }
  return lines;
}

/** Refuse a pattern list the gate cannot read literally. */
function validatePatterns(patterns, source) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    problems.push(`${source} exports no pattern entries`);
    return;
  }
  const seen = new Set();
  for (const entry of patterns) {
    const name = typeof entry?.name === "string" ? entry.name : "";
    if (name === "") {
      problems.push(`${source}: an entry carries no name`);
    } else if (seen.has(name)) {
      problems.push(`${source}: pattern ${name} is declared twice`);
    } else {
      seen.add(name);
    }
    if (!(entry?.regex instanceof RegExp)) {
      problems.push(`${source}: ${name || "an entry"} carries no regex`);
    } else if (/[gy]/.test(entry.regex.flags)) {
      problems.push(
        `${source}: ${name} carries the ${entry.regex.flags.replace(/[^gy]/g, "")} flag; a stateful pattern judges each line from where the last match ended`,
      );
    }
    if (typeof entry?.reason !== "string" || entry.reason.trim() === "") {
      problems.push(`${source}: ${name || "an entry"} carries no one-line reason`);
    }
  }
}

validatePatterns(PATTERNS, "lib/private-patterns.mjs");

/** The allowance list this run applies: the repository's own, or the module a
 *  fixture passes with `--allowances`. Patterns and identity allowances are not
 *  overridable: a fixture has to be judged by the real vocabulary. */
let allowances = REPO_ALLOWANCES;
if (allowancesFlag !== "") {
  const loaded = await import(pathToFileURL(allowancesFlag).href).catch((error) => {
    refuse(`--allowances ${allowancesFlag} could not be imported: ${error.message}`);
  });
  if (!Array.isArray(loaded.ALLOWANCES)) {
    refuse(`--allowances ${allowancesFlag} does not export an ALLOWANCES array`);
  }
  allowances = loaded.ALLOWANCES;
}

const patternNames = new Set(PATTERNS.map((entry) => entry.name));
const allowanceUses = new Map();
const emailUses = new Map();

/** Validate one allowance against the populations this run holds, so a broken
 *  entry is reported even when no match reaches it. */
function validateAllowance(entry, index) {
  const where = `allowance ${index + 1}`;
  const file = typeof entry?.file === "string" ? entry.file : "";
  const pattern = typeof entry?.pattern === "string" ? entry.pattern : "";
  if (file === "") problems.push(`${where} names no file`);
  else if (!population.includes(file)) {
    problems.push(
      `${where} names ${file}, which neither the index nor the working tree carries; an allowance over a file that is gone certifies nothing`,
    );
  }
  if (pattern === "") problems.push(`${where} names no pattern`);
  else if (!patternNames.has(pattern)) {
    problems.push(
      `${where} names pattern ${pattern}, which lib/private-patterns.mjs does not declare`,
    );
  }
  if (entry?.lines !== undefined) {
    const lines = entry.lines;
    const shaped =
      Array.isArray(lines) &&
      lines.length === 2 &&
      lines.every((n) => Number.isInteger(n) && n >= 1) &&
      lines[0] <= lines[1];
    if (!shaped) problems.push(`${where} carries lines that are not a [from, to] pair of line numbers`);
  }
  if (typeof entry?.reason !== "string" || entry.reason.trim() === "") {
    problems.push(`${where} carries no one-line reason`);
  }
}

allowances.forEach(validateAllowance);

/** The allowance covering one hit, or undefined. File and pattern pin it; when
 *  the entry declares `lines`, the hit has to fall inside that range too. */
function allowanceFor(file, patternName, line) {
  return allowances.find(
    (entry) =>
      entry?.file === file &&
      entry?.pattern === patternName &&
      (entry.lines === undefined || (line >= entry.lines[0] && line <= entry.lines[1])),
  );
}

// ── Surface 1: the tree ─────────────────────────────────────────────────────

let unreadable = 0;
let treeHits = 0;

/** Refused tree hits, one row per (file, pattern), in scan order. */
const treeRows = new Map();

for (const path of population) {
  let text;
  try {
    text = readFileSync(join(root, path), "utf8");
  } catch {
    unreadable += 1;
    continue;
  }
  for (const pattern of PATTERNS) {
    for (const line of matchingLines(text, pattern)) {
      treeHits += 1;
      const allowance = allowanceFor(path, pattern.name, line);
      if (allowance !== undefined) {
        allowanceUses.set(allowance, (allowanceUses.get(allowance) ?? 0) + 1);
        continue;
      }
      const key = `${path}\0${pattern.name}`;
      const row = treeRows.get(key) ?? { where: path, pattern: pattern.name, lines: [] };
      row.lines.push(line);
      treeRows.set(key, row);
    }
  }
}

const unusedAllowances = allowances.filter((entry) => !allowanceUses.has(entry));
for (const entry of unusedAllowances) {
  problems.push(
    `allowance: ${entry.file} [${entry.pattern}] suppresses nothing: no match reaches it under its line range, so its reason ("${entry.reason}") describes a rule the gate is not keeping`,
  );
}

// ── Surface 2: the commit range ─────────────────────────────────────────────

/** The base ref the range is measured against, and the commit it resolved to. */
function resolveBaseline(dir, flag) {
  const ref = flag.trim();
  if (ref !== "") {
    const sha = tryGit(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim();
    return sha ? { ref, sha, kind: "named" } : null;
  }
  const candidates = [];
  if (process.env.GITHUB_BASE_REF) candidates.push(process.env.GITHUB_BASE_REF);
  candidates.push("main", "origin/main");
  for (const candidate of candidates) {
    const sha = tryGit(dir, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])?.trim();
    if (sha) return { ref: candidate, sha, kind: "branch" };
  }
  const tag = tryGit(dir, ["describe", "--tags", "--abbrev=0", "HEAD"])?.trim();
  if (tag) {
    const sha = tryGit(dir, ["rev-parse", "--verify", "--quiet", `${tag}^{commit}`])?.trim();
    if (sha) return { ref: tag, sha, kind: "tag" };
  }
  return null;
}

const baseline = resolveBaseline(root, baseFlag);
if (baseline === null) {
  refuse(
    baseFlag.trim() !== ""
      ? `--base ${baseFlag} names no commit in ${root}`
      : `no base branch and no reachable tag, so the commit range cannot be established in ${root}`,
  );
}
const mergeBase = tryGit(root, ["merge-base", baseline.sha, "HEAD"])?.trim() ?? "";
if (mergeBase === "") {
  refuse(
    `no merge base between ${baseline.ref} (${baseline.sha.slice(0, 7)}) and HEAD, so no populated range exists`,
  );
}

const logRaw = tryGit(root, ["log", "--no-color", `--format=${LOG_FORMAT}`, `${mergeBase}..HEAD`]);
if (logRaw === undefined) refuse(`${root}: git could not read the log of ${mergeBase.slice(0, 7)}..HEAD`);

/** One record per commit: the fields of LOG_FORMAT, record-terminated. */
const commits = [];
for (const record of logRaw.split("\x1e")) {
  const trimmed = record.replace(/^\n+/, "").replace(/\n+$/, "");
  if (trimmed === "") continue;
  const [sha, subject = "", body = "", authorEmail = "", committerEmail = ""] =
    trimmed.split("\x1f");
  commits.push({ sha, subject, body, authorEmail, committerEmail });
}

let historyHits = 0;

for (const commit of commits) {
  for (const [part, text] of [
    ["subject", commit.subject],
    ["body", commit.body],
  ]) {
    for (const pattern of PATTERNS) {
      const lines = matchingLines(text, pattern);
      if (lines.length === 0) continue;
      historyHits += 1;
      findings.push({
        surface: "history",
        where: `${commit.sha} ${part}`,
        pattern: pattern.name,
        line: lines[0],
        count: lines.length,
      });
    }
  }
  for (const [role, address] of [
    ["author", commit.authorEmail],
    ["committer", commit.committerEmail],
  ]) {
    const trimmed = address.trim();
    if (trimmed === "" || NOREPLY_ALIAS.test(trimmed)) continue;
    const allowed = ALLOWED_EMAILS.find(
      (entry) => entry?.address?.toLowerCase() === trimmed.toLowerCase(),
    );
    if (allowed !== undefined) {
      emailUses.set(allowed, (emailUses.get(allowed) ?? 0) + 1);
      continue;
    }
    historyHits += 1;
    findings.push({ surface: "identity", where: commit.sha, role, address: trimmed });
  }
}

// ── Surface 3: the tag annotation ───────────────────────────────────────────

const tagNameOfCheckout = () => {
  if (tagFlag.trim() !== "") return tagFlag.trim();
  if (process.env.GITHUB_REF_TYPE === "tag") return (process.env.GITHUB_REF_NAME ?? "").trim();
  return "";
};

const tagName = tagNameOfCheckout();
let tagSummary = "none (this checkout is not a tag)";
let tagHits = 0;

if (tagName !== "") {
  const objectType = tryGit(root, ["cat-file", "-t", `refs/tags/${tagName}`])?.trim();
  if (objectType === undefined) refuse(`--tag ${tagName} names no tag in ${root}`);
  if (objectType !== "tag") {
    tagSummary = `${tagName} is a lightweight tag, so it carries no annotated message (0 lines read)`;
  } else {
    const annotation = tryGit(root, [
      "for-each-ref",
      `refs/tags/${tagName}`,
      "--format=%(contents)",
    ]);
    if (annotation === undefined) refuse(`git could not read the annotation of tag ${tagName}`);
    const trimmed = annotation.replace(/\n+$/, "");
    const annotationLines = trimmed.split("\n");
    for (const [index, line] of annotationLines.entries()) {
      for (const pattern of PATTERNS) {
        if (!pattern.regex.test(line)) continue;
        tagHits += 1;
        findings.push({
          surface: "tag",
          where: tagName,
          pattern: pattern.name,
          line: index + 1,
        });
      }
    }
    tagSummary = `${tagName} annotation (${annotationLines.length} line(s) read)`;
  }
}

// ── The census, and the verdict ─────────────────────────────────────────────

const census = [
  `tree: scanned ${population.length} file(s) at ${revision} (${tracked.length} tracked, ${untracked.length} untracked, ${unreadable} unreadable), ${treeHits} hit(s)`,
  `history: ${commits.length} commit(s) scanned in ${mergeBase.slice(0, 7)}..HEAD (base ${baseline.ref}${baseline.kind === "tag" ? ", the newest tag" : ""}), ${historyHits} hit(s)`,
  `tag: ${tagSummary}, ${tagHits} hit(s)`,
  `allowances: ${allowances.length} declared (${allowanceUses.size} applied), ${ALLOWED_EMAILS.length} email(s) declared (${emailUses.size} applied)`,
];

const applied = [
  ...[...allowanceUses.entries()].map(([entry, count]) => {
    const range =
      entry.lines === undefined
        ? "whole file"
        : entry.lines[0] === entry.lines[1]
          ? `line ${entry.lines[0]}`
          : `lines ${entry.lines[0]}-${entry.lines[1]}`;
    return `allowance applied: ${entry.file} [${entry.pattern}] ${range} x${count} (${entry.reason})`;
  }),
  ...[...emailUses.keys()].map(
    (entry) => `email allowance applied: ${entry.address} (${entry.reason})`,
  ),
];

if (problems.length > 0 || findings.length > 0 || treeRows.size > 0) {
  const total = problems.length + findings.length + treeRows.size;
  console.error(`check-private-paths: ${total} finding(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  for (const row of treeRows.values()) {
    console.error(`  tree: ${row.where}: ${row.pattern} x${row.lines.length} (first at line ${row.lines[0]})`);
  }
  for (const finding of findings) {
    if (finding.surface === "history") {
      console.error(
        `  history: ${finding.where}: ${finding.pattern} x${finding.count} (first at line ${finding.line})`,
      );
    } else if (finding.surface === "identity") {
      console.error(
        `  identity: ${finding.where} ${finding.role} email ${finding.address} is neither a noreply alias nor an allowlisted address`,
      );
    } else {
      console.error(`  ${finding.surface}: ${finding.where} line ${finding.line}: ${finding.pattern}`);
    }
  }
  for (const line of applied) console.error(`  ${line}`);
  for (const line of census) console.error(`  ${line}`);
  process.exit(1);
}

console.log("check-private-paths: clean");
for (const line of applied) console.log(`  ${line}`);
for (const line of census) console.log(`  ${line}`);
