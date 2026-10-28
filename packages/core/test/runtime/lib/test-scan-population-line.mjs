/**
 * test-scan-population-line.mjs — a scan's read count must equal its population.
 *
 * A gate that walks the tracked index prints how many files it read against the
 * population it enumerated, and a seat transcribes that line into gate evidence
 * as a population stamp. When the first number sits below the second, the stamp
 * certifies a scan of less than the tree, and the merge path refuses it against
 * the census its revision names: the work ships without its population record.
 *
 * So the invariant held here is equality, read from the scripts themselves
 * rather than from copies of their lines:
 *
 *   - packages/core/scripts/check-placement.mjs reports the index count on both
 *     sides, so a stamp transcribed from its line matches `git ls-files | wc -l`;
 *   - packages/core/scripts/check-doc-links.mjs reports its markdown population
 *     on both sides.
 *
 * A gate whose own bytes it must not match still reads that file: the exemption
 * belongs in the printed exclusion list, where the reason a hit was not
 * reported is visible. That half is asserted too, because a silent skip reads
 * exactly like a clean file.
 *
 * Run: node test/runtime/lib/test-scan-population-line.mjs
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE is packages/core/test/runtime/lib; five levels up is the repo root.
const ROOT = join(HERE, "..", "..", "..", "..", "..");
const PLACEMENT = join(ROOT, "packages", "core", "scripts", "check-placement.mjs");
const DOC_LINKS = join(ROOT, "packages", "core", "scripts", "check-doc-links.mjs");

/** Run a gate and keep both streams; the gate's own verdict is another file's contract. */
function runGate(script, args) {
  const run = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: "utf8" });
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

/** Tracked entries at the tree the gate just walked. */
function census(...pathspec) {
  const out = execFileSync("git", ["-C", ROOT, "ls-files", ...pathspec], { encoding: "utf8" });
  return out.split("\n").filter(Boolean).length;
}

// ── check-placement: read count, enumerated population, and the self-exemption ─

const placementOut = runGate(PLACEMENT, ["--strict"]);
const placementLine = placementOut
  .split("\n")
  .find((candidate) => candidate.startsWith("Placement check"));
assert.ok(placementLine, `check-placement printed no summary line:\n${placementOut}`);

const placementShape = placementLine.match(
  /^Placement check \([\w-]+\) \u2014 (\d+) tracked files scanned of (\d+) tracked\b/,
);
assert.ok(placementShape, `check-placement summary line shape drifted: ${placementLine}`);

const read = Number(placementShape[1]);
const population = Number(placementShape[2]);
assert.equal(
  read,
  population,
  `check-placement read ${read} of ${population} tracked files: a stamp transcribed from this ` +
    `line records a population short of the census, so the scan must cover every entry it ` +
    `enumerates: ${placementLine}`,
);
assert.equal(
  population,
  census(),
  `the enumerated population must be the index the run walked: ${placementLine}`,
);

// The tool's own file is exempt from matching, not from the population: the
// exemption is a printed entry with a reason beside its hit count.
const placementLines = placementOut.split("\n");
const selfEntry = placementLines.findIndex((line) =>
  line.trim().startsWith("packages/core/scripts/check-placement.mjs ["),
);
assert.ok(
  selfEntry >= 0,
  `check-placement does not list its own file in the documented exclusions, so the ` +
    `population and the matched set differ with nothing printed to say why:\n${placementOut}`,
);
assert.ok(
  placementLines[selfEntry + 1]?.trim().startsWith("reason: "),
  `the exclusion for the tool's own file carries no printed reason:\n${placementOut}`,
);

// ── check-doc-links: its markdown population, both sides ─────────────────────

const docLinksOut = runGate(DOC_LINKS, []);
const docLinksLine = docLinksOut
  .split("\n")
  .find((candidate) => candidate.includes("tracked markdown files scanned"));
assert.ok(docLinksLine, `check-doc-links printed no population line:\n${docLinksOut}`);

const docLinksShape = docLinksLine.match(/(\d+) of (\d+) tracked markdown files scanned/);
assert.ok(docLinksShape, `check-doc-links population line shape drifted: ${docLinksLine}`);

const markdownRead = Number(docLinksShape[1]);
const markdownPopulation = Number(docLinksShape[2]);
assert.equal(
  markdownRead,
  markdownPopulation,
  `check-doc-links read ${markdownRead} of ${markdownPopulation} tracked markdown files: ` +
    `the two numbers are the population record, so they must agree: ${docLinksLine}`,
);
assert.equal(
  markdownPopulation,
  census("*.md"),
  `the markdown population must be the tracked set the run walked: ${docLinksLine}`,
);

console.log(`  [ok] ${placementLine}`);
console.log(`  [ok] ${docLinksLine.trim()}`);
console.log("\nRESULT: PASS (2 cases)");
