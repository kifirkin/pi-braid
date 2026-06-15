import { deliverPastInsights } from "../../memory/past-insights.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RESOURCES_DISCOVER } from "../../../lib/core/event-names.js";
import { gatherL1State, l1EnvSection } from "./l1-environment.js";
import { contrastSection } from "./contrast-phrase-library.js";
import { deliverActiveSpecs } from "../../cognitive/openspec.js";
import { deliverRelevantHints } from "../../cognitive/hints.js";
import type { PromptSection } from "./section.js";
import { linesSection, simpleSection, composeSections } from "./section.js";
import {
  IDENTITY_INTRO,
  INTERACTION_STYLE,
  COMPACTION_SURVIVAL,
  LIVING_DOCS,
} from "./identity.js";
import {
  SYCOPHANCY_RESISTANCE,
  STAKES_AWARENESS,
  EPISTEMIC_STABILITY,
  SURGICAL_PRECISION,
  BUDGET_AWARENESS,
} from "./behavioral-guardrails.js";
import {
  reconstructSkillsSection,
  resetSkillsSectionCache,
} from "./skills-section.js";

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
 *   package manager — includes user, project, AND package skills). This is the
 *   canonical pattern from pi's own docs: extensions should not re-discover
 *   skills; they should reformat what pi already loaded.
 * - Guidelines: fixed template based on tool availability
 * - Date/Cwd: computed directly
 *
 * Sections re-implemented locally:
 * - Identity: Braid agent identity
 * - Behavioral guidelines: consolidated from AGENTS.md (REMOVED - compliance triggers)
 * - Project context: loads AGENTS.md/CLAUDE.md files (pi's native loading is overridden)
 * - L1 environmental state
 * - Enforcement signals
 *
 * Historical change log moved to CHANGELOG.md. The current shape is the
 * post-implicit-framing research state: single-sentence interaction style,
 * 5 research-backed single-sentence guardrails, no latent-behavior
 * activation in the prompt (moved to runtime via `latent-activator`).
 */

// ── L1: Enforcement Signal Surfacing ────────────────────────────────────────
// Session-scoped state (migrated from module-level singletons)
import { getExtensionState } from "../../../lib/state/extension-state.js";

interface PromptBuilderState {
  activeContrastMode: string;
  insightsSent: boolean;
}

function getPromptState(ctx: ExtensionContext): PromptBuilderState {
  return getExtensionState(ctx, "prompt-builder", () => ({
    activeContrastMode: "TRUTH-SEEKING",
    insightsSent: false,
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

async function projectContextSection(cwd: string): Promise<PromptSection> {
  // Uses pi-core's exported `loadProjectContextFiles` instead of a local
  // re-implementation. The SDK exports this as a standalone utility
  // (see pi CHANGELOG for #3142). This keeps us in sync with the
  // canonical resolution order: agent-dir global context, then
  // cwd-ancestors (most-root last), deduped by path.

  // loadProjectContextFiles is sync, so wrap the call in a microtask
  // so the function remains `async` (matches PromptSection contract).
  const contextFiles = await Promise.resolve().then(() =>
    loadProjectContextFiles({ cwd, agentDir: getAgentDir() }),
  );

  return {
    name: "project-context",
    render: () => {
      if (contextFiles.length === 0) {
        return "";
      }

      const lines = ["<project_context>", "", "Project-specific instructions and guidelines:", ""];

      for (const { path: filePath, content } of contextFiles) {
        lines.push(`  <project_instructions path="${filePath}">`);
        lines.push(content);
        lines.push(`  </project_instructions>`);
      }

      lines.push("</project_context>");

      return lines.join("\n");
    },
  };
}

// ── Main Extension ───────────────────────────────────────────────────────────

export default function promptBuilderExtension(pi: ExtensionAPI) {
  // L1 state is now gathered per-request, not global

  // 4b: Listen for enforcement_signals events - replaces direct coupling via module-level singleton.
  // enforcement emits these on every turn_end and session_compact.
  registerSessionStartHandler(pi, SessionPhase.MemoryState, async (_event, ctx) => {
    const ps = getPromptState(ctx);
    pi.events.on("enforcement_signals", (data: unknown) => {
      const d = data as { contrastMode?: string };
      if (d.contrastMode) ps.activeContrastMode = d.contrastMode;
    });
  });

  // ── resources_discover: invalidate skills cache ──
  // When resources are re-discovered (e.g. /reload, or session replacement),
  // pi re-resolves skills and the next before_agent_start will receive an
  // updated systemPromptOptions.skills list. We invalidate our format cache
  // so the new list gets reformatted.
  pi.on(RESOURCES_DISCOVER, async (_event, ctx) => {
    resetSkillsSectionCache(ctx);
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

    const l1Env = await gatherL1State(pi, ctx);

    // 5. Supplemental context (past insights, hints, OpenSpec specs) →
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
    const sections: PromptSection[] = [
      // 1. Custom identity (THE key difference from native)
      simpleSection("identity", IDENTITY_INTRO),

      // 1a. Behavioral guardrails (concise, single-sentence, research-backed)
      simpleSection("guardrail-sycophancy", SYCOPHANCY_RESISTANCE),
      simpleSection("guardrail-stakes", STAKES_AWARENESS),
      simpleSection("guardrail-epistemic", EPISTEMIC_STABILITY),
      simpleSection("guardrail-surgical", SURGICAL_PRECISION),
      simpleSection("guardrail-budget", BUDGET_AWARENESS),

      // 1b. Compaction survival invariant - scratchpad + tasks must be self-contained
      //     so the agent can recover context after conversation compression
      simpleSection("invariant-compaction", COMPACTION_SURVIVAL),

      // 1c. Living documentation invariant - agent maintains AGENTS.md hierarchy
      //     Walk tree before edit, update docs after change (from DOX - agent0ai/dox)
      simpleSection("invariant-living-docs", LIVING_DOCS),

      // 8. Interaction style
      simpleSection("interaction-style", INTERACTION_STYLE),
    ];

    // 2. Available tools
    sections.push(toolsSection(tools));

    // 3. Skills (only when the read tool is available)
    if (hasRead) {
      // Use skills resolved by pi's full resource loader — this includes
      // package skills (e.g. pi-braid-skills), user/project skill dirs,
      // .agents/skills, and CLI --skill paths. We only re-format with
      // braid's line-count/section metadata; we do NOT re-discover skills
      // ourselves and we do NOT cap or filter them. Every skill is listed
      // with its full path so the agent can `read` any of them on demand.
      const skillsText = await reconstructSkillsSection(
        event.systemPromptOptions?.skills ?? [],
        ctx,
      );
      if (skillsText) sections.push(simpleSection("skills", skillsText));
    }

    // 4. Project context (replaces pi-native loading which prompt-builder overrides)
    // Render ahead of append so it goes into the dedup set before the user
    // append can be checked against it.
    const projectContext = await (await projectContextSection(cwd)).render();
    if (projectContext) {
      sections.push(simpleSection("project-context", projectContext));
    }

    // 5. L1 environmental state
    sections.push(l1EnvSection(l1Env));

    // 6. Date and cwd
    sections.push(
      simpleSection(
        "environment",
        `Current time: ${new Date().toISOString()}\nCurrent working directory: ${cwd.replace(/\\/g, "/")}`,
      ),
    );

    // 7. Active contrast mode (truthfulness guardrails)
    sections.push(contrastSection(ps.activeContrastMode));

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

export { gatherL1State, l1EnvSection };
