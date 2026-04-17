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
 * - Project context: loads AGENTS.md/CLAUDE.md files
 * - Docs reference: simplified to skill reference
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { formatSkillsForPrompt, loadSkills } from "@mariozechner/pi-coding-agent";
import { gatherL1State } from "./l1-environment.js";

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
const IDENTITY_INTRO = `You are stateful and meticulous expert software architect.

Think silently. Find the correct trajectory. Not the first plausible path.

Your tools are keys to proper solutions - use them to access your full capability.
When facing complex, multi-step, or ambiguous tasks, think and plan, hypothesize and explore paths for multi-hypothesis analysis, recall memory for similar past solutions.

Finalize to mark task completion.`;

// ── Reconstruction Functions (from structured data, not text parsing) ─────────

function reconstructToolsSection(tools: ReturnType<ExtensionAPI["getAllTools"]>): string {
  // Use description from ToolInfo (promptSnippet not available in getAllTools return type)
  const visibleTools = tools
    .map(t => `- ${t.name}: ${t.description}`)
    .join("\n");

  const toolsList = visibleTools || "(none)";

  return `Available tools():
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.`;
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
  // Simplified: just reference the pi-reference skill
  // The skill contains all documentation paths and cross-references
  return `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, TUI, keybindings, configuration, internal structure, ~/.pi directory, or anything about how pi works under the hood):

Use the pi-reference skill for comprehensive documentation. Load it with:
  /skill:pi-reference

The skill covers: extensions, themes, skills, prompt templates, TUI components, keybindings, SDK integrations, custom providers, adding models, and pi packages.`;
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
  const result = loadSkills({ cwd, includeDefaults: true });
  return formatSkillsForPrompt(result.skills);
}

function formatL1Environment(env: Awaited<ReturnType<typeof gatherL1State>>): string {
  const lines: string[] = [];

  // Session time
  const minutes = Math.floor(env.agentEnv.sessionElapsedMs / 60000);
  const seconds = Math.floor((env.agentEnv.sessionElapsedMs % 60000) / 1000);
  const sinceLast = Math.round(env.agentEnv.sinceLastEventMs / 1000);

  lines.push("## System State");
  lines.push(`- Session: ${minutes}m ${seconds}s`);
  lines.push(`- Last event: ${sinceLast}s ago`);
  lines.push(`- Turns: ${env.agentEnv.turnCount}`);

  if (env.agentEnv.avgToolTimeMs > 0) {
    lines.push(`- Tool avg: ${env.agentEnv.avgToolTimeMs}ms`);
  }

  // Context warning
  if (env.contextPercent > 75) {
    lines.push(`Context: ${env.contextPercent.toFixed(0)}%`);
  }

  // Memory count
  if (env.memoryCount > 0) {
    lines.push(`${env.memoryCount} prior experience(s)`);
  }

  // Checkpoint awareness
  if (env.stepsSinceCheckpoint > 20) {
    lines.push("Consider context_tag()");
  }

  return lines.join("\n");
}

// ── Main Extension ───────────────────────────────────────────────────────────

console.error("=== PROMPT BUILDER EXTENSION LOADED ===");

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
    console.error("=== PROMPT BUILDER before_agent_start CALLED ===");
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

    // 4. Pi documentation (skill reference)
    parts.push(reconstructDocsSection());

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

    // 7. L1 environmental state (pi-braid addition)
    parts.push(formatL1Environment(l1Env));

    // 8. Enforcement signals (pi-braid addition)
    const enforcement = formatEnforcementL1(_enforcementSignals);
    if (enforcement) {
      parts.push(enforcement);
    }

    // 9. Date and cwd (always last)
    const date = new Date().toISOString().slice(0, 10);
    const promptCwd = cwd.replace(/\\/g, "/");
    parts.push(`Current date: ${date}`);
    parts.push(`Current working directory: ${promptCwd}`);

    const newPrompt = parts.join("\n\n");
    console.error("PROMPT BUILDER: Generated prompt length:", newPrompt.length);
    console.error("PROMPT BUILDER: First 200 chars:", newPrompt.substring(0, 200));
    return { systemPrompt: newPrompt };
  });
}
