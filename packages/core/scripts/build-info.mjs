#!/usr/bin/env node
/**
 * build-info.mjs — the provenance record a packed package carries.
 *
 * publish-local.mjs writes `<pkgDir>/build-info.json` before `npm pack`, so a
 * tarball (and the copy installed under ~/.pi/agent/local-packages) can be
 * told apart from any other build that shares its version string. The version
 * field alone cannot do that: once package.json holds a full release string
 * (e.g. 0.3.2-main.21), two publishes from different commits pack the same
 * tarball name. The sha recorded here still moves.
 *
 * Shape:
 *   {
 *     "name":     "<package.json name>",
 *     "version":  "<version string packed into the manifest>",
 *     "sha":      "<full commit sha>" | null,   // null outside a git work tree
 *     "shaShort": "<short commit sha, SHA_SHORT_LENGTH characters>" | null,
 *     "branch":   "<branch name>" | "detached",
 *     "dirty":    true | false | null,          // null when git cannot answer
 *     "packedAt": "<ISO-8601 timestamp>"
 *   }
 *
 * The file is generated for the pack and removed by the caller afterwards; it
 * is never committed.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const BUILD_INFO_FILE = "build-info.json";

/**
 * The env var a caller sets to tell the prepack step that it already wrote
 * the record for this pack and the writer must keep it. `publish-local.mjs`
 * is the only producer: it reads git before the manifest bump (the bump would
 * otherwise read as a dirty tree at prepack time) and writes the record from
 * that read, so the recorded `dirty` keeps the pre-bump state. Presence of the
 * marker, not a field comparison, is what licenses the deferral — a record
 * someone left behind looks exactly like the caller's in name, version and
 * sha, while only the caller can set this.
 */
export const PROVENANCE_DEFER_ENV = "BRAID_PROVENANCE_DEFER";

/**
 * How many characters `shaShort` carries. Pinned because `git rev-parse
 * --short` abbreviates to the shortest prefix unique in the object database it
 * is asked about, so the length is a property of the clone rather than of the
 * commit: a depth-1 CI checkout and a developer's clone of one commit answered
 * 7 and 8. The record is compared across exactly that pair, so its length is
 * stated here instead of inherited from whichever clone wrote it.
 */
export const SHA_SHORT_LENGTH = 8;

function git(args, cwd) {
  try {
    return execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Read the git state a package is packed from. Call this before any temporary
 * manifest edit: a bumped package.json reads as a dirty tree and would make
 * `dirty` always true.
 */
export function readGitProvenance(pkgDir) {
  if (git("rev-parse --is-inside-work-tree", pkgDir) !== "true") {
    return { sha: null, shaShort: null, branch: "detached", dirty: null };
  }
  const ref = git("rev-parse --abbrev-ref HEAD", pkgDir);
  const status = git("status --porcelain", pkgDir);
  return {
    sha: git("rev-parse HEAD", pkgDir),
    shaShort: git(`rev-parse --short=${SHA_SHORT_LENGTH} HEAD`, pkgDir),
    branch: !ref || ref === "HEAD" ? "detached" : ref,
    dirty: status === null ? null : status !== "",
  };
}

/** Write the provenance file into the package root and return the record. */
export function writeBuildInfo(pkgDir, { name, version, git: gitState }) {
  const info = {
    name,
    version,
    ...gitState,
    packedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(pkgDir, BUILD_INFO_FILE), JSON.stringify(info, null, 2) + "\n");
  return info;
}
