/**
 * Test: pi-native prompt parity — the pi docs pointer and the section registry.
 *
 * braid publishes its prompt through pi's section seam, so pi's native
 * section builder runs on every request. Two contracts keep that seam honest:
 *
 * 1. Content: braid's pi docs seat is a static pointer to the pi-reference
 *    skill (pi-reference-section.ts), never a copy of pi's path list. The
 *    test renders a real native prompt through pi's installed builder to show
 *    the native `docs` region still exists upstream, then asserts braid's
 *    composed group carries the pointer and not the region.
 * 2. Structure: every native section key must be an explicit braid decision
 *    (NATIVE_SECTION_POLICY). The test derives pi's live key set from the
 *    same internal builder, so an upstream section addition fails here
 *    instead of reaching the model as a silent drop.
 *
 * Seam note: pi's exports map blocks subpath imports
 * (ERR_PACKAGE_PATH_NOT_EXPORTED), so the internal builder is imported by
 * file URL resolved from the package entry. The seam is test-only and
 * real: if pi relocates the module the import throws and this file fails
 * loudly, never silently.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

// ── braid production modules ──────────────────────────────────────────────
const { PI_REFERENCE_POINTER, piReferenceSection } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "pi-reference-section.js")
);
const { NATIVE_SECTION_POLICY, unlistedNativeSections } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "section-parity.js")
);
const { customSectionsFrom } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "custom-sections.js")
);
const { composeSections, simpleSection } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "section.js")
);

// ── pi internals (see seam note) ──────────────────────────────────────────
const piEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const piInternalUrl = new URL("core/system-prompt.js", new URL("./", piEntryUrl)).href;
const pi = await import(piInternalUrl);

// ── helpers ───────────────────────────────────────────────────────────────
const PROBE_SECTION = "embedder_probe";

function nativeOptions(overrides = {}) {
  return {
    cwd: "/virtual/proj",
    selectedTools: ["read", "bash", "edit", "write"],
    toolSnippets: { read: "Read a file", bash: "Run a command" },
    toolGuidelines: {},
    promptGuidelines: ["Embedder bullet"],
    appendSystemPrompt: "Extra user instruction.",
    contextFiles: [{ path: "/virtual/proj/AGENTS.md", content: "# project rules" }],
    skills: [
      {
        name: "probe-skill",
        description: "A probe skill",
        filePath: "/virtual/skills/probe/SKILL.md",
        baseDir: "/virtual/skills",
      },
    ],
    sections: { [PROBE_SECTION]: "Embedder section body." },
    ...overrides,
  };
}

function renderSections(options) {
  return pi.buildSystemPromptSections(pi.normalizeBuildSystemPromptOptions(options));
}

function renderPrompt(options) {
  return pi.buildSystemPrompt(pi.normalizeBuildSystemPromptOptions(options));
}

// The eight fixed native section keys (custom keys are dynamic per options).
const EXPECTED_NATIVE_FIXED = [
  "addendum",
  "cwd",
  "docs",
  "preamble",
  "project_context",
  "rules",
  "skills",
  "tools",
].sort();

// ── Tests ─────────────────────────────────────────────────────────────────

describe("pi-reference pointer", () => {
  it("renders a compact pointer to the pi-reference skill, not pi's path list", () => {
    const section = piReferenceSection();
    const text = section.render();
    assert.equal(section.name, "pi-docs");
    assert.equal(text, PI_REFERENCE_POINTER);
    assert.ok(text.includes("read the pi-reference skill"), "pointer must name the skill to read");
    assert.ok(text.includes("list_skills"), "pointer must name the discovery tool");
    assert.ok(!text.includes("<docs>") && !text.includes("</docs>"), "the native region tags must be gone");
    assert.ok(
      !/README\.md|docs\/|examples\//.test(text),
      "the pointer must not re-author pi's path list",
    );
    assert.ok(text.split("\n").length <= 2, "the pointer must stay 1-2 lines");
  });

  it("the composed stable group carries the pointer and not the native docs region", async () => {
    // Precondition: pi's builder still renders the docs region upstream;
    // braid replaces it with the pointer section.
    const native = renderPrompt(nativeOptions());
    assert.ok(native.includes("<docs>"), "pi's native prompt must still carry the docs region");

    const braid = await composeSections(
      [simpleSection("head", "head"), piReferenceSection()],
      "\n\n",
      new Set(),
    );
    assert.equal(braid.split("pi-reference").length - 1, 1, "the pointer must appear exactly once");
    assert.ok(!braid.includes("<docs>"), "braid's stable group must not carry the native region");
    assert.ok(
      !braid.includes("Pi documentation (read only when the user asks about pi itself"),
      "the native docs text must be gone",
    );
  });
});

describe("native section parity", () => {
  it("pi's live section set is fully covered by the disposition registry", () => {
    const options = nativeOptions();
    const derived = Object.keys(renderSections(options));
    const customKeys = Object.keys(options.sections);
    // The derivation must have produced every expected fixed key.
    for (const k of EXPECTED_NATIVE_FIXED) {
      assert.ok(derived.includes(k), `derivation must include fixed key "${k}"`);
    }
    // Strip custom keys (they are rendered via the sections mechanism, not from the fixed set).
    const fixedKeys = derived.filter((k) => !customKeys.includes(k));
    assert.deepEqual(unlistedNativeSections(fixedKeys), [], "every fixed native key must have a disposition entry");
  });

  it("the guard fires on an unknown section key (synthetic probe), passes cleanly without it", () => {
    assert.deepEqual(unlistedNativeSections([...EXPECTED_NATIVE_FIXED, "synthetic_probe"]), ["synthetic_probe"]);
    assert.deepEqual(unlistedNativeSections(EXPECTED_NATIVE_FIXED), []);
  });

  it("registry completeness: every required key has a disposition entry and each lists a reason", () => {
    const byKey = new Map(NATIVE_SECTION_POLICY.map((p) => [p.key, p]));
    const required = [...EXPECTED_NATIVE_FIXED, "sections", "promptGuidelines", "customPrompt"];
    for (const key of required) {
      const entry = byKey.get(key);
      assert.ok(entry, `registry must contain a disposition entry for "${key}"`);
      assert.ok(typeof entry.reason === "string" && entry.reason.trim().length > 0, `entry for "${key}" must have a non-empty reason`);
      assert.match(entry.disposition, /^(rendered|replaced|preserved|dropped)$/, `entry for "${key}" must be a valid disposition`);
    }
    // Specific disposition expectations (full contract).
    assert.equal(
      byKey.get("docs").disposition,
      "dropped",
      "the pi-reference skill owns pi's docs index; braid no longer re-emits the native region",
    );
    assert.equal(byKey.get("addendum").disposition, "preserved");
    assert.equal(byKey.get("sections").disposition, "rendered", "custom sections are rendered via passthrough");
    assert.equal(byKey.get("promptGuidelines").disposition, "dropped");
    assert.equal(byKey.get("customPrompt").disposition, "dropped");
  });

  it("custom sections pass through from options (rendered via passthrough)", async () => {
    const secs = customSectionsFrom({ sections: { [PROBE_SECTION]: "Embedder section body.", blank: "" } });
    assert.equal(secs.length, 1, "only one non-empty custom section should be produced");
    assert.equal(secs[0].name, PROBE_SECTION);
    const composed = await composeSections(secs, "\n\n");
    assert.ok(composed.includes("Embedder section body."));
    // Empty inputs produce nothing.
    assert.deepEqual(customSectionsFrom(undefined), []);
    assert.deepEqual(customSectionsFrom({}), []);

    // The custom key really renders in pi's native build — the mechanism
    // this mirror passes through.
    const rendered = renderSections(nativeOptions());
    assert.ok(PROBE_SECTION in rendered, "pi's builder must include the custom key");
  });

  it("handler wiring: the stable group is composed, then published through the seam", () => {
    const handlerSource = readFileSync(
      join(ROOT, "dist", "extensions", "core", "prompt-builder", "index.js"),
      "utf8",
    );
    assert.ok(handlerSource.includes("piReferenceSection("), "handler must call piReferenceSection");
    assert.ok(
      !handlerSource.includes("nativeDocsSection("),
      "the native docs extraction call must be gone",
    );
    assert.ok(handlerSource.includes("customSectionsFrom("), "handler must call customSectionsFrom");
    assert.ok(handlerSource.includes("composeSectionMap("), "handler must compose its named sections");
    assert.ok(
      handlerSource.includes("publishPromptSections("),
      "handler must publish through the section seam",
    );
    assert.ok(
      !handlerSource.includes("return { systemPrompt:"),
      "handler must not force a system prompt: forcing collapses the sections",
    );
    // Seat order inside the stable group: tools, then the pi docs pointer.
    const toolsPos = handlerSource.indexOf("push(toolsSection(tools))");
    const docsPos = handlerSource.indexOf("piReferenceSection(");
    assert.ok(toolsPos !== -1 && docsPos > toolsPos, "pi docs pointer seat must be after tools section");
    // Publication order: caller entries are read out of the options map during
    // composition, so that read must happen before publication replaces the map.
    const composePos = handlerSource.indexOf("composeSections(stableSections");
    const callerPos = handlerSource.indexOf("customSectionsFrom(");
    const publishPos = handlerSource.indexOf("publishPromptSections(");
    assert.ok(
      composePos !== -1 && composePos < publishPos,
      "the stable group must be composed before publication (caller entries are read during it)",
    );
    assert.ok(
      callerPos !== -1 && callerPos < publishPos,
      "caller entries must be read before publication replaces the options map",
    );
  });
});