/**
 * Runtime test for harness proposer (src/lib/harness/harness-proposer.ts).
 *
 * Tests parseCandidates — the most fragile part of the proposer — with
 * fixture LLM output. Does NOT make real LLM calls.
 *
 * Failure mode: if the LLM output format changes, parseCandidates returns
 * 0 candidates. This test catches format drift early.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE = join(ROOT, "src", "lib", "harness", "harness-proposer.ts");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`PASS: ${msg}`);
  } else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

// ── Verify source exports ────────────────────────────────────────────────────

assert(existsSync(SOURCE), `Source file exists: ${SOURCE}`);

const source = readFileSync(SOURCE, "utf-8");

// Check that parseCandidates is exported
assert(
  source.includes("export function parseCandidates"),
  "parseCandidates is exported from harness-proposer.ts"
);

// Check that generateProposal is exported
assert(
  source.includes("export async function generateProposal"),
  "generateProposal is exported from harness-proposer.ts"
);

// Check that generateAllPendingProposals is exported
assert(
  source.includes("export async function generateAllPendingProposals"),
  "generateAllPendingProposals is exported from harness-proposer.ts"
);

// ── Verify parser constants ──────────────────────────────────────────────────

assert(source.includes("K_CANDIDATES"), "K_CANDIDATES constant defined");
assert(source.includes("ACTIONABLE_SEVERITY"), "ACTIONABLE_SEVERITY constant defined");
assert(
  source.includes("PROPOSER_TIMEOUT_MS"),
  "PROPOSER_TIMEOUT_MS constant defined"
);
assert(
  source.includes("PROPOSER_MAX_TOKENS"),
  "PROPOSER_MAX_TOKENS constant defined"
);

// ── Verify prompt construction ───────────────────────────────────────────────

assert(
  source.includes("--- CANDIDATE 1 ---"),
  "Parser expects CANDIDATE N markers"
);
assert(
  source.includes("--- END CANDIDATE ---"),
  "Parser expects END CANDIDATE markers"
);
assert(
  source.includes("Label:"),
  "Parser expects Label: field"
);
assert(
  source.includes("Change:"),
  "Parser expects Change: field"
);
assert(
  source.includes("Rationale:"),
  "Parser expects Rationale: field"
);
assert(
  source.includes("Effort:"),
  "Parser expects Effort: field"
);

// ── Verify surface context reading ───────────────────────────────────────────

assert(
  source.includes("readSurfaceContext"),
  "readSurfaceContext function exists"
);
assert(
  source.includes('case "system-prompt"'),
  "Surface context covers system-prompt"
);
assert(
  source.includes('case "tool-description"'),
  "Surface context covers tool-description"
);
assert(
  source.includes('case "enforcement-signal"'),
  "Surface context covers enforcement-signal"
);
assert(
  source.includes('case "heuristic"'),
  "Surface context covers heuristic"
);

// ── Verify LLM integration ───────────────────────────────────────────────────

assert(
  source.includes("callLlm("),
  "Uses callLlm for proposal generation"
);
assert(
  source.includes("resolveUtilityModel"),
  "Uses resolveUtilityModel for model selection"
);
assert(
  source.includes("ctx.modelRegistry.getApiKeyForProvider"),
  "Uses modelRegistry for API key resolution"
);

// ── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n📊 ${passed}/${total} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);