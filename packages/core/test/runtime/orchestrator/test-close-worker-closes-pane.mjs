/**
 * A closed worker does not leave its pane standing.
 *
 * The registry knows two facts around a worker's life: the pane it was started
 * in, and the close that ended the row. Nothing closes the pane between them:
 * an interactive agent stays at its prompt when its turn ends, `herdr agent`
 * has no stop, and the renderer closes a pane only for a `pane` command. So the
 * pane outlived its worker 158 times in one measured corpus, 14 of them in a
 * single workspace where the seat closed the rows and left the panes.
 *
 * What this pins, one leg per way the act could be wrong:
 *   1. a row naming an idle pane closes exactly that pane, once;
 *   2. a row with no pane id asks herdr nothing and says so in the report;
 *   3. a herdr that refuses the close leaves the close standing, with a reason;
 *   4. a pane whose agent is working is left alone;
 *   5. the caller's own pane is left alone;
 *   6. a pane that is already gone reads as cleared, not as a failure;
 *   7. a pane holding a different agent session is foreign and is refused;
 *   8. a pane the caller passes for a row that records none is written onto the
 *      row and then closed;
 *   9. an argument that contradicts the row's own handle closes nothing;
 *  10. outside a herdr session the step is skipped without invoking anything.
 *
 * The control for this file is planted, not asserted: with the pane step made a
 * no-op, leg 1 fails naming the surviving pane. It was run that way and the
 * failure is quoted in the report.
 *
 * Hermetic: HOME and PI_CODING_AGENT_DIR are pinned into a scratch root and
 * BRAID_HOME is cleared before the dist imports. The herdr binary is a script
 * written into the scratch tree and reached through HERDR_BIN_PATH, so the live
 * herdr is never invoked and the argv it received is the record.
 *
 * Run: node packages/core/test/runtime/orchestrator/test-close-worker-closes-pane.mjs
 * (after npm run build)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "pane-close-"));
process.env.HOME = FAKE_HOME;
process.env.PI_CODING_AGENT_DIR = join(FAKE_HOME, ".pi", "agent");
delete process.env.BRAID_HOME;

// The fake herdr. It answers `pane get` from a state file, applies `pane close`
// to that file, and appends every argv it received to a log, which is the only
// witness this test needs for what the tool asked for.
const BIN_DIR = mkdtempSync(join(tmpdir(), "pane-close-bin-"));
const FAKE_HERDR = join(BIN_DIR, "herdr");
const STATE_FILE = join(BIN_DIR, "state.json");
const ARGV_LOG = join(BIN_DIR, "argv.log");

writeFileSync(
  FAKE_HERDR,
  `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_HERDR_ARGV, argv.join(" ") + "\\n");
const state = JSON.parse(fs.readFileSync(process.env.FAKE_HERDR_STATE, "utf-8"));
const [group, verb, pane] = argv;
const reply = (payload, code) => {
  console.log(JSON.stringify(payload));
  process.exit(code);
};
if (group !== "pane") reply({ error: { code: "bad_command", message: argv.join(" ") } }, 2);
const record = state.panes[pane];
const missing = () =>
  reply({ error: { code: "pane_not_found", message: "pane " + pane + " not found" } }, verb === "close" ? 1 : 0);
if (verb === "get") {
  if (!record) missing();
  reply(
    {
      id: "cli:pane:get",
      result: {
        type: "pane_info",
        pane: {
          pane_id: pane,
          agent: record.agent === undefined ? "pi" : record.agent,
          agent_status: record.status,
          agent_session: record.session ? { kind: "path", source: "herdr:pi", value: record.session } : null,
        },
      },
    },
    0,
  );
}
if (verb === "close") {
  if (state.failClose) reply({ error: { code: "internal", message: "close refused by herdr" } }, 1);
  if (!record) missing();
  delete state.panes[pane];
  fs.writeFileSync(process.env.FAKE_HERDR_STATE, JSON.stringify(state));
  reply({ id: "cli:pane:close", result: { type: "pane_close", pane_id: pane } }, 0);
}
reply({ error: { code: "bad_command", message: argv.join(" ") } }, 2);
`,
);
chmodSync(FAKE_HERDR, 0o755);

process.env.HERDR_ENV = "1";
process.env.HERDR_BIN_PATH = FAKE_HERDR;
process.env.HERDR_PANE_ID = "wC5:own";
process.env.FAKE_HERDR_STATE = STATE_FILE;
process.env.FAKE_HERDR_ARGV = ARGV_LOG;

const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);
const { readWorkers } = await import("../../../dist/lib/orchestrator/workers.js");

const fakePi = {
  tools: [],
  registerTool(definition) {
    this.tools.push(definition);
  },
  on() {},
};
orchestratorExtension(fakePi);
const orchestrateTool = fakePi.tools.find((tool) => tool.name === "orchestrate");
const run = (params) =>
  orchestrateTool.execute("call-1", params, new AbortController().signal, undefined, undefined);

/** Rewrite the fake herdr's world: one state file, and a fresh argv log. */
function setPanes(panes, { failClose = false } = {}) {
  writeFileSync(STATE_FILE, JSON.stringify({ panes, failClose }));
  writeFileSync(ARGV_LOG, "");
}

/** Every herdr call the tool made, in order. */
const herdrCalls = () =>
  existsSync(ARGV_LOG)
    ? readFileSync(ARGV_LOG, "utf-8")
        .split("\n")
        .filter((line) => line.length > 0)
    : [];

const closeCalls = (pane) => herdrCalls().filter((line) => line === `pane close ${pane}`);
const anyCloseCalls = () => herdrCalls().filter((line) => line.startsWith("pane close "));

const scratchProject = () => mkdtempSync(join(tmpdir(), "pane-close-project-"));

/** Admit a row, optionally carrying a pane handle and a session path. */
async function admit(repo, workerId, { pane, workerSession } = {}) {
  await run({
    action: "register-worker",
    workerId,
    spec: "impl",
    cwd: repo,
    outputFile: join(repo, "report.md"),
    ...(pane === undefined ? {} : { pane }),
    ...(workerSession === undefined ? {} : { workerSession }),
  });
}

describe("close-worker ends the pane it records", () => {
  it("closes the idle pane the row names, once", async () => {
    const repo = scratchProject();
    setPanes({ "wC5:p1": { status: "idle", session: join(repo, "w1.jsonl") } });
    await admit(repo, "w-with-pane", { pane: "wC5:p1" });

    const result = await run({ action: "close-worker", workerId: "w-with-pane", outcome: "closed" });

    assert.deepEqual(
      closeCalls("wC5:p1"),
      ["pane close wC5:p1"],
      "exactly one close of the pane wC5:p1, which otherwise survives the worker",
    );
    assert.match(result.content[0].text, /Pane: pane wC5:p1 closed\./);
    assert.equal(result.details.pane.result, "closed");
    assert.equal(result.details.pane.cleared, true);
  });

  it("asks herdr nothing for a row with no pane id, and says so", async () => {
    const repo = scratchProject();
    setPanes({ "wC5:p2": { status: "idle" } });
    await admit(repo, "w-no-pane");

    const result = await run({ action: "close-worker", workerId: "w-no-pane", outcome: "closed" });

    assert.deepEqual(herdrCalls(), [], "nothing was invoked: the handle is never invented");
    assert.match(result.content[0].text, /Pane: no pane recorded on the row and none given/);
    assert.equal(result.details.pane.result, "skipped");
  });

  it("leaves the registry close standing when herdr refuses to close", async () => {
    const repo = scratchProject();
    setPanes({ "wC5:p3": { status: "idle" } }, { failClose: true });
    await admit(repo, "w-refused", { pane: "wC5:p3" });

    const result = await run({ action: "close-worker", workerId: "w-refused", outcome: "closed" });

    assert.equal(result.details.pane.result, "unavailable", "the failure is reported, not thrown");
    assert.match(result.content[0].text, /herdr could not close pane wC5:p3: close refused by herdr/);
    assert.equal(
      readWorkers(repo).workers["w-refused"].closedAt !== null,
      true,
      "a herdr failure does not undo the registry close",
    );
  });

  it("leaves a pane whose agent is working alone", async () => {
    const repo = scratchProject();
    setPanes({ "wC5:p4": { status: "working" } });
    await admit(repo, "w-mis-closed", { pane: "wC5:p4" });

    const result = await run({ action: "close-worker", workerId: "w-mis-closed", outcome: "closed" });

    assert.deepEqual(anyCloseCalls(), [], "a live run is not killed behind a closed row");
    assert.match(result.content[0].text, /reports its agent working/);
    assert.equal(result.details.pane.result, "skipped");
  });

  it("leaves this process's own pane alone", async () => {
    const repo = scratchProject();
    setPanes({ "wC5:own": { status: "idle" } });
    await admit(repo, "w-own-pane", { pane: "wC5:own" });

    const result = await run({ action: "close-worker", workerId: "w-own-pane", outcome: "closed" });

    assert.deepEqual(herdrCalls(), [], "a process cannot close the pane it runs in");
    assert.match(result.content[0].text, /is this process's own pane/);
    assert.equal(result.details.pane.result, "skipped");
  });

  it("treats an already-gone pane as cleared", async () => {
    const repo = scratchProject();
    setPanes({});
    await admit(repo, "w-gone-pane", { pane: "wC5:p6" });

    const result = await run({ action: "close-worker", workerId: "w-gone-pane", outcome: "closed" });

    assert.deepEqual(anyCloseCalls(), [], "the read already answered: nothing to close");
    assert.match(result.content[0].text, /pane wC5:p6 was already gone/);
    assert.equal(result.details.pane.result, "already-gone");
    assert.equal(result.details.pane.cleared, true, "a gone pane is the outcome, not a failure");
  });

  it("refuses a pane that holds a different agent session", async () => {
    const repo = scratchProject();
    const foreign = join(repo, "someone-else.jsonl");
    setPanes({ "wC5:p7": { status: "idle", session: foreign } });
    await admit(repo, "w-foreign", {
      pane: "wC5:p7",
      workerSession: join(repo, "the-worker.jsonl"),
    });

    const result = await run({ action: "close-worker", workerId: "w-foreign", outcome: "closed" });

    assert.deepEqual(anyCloseCalls(), [], "a foreign pane is not closed");
    assert.match(result.content[0].text, /holds a different agent session/);
    assert.equal(result.details.pane.result, "refused");
  });

  it("records a pane the caller passes for a row that carries none, then closes it", async () => {
    const repo = scratchProject();
    setPanes({ "wC5:p8": { status: "idle" } });
    await admit(repo, "w-handle-given");

    const result = await run({
      action: "close-worker",
      workerId: "w-handle-given",
      outcome: "closed",
      pane: "wC5:p8",
    });

    assert.deepEqual(closeCalls("wC5:p8"), ["pane close wC5:p8"]);
    assert.match(result.content[0].text, /Pane: pane wC5:p8 closed\./);
    assert.equal(
      readWorkers(repo).workers["w-handle-given"].pane,
      "wC5:p8",
      "the row a later reader gets names the pane it left",
    );
  });

  it("closes nothing when the argument contradicts the row's own handle", async () => {
    const repo = scratchProject();
    setPanes({ "wC5:p9": { status: "idle" }, "wC5:p10": { status: "idle" } });
    await admit(repo, "w-two-handles", { pane: "wC5:p9" });

    const result = await run({
      action: "close-worker",
      workerId: "w-two-handles",
      outcome: "closed",
      pane: "wC5:p10",
    });

    assert.deepEqual(anyCloseCalls(), [], "two records naming two panes close neither");
    assert.match(result.content[0].text, /records pane wC5:p9 and the argument names wC5:p10/);
    assert.equal(result.details.pane.result, "refused");
  });

  it("skips the whole step outside a herdr session", async () => {
    const repo = scratchProject();
    setPanes({ "wC5:p11": { status: "idle" } });
    await admit(repo, "w-no-herdr", { pane: "wC5:p11" });

    delete process.env.HERDR_ENV;
    try {
      const result = await run({ action: "close-worker", workerId: "w-no-herdr", outcome: "closed" });
      assert.deepEqual(herdrCalls(), [], "no herdr, no call");
      assert.match(result.content[0].text, /not inside a herdr session/);
      assert.equal(result.details.pane.result, "skipped");
    } finally {
      process.env.HERDR_ENV = "1";
    }
  });
});
