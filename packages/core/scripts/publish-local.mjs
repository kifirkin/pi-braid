#!/usr/bin/env node
/**
 * publish-local.mjs — versioned local publish pipeline for pi-braid packages.
 *
 * Produces a semantically-versioned tgz (base + branch + iteration) and
 * installs it into ~/.pi/agent/local-packages. Source package.json is bumped
 * only temporarily and reverted so the repo stays clean.
 *
 * Parameterizable by package: the package directory
 * is resolved from the first CLI arg, or falls back to the current working
 * directory (cwd). When no arg is given AND cwd is the monorepo root, the
 * default package is `core` (keeps `npm run publish:local` at the root
 * working identically for core).
 *
 *   node scripts/publish-local.mjs                # cwd==repo root -> core
 *   node scripts/publish-local.mjs core           # -> packages/core
 *   node scripts/publish-local.mjs telegram       # -> packages/telegram
 *   node scripts/publish-local.mjs providers      # -> packages/providers
 *   node scripts/publish-local.mjs skills         # -> packages/skills
 *   node scripts/publish-local.mjs contrib        # -> packages/contrib
 *   LOCAL_PKG=~/other/node_modules node ...       # override install destination
 *
 * Version scheme:  <base>-<sanitized-branch>.<iteration>
 *   e.g. 0.3.0-feature-ctx-budget.4
 *   - base          = current package.json version (e.g. 0.3.0)
 *   - branch        = git branch, sanitized to [a-zA-Z0-9.-]
 *   - iteration     = commit count on this branch since main/master
 *
 * The rules themselves live in scripts/lib/version-derivation.mjs, which the
 * tag path (scripts/tag-prerelease.mjs) imports too: the tarball and the ref
 * must never disagree about which version a commit is.
 *
 * tgz naming follows npm pack: <name>-<version>.tgz, where <name> is the
 * package.json `name` (all braid packages use flat pi-braid-* names, so the
 * tarball is e.g. pi-braid-0.3.2-main.0.tgz / pi-braid-telegram-0.1.0-main.0.tgz).
 *
 * Pre-publish: the target package's `prepublishOnly` runs typecheck + build
 * (core/telegram) or typecheck (source-shipped providers) — see each package.json.
 *
 * Usage (per package):
 *   npm run publish:local                 # root -> core
 *   npm run publish:local:telegram        # root -> telegram
 *   npm run publish:local:providers       # root -> providers
 *   npm run publish:local:skills          # root -> skills
   npm run publish:local:contrib         # root -> contrib
 *   npm run publish:local -w packages/telegram
 *   npm run publish:local -w packages/providers
 *
 * Provenance: before packing, the script writes <package>/build-info.json
 * (package name, version, full + short commit sha, branch, dirty flag, pack
 * timestamp) so a build can be audited even when its version string (and so
 * its tarball name) is reused across commits. Ask whether an installed copy
 * comes from the current tip (run from the repo root; swap the package name
 * for a non-core workspace):
 *
 * Read the installed pi-braid/build-info.json `sha` field and compare it
 * with `git rev-parse HEAD`: equal means the installed copy came from the
 * current tip; otherwise report the installed sha against the tip sha.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { BUILD_INFO_FILE, readGitProvenance, writeBuildInfo } from "./build-info.mjs";
import { deriveVersionFor } from "./lib/version-derivation.mjs";

const KNOWN = ["core", "telegram", "providers", "skills", "contrib"];

function sh(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

// --- resolve the package directory --------------------------------------
function resolvePkgDir() {
  const arg = process.argv[2];
  const cwd = process.cwd();

  if (arg) {
    if (!KNOWN.includes(arg)) {
      console.error(`[publish-local] unknown package "${arg}" (expected: ${KNOWN.join(" | ")})`);
      process.exit(2);
    }
    // repo root = git top-level; package dir = <root>/packages/<arg>
    const top = sh("git rev-parse --show-toplevel", cwd);
    if (!top) {
      console.error("[publish-local] cannot locate git repo root for package resolution");
      process.exit(2);
    }
    return path.join(top, "packages", arg);
  }

  // No arg: if we are inside the monorepo root, default to core; otherwise
  // publish whatever package the cwd is (backwards-compatible).
  const cwdPkg = path.join(cwd, "package.json");
  const isRepoRoot =
    fs.existsSync(cwdPkg) && Array.isArray(JSON.parse(fs.readFileSync(cwdPkg, "utf8")).workspaces);
  return isRepoRoot ? path.join(cwd, "packages", "core") : cwd;
}

// --- failure-atomic install into the destination -------------------------
//
// A failed install must never leave the runtime without the package: the
// old installed dir and the destination manifest bytes must survive a
// failed install unchanged, and the tarball must stay for a manual retry.
// Order of operations:
//   1. resolution-only dry run (mutates nothing) — peer conflicts and
//      missing file: targets surface here, before anything is touched;
//   2. the old installed dir RENAMES to a backup name (not rm -rf) and the
//      destination package.json / package-lock.json bytes are snapshotted;
//   3. the real install; on failure the backup and the snapshots are
//      restored and the error rethrows; on success the backup is removed.
function installAtomic(dest, tgzName, pkgName) {
  const installedDir = path.join(dest, "node_modules", pkgName);
  // Lives at the destination root, not inside node_modules: npm owns that
  // tree during install and must never treat the backup as package data.
  // The name is sanitized because a scoped package name carries a slash.
  const backupDir = path.join(
    dest,
    `.${pkgName.replace(/[^a-zA-Z0-9._-]+/g, "_")}.publish-backup`,
  );
  const snapshots = ["package.json", "package-lock.json"].map((file) => {
    const p = path.join(dest, file);
    try {
      return { path: p, existed: true, bytes: fs.readFileSync(p) };
    } catch {
      return { path: p, existed: false };
    }
  });

  const restore = () => {
    // A failed install can leave a partial extraction behind; drop it so it
    // cannot shadow the backup on the way back.
    if (fs.existsSync(backupDir)) {
      if (fs.existsSync(installedDir)) fs.rmSync(installedDir, { recursive: true, force: true });
      fs.renameSync(backupDir, installedDir);
    }
    for (const s of snapshots) {
      if (s.existed) fs.writeFileSync(s.path, s.bytes);
      else if (fs.existsSync(s.path)) fs.rmSync(s.path, { force: true });
    }
  };

  execSync(`npm install --dry-run ./${tgzName}`, { cwd: dest, stdio: "inherit" });

  if (fs.existsSync(backupDir)) {
    // Leftover from an earlier crashed run: the current install supersedes it.
    console.log(`[publish-local] removing stale backup ${backupDir}`);
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
  if (fs.existsSync(installedDir)) fs.renameSync(installedDir, backupDir);

  try {
    execSync(`npm install ./${tgzName}`, { cwd: dest, stdio: "inherit" });
  } catch (e) {
    console.error(`[publish-local] install failed, restoring previous install from ${backupDir}`);
    restore();
    console.error(
      `[publish-local] previous install restored; tarball kept for retry: ${path.join(dest, tgzName)}`,
    );
    throw e;
  }
  if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
}

const pkgDir = resolvePkgDir();
const pkgPath = path.join(pkgDir, "package.json");
const pkgRaw = fs.readFileSync(pkgPath, "utf8"); // pristine snapshot for restore
const pkg = JSON.parse(pkgRaw);
const base = pkg.version;

// --- version: base, sanitized branch, iteration ---
// One derivation for the tarball and the tag. A base that already carries a
// prerelease (e.g. 0.3.2-main.1 from a manual version-bump commit) comes back
// verbatim, so it cannot be double-suffixed into 0.3.2-main.1-main.0.
const { version: ver, branch, iterations: iter } = deriveVersionFor({ base, pkgDir, sh });
// npm pack always names the tarball <name>-<version>.tgz; derive from the
// package.json name (flat pi-braid-* names yield a flat, valid filename).
const tgzName = `${pkg.name}-${ver}.tgz`;
const dest = process.env.LOCAL_PKG || path.join(homedir(), ".pi/agent/local-packages");

// Provenance is read before the manifest is touched: the temporary version
// bump below would otherwise read as a dirty tree. The record ships as
// build-info.json inside the tarball and is removed in `finally`.
const gitProvenance = readGitProvenance(pkgDir);
const buildInfoPath = path.join(pkgDir, BUILD_INFO_FILE);

console.log(`[publish-local] package=${pkg.name} (${path.relative(process.cwd(), pkgDir) || "."})`);
console.log(`[publish-local] version ${ver}`);
console.log(`[publish-local] branch=${branch} iteration=${iter}`);
console.log(
  `[publish-local] provenance sha=${gitProvenance.shaShort || "(none)"} branch=${gitProvenance.branch} dirty=${gitProvenance.dirty}`,
);

// Temporarily bump the version field (no git tag, no commit, and — unlike
// `npm version` — no writes to the workspace package-lock.json). The pristine
// bytes are restored in `finally`.
const bumped = JSON.parse(pkgRaw);
bumped.version = ver;
// With an explicit `files` allowlist a root-level build-info.json ships only
// if listed, so add it for the pack; the pristine manifest is restored below.
if (Array.isArray(bumped.files) && !bumped.files.includes(BUILD_INFO_FILE)) {
  bumped.files = [...bumped.files, BUILD_INFO_FILE];
}
fs.writeFileSync(pkgPath, JSON.stringify(bumped, null, 2) + "\n");

let ok = false;
try {
  // Explicit pre-pack gate. npm pack does NOT run prepublishOnly (that fires
  // on `npm publish` only), so build freshness must not be assumed — telegram
  // once packed without dist. Run typecheck / build only when the package
  // defines those scripts (core/telegram/providers do; the markdown-only
  // skills pack defines neither).
  if (pkg.scripts && pkg.scripts.typecheck) {
    execSync("npm run typecheck", { cwd: pkgDir, stdio: "inherit" });
  }
  if (pkg.scripts && pkg.scripts.build) {
    execSync("npm run build", { cwd: pkgDir, stdio: "inherit" });
  }
  writeBuildInfo(pkgDir, { name: pkg.name, version: ver, git: gitProvenance });
  execSync("npm pack", { cwd: pkgDir, stdio: "inherit" });
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(pkgDir, tgzName), path.join(dest, tgzName));
  installAtomic(dest, tgzName, pkg.name);
  console.log(`[publish-local] installed ${tgzName} -> ${dest}`);
  ok = true;
} catch (e) {
  console.error(`[publish-local] FAILED: ${e.message}`);
} finally {
  // Restore the pristine package.json bytes so the repo stays clean. Restoring
  // exact bytes (not `git checkout`) also preserves any pre-existing edits to
  // the manifest that predate the publish.
  fs.writeFileSync(pkgPath, pkgRaw);
  // The provenance file is generated output, never committed: remove it
  // unconditionally so no stale record survives a run.
  fs.rmSync(buildInfoPath, { force: true });
  // Remove the tgz from the package tree (it lives in dest now).
  const srcTgz = path.join(pkgDir, tgzName);
  if (fs.existsSync(srcTgz)) fs.unlinkSync(srcTgz);
}

process.exit(ok ? 0 : 1);
