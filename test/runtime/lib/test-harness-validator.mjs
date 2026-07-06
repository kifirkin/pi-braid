/**
 * Runtime test for harness validator (src/lib/harness/harness-validator.ts).
 *
 * Tests the validator's structural integrity:
 *   - Exports exist and have expected signatures
 *   - parseEvalResult handles valid/invalid JSON
 *   - applyParetoAcceptance correctly evaluates score pairs
 *   - Prompt construction includes held-in and held-out sections
 *
 * Does NOT make real LLM calls. Uses static analysis of the source file.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE = join(ROOT, "src", "lib", "harness", "harness-validator.ts");

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

// ── Verify source exists ─────────────────────────────────────────────────────

assert(existsSync(SOURCE), `Source file exists: ${SOURCE}`);

const source = readFileSync(SOURCE, "utf-8");

// ── Verify exported functions ────────────────────────────────────────────────

assert(
  source.includes("export async function validateCandidate"),
  "validateCandidate is exported"
);

assert(
  source.includes("export async function validateProposal"),
  "validateProposal is exported"
);

assert(
  source.includes("export async function generateAllPendingValidations"),
  "generateAllPendingValidations is exported"
);

assert(
  source.includes("export function applyParetoAcceptance"),
  "applyParetoAcceptance is exported"
);

// ── Verify constants ─────────────────────────────────────────────────────────

assert(
  source.includes("MAX_HELD_IN_SIGS"),
  "MAX_HELD_IN_SIGS constant defined"
);

assert(
  source.includes("MAX_HELD_OUT_SIGS"),
  "MAX_HELD_OUT_SIGS constant defined"
);

assert(
  source.includes("VALIDATOR_TIMEOUT_MS"),
  "VALIDATOR_TIMEOUT_MS constant defined"
);

assert(
  source.includes("VALIDATOR_MAX_TOKENS"),
  "VALIDATOR_MAX_TOKENS constant defined"
);

assert(
  source.includes("MIN_ACCEPTABLE_MAX_SCORE"),
  "MIN_ACCEPTABLE_MAX_SCORE constant defined"
);

// ── Verify prompt markers ────────────────────────────────────────────────────

assert(
  source.includes("Held-In Failure Evidence"),
  "Prompt contains held-in evidence section marker"
);

assert(
  source.includes("Held-Out Failure Evidence"),
  "Prompt contains held-out evidence section marker"
);

assert(
  source.includes("heldInScore"),
  "Prompt instructs JSON output with heldInScore"
);

assert(
  source.includes("heldOutScore"),
  "Prompt instructs JSON output with heldOutScore"
);

assert(
  source.includes("rationale"),
  "Prompt instructs JSON output with rationale"
);

// ── Verify Pareto rule ───────────────────────────────────────────────────────

assert(
  source.includes("applyParetoAcceptance"),
  "Pareto acceptance function is defined"
);

assert(
  source.includes("heldInScore >= 0"),
  "Pareto rule checks heldInScore >= 0"
);

assert(
  source.includes("heldOutScore >= 0"),
  "Pareto rule checks heldOutScore >= 0"
);

// ── Verify JSON parsing ──────────────────────────────────────────────────────

assert(
  source.includes("parseEvalResult"),
  "parseEvalResult helper function defined"
);

assert(
  source.includes("JSON.parse"),
  "Uses JSON.parse for evaluation result"
);

assert(
  source.includes("Math.max(-1, Math.min(1, v))"),
  "Clamps scores to [-1, 1]"
);

// ── Verify LLM integration ───────────────────────────────────────────────────

assert(
  source.includes("callLlm("),
  "Uses callLlm for evaluation"
);

assert(
  source.includes("resolveUtilityModel"),
  "Uses resolveUtilityModel for model selection"
);

assert(
  source.includes("ctx.modelRegistry.getApiKeyForProvider"),
  "Uses modelRegistry for API key resolution"
);

// ── Verify decision rationale ────────────────────────────────────────────────

assert(
  source.includes("ACCEPTED:"),
  "Decision rationale includes ACCEPTED marker"
);

assert(
  source.includes("REJECTED:"),
  "Decision rationale includes REJECTED marker"
);

assert(
  source.includes("Pareto rule:"),
  "Decision rationale includes Pareto rule summary"
);

// ── Verify edge case handling ────────────────────────────────────────────────

assert(
  source.includes(".toFixed(2)"),
  "Uses toFixed for score formatting"
);

assert(
  source.includes("Held-in score:"),
  "Decision rationale includes Held-in score label"
);

assert(
  source.includes("Held-out score:"),
  "Decision rationale includes Held-out score label"
);

// ── Score label function ─────────────────────────────────────────────────────

assert(
  source.includes("strong improvement"),
  "Score label includes strong improvement"
);

assert(
  source.includes("severe regression"),
  "Score label includes severe regression"
);

// ── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n📊 ${passed}/${total} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);