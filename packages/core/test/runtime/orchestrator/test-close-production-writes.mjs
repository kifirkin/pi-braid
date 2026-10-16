/**
 * Test: the close path's production-write preflight refusal.
 *
 * Pins the close-side read of the seat's production-write class:
 *
 * 1. The class is data. The fixture table in this file is synthetic — the
 *    reader and this suite name no vendor verb — so the cases prove the
 *    mechanism takes any table, and the member/piece patterns are the only
 *    place the class lives.
 * 2. A write row without a preflight row is refused, naming the row index, the
 *    member, the missing piece ids and the command; the row is untouched and
 *    nothing is stored.
 * 3. A close whose rows record every piece passes, whether the pieces sit in
 *    one composed row or across several.
 * 4. The read-only verb, the unrelated command and the absent/malformed class
 *    file all stay untouched or fail open: false refusals are the failure this
 *    read exists to avoid.
 * 5. A field carrying the read verb beside the write is still a write: the
 *    member patterns are the write verbs only.
 * 6. The pure reader is pinned directly with a caller-supplied table, so the
 *    data contract is checked without the file.
 * 7. The integration case drives the real orchestrate tool with a fake
 *    ExtensionAPI: the refusal rejects the tool call and leaves the registry
 *    row alone, and the published gates prose carries the new sentence.
 *
 * Hermetic: HOME and PI_CODING_AGENT_DIR are pinned into a scratch root BEFORE
 * the dist imports and BRAID_HOME is cleared, so the registry and the class
 * data file resolve inside the scratch tree; the live ~/.pi/agent is neither
 * read nor written.
 *
 * Run: node test/runtime/orchestrator/test-close-production-writes.mjs
 * (after npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "close-production-writes-"));
process.env.HOME = FAKE_HOME;
process.env.PI_CODING_AGENT_DIR = join(FAKE_HOME, ".pi", "agent");
delete process.env.BRAID_HOME;

const {
  closeWorker,
  productionWriteClassPath,
  productionWriteRefusalDetail,
  readProductionWriteClass,
  readProductionWrites,
  readWorkers,
  registerWorker,
} = await import("../../../dist/lib/orchestrator/index.js");
const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);

/**
 * The fixture class, synthetic on purpose: one write verb family, one declared
 * read-only verb, and three named pieces. The mechanism must work from this
 * table alone.
 */
const CLASS_TABLE = {
  version: 1,
  class: "production-write",
  members: [
    {
      id: "deployer-push",
      label: "Deployer push",
      registry: "https://deployer.example",
      pattern: "(?:^|[;&|(]\\s*)deployer\\s+push(?:\\s|$)",
    },
  ],
  exempt: [
    {
      id: "deployer-ls",
      label: "Deployer list",
      pattern: "(?:^|[;&|(]\\s*)deployer\\s+ls(?:\\s|$)",
    },
  ],
  preflight: {
    pieces: [
      { id: "identity", label: "identity", pattern: "deployer\\s+whoami\\b" },
      { id: "registry", label: "registry", pattern: "--endpoint\\s+\\S+" },
      { id: "dry-run", label: "dry-run", pattern: "deployer\\s+push[^;&|\\n]*--dry-run\\b" },
    ],
  },
};

/** Install the fixture table where the close path reads it. */
function writeClass(table = CLASS_TABLE, text = null) {
  const path = productionWriteClassPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text ?? JSON.stringify(table, null, 2));
}

function clearClass() {
  rmSync(productionWriteClassPath(), { force: true });
}

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

function scratchRepo() {
  return mkdtempSync(join(FAKE_HOME, "repo-"));
}

function admit(repo, workerId) {
  const result = registerWorker({ workerId, spec: "impl", cwd: repo });
  assert.equal(result.ok, true, `admission failed: ${JSON.stringify(result)}`);
  return result.entry;
}

console.log("the production-write reader");

test("the reader takes any table: members decide writes, pieces decide missing evidence", () => {
  const table = {
    members: [{ id: "push", label: "push", pattern: "deployer\\s+push" }],
    pieces: [
      { id: "p1", label: "p1", pattern: "--endpoint" },
      { id: "p2", label: "p2", pattern: "--dry-run" },
    ],
  };
  const read = readProductionWrites(
    [
      { cmd: "deployer ls", exit: 0 },
      { cmd: "deployer push --endpoint https://stub.example", exit: 0 },
    ],
    table,
  );
  assert.equal(read.rows.length, 1, "only the write row is read");
  assert.equal(read.rows[0].row, 1);
  assert.equal(read.rows[0].member, "push");
  assert.deepEqual(read.rows[0].preflightRows, [1], "the write row carries the endpoint piece");
  assert.deepEqual(read.rows[0].missingPieces, ["p2"]);
  assert.equal(read.unsatisfied.length, 1);
  assert.match(
    productionWriteRefusalDetail(read) ?? "",
    /gates\[1\] records a production write \("push"\) without a complete preflight row: missing pieces: p2; cmd: deployer push --endpoint https:\/\/stub\.example/,
  );
  assert.equal(productionWriteRefusalDetail({ rows: [], unsatisfied: [] }), null, "no read, no refusal");
});

test("the class file absent, malformed or empty refuses nothing", () => {
  clearClass();
  assert.deepEqual(readProductionWriteClass(), { members: [], pieces: [] });
  writeClass(null, "{ not json");
  assert.deepEqual(readProductionWriteClass(), { members: [], pieces: [] });
  writeClass(null, JSON.stringify({ members: [{ id: "", pattern: "x" }, { id: "bad", pattern: "(" }] }));
  assert.deepEqual(readProductionWriteClass().members, [], "unusable entries are dropped");
});

console.log("the close path");

test("a write row without a preflight row is refused and stamps nothing", () => {
  writeClass();
  const repo = scratchRepo();
  const workerId = "pw-missing";
  admit(repo, workerId);
  assert.equal(readProductionWriteClass().members.length, 1, "the fixture table is the one read");

  assert.throws(
    () => closeWorker(workerId, "completed", [{ cmd: "deployer push", exit: 0 }], repo),
    (error) => {
      const message = error.message;
      assert.match(message, /gates\[0\]/, message);
      assert.match(message, /production write \("deployer-push"\)/, message);
      assert.match(message, /missing pieces: identity, registry, dry-run/, message);
      assert.match(message, /cmd: deployer push/, message);
      assert.match(message, /worker pw-missing, outcome completed/, message);
      return true;
    },
  );

  const entry = readWorkers(repo).workers[workerId];
  assert.equal(entry.closedAt, null, "a refused close stamps nothing");
  assert.equal(entry.status, "admitted", "the status is untouched");
  assert.equal(entry.gates.length, 0, "no gate row is stored");
});

test("a composed preflight row passes the same close and the rows are stored", () => {
  writeClass();
  const repo = scratchRepo();
  const workerId = "pw-composed";
  admit(repo, workerId);

  const entry = closeWorker(
    workerId,
    "completed",
    [
      { cmd: "deployer push", exit: 0 },
      {
        cmd: "deployer whoami && deployer show --endpoint https://stub.example && deployer push --dry-run",
        exit: 0,
      },
    ],
    repo,
  );
  assert.equal(entry?.status, "completed");
  assert.equal(entry?.gates.length, 2, "both rows are stored");
});

test("pieces across separate rows pass, and the missing piece alone names the refusal", () => {
  writeClass();
  const repo = scratchRepo();
  const partialId = "pw-partial";
  admit(repo, partialId);
  assert.throws(
    () =>
      closeWorker(
        partialId,
        "completed",
        [
          { cmd: "deployer push", exit: 0 },
          { cmd: "deployer whoami && deployer push --endpoint https://stub.example", exit: 0 },
        ],
        repo,
      ),
    /missing pieces: dry-run; cmd: deployer push/,
    "only the piece no row carries is named",
  );

  const workerId = "pw-separate";
  admit(repo, workerId);
  const entry = closeWorker(
    workerId,
    "completed",
    [
      { cmd: "deployer push", exit: 0 },
      { cmd: "deployer whoami", exit: 0 },
      { cmd: "deployer show --endpoint https://stub.example", exit: 0 },
      { cmd: "deployer push --dry-run", exit: 0 },
    ],
    repo,
  );
  assert.equal(entry?.status, "completed", "four separate rows cover every piece");
});

test("the whitelist, the unrelated command and the absent class file stay untouched", () => {
  writeClass();
  const repo = scratchRepo();
  for (const [workerId, cmd] of [
    ["pw-readonly", "deployer ls --endpoint https://stub.example"],
    ["pw-unrelated", "git status"],
    ["pw-unrelated-2", "make build"],
  ]) {
    admit(repo, workerId);
    const entry = closeWorker(workerId, "completed", [{ cmd, exit: 0 }], repo);
    assert.equal(entry?.status, "completed", `${cmd} must not be refused`);
  }
  assert.deepEqual(
    readProductionWrites([{ cmd: "deployer ls", exit: 0 }]).rows,
    [],
    "the read-only verb is not a write",
  );

  clearClass();
  const absent = "pw-absent-class";
  admit(repo, absent);
  const entry = closeWorker(absent, "completed", [{ cmd: "deployer push", exit: 0 }], repo);
  assert.equal(entry?.status, "completed", "no class data means no refusal");
});

test("a read beside the write does not silence the write", () => {
  writeClass();
  const repo = scratchRepo();
  const workerId = "pw-mixed";
  admit(repo, workerId);
  assert.throws(
    () =>
      closeWorker(workerId, "completed", [{ cmd: "deployer whoami && deployer push", exit: 0 }], repo),
    (error) => {
      assert.match(error.message, /missing pieces: registry, dry-run/, error.message);
      assert.doesNotMatch(error.message, /identity/, "the read recorded the identity piece");
      return true;
    },
  );
});

console.log("the published contract and the tool path");

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

test("the gates contract names the production-write refusal and its fail-open direction", () => {
  const gates = orchestrateTool.parameters.properties.gates.description;
  assert.match(gates, /production-write refusal|production-write class/, `the contract must name the refusal: ${gates}`);
  assert.match(gates, /no class data means no refusal/, `the contract must state fail-open: ${gates}`);
});

await (async () => {
  writeClass();
  const repo = scratchRepo();
  const workerId = "pw-tool";
  const admitted = await runTool({ action: "register-worker", workerId, spec: "impl", cwd: repo });
  assert.equal(JSON.parse(admitted.content[0].text).entry.status, "admitted", admitted.content[0].text);

  await assert.rejects(
    () =>
      runTool({
        action: "close-worker",
        workerId,
        cwd: repo,
        outcome: "completed",
        gates: [{ cmd: "deployer push", exit: 0 }],
      }),
    /production write \("deployer-push"\)/,
    "the tool call must reject on the refusal",
  );
  const entry = readWorkers(repo).workers[workerId];
  assert.equal(entry.closedAt, null, "a refused tool close stamps nothing");

  const closed = await runTool({
    action: "close-worker",
    workerId,
    cwd: repo,
    outcome: "completed",
    gates: [
      { cmd: "deployer push", exit: 0 },
      { cmd: "deployer whoami && deployer push --endpoint https://stub.example --dry-run", exit: 0 },
    ],
  });
  assert.match(closed.content[0].text, /closed: completed/, closed.content[0].text);
  assert.equal(closed.details.entry.gates.length, 2);
})()
  .then(() => {
    passed++;
    console.log("  [ok] the orchestrate tool refuses, then closes with the preflight recorded");
  })
  .catch((error) => {
    failed++;
    console.log(`  [fail] the orchestrate tool refuses, then closes with the preflight recorded: ${error.message}`);
  });

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
