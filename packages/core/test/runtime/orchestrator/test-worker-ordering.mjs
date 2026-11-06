/**
 * Test: queue order and dependency gating in the worker registry.
 *
 * Pins what makes a listing answer "which worker may run next":
 *
 * 1. Admission refuses a dependency edge it cannot honour: an id that is not in
 *    the registry, the row's own id, and an edge that closes a loop of length
 *    two or three. Each refusal carries a machine-readable reason and the
 *    offending id, and writes nothing — the row stands as it was.
 * 2. Satisfaction is `merged` or `completed` and nothing else. A dependency
 *    closed with outcome `closed` or `error` delivered nothing, so its
 *    dependents stay blocked; a completed one releases them.
 * 3. `check-worker` reports `blocked` for a row with an unsatisfied dependency,
 *    names the blocking ids, and keeps the row's stored status beside the
 *    verdict. `blocked` is never written: the stored vocabulary does not gain
 *    it, and the row on disk keeps its own status.
 * 4. `list-workers` prints in actionable order: ready rows before blocked ones,
 *    ranked before unranked, lower priority first. A blocked row carries
 *    `blocked-by: <ids>`; an unranked, wait-free row keeps the line shape it
 *    had before the queue facts existed.
 * 5. Satisfaction is read against every row, so a closed dependency satisfies
 *    its dependents even while an `includeClosed=false` listing hides it: the
 *    blocked row names it rather than the ready row turning blocked.
 * 6. A registry written before these fields existed loads, lists and closes:
 *    the read path fills the two fields in memory and writes nothing back.
 * 7. `update-worker` moves a priority and refuses to move a dependency.
 *
 * Hermetic: HOME and PI_CODING_AGENT_DIR are pinned into a scratch root BEFORE
 * the dist imports and BRAID_HOME is cleared, so every registry read and write
 * lands in the scratch tree; the live ~/.pi/agent is neither read nor written.
 *
 * Run: node --test test/runtime/orchestrator/test-worker-ordering.mjs
 * (after npm run build)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "worker-ordering-"));
process.env.HOME = FAKE_HOME;
process.env.PI_CODING_AGENT_DIR = join(FAKE_HOME, ".pi", "agent");
delete process.env.BRAID_HOME;

const {
  WORKER_STATUSES,
  WORKER_VERDICT_STATUSES,
  WORKER_SATISFYING_STATUSES,
  checkWorker,
  closeWorker,
  normalizeDependsOn,
  orderWorkerRows,
  readWorkers,
  registerWorker,
  unsatisfiedDependencies,
  validateDependencies,
  writeWorkers,
} = await import("../../../dist/lib/orchestrator/workers.js");
const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);

// A fixed epoch, expressed as a number so no date literal sits in the source.
const T0 = Date.UTC(2026, 0, 1);
const iso = (ms) => new Date(ms).toISOString();

// ── fixtures ────────────────────────────────────────────────────────────────

/** A scratch project directory; no git is needed by these paths. */
function project() {
  return mkdtempSync(join(FAKE_HOME, "project-"));
}

/** A git repo, for the one case that proves a refused spawn creates no branch. */
function gitProject() {
  const repo = project();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  writeFileSync(join(repo, "base.txt"), "base\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo });
  return repo;
}

/** Admit a row and assert it landed; a refused fixture setup must fail loudly. */
function admit(cwd, workerId, extra = {}) {
  const result = registerWorker({ workerId, spec: "impl", cwd, ...extra });
  assert.equal(result.ok, true, `fixture admission of ${workerId} failed: ${result.reason}`);
  return result.entry;
}

/** Close a row and assert the close wrote; returns the closed entry. */
function closeRow(cwd, workerId, outcome, gates = undefined) {
  const closed = closeWorker(workerId, outcome, gates, cwd);
  assert.ok(closed, `fixture close of ${workerId} found no row`);
  assert.equal(closed.status, outcome, `fixture close of ${workerId} did not land`);
  return closed;
}

/** A complete-enough stored row, in the shape written before the queue facts. */
function legacyRow(workerId, cwd, overrides = {}) {
  return {
    workerId,
    spec: "impl",
    status: "working",
    cwd,
    pane: null,
    workspace: null,
    workerSession: null,
    outputFile: null,
    branch: null,
    files: [],
    spawnedAt: iso(T0),
    lastSeenAt: iso(T0),
    resultAt: null,
    mergeSha: null,
    mergedAt: null,
    closedAt: null,
    gates: [],
    admissionRefusals: [],
    requestId: `${workerId}:1`,
    checkpoint: null,
    ...overrides,
  };
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
assert.ok(orchestrateTool, "the extension must register the orchestrate tool");
const runTool = (params) =>
  orchestrateTool.execute("call-1", params, new AbortController().signal, undefined, undefined);
const toolText = (result) => result.content[0].text;

/**
 * The listed rows in printed order, each with the ids its `blocked-by:` line
 * names. The marker is a continuation line, so it attaches to the row above it,
 * never to a row of its own.
 */
function listedRows(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const row = line.match(/^ {2}(\S+) {2}spec=/);
    if (row) {
      rows.push({ workerId: row[1], blockedBy: [] });
      continue;
    }
    const blocked = line.match(/^ {4}blocked-by: (.+)$/);
    if (blocked && rows.length > 0) {
      rows[rows.length - 1].blockedBy = blocked[1].split(/\s*,\s*/);
    }
  }
  return rows;
}

const orderOf = (text) => listedRows(text).map((row) => row.workerId);

// ── 1. the refused edges ────────────────────────────────────────────────────

describe("admission refuses a dependency it cannot honour", () => {
  it("refuses an id that is not in the registry", () => {
    const cwd = project();
    admit(cwd, "known");

    const refused = registerWorker({
      workerId: "unknown-dep",
      spec: "impl",
      cwd,
      dependsOn: ["ghost"],
    });
    assert.equal(refused.ok, false, "an unknown dependency must refuse the admission");
    assert.equal(refused.refusedBy, "unknown-dependency", "the reason must be machine-readable");
    assert.equal(refused.offendingId, "ghost", "the refusal must name the id it turned away");
    assert.match(refused.reason, /ghost/, "the sentence must name the id too");
    assert.equal(
      readWorkers(cwd).workers["unknown-dep"],
      undefined,
      "a refused admission writes no row",
    );

    // The live row the fixture admitted is untouched by the refused edge.
    assert.deepEqual(readWorkers(cwd).workers.known.dependsOn, [], "the fixture row is unchanged");
  });

  it("refuses a row that names itself, before answering unknown-dependency", () => {
    const cwd = project();

    const refused = registerWorker({ workerId: "self", spec: "impl", cwd, dependsOn: ["self"] });
    assert.equal(refused.ok, false);
    assert.equal(refused.refusedBy, "self-dependency", "a self-edge is its own refusal");
    assert.equal(refused.offendingId, "self");
    assert.equal(readWorkers(cwd).workers.self, undefined, "a refused admission writes no row");
  });

  it("refuses a two-row loop, naming the path", () => {
    const cwd = project();
    admit(cwd, "loop-a");
    closeRow(cwd, "loop-a", "closed");
    admit(cwd, "loop-b", { dependsOn: ["loop-a"] });

    // loop-a is closed, so it rolls over; the new edges would close the loop.
    const refused = registerWorker({
      workerId: "loop-a",
      spec: "impl",
      cwd,
      dependsOn: ["loop-b"],
    });
    assert.equal(refused.ok, false, "an edge closing a loop must refuse the admission");
    assert.equal(refused.refusedBy, "dependency-cycle");
    assert.equal(refused.offendingId, "loop-b");
    assert.match(refused.reason, /loop-a -> loop-b -> loop-a/, "the refusal must name the path");
    assert.equal(
      readWorkers(cwd).workers["loop-a"].dependsOn.length,
      0,
      "the rolled-over row must keep the edges it had: none were written",
    );
    assert.ok(readWorkers(cwd).workers["loop-a"].closedAt, "the closed row is not reopened either");
  });

  it("refuses a three-row loop, naming the path", () => {
    const cwd = project();
    admit(cwd, "chain-a");
    admit(cwd, "chain-b", { dependsOn: ["chain-a"] });
    admit(cwd, "chain-c", { dependsOn: ["chain-b"] });
    closeRow(cwd, "chain-a", "closed");

    const refused = registerWorker({
      workerId: "chain-a",
      spec: "impl",
      cwd,
      dependsOn: ["chain-c"],
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.refusedBy, "dependency-cycle");
    assert.equal(refused.offendingId, "chain-c");
    assert.match(
      refused.reason,
      /chain-a -> chain-c -> chain-b -> chain-a/,
      "the refusal must walk the whole loop",
    );
    assert.equal(readWorkers(cwd).workers["chain-a"].closedAt != null, true, "nothing was written");
  });

  it("refuses a spawn before a branch exists, and the tool reports it", async () => {
    const repo = gitProject();
    const refused = await runTool({
      action: "spawn-worker",
      workerId: "spawn-u",
      slug: "spawn-fixture",
      spec: "impl",
      outputFile: join(repo, "report.md"),
      files: [join(repo, "work.txt")],
      cwd: repo,
      dependsOn: ["ghost"],
    }).then(
      () => null,
      (error) => error,
    );
    assert.ok(refused, "spawn-worker must refuse an unknown dependency");
    assert.match(refused.message, /unknown-dependency/, "the refusal carries its reason token");
    assert.match(refused.message, /ghost/, "and the id it names");
    assert.equal(readWorkers(repo).workers["spawn-u"], undefined, "no row was admitted");
    const branches = execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf8" });
    assert.doesNotMatch(branches, /spawn-u/, "a refused spawn leaves no branch behind");
  });

  it("reports the same reason and id through register-worker's JSON", async () => {
    const cwd = project();
    admit(cwd, "tool-known");
    const parsed = JSON.parse(
      toolText(
        await runTool({
          action: "register-worker",
          workerId: "tool-unknown",
          spec: "impl",
          cwd,
          dependsOn: ["ghost"],
        }),
      ),
    );
    assert.equal(parsed.ok, false);
    assert.equal(parsed.refusedBy, "unknown-dependency");
    assert.equal(parsed.offendingId, "ghost");
  });
});

// ── 2. satisfaction ─────────────────────────────────────────────────────────

describe("satisfaction is merged or completed and nothing else", () => {
  it("declares exactly the two satisfying statuses", () => {
    assert.deepEqual([...WORKER_SATISFYING_STATUSES], ["merged", "completed"]);
  });

  it("releases a dependent on completed and holds it through closed or error", () => {
    const cwd = project();

    // completed releases
    admit(cwd, "done-dep");
    admit(cwd, "waits-on-done", { dependsOn: ["done-dep"] });
    assert.deepEqual(unsatisfiedDependencies(readWorkers(cwd).workers["waits-on-done"], readWorkers(cwd)), [
      "done-dep",
    ]);
    closeRow(cwd, "done-dep", "completed", [{ cmd: "true", exit: 0 }]);
    assert.deepEqual(
      unsatisfiedDependencies(readWorkers(cwd).workers["waits-on-done"], readWorkers(cwd)),
      [],
      "a completed dependency releases its dependents",
    );

    // closed without delivering does not
    admit(cwd, "closed-dep");
    admit(cwd, "waits-on-closed", { dependsOn: ["closed-dep"] });
    closeRow(cwd, "closed-dep", "closed");
    assert.deepEqual(
      unsatisfiedDependencies(readWorkers(cwd).workers["waits-on-closed"], readWorkers(cwd)),
      ["closed-dep"],
      "a closed dependency delivered nothing",
    );

    // error does not
    admit(cwd, "error-dep");
    admit(cwd, "waits-on-error", { dependsOn: ["error-dep"] });
    closeRow(cwd, "error-dep", "error");
    assert.deepEqual(
      unsatisfiedDependencies(readWorkers(cwd).workers["waits-on-error"], readWorkers(cwd)),
      ["error-dep"],
      "a failed dependency delivered nothing",
    );
  });
});

// ── 3. the blocked verdict ──────────────────────────────────────────────────

describe("check-worker reports blocked without writing it", () => {
  it("names the blocking ids and keeps the stored status beside the verdict", async () => {
    const cwd = project();
    admit(cwd, "blocker");
    closeRow(cwd, "blocker", "error");
    admit(cwd, "waiting", { dependsOn: ["blocker"] });

    const verdict = checkWorker("waiting", { cwd });
    assert.equal(verdict.status, "blocked", "an unsatisfied dependency is not an actionable row");
    assert.deepEqual(verdict.blockedBy, ["blocker"]);
    assert.equal(verdict.storedStatus, "admitted", "the row's own status travels beside the verdict");
    assert.match(verdict.reason, /blocker \(status error\)/, "the reason names the id and its status");
    assert.match(verdict.reason, /stored status admitted/, "and the status it did not overwrite");

    // The verdict is computed: the registry row keeps the status it was given,
    // and the stored vocabulary does not gain the word.
    assert.equal(readWorkers(cwd).workers.waiting.status, "admitted");
    assert.equal(WORKER_STATUSES.includes("blocked"), false, "blocked is never a stored status");
    assert.equal(WORKER_VERDICT_STATUSES.includes("blocked"), true, "it is a verdict");

    // The rendered block carries both facts on their own lines.
    const result = await runTool({ action: "check-worker", workerId: "waiting", cwd });
    const text = toolText(result);
    assert.match(text, /^status: blocked$/m, text);
    assert.match(text, /^storedStatus: admitted$/m, text);
    assert.match(text, /^blockedBy: blocker$/m, text);
    assert.equal(result.details.blockedBy.length, 1);
  });

  it("reports ready rows as before: no blocked ids, no blocked verdict", () => {
    const cwd = project();
    admit(cwd, "solo");
    const verdict = checkWorker("solo", { cwd });
    assert.equal(verdict.status, "admitted");
    assert.deepEqual(verdict.blockedBy, []);
    assert.equal(verdict.storedStatus, "admitted");
  });
});

// ── 4. the listing order ────────────────────────────────────────────────────

describe("list-workers prints in actionable order", () => {
  it("ranks ready rows by priority, unranked last, and sinks the blocked row", async () => {
    const cwd = project();
    // Rows are admitted in an order that no plausible sort would reproduce:
    // insertion order is 30, 10, unranked, and the 10 is the blocked one.
    admit(cwd, "rank-30", { priority: 30 });
    admit(cwd, "rank-10", { priority: 10, dependsOn: ["rank-30"] });
    admit(cwd, "rank-none");
    // spawnedAt orders the tie-free fallback; pin the fixture's own values so a
    // null-priority row can never win by accident.
    for (const [workerId, ms] of [
      ["rank-30", T0],
      ["rank-10", T0 + 1000],
      ["rank-none", T0 + 2000],
    ]) {
      const registry = readWorkers(cwd);
      registry.workers[workerId].spawnedAt = iso(ms);
      writeWorkers(registry, cwd);
    }

    const before = toolText(await runTool({ action: "list-workers", cwd, includeClosed: true }));
    assert.deepEqual(
      orderOf(before),
      ["rank-30", "rank-none", "rank-10"],
      `ready rows first by priority with unranked last, then the blocked row:\n${before}`,
    );
    const blockedRow = listedRows(before).find((row) => row.workerId === "rank-10");
    assert.deepEqual(blockedRow.blockedBy, ["rank-30"], "the blocked row names what holds it");
    assert.equal(
      listedRows(before).find((row) => row.workerId === "rank-none").blockedBy.length,
      0,
      "an unranked, wait-free row carries no marker",
    );
    assert.match(before, /rank-30 {2}spec=impl {2}status=admitted[^\n]*priority=30/, before);
    assert.match(before, /rank-10 {2}spec=impl {2}status=admitted[^\n]*priority=10/, before);
    const unrankedLine = before.match(/^ {2}rank-none {2}[^\n]*$/m)[0];
    assert.doesNotMatch(unrankedLine, /priority=/, "an unranked row prints no priority field");

    // The dependency lands: the blocked row joins the ready group and the
    // ranking decides again — 10 before 30, unranked last.
    closeWorker("rank-30", "completed", [{ cmd: "true", exit: 0 }], cwd);
    const after = toolText(await runTool({ action: "list-workers", cwd, includeClosed: true }));
    assert.deepEqual(
      orderOf(after),
      ["rank-10", "rank-30", "rank-none"],
      `with the dependency delivered, priority decides the whole group:\n${after}`,
    );
    assert.equal(
      listedRows(after).filter((row) => row.blockedBy.length > 0).length,
      0,
      "no row is blocked once the dependency is delivered",
    );
  });

  it("reads satisfaction before hiding closed rows", async () => {
    const cwd = project();
    admit(cwd, "ready-row", { priority: 10 });
    admit(cwd, "closed-row");
    closeRow(cwd, "closed-row", "error");
    admit(cwd, "blocked-row", { dependsOn: ["closed-row"], priority: 1 });

    const live = toolText(await runTool({ action: "list-workers", cwd }));
    assert.deepEqual(
      orderOf(live),
      ["ready-row", "blocked-row"],
      `the closed dependency is hidden, its dependent still names it:\n${live}`,
    );
    assert.deepEqual(
      listedRows(live).find((row) => row.workerId === "blocked-row").blockedBy,
      ["closed-row"],
      "a hidden row still holds the listing's blocked marker",
    );

    const withClosed = toolText(await runTool({ action: "list-workers", cwd, includeClosed: true }));
    assert.deepEqual(
      orderOf(withClosed),
      ["ready-row", "closed-row", "blocked-row"],
      `the closed row ranks as ready (it waits for nothing) and prints above the blocked one:\n${withClosed}`,
    );
  });

  it("orders the pure read the same way, blocked rows carrying their ids", () => {
    const cwd = project();
    admit(cwd, "pure-a", { priority: 2 });
    admit(cwd, "pure-b", { dependsOn: ["pure-a"], priority: 1 });
    const registry = readWorkers(cwd);
    const ordered = orderWorkerRows(Object.values(registry.workers), registry);
    assert.deepEqual(
      ordered.ready.map((row) => row.entry.workerId),
      ["pure-a"],
    );
    assert.deepEqual(
      ordered.blocked.map((row) => [row.entry.workerId, row.blockedBy]),
      [["pure-b", ["pure-a"]]],
    );
  });
});

// ── 5. a registry written before the fields existed ─────────────────────────

describe("a registry written before the queue facts loads", () => {
  it("fills the two fields in memory, lists the row unchanged, and closes it", async () => {
    const cwd = project();
    writeWorkers({ version: 1, workers: { legacy: legacyRow("legacy", cwd) } }, cwd);

    const loaded = readWorkers(cwd).workers.legacy;
    assert.equal(loaded.priority, null, "an absent priority reads as unranked");
    assert.deepEqual(loaded.dependsOn, [], "an absent dependsOn waits for nothing");
    assert.equal(
      unsatisfiedDependencies(loaded, readWorkers(cwd)).length,
      0,
      "a legacy row is not blocked by a field it never had",
    );

    const listed = toolText(await runTool({ action: "list-workers", cwd }));
    assert.match(listed, /^ {2}legacy {2}spec=impl {2}status=working/m, listed);
    const legacyLine = listed.match(/^ {2}legacy {2}[^\n]*$/m)[0];
    assert.doesNotMatch(
      legacyLine,
      /priority=|depends-on=/,
      "the printed line keeps the shape it had before the fields existed",
    );

    const closed = closeWorker("legacy", "closed", undefined, cwd);
    assert.equal(closed.status, "closed");
    assert.ok(closed.closedAt, "the close lands");
    assert.equal(checkWorker("legacy", { cwd }).status, "closed", "and the verdict reads it");
  });
});

// ── 6. update-worker moves a priority, not a dependency ─────────────────────

describe("update-worker", () => {
  it("moves a priority and refuses to move a dependency", async () => {
    const cwd = project();
    admit(cwd, "mover", { dependsOn: [] });

    const updated = await runTool({ action: "update-worker", workerId: "mover", priority: 7, cwd });
    assert.equal(updated.details.entry.priority, 7, "the priority is written");
    assert.match(toolText(updated), /"priority": 7/);

    const refused = await runTool({
      action: "update-worker",
      workerId: "mover",
      dependsOn: ["late-dep"],
      cwd,
    }).then(
      () => null,
      (error) => error,
    );
    assert.ok(refused, "update-worker must refuse a dependency change");
    assert.match(refused.message, /fixed at admission/, refused.message);
    assert.deepEqual(readWorkers(cwd).workers.mover.dependsOn, [], "and write nothing");
  });
});

// ── 7. the validator's own edges ────────────────────────────────────────────

describe("dependency helpers", () => {
  it("normalizes ids, drops blanks and duplicates, and keeps declared order", () => {
    assert.deepEqual(normalizeDependsOn([" a ", "b", "a", "", 7, null]), ["a", "b"]);
    assert.deepEqual(normalizeDependsOn(undefined), []);
    assert.deepEqual(normalizeDependsOn("a"), [], "a scalar is not a dependency list");
  });

  it("validates against the registry it is given, not a global", () => {
    const cwd = project();
    admit(cwd, "v-a");
    const registry = readWorkers(cwd);
    assert.equal(validateDependencies("v-b", ["v-a"], registry), null, "a known id is admitted");
    assert.equal(validateDependencies("v-b", ["nope"], registry).reason, "unknown-dependency");
    assert.deepEqual(validateDependencies("v-b", ["nope"], registry).path, []);
  });
});
