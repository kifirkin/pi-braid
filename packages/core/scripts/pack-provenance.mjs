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
 * An existing record that already describes this pack is kept, not rewritten.
 * publish-local.mjs writes the record itself before it bumps the manifest for
 * the pack, so the `dirty` it recorded is the tree's honest state; rewriting
 * at prepack time would read the temporary bump as a dirty tree. A record
 * naming another commit, another version or another package is stale and is
 * replaced. Outside a git work tree there is no sha to compare against, so
 * nothing is deferred to and the record is always written.
 *
 * Usage: node packages/core/scripts/pack-provenance.mjs write|remove
 * Exit: 0 the record is in place (write) / gone (remove); 2 no package to act on.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { BUILD_INFO_FILE, readGitProvenance, writeBuildInfo } from "./build-info.mjs";

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

/** Does the record on disk already describe this very pack? */
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

if (describesThisPack()) {
  say(`${name}@${version} ${git.shaShort}: existing record kept`);
  process.exit(0);
}

const info = writeBuildInfo(pkgDir, { name, version, git });
say(`${info.name}@${info.version} ${info.shaShort ?? "(no git)"} dirty=${info.dirty} written`);
