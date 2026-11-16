#!/usr/bin/env node
// test-check-artifact-staleness.mjs - offline harness for check-artifact-staleness.mjs.
//
// A hermetic temp repo carries the cases, so the verdicts are attributable to the
// freshness leg alone: a revision that IS HEAD passes; a revision whose scope moved
// is report-only by default and fails under --strict; a scope that did not move
// passes even when the tree did; a revision that never landed in the branch fails;
// a revision the repo does not contain is a usage-level failure (exit 2), because
// an artifact that names an unknown revision cannot be freshness-checked at all.
//
// The gate under test defaults to the script three directories up;
// CHECK_STALENESS=<path> overrides it, which is how a RED run is recorded
// against a pre-change copy.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE =
  process.env.CHECK_STALENESS ||
  join(import.meta.dirname, "..", "..", "..", "scripts", "check-artifact-staleness.mjs");
const root = mkdtempSync(join(tmpdir(), "staleness-test-"));
const repo = join(root, "fixture-repo");

const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const run = (args) => {
  const r = spawnSync(process.execPath, [GATE, ...args], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
};

let checks = 0, failures = 0;
function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// ── the fixture repo: A (a.txt) -> B (b.txt) -> C on a side branch ───────────
spawnSync("git", ["init", "-q", "-b", "main", repo]);
git("config", "user.email", "fixture@example.com");
git("config", "user.name", "fixture");
writeFileSync(join(repo, "a.txt"), "one\n");
git("add", "a.txt");
git("commit", "-q", "-m", "A");
const shaA = git("rev-parse", "HEAD").stdout.trim();
writeFileSync(join(repo, "b.txt"), "two\n");
git("add", "b.txt");
git("commit", "-q", "-m", "B");
const shaB = git("rev-parse", "HEAD").stdout.trim();
git("checkout", "-q", "-b", "side");
writeFileSync(join(repo, "c.txt"), "three\n");
git("add", "c.txt");
git("commit", "-q", "-m", "C");
const shaC = git("rev-parse", "HEAD").stdout.trim();
git("checkout", "-q", "main");

// ── (a) the revision IS HEAD ────────────────────────────────────────────────
let r = run(["--repo", repo, "--revision", shaB]);
check("(a) a revision that is HEAD passes", r.code === 0 && /IS the repo's HEAD/.test(r.stdout), `exit=${r.code}`);

// ── (b) the tree moved: report-only by default, failing under --strict ──────
r = run(["--repo", repo, "--revision", shaA]);
check("(b) a moved tree is report-only by default and names the changed file", r.code === 0 && /STALE\?/.test(r.stdout) && /b\.txt/.test(r.stdout), `exit=${r.code}`);

r = run(["--repo", repo, "--revision", shaA, "--strict"]);
check("(b) the same case fails under --strict", r.code === 1 && /FAIL \(--strict\)/.test(r.stdout), `exit=${r.code}`);

// ── (c) the scope did not move, even though the tree did ────────────────────
r = run(["--repo", repo, "--revision", shaA, "--paths", "a.txt", "--strict"]);
check("(c) an unchanged scope passes under --strict", r.code === 0 && /nothing in the artifact's scope changed/.test(r.stdout), `exit=${r.code}`);

r = run(["--repo", repo, "--revision", shaA, "--paths", "b.txt", "--strict"]);
check("(c) a changed scope fails under --strict", r.code === 1, `exit=${r.code}`);

// ── (d) a revision that never landed in the branch ──────────────────────────
r = run(["--repo", repo, "--revision", shaC]);
check("(d) a revision that is not an ancestor fails and says why", r.code === 1 && /NOT an ancestor/.test(r.stdout), `exit=${r.code}`);

// ── (e) a revision the repo does not contain is a usage-level failure ───────
r = run(["--repo", repo, "--revision", "0123456789abcdef0123456789abcdef01234567"]);
check("(e) an unknown revision exits 2, not a warning", r.code === 2 && /cannot be freshness-checked/.test(r.stderr), `exit=${r.code}`);

// ── (f) usage discipline ────────────────────────────────────────────────────
r = run(["--repo", repo]);
check("(f) a missing --revision exits 2", r.code === 2, `exit=${r.code}`);
r = run(["--repo", join(root, "nope"), "--revision", shaB]);
check("(f) a repo that does not exist exits 2", r.code === 2, `exit=${r.code}`);

rmSync(root, { recursive: true, force: true });
console.log(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"} (${checks - failures}/${checks} checks)`);
process.exit(failures === 0 ? 0 : 1);
