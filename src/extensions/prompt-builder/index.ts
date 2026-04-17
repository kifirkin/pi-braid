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
 * - Docs guidance: minimal reference to L1-discovered paths
 * - Date/Cwd: computed directly
 *
 * Sections re-implemented locally:
 * - Project context: loads AGENTS.md/CLAUDE.md files
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { formatSkillsForPrompt, loadSkills } from "@mariozechner/pi-coding-agent";
import { SKILLS_DIR } from "../../index.js";
import { gatherL1State, formatL1Environment } from "./l1-environment.js";

// ── Thinking guidance (moved from reasoning extension) ──────────────────────
const THINK_SILENTLY = `
## Thinking

Think silently. Find the correct trajectory. Not the first plausible path.
`;

const VERIFICATION_REMINDER = `
## Before claiming done

Provide honest proofs and then finalize.
`;

// ── Implicit Budget (Harness Engineering - 83.8% token reduction) ─────────────
// Research: Batch Prompting (2511.04108), BCR (2604.02322)
// Live test: 83.8% token reduction without quality loss
const IMPLICIT_BUDGET = `
## Efficiency

Your tools are knowledge decompressors - they expand your capabilities beyond pure text generation.

Provide concise, production-quality solutions. Focus on correct, efficient code over verbose explanations.
When code is self-documenting, prefer it to comments.
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

// ── Identity (THE key difference from native) ─────────────────────────────────
const IDENTITY_INTRO = `From now you are Braid, stateful and meticulous expert software architect operating inside a Pi coding agent harness.
Your tools and skills are keys to proper solutions - use and read them enought to access your full capability.
When facing complex, multi-step, or ambiguous tasks, think and plan, hypothesize and explore paths for multi-hypothesis analysis, recall memory for similar past solutions.
Finalize to mark task completion.`;

// ── Reconstruction Functions (from structured data, not text parsing) ─────────

function reconstructToolsSection(tools: ReturnType<ExtensionAPI["getAllTools"]>): string {
  // Use description from ToolInfo (promptSnippet not available in getAllTools return type)
  const visibleTools = tools
    .map(t => `- ${t.name}: ${t.description}`)
    .join("\n");

  const toolsList = visibleTools || "(none)";

  return `Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom_tools depending on the project.`;
}

function reconstructGuidelineSection(hasBash: boolean, hasGrep: boolean, hasFind: boolean, hasLs: boolean): string {
  const guidelines: string[] = [];

  // File exploration
  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    guidelines.push("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    guidelines.push("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
  }

  // Always include
  guidelines.push("Be concise in your responses");
  guidelines.push("Show file paths clearly when working with files");

  return `Guidelines:
${guidelines.map(g => `- ${g}`).join("\n")}`;
}


function reconstructDocsSection(): string {
  // Path is in L1 section. This is just guidance for when to read docs.
  return `Pi documentation (read only when asked about pi, its SDK, extensions, themes, skills, TUI, keybindings, configuration, or ~/.pi directory):

Docs root is in ## System State. See pi-reference skill for doc index.`;
}

function reconstructProjectContextSection(cwd: string): string {
  // Re-implemented from loadProjectContextFiles (not exported from pi)
  // Searches for AGENTS.md or CLAUDE.md in cwd and ancestors

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
  const root = resolve("/");
  let currentDir = cwd;

  while (true) {
    const contextFile = loadContextFromDir(currentDir);
    if (contextFile && !seenPaths.has(contextFile.path)) {
      contextFiles.unshift(contextFile); // Prepend so closest is first
      seenPaths.add(contextFile.path);
    }

    if (currentDir === root) break;

    const parentDir = resolve(currentDir, "..");
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
  // Include pi-braid's bundled skills via SKILLS_DIR
  // plus default locations (~/.pi/agent/skills, ./.pi/skills)
  const result = loadSkills({ cwd, skillPaths: [SKILLS_DIR], includeDefaults: true });
  return formatSkillsForPrompt(result.skills);
}

// ── Main Extension ───────────────────────────────────────────────────────────

export default function promptBuilderExtension(pi: ExtensionAPI) {
  pi.events.on("enforcement_signals", (data: unknown) => {
    const d = data as { turn: number; signals: Record<string, { turn: number; text: string; acted: boolean }> };
    _enforcementSignals = d.signals;
    _lastSignalTurn = d.turn;
  });

  pi.on("session_start", () => {
    _enforcementSignals = {};
    _lastSignalTurn = 0;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx.cwd;

    // Get structured data
    const tools = pi.getAllTools();
    const toolNames = tools.map(t => t.name);
    const hasBash = toolNames.includes("bash");
    const hasGrep = toolNames.includes("grep");
    const hasFind = toolNames.includes("find");
    const hasLs = toolNames.includes("ls");
    const hasRead = toolNames.includes("read");

    // Gather L1 state
    const l1Env = await gatherL1State(pi, ctx);

    // Build sections in order
    const parts: string[] = [];

    // 1. Custom identity (THE difference)
    parts.push(IDENTITY_INTRO);

    // 2. Available tools (structured)
    parts.push(reconstructToolsSection(tools));

    // 3. Guidelines (fixed template)
    parts.push(reconstructGuidelineSection(hasBash, hasGrep, hasFind, hasLs));

    // 4. Pi documentation - commented out for testing environmental awareness
    // Agent should discover docs path from L1 and skill guidance
    // parts.push(reconstructDocsSection());

    // 5. Project context (from file loading)
    const projectContext = reconstructProjectContextSection(cwd);
    if (projectContext) {
      parts.push(projectContext);
    }

    // 6. Skills (from skill loading API)
    if (hasRead) {
      const skillsSection = reconstructSkillsSection(cwd);
      if (skillsSection) {
        parts.push(skillsSection);
      }
    }

    // 7. L1 environmental state
    parts.push(formatL1Environment(l1Env));

    // 8. Enforcement signals
    const enforcement = formatEnforcementL1(_enforcementSignals);
    if (enforcement) {
      parts.push(enforcement);
    }

    // 9. Thinking guidance
    parts.push(THINK_SILENTLY);
    parts.push(VERIFICATION_REMINDER);

    // 10. Implicit budget - harness engineering for efficiency
    parts.push(IMPLICIT_BUDGET);

    // 11. Date and cwd (always last)
    const date = new Date().toISOString();
    const promptCwd = cwd.replace(/\\/g, "/");
    parts.push(`Current time: ${date}`);
    parts.push(`Current working directory: ${promptCwd}`);

    const newPrompt = parts.join("\n\n");
    return { systemPrompt: newPrompt };
  });
}
