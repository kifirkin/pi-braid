/**
 * Test: prompt-builder Instance composition block (v3.5).
 *
 * Pins the "## Instance" block contract:
 *   - Always present at the top of the system prompt
 *   - Stable per session (root, cwd, os, datetime, agent version)
 *   - Tree-style extension list with module grouping + per-extension tool counts
 *   - Total counts (tools, skills, memory) at the bottom
 *   - No project-context leakage (per user's "don't leak" rule)
 *
 * The Instance block replaces scattered env info (root/cwd/os/datetime
 * were previously split between l1-environment.ts and section 6 of
 * the prompt-builder). This test pins the consolidated shape.
 *
 * Source-level contract test: same family as test-prompt-builder-values.mjs.
 * Catches:
 *   - removal of the section from the prompt (regression)
 *   - change to the required field set (regression)
 *   - the wired sections array containing the wrong first element
 *
 * History: introduced 2026-06-28 as part of the system-prompt cleanup.
 *   Prior to this, env info was scattered (## System State + section 6).
 *   See instance-composition.ts header for full design rationale.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  promptBuilder: join(ROOT, "src/extensions/core/prompt-builder/index.ts"),
  instanceComp: join(ROOT, "src/extensions/core/prompt-builder/instance-composition.ts"),
  loader: join(ROOT, "src/loader/loader.ts"),
  toolProvenance: join(ROOT, "src/lib/state/tool-provenance.ts"),
  manifest: join(ROOT, "src/extensions/manifest.ts"),
};

// ── Subtests ────────────────────────────────────────────────────────────────

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
  }
}

test("instance-composition.ts exists and exports instanceSection", () => {
  const content = readFileSync(FILES.instanceComp, "utf-8");
  assert.ok(
    content.includes("export async function instanceSection"),
    "instance-composition.ts must export instanceSection",
  );
  assert.ok(
    content.includes("InstanceContext"),
    "instance-composition.ts must define InstanceContext",
  );
});

test("prompt-builder wires the Instance block as the first section", () => {
  const content = readFileSync(FILES.promptBuilder, "utf-8");
  assert.ok(
    content.includes("import { instanceSection }"),
    "prompt-builder must import instanceSection",
  );
  // The instance section is the first non-comment element of the
  // sections array. Strip leading comments before checking.
  const match = content.match(/const sections: PromptSection\[\] = \[([\s\S]*?)\];/);
  assert.ok(match, "expected sections array literal");
  const stripped = match[1]
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim()) // strip // comments
    .filter((l) => l.length > 0)
    .join(" ");
  assert.ok(
    stripped.startsWith("inst,") || stripped.startsWith("instanceSection("),
    `Instance block must be the first section. Got: ${stripped.slice(0, 80)}`,
  );
});

test("instance-composition renders required env fields", () => {
  const content = readFileSync(FILES.instanceComp, "utf-8");
  // Each required line must be present in the render output
  const required = [
    "## Instance",
    "Agent:",
    "Root:",
    "Cwd:",
    "OS:",
    "Now:",
    "Extensions",
  ];
  for (const field of required) {
    assert.ok(
      content.includes(field),
      `Instance block must include "${field}" field`,
    );
  }
});

test("instance-composition groups extensions by module", () => {
  const content = readFileSync(FILES.instanceComp, "utf-8");
  assert.ok(
    content.includes("getModuleGroup"),
    "instance-composition must use getModuleGroup for module grouping",
  );
  assert.ok(
    content.includes("getModuleNames"),
    "instance-composition must use getModuleNames for module iteration",
  );
  // Tree-shape: per-extension template literal in the renderer
  assert.ok(
    content.includes("${ext.id}"),
    "Instance block must render per-extension tree entries",
  );
  // Tree indentation: 4-space indent for extension leaves
  assert.ok(
    content.includes("    - ${ext.id}"),
    "Instance block must use 4-space indented tree leaves",
  );
});

test("instance-composition shows tool counts per extension", () => {
  const content = readFileSync(FILES.instanceComp, "utf-8");
  assert.ok(
    content.includes("getToolProvenance"),
    "instance-composition must use tool provenance",
  );
  // Tool count badge: [N tool(s)] or [N tools]
  assert.ok(
    /\[N tool|\$\{count\} tool/.test(content) || /tool\$\{count === 1/.test(content),
    "Instance block must show per-extension tool counts",
  );
});

test("instance-composition labels unmatched tools as 'external' (not pi-core)", () => {
  // Tools not attributed to any braid manifest entry (contrib + pi-core
  // built-ins) are surfaced as a separate 'external' group. Earlier the
  // label was 'pi-core: N built-in tool(s)' which was misleading once
  // pi-braid-contrib started showing up there.
  const content = readFileSync(FILES.instanceComp, "utf-8");
  assert.ok(
    content.includes("externalTools"),
    "Instance block must use externalTools field name (was coreTools)",
  );
  assert.ok(
    !content.includes("coreTools"),
    "Instance block must not retain the old coreTools name",
  );
  assert.ok(
    content.includes("external:"),
    "Instance block must render the 'external:' group label",
  );
  assert.ok(
    content.includes("pi-core + contrib"),
    "Instance block must annotate external as 'pi-core + contrib'",
  );
});

test("loader records tool provenance after each extension loads", () => {
  const content = readFileSync(FILES.loader, "utf-8");
  assert.ok(
    content.includes("recordToolRegistration"),
    "loader must call recordToolRegistration",
  );
  assert.ok(
    content.includes("getAllTools"),
    "loader must use getAllTools to detect new tools",
  );
  // Diff-before/after pattern: toolsBefore Set
  assert.ok(
    content.includes("toolsBefore"),
    "loader must use before/after diff pattern for tool provenance",
  );
});

test("tool-provenance module exports the registry API", () => {
  const content = readFileSync(FILES.toolProvenance, "utf-8");
  const required = [
    "getToolProvenance",
    "recordToolRegistration",
    "getToolSource",
    "getToolsByExtension",
    "clearToolProvenance",
  ];
  for (const fn of required) {
    assert.ok(
      content.includes(fn),
      `tool-provenance must export ${fn}`,
    );
  }
});

test("Instance block does not leak AGENTS.md content into the prompt", () => {
  // The instance-composition module must NOT read project AGENTS.md
  // or call loadProjectContextFiles. It only surfaces manifest + state.
  const content = readFileSync(FILES.instanceComp, "utf-8");
  assert.ok(
    !content.includes("AGENTS.md") && !content.includes("loadProjectContextFiles"),
    "Instance block must not pull project doc content (pointer-only elsewhere)",
  );
});

test("manifest is the single source of truth for the extension tree", () => {
  const content = readFileSync(FILES.instanceComp, "utf-8");
  assert.ok(
    content.includes("from \"../../../extensions/manifest.js\""),
    "instance-composition must import from extensions/manifest",
  );
});

// ── Report ──────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

console.log(`\n${passed}/${results.length} subtests passed`);
if (failed > 0) {
  for (const r of results.filter((r) => !r.pass)) {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  }
  process.exit(1);
}
console.log("test-instance-composition: all green");
