#!/usr/bin/env node
/**
 * tag-prerelease.mjs — tag HEAD with the version the derivation already named.
 *
 * The publish path has always derived a version for the tree it packs, and
 * nothing turned that version into a ref, so a published iteration left no tag
 * pointing at the commit it came from. This script closes that gap: the
 * version comes from the same module the publish path uses
 * (scripts/lib/version-derivation.mjs), and the annotated tag `v<version>` is
 * created at HEAD.
 *
 * A tag names its package. Core owns the bare `v` namespace (its legacy line,
 * v0.1.1 … v0.39.0, and nothing in it is retagged); every sibling tags as
 * `<workspace>-v<version>` (telegram-v0.1.4, providers-v1.0.5, …). One line's
 * tags therefore cannot block another's, and the legacy core names do not
 * squat a sibling's release name. The scheme is recorded in the root
 * CHANGELOG.
 *
 * It never creates a commit and never edits package.json.
 *
 * Refusals (message on stderr, exit 1):
 *   - not inside a git work tree: there is no HEAD to tag;
 *   - HEAD is detached: an iteration count taken off a detached HEAD names no
 *     line anyone can return to;
 *   - the tree is dirty, untracked files included: a tag must name a committed
 *     state;
 *   - the derived version is not valid semver: the name would not be a version
 *     and git may not even accept it as a ref;
 *   - the tag already exists;
 *   - the derived version does not sort strictly above the highest existing tag
 *     in this package's namespace: a rebase lowers the iteration count, and a
 *     tag below the last one would re-point a released name at different code.
 *
 * Usage:
 *   node packages/core/scripts/tag-prerelease.mjs [package]   # default: core
 */
import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { deriveVersionFor } from "./lib/version-derivation.mjs";
import { compareVersions, highestVersion, isValidVersion } from "./lib/semver.mjs";

function sh(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  } catch {
    return "";
  }
}

function refuse(reason) {
  console.error(`[tag-prerelease] refusing: ${reason}`);
  process.exit(1);
}

/**
 * The tag namespace this package owns. Core keeps the bare `v`: it holds the
 * legacy line, and a package name inside the bare namespace would be a second
 * scheme. Every sibling carries its workspace name, so the tag names its
 * package.
 */
function tagPrefix(dir) {
  const workspace = path.basename(dir);
  return workspace === "core" ? "" : `${workspace}-`;
}

/**
 * The package whose base version the tag is derived from: the first CLI arg as
 * a workspace name, or `core` (the release line the repo tags by default).
 */
function resolvePkgDir() {
  const arg = process.argv[2];
  const top = sh("git rev-parse --show-toplevel", process.cwd());
  if (!top) refuse("not inside a git work tree, so there is no HEAD to tag");
  if (!arg) return path.join(top, "packages", "core");

  const dir = path.join(top, "packages", arg);
  if (!fs.existsSync(path.join(dir, "package.json"))) {
    refuse(`unknown package "${arg}": no package.json at ${path.relative(top, dir)}`);
  }
  return dir;
}

const pkgDir = resolvePkgDir();
const pkgPath = path.join(pkgDir, "package.json");
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
} catch (error) {
  refuse(`cannot read a version from ${path.relative(process.cwd(), pkgPath)}: ${error.message}`);
}
if (typeof pkg.version !== "string") {
  refuse(`${path.relative(process.cwd(), pkgPath)} has no version string`);
}

const ref = sh("git rev-parse --abbrev-ref HEAD", pkgDir);
if (!ref || ref === "HEAD") {
  refuse("HEAD is detached; check out the branch this iteration belongs to and run again");
}

const dirty = sh("git status --porcelain", pkgDir);
if (dirty) {
  refuse(`the tree is dirty; a tag must name a committed state:\n${dirty}`);
}

const { version, branch, iterations } = deriveVersionFor({ base: pkg.version, pkgDir, sh });
const prefix = tagPrefix(pkgDir);
const tag = `${prefix}v${version}`;

if (!isValidVersion(version)) {
  refuse(
    `the derived version "${version}" is not valid semver; check the base version in package.json`,
  );
}

if (sh(`git rev-parse -q --verify refs/tags/${tag}`, pkgDir)) {
  refuse(`tag ${tag} already exists`);
}

const existing = sh(`git tag --list '${prefix}v*'`, pkgDir).split("\n").filter(Boolean);
const highest = highestVersion(existing.map((name) => name.slice(`${prefix}v`.length)));
if (highest && compareVersions(version, highest) <= 0) {
  refuse(
    `${tag} does not sort strictly above the highest existing tag ${prefix}v${highest}; ` +
      "a rebase lowers the iteration count, and re-tagging below a released version " +
      "would re-point that name at different code",
  );
}

try {
  execFileSync("git", ["tag", "-a", tag, "-m", `${pkg.name} ${version}`], { cwd: pkgDir });
} catch (error) {
  refuse(`git could not create the tag: ${error.message}`);
}

const sha = sh("git rev-parse --short HEAD", pkgDir);
console.log(
  `[tag-prerelease] created annotated tag ${tag} at ${sha} (base ${pkg.version}, branch ${branch}, iteration ${iterations})`,
);
if (highest) console.log(`[tag-prerelease] highest tag before this one: ${prefix}v${highest}`);
