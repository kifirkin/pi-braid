/**
 * test-pack-provenance.mjs — the pack-time record, held by fixtures.
 *
 * Two halves. The writer's own contract is driven in a throwaway git work tree
 * — a real repository, because the record's sha, branch and dirty flag come
 * from git: the version is the manifest's, a record the caller's deferral
 * marker licenses is left alone, and every other record — including one that
 * matches the pack field for field — is regenerated from a fresh read.
 *
 * The end-to-end half packs real fixtures through npm: a leftover record on
 * an edited tree must not reach the tarball, and a pack carrying the caller's
 * marker must keep the caller's record. It also drives one `npm pack` of the
 * markdown-only skills workspace — the cheapest package whose pack exercises
 * the wired prepack/postpack pair — and checks the tree that pack ran in: the
 * record is gone again and the checkout is not left with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVENANCE_DEFER_ENV, readGitProvenance, writeBuildInfo } from "../../../scripts/build-info.mjs";

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
function buildFixture({ name = "fixture-pack", version = "1.2.3", files, scripts } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pack-provenance-test-"));
  const manifest = { name, version, license: "MIT" };
  if (files) manifest.files = files;
  if (scripts) manifest.scripts = scripts;
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  // The record is never tracked. Ignoring it keeps `dirty` attributable to a
  // caller's edit instead of to the pack's own leftover, which `git status`
  // would otherwise report as an untracked entry.
  writeFileSync(join(dir, ".gitignore"), `${BUILD_INFO_FILE}\n`);
  git(["-c", "init.defaultBranch=main", "init", "-q"], dir);
  git(["add", "-A"], dir);
  git(["-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "commit", "-q", "-m", "fixture"], dir);
  return { dir, name, version };
}

/** The prepack/postpack pair every workspace manifest wires, writer path quoted. */
function wiredScripts() {
  const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
  return {
    prepack: `node ${quote(WRITER)} write`,
    postpack: `node ${quote(WRITER)} remove`,
  };
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

/**
 * Pack the fixture through npm and read the record back out of the one
 * tarball it wrote. The caller removes the returned destination.
 */
function packFixture(dir, env = {}) {
  const dest = mkdtempSync(join(tmpdir(), "pack-provenance-tarball-"));
  const res = spawnSync("npm", ["pack", "--pack-destination", dest], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  assert.equal(res.status, 0, `npm pack must exit 0: ${res.stdout}\n${res.stderr}`);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const tarball = join(dest, `${manifest.name}-${manifest.version}.tgz`);
  const extracted = spawnSync("tar", ["-xzOf", tarball, `package/${BUILD_INFO_FILE}`], { encoding: "utf8" });
  assert.equal(extracted.status, 0, `tar must extract the record from ${tarball}: ${extracted.stderr}`);
  return { dest, tarball, record: JSON.parse(extracted.stdout) };
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

test("write keeps a record the caller wrote when the deferral marker is set", () => {
  const fx = buildFixture();
  try {
    const head = git(["rev-parse", "HEAD"], fx.dir);
    const written = { name: fx.name, version: fx.version, sha: head, packedAt: "2000-01-01T00:00:00.000Z" };
    putRecord(fx.dir, written);
    const res = write(fx.dir, ["write"], { [PROVENANCE_DEFER_ENV]: "1" });
    assert.equal(res.status, 0, `write must exit 0: ${res.stderr}`);
    assert.deepEqual(
      record(fx.dir),
      written,
      "the record publish-local wrote before its manifest bump must survive the prepack",
    );
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("write regenerates a matching record when no caller set the deferral marker", () => {
  const fx = buildFixture();
  try {
    const head = git(["rev-parse", "HEAD"], fx.dir);
    // The state a killed postpack leaves: a record naming this pack, written
    // while the tree was clean. The tree is edited afterwards — the ordinary
    // rebuild case — and the record may not outlive the tree it describes.
    const leftover = {
      name: fx.name,
      version: fx.version,
      sha: head,
      dirty: false,
      packedAt: "2000-01-01T00:00:00.000Z",
    };
    putRecord(fx.dir, leftover);
    writeFileSync(join(fx.dir, "README.md"), "# fixture\nedited\n");
    const res = write(fx.dir, ["write"]);
    assert.equal(res.status, 0, `write must exit 0: ${res.stderr}`);
    const info = record(fx.dir);
    assert.equal(info.dirty, true, "a leftover record must not make an edited tree ship dirty:false");
    assert.notEqual(info.packedAt, leftover.packedAt, "the record must be regenerated, not kept");
    assert.equal(info.sha, head, "the regenerated record must name the packed commit");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("write regenerates when the marker has no record of this pack to keep", () => {
  const fx = buildFixture();
  try {
    const head = git(["rev-parse", "HEAD"], fx.dir);
    assert.equal(write(fx.dir, ["write"], { [PROVENANCE_DEFER_ENV]: "1" }).status, 0);
    assert.equal(record(fx.dir).sha, head, "a marker with no record on disk must still pack a record");

    putRecord(fx.dir, { name: fx.name, version: fx.version, sha: "0".repeat(40) });
    assert.equal(write(fx.dir, ["write"], { [PROVENANCE_DEFER_ENV]: "1" }).status, 0);
    assert.equal(record(fx.dir).sha, head, "the marker must not keep a record of another commit");
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

test("a leftover record does not reach the tarball a real pack of an edited tree produces", () => {
  const fx = buildFixture({ files: [BUILD_INFO_FILE], scripts: wiredScripts() });
  let dest;
  try {
    const head = git(["rev-parse", "HEAD"], fx.dir);
    // A killed postpack's leftover: the record is written the way prepack
    // writes it, and the pack it belonged to never removed it.
    assert.equal(write(fx.dir, ["write"]).status, 0);
    const leftover = record(fx.dir);
    assert.equal(leftover.dirty, false, "the fixture must start clean");
    writeFileSync(join(fx.dir, "README.md"), "# fixture\nedited\n");

    const packed = packFixture(fx.dir);
    dest = packed.dest;
    assert.equal(packed.record.sha, head, "the shipped record must name the packed commit");
    assert.equal(packed.record.dirty, true, "the tarball must not carry the leftover's dirty:false");
    assert.notEqual(
      packed.record.packedAt,
      leftover.packedAt,
      "the shipped record must have been written at pack time",
    );
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
    if (dest) rmSync(dest, { recursive: true, force: true });
  }
});

test("a pack carrying the caller's deferral marker keeps the caller's record", () => {
  const fx = buildFixture({ files: [BUILD_INFO_FILE], scripts: wiredScripts() });
  let dest;
  try {
    const head = git(["rev-parse", "HEAD"], fx.dir);
    const bumpedVersion = `${fx.version}-main.0`;
    // publish-local's order: read the tree, then bump the manifest for the
    // pack. The bump would read as dirty at prepack time, so the record is
    // written first, with the version being packed, and the marker is what
    // keeps it.
    const caller = writeBuildInfo(fx.dir, {
      name: fx.name,
      version: bumpedVersion,
      git: readGitProvenance(fx.dir),
    });
    const manifest = JSON.parse(readFileSync(join(fx.dir, "package.json"), "utf8"));
    writeFileSync(
      join(fx.dir, "package.json"),
      JSON.stringify({ ...manifest, version: bumpedVersion }, null, 2) + "\n",
    );

    const packed = packFixture(fx.dir, { [PROVENANCE_DEFER_ENV]: "1" });
    dest = packed.dest;
    assert.deepEqual(packed.record, caller, "the caller's record must be the shipped one, unbumped");
    assert.equal(packed.record.dirty, false, "the deliberate version bump must not ship as dirt");
    assert.equal(packed.record.version, bumpedVersion, "the shipped record must carry the packed version");
    assert.equal(packed.record.sha, head, "the shipped record must name the commit that was packed");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
    if (dest) rmSync(dest, { recursive: true, force: true });
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
