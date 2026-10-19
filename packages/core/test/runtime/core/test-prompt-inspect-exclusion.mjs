/**
 * Regression test: prompt_inspect's includeTools/includeSkills exclusion
 * against braid-composed prompts.
 *
 * Failure mode guarded: exclusion patterns built from lookahead terminators
 * that never occur after the braid "Available tools:" inventory (it is
 * followed by the "In addition to the tools above..." paragraph), and a
 * skills pattern targeting the native-pi <available_skills> block the braid
 * prompt-builder never renders, match nothing - so the tool reports
 * "0 lines removed" while the sections still render. The tool's contract
 * (per its description: "false shows a count marker") is exclusion, not
 * advisory, so the filters match the actual braid prompt shape and are
 * exported as pure functions for direct pinning.
 *
 * The live braid prompt carries no Resources pointer line, so
 * excludeSkillsBlock degrades to 0-removed against it ("absent, never
 * wrong"); the pure function stays because third-party, hostile, or
 * pi-native prompt shapes can still carry a "Resources: N skills" line, and
 * the fixtures below pin the parser byte-for-byte. The braid-shape replica
 * here pins a shape that still carries a Resources line (matching those
 * foreign shapes); it is not an assertion about the live braid prompt shape.
 *
 * Pinned here:
 * 1. excludeToolsBlock removes the whole inventory (header + item lines),
 * replaces it with the count marker, and reports honest telemetry.
 * 2. A "(none)" inventory is removed with toolCount 0.
 * 3. excludeSkillsBlock replaces the Resources line with the marker
 * carrying the parsed skill count.
 * 4. On a byte-level replica of the braid-composed prompt both exclusions
 * together remove every tool/skill line and keep the surrounding prose.
 * 5. Absent sections degrade to 0-removed / count 0 (absent, never wrong).
 * 6. A blank `truncate` (converted to 0 by argument validation) applies the
 *    documented 5000-char default. The description used to define 0 as "no
 *    limit", so a blank flipped the tool into dumping the whole assembled
 *    prompt; a real truncate still applies.
 *
 * Run: node test/runtime/core/test-prompt-inspect-exclusion.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { excludeToolsBlock, excludeSkillsBlock, createPromptInspectTool } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "inspect.js")
);
const { validateToolArguments } = await import("@earendil-works/pi-ai/utils/validation");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(` [ok] ${name}`);
    })
    .catch((e) => {
      failed++;
      console.log(` [fail] ${name}: ${e.message}`);
    });
}

/** Byte-shape replica of the braid-composed prompt around the two blocks. */
function braidPrompt({ tools = 3, skills = 28 } = {}) {
  const toolLines = Array.from(
    { length: tools },
    (_, i) => `- tool${i + 1}: description line ${i + 1}`,
  ).join("\n");
  return [
    "You are Braid.",
    "",
    `Resources: ${skills} skills — call list_skills for the name/path/purpose catalog.`,
    "",
    "Available tools:",
    toolLines,
    "",
    "Other custom tools may exist depending on the project.",
  ].join("\n");
}

console.log("=== H-8: prompt_inspect includeTools/includeSkills exclusion ===\n");

await test("excludeToolsBlock removes the braid inventory and reports honest counts", () => {
  const prompt = braidPrompt({ tools: 3 });
  const out = excludeToolsBlock(prompt);
  assert.equal(out.toolCount, 3);
  // 1 header + 3 item lines removed.
  assert.equal(out.linesRemoved, 4);
  assert.ok(!out.text.includes("- tool1:"), "tool lines must not render");
  assert.ok(!out.text.includes("Available tools:"), "header must not render");
  assert.match(
    out.text,
    /\[TOOLS: 3 tools registered — excluded\. Use includeTools=true to show\.\]/,
  );
  // The surrounding prose survives with its blank-line separation intact.
  assert.match(out.text, /Other custom tools may exist/);
  assert.match(out.text, /\n\n\[TOOLS: 3 tools registered[^\n]*\]\n\nOther custom tools/);
});

await test("excludeToolsBlock handles a '(none)' inventory", () => {
  const prompt = [
    "You are Braid.",
    "",
    "Available tools:",
    "(none)",
    "",
    "Other custom tools may exist depending on the project.",
  ].join("\n");
  const out = excludeToolsBlock(prompt);
  assert.equal(out.toolCount, 0);
  assert.ok(out.text.includes("(none)") === false, "(none) line is replaced");
  assert.match(out.text, /\[TOOLS: 0 tools registered/);
});

await test("excludeSkillsBlock replaces the Resources one-liner with the count marker", () => {
  const prompt = braidPrompt({ skills: 28 });
  const out = excludeSkillsBlock(prompt);
  assert.equal(out.skillCount, 28);
  assert.equal(out.linesRemoved, 1);
  assert.ok(!out.text.includes("call list_skills for the name/path/purpose catalog"));
  assert.match(
    out.text,
    /\[SKILLS: 28 skills available — excluded\. Use includeSkills=true to show\.\]/,
  );
});

await test("both exclusions on the real braid shape remove every tool/skill line (H-8: no more '0 lines removed')", () => {
  const prompt = braidPrompt({ tools: 65, skills: 28 });
  const skills = excludeSkillsBlock(prompt);
  const tools = excludeToolsBlock(skills.text);
  assert.equal(skills.linesRemoved, 1, "skills: 1 line removed");
  assert.equal(tools.linesRemoved, 66, "tools: header + 65 items removed");
  assert.equal(tools.toolCount, 65);
  assert.ok(!/^- /m.test(tools.text), "no tool item lines survive");
  assert.ok(!tools.text.includes("Resources: 28 skills"));
  // Markers present exactly once each.
  assert.equal(tools.text.match(/\[TOOLS:/g)?.length, 1);
  assert.equal(tools.text.match(/\[SKILLS:/g)?.length, 1);
});

await test("absent sections degrade to 0 removed (absent, never wrong)", () => {
  const outTools = excludeToolsBlock("No tools section here.\n\nJust prose.");
  assert.deepEqual(outTools, {
    text: "No tools section here.\n\nJust prose.",
    linesRemoved: 0,
    toolCount: 0,
  });
  const outSkills = excludeSkillsBlock("No resources line here.");
  assert.deepEqual(outSkills, { text: "No resources line here.", linesRemoved: 0, skillCount: 0 });
});

// ── truncate: a blank value applies the documented default ─────────────────

const LONG_PROMPT = "You are Braid.\n" + "line of prompt text\n".repeat(600);

function inspectCtx() {
  return { getSystemPrompt: () => LONG_PROMPT };
}

function validatedInspectArgs(raw) {
  const tool = createPromptInspectTool();
  return {
    tool,
    args: validateToolArguments(
      { name: "prompt_inspect", parameters: tool.parameters },
      { name: "prompt_inspect", arguments: raw },
    ),
  };
}

await test("prompt_inspect with a blank truncate truncates at the documented 5000", async () => {
  const { tool, args } = validatedInspectArgs({ truncate: "" });
  assert.equal(args.truncate, 0, "the framework converts the blank truncate to 0 (tested path)");
  const res = await tool.execute("i1", args, undefined, undefined, inspectCtx());
  assert.equal(res.details.truncated, true, "a blank truncate must not dump the whole prompt");
  assert.match(res.content[0].text, /truncated at 5000 chars/);
  assert.ok(res.content[0].text.length < LONG_PROMPT.length);
});

await test("prompt_inspect control: a real truncate still applies", async () => {
  const { tool, args } = validatedInspectArgs({ truncate: 300 });
  const res = await tool.execute("i2", args, undefined, undefined, inspectCtx());
  assert.equal(res.details.truncated, true);
  assert.match(res.content[0].text, /truncated at 300 chars/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
