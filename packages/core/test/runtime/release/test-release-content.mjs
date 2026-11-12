/**
 * check-release-content — the ledger's claims, and the five states it must tell
 * apart.
 *
 * The tool exists because a version can be on the registry while the tree
 * carries content that version never shipped: the publish loop skips a version
 * the registry already serves, so the change is never uploaded and no check
 * notices. Every case here pins one of the states that make the record
 * trustworthy:
 *
 *   - a version packs to the same content twice, even though the tarballs
 *     themselves differ (the provenance record's clock, branch and short sha
 *     are the packer's environment, and the case asserts the byte difference
 *     before it asserts the equality, so a machine that packed too fast to
 *     differ cannot pass this case by accident)
 *   - content that moved under a recorded version is refused, naming the
 *     workspace, the version, both digests and the paths
 *   - nondeterminism anywhere other than the provenance record is refused, so
 *     the one exclusion cannot widen into "packs differ, ignore it"
 *   - a version the ledger does not hold is a new version, not a refusal, and
 *     checking writes nothing
 *   - recording never rewrites a recorded version, and a refused record writes
 *     nothing at all
 *
 * Plus the states in which the tool must refuse to answer: an unreadable
 * ledger is exit 2, never the pass an empty one gives.
 *
 * The workspaces are real `npm pack` runs against fixtures built in a temporary
 * directory, because the subject is what npm's packer puts in the tarball under
 * the package's own lifecycle. The provenance shape comes from the production
 * writer, wired as `prepack`/`postpack` exactly as every shipping manifest
 * wires it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** This checkout: packages/core/test/runtime/release back up to the root. */
const REPO = resolve(HERE, "..", "..", "..", "..", "..");
const SCRIPT = join(REPO, "packages", "core", "scripts", "check-release-content.mjs");
const PROVENANCE = join(REPO, "packages", "core", "scripts", "pack-provenance.mjs");
const LEDGER = "release-ledger.json";

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
 * One workspace: a manifest whose `files` allowlist is the shape the shipping
 * manifests use, a library file, and the production provenance writer as the
 * `prepack`/`postpack` pair.
 *
 * `prepackExtra` runs after the writer, which is how a case makes a pack
 * nondeterministic in a file that is *not* the record.
 */
function workspace(repo, { dir = "alpha", name = "fixture-alpha", version = "1.0.0", prepackExtra = null } = {}) {
  const pkgDir = join(repo, "packages", dir);
  mkdirSync(join(pkgDir, "lib"), { recursive: true });
  const prepack = [`node "${PROVENANCE}" write`, prepackExtra].filter(Boolean).join(" && ");
  const manifest = {
    name,
    version,
    files: ["lib/", "build-info.json"],
    scripts: { prepack, postpack: `node "${PROVENANCE}" remove` },
  };
  writeFileSync(join(pkgDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(pkgDir, "lib", "leaf.js"), "export const leaf = 1;\n");
  return { dir: pkgDir, manifestPath: join(pkgDir, "package.json"), name, version, key: `${name}@${version}` };
}

/** A repository root holding no ledger yet. */
function repo() {
  const root = join(tempDir("release-content-repo-"), "repo");
  mkdirSync(join(root, "packages"), { recursive: true });
  return root;
}

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  const err = result.stderr ?? "";
  assert.ok(!/Cannot find module|ERR_MODULE_NOT_FOUND/.test(err), `check-release-content.mjs did not run: ${err.trim()}`);
  assert.notEqual(result.status, null, `check-release-content.mjs did not start: ${result.error}`);
  return { code: result.status, out: result.stdout ?? "", err };
}

const check = (root) => run(["--check", "--root", root]);
const record = (root) => run(["--record", "--root", root]);

function ledgerBytes(root) {
  return readFileSync(join(root, LEDGER), "utf8");
}

function ledgerEntries(root) {
  return JSON.parse(ledgerBytes(root)).entries;
}

/** Pack a fixture workspace on its own, for a case that needs the artifact. */
function packFixture(workspace) {
  const out = tempDir("release-content-pack-");
  const result = spawnSync("npm", ["pack", "--pack-destination", out], { cwd: workspace.dir, encoding: "utf8" });
  assert.equal(result.status, 0, `the fixture workspace did not pack: ${result.stderr}`);
  const tarball = join(out, `${workspace.name}-${workspace.version}.tgz`);
  assert.ok(existsSync(tarball), `expected a tarball at ${tarball}`);
  return tarball;
}

test("a recorded version packs to the same content twice, though the tarballs differ", () => {
  const root = repo();
  const alpha = workspace(root);

  // The premise, measured before the claim: two packs of this tree are not
  // byte-identical, because the record carries the packer's clock.
  const first = readFileSync(packFixture(alpha));
  const second = readFileSync(packFixture(alpha));
  assert.ok(!first.equals(second), "the fixture must produce differing tarballs, or this case cannot witness the exclusion");

  assert.equal(record(root).code, 0, "recording the tree's own version must pass");
  for (const attempt of ["first", "second"]) {
    const { code, out } = check(root);
    assert.equal(code, 0, `the ${attempt} check of an unchanged tree must pass: ${out}`);
    assert.match(out, new RegExp(`${alpha.key}  unchanged`));
  }
});

test("the provenance record is excluded by name, and everything else is recorded", () => {
  const root = repo();
  const alpha = workspace(root);
  assert.equal(record(root).code, 0);

  const files = ledgerEntries(root)[alpha.key].files;
  assert.ok(Object.keys(files).includes("lib/leaf.js"), `a shipped file must be recorded: ${Object.keys(files)}`);
  assert.ok(Object.keys(files).includes("package.json"), `the packed manifest is content: ${Object.keys(files)}`);
  // Its fields are the packer's environment; a ledger that recorded it would
  // refuse on the recorder's branch name.
  assert.equal("build-info.json" in files, false, `the record must not be content: ${Object.keys(files)}`);
  assert.match(Object.values(files)[0], /^[0-9a-f]{64}$/);
});

test("content that moved under a recorded version is refused, with both digests and the path", () => {
  const root = repo();
  const alpha = workspace(root);
  const other = workspace(root, { dir: "beta", name: "fixture-beta" });
  assert.equal(record(root).code, 0);

  writeFileSync(join(alpha.dir, "lib", "leaf.js"), "export const leaf = 2;\n");
  const { code, out, err } = check(root);

  assert.equal(code, 1, `a changed file under a recorded version must refuse: ${out}${err}`);
  const said = `${out}${err}`;
  assert.match(said, new RegExp(`refusing: ${alpha.key.replace(".", "\\.")}`), said);
  assert.match(said, /recorded {2}sha256:[0-9a-f]{64}/, said);
  assert.match(said, /packed {4}sha256:[0-9a-f]{64}/, said);
  assert.match(said, /changed {2}lib\/leaf\.js/, said);
  // The one action that resolves it, and the file it is taken in.
  assert.match(said, /bump the version in/, said);
  assert.match(said, /packages\/alpha\/package\.json/, said);
  // The other workspace is untouched by its neighbour's refusal.
  assert.match(out, new RegExp(`${other.key}  unchanged`), out);
});

test("nondeterminism in a shipped file is refused, so the exclusion cannot widen", () => {
  const root = repo();
  // The record is the only tolerated difference: the same shape written into a
  // library file has to be caught, or the tool would accept any pack at all.
  workspace(root, {
    prepackExtra: `node -e "require('fs').writeFileSync('lib/stamp.js', String(Math.random()))"`,
  });
  assert.equal(record(root).code, 0);

  const { code, err } = check(root);
  assert.equal(code, 1, `a random shipped file must be refused: ${err}`);
  assert.match(err, /changed {2}lib\/stamp\.js/, err);
});

test("a version the ledger does not hold is a new version, and checking writes nothing", () => {
  const root = repo();
  const alpha = workspace(root, { version: "2.0.0" });
  assert.equal(existsSync(join(root, LEDGER)), false, "the fixture starts with no ledger");

  const { code, out } = check(root);
  assert.equal(code, 0, `an unrecorded version is not a refusal: ${out}`);
  assert.match(out, new RegExp(`${alpha.key}  no ledger entry`), out);
  // A check that wrote would let a run bless whatever it happened to pack.
  assert.equal(existsSync(join(root, LEDGER)), false, "checking must not create the ledger");
});

test("--require-recorded turns a missing entry into a refusal, and only means something with --check", () => {
  const root = repo();
  const alpha = workspace(root);

  // The release boundary needs the record to exist before the artifact does:
  // otherwise nothing can say afterwards what a published version contained.
  const refused = run(["--check", "--require-recorded", "--root", root]);
  assert.equal(refused.code, 1, `an unrecorded version must not publish: ${refused.out}${refused.err}`);
  assert.match(refused.err, new RegExp(`refusing: ${alpha.key} has no ledger entry`), refused.err);
  assert.match(refused.err, /npm run release:content:record/, refused.err);
  assert.equal(existsSync(join(root, LEDGER)), false, "a refusal must not write the ledger");

  // The other modes report their own state; a flag they ignore would let a run
  // claim a policy it never applied.
  for (const args of [["--record", "--require-recorded"], ["--verify-published", "--require-recorded"]]) {
    const { code, err } = run([...args, "--root", root]);
    assert.equal(code, 2, `${args.join(" ")} must be refused: ${err}`);
    assert.match(err, /applies to --check only/, err);
  }
  // And the mode flag itself belongs to --record.
  const seedElsewhere = run(["--check", "--seed-from-registry", "--root", root]);
  assert.equal(seedElsewhere.code, 2, `--seed-from-registry applies to --record: ${seedElsewhere.err}`);
  assert.match(seedElsewhere.err, /applies to --record only/, seedElsewhere.err);
});

test("an entry says whether its content came from the tree", () => {
  const root = repo();
  const alpha = workspace(root);
  assert.equal(record(root).code, 0);

  // A seeded entry (recorded from the registry) must be distinguishable from
  // one recorded from a release's tree, or a reader cannot tell which claim an
  // entry makes.
  assert.equal(ledgerEntries(root)[alpha.key].source, "tree");
});

test("recording refuses to rewrite a recorded version, and writes nothing when it refuses", () => {
  const root = repo();
  const alpha = workspace(root);
  assert.equal(record(root).code, 0);
  const before = ledgerBytes(root);

  writeFileSync(join(alpha.dir, "lib", "leaf.js"), "export const leaf = 3;\n");
  const { code, out, err } = record(root);

  assert.equal(code, 1, `a record over changed content must refuse: ${out}${err}`);
  assert.match(err, /nothing was recorded/, err);
  // Rewriting the entry is how a release launders the failure this tool exists
  // to catch; the recorded content has to survive the attempt.
  assert.equal(ledgerBytes(root), before, "a refused record must leave the ledger untouched");
});

test("recording twice is a no-op, and a prerelease is never recorded", () => {
  const root = repo();
  workspace(root);
  const preview = workspace(root, { dir: "gamma", name: "fixture-gamma", version: "3.0.0-next.1" });
  assert.equal(record(root).code, 0);
  const once = ledgerBytes(root);

  const { code, out } = record(root);
  assert.equal(code, 0, out);
  assert.match(out, /already recorded/, out);
  assert.equal(ledgerBytes(root), once, "a record with nothing to add must not rewrite the ledger");

  // The release workflow never publishes a prerelease, so there is no content
  // on the registry to protect, and recording one would churn every iteration.
  assert.equal(preview.key in ledgerEntries(root), false, "a prerelease must not be recorded");
  assert.match(out, /prerelease, never published/, out);
});

test("an unreadable ledger is exit 2, never the pass an empty one gives", () => {
  const root = repo();
  const alpha = workspace(root);
  const cases = {
    "not JSON": "{ not json",
    "no entries object": JSON.stringify({ version: 1, entries: [] }),
    "an entry without a files map": JSON.stringify({ version: 1, entries: { [alpha.key]: {} } }),
    "a digest that is not sha256": JSON.stringify({ version: 1, entries: { [alpha.key]: { files: { "lib/leaf.js": "deadbeef" } } } }),
    "an unknown format": JSON.stringify({ version: 99, entries: {} }),
  };

  for (const [what, text] of Object.entries(cases)) {
    writeFileSync(join(root, LEDGER), text);
    const { code, out, err } = check(root);
    assert.equal(code, 2, `${what} must be a refusal to answer, got exit ${code}: ${out}${err}`);
    assert.match(err, /check-release-content: /, `${what} must say it could not answer: ${err}`);
    // The failure mode this pins: a damaged entry read as an absent one would
    // report "a new version to publish" and clear the release.
    assert.doesNotMatch(out, /unchanged/, `${what} must not report content as checked: ${out}`);
  }
});

test("a root with no publishable workspace is exit 2", () => {
  const root = repo();
  const { code, err } = check(root);
  assert.equal(code, 2, `an empty packages directory cannot be vouched for: ${err}`);
  assert.match(err, /holds no publishable workspace/, err);
});

test("the command line refuses what it cannot mean", () => {
  const root = repo();
  workspace(root);
  const cases = {
    "two modes": ["--check", "--record", "--root", root],
    "an unknown argument": ["--nonsense", "--root", root],
    "a flag without its value": ["--root"],
  };
  for (const [what, args] of Object.entries(cases)) {
    const { code, err } = run(args);
    assert.equal(code, 2, `${what} must be refused, got exit ${code}: ${err}`);
  }
  // A missing --root value must not be read as "no root", which would fall back
  // to the caller's own checkout and compare the wrong tree.
  const { err } = run(["--ledger", "--record"]);
  assert.match(err, /--ledger/, err);
});
