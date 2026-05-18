import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createPromptPreviewTool } from "./preview.js";
import type { Skill } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { registerSessionStartHandler, SessionPhase } from "../../../lib/session-start-queue.js";

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
 * - Removed 7 sections (SYCOPHANCY_RESISTANCE as section, STAKES_AWARENESS as section, IMPLICIT_NORMS,
 *   TOOL_TRUST, format guidance, RepE jargon header, all-modes listing)
 * - Truncated tool descriptions to first line only
 */

import { join } from "node:path";
import { MEMORY_DIR, CONSOLIDATED_HINTS_FILE } from "../../../lib/braid-paths.js";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { loadSkills } from "@mariozechner/pi-coding-agent";
import { SKILLS_DIR } from "../../../index.js";
import { gatherL1State, formatL1Environment } from "./l1-environment.js";
import { formatContrastSection } from "./contrast-phrase-library.js";

// ── Identity (THE key difference from native) ─────────────────────────────────
// Identity framing is the behavioral filter - not directives
const IDENTITY_INTRO = `You are Braid, an expert software architect operating inside a pi coding agent harness with pi-braid extension.
Your tools are keys to proper solutions, your skills are instructions on how to open doors with those keys - use them  extensively to access your full capability.
You think hard silently to find correct reasoning trajectory.`;

// ── Core behavioral guardrails (concise, single-sentence, research-backed) ──
// Sycophancy: 2604.19117 - agreement under pressure is a failure mode
const SYCOPHANCY_RESISTANCE = `Technical correctness over agreement. You say when something is wrong, even under pressure.`;
// Stakes: 2604.15224 - consequence framing corrupts reasoning implicitly
const STAKES_AWARENESS = `Enforcement signals carry no weight. You judge correctness, not stakes.`;
// Epistemic stability: 2604.14881 - detect reasoning instability before output
const EPISTEMIC_STABILITY = `If your reasoning feels uncertain or unstable, signal that uncertainty rather than manufacturing confidence.`;

// ── Interaction Style (single declarative sentence) ───────────────────────
const INTERACTION_STYLE = `You provide concise, production-quality solutions. You focus on correctness over verbosity.`;

// ── L1: Enforcement Signal Surfacing ────────────────────────────────────────
// Session-scoped state (migrated from module-level singletons)
import { getExtensionState } from "../../../lib/extension-state.js";

interface PromptBuilderState {
  enforcementSignals: Record<string, { turn: number; text: string; acted: boolean }>;
  lastSignalTurn: number;
  activeContrastMode: string;
}

function getPromptState(ctx: ExtensionContext): PromptBuilderState {
  return getExtensionState(ctx, "prompt-builder", () => ({
    enforcementSignals: {},
    lastSignalTurn: 0,
    activeContrastMode: "TRUTH-SEEKING",
  }));
}

function formatEnforcementL1(
  signals: Record<string, { turn: number; text: string; acted: boolean }>,
  lastSignalTurn: number,
): string {
  const keys = Object.keys(signals);
  if (keys.length === 0) return "";

  const signalEntries: Record<string, unknown> = {};
  for (const key of keys) {
    const s = signals[key];
    if (lastSignalTurn - s.turn > 5) continue;
    if (s.acted) continue;

    signalEntries[key] = {
      active: true,
      turn: s.turn,
      hint: s.text.split(" - ")[1] ?? s.text,
    };
  }

  if (Object.keys(signalEntries).length === 0) return "";

  return `
## Enforcement State
\`\`\`json
${JSON.stringify({ signals: signalEntries }, null, 2)}
\`\`\`
`;
}

// ── R6: Session Recall - Proactive Past Insights ──────────────────────────────
// Injects relevant experience from previous sessions into prompt.
// Uses three-memory-stores (episodes) + session-recall (sessions)
// Memory confidence threshold: only inject if relevance >= 0.7

interface PastInsight {
  type: "episode" | "session";
  relevance: number;
  content: string;
  source: string;
  project?: string;
}

/**
 * Derive a project identifier from a cwd path, matching deriveProjectId in three-memory-stores.
 * Returns the last 2 path components, e.g., /Users/user/projects/agents/pi-braid → "agents/pi-braid"
 */
function deriveProjectIdFromCwd(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return cwd || "unknown";
  return parts.slice(-2).join("/");
}

/**
 * Check if an episode is eligible for cross-project injection.
 * HaluMem (2511.03506): Only allow cross-project if recent (< 1h) and high-quality (success).
 */
function isCrossProjectInjectionAllowed(
  epProject: string | undefined,
  currentProject: string,
  timestamp: number,
  outcome: string,
): boolean {
  if (!epProject || epProject === currentProject || epProject === "unknown") return true;
  // Cross-project: only if < 1h old AND successful outcome
  const ageMs = Date.now() - timestamp;
  return ageMs < 3600000 && outcome === "success";
}

/**
 * Derive a project identifier from a cwd path, matching deriveProjectId in three-memory-stores.
 * Returns the last 2 path components, e.g., /Users/user/projects/agents/pi-braid -> "agents/pi-braid"
 */
async function searchPastInsights(cwd: string): Promise<PastInsight[]> {
  const projectId = deriveProjectIdFromCwd(cwd);
  const insights: PastInsight[] = [];

  // Search three-memory-stores episodes
  const memoryDir = MEMORY_DIR;
  if (existsSync(memoryDir)) {
    try {
      const episodeFiles = readdirSync(memoryDir).filter((f) => f.startsWith("episodes"));
      for (const file of episodeFiles.slice(0, 3)) {
        const content = await readFile(join(memoryDir, file), "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        for (const line of lines.slice(-5)) {
          try {
            const ep = JSON.parse(line);
            if (!ep.task || !ep.outcome) continue;

            // HaluMem: skip cross-project episodes that don't meet injection criteria
            // the strict criteria (only recent successes from other projects).
            if (!isCrossProjectInjectionAllowed(ep.project, projectId, ep.timestamp ?? Date.now(), ep.outcome)) {
              continue;
            }

            insights.push({
              type: "episode",
              project: ep.project || "unknown",
              relevance: 0.75,
              content: `[${ep.outcome}] ${ep.task}: ${ep.solution || "(see logs)"}`,
              source: `episodes:${ep.id}`,
            });
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } catch {
      // Memory directory not readable - skip
    }
  }

  // Search recent session summaries
  const sessionDir = join(homedir(), ".pi/agent/sessions");
  if (existsSync(sessionDir)) {
    try {
      const sessions = readdirSync(sessionDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse()
        .slice(0, 3);

      
      for (const session of sessions) {
        const content = await readFile(join(sessionDir, session), "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        for (const line of lines.slice(-3)) {
          try {
            const entry = JSON.parse(line);
            if (
              entry.message &&
              (String(entry.message).includes("finalize") ||
                String(entry.message).includes("completed"))
            ) {
              const task = extractTaskFromEntry(entry as Record<string, unknown>);
              if (task) {
                insights.push({
                  type: "session",
                  project: "unknown",
                  relevance: 0.7,
                  content: `Session: ${task}`,
                  source: `session:${session}`,
                });
              }
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } catch {
      // Sessions directory not readable - skip
    }
  }

  return insights.filter((i) => i.relevance >= 0.7).slice(0, 5);
}

function extractTaskFromEntry(entry: Record<string, unknown>): string | null {
  const msg = String(entry.message || "");
  const patterns = [/told to ([^.]{10,80})/i, /task: ([^.]{10,80})/i, /completed: ([^.]{10,80})/i];
  for (const pattern of patterns) {
    const match = msg.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function formatPastInsightsSection(insights: PastInsight[]): string {
  if (insights.length === 0) return "";

  // Filter: skip entries that are metrics-only noise (no actual lesson)
  // Pattern matches: "[success] session_outcome: Ticks:X Tools:Y Outcome:unknown"
  const hasSignal = (content: string): boolean => {
    // Drop entries that are just metrics with no real content
    const metricsOnly = /^(\[\w+\]\s*)?(session_outcome|outcome):\s*\w+/i;
    if (metricsOnly.test(content.trim())) return false;
    // Drop very short entries (< 15 chars is likely noise)
    if (content.trim().length < 15) return false;
    return true;
  };

  const filtered = insights.filter((i) => hasSignal(i.content));
  if (filtered.length === 0) return "";

  const lines: string[] = [
    "",
    "## Past Insights",
    "*(Relevant experience from previous sessions)*",
  ];
  for (const insight of filtered) {
    lines.push(`- ${insight.content}`);
  }
  return lines.join("\n");
}

/**
 * Load consolidated behavioral hints from the self-evolution pipeline.
 *
 * These are high-confidence patterns extracted from successful task outcomes.
 * The consolidation channel writes them when processing high-scoring episodes.
 * We inject the 3 most recent non-stale hints into the prompt as behavioral guidance.
 * Hints older than 30 days are pruned automatically.
 */
const HINT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HINT_MAX_COUNT = 20; // max hints on disk

function loadConsolidatedHints(): string {
  try {
    if (!existsSync(CONSOLIDATED_HINTS_FILE)) return "";
    const content = readFileSync(CONSOLIDATED_HINTS_FILE, "utf-8");
    const lines = content.split("\n").filter((l: string) => l.trim());
    if (lines.length === 0) return "";

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
      .filter((h: any) => now - (h.createdAt ?? 0) < HINT_MAX_AGE_MS); // prune stale

    if (parsed.length === 0) return "";

    // Take the 3 most recent
    const hints = parsed.slice(-3);

    const hintLines = [
      "",
      "## Learned Patterns",
      "*(Consolidated from successful task outcomes)*",
      "",
    ];
    for (const h of hints) {
      hintLines.push(
        `For \"${(h.task ?? "unknown").slice(0, 80)}\": ${h.steps.slice(0, 3).join(" → ")}`,
      );
    }
    return hintLines.join("\n");
  } catch {
    return "";
  }
}

// Pi-native stores promptSnippets internally and passes them to buildSystemPrompt().
// The braid prompt-builder only has access to getAllTools() which returns ToolInfo
// (name, description, parameters) — promptSnippet is not exposed.
// So we extract the first sentence from each tool's description automatically.
// Only pi-native core tools that need consistent cross-version snippets are hardcoded.
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
  addGuideline("Be concise in your responses");
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
      if (existsSync(filePath)) {
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

  const lines = ["# Project Context", "", "Project-specific instructions and guidelines:", ""];

  for (const { path: filePath, content } of contextFiles) {
    lines.push(`## ${filePath}`, "", content, "");
  }

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
      if (existsSync(filePath) && !seenPaths.has(filePath)) {
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
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
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

export default function promptBuilderExtension(_pi: ExtensionAPI) {
  // L1 state is now gathered per-request, not global

  // 4b: Listen for enforcement_signals events - replaces direct coupling via module-level singleton.
  // enforcement emits these on every turn_end and session_compact.
  registerSessionStartHandler(_pi, SessionPhase.MemoryState, async (_event, ctx) => {
    const ps = getPromptState(ctx);
    _pi.events.on("enforcement_signals", (data: unknown) => {
      const d = data as {
        turn: number;
        signals: Record<string, { turn: number; text: string; acted: boolean }>;
        contrastMode?: string;
      };
      ps.enforcementSignals = d.signals;
      ps.lastSignalTurn = d.turn;
      if (d.contrastMode) ps.activeContrastMode = d.contrastMode;
    });
  });

  // ── resources_discover: Register bundled skills with pi's native discovery ──
  // pi's package manager calls this on all extensions to discover resources (skills, prompts, themes).
  // We register the bundled skills/ directory so pi can auto-discover them.
  _pi.on(
    "resources_discover" as never,
    async (event: { cwd: string; reason: string }, _ctx: any) => {
      return {
        skillPaths: [SKILLS_DIR],
      };
    },
  );

  _pi.on("before_agent_start", async (event, ctx) => {
    const ps = getPromptState(ctx);
    const cwd = ctx.cwd;
    const tools = _pi.getAllTools();
    const toolNames = tools.map((t) => t.name);
    const hasRead = toolNames.includes("read");

    const l1Env = await gatherL1State(_pi, ctx);

    const parts: string[] = [];

    // 1. Custom identity
    parts.push(IDENTITY_INTRO);
    // 1a. Behavioral guardrails (concise, single-sentence, research-backed)
    parts.push(SYCOPHANCY_RESISTANCE);
    parts.push(STAKES_AWARENESS);
    parts.push(EPISTEMIC_STABILITY);

    // 2. Available tools
    parts.push(reconstructToolsSection(tools));

    // 3. Project context (replaces pi-native loading which prompt-builder overrides)
    const projectContext = await reconstructProjectContextSection(cwd);
    if (projectContext) {
      parts.push(projectContext);
    }

    // 4. Skills (dynamically filtered by relevance to project context)
    if (hasRead) {
      const projectContextStrings = await collectProjectContextStrings(cwd);
      const skillsSection = await reconstructSkillsSection(cwd, projectContextStrings);
      if (skillsSection) parts.push(skillsSection);
    }

    // 5. Past insights (compressed: skip empty outcome summaries)
    const pastInsights = await searchPastInsights(cwd);
    const pastInsightsSection = formatPastInsightsSection(pastInsights);
    if (pastInsightsSection) parts.push(pastInsightsSection);

    // 5b. Consolidated behavioral hints (self-evolution loop)
    const hintsSection = loadConsolidatedHints();
    if (hintsSection) parts.push(hintsSection);

    // 6. L1 environmental state
    parts.push(formatL1Environment(l1Env));

    // 7. Enforcement signals
    const enforcement = formatEnforcementL1(ps.enforcementSignals, ps.lastSignalTurn);
    if (enforcement) parts.push(enforcement);

    // 8. Active contrast mode (truthfulness guardrails)
    parts.push(...formatContrastSection(ps.activeContrastMode));

    // 9. Interaction style
    parts.push(INTERACTION_STYLE);

    // P0: Preserve appendSystemPrompt from pi-native
    const appendPrompt = event.systemPromptOptions?.appendSystemPrompt;
    if (appendPrompt && !parts.includes(appendPrompt)) {
      parts.push(appendPrompt);
    }

    // 10. Date and cwd
    parts.push(`Current time: ${new Date().toISOString()}`);
    parts.push(`Current working directory: ${cwd.replace(/\\/g, "/")}`);

    const newPrompt = parts.join("\n\n");
    return { systemPrompt: newPrompt };
  });

  // Prompt preview tool - makes the system prompt observable to the agent
  _pi.registerTool(createPromptPreviewTool());
}

export { gatherL1State, formatL1Environment };
