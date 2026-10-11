/**
 * Test: B17 deliverables manifest is project-scoped, touched-file-only, and
 * lives under the braid home (never <cwd>/.braid).
 *
 * Regression test, relocated. The old recordDeliverables:
 *   - wrote to a GLOBAL ~/.pi/agent/braid/deliverables/deliverables.jsonl
 *     shared across every project (cross-project leak);
 *   - later wrote to <repoRoot>/.braid/deliverables.jsonl, polluting every
 *     project cwd a session ran in;
 *   - listed EVERY git-dirty file in the repo, including pre-existing
 *     strays the task never touched (e.g. an untouched scratch file).
 *
 * This test proves the new behavior:
 *   1. the manifest is written only to getDeliverablesFilePath(repo), under a
 *      pinned BRAID_HOME tmpdir, and no <repo>/.braid directory is created;
 *   2. only files the session touched via edit/write (bidirectional-verifier
 *      editedFiles) that are dirty in git AND inside the project are recorded;
 *   3. untouched dirty strays are excluded, and no file outside the project
 *      is installed;
 *   4. nothing is appended to the global home-dir manifest.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const { recordDeliverables } =
  await import("../../../dist/extensions/cognitive/metacognition/handlers/finalize.js");
const { getVerifierState } = await import("../../../dist/lib/store/bidirectional-verifier.js");
const { getDeliverablesFilePath } = await import("../../../dist/lib/config/braid-paths.js");

const GLOBAL_MANIFEST = join(
  homedir(),
  ".pi",
  "agent",
  "braid",
  "deliverables",
  "deliverables.jsonl",
);

describe("B17 deliverables manifest scope", () => {
  let repo;
  let outsideFile;
  let braidHome;
  let priorBraidHome;

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "b17-scope-"));
    braidHome = mkdtempSync(join(tmpdir(), "b17-braid-home-"));
    priorBraidHome = process.env.BRAID_HOME;
    process.env.BRAID_HOME = braidHome;

    execSync("git init -q", { cwd: repo });
    execSync("git config user.email test@test.local", { cwd: repo });
    execSync("git config user.name test", { cwd: repo });

    // Committed baseline, then both files become dirty in the working tree.
    writeFileSync(join(repo, "touched.ts"), "v1\n");
    writeFileSync(join(repo, "stray.ts"), "v1\n");
    execSync("git add -A && git commit -qm init", { cwd: repo });
    writeFileSync(join(repo, "touched.ts"), "v2\n");
    writeFileSync(join(repo, "stray.ts"), "v2\n");

    // A file OUTSIDE the repo (above the project root) that is also "touched".
    outsideFile = join(tmpdir(), "b17-outside-" + Date.now() + ".ts");
    writeFileSync(outsideFile, "outside\n");
  });

  after(() => {
    if (priorBraidHome === undefined) delete process.env.BRAID_HOME;
    else process.env.BRAID_HOME = priorBraidHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(braidHome, { recursive: true, force: true });
    rmSync(outsideFile, { force: true });
  });

  it("records only session-touched files under the braid home, leaving the repo clean", async () => {
    const ctx = { cwd: repo };
    const verifier = getVerifierState(ctx);
    // The session touched touched.ts (edit/write). stray.ts is dirty but was
    // never touched this session — the old code installed it anyway.
    verifier.editedFiles.add("touched.ts");
    verifier.editedFiles.add(outsideFile); // outside the project — must be dropped

    await recordDeliverables(ctx, "test summary", true);

    const manifestPath = getDeliverablesFilePath(repo);
    assert.ok(
      manifestPath.startsWith(braidHome),
      "manifest path resolves under the pinned braid home",
    );
    assert.ok(existsSync(manifestPath), "manifest written under the braid home");

    const lines = readFileSync(manifestPath, "utf-8").split("\n").filter(Boolean);
    const rec = JSON.parse(lines[lines.length - 1]);
    assert.equal(rec.session, repo, "record is tagged with this project");
    assert.ok(Array.isArray(rec.files));

    const paths = rec.files.map((f) => f.path);
    assert.ok(paths.includes("touched.ts"), "session-touched dirty file recorded");
    assert.ok(!paths.includes("stray.ts"), "untouched dirty stray NOT recorded");
    assert.ok(
      !paths.some((p) => p.startsWith("..") || p.startsWith("/")),
      "no file outside the project recorded",
    );

    assert.ok(
      !existsSync(join(repo, ".braid")),
      "no .braid/ directory is created inside the project",
    );
  });

  it("does not append to the global ~/.pi home-dir manifest", async () => {
    // Capture the global manifest state (content or absence).
    const globalBefore = existsSync(GLOBAL_MANIFEST)
      ? readFileSync(GLOBAL_MANIFEST, "utf-8")
      : null;

    const ctx = { cwd: repo };
    getVerifierState(ctx).editedFiles.add("touched.ts");
    await recordDeliverables(ctx, "summary two", true);

    if (globalBefore === null) {
      assert.ok(
        !existsSync(GLOBAL_MANIFEST),
        "global manifest must not be created by project-scoped finalize",
      );
    } else {
      const globalAfter = readFileSync(GLOBAL_MANIFEST, "utf-8");
      assert.equal(globalAfter, globalBefore, "global manifest content unchanged");
    }
  });
});
