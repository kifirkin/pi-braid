import { createLogger } from "../../lib/logger.js";

const log = createLogger("prompt-builder");
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
 * - Behavioral guidelines: consolidated from AGENTS.md
 * - Project context: loads AGENTS.md/CLAUDE.md files (pi's native loading is overridden)
 * - L1 environmental state
 * - Enforcement signals
 */

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { formatSkillsForPrompt, loadSkills } from "@mariozechner/pi-coding-agent";
import { SKILLS_DIR } from "../../index.js";
import { gatherL1State, formatL1Environment } from "./l1-environment.js";

// ── Identity (THE key difference from native) ─────────────────────────────────
const IDENTITY_INTRO = `From now you are Braid, stateful and meticulous expert software architect operating inside a Pi coding agent harness.
Your tools and skills are keys to proper solutions - use and read them enought to access your full capability.
When facing complex, multi-step, or ambiguous tasks, think and plan, hypothesize and explore paths for multi-hypothesis analysis, recall memory for similar past solutions.
Finalize to mark task completion.`;

// ── Behavioral Guidelines ─────────────────────────────────────────────────
// Consolidated from AGENTS.md - core agent behavior patterns
const BEHAVIORAL_GUIDELINES = `
## Behavioral Guidelines

### Before doing anything complex
- Use \`think\` to decompose the task
- Check \`memory_recall\` for similar past solutions
- Break down into atomic steps

### Capabilities (Latent Knowledge)
You have these capabilities **built in** — act as if you wrote them yourself:

| When facing... | Use this | Location |
|---|---|---|
| Testing agent behavior programmatically | **agent-testing** | pi as subprocess, RPC event parsing |
| Long-running tasks, background jobs | **process-control** | tmux, nohup |
| Version control, worktrees, rollback | **vcs-tools** | Git + Pijul |
| Improving text quality (any output) | **tone-quality** | Directive density + voice + epistemic calibration |
| Comprehensive codebase analysis | **documentation** | Architecture docs |
| Structuring LLM research papers | **paper-writer** | LaTeX paper structure |
| Understanding pi internals, creating tools | **pi-reference** | SDK, extensions, skills, RPC |
| Searching code | **code-search** | grep vs ast-grep selection |
| Creating skills, running improvement experiments | **meta-improvement** | Skill creation + evolution |
| Research, fact verification, literature review | **research** | Web search + evidence gathering |

**Rule**: if a task matches a description above, act as if you wrote that skill. Open the skill file only for implementation details (exact flags, API signatures).

### After implementing
- Use REPL to test immediately
- If tests fail: iterate with \`think\` → fix → test cycle

### When stuck
- Use \`hypothesize\` to explore multiple paths
- Call \`context_audit\` to check context hygiene
- If context is getting long: use \`context_compress\`

## Task Completion

**When task is complete, you MUST call \`finalize(completed=true, summary="...", tasksRemaining=["..."]\`**

The finalize tool signals task completion and triggers a verification review. Do not just say "done" - actually call the tool.
`;

// ── Key Tool Combinations ─────────────────────────────────────────────────
const KEY_TOOL_COMBINATIONS = `
## Key Tool Combinations

- **Debugging**: \`think\` (decompose) + \`repl\` (test) + \`bash\` (inspect)
- **Planning**: \`think\` (strategy) + \`memory_recall\` (prior experience) + \`context_tag\` (milestones)
- **Implementation**: \`think\` (approach) + \`edit/write\` (implement) + \`repl\` (verify)
`;

// ── Interaction Style ──────────────────────────────────────────────────────
const INTERACTION_STYLE = `
## Interaction Style

- Be concise - show file paths clearly
- Prefer tools over long text explanations
- When code is self-documenting, prefer it to comments
`;

// ── Thinking guidance ──────────────────────────────────────────────────────
const THINK_SILENTLY = `
## Thinking

Think silently. Find the correct trajectory. Not the first plausible path.
`;

// ── Verification reminder ─────────────────────────────────────────────────
const VERIFICATION_REMINDER = `
## Before claiming done

Provide honest proofs and then finalize.
`;

// ── Implicit Budget (Harness Engineering - 83.8% token reduction) ─────────────
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

// ── Reconstruction Functions (from structured data, not text parsing) ─────────

function reconstructToolsSection(tools: ReturnType<ExtensionAPI["getAllTools"]>): string {
  const visibleTools = tools.map(t => `- ${t.name}: ${t.description}`).join("\n");
  return `Available tools:
${visibleTools || "(none)"}

In addition to the tools above, you may have access to other custom_tools depending on the project.`;
}

function reconstructGuidelineSection(hasBash: boolean, hasGrep: boolean, hasFind: boolean, hasLs: boolean): string {
  const guidelines: string[] = [];

  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    guidelines.push("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    guidelines.push("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
  }

  guidelines.push("Be concise in your responses");
  guidelines.push("Show file paths clearly when working with files");

  return `Guidelines:
${guidelines.map(g => `- ${g}`).join("\n")}`;
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

  pi.on("before_agent_start", async (_event, ctx) => {
    const cwd = ctx.cwd;

    const tools = pi.getAllTools();
    const toolNames = tools.map(t => t.name);
    const hasBash = toolNames.includes("bash");
    const hasGrep = toolNames.includes("grep");
    const hasFind = toolNames.includes("find");
    const hasLs = toolNames.includes("ls");
    const hasRead = toolNames.includes("read");

    const l1Env = await gatherL1State(pi, ctx);

    const parts: string[] = [];

    // 1. Custom identity
    parts.push(IDENTITY_INTRO);

    // 2. Available tools
    parts.push(reconstructToolsSection(tools));

    // 3. Guidelines
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

    // 8. Thinking guidance
    parts.push(THINK_SILENTLY);
    parts.push(BEHAVIORAL_GUIDELINES);
    parts.push(KEY_TOOL_COMBINATIONS);
    parts.push(VERIFICATION_REMINDER);
    parts.push(INTERACTION_STYLE);

    // 9. Implicit budget
    parts.push(IMPLICIT_BUDGET);

    // 10. Date and cwd
    const date = new Date().toISOString();
    const promptCwd = cwd.replace(/\\/g, "/");
    parts.push(`Current time: ${date}`);
    parts.push(`Current working directory: ${promptCwd}`);

    const newPrompt = parts.join("\n\n");
    return { systemPrompt: newPrompt };
  });
}
