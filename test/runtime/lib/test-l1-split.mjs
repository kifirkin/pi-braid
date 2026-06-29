/**
 * Test: prompt-builder L1 split (v3.6).
 *
 * Pins the three-block architecture for the system prompt:
 *   - Instance (stable per session-start): identity, root, cwd, os,
 *     datetime, module tree — owned by instance-composition.ts (v3.5)
 *   - Session (volatile): PID, session time, last event, turns, tool
 *     avg — owned by session-section.ts (v3.6)
 *   - Context (conditional): context %, session health, memory count,
 *     steps since checkpoint — owned by context-section.ts (v3.6)
 *
 * Replaces the pre-v3.6 monolithic `l1-environment.ts` which mixed
 * all three categories. Source-level contract test (same family as
 * test-instance-composition.mjs and test-prompt-builder-values.mjs).
 *
 * Catches:
 *   - re-introduction of l1-environment.ts (regression)
 *   - removal of session-section.ts or context-section.ts (regression)
 *   - prompt-builder not wiring the new sections in the right order
 *   - agent-environment still exposing the superseded formatter
 *   - the volatile/conditional categories getting mixed again
 *
 * History: introduced 2026-06-29 to pin the v3.6 L1 split.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  promptBuilder: join(ROOT, "src/extensions/core/prompt-builder/index.ts"),
  instanceComp: join(ROOT, "src/extensions/core/prompt-builder/instance-composition.ts"),
  sessionSection: join(ROOT, "src/extensions/core/prompt-builder/session-section.ts"),
  contextSection: join(ROOT, "src/extensions/core/prompt-builder/context-section.ts"),
  agentEnvironment: join(ROOT, "src/extensions/core/agent-environment/index.ts"),
  promptBuilderAgents: join(ROOT, "src/extensions/core/prompt-builder/AGENTS.md"),
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

test("l1-environment.ts is removed (v3.6 split is permanent)", () => {
  // Path is built at runtime (not as a "src/..." literal in source)
  // so check-deps.mjs does not flag the deleted path as a stale
  // test reference. The contract is the same: the file must not
  // exist anywhere under the prompt-builder directory.
  const l1Path = join(dirname(FILES.promptBuilder), "l1-environment.ts");
  assert.ok(
    !existsSync(l1Path),
    "l1-environment.ts must be removed; the L1 split is permanent",
  );
});

test("session-section.ts exists and exports sessionSection", () => {
  const content = readFileSync(FILES.sessionSection, "utf-8");
  assert.ok(
    content.includes("export async function sessionSection"),
    "session-section.ts must export sessionSection",
  );
  assert.ok(
    content.includes("sessionElapsedMs"),
    "session-section must consume sessionElapsedMs from agent-environment",
  );
  assert.ok(
    content.includes("turnCount"),
    "session-section must surface turnCount",
  );
  assert.ok(
    content.includes("## Session"),
    "session-section must render the '## Session' heading",
  );
});

test("session-section drops the machine info (now in Instance)", () => {
  // The pre-v3.6 monolithic l1-environment.ts rendered
  // "Machine: <platform> (<hostname>)" inside the L1 block.
  // Post-v3.6, that line moved to the Instance block. Session
  // must NOT re-introduce it in the rendered output.
  const content = readFileSync(FILES.sessionSection, "utf-8");
  // Pin the formatSessionBlock function body and assert the rendered
  // lines do not include machine/hostname. The data layer may still
  // hold a `machine` field on the gathered type, but the renderer
  // must not pull from it.
  const bodyMatch = content.match(/function formatSessionBlock[\s\S]*?\n\}/);
  assert.ok(bodyMatch, "expected formatSessionBlock function in session-section");
  const body = bodyMatch[0];
  assert.ok(
    !/data\.machine/.test(body),
    "formatSessionBlock must not read data.machine (in Instance since v3.5)",
  );
  assert.ok(
    !body.includes("Machine:") && !body.includes("Hostname:") && !body.includes("Platform:"),
    "session-section.render must not include machine/hostname/platform lines (in Instance)",
  );
});

test("context-section.ts exists with gather + render exports", () => {
  const content = readFileSync(FILES.contextSection, "utf-8");
  assert.ok(
    content.includes("export async function gatherContextState"),
    "context-section must export gatherContextState",
  );
  assert.ok(
    content.includes("export function contextSection"),
    "context-section must export contextSection",
  );
  assert.ok(
    content.includes("## Context"),
    "context-section must render the '## Context' heading",
  );
});

test("context-section omits itself when nothing to surface", () => {
  // The conditional nature of Context: the section returns "" when
  // no field has data, so the caller can drop it entirely. Pin this
  // so the section never renders an empty "## Context" header.
  const content = readFileSync(FILES.contextSection, "utf-8");
  assert.ok(
    content.includes('return ""') || content.includes("return ''"),
    "context-section must short-circuit to empty string when no data",
  );
  for (const gate of [
    "contextPercent > 75",
    "sessionHealth",
    "memoryCount > 0",
    "stepsSinceCheckpoint > 0",
  ]) {
    assert.ok(
      content.includes(gate),
      `context-section must gate on "${gate}"`,
    );
  }
});

test("context-section does NOT re-introduce the v3.5 piRoot duplicate", () => {
  // The pre-v3.5 monolithic L1 block had `Root: ${piRoot}`. v3.5
  // moved that to Instance. v3.6 must not re-introduce it.
  const content = readFileSync(FILES.contextSection, "utf-8");
  assert.ok(
    !content.includes("piRoot") && !content.includes("piRootPath"),
    "context-section must not include piRoot (in Instance since v3.5)",
  );
});

test("agent-environment no longer exports formatL1EnvironmentSection", () => {
  // The formatter was the source of the monolithic L1 block.
  // session-section.ts now does its own formatting from gathered
  // data; formatL1EnvironmentSection should be gone as an export.
  const content = readFileSync(FILES.agentEnvironment, "utf-8");
  assert.ok(
    !/export function formatL1EnvironmentSection/.test(content),
    "agent-environment must not export formatL1EnvironmentSection (v3.6)",
  );
  assert.ok(
    content.includes("export function gatherL1Environment"),
    "agent-environment must still expose gatherL1Environment (data layer)",
  );
});

test("prompt-builder wires Session + Context after Instance", () => {
  // The sections array is built up via both an initial literal and
  // subsequent .push() calls. Verify Session and Context are pushed,
  // Session comes before Context (volatile precedes conditional),
  // and the old l1EnvSection call is gone.
  const content = readFileSync(FILES.promptBuilder, "utf-8");
  assert.ok(
    content.includes('from "./session-section.js"'),
    "prompt-builder must import from session-section",
  );
  assert.ok(
    content.includes('from "./context-section.js"'),
    "prompt-builder must import from context-section",
  );
  assert.ok(
    !content.includes('from "./l1-environment.js"'),
    "prompt-builder must not import l1-environment (removed in v3.6)",
  );
  assert.ok(
    !content.includes("l1EnvSection(") && !content.includes("gatherL1State("),
    "prompt-builder must not call the old l1-environment helpers (v3.6)",
  );
  assert.ok(
    /sections\.push\(session\)/.test(content),
    "prompt-builder must push session into sections",
  );
  assert.ok(
    /sections\.push\(context\)/.test(content),
    "prompt-builder must push context into sections",
  );
  const sessionPushIdx = content.indexOf("sections.push(session)");
  const contextPushIdx = content.indexOf("sections.push(context)");
  assert.ok(
    sessionPushIdx > 0 && contextPushIdx > 0 && sessionPushIdx < contextPushIdx,
    "session (volatile) must be pushed before context (conditional)",
  );
});

test("prompt-builder re-exports the new section helpers", () => {
  // Matches the v3.5 pattern: index.ts re-exports the section
  // builders for callers that import them from the prompt-builder
  // entry point.
  const content = readFileSync(FILES.promptBuilder, "utf-8");
  for (const name of ["sessionSection", "gatherContextState", "contextSection"]) {
    const re = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`);
    assert.ok(re.test(content), `prompt-builder must re-export ${name}`);
  }
  assert.ok(
    !/export\s*\{[^}]*\bgatherL1State\b/.test(content) &&
      !/export\s*\{[^}]*\bl1EnvSection\b/.test(content),
    "prompt-builder must not re-export the old l1-environment helpers",
  );
});

test("AGENTS.md documents the new files and not the old one", () => {
  const content = readFileSync(FILES.promptBuilderAgents, "utf-8");
  assert.ok(
    content.includes("session-section.ts"),
    "AGENTS.md must document session-section.ts",
  );
  assert.ok(
    content.includes("context-section.ts"),
    "AGENTS.md must document context-section.ts",
  );
  assert.ok(
    !content.includes("| `l1-environment.ts`"),
    "AGENTS.md must not document l1-environment.ts (removed)",
  );
});

test("the three-block split has a clear separation of concerns", () => {
  // Final integration pin: each of the three blocks has a distinct
  // role documented in its module header. Catches drift if a future
  // change moves volatile data into Context or stable data into
  // Session.
  const session = readFileSync(FILES.sessionSection, "utf-8");
  const context = readFileSync(FILES.contextSection, "utf-8");
  const instance = readFileSync(FILES.instanceComp, "utf-8");
  assert.ok(
    /volatile/i.test(session),
    "session-section header should describe its volatile nature",
  );
  assert.ok(
    /conditional/i.test(context),
    "context-section header should describe its conditional nature",
  );
  assert.ok(
    /stable per session/i.test(instance),
    "instance-composition header should describe its stable-per-session nature",
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
console.log("test-l1-split: all green");
