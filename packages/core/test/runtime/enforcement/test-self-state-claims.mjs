/**
 * Test: self-state claim class in the verification judge.
 *
 * Motivation (probe): delivery/liveness self-state claims were asserted
 * 10/10 with honest nuance 0/10 - the judge had no decisive in-session check
 * for "messages reach me". covers the prompt side (state-aware TG row);
 * this is the enforcement side.
 *
 * Fixtures under test (brief):
 * 1. Planted claim + no probe in window -> section renders, candidate
 * listed verbatim.
 * 2. Same claim + probe call in the window (toolsUsed / taskEvidence /
 * toolLog) -> no candidates, no section.
 * 3. Non-self-state claim -> no candidates (negative control).
 * 4. False-positive sanity for the term list + byte-stability of the
 * no-candidate prompt (no unconditional token growth).
 *
 * Deliberate-update note: fixture 12 pins the EXACT bytes of a
 * no-candidate prompt (golden string). Any intentional formatting change in
 * buildVerificationPrompt must update that golden in the same commit - it
 * exists to prove the detector adds nothing when there is nothing to add.
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

console.log("=== self-state claim class ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

const judge = await import(join(ROOT, "dist/extensions/enforcement/verification-judge.js"));
const selfState = await import(join(ROOT, "dist/extensions/enforcement/self-state-claims.js"));

const CLAIM_TEXT = "The poller is running and the owner can reach me anytime.";

/** Minimal JudgeContext shape; lastResponse overridden per fixture. */
function ctxOf(overrides) {
  return {
    userRequest: "Ship the report",
    toolsUsed: ["bash", "finalize"],
    toolLog: ["Turn 2: [finalize]"],
    hasCodeChanges: false,
    lastResponse: "done",
    thinking: "",
    ...overrides,
  };
}

// ── 1. Planted claim + no probe -> candidates + rendered section ────────────

await test("fixture 1: planted claim with no probe -> candidate listed verbatim", async () => {
  const claims = selfState.findSelfStateClaims({
    responseText: CLAIM_TEXT,
    toolsUsed: ["bash", "finalize"],
  });
  assert.strictEqual(claims.length, 1, `exactly one candidate (got ${JSON.stringify(claims)})`);
  assert.strictEqual(claims[0].claim, CLAIM_TEXT, "claim listed verbatim");
  assert.strictEqual(claims[0].patternId, "channel-liveness-subject", "matched pattern id");
});

await test("fixture 1: prompt renders SELF-STATE CLAIMS section with rule", async () => {
  const prompt = judge.buildVerificationPrompt(ctxOf({ lastResponse: CLAIM_TEXT }));
  assert.ok(prompt.includes("## SELF-STATE CLAIMS"), "section present");
  assert.ok(prompt.includes(`- "${CLAIM_TEXT}"`), "claim listed verbatim in prompt");
  assert.ok(
    prompt.includes("session_health, health_maintenance, tunnel_status, v2raytun_status, telegram_send"),
    "rule names the probe set",
  );
  assert.ok(prompt.includes('category "claim"'), "rule names the issue category");
  // Section sits immediately after the claim surface it audits.
  const responseIdx = prompt.indexOf("## AGENT RESPONSE");
  const claimsIdx = prompt.indexOf("## SELF-STATE CLAIMS");
  assert.ok(claimsIdx > responseIdx, "section follows AGENT RESPONSE");
  assert.ok(prompt.trimEnd().endsWith("must NOT be flagged."), "section is the final section");
});

// ── 2. Probe call in the evidence window -> suppressed ──────────────────────

await test("fixture 2a: probe in toolsUsed -> no candidates, no section", async () => {
  const claims = selfState.findSelfStateClaims({
    responseText: CLAIM_TEXT,
    toolsUsed: ["bash", "session_health"],
  });
  assert.deepStrictEqual(claims, [], "no candidates when a probe was used");
  assert.ok(
    !judge
      .buildVerificationPrompt(
        ctxOf({ lastResponse: CLAIM_TEXT, toolsUsed: ["bash", "session_health"] }),
      )
      .includes("## SELF-STATE CLAIMS"),
    "no section when a probe was used",
  );
});

await test("fixture 2b: probe in taskEvidence -> no candidates", async () => {
  const claims = selfState.findSelfStateClaims({
    responseText: CLAIM_TEXT,
    toolsUsed: ["bash"],
    taskEvidence: ['09:01:00 telegram_send [OK]: {"ok":true,"message_id":42}'],
  });
  assert.deepStrictEqual(claims, [], "evidence-window probe suppresses candidates");
});

await test("fixture 2c: probe in toolLog -> no candidates", async () => {
  const claims = selfState.findSelfStateClaims({
    responseText: CLAIM_TEXT,
    toolsUsed: ["bash"],
    toolLog: ["Turn 3: [v2raytun_status] tunnel up"],
  });
  assert.deepStrictEqual(claims, [], "current-window probe suppresses candidates");
});

await test("fixture 2d: the general tunnel_status probe -> no candidates", async () => {
  const claims = selfState.findSelfStateClaims({
    responseText: CLAIM_TEXT,
    toolsUsed: ["bash", "tunnel_status"],
  });
  assert.deepStrictEqual(claims, [], "general probe tool suppresses candidates");
});

// ── 3. Negative control: non-self-state claims ──────────────────────────────

await test("fixture 3: non-self-state claim -> no candidates (negative control)", async () => {
  for (const text of [
    "Implemented the fix, tests pass.",
    "All 12 tests pass and typecheck is clean.",
    "Refactored the handler and updated the docs.",
  ]) {
    const claims = selfState.findSelfStateClaims({ responseText: text, toolsUsed: ["bash"] });
    assert.deepStrictEqual(claims, [], `no candidates for: "${text}"`);
  }
});

// ── 4. False-positive sanity (term-list boundaries) ─────────────────────────

await test("fixture 4: bare 'running' without a self-state subject does not match", async () => {
  const claims = selfState.findSelfStateClaims({
    responseText: "Running the full test suite now. Tests are running clean.",
    toolsUsed: ["bash"],
  });
  assert.deepStrictEqual(claims, [], "subject guard keeps test-running out of the class");
});

await test("fixture 4: 'deliverables' does not match the delivery term", async () => {
  const claims = selfState.findSelfStateClaims({
    responseText: "Deliverables manifest lists 3 files; the report was delivered to disk.",
    toolsUsed: ["bash"],
  });
  // "delivered to disk"IS a delivery-claim match (recall-biased); the point
  // is that the word "deliverables"alone does not trigger. Use a text where
  // only the deliverables mention exists.
  assert.ok(
    selfState.findSelfStateClaims({
      responseText: "Deliverables manifest lists 3 files.",
      toolsUsed: ["bash"],
    }).length === 0,
    "'deliverables' alone is not a delivery claim",
  );
  assert.deepStrictEqual(
    claims.length >= 1,
    true,
    "'delivered' alone still matches (recall-biased)",
  );
});

await test("fixture 4: 'resent' does not match 'sent' (word boundary)", async () => {
  assert.deepStrictEqual(
    selfState.findSelfStateClaims({
      responseText: "The flaky test was resent to the queue.",
      toolsUsed: ["bash"],
    }),
    [],
    "no word boundary inside 'resent'",
  );
});

await test("fixture 4: hedged/negative self-state is exempt (never punish the hedge)", async () => {
  for (const text of [
    "The poller is not running; reachability unverified.",
    "Messages may not arrive while the poller is off.",
    "The tunnel might be down; I cannot confirm without a probe.",
    "TG inbound reachability unknown right now.",
  ]) {
    assert.deepStrictEqual(
      selfState.findSelfStateClaims({ responseText: text, toolsUsed: ["bash"] }),
      [],
      `hedged/negative claim exempt: "${text}"`,
    );
  }
});

await test("fixture 4: a clause naming a probe tool is exempt (probe awareness)", async () => {
  assert.deepStrictEqual(
    selfState.findSelfStateClaims({
      responseText: "I called session_health and the session is healthy.",
      toolsUsed: ["bash"],
    }),
    [],
    "citing the check exempts the clause",
  );
});

await test("fixture 4: interrogatives are not assertions", async () => {
  assert.deepStrictEqual(
    selfState.findSelfStateClaims({
      responseText: "Is the poller running? Let me check.",
      toolsUsed: ["bash"],
    }),
    [],
    "questions do not become candidates",
  );
});

await test("fixture 4: chunk-summary evidence without a probe name still renders (FN-safe)", async () => {
  // A summarized evidence chunk may not name the probe tool; the deterministic
  // scan then renders the section, and the LLM arbitrates against the full
  // sections above. Missing a render is benign; suppressing a real claim is
  // the failure mode.
  const claims = selfState.findSelfStateClaims({
    responseText: CLAIM_TEXT,
    toolsUsed: ["bash"],
    taskEvidence: ["(chunk 1/2 summary) S1"],
  });
  assert.strictEqual(claims.length, 1, "summary line does not count as a probe");
  assert.ok(
    judge
      .buildVerificationPrompt(
        ctxOf({ lastResponse: CLAIM_TEXT, taskEvidence: ["(chunk 1/2 summary) S1"] }),
      )
      .includes("## SELF-STATE CLAIMS"),
    "section renders so the LLM can arbitrate",
  );
});

// ── 5. Prompt byte-stability (no unconditional token growth) ────────────────

await test("byte-stability: no-candidate prompt is byte-identical to the golden", async () => {
  // GOLDEN (deliberate-update note at file top): re-bake on intentional
  // formatting changes to buildVerificationPrompt, same commit.
  const golden =
    "## USER REQUEST\nShip the report\n\n## TOOLS USED\nbash, finalize\n\n## CODE CHANGES: NO\n\n## TOOL EXECUTION LOG\nTurn 2: [finalize]\n\n## AGENT RESPONSE (visible text)\ndone";
  assert.strictEqual(judge.buildVerificationPrompt(ctxOf({})), golden, "exact bytes preserved");
});

await test("cap: claims beyond the cap are listed with an explicit suppressed count", async () => {
  const eight =
    "The poller is running.\n" +
    "The tunnel is working.\n" +
    "The session is healthy.\n" +
    "The heartbeat is active.\n" +
    "You can reach me anytime.\n" +
    "The report was sent successfully.\n" +
    "Messages are arriving now.\n" +
    "The daemon is alive.";
  const section = selfState.renderSelfStateClaimsSection(
    selfState.findSelfStateClaims({ responseText: eight, toolsUsed: ["bash"] }),
  );
  const listed = section.split("\n").filter((l) => l.startsWith('- "'));
  assert.strictEqual(listed.length, selfState.MAX_SELF_STATE_CLAIMS_IN_PROMPT, "cap honored");
  assert.ok(
    /\(2 more matched claim\(s\) suppressed, cap 6\)/.test(section),
    "explicit suppressed-count line present",
  );
});

// ── 6. parseVerificationOutput schema unchanged ─────────────────────────────

await test("parseVerificationOutput schema unchanged; category 'claim' parses", async () => {
  const raw =
    '```json\n{"verdict":"warn","confidence":80,"summary":"self-state claim without probe",' +
    '"issues":[{"severity":"medium","category":"claim","description":"claimed delivery without a probe call"}],' +
    '"unverifiedChanges":false}\n```';
  const parsed = judge.parseVerificationOutput(raw);
  assert.ok(parsed, "parses");
  assert.strictEqual(parsed.verdict, "warn");
  assert.strictEqual(parsed.issues.length, 1);
  assert.strictEqual(parsed.issues[0].category, "claim", "claim category round-trips");
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== self-state claim class passed ===");
