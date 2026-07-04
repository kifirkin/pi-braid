/**
 * Test: prompt-builder wiring + structural contract.
 *
 * Scope (2026-07-04 cleanup): structural/wiring tests only. Tests that
 * pinned freeform prompt-text content (sentence counts, exact phrases,
 * meta-LLM term scans, vocabulary checks) were removed. The system
 * prompt is freeform prose the author can evolve; the wiring
 * (which constants get rendered, into which sections, with which
 * surrounding structure) is the durable contract.
 *
 * Pins:
 *   - Deleted-files regression guards (behavioral-guardrails.ts,
 *     contrast-phrase-library.ts stay deleted)
 *   - behavior-modes.ts structural contract (4 modes, 1-2 directives
 *     each, default mode identity, TRUTH-SEEKING wiring)
 *   - Identity constants: each directive is exported from identity.ts
 *     and rendered via simpleSection("invariant-...", CONST)
 *   - Project docs structural contract (pointer-only, no verbatim
 *     injection, project-docs section API surface)
 *   - Unified ## Context block (one headingSection, no double-render)
 *   - RESOURCES_DISCOVER cache invalidation wiring
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

console.log("=== prompt-builder wiring contract ===\n");

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

// ── Deleted-files regression guards ────────────────────────────────
// The old 8-value static layer and 6-phrase contrast library are
// gone. The lean successor is behavior-modes.ts. These guards
// prevent accidental restoration of the bloated versions.

test("behavioral-guardrails.ts is deleted (regression guard)", () => {
  const guardrailsPath = join(ROOT, "src/extensions/core/prompt-builder/behavioral-guardrails.ts");
  assert.ok(!existsSync(guardrailsPath), "behavioral-guardrails.ts must stay deleted (replaced by behavior-modes.ts)");
});

test("contrast-phrase-library.ts is deleted (regression guard)", () => {
  const libraryPath = join(ROOT, "src/extensions/core/prompt-builder/contrast-phrase-library.ts");
  assert.ok(!existsSync(libraryPath), "contrast-phrase-library.ts must stay deleted (replaced by behavior-modes.ts)");
});

test("prompt-builder no longer imports from the deleted files", () => {
  assert.ok(
    !/from\s+["'].*behavioral-guardrails/.test(promptBuilderSrc),
    "prompt-builder must not import from behavioral-guardrails.ts",
  );
  assert.ok(
    !/from\s+["'].*contrast-phrase-library/.test(promptBuilderSrc),
    "prompt-builder must not import from contrast-phrase-library.ts",
  );
});

// ── Behavior modes: structural contract ───────────────────────────────

test("behavior-modes.ts exists and exports the right API", () => {
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
  const modeBlocks = behaviorModesSrc.matchAll(/"([A-Z-]+)":\s*\{[\s\S]*?directives:\s*\[([\s\S]*?)\]\s*\}/g);
  for (const m of modeBlocks) {
    const modeName = m[1];
    const directivesContent = m[2];
    const directiveCount = (directivesContent.match(/`[^`]+`|"[^"]+"/g) || []).length;
    assert.ok(
      directiveCount >= 1 && directiveCount <= 2,
      `${modeName} mode has ${directiveCount} directives; expected 1-2 (lean successor)`,
    );
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
  assert.match(promptBuilderSrc, /pi\.events\.on\(["']enforcement_signals["']/);
  assert.match(promptBuilderSrc, /contrastMode/);
  assert.match(promptBuilderSrc, /activeBehaviorMode/);
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

test("signals.ts exports determineContrastMode and returns the 4 mode keys", () => {
  assert.match(signalsSrc, /export\s+function\s+determineContrastMode/);
  const modes = ["TRUTH-SEEKING", "TOOL-RELIABILITY", "EPISTEMIC-CALIBRATION", "CORRECTION"];
  for (const mode of modes) {
    assert.ok(
      signalsSrc.includes(`return "${mode}"`),
      `determineContrastMode must return "${mode}" for the corresponding condition`,
    );
  }
});

// ── Identity directive wiring: each constant must be exported + rendered ─
// The system-prompt text itself is freeform prose (not pinned by tests);
// what we pin is the wiring contract -- each identity framing must be
// exported from identity.ts and rendered via simpleSection("invariant-...").

test("INTERACTION_STYLE is exported and rendered", () => {
  assert.match(identitySrc, /export const INTERACTION_STYLE\s*=/);
  assert.match(promptBuilderSrc, /simpleSection\(\s*["']interaction-style["']\s*,\s*INTERACTION_STYLE\s*\)/);
});

test("CONCISE_RESPONSES is exported and rendered", () => {
  assert.match(identitySrc, /export const CONCISE_RESPONSES\s*=/);
  assert.match(promptBuilderSrc, /simpleSection\(\s*["']value-concise-responses["']\s*,\s*CONCISE_RESPONSES\s*\)/);
});

test("COMPACTION_SURVIVAL is exported and rendered", () => {
  assert.match(identitySrc, /export const COMPACTION_SURVIVAL\s*=/);
  assert.match(promptBuilderSrc, /simpleSection\(\s*["']invariant-compaction["']\s*,\s*COMPACTION_SURVIVAL\s*\)/);
});

test("DEFINITION_OF_DONE is exported and rendered", () => {
  assert.match(identitySrc, /export const DEFINITION_OF_DONE\s*=/);
  assert.match(promptBuilderSrc, /simpleSection\(\s*["']invariant-definition-of-done["']\s*,\s*DEFINITION_OF_DONE\s*\)/);
});

test("LIVING_DOCS is exported and rendered", () => {
  assert.match(identitySrc, /export const LIVING_DOCS\s*=/);
  assert.match(promptBuilderSrc, /simpleSection\(\s*["']invariant-living-docs["']\s*,\s*LIVING_DOCS\s*\)/);
});

test("MEMORY_AWARENESS is exported and rendered", () => {
  assert.match(identitySrc, /export const MEMORY_AWARENESS\s*=/);
  assert.match(promptBuilderSrc, /simpleSection\(\s*["']invariant-memory["']\s*,\s*MEMORY_AWARENESS\s*\)/);
});

test("SCOPES is exported and rendered", () => {
  assert.match(identitySrc, /export const SCOPES\s*=/);
  assert.match(promptBuilderSrc, /simpleSection\(\s*["']invariant-scopes["']\s*,\s*SCOPES\s*\)/);
});

test("FRAMEWORK_CONFIG_FIRST is exported and rendered", () => {
  assert.match(identitySrc, /export const FRAMEWORK_CONFIG_FIRST\s*=/);
  assert.match(promptBuilderSrc, /simpleSection\(\s*["']invariant-framework-config-first["']\s*,\s*FRAMEWORK_CONFIG_FIRST\s*\)/);
});

test("RESOURCE_DISCOVERY is exported and rendered", () => {
  assert.match(identitySrc, /export const RESOURCE_DISCOVERY\s*=/);
  assert.match(promptBuilderSrc, /simpleSection\(\s*["']invariant-resource-discovery["']\s*,\s*RESOURCE_DISCOVERY\s*\)/);
});

// ── Project docs structural contract ────────────────────────────────

test("project docs use pointer-only model (no verbatim content injection)", () => {
  // Regression guard: the old `<project_context>` / `<project_instructions>`
  // block that wrapped full content must not be present.
  assert.ok(
    !/<project_context>/.test(promptBuilderSrc),
    "prompt-builder must not use the old <project_context> wrapper (full content injection)",
  );
  assert.ok(
    !/<project_instructions\b/.test(promptBuilderSrc),
    "prompt-builder must not use the old <project_instructions> tag (full content injection)",
  );
  assert.match(promptBuilderSrc, /reconstructProjectDocsSection/);
});

test("project-docs section file exports the right API", () => {
  assert.match(projDocsSrc, /export\s+(async\s+)?function\s+projectDocsSection/);
  assert.match(projDocsSrc, /export\s+function\s+fingerprintProjectDocs/);
  assert.match(projDocsSrc, /export\s+(async\s+)?function\s+reconstructProjectDocsSection/);
  assert.match(projDocsSrc, /export\s+function\s+resetProjectDocsSectionCache/);
});

test("RESOURCES_DISCOVER invalidates both skills and project-docs caches", () => {
  const m = promptBuilderSrc.match(
    /RESOURCES_DISCOVER[\s\S]{0,500}?pi\.on\([\s\S]{0,500}?\)/,
  );
  assert.ok(m, "RESOURCES_DISCOVER handler must exist");
  const handler = m[0];
  assert.match(handler, /resetSkillsSectionCache/);
  assert.match(handler, /resetProjectDocsSectionCache/);
});

// ── Unified ## Context block ────────────────────────────────────────

test("prompt-builder composes project-docs + memory + runtime-context under one `## Context` heading", () => {
  assert.match(
    promptBuilderSrc,
    /headingSection\(\s*["']context["']\s*,\s*["']Context["']\s*,/,
    'prompt-builder must use headingSection("context", "Context", ...) for the unified block',
  );
});

test("prompt-builder no longer pushes project-docs or memory as separate simpleSections", () => {
  assert.ok(
    !/simpleSection\(\s*["']project-docs["']\s*,/.test(promptBuilderSrc),
    "project-docs must not be its own simpleSection; it joins the unified `## Context` heading",
  );
  assert.ok(
    !/simpleSection\(\s*["']memory["']\s*,/.test(promptBuilderSrc),
    "memory must not be its own simpleSection; it joins the unified `## Context` heading",
  );
});

test("`## Context` heading appears exactly once per prompt render", () => {
  const headingCalls = promptBuilderSrc.match(
    /headingSection\(\s*["']context["']\s*,\s*["']Context["']\s*,/g,
  );
  assert.ok(
    headingCalls && headingCalls.length === 1,
    `prompt-builder must call headingSection("context", "Context", ...) exactly once; found ${headingCalls?.length ?? 0}`,
  );
});

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== prompt-builder wiring contract tests passed ===");
