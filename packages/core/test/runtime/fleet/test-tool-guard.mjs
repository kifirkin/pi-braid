/**
 * Test: the pre-execution duplication guard.
 *
 * Two of the three legs of this guard's proof live here, and neither is a
 * sentence in a prompt:
 *
 *   1. The handler's decision, called directly against rows in a real journal:
 *      a duplicate of a completed mutating call is refused, the first call of
 *      that key runs, the same key inside the current turn runs, a read-only
 *      call runs, and a different argument set runs.
 *   2. The wiring: a supervisor hands every child both the guard's `-e` entry
 *      and the node and turn the guard needs, alongside the extensions it
 *      already passed, and the spawned process really has both.
 *
 * The third leg is a real pi child refusing a duplicate before it executes.
 * That lives in `drill.mjs --arms nonote`: it needs a real pi process, and this
 * file does not run one. Passing here says nothing about that arm.
 *
 * Run: node test/runtime/fleet/test-tool-guard.mjs
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { effectKey, openJournal } from "../../../scripts/fleet/journal.mjs";
import { createRpcDriver, GUARD_EXTENSION, guardEnvironment } from "../../../scripts/fleet/driver-rpc.mjs";
import { Supervisor } from "../../../scripts/fleet/supervisor.mjs";
import toolGuard, {
  canonicalKey,
  createGuard,
  GUARD_ENV,
  guardContext,
  openGuardJournal,
} from "../../../scripts/fleet/tool-guard.mjs";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  [fail] ${name}: ${error.message}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "fleet-guard-"));
const worldFile = join(root, "world.log");
const nodeId = "n1";

/** The command the interrupted turn already applied. */
const APPLIED = `printf 'applied\\n' >> ${worldFile}`;
/** A command no row records: the same tool, different arguments. */
const FRESH = `printf 'fresh\\n' >> ${worldFile}`;
/** A command completed inside the turn that is now running. */
const SAME_TURN = `printf 'twice-in-one-turn\\n' >> ${worldFile}`;

// ── the fabricated journal ──────────────────────────────────────────────────

const DEAD_PID = 2_147_483_600;
const seed = openJournal(root, { driver: "rpc" });
const epoch = seed.registerSupervisor({ pid: DEAD_PID, driver: "rpc", childArgs: [], piVersion: "test" });
seed.addNode({
  nodeId,
  parentId: null,
  projectRoot: root,
  charterPath: join(root, "charter.md"),
  driver: "rpc",
});
const completed = (turnId, toolCallId, toolName, args, seq) => {
  seed.effectAttempted({ turnId, nodeId, toolCallId, toolName, args, replay: "never", seq });
  seed.effectSettled({ turnId, toolCallId, result: { ok: true }, isError: false });
};
const interruptedTurn = seed.beginTurn(nodeId, {
  kind: "charter",
  promptText: "apply the effect",
  sessionId: "fleet-n1",
  supervisorEpoch: epoch,
});
// The recorded rows carry what the tool reports back; the calls below do not.
// That difference is what the two surfaces of one call look like.
completed(interruptedTurn, "call-applied", "bash", { command: APPLIED, timeout: null }, 1);
completed(interruptedTurn, "call-read", "read", { path: join(root, "charter.md"), offset: null, limit: 2000 }, 2);
// The edit tool's legacy pair, which is the shape the RPC record keeps.
completed(interruptedTurn, "call-edit", "edit", { path: join(worldFile), oldText: "a", newText: "b" }, 3);
// The same call after pi's edit tool rewrote it into an `edits` array.
completed(interruptedTurn, "call-edit-array", "edit", { path: join(worldFile), edits: [{ oldText: "c", newText: "d" }] }, 4);
const currentTurn = seed.beginTurn(nodeId, {
  kind: "recovery",
  promptText: "resume",
  sessionId: "fleet-n1",
  supervisorEpoch: epoch,
});
completed(currentTurn, "call-same-turn", "bash", { command: SAME_TURN }, 1);

const store = openGuardJournal(root);
const guard = createGuard({ nodeId, turnId: currentTurn, store: () => store });

/** Call the handler the way pi calls it: the tool's input, nothing else. */
const call = (toolName, input, toolCallId = "call-now") => guard.onToolCall({ toolName, toolCallId, input });

/** Re-read the journal as another process would, to see what the guard wrote. */
function effectsOf(turnId) {
  const reopened = openJournal(root, {});
  try {
    return reopened.effects(turnId);
  } finally {
    reopened.close();
  }
}

// ── leg 1: the handler's five decisions ─────────────────────────────────────

await check("case 1: a duplicate of a completed mutating call is refused before it runs", () => {
  const result = call("bash", { command: APPLIED }, "call-duplicate");
  assert.equal(result?.block, true, `expected a block, got ${JSON.stringify(result)}`);
  assert.match(String(result.reason), /turn 1\b/, "the refusal names the turn that completed it");
  assert.match(String(result.reason), /bash/, "the refusal names the tool");
});

await check("case 1b: the refusal is a durable row, not a log line", () => {
  const row = effectsOf(currentTurn).find((effect) => effect.tool_call_id === "call-duplicate");
  assert.ok(row, "a row exists for the refused call");
  assert.equal(row.state, "blocked");
  assert.equal(row.tool_name, "bash");
  assert.equal(row.args_json, JSON.stringify({ command: APPLIED }));
  assert.equal(row.idempotency_key, effectKey({ nodeId, turnId: currentTurn, toolCallId: "call-duplicate" }));
  assert.equal(row.is_error, 1);
  const record = JSON.parse(row.result_json);
  assert.equal(record.blocked, true);
  assert.equal(record.duplicate_of_turn, interruptedTurn);
  assert.ok(row.started_at > 0 && row.ended_at > 0, "the row is time-stamped");
});

await check("case 1c: a refused call is not an applied effect and never becomes unknown", () => {
  const reopened = openJournal(root, {});
  try {
    const applied = reopened.settledEffects(currentTurn).map((effect) => effect.tool_call_id);
    assert.ok(!applied.includes("call-duplicate"), "settledEffects must not present a refusal as applied");
    reopened.markUnknownEffects(currentTurn);
    const row = reopened.effects(currentTurn).find((effect) => effect.tool_call_id === "call-duplicate");
    assert.equal(row.state, "blocked", "reconciliation leaves a refusal alone");
  } finally {
    reopened.close();
  }
});

await check("case 2: the first call of a key is allowed", () => {
  assert.equal(call("bash", { command: FRESH }, "call-fresh"), undefined);
});

await check("case 3: the same key inside the current turn is allowed", () => {
  assert.equal(call("bash", { command: SAME_TURN }, "call-same-turn-again"), undefined);
});

await check("case 4: a read-only call completed in an earlier turn is allowed", () => {
  assert.equal(call("read", { path: join(root, "charter.md") }, "call-read-again"), undefined);
});

await check("case 5: a different argument set is allowed", () => {
  assert.equal(call("bash", { command: `${APPLIED} ` }, "call-trailing-space"), undefined);
});

await check("the identity ignores key order and unset fields", () => {
  assert.equal(
    canonicalKey({ path: join(worldFile), oldText: "a", newText: "b" }),
    canonicalKey({ newText: "b", path: join(worldFile), oldText: "a" }),
  );
  assert.equal(canonicalKey({ command: "x", timeout: null }), canonicalKey({ command: "x" }));
  const reordered = call("edit", { newText: "b", oldText: "a", path: join(worldFile) }, "call-edit-reordered");
  assert.equal(reordered?.block, true, `a reordered edit is the same call, got ${JSON.stringify(reordered)}`);
});

await check("the edit tool's two shapes are one call, in both directions", () => {
  const asArray = call("edit", { path: join(worldFile), edits: [{ oldText: "a", newText: "b" }] }, "call-edit-arr");
  assert.equal(asArray?.block, true, `a legacy row against an edits call, got ${JSON.stringify(asArray)}`);
  const asPair = call("edit", { path: join(worldFile), oldText: "c", newText: "d" }, "call-edit-pair");
  assert.equal(asPair?.block, true, `an edits row against a legacy call, got ${JSON.stringify(asPair)}`);
  const twoEdits = call(
    "edit",
    { path: join(worldFile), edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] },
    "call-edit-two",
  );
  assert.equal(twoEdits, undefined, "two edits are not the single edit that was recorded");
});

await check("a call that carries no arguments matches nothing", () => {
  // Vacuous agreement would block every argument-less call of a tool that has
  // ever run, which is the one shape where a subset comparison goes wrong.
  assert.equal(call("bash", {}, "call-empty"), undefined);
});

await check("a guard with no journal does not block, and says so", () => {
  const reported = [];
  const unreadable = createGuard({
    nodeId,
    turnId: currentTurn,
    store: () => {
      throw new Error("disk went away");
    },
    report: (line) => reported.push(line),
  });
  const result = unreadable.onToolCall({ toolName: "bash", toolCallId: "call-unreadable", input: { command: APPLIED } });
  assert.equal(result, undefined, "a guard that cannot read must not refuse work");
  assert.equal(reported.length, 1, `expected one report, got ${reported.length}`);
  assert.match(reported[0], /disk went away/);
});

await check("the env contract is all-or-nothing, and its switch turns the guard off", () => {
  assert.equal(guardContext({}), null);
  assert.equal(guardContext({ [GUARD_ENV.root]: root, [GUARD_ENV.node]: nodeId }), null, "no turn id, no guard");
  assert.equal(
    guardContext({ [GUARD_ENV.root]: root, [GUARD_ENV.node]: nodeId, [GUARD_ENV.turn]: "0" }),
    null,
    "a turn id that is not a positive integer is not a turn",
  );
  assert.deepEqual(
    guardContext({ [GUARD_ENV.root]: root, [GUARD_ENV.node]: nodeId, [GUARD_ENV.turn]: "7" }),
    { root: resolve(root), nodeId, turnId: 7 },
  );
  assert.equal(
    guardContext({ [GUARD_ENV.root]: root, [GUARD_ENV.node]: nodeId, [GUARD_ENV.turn]: "7", [GUARD_ENV.off]: "off" }),
    null,
    "the switch is the operator's escape hatch",
  );
  assert.deepEqual(
    guardContext({ [GUARD_ENV.root]: root, [GUARD_ENV.node]: nodeId, [GUARD_ENV.turn]: "7", [GUARD_ENV.off]: "on" }),
    { root: resolve(root), nodeId, turnId: 7 },
    "a value that is not a recognised off leaves the guard on rather than silently disabling it",
  );
});

await check("loaded without its env, the extension registers no handler at all", () => {
  const saved = { ...process.env };
  for (const name of Object.values(GUARD_ENV)) delete process.env[name];
  const registered = [];
  try {
    toolGuard({ on: (event) => registered.push(event) });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
    }
  }
  assert.deepEqual(registered, [], "no env, no hook: pi skips tool_call entirely");
});

store.close();
seed.close();

// ── leg 2: the wiring ───────────────────────────────────────────────────────

const providerExtension = join(root, "provider-extension.mjs");
writeFileSync(providerExtension, "export default function provider() {}\n");

await check("the supervisor's driver carries the guard and the env the guard reads", () => {
  const supervisor = new Supervisor({
    root,
    driver: "rpc",
    control: false,
    model: "stub/stub-1",
    extensions: [providerExtension],
  });
  const driver = supervisor.createDriver(
    { node_id: nodeId, driver: "rpc", project_root: root, session_id: "fleet-n1", driver_config: "{}" },
    currentTurn,
  );
  const argv = driver.args();
  const entryFor = (path) => argv.findIndex((token, index) => token === "-e" && argv[index + 1] === path);
  try {
    assert.ok(entryFor(providerExtension) >= 0, `the extension passed before this change is still passed: ${argv.join(" ")}`);
    assert.ok(entryFor(GUARD_EXTENSION) >= 0, `the guard is passed: ${argv.join(" ")}`);
    assert.equal(driver.cfg.env[GUARD_ENV.root], resolve(root));
    assert.equal(driver.cfg.env[GUARD_ENV.node], nodeId);
    assert.equal(driver.cfg.env[GUARD_ENV.turn], String(currentTurn));
  } finally {
    supervisor.journal.close();
  }
});

await check("the spawned child really receives the -e entry and the env", async () => {
  const dumpPath = join(root, "fake-pi.json");
  const fakePi = join(root, "fake-pi.mjs");
  writeFileSync(
    fakePi,
    [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      "writeFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({",
      "  argv: process.argv.slice(2),",
      "  env: {",
      '    root: process.env[process.env.FAKE_PI_ROOT_NAME] ?? null,',
      '    node: process.env[process.env.FAKE_PI_NODE_NAME] ?? null,',
      '    turn: process.env[process.env.FAKE_PI_TURN_NAME] ?? null,',
      "  },",
      "}));",
      'let buffer = "";',
      'process.stdin.on("data", (chunk) => {',
      "  buffer += chunk.toString(\"utf8\");",
      "  let index;",
      "  while ((index = buffer.indexOf(\"\\n\")) >= 0) {",
      "    const line = buffer.slice(0, index);",
      "    buffer = buffer.slice(index + 1);",
      "    if (!line.trim()) continue;",
      "    let record;",
      "    try { record = JSON.parse(line); } catch { continue; }",
      '    if (record.type !== "get_state") continue;',
      '    process.stdout.write(JSON.stringify({ type: "response", id: record.id, command: "get_state", success: true, data: { sessionId: "fake-session", messageCount: 0 } }) + "\\n");',
      "  }",
      "});",
      'process.stdin.on("end", () => process.exit(0));',
      "",
    ].join("\n"),
  );
  chmodSync(fakePi, 0o755);

  const driver = createRpcDriver({
    piBin: fakePi,
    cwd: root,
    sessionId: "fleet-n1",
    sessionDir: join(root, "sessions"),
    model: "stub/stub-1",
    extensions: [providerExtension],
    guardExtension: GUARD_EXTENSION,
    env: {
      ...guardEnvironment({ root, nodeId, turnId: currentTurn }),
      FAKE_PI_DUMP: dumpPath,
      FAKE_PI_ROOT_NAME: GUARD_ENV.root,
      FAKE_PI_NODE_NAME: GUARD_ENV.node,
      FAKE_PI_TURN_NAME: GUARD_ENV.turn,
    },
  });
  try {
    await driver.start();
    const seen = JSON.parse(readFileSync(dumpPath, "utf8"));
    const entryFor = (path) => seen.argv.findIndex((token, index) => token === "-e" && seen.argv[index + 1] === path);
    assert.ok(entryFor(providerExtension) >= 0, `pre-existing -e entry reached the child: ${seen.argv.join(" ")}`);
    assert.ok(entryFor(GUARD_EXTENSION) >= 0, `guard -e entry reached the child: ${seen.argv.join(" ")}`);
    assert.equal(seen.env.node, nodeId);
    assert.equal(seen.env.turn, String(currentTurn));
    assert.equal(seen.env.root, resolve(root));
  } finally {
    await driver.stop().catch(() => {});
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
