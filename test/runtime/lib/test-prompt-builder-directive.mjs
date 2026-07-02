/**
 * Test: prompt-builder output directive + behavior-modes contract.
 *
 * Originally replaced test-prompt-builder-values.mjs (2026-06-29 after the
 * value-statement layer was deleted). Updated 2026-06-29 after the dynamic
 * behavior-mode system was restored in behavior-modes.ts.
 *
 * Pins three contracts:
 *
 *   1. The single concise-responses directive (CONCISE_RESPONSES in identity.ts):
 *      - Exists as a constant, rendered into the system prompt
 *      - Is one declarative sentence, no meta-LLM references, generalist vocabulary
 *
 *   2. Dynamic behavior modes (behavior-modes.ts):
 *      - File exists, exports behaviorModeSection + MODES + DEFAULT_MODE
 *      - 4 modes defined: TRUTH-SEEKING, CORRECTION, EPISTEMIC-CALIBRATION, TOOL-RELIABILITY
 *      - Each mode has 1-2 directives (lean, not the old 6-phrase library)
 *      - Default mode is TRUTH-SEEKING
 *      - Rendered into the system prompt via behaviorModeSection()
 *      - Enforcement signals wiring: turn-end-handler emits contrastMode
 *      - The old static value sections are NOT rendered (they stay deleted)
 *
 *   3. Orthogonal contracts from the prior test:
 *      - Project docs use pointer-only model
 *      - project-docs-section.ts exports the right API
 *      - RESOURCES_DISCOVER invalidates both skills and project-docs caches
 *      - IDENTITY_INTRO is generalist (not software-architect) framing
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  identity: join(ROOT, "src/extensions/core/prompt-builder/identity.ts"),
  behaviorModes: join(ROOT, "src/extensions/core/prompt-builder/behavior-modes.ts"),
  promptBuilder: join(ROOT, "src/extensions/core/prompt-builder/index.ts"),
  turnEndHandler: join(ROOT, "src/extensions/enforcement/handlers/turn-end-handler.ts"),
  signals: join(ROOT, "src/extensions/enforcement/signals.ts"),
  projDocs: join(ROOT, "src/extensions/core/prompt-builder/project-docs-section.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source must exist at ${path}`);
}

const identitySrc = readFileSync(FILES.identity, "utf-8");
const behaviorModesSrc = readFileSync(FILES.behaviorModes, "utf-8");
const promptBuilderSrc = readFileSync(FILES.promptBuilder, "utf-8");
const turnEndHandlerSrc = readFileSync(FILES.turnEndHandler, "utf-8");
const signalsSrc = readFileSync(FILES.signals, "utf-8");
const projDocsSrc = readFileSync(FILES.projDocs, "utf-8");

console.log("=== prompt-builder directive + behavior-modes contract ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(`  [x] ${name}: ${e.message}`);
    failed++;
  }
}

// ── Old deleted files stay deleted (regression guard) ────────────────────
// The old 8-value static layer and 6-phrase contrast library are gone.
// The lean successor is behavior-modes.ts (4 modes x 1-2 directives).
// These guard against accidentally restoring the bloated versions.

test("behavioral-guardrails.ts is deleted (regression guard)", () => {
  const guardrailsPath = join(ROOT, "src/extensions/core/prompt-builder/behavioral-guardrails.ts");
  assert.ok(!existsSync(guardrailsPath), "behavioral-guardrails.ts must stay deleted (replaced by behavior-modes.ts)");
});

test("contrast-phrase-library.ts is deleted (regression guard)", () => {
  const contrastPath = join(ROOT, "src/extensions/core/prompt-builder/contrast-phrase-library.ts");
  assert.ok(!existsSync(contrastPath), "contrast-phrase-library.ts must stay deleted (replaced by behavior-modes.ts)");
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

// ── Behavior modes (restored dynamic system) ───────────────────────────────

test("behavior-modes.ts exists and exports the right API", () => {
  assert.ok(existsSync(FILES.behaviorModes), `behavior-modes.ts must exist at ${FILES.behaviorModes}`);
  assert.match(behaviorModesSrc, /export\s+function\s+behaviorModeSection/);
  assert.match(behaviorModesSrc, /export\s+\{\s*MODES\s*,\s*DEFAULT_MODE\s*\}/);
  assert.match(behaviorModesSrc, /export\s+type\s+\{\s*ModeDef\s*\}/);
});

test("4 behavior modes are defined", () => {
  const requiredModes = ["TRUTH-SEEKING", "CORRECTION", "EPISTEMIC-CALIBRATION", "TOOL-RELIABILITY"];
  for (const mode of requiredModes) {
    assert.match(
      behaviorModesSrc,
      new RegExp(`"${mode}"\\s*:`),
      `MODES must define the ${mode} mode`,
    );
  }
});

test("default mode is TRUTH-SEEKING", () => {
  assert.match(
    behaviorModesSrc,
    /DEFAULT_MODE\s*=\s*MODES\["TRUTH-SEEKING"\]/,
    "DEFAULT_MODE must be TRUTH-SEEKING",
  );
});

test("each mode has 1-2 directives (lean, not the old 6-phrase library)", () => {
  // Extract each mode's directives array and count entries.
  // The old contrast-phrase-library had up to 3 phrases per mode.
  // The lean successor should have 1-2.
  const modeBlocks = behaviorModesSrc.matchAll(/"([A-Z-]+)":\s*\{[\s\S]*?directives:\s*\[([\s\S]*?)\]\s*\}/g);
  for (const m of modeBlocks) {
    const modeName = m[1];
    const directivesContent = m[2];
    // Count the number of string entries (backtick or quote delimited)
    const directiveCount = (directivesContent.match(/`[^`]+`|"[^"]+"/g) || []).length;
    assert.ok(
      directiveCount >= 1 && directiveCount <= 2,
      `${modeName} mode has ${directiveCount} directives; expected 1-2 (lean successor, not the old 3-phrase library)`,
    );
  }
});

test("behavior-modes has no meta-LLM references in directive text", () => {
  // Check only the directive string literals (backtick-delimited), not comments.
  // The file's explanatory comments may reference LLM concepts for maintainers;
  // the prompt text itself must not.
  const directives = behaviorModesSrc.matchAll(/`([^`]+)`/g);
  const metaLLMTerms = ["LLM", "language model", "thinking model", "training data"];
  for (const m of directives) {
    const text = m[1];
    // Skip comments (if a backtick string contains '//' it's likely a comment example)
    for (const term of metaLLMTerms) {
      assert.ok(
        !text.includes(term),
        `behavior-modes directive must not reference "${term}": "${text.slice(0, 60)}..."`,
      );
    }
  }
});

test("behavior mode section is rendered into the system prompt", () => {
  assert.match(
    promptBuilderSrc,
    /behaviorModeSection\(ps\.activeBehaviorMode\)/,
    "index.ts must render behaviorModeSection with the active mode from state",
  );
});

test("prompt-builder listens for enforcement_signals with contrastMode", () => {
  assert.match(
    promptBuilderSrc,
    /pi\.events\.on\(["']enforcement_signals["']/,
    "index.ts must listen for enforcement_signals events",
  );
  assert.match(
    promptBuilderSrc,
    /contrastMode/,
    "index.ts must read contrastMode from the event data",
  );
  assert.match(
    promptBuilderSrc,
    /activeBehaviorMode/,
    "index.ts must store the mode in activeBehaviorMode state",
  );
});

test("turn-end-handler emits contrastMode via enforcement_signals", () => {
  assert.match(
    turnEndHandlerSrc,
    /import\s+\{[^}]*determineContrastMode[^}]*\}\s+from\s+["']\.\.\/signals\.js["']/,
    "turn-end-handler must import determineContrastMode",
  );
  assert.match(
    turnEndHandlerSrc,
    /pi\.events\.emit\s*\(\s*["']enforcement_signals["'][\s\S]*?contrastMode:\s*determineContrastMode/,
    "turn-end-handler must emit contrastMode via enforcement_signals",
  );
});

test("signals.ts exports determineContrastMode and documents the 4 modes", () => {
  assert.match(signalsSrc, /export\s+function\s+determineContrastMode/);
  // All 4 mode names should appear as return values
  const modes = ["TRUTH-SEEKING", "TOOL-RELIABILITY", "EPISTEMIC-CALIBRATION", "CORRECTION"];
  for (const mode of modes) {
    assert.ok(
      signalsSrc.includes(`return "${mode}"`),
      `determineContrastMode must return "${mode}" for the corresponding condition`,
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

// ── DEFINITION_OF_DONE invariant (SPQ-1) ─────────────────────────────────

test("DEFINITION_OF_DONE directive exists in identity.ts", () => {
  assert.match(
    identitySrc,
    /export const DEFINITION_OF_DONE\s*=/,
    "DEFINITION_OF_DONE must be exported from identity.ts",
  );
});

test("DEFINITION_OF_DONE directive is rendered into the system prompt", () => {
  assert.match(
    promptBuilderSrc,
    /simpleSection\(\s*["']invariant-definition-of-done["']\s*,\s*DEFINITION_OF_DONE\s*\)/,
    "index.ts must render DEFINITION_OF_DONE via simpleSection(\"invariant-definition-of-done\", ...)",
  );
});

test("DEFINITION_OF_DONE mentions the verification triple components", () => {
  // Use (?:[^`\\]|\\.)* to handle escaped backticks inside the template literal
  const m = identitySrc.match(/export const DEFINITION_OF_DONE\s*=\s*`((?:[^`\\]|\\.)*)`/);
  assert.ok(m, "DEFINITION_OF_DONE must have a template literal value");
  const literal = m[1];
  // Must mention all three parts of the triple
  assert.ok(/path/i.test(literal), "DEFINITION_OF_DONE must mention file path(s)");
  assert.ok(/git log|last-modified|confirm.*change/i.test(literal),
    "DEFINITION_OF_DONE must mention a command that confirms the change was applied");
  assert.ok(/verif|test|typecheck|correctness/i.test(literal),
    "DEFINITION_OF_DONE must mention a verification command");
  // Must mention finalize as the gate
  assert.ok(/finalize/i.test(literal), "DEFINITION_OF_DONE must reference finalize as the gate");
});

test("DEFINITION_OF_DONE has no meta-LLM references", () => {
  const m = identitySrc.match(/export const DEFINITION_OF_DONE\s*=\s*`((?:[^`\\]|\\.)*)`/);
  assert.ok(m, "DEFINITION_OF_DONE must have a template literal value");
  const literal = m[1];
  const metaLLMTerms = ["LLM", "language model", "thinking model", "training"];
  for (const term of metaLLMTerms) {
    assert.ok(
      !literal.includes(term),
      `DEFINITION_OF_DONE must not reference "${term}" (meta-LLM noise)`,
    );
  }
});

// ── INTERACTION_STYLE: markup-discipline clause (added 2026-07-02) ───

test("INTERACTION_STYLE contains the markup-discipline clause", () => {
  // The 2026-07-02 extension added a 4th sentence: reasoning belongs inside
  // think() calls or natural prose, never as raw markup tags in the visible
  // response. Pin the clause so future edits don't quietly remove it.
  const m = identitySrc.match(/export const INTERACTION_STYLE\s*=\s*`((?:[^`\\]|\\.)*)`/);
  assert.ok(m, "INTERACTION_STYLE must have a template literal value");
  const literal = m[1];
  assert.ok(/think\(\)/i.test(literal), "INTERACTION_STYLE must reference think()");
  assert.ok(/markup/i.test(literal), "INTERACTION_STYLE must mention markup");
  assert.ok(/visible response/i.test(literal), "INTERACTION_STYLE must specify 'visible response'");
});

test("INTERACTION_STYLE has no meta-LLM references", () => {
  const m = identitySrc.match(/export const INTERACTION_STYLE\s*=\s*`((?:[^`\\]|\\.)*)`/);
  assert.ok(m, "INTERACTION_STYLE must have a template literal value");
  const literal = m[1];
  const metaLLMTerms = ["LLM", "language model", "thinking model", "training"];
  for (const term of metaLLMTerms) {
    assert.ok(
      !literal.includes(term),
      `INTERACTION_STYLE must not reference "${term}" (meta-LLM noise)`,
    );
  }
});

// ── SCOPES: artifact-location heuristic (added 2026-07-02) ─────────────

test("SCOPES directive exists in identity.ts", () => {
  assert.match(
    identitySrc,
    /export const SCOPES\s*=/,
    "SCOPES must be exported from identity.ts",
  );
});

test("SCOPES directive is rendered into the system prompt", () => {
  assert.match(
    promptBuilderSrc,
    /simpleSection\(\s*["']invariant-scopes["']\s*,\s*SCOPES\s*\)/,
    "index.ts must render SCOPES via simpleSection(\"invariant-scopes\", ...)",
  );
});

test("SCOPES is principled and short (3 sentences max)", () => {
  // SCOPES enumerates lifetime / audience / portability as escalation
  // heuristics and ends with a memorable closer. 3 sentences is the
  // expected ceiling; longer drifts toward catalog.
  const m = identitySrc.match(/export const SCOPES\s*=\s*`((?:[^`\\]|\\.)*)`/);
  assert.ok(m, "SCOPES must have a template literal value");
  const literal = m[1].trim();
  const sentenceEnders = (literal.match(/[.!?](?:\s|$)/g) || []).length;
  assert.ok(
    sentenceEnders <= 3,
    `SCOPES has ${sentenceEnders} sentences; expected <= 3 (principle + heuristic + closer)`,
  );
});

test("SCOPES has no example paths in the directive text", () => {
  // Discoverability principle: no `~/.pi`, no `/tmp`, no `/etc`, no
  // `~/.config` in the directive text. Concrete paths belong in the
  // agent's discovery (via read/ls/find), not in the identity framing.
  const m = identitySrc.match(/export const SCOPES\s*=\s*`((?:[^`\\]|\\.)*)`/);
  assert.ok(m, "SCOPES must have a template literal value");
  const literal = m[1];
  const forbiddenPaths = ["/tmp", "/etc", "/var", "~/.pi", "~/.config", "~/.cache", "~/.local"];
  for (const p of forbiddenPaths) {
    assert.ok(
      !literal.includes(p),
      `SCOPES must not enumerate path "${p}" (discoverability: agent finds concrete paths at the moment of need)`,
    );
  }
});

test("SCOPES mentions the escalation heuristic (lifetime / audience / portability)", () => {
  const m = identitySrc.match(/export const SCOPES\s*=\s*`((?:[^`\\]|\\.)*)`/);
  assert.ok(m, "SCOPES must have a template literal value");
  const literal = m[1];
  assert.ok(/lifetime/i.test(literal), "SCOPES must mention lifetime as escalation criterion");
  assert.ok(/audience/i.test(literal), "SCOPES must mention audience as escalation criterion");
  assert.ok(/portability/i.test(literal), "SCOPES must mention portability as escalation criterion");
});

test("SCOPES has no meta-LLM references", () => {
  const m = identitySrc.match(/export const SCOPES\s*=\s*`((?:[^`\\]|\\.)*)`/);
  assert.ok(m, "SCOPES must have a template literal value");
  const literal = m[1];
  const metaLLMTerms = ["LLM", "language model", "thinking model", "training"];
  for (const term of metaLLMTerms) {
    assert.ok(
      !literal.includes(term),
      `SCOPES must not reference "${term}" (meta-LLM noise)`,
    );
  }
});

// ── CORRECTION mode: markup-discipline reminder (extended 2026-07-02) ───

test("CORRECTION mode directive references think() with the canonical signature", () => {
  // Pin the canonical call form so the directive keeps showing the exact
  // tool invocation the agent needs (observation / decision / reason).
  // The markup-discipline warning lives in INTERACTION_STYLE alone; the
  // CORRECTION directive stays lean and focused on the missing call.
  const modeMatch = behaviorModesSrc.match(/"CORRECTION":\s*\{[\s\S]*?directives:\s*\[([\s\S]*?)\][\s\S]*?\}/);
  assert.ok(modeMatch, "CORRECTION mode must be defined");
  const directives = modeMatch[1];
  assert.ok(/think\(observation, decision, reason\)/.test(directives),
    "CORRECTION first directive must reference think(observation, decision, reason)");
  assert.ok(/think\(\) tool/.test(directives),
    "CORRECTION first directive must name 'think() tool' to anchor the call reference");
});

test("CORRECTION mode stays at 1-2 directives (lean, not the old 3-phrase library)", () => {
  // Pin the existing lean invariant for CORRECTION specifically -- the
  // 2026-07-02 extension rewrites the first directive's content but must
  // not push it past 2 directives.
  const modeMatch = behaviorModesSrc.match(/"CORRECTION":\s*\{[\s\S]*?directives:\s*\[([\s\S]*?)\][\s\S]*?\}/);
  assert.ok(modeMatch, "CORRECTION mode must be defined");
  const directives = modeMatch[1];
  const directiveCount = (directives.match(/`[^`]+`|"[^"]+"/g) || []).length;
  assert.ok(
    directiveCount >= 1 && directiveCount <= 2,
    `CORRECTION mode has ${directiveCount} directives; expected 1-2 (lean)`,
  );
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