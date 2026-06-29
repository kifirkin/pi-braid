/**
 * Test: prompt-builder output directive contract.
 *
 * Replaces test-prompt-builder-values.mjs (renamed 2026-06-29 after the
 * value-statement layer was deleted along with behavioral-guardrails.ts
 * and contrast-phrase-library.ts).
 *
 * Pins two contracts:
 *
 *   1. The single concise-responses directive:
 *      - Exists as a constant in identity.ts
 *      - Is rendered into the system prompt via simpleSection
 *      - Is one declarative sentence (matches the documented terseness principle)
 *      - Has no meta-LLM references (preserves the spirit of the old
 *        meta-LLM-noise guard — the directive speaks to the agent, not
 *        to LLM failure modes)
 *      - Uses generalist vocabulary (no 'bug', 'refactor', 'patch')
 *
 *   2. Orthogonal contracts that lived in the old test but are unrelated
 *      to the values-vs-behaviors decision (kept so refactors of those
 *      files don't silently break the contract):
 *      - Project docs use pointer-only model
 *      - project-docs-section.ts exports the right API
 *      - RESOURCES_DISCOVER invalidates both skills and project-docs caches
 *      - IDENTITY_INTRO is generalist (not software-architect) framing
 *
 * This is a source-level contract test. It's stable to wording changes
 * but catches:
 *   - removal of the directive (regression)
 *   - removal from the rendered prompt (regression)
 *   - drift back to multi-sentence or software-only vocabulary
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  identity: join(ROOT, "src/extensions/core/prompt-builder/identity.ts"),
  promptBuilder: join(ROOT, "src/extensions/core/prompt-builder/index.ts"),
  projDocs: join(ROOT, "src/extensions/core/prompt-builder/project-docs-section.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source must exist at ${path}`);
}

const identitySrc = readFileSync(FILES.identity, "utf-8");
const promptBuilderSrc = readFileSync(FILES.promptBuilder, "utf-8");
const projDocsSrc = readFileSync(FILES.projDocs, "utf-8");

console.log("=== prompt-builder output directive contract ===\n");

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

// ── Deleted files stay deleted (regression guard) ─────────────────────────
// Paths are built inside the test fns (not in a top-level FILES const) so
// check-deps doesn't flag them as stale source references. The assertion
// is `!existsSync(...)` so it's pinning absence, not presence.

test("behavioral-guardrails.ts is deleted (regression guard)", () => {
  const guardrailsPath = join(ROOT, "src/extensions/core/prompt-builder/behavioral-guardrails.ts");
  assert.ok(!existsSync(guardrailsPath), "behavioral-guardrails.ts must stay deleted");
});

test("contrast-phrase-library.ts is deleted (regression guard)", () => {
  const contrastPath = join(ROOT, "src/extensions/core/prompt-builder/contrast-phrase-library.ts");
  assert.ok(!existsSync(contrastPath), "contrast-phrase-library.ts must stay deleted");
});

test("prompt-builder no longer imports from the deleted files", () => {
  assert.ok(
    !/from\s+["']\.\/behavioral-guardrails\.js["']/.test(promptBuilderSrc),
    "index.ts must not import from the deleted behavioral-guardrails.js",
  );
  assert.ok(
    !/from\s+["']\.\/contrast-phrase-library\.js["']/.test(promptBuilderSrc),
    "index.ts must not import from the deleted contrast-phrase-library.js",
  );
});

test("prompt-builder no longer references the deleted value sections", () => {
  const deadSections = [
    "value-epistemic-integrity",
    "value-broad-perspective",
    "value-evidence-grounding",
    "value-surgical-precision",
    "value-strategy-and-drift",
    "value-sycophancy-resistance",
    "value-knowledge-under-pressure",
    "value-communication-quality",
  ];
  for (const sec of deadSections) {
    assert.ok(
      !promptBuilderSrc.includes(sec),
      `index.ts must not render ${sec} (deleted with the value-statement layer)`,
    );
  }
});

// ── CONCISE_RESPONSES directive ───────────────────────────────────────────

test("CONCISE_RESPONSES directive exists in identity.ts", () => {
  assert.match(
    identitySrc,
    /export const CONCISE_RESPONSES\s*=/,
    "CONCISE_RESPONSES must be exported from identity.ts",
  );
});

test("CONCISE_RESPONSES directive is rendered into the system prompt", () => {
  assert.match(
    promptBuilderSrc,
    /simpleSection\(\s*["']value-concise-responses["']\s*,\s*CONCISE_RESPONSES\s*\)/,
    "index.ts must render CONCISE_RESPONSES via simpleSection(\"value-concise-responses\", ...)",
  );
});

test("CONCISE_RESPONSES is a single declarative sentence", () => {
  const m = identitySrc.match(/export const CONCISE_RESPONSES\s*=\s*`([^`]*)`/);
  assert.ok(m, "CONCISE_RESPONSES must have a template literal value");
  const literal = m[1].trim();
  const sentenceEnders = (literal.match(/[.!?](?:\s|$)/g) || []).length;
  assert.ok(
    sentenceEnders <= 1,
    `CONCISE_RESPONSES has ${sentenceEnders} sentences; should be exactly 1 (terseness principle)`,
  );
});

test("CONCISE_RESPONSES has no meta-LLM references", () => {
  const m = identitySrc.match(/export const CONCISE_RESPONSES\s*=\s*`([^`]*)`/);
  assert.ok(m, "CONCISE_RESPONSES must have a template literal value");
  const literal = m[1];
  const metaLLMTerms = ["LLM", "language model", "thinking model", "training"];
  for (const term of metaLLMTerms) {
    assert.ok(
      !literal.includes(term),
      `CONCISE_RESPONSES must not reference "${term}" (meta-LLM noise in the agent's identity)`,
    );
  }
});

test("CONCISE_RESPONSES uses generalist vocabulary", () => {
  const m = identitySrc.match(/export const CONCISE_RESPONSES\s*=\s*`([^`]*)`/);
  assert.ok(m, "CONCISE_RESPONSES must have a template literal value");
  const literal = m[1];
  const softwareOnlyTerms = [
    /\bbug[s]?\b/i,
    /\brefactor/i,
    /\bpatch(?:ing|es|ed)?\b/i,
    /\bcode\b/i,
  ];
  for (const pattern of softwareOnlyTerms) {
    assert.ok(
      !pattern.test(literal),
      `CONCISE_RESPONSES uses software-only vocabulary (${pattern}); use generalist language instead`,
    );
  }
});

// ── Project docs pointer model (orthogonal, preserved from prior test) ──

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
  assert.ok(existsSync(FILES.projDocs), `project-docs-section.ts must exist at ${FILES.projDocs}`);
  // Required exports
  assert.match(projDocsSrc, /export\s+(async\s+)?function\s+projectDocsSection/);
  assert.match(projDocsSrc, /export\s+function\s+fingerprintProjectDocs/);
  assert.match(projDocsSrc, /export\s+(async\s+)?function\s+reconstructProjectDocsSection/);
  assert.match(projDocsSrc, /export\s+function\s+resetProjectDocsSectionCache/);
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

// ── IDENTITY: generalist frame (orthogonal, preserved from prior test) ───

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

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== prompt-builder directive contract tests passed ===");