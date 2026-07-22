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
  SKILLS_LOADING,
  WORK_ETHIC,
  SELF_MANAGEMENT,
  COMMUNICATION,
  EPISTEMIC_STANCE,
  AGENT_AWARENESS,
} from "./identity.js";
import {
  reconstructProjectDocsSection,
  resetProjectDocsSectionCache,
} from "./project-docs-section.js";
import { setCachedSkills } from "../skills-tool/index.js";
import {
  reconstructMemorySection,
  resetMemorySectionCache,
} from "./memory-section.js";
import { instanceSection } from "./instance-composition.js";
import { resourcesSection, type SkillEntry } from "./resources-section.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { getTimerFilePath } from "../../../lib/config/braid-paths.js";
import { restoreTimer } from "../../../extensions/scheduling/timer/index.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { BRAID_INJECTED, BRAID_SOURCE } from "../../../lib/constants/injection-details.js";

/**
 * Fire persisted timers that expired during a process gap (e.g. /reload).
 * Reads PENDING_TIMERS_FILE, fires expired ones via a tracked wakeup message,
 * and rewrites the file with only the unexpired timers remaining.
 * Called once per before_agent_start (every turn) but cheap: empty file = no-op.
 */
function recoverPersistedTimers(pi: ExtensionAPI): void {
  try {
    const timerFile = getTimerFilePath(process.cwd());
    if (!existsSync(timerFile)) return;
    const raw = readFileSync(timerFile, "utf-8").trim();
    if (!raw) return;
    const timers = raw.split("\n").map((l) => JSON.parse(l));
    const now = Date.now();
    const remaining: unknown[] = [];
    let fired = 0;
    let restored = 0;
    for (const t of timers) {
      if (t.firesAt <= now) {
        const text = `[TIMER FIRED - persisted] ${t.reason} - Resume the task.`;
        try {
          sendTrackedMessage(
            pi,
            {
              customType: "timer-fire",
              content: [{ type: "text" as const, text }],
              display: true,
              details: { [BRAID_INJECTED]: true, [BRAID_SOURCE]: "timer/persisted-fire", timerId: t.id },
            },
            { triggerTurn: true },
            { type: "heartbeat", source: "timer/persisted-fire" },
            { bypassFloodCap: true },
          );
          fired++;
        } catch {
          remaining.push(t);
        }
      } else {
        // Re-arm unexpired timers into memory so the poller fires them on schedule.
        // restoreTimer() returns a new id; rewrite the disk entry with it.
        try {
          const newId = restoreTimer(t.sessionId, t.firesAt - now, t.reason, t.tag, t.wake);
          remaining.push({ ...t, id: newId });
          restored++;
        } catch {
          remaining.push(t);
        }
      }
    }
    writeFileSync(timerFile, remaining.map((t) => JSON.stringify(t)).join("\n") + (remaining.length ? "\n" : ""), "utf-8");
    if (fired > 0) console.log(`[timer] recovered ${fired} persisted timer(s) after restart`);
    if (restored > 0) console.log(`[timer] re-armed ${restored} unexpired persisted timer(s)`);
    if (fired > 0) console.log(`[timer] recovered ${fired} persisted timer(s) after restart`);
  } catch {
    /* non-fatal */
  }
}

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
}

function getPromptState(ctx: ExtensionContext): PromptBuilderState {
  return getExtensionState(ctx, "prompt-builder", () => ({
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

// ── Guidelines section (sub-structures by family) ─────────────────────────
// Extracted from toolsSection() to match pi-core's native pattern: guidelines
// appear BEFORE tools, not embedded after them. This makes the prompt
// structure: Identity → Guidelines → Tools → Skills → Context.

/**
 * File tool guidelines: bash/grep/find/ls usage (pi-core native pattern).
 * Conditional on tool availability — only shows if bash is present.
 */
function fileToolGuidelines(toolNames: string[]): string[] {
  const lines: string[] = [];
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

/**
 * Communication guidelines: always-included pi-native directives.
 */
function communicationGuidelines(): string[] {
  return [
    "Prefer clear, direct responses",
    "Show file paths clearly when working with files",
    // Research backing: Bakhshi (2026) arXiv:2604.19768 - LLMs exhibit systematic
    // epistemic-rhetorical patterns at ~2x human rate
    "Write text that reads naturally, as if written by a human, not generated by a machine",
  ];
}

/**
 * Context navigation pipeline guidelines (tool-availability-guarded).
 *
 * Teaches the agent the session-tree mental model and how to compose
 * navigation tools strategically — not just what each tool does (the tools
 * section already covers that), but how to use them together.
 *
 * Concise: no markdown headings, no excessive structure (per P0-2).
 */
function contextNavigationGuidelines(toolNames: string[]): string[] {
  const lines: string[] = [];
  const hasContextNavigate = toolNames.includes("context_navigate");
  const hasContextCompress = toolNames.includes("context_compress");
  const hasContextInspect = toolNames.includes("context_inspect");
  const hasContextProposals = toolNames.includes("context_proposals");

  if (!hasContextNavigate && !hasContextCompress && !hasContextInspect && !hasContextProposals) {
    return lines;
  }

  lines.push("");

  if (hasContextNavigate) {
    lines.push("The session is a branching tree \u2014 tag positions, log to see history, checkout to jump to a leaf with its context summarized. Use backupTag to save your spot before jumping.");
  }

  if (hasContextNavigate && hasContextCompress) {
    lines.push("To explore a leaf in depth: tag your position, checkout to the target, explore, then checkout back to resume.");
  }

  if (hasContextCompress) {
    lines.push("Free space: archive when > 50%, compact as last resort (> 70%). Pipeline: tag \u2192 archive \u2192 inspect.");
  }

  if (hasContextInspect || hasContextProposals) {
    const parts: string[] = [];
    if (hasContextInspect) parts.push("context_inspect for summary or bloat detection");
    if (hasContextProposals) parts.push("context_proposals for pending auto-suggestions");
    lines.push("Health: " + parts.join("; ") + ".");
  }

  return lines;
}

/**
 * Assemble all guidelines into a single section, placed before tools.
 * Order: file tools → communication → context navigation.
 * Each family is a clear sub-structure for easy maintainability.
 */
function guidelinesSection(toolNames: string[]): PromptSection {
  const allLines = [
    ...fileToolGuidelines(toolNames),
    ...communicationGuidelines(),
    ...contextNavigationGuidelines(toolNames),
  ];
  return linesSection("guidelines", allLines, { dedup: true });
}

function toolsSection(tools: ReturnType<ExtensionAPI["getAllTools"]>): PromptSection {
  // pi-native stores promptSnippets internally but getAllTools() doesn't expose them.
  // KNOWN_SNIPPETS covers pi-native core tools (their descriptions are parameter schemas,
  // not prose). For all other tools, extract first sentence from t.description.
  const visibleTools = tools
    .filter((t) => t.name && (t.description || KNOWN_SNIPPETS[t.name]))
    .map((t) => {
      const snippet = KNOWN_SNIPPETS[t.name] ?? firstSentence(t.description ?? "");
      return `- ${t.name}: ${snippet}`;
    })
    .join("\n");

  return {
    name: "tools",
    render: () => {
      return `Available tools:\n${visibleTools || "(none)"}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
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

import { createPromptInspectTool } from "./inspect.js";

export default function promptBuilderExtension(pi: ExtensionAPI) {
  pi.registerTool(createPromptInspectTool());
  // L1 state is now gathered per-request, not global

  // Context: tools, skills, memories, runtime extensions, project docs, memory ──
  // Fetched once per session, cached afterwards (session-scoped state).
  // Uses registerSessionStartHandler so the state is available before the
  // first prompt is built.
  registerSessionStartHandler(pi, SessionPhase.MemoryState, async (_event, ctx) => {
    const ps = getPromptState(ctx);
    // No enforcement_signals listener needed — behavior modes were removed
    // in 2026-07-13. All directives are now static identity invariants.
  });

  // ── resources_discover: invalidate skills, project-docs, memory caches ──
  // When resources are re-discovered (e.g. /reload, or session replacement),
  // pi re-resolves skills and project context. We invalidate our format
  // caches so the next before_agent_start renders with the new sets. The
  // memory section also invalidates so a freshly-written episode surfaces
  // in the next turn's pointer block.
  pi.on(RESOURCES_DISCOVER, async (_event, ctx) => {
    resetProjectDocsSectionCache(ctx);
    resetMemorySectionCache(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Fire any persisted timers that expired during a process gap (e.g. /reload)
    recoverPersistedTimers(pi);

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
    // Cache skills for the list_skills tool (on-demand discovery).
    setCachedSkills(skills);
    // Extract unique base directories from loaded skill file paths so the
    // Instance block can show where skills are loaded from (not just the count).
    const skillDirs = [...new Set(skills.map((s) => s.baseDir).filter(Boolean))];
    let memoryCount = 0;
    try {
      const memory = getCognitiveMemory();
      try { await memory.init(); } catch { /* already init'd or non-fatal */ }
      memoryCount = memory.getAll(3).length;
    } catch { /* memory unavailable - non-fatal */ }
    const inst = await instanceSection(pi, ctx, {
      skillCount: skills.length,
      skillDirs,
      skills: skills.map((s) => ({
        name: s.name,
        filePath: s.filePath,
        baseDir: s.baseDir,
      })),
      memoryCount,
    });

    const sections: PromptSection[] = [
      // 0. Instance composition (top of prompt, stable per session)
      inst,

      // 1. Identity: who Braid is (6 consolidated blocks, no heading)
      simpleSection("identity", [
        IDENTITY_INTRO,
        WORK_ETHIC,
        SELF_MANAGEMENT,
        COMMUNICATION,
        EPISTEMIC_STANCE,
        AGENT_AWARENESS,
      ].join("\n\n")),

      // 2. Skills-loading directive (before guidelines, before tools).
      //    Tells the agent to load skills on first tool call.
      simpleSection("skills-loading", SKILLS_LOADING),

      // 3. Guidelines (before tools, pi-core native pattern).
      //    Order: file tools → communication → context navigation.
      guidelinesSection(toolNames),
    ];

    // 3.5. Resources (skill counts, memory counts) — before tools so the
    //       agent knows what skills are available before seeing the tool list.
    const res = resourcesSection({
      skillCount: skills.length,
      skillDirs,
      skills: skills.map((s) => ({
        name: s.name,
        filePath: s.filePath,
        baseDir: s.baseDir,
      })),
      memoryCount,
      cwd,
    });
    const resText = await res.render();
    if (resText) sections.push(simpleSection("resources", resText));

    // 4. Available tools
    sections.push(toolsSection(tools));

    // 5. Unified context block (project-docs + memory + runtime context).
    //    No heading — plain text, like the rest of the prompt.
    const contextFragments = [
      await (await projectContextSection(cwd, ctx)).render(),
      await reconstructMemorySection(ctx),
      await context.render(),
    ].filter((s) => s && s.trim() !== "");
    const contextBlock = contextFragments.join("\n\n");
    sections.push(simpleSection("context", contextBlock));

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
