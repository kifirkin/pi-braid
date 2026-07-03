import { deliverPastInsights } from "../../../lib/memory/past-insights.js";
import { getCognitiveMemory } from "../../../lib/memory/index.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RESOURCES_DISCOVER } from "../../../lib/core/event-names.js";
import { gatherContextState, contextSection } from "./context-section.js";
import { deliverActiveSpecs } from "../../../lib/cognitive/openspec.js";
import { deliverRelevantHints } from "../../../lib/cognitive/hints.js";
import type { PromptSection } from "./section.js";
import { linesSection, simpleSection, headingSection, composeSections } from "./section.js";
import {
  IDENTITY_INTRO,
  INTERACTION_STYLE,
  CONCISE_RESPONSES,
  COMPACTION_SURVIVAL,
  DEFINITION_OF_DONE,
  LIVING_DOCS,
  MEMORY_AWARENESS,
  SCOPES,
  FRAMEWORK_CONFIG_FIRST,
} from "./identity.js";
import { behaviorModeSection } from "./behavior-modes.js";
import {
  reconstructSkillsSection,
  resetSkillsSectionCache,
} from "./skills-section.js";
import {
  reconstructProjectDocsSection,
  resetProjectDocsSectionCache,
} from "./project-docs-section.js";
import {
  reconstructMemorySection,
  resetMemorySectionCache,
} from "./memory-section.js";
import { instanceSection } from "./instance-composition.js";

/**
 * Prompt Builder - Reconstruction from Structured Data
 *
 * No fragile string extraction. Everything built from APIs and fixed templates.
 * Only pi-braid additions (identity, L1, enforcement) are custom.
 *
 * Sections built from structured data:
 * - Tools: pi.getAllTools() (with promptSnippet)
 * - Skills: skillsSection() re-formats skills from
 *   event.systemPromptOptions.skills (the fully resolved list pi built via its
 *   package manager -- includes user, project, AND package skills). This is the
 *   canonical pattern from pi's own docs: extensions should not re-discover
 *   skills; they should reformat what pi already loaded.
 * - Project docs: projectDocsSection() re-formats AGENTS.md / CLAUDE.md files
 *   from loadProjectContextFiles() as a `<available_project_docs>` block
 *   (pointer-only, agent reads full content on demand). Mirrors the skills
 *   model. Prevents pattern-matching against stale doc references.
 * - Guidelines: fixed template based on tool availability
 * - Date/Cwd: computed directly
 *
 * Sections re-implemented locally:
 * - Identity: Braid agent identity (smart-mix: persona + native pattern + generalist)
 * - Value statements: 8 single-sentence identity-level directives (compressed from 11 on 2026-06-23)
 * - L1 environmental state
 * - Enforcement signals
 *
 * Historical change log moved to CHANGELOG.md. The current shape is the
 * post-implicit-framing research state: single-sentence interaction style,
 * 8 research-backed single-sentence value statements, no latent-behavior
 * activation in the prompt (moved to runtime via `latent-activator`).
 */

// ── L1: Enforcement Signal Surfacing ────────────────────────────────────────
// Session-scoped state (migrated from module-level singletons)
import { getExtensionState } from "../../../lib/state/extension-state.js";

interface PromptBuilderState {
  insightsSent: boolean;
  activeBehaviorMode: string;
}

function getPromptState(ctx: ExtensionContext): PromptBuilderState {
  return getExtensionState(ctx, "prompt-builder", () => ({
    insightsSent: false,
    activeBehaviorMode: "TRUTH-SEEKING",
  }));
}
const KNOWN_SNIPPETS: Record<string, string> = {
  // pi-native core tools (consistent one-liners regardless of version)
  read: "Read file contents",
  bash: "Execute bash commands (ls, grep, find, etc.)",
  edit: "Make precise file edits with exact text replacement",
  write: "Create or overwrite files",
  grep: "Search file contents for patterns (respects .gitignore)",
  find: "Find files by glob pattern (respects .gitignore)",
  ls: "List directory contents",
};

/**
 * Extract the first sentence of a description for the tool listing.
 *
 * Tool descriptions should be written so the first sentence contains both
 * "what it does" and "when to use" - no transformation needed.
 * This just extracts that first sentence cleanly.
 *
 * KNOWN_SNIPPETS covers pi-native core tools (read, bash, etc.) whose
 * descriptions are raw parameter schemas, not prose suitable for listing.
 */
function firstSentence(text: string): string {
  const match = text.match(/^([^.!?\n]*[.!?])\s?/);
  if (match) {
    const s = match[1].trim();
    return s.length <= 120 ? s : s.slice(0, 117) + "...";
  }
  const line = text.split("\n").find((l) => l.trim().length > 0);
  const t = (line ?? text).trim();
  return t.length <= 120 ? t : t.slice(0, 117) + "...";
}

function toolsSection(tools: ReturnType<ExtensionAPI["getAllTools"]>): PromptSection {
  // pi-native stores promptSnippets internally but getAllTools() doesn't expose them.
  // KNOWN_SNIPPETS covers pi-native core tools (their descriptions are parameter schemas,
  // not prose). For all other tools, extract first sentence from t.description.
  const toolNames = tools.map((t) => t.name);
  const visibleTools = tools
    .filter((t) => t.name && (t.description || KNOWN_SNIPPETS[t.name]))
    .map((t) => {
      const snippet = KNOWN_SNIPPETS[t.name] ?? firstSentence(t.description ?? "");
      return `- ${t.name}: ${snippet}`;
    })
    .join("\n");

  // Collect guidelines matching pi-native's _rebuildSystemPrompt + system-prompt.js logic.
  // The dedup semantic (originally a local `addGuideline` closure) is now provided
  // by `linesSection(..., { dedup: true })` - the canonical primitive.
  const guidelineLines: string[] = [];

  // pi-native's bash/grep/find/ls conditional (from system-prompt.js)
  const hasBash = toolNames.includes("bash");
  const hasGrep = toolNames.includes("grep");
  const hasFind = toolNames.includes("find");
  const hasLs = toolNames.includes("ls");
  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    guidelineLines.push("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    guidelineLines.push(
      "Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    );
  }

  // Always-included guidelines (pi-native)
  guidelineLines.push("Prefer clear, direct responses");
  guidelineLines.push("Show file paths clearly when working with files");
  // Research backing: Bakhshi (2026) arXiv:2604.19768 - LLMs exhibit systematic epistemic-rhetorical patterns at ~2x human rate
  guidelineLines.push(
    "Write text that reads naturally, as if written by a human, not generated by a machine",
  );

  // Wrap guidelines in the canonical linesSection primitive (dedup=true replaces
  // the old local addGuideline helper). The visible-tools block is a fixed
  // template, so it stays as a manual string and the section composes both.
  const guidelinesSection = linesSection("tools-guidelines", guidelineLines, { dedup: true });

  return {
    name: "tools",
    render: () => {
      const renderedGuidelines = guidelinesSection.render();
      // Preserve the original layout: "Available tools: ..." then a blank line
      // then "In addition to the tools above..." then the guidelines block.
      const guidelinesSuffix = renderedGuidelines ? `\n\n${renderedGuidelines}` : "";
      return `Available tools:\n${visibleTools || "(none)"}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.${guidelinesSuffix}`;
    },
  };
}

async function projectContextSection(cwd: string, ctx: ExtensionContext): Promise<PromptSection> {
  // Uses pi-core's exported `loadProjectContextFiles` instead of a local
  // re-implementation. The SDK exports this as a standalone utility
  // (see pi CHANGELOG for #3142). This keeps us in sync with the
  // canonical resolution order: agent-dir global context, then
  // cwd-ancestors (most-root last), deduped by path.
  //
  // Pointer-only model: we DO NOT inject AGENTS.md / CLAUDE.md content
  // into the system prompt. Instead we render a `<available_project_docs>`
  // block listing the files with metadata, and let the agent `read` the
  // full content on demand. This mirrors the skills model and prevents
  // the agent from pattern-matching against stale doc references when
  // parsing ambiguous external output (see June 22 hacking-a0 phantom-
  // reply incident for the original failure mode).

  // loadProjectContextFiles is sync, so wrap the call in a microtask
  // so the function remains `async` (matches PromptSection contract).
  const contextFiles = await Promise.resolve().then(() =>
    loadProjectContextFiles({ cwd, agentDir: getAgentDir() }),
  );

  return {
    name: "project-docs",
    render: async () => reconstructProjectDocsSection(contextFiles, ctx),
  };
}

// ── Main Extension ───────────────────────────────────────────────────────────

export default function promptBuilderExtension(pi: ExtensionAPI) {
  // L1 state is now gathered per-request, not global

  // Listen for enforcement_signals events -- enforcement emits these on
  // every turn_end and session_compact with the current behavior mode.
  // The prompt-builder stores the mode and renders it in the next prompt.
  // Uses registerSessionStartHandler so the listener has access to the
  // per-session ExtensionContext (needed for getExtensionState).
  registerSessionStartHandler(pi, SessionPhase.MemoryState, async (_event, ctx) => {
    const ps = getPromptState(ctx);
    pi.events.on("enforcement_signals", (data: unknown) => {
      const d = data as { contrastMode?: string };
      if (d.contrastMode) ps.activeBehaviorMode = d.contrastMode;
    });
  });

  // ── resources_discover: invalidate skills, project-docs, memory caches ──
  // When resources are re-discovered (e.g. /reload, or session replacement),
  // pi re-resolves skills and project context. We invalidate our format
  // caches so the next before_agent_start renders with the new sets. The
  // memory section also invalidates so a freshly-written episode surfaces
  // in the next turn's pointer block.
  pi.on(RESOURCES_DISCOVER, async (_event, ctx) => {
    resetSkillsSectionCache(ctx);
    resetProjectDocsSectionCache(ctx);
    resetMemorySectionCache(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const ps = getPromptState(ctx);
    const cwd = ctx.cwd;
    const allTools = pi.getAllTools();
    const activeToolNames = pi.getActiveTools() ?? allTools.map((t) => t.name);
    const tools =
      activeToolNames.length > 0
        ? allTools.filter((t) => activeToolNames.includes(t.name))
        : allTools;
    const toolNames = tools.map((t) => t.name);
    const hasRead = toolNames.includes("read");

    // v3.7: Session merged into Instance. Context (conditional)
    // remains as the only other runtime block in the system prompt.
    const contextData = await gatherContextState(pi, ctx);
    const context = contextSection(contextData);

    // 5. Supplemental context (past insights, hints, OpenSpec specs) ->
    // offloaded to steer whispers (once per session). Avoids per-turn disk
    // I/O and system prompt bloat for context the agent can re-load via
    // `read` if needed.
    if (!ps.insightsSent) {
      // Run in parallel - each delivery is independent and best-effort.
      // allSettled ensures one failure doesn't block the others.
      await Promise.allSettled([
        deliverPastInsights(cwd, pi, ctx),
        deliverRelevantHints(cwd, pi, ctx),
        deliverActiveSpecs(cwd, pi, ctx),
      ]);
      ps.insightsSent = true;
    }

    // Build the prompt as a flat list of sections. Every section is a
    // `PromptSection`; the top-level handler never touches raw strings
    // or arrays of strings.
    // 0. Instance composition block (top-level, all env + session info
    //    merged in v3.7). See instance-composition.ts for the design.
    const skills = event.systemPromptOptions?.skills ?? [];
    let memoryCount = 0;
    try {
      const memory = getCognitiveMemory();
      try { await memory.init(); } catch { /* already init'd or non-fatal */ }
      memoryCount = memory.getAll(3).length;
    } catch { /* memory unavailable - non-fatal */ }
    const inst = await instanceSection(pi, ctx, {
      skillCount: skills.length,
      memoryCount,
    });

    const sections: PromptSection[] = [
      // 0. Instance composition (top of prompt, stable per session)
      inst,

      // 1. Custom identity (THE key difference from native)
      simpleSection("identity", IDENTITY_INTRO),

      // 1a. Output directive (concise responses alongside tool calls).
      //     Pairs with the dynamic behavior-mode section below.
      simpleSection("value-concise-responses", CONCISE_RESPONSES),

      // 1a-behavior. Dynamic behavior mode -- surfaces the right directive
      //     based on enforcement state (TRUTH-SEEKING by default, shifts to
      //     CORRECTION / EPISTEMIC-CALIBRATION / TOOL-RELIABILITY when the
      //     enforcement system detects the corresponding pattern).
      //     Restored 2026-06-29 after being deleted in 3b4f108a.
      behaviorModeSection(ps.activeBehaviorMode),

      // 1b. Compaction survival invariant - scratchpad + tasks must be self-contained
      //     so the agent can recover context after conversation compression
      simpleSection("invariant-compaction", COMPACTION_SURVIVAL),

      // 1b-doD. Definition of Done invariant - every done item carries a
      //     verification triple (path + last-modified-cmd + verification-cmd).
      //     Prevents drift: the agent can't claim done without evidence.
      //     SPQ-1 (2026-06-29 12-point review: "single highest-leverage prompt change").
      simpleSection("invariant-definition-of-done", DEFINITION_OF_DONE),

      // 1c. Living documentation invariant - agent maintains AGENTS.md hierarchy
      //     Walk tree before edit, update docs after change (from DOX - agent0ai/dox)
      simpleSection("invariant-living-docs", LIVING_DOCS),

      // 1d. Memory awareness directive - recall before non-trivial work, store
      //     reusable findings after. Behavioral fix for the 0.84%-usage problem
      //     (2026-06-22 audit). Pairs with the memory pointer block rendered
      //     later in section 4b.
      simpleSection("invariant-memory", MEMORY_AWARENESS),

      // 1e. Scopes directive - match every artifact's location to its purpose;
      //     default to the narrowest scope that satisfies the purpose, broaden
      //     only when lifetime / audience / portability demand it. Principle-
      //     based (no path lists) so the agent discovers concrete locations
      //     at the moment of need via read/ls/find.
      simpleSection("invariant-scopes", SCOPES),

      // 1f. Framework Config First — before overriding internals,
      //     check the framework's official configuration API.
      //     Origin: 2026-07-02 reveal.js disableLayout discovery.
      //     Generic: applies to any system with a public surface.
      simpleSection("invariant-framework-config-first", FRAMEWORK_CONFIG_FIRST),

      // 8. Interaction style
      simpleSection("interaction-style", INTERACTION_STYLE),
    ];

    // 2. Available tools
    sections.push(toolsSection(tools));

    // 3. Skills (only when the read tool is available)
    if (hasRead) {
      // Use skills resolved by pi's full resource loader -- this includes
      // package skills (e.g. pi-braid-skills), user/project skill dirs,
      // .agents/skills, and CLI --skill paths. We only re-format with
      // description+location metadata from the loaded Skill objects; we do
      // NOT re-discover skills ourselves and we do NOT cap or filter them.
      // Every skill is listed with its domain description and full path so
      // the agent can pattern-match and `read` any of them on demand.
      const skillsText = await reconstructSkillsSection(
        event.systemPromptOptions?.skills ?? [],
        ctx,
      );
      if (skillsText) sections.push(simpleSection("skills", skillsText));
    }

    // 4. Unified `## Context` block (project-docs + memory + runtime context).
    //    The heading was reserved in v3.6 by context-section for runtime
    //    context, but the sibling pointer blocks (project docs, memory) used
    //    to wrap themselves in their own XML envelopes (`<available_*>...`)
    //    and so didn't need a markdown heading. After the 2026-07-02 plain-text
    //    cleanup, those envelopes are gone and the two blocks are headerless
    //    bullets. This composer finishes the unification intent by wrapping
    //    all three siblings under one markdown heading.
    //
    //    Order preserved from the previous three-push layout:
    //      project-docs -> memory -> runtime-context
    //    Empty fragments are filtered (headingSection itself drops empty
    //    bodies, so the whole block -- heading included -- is omitted when
    //    nothing is left).
    const contextFragments = [
      await (await projectContextSection(cwd, ctx)).render(),
      await reconstructMemorySection(ctx),
      await context.render(),
    ].filter((s) => s && s.trim() !== "");
    const contextBlock = contextFragments.join("\n\n");
    sections.push(headingSection("context", "Context", contextBlock));

    // 9: Preserve appendSystemPrompt from pi-native. Deduplicated against
    // everything above via the dedup set; user-provided append content that
    // matches an existing section is silently dropped.
    const appendPrompt = event.systemPromptOptions?.appendSystemPrompt;
    if (appendPrompt) {
      sections.push(simpleSection("append", appendPrompt));
    }

    const dedupSet = new Set<string>();
    const newPrompt = await composeSections(sections, "\n\n", dedupSet);
    return { systemPrompt: newPrompt };
  });
}

export { gatherContextState, contextSection };
