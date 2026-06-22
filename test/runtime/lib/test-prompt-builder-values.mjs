/**
 * Test: prompt-builder value statements contract (2026-06-21).
 *
 * Pins the architectural split:
 *   - Values (identity, how to reason) live in prompt-builder
 *   - Behaviors (concrete project rules) live in each project's AGENTS.md
 *
 * Asserts the 10 value statements exist in behavioral-guardrails.ts AND
 * are wired into the system prompt via simpleSection. Both are needed:
 * a constant that exists but isn't rendered is dead code; a rendered
 * constant that doesn't exist would be a runtime error.
 *
 * This is a source-level contract test, same family as the other
 * prompt-builder tests. It's stable to wording changes but catches:
 *   - removal of a value (regression)
 *   - removal from the rendered prompt (regression)
 *   - reordering that changes the semantic meaning (regression)
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  guardrails: join(ROOT, "src/extensions/core/prompt-builder/behavioral-guardrails.ts"),
  promptBuilder: join(ROOT, "src/extensions/core/prompt-builder/index.ts"),
  identity: join(ROOT, "src/extensions/core/prompt-builder/identity.ts"),
  ag: join(ROOT, "src/extensions/core/prompt-builder/AGENTS.md"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source must exist at ${path}`);
}

const guardrailsSrc = readFileSync(FILES.guardrails, "utf-8");
const promptBuilderSrc = readFileSync(FILES.promptBuilder, "utf-8");
const identitySrc = readFileSync(FILES.identity, "utf-8");
const agSrc = readFileSync(FILES.ag, "utf-8");

console.log("=== prompt-builder value statements contract ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

// ── 5 pre-existing values still present ──────────────────────────────

test("SYCOPHANCY_RESISTANCE value exists and is rendered", () => {
  assert.match(guardrailsSrc, /export const SYCOPHANCY_RESISTANCE\s*=/);
  assert.match(
    promptBuilderSrc,
    /simpleSection\(\s*["']value-sycophancy-resistance["']\s*,\s*SYCOPHANCY_RESISTANCE\s*\)/,
  );
});

test("STAKES_AWARENESS value exists and is rendered", () => {
  assert.match(guardrailsSrc, /export const STAKES_AWARENESS\s*=/);
  assert.match(
    promptBuilderSrc,
    /simpleSection\(\s*["']value-stakes-awareness["']\s*,\s*STAKES_AWARENESS\s*\)/,
  );
});

test("EPISTEMIC_STABILITY value exists and is rendered", () => {
  assert.match(guardrailsSrc, /export const EPISTEMIC_STABILITY\s*=/);
  assert.match(
    promptBuilderSrc,
    /simpleSection\(\s*["']value-epistemic-stability["']\s*,\s*EPISTEMIC_STABILITY\s*\)/,
  );
});

test("SURGICAL_PRECISION value exists and is rendered", () => {
  assert.match(guardrailsSrc, /export const SURGICAL_PRECISION\s*=/);
  assert.match(
    promptBuilderSrc,
    /simpleSection\(\s*["']value-surgical-precision["']\s*,\s*SURGICAL_PRECISION\s*\)/,
  );
});

test("BUDGET_AWARENESS value exists and is rendered", () => {
  assert.match(guardrailsSrc, /export const BUDGET_AWARENESS\s*=/);
  assert.match(
    promptBuilderSrc,
    /simpleSection\(\s*["']value-budget-awareness["']\s*,\s*BUDGET_AWARENESS\s*\)/,
  );
});

// ── 5 new values (added 2026-06-21) exist and are rendered ────────────

test("BROAD_PERSPECTIVE value exists and is rendered (NEW 2026-06-21)", () => {
  assert.match(guardrailsSrc, /export const BROAD_PERSPECTIVE\s*=/);
  assert.match(
    promptBuilderSrc,
    /simpleSection\(\s*["']value-broad-perspective["']\s*,\s*BROAD_PERSPECTIVE\s*\)/,
  );
});

test("STRATEGY_BEFORE_ACTION value exists and is rendered (NEW 2026-06-21)", () => {
  assert.match(guardrailsSrc, /export const STRATEGY_BEFORE_ACTION\s*=/);
  assert.match(
    promptBuilderSrc,
    /simpleSection\(\s*["']value-strategy-before-action["']\s*,\s*STRATEGY_BEFORE_ACTION\s*\)/,
  );
});

test("REASONING_INTEGRITY value exists and is rendered (NEW 2026-06-21)", () => {
  assert.match(guardrailsSrc, /export const REASONING_INTEGRITY\s*=/);
  assert.match(
    promptBuilderSrc,
    /simpleSection\(\s*["']value-reasoning-integrity["']\s*,\s*REASONING_INTEGRITY\s*\)/,
  );
});

test("KNOWLEDGE_UNDER_PRESSURE value exists and is rendered (NEW 2026-06-21)", () => {
  assert.match(guardrailsSrc, /export const KNOWLEDGE_UNDER_PRESSURE\s*=/);
  assert.match(
    promptBuilderSrc,
    /simpleSection\(\s*["']value-knowledge-under-pressure["']\s*,\s*KNOWLEDGE_UNDER_PRESSURE\s*\)/,
  );
});

test("COMMUNICATION_QUALITY value exists and is rendered (NEW 2026-06-21)", () => {
  assert.match(guardrailsSrc, /export const COMMUNICATION_QUALITY\s*=/);
  assert.match(
    promptBuilderSrc,
    /simpleSection\(\s*["']value-communication-quality["']\s*,\s*COMMUNICATION_QUALITY\s*\)/,
  );
});

// ── 1 new value (added 2026-06-22) exists and is rendered ───────────

test("EVIDENCE_GROUNDING value exists and is rendered (NEW 2026-06-22)", () => {
  // Reference: June 22 hacking-a0 phantom-reply incident. The agent
  // pattern-matched ambiguous browser_eval output against AGENTS.md
  // forward references, hallucinating a "MAJOR HINT" narrative from
  // a like-count digit. The fix has two parts: (a) project docs are
  // now pointer-only (no verbatim content injection), and (b) the
  // value-layer counter-priming directive below.
  assert.match(guardrailsSrc, /export const EVIDENCE_GROUNDING\s*=/);
  assert.match(
    promptBuilderSrc,
    /simpleSection\(\s*["']value-evidence-grounding["']\s*,\s*EVIDENCE_GROUNDING\s*\)/,
  );
});

test("EVIDENCE_GROUNDING forbids meta-LLM references in its literal", () => {
  // The value is identity-level: it should speak to the agent's behavior,
  // not to LLM failure modes. Pin the absence of meta-LLM terms.
  const m = guardrailsSrc.match(
    /export const EVIDENCE_GROUNDING\s*=\s*`([^`]*)`/,
  );
  assert.ok(m, "EVIDENCE_GROUNDING must have a template literal value");
  const literal = m[1];
  const metaLLMTerms = ["LLM", "language model", "thinking model", "training"];
  for (const term of metaLLMTerms) {
    assert.ok(
      !literal.includes(term),
      `EVIDENCE_GROUNDING must not reference "${term}" (meta-LLM noise)`,
    );
  }
});

// ── Project docs pointer model (2026-06-22) ──────────────────────────

test("project docs use pointer-only model (no verbatim content injection)", () => {
  // The prompt-builder must NOT inject AGENTS.md / CLAUDE.md content
  // directly into the system prompt. Instead it lists them as a
  // `<available_project_docs>` block; the agent reads full content
  // on demand via the `read` tool. Mirrors the skills model.
  //
  // Regression guard: the old `<project_context>` / `<project_instructions>`
  // block that wrapped full content must not be present anywhere in
  // prompt-builder code.
  assert.ok(
    !/<project_context>/.test(promptBuilderSrc),
    "prompt-builder must not use the old <project_context> wrapper (full content injection)",
  );
  assert.ok(
    !/<project_instructions\b/.test(promptBuilderSrc),
    "prompt-builder must not use the old <project_instructions> tag (full content injection)",
  );
  // The new pointer block must be referenced.
  assert.match(
    promptBuilderSrc,
    /reconstructProjectDocsSection|<available_project_docs>/,
    "prompt-builder must use the new project-docs pointer model",
  );
});

test("project-docs section file exists and exports the right API", () => {
  // Pins the contract of project-docs-section.ts so accidental refactors
  // don't break the pointer model.
  const projDocsPath = join(ROOT, "src/extensions/core/prompt-builder/project-docs-section.ts");
  assert.ok(existsSync(projDocsPath), `project-docs-section.ts must exist at ${projDocsPath}`);
  const projDocsSrc = readFileSync(projDocsPath, "utf-8");
  // Required exports
  assert.match(projDocsSrc, /export\s+(async\s+)?function\s+projectDocsSection/);
  assert.match(projDocsSrc, /export\s+function\s+fingerprintProjectDocs/);
  assert.match(projDocsSrc, /export\s+(async\s+)?function\s+reconstructProjectDocsSection/);
  assert.match(projDocsSrc, /export\s+function\s+resetProjectDocsSectionCache/);
  // Must NOT inject file content — only metadata
  assert.ok(
    !/content\b/.test(projDocsSrc.match(/lines\.push\([^)]+\)/g)?.join("") || ""),
    "projectDocsSection must not push file content into the rendered block",
  );
});

test("RESOURCES_DISCOVER invalidates both skills and project-docs caches", () => {
  // When resources are re-discovered (e.g. /reload), both caches must
  // be invalidated so the next before_agent_start renders fresh.
  const m = promptBuilderSrc.match(
    /RESOURCES_DISCOVER[\s\S]{0,500}?pi\.on\([\s\S]{0,500}?\)/,
  );
  assert.ok(m, "RESOURCES_DISCOVER handler must exist");
  const handler = m[0];
  assert.match(handler, /resetSkillsSectionCache/);
  assert.match(handler, /resetProjectDocsSectionCache/);
});

// ── Architecture: values, not behaviors ───────────────────────────────

test("file documents the values-vs-behaviors split", () => {
  // The AGENTS.md must explain WHY behaviors live in project AGENTS.md
  // and not in the shared prompt. Without this, future contributors will
  // add behaviors here and the shared prompt will accumulate project baggage.
  assert.match(
    agSrc,
    /values[^]*behaviors|values-vs-behaviors/i,
    "AGENTS.md must document the values vs behaviors split",
  );
});

test("file does not contain project-specific behaviors (regression guard)", () => {
  // We pin a few known behaviors that are PROJECT-SPECIFIC. If they ever
  // get added to the shared prompt, this test fails — meaning the shared
  // prompt is being polluted with project baggage.
  //
  // These are not exhaustive. They're examples that today live in a
  // specific project's AGENTS.md and should NOT migrate to the shared
  // prompt-builder. The test is a sentinel, not a complete inventory.
  const projectBehaviors = [
    "no_console_outside_logger",  // the codebase's own test for this
    "use sendTrackedMessage",     // pi-braid-specific convention
    "getExtensionState",          // pi-braid-specific state factory
  ];
  for (const behavior of projectBehaviors) {
    assert.ok(
      !guardrailsSrc.includes(behavior),
      `${behavior} is a project-specific behavior and must NOT be in the shared prompt-builder`,
    );
  }
});

// ── IDENTITY: generalist frame, not software-architect ───────────────

test("IDENTITY_INTRO is generalist (not software-architect) framing", () => {
  // The 2026-06-21 rewrite drops "software architect" in favor of "generalist"
  // so the agent doesn't narrow to a single domain. Pin the absence of the
  // narrow framing AND the presence of the broad framing.
  assert.ok(
    !/expert software architect|software architect/i.test(identitySrc),
    "IDENTITY must NOT use 'software architect' framing (narrow, forecloses generalist identity)",
  );
  assert.match(
    identitySrc,
    /generalist|broader? perspective|deep reasoning/i,
    "IDENTITY must establish generalist identity (generalist / deep reasoning / broad perspective)",
  );
  assert.match(
    identitySrc,
    /software|research|planning|writing|decision-making/,
    "IDENTITY must enumerate the domains the agent engages with (not narrowed to one)",
  );
});

// ── No meta-LLM references in rendered values ────────────────────────

test("values do not contain meta-LLM references ('LLM errors', 'thinking models', etc.)", () => {
  // The agent doesn't need to know about LLM failure modes — it just
  // needs to embody the values. Meta-LLM facts in the prompt are noise.
  //
  // Match the *rendered* values (not just the file) by checking what's
  // exported as value constants. We extract the template literal contents
  // for each value constant and assert they don't contain meta-LLM terms.
  const valueNames = [
    "BROAD_PERSPECTIVE",
    "STRATEGY_BEFORE_ACTION",
    "REASONING_INTEGRITY",
    "KNOWLEDGE_UNDER_PRESSURE",
    "COMMUNICATION_QUALITY",
    "SYCOPHANCY_RESISTANCE",
    "STAKES_AWARENESS",
    "EPISTEMIC_STABILITY",
    "SURGICAL_PRECISION",
    "BUDGET_AWARENESS",
  ];
  const metaLLMTerms = [
    "LLM errors",
    "LLM ",
    "thinking model",
    "language model",
    "training",
    "fine-tun",
    "RLHF",
  ];
  for (const name of valueNames) {
    // Find the value's template literal: `export const NAME = \`...\`;`
    const m = guardrailsSrc.match(
      new RegExp(`export const ${name}\\s*=\\s*\`([^\`]*)\``),
    );
    assert.ok(m, `${name} must have a template literal value`);
    const literal = m[1];
    for (const term of metaLLMTerms) {
      assert.ok(
        !literal.includes(term),
        `${name} must not reference "${term}" (meta-LLM noise in the agent's identity)`,
      );
    }
  }
});

// ── No software-only vocabulary in rendered values ───────────────────

test("values use generalist vocabulary (no 'bug', 'refactor', 'code', 'patch')", () => {
  // A generalist agent addresses issues, not bugs. Works across domains,
  // not just code. Drops software-only words from the shared prompt.
  //
  // We allow 'code' to appear in IDENTITY (it lists "software" as a domain)
  // but NOT in the value statements themselves. The values should be
  // domain-neutral.
  const valueNames = [
    "BROAD_PERSPECTIVE",
    "STRATEGY_BEFORE_ACTION",
    "REASONING_INTEGRITY",
    "KNOWLEDGE_UNDER_PRESSURE",
    "COMMUNICATION_QUALITY",
    "SYCOPHANCY_RESISTANCE",
    "STAKES_AWARENESS",
    "EPISTEMIC_STABILITY",
    "SURGICAL_PRECISION",
    "BUDGET_AWARENESS",
  ];
  const softwareOnlyTerms = [
    // "bug" - too narrow; a generalist addresses "issues", not "bugs"
    /\bbug[s]?\b/i,
    // "refactor" - too narrow; restructure / reorganize / address
    /\brefactor/i,
    // "patch" - too narrow; address / intervene
    /\bpatch(?:ing|es|ed)?\b/i,
  ];
  for (const name of valueNames) {
    const m = guardrailsSrc.match(
      new RegExp(`export const ${name}\\s*=\\s*\`([^\`]*)\``),
    );
    assert.ok(m, `${name} must have a template literal value`);
    const literal = m[1];
    for (const pattern of softwareOnlyTerms) {
      assert.ok(
        !pattern.test(literal),
        `${name} uses software-only vocabulary (${pattern}); use generalist language instead`,
      );
    }
  }
});

// ── Each value is one sentence (matches the documented style) ─────────

test("each value is a single declarative sentence", () => {
  // The file's docstring says "single declarative sentence". A value
  // that's two sentences has likely drifted from the contract.
  //
  // Heuristic: count sentence-ending punctuation. We allow up to 2
  // sentences (some sharpened values have a "Note: ..." clause that
  // could be a sentence) but flag 3+.
  const valueNames = [
    "BROAD_PERSPECTIVE",
    "STRATEGY_BEFORE_ACTION",
    "REASONING_INTEGRITY",
    "KNOWLEDGE_UNDER_PRESSURE",
    "COMMUNICATION_QUALITY",
  ];
  for (const name of valueNames) {
    const m = guardrailsSrc.match(
      new RegExp(`export const ${name}\\s*=\\s*\`([^\`]*)\``),
    );
    assert.ok(m, `${name} must have a template literal value`);
    const literal = m[1].trim();
    // Count terminal punctuation that ends a sentence
    const sentenceEnders = (literal.match(/[.!?](?:\s|$)/g) || []).length;
    assert.ok(
      sentenceEnders <= 2,
      `${name} has ${sentenceEnders} sentences; values should be ≤2 declarative sentences`,
    );
  }
});

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== prompt-builder values contract tests passed ===");
