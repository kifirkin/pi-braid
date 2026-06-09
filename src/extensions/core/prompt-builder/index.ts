import { stat, readFile } from "node:fs/promises";
import { createPromptPreviewTool } from "./preview.js";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  searchPastInsights,
  formatPastInsightsSection,
  deriveProjectIdFromCwd,
} from "./past-insights.js";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/state/session-start-queue.js";

/** Async helper: check if a path exists (replaces existsSync). */
async function asyncExists(p: string): Promise<boolean> {
  return stat(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * Prompt Builder - Reconstruction from Structured Data
 *
 * No fragile string extraction. Everything built from APIs and fixed templates.
 * Only pi-braid additions (identity, L1, enforcement) are custom.
 *
 * Sections built from structured data:
 * - Tools: pi.getAllTools() (with promptSnippet)
 * - Skills: loadSkills() + formatSkillsWithLineCounts() (pi-braid enhanced)
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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { SKILLS_DIR } from "../../../lib/config/project-paths.js";
import { gatherL1State, formatL1Environment } from "./l1-environment.js";
import { formatContrastSection } from "./contrast-phrase-library.js";
import { classify } from "../../../lib/ai/text-classifier.js";

// ── Identity (THE key difference from native) ─────────────────────────────────
// Identity framing is the behavioral filter - not directives
const IDENTITY_INTRO = `You are Braid, an expert software architect operating inside a pi coding agent harness with pi-braid extension.
Your tools let you act. Your skills let you navigate — load them before every task.
Skills contain reference maps, procedures, and domain knowledge. Not loading the right skill means operating blind.
You think hard silently to find correct reasoning trajectory.`;

// ── Core behavioral guardrails (concise, single-sentence, research-backed) ──
// Sycophancy: 2604.19117 - agreement under pressure is a failure mode
const SYCOPHANCY_RESISTANCE = `Technical correctness over agreement. You say when something is wrong, even under pressure.`;
// Stakes: 2604.15224 - consequence framing corrupts reasoning implicitly
const STAKES_AWARENESS = `Enforcement signals carry no weight. You judge correctness, not stakes.`;
// Epistemic stability: 2604.14881 - detect reasoning instability before output
const EPISTEMIC_STABILITY = `If your reasoning feels uncertain or unstable, signal that uncertainty rather than manufacturing confidence.`;
// Surgical precision: minimal targeted changes, read before write, no speculative abstraction
const SURGICAL_PRECISION = `Make minimal, targeted changes. Read shared utilities and existing callers before writing new code. Don't refactor adjacent code or add speculative abstractions.`;
// Budget awareness: define success criteria, loop until verified, checkpoint progress
const BUDGET_AWARENESS = `Define success criteria before execution. Verify against them. Checkpoint progress at significant steps.`;

// Compaction survival: write structured session memory for post-compaction continuity
// Inspired by Agent Zero's "prompt invariant" concept — instructions that survive
// compaction because they live in tool-backed surfaces (scratchpad, task tool).
// The key insight: after compaction, the agent retains structured data (scratchpad,
// tasks) but loses the conversational context that gave it meaning. Writing entries
// with enough self-contained detail solves this.
const COMPACTION_SURVIVAL = `Keep your scratchpad (goal, plan, decisions, key learnings) and task list detailed enough that a future you could pick up your work cold. That future you is you, after the conversation compresses. Include file paths and reasoning so each entry is self-contained.`;

// Living documentation: agent-maintained doc hierarchy (inspired by DOX — agent0ai/dox)
// Before editing, walk the docs tree from root to target, reading every AGENTS.md
// along the path. After meaningful changes, update the nearest owning AGENTS.md
// (purpose, scope, contracts, workflows). Create child AGENTS.md files for
// subdirectories with distinct ownership, and keep the tree synchronized.
const LIVING_DOCS = `Project guidelines (AGENTS.md files) are living contracts you maintain. Before editing a file, read every AGENTS.md along the path from root to target. After making a meaningful change, update the nearest owning AGENTS.md — scope, ownership, contracts, and workflows drift otherwise. Create child AGENTS.md files for subdirectories with distinct purpose or rules, and keep the doc tree synchronized with the project structure. Docs are agent-maintained, not human-maintained — you can create and update them. Stick to the default shape: Purpose, Ownership, Local Contracts, Work Guidance, Verification.`;

// ── Interaction Style (single declarative sentence) ───────────────────────
const INTERACTION_STYLE = `You provide concise, production-quality solutions. You focus on correctness over verbosity.`;

// ── L1: Enforcement Signal Surfacing ────────────────────────────────────────
// Session-scoped state (migrated from module-level singletons)
import { getExtensionState } from "../../../lib/state/extension-state.js";
import { sendTrackedMessage } from "../../../lib/utils/injection-tracker.js";
import { onEvent } from "../../../lib/events/event-types.js";
import { RESOURCES_DISCOVER } from "../../../lib/core/event-names.js";

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
    // if they pass a higher quality bar (score >= 80) — same logic as
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

/**
 * Relevance criteria for hints — uses the hint text and a context summary.
 */
const HINT_RELEVANCE_CRITERIA = {
  systemPrompt:
    "You are a relevance classifier. Determine if the given behavioral hint " +
    "is relevant to the user's current task. A hint is relevant ONLY if it " +
    "describes a strategy or workflow that could plausibly apply to the " +
    "current task based on shared topic, tool, or methodology. " +
    "Generic hints like 'Fix type error: Reproduce → Locate → Apply' are NOT " +
    "relevant even if vaguely applicable. " +
    "Answer only 'yes' or 'no'. Do not explain.",
  userPrompt:
    "Current task: {{currentTask}}\n" +
    "Hint: {{hint}}\n" +
    "Is this hint relevant to the current task?",
};

/** Heuristic fallback: reject generic-seeming hints. */
function hintRelevanceFallback(hint: string, currentTask: string): string {
  // Reject hints shorter than 30 chars or that match generic patterns
  if (hint.length < 30) return "no";
  if (/Fix \w+ error:/.test(hint)) return "no";
  if (/Debug.*isolate/.test(hint)) return "no";
  if (/Reproduce.*Locate.*Apply/.test(hint)) return "no";
  // Keyword overlap check: require at least one significant word (3+ chars,
  // not a stop word) in common between the hint and the current task.
  // This catches obvious false positives like a "session_outcome" hint
  // being suggested for a code refactoring task.
  const hintWords = new Set(extractKeywords(hint));
  const taskWords = new Set(extractKeywords(currentTask));
  for (const w of hintWords) {
    if (taskWords.has(w)) return "yes";
  }
  return "no";
}

/** Common stop words that don't count for keyword overlap. */
const HINT_STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need",
  "that", "this", "these", "those", "what", "which", "who", "whom",
  "with", "without", "from", "into", "onto", "and", "or", "but",
  "if", "then", "else", "when", "where", "how", "why", "not",
  "all", "each", "every", "both", "few", "more", "most", "other",
  "some", "such", "no", "nor", "only", "own", "same", "so",
  "than", "too", "very", "just", "also", "now", "here", "there",
  "use", "used", "using", "via", "for", "make", "made", "run",
]);

/** Extract lowercase keywords (3+ chars, alphanumeric) excluding stop words. */
function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !HINT_STOP_WORDS.has(w));
}

/**
 * Extract the current task from the session — the most recent user message.
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
        HINT_RELEVANCE_CRITERIA,
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
 * "what it does" and "when to use" — no transformation needed.
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

function reconstructToolsSection(tools: ReturnType<ExtensionAPI["getAllTools"]>): string {
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
  const guidelines: string[] = [];
  const addGuideline = (g: string) => {
    const trimmed = g.trim();
    if (trimmed.length > 0 && !guidelines.includes(trimmed)) {
      guidelines.push(trimmed);
    }
  };

  // pi-native's bash/grep/find/ls conditional (from system-prompt.js)
  const hasBash = toolNames.includes("bash");
  const hasGrep = toolNames.includes("grep");
  const hasFind = toolNames.includes("find");
  const hasLs = toolNames.includes("ls");
  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    addGuideline("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    addGuideline(
      "Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    );
  }

  // Always-included guidelines (pi-native)
  addGuideline("Prefer clear, direct responses");
  addGuideline("Show file paths clearly when working with files");
  // Research backing: Bakhshi (2026) arXiv:2604.19768 - LLMs exhibit systematic epistemic-rhetorical patterns at ~2x human rate
  addGuideline(
    "Write text that reads naturally, as if written by a human, not generated by a machine",
  );

  const toolGuidelines = guidelines.length > 0 ? "\n\n" + guidelines.join("\n") : "";

  return `Available tools:\n${visibleTools || "(none)"}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.${toolGuidelines}`;
}

async function reconstructProjectContextSection(cwd: string): Promise<string> {
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
}

/**
 * Collect raw project context file contents for skill relevance scoring.
 * Avoids re-reading files that reconstructProjectContextSection already loaded.
 */
async function collectProjectContextStrings(cwd: string): Promise<string[]> {
  const agentDir = getAgentDir();
  const seenPaths = new Set<string>();
  const rawContents: string[] = [];

  async function loadRaw(dir: string): Promise<void> {
    const candidates = ["AGENTS.md", "CLAUDE.md"];
    for (const filename of candidates) {
      const filePath = join(dir, filename);
      if ((await asyncExists(filePath)) && !seenPaths.has(filePath)) {
        seenPaths.add(filePath);
        try {
          rawContents.push(await readFile(filePath, "utf-8"));
        } catch {
          // skip unreadable
        }
      }
    }
  }

  await loadRaw(agentDir);

  const root = join("/");
  let currentDir = cwd;
  while (true) {
    await loadRaw(currentDir);
    if (currentDir === root) break;
    const parentDir = join(currentDir, "..");
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return rawContents;
}

/**
 * Skill relevance triggers — each skill maps to keywords that indicate
 * when it should be surfaced in the prompt. Skills without matches still
 * appear but with lower priority unless the user explicitly references them.
 *
 * Phase 1 of dynamic skill loading (SKILL-LOADING-RESEARCH.md):
 * Relevance-based filtering at prompt construction time. Phase 2 will add
 * heartbeat-triggered activation and mid-session loading/unloading.
 */
const SKILL_TRIGGERS: Record<string, string[]> = {
  "agent-testing": ["benchmark", "test", "evaluat", "RPC", "trial", "harness", "subagent"],
  "code-search": ["search", "grep", "codemod", "refactor", "find"],
  "design-system": ["design token", "brand", "visual identity", "DESIGN.md"],
  "documentation": ["documentation", "README", "ARCHITECTURE.md", "doc", "readme"],
  "healthcheck": ["healthcheck", "diagnos", "setup", "troubleshoot", "env"],
  "meta-improvement": ["skill", "experiment", "self-improve", "metric"],
  "paper-writer": ["paper", "LaTeX", "arXiv", "research paper", "academic"],
  "pi-reference": ["pi", "SDK", "extension", "plugin", "provider", "model"],
  "process-control": ["tmux", "nohup", "long-run", "background", "daemon", "subagent"],
  "research": ["research", "web search", "fact-check", "literature", "find"],
  "software-engineer": ["code", "debug", "implement", "refactor", "bug"],
  "subagent": ["subagent", "spawn", "worker", "orchestrat", "parallel", "fan-out", "RPC mode"],
  "tone-quality": ["tone", "writing", "voice", "style", "prompt", "skill", "documentation"],
  "vcs-tools": ["git", "pijul", "version control", "commit", "checkpoint"],
  "visual-creator": ["visual", "UI", "game asset", "sprite", "illustration"],
  "visual-validator": ["visual audit", "sprite sheet", "design review"],
};

/** Skills that should be co-loaded when a related skill is relevant. */
const SKILL_RELATIONS: Record<string, string[]> = {
  "agent-testing": ["process-control", "pi-reference"],
  "meta-improvement": ["tone-quality", "pi-reference"],
  "process-control": ["agent-testing"],
  "subagent": ["agent-testing", "process-control", "pi-reference"],
  "tone-quality": ["pi-reference"],
  "visual-creator": ["visual-validator", "design-system"],
};

/** Score how relevant each skill is given the current cwd and project context. */
function scoreSkillRelevance(skill: Skill, cwd: string, projectContextFiles: string[]): number {
  // Always include skills the agent has explicitly used before (base relevance)
  let score = 0.1;

  // Boost from cwd path patterns
  const cwdLower = cwd.toLowerCase();
  if (cwdLower.includes("paper") || cwdLower.includes("arxiv")) score += 0.3;
  if (cwdLower.includes("test") || cwdLower.includes("benchmark")) score += 0.2;
  if (cwdLower.includes("design") || cwdLower.includes("brand")) score += 0.2;
  if (cwdLower.includes("docs") || cwdLower.includes("doc")) score += 0.15;
  if (cwdLower.includes("research")) score += 0.2;
  if (cwdLower.includes("pi") || cwdLower.includes("extension") || cwdLower.includes("plugin"))
    score += 0.2;

  // Boost from project context file contents
  const contextText = projectContextFiles.join(" ").toLowerCase();
  const triggers = SKILL_TRIGGERS[skill.name] ?? [];
  for (const trigger of triggers) {
    if (contextText.includes(trigger.toLowerCase())) {
      score += 0.3;
    }
  }

  // Boost from skill description matching cwd activity
  const desc = skill.description.toLowerCase();
  if (cwdLower.includes("paper") && desc.includes("research")) score += 0.2;
  if (cwdLower.includes("test") && desc.includes("test")) score += 0.2;

  return Math.min(score, 1.0);
}

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

async function formatSkillsWithLineCounts(
  skills: Skill[],
  cwd: string,
  projectContext: string[],
): Promise<string> {
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
  if (visibleSkills.length === 0) {
    return "";
  }

  // Score and rank skills by relevance to current context.
  // Include at most 8 skills — enough coverage without overwhelming the prompt.
  const scored = visibleSkills.map((s) => ({
    skill: s,
    relevance: scoreSkillRelevance(s, cwd, projectContext),
  }));
  scored.sort((a, b) => b.relevance - a.relevance);

  const MAX_VISIBLE_SKILLS = 8;
  const topSkills = scored.slice(0, MAX_VISIBLE_SKILLS);

  // Boost related skills: if a high-scoring skill has relations, boost those too
  const topNames = new Set(topSkills.map(({ skill }) => skill.name));
  for (const { skill, relevance } of scored) {
    if (relevance >= 0.3 && SKILL_RELATIONS[skill.name]) {
      for (const related of SKILL_RELATIONS[skill.name]) {
        const idx = scored.findIndex((s) => s.skill.name === related);
        if (idx >= 0 && !topNames.has(related)) {
          scored[idx].relevance = Math.max(scored[idx].relevance, 0.25);
        }
      }
    }
  }
  // Re-sort after boosting
  scored.sort((a, b) => b.relevance - a.relevance);
  const boosted = scored.slice(0, MAX_VISIBLE_SKILLS);
  const hiddenCount = scored.length - boosted.length;

  const lines = [
    "Skills are your first knowledge in context. Read all of the relevant ones with `read` tool before starting any task.",
    "<available_skills>",
  ];

  for (const { skill } of boosted) {
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

  if (hiddenCount > 0) {
    lines.push(
      `*${hiddenCount} more ${hiddenCount === 1 ? "skill is" : "skills are"} available — use \`read\` to load them if needed.*`,
    );
  }

  return lines.join("\n");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function reconstructSkillsSection(
  cwd: string,
  projectContextFileContents: string[],
): Promise<string> {
  const result = loadSkills({
    cwd,
    agentDir: getAgentDir(),
    skillPaths: [SKILLS_DIR],
    includeDefaults: true,
  });
  return formatSkillsWithLineCounts(result.skills, cwd, projectContextFileContents);
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

  // ── resources_discover: Register bundled skills with pi's native discovery ──
  // pi's package manager calls this on all extensions to discover resources (skills, prompts, themes).
  // We register the bundled skills/ directory so pi can auto-discover them.
  onEvent(pi, RESOURCES_DISCOVER, async (_event: { cwd: string; reason: string }, _ctx: any) => {
    return {
      skillPaths: [SKILLS_DIR],
    };
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

    const parts: string[] = [];

    // 1. Custom identity
    parts.push(IDENTITY_INTRO);
    // 1a. Behavioral guardrails (concise, single-sentence, research-backed)
    parts.push(SYCOPHANCY_RESISTANCE);
    parts.push(STAKES_AWARENESS);
    parts.push(EPISTEMIC_STABILITY);
    parts.push(SURGICAL_PRECISION);
    parts.push(BUDGET_AWARENESS);
    // 1b. Compaction survival invariant — scratchpad + tasks must be self-contained
    //     so the agent can recover context after conversation compression
    parts.push(COMPACTION_SURVIVAL);
    // 1c. Living documentation invariant — agent maintains AGENTS.md hierarchy
    //     Walk tree before edit, update docs after change (from DOX — agent0ai/dox)
    parts.push(LIVING_DOCS);

    // 2. Skills
    if (hasRead) {
      const projectContextStrings = await collectProjectContextStrings(cwd);
      const skillsSection = await reconstructSkillsSection(cwd, projectContextStrings);
      if (skillsSection) parts.push(skillsSection);
    }

    // 3. Available tools
    parts.push(reconstructToolsSection(tools));

    // 4. Project context (replaces pi-native loading which prompt-builder overrides)
    const projectContext = await reconstructProjectContextSection(cwd);
    if (projectContext) {
      parts.push(projectContext);
    }

    // 5. Past insights + hints → offloaded to steer whisper (once per session)
    // Avoids per-turn disk I/O and system prompt bloat for supplemental context.
    if (!ps.insightsSent) {
      const pastInsights = await searchPastInsights(cwd);
      const insightsText = formatPastInsightsSection(pastInsights);
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

    // 6. L1 environmental state
    parts.push(formatL1Environment(l1Env));

    // 6b. OpenSpec spec context (inject SHALL/MUST requirements from active specs)
    try {
      const { join } = await import("node:path");
      const { readdirSync, existsSync, readFileSync } = await import("node:fs");
      const specDir = join(cwd, "openspec", "specs");
      if (existsSync(specDir)) {
        const specParts: string[] = [];
        const domains = readdirSync(specDir, { withFileTypes: true });
        let count = 0;
        for (const domain of domains) {
          if (!domain.isDirectory() || count >= 3) continue;
          const specPath = join(specDir, domain.name, "spec.md");
          if (!existsSync(specPath)) continue;
          const content = readFileSync(specPath, "utf-8");
          // Extract only SHALL/MUST/SHOULD requirements
          const reqs: string[] = [];
          for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("### Requirement:") || /\b(SHALL|MUST|SHOULD)\b/.test(trimmed)) {
              reqs.push(trimmed.replace(/^[#\s]+/, ""));
            }
          }
          if (reqs.length > 0) {
            specParts.push(`${domain.name}:\n${reqs.map((r) => `  ${r}`).join("\n")}`);
            count++;
          }
        }
        if (specParts.length > 0) {
          parts.push(
            `## Active Specs\n\n${specParts.join("\n\n")}\n\nWhen editing, check openspec/specs/ for relevant requirements and update delta specs if behavior changes.`,
          );
        }
      }
    } catch {
      // Spec dir missing or unreadable — skip silently
    }

    // 7. Active contrast mode (truthfulness guardrails)
    parts.push(...formatContrastSection(ps.activeContrastMode));

    // 8. Interaction style
    parts.push(INTERACTION_STYLE);

    // P0: Preserve appendSystemPrompt from pi-native
    const appendPrompt = event.systemPromptOptions?.appendSystemPrompt;
    if (appendPrompt && !parts.includes(appendPrompt)) {
      parts.push(appendPrompt);
    }

    // 9. Date and cwd
    parts.push(`Current time: ${new Date().toISOString()}`);
    parts.push(`Current working directory: ${cwd.replace(/\\/g, "/")}`);

    const newPrompt = parts.join("\n\n");
    return { systemPrompt: newPrompt };
  });

  // Prompt preview tool - makes the system prompt observable to the agent
  pi.registerTool(createPromptPreviewTool());
}

export { gatherL1State, formatL1Environment };
