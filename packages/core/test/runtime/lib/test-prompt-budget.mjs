/**
 * Test: prompt-builder structural de-dup regression guard.
 *
 * What this file does:
 * - Calls the REAL public assembly entry the runtime uses: composeSections()
 * from dist/.../section.js — the exact function prompt-builder/index.ts
 * invokes with the "\n\n"separator + a dedup set. The fixed tool set is
 * fed INTO the builder as a PromptSection list (built with the real
 * exported section builders and dist constants); it is not used to
 * hand-rebuild raw strings.
 * - Asserts BEHAVIORAL INVARIANTS on the assembled output, one per
 * de-dup regression mode:
 * a. EXACTLY-ONCE: every documented `- <name>: <reflection>`tool
 * one-liner, every tool-pipeline line, the skills-loading directive
 * and a representative guidance line each appears EXACTLY once.
 * b. DISCOVERY HONORS GUARDS: a guarded discovery line renders when its
 * guard tool is in the fixed set and is dropped when it is not.
 * c. PROJECT-DOCS POINTER: the pointer/directive renders only when
 * project-docs context is supplied to the builder.
 * d. NO EMPTY SECTIONS: every expected section contributes text.
 * e. ASSEMBLY INTEGRITY: identity stance + at least one tool one-liner +
 * skills-loading guidance are all present — real sections joined, not
 * a degenerate string.
 * f. NO char-count / budget assertions of any kind. (A single soft
 * `> 1000 chars`floor below proves assembly; it is NOT a ceiling on
 * bloat and is the only numeric bound in the file.)
 * g. perToolGuidelines() is NOT used here — it has 0 production callers
 * and is pinned as a test-only fixture by test-tool-pipelines.mjs.
 * The exactly-once scans above are the correct de-dup replacement.
 *
 * DETERMINISM: the assembly reads only dist/ module constants + the fixed
 * tool-set / project-docs inputs below — no process.env, no fs, no skills
 * dirs, no session state. It therefore passes identically on a clean
 * checkout, and that is itself asserted (two assemblies of the same inputs
 * must be byte-identical).
 *
 * Tool set fed to the builder: every TOOL_GUIDELINES key ∪ every tool-pipeline
 * guard tool. Guard-only tools without an owned guideline (e.g. fetch_content,
 * context_inspect) participate in guard matching but render NO one-liner:
 * the live tools section renders owned lines only — a tool whose line would
 * come from the description-firstSentence fallback is skipped entirely
 * (its registered description rides the API tools channel). The exactly-once
 * scan therefore covers the documented tools — the set whose one-liners are
 * stable text.
 *
 * The memory-section pointer block and the L1 context bullet section are
 * environment-dependent (session stats, live memory counts) and are excluded
 * here by design. The structural de-dup contract under test is the
 * identity/guidelines/discovery/pipelines/resources/tools/project-docs
 * composition.
 *
 * Keep this as a SINGLE file: the suite runner counts files per directory.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const {
  REPAIR_DISCIPLINE,
  EPISTEMIC_STANCE,
  SELF_AUDIT,
  PHILOSOPHY,
  DISCOVERY,
} = await import(join(ROOT, "dist", "extensions", "core", "prompt-builder", "identity.js"));

// Skills-loading text is owned by the skills-tool module and rendered by
// prompt-builder as its own guarded section (relocation pin: the text and
// its guard travel with the tool that owns the strategy). The mechanical
// trigger's worked examples are derived from the inputs, so the test feeds
// a fixed synthetic catalog to keep the assembly environment-free.
const { skillsCatalogRule, SKILLS_POINTER_RULE, mechanicalTriggerExamples, skillsLoadingText } =
  await import(join(ROOT, "dist", "extensions", "core", "skills-tool", "loading-guidance.js"));

// Surface discipline is its own prompt-builder section file; the handler
// renders it between the identity and identity-core blocks (render order:
// COMMUNICATION → SURFACE_DISCIPLINE → EPISTEMIC_STANCE).
const { SURFACE_DISCIPLINE, surfaceDisciplineSection } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "surface-discipline-section.js")
);

const { TOOL_GUIDELINES, resolveOwnedToolLine, resolveToolLine } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "tool-guidelines.js")
);

const { EXTERNAL_TOOL_GUIDELINES } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "external-tool-guidelines.js")
);

const { TOOL_PIPELINES, toolPipelineLines } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "tool-pipelines.js")
);

const { composeSections, simpleSection, linesSection } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "section.js")
);

// The identity seat is the HANDLER'S OWN section list: identitySection() is a
// pure export from the built prompt-builder/index.js (the same module the
// timer recovery tests already import). Feeding it to the assembly below means
// every seat/verbatim assertion in this file exercises the production
// composition — a seat move in the handler fails here, not just in a mirror.
const { identitySection } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "index.js")
);

// Context-cadence line: the prompt carries the
// generic pipeline stance; threshold literals are gone — the extension
// ladder (context-thresholds.ts) is the single source of truth. The mirror
// below pins the exact production string; any drift fails the exactly-once
// and stance-presence assertions.
const CONTEXT_CADENCE_LINE =
  "Context is finite: tag positions before archival, archive old ranges deliberately, inspect health often; obey context-lifecycle advisories.";

const { projectDocsSection } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "project-docs-section.js")
);

// Memory pointer block: environment-dependent (live paths) and excluded from
// the assembly above by design — pinned directly against the dist renderer.
const { reconstructMemorySection } = await import(
  join(ROOT, "dist", "extensions", "core", "prompt-builder", "memory-section.js")
);

// ── Fixed representative tool set (deterministic, environment-free) ──────────
// every TOOL_GUIDELINES key ∪ every tool-pipeline guard tool ∪ the
// context-navigation guideline guard tools (the
// contextNavigationGuidelines lines — branching-tree, context-cadence, health —
// are part of the de-dup contract and only render when their guard tools are
// active, as in a real session). Closed under guards by construction, so every
// pipeline + discovery guard renders.
const DOC_TOOLS = Object.keys(TOOL_GUIDELINES);
const PIPELINE_GUARD_TOOLS = [...new Set(Object.values(TOOL_PIPELINES).flatMap((p) => p.guard))];

// pi-core 1.1.0 self-registers `promptGuidelines` for exactly these five
// builtins (dist/core/tools/{read,bash,edit,write,powershell}.js
// `*ToolSystemPromptContribution.guidelines`) and getAllTools() exposes them,
// so in a live session resolveOwnedToolLine sees priority 1 for these names.
// Braid curates the rendered rows for them; the synthetic lines below
// reproduce the owning package's thinner text so the override is exercised.
const PI_BUILTIN_PROMPT_GUIDELINES = {
  read: ["Use read to examine files instead of cat or sed."],
  bash: [
    "You can inspect PI_* environment variables for current model and session details.",
  ],
  edit: ["Use edit for precise changes (edits[].oldText must match exactly)"],
  write: ["Use write only for new files or complete rewrites."],
  powershell: [
    "You can inspect PI_* environment variables for current model and session details.",
  ],
};
const PINNED_BUILTIN_NAMES = ["read", "bash", "edit", "write", "powershell"];
const CONTEXT_NAV_GUARD_TOOLS = [
  "context_navigate",
  "context_compress",
  "context_inspect",
  "context_proposals",
];
// The herdr family renders no tool row (external guideline map, no
// TOOL_GUIDELINES key) but is active in every real session; including it
// gives the skills-loading derivation a real pair to render.
const HERDR_FAMILY_TOOLS = ["herdr_agent", "herdr_layout", "herdr_pane"];
// Fixed synthetic catalog for the floor's rows and the derived trigger
// examples (the real catalog is runtime state). It mirrors today's relevant
// shape with stable names: a herdr skill exists; no memory or session skill
// does. The rows live under one synthetic pack, so the section states that
// root.
const SKILL_NAMES = ["herdr-topology", "placement-discipline", "pi-reference"];
const SYNTHETIC_PACK = "/catalog";
const SKILL_ROWS = SKILL_NAMES.map((name) => ({
  name,
  description: `Synthetic row for ${name}.`,
  filePath: `${SYNTHETIC_PACK}/${name}/SKILL.md`,
}));
const ALL_TOOLS = [
  ...new Set([
    ...DOC_TOOLS,
    ...PIPELINE_GUARD_TOOLS,
    ...CONTEXT_NAV_GUARD_TOOLS,
    ...HERDR_FAMILY_TOOLS,
  ]),
];

/** Fixed, deterministic fake project-docs set (no fs access). */
const FAKE_PROJECT_DOCS = [{ path: "/virtual/proj/AGENTS.md", content: "" }];

/**
 * Faithful mirrors of the PRIVATE helpers in dist prompt-builder/index.js
 * (fileToolGuidelines / communicationGuidelines / contextNavigationGuidelines /
 * toolsSection), extracted from the dist build so the section list assembled
 * here matches the live handler line-for-line. They feed the REAL
 * linesSection({ dedup: true }) and the REAL composeSections, so the de-dup
 * contract itself is exercised by production code — not re-derived by hand.
 */
function fileToolGuidelines(toolNames) {
  const lines = [];
  const hasBash = toolNames.includes("bash");
  const hasGrep = toolNames.includes("grep");
  const hasFind = toolNames.includes("find");
  const hasLs = toolNames.includes("ls");
  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    lines.push("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    lines.push(
      "Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    );
  }
  return lines;
}

function communicationGuidelines(toolNames) {
  const lines = [
    "Write text that reads naturally, as if written by a human, not generated by a machine",
  ];
  const hasRead = toolNames.includes("read");
  const hasBash = toolNames.includes("bash");
  if (hasRead || hasBash) {
    lines.push("Show file paths clearly when working with files");
  }
  return lines;
}

function contextNavigationGuidelines(toolNames) {
  const lines = [];
  const hasContextNavigate = toolNames.includes("context_navigate");
  const hasContextCompress = toolNames.includes("context_compress");
  if (!hasContextNavigate && !hasContextCompress) {
    return lines;
  }
  lines.push("");
  if (hasContextNavigate) {
    lines.push(
      "The session is a branching tree \u2014 tag positions, log to see history, checkout to jump to a leaf with its context summarized. Use backupTag to save your spot before jumping.",
    );
  }
  if (hasContextCompress) {
    // Mirrors index.ts: context-cadence stance line (no threshold
    // literals in the prompt; the extension ladder owns the numbers).
    lines.push(CONTEXT_CADENCE_LINE);
  }
  // Mirrors index.ts: tool mechanics stay in tool descriptions (dedup with
  // the tools channel); no Health line here either.
  return lines;
}

function guidelinesSection(toolNames) {
  return linesSection(
    "guidelines",
    [
      ...fileToolGuidelines(toolNames),
      ...communicationGuidelines(toolNames),
      ...contextNavigationGuidelines(toolNames),
    ],
    { dedup: true },
  );
}

/** Mirrors index.ts toolsSection for owned tools (single render):
 * the live section renders owned lines only — no description fallback. */
function toolsSection(toolOneLiners) {
  return simpleSection(
    "tools",
    `Available tools:\n${toolOneLiners.join("\n") || "(none)"}\n\nOther custom tools may exist depending on the project.`,
  );
}

/**
 * Assemble a REAL system prompt via the production composition entry
 * (composeSections + "\n\n" + a fresh dedup set — exactly what index.ts's
 * before_agent_start handler passes). The identity seat comes from the
 * handler's own exported section list (identitySection()); the remaining
 * section list mirrors the handler's. The inputs are the fixed tool set, an
 * optional fake project-docs set, and an optional synthetic
 * tool -> promptGuidelines map (the priority-path input) — fully deterministic.
 */
async function assemblePrompt({ toolNames, projectDocs = [], toolGuidelines = {} }) {
  const hasRead = toolNames.includes("read");
  const hasListSkills = toolNames.includes("list_skills");

  const discoveryLines = DISCOVERY.filter(
    (line) => line.guard.length === 0 || line.guard.some((t) => toolNames.includes(t)),
  ).map((line) => line.text);

  const pipelineLines = toolPipelineLines(toolNames);

  // Only documented tools render deterministic one-liners (see file docstring).
  // Rows resolve through the REAL production resolver so the priority path
  // (owner promptGuidelines vs curated record) is exercised rather than
  // bypassed; with no synthetic guidelines supplied this is byte-identical
  // to the former direct TOOL_GUIDELINES render.
  const toolOneLiners = toolNames
    .filter((t) => Object.prototype.hasOwnProperty.call(TOOL_GUIDELINES, t))
    .map((t) => {
      const line = resolveOwnedToolLine(t, toolGuidelines[t]);
      return line ? `- ${t}: ${line}` : null;
    })
    .filter((l) => l !== null);

  const sections = [
    // 1. identity — the main block IS the production section list (the
    // handler's exported identitySection()); the three seats (main,
    // surface-discipline, core) keep the rendered order of the former single
    // block: COMMUNICATION → SURFACE_DISCIPLINE → EPISTEMIC_STANCE.
    identitySection(),
    surfaceDisciplineSection(),
    simpleSection(
      "identity-core",
      [EPISTEMIC_STANCE, SELF_AUDIT, PHILOSOPHY].join("\n\n"),
    ),

    // 2. skills-loading — guarded by read + list_skills (as in index.ts);
    //    the floor renders every row of the fixed catalog.
    ...(hasRead && hasListSkills
      ? [simpleSection("skills-loading", skillsLoadingText(toolNames, SKILL_ROWS))]
      : []),

    // 3. guidelines (dedup: true in production builder).
    guidelinesSection(toolNames),

    // 4. discovery — guarded by tool availability.
    ...(discoveryLines.length > 0 ? [simpleSection("discovery", discoveryLines.join("\n\n"))] : []),

    // 5. tool-usage pipelines — guarded.
    ...(pipelineLines.length > 0 ? [simpleSection("pipelines", pipelineLines.join("\n\n"))] : []),

    // 6. resources — REMOVED (: dead, duplicated by the skills-loading
    // contract and the list_skills tool description).

    // 7. tools — one line per documented tool (round-20 single-render).
    toolsSection(toolOneLiners),

    // 8. context — project-docs pointer only (memory + L1 bullets are
    // environment-dependent and excluded by design, see file docstring).
    simpleSection(
      "context",
      [...(hasRead ? [await projectDocsSection(projectDocs)] : [])]
        .filter((s) => s && s.trim() !== "")
        .join("\n\n"),
    ),

    // 9. instance — static placeholder (the live line carries process-stable
    //    identity: build, install root, model, PID, session, resource counts).
    simpleSection(
      "instance",
      "Agent: Braid vTEST (over pi-core vTEST) | Root: /virtual/braid | Model: test/model | PID: 1 | Session: structural-test | Resources: 0 skills, 0 memories",
    ),
  ];

  return composeSections(sections, "\n\n", new Set());
}

/** Count how many whole output lines equal `needle`exactly. */
function countLines(output, needle) {
  return output.split("\n").filter((l) => l === needle).length;
}

const DISCOVERY_UNCONDITIONAL = DISCOVERY.find((l) => l.guard.length === 0).text;
//: the guarded orientation line was dropped — the system_info tool
// description covers it. DISCOVERY is now the single unconditional stance line.
const DISCOVERY_ORIENTATION_NEEDLE = "Orientation: run system_info to see the runtime";

describe("prompt-builder (structural de-dup regression guard)", () => {
  it("determinism: identical fixed inputs produce byte-identical output", async () => {
    const inputs = { toolNames: ALL_TOOLS, projectDocs: FAKE_PROJECT_DOCS };
    const [a, b] = await Promise.all([assemblePrompt(inputs), assemblePrompt(inputs)]);
    assert.equal(a, b, "two assemblies of the same fixed inputs must be byte-identical");
    assert.ok(a.trim().length > 0, "assembled prompt must not be empty");
    // Assembled-size report: the fixed-input assembly is the deterministic
    // measurement surface for prompt-cost deltas (no ceiling — size is not
    // a contract; the number is printed so waves can diff it).
    console.log(`[prompt-budget] assembled prompt: ${a.length} chars`);
    // The fixed set is closed under pipeline guards — every pipeline renders.
    for (const p of Object.values(TOOL_PIPELINES)) {
      for (const g of p.guard) {
        assert.ok(
          ALL_TOOLS.includes(g),
          `pipeline "${p.label}" guards "${g}" which is missing from the fixed set`,
        );
      }
    }
  });

  it("exactly-once: every documented tool one-liner appears exactly once (round-20 de-dup contract)", async () => {
    const output = await assemblePrompt({ toolNames: ALL_TOOLS });
    assert.ok(
      DOC_TOOLS.length >= 25,
      `documented tool set shrank unexpectedly: ${DOC_TOOLS.length}`,
    );
    assert.equal(new Set(DOC_TOOLS).size, DOC_TOOLS.length, "TOOL_GUIDELINES keys must be unique");
    for (const name of DOC_TOOLS) {
      const needle = `- ${name}: ${TOOL_GUIDELINES[name]}`;
      const n = countLines(output, needle);
      assert.equal(n, 1, `tool one-liner for "${name}" must appear exactly once (found ${n})`);
    }
  });

  it("exactly-once: every tool-pipeline line appears exactly once", async () => {
    const output = await assemblePrompt({ toolNames: ALL_TOOLS });
    const flattened = toolPipelineLines(ALL_TOOLS);
    //: 2 domains (implementation merged into the understand-before-act
    // framing; verification dropped as a restatement of its tools' rows),
    // 3 lines total.
    assert.equal(flattened.length, 3, "pipelines render exactly the 2-domain, 3-line set");
    for (const line of flattened) {
      const n = countLines(output, line);
      assert.equal(n, 1, `pipeline line must appear exactly once: "${line}"`);
    }
  });

  it("exactly-once: skills-loading directive and a guidance line each appear once", async () => {
    const output = await assemblePrompt({ toolNames: ALL_TOOLS });
    // Skills-loading is a multi-line section — count as a whole block. The
    // text is the builder's output over the same fixed inputs the assembly
    // consumed (byte-identical by construction).
    const sectionText = skillsLoadingText(ALL_TOOLS, SKILL_ROWS).trim();
    const ndl = output.split(sectionText).length - 1;
    assert.equal(ndl, 1, "skills-loading directive must appear exactly once");
    // Strategy contract: pointer rule, mid-task re-list trigger,
    // never-act-from-memory, and the when-not test all travel together.
    assert.ok(
      output.includes("Pointer rule: the catalog one-liner is metadata, not content"),
      "pointer rule must render",
    );
    assert.ok(
      !output.includes("call list_skills again"),
      "the re-list trigger is superseded: the whole catalog is in the prompt",
    );
    assert.ok(
      output.includes("never act from memory of a skill's contents"),
      "re-read rule must render (compressed form)",
    );
    assert.ok(
      output.includes(
        "The prompt already covering the domain is the only reason to skip the read",
      ),
      "when-not test must render (compressed form)",
    );
    assert.ok(
      output.includes("Mechanical trigger, no judgment call"),
      "the mechanical form of the trigger must render with the judgment form",
    );
    // Derived examples: the trigger renders exactly the pairs computed from
    // the fixed inputs, and each rendered pair names only real inputs.
    const expectedExamples = mechanicalTriggerExamples(ALL_TOOLS, SKILL_NAMES);
    assert.ok(
      expectedExamples.length > 0,
      "the fixed tool+skill inputs must compute at least one real pair",
    );
    assert.ok(
      sectionText.includes(`(${expectedExamples.join(", ")})`),
      "the trigger must render exactly the computed examples",
    );
    for (const m of sectionText.matchAll(/`([a-z0-9_]+)` → ([^\s),]+)/g)) {
      assert.ok(
        ALL_TOOLS.includes(m[1]),
        `trigger example names a tool outside the inputs: ${m[1]}`,
      );
      assert.ok(
        SKILL_NAMES.some((s) =>
          s.split("-").some((t) => t.toLowerCase() === m[2].toLowerCase()),
        ),
        `trigger example names a token outside the skill catalog: ${m[2]}`,
      );
    }
    assert.ok(
      !sectionText.includes("memory_store") && !sectionText.includes("session_health"),
      "stale hardcoded examples must stay gone (no memory/session skill exists)",
    );
    assert.ok(
      !output.includes("continue with offset until the file is complete"),
      "offset clause removed (dedup: read guideline owns it)",
    );
    // Relocation guard: the directive renders only with read + list_skills —
    // the guard travels with the text to its new home.
    const withoutListSkills = await assemblePrompt({
      toolNames: ALL_TOOLS.filter((t) => t !== "list_skills"),
    });
    assert.ok(
      !withoutListSkills.includes(sectionText),
      "skills-loading must be absent without list_skills (relocation guard)",
    );
    // Representative cross-tool guidance from the guidelines section.
    const guidance =
      "Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)";
    const ng = countLines(output, guidance);
    assert.equal(ng, 1, "guidance line must appear exactly once");
  });

  it("context-cadence guidance renders the generic stance (no threshold literals)", async () => {
    const output = await assemblePrompt({ toolNames: ALL_TOOLS });
    // The stance line renders verbatim (mirrors index.ts, H-1).
    const line = output.split("\n").find((l) => l.startsWith("Context is finite:"));
    assert.ok(line, "context-cadence stance line must render");
    assert.equal(line, CONTEXT_CADENCE_LINE, "stance line must match the pinned production string");
    // H-1 desync guard: no threshold literals in the cadence line (the
    // extension ladder in context-thresholds.ts is the single source of truth).
    assert.ok(
      !line.includes("50k") && !line.includes("100k"),
      "cadence line must not carry threshold literals",
    );
    assert.ok(!output.includes("Free space:"), "old token-cadence line must be gone");
    assert.ok(
      !output.includes("archive when > 50%"),
      "percent-based cadence advice must stay gone",
    );
  });

  it("discovery honors guards: the stance renders, the orientation line stays gone", async () => {
    const full = await assemblePrompt({ toolNames: ALL_TOOLS });
    assert.ok(
      full.includes(DISCOVERY_UNCONDITIONAL),
      "unconditional discovery stance must always render",
    );
    assert.ok(
      !full.includes(DISCOVERY_ORIENTATION_NEEDLE),
      "orientation recipe must stay dropped (system_info tool description covers it)",
    );
  });

  it("project-docs pointer renders only when project-docs context is supplied", async () => {
    const withDocs = await assemblePrompt({ toolNames: ALL_TOOLS, projectDocs: FAKE_PROJECT_DOCS });
    assert.ok(
      withDocs.includes("- AGENTS.md at /virtual/proj/AGENTS.md"),
      "pointer line must render when project-docs context is supplied",
    );
    assert.ok(
      withDocs.includes("Read the project docs in full before editing the areas they cover"),
      "project-docs directive must render when context is supplied",
    );

    const withoutDocs = await assemblePrompt({ toolNames: ALL_TOOLS, projectDocs: [] });
    assert.ok(
      !withoutDocs.includes("- AGENTS.md at /virtual/proj/AGENTS.md"),
      "pointer line must be absent without project-docs context",
    );
    assert.ok(
      !withoutDocs.includes("Read the project docs in full before editing the areas they cover"),
      "project-docs directive must be absent without project-docs context",
    );
  });

  it("no empty sections + assembly integrity: real sections joined, not a degenerate string", async () => {
    const output = await assemblePrompt({ toolNames: ALL_TOOLS, projectDocs: FAKE_PROJECT_DOCS });
    // Assembly integrity (e): identity stance + one tool one-liner + skills-loading.
    assert.ok(
      output.includes("You are Braid. You work across software"),
      "identity stance must be present",
    );
    assert.ok(output.includes("- read: "), "at least one tool one-liner must be present");
    assert.ok(
      output.includes("This catalog is every installed skill"),
      "the skills floor must be present",
    );
    assert.ok(
      output.includes("read the WHOLE SKILL.md before acting in that domain"),
      "the floor must carry the read obligation",
    );
    assert.ok(
      output.includes(`- ${SKILL_ROWS[0].name}: ${SKILL_ROWS[0].description}`),
      "the floor must render a row per skill",
    );
    assert.ok(output.includes("Available tools:"), "tools section header must be present");
    // The standalone resources section stays deleted. The only resource
    // counts ride the compact instance line, which answers a different
    // question (did the stores load at all).
    const resourceLines = output.split("\n").filter((l) => l.includes("Resources:"));
    assert.equal(resourceLines.length, 1, "only the instance line may carry resource counts");
    assert.ok(
      resourceLines[0].startsWith("Agent: Braid vTEST"),
      "resource counts must ride the compact instance line, not their own section",
    );
    assert.ok(
      output.includes("Other custom tools may exist depending on the project."),
      "tools section tail must be present",
    );
    // No empty sections (d): composeSections drops whitespace-only sections, so
    // every landmark above proves its section contributed real text.
    assert.ok(
      !/(?:\n\n){2,}/.test(output),
      "no two consecutive blank-line joins (no empty section in the middle)",
    );
    // Soft assembly floor (the ONLY numeric bound — proves assembly, never a
    // ceiling on bloat). Size is not a contract.
    assert.ok(output.length > 1000, "assembled prompt is a real multi-section prompt");
  });

  it("identity compression + PHILOSOPHY render, deleted lines stay gone", async () => {
    const output = await assemblePrompt({ toolNames: ALL_TOOLS, projectDocs: FAKE_PROJECT_DOCS });
    //: intro tail sharpened, "extras on top of pi"gone.
    assert.ok(
      !output.includes("extras on top of pi"),
      "'extras on top of pi' phrase must stay cut",
    );
    assert.ok(
      output.includes("Pi is a minimal harness — you extend it, not configure it."),
      "sharpened tail must render",
    );
    //: tool-purpose paragraph gone.
    assert.ok(
      !output.includes("finalize archives tasks, memory_store persists learnings"),
      "tool-purpose paragraph must stay deleted",
    );
    //: PHILOSOPHY block renders (4 lines, exact text).
    assert.ok(output.includes("Success loves silence: you keep private things private"));
    assert.ok(output.includes("calm, cold mind"));
    assert.ok(output.includes("self-irony is a truth tool, not a performance"));
    //: the senior-craft line and the placement block were reverted (the
    // prompt re-probe failed its keep rule); SELF_AUDIT stays (the same probe
    // kept it). The revert deletes the senior line: the growth-arc phrasing
    // stays cut, it is not restored.
    assert.ok(
      !output.includes("You are the twenty-year senior"),
      "senior-craft line must stay cut",
    );
    assert.ok(!output.includes("Craft over haste"), "growth-arc senior line must stay cut");
    assert.ok(
      !output.includes("A fix lives where the invariant lives"),
      "placement block must stay cut",
    );
    assert.ok(output.includes(SELF_AUDIT), "SELF_AUDIT must render verbatim");
    assert.ok(output.includes("Doubt is symmetric"), "symmetric-doubt clause must render");
    // Self-audit tail: the reworded phrasing renders verbatim and the
    // pre-reword tail stays gone. The negative needle names the unique old
    // tail without carrying the scanner's own vocabulary.
    assert.ok(
      output.includes("Everything you hand up ends with what you could not verify"),
      "self-audit handoff tail must render (reworded)",
    );
    assert.ok(!output.includes("you send up ends"), "pre-reword self-audit tail must stay gone");
    //: tool-failure reword + widened claim enumeration.
    assert.ok(
      output.includes("check your input first; a failure that contradicts the input is a tool bug"),
      "tool-failure reword must render",
    );
    assert.ok(
      !output.includes("the fault is almost always in your input, not the tool"),
      "self-blame prior must stay gone",
    );
    assert.ok(
      output.includes("a file's, the owner's, a peer agent's — to one test"),
      "peer-agent claim source must render (widened gate)",
    );
    //: cuts: the aphorism is gone and the em-dash rule is narrowed.
    assert.ok(
      !output.includes("Instruction is permanent; narrative is borrowed."),
      "narrative aphorism must stay cut",
    );
    assert.ok(
      output.includes(
        "No em dashes in text you write for people; no signposting, no narrative framing.",
      ),
      "narrowed em-dash clause must render",
    );
    //: multi-agent block removed: the [agent:…] tag contract named a message
    // format with no producer in any shipped mechanism. The text must stay
    // gone — not re-added, not paraphrased back in.
    assert.ok(
      !output.includes("Peer agents may message you"),
      "the multi-agent message contract must stay gone (no producer for the tag format)",
    );
    assert.ok(
      !output.includes("treat it as a task continuation from SOURCE"),
      "the 4-clause protocol must stay gone",
    );
    //: health line (tool-description restatement) stays gone.
    assert.ok(!output.includes("Health: context_inspect"), "context health line must stay dropped");
    //: implementation pipeline + orientation recipe stay gone.
    assert.ok(
      !output.includes("read the target files before changing them"),
      "implementation pipeline must stay dropped",
    );
  });

  it("surface discipline renders exactly once + measured added-token delta", async () => {
    const output = await assemblePrompt({ toolNames: ALL_TOOLS, projectDocs: FAKE_PROJECT_DOCS });
    // Exactly-once render of the baked block (the section file pins the text
    // verbatim; drift on either side fails here).
    const needle = "Signal discipline binds every surface you produce";
    assert.equal(
      output.split(needle).length - 1,
      1,
      "SURFACE_DISCIPLINE must render exactly once in the assembled prompt",
    );
    assert.ok(
      output.includes(SURFACE_DISCIPLINE),
      "SURFACE_DISCIPLINE exact text must render verbatim (no paraphrase)",
    );
    // Mirror-guard addition: labels seen in task text or briefs stay out of
    // produced artifacts; the carve-out seats are named in the sentence.
    assert.ok(
      output.includes(
        "Internal labels present in task text or briefs are never copied into code, tests, comments, docs, or commit messages",
      ),
      "mirror-guard sentence must render verbatim",
    );
    // Ordering lockstep: the block sits between COMMUNICATION and EPISTEMIC_STANCE
    // (its own section now; the split keeps the render seat unchanged).
    const commTail = output.indexOf(
      "You reason before you act; you do not narrate step-by-step reasoning.",
    );
    const surfHead = output.indexOf(needle);
    const epiHead = output.indexOf("Truth over agreeableness");
    assert.ok(
      commTail !== -1 && surfHead > commTail && epiHead !== -1 && surfHead < epiHead,
      "SURFACE_DISCIPLINE must sit between COMMUNICATION and EPISTEMIC_STANCE",
    );
    // Measured added-token delta, printed for the bake record. This file
    // carries no budget ceilings by design (header note f), so the block's
    // cost is reported rather than asserted against a number.
    const words = SURFACE_DISCIPLINE.trim().split(/\s+/).length;
    const chars = SURFACE_DISCIPLINE.length;
    console.log(
      `[surface-discipline] added identity text: ${words} words / ${chars} chars ≈ ${Math.round(words * 1.3)} tokens (words×1.3) / ${Math.round(chars / 4)} tokens (chars÷4)`,
    );
  });

  it("repair discipline: verbatim render, repair-region seat, known-open-check done gate", async () => {
    const output = await assemblePrompt({ toolNames: ALL_TOOLS, projectDocs: FAKE_PROJECT_DOCS });
    // Exactly-once render of the block (drift on either side fails here).
    assert.ok(
      output.includes(REPAIR_DISCIPLINE),
      "REPAIR_DISCIPLINE exact text must render verbatim (no paraphrase)",
    );
    for (const needle of [
      "Root cause before repair: reproduce the failure, name the mechanism in one sentence a reader could falsify, then fix that mechanism.",
      "A repair whose mechanism is unnamed is a guess.",
      // Setup-clause openings of sentences 2 and 3: the load-bearing middles
      // and tails are pinned above/below, but paraphrasing an opening away
      // must fail too — the sentence entrances are part of the verbatim grip.
      "A claim you did not derive yourself",
      "A non-trivial repair is a weighted decision",
      "gets re-derived with your own instrument",
      "a check that shares the instrument or the path that produced the result is not evidence",
      "blast radius, reversibility, cost, and what each forecloses",
      "pick one and say why the others lost",
    ]) {
      assert.equal(
        output.split(needle).length - 1,
        1,
        `repair-discipline clause must render exactly once: "${needle}"`,
      );
    }
    // Seat lockstep: the block sits inside the repair-governing region,
    // after WORK_ETHIC (scope) and before SELF_MANAGEMENT.
    const workEthic = output.indexOf("You are methodical and precise");
    const repair = output.indexOf("Root cause before repair");
    const selfMgmt = output.indexOf("Memory is your workspace");
    assert.ok(
      workEthic !== -1 && repair > workEthic && selfMgmt > repair,
      "REPAIR_DISCIPLINE must sit between WORK_ETHIC and SELF_MANAGEMENT",
    );
    // Restatement guard: the retrieved-context grounding sentence is owned by
    // EPISTEMIC_STANCE (identity-core seat). If it reappears inside
    // REPAIR_DISCIPLINE — or any other seat — the rule is carried twice, and
    // the pin fails. Clause-specific by design: shared vocabulary across
    // blocks stays legal; only this exact grounding clause is counted.
    assert.equal(
      output.split("what your tools return outranks what your weights remember").length - 1,
      1,
      "the grounding clause must render exactly once (owned by EPISTEMIC_STANCE); a second occurrence is a restatement",
    );
    // Done gate: the known-open-check blocker rides the finalize sentence.
    assert.ok(
      output.includes(
        "Verify before finalize: every done item carries evidence — what changed, how it was checked. No done claim stands while a known-open check is unanswered.",
      ),
      "known-open-check done gate must render verbatim",
    );
    // Measured added-text delta, printed for the bake record (the
    // surface-discipline block prints its own the same way).
    const words = REPAIR_DISCIPLINE.trim().split(/\s+/).length;
    console.log(
      `[repair-discipline] added identity text: ${words} words / ${REPAIR_DISCIPLINE.length} chars ≈ ${Math.round(words * 1.3)} tokens (words×1.3) / ${Math.round(REPAIR_DISCIPLINE.length / 4)} tokens (chars÷4)`,
    );
  });

  it("production composition: the identity seat is the handler's own section list", async () => {
    // The assembly feeds the exported identitySection() from the built
    // handler, so the seat and verbatim assertions above run against the
    // production composition. This guard pins the routing itself: if the
    // identity join is re-inlined in the handler (the hand-mirror reborn),
    // the seam goes dead and those assertions would test a seam nothing
    // calls. The source read below is a build artifact — static and
    // deterministic per build, like the dist imports above.
    const handlerSource = readFileSync(
      join(ROOT, "dist", "extensions", "core", "prompt-builder", "index.js"),
      "utf8",
    );
    assert.ok(
      handlerSource.includes("identitySection(),"),
      "the built handler must compose the identity seat via identitySection()",
    );
    assert.equal(
      handlerSource.split("IDENTITY_INTRO").length - 1,
      2,
      "IDENTITY_INTRO must appear exactly twice in the built handler (import + seam body); a third occurrence means a re-inlined identity join",
    );
  });

  it("identity-core + token-delta: ratified core verbatim, dissolved texts stay gone, owned-only tool rows", async () => {
    const output = await assemblePrompt({ toolNames: ALL_TOOLS, projectDocs: FAKE_PROJECT_DOCS });
    // The ratified 3-sentence core renders byte-exact (no paraphrase drift).
    assert.ok(output.includes(EPISTEMIC_STANCE), "the ratified identity-core must render verbatim");
    // Every sentence the core dissolved must stay gone (compression =
    // subtraction — none survives beside the core).
    const dissolved = [
      "Truth-seeking over agreeableness",
      "State what you believe is correct even if it contradicts the user",
      "If uncertain, say so.",
      "Calibrate your confidence",
      "is accuracy awareness, not weakness",
      "Say \"I don't know\" when the evidence isn't there.",
      "is always more authoritative than what your weights remember",
      // Intro self-description (dissolved with the core).
      "an honest self-aware agent with a metacognitive suite",
    ];
    for (const s of dissolved) {
      assert.ok(!output.includes(s), `dissolved proclamation must stay gone: "${s}"`);
    }
    // The core's own load-bearing clauses render.
    assert.ok(
      output.includes("say what it asserts, what must be true for it to hold"),
      "claim-gate procedure (S1) must render",
    );
    assert.ok(
      output.includes("claims about your own running state too"),
      "self-state gate (S2) must render",
    );
    assert.ok(
      output.includes('say "I don\'t know" or go get it'),
      "knowledge-boundary fallback (S3) must render",
    );

    // Token-delta edits: reworded directives render, originals stay gone.
    assert.ok(
      output.includes("Verify before finalize: every done item carries evidence"),
      "evidence-carrying done items must render",
    );
    // Result-schema addition: the worker's final-message contract lists the
    // seven fields literally, so the assembled prompt must carry them.
    assert.ok(
      output.includes(
        "your final chat message ends with a fenced JSON result block carrying exactly these seven fields: worker, spec, status, output_file, artifacts, gate_evidence, claims",
      ),
      "worker result-schema contract must render",
    );
    assert.ok(!output.includes("verification triple"), "old loop tail must stay cut");
    assert.ok(
      output.includes("Close the loop: observe, evaluate, adapt, persist."),
      "compressed loop must render",
    );
    assert.ok(
      !output.includes("close the loop: observe what happened"),
      "verbose loop sentence must stay cut",
    );
    assert.ok(
      !output.includes("If a sentence tells a story"),
      "duplicate communication sentence must stay cut",
    );
    assert.ok(
      !output.includes("Prefer clear, direct responses"),
      "generic clarity line must stay cut",
    );
    assert.ok(
      output.includes("Other custom tools may exist depending on the project."),
      "tools footer must render (reworded)",
    );
    assert.ok(
      !output.includes("In addition to the tools above"),
      "old tools footer must stay gone",
    );
    assert.ok(
      output.includes("Read the project docs in full before editing the areas they cover"),
      "project-docs directive must render (reworded)",
    );
    assert.ok(
      !output.includes("Read the project documentation files below"),
      "old project-docs directive must stay gone",
    );
    const memoryBlock = await reconstructMemorySection({});
    assert.ok(
      memoryBlock.includes("Memory stores — read or query on demand:"),
      "memory directive must render (reworded)",
    );
    assert.ok(
      !memoryBlock.includes("use `memory` to recall before non-trivial work"),
      "old memory directive must stay gone",
    );
    // Pointer-line shape unchanged: one `- <store> at <path>`line per store.
    assert.ok(/^- episodes at .+$/m.test(memoryBlock), "episodes pointer renders");
    assert.ok(/^- semantic at .+$/m.test(memoryBlock), "semantic pointer renders");
    assert.ok(
      memoryBlock.includes("- heuristics: session-scoped (no on-disk file)"),
      "heuristics pointer renders",
    );
    assert.ok(
      output.includes("Pi is a minimal harness — you extend it, not configure it."),
      "intro tail (reworded) must render",
    );
    assert.ok(!output.includes("you are built to extend it"), "old intro tail must stay gone");
    assert.ok(
      output.includes("You are Braid. You work across software"),
      "intro (reworded) must render",
    );

    // Owned-only tool rows: the description-firstSentence fallback is no
    // longer a render source. context_* strategy stays in its single home.
    assert.equal(
      resolveOwnedToolLine("browser_navigate", undefined),
      undefined,
      "description-only tools render no row",
    );
    assert.equal(
      resolveOwnedToolLine("context_inspect", undefined),
      undefined,
      "context_* strategy stays outside the tools section",
    );
    assert.equal(resolveOwnedToolLine("read", undefined), TOOL_GUIDELINES.read);
    assert.equal(
      resolveOwnedToolLine("herdr_agent", undefined),
      EXTERNAL_TOOL_GUIDELINES.herdr_agent,
      "external-map rows still render",
    );
    assert.equal(
      resolveOwnedToolLine("verify", ["when: owner-declared strategy"]),
      "when: owner-declared strategy",
      "promptGuidelines still win for non-pinned tools",
    );
    assert.equal(
      resolveOwnedToolLine("edit", ["when: owner-declared strategy"]),
      TOOL_GUIDELINES.edit,
      "the pinned-builtin override wins for edit",
    );
    // resolveToolLine keeps the description fallback for other callers.
    assert.equal(
      resolveToolLine(
        "context_compress",
        "Free up context space; prefer archive over compact.",
        undefined,
      ),
      "Free up context space; prefer archive over compact.",
      "resolveToolLine fallback unchanged for its remaining callers",
    );
  });

  it("pinned builtins: braid's curated rows win over pi's self-registered promptGuidelines", async () => {
    // Resolver level: the owner's line is present and must lose for these
    // five names (pre-fix it wins — this is the RED assertion).
    for (const name of PINNED_BUILTIN_NAMES) {
      assert.equal(
        resolveOwnedToolLine(name, PI_BUILTIN_PROMPT_GUIDELINES[name]),
        TOOL_GUIDELINES[name],
        `\`${name}\` must render braid's curated row, not pi's promptGuidelines[0]`,
      );
    }
    // Render level: a synthetic tool set carrying pi's promptGuidelines must
    // still render braid's rows.
    const output = await assemblePrompt({
      toolNames: ALL_TOOLS,
      toolGuidelines: PI_BUILTIN_PROMPT_GUIDELINES,
    });
    for (const name of PINNED_BUILTIN_NAMES) {
      const needle = `- ${name}: ${TOOL_GUIDELINES[name]}`;
      const n = countLines(output, needle);
      assert.equal(n, 1, `braid's \`${name}\` row must render exactly once (found ${n})`);
    }
    // And the owners' thinner lines must not appear anywhere.
    for (const name of PINNED_BUILTIN_NAMES) {
      const piLine = `- ${name}: ${PI_BUILTIN_PROMPT_GUIDELINES[name][0]}`;
      assert.equal(countLines(output, piLine), 0, `pi's \`${name}\` line must not render`);
    }
  });
});

describe("skills-loading mechanical trigger (pure derivation)", () => {
  it("synthetic tools+skills produce the expected examples, sorted by family token", () => {
    assert.deepEqual(
      mechanicalTriggerExamples(
        ["herdr_layout", "document_parse", "memory_store"],
        ["herdr-topology", "parse-document", "placement-discipline"],
      ),
      ["`document_parse` → document", "`herdr_layout` → herdr"],
    );
    // The arrow target keeps the skill's own casing (case-insensitive match).
    assert.deepEqual(mechanicalTriggerExamples(["x_ray"], ["X-Ray-Viewer"]), ["`x_ray` → X"]);
    assert.ok(
      skillsLoadingText(["herdr_layout"], [
        { name: "herdr-topology", description: "", filePath: "/catalog/herdr-topology/SKILL.md" },
      ]).includes(
        "(`herdr_layout` → herdr) → read that SKILL.md before the first call in the family.",
      ),
      "the trigger renders the computed pair inline",
    );
  });

  it("an unmatched family yields no example and no parenthetical", () => {
    assert.deepEqual(
      mechanicalTriggerExamples(["memory_store", "session_health"], ["herdr-topology"]),
      [],
      "no skill token matches the memory/session families",
    );
    const trigger = skillsLoadingText(["memory_store", "session_health"], [
      { name: "herdr-topology", description: "", filePath: "/catalog/herdr-topology/SKILL.md" },
    ])
      .split("\n")
      .find((l) => l.startsWith("Mechanical trigger"));
    assert.equal(
      trigger,
      "Mechanical trigger, no judgment call: about to use a tool family whose word appears in a skill's name → read that SKILL.md before the first call in the family.",
      "no parenthetical when no pair computes",
    );
  });

  it("multiple matches render deterministically across input permutations", () => {
    const tools = [
      "herdr_pane",
      "document_search",
      "herdr_agent",
      "document_parse",
      "herdr_layout",
    ];
    const skills = ["pi-reference", "herdr-topology", "parse-document"];
    const expected = ["`document_parse` → document", "`herdr_agent` → herdr"];
    assert.deepEqual(mechanicalTriggerExamples(tools, skills), expected);
    assert.deepEqual(
      mechanicalTriggerExamples([...tools].reverse(), [...skills].reverse()),
      expected,
      "input order must not change the rendered text",
    );
    assert.deepEqual(
      mechanicalTriggerExamples([...tools].sort().reverse(), [...skills].sort().reverse()),
      expected,
    );
  });

  it("an empty catalog renders no section", () => {
    // The floor is a catalog: with nothing installed there is no section to
    // render, rather than a section claiming to list every skill and listing
    // none. A catalog that installs no tool-family-named skill still renders
    // the trigger without a parenthetical (the case above).
    assert.equal(skillsLoadingText(["memory_store"], []), "", "no catalog, no floor");
    const text = skillsLoadingText(["memory_store"], [
      { name: "herdr-topology", description: "", filePath: "/catalog/herdr-topology/SKILL.md" },
    ]);
    // Paragraphs 1 and 2 stay byte-stable (the pinned strategy text).
    assert.ok(text.startsWith(skillsCatalogRule(SYNTHETIC_PACK)), "catalog rule renders first");
    assert.ok(text.includes(`\n\n${SKILLS_POINTER_RULE}\n\n`), "pointer rule renders second");
  });
});
