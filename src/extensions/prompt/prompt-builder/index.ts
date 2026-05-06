import { existsSync, readdirSync } from "node:fs";
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
 * - Removed 7 sections (SYCOPHANCY_RESISTANCE, STAKES_AWARENESS, IMPLICIT_NORMS,
 *   TOOL_TRUST, format guidance, RepE jargon header, all-modes listing)
 * - Truncated tool descriptions to first line only
 */

import { join } from "node:path";
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
}

async function searchPastInsights(cwd: string): Promise<PastInsight[]> {
  const insights: PastInsight[] = [];

  // Search three-memory-stores episodes
  const memoryDir = join(homedir(), ".pi/agent/memory");
  if (existsSync(memoryDir)) {
    try {
      const episodeFiles = readdirSync(memoryDir).filter((f) => f.startsWith("episodes"));
      for (const file of episodeFiles.slice(0, 3)) {
        const content = await readFile(join(memoryDir, file), "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        for (const line of lines.slice(-5)) {
          try {
            const ep = JSON.parse(line);
            if (ep.task && ep.outcome) {
              insights.push({
                type: "episode",
                relevance: 0.75,
                content: `[${ep.outcome}] ${ep.task}: ${ep.solution || "(see logs)"}`,
                source: `episodes:${ep.id}`,
              });
            }
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

// ── Reconstruction Functions (from structured data, not text parsing) ─────────

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

/** Extract first sentence from a tool description. */
function firstSentence(text: string): string {
  // Find the first period followed by a space and uppercase letter (second sentence boundary)
  const end = text.search(/\.\s+[A-Z"`(]/);
  if (end === -1) {
    // Single sentence: ensure it ends with a period
    return text.endsWith(".") ? text : text + ".";
  }
  return text.slice(0, end + 1).trim();
}

function reconstructToolsSection(tools: ReturnType<ExtensionAPI["getAllTools"]>): string {
  // pi-native uses promptSnippet (short curated description) from each tool definition.
  // Only tools with a snippet appear in the listing. Fall back to full description.
  const toolNames = tools.map((t) => t.name);
  const visibleTools = tools
    .filter((t) => t.name && (t.description || KNOWN_SNIPPETS[t.name]))
    .map((t) => `- ${t.name}: ${KNOWN_SNIPPETS[t.name] ?? firstSentence(t.description)}`)
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
    addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
  }

  // Tool-specific promptGuidelines - only for tools known to define them.
  // These replicate what pi-native collects via _toolPromptGuidelines.get(name).
  for (const name of toolNames) {
    const toolGuidelines = PROMPT_GUIDELINES[name as keyof typeof PROMPT_GUIDELINES];
    if (toolGuidelines) {
      for (const g of toolGuidelines) {
        addGuideline(g);
      }
    }
  }

  // Always-included guidelines (pi-native)
  addGuideline("Be concise in your responses");
  addGuideline("Show file paths clearly when working with files");
  // Research backing: Bakhshi (2026) arXiv:2604.19768 - LLMs exhibit systematic epistemic-rhetorical patterns at ~2x human rate
  addGuideline("Write text that reads naturally, as if written by a human, not generated by a machine");

  const toolGuidelines =
    guidelines.length > 0 ? "\n\n" + guidelines.join("\n") : "";

  return `Available tools:\n${visibleTools || "(none)"}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.${toolGuidelines}`;
}

// Known promptGuidelines for pi-native core tools (from their tool definitions).
const PROMPT_GUIDELINES: Record<string, string[]> = {
  read: ["Use read to examine files instead of cat or sed"],
  edit: [
    "Use edit for precise changes (edits[].oldText must match exactly)",
    "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
    "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
    "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
  ],
  write: ["Use write only for new files or complete rewrites"],
};

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
 * Enhanced skill formatter that adds file metadata (line count, section preview)
 * so the agent knows the scope of each skill before reading it.
 *
 * This augments the native formatSkillsForPrompt with structural awareness
 * - the agent knows "this is a 200-line file with sections X, Y, Z"
 * and can decide whether to read it fully or target specific sections.
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

async function formatSkillsWithLineCounts(skills: Skill[]): Promise<string> {
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
  if (visibleSkills.length === 0) {
    return "";
  }

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];

  for (const skill of visibleSkills) {
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
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function reconstructSkillsSection(cwd: string): Promise<string> {
  const result = loadSkills({
    cwd,
    agentDir: getAgentDir(),
    skillPaths: [SKILLS_DIR],
    includeDefaults: true,
  });
  return formatSkillsWithLineCounts(result.skills);
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

    // 2. Available tools
    parts.push(reconstructToolsSection(tools));

    // 3. Project context (replaces pi-native loading which prompt-builder overrides)
    const projectContext = await reconstructProjectContextSection(cwd);
    if (projectContext) {
      parts.push(projectContext);
    }

    // 4. Skills
    if (hasRead) {
      const skillsSection = await reconstructSkillsSection(cwd);
      if (skillsSection) parts.push(skillsSection);
    }

    // 5. Past insights (compressed: skip empty outcome summaries)
    const pastInsights = await searchPastInsights(cwd);
    const pastInsightsSection = formatPastInsightsSection(pastInsights);
    if (pastInsightsSection) parts.push(pastInsightsSection);

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
