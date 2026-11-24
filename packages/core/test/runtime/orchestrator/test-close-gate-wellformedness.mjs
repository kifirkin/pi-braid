/**
 * Test: close-path gate-row well-formedness (the four string predicates).
 *
 * Pins the close path's read of recorded gate evidence before it is stamped:
 *
 * 1. Every decorated command recorded in the self-review gate samples is
 *    refused as written and accepted once the decoration is gone. The table
 *    names the predicate that must fire for each row, so a change in which
 *    predicate catches a shape fails here instead of passing as "refused".
 *    The prose-only rows fail (b); every parenthesized or arrow-decorated row
 *    fails (a), the parse, with the decoration still in the field.
 * 2. A row with no `cmd` at all (the unparseable evidence shape) is refused by
 *    the existing shape check, before any predicate runs and with nothing
 *    logged: that refusal is not a well-formedness refusal.
 * 3. The deliberate non-catch: `false` recorded as exit 0 parses, resolves and
 *    stays accepted, through the close path too. That boundary belongs to
 *    effect evidence (whether a recorded fake gate was ever run); asserting
 *    the acceptance keeps a later reader from assuming this validator closes
 *    the fake-gate family by itself.
 * 4. (c) names the field's own hole: an unquoted `;`, newline or background
 *    `&`, and a word-starting `#`, hand the recorded exit to something other
 *    than the command the field names, so they are refused; quoted
 *    separators, command substitutions, pipelines, redirections and `&&`
 *    chains stay accepted.
 * 5. (d) is outcome- and expectation-dependent: exit 1 is refused under
 *    `completed` and accepted under `error`; a row that declares
 *    `expect: "fail"` inverts the rule under `completed` - its non-zero exit
 *    is the expectation, its zero exit is the violation - and the four other
 *    predicates keep judging it. A row with no field keeps today's rule and
 *    today's detail string.
 * 5b. (b) resolves the first token in the directory the command ran in (the
 *    worker's own cwd), so a worker's `./relative/binary` is valid evidence
 *    where it ran and is refused, with that directory named, where it is not.
 * 6. The mode comes from settings (braid.orchestrator.closeGateWellFormedness,
 *    default "shadow"), read at close time: shadow records a refusal line and
 *    lets the close stand; enforce throws naming the row, predicate and cmd
 *    before any registry write, and leaves the row untouched; off skips the
 *    read and logs nothing. The pure resolver is pinned separately so a typo
 *    cannot disarm or arm the validator.
 * 7. The integration case drives the real orchestrate tool with a fake
 *    ExtensionAPI: a worker's own entry closes under the default mode with a
 *    decorated row, an honest row and the deliberately uncaught `false` row,
 *    writing exactly one refusal line under the pinned braid root and storing
 *    all three rows.
 *
 * Hermetic: HOME and PI_CODING_AGENT_DIR are pinned into a scratch root BEFORE
 * the dist imports and BRAID_HOME is cleared, so the registry, the refusal log
 * and settings.json all resolve inside the scratch tree; the live
 * ~/.pi/agent is neither read nor written.
 *
 * Run: node test/runtime/orchestrator/test-close-gate-wellformedness.mjs
 * (after npm run build)
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_HOME = mkdtempSync(join(tmpdir(), "close-gate-wf-"));
process.env.HOME = FAKE_HOME;
process.env.PI_CODING_AGENT_DIR = join(FAKE_HOME, ".pi", "agent");
delete process.env.BRAID_HOME;

const {
  closeGateRefusalLogPath,
  findGateRowViolation,
  findTopLevelDecoration,
  firstCommandToken,
  gateRowExpectation,
  gateRowExpectationMet,
  GATE_ROW_EXPECTATIONS,
  readWorkers,
} = await import("../../../dist/lib/orchestrator/index.js");
const { CLOSE_GATE_WELL_FORMEDNESS_DEFAULTS, resolveCloseGateWellFormedness } = await import(
  "../../../dist/lib/config/braid-settings.js"
);
const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);

const SETTINGS_DIR = join(FAKE_HOME, ".pi", "agent");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");

/** Write a settings.json carrying only the close-gate mode. */
function setMode(mode) {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(
    SETTINGS_FILE,
    JSON.stringify({ braid: { orchestrator: { closeGateWellFormedness: mode } } }),
  );
}

/** Remove the settings file: the shipped default (shadow) applies. */
function clearMode() {
  rmSync(SETTINGS_FILE, { force: true });
}

/** Every refusal line currently in the scratch log, parsed. */
function refusalLines() {
  const file = closeGateRefusalLogPath();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function clearRefusalLog() {
  rmSync(closeGateRefusalLogPath(), { force: true });
}

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

// ── the recorded instances, in both directions ──────────────────────────────
// The recorded strings are data, not code, so they live verbatim in
// fixtures/close-gate-recorded-instances.json together with their store
// provenance notes; the scan that reads provenance tokens does not read JSON.
// `recorded` is the field as it was recorded, `honest` is the repaired form
// that keeps the same check. The predicates never execute either string.

const INSTANCES = JSON.parse(
  readFileSync(join(HERE, "fixtures", "close-gate-recorded-instances.json"), "utf8"),
).instances;
const DECORATED_CLOSE_ROW = INSTANCES.find((row) => row.role === "decorated-close");
const HONEST_CLOSE_ROW = INSTANCES.find((row) => row.role === "honest-close");
assert.ok(DECORATED_CLOSE_ROW, "the fixture must carry the decorated close row");
assert.ok(HONEST_CLOSE_ROW, "the fixture must carry the honest close row");
const PROSE_ROW = INSTANCES.find((row) => row.predicate === "b");
assert.ok(PROSE_ROW, "the fixture must carry the prose row that fails (b)");

console.log("the four predicates over the recorded instances");

test("every recorded decorated row is refused by its named predicate and accepted in its honest form", () => {
  assert.ok(INSTANCES.length >= 7, `the fixture must carry every recorded instance: ${INSTANCES.length}`);
  for (const instance of INSTANCES) {
    const refused = findGateRowViolation(instance.recorded, 0, "completed");
    assert.ok(refused, `${instance.id}: the recorded row must be refused as written`);
    assert.equal(
      refused.predicate,
      instance.predicate,
      `${instance.id}: refused by (${refused.predicate}), not (${instance.predicate}): ${refused.detail}`,
    );
    assert.ok(refused.detail.length > 0, `${instance.id}: the violation must carry a detail`);
    assert.equal(
      findGateRowViolation(instance.honest, 0, "completed"),
      null,
      `${instance.id}: the honest form must be accepted: ${instance.honest}`,
    );
  }
});

/**
 * The first non-empty stderr line the shell itself prints for a command it
 * refuses to parse, read from the same shell the predicate runs. Bash says
 * `syntax error near unexpected token`, dash says `Syntax error: "("
 * unexpected`, and a translated shell says neither, so the expected string is
 * derived here instead of spelled into the assertion: what is pinned is that
 * (a) carries the shell's line, not one shell's wording of it.
 */
function shellParseErrorLine(cmd) {
  try {
    execFileSync("sh", ["-n", "-c", cmd], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    return null;
  } catch (error) {
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    return (
      stderr
        .split("\n")
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate.length > 0) ?? null
    );
  }
}

test("the parse predicate reports the shell's own line, and the resolve predicate names the token", () => {
  const parsed = findGateRowViolation(DECORATED_CLOSE_ROW.recorded, 0, "completed");
  assert.match(parsed.detail, /sh -n/, `(a) must name the instrument: ${parsed.detail}`);
  const shellLine = shellParseErrorLine(DECORATED_CLOSE_ROW.recorded);
  assert.ok(shellLine, "the fixture's decorated row must not parse under the shell the predicate runs");
  assert.ok(
    parsed.detail.includes(shellLine),
    `(a) must carry the shell's line verbatim: ${shellLine} not in ${parsed.detail}`,
  );
  const prose = findGateRowViolation(PROSE_ROW.recorded, 0, "completed");
  assert.match(prose.detail, /falsification:/, `(b) must name the token: ${prose.detail}`);
});

test("(d): exit 1 is refused under completed and accepted under the other outcomes", () => {
  const failing = 'node -e "process.exit(1)"';
  const refused = findGateRowViolation(failing, 1, "completed");
  assert.equal(refused.predicate, "d", JSON.stringify(refused));
  assert.match(refused.detail, /exit 1/, refused.detail);
  assert.equal(findGateRowViolation(failing, 1, "error"), null, "a failing gate is honest evidence under error");
  assert.equal(findGateRowViolation(failing, 1, "stalled"), null);
  assert.equal(findGateRowViolation(failing, 1, "false-done"), null);
  assert.equal(findGateRowViolation(failing, 0, "completed"), null);
});

test("(d): a falsifier is recorded for the exit it produced, and a green falsifier is the violation", () => {
  const red = 'node -e "process.exit(1)"';
  assert.equal(
    findGateRowViolation(red, 1, "completed", { expect: "fail" }),
    null,
    "a control that went red is well-formed evidence",
  );
  assert.equal(
    findGateRowViolation(red, 3, "completed", { expect: "fail" }),
    null,
    "any non-zero code is the expectation; the code is recorded as it was produced",
  );

  const green = 'node -e "process.exit(0)"';
  const refused = findGateRowViolation(green, 0, "completed", { expect: "fail" });
  assert.ok(refused, "a falsifier that passed must be refused");
  assert.equal(refused.predicate, "d", JSON.stringify(refused));
  assert.match(refused.detail, /proves nothing/, refused.detail);
});

test("(d) keeps today's refusal and today's detail for a row that expects to pass", () => {
  const failing = 'node -e "process.exit(1)"';
  for (const opts of [{}, { expect: "pass" }]) {
    const refused = findGateRowViolation(failing, 1, "completed", opts);
    assert.ok(refused, `a failing row under ${JSON.stringify(opts)} must be refused`);
    assert.equal(refused.predicate, "d");
    assert.equal(
      refused.detail,
      "exit 1 recorded under a completed outcome",
      "the detail an existing reader pins must not change",
    );
  }
  assert.equal(findGateRowViolation(failing, 0, "completed", { expect: "pass" }), null);
});

test("(d) is judged only under a completed outcome, whatever the row declared", () => {
  for (const outcome of ["error", "stalled", "false-done", "closed"]) {
    assert.equal(
      findGateRowViolation('node -e "process.exit(0)"', 0, outcome, { expect: "fail" }),
      null,
      `an unreddened control is not a well-formedness violation under ${outcome}`,
    );
  }
});

test("a falsifier row is still a command: (a), (b), (c) and (e) judge it", () => {
  const cases = [
    ["npm run ci:check (planted control)", "a"],
    ["falsification: the new case should go red", "b"],
    ["npm run ci:check # planted control", "c"],
    ["node scripts/check-result.mjs /tmp/close-falsifier-no-such-receipt.jsonl", "e"],
  ];
  for (const [cmd, predicate] of cases) {
    const refused = findGateRowViolation(cmd, 1, "completed", { expect: "fail" });
    assert.ok(refused, `a falsifier row must still be judged: ${cmd}`);
    assert.equal(refused.predicate, predicate, `${cmd} -> ${JSON.stringify(refused)}`);
  }
});

test("the expectation readers default an absent or unreadable field to pass", () => {
  assert.deepEqual(GATE_ROW_EXPECTATIONS, ["pass", "fail"]);
  assert.equal(gateRowExpectation({}), "pass");
  assert.equal(gateRowExpectation({ expect: "pass" }), "pass");
  assert.equal(gateRowExpectation({ expect: "fail" }), "fail");
  assert.equal(gateRowExpectation({ expect: "FAIL" }), "pass", "an unreadable field reads as the old rule");
  assert.equal(gateRowExpectationMet({ exit: 0 }), true);
  assert.equal(gateRowExpectationMet({ exit: 1 }), false);
  assert.equal(gateRowExpectationMet({ exit: 1, expect: "fail" }), true);
  assert.equal(gateRowExpectationMet({ exit: 0, expect: "fail" }), false);
});

// ── (b) resolves where the command ran ──────────────────────────────────────

const RESOLVE_DIR = mkdtempSync(join(tmpdir(), "close-gate-cwd-"));
mkdirSync(join(RESOLVE_DIR, "native", "build"), { recursive: true });
const LOCAL_BINARY = join(RESOLVE_DIR, "native", "build", "tract-test");
writeFileSync(LOCAL_BINARY, "#!/bin/sh\nexit 1\n");
chmodSync(LOCAL_BINARY, 0o755);
const LOCAL_ROW = "./native/build/tract-test";

test("(b): the first token resolves in the directory the command ran in", () => {
  assert.equal(
    findGateRowViolation(LOCAL_ROW, 1, "error", { cwd: RESOLVE_DIR }),
    null,
    "a worker's own relative binary is valid evidence where it ran",
  );
  assert.equal(
    findGateRowViolation("npm run typecheck", 0, "completed", { cwd: RESOLVE_DIR }),
    null,
    "a PATH command still resolves",
  );
});

test("(b): a row that does not resolve in that directory is refused, naming it", () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "close-gate-elsewhere-"));
  const refused = findGateRowViolation(LOCAL_ROW, 0, "completed", { cwd: elsewhere });
  assert.ok(refused, "the same row from another directory must be refused");
  assert.equal(refused.predicate, "b", JSON.stringify(refused));
  assert.ok(
    refused.detail.includes(elsewhere),
    `the detail must name the directory the look-up ran in: ${refused.detail}`,
  );
});

test("(b): with no cwd the look-up is this process's, and the detail keeps its shape", () => {
  const refused = findGateRowViolation(LOCAL_ROW, 0, "completed");
  assert.ok(refused, "no cwd means today's behaviour");
  assert.equal(refused.predicate, "b");
  assert.equal(
    refused.detail,
    `first token "${LOCAL_ROW}" does not resolve to an executable`,
    "a row recorded with no directory keeps the message it had",
  );
});

test("(b): a directory that no longer exists is named, and the message is kept", () => {
  const gone = join(RESOLVE_DIR, "removed-worktree");
  const refused = findGateRowViolation(LOCAL_ROW, 0, "completed", { cwd: gone });
  assert.ok(refused, "nothing resolves in a directory that is not there");
  assert.equal(refused.predicate, "b");
  assert.match(refused.detail, /does not resolve to an executable/, refused.detail);
  assert.ok(refused.detail.includes(gone), `the detail must name the directory: ${refused.detail}`);
});

test("the deliberate non-catch: `false` with exit 0 is well formed and stays accepted", () => {
  assert.equal(
    findGateRowViolation("false", 0, "completed"),
    null,
    "a fake gate is well formed; catching it is the effect gate's job, not this one's",
  );
});

test("(c): a top-level decoration that hands the exit to something else is refused", () => {
  const refused = [
    "npm run ci:check; 107 checks, 0 failures",
    "npm run ci:check # 107 checks, 0 failures",
    "npm run ci:check\necho done",
    "npm run ci:check &",
  ];
  for (const cmd of refused) {
    const verdict = findGateRowViolation(cmd, 0, "completed");
    assert.ok(verdict, `must be refused: ${JSON.stringify(cmd)}`);
    assert.equal(verdict.predicate, "c", `${cmd} -> ${JSON.stringify(verdict)}`);
  }
});

test("(c) leaves honest shell syntax alone: quoting, substitutions, pipelines, redirections, && chains", () => {
  const accepted = [
    "npm run ci:check 2>&1 | tail -20",
    "cd packages/core && npm run ci:check",
    `git grep -nE "a;b" -- x`,
    `node -e "console.log($(echo 1; echo 2))"`,
    'VAR="a b" npm run ci:check',
    "npm run ci:check > /tmp/out.txt",
  ];
  for (const cmd of accepted) {
    assert.equal(
      findGateRowViolation(cmd, 0, "completed"),
      null,
      `honest shell syntax must stay accepted: ${cmd}`,
    );
  }
});

test("(c) scans quotes and substitutions instead of matching raw characters", () => {
  assert.equal(findTopLevelDecoration("echo '# not a comment'"), null);
  assert.equal(findTopLevelDecoration("echo \\# literal"), null);
  assert.equal(findTopLevelDecoration("echo foo#bar"), null);
  assert.equal(findTopLevelDecoration('echo ";"'), null);
  assert.equal(findTopLevelDecoration("echo `date; date`"), null);
  assert.equal(findTopLevelDecoration("echo $(echo a; echo b)"), null);
  assert.equal(findTopLevelDecoration("echo 2>&1"), null);
  assert.equal(findTopLevelDecoration("echo a; echo b"), ";");
  assert.equal(findTopLevelDecoration("echo a # b"), "comment");
  assert.equal(findTopLevelDecoration("echo a\necho b"), "newline");
  assert.equal(findTopLevelDecoration("sleep 1 &"), "&");
  assert.equal(findTopLevelDecoration("echo a && echo b"), null);
});

test("env prefixes are stripped, quoted values included, before the first token is read", () => {
  assert.equal(firstCommandToken("PI_TEST_TIMEOUT_MS=90000 npm run ci:check"), "npm");
  assert.equal(firstCommandToken('VAR="a b" node x.mjs'), "node");
  assert.equal(firstCommandToken("  git status"), "git");
  assert.equal(firstCommandToken("VAR=1"), null, "assignments alone name no command");
});

// ── the mode: settings resolver ─────────────────────────────────────────────

test("the settings resolver defaults to shadow and falls back to it on junk", () => {
  assert.equal(CLOSE_GATE_WELL_FORMEDNESS_DEFAULTS.mode, "shadow");
  assert.equal(resolveCloseGateWellFormedness(undefined).mode, "shadow");
  assert.equal(resolveCloseGateWellFormedness(null).mode, "shadow");
  assert.equal(resolveCloseGateWellFormedness("enforce").mode, "enforce");
  assert.equal(resolveCloseGateWellFormedness("off").mode, "off");
  assert.equal(resolveCloseGateWellFormedness("banana").mode, "shadow", "a typo must not disarm the read");
  assert.equal(resolveCloseGateWellFormedness({ mode: "enforce" }).mode, "shadow");
});

// ── the close path, driven through the real registered tool ─────────────────

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

test("the close-worker gates prose publishes the read and the mode key", () => {
  const gates = orchestrateTool.parameters.properties.gates.description;
  assert.match(gates, /closeGateWellFormedness/, `the published contract must name the key: ${gates}`);
  assert.match(gates, /shadow mode/, `the published contract must state the shipped default: ${gates}`);
});

function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), "close-gate-repo-"));
  return dir;
}

console.log("the close path");

await testAsync("a worker's own entry closes in shadow mode: one decorated row, one refusal line, all rows stored", async () => {
  clearMode();
  clearRefusalLog();
  const repo = scratchRepo();
  const workerId = "wf-shadow";
  await runTool({ action: "register-worker", workerId, spec: "impl", cwd: repo });

  const result = await runTool({
    action: "close-worker",
    workerId,
    cwd: repo,
    outcome: "completed",
    gates: [
      { cmd: DECORATED_CLOSE_ROW.recorded, exit: 0 },
      { cmd: HONEST_CLOSE_ROW.honest, exit: 0 },
      { cmd: "false", exit: 0 },
    ],
  });

  assert.match(toolText(result), /closed: completed/, toolText(result));
  const entry = result.details.entry;
  assert.equal(entry.status, "completed");
  assert.ok(entry.closedAt, "the close must stand in shadow mode");
  assert.equal(entry.gates.length, 3, "every row is stored, the decorated one included");
  assert.equal(entry.gates[0].cmd, DECORATED_CLOSE_ROW.recorded, "the stored cmd is the recorded field, verbatim");
  assert.ok(
    entry.gates.every((gate) => typeof gate.at === "string" && gate.at.length > 0),
    "each stored row carries its stamp",
  );

  const lines = refusalLines();
  assert.equal(lines.length, 1, `exactly one refusal line expected: ${JSON.stringify(lines)}`);
  const line = lines[0];
  assert.equal(line.workerId, workerId);
  assert.equal(line.row, 0, "the row index is the gate evidence index");
  assert.equal(line.predicate, "a");
  assert.equal(line.mode, "shadow");
  assert.equal(line.outcome, "completed");
  assert.equal(line.cmd, DECORATED_CLOSE_ROW.recorded);
  assert.ok(typeof line.at === "string" && line.at.length > 0);
  assert.ok(typeof line.detail === "string" && line.detail.length > 0);
  assert.ok(
    closeGateRefusalLogPath().startsWith(FAKE_HOME),
    "the log must land under the pinned braid root, not the live tree",
  );
});

await testAsync("enforce mode refuses the same close, naming row, predicate and cmd, and leaves the row untouched", async () => {
  setMode("enforce");
  clearRefusalLog();
  const repo = scratchRepo();
  const workerId = "wf-enforce";
  await runTool({ action: "register-worker", workerId, spec: "impl", cwd: repo });

  await assert.rejects(
    () =>
      runTool({
        action: "close-worker",
        workerId,
        cwd: repo,
        outcome: "completed",
        gates: [{ cmd: DECORATED_CLOSE_ROW.recorded, exit: 0 }],
      }),
    (error) => {
      const message = error.message;
      assert.match(message, /gates\[0\]/, message);
      assert.match(message, /predicate \(a\)/, message);
      assert.match(message, /sh -n/, message);
      assert.ok(message.includes(DECORATED_CLOSE_ROW.recorded), `the message must quote the recorded cmd: ${message}`);
      return true;
    },
  );

  const entry = readWorkers(repo).workers[workerId];
  assert.equal(entry.closedAt, null, "a refused close stamps nothing");
  assert.equal(entry.status, "admitted", "the status is untouched");
  assert.equal(entry.gates.length, 0, "no gate row is stored");
  const lines = refusalLines();
  assert.equal(lines.length, 1, `the enforce refusal is recorded once: ${JSON.stringify(lines)}`);
  assert.equal(lines[0].mode, "enforce");
  assert.equal(lines[0].predicate, "a");
});

await testAsync("off mode closes the same decorated row and logs nothing", async () => {
  setMode("off");
  clearRefusalLog();
  const repo = scratchRepo();
  const workerId = "wf-off";
  await runTool({ action: "register-worker", workerId, spec: "impl", cwd: repo });

  const result = await runTool({
    action: "close-worker",
    workerId,
    cwd: repo,
    outcome: "completed",
    gates: [{ cmd: DECORATED_CLOSE_ROW.recorded, exit: 0 }],
  });
  assert.equal(result.details.entry.status, "completed");
  assert.equal(refusalLines().length, 0, "off writes no refusal line");
});

await testAsync("a planted falsifier closes in enforce mode: stored with its code, printed as fail", async () => {
  setMode("enforce");
  clearRefusalLog();
  const repo = scratchRepo();
  const workerId = "wf-falsifier";
  await runTool({ action: "register-worker", workerId, spec: "impl", cwd: repo });

  const result = await runTool({
    action: "close-worker",
    workerId,
    cwd: repo,
    outcome: "completed",
    gates: [
      { cmd: "npm run typecheck", exit: 0 },
      { cmd: 'node -e "process.exit(1)"', exit: 1, expect: "fail" },
    ],
  });

  const text = toolText(result);
  assert.match(text, /closed: completed/, text);
  assert.equal(refusalLines().length, 0, "a red control is well-formed evidence, so nothing is refused");

  const stored = result.details.entry.gates;
  assert.equal(stored[0].expect, undefined, "a pass row carries no field");
  assert.equal(stored[1].expect, "fail");
  assert.equal(stored[1].exit, 1, "the code is stored as it was produced");
  assert.ok(
    text.includes('fail: node -e "process.exit(1)" (exit 1)'),
    `the close report must mark a falsifier row as fail: ${text}`,
  );
  assert.ok(
    text.includes("ok: npm run typecheck (exit 0)"),
    `a pass row must read as ok: ${text}`,
  );
  assert.equal(
    readWorkers(repo).workers[workerId].gates[1].expect,
    "fail",
    "the field survives the registry write",
  );
});

await testAsync("enforce refuses a falsifier that passed, and stores nothing", async () => {
  setMode("enforce");
  clearRefusalLog();
  const repo = scratchRepo();
  const workerId = "wf-green-control";
  await runTool({ action: "register-worker", workerId, spec: "impl", cwd: repo });

  await assert.rejects(
    () =>
      runTool({
        action: "close-worker",
        workerId,
        cwd: repo,
        outcome: "completed",
        gates: [{ cmd: 'node -e "process.exit(0)"', exit: 0, expect: "fail" }],
      }),
    (error) => {
      assert.match(error.message, /predicate \(d\)/, error.message);
      assert.match(error.message, /proves nothing/, error.message);
      return true;
    },
  );

  const entry = readWorkers(repo).workers[workerId];
  assert.equal(entry.closedAt, null, "a refused close stamps nothing");
  assert.equal(entry.gates.length, 0, "no gate row is stored");
  const lines = refusalLines();
  assert.equal(lines.length, 1, `the refusal is recorded once: ${JSON.stringify(lines)}`);
  assert.equal(lines[0].predicate, "d");
  assert.match(lines[0].detail, /proves nothing/, lines[0].detail);
});

await testAsync("a close resolves the worker's own relative row from the worker's cwd", async () => {
  setMode("enforce");
  clearRefusalLog();
  const repo = scratchRepo();
  mkdirSync(join(repo, "bin"), { recursive: true });
  const binary = join(repo, "bin", "tract-check");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o755);
  const workerId = "wf-relative";
  await runTool({ action: "register-worker", workerId, spec: "impl", cwd: repo });

  const result = await runTool({
    action: "close-worker",
    workerId,
    cwd: repo,
    outcome: "completed",
    gates: [{ cmd: "./bin/tract-check", exit: 0 }],
  });
  assert.equal(result.details.entry.status, "completed");
  assert.equal(
    refusalLines().length,
    0,
    "the row resolves where it ran, so the close records it instead of refusing it",
  );

  // The other direction, through the same path: a worker whose own directory
  // does not hold the binary is refused, and the message names that directory.
  const empty = scratchRepo();
  const other = "wf-relative-missing";
  await runTool({ action: "register-worker", workerId: other, spec: "impl", cwd: empty });
  await assert.rejects(
    () =>
      runTool({
        action: "close-worker",
        workerId: other,
        cwd: empty,
        outcome: "completed",
        gates: [{ cmd: "./bin/tract-check", exit: 0 }],
      }),
    (error) => {
      assert.match(error.message, /predicate \(b\)/, error.message);
      assert.ok(error.message.includes(empty), `the message must name the directory: ${error.message}`);
      return true;
    },
  );
  assert.equal(readWorkers(empty).workers[other].closedAt, null);
});

await testAsync("a row with no cmd is refused by the shape check: no predicate runs and nothing is logged", async () => {
  clearMode();
  clearRefusalLog();
  const repo = scratchRepo();
  const workerId = "wf-unparseable";
  await runTool({ action: "register-worker", workerId, spec: "impl", cwd: repo });

  for (const gates of [[{}], [{ cmd: null, exit: null }], [{ cmd: "npm test" }]]) {
    await assert.rejects(
      () => runTool({ action: "close-worker", workerId, cwd: repo, outcome: "completed", gates }),
      /cmd must be a non-empty string|exit must be a number/,
      `the unparseable shape must be refused: ${JSON.stringify(gates)}`,
    );
  }
  const entry = readWorkers(repo).workers[workerId];
  assert.equal(entry.closedAt, null, "a shape refusal stamps nothing");
  assert.equal(refusalLines().length, 0, "a shape refusal is not a well-formedness refusal");
});

await testAsync("the close shape this report's own gate evidence carries passes the default validator", async () => {
  clearMode();
  clearRefusalLog();
  const repo = scratchRepo();
  const workerId = "wf-own-close";
  await runTool({ action: "register-worker", workerId, spec: "impl", cwd: repo });

  const result = await runTool({
    action: "close-worker",
    workerId,
    cwd: repo,
    outcome: "completed",
    gates: [
      { cmd: "npm run ci:check -w packages/core", exit: 0 },
      { cmd: "npm run typecheck -w packages/core", exit: 0 },
    ],
  });
  assert.equal(result.details.entry.status, "completed");
  assert.equal(
    refusalLines().length,
    0,
    "an honest close of a worker's own entry must not be flagged",
  );
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
