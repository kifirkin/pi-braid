#!/usr/bin/env node
/**
 * stage-changelog.mjs — the release notes go into the pack, and come back out.
 *
 * npm's `files` allowlist is package-relative. The repository keeps one
 * changelog at its root, above the package, so no allowlist entry can name it
 * and a packed `pi-braid` would carry no changelog at all. This pair stages
 * that file at the package root for the duration of the pack and removes it
 * afterwards, which gives the artifact the notes without giving the repository
 * a second copy to drift: the file that ships is always the one the released
 * tree holds.
 *
 *   node scripts/stage-changelog.mjs write    # prepack
 *   node scripts/stage-changelog.mjs remove   # postpack
 *
 * The staged path is gitignored, so an interrupted pack cannot leave the
 * checkout reading as dirty either way. The source is resolved the way
 * release-notes.mjs resolves it in a source tree — three levels above
 * `packages/core/scripts` — so the two agree about which file the release is.
 *
 * The package being packed comes from `npm_package_json`, which a lifecycle
 * script is handed. Without it there is no package to stage into and the run is
 * refused: this is a prepack/postpack step, not a standalone command.
 *
 * Usage: node packages/core/scripts/stage-changelog.mjs write|remove
 * Exit: 0 staged (write) / gone (remove); 2 no package to act on;
 *       1 the repository's changelog is missing or the copy could not be made.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const CHANGELOG_FILE = "CHANGELOG.md";

// Diagnostics go to stderr: `npm pack --json` owns stdout, and a lifecycle
// script that prints there corrupts its output.
const say = (message) => console.error(`[stage-changelog] ${message}`);

const mode = process.argv[2];
if (mode !== "write" && mode !== "remove") {
  say(`usage: stage-changelog.mjs write|remove (got "${mode ?? ""}")`);
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
const staged = path.join(pkgDir, CHANGELOG_FILE);

if (mode === "remove") {
  fs.rmSync(staged, { force: true });
  process.exit(0);
}

const source = path.resolve(pkgDir, "..", "..", CHANGELOG_FILE);
let text;
try {
  text = fs.readFileSync(source, "utf8");
} catch (error) {
  say(`cannot read ${source}: ${error.code ?? error.message}`);
  process.exit(1);
}
try {
  fs.writeFileSync(staged, text);
} catch (error) {
  say(`cannot write ${staged}: ${error.code ?? error.message}`);
  process.exit(1);
}
say(`${staged} staged from ${source} (${text.length} bytes)`);
