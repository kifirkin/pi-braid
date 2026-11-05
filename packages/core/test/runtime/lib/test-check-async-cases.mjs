/**
 * Test: check-async-cases catches an async case a helper never awaits, and
 * nothing else.
 *
 * The case the gate exists for is fake green, not a wrong assertion: a
 * hand-rolled helper calls `fn()` and moves on, so an `async` case's promise is
 * dropped and the file prints its pass line before the case settles.
 *
 * 1. A tree with such a helper and an async call fails, naming file and line.
 * 2. The same tree with a synchronous call passes: the gate reads the call site,
 *    not the helper's existence.
 * 3. The control: a helper that chains the promise and is called with an async
 *    case passes, so the gate does not flag the shape it is meant to accept.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "..", "..", "scripts", "check-async-cases.mjs");

const DROPPING_HELPER = `let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.log(name, error.message);
  }
}
`;

const CHAINING_HELPER = `let passed = 0;
let chain = Promise.resolve();
function check(name, fn) {
  chain = chain.then(() => fn()).then(() => { passed += 1; });
}
`;

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "check-async-cases-"));
  const dir = join(root, "packages", "fixture", "test");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf-8");
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf-8" });
}

test("an async case handed to a promise-dropping helper fails, naming the line", () => {
  const root = tree({ "bad.mjs": DROPPING_HELPER + '\ncheck("a case", async () => {});\n' });
  const r = run(root);
  assert.equal(r.status, 1, `exit 1: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /bad\.mjs:11/, "the finding names file and line");
  assert.match(r.stderr, /check\(name, async/, "the finding names the call shape");
});

test("the same helper with a synchronous case passes", () => {
  const root = tree({ "ok.mjs": DROPPING_HELPER + '\ncheck("a case", () => {});\n' });
  const r = run(root);
  assert.equal(r.status, 0, `exit 0: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /1 helper\(s\) drop the promise, 0 async case/, "the population is printed");
});

test("the control: a helper that chains the promise is not flagged", () => {
  const root = tree({ "chained.mjs": CHAINING_HELPER + '\ncheck("a case", async () => {});\n' });
  const r = run(root);
  assert.equal(r.status, 0, `a chaining helper accepts async cases: ${r.stdout}${r.stderr}`);
});
