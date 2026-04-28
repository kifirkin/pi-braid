import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createPromptPreviewTool } from "./preview.js";
import type { Skill } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";

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
 * - Added drift self-audit to IMPLICIT_NORMS (2604.14717)
 */

import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { loadSkills } from "@mariozechner/pi-coding-agent";
import { SKILLS_DIR } from "../../../index.js";
import { gatherL1State, formatL1Environment } from "./l1-environment.js";
import { loadScratchpadFromDisk, projectSlugFromCwd, formatScratchpad } from "../../core/scratchpad/index.js";

// ── Identity (THE key difference from native) ─────────────────────────────────
// Identity framing is the behavioral filter - not directives
const IDENTITY_INTRO = `From now you are Braid, stateful and meticulous expert software architect operating inside a Pi coding agent harness.
Your tools and skills are keys to proper solutions - use tools and skills much enought to access your full capability.
When facing complex, multi-step, or ambiguous tasks, think and plan, hypothesize and explore paths for multi-hypothesis analysis, recall memory for similar past solutions.
Finalize to mark task completion.`;

// ── Sycophancy Resistance ───────────────────────────────────────────────────
// Research: 2604.19117 — same attention heads drive sycophancy and lying.
// Agreement under pressure is a failure mode, not politeness.
const SYCOPHANCY_RESISTANCE = `Technical correctness over agreement. You say when something is wrong, even under pressure.`;

// ── Stakes Awareness ────────────────────────────────────────────────────────
// Research: 2604.15224 — stakes signaling corrupts reasoning implicitly.
// Enforcement signals carry no consequences. Judge correctness, not stakes.
const STAKES_AWARENESS = `Enforcement signals carry no consequences. Judge correctness, not stakes.`;

// ── Epistemic Stability ─────────────────────────────────────────────────────
// Research: 2604.14881 — Epistemic Control Loop. Detect instability → modulate.
// Extended with contrast principles from RepE (2310.01405)
const EPISTEMIC_STABILITY = `Uncertainty signaled early beats confidence delivered wrong.

Confidence calibration: Only express high confidence when you have strong evidence. Low confidence signals are not weakness but accuracy awareness. When estimating uncertainty, err on the side of caution.`;

// ── RepE Contrast Vectors (Text-Space Approximation) ────────────────────────
// Research: 2310.01405 — Representation Engineering. Honesty is linear in residual stream.
// Text-level approximation: phrases activate same circuits as contrast vector injection.
// Truth-first: suppress agreeableness circuit
const CONTRAST_TRUTH_FIRST = `Your primary obligation is TRUTHFULNESS, not agreeableness. If you are uncertain, say so. Do not invent answers to appear helpful. It is better to admit uncertainty than to provide a confident wrong answer.`;

// Anti-sycophancy: suppress preference-following circuit
const CONTRAST_ANTI_SYCOPHANCY = `State what you believe to be correct, even if it contradicts the user's stated preference or belief. Your role is to provide accurate analysis, not to agree with the user.`;

// Knowledge boundary: activate self-knowledge circuit
const CONTRAST_KNOWLEDGE_BOUNDARY = `Distinguish clearly between what you KNOW and what you INFER. State your knowledge boundaries explicitly before offering solutions. Say 'I don't know' when the information is not in your training data or cannot be derived from the available context.`;

// ── Interaction Style (single declarative sentence) ───────────────────────
const INTERACTION_STYLE = `Provide concise, production-quality solutions. Focus on correctness over verbosity.`;

// ── Tool Trust (empirical — based on benchmark data) ──────────────────────
// bash tools fail non-deterministically (sed -i cross-platform, redirect truncation);
// edit/write are exact-match and verifiable. Agent mistakes >> tool bugs.
const TOOL_TRUST = `
// Tool reliability — empirical basis

The \`edit\` and \`write\` tools work reliably. They WILL modify files exactly as instructed.
When a tool call fails, the failure is almost always an agent mistake — wrong line numbers,
stale file content, incorrect indentation — not a tool malfunction. Re-read the file and retry.

For file operations, \`edit\` and \`write\` are the default. Bash is for shell operations
(piping, glob expansion, running tests and builds, navigating directories).
Do not use \`sed\`, \`echo\`, \`cat\`, or shell redirects for file content modification.
These are unreliable and non-portable.

Non-negotiable: if you find yourself reaching for \`sed -i\` or \`echo ... > file\`,
stop. Use \`edit\` or \`write\` instead. They are always available and always work.`;

// ── Implicit Norms (identity-aligned, no directives) ──────────────────────
const IMPLICIT_NORMS = `

Every action is permanent. No drafts, no quick tests.

One artifact, correct, self-contained. Check: does it already exist? Delete old before creating new.

Self-correction before the mistake, not apology after.

You are the filter, not the echo. Code smell and slop get rejected on sight.

High-stakes actions deserve a 3-second pause. Drift is invisible — check your trajectory against your identity.
`;

// ── L1: Enforcement Signal Surfacing ────────────────────────────────────────
// Session-scoped state (migrated from module-level singletons)
import { getExtensionState } from "../../../lib/extension-state.js";

interface PromptBuilderState {
	enforcementSignals: Record<string, { turn: number; text: string; acted: boolean }>;
	lastSignalTurn: number;
}

function getPromptState(ctx: ExtensionContext): PromptBuilderState {
	return getExtensionState(ctx, "prompt-builder", () => ({
		enforcementSignals: {},
		lastSignalTurn: 0,
	}));
}

function formatEnforcementL1(signals: Record<string, { turn: number; text: string; acted: boolean }>, lastSignalTurn: number): string {
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
\`\`\``;
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
						if (entry.message && (String(entry.message).includes("finalize") || String(entry.message).includes("completed"))) {
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
	const patterns = [
		/told to ([^.]{10,80})/i,
		/task: ([^.]{10,80})/i,
		/completed: ([^.]{10,80})/i,
	];
	for (const pattern of patterns) {
		const match = msg.match(pattern);
		if (match) return match[1].trim();
	}
	return null;
}

function formatPastInsightsSection(insights: PastInsight[]): string {
	if (insights.length === 0) return "";
	const lines: string[] = [
		"",
		"## Past Insights",
		"*(Relevant experience from previous sessions)*",
	];
	for (const insight of insights) {
		lines.push(`- ${insight.content}`);
	}
	return lines.join("\n");
}

// ── Reconstruction Functions (from structured data, not text parsing) ─────────

function reconstructToolsSection(tools: ReturnType<ExtensionAPI["getAllTools"]>): string {
  const visibleTools = tools.map(t => `- ${t.name}: ${t.description}`).join("\n");

  // Structured output instruction (MDA: repetitive format catalyzes ICL circuits)
  const structuredOutput = `

## Output Format

Tool results and code should use structured, delimited format to catalyze induction head circuits (MDA 2601.21996):

For tool results, use:
\`\`\`
TOOL_RESULT:
TOOL: [tool-name]
ACTION: [what was done]
STATUS: success | error | partial
DATA:
  [KEY]: [value]
RESULT: [summary]
---
\`\`\`

For code blocks, use consistent formatting:
\`\`\`[language]
[code]
\`\`\`

This structured format with consistent delimiters helps activate in-context learning circuits.`;

  return `Available tools:
${visibleTools || "(none)"}

In addition to the tools above, you may have access to other custom_tools depending on the project.${structuredOutput}`;
}

function reconstructGuidelineSection(_hasBash: boolean, _hasGrep: boolean, _hasFind: boolean, _hasLs: boolean): string {
  // No directive guidelines - tool usage is self-documenting from tool names/descriptions
  // Behaviors are guided by identity framing, not explicit rules
  return "";
}

async function reconstructProjectContextSection(cwd: string): Promise<string> {
  // Re-implemented from loadProjectContextFiles (not exported from pi)
  // Searches for AGENTS.md or CLAUDE.md in cwd and ancestors
  // NOTE: pi's native loading is overridden by prompt-builder, so we must replicate here

  const contextFiles: Array<{ path: string; content: string }> = [];
  const seenPaths = new Set<string>();

  async function loadContextFromDir(dir: string): Promise<{ path: string; content: string } | null> {
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
 * — the agent knows "this is a 200-line file with sections X, Y, Z"
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
  const result = loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [SKILLS_DIR], includeDefaults: true });
  return formatSkillsWithLineCounts(result.skills);
}

// ── Main Extension ───────────────────────────────────────────────────────────

export default function promptBuilderExtension(_pi: ExtensionAPI) {
  // L1 state is now gathered per-request, not global

  // 4b: Listen for enforcement_signals events — replaces direct coupling via module-level singleton.
  // enforcement emits these on every turn_end and session_compact.
  _pi.on("session_start", async (_event, ctx) => {
    const ps = getPromptState(ctx);
    _pi.events.on("enforcement_signals", (data: unknown) => {
      const d = data as { turn: number; signals: Record<string, { turn: number; text: string; acted: boolean }> };
      ps.enforcementSignals = d.signals;
      ps.lastSignalTurn = d.turn;
    });
  });

  _pi.on("before_agent_start", async (event, ctx) => {
    const ps = getPromptState(ctx);
    const cwd = ctx.cwd;
    const _userPrompt = event.prompt;

    const tools = _pi.getAllTools();
    const toolNames = tools.map(t => t.name);
    const hasBash = toolNames.includes("bash");
    const hasGrep = toolNames.includes("grep");
    const hasFind = toolNames.includes("find");
    const hasLs = toolNames.includes("ls");
    const hasRead = toolNames.includes("read");

    const l1Env = await gatherL1State(_pi, ctx);

    const parts: string[] = [];

    // 1. Custom identity
    parts.push(IDENTITY_INTRO);

    // 1a. Sycophancy resistance (research-backed behavioral filter)
    parts.push(SYCOPHANCY_RESISTANCE);

    // 2. Available tools
    parts.push(reconstructToolsSection(tools));

    // 3. Guidelines (empty - removed directives)
    parts.push(reconstructGuidelineSection(hasBash, hasGrep, hasFind, hasLs));

    // 4. Project context (from file loading - required since pi's native loading is overridden)
    const projectContext = await reconstructProjectContextSection(cwd);
    if (projectContext) {
      parts.push(projectContext);
    }

    // 5. Skills
    if (hasRead) {
      const skillsSection = await reconstructSkillsSection(cwd);
      if (skillsSection) {
        parts.push(skillsSection);
      }
    }

    // R6: Proactive recall - inject past insights (only if relevance >= 0.7)
    const pastInsights = await searchPastInsights(cwd);
    const pastInsightsSection = formatPastInsightsSection(pastInsights);
    if (pastInsightsSection) {
      parts.push(pastInsightsSection);
    }

    // SESSION STATE (survives compaction): load scratchpad from disk to ensure
    // goal/plan/decisions are always available regardless of compaction history.
    // This is critical for weekly-long sessions where compaction can lose task context.
    try {
      const slug = projectSlugFromCwd(cwd);
      const pad = await loadScratchpadFromDisk(slug);
      if (pad && (pad.goal || pad.plan.length > 0)) {
        parts.push("## Session State");
        parts.push(formatScratchpad(pad));
      }
    } catch {
      // Non-fatal — scratchpad may not exist yet
    }

    // 6. L1 environmental state
    parts.push(formatL1Environment(l1Env));

    // 7. Enforcement signals
    const enforcement = formatEnforcementL1(ps.enforcementSignals, ps.lastSignalTurn);
    if (enforcement) {
      parts.push(enforcement);
    }

    // 7a. Stakes awareness (research-backed counter to implicit bias)
    parts.push(STAKES_AWARENESS);

    // 8. Implicit norms (identity-aligned)
    parts.push(IMPLICIT_NORMS);

    // 8. Tool trust (empirical — prevent bash hack anti-pattern)
    parts.push(TOOL_TRUST);

    // 8a. Epistemic stability (research-backed self-monitoring)
    parts.push(EPISTEMIC_STABILITY);

    // 8b. RepE contrast vectors (text-space approximation of activation injection)
    parts.push("// Truthfulness over agreeableness — RepE contrast vector");
    parts.push(CONTRAST_TRUTH_FIRST);
    parts.push("// Anti-sycophancy: objective analysis — RepE contrast vector");
    parts.push(CONTRAST_ANTI_SYCOPHANCY);
    parts.push("// Self-knowledge: know your boundaries — RepE contrast vector");
    parts.push(CONTRAST_KNOWLEDGE_BOUNDARY);

    // 9. Interaction style (single declarative sentence)
    parts.push(INTERACTION_STYLE);

    // 10. Date and cwd
    const date = new Date().toISOString();
    const promptCwd = cwd.replace(/\\/g, "/");
    parts.push(`Current time: ${date}`);
    parts.push(`Current working directory: ${promptCwd}`);

    const newPrompt = parts.join("\n\n");
    return { systemPrompt: newPrompt };
  });

  // Prompt preview tool — makes the system prompt observable to the agent
  _pi.registerTool(createPromptPreviewTool());
}

// Re-exports for preview.ts (and other internal tools)
export * from "./constants.js";
export { gatherL1State, formatL1Environment };
