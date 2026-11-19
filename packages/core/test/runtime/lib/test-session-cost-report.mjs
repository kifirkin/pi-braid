/**
 * session-cost-report.mjs — the reader that splits a session's tokens by class
 * and by tool, and prices them only from rates the caller supplies.
 *
 * The fixture is hand-built so every number below is an arithmetic a reader can
 * redo on paper: two tools, two windows whose weights are 3:1 and 1:2, one turn
 * per bucket (prompt, aborted, no usage), one malformed line, one field a
 * provider never reported. The real sessions tree under $HOME is never read,
 * except by the two cases that prove the default root and its refusal.
 *
 * Cases:
 *   1. the four classes, hand-checked: uncached input, cached input, cache
 *      write, output, and the total that is their sum
 *   2. the per-tool split follows result characters (3:1 then 1:2), which an
 *      even split would not produce
 *   3. the per-tool columns sum to the class totals exactly, in every class
 *   4. a price is the caller's rates applied to those tokens, and nothing else
 *   5. a class with tokens and no rate is refused, and the refusal names it
 *   6. no rate flags at all: the price line says so instead of printing a zero
 *   7. a field no turn reported prints n/a, never 0
 *   8. aborted/error turns are counted, excluded from the tokens, and a turn
 *      without usage is counted rather than assumed to be zero
 *   9. malformed lines and non-object lines are counted, not dropped
 *   10. the assistant character split names prose, thinking, tool arguments
 *   11. --json carries the same totals the text render prints
 *   12. --session selects exactly the sessions named, so a census can be
 *       reproduced from the command line
 *   13. the default root is pi's sessions dir under an absolute home, and a
 *       home that is not absolute is refused instead of resolved against cwd
 *   14. bad usage exits 2; a directory with no sessions is reported, exit 0; a
 *       named file that is not there exits 2 instead of printing an empty report
 *   15. allocate() distributes whole tokens and puts the remainder on the
 *       largest fractional part, deterministically
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCRIPT = join(ROOT, "scripts", "session-cost-report.mjs");

const reader = await import(pathToFileURL(SCRIPT).href);

const text = (n) => ({ type: "text", text: "x".repeat(n) });
const think = (n) => ({ type: "thinking", text: "x".repeat(n) });
const call = (name, args) => ({ type: "toolCall", id: `call_${name}_${args.path ?? args.command}`, name, arguments: args });

let seq = 0;
function assistant({ usage, content = [], stopReason = "stop", model = "m-a" }) {
  seq += 1;
  return {
    type: "message",
    id: `a${seq}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content,
      model,
      provider: "fixture",
      stopReason,
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

function result(name, chars) {
  seq += 1;
  return {
    type: "message",
    id: `r${seq}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "toolResult", toolCallId: `call_${name}`, toolName: name, content: [text(chars)] },
  };
}

function user(value) {
  seq += 1;
  return {
    type: "message",
    id: `u${seq}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.500Z",
    message: { role: "user", content: [text(value.length)] },
  };
}

const usage = (input, output, cacheRead, cacheWrite) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  reasoning: 0,
  totalTokens: input + output + cacheRead + cacheWrite,
});

/**
 * fx-1, in file order. Windows and charges, as the reader must derive them:
 *
 *   A1  window []            -> (prompt)   input 1000  cacheRead 4000  write   0  out 100
 *   r1  read  300 chars, r2 bash 100 chars
 *   A2  window read:bash 3:1 -> read 450/1800/0/150, bash 150/600/0/50
 *   r3  bash  100 chars, r4 read 200 chars
 *   A3  window bash:read 1:2 -> bash 100/400/200/100, read 200/800/400/200
 *   A4  window []            -> (prompt)   input  900  cacheRead    0  write   0  out  90
 *   A5  no usage             -> counted, no tokens
 *   A6  aborted              -> counted, tokens excluded
 *   A7  window []            -> (prompt)   input 1100, cacheRead absent, write absent, out 110
 *   r5  edit  40 chars       -> never read by a turn (the file ends)
 *
 * Totals: uncached input 3900, cached input 7600, cache write 600, output 800.
 * Per tool: read 650/2600/400/350, bash 250/1000/200/150, (prompt) 3000/4000/0/300.
 */
function fixtureOne() {
  seq = 0;
  const lines = [
    { type: "session", version: 3, id: "fx-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/fixture" },
    user("go"),
    assistant({
      usage: usage(1000, 100, 4000, 0),
      stopReason: "toolUse",
      content: [text(100), call("read", { path: "p" }), call("bash", { command: "ls" })],
    }),
    result("read", 300),
    result("bash", 100),
    assistant({
      usage: usage(600, 200, 2400, 0),
      stopReason: "toolUse",
      content: [text(50), call("bash", { command: "rm x" }), call("read", { path: "p" })],
    }),
    result("bash", 100),
    result("read", 200),
    assistant({
      usage: usage(300, 300, 1200, 600),
      content: [think(30), text(200)],
    }),
    user("again"),
    assistant({ usage: usage(900, 90, 0, 0), content: [text(40)] }),
    assistant({ content: [text(10)], model: "m-b" }),
    assistant({ usage: usage(50, 5, 0, 0), stopReason: "aborted", content: [text(20)] }),
    "{ this line is not json",
    "[1,2,3]",
    // A7: a provider that reports neither cache field. Kept last of the billed
    // turns so its missing fields are unambiguous in the totals.
    assistant({
      usage: { input: 1100, output: 110, reasoning: 0, totalTokens: 1210 },
      content: [text(60)],
    }),
    result("edit", 40),
  ];
  return lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n");
}

/** fx-2: no turn reports a cache field, so cached input is n/a for the session. */
function fixtureTwo() {
  seq = 0;
  return [
    { type: "session", version: 3, id: "fx-2", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/fixture" },
    user("hi"),
    assistant({ usage: { input: 100, output: 10, totalTokens: 110 }, content: [text(5)] }),
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
}

const RATES = { uncachedIn: 10, cachedIn: 1, cacheWrite: 12.5, out: 40 };
const RATE_ARGS = ["--rate-in", "10", "--rate-cache-read", "1", "--rate-cache-write", "12.5", "--rate-out", "40"];

const tmpDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "session-cost-"));
  tmpDirs.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function writeSession(dir, name, body) {
  writeFileSync(join(dir, name), body);
  return join(dir, name);
}

function run(args, { env } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

/** The fixture on disk, parsed through --json, which every numeric case reads. */
function jsonOf(args, body = fixtureOne()) {
  const path = writeSession(tempDir(), "fx-1.jsonl", body);
  const out = run(["--file", path, "--json", ...args]);
  assert.equal(out.status, 0, `--json must exit 0, stderr: ${out.stderr}`);
  return JSON.parse(out.stdout);
}

test("the four classes are the recorded ones, hand-checked", () => {
  const payload = jsonOf([]);
  const session = payload.sessions[0];
  assert.equal(session.totals.uncachedIn, 3900, "uncached input total");
  assert.equal(session.totals.cachedIn, 7600, "cached input total");
  assert.equal(session.totals.cacheWrite, 600, "cache write total");
  assert.equal(session.totals.out, 800, "output total");
  assert.equal(
    session.totals.uncachedIn + session.totals.cachedIn + session.totals.cacheWrite + session.totals.out,
    12900,
    "the four classes are disjoint and sum to the session total",
  );
  assert.equal(session.turns.billed, 5, "billed turns");
});

test("the per-tool split follows result characters, not an even share", () => {
  const session = jsonOf([]).sessions[0];
  const byName = Object.fromEntries(session.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(
    byName.read.tokens,
    { uncachedIn: 650, cachedIn: 2600, cacheWrite: 400, out: 350 },
    "read holds the 3:1 window and two thirds of the 1:2 window",
  );
  assert.deepEqual(
    byName.bash.tokens,
    { uncachedIn: 250, cachedIn: 1000, cacheWrite: 200, out: 150 },
    "bash holds one quarter of the 3:1 window and one third of the 1:2 window",
  );
  assert.deepEqual(
    byName["(prompt)"].tokens,
    { uncachedIn: 3000, cachedIn: 4000, cacheWrite: 0, out: 300 },
    "a window with no tool result is charged to the prompt",
  );
  assert.equal(byName.read.resultChars, 500, "read result characters");
  assert.equal(byName.bash.resultChars, 200, "bash result characters");
  assert.equal(byName.read.calls, 2, "read calls");
  assert.equal(byName.bash.calls, 2, "bash calls");
  assert.equal(
    byName.bash.tokens.uncachedIn,
    250,
    "an even split of the 3:1 window would put 450 here, so 250 is what proves the weighting",
  );
});

test("the per-tool columns sum to the class totals in every class", () => {
  const session = jsonOf([]).sessions[0];
  for (const cls of reader.CLASSES) {
    const column = session.tools.reduce((sum, tool) => sum + tool.tokens[cls.key], 0);
    assert.equal(
      column,
      session.totals[cls.key],
      `${cls.label}: the per-tool column must sum to the class total`,
    );
    assert.equal(session.splitResidual[cls.key], 0, `${cls.label}: whole-token split leaves no residual`);
  }
});

test("a price is the caller's rates applied to the tokens, nothing else", () => {
  const session = jsonOf(RATE_ARGS).sessions[0];
  assert.equal(session.price, 0.0861, "price in USD at the supplied rates");
  const payload = jsonOf(RATE_ARGS);
  assert.deepEqual(payload.rates, RATES, "the rates the payload was priced at are the ones supplied");

  const path = writeSession(tempDir(), "fx-1.jsonl", fixtureOne());
  const rendered = run(["--file", path, ...RATE_ARGS]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /^ {4}price: 0\.0861 USD at the rates supplied$/m, "price line");
  assert.match(
    rendered.stdout,
    /uncached input: 3900 tokens x 10 USD\/1M = 0\.039000 USD/,
    "the arithmetic is printed per class",
  );
  assert.match(
    rendered.stdout,
    /cached input: 7600 tokens x 1 USD\/1M = 0\.007600 USD/,
    "cached input arithmetic",
  );
  assert.match(
    rendered.stdout,
    /cache write: 600 tokens x 12\.5 USD\/1M = 0\.007500 USD/,
    "cache write arithmetic",
  );
  assert.match(rendered.stdout, /output: 800 tokens x 40 USD\/1M = 0\.032000 USD/, "output arithmetic");
});

test("a class with tokens and no rate is refused, and the refusal names the class", () => {
  const path = writeSession(tempDir(), "fx-1.jsonl", fixtureOne());
  const out = run(["--file", path, "--rate-in", "10", "--rate-out", "40"]);
  assert.equal(out.status, 0, "a refusal to price is a report, not a usage error");
  assert.match(
    out.stdout,
    /price: n\/a, no rate for cached input \(7600 tokens, needs --rate-cache-read\), cache write \(600 tokens, needs --rate-cache-write\)/,
    "the refusal names every class it cannot price",
  );
  assert.doesNotMatch(out.stdout, /price: 0\./, "no total is printed while a class is unpriced");
  const session = jsonOf(["--rate-in", "10", "--rate-out", "40"]).sessions[0];
  assert.equal(session.price, null, "the payload carries no price, not a partial one");
  assert.deepEqual(
    session.missingRates.map((entry) => entry.key),
    ["cachedIn", "cacheWrite"],
    "missing rate classes",
  );
});

test("no rate flags at all: the price is not requested", () => {
  const path = writeSession(tempDir(), "fx-1.jsonl", fixtureOne());
  const out = run(["--file", path]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /price: not requested \(no --rate-\* flag was given\)/, "no silent zero price");
  assert.equal(jsonOf([]).sessions[0].price, null, "an unpriced payload carries no price");
});

test("a field no turn reported prints n/a, never zero", () => {
  const dir = tempDir();
  const path = writeSession(dir, "fx-2.jsonl", fixtureTwo());
  const out = run(["--file", path, "--json"]);
  const session = JSON.parse(out.stdout).sessions[0];
  assert.equal(session.totals.cachedIn, 0, "no cached tokens were read");
  assert.equal(session.unknown.cachedIn, 1, "the one billed turn omitted cacheRead");
  const rendered = run(["--file", path]);
  assert.match(rendered.stdout, /cached input +n\/a/, "cached input is n/a for the session");
  assert.match(rendered.stdout, /cache write +n\/a/, "cache write is n/a for the session");
  assert.match(rendered.stdout, /uncached input +100$/m, "a reported class still renders its number");
});

test("aborted turns are counted and excluded; a turn without usage is counted", () => {
  const session = jsonOf([]).sessions[0];
  assert.equal(session.turns.excludedAbortedOrError, 1, "aborted/error turns");
  assert.equal(session.turns.withoutUsage, 1, "turns without usage");
  assert.equal(session.turns.billed, 5, "the aborted turn's 50 input tokens are not in the totals");
  assert.equal(session.totals.uncachedIn, 3900, "uncached input excludes the aborted turn");
  const path = jsonOf([]).sessions[0].file;
  const rendered = run(["--file", path]);
  assert.match(
    rendered.stdout,
    /turns: 5 billed, 1 without usage, 1 aborted\/error \(usage not counted\)/,
    "the excluded turn is named, not silently dropped",
  );
});

test("malformed lines and non-object lines are counted, not dropped", () => {
  const session = jsonOf([]).sessions[0];
  assert.equal(session.malformed, 2, "one unparseable line and one JSON array");
  const path = session.file;
  const rendered = run(["--file", path]);
  assert.match(rendered.stdout, /, malformed lines: 2/, "the render carries the count");
});

test("the assistant character split names prose, thinking and tool arguments", () => {
  const session = jsonOf([]).sessions[0];
  assert.equal(session.content.prose, 480, "prose characters");
  assert.equal(session.content.thinking, 30, "thinking characters");
  assert.equal(session.content.toolArgs, 58, "tool argument characters");
  const path = session.file;
  const rendered = run(["--file", path]);
  assert.match(
    rendered.stdout,
    /assistant characters \(all turns\): prose 480 \(84\.5%\), thinking 30 \(5\.3%\), tool arguments 58 \(10\.2%\)/,
    "the character split is rendered with its shares",
  );
});

test("--json carries the same totals the text render prints", () => {
  const payload = jsonOf([]);
  assert.equal(payload.totals.uncachedIn, 3900, "payload uncached input");
  assert.equal(payload.totals.cachedIn, 7600, "payload cached input");
  assert.equal(payload.sessions.length, 1, "one session in the payload");
  assert.equal(payload.sessions[0].sessionId, "fx-1", "the session id comes from the session record");
  const path = payload.sessions[0].file;
  const rendered = run(["--file", path]);
  assert.match(rendered.stdout, /uncached input +3900$/m, "the text render agrees with the payload");
});

test("--session selects exactly the sessions named, one level down", () => {
  const root = tempDir();
  mkdirSync(join(root, "project-a"));
  mkdirSync(join(root, "project-b"));
  writeSession(join(root, "project-a"), "s1_fx-1.jsonl", fixtureOne());
  writeSession(join(root, "project-b"), "s2_fx-2.jsonl", fixtureTwo());
  writeSession(join(root, "project-b"), "s3_fx-3.jsonl", fixtureTwo().replace('"fx-2"', '"fx-3"'));

  const found = reader.listSessionFiles(root);
  assert.equal(found.length, 3, "every *.jsonl one level down is found");

  const out = run(["--dir", root, "--session", "fx-1", "--session", "fx-3", "--json"]);
  assert.equal(out.status, 0, out.stderr);
  const payload = JSON.parse(out.stdout);
  assert.deepEqual(
    payload.sessions.map((session) => session.sessionId).sort(),
    ["fx-1", "fx-3"],
    "the census selection is exactly what was named",
  );
  assert.equal(payload.totals.uncachedIn, 3900 + 100, "the selected sessions are the ones summed");
});

test("the default root is pi's sessions dir, and a relative home is refused", () => {
  assert.ok(
    reader.piSessionsDir().endsWith(join(".pi", "agent", "sessions")),
    "the default root mirrors pi's layout",
  );
  const refused = run([], { env: { HOME: "." } });
  assert.equal(refused.status, 2, "a HOME that is not absolute is refused");
  assert.match(refused.stderr, /HOME does not resolve an absolute path/, "the refusal names the cause");
});

test("bad usage exits 2; an empty directory is a report; a missing file is not", () => {
  const bad = run(["--rate-in", "nope"]);
  assert.equal(bad.status, 2, "a rate that is not a number is refused");
  assert.match(bad.stderr, /--rate-in needs a non-negative number/, "the refusal names the flag");

  assert.equal(run(["--limit", "-1"]).status, 2, "a negative limit is refused");
  assert.equal(run(["--nonsense"]).status, 2, "an unknown argument is refused");

  const empty = tempDir();
  const emptyRun = run(["--dir", empty]);
  assert.equal(emptyRun.status, 0, "a directory with no sessions is a report, not an error");
  assert.match(emptyRun.stdout, /no session file at this path/, "the empty case says so");

  const missing = run(["--file", join(tempDir(), "absent.jsonl")]);
  assert.equal(missing.status, 2, "a named file that is not there is an operator error");
  assert.match(missing.stderr, /absent\.jsonl: no such file/, "the missing path is named");
});

test("allocate() distributes whole tokens deterministically", () => {
  assert.deepEqual(reader.allocate(0, [1, 1]), [0, 0], "a zero total allocates nothing");
  assert.deepEqual(reader.allocate(10, [1, 1, 1]), [4, 3, 3], "the remainder goes to the earliest row on a tie");
  assert.deepEqual(reader.allocate(100, [300, 100]), [75, 25], "weights of 3:1");
  assert.deepEqual(reader.allocate(7, [0, 0]), [4, 3], "no weight at all falls back to an even split");
  assert.equal(
    reader.allocate(1000, [1, 1, 1]).reduce((a, b) => a + b, 0),
    1000,
    "the parts always sum to the total",
  );
});
