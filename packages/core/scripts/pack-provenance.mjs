#!/usr/bin/env node
/**
 * pack-provenance.mjs — the record goes into the pack, and comes back out.
 *
 * Every workspace manifest wires this as its `prepack` / `postpack` pair, so
 * any tarball — from `npm pack` or from `npm publish`, which packs first —
 * carries `build-info.json`, and the checkout it was made from ends as it
 * started: the record is generated before the pack and removed after it. The
 * file is gitignored too, so an interrupted pack cannot make the tree read as
 * dirty either way.
 *
 *   node scripts/pack-provenance.mjs write    # prepack
 *   node scripts/pack-provenance.mjs remove   # postpack
 *
 * The record is written for the package npm is packing: a lifecycle script is
 * handed that manifest in `npm_package_json`, and the record takes its `name`
 * and the version being packed from it, while sha, branch and dirty come from
 * `readGitProvenance` in `scripts/build-info.mjs`, the one generator. Without
 * that variable there is no package to record and the run is refused — the
 * script is a lifecycle step, not a standalone command.
 *
 * A record is kept only when the caller says so. publish-local.mjs reads git
 * before the version bump for the pack and writes the record from that read,
 * so the `dirty` it recorded is the pre-bump state; it carries
 * PROVENANCE_DEFER_ENV into `npm pack`, because a prepack that rewrote the
 * record there would read the temporary bump as a dirty tree. Without that
 * marker the record is always regenerated from a fresh git read — including
 * when a record on disk names this same pack, because a record a killed
 * `postpack` left behind describes a tree that no longer exists and must not
 * become the shipped `dirty`. The debug line names which of the two paths ran.
 *
 * Usage: node packages/core/scripts/pack-provenance.mjs write|remove
 * Exit: 0 the record is in place (write) / gone (remove); 2 no package to act on.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BUILD_INFO_FILE,
  PROVENANCE_DEFER_ENV,
  readGitProvenance,
  writeBuildInfo,
} from "./build-info.mjs";

// Diagnostics go to stderr: `npm pack --json` owns stdout, and a lifecycle
// script that prints there corrupts its output.
const say = (message) => console.error(`[pack-provenance] ${message}`);

const mode = process.argv[2];
if (mode !== "write" && mode !== "remove") {
  say(`usage: pack-provenance.mjs write|remove (got "${mode ?? ""}")`);
  process.exit(2);
}

const manifestPath = process.env.npm_package_json;
if (!manifestPath) {
  say(
    "no npm_package_json: this is the prepack/postpack step of a workspace manifest and runs through npm",
  );
  process.exit(2);
}
const pkgDir = path.dirname(manifestPath);
const infoPath = path.join(pkgDir, BUILD_INFO_FILE);

if (mode === "remove") {
  fs.rmSync(infoPath, { force: true });
  process.exit(0);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (e) {
  say(`cannot read ${manifestPath}: ${e.message}`);
  process.exit(1);
}
const { name, version } = manifest;
if (typeof name !== "string" || typeof version !== "string") {
  say(`${manifestPath}: no name/version to record`);
  process.exit(1);
}

const git = readGitProvenance(pkgDir);
const deferRequested = process.env[PROVENANCE_DEFER_ENV] === "1";

/**
 * Does the record on disk describe this very pack? Only ever asked when the
 * caller requested the deferral; it guards against keeping a record the
 * caller did not write for this pack (another commit, version or package).
 */
function describesThisPack() {
  if (!git.sha) return false;
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  } catch {
    return false;
  }
  return existing?.name === name && existing?.version === version && existing?.sha === git.sha;
}

if (deferRequested && describesThisPack()) {
  say(`${name}@${version} ${git.shaShort}: record written by the caller kept (${PROVENANCE_DEFER_ENV})`);
  process.exit(0);
}

if (fs.existsSync(infoPath)) {
  say(
    deferRequested
      ? `${name}@${version}: the record present does not describe this pack, rewritten`
      : `${name}@${version}: record present without the caller's deferral marker, rewritten from a fresh git read`,
  );
}

const info = writeBuildInfo(pkgDir, { name, version, git });
say(`${info.name}@${info.version} ${info.shaShort ?? "(no git)"} dirty=${info.dirty} written`);
