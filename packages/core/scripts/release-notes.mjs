#!/usr/bin/env node
/**
 * release-notes.mjs — print the CHANGELOG section a core version names.
 *
 * The publish workflow creates a GitHub Release for the version a tag names,
 * and that entry's body is the changelog section for the same version. The
 * extraction lives here rather than in shell inside the workflow because the
 * rules need a fixture: "does this heading name that version" is the kind of
 * match a one-liner gets subtly wrong, and a workflow step has no harness of
 * its own to notice. Two of those rules are the reason this file exists:
 * `0.41.0` must never answer with the `0.41.2` section, and a sibling
 * package's version in a multi-package heading must not answer at all.
 *
 * Usage: node packages/core/scripts/release-notes.mjs <version>
 *
 * Exit codes, because the caller acts on the difference:
 *   0  the section body is on stdout, without its heading line
 *   2  no section names that version — the caller generates notes instead
 *   1  the question could not be answered: the argument is not a stable
 *      version, or the changelog could not be read. The caller fails here
 *      rather than falling back, because a fallback would hide both.
 *
 * The changelog read is this repository's own, resolved from this script's
 * location. There is deliberately no path argument: the release body cannot
 * then be built from a different copy of the file than the tree being released.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHANGELOG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "CHANGELOG.md");

/** What a release tag names and the registry serves: a stable `x.y.z`. */
const STABLE = /^\d+\.\d+\.\d+$/;

/**
 * The version a `## ` heading attaches to Core, or null when it names none.
 *
 * A heading lists one entry per package that moved in the train (`Core — 0.40.2
 * / Telegram — 0.1.5`), so the version naming the release is the one attached to
 * `Core`: `0.1.5` in that heading names Telegram and must not be answered with.
 * The segment test is anchored at the start of the heading or at a ` /`
 * separator, so a word that merely ends in "core" cannot match.
 *
 * The dash is the em dash the file's headings carry; an ASCII hyphen is accepted
 * as well, so a heading written by hand is read rather than reported absent.
 */
function coreVersion(line) {
  if (!/^## /.test(line)) return null;
  const match = /(?:^|\/)\s*Core\s+[-\u2014]\s+(\S+)/.exec(line.slice(3));
  return match ? match[1] : null;
}

const [, , version] = process.argv;

if (!version || !STABLE.test(version)) {
  const got = version === undefined ? "no argument" : JSON.stringify(version);
  console.error(`release-notes: expected a stable version (0.42.0 form), got ${got}`);
  process.exit(1);
}

let changelog;
try {
  changelog = readFileSync(CHANGELOG, "utf8");
} catch (error) {
  console.error(`release-notes: cannot read ${CHANGELOG}: ${error.code ?? error.message}`);
  process.exit(1);
}

const lines = changelog.split("\n");
const heading = lines.findIndex((line) => coreVersion(line) === version);

if (heading === -1) {
  console.error(`release-notes: no section for ${version} in ${CHANGELOG}`);
  process.exit(2);
}

// The section runs from the line after its heading to the line before the next
// level-2 heading. Subsection headings (`###`) sit inside it: every release
// section carries one per package that moved, and ending there would truncate
// the body to its first package.
const next = lines.findIndex((line, index) => index > heading && /^## /.test(line));
const body = lines
  .slice(heading + 1, next === -1 ? lines.length : next)
  .join("\n")
  .trim();

process.stdout.write(`${body}\n`);
