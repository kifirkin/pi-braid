/**
 * Test: a failing file's own reason reaches the run, bounded, and a passing
 * file's body does not.
 *
 * The runner walks 300 files and reports one line each, so before this it
 * reported a red file by name and totals while the assertion that failed - the
 * only place a failure says why - was dropped with the child's streams. A red
 * run then cost a second run of the file by hand, and on CI that meant a
 * container to find a message the process had already printed.
 *
 * Pinned here, over a bench tree so the real suite is not touched:
 *   - the assertion text of a failing file is printed under its line;
 *   - a passing file's body is not: the run stays a summary plus the failures;
 *   - a file that prints more than the budget has its output bounded, and the
 *     block says how many lines were left out;
 *   - the totals still name every failed file, so the tail of a long run is
 *     still the list of what broke;
 *   - the run exits non-zero when any file fails.
 *
 * Run: node test/runtime/test-runner-failure-output.mjs
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../../scripts/run-tests.mjs");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  [fail] ${name}: ${error.message}`);
  }
}

/**
 * A bench package: the runner under test, plus the files it will walk. The
 * runner resolves its tree from its own location, so copying it into
 * `<bench>/scripts` is what makes the bench the suite it runs.
 */
function bench(files) {
  const dir = mkdtempSync(join(tmpdir(), "runner-failure-output-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "test/runtime"), { recursive: true });
  writeFileSync(join(dir, "scripts/run-tests.mjs"), readFileSync(RUNNER, "utf8"));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(dir, "test/runtime", name), source);
  }
  const run = spawnSync(process.execPath, ["scripts/run-tests.mjs"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PI_TEST_TIMEOUT_MS: "10000" },
  });
  return { ...run, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

const BOOM = `import { strict as assert } from "node:assert";
console.log("  [ok] a passing arm");
assert.equal("got", "wanted", "the reason nobody could read");
`;

const PASS = `console.log("  a passing file's own body, printed nowhere");
console.log("Results: 4 passed, 0 failed");
`;

const CHATTY = `for (let i = 0; i < 500; i += 1) console.log(\`step \${i}\`);
throw new Error("buried under the steps");
`;

const run = bench({ "test-boom.mjs": BOOM, "test-pass.mjs": PASS, "test-chatty.mjs": CHATTY });

check("the run exits non-zero when a file fails", () => {
  assert.equal(run.status, 1, `the runner reports failure by exit code (output: ${run.output.slice(-400)})`);
});

check("a failing file's assertion text is printed under its line", () => {
  assert.match(run.output, /\[1\/3\] test-boom\.mjs|\] test-boom\.mjs/, "the file is named");
  assert.match(
    run.output,
    /the reason nobody could read/,
    "the assertion's own message reaches the run, so a red file does not need a second run to read",
  );
  assert.match(run.output, /its own output/, "the block is labelled as the file's own text");
});

check("a passing file's body is not printed", () => {
  assert.match(run.output, /test-pass\.mjs/, "the passing file is still named");
  assert.doesNotMatch(
    run.output,
    /a passing file's own body, printed nowhere/,
    "a green file contributes its summary line only; the block belongs to failures",
  );
});

check("a file that prints more than the budget has its output bounded", () => {
  const lines = run.output.split("\n");
  const gutter = lines.filter((line) => line.startsWith("     | "));
  const block = gutter.filter((line) => /step \d+|buried under the steps/.test(line));
  assert.ok(block.length > 0, "the chatty file's output is shown at all");
  assert.ok(
    block.length <= 40,
    `at most 40 of the chatty file's lines are printed, and ${block.length} were`,
  );
  assert.match(run.output, /earlier lines? omitted/, "the block says how much it left out");
  assert.match(run.output, /buried under the steps/, "the reason in the last line survives the bound");
  assert.match(run.output, /node test\/runtime\/test-chatty\.mjs/, "the block names the command that prints the rest");
});

check("the totals still name every failed file", () => {
  assert.match(run.output, /2 failed/, "the totals count the failures");
  assert.match(run.output, /Failed: .*test-boom\.mjs/, "the first failure is listed");
  assert.match(run.output, /Failed: .*test-chatty\.mjs/, "the second failure is listed");
  assert.doesNotMatch(run.output, /Failed: .*test-pass\.mjs/, "a passing file is not listed as failed");
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
