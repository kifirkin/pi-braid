#!/usr/bin/env node
/**
 * check-release.mjs — the tag and the manifest must agree, and the tag must
 * carry the annotation and the ordering the release scheme promises.
 *
 * A tag is a claim about a commit and package.json is a claim about a version.
 * Checking either alone passes while the pair lies: a tag spelling a version no
 * manifest holds and no derivation produces, a lightweight tag that carries no
 * message, an iteration tag created after the release it belongs to, or a tree
 * whose derived version sorts below a tag that already exists.
 *
 * Rules, for one package (default core, or the first CLI arg as a workspace
 * name):
 *   1. the manifest version is valid semver;
 *   2. every tag in this package's namespace at HEAD is annotated, and its name
 *      is that namespace plus either a workspace manifest version or the
 *      iteration version this tree derives;
 *   3. a tag this package holds at HEAD sorts strictly above every tag in its
 *      namespace already in its history, and an iteration tag precedes its own
 *      base release: 0.40.0-main.3 < 0.40.0, per semver.org 2.0.0 with build
 *      metadata ignored;
 *   4. with no tag of its own at HEAD, the version the tree derives must sort
 *      strictly above the highest existing tag in this package's namespace: the
 *      rule the tag path enforces, checked here before the tag exists.
 *
 * The namespaces are per package (root CHANGELOG, "Two tag roles"): core owns
 * the bare `v` namespace, every sibling owns `<workspace>-v*`. A tag therefore
 * names its package, one line's tags cannot block another's, and the legacy
 * core names do not squat a sibling's release name.
 *
 * Usage: node packages/core/scripts/check-release.mjs [package]
 * Exit: 0 clean, 1 a violated rule, 2 usage error.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { deriveVersion, readVersionInputs } from "./lib/version-derivation.mjs";
import {
  compareVersions,
  highestVersion,
  isPrerelease,
  isValidVersion,
  releaseOf,
} from "./lib/semver.mjs";

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);

function sh(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  } catch {
    return "";
  }
}

function gitLines(cmd, cwd) {
  return sh(cmd, cwd)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const top = sh("git rev-parse --show-toplevel", process.cwd());
if (!top) {
  console.error("check-release: not inside a git work tree; nothing to check against");
  process.exit(2);
}

const arg = process.argv[2];
const pkgDir = path.join(top, "packages", arg ?? "core");
const pkgPath = path.join(pkgDir, "package.json");
if (!fs.existsSync(pkgPath)) {
  console.error(`check-release: no package.json at ${path.relative(top, pkgPath)}`);
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const version = pkg.version;
const relPkg = path.relative(top, pkgPath);

// ── rule 1: the manifest version is a version ───────────────────────────────
if (!isValidVersion(version)) {
  fail(`${relPkg}: version "${version}" is not valid semver`);
}

// ── the versions and the tag namespace this tree can honestly carry ────────
// Manifests, keyed by the version they hold and by the workspace that holds
// it. A tag at HEAD is honest when its name spells this package's manifest
// version or the iteration version this tree derives.
const byVersion = new Map();
const byWorkspace = new Map();
const workspace = path.join(top, "packages");
for (const entry of fs.readdirSync(workspace, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifest = path.join(workspace, entry.name, "package.json");
  if (!fs.existsSync(manifest)) continue;
  const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (typeof parsed.version !== "string") continue;
  byVersion.set(parsed.version, [...(byVersion.get(parsed.version) ?? []), parsed.name]);
  byWorkspace.set(parsed.name, entry.name);
}

// Core owns the bare `v` namespace: it holds the legacy line (v0.1.1 …
// v0.39.0) and nothing in it is retagged. Every sibling owns `<workspace>-v*`,
// so a tag names its package, one line's tags cannot block another's, and the
// legacy core names (v0.1.4, v0.2.0 …) do not squat a sibling's release name.
const workspaceName = path.basename(pkgDir);
const prefix = workspaceName === "core" ? "" : `${workspaceName}-`;
const tagGlob = `${prefix}v*`;
const namespace = prefix === "" ? "v*" : tagGlob;
const stripTag = (tag) => tag.slice(`${prefix}v`.length);
notes.push(`namespace: ${namespace}`);

const { branch, iterations } = readVersionInputs(pkgDir, sh);
const derivedHere = deriveVersion({ base: version, branch, iterations });

const allTags = gitLines(`git tag --list '${tagGlob}'`, top);
const headTags = gitLines(`git tag --points-at HEAD --list '${tagGlob}'`, top);

// ── rule 2: a tag at HEAD is annotated and spells a version this package holds ─
for (const tag of headTags) {
  const objectType = sh(`git cat-file -t ${tag}`, top);
  if (objectType !== "tag") {
    fail(
      objectType === "commit"
        ? `${tag}: lightweight tag; an annotated tag is required (git tag -a)`
        : `${tag}: cannot read the tag object (${objectType || "git said nothing"})`,
    );
    continue;
  }

  const claimed = stripTag(tag);
  const holders = byVersion.get(claimed) ?? [];
  const others = holders.filter((name) => byWorkspace.get(name) !== workspaceName);
  if (prefix === "" && others.length > 0) {
    // A bare `v` tag names no package: it cannot be attributed when two
    // workspaces hold the version, and it is misplaced when it spells a
    // sibling's version.
    fail(
      `${tag}: a bare v tag cannot name its package; ${holders.join(", ")} hold version ` +
        `"${claimed}"`,
    );
  } else if (claimed === version) {
    notes.push(`${tag}: annotated, matches ${pkg.name} ${claimed}`);
  } else if (claimed === derivedHere) {
    notes.push(`${tag}: annotated, the iteration version this tree derives for ${pkg.name}`);
  } else {
    fail(
      `${tag}: no manifest for ${pkg.name} holds version "${claimed}", and it is not the ` +
        `iteration version this tree derives (${derivedHere})`,
    );
  }
}

// ── rule 3: the tags this package holds at HEAD, and where they sort ────────
const ownAtHead = headTags.filter((tag) => {
  const claimed = stripTag(tag);
  return claimed === version || claimed === derivedHere;
});

const parent = sh("git rev-parse -q --verify HEAD^", top);
const highestExisting = highestVersion(allTags.map((name) => stripTag(name)));

for (const tag of ownAtHead) {
  const claimed = stripTag(tag);
  if (!isValidVersion(claimed)) continue; // rule 1 already failed on the manifest

  const previous = parent
    ? highestVersion(
        gitLines(`git tag --list '${tagGlob}' --merged ${parent}`, top)
          .filter((name) => name !== tag)
          .map((name) => stripTag(name)),
      )
    : null;
  if (previous && compareVersions(claimed, previous) <= 0) {
    fail(`${tag}: sorts at or below v${previous}, a tag already in its history`);
  }

  if (isPrerelease(claimed)) {
    const base = releaseOf(claimed);
    const baseTag = `v${base}`;
    // The base release at the same commit is the release of this very
    // iteration, not a release that already happened: only a base release on
    // another commit means the iteration line for this base is closed.
    if (allTags.includes(baseTag) && !headTags.includes(baseTag)) {
      fail(
        `${tag}: its base release ${baseTag} was already tagged on another commit; an ` +
          "iteration tag precedes the release it belongs to",
      );
    }
    notes.push(`ordering: ${previous ?? "(no earlier tag)"} < ${claimed} < ${base}`);
  } else {
    notes.push(`ordering: ${previous ?? "(no earlier tag)"} < ${claimed}`);
  }
}

// ── rule 4: nothing of this package at HEAD, so the derivation must be ahead ─
if (ownAtHead.length === 0) {
  if (isValidVersion(derivedHere) && highestExisting && compareVersions(derivedHere, highestExisting) <= 0) {
    fail(
      `${derivedHere}: the version derived for this tree sorts at or below the highest existing ` +
        `tag ${prefix}v${highestExisting} in the ${namespace} namespace`,
    );
  }
  notes.push(`HEAD tags: ${headTags.length > 0 ? headTags.join(", ") : "none"}`);
  notes.push(`derived for this tree: ${derivedHere}`);
  notes.push(`highest existing tag: ${highestExisting ? `${prefix}v${highestExisting}` : "(none)"}`);
  notes.push(`ordering: ${highestExisting ?? "(no earlier tag)"} < ${derivedHere}`);
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`check-release: package=${pkg.name} version=${version} (${relPkg})`);
for (const note of notes) console.log(`  ${note}`);

if (problems.length > 0) {
  console.error(`check-release: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("check-release: clean (tag and manifest agree; the ordering holds)");
