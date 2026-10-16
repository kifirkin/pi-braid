/**
 * test-pack-provenance.mjs — the pack-time record, held by fixtures.
 *
 * Two halves. The writer's own contract is driven in a throwaway git work tree
 * — a real repository, because the record's sha, branch and dirty flag come
 * from git: the version is the manifest's, a stale record is replaced, and a
 * record that already describes the pack is left alone (that is the path
 * publish-local.mjs relies on, since it writes the record before it bumps the
 * manifest and the pack would otherwise read the bump as a dirty tree).
 *
 * The end-to-end half drives one real `npm pack` of the markdown-only skills
 * workspace — the cheapest package whose pack exercises the wired
 * prepack/postpack pair — and reads the record back out of the tarball with
 * tar. It also checks the tree the pack ran in: the record is gone again and
 * the checkout is not left with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// This file sits in packages/core/test/runtime/release/.
const CORE = join(HERE, "../../..");
const ROOT = join(CORE, "..", "..");
const WRITER = join(CORE, "scripts", "pack-provenance.mjs");
const SKILLS = join(ROOT, "packages", "skills");

const BUILD_INFO_FILE = "build-info.json";

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** A committed fixture package, so the writer has a work tree to read. */
function buildFixture({ name = "fixture-pack", version = "1.2.3" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pack-provenance-test-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version, license: "MIT" }, null, 2) + "\n",
  );
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(["-c", "init.defaultBranch=main", "init", "-q"], dir);
  git(["add", "-A"], dir);
  git(["-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "commit", "-q", "-m", "fixture"], dir);
  return { dir, name, version };
}

/** Run the writer the way npm runs a lifecycle script: the manifest it acts on is passed in. */
function write(dir, args = [], env = {}) {
  return spawnSync(process.execPath, [WRITER, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, npm_package_json: join(dir, "package.json"), ...env },
  });
}

function record(dir) {
  return JSON.parse(readFileSync(join(dir, BUILD_INFO_FILE), "utf8"));
}

function putRecord(dir, info) {
  writeFileSync(join(dir, BUILD_INFO_FILE), JSON.stringify(info, null, 2) + "\n");
}

test("write records the manifest it runs in, from git", () => {
  const fx = buildFixture();
  try {
    const head = git(["rev-parse", "HEAD"], fx.dir);
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], fx.dir);
    const res = write(fx.dir, ["write"]);
    assert.equal(res.status, 0, `write must exit 0: ${res.stderr}`);
    const info = record(fx.dir);
    assert.equal(info.name, fx.name, "the record must name the package it sits in");
    assert.equal(info.version, fx.version, "the record must carry the version being packed");
    assert.equal(info.sha, head, "the record must carry the commit being packed");
    assert.equal(info.shaShort, head.slice(0, 7), "the short sha must be the short form of that commit");
    assert.equal(info.branch, branch, "the record must carry the branch");
    assert.equal(info.dirty, false, "a clean tree must not be recorded as dirty");
    assert.match(info.packedAt, /^\d{4}-\d{2}-\d{2}T/, "the record must carry a timestamp");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("write replaces a record that names another commit or another version", () => {
  const fx = buildFixture();
  try {
    const head = git(["rev-parse", "HEAD"], fx.dir);
    const stale = { name: fx.name, version: fx.version, sha: "0".repeat(40), packedAt: "2000-01-01T00:00:00.000Z" };
    putRecord(fx.dir, stale);
    assert.equal(write(fx.dir, ["write"]).status, 0);
    assert.equal(record(fx.dir).sha, head, "a record from another commit must not survive a pack");

    putRecord(fx.dir, { ...stale, sha: head, version: "0.0.1" });
    assert.equal(write(fx.dir, ["write"]).status, 0);
    assert.equal(record(fx.dir).version, fx.version, "a record of another version must not survive a pack");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("write keeps a record that already describes this pack", () => {
  const fx = buildFixture();
  try {
    const head = git(["rev-parse", "HEAD"], fx.dir);
    const written = { name: fx.name, version: fx.version, sha: head, packedAt: "2000-01-01T00:00:00.000Z" };
    putRecord(fx.dir, written);
    const res = write(fx.dir, ["write"]);
    assert.equal(res.status, 0, `write must exit 0: ${res.stderr}`);
    assert.deepEqual(
      record(fx.dir),
      written,
      "a record written before the pack (the publish-local path) must not be rewritten",
    );
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("write marks a tree that was edited after the commit", () => {
  const fx = buildFixture();
  try {
    writeFileSync(join(fx.dir, "README.md"), "# fixture\nedited\n");
    assert.equal(write(fx.dir, ["write"]).status, 0);
    assert.equal(record(fx.dir).dirty, true, "an edited tree must be recorded as dirty");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("remove takes the record away, and is quiet when there is none", () => {
  const fx = buildFixture();
  try {
    assert.equal(write(fx.dir, ["write"]).status, 0);
    assert.ok(existsSync(join(fx.dir, BUILD_INFO_FILE)), "the fixture must hold a record to remove");
    assert.equal(write(fx.dir, ["remove"]).status, 0);
    assert.ok(!existsSync(join(fx.dir, BUILD_INFO_FILE)), "remove must delete the record");
    assert.equal(write(fx.dir, ["remove"]).status, 0, "remove must succeed when there is nothing to remove");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("write refuses an unknown verb", () => {
  const fx = buildFixture();
  try {
    assert.notEqual(write(fx.dir, []).status, 0, "a missing verb must be refused");
    assert.notEqual(write(fx.dir, ["pack"]).status, 0, "an unknown verb must be refused");
    assert.ok(!existsSync(join(fx.dir, BUILD_INFO_FILE)), "a refused run must write nothing");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("write refuses a run with no package to act on", () => {
  const fx = buildFixture();
  try {
    // Exactly the standalone shape: no lifecycle variable, so no manifest the
    // pack-time record could belong to.
    const res = write(fx.dir, ["write"], { npm_package_json: undefined });
    assert.equal(res.status, 2, `a run outside npm's lifecycle must be refused: ${res.stderr}`);
    assert.match(res.stderr, /npm_package_json/, "the refusal must name what is missing");
    assert.ok(!existsSync(join(fx.dir, BUILD_INFO_FILE)), "a refused run must write nothing");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("a real pack ships the record and leaves the tree as it found it", () => {
  const dest = mkdtempSync(join(tmpdir(), "pack-provenance-tarball-"));
  const manifest = JSON.parse(readFileSync(join(SKILLS, "package.json"), "utf8"));
  try {
    const packed = spawnSync("npm", ["pack", "-w", "packages/skills", "--pack-destination", dest], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(packed.status, 0, `npm pack must exit 0: ${packed.stdout}\n${packed.stderr}`);

    const tarballs = readdirSync(dest).filter((f) => f.endsWith(".tgz"));
    assert.deepEqual(tarballs, [`${manifest.name}-${manifest.version}.tgz`], "npm must name the tarball for the manifest");

    const listing = spawnSync("tar", ["-tzf", join(dest, tarballs[0])], { encoding: "utf8" });
    assert.equal(listing.status, 0, `tar must list the tarball: ${listing.stderr}`);
    assert.ok(
      listing.stdout.split("\n").includes(`package/${BUILD_INFO_FILE}`),
      `the tarball must contain package/${BUILD_INFO_FILE}:\n${listing.stdout}`,
    );

    const extracted = spawnSync("tar", ["-xzOf", join(dest, tarballs[0]), `package/${BUILD_INFO_FILE}`], {
      encoding: "utf8",
    });
    assert.equal(extracted.status, 0, `tar must extract the record: ${extracted.stderr}`);
    const info = JSON.parse(extracted.stdout);
    assert.equal(info.name, manifest.name, "the shipped record must name the package");
    assert.equal(info.version, manifest.version, "the shipped record must carry the packed version");
    assert.ok(info.sha, "the shipped record must carry a commit sha");

    assert.ok(
      !existsSync(join(SKILLS, BUILD_INFO_FILE)),
      "postpack must remove the record from the tree it packed",
    );
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});
