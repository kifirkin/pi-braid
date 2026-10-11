/**
 * test-placement-budget.mjs — the exclusion list is capped, and the cap bites.
 *
 * check-placement.mjs skips itself, reads `git ls-files` from the repo root
 * three levels up, and caps its hand-justified exclusion list with
 * EXCLUSION_BUDGET. A cap that has never been seen failing is not a cap, so
 * this file proves both sides:
 *
 *   1. a copy of the script whose exclusion list exceeds the budget fails
 *      strict mode and names the budget in its output;
 *   2. the same copy in report-only mode still exits 0;
 *   3. the real script stays within budget on the current tree.
 *
 * The copy is built from the real source, so a revert of the budget check
 * makes case 1 fail. It is placed at the same relative depth inside a
 * throwaway git tree, so the script's three-levels-up `root` resolves to
 * that tree and the real checkout is never written to. The budget constant
 * is read from the source, so a deliberate bump is tracked instead of
 * pinned here.
 *
 * The mutant is executed, and both verdicts are read from its exit status:
 * a copy that cannot parse exits non-zero, the same status case 1 asserts, so
 * the copy is guarded before it runs. A broken mutant stops at the guard, by
 * name, instead of being read as a budget failure that never happened.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertFixtureParses } from "./fixture-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const SCRIPT = join(ROOT, "scripts", "check-placement.mjs");
const SOURCE = readFileSync(SCRIPT, "utf8");

const BUDGET_MATCH = SOURCE.match(/const EXCLUSION_BUDGET = (\d+);/);
assert.ok(BUDGET_MATCH, "check-placement.mjs must declare a numeric EXCLUSION_BUDGET");
const BUDGET = Number(BUDGET_MATCH[1]);

/** The real source with synthetic entries pushing the exclusion list over budget. */
function overBudgetSource() {
  const injected = Array.from(
    { length: BUDGET + 1 },
    (_, i) =>
      `  { path: "__budget_probe__/${i}/", classes: ["domain-literal"], reason: "synthetic over-budget entry injected by the budget test" },`,
  ).join("\n");
  const mutated = SOURCE.replace("const EXCLUSIONS = [", `const EXCLUSIONS = [\n${injected}`);
  assert.notEqual(mutated, SOURCE, "EXCLUSIONS declaration not found in check-placement.mjs");
  return mutated;
}

function run(scriptPath, args, cwd) {
  const result = spawnSync("node", [scriptPath, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
}

/** Run a mutated copy inside a throwaway git tree, then remove the tree. */
function runOverBudgetCopy(args) {
  const tree = mkdtempSync(join(tmpdir(), "placement-budget-"));
  try {
    const scriptsDir = join(tree, "packages", "core", "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    const copy = join(scriptsDir, "check-placement.mjs");
    writeFileSync(copy, overBudgetSource());
    assertFixtureParses(copy);
    for (const gitArgs of [["init", "-q"], ["add", "-A"]]) {
      const git = spawnSync("git", gitArgs, { cwd: tree, encoding: "utf8" });
      assert.equal(git.status, 0, `git ${gitArgs.join(" ")} failed: ${git.stderr}`);
    }
    return run(copy, args, tree);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

describe("placement exclusion budget", () => {
  it("fails strict mode when the exclusion list grows past the budget", () => {
    const { status, out } = runOverBudgetCopy(["--strict"]);
    assert.equal(status, 1, out);
    const exceeded = out.match(/Exclusion budget exceeded: (\d+) entries > (\d+)/);
    assert.ok(exceeded, `budget failure message missing from output:\n${out}`);
    assert.ok(
      Number(exceeded[1]) > Number(exceeded[2]),
      `expected used > budget, got "${exceeded[0]}"`,
    );
    assert.match(out, /0 hit\(s\) reported/, "the failure must be the budget, not a scan hit");
  });

  it("keeps report-only mode at exit 0 while still naming the budget", () => {
    const { status, out } = runOverBudgetCopy([]);
    assert.equal(status, 0, out);
    assert.match(out, /Exclusion budget: \d+\/\d+ entries used/);
    assert.match(out, /Exclusion budget exceeded:/);
  });

  it("stays within budget on the current tree", () => {
    const { status, out } = run(SCRIPT, ["--strict"], ROOT);
    assert.equal(status, 0, out);
    const budgetLine = out.match(/Exclusion budget: (\d+)\/(\d+) entries used/);
    assert.ok(budgetLine, `budget line missing from output:\n${out}`);
    assert.ok(
      Number(budgetLine[1]) <= Number(budgetLine[2]),
      `used ${budgetLine[1]} entries exceeds budget ${budgetLine[2]}`,
    );
  });
});
