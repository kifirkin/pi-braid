import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "node:os";

/**
 * Prompt Builder - Reconstruction from Structured Data
 *
 * No fragile string extraction. Everything built from APIs and fixed templates.
 * Only pi-braid additions (identity, L1, enforcement) are custom.
 *
 * Sections built from structured data:
 * - Tools: pi.getAllTools() (with promptSnippet)
 * - Skills: loadSkills() + formatSkillsForPrompt()
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
import { formatSkillsForPrompt, loadSkills } from "@mariozechner/pi-coding-agent";
import { SKILLS_DIR } from "../../index.js";
import { gatherL1State, formatL1Environment } from "./l1-environment.js";

// ── Identity (THE key difference from native) ─────────────────────────────────
// Identity framing is the behavioral filter - not directives
const IDENTITY_INTRO = `From now you are Braid, stateful and meticulous expert software architect operating inside a Pi coding agent harness.
Your tools and skills are keys to proper solutions - use and read them much enought to access your full capability.
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
const EPISTEMIC_STABILITY = `Uncertainty signaled early beats confidence delivered wrong.`;

// ── Interaction Style (single declarative sentence) ───────────────────────
const INTERACTION_STYLE = `Provide concise, production-quality solutions. Focus on correctness over verbosity.`;

// ── Implicit Norms (identity-aligned, no directives) ──────────────────────
const IMPLICIT_NORMS = `

Every action is permanent. No drafts, no quick tests.

One artifact, correct, self-contained. Check: does it already exist? Delete old before creating new.

Self-correction before the mistake, not apology after.

You are the filter, not the echo. Code smell and slop get rejected on sight.

High-stakes actions deserve a 3-second pause. Drift is invisible — check your trajectory against your identity.
`;

// ── L1: Enforcement Signal Surfacing ────────────────────────────────────────
let _enforcementSignals: Record<string, { turn: number; text: string; acted: boolean }> = {};
let _lastSignalTurn = 0;

function formatEnforcementL1(signals: Record<string, { turn: number; text: string; acted: boolean }>): string {
  const keys = Object.keys(signals);
  if (keys.length === 0) return "";

  const signalEntries: Record<string, unknown> = {};
  for (const key of keys) {
    const s = signals[key];
    if (_lastSignalTurn - s.turn > 5) continue;
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

function searchPastInsights(cwd: string): PastInsight[] {
	const insights: PastInsight[] = [];

	// Search three-memory-stores episodes
	const memoryDir = join(homedir(), ".pi/logs/memory");
	if (existsSync(memoryDir)) {
		try {
			const episodeFiles = readdirSync(memoryDir).filter((f) => f.startsWith("episodes"));
			for (const file of episodeFiles.slice(0, 3)) {
				const content = readFileSync(join(memoryDir, file), "utf-8");
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
				const content = readFileSync(join(sessionDir, session), "utf-8");
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
  return `Available tools:
${visibleTools || "(none)"}

In addition to the tools above, you may have access to other custom_tools depending on the project.`;
}

function reconstructGuidelineSection(_hasBash: boolean, _hasGrep: boolean, _hasFind: boolean, _hasLs: boolean): string {
  // No directive guidelines - tool usage is self-documenting from tool names/descriptions
  // Behaviors are guided by identity framing, not explicit rules
  return "";
}

function reconstructProjectContextSection(cwd: string): string {
  // Re-implemented from loadProjectContextFiles (not exported from pi)
  // Searches for AGENTS.md or CLAUDE.md in cwd and ancestors
  // NOTE: pi's native loading is overridden by prompt-builder, so we must replicate here

  const contextFiles: Array<{ path: string; content: string }> = [];
  const seenPaths = new Set<string>();

  function loadContextFromDir(dir: string): { path: string; content: string } | null {
    const candidates = ["AGENTS.md", "CLAUDE.md"];
    for (const filename of candidates) {
      const filePath = join(dir, filename);
      if (existsSync(filePath)) {
        try {
          return {
            path: filePath,
            content: readFileSync(filePath, "utf-8"),
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
  const globalContext = loadContextFromDir(agentDir);
  if (globalContext) {
    contextFiles.push(globalContext);
    seenPaths.add(globalContext.path);
  }

  // Ancestor context files (from cwd up to root)
  const root = join("/");
  let currentDir = cwd;

  while (true) {
    const contextFile = loadContextFromDir(currentDir);
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

function reconstructSkillsSection(cwd: string): string {
  const result = loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [SKILLS_DIR], includeDefaults: true });
  return formatSkillsForPrompt(result.skills);
}

// ── Main Extension ───────────────────────────────────────────────────────────

export default function promptBuilderExtension(_pi: ExtensionAPI) {
  // L1 state is now gathered per-request, not global
  // Enforcement signals handled in before_agent_start

  _pi.on("before_agent_start", async (event, ctx) => {
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
    const projectContext = reconstructProjectContextSection(cwd);
    if (projectContext) {
      parts.push(projectContext);
    }

    // 5. Skills
    if (hasRead) {
      const skillsSection = reconstructSkillsSection(cwd);
      if (skillsSection) {
        parts.push(skillsSection);
      }
    }

    // R6: Proactive recall - inject past insights (only if relevance >= 0.7)
    const pastInsights = searchPastInsights(cwd);
    const pastInsightsSection = formatPastInsightsSection(pastInsights);
    if (pastInsightsSection) {
      parts.push(pastInsightsSection);
    }

    // 6. L1 environmental state
    parts.push(formatL1Environment(l1Env));

    // 7. Enforcement signals
    const enforcement = formatEnforcementL1(_enforcementSignals);
    if (enforcement) {
      parts.push(enforcement);
    }

    // 7a. Stakes awareness (research-backed counter to implicit bias)
    parts.push(STAKES_AWARENESS);

    // 8. Implicit norms (identity-aligned)
    parts.push(IMPLICIT_NORMS);

    // 8a. Epistemic stability (research-backed self-monitoring)
    parts.push(EPISTEMIC_STABILITY);

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
}
