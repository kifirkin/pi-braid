/**
 * Test: a close records who performed it, and a worker may not close its own row.
 *
 * The registry row is the artifact a later reader trusts without re-running
 * anything, so the close path has three obligations this file pins:
 *
 * 1. A caller that resolves as the row's worker is refused before any write.
 *    The row stays live, with no gates and no closer.
 * 2. An accepted close stamps `closedBy` from evidence the handler resolved:
 *    the role marker first, then the caller's session against the row's
 *    recorded worker session. A seat close is `seat`; a seat close of a row
 *    that records no worker session is `unknown`, never refused — a gate that
 *    refuses the honest case teaches people to work around it.
 * 3. A closed row is terminal. `update-worker` refuses a status or checkpoint
 *    patch on it, and a completed row with no gate evidence reads
 *    `closed-unverified`, because a completed close cannot be produced without
 *    gates. A row closed before the stamp existed is read for its closing
 *    session when the caller supplies one: closed by its own worker session it
 *    reads `closed-unverified`, by the seat that admitted it, `closed`.
 *
 * The seat override (`forcedBySeat`) accepts a worker-attributed close and
 * keeps it visible: the row records the observed kind plus `forced`.
 *
 * Hermetic: HOME is redirected to a temp dir BEFORE the dist imports, and the
 * registry, the locks and the session fixtures all live under it.
 *
 * Run: node packages/core/test/runtime/orchestrator/test-close-attribution.mjs (after npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "close-attribution-home-"));
process.env.HOME = FAKE_HOME;
delete process.env.BRAID_SESSION_ROLE;

const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);
const { readWorkers, writeWorkers } = await import("../../../dist/lib/orchestrator/workers.js");

const fakePi = {
  tools: [],
  registerTool(definition) {
    this.tools.push(definition);
  },
  on() {},
};
orchestratorExtension(fakePi);
const orchestrateTool = fakePi.tools.find((tool) => tool.name === "orchestrate");

/** Run the tool as a caller whose context names the given session and root. */
function runTool(params, ctx) {
  return orchestrateTool.execute(
    "call-1",
    params,
    new AbortController().signal,
    undefined,
    ctx,
  );
}

function toolText(result) {
  return result.content[0].text;
}

/** A context shaped like pi's: a session file, an id and the directory it lives in. */
function contextFor(sessionFile, sessionsRoot) {
  return {
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionFile,
      getSessionDir: () => sessionsRoot,
    },
  };
}

let seq = 0;
function freshProject() {
  return mkdtempSync(join(FAKE_HOME, `project-${++seq}-`));
}

function workerSessionPath(name) {
  const dir = mkdtempSync(join(FAKE_HOME, "sessions-"));
  return join(dir, `${name}.jsonl`);
}

/** One parsed session line carrying an orchestrate tool call. */
function orchestrateLine(at, action, workerId) {
  return JSON.stringify({
    type: "message",
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: at,
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: `call-${Math.random().toString(36).slice(2, 8)}`,
          name: "orchestrate",
          arguments: { action, workerId },
        },
      ],
    },
  });
}

/** A session file whose name starts at `startIso` and whose lines are given. */
function writeSessionFile(root, projectDir, startIso, lines) {
  const dir = join(root, projectDir);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(startIso).toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${stamp}_session-${++seq}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return file;
}

/**
 * Truncate one file's mtime down to the second, which is what a filesystem with
 * small inodes or an overlay layer records. The fixture writes its session
 * moments after the row spawns, so on such a filesystem the file's mtime sits
 * below the spawn unless the rule allows for the granularity.
 */
function coarsenMtime(file) {
  const coarse = Math.floor(statSync(file).mtimeMs / 1000) * 1000;
  utimesSync(file, coarse / 1000, coarse / 1000);
  return coarse;
}

/** Read one row through the registry reader, so the fixture never spells the path rule. */
function row(project, workerId) {
  return readWorkers(project).workers[workerId];
}

/** Rewrite the row in place, to shape a legacy or patched record. */
function patchRowFile(project, workerId, mutate) {
  const registry = readWorkers(project);
  mutate(registry.workers[workerId]);
  writeWorkers(registry, project);
}

async function register(project, workerId) {
  await runTool({
    action: "register-worker",
    workerId,
    spec: "research",
    cwd: project,
    outputFile: join(project, "out.md"),
    files: [join(project, "work.txt")],
  });
}

test("a worker-role caller is refused, and nothing is written", async () => {
  const project = freshProject();
  await register(project, "unit-self");
  const session = workerSessionPath("worker-self");
  await runTool({ action: "update-worker", workerId: "unit-self", workerSession: session, cwd: project });
  const before = row(project, "unit-self");

  process.env.BRAID_SESSION_ROLE = "worker";
  try {
    await assert.rejects(
      () =>
        runTool(
          {
            action: "close-worker",
            workerId: "unit-self",
            outcome: "completed",
            gates: [{ cmd: "npm test", exit: 0 }],
            cwd: project,
          },
          contextFor(session, join(FAKE_HOME, "sessions-root")),
        ),
      /may not close its own row/,
    );
  } finally {
    delete process.env.BRAID_SESSION_ROLE;
  }

  const after = row(project, "unit-self");
  assert.equal(after.closedAt, null, "the row stays live");
  assert.equal(after.closedBy, null, "no closer is stamped");
  assert.deepEqual(after.gates, [], "no gate rows are appended");
  assert.equal(after.status, before.status, "the stored status is untouched");
});

test("a self-close by session identity is refused, and nothing is written", async () => {
  const project = freshProject();
  await register(project, "unit-ident");
  const session = workerSessionPath("worker-ident");
  await runTool({ action: "update-worker", workerId: "unit-ident", workerSession: session, cwd: project });

  await assert.rejects(
    () =>
      runTool(
        {
          action: "close-worker",
          workerId: "unit-ident",
          outcome: "closed",
          cwd: project,
        },
        contextFor(session, join(FAKE_HOME, "sessions-root")),
      ),
    /may not close its own row/,
  );

  assert.equal(row(project, "unit-ident").closedAt, null, "the row stays live");
});

test("a seat closing a worker it did not run is accepted and stamped seat", async () => {
  const project = freshProject();
  await register(project, "unit-seat");
  const session = workerSessionPath("worker-seat");
  await runTool({ action: "update-worker", workerId: "unit-seat", workerSession: session, cwd: project });
  const seat = workerSessionPath("seat-seat");

  const closed = await runTool(
    {
      action: "close-worker",
      workerId: "unit-seat",
      outcome: "completed",
      gates: [{ cmd: "npm test", exit: 0 }],
      cwd: project,
    },
    contextFor(seat, join(FAKE_HOME, "sessions-root")),
  );

  const entry = row(project, "unit-seat");
  assert.equal(entry.status, "completed");
  assert.equal(entry.closedBy.kind, "seat", toolText(closed));
  assert.equal(entry.closedBy.session, seat, "the closer's session is recorded");
  assert.equal(entry.closedBy.forced, undefined, "an ordinary seat close is not forced");
  assert.match(entry.closedBy.at, /^\d{4}-\d{2}-\d{2}T/, "the registry clock stamps the closer");
});

test("a seat closing a row with no worker session is accepted as unknown", async () => {
  const project = freshProject();
  await register(project, "unit-nosession");
  const seat = workerSessionPath("seat-nosession");

  const closed = await runTool(
    {
      action: "close-worker",
      workerId: "unit-nosession",
      outcome: "completed",
      gates: [{ cmd: "npm test", exit: 0 }],
      cwd: project,
    },
    contextFor(seat, join(FAKE_HOME, "sessions-root")),
  );

  const entry = row(project, "unit-nosession");
  assert.equal(entry.closedBy.kind, "unknown", toolText(closed));
  assert.equal(entry.closedBy.session, seat);
});

test("a caller context with no session identity is refused as unattributed", async () => {
  const project = freshProject();
  await register(project, "unit-anon");

  await assert.rejects(
    () =>
      runTool(
        {
          action: "close-worker",
          workerId: "unit-anon",
          outcome: "closed",
          cwd: project,
        },
        { sessionManager: {} },
      ),
    /unattributed/,
  );

  assert.equal(row(project, "unit-anon").closedAt, null, "the row stays live");
});

test("the seat override accepts a self-close and keeps it visible", async () => {
  const project = freshProject();
  await register(project, "unit-forced");
  const session = workerSessionPath("worker-forced");
  await runTool({ action: "update-worker", workerId: "unit-forced", workerSession: session, cwd: project });

  const closed = await runTool(
    {
      action: "close-worker",
      workerId: "unit-forced",
      outcome: "completed",
      gates: [{ cmd: "npm test", exit: 0 }],
      forcedBySeat: true,
      cwd: project,
    },
    contextFor(session, join(FAKE_HOME, "sessions-root")),
  );

  const entry = row(project, "unit-forced");
  assert.equal(entry.closedAt !== null, true, toolText(closed));
  assert.equal(entry.closedBy.kind, "worker", "the observed kind is not laundered");
  assert.equal(entry.closedBy.forced, true, "the override is on the record");
});

test("a closed row refuses a status patch and a checkpoint patch", async () => {
  const project = freshProject();
  await register(project, "unit-sealed");
  await runTool({
    action: "close-worker",
    workerId: "unit-sealed",
    outcome: "closed",
    cwd: project,
  });
  const closedAt = row(project, "unit-sealed").closedAt;

  await assert.rejects(
    () =>
      runTool({
        action: "update-worker",
        workerId: "unit-sealed",
        status: "completed",
        cwd: project,
      }),
    /closed row's status is terminal/,
  );
  await assert.rejects(
    () =>
      runTool({
        action: "update-worker",
        workerId: "unit-sealed",
        phase: "delivered",
        lastStep: "verified",
        cwd: project,
      }),
    /closed row carries no resume point/,
  );

  const entry = row(project, "unit-sealed");
  assert.equal(entry.status, "closed", "the terminal outcome stands");
  assert.equal(entry.closedAt, closedAt, "nothing moved the close");
  assert.equal(entry.checkpoint, null, "no resume point was written");
});

test("a completed row with no gate evidence reads closed-unverified", async () => {
  const project = freshProject();
  await register(project, "unit-gateless");
  await runTool({
    action: "close-worker",
    workerId: "unit-gateless",
    outcome: "closed",
    cwd: project,
  });
  // The shape a status patch used to produce: completed, no gates, no closer.
  patchRowFile(project, "unit-gateless", (entry) => {
    entry.status = "completed";
    delete entry.closedBy;
  });

  const verdict = await runTool({ action: "check-worker", workerId: "unit-gateless", cwd: project });
  assert.equal(verdict.details.status, "closed-unverified", toolText(verdict));
  assert.match(verdict.details.reason, /no gate evidence/);
});

test("a legacy row closed by its own worker session reads closed-unverified", async () => {
  const project = freshProject();
  await register(project, "unit-legacy");
  const root = join(FAKE_HOME, "legacy-sessions-worker");
  const spawnedAt = row(project, "unit-legacy").spawnedAt;
  const session = writeSessionFile(root, "--fixture-project--", spawnedAt, [
    orchestrateLine(spawnedAt, "update-worker", "unit-legacy"),
    orchestrateLine(spawnedAt, "close-worker", "unit-legacy"),
  ]);
  await runTool({ action: "update-worker", workerId: "unit-legacy", workerSession: session, cwd: project });
  await runTool({
    action: "close-worker",
    workerId: "unit-legacy",
    outcome: "completed",
    gates: [{ cmd: "npm test", exit: 0 }],
    cwd: project,
  });
  // A row closed before the stamp existed: no closedBy, its worker session on record.
  patchRowFile(project, "unit-legacy", (entry) => {
    delete entry.closedBy;
  });

  const verdict = await runTool({
    action: "check-worker",
    workerId: "unit-legacy",
    cwd: project,
  }, contextFor(session, root));
  assert.equal(verdict.details.status, "closed-unverified", toolText(verdict));
  assert.equal(verdict.details.closer.kind, "worker", "read from the closing session");
  assert.match(verdict.details.reason, /recorded closer is the worker/);
});

test("a legacy row closed by the session that admitted it reads closed", async () => {
  const project = freshProject();
  await register(project, "unit-legacy-seat");
  const root = join(FAKE_HOME, "legacy-sessions-seat");
  const spawnedAt = row(project, "unit-legacy-seat").spawnedAt;
  const startedBefore = new Date(Date.parse(spawnedAt) - 3_600_000).toISOString();
  const seat = writeSessionFile(root, "--fixture-seat--", startedBefore, [
    orchestrateLine(spawnedAt, "spawn-worker", "unit-legacy-seat"),
    orchestrateLine(spawnedAt, "close-worker", "unit-legacy-seat"),
  ]);
  await runTool({
    action: "close-worker",
    workerId: "unit-legacy-seat",
    outcome: "completed",
    gates: [{ cmd: "npm test", exit: 0 }],
    cwd: project,
  });
  patchRowFile(project, "unit-legacy-seat", (entry) => {
    delete entry.closedBy;
  });

  const verdict = await runTool(
    { action: "check-worker", workerId: "unit-legacy-seat", cwd: project },
    contextFor(seat, root),
  );
  assert.equal(verdict.details.status, "closed", toolText(verdict));
  assert.equal(verdict.details.closer.kind, "seat");
});

test("a coarse mtime does not hide the session that closed a legacy row", async () => {
  const project = freshProject();
  await register(project, "unit-legacy-coarse");
  const root = join(FAKE_HOME, "legacy-sessions-coarse");
  const spawnedAt = row(project, "unit-legacy-coarse").spawnedAt;
  const startedBefore = new Date(Date.parse(spawnedAt) - 3_600_000).toISOString();
  const seat = writeSessionFile(root, "--fixture-seat--", startedBefore, [
    orchestrateLine(spawnedAt, "close-worker", "unit-legacy-coarse"),
  ]);
  // A filesystem that records whole seconds puts the write below the spawn when
  // the two happen inside one second, which is the ordinary case for a fixture
  // and for a real close too. The closer must survive that.
  const coarse = coarsenMtime(seat);
  assert.ok(coarse <= Date.parse(spawnedAt), "the fixture must actually coarsen the mtime");
  await runTool({
    action: "close-worker",
    workerId: "unit-legacy-coarse",
    outcome: "completed",
    gates: [{ cmd: "npm test", exit: 0 }],
    cwd: project,
  });
  patchRowFile(project, "unit-legacy-coarse", (entry) => {
    delete entry.closedBy;
  });

  const verdict = await runTool(
    { action: "check-worker", workerId: "unit-legacy-coarse", cwd: project },
    contextFor(seat, root),
  );
  assert.equal(verdict.details.status, "closed", toolText(verdict));
  assert.equal(verdict.details.closer?.kind, "unknown", toolText(verdict));
});

test("a session file written long before the spawn is still skipped", async () => {
  const project = freshProject();
  await register(project, "unit-legacy-stale");
  const root = join(FAKE_HOME, "legacy-sessions-stale");
  const spawnedAt = row(project, "unit-legacy-stale").spawnedAt;
  const startedBefore = new Date(Date.parse(spawnedAt) - 3_600_000).toISOString();
  const seat = writeSessionFile(root, "--fixture-seat--", startedBefore, [
    orchestrateLine(spawnedAt, "close-worker", "unit-legacy-stale"),
  ]);
  // Ten minutes before the spawn is outside the skew the rule allows: a file
  // that stopped being written that long before the row existed did not close it.
  const staleSeconds = (Date.parse(spawnedAt) - 600_000) / 1000;
  utimesSync(seat, staleSeconds, staleSeconds);
  await runTool({
    action: "close-worker",
    workerId: "unit-legacy-stale",
    outcome: "completed",
    gates: [{ cmd: "npm test", exit: 0 }],
    cwd: project,
  });
  patchRowFile(project, "unit-legacy-stale", (entry) => {
    delete entry.closedBy;
  });

  const verdict = await runTool(
    { action: "check-worker", workerId: "unit-legacy-stale", cwd: project },
    contextFor(seat, root),
  );
  assert.equal(verdict.details.closer, null, toolText(verdict));
});

test("list-workers prints the closer next to the status", async () => {
  const project = freshProject();
  await register(project, "unit-listed");
  const session = workerSessionPath("worker-listed");
  await runTool({ action: "update-worker", workerId: "unit-listed", workerSession: session, cwd: project });
  const seat = workerSessionPath("seat-listed");
  await runTool(
    {
      action: "close-worker",
      workerId: "unit-listed",
      outcome: "completed",
      gates: [{ cmd: "npm test", exit: 0 }],
      cwd: project,
    },
    contextFor(seat, join(FAKE_HOME, "sessions-root")),
  );

  const listing = await runTool({ action: "list-workers", cwd: project, includeClosed: true });
  assert.match(toolText(listing), /status=completed\s{2}closer=seat session=.*seat-listed/);
});
