/**
 * Test: orchestrator worker registry — CRUD, atomic writes, request identity.
 *
 * Pins the registry contract from the subagent-contract design (§2.2):
 * 1. Per-project file resolution: workers.json sits beside locks.json under
 * ~/.pi/agent/braid/projects/<sanitized-cwd>/.
 * 2. registerWorker writes a complete handle (null-able pane/workspace/
 * session/output fields, empty gates, the derived (workerId, step) request id,
 * no checkpoint): a retried admission of the same request reuses the live
 * entry that request already admitted, while a different request — or the same
 * request describing different work — is refused with both ids named.
 * 3. updateWorker merges handle fields and refreshes lastSeenAt; a closed
 * entry can be rolled over by re-registering (the closed record is replaced).
 * 4. closeWorker stamps a terminal outcome + closedAt + gate evidence: a
 * completed close without gates and malformed gate entries are refused
 * before any write, and first close wins.
 * 5. Persistence is atomic (no temp litter) with mode 0600; a corrupt or
 * missing file reads as an empty registry, never throws.
 * 6. Without an explicit cwd, a worker registered under another project is
 * still located by scanning project registries (parent runs in its own
 * workspace while the registry lives under the target repo).
 * 7. Effect evidence for a terminal completion: a completed close with none
 * of a fresh output file (mtime not before spawnedAt), a branch advance or
 * recorded merge, and a passing gate is flagged `no effect evidence` in both
 * the close result and the check verdict, advisory and non-blocking; each
 * evidence kind alone suppresses the flag, and a non-completed close carries
 * no flag at all.
 *
 * The second half pins the check-worker verdict (§2.2 result-location
 * contract): completed requires an existing output file plus a parseable
 * result schema within the last three assistant messages of the worker
 * session (impl spec also requires a commit on the worker branch); a live
 * done/idle status with missing evidence is false-done, never completed.
 * The lifecycle actions (spawn/register/update/check/list/close) are driven
 * through the real registered tool with a fake ExtensionAPI:
 * - spawn-worker registers a complete entry before reporting a worker ready,
 *   and mutates nothing (no branch, no locks) when spec/outputFile are absent;
 * - update-worker persists branch/files patches and check-worker counts the
 *   commits on the patched branch;
 * - close-worker releases the worker's locks;
 * - check-worker falls back to the branch on the worker's lock rows when the
 *   registry entry's own branch is null;
 * - a result block one or two assistant messages back still validates, with
 *   the offset reported; none within the window does not.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports
 * (os.homedir() reads $HOME on POSIX), so the real ~/.pi/agent is untouched.
 *
 * Run: node test/runtime/lib/test-worker-registry.mjs (after npm run build)
 */

import { strict as assert } from "node:assert";
import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "w170-registry-"));
process.env.HOME = FAKE_HOME;

const { BRAID_DIR, getLockFilePath, getWorkersFilePath } =
  await import("../../../dist/lib/config/braid-paths.js");
const { getAllLocks, acquireLock } = await import("../../../dist/lib/orchestrator/index.js");
const {
  WORKER_REGISTRY_VERSION,
  parseWorkerStatus,
  parseWorkerOutcome,
  readWorkers,
  writeWorkers,
  registerWorker,
  updateWorker,
  closeWorker,
  recordWorkerMerge,
  checkWorker,
  workerEffectEvidence,
  workerEffectEvidenceForEntry,
  WORKER_EFFECT_EVIDENCE_FLAG,
  validateResultSchema,
  locateResultSchema,
} = await import("../../../dist/lib/orchestrator/workers.js");
const { default: orchestratorExtension } =
  await import("../../../dist/extensions/orchestrator/index.js");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed++;
    console.log(`  [fail] ${name}: ${error.message}`);
  }
}

/** Fresh project dir per test — registry state never leaks across tests. */
function freshProject() {
  return mkdtempSync(join(tmpdir(), "w170-project-"));
}

/** Fresh git repo on main with one base commit. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "w170-repo-"));
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.email", "test@example.com");
  gitIn(repo, "config", "user.name", "test");
  gitIn(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "base.txt"), "base\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return repo;
}

function gitIn(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function branchExistsIn(repo, branch) {
  return gitIn(repo, "branch", "--list", branch).length > 0;
}

function registryFile(project) {
  return getWorkersFilePath(project);
}

console.log("worker registry test\n");

// ── Path resolution ─────────────────────────────────────────────────────────

test("getWorkersFilePath sits beside locks.json in the per-project dir", () => {
  const project = freshProject();
  const workers = getWorkersFilePath(project);
  const locks = getLockFilePath(project);
  assert.equal(dirname(workers), dirname(locks), "same per-project directory");
  assert.equal(workers, join(dirname(locks), "workers.json"));
  assert.ok(
    workers.startsWith(join(BRAID_DIR, "projects")),
    `expected a per-project path under ${BRAID_DIR}/projects, got ${workers}`,
  );
});

// ── Admission ───────────────────────────────────────────────────────────────

test("registerWorker admits a full handle and persists it", () => {
  const project = freshProject();
  const result = registerWorker(
    {
      workerId: "w1",
      spec: "research",
      cwd: project,
      files: [join(project, "a.ts")],
      branch: "worker/w1/research",
      outputFile: join(project, "report.md"),
    },
    project,
  );

  assert.equal(result.ok, true);
  const entry = result.entry;
  assert.equal(entry.workerId, "w1");
  assert.equal(entry.spec, "research");
  assert.equal(entry.status, "admitted");
  assert.equal(entry.cwd, project);
  assert.equal(entry.pane, null);
  assert.equal(entry.workspace, null);
  assert.equal(entry.workerSession, null);
  assert.equal(entry.outputFile, join(project, "report.md"));
  assert.equal(entry.branch, "worker/w1/research");
  assert.deepEqual(entry.files, [join(project, "a.ts")]);
  assert.equal(entry.resultAt, null);
  assert.equal(entry.closedAt, null);
  assert.deepEqual(entry.gates, []);
  assert.ok(!Number.isNaN(Date.parse(entry.spawnedAt)), "spawnedAt is an ISO timestamp");
  assert.equal(entry.lastSeenAt, entry.spawnedAt);

  const persisted = readWorkers(project);
  assert.equal(persisted.version, WORKER_REGISTRY_VERSION);
  assert.deepEqual(persisted.workers.w1, entry, "handle round-trips through disk");
});

test("registerWorker reuses a live entry for the same request and refuses another", () => {
  const project = freshProject();
  const first = registerWorker({ workerId: "w2", spec: "impl", cwd: project }, project);
  assert.equal(first.ok, true);
  assert.equal(
    first.entry.requestId,
    "w2:1",
    "admission records the derived (workerId, step) key",
  );
  assert.equal(first.entry.checkpoint, null);

  // The retry a restarted caller makes carries the same request, so it gets
  // back the entry that request already admitted instead of a second one.
  const retry = registerWorker({ workerId: "w2", spec: "impl", cwd: project }, project);
  assert.equal(retry.ok, true);
  assert.equal(retry.reused, true);
  assert.equal(retry.entry.spawnedAt, first.entry.spawnedAt, "first handle kept");
  assert.equal(Object.keys(readWorkers(project).workers).length, 1, "no duplicate row");

  // A different request id, or the same request describing different work, is
  // refused loudly rather than admitted beside the live entry.
  const other = registerWorker(
    { workerId: "w2", spec: "impl", cwd: project, requestId: "w2:2" },
    project,
  );
  assert.equal(other.ok, false);
  assert.match(other.reason, /live/);
  assert.match(other.reason, /w2:2 is a different request/);

  const changed = registerWorker({ workerId: "w2", spec: "research", cwd: project }, project);
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /describes different work/);

  const persisted = readWorkers(project);
  assert.equal(Object.keys(persisted.workers).length, 1, "a refusal writes nothing");
  assert.equal(persisted.workers.w2.spawnedAt, first.entry.spawnedAt, "first handle kept");
});

test("registerWorker validates required fields", () => {
  const project = freshProject();
  assert.throws(() => registerWorker({ workerId: "", spec: "impl", cwd: project }, project));
  assert.throws(() => registerWorker({ workerId: "w3", spec: "", cwd: project }, project));
  assert.throws(() => registerWorker({ workerId: "w3", spec: "impl", cwd: "" }, project));
});

// ── Updates ──────────────────���──────────────────────────────────────────────

test("updateWorker merges handle fields and refreshes lastSeenAt", () => {
  const project = freshProject();
  const registered = registerWorker({ workerId: "w4", spec: "impl", cwd: project }, project);

  const updated = updateWorker(
    "w4",
    {
      pane: "pane-7",
      workspace: "ws-2",
      workerSession: join(project, "session.jsonl"),
      outputFile: join(project, "out.md"),
      status: "working",
    },
    project,
  );

  assert.ok(updated, "entry found");
  assert.equal(updated.pane, "pane-7");
  assert.equal(updated.workspace, "ws-2");
  assert.equal(updated.workerSession, join(project, "session.jsonl"));
  assert.equal(updated.outputFile, join(project, "out.md"));
  assert.equal(updated.status, "working");
  assert.equal(
    updated.spawnedAt,
    registered.entry.spawnedAt,
    "spawnedAt is immutable across updates",
  );
  assert.ok(updated.lastSeenAt >= updated.spawnedAt);
  assert.deepEqual(readWorkers(project).workers.w4, updated);
});

test("updateWorker returns null for an unknown worker", () => {
  const project = freshProject();
  assert.equal(updateWorker("nope", { status: "working" }, project), null);
});

test("updateWorker rejects an unknown status", () => {
  const project = freshProject();
  registerWorker({ workerId: "w5", spec: "impl", cwd: project }, project);
  assert.throws(() => updateWorker("w5", { status: "done-ish" }, project), /Unknown worker status/);
});

// ── Closure ─────────────────────────────────────────────────────────────────

test("closeWorker stamps outcome, closedAt, and gate evidence", () => {
  const project = freshProject();
  registerWorker({ workerId: "w6", spec: "impl", cwd: project }, project);

  const closed = closeWorker(
    "w6",
    "completed",
    [
      { cmd: "npm run typecheck", exit: 0 },
      { cmd: "npm test", exit: 0 },
    ],
    project,
  );

  assert.ok(closed, "entry found");
  assert.equal(closed.status, "completed");
  assert.ok(closed.closedAt, "closedAt stamped");
  assert.ok(closed.resultAt, "resultAt stamped on completion");
  assert.equal(closed.gates.length, 2);
  assert.equal(closed.gates[0].cmd, "npm run typecheck");
  assert.equal(closed.gates[1].exit, 0);
  assert.ok(closed.gates.every((gate) => !Number.isNaN(Date.parse(gate.at))));
  assert.deepEqual(readWorkers(project).workers.w6, closed);
});

test("closeWorker does not overwrite a prior closure", () => {
  const project = freshProject();
  registerWorker({ workerId: "w7", spec: "impl", cwd: project }, project);
  const first = closeWorker("w7", "error", [{ cmd: "npm test", exit: 1 }], project);

  const second = closeWorker("w7", "completed", [], project);
  assert.equal(second.status, "error", "first close wins");
  assert.equal(second.closedAt, first.closedAt);
  assert.equal(second.gates.length, 1, "late gates are not appended to a closed entry");
});

test("closeWorker refuses a completed close with no gate evidence", () => {
  const project = freshProject();
  registerWorker({ workerId: "w13", spec: "impl", cwd: project }, project);
  const before = readWorkers(project).workers.w13;

  assert.throws(
    () => closeWorker("w13", "completed", [], project),
    /completed close requires non-empty gate evidence/,
  );
  assert.throws(
    () => closeWorker("w13", "completed", undefined, project),
    /completed close requires non-empty gate evidence/,
    "the requirement holds for a missing gates argument too",
  );
  assert.throws(
    // The lib type says array; a JS caller can still pass anything.
    () => closeWorker("w13", "completed", "npm test", project),
    /gates must be an array/,
  );
  assert.deepEqual(
    readWorkers(project).workers.w13,
    before,
    "a refused close leaves the row untouched (status, gates, closedAt)",
  );
});

test("closeWorker refuses malformed gate entries without writing", () => {
  const project = freshProject();
  registerWorker({ workerId: "w14", spec: "impl", cwd: project }, project);
  const before = readWorkers(project).workers.w14;

  assert.throws(
    () => closeWorker("w14", "completed", [{ cmd: "", exit: 0 }], project),
    /gates\[0\]\.cmd must be a non-empty string/,
  );
  assert.throws(
    () => closeWorker("w14", "completed", [{ cmd: "npm test" }], project),
    /gates\[0\]\.exit must be a number/,
  );
  assert.throws(
    () => closeWorker("w14", "completed", [{ cmd: "npm test", exit: "0" }], project),
    /gates\[0\]\.exit must be a number/,
  );
  assert.throws(
    () => closeWorker("w14", "error", [{ cmd: "npm test", exit: null }], project),
    /gates\[0\]\.exit must be a number/,
    "the shape check runs for every outcome, not only completed",
  );
  assert.deepEqual(readWorkers(project).workers.w14, before, "the row stays untouched");
});

test("closeWorker accepts empty gate evidence for non-completed outcomes", () => {
  const project = freshProject();
  for (const outcome of ["error", "false-done", "closed"]) {
    registerWorker({ workerId: `w15-${outcome}`, spec: "impl", cwd: project }, project);
    const closed = closeWorker(`w15-${outcome}`, outcome, [], project);
    assert.equal(closed.status, outcome);
    assert.deepEqual(closed.gates, []);
  }

  registerWorker({ workerId: "w15-none", spec: "impl", cwd: project }, project);
  const closed = closeWorker("w15-none", "error", undefined, project);
  assert.ok(closed, "a non-completed close needs no gate evidence");
  assert.deepEqual(closed.gates, []);
});

test("closeWorker returns null for an unknown worker and rejects bad outcomes", () => {
  const project = freshProject();
  assert.equal(closeWorker("nope", "completed", [], project), null);
  registerWorker({ workerId: "w8", spec: "impl", cwd: project }, project);
  assert.throws(() => closeWorker("w8", "finished", [], project), /Unknown worker outcome/);
});

test("a closed entry rolls over on re-register (retry is countable)", () => {
  const project = freshProject();
  registerWorker({ workerId: "w9", spec: "impl", cwd: project }, project);
  closeWorker("w9", "false-done", [{ cmd: "npm test", exit: 1 }], project);

  const retry = registerWorker({ workerId: "w9", spec: "impl", cwd: project }, project);
  assert.equal(retry.ok, true, "closed entries do not block admission");
  assert.equal(retry.entry.status, "admitted");
  assert.equal(retry.entry.closedAt, null);
  assert.deepEqual(retry.entry.gates, [], "the fresh attempt starts with empty gates");
  assert.equal(readWorkers(project).workers.w9.status, "admitted");
});

// ── Persistence hygiene ─────────────────────────────────────────────���───────

test("registry writes are atomic (no temp litter) and mode 0600", () => {
  const project = freshProject();
  registerWorker({ workerId: "w10", spec: "impl", cwd: project }, project);
  updateWorker("w10", { status: "working" }, project);
  closeWorker("w10", "error", [], project);

  const file = registryFile(project);
  assert.ok(existsSync(file), "registry file exists");
  const leftovers = readdirSync(dirname(file)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "no temp files left behind");
  assert.equal(statSync(file).mode & 0o777, 0o600, "registry file is owner-only");
});

test("a missing or corrupt registry reads as empty, never throws", () => {
  const project = freshProject();
  assert.deepEqual(readWorkers(project), { version: WORKER_REGISTRY_VERSION, workers: {} });

  const file = registryFile(project);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{ not json", "utf-8");
  assert.deepEqual(readWorkers(project), { version: WORKER_REGISTRY_VERSION, workers: {} });

  writeFileSync(file, JSON.stringify({ version: 1, workers: null }), "utf-8");
  assert.deepEqual(readWorkers(project), { version: WORKER_REGISTRY_VERSION, workers: {} });

  const result = registerWorker({ workerId: "w11", spec: "impl", cwd: project }, project);
  assert.equal(result.ok, true, "registration heals a corrupt file");
  assert.equal(JSON.parse(readFileSync(file, "utf-8")).workers.w11.status, "admitted");
});

test("writeWorkers persists an explicit registry", () => {
  const project = freshProject();
  const registry = {
    version: WORKER_REGISTRY_VERSION,
    workers: {},
  };
  writeWorkers(registry, project);
  assert.deepEqual(readWorkers(project), registry);
});

// ── Lookup without an explicit cwd ──────────────────────────────────────────

test("a worker is located across project registries when cwd is omitted", () => {
  const project = freshProject();
  registerWorker({ workerId: "w12", spec: "impl", cwd: project }, project);

  const updated = updateWorker("w12", { status: "working" });
  assert.ok(updated, "located without cwd");
  assert.equal(updated.status, "working");
  assert.equal(
    readWorkers(project).workers.w12.status,
    "working",
    "the write landed in the worker's own registry",
  );

  const closed = closeWorker("w12", "completed", [{ cmd: "npm test", exit: 0 }], project);
  assert.equal(closed.status, "completed");
});

// ── Status / outcome parsing ────────────────────────────────────────────────

test("parseWorkerStatus and parseWorkerOutcome accept the vocabulary, reject the rest", () => {
  assert.equal(parseWorkerStatus("false-done"), "false-done");
  assert.equal(parseWorkerStatus(" admitted "), "admitted");
  assert.throws(() => parseWorkerStatus("bogus"), /Unknown worker status/);

  assert.equal(parseWorkerOutcome("completed"), "completed");
  assert.throws(() => parseWorkerOutcome("working"), /Unknown worker outcome/);
});

// ── Result schema ───────────────────────────────────────────────────────────

/** Write a session JSONL fixture; one JSON object per line. */
function writeSession(dir, lines) {
  const file = join(dir, "session.jsonl");
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf-8");
  return file;
}

function assistantTurn(text) {
  return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** A result-schema block per the subagent contract design (§2.3). */
function resultBlock(overrides = {}) {
  const block = {
    worker: "fixture",
    spec: "research",
    status: "completed",
    output_file: "/tmp/report.md",
    artifacts: [],
    gate_evidence: [],
    claims: [],
    blocked_reason: null,
    next: "none",
    ...overrides,
  };
  return "```json\n" + JSON.stringify(block, null, 2) + "\n```";
}

function fencedJson(raw) {
  return "```json\n" + raw + "\n```";
}

test("validateResultSchema: a fenced block in the last assistant message is valid", () => {
  const dir = freshProject();
  const file = writeSession(dir, [assistantTurn("progress"), assistantTurn(resultBlock())]);
  assert.equal(validateResultSchema(file), true);
});

test("validateResultSchema: only the last assistant message counts at offset 0", () => {
  const dir = freshProject();
  const file = writeSession(dir, [assistantTurn("progress"), assistantTurn(resultBlock())]);
  assert.equal(validateResultSchema(file), true);
  assert.equal(locateResultSchema(file).messageOffset, 0, "terminal block sits at offset 0");
});

test("locateResultSchema: a block one message back validates and reports offset 1", () => {
  const dir = freshProject();
  const file = writeSession(dir, [
    assistantTurn("progress"),
    assistantTurn(resultBlock()),
    assistantTurn("All done — wrapping up."),
  ]);
  const located = locateResultSchema(file);
  assert.ok(located, "a near-terminal block still validates");
  assert.equal(located.messageOffset, 1, "the block was the second-to-last assistant message");
  assert.equal(validateResultSchema(file), true);
});

test("locateResultSchema: no block within the last 3 assistant messages is invalid", () => {
  const dir = freshProject();
  const file = writeSession(dir, [
    assistantTurn(resultBlock()),
    assistantTurn("a"),
    assistantTurn("b"),
    assistantTurn("c"),
  ]);
  assert.equal(locateResultSchema(file), null, "the block is the 4th assistant message back");
  assert.equal(validateResultSchema(file), false);
});

test("validateResultSchema: bare JSON accepted; malformed or incomplete blocks rejected", () => {
  const dir = freshProject();
  const bare = writeSession(dir, [
    assistantTurn(
      JSON.stringify({ worker: "w", spec: "impl", status: "completed", output_file: "/tmp/x.md" }),
    ),
  ]);
  assert.equal(validateResultSchema(bare), true);

  const malformed = writeSession(dir, [assistantTurn(fencedJson("{ not json"))]);
  assert.equal(validateResultSchema(malformed), false);

  const incomplete = writeSession(dir, [
    assistantTurn(fencedJson(JSON.stringify({ worker: "w", status: "completed" }))),
  ]);
  assert.equal(validateResultSchema(incomplete), false);
});

test("validateResultSchema: missing sessions and non-assistant turns are invalid", () => {
  assert.equal(validateResultSchema(null), false);
  assert.equal(validateResultSchema(join(freshProject(), "absent.jsonl")), false);
  const dir = freshProject();
  const file = writeSession(dir, [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: resultBlock() }] },
    },
  ]);
  assert.equal(validateResultSchema(file), false);
});

// ── Verdict computation ─────────────────────────────────────────────────���───

test("checkWorker: live done with a missing output file is false-done, never completed", () => {
  const project = freshProject();
  registerWorker(
    { workerId: "v1", spec: "research", cwd: project, outputFile: join(project, "missing.md") },
    project,
  );

  const verdict = checkWorker("v1", { liveStatus: "done", cwd: project });
  assert.equal(verdict.status, "false-done");
  assert.equal(verdict.outputExists, false);
  assert.equal(verdict.outputAgeSec, null);
  assert.equal(verdict.schemaValid, false);
  assert.match(verdict.reason, /output file missing/);
});

test("checkWorker: live done with output + schema completes a research worker", () => {
  const project = freshProject();
  const out = join(project, "report.md");
  writeFileSync(out, "result", "utf-8");
  const session = writeSession(project, [assistantTurn(resultBlock())]);
  registerWorker({ workerId: "v2", spec: "research", cwd: project, outputFile: out }, project);
  updateWorker("v2", { workerSession: session, status: "working" }, project);

  const verdict = checkWorker("v2", { liveStatus: "done", cwd: project });
  assert.equal(verdict.status, "completed");
  assert.equal(verdict.schemaValid, true);
  assert.equal(verdict.outputExists, true);
  assert.ok(typeof verdict.outputAgeSec === "number" && verdict.outputAgeSec >= 0);
  assert.equal(verdict.branchAhead, null, "no git cwd — branch count unavailable");
  assert.equal(verdict.gateSummary, "no gates recorded");
  assert.match(verdict.reason, /output \+ schema verified/);
});

test("checkWorker: a live working status outranks present evidence", () => {
  const project = freshProject();
  const out = join(project, "report.md");
  writeFileSync(out, "result", "utf-8");
  const session = writeSession(project, [assistantTurn(resultBlock())]);
  registerWorker({ workerId: "v3", spec: "research", cwd: project, outputFile: out }, project);
  updateWorker("v3", { workerSession: session }, project);

  const verdict = checkWorker("v3", { liveStatus: "working", cwd: project });
  assert.equal(verdict.status, "working");
  assert.match(verdict.reason, /live status working/);
});

test("checkWorker: live blocked maps to stalled", () => {
  const project = freshProject();
  registerWorker({ workerId: "v3b", spec: "research", cwd: project }, project);
  const verdict = checkWorker("v3b", { liveStatus: "blocked", cwd: project });
  assert.equal(verdict.status, "stalled");
  assert.match(verdict.reason, /live status blocked/);
});

test("checkWorker: a frozen session with no output stalls without a live status", () => {
  const project = freshProject();
  const session = writeSession(project, [assistantTurn("working")]);
  registerWorker(
    { workerId: "v4", spec: "research", cwd: project, outputFile: join(project, "missing.md") },
    project,
  );
  updateWorker("v4", { workerSession: session, status: "working" }, project);
  const threeHoursAgo = Date.now() / 1000 - 3 * 60 * 60;
  utimesSync(session, threeHoursAgo, threeHoursAgo);

  const verdict = checkWorker("v4", { cwd: project });
  assert.equal(verdict.status, "stalled");
  assert.match(verdict.reason, /frozen/);
  assert.ok(verdict.sessionGrowthAgeSec > 600);
});

test("checkWorker: a closed entry reports closed with its gate summary", () => {
  const project = freshProject();
  registerWorker({ workerId: "v5", spec: "research", cwd: project }, project);
  closeWorker(
    "v5",
    "completed",
    [
      { cmd: "npm test", exit: 1 },
      { cmd: "npm run build", exit: 0 },
    ],
    project,
  );

  const verdict = checkWorker("v5", { cwd: project });
  assert.equal(verdict.status, "closed");
  assert.match(verdict.reason, /outcome completed/);
  assert.equal(verdict.gateSummary, "1/2 passed; failing: npm test");
});

test("checkWorker: a registry-marked error reports error", () => {
  const project = freshProject();
  registerWorker({ workerId: "v6", spec: "research", cwd: project }, project);
  updateWorker("v6", { status: "error" }, project);
  const verdict = checkWorker("v6", { cwd: project });
  assert.equal(verdict.status, "error");
  assert.match(verdict.reason, /registry marked error/);
});

test("checkWorker: impl without a branch commit is false-done", () => {
  const project = freshProject();
  const out = join(project, "out.md");
  writeFileSync(out, "result", "utf-8");
  const session = writeSession(project, [
    assistantTurn(resultBlock({ spec: "impl", output_file: out })),
  ]);
  registerWorker(
    { workerId: "v7", spec: "impl", cwd: project, outputFile: out, branch: "worker/v7/impl" },
    project,
  );
  updateWorker("v7", { workerSession: session }, project);

  const verdict = checkWorker("v7", { liveStatus: "done", cwd: project });
  assert.equal(verdict.status, "false-done");
  assert.match(verdict.reason, /no commit on worker branch/);
});

test("checkWorker: impl completes once the worker branch carries a commit", () => {
  const repo = freshProject();
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email test@test.local", { cwd: repo });
  execSync("git config user.name test", { cwd: repo });
  writeFileSync(join(repo, "f.txt"), "x", "utf-8");
  execSync("git add -A && git commit -qm init", { cwd: repo });
  const base = execSync("git symbolic-ref --short HEAD", { cwd: repo, encoding: "utf-8" }).trim();
  execSync("git checkout -qb worker/v8/impl", { cwd: repo });
  writeFileSync(join(repo, "f.txt"), "xy", "utf-8");
  execSync("git commit -qam impl", { cwd: repo });
  execSync(`git checkout -q ${base}`, { cwd: repo });

  const out = join(repo, "out.md");
  writeFileSync(out, "result", "utf-8");
  const session = writeSession(repo, [
    assistantTurn(resultBlock({ spec: "impl", output_file: out })),
  ]);
  registerWorker(
    { workerId: "v8", spec: "impl", cwd: repo, outputFile: out, branch: "worker/v8/impl" },
    repo,
  );
  updateWorker("v8", { workerSession: session }, repo);

  const verdict = checkWorker("v8", { liveStatus: "done", cwd: repo });
  assert.equal(verdict.status, "completed");
  assert.equal(verdict.branchAhead, 1);
});

test("checkWorker returns null for an unknown worker", () => {
  assert.equal(checkWorker("ghost", { cwd: freshProject() }), null);
});

// ── Effect evidence ─────────────────────────────────────────────────────

/**
 * Set a file's mtime relative to a spawn timestamp. The offset is explicit,
 * so the evidence judgment cannot ride on filesystem timestamp granularity.
 */
function pinMtime(file, spawnedIso, offsetMs) {
  const at = new Date(Date.parse(spawnedIso) + offsetMs);
  utimesSync(file, at, at);
}

test("effect evidence: a passing gate is evidence, so a completed close is not flagged", () => {
  const project = freshProject();
  registerWorker({ workerId: "e1", spec: "research", cwd: project }, project);
  closeWorker("e1", "completed", [{ cmd: "npm test", exit: 0 }], project);

  const verdict = checkWorker("e1", { cwd: project });
  assert.equal(verdict.status, "closed");
  assert.deepEqual(verdict.effectEvidence, {
    outputWritten: false,
    branchAdvanced: false,
    gatePassed: true,
    none: false,
  });
});

test("effect evidence: a deliverable written during the run is evidence on its own", () => {
  const project = freshProject();
  const out = join(project, "report.md");
  const registered = registerWorker(
    { workerId: "e2", spec: "research", cwd: project, outputFile: out },
    project,
  );
  writeFileSync(out, "written during the run", "utf-8");
  pinMtime(out, registered.entry.spawnedAt, 60_000);
  closeWorker("e2", "completed", [{ cmd: "npm test", exit: 1 }], project);

  const verdict = checkWorker("e2", { cwd: project });
  assert.equal(verdict.effectEvidence.outputWritten, true);
  assert.equal(verdict.effectEvidence.gatePassed, false, "the failing gate is no evidence");
  assert.equal(verdict.effectEvidence.branchAdvanced, false);
  assert.equal(verdict.effectEvidence.none, false, "the fresh output alone is evidence");
});

test("effect evidence: a branch ahead of its base is evidence on its own", () => {
  const repo = makeRepo();
  gitIn(repo, "checkout", "-q", "-b", "worker/e3/impl");
  writeFileSync(join(repo, "work.txt"), "worker work\n", "utf-8");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "worker work");
  gitIn(repo, "checkout", "-q", "main");

  registerWorker(
    { workerId: "e3", spec: "impl", cwd: repo, branch: "worker/e3/impl" },
    repo,
  );
  closeWorker("e3", "completed", [{ cmd: "npm test", exit: 1 }], repo);

  const verdict = checkWorker("e3", { cwd: repo });
  assert.equal(verdict.branchAhead, 1);
  assert.equal(verdict.effectEvidence.branchAdvanced, true);
  assert.equal(verdict.effectEvidence.gatePassed, false);
  assert.equal(verdict.effectEvidence.none, false, "the branch commit alone is evidence");
});

test("effect evidence: a recorded merge sha is evidence even when the branch is gone", () => {
  const project = freshProject();
  registerWorker({ workerId: "e4", spec: "impl", cwd: project }, project);
  closeWorker("e4", "completed", [{ cmd: "npm test", exit: 1 }], project);
  recordWorkerMerge("e4", { mergeSha: "a1b2c3d4e5f6", cwd: project });

  const verdict = checkWorker("e4", { cwd: project });
  assert.equal(verdict.effectEvidence.branchAdvanced, true, "the merge sha stands in for the branch");
  assert.equal(verdict.effectEvidence.none, false);
});

test("effect evidence: a completed close with none of the three kinds is flagged", () => {
  const project = freshProject();
  registerWorker({ workerId: "e5", spec: "research", cwd: project }, project);
  closeWorker("e5", "completed", [{ cmd: "npm test", exit: 1 }], project);

  const verdict = checkWorker("e5", { cwd: project });
  assert.deepEqual(verdict.effectEvidence, {
    outputWritten: false,
    branchAdvanced: false,
    gatePassed: false,
    none: true,
  });
  assert.equal(verdict.status, "closed", "the flag changes no verdict field but its own");
  assert.match(verdict.reason, /outcome completed/, "the reason is unchanged");
});

test("effect evidence: an output file that predates the run is not evidence", () => {
  const project = freshProject();
  const out = join(project, "stale.md");
  const registered = registerWorker(
    { workerId: "e6", spec: "research", cwd: project, outputFile: out },
    project,
  );
  writeFileSync(out, "written before the worker existed", "utf-8");
  pinMtime(out, registered.entry.spawnedAt, -60_000);
  closeWorker("e6", "completed", [{ cmd: "npm test", exit: 1 }], project);

  const verdict = checkWorker("e6", { cwd: project });
  assert.equal(verdict.outputExists, true, "the raw field still reports the file");
  assert.equal(
    verdict.effectEvidence.outputWritten,
    false,
    "but it was not written during the run",
  );
  assert.equal(verdict.effectEvidence.none, true, "the flag fires on a stale deliverable");
});

test("workerEffectEvidence: the kinds are judged independently, absent facts are no evidence", () => {
  const spawnedAt = new Date(1_000_000).toISOString();
  const bare = { spawnedAt, mergeSha: null, gates: [] };

  assert.equal(
    workerEffectEvidence(bare, { outputMtimeMs: null, branchAhead: 0 }).none,
    true,
    "a branch ahead by 0 is not an advance",
  );
  assert.equal(
    workerEffectEvidence({ ...bare, mergeSha: "abc123" }, {
      outputMtimeMs: null,
      branchAhead: 0,
    }).branchAdvanced,
    true,
    "a merge sha is evidence even at branchAhead 0",
  );
  assert.equal(
    workerEffectEvidence(
      { ...bare, gates: [{ cmd: "a", exit: 1, at: "" }, { cmd: "b", exit: 0, at: "" }] },
      { outputMtimeMs: null, branchAhead: null },
    ).gatePassed,
    true,
    "a passing gate among failures counts",
  );
  assert.equal(
    workerEffectEvidence(bare, { outputMtimeMs: 1_000_000, branchAhead: null }).outputWritten,
    true,
    "an mtime exactly at spawn time counts",
  );
  assert.equal(
    workerEffectEvidence({ ...bare, spawnedAt: "not-a-date" }, {
      outputMtimeMs: 9e15,
      branchAhead: null,
    }).outputWritten,
    false,
    "an unparsable spawnedAt makes any mtime unevidenceable",
  );
});

test("workerEffectEvidenceForEntry gathers the facts itself (stat + git)", () => {
  const repo = makeRepo();
  gitIn(repo, "checkout", "-q", "-b", "worker/e7/impl");
  writeFileSync(join(repo, "work.txt"), "worker work\n", "utf-8");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "worker work");
  gitIn(repo, "checkout", "-q", "main");

  const out = join(repo, "out.md");
  const registered = registerWorker(
    { workerId: "e7", spec: "impl", cwd: repo, branch: "worker/e7/impl", outputFile: out },
    repo,
  );
  writeFileSync(out, "written during the run", "utf-8");
  pinMtime(out, registered.entry.spawnedAt, 60_000);

  const evidence = workerEffectEvidenceForEntry(readWorkers(repo).workers.e7, { cwd: repo });
  assert.deepEqual(evidence, {
    outputWritten: true,
    branchAdvanced: true,
    gatePassed: false,
    none: false,
  });

  const withoutCwd = workerEffectEvidenceForEntry(readWorkers(repo).workers.e7, {});
  assert.equal(
    withoutCwd.branchAdvanced,
    false,
    "an uncountable branch is absent fact, not invented evidence",
  );
  assert.equal(withoutCwd.outputWritten, true, "the stat needs no cwd");
});

// ── Extension actions (real registered tool, fake ExtensionAPI) ────────────

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

await testAsync("tool: register-worker admits, reuses a duplicate request, and requires cwd", async () => {
  const project = freshProject();
  const admitted = JSON.parse(
    toolText(
      await runTool({
        action: "register-worker",
        workerId: "tw1",
        spec: "research",
        cwd: project,
        outputFile: join(project, "r.md"),
      }),
    ),
  );
  assert.equal(admitted.ok, true);
  assert.equal(admitted.entry.status, "admitted");
  assert.equal(admitted.entry.outputFile, join(project, "r.md"));

  const duplicate = JSON.parse(
    toolText(
      await runTool({ action: "register-worker", workerId: "tw1", spec: "research", cwd: project }),
    ),
  );
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.reused, true, "a retried admission reuses the live entry");
  assert.equal(duplicate.entry.spawnedAt, admitted.entry.spawnedAt, "no duplicate was written");

  await assert.rejects(
    () => runTool({ action: "register-worker", workerId: "tw2", spec: "impl" }),
    /requires workerId, spec, and cwd/,
  );
});

await testAsync("tool: update-worker merges fields and resolves across projects", async () => {
  const project = freshProject();
  await runTool({ action: "register-worker", workerId: "tw3", spec: "impl", cwd: project });

  const text = toolText(
    await runTool({
      action: "update-worker",
      workerId: "tw3",
      pane: "pane-3",
      workspace: "ws-3",
      workerSession: join(project, "s.jsonl"),
      status: "working",
    }),
  );
  assert.match(text, /updated/);
  const entry = readWorkers(project).workers.tw3;
  assert.equal(entry.pane, "pane-3");
  assert.equal(entry.workspace, "ws-3");
  assert.equal(entry.workerSession, join(project, "s.jsonl"));
  assert.equal(entry.status, "working");

  const missing = toolText(
    await runTool({ action: "update-worker", workerId: "ghost", cwd: project }),
  );
  assert.match(missing, /No registry entry/);
});

await testAsync("tool: check-worker returns the structured verdict", async () => {
  const project = freshProject();
  const out = join(project, "r.md");
  await runTool({
    action: "register-worker",
    workerId: "tw4",
    spec: "research",
    cwd: project,
    outputFile: out,
  });

  const falseDone = await runTool({
    action: "check-worker",
    workerId: "tw4",
    cwd: project,
    liveStatus: "done",
  });
  assert.equal(falseDone.details.status, "false-done");
  assert.match(toolText(falseDone), /status: false-done/);

  writeFileSync(out, "result", "utf-8");
  const session = writeSession(project, [assistantTurn(resultBlock())]);
  await runTool({
    action: "update-worker",
    workerId: "tw4",
    workerSession: session,
    status: "working",
    cwd: project,
  });

  const completed = await runTool({
    action: "check-worker",
    workerId: "tw4",
    cwd: project,
    liveStatus: "done",
  });
  assert.equal(completed.details.status, "completed");
  const text = toolText(completed);
  assert.match(text, /schemaValid: true/);
  assert.match(text, /gateSummary: no gates recorded/);

  const ghost = toolText(
    await runTool({ action: "check-worker", workerId: "ghost", cwd: project }),
  );
  assert.match(ghost, /No registry entry and no locks/);
});

await testAsync(
  "tool: close-worker records the outcome and list-workers shows counts",
  async () => {
    const project = freshProject();
    await runTool({ action: "register-worker", workerId: "tw5", spec: "impl", cwd: project });

    const closed = await runTool({
      action: "close-worker",
      workerId: "tw5",
      outcome: "completed",
      gates: [{ cmd: "npm test", exit: 0 }],
      cwd: project,
    });
    assert.match(toolText(closed), /closed: completed/);
    const entry = readWorkers(project).workers.tw5;
    assert.equal(entry.status, "completed");
    assert.ok(entry.closedAt);
    assert.equal(entry.gates.length, 1);

    const liveView = toolText(await runTool({ action: "list-workers", cwd: project }));
    assert.match(liveView, /No live workers/);

    const all = toolText(
      await runTool({ action: "list-workers", cwd: project, includeClosed: true }),
    );
    assert.match(all, /tw5/);
    assert.match(all, /status=completed/);
    assert.match(all, /counts: total=1 live=0 closed=1/);
    assert.match(all, /closed=/);

    await assert.rejects(
      () => runTool({ action: "close-worker", workerId: "tw5" }),
      /requires workerId and outcome/,
    );
    await assert.rejects(() => runTool({ action: "nonsense" }), /Unknown action/);
  },
);

// ── Lifecycle actions that must leave no half-made worker ───────────────

await testAsync("tool: spawn-worker registers a complete entry and creates the branch", async () => {
  const repo = makeRepo();
  const file = join(repo, "work.txt");
  const out = join(repo, "out.md");

  const text = toolText(
    await runTool({
      action: "spawn-worker",
      workerId: "sw1",
      slug: "lifecycle",
      files: [file],
      spec: "impl",
      outputFile: out,
      cwd: repo,
    }),
  );
  assert.match(text, /ready and registered/);

  const entry = readWorkers(repo).workers.sw1;
  assert.ok(entry, "spawn wrote a registry entry (not invisible to list-workers)");
  assert.equal(entry.spec, "impl");
  assert.equal(entry.branch, "worker/sw1/lifecycle");
  assert.deepEqual(entry.files, [file]);
  assert.equal(entry.outputFile, out);
  assert.equal(entry.status, "admitted");

  const locks = getAllLocks(repo);
  assert.ok(locks[file], "the spawned worker holds its file lock");
  assert.equal(locks[file].branch, "worker/sw1/lifecycle");
  assert.ok(branchExistsIn(repo, "worker/sw1/lifecycle"), "the worker branch exists");
});

await testAsync(
  "tool: spawn-worker refuses to mutate anything when spec/outputFile are missing",
  async () => {
    const repo = makeRepo();
    const file = join(repo, "work.txt");

    await assert.rejects(
      () =>
        runTool({
          action: "spawn-worker",
          workerId: "sw2",
          slug: "x",
          files: [file],
          outputFile: join(repo, "o.md"),
          cwd: repo,
        }),
      /requires spec and outputFile/,
    );
    await assert.rejects(
      () =>
        runTool({
          action: "spawn-worker",
          workerId: "sw2",
          slug: "x",
          files: [file],
          spec: "impl",
          cwd: repo,
        }),
      /invisible to list-workers and check-worker/,
    );

    assert.equal(readWorkers(repo).workers.sw2, undefined, "no registry entry was written");
    assert.deepEqual(getAllLocks(repo), {}, "no locks were acquired");
    assert.ok(!branchExistsIn(repo, "worker/sw2/x"), "no branch was created");
  },
);

await testAsync(
  "tool: update-worker persists branch/files and check-worker counts commits on it",
  async () => {
    const repo = makeRepo();
    gitIn(repo, "checkout", "-q", "-b", "worker/uw1/impl");
    writeFileSync(join(repo, "work.txt"), "worker work\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-q", "-m", "worker work");
    gitIn(repo, "checkout", "-q", "main");

    const file = join(repo, "work.txt");
    const out = join(repo, "out.md");
    writeFileSync(out, "result", "utf-8");
    const session = writeSession(repo, [
      assistantTurn(resultBlock({ spec: "impl", output_file: out })),
    ]);

    await runTool({
      action: "register-worker",
      workerId: "uw1",
      spec: "impl",
      cwd: repo,
      outputFile: out,
    });
    const updated = toolText(
      await runTool({
        action: "update-worker",
        workerId: "uw1",
        branch: "worker/uw1/impl",
        files: [file],
        workerSession: session,
        cwd: repo,
      }),
    );
    assert.match(updated, /updated/);
    const entry = readWorkers(repo).workers.uw1;
    assert.equal(entry.branch, "worker/uw1/impl", "branch patch persisted");
    assert.deepEqual(entry.files, [file], "files patch persisted");

    const verdict = await runTool({
      action: "check-worker",
      workerId: "uw1",
      cwd: repo,
      liveStatus: "done",
    });
    assert.equal(verdict.details.status, "completed");
    assert.equal(verdict.details.branchAhead, 1, "check-worker counted the branch commit");
  },
);

await testAsync("tool: close-worker releases the worker's locks", async () => {
  const repo = makeRepo();
  const file = join(repo, "work.txt");
  assert.equal(acquireLock([file], "cw1", "worker/cw1/impl", repo), true, "fixture lock");
  await runTool({
    action: "register-worker",
    workerId: "cw1",
    spec: "impl",
    cwd: repo,
    branch: "worker/cw1/impl",
    files: [file],
  });
  assert.ok(getAllLocks(repo)[file], "precondition: the worker holds a lock");

  await runTool({
    action: "close-worker",
    workerId: "cw1",
    outcome: "completed",
    gates: [{ cmd: "npm test", exit: 0 }],
    cwd: repo,
  });
  assert.deepEqual(getAllLocks(repo), {}, "close released the locks");
  assert.equal(readWorkers(repo).workers.cw1.status, "completed");
});

await testAsync("tool: close-worker flags a completed close that produced no effect", async () => {
  const project = freshProject();
  await runTool({ action: "register-worker", workerId: "te1", spec: "research", cwd: project });

  const closed = await runTool({
    action: "close-worker",
    workerId: "te1",
    outcome: "completed",
    gates: [{ cmd: "npm test", exit: 1 }],
    cwd: project,
  });
  const text = toolText(closed);
  assert.match(text, new RegExp(WORKER_EFFECT_EVIDENCE_FLAG), "the flag rides on the close report");
  assert.match(text, /no passing gate/, "the flag names the evidence it did not find");
  assert.equal(closed.details.effectEvidence.none, true);
  assert.equal(closed.details.entry.status, "completed", "the close itself stands (advisory)");
  assert.equal(readWorkers(project).workers.te1.status, "completed");
});

await testAsync(
  "tool: close-worker reports the evidence breakdown and no flag when evidence exists",
  async () => {
    const project = freshProject();
    await runTool({ action: "register-worker", workerId: "te2", spec: "research", cwd: project });

    const closed = await runTool({
      action: "close-worker",
      workerId: "te2",
      outcome: "completed",
      gates: [{ cmd: "npm test", exit: 0 }],
      cwd: project,
    });
    assert.doesNotMatch(toolText(closed), new RegExp(WORKER_EFFECT_EVIDENCE_FLAG));
    assert.deepEqual(closed.details.effectEvidence, {
      outputWritten: false,
      branchAdvanced: false,
      gatePassed: true,
      none: false,
    });
  },
);

await testAsync("tool: a non-completed close carries no effect-evidence flag", async () => {
  const project = freshProject();
  await runTool({ action: "register-worker", workerId: "te3", spec: "impl", cwd: project });

  const closed = await runTool({
    action: "close-worker",
    workerId: "te3",
    outcome: "error",
    cwd: project,
  });
  assert.equal(closed.details.effectEvidence, null, "effect evidence is a completion judgment");
  assert.doesNotMatch(toolText(closed), new RegExp(WORKER_EFFECT_EVIDENCE_FLAG));
});

await testAsync("tool: check-worker renders the effect-evidence line for both polarities", async () => {
  const project = freshProject();

  await runTool({ action: "register-worker", workerId: "te4", spec: "research", cwd: project });
  await runTool({
    action: "close-worker",
    workerId: "te4",
    outcome: "completed",
    gates: [{ cmd: "npm test", exit: 1 }],
    cwd: project,
  });
  const flagged = await runTool({ action: "check-worker", workerId: "te4", cwd: project });
  assert.match(
    toolText(flagged),
    /effectEvidence: no effect evidence \(output=false branch=false gate=false\)/,
  );
  assert.equal(flagged.details.effectEvidence.none, true);

  await runTool({ action: "register-worker", workerId: "te5", spec: "impl", cwd: project });
  await runTool({
    action: "close-worker",
    workerId: "te5",
    outcome: "completed",
    gates: [{ cmd: "npm test", exit: 1 }],
    cwd: project,
  });
  recordWorkerMerge("te5", { mergeSha: "a1b2c3d4e5f6", cwd: project });
  const evidenced = await runTool({ action: "check-worker", workerId: "te5", cwd: project });
  assert.match(toolText(evidenced), /effectEvidence: output=false branch=true gate=false/);
  assert.equal(evidenced.details.effectEvidence.none, false);

  await runTool({ action: "register-worker", workerId: "te6", spec: "research", cwd: project });
  const open = await runTool({ action: "check-worker", workerId: "te6", cwd: project });
  assert.match(toolText(open), /effectEvidence: -/, "not a terminal completion, no judgment");
  assert.equal(open.details.effectEvidence, null);
});

await testAsync(
  "tool: a null entry branch falls back to the lock row's branch, or blocks without one",
  async () => {
    const repo = makeRepo();
    gitIn(repo, "checkout", "-q", "-b", "worker/fb1/impl");
    writeFileSync(join(repo, "work.txt"), "worker work\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-q", "-m", "worker work");
    gitIn(repo, "checkout", "-q", "main");

    const file = join(repo, "work.txt");
    const out = join(repo, "out.md");
    writeFileSync(out, "result", "utf-8");
    const session = writeSession(repo, [
      assistantTurn(resultBlock({ spec: "impl", output_file: out })),
    ]);

    assert.equal(acquireLock([file], "fb1", "worker/fb1/impl", repo), true, "fixture lock");
    await runTool({
      action: "register-worker",
      workerId: "fb1",
      spec: "impl",
      cwd: repo,
      outputFile: out,
    }); // deliberately no branch on the entry
    await runTool({ action: "update-worker", workerId: "fb1", workerSession: session, cwd: repo });

    const verdict = await runTool({
      action: "check-worker",
      workerId: "fb1",
      cwd: repo,
      liveStatus: "done",
    });
    assert.equal(verdict.details.status, "completed", "lock-row branch resolved the commit");
    assert.equal(verdict.details.branchAhead, 1);
    assert.doesNotMatch(verdict.details.reason, /no commit on worker branch/);

    const repo2 = makeRepo();
    const out2 = join(repo2, "out.md");
    writeFileSync(out2, "result", "utf-8");
    const session2 = writeSession(repo2, [
      assistantTurn(resultBlock({ spec: "impl", output_file: out2 })),
    ]);
    await runTool({
      action: "register-worker",
      workerId: "fb2",
      spec: "impl",
      cwd: repo2,
      outputFile: out2,
    });
    await runTool({
      action: "update-worker",
      workerId: "fb2",
      workerSession: session2,
      cwd: repo2,
    });
    const blocked = await runTool({
      action: "check-worker",
      workerId: "fb2",
      cwd: repo2,
      liveStatus: "done",
    });
    assert.equal(blocked.details.status, "false-done");
    assert.match(blocked.details.reason, /no commit on worker branch/);
  },
);

await testAsync(
  "tool: check-worker reports the offset of a near-terminal result block",
  async () => {
    const repo = makeRepo();
    const out = join(repo, "out.md");
    writeFileSync(out, "result", "utf-8");
    const session = writeSession(repo, [
      assistantTurn("progress"),
      assistantTurn(resultBlock({ spec: "research", output_file: out })),
      assistantTurn("Wrapping up now."),
    ]);
    await runTool({
      action: "register-worker",
      workerId: "of1",
      spec: "research",
      cwd: repo,
      outputFile: out,
    });
    await runTool({ action: "update-worker", workerId: "of1", workerSession: session, cwd: repo });

    const verdict = await runTool({
      action: "check-worker",
      workerId: "of1",
      cwd: repo,
      liveStatus: "done",
    });
    assert.equal(verdict.details.status, "completed", "near-terminal block still completes");
    assert.equal(verdict.details.resultSchemaMessageOffset, 1);
    assert.match(toolText(verdict), /resultSchemaMessageOffset: 1/);
  },
);

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
