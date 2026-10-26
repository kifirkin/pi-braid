/**
 * pack-compare — the three answers, and the code each one carries.
 *
 * pack-compare.mjs exists because "the registry serves the tree this commit
 * builds" cannot be answered by comparing bytes: two packs of one tree differ
 * in gzip framing, entry order, and the provenance record's own timestamp.
 * Unpacked, they differ in nothing else — which is a claim a release can act
 * on, and one that only holds if the tool under it distinguishes three states
 * rather than two. A tool that reports "different" when it failed to read
 * would turn a corrupt download into a verdict about the tree; a tool that
 * reports "equal" when it read nothing would clear a release it never saw.
 *
 * Each case therefore pins one of the three codes (0 equal, 1 different,
 * 2 could not read), and the shape of what is printed for the middle one. The
 * archives are written with the shell's `tar`: no tar-writing module is
 * installed in this repository (there is no `tar` or `tar-stream` under
 * `node_modules`), and a fixture that hand-wrote headers would share its bugs
 * with the reader it is testing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** This checkout: packages/core/test/runtime/release back up to the root. */
const REPO = resolve(HERE, "..", "..", "..", "..", "..");
const SCRIPT = join(REPO, "packages", "core", "scripts", "pack-compare.mjs");

const tempRoots = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * One provenance record, with the field the comparison must normalise.
 *
 * The stamp is computed rather than written out: what the field holds is the
 * packer's business, and a reader that only replaces the value must not be
 * able to depend on its format.
 */
const record = (name, stamp) =>
  `${JSON.stringify({ name, version: "1.0.0", sha: "0000000", dirty: false, packedAt: stamp }, null, 2)}\n`;

const STAMP_A = new Date(0).toISOString();
const STAMP_B = new Date(1_000_000_000).toISOString();

const TREE = {
  "build-info.json": record("fixture", STAMP_A),
  "index.js": "export const answer = 42;\n",
  "nested/leaf.txt": "a leaf\n",
};

/** Write `files` under a staging directory and archive it with the shell's tar. */
function pack(files) {
  const staging = tempDir("pack-compare-stage-");
  for (const [path, content] of Object.entries(files)) {
    const target = join(staging, "pkg", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const archive = join(tempDir("pack-compare-out-"), "pkg.tgz");
  // A packaged tree is archived as `pkg/…`, which is the shape npm emits; the
  // prefix is kept by the comparison rather than stripped, so the fixture's
  // paths and a real tarball's read the same way.
  const tar = spawnSync("tar", ["-czf", archive, "-C", staging, "pkg"], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  assert.equal(tar.status, 0, `tar could not write the fixture archive: ${tar.stderr}`);
  return archive;
}

/**
 * Run the tool, and refuse to read anything into a run that never started.
 *
 * A spawn of a missing file still exits non-zero and prints nothing, so a case
 * that only asserts the code can pass because its subject was absent — the one
 * failure mode a comparison fixture must not have. Both guards below fail the
 * case loudly in that state.
 */
function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  const err = result.stderr ?? "";
  assert.ok(
    !/Cannot find module|ERR_MODULE_NOT_FOUND/.test(err),
    `pack-compare.mjs did not run: ${err.trim()}`,
  );
  assert.notEqual(result.status, null, `pack-compare.mjs did not start: ${result.error}`);
  return { code: result.status, out: result.stdout ?? "", err };
}

const compare = (a, b) => run([a, b]);

test("two packs of one tree are equal, and the one normalised field is named", () => {
  const a = pack(TREE);
  const b = pack({ ...TREE, "build-info.json": record("fixture", STAMP_B) });

  const { code, out } = compare(a, b);
  assert.equal(code, 0, `expected equality, got exit ${code}: ${out}`);
  assert.match(out, /identical/i);
  // The reader has to be able to see that a difference existed and was
  // accounted for; an unqualified "identical" would hide the normalisation.
  assert.match(out, /packedAt/);
  assert.match(out, /build-info\.json/);
});

test("the same archive twice is equal, byte for byte", () => {
  const a = pack(TREE);
  const copy = join(tempDir("pack-compare-copy-"), "copy.tgz");
  copyFileSync(a, copy);

  const { code, out } = compare(a, copy);
  assert.equal(code, 0, `expected equality, got exit ${code}: ${out}`);
  assert.ok(!/packedAt/.test(out), `nothing was normalised, so nothing should be reported: ${out}`);
});

test("a changed file is exit 1 and the path is named", () => {
  const a = pack(TREE);
  const b = pack({ ...TREE, "index.js": "export const answer = 43;\n" });

  const { code, out } = compare(a, b);
  assert.equal(code, 1, `expected a difference, got exit ${code}: ${out}`);
  assert.match(out, /pkg\/index\.js/);
  // Only the changed path: a report that lists the whole tree is not a report.
  assert.ok(!out.includes("pkg/nested/leaf.txt"), `an unchanged path was reported: ${out}`);
});

test("a path on one side only is exit 1, and says which side", () => {
  const a = pack(TREE);
  const b = pack({ ...TREE, "extra/only-here.txt": "one side\n" });

  const { code, out } = compare(a, b);
  assert.equal(code, 1, `expected a difference, got exit ${code}: ${out}`);
  assert.match(out, /pkg\/extra\/only-here\.txt/);
  assert.match(out, /only in b/i);
});

test("a surviving difference is reported even when the provenance stamps differ too", () => {
  const a = pack(TREE);
  const b = pack({
    ...TREE,
    "build-info.json": record("fixture", STAMP_B),
    "nested/leaf.txt": "a different leaf\n",
  });

  const { code, out } = compare(a, b);
  assert.equal(code, 1, `expected a difference, got exit ${code}: ${out}`);
  assert.match(out, /pkg\/nested\/leaf\.txt/);
  // The provenance field is normalised, not suppressed: it must not appear as
  // the reason once another file differs for real.
  assert.ok(!/packedAt .*differ/.test(out), `the normalised field was reported as a difference: ${out}`);
});

test("a path that does not exist is exit 2, never exit 1", () => {
  const a = pack(TREE);
  const missing = join(tempDir("pack-compare-missing-"), "absent.tgz");

  const { code, out, err } = compare(a, missing);
  assert.equal(code, 2, `a missing path must not read as a difference: exit ${code} ${out}`);
  assert.match(err, /absent\.tgz/);
});

test("a file that is not a tarball is exit 2", () => {
  const a = pack(TREE);
  const notTar = join(tempDir("pack-compare-junk-"), "junk.tgz");
  writeFileSync(notTar, "this is not an archive\n");

  const { code, out } = compare(a, notTar);
  assert.equal(code, 2, `an unreadable archive must not read as a difference: exit ${code} ${out}`);
});

test("the arguments are exactly two tarballs", () => {
  const a = pack(TREE);
  const one = run([a]);
  assert.equal(one.code, 2, `one argument must be a usage error: exit ${one.code}`);
  assert.match(one.err, /usage/i);

  const none = run([]);
  assert.equal(none.code, 2, `no arguments must be a usage error: exit ${none.code}`);
});

test("the same inputs print the same lines", () => {
  const a = pack(TREE);
  const b = pack({ ...TREE, "index.js": "export const answer = 43;\n" });

  const first = compare(a, b);
  const second = compare(a, b);
  assert.equal(first.code, 1);
  assert.equal(second.code, 1);
  assert.equal(second.out, first.out, "the comparison is not deterministic");
});

test("a large difference is bounded and says how much it left out", () => {
  const a = pack(TREE);
  const changed = { ...TREE };
  for (let i = 0; i < 40; i++) changed[`bulk/file-${i}.txt`] = `value ${i}\n`;
  const b = pack(changed);

  const { code, out } = compare(a, b);
  assert.equal(code, 1, `expected a difference, got exit ${code}: ${out}`);
  const lines = out.trimEnd().split("\n").length;
  assert.ok(lines <= 30, `the report is not bounded: ${lines} lines`);
  assert.match(out, /more/, `a bounded report must say how many paths it omitted: ${out}`);
});

test("the comparison does not write into either archive's directory", () => {
  const a = pack(TREE);
  const b = pack({ ...TREE, "build-info.json": record("fixture", STAMP_B) });
  const before = readdirSync(dirname(a)).sort();

  compare(a, b);

  assert.deepEqual(readdirSync(dirname(a)).sort(), before, "the tool left files behind");
  assert.ok(statSync(a).isFile(), "the archive was consumed");
});
