/**
 * test-release-notes.mjs — the section extract, and the boundaries it must not
 * cross.
 *
 * release-notes.mjs runs on the release path: the publish workflow puts its
 * stdout into the GitHub Release body for a version tag, reads exit 2 as "this
 * version has no changelog section", and fails the step on anything else. The
 * two expensive failures are therefore a wrong section published as the release
 * prose, and a section that is present reported absent so the generated commit
 * list ships in its place.
 *
 * Each case lays the real script out under a throwaway root at the repository
 * path it expects (`packages/core/scripts/`), and writes the changelog that case
 * needs. Copying the script rather than pointing it at a file is deliberate: the
 * script resolves `CHANGELOG.md` three levels above itself and takes no path, so
 * the fixture moves the script into the tree it should read. The last case runs
 * the script in this checkout, which is what pins that resolution for real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** This checkout: packages/core/test/runtime/release back up to the root. */
const REPO = resolve(HERE, "..", "..", "..", "..", "..");
const SCRIPT = join(REPO, "packages", "core", "scripts", "release-notes.mjs");
const REAL_CHANGELOG = join(REPO, "CHANGELOG.md");

/** The dash the shipped headings carry; the parser reads an ASCII hyphen too. */
const DASH = "\u2014";

/** `Core — 0.41.0 (subject)`, the heading shape a core release section uses. */
const coreHeading = (version, subject) => `Core ${DASH} ${version} (${subject})`;

/** A changelog document over `[heading, body]` sections. */
function document(sections) {
  return [
    "# Changelog",
    "",
    "Two tag roles, one namespace per package.",
    "",
    "## Repository history",
    "",
    "One consolidated commit.",
    "",
    ...sections.flatMap(([heading, body]) => [`## ${heading}`, "", body, ""]),
  ].join("\n");
}

/** Lay the real script out under `root` at its repository path. */
function install(root) {
  const target = join(root, "packages", "core", "scripts", "release-notes.mjs");
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(SCRIPT, target);
  return target;
}

/**
 * A throwaway repository root holding the real script.
 *
 * `changelog === null` writes no changelog at all, which is the
 * nothing-to-read arm.
 */
function fixture(changelog) {
  const root = mkdtempSync(join(tmpdir(), "release-notes-"));
  const script = install(root);
  if (changelog !== null) writeFileSync(join(root, "CHANGELOG.md"), changelog);
  return script;
}

function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const SINGLE = document([
  [coreHeading("0.40.5", "package discovery metadata"), "Body line one.\nBody line two."],
]);

test("the section body comes back, without its heading line", () => {
  const { code, out, err } = run(fixture(SINGLE), ["0.40.5"]);
  assert.equal(code, 0);
  assert.equal(out, "Body line one.\nBody line two.\n");
  assert.equal(err, "", "a section that was found says nothing on stderr");
});

const MULTI = document([
  [
    `Core ${DASH} 0.40.2 / Telegram ${DASH} 0.1.5 / Providers ${DASH} 1.0.6 (orchestrator close gates)`,
    "Multi body.",
  ],
]);

test("a multi-package heading answers for Core and never for a sibling's version", () => {
  const script = fixture(MULTI);

  const core = run(script, ["0.40.2"]);
  assert.equal(core.code, 0);
  assert.equal(core.out, "Multi body.\n");

  // 0.1.5 names Telegram in that heading. The publish path reads a package's
  // own version, so answering here would put another package's notes under
  // this release.
  const sibling = run(script, ["0.1.5"]);
  assert.equal(sibling.code, 2);
  assert.equal(sibling.out, "");
});

const NEIGHBOURS = document([
  [coreHeading("0.41.2", "the runtime floor"), "Newer body."],
  [coreHeading("0.41.0", "the supervisor fleet ships"), "Wanted body."],
  [coreHeading("0.41.02", "a longer token"), "Longer body."],
  [coreHeading("0.41.0-main.3", "a prerelease"), "Prerelease body."],
]);

test("a version is matched as a whole token, never as a prefix", () => {
  const { code, out } = run(fixture(NEIGHBOURS), ["0.41.0"]);
  assert.equal(code, 0);
  // Equality rather than a substring check: it also proves no neighbour's body
  // was appended to the answer.
  assert.equal(out, "Wanted body.\n");
});

const SUBSECTIONS = document([
  [
    coreHeading("0.41.0", "a train with two packages"),
    "### Core\n\n- **One** - first.\n- **Two** - second.\n\n### Telegram\n\n- **Three** - third.",
  ],
  [coreHeading("0.40.9", "the section after it"), "After body."],
]);

test("the section ends at the next level-2 heading, and keeps its subsections", () => {
  const { code, out } = run(fixture(SUBSECTIONS), ["0.41.0"]);
  assert.equal(code, 0);
  assert.equal(
    out,
    "### Core\n\n- **One** - first.\n- **Two** - second.\n\n### Telegram\n\n- **Three** - third.\n",
  );
  assert.ok(!out.includes("After body."), "the next section leaked into the body");
});

test("a version no heading names is exit 2, and the file is named", () => {
  const { code, out, err } = run(fixture(SINGLE), ["0.41.0"]);
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.match(err, /no section for 0\.41\.0/);
  assert.match(err, /CHANGELOG\.md/);
});

test("a changelog that cannot be read is exit 1, so absent and broken differ", () => {
  const { code, out, err } = run(fixture(null), ["0.40.5"]);
  assert.equal(code, 1);
  assert.equal(out, "");
  assert.match(err, /cannot read/);
  assert.match(err, /CHANGELOG\.md/);
});

test("an argument that is not a stable version is exit 1", () => {
  const script = fixture(SINGLE);

  // The tag name is the plausible mistake: `v0.42.0` is what a caller holds
  // when it reaches for the version, and a fall back to generated notes would
  // hide it on every release.
  const tag = run(script, ["v0.40.5"]);
  assert.equal(tag.code, 1);
  assert.match(tag.err, /stable version/);

  const missing = run(script);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /got no argument/);
});

test("in this checkout the script reads the repository's own changelog", () => {
  assert.ok(existsSync(REAL_CHANGELOG), `no changelog at ${REAL_CHANGELOG}`);

  // Resolution: a version no release ever carried has to name this repository's
  // file, not a copy a fixture wrote.
  const absent = run(SCRIPT, ["0.0.0"]);
  assert.equal(absent.code, 2);
  assert.ok(absent.err.includes(REAL_CHANGELOG), `stderr did not name ${REAL_CHANGELOG}`);

  // A landed version comes back from it, heading stripped. The version is
  // history, so this asserts the shipped heading shape as written rather than a
  // future edit's.
  const landed = run(SCRIPT, ["0.40.5"]);
  assert.equal(landed.code, 0);
  assert.notEqual(landed.out.trim(), "");
  assert.ok(!/^## /m.test(landed.out), "the heading line came back with the body");
});
