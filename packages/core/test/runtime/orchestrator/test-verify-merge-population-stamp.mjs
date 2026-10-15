/**
 * Test: verify-and-merge reads the close's population stamp against git.
 *
 * The invariant pinned here: **a close that records a population below the
 * census of the revision it names cannot merge clean.** A gate that ran
 * before staging certifies fewer tracked entries than the commit carries; the
 * stamp is the recorded number, the census comes from git alone, and the
 * refusal names the row, the stamp, the census, the delta and the remedy. A
 * matching stamp merges, an unstamped close prints `no recorded population`,
 * and an unreadable stamp is named rather than silently dropped.
 *
 * The comparison runs on the close's rows as the merge path can read them: the
 * recorded close when the row was already closed, otherwise the worker's
 * result block. Both are exercised here, the registry one winning when both
 * exist. Pure parser and render cases run without a repository.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports, so the
 * real ~/.pi/agent is untouched.
 *
 * Run: node test/runtime/orchestrator/test-verify-merge-population-stamp.mjs (after npm run build)
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "verify-merge-population-"));
process.env.HOME = FAKE_HOME;

const { parsePopulationStamp, readPopulationStamps, populationRefusalDetail, getAllLocks } =
  await import("../../../dist/lib/orchestrator/index.js");
const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);

let passed = 0;
let failed = 0;
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed++;
    console.log(`  [fail] ${name}: ${error.message}`);
  }
}

// ── git fixtures ────────────────────────────────────────────────────────────

function gitIn(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}
function gitOk(repo, ...args) {
  try {
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const branchExistsIn = (repo, branch) => gitIn(repo, "branch", "--list", branch).length > 0;
const isAncestorIn = (repo, a, b) => gitOk(repo, "merge-base", "--is-ancestor", a, b);

/** Fresh repo on `main` with one tracked file (census 1). */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "verify-merge-population-repo-"));
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.email", "test@example.com");
  gitIn(repo, "config", "user.name", "test");
  gitIn(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "base.txt"), "base\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return repo;
}

/** One commit on the worker branch, leaving the repo back on `main`. */
function workerCommit(repo, branch, file = "work.txt") {
  gitIn(repo, "checkout", "-q", branch);
  writeFileSync(join(repo, file), "work\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "worker work");
  const tip = gitIn(repo, "rev-parse", "HEAD");
  gitIn(repo, "checkout", "-q", "main");
  return tip;
}

// ── the tool, driven through the real registered definition ─────────────────

const fakePi = {
  tools: [],
  registerTool(definition) {
    this.tools.push(definition);
  },
  on() {},
};
orchestratorExtension(fakePi);
const orchestrateTool = fakePi.tools.find((tool) => tool.name === "orchestrate");
const runTool = (params) =>
  orchestrateTool.execute("call-1", params, new AbortController().signal, undefined, undefined);
const toolText = (result) => result.content[0].text;
const toolDetails = (result) => result.details ?? {};

/** A worker session whose final assistant message carries one result block. */
const SESSIONS = mkdtempSync(join(tmpdir(), "verify-merge-population-session-"));
function writeSession(name, rows) {
  const session = join(SESSIONS, name);
  const schema = {
    worker: "pop-fixture",
    spec: "impl",
    status: "completed",
    output_file: join(SESSIONS, "deliverable.md"),
    artifacts: [],
    gate_evidence: rows,
    claims: [],
  };
  const text = `Done.\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`\n`;
  const entry = {
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
  writeFileSync(session, `${JSON.stringify(entry)}\n`);
  return session;
}

/**
 * A worker admitted through the tool, committed on its branch, with a session
 * carrying the given close rows. Returns the repo, the tip and the branch.
 */
async function admitted({ id, rows = null, sessionRows = null }) {
  const repo = makeRepo();
  const spawned = await runTool({
    action: "spawn-worker",
    workerId: id,
    slug: "population-stamp",
    files: [join(repo, "base.txt")],
    spec: "impl",
    outputFile: join(repo, "deliverable.md"),
    cwd: repo,
  });
  const text = toolText(spawned);
  const branch = text.match(/^Branch: (.+)$/m)?.[1];
  assert.ok(branch, `fixture must learn the branch: ${text.slice(0, 200)}`);
  const tip = workerCommit(repo, branch);
  if (sessionRows) {
    const session = writeSession(`${id}-session.jsonl`, sessionRows(tip));
    const updated = await runTool({
      action: "update-worker",
      workerId: id,
      workerSession: session,
      cwd: repo,
    });
    assert.match(toolText(updated), /updated/);
  }
  if (rows) {
    const closed = await runTool({
      action: "close-worker",
      workerId: id,
      outcome: "completed",
      gates: rows(tip),
      cwd: repo,
    });
    assert.match(toolText(closed), /closed: completed/);
  }
  return { repo, tip, branch };
}

const merge = (repo, id) =>
  runTool({ action: "verify-and-merge", workerId: id, baseBranch: "main", cwd: repo });

// ── pure parser ─────────────────────────────────────────────────────────────

const VALID_STAMPS = [
  ["scanned 0 files at abc1234", { n: 0, unit: "files", revision: "abc1234" }],
  ["scanned 914 files at main", { n: 914, unit: "files", revision: "main" }],
  ["scanned 12 rows at worker/one/two", { n: 12, unit: "rows", revision: "worker/one/two" }],
  ["scanned 3 cases at v1.2", { n: 3, unit: "cases", revision: "v1.2" }],
  ["scanned 7 files at ABC1234", { n: 7, unit: "files", revision: "ABC1234" }],
  [
    "scanned 9 files at 0123456789abcdef0123456789abcdef01234567",
    { n: 9, unit: "files", revision: "0123456789abcdef0123456789abcdef01234567" },
  ],
];

const INVALID_STAMPS = [
  "scanned 914 Files at main",
  "scanned -1 files at main",
  "scanned 1.5 files at main",
  "scanned 5 files at abc123",
  "scanned 5 files at 0123456789abcdef0123456789abcdef0123456789",
  "scanned 5 files at main; rm -rf /",
  "scanned 5 files at main extra",
  "scanned 5 files at ",
  " scanned 5 files at main",
  "scanned 5 files at main\n",
  "scanned 5 files at ...",
  "the gate scanned 5 files at main",
  "",
];

await testAsync("pure: the stamp shape parses to n, unit and revision", () => {
  for (const [raw, expected] of VALID_STAMPS) {
    assert.deepEqual(parsePopulationStamp(raw), expected, `should parse: ${JSON.stringify(raw)}`);
  }
});

await testAsync("pure: every off-shape value is refused, non-strings included", () => {
  for (const raw of INVALID_STAMPS) {
    assert.equal(parsePopulationStamp(raw), null, `should refuse: ${JSON.stringify(raw)}`);
  }
  for (const raw of [undefined, null, 5, {}, []]) {
    assert.equal(parsePopulationStamp(raw), null, `should refuse non-string: ${JSON.stringify(raw)}`);
  }
});

await testAsync("pure: the read compares files rows only, against the supplied census", () => {
  const read = readPopulationStamps(
    [
      { cmd: "git ls-files | wc -l", exit: 0, stamp: "scanned 1 files at rev-one" },
      { cmd: "node count.mjs", exit: 0, stamp: "scanned 3 rows at rev-one" },
      { cmd: "npm run ci:check", exit: 0 },
      { cmd: "find . -type f | wc -l", exit: 0, stamp: "scanned nine files" },
      { cmd: "ls -la", exit: 0, stamp: "scanned 2 files at rev-missing" },
    ],
    (revision) => (revision === "rev-one" ? 2 : null),
  );
  const [below, rows, absent, unreadable, unresolved] = read.rows;
  assert.equal(below.verdict, "below");
  assert.equal(below.delta, 1);
  assert.equal(rows.verdict, "other-subject");
  assert.equal(absent.verdict, "absent");
  assert.equal(unreadable.verdict, "unreadable");
  assert.equal(unresolved.verdict, "unresolved");
  assert.equal(read.comparisons.length, 1);
  assert.equal(read.standing, below);
  assert.equal(read.recorded, true);
  assert.deepEqual(read.lines, [
    "population delta: recorded 1 vs census 2 at rev-one (row 0)",
    'population stamp unreadable: row 3 "scanned nine files"',
    "population delta: recorded 2 at rev-missing (row 4; revision unresolved, not compared)",
  ]);
});

await testAsync("pure: an unreadable or absent read never yields a refusal", () => {
  const unreadable = readPopulationStamps([{ cmd: "ls", stamp: "nope" }], () => 1);
  const empty = readPopulationStamps([], () => 1);
  const notAnArray = readPopulationStamps("not rows", () => 1);
  const rowNotObject = readPopulationStamps([null, 7], () => 1);
  assert.equal(populationRefusalDetail(unreadable), null);
  assert.equal(populationRefusalDetail(empty), null);
  assert.deepEqual(empty.lines, ["no recorded population"]);
  assert.deepEqual(notAnArray.rows, []);
  assert.deepEqual(notAnArray.lines, ["no recorded population"]);
  assert.equal(rowNotObject.rows.length, 2);
  assert.equal(rowNotObject.recorded, false);
});

await testAsync("pure: a standing delta detail names row, stamp, census, delta and remedy", () => {
  const read = readPopulationStamps(
    [{ cmd: "git ls-files | wc -l", stamp: "scanned 903 files at rev-one" }],
    () => 909,
  );
  const detail = populationRefusalDetail(read);
  assert.match(detail, /row 0/);
  assert.match(detail, /scanned 903 files at rev-one/);
  assert.match(detail, /census at rev-one is 909/);
  assert.match(detail, /delta 6/);
  assert.match(detail, /re-run the gate on the staged tree and re-issue the close/);
});

await testAsync("pure: the first standing delta is the one named", () => {
  const read = readPopulationStamps(
    [
      { cmd: "a", stamp: "scanned 5 files at rev-one" },
      { cmd: "b", stamp: "scanned 1 files at rev-one" },
    ],
    () => 2,
  );
  assert.equal(read.standing.row, 1);
  assert.match(populationRefusalDetail(read), /row 1/);
});

// ── merge path ──────────────────────────────────────────────────────────────

await testAsync("merge: a stamped files row below the census refuses and names the delta", async () => {
  const id = "pop-below";
  const { repo, tip, branch } = await admitted({
    id,
    sessionRows: (t) => [
      { cmd: "git ls-files | wc -l", exit: 0, stamp: `scanned 1 files at ${t}` },
    ],
  });
  const baseBefore = gitIn(repo, "rev-parse", "main");
  const result = await merge(repo, id);
  const text = toolText(result);
  assert.equal(toolDetails(result).mergeSha, undefined, "no merge may be claimed");
  assert.match(text, /^NOT merged: row 0 stamp "scanned 1 files at /m);
  assert.match(text, new RegExp(`census at ${tip} is 2 \\(delta 1\\)`));
  assert.match(text, /re-run the gate on the staged tree and re-issue the close/);
  assert.match(text, new RegExp(`population delta: recorded 1 vs census 2 at ${tip} \\(row 0\\)`));
  assert.equal(gitIn(repo, "rev-parse", "main"), baseBefore, "the base must not move");
  assert.equal(isAncestorIn(repo, tip, "main"), false, "the tip must not be in the base");
  assert.equal(branchExistsIn(repo, branch), true, "a refusal keeps the branch");
  assert.equal(Object.keys(getAllLocks(repo)).length > 0, true, "a refusal keeps the locks");
});

await testAsync("merge: a stamped row matching the census merges and prints delta 0", async () => {
  const id = "pop-match";
  const { repo, tip } = await admitted({
    id,
    sessionRows: (t) => [
      { cmd: "git ls-files | wc -l", exit: 0, stamp: `scanned 2 files at ${t}` },
    ],
  });
  const result = await merge(repo, id);
  const text = toolText(result);
  assert.equal(toolDetails(result).mergeSha, tip);
  assert.match(text, new RegExp(`merged into main at ${tip.slice(0, 12)}`));
  assert.match(text, new RegExp(`population delta: recorded 2 vs census 2 at ${tip} \\(row 0\\)`));
  assert.equal(isAncestorIn(repo, tip, "main"), true);
});

await testAsync("merge: a close with no stamp merges and prints no recorded population", async () => {
  const id = "pop-absent";
  const { repo, tip } = await admitted({
    id,
    sessionRows: () => [{ cmd: "npm run ci:check", exit: 0 }],
  });
  const result = await merge(repo, id);
  const text = toolText(result);
  assert.equal(toolDetails(result).mergeSha, tip);
  assert.match(text, /no recorded population/);
  assert.doesNotMatch(text, /population delta:/);
});

await testAsync("merge: a malformed stamp is named and the merge still lands", async () => {
  const id = "pop-unreadable";
  const { repo, tip } = await admitted({
    id,
    sessionRows: () => [{ cmd: "find . -type f | wc -l", exit: 0, stamp: "scanned nine files" }],
  });
  const result = await merge(repo, id);
  const text = toolText(result);
  assert.equal(toolDetails(result).mergeSha, tip);
  assert.match(text, /population stamp unreadable: row 0 "scanned nine files"/);
  assert.match(text, /no recorded population/);
});

await testAsync("merge: a stamp whose revision does not resolve is not compared", async () => {
  const id = "pop-unresolved";
  const { repo, tip } = await admitted({
    id,
    sessionRows: () => [
      { cmd: "git ls-files | wc -l", exit: 0, stamp: "scanned 2 files at deadbeef0" },
    ],
  });
  const result = await merge(repo, id);
  const text = toolText(result);
  assert.equal(toolDetails(result).mergeSha, tip);
  assert.match(text, /revision unresolved, not compared/);
});

await testAsync("merge: a stamp for another unit is not a file census", async () => {
  const id = "pop-other-unit";
  const { repo, tip } = await admitted({
    id,
    sessionRows: (t) => [{ cmd: "node case-count.mjs", exit: 0, stamp: `scanned 3 rows at ${t}` }],
  });
  const result = await merge(repo, id);
  const text = toolText(result);
  assert.equal(toolDetails(result).mergeSha, tip);
  assert.match(text, /no recorded population/);
  assert.doesNotMatch(text, /population delta:/);
});

await testAsync("merge: a recorded population above the census prints but does not block", async () => {
  const id = "pop-above";
  const { repo, tip } = await admitted({
    id,
    sessionRows: (t) => [
      { cmd: "git ls-files | wc -l", exit: 0, stamp: `scanned 9 files at ${t}` },
    ],
  });
  const result = await merge(repo, id);
  const text = toolText(result);
  assert.equal(toolDetails(result).mergeSha, tip);
  assert.match(text, new RegExp(`population delta: recorded 9 vs census 2 at ${tip} \\(row 0\\)`));
});

await testAsync("merge: the recorded close wins over the session when both carry rows", async () => {
  const id = "pop-registry";
  const rows = (t) => [
    { cmd: "git ls-files | wc -l", exit: 0, stamp: `scanned 1 files at ${t}` },
  ];
  const { repo, tip } = await admitted({
    id,
    sessionRows: (t) => [
      { cmd: "git ls-files | wc -l", exit: 0, stamp: `scanned 2 files at ${t}` },
    ],
    rows,
  });
  const result = await merge(repo, id);
  const text = toolText(result);
  assert.equal(toolDetails(result).mergeSha, undefined);
  assert.match(text, new RegExp(`population delta: recorded 1 vs census 2 at ${tip} \\(row 0\\)`));
});

await testAsync("merge: an unstamped recorded close blocks nothing", async () => {
  const id = "pop-registry-open";
  const { repo, tip } = await admitted({
    id,
    rows: () => [{ cmd: "npm run ci:check", exit: 0 }],
  });
  const result = await merge(repo, id);
  const text = toolText(result);
  assert.equal(toolDetails(result).mergeSha, tip);
  assert.match(text, /no recorded population/);
});

// ── Verdict ─────────────────────────────────────────────────────────────────

console.log(`\n${failed === 0 ? `RESULT: PASS (${passed} cases)` : `RESULT: FAIL (${failed}/${passed} cases)`}`);
process.exit(failed === 0 ? 0 : 1);
