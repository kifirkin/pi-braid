/**
 * test-publish-local-atomic-install.mjs — a failed publish install must
 * never destroy the previously installed package.
 *
 * Drives scripts/publish-local.mjs against sandbox destinations via the
 * LOCAL_PKG env var, so no fixture ever touches the live local-packages
 * tree. Three publishes:
 *
 *   1. resolution fails (a fixture dependency targets a missing file:) —
 *      the previous install survives byte-identical, the destination
 *      manifest is untouched, the tarball stays for retry, exit non-zero;
 *   2. resolution passes but the install step fails (fixture install
 *      script exits non-zero) — the backup path restores the old install;
 *   3. clean fixture — the swap happens, the manifest pin moves, and no
 *      backup remains.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCRIPT = join(ROOT, "scripts", "publish-local.mjs");
const WRITER = join(ROOT, "scripts", "pack-provenance.mjs");

const FIXTURE_NAME = "publish-fixture";
const OLD_VERSION = "0.9.0";
const OLD_MARKER = "previous-install-marker";

function newSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "publish-local-test-"));
  const dest = join(dir, "dest");
  const installed = join(dest, "node_modules", FIXTURE_NAME);
  mkdirSync(installed, { recursive: true });
  writeFileSync(
    join(installed, "package.json"),
    JSON.stringify({ name: FIXTURE_NAME, version: OLD_VERSION }, null, 2) + "\n",
  );
  writeFileSync(join(installed, "marker.txt"), OLD_MARKER + "\n");
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify({ name: "dest-tree", version: "1.0.0" }, null, 2) + "\n",
  );
  return { dir, dest, installed };
}

function newFixture(dir, manifest) {
  const pkgDir = join(dir, "fixture");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  return pkgDir;
}

function runPublish(pkgDir, dest) {
  return spawnSync("node", [SCRIPT], {
    cwd: pkgDir,
    env: { ...process.env, LOCAL_PKG: dest, npm_config_cache: join(pkgDir, "..", "npm-cache") },
    encoding: "utf8",
    timeout: 25_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assertOldInstallIntact(s, destManifestBefore) {
  assert.equal(
    readFileSync(join(s.installed, "marker.txt"), "utf8"),
    OLD_MARKER + "\n",
    "previous install content must survive byte-identical",
  );
  assert.equal(
    JSON.parse(readFileSync(join(s.installed, "package.json"), "utf8")).version,
    OLD_VERSION,
    "previous install manifest must survive",
  );
  assert.deepEqual(
    readFileSync(join(s.dest, "package.json")),
    destManifestBefore,
    "destination package.json bytes must be unchanged",
  );
  assert.ok(
    !existsSync(join(s.dest, "package-lock.json")),
    "no lockfile must appear when none existed",
  );
}

test("a publish whose install cannot resolve leaves the previous install intact", () => {
  const s = newSandbox();
  try {
    const fixture = newFixture(s.dir, {
      name: FIXTURE_NAME,
      version: "1.0.0",
      dependencies: { "ghost-dep": "file:./ghost.tgz" },
    });
    const destManifestBefore = readFileSync(join(s.dest, "package.json"));
    const res = runPublish(fixture, s.dest);
    assert.notEqual(res.status, 0, "publish must exit non-zero when the install cannot resolve");
    assert.match(
      (res.stderr ?? "") + (res.stdout ?? ""),
      /ghost\.tgz/,
      "failure output must name the unresolved dependency",
    );
    assertOldInstallIntact(s, destManifestBefore);
    assert.ok(
      existsSync(join(s.dest, `${FIXTURE_NAME}-1.0.0-detached.0.tgz`)),
      "the built tarball must remain in the destination for recovery",
    );
    assert.ok(
      !existsSync(join(fixture, "build-info.json")),
      "the generated provenance file must be removed even when the install fails",
    );
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("an install that fails after resolution is rolled back from the backup", () => {
  const s = newSandbox();
  try {
    const fixture = newFixture(s.dir, {
      name: FIXTURE_NAME,
      version: "1.1.0",
      scripts: { install: "node -e \"process.exit(3)\"" },
    });
    const destManifestBefore = readFileSync(join(s.dest, "package.json"));
    const res = runPublish(fixture, s.dest);
    assert.notEqual(res.status, 0, "publish must exit non-zero when the install step fails");
    const output = (res.stderr ?? "") + (res.stdout ?? "");
    assert.match(output, /publish-backup/, "failure output must name the backup path");
    assert.match(output, /restor/i, "failure output must say the previous install was restored");
    assertOldInstallIntact(s, destManifestBefore);
    assert.ok(
      !existsSync(join(s.dest, `.${FIXTURE_NAME}.publish-backup`)),
      "the backup must be gone after the restore",
    );
    assert.ok(
      existsSync(join(s.dest, `${FIXTURE_NAME}-1.1.0-detached.0.tgz`)),
      "the built tarball must remain in the destination for recovery",
    );
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("a publish packs the pre-bump record, not the version bump", () => {
  const s = newSandbox();
  try {
    const fixture = newFixture(s.dir, {
      name: FIXTURE_NAME,
      version: "4.0.0",
      files: ["build-info.json"],
      // The workspace wiring, so the pack runs the shared writer for real.
      scripts: {
        prepack: `node '${WRITER}' write`,
        postpack: `node '${WRITER}' remove`,
      },
    });
    for (const args of [
      ["-c", "init.defaultBranch=main", "init", "-q"],
      ["add", "-A"],
      ["-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "commit", "-q", "-m", "fixture"],
    ]) {
      const step = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
      assert.equal(step.status, 0, `git ${args.join(" ")} failed: ${step.stderr}`);
    }
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).stdout.trim();

    const res = runPublish(fixture, s.dest);
    assert.equal(res.status, 0, `publish must succeed: ${res.stdout}\n${res.stderr}`);
    const buildInfo = JSON.parse(readFileSync(join(s.installed, "build-info.json"), "utf8"));
    assert.equal(buildInfo.name, FIXTURE_NAME, "provenance must name the packed package");
    assert.equal(buildInfo.version, "4.0.0-main.0", "provenance must carry the derived version");
    assert.equal(buildInfo.sha, head, "provenance must name the packed commit");
    assert.equal(
      buildInfo.dirty,
      false,
      "the temporary version bump must not be recorded as uncommitted changes",
    );
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("a clean publish swaps the install and leaves no backup", () => {
  const s = newSandbox();
  try {
    const fixture = newFixture(s.dir, {
      name: FIXTURE_NAME,
      version: "2.0.0",
      // An explicit allowlist must not keep the provenance file out of the tarball.
      files: ["package.json"],
    });
    const res = runPublish(fixture, s.dest);
    assert.equal(res.status, 0, "publish must succeed for a clean fixture");
    const installed = JSON.parse(readFileSync(join(s.installed, "package.json"), "utf8"));
    assert.equal(
      installed.version,
      "2.0.0-detached.0",
      "the installed dir must be re-extracted from the new tarball",
    );
    const buildInfo = JSON.parse(readFileSync(join(s.installed, "build-info.json"), "utf8"));
    assert.equal(buildInfo.name, FIXTURE_NAME, "provenance must name the packed package");
    assert.equal(
      buildInfo.version,
      "2.0.0-detached.0",
      "provenance must carry the packed version",
    );
    assert.equal(buildInfo.sha, null, "a non-git fixture records no commit sha");
    assert.ok(
      !existsSync(join(fixture, "build-info.json")),
      "the generated provenance file must not survive in the package tree",
    );
    const destPkg = JSON.parse(readFileSync(join(s.dest, "package.json"), "utf8"));
    assert.equal(
      destPkg.dependencies[FIXTURE_NAME],
      `file:${FIXTURE_NAME}-2.0.0-detached.0.tgz`,
      "the destination manifest pin must move to the new tarball",
    );
    assert.ok(
      !existsSync(join(s.dest, `.${FIXTURE_NAME}.publish-backup`)),
      "no backup may remain on the success path",
    );
    assert.ok(
      existsSync(join(s.dest, `${FIXTURE_NAME}-2.0.0-detached.0.tgz`)),
      "the tarball is retained in the destination",
    );
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
