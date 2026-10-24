/**
 * Test: the guard's silence is a fact the fleet has to report.
 *
 * Two ways a fail-open guard is invisible, and both make an unguarded child look
 * exactly like a guarded one that found nothing to refuse:
 *
 *   stderr     a guard that cannot read the journal says so on the child's
 *              stderr, and nothing reads the child's stderr. The supervisor now
 *              logs what the child wrote, once per turn and bounded, so a wrong
 *              FLEET_GUARD_ROOT leaves a line instead of nothing; a quiet child
 *              still leaves none, or the line would be noise.
 *
 *   unknown    `state = 'unknown'` is the crash residue: the tool started and
 *              never reported, so the effect may have half applied. The guard
 *              counts that row as history and refuses a call it matches, and the
 *              recovery note tells the node so instead of leaving it to discover
 *              the refusal. Both halves are pinned here, in both directions: the
 *              refusal lands on an unknown effect inside the run being resumed,
 *              a settled turn's effect is left alone because the window is the
 *              run and not the store's memory, and the note names every unknown
 *              effect and says the guard will refuse a repeat. Change either
 *              half alone and the pair stops being true.
 *
 * The guard's own reader is used as the instrument, not restated: the arm runs
 * `openGuardJournal` against a store this file seeded, so the assertion is about
 * the guard that ships rather than about a copy of its query.
 *
 * Run: node test/runtime/fleet/test-guard-visibility.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openJournal } from "../../../scripts/fleet/journal.mjs";
import { openGuardJournal } from "../../../scripts/fleet/tool-guard.mjs";
import { childStderrReport, recoveryPrompt, Supervisor } from "../../../scripts/fleet/supervisor.mjs";

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

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function waitFor(label, predicate, { timeoutMs = 15_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ── the class where an effect may have half applied ─────────────────────────
//
// One store, two turns: turn 1 completed one call, turn 2 was interrupted with
// an identical-shaped call still attempted, which reconciliation turned into
// `unknown`.

const root = mkdtempSync(join(tmpdir(), "fleet-visibility-"));
const COMPLETED_ARGS = { command: "printf 'half\\n' >> world.log" };
const UNKNOWN_ARGS = { command: "printf 'other\\n' >> world.log" };

const seed = openJournal(root, { driver: "scripted" });
seed.addNode({
  nodeId: "n1",
  parentId: null,
  projectRoot: root,
  charterPath: join(root, "charter.md"),
  driver: "scripted",
});
const completedTurn = seed.beginTurn("n1", {
  kind: "charter",
  promptText: "run the effect",
  sessionId: "fleet-n1-test",
  supervisorEpoch: 1,
});
seed.effectAttempted({
  turnId: completedTurn,
  nodeId: "n1",
  toolCallId: "call-completed",
  toolName: "bash",
  args: COMPLETED_ARGS,
  replay: "never",
  seq: 1,
});
seed.effectSettled({ turnId: completedTurn, toolCallId: "call-completed", result: { ok: true }, isError: false });
seed.endTurn(completedTurn, { state: "settled" });

const interruptedTurn = seed.beginTurn("n1", {
  kind: "message",
  promptText: "run it again",
  sessionId: "fleet-n1-test",
  supervisorEpoch: 1,
});
const unknownKey = seed.effectAttempted({
  turnId: interruptedTurn,
  nodeId: "n1",
  toolCallId: "call-unknown",
  toolName: "bash",
  args: UNKNOWN_ARGS,
  replay: "never",
  seq: 1,
});
seed.markUnknownEffects(interruptedTurn);
const unknownRow = seed.effects(interruptedTurn)[0];
seed.endTurn(interruptedTurn, { state: "interrupted" });
seed.setNodeState("n1", "settled");
const node = seed.getNode("n1");
seed.close();

// The turn a resumed run would be: the interrupted turn is the last one, so the
// guard's window starts at the settled turn before it.
const currentTurn = interruptedTurn + 1;

await check("the guard refuses the call whose outcome is unknown, and names the row it is refusing", () => {
  const guard = openGuardJournal(root);
  try {
    assert.equal(unknownRow.state, "unknown", "the seeded row is the crash residue");
    assert.equal(unknownRow.idempotency_key, unknownKey, "the row is the attempt that was made, not a new one");
    const duplicate = guard.appliedDuplicate({
      nodeId: "n1",
      toolName: "bash",
      args: UNKNOWN_ARGS,
      currentTurnId: currentTurn,
    });
    assert.ok(duplicate, "an effect that may have applied is history the guard refuses to repeat");
    assert.equal(duplicate.turnId, interruptedTurn);
    assert.equal(duplicate.toolCallId, "call-unknown");
    assert.equal(duplicate.state, "unknown", "the refusal can say the outcome was never learned");
  } finally {
    guard.close();
  }
});

await check("the guard lets a settled run's effect go, so the window is the run and not the store's memory", () => {
  const reopened = openJournal(root, {});
  try {
    assert.equal(reopened.effects(completedTurn).length, 1, "the completed row is in the store, and the guard still lets it go");
  } finally {
    reopened.close();
  }
  const guard = openGuardJournal(root);
  try {
    const duplicate = guard.appliedDuplicate({
      nodeId: "n1",
      toolName: "bash",
      args: COMPLETED_ARGS,
      currentTurnId: currentTurn,
    });
    assert.equal(duplicate, null, "a turn that ended normally finished its work, so its effects are not this run's history");
  } finally {
    guard.close();
  }
});

await check("the recovery note names every unknown effect and says the guard will refuse a repeat", () => {
  const { prompt: note } = recoveryPrompt({
    node,
    interruptedTurn: { turn_id: interruptedTurn },
    completed: [],
    unknown: [unknownRow],
    pending: [],
  });
  assert.match(note, new RegExp(`- seq ${unknownRow.seq} bash unknown \\(idempotency ${unknownKey}\\)`), note);
  assert.match(note, /Re-issuing one of these is refused/, note);
  assert.match(note, /counts as history the guard will not let you repeat/, note);
  assert.match(note, /releasing it is an operator's decision/, "the release is named as the operator's, not the node's");
  assert.match(note, /never repeat a completed effect/, "the completed rule is still stated");
});

await check("suppressing the note is the only thing that removes the account", () => {
  const { prompt: silent } = recoveryPrompt({
    node,
    interruptedTurn: { turn_id: interruptedTurn },
    completed: [],
    unknown: [unknownRow],
    pending: [],
    note: false,
  });
  assert.doesNotMatch(silent, /unknown/, silent);
  assert.doesNotMatch(silent, /Re-issuing one of these is refused/, silent);
});

// ── the child's stderr ──────────────────────────────────────────────────────

await check("a quiet child is reported as nothing at all", () => {
  assert.equal(childStderrReport(""), null);
  assert.equal(childStderrReport("   \n\t\n"), null);
  assert.equal(childStderrReport(undefined), null);
});

await check("a child's stderr is collapsed to one line and cut from the front, keeping the tail", () => {
  const report = childStderrReport(`${"noise ".repeat(400)}\nTAIL-MARK-91`, { limit: 120 });
  assert.ok(report, "something was written");
  assert.ok(report.withheld > 0, `the report says how much it withheld: ${report.withheld}`);
  assert.doesNotMatch(report.shown, /\n/, "one line, not a transcript");
  assert.match(report.shown, /TAIL-MARK-91$/, "the tail is the part worth keeping");
  assert.ok(report.shown.length < 160, `the shown text is bounded: ${report.shown.length}`);
});

// A supervisor with a driver whose child wrote to stderr, and one whose child
// said nothing. Same supervisor, same turn shape: the only difference is what
// the child put on the channel, so the arms cannot pass on a difference in the
// drive path.
const GUARD_LINE =
  "fleet-guard: journal unreadable at n1-noisy turn 1 (ENOENT no fleet journal at /nope/fleet.sqlite); call c1 bash allowed through unguarded";
// The newest thing the child said is what survives a bounded report, so the
// guard's line sits at the end of a noisy stream the way a repeat of it would:
// the guard reports once per refusable call, and the driver keeps the tail.
const NOISY_STDERR = `${"stderr chatter ".repeat(120)}\n${GUARD_LINE}`;

const fleetRoot = mkdtempSync(join(tmpdir(), "fleet-stderr-"));
const worldFile = join(fleetRoot, "world.log");
writeFileSync(worldFile, "");
{
  const journal = openJournal(fleetRoot, { driver: "scripted" });
  for (const nodeId of ["n1-noisy", "n2-quiet"]) {
    journal.addNode({
      nodeId,
      parentId: null,
      projectRoot: fleetRoot,
      charterPath: join(fleetRoot, `${nodeId}.charter.md`),
      driver: "scripted",
      driverConfig: { steps: [{ op: "done" }], worldFile },
    });
  }
  journal.close();
}

const log = [];
const supervisor = new Supervisor({
  root: fleetRoot,
  driver: "scripted",
  cap: 2,
  tickMs: 20,
  // Long enough that no arm races an exit it did not ask for.
  idleExitMs: 600_000,
  control: false,
  log: (line) => log.push(line),
});
const realCreateDriver = supervisor.createDriver.bind(supervisor);
supervisor.createDriver = (drivenNode, turnId) => {
  const driver = realCreateDriver(drivenNode, turnId);
  // What an RpcDriver accumulates from its child's stderr, installed at the one
  // seam the supervisor reads.
  if (drivenNode.node_id === "n1-noisy") driver.stderr = NOISY_STDERR;
  return driver;
};

await supervisor.start();
await waitFor("both nodes to finish", () => {
  const journal = openJournal(fleetRoot, {});
  try {
    return ["n1-noisy", "n2-quiet"].every((nodeId) => journal.getNode(nodeId).state === "done");
  } finally {
    journal.close();
  }
});
await supervisor.stop();

const stderrLines = log.filter((line) => line.includes("child stderr"));

await check("a guarded child that wrote to stderr is visible in the supervisor's log", () => {
  const noisy = stderrLines.filter((line) => line.includes("n1-noisy"));
  assert.equal(noisy.length, 1, `one line per turn, not one per chunk: ${stderrLines.join(" | ")}`);
  assert.match(noisy[0], /journal unreadable/, "the guard's own words are carried, not summarised");
  assert.match(noisy[0], /allowed through unguarded/, "the fail-open consequence is carried with them");
});

await check("the logged line is bounded, and says how much it withheld", () => {
  const line = stderrLines.find((candidate) => candidate.includes("n1-noisy"));
  assert.ok(line, "the noisy child produced a line");
  assert.ok(line.length < 700, `the line is bounded (${line.length} chars) of ${NOISY_STDERR.length} written`);
  assert.match(line, /chars withheld/);
});

await check("a child that wrote nothing leaves no line, so the report is not noise", () => {
  assert.equal(stderrLines.filter((line) => line.includes("n2-quiet")).length, 0, stderrLines.join(" | "));
});

// ── summary ─────────────────────────────────────────────────────────────────

if (failed > 0) {
  console.log(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
