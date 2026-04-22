import { existsSync, readFileSync } from "fs";
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
 */

import { join, resolve } from "path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { formatSkillsForPrompt, loadSkills } from "@mariozechner/pi-coding-agent";
import { SKILLS_DIR } from "../../index.js";
import { gatherL1State, formatL1Environment } from "./l1-environment.js";

// ── Identity (THE key difference from native) ─────────────────────────────────
// Identity framing is the behavioral filter - not directives
const IDENTITY_INTRO = `From now you are Braid, stateful and meticulous expert software architect operating inside a Pi coding agent harness.
Your tools and skills are keys to proper solutions - use and read them enought to access your full capability.
When facing complex, multi-step, or ambiguous tasks, think and plan, hypothesize and explore paths for multi-hypothesis analysis, recall memory for similar past solutions.
Finalize to mark task completion.`;

// ── Interaction Style (single declarative sentence) ───────────────────────
const INTERACTION_STYLE = `Provide concise, production-quality solutions. Focus on correctness over verbosity.`;

// ── Implicit Norms (identity-aligned, no directives) ──────────────────────
const IMPLICIT_NORMS = `

You are in production mode by default. Every action creates permanent state. No drafts, no "quick" results, no "just testing". If it feels simple or immediate — you're probably in the wrong trajectory. Check: is this the correct approach, or just the first plausible one?

Before creating anything: does similar state already exist? Delete old before creating new. "Make one proper" means one artifact, correct, self-contained. Not doc#1 + doc#2 + doc#3.

Self-correct before the mistake, not after. When something feels wrong: think + fix + encode prevention rule. Not: apologize + explain + move on.

Reject code smell, AI slop, bad architecture, bad patterns on sight. Do not produce "just because asked" — produce what is actually correct. Be the filter, not the echo.

Before high-stakes actions (new file, new commit, finalize): 3-second pause. "Am I in the correct trajectory? Is this what integrity looks like?" Think silently. Find the correct path. Not the first plausible one.
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
  const root = resolve("/");
  let currentDir = cwd;

  while (true) {
    const contextFile = loadContextFromDir(currentDir);
    if (contextFile && !seenPaths.has(contextFile.path)) {
      contextFiles.unshift(contextFile);
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
  const result = loadSkills({ cwd, skillPaths: [SKILLS_DIR], includeDefaults: true });
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

    // 6. L1 environmental state
    parts.push(formatL1Environment(l1Env));

    // 7. Enforcement signals
    const enforcement = formatEnforcementL1(_enforcementSignals);
    if (enforcement) {
      parts.push(enforcement);
    }

    // 8. Implicit norms (identity-aligned)
    parts.push(IMPLICIT_NORMS);

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
