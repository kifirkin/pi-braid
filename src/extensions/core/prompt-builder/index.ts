import { readFile } from "node:fs/promises";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  searchPastInsights,
  pastInsightsSection,
  deriveProjectIdFromCwd,
} from "./past-insights.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";
import { asyncExists } from "../../../lib/utils/async-fs.js";

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
 * CHANGES from implicit-framing research:
 * - Removed 5 sections (THINK_SILENTLY, BEHAVIORAL_GUIDELINES, KEY_TOOL_COMBINATIONS, VERIFICATION_REMINDER, IMPLICIT_BUDGET)
 * - Condensed INTERACTION_STYLE to single sentence
 * - Removed directive guidelines - behaviors are latent, not from directives
 * - Removed latent behavior activation from prompt (moved to runtime)
 * - Added sycophancy resistance (2604.19117), stakes awareness (2604.15224), epistemic stability (2604.14881)
 * - Added surgical precision (minimal targeted changes) + budget awareness (goal-driven execution)
 * - Removed 7 sections (SYCOPHANCY_RESISTANCE as section, STAKES_AWARENESS as section, IMPLICIT_NORMS,
 *   TOOL_TRUST, format guidance, RepE jargon header, all-modes listing)
 * - Truncated tool descriptions to first line only
 */

import { join } from "node:path";
import { CONSOLIDATED_HINTS_FILE } from "../../../lib/config/braid-paths.js";
import { RESOURCES_DISCOVER } from "../../../lib/core/event-names.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
// SKILLS_DIR import removed - skills moved to pi-braid-skills package.
// NOTE: we deliberately do NOT call loadSkills() here. Skills are now sourced
// from event.systemPromptOptions.skills, which pi has already resolved through
// its full package manager pipeline (user dirs, project dirs, .agents/skills,
// packages, CLI --skill, settings.json skills). Re-walking dirs ourselves
// would miss package skills (e.g. pi-braid-skills) and other pi sources.
import { gatherL1State, l1EnvSection } from "./l1-environment.js";
import { contrastSection } from "./contrast-phrase-library.js";
import { activeSpecsSection } from "./openspec.js";
import { classify } from "../../../lib/ai/text-classifier.js";
import { CRITICS } from "../../../lib/ai/critic-registry.js";
import type { PromptSection } from "./section.js";
import { linesSection, simpleSection, composeSections } from "./section.js";

// ── Identity (THE key difference from native) ─────────────────────────────────
// Identity framing is the behavioral filter - not directives
const IDENTITY_INTRO = `You are Braid, an expert software architect operating inside a pi coding agent harness.
Your tools let you act - use them wisely and strategically.
Your skills let you navigate - load them before every task. Skills contain reference maps, procedures, and domain knowledge.`;

// ── Core behavioral guardrails (concise, single-sentence, research-backed) ──
// Sycophancy: 2604.19117 - agreement under pressure is a failure mode
const SYCOPHANCY_RESISTANCE = `Technical correctness over agreement. You say when something is wrong, even under pressure.`;
// Stakes: 2604.15224 - consequence framing corrupts reasoning implicitly
const STAKES_AWARENESS = `Enforcement signals must be architecturally absent. Ensure the evaluation pipeline provides zero contextual metadata regarding downstream stakes, forcing the judge to evaluate pure correctness.`;
// Epistemic stability: 2604.14881 - detect reasoning instability before output
const EPISTEMIC_STABILITY = `If your reasoning feels uncertain or unstable, signal that uncertainty rather than manufacturing confidence.`;
// Surgical precision: minimal targeted changes, read before write, no speculative abstraction
const SURGICAL_PRECISION = `Make minimal, targeted changes. Read shared utilities and existing callers before writing new code. Don't refactor adjacent code or add speculative abstractions.`;
// Budget awareness: define success criteria, loop until verified, checkpoint progress
const BUDGET_AWARENESS = `Define success criteria before execution. Verify against them. Checkpoint progress at significant steps.`;

// Compaction survival: write structured session memory for post-compaction continuity
// Inspired by Agent Zero's "prompt invariant" concept - instructions that survive
// compaction because they live in tool-backed surfaces (scratchpad, task tool).
// The key insight: after compaction, the agent retains structured data (scratchpad,
// tasks) but loses the conversational context that gave it meaning. Writing entries
// with enough self-contained detail solves this.
const COMPACTION_SURVIVAL = `Keep your scratchpad (goal, plan, decisions, key learnings) and task list detailed enough that a future you could pick up your work cold. That future you is you, after the conversation compresses. Include file paths and reasoning so each entry is self-contained.`;

// Living documentation: agent-maintained doc hierarchy (inspired by DOX - agent0ai/dox)
const LIVING_DOCS = `Project guidelines are living contracts you maintain. Keep them synchronized with the project structure.`;

// ── Interaction Style (single declarative sentence) ───────────────────────
const INTERACTION_STYLE = `You think hard silently to find correct reasoning trajectory. You provide concise, production-quality solutions. You focus on correctness over verbosity.`;

// ── L1: Enforcement Signal Surfacing ────────────────────────────────────────
// Session-scoped state (migrated from module-level singletons)
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";

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

const HINT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function loadConsolidatedHints(currentProject?: string): Promise<string[]> {
  try {
    if (!(await asyncExists(CONSOLIDATED_HINTS_FILE))) return [];
    const content = await readFile(CONSOLIDATED_HINTS_FILE, "utf-8");
    const lines = content.split("\n").filter((l: string) => l.trim());
    if (lines.length === 0) return [];

    const now = Date.now();
    const parsed = lines
      .map((l: string) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((h: any): h is Record<string, any> => h !== null)
      .filter((h: any) => h.steps && (h.steps as string[]).length > 0)
      .filter((h: any) => now - (h.createdAt ?? 0) < HINT_MAX_AGE_MS);

    if (parsed.length === 0) return [];

    // Filter: prefer same-project hints. Cross-project hints are only included
    // if they pass a higher quality bar (score >= 80) - same logic as
    // isCrossProjectInjectionAllowed for episodic memory.
    const sameProject = currentProject
      ? parsed.filter(
          (h: any) => !h.project || h.project === currentProject || h.project === "unknown",
        )
      : parsed;
    const crossProject = currentProject
      ? parsed.filter(
          (h: any) =>
            h.project &&
            h.project !== currentProject &&
            h.project !== "unknown" &&
            (h.score ?? 0) >= 80,
        )
      : [];
    const candidates = [...sameProject, ...crossProject];

    // Deduplicate by task: keep only the most recent entry per task
    const byTask = new Map<string, any>();
    for (const h of candidates) {
      const key = h.task ?? "";
      const existing = byTask.get(key);
      if (!existing || (h.createdAt ?? 0) > (existing.createdAt ?? 0)) {
        byTask.set(key, h);
      }
    }
    const deduped = Array.from(byTask.values())
      .filter((h) => h.createdAt != null)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

    // Take the 3 most recent, render as readable strings
    return deduped.slice(-3).map((h) => {
      const task = (h.task ?? "unknown").slice(0, 80);
      const steps = (h.steps as string[]).slice(0, 3).join(" → ");
      return `When working on "${task}": ${steps}`;
    });
  } catch {
    return [];
  }
}

// HINT_RELEVANCE_CRITERIA was moved to CRITICS.hintRelevance in critic-registry.ts

/**
 * Heuristic fallback (Tier 1 graceful degradation).
 * Only the obviously-generic patterns are rejected here. The semantic
 * matching ("does this hint apply to the current task?") is left to
 * the LLM tier - keyword-overlap Jaccard was tried and removed because
 * it produced too many false positives and false negatives.
 */
function hintRelevanceFallback(hint: string, _currentTask: string): string {
  if (hint.length < 30) return "no";
  if (/Fix \w+ error:/.test(hint)) return "no";
  if (/Debug.*isolate/.test(hint)) return "no";
  if (/Reproduce.*Locate.*Apply/.test(hint)) return "no";
  return "yes";
}

/**
 * Extract the current task from the session - the most recent user message.
 * Returns a short summary, max ~200 chars.
 */
function getCurrentTask(ctx: ExtensionContext): string {
  try {
    const sm = ctx.sessionManager;
    if (!sm || typeof sm.getBranch !== "function") return "";
    const branch = sm.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === "message" && entry.message?.role === "user") {
        const content = entry.message.content;
        let text = "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          text = content
            .filter((c: any) => c?.type === "text")
            .map((c: any) => c?.text || "")
            .join(" ");
        }
        return text.trim().slice(0, 500);
      }
    }
  } catch {
    // Non-fatal: empty current task means keyword check rejects all hints,
    // which is the safe default.
  }
  return "";
}

/**
 * Pre-filter: run the cheap heuristic BEFORE the LLM classifier.
 * If the heuristic says "no", skip the expensive LLM call entirely.
 * This prevents known-bad hints from slipping through when the LLM
 * misclassifies them despite instructions to reject generic patterns.
 */
/**
 * Filter hints by relevance using the utility model.
 * Returns only hints classified as relevant to the current session.
 */
async function filterRelevantHints(hints: string[], ctx: ExtensionContext): Promise<string[]> {
  const currentTask = getCurrentTask(ctx);
  // Empty current task → reject all hints. Better to surface nothing
  // than to inject a hint that has no task to be relevant to.
  if (!currentTask) return [];

  const results = await Promise.all(
    hints.map((hint) =>
      classify(
        ctx,
        CRITICS.hintRelevance.criteria,
        { hint, currentTask },
        {
          maxTokens: 5,
          timeoutMs: 3000,
          fallback: () => hintRelevanceFallback(hint, currentTask),
        },
      ),
    ),
  );

  return hints.filter((_, i) => results[i].label === "yes");
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
  // Re-implemented from loadProjectContextFiles (not exported from pi)
  // Searches for AGENTS.md or CLAUDE.md in cwd and ancestors
  // NOTE: pi's native loading is overridden by prompt-builder, so we must replicate here

  const contextFiles: Array<{ path: string; content: string }> = [];
  const seenPaths = new Set<string>();

  async function loadContextFromDir(
    dir: string,
  ): Promise<{ path: string; content: string } | null> {
    const candidates = ["AGENTS.md", "CLAUDE.md"];
    for (const filename of candidates) {
      const filePath = join(dir, filename);
      if (await asyncExists(filePath)) {
        try {
          return {
            path: filePath,
            content: await readFile(filePath, "utf-8"),
          };
        } catch {
          // Skip files that can't be read
          /* Non-fatal: prompt parsing failed */
        }
      }
    }
    return null;
  }

  // Global context (agent dir)
  const agentDir = getAgentDir();
  const globalContext = await loadContextFromDir(agentDir);
  if (globalContext) {
    contextFiles.push(globalContext);
    seenPaths.add(globalContext.path);
  }

  // Ancestor context files (from cwd up to root)
  const root = join("/");
  let currentDir = cwd;

  while (true) {
    const contextFile = await loadContextFromDir(currentDir);
    if (contextFile && !seenPaths.has(contextFile.path)) {
      contextFiles.unshift(contextFile);
      seenPaths.add(contextFile.path);
    }

    if (currentDir === root) break;

    const parentDir = join(currentDir, "..");
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

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

/**
 * Skill metadata: counts lines and extracts section headings from each
 * SKILL.md so the agent can size up a skill before reading the full file.
 * Surfaced as `<lines>` and `<sections>` XML attributes in <available_skills>.
 */
interface SkillMeta {
  totalLines: number;
  sections: string[];
}

async function getSkillMeta(skill: Skill): Promise<SkillMeta> {
  try {
    const content = await readFile(skill.filePath, "utf-8");
    const lines = content.split("\n");
    const sections: string[] = [];

    // Extract markdown heading names (## Section Title)
    for (const line of lines) {
      const match = line.match(/^#{2,3}\s+(.+)$/);
      if (match) {
        sections.push(match[1].trim());
      }
    }

    return { totalLines: lines.length, sections: sections.slice(0, 8) };
  } catch {
    return { totalLines: 0, sections: [] };
  }
}

/**
 * Format all skills for inclusion in the system prompt.
 *
 * Mirrors the native pi format (one <skill> entry per resolved skill with
 * name, description, and location) plus a braid enhancement: each entry
 * also carries <lines> and <sections> so the agent can size up a skill
 * before reading the full file. No relevance scoring, no cap, no hidden
 * list — every skill the loader produced is here, so the agent can
 * always `read` any of them on demand. Skills with
 * `disable-model-invocation: true` are excluded, matching native.
 */
async function skillsSection(skills: Skill[]): Promise<PromptSection> {
  return {
    name: "skills",
    render: async () => {
      const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
      if (visibleSkills.length === 0) {
        return "";
      }

      // Sort alphabetically for stable, predictable output. No scoring, no cap.
      const sorted = [...visibleSkills].sort((a, b) => a.name.localeCompare(b.name));

      const lines = [
        "Skills are your first knowledge in context. Read all of the relevant ones with `read` tool before starting a task.",
        "<available_skills>",
      ];

      for (const skill of sorted) {
        const meta = await getSkillMeta(skill);
        lines.push("  <skill>");
        lines.push(`    <name>${escapeXml(skill.name)}</name>`);
        lines.push(`    <description>${escapeXml(skill.description)}</description>`);
        lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
        lines.push(`    <lines>${meta.totalLines}</lines>`);
        if (meta.sections.length > 0) {
          lines.push(`    <sections>${meta.sections.join(" | ")}</sections>`);
        }
        lines.push("  </skill>");
      }

      lines.push("</available_skills>");

      return lines.join("\n");
    },
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Cache the formatted skills section per skill-set fingerprint so we don't
// re-read every SKILL.md and re-score relevance on every turn. Invalidated
// when the set of loaded skills changes (e.g. after /reload or session start).
let skillsSectionCache:
  | { fingerprint: string; section: string }
  | undefined;

function fingerprintSkills(skills: readonly Skill[]): string {
  // Stable, order-independent hash of the resolved skill set.
  // filePath is unique per skill within a single resolution; name disambiguates
  // collisions (loadSkills emits a diagnostic in that case).
  return skills
    .map((s) => `${s.name}\u0000${s.filePath}`)
    .sort()
    .join("\n");
}

async function reconstructSkillsSection(
  skills: readonly Skill[],
): Promise<string> {
  const fingerprint = fingerprintSkills(skills);
  if (skillsSectionCache?.fingerprint === fingerprint) {
    return skillsSectionCache.section;
  }
  // Render immediately so the cache holds the final string. The fingerprint
  // already captures the input identity; we don't need to re-derive the
  // PromptSection on cache hits.
  const section = await (await skillsSection(skills as Skill[])).render();
  skillsSectionCache = { fingerprint, section };
  return section;
}

function resetSkillsSectionCache(): void {
  skillsSectionCache = undefined;
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
  pi.on(RESOURCES_DISCOVER, () => {
    resetSkillsSectionCache();
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

    // 5. Past insights + hints → offloaded to steer whisper (once per session)
    // Avoids per-turn disk I/O and system prompt bloat for supplemental context.
    // Done BEFORE building sections so the offloaded work happens in parallel
    // with the rest of the prompt assembly.
    if (!ps.insightsSent) {
      const pastInsights = await searchPastInsights(cwd);
      const insightsText = await pastInsightsSection(pastInsights).render();
      if (insightsText) {
        try {
          sendTrackedMessage(
            pi,
            {
              customType: "context",
              display: true,
              content: [{ type: "text" as const, text: insightsText }],
            },
            { deliverAs: "steer", triggerTurn: false },
            { type: "memory", source: "prompt-builder/insights" },
          );
        } catch {
          // Non-fatal: steer message send is best-effort
        }
      }

      // Load and filter hints by utility model relevance, deliver as whispers
      // Pass project ID so cross-project hints are deprioritized.
      const projectId = deriveProjectIdFromCwd(cwd);
      const allHints = await loadConsolidatedHints(projectId);
      if (allHints.length > 0) {
        try {
          const relevantHints = await filterRelevantHints(allHints, ctx);
          for (const hint of relevantHints) {
            sendTrackedMessage(
              pi,
              {
                customType: "hint",
                display: true,
                content: [{ type: "text" as const, text: `[hint] ${hint}` }],
              },
              { deliverAs: "steer", triggerTurn: false },
              { type: "memory", source: "prompt-builder/hint" },
            );
          }
        } catch {
          // Non-fatal: hint delivery is best-effort
        }
      }

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

    // 7. OpenSpec spec context (inject SHALL/MUST requirements from active specs)
    sections.push(activeSpecsSection(cwd));

    // 8. Active contrast mode (truthfulness guardrails)
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
