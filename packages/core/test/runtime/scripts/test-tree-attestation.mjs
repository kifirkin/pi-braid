// test-tree-attestation.mjs — the tree digest, and the gate that reads it.
//
// One file for two subjects because they are one claim: the bytes the digest
// module hashes are the bytes the gate compares a block's `tree:<64 hex>`
// against, and a suite that tested only one of them would agree with a second
// copy of the format living in the gate.
//
// The module is loaded through a guard rather than an import statement, so a
// missing file fails the cases that need it by name, with the resolution error
// beside them, instead of aborting the file at load. That is how the red runs
// before the mechanism existed were recorded: TREE_DIGEST and CHECK_RESULT point
// the same cases at the pre-change artifacts, and each case names what it lacks.
//
// Every tree a case hashes is a temp fixture this file builds in its own
// directory and removes in `finally`, so no verdict depends on a checkout that
// happens to exist on the machine running it.
//
// The last case drives the gate on a git fixture and asserts a short sha still
// resolves there: the content form is an addition, and a case that showed it
// accepted is not a case that showed the revision form still is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const CHECK_RESULT =
  process.env.CHECK_RESULT ||
  join(import.meta.dirname, "..", "..", "..", "scripts", "check-result.mjs");
const DIGEST_MODULE =
  process.env.TREE_DIGEST ||
  join(import.meta.dirname, "..", "..", "..", "scripts", "tree-digest.mjs");

let treeEntries = null;
let digestLines = null;
let moduleError = "";
try {
  ({ treeEntries, digestLines } = await import(pathToFileURL(DIGEST_MODULE).href));
} catch (error) {
  moduleError = error instanceof Error ? error.message : String(error);
}

/** The digest through the module under test, or a failed assertion naming why. */
function digestOf(dir) {
  assert.equal(
    moduleError,
    "",
    `the digest module is not importable at ${DIGEST_MODULE}: ${moduleError}`,
  );
  return digestLines(treeEntries(dir));
}

/** A case that needs the module: absent, it fails with the resolution error. */
function moduleTest(name, body) {
  test(name, () => {
    assert.equal(
      moduleError,
      "",
      `the digest module is not importable at ${DIGEST_MODULE}: ${moduleError}`,
    );
    body();
  });
}

const scratch = (label) => mkdtempSync(join(tmpdir(), `${label}-`));
const put = (dir, relPath, content) => {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ── the format ──────────────────────────────────────────────────────────────
// One file, one line, built here from the bytes rather than from the module's
// own builder: a fixture that reused the builder would agree with a wrong
// format. The line is `<relpath>\0<size>\0<sha256 of contents>\n`, and the
// digest is the sha256 of the lines in path order.

moduleTest("(a) the digest is sha256 of one documented line per file", () => {
  const dir = scratch("tree-format-");
  try {
    put(dir, "a.txt", "one\n");
    const line = `a.txt\0${Buffer.byteLength("one\n")}\0${sha(Buffer.from("one\n"))}\n`;
    const want = sha(Buffer.from(line));
    const got = digestOf(dir);
    assert.equal(got, want, `one file, one line: got ${got} want ${want}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── stability, and what moves the digest ────────────────────────────────────
// A digest that moved when nothing changed would be useless in a gate, and one
// that never moved would accept every block. Both halves are one case each,
// because they fail for different reasons.

moduleTest("(b) the same tree hashes the same twice", () => {
  const dir = scratch("tree-stable-");
  try {
    put(dir, "lib/index.js", "export const one = 1;\n");
    put(dir, "docs/readme.md", "# two\n");
    const first = digestOf(dir);
    const second = digestOf(dir);
    assert.equal(second, first, `two reads of one tree: ${first} then ${second}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

moduleTest("(c) one byte of one file moves the digest", () => {
  const dir = scratch("tree-byte-");
  try {
    put(dir, "lib/index.js", "export const one = 1;\n");
    put(dir, "docs/readme.md", "# two\n");
    const before = digestOf(dir);
    writeFileSync(join(dir, "docs/readme.md"), "# two!\n");
    const after = digestOf(dir);
    writeFileSync(join(dir, "docs/readme.md"), "# two\n");
    const restored = digestOf(dir);
    assert.notEqual(after, before, `one byte was written: ${before} vs ${after}`);
    assert.equal(restored, before, "writing the byte back restores the digest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

moduleTest("(d) an added file moves the digest, and removing it restores it", () => {
  const dir = scratch("tree-add-");
  try {
    put(dir, "lib/index.js", "export const one = 1;\n");
    const before = digestOf(dir);
    const added = put(dir, "lib/extra.js", "export const two = 2;\n");
    const withExtra = digestOf(dir);
    rmSync(added);
    const after = digestOf(dir);
    assert.notEqual(withExtra, before, "an added file is part of the tree");
    assert.equal(after, before, "removing it leaves the tree it found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A rename with the bytes unchanged still moves it: the path is on the line, so
// two trees holding the same contents in different places are two trees.
moduleTest("(e) a rename with the contents unchanged moves the digest", () => {
  const dir = scratch("tree-rename-");
  try {
    put(dir, "docs/readme.md", "# two\n");
    const before = digestOf(dir);
    rmSync(join(dir, "docs/readme.md"));
    put(dir, "docs/renamed.md", "# two\n");
    const after = digestOf(dir);
    assert.notEqual(after, before, `same bytes, other path: ${before} vs ${after}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── what the digest leaves out ──────────────────────────────────────────────
// Two exclusions carry the weight: a path the tree's own .gitignore names, and a
// dependency install. Both are written into a tree that already has a digest, so
// the case is "writing this does not move it" rather than "this is absent".

moduleTest("(f) a path the .gitignore names does not move the digest", () => {
  const dir = scratch("tree-ignore-");
  try {
    put(dir, "lib/index.js", "export const one = 1;\n");
    put(dir, ".gitignore", "*.log\nscratch/\n");
    const before = digestOf(dir);
    put(dir, "debug.log", "noise\n");
    put(dir, "scratch/notes.txt", "noise\n");
    const after = digestOf(dir);
    assert.equal(after, before, `ignored paths entered the digest: ${before} then ${after}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

moduleTest("(g) a dependency install does not move the digest", () => {
  const dir = scratch("tree-modules-");
  try {
    put(dir, "lib/index.js", "export const one = 1;\n");
    const before = digestOf(dir);
    put(dir, "node_modules/left-pad/index.js", "module.exports = 1;\n");
    put(dir, "node_modules/.bin/left-pad", "#!/bin/sh\n");
    const after = digestOf(dir);
    assert.equal(after, before, `an install entered the digest: ${before} then ${after}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A link is hashed by the string it points at. Following it would put bytes from
// outside the tree into the digest and let a link cycle hang the walk, so the
// case proves both halves: the target's contents are invisible, the target
// string is not.
moduleTest("(h) a symlink is hashed by its target and never followed", () => {
  const dir = scratch("tree-links-");
  try {
    put(dir, "tree/real.txt", "alpha\n");
    put(dir, "outside/secret.txt", "one\n");
    symlinkSync(join(dir, "outside/secret.txt"), join(dir, "tree/pointer"));
    const before = digestOf(join(dir, "tree"));
    put(dir, "outside/secret.txt", "two\n");
    const afterTargetEdit = digestOf(join(dir, "tree"));
    assert.equal(afterTargetEdit, before, "the bytes behind an unchanged link were read");
    unlinkSync(join(dir, "tree/pointer"));
    symlinkSync(join(dir, "outside/other.txt"), join(dir, "tree/pointer"));
    const afterRelink = digestOf(join(dir, "tree"));
    assert.notEqual(afterRelink, before, "a different link target must move the digest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the planted control ─────────────────────────────────────────────────────
// A digest that returns one constant passes the stability case (b) and cannot
// answer the pair case (c). Asserting the plant's blindness is what shows which
// of the two carries the claim: a suite holding only (b) would accept an
// instrument that hashes nothing. Both real digests are in the message so the
// pair can be checked by eye as well.

moduleTest("(i) control: a constant instrument passes stability and fails the pair", () => {
  const dir = scratch("tree-control-");
  try {
    put(dir, "a/same.txt", "one\n");
    put(dir, "b/same.txt", "onf\n");
    const realA = digestOf(join(dir, "a"));
    const realB = digestOf(join(dir, "b"));
    const planted = () => "0".repeat(64);
    assert.equal(
      planted(join(dir, "a")),
      planted(join(dir, "b")),
      "a constant digest cannot tell two trees apart, which is the failure (c) catches",
    );
    assert.notEqual(realA, realB, `one byte apart: ${realA} vs ${realB}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── location independence ──────────────────────────────────────────────────
// The digest is of what the tree holds, not of where it holds it: a close that
// ran in a copy at another path attests the same tree. Two decisions make that
// true, and both are asserted rather than described: only relative paths are on
// the line, and a worktree's `.git` file (a pointer to the store, not content)
// does not enter it.

moduleTest("(i2) two copies at different paths hash the same", () => {
  const dir = scratch("tree-copy-");
  try {
    put(dir, "one/src/index.js", "export const one = 1;\n");
    put(dir, "one/.git", "gitdir: /elsewhere/.git/worktrees/one\n");
    put(dir, "two/src/index.js", "export const one = 1;\n");
    put(dir, "two/.git", "gitdir: /another-place/.git/worktrees/two\n");
    const here = digestOf(join(dir, "one"));
    const there = digestOf(join(dir, "two"));
    assert.equal(there, here, `two copies, one tree: ${here} vs ${there}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the gate ────────────────────────────────────────────────────────────────
// The block is valid in every case, so a refusal is attributable to the
// source-revision leg alone: each failing case must carry exactly one FAIL line.

function block(outputFile, extra = {}) {
  return {
    worker: "fixture-worker",
    spec: "impl",
    status: "completed",
    output_file: outputFile,
    artifacts: [],
    gate_evidence: [{ cmd: "true", exit_code: 0 }],
    claims: [
      {
        claim: "the evidence was read at the tree the block names",
        // Names no runnable file, so the parity leg has nothing to ask and every
        // gate case below isolates the source-revision leg.
        verified_by: "the tree-attestation fixture (offline, one temp tree per case)",
      },
    ],
    ...extra,
  };
}

function session(dir, payload) {
  const path = join(dir, "session.jsonl");
  const text = `Result follows.\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
  const entry = { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
  writeFileSync(path, `${JSON.stringify(entry)}\n`);
  return path;
}

function gate(args, opts = {}) {
  const r = spawnSync(process.execPath, [CHECK_RESULT, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    env: { ...process.env, BRAID_GATE_REPOS: "", ...opts.env },
  });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

const failLines = (stdout) => (stdout.match(/^FAIL/gm) || []).length;
const sourceLine = (stdout) => stdout.split("\n").find((line) => /source-revision/.test(line)) ?? "";

/** A tree with a report beside it, which is the shape a close leaves behind. */
function closeTree(dir) {
  const tree = join(dir, "tree");
  put(dir, "report.md", "# fixture report\n\n## Placement\n\nfixture only\n");
  put(dir, "tree/src/index.js", "export const one = 1;\n");
  put(dir, "tree/docs/readme.md", "# two\n");
  return tree;
}

// The digest a worker writes into its block is the one the gate prints: the two
// calls are the instrument and its use, and a case that only checked the block
// could not tell a working print from a match against a stale value.
test("(j) --print-tree-digest prints tree:<64 hex> for the tree it was given", () => {
  const dir = scratch("tree-print-");
  try {
    const tree = closeTree(dir);
    const want = digestOf(tree);
    const r = gate(["--print-tree-digest", "--tree", tree], { cwd: dir });
    assert.equal(r.code, 0, `exit=${r.code} stdout=${r.stdout.slice(0, 300)}`);
    assert.equal(r.stdout.trim(), `tree:${want}`, `printed ${r.stdout.trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(k) a block attesting the tree's own digest passes", () => {
  const dir = scratch("tree-pass-");
  try {
    const tree = closeTree(dir);
    const digest = digestOf(tree);
    const s = session(dir, block(join(dir, "report.md"), { source_revision: `tree:${digest}` }));
    const r = gate([s, "--tree", tree], { cwd: dir });
    assert.equal(r.code, 0, `exit=${r.code} ${sourceLine(r.stdout).trim()}`);
    assert.match(r.stdout, /PASS\s+source-revision/, "the content form must be accepted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The refusal has to be usable: it names both digests, so a reader can see that
// the tree moved rather than that the form was wrong.
test("(l) the same block after one byte changes fails, naming both digests", () => {
  const dir = scratch("tree-moved-");
  try {
    const tree = closeTree(dir);
    const attested = digestOf(tree);
    put(dir, "tree/docs/late.md", "# written after the evidence was read\n");
    const now = digestOf(tree);
    const s = session(dir, block(join(dir, "report.md"), { source_revision: `tree:${attested}` }));
    const r = gate([s, "--tree", tree], { cwd: dir });
    assert.equal(r.code, 1, `exit=${r.code} ${sourceLine(r.stdout).trim()}`);
    assert.equal(failLines(r.stdout), 1, `one leg, one FAIL line: ${sourceLine(r.stdout).trim()}`);
    assert.match(r.stdout, /FAIL\s+source-revision/, "the refused leg is the revision one");
    const line = sourceLine(r.stdout);
    assert.ok(line.includes(attested), `the block's value is named: ${line.slice(0, 160)}`);
    assert.ok(line.includes(now), `the tree's current value is named: ${line.slice(0, 160)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The two forms are accepted, and a value that is neither has to say so. The
// message names both, because the seat that wrote `no-vcs` had no way to learn
// from this gate what to write instead.
test("(m) a bare no-vcs is refused, with both accepted forms named", () => {
  const dir = scratch("tree-no-vcs-");
  try {
    const tree = closeTree(dir);
    const s = session(dir, block(join(dir, "report.md"), { source_revision: "no-vcs" }));
    const r = gate([s, "--tree", tree], { cwd: dir });
    assert.equal(r.code, 1, `exit=${r.code}`);
    assert.equal(failLines(r.stdout), 1, `one leg, one FAIL line: ${r.stdout.slice(0, 400)}`);
    const line = sourceLine(r.stdout);
    assert.match(line, /7-40 hex/, `a hex sha is named: ${line.slice(0, 200)}`);
    assert.match(line, /tree:<64 hex>/, `the content form is named: ${line.slice(0, 200)}`);
    assert.match(line, /--print-tree-digest/, `the remedy is named: ${line.slice(0, 200)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Uppercase hex is the same digest: the field is read case-insensitively, and a
// block that shouted its value is not a block that lied about the tree.
test("(n) an uppercase tree digest matches the same tree", () => {
  const dir = scratch("tree-upper-");
  try {
    const tree = closeTree(dir);
    const digest = digestOf(tree).toUpperCase();
    const s = session(dir, block(join(dir, "report.md"), { source_revision: `tree:${digest}` }));
    const r = gate([s, "--tree", tree], { cwd: dir });
    assert.equal(r.code, 0, `exit=${r.code} ${sourceLine(r.stdout).trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// No --tree means the tree the gate was run in, which is the close that ran
// where the work ran: the form has to work without being pointed at anything.
test("(o) without --tree the gate hashes the tree it was run in", () => {
  const dir = scratch("tree-cwd-");
  try {
    const tree = closeTree(dir);
    const digest = digestOf(tree);
    const s = session(dir, block(join(dir, "report.md"), { source_revision: `tree:${digest}` }));
    const r = gate([s], { cwd: tree });
    assert.equal(r.code, 0, `exit=${r.code} ${sourceLine(r.stdout).trim()}`);
    assert.match(r.stdout, /PASS\s+source-revision/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the revision form is untouched ──────────────────────────────────────────
// The addition is one accepted form beside another. A short sha in a repository
// the gate was told about resolves exactly as it did before, at the seven
// characters the field's floor allows.

test("(p) a 7-character sha still resolves and passes the same leg", () => {
  const dir = scratch("tree-sha-");
  try {
    closeTree(dir);
    const repo = join(dir, "repo");
    const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    spawnSync("git", ["init", "-q", "-b", "main", repo]);
    git("config", "user.email", "fixture@example.test");
    git("config", "user.name", "fixture");
    writeFileSync(join(repo, "first.txt"), "one\n");
    git("add", "-A");
    git("commit", "-q", "-m", "first");
    const short = git("rev-parse", "--short=7", "HEAD").stdout.trim();
    const s = session(dir, block(join(dir, "report.md"), { source_revision: short }));
    const r = gate([s, "--repo", repo], { cwd: dir });
    assert.equal(r.code, 0, `exit=${r.code} rev=${short} ${sourceLine(r.stdout).trim()}`);
    assert.match(sourceLine(r.stdout), /resolved in/, `the repo label is named: ${sourceLine(r.stdout)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
