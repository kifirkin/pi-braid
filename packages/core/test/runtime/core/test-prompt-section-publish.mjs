/**
 * Test: prompt-builder publication through pi's section seam.
 *
 * braid publishes a stable group as `customPrompt` and the turn-to-turn text
 * as named `sections` entries, which pi diffs against the transcript
 * individually - not one opaque system-prompt string. Publishing rests on
 * two contracts this file pins against pi's own builder:
 *
 * 1. Neutralization: pi renders every native section AND every `sections`
 *    entry, so the native sections braid replaces must be emptied or they
 * reach the model (project_context, skills, addendum), and caller-supplied
 *    entries must not be left in the map, or each renders a second time.
 * 2. Order: caller-supplied section entries must be read out of the options
 *    map before publication replaces it, or they never reach braid's stable
 *    group. The wiring assertion in test-native-prompt-parity.mjs pins the
 *    handler's order.
 *
 * Every assertion runs pi's installed builder over the options the production
 * `publishPromptSections` produced, so it fails on the real rendered section
 * set rather than on a hand-mirror.
 *
 * Seam note: pi's exports map blocks subpath imports, so the internal builder
 * is imported by file URL resolved from the package entry (same seam as
 * test-native-prompt-parity.mjs). It fails loudly if pi relocates the module.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { publishPromptSections } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "section-publish.js")
);
const { composeSections, composeSectionMap, simpleSection } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "section.js")
);
const { customSectionsFrom } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "custom-sections.js")
);
const { piReferenceSection } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "pi-reference-section.js")
);

const piEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const piInternalUrl = new URL("core/system-prompt.js", new URL("./", piEntryUrl)).href;
const pi = await import(piInternalUrl);

// ── fixtures ──────────────────────────────────────────────────────────────
const STABLE = "You are Braid.\n\nStable identity block.";
const CONTEXT = "Context is finite: tag positions before archival.";
const INSTANCE = "You are Braid v0.3.2 | Session: probe";
const PROBE_SECTION = "embedder_probe";
const PROBE_BODY = "Embedder section body.";
const APPEND = "Extra user instruction.";
const PROJECT_RULE = "# project rules";

function baseOptions(overrides = {}) {
  return pi.normalizeBuildSystemPromptOptions({
    cwd: "/virtual/proj",
    selectedTools: ["read", "bash", "edit", "write"],
    toolSnippets: { read: "Read a file" },
    appendSystemPrompt: APPEND,
    contextFiles: [{ path: "/virtual/proj/AGENTS.md", content: PROJECT_RULE }],
    skills: [
      {
        name: "probe-skill",
        description: "A probe skill",
        filePath: "/virtual/skills/probe/SKILL.md",
        baseDir: "/virtual/skills",
      },
    ],
    sections: { [PROBE_SECTION]: PROBE_BODY },
    ...overrides,
  });
}

/**
 * Mirror of the handler's publication step: read the caller entries into the
 * stable group, then publish.
 */
async function publishLikeHandler(options) {
  const dedupSet = new Set();
  const stablePrompt = await composeSections(
    [simpleSection("identity", STABLE), piReferenceSection(), ...customSectionsFrom(options)],
    "\n\n",
    dedupSet,
  );
  const volatileSections = await composeSectionMap(
    [simpleSection("context", CONTEXT), simpleSection("instance", INSTANCE)],
    dedupSet,
  );
  publishPromptSections(options, stablePrompt, volatileSections);
  return { stablePrompt, volatileSections };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("prompt section publication", () => {
  it("publishes the stable group as the preamble and the volatile text as named sections", async () => {
    const options = baseOptions();
    const { stablePrompt } = await publishLikeHandler(options);
    const sections = pi.buildSystemPromptSections(options);

    assert.equal(sections.preamble, stablePrompt, "customPrompt renders as the untagged preamble");
    assert.ok(sections.preamble.startsWith("You are Braid."), "braid's identity leads the preamble");
    assert.ok(
      sections.preamble.includes("pi-reference skill"),
      "the preamble carries the pi docs pointer",
    );
    assert.equal(sections.context, `<context>\n${CONTEXT}\n</context>`);
    assert.equal(sections.instance, `<instance>\n${INSTANCE}\n</instance>`);
    assert.equal(sections.cwd, "<cwd>\n/virtual/proj\n</cwd>");
    // pi adds cwd unconditionally; braid's sections follow it.
    assert.deepEqual(
      Object.keys(sections),
      ["preamble", "cwd", "context", "instance"],
      "the rendered key set is exactly braid's sections plus pi's cwd",
    );
  });

  it("neutralizes the native sections braid replaces", async () => {
    const options = baseOptions();
    await publishLikeHandler(options);
    const sections = pi.buildSystemPromptSections(options);
    const rendered = pi.buildSystemPrompt(options);

    assert.deepEqual(options.contextFiles, [], "contextFiles is emptied (no inline project_context)");
    assert.deepEqual(options.skills, [], "skills is emptied (no inlined catalog)");
    assert.equal(options.appendSystemPrompt, "", "appendSystemPrompt is emptied (no native addendum)");
    assert.ok(!("project_context" in sections), "project_context must not render");
    assert.ok(!("skills" in sections), "the native skills section must not render");
    assert.ok(!("addendum" in sections), "the native addendum must not render");
    assert.ok(!rendered.includes(PROJECT_RULE), "project file content must not reach the prompt");
    assert.ok(!rendered.includes("probe-skill"), "the skill catalog must not reach the prompt");
  });

  it("renders caller-supplied entries once, inside the stable group", async () => {
    const options = baseOptions();
    const { stablePrompt } = await publishLikeHandler(options);
    const sections = pi.buildSystemPromptSections(options);
    const rendered = pi.buildSystemPrompt(options);

    assert.ok(stablePrompt.includes(PROBE_BODY), "the caller entry is read into the stable group");
    assert.ok(!(PROBE_SECTION in sections), "the caller entry must not stay in the options map");
    assert.equal(
      rendered.split(PROBE_BODY).length - 1,
      1,
      "the caller entry must reach the prompt exactly once",
    );
  });

  it("a changed volatile section patches that section alone", async () => {
    // The point of the migration: a turn that changes only the runtime context
    // must re-send only the context section, not the whole head prompt. pi
    // diffs the desired sections against the transcript's.
    const turn1Options = baseOptions();
    await publishLikeHandler(turn1Options);
    const turn1 = pi.buildSystemPromptSections(turn1Options);

    const turn2Options = baseOptions();
    const { volatileSections } = await publishLikeHandler(turn2Options);
    volatileSections.context = `${CONTEXT} Changed line.`;
    const turn2 = pi.buildSystemPromptSections(turn2Options);

    const patch = pi.diffSystemPromptSections(turn1, turn2);
    assert.deepEqual(Object.keys(patch), ["context"], "only the changed section is re-sent");
    assert.equal(patch.context, `<context>\n${CONTEXT} Changed line.\n</context>`);
    assert.equal(patch.preamble, undefined, "the stable group must not be re-sent");
    assert.equal(patch.instance, undefined, "an unchanged section must not be re-sent");

    // Unchanged prompt: no patch at all.
    const turnA = baseOptions();
    await publishLikeHandler(turnA);
    const turnB = baseOptions();
    await publishLikeHandler(turnB);
    assert.equal(
      pi.diffSystemPromptSections(
        pi.buildSystemPromptSections(turnA),
        pi.buildSystemPromptSections(turnB),
      ),
      undefined,
      "an unchanged prompt produces no system message",
    );
  });

  it("relocating the volatile sections preserves the composed text byte for byte", async () => {
    // The handler used to join one list: stable seats, then context and
    // instance, then caller/append entries. It now joins the stable seats
    // (plus caller/append) and publishes context/instance as their own
    // sections, which pi renders last. With no caller or append entries (the
    // CLI case), the two paths must produce the same bytes, in the same order.
    const stable = [
      simpleSection("identity", STABLE),
      simpleSection("guidelines", "- Be concise"),
      simpleSection("tools", "Available tools:\n- read: Read a file"),
    ];
    const context = simpleSection("context", CONTEXT);
    const instance = simpleSection("instance", INSTANCE);

    const oldWay = await composeSections([...stable, context, instance], "\n\n", new Set());

    const dedupSet = new Set();
    const newStable = await composeSections(stable, "\n\n", dedupSet);
    const newVolatile = await composeSectionMap([context, instance], dedupSet);
    const newWay = [newStable, newVolatile.context, newVolatile.instance].join("\n\n");

    assert.equal(newWay, oldWay, "no text may be lost, duplicated, or reordered");
    assert.deepEqual(Object.keys(newVolatile), ["context", "instance"], "context then instance");
  });

  it("composeSectionMap shares the dedup contract with composeSections", async () => {
    const seen = new Set();
    await composeSections([simpleSection("identity", STABLE)], "\n\n", seen);
    const map = await composeSectionMap(
      [
        simpleSection("context", STABLE),
        simpleSection("instance", INSTANCE),
        simpleSection("empty", "   "),
      ],
      seen,
    );
    assert.deepEqual(
      map,
      { instance: INSTANCE },
      "a duplicate of an earlier section and an empty section are both omitted",
    );
    assert.deepEqual(await composeSectionMap([simpleSection("context", CONTEXT)]), {
      context: CONTEXT,
    });
  });
});
