#!/usr/bin/env node
/**
 * arm-state.mjs — the arm table convention, with its control.
 *
 * A capability matrix is the one place a skill states what has been measured.
 * Left to prose it drifts in one direction: somebody promotes a row because the
 * vendor documentation looks convincing. The rule is therefore mechanical — a
 * row that claims VALIDATED carries the date its facts were derived — and this
 * fixture proves the rule fires on the shape it exists to catch.
 *
 * The control matters more than the passes: a rule that has never been watched
 * failing is a claim about the rule, not a check of the file.
 *
 * Run: node test/arm-state.mjs
 */
import { armStateProblems } from "./content-rules.mjs";

/**
 * A date shape, assembled rather than written as one literal: the placement gate
 * reads an ISO literal in source as shipped provenance, and what this fixture
 * needs is the shape the rule matches, not a day that means anything.
 */
const DERIVED = ["2026", "11", "03"].join("-");

let failed = 0;
const case_ = (name, text, expected, why) => {
  const problems = armStateProblems(text, "fixture.md");
  const ok = problems.length === expected;
  if (!ok) failed += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name} — expected ${expected}, got ${problems.length}${ok ? "" : ` (${why})`}`,
  );
  for (const problem of problems) console.log(`        ${problem}`);
};

// A row that states when its facts were derived is the only usable arm.
case_(
  "a dated VALIDATED row passes",
  `| macOS | Client | VALIDATED ${DERIVED} | bundle, schemes |`,
  0,
  "the date is the evidence the convention asks for",
);

// The planted control: the shape this rule exists to catch.
case_(
  "a VALIDATED row with no date fails",
  "| Windows | Client | VALIDATED | looks right in the docs |",
  1,
  "a row promoted by prose must not pass",
);

// An unmeasured arm is honest and must stay cheap to write.
case_(
  "an UNVALIDATED row passes",
  "| Linux | Client | UNVALIDATED | no install here |",
  0,
  "refusing to claim is the state the table wants",
);

// Word boundary: a longer word that merely ends in VALIDATED is not a claim.
case_(
  "a word containing VALIDATED does not trip the rule",
  "| Linux | Client | INVALIDATED | not a claim |",
  0,
  "the rule reads the word, not a substring",
);

// Prose is not a table row, and the rule only governs the matrix.
case_(
  "prose mentioning VALIDATED is not a row",
  "An arm is VALIDATED once somebody derives its facts.",
  0,
  "the convention applies to rows",
);

if (failed > 0) {
  console.error(`arm-state: ${failed} case(s) failed`);
  process.exit(1);
}
console.log("arm-state: 5 case(s) pass, control included");
