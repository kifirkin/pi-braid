/**
 * test-placement-summary-line.mjs — the summary line is the stamp's printed source.
 *
 * A population stamp is transcribed from the gate's own output, and the merge
 * path later compares that population against the census of the revision the
 * line names. A refactor that drops either number or the revision turns every
 * stamp derived from the line into an unreadable one, so this pins the shape:
 *
 *   - the files the run read (strictly fewer than the population: the gate
 *     skips its own file);
 *   - the enumerated population it was over (the index it walked, which must
 *     equal `git ls-files` at run time);
 *   - the revision the scan certifies (the branch the tree is on, the short
 *     sha when HEAD is detached).
 *
 * The run happens through the real script, so the line under test is the one a
 * seat transcribes, not a copy's.
 *
 * Run: node test/runtime/lib/test-placement-summary-line.mjs
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE is packages/core/test/runtime/lib; five levels up is the repo root.
const ROOT = join(HERE, "..", "..", "..", "..", "..");
const SCRIPT = join(ROOT, "packages", "core", "scripts", "check-placement.mjs");

const gitText = (...args) =>
  execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf-8" }).trim();

const out = execFileSync("node", [SCRIPT, "--strict"], { cwd: ROOT, encoding: "utf8" });
const line = out.split("\n").find((candidate) => candidate.startsWith("Placement check (strict)"));
assert.ok(line, `summary line missing from the run:\n${out}`);

const shape = line.match(
  /^Placement check \(strict\) \u2014 (\d+) tracked files scanned of (\d+) tracked at (\S+)$/,
);
assert.ok(shape, `summary line shape drifted: ${line}`);

const read = Number(shape[1]);
const population = Number(shape[2]);
const revision = shape[3];

const tracked = gitText("ls-files").split("\n").filter(Boolean);
assert.equal(
  population,
  tracked.length,
  `the enumerated population must be the index the run walked: ${line}`,
);
assert.ok(read > 0 && read < population, `read count must sit below the population: ${line}`);

const branch = gitText("rev-parse", "--abbrev-ref", "HEAD");
const expected = branch && branch !== "HEAD" ? branch : gitText("rev-parse", "--short", "HEAD");
assert.equal(revision, expected, `the revision must be the ref the tree is on: ${line}`);

console.log(`  [ok] summary line: ${line}`);
console.log("\nRESULT: PASS (1 case)");
