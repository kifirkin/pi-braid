/**
 * Prompt Builder Extension — Replaces the default system prompt with
 * the develop-branch "identity framing" prompt.
 *
 * The upstream main branch uses directive-style prompts:
 *   "You MUST read files before editing"
 *   "ALWAYS verify your changes"
 *   "NEVER fabricate data"
 *
 * The develop branch uses identity framing:
 *   "You examine files before editing"
 *   "You verify after every change"
 *   "You don't fabricate"
 *
 * Research shows explicit directives trigger compliance theater.
 * Identity framing channels behavior toward task-relevant actions.
 *
 * This extension uses `before_agent_start` to dynamically replace
 * the system prompt each turn. It:
 * - Constructs tool-aware guidelines based on active tools
 * - Incorporates promptSnippet/promptGuidelines from registered tools
 * - Injects the develop-branch identity framing
 * - Preserves any custom SYSTEM.md or append sections from the host
 *
 * The key design principle: we DON'T just append text — we REPLACE
 * the system prompt entirely so the identity framing is consistent.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Tool descriptions for system prompt */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  read: "Read file contents",
  bash: "Execute bash commands (ls, grep, find, etc.)",
  edit: "Make surgical edits to files (find exact text and replace)",
  write: "Create or overwrite files",
  grep: "Search file contents for patterns (respects .gitignore)",
  find: "Find files by glob pattern (respects .gitignore)",
  ls: "List directory contents",
};

/** Default identity-framing guidelines */
const DEFAULT_GUIDELINES = [
  "You write tight. No fluff. File paths named, right there.",
  "You plan on paper first. Steps before code.",
  "You understand completely before touching. The real problem, not a shadow of it.",
  "You coordinate. You branch for safety.",
  "You write code that works. Tests confirm it.",
  "You verify. After every change, before claiming done.",
  "You choose the solution that lasts. The proper way is never optional.",
  "You remember. Every session builds on the last.",
  "You don't fabricate. Not data. Not sources. Not results.",
  "You are honest. You report what you found, not what you hoped to find.",
  "You confront contradictory evidence. You don't ignore it.",
  "You admit uncertainty. Making up answers stops here.",
];

export default function promptBuilderExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const currentPrompt = event.systemPrompt;

    // Get active tools from the API
    const allTools = pi.getAllTools();
    // getActiveTools() returns string[], getAllTools() returns ToolInfo[]
    const activeToolNames = pi.getActiveTools();

    // Build tool-aware guidelines
    const guidelines: string[] = [];
    const guidelinesSet = new Set<string>();
    const addGuideline = (g: string) => {
      if (!guidelinesSet.has(g)) {
        guidelinesSet.add(g);
        guidelines.push(g);
      }
    };

    // Tool-conditional guidelines (identity framing)
    const hasBash = activeToolNames.includes("bash");
    const hasGrep = activeToolNames.includes("grep");
    const hasFind = activeToolNames.includes("find");
    const hasLs = activeToolNames.includes("ls");
    const hasRead = activeToolNames.includes("read");
    const hasEdit = activeToolNames.includes("edit");
    const hasWrite = activeToolNames.includes("write");

    if (hasBash && !hasGrep && !hasFind && !hasLs) {
      addGuideline("You reach for bash for file operations like ls, rg, find");
    } else if (hasBash && (hasGrep || hasFind || hasLs)) {
      addGuideline(
        "You prefer grep/find/ls over bash for file exploration (faster, respects .gitignore)",
      );
    }

    if (hasRead && hasEdit) {
      addGuideline("You examine files before editing, using read instead of cat or sed.");
    }

    if (hasEdit) {
      addGuideline("You make precise changes — old text matches exactly.");
    }

    if (hasWrite) {
      addGuideline("You write new files or complete rewrites");
    }

    if (hasEdit || hasWrite) {
      addGuideline("You summarize actions in plain text, not via cat or bash");
    }

    // Collect promptGuidelines from registered tools (if exposed via ToolInfo)
    const toolGuidelines: string[] = [];
    const toolSnippets: Record<string, string> = {};
    for (const tool of allTools) {
      // promptGuidelines and promptSnippet are on ToolDefinition but may not be in ToolInfo
      // Access via type assertion since they may be present at runtime
      const guidelines = (tool as any).promptGuidelines;
      const snippet = (tool as any).promptSnippet;
      if (Array.isArray(guidelines)) {
        for (const g of guidelines) {
          toolGuidelines.push(g);
        }
      }
      if (typeof snippet === "string") {
        toolSnippets[tool.name] = snippet;
      }
    }

    // Use tool guidelines if present, otherwise defaults
    if (toolGuidelines.length > 0) {
      for (const g of toolGuidelines) {
        addGuideline(g.trim());
      }
    } else {
      for (const g of DEFAULT_GUIDELINES) {
        addGuideline(g);
      }
    }

    // Build tools list
    const visibleTools = activeToolNames.filter(
      (name) => name in TOOL_DESCRIPTIONS || toolSnippets[name],
    );
    const toolsList =
      visibleTools.length > 0
        ? visibleTools
            .map((name) => {
              const snippet = toolSnippets[name] ?? TOOL_DESCRIPTIONS[name] ?? name;
              return `- ${name}: ${snippet}`;
            })
            .join("\n")
        : "(none)";

    const guidelinesText = guidelines.map((g) => `- ${g}`).join("\n");

    // Extract any append content from current prompt (e.g., from APPEND_SYSTEM.md or extensions)
    // We look for everything after the last known section marker
    let appendContent = "";
    const appendMarker = "\n\n# Project Context";
    const appendIndex = currentPrompt.indexOf(appendMarker);
    if (appendIndex !== -1) {
      appendContent = currentPrompt.slice(appendIndex);
    }

    // Build the new prompt
    const date = new Date().toISOString().slice(0, 10);
    const cwd = ctx.cwd.replace(/\\/g, "/");

    let newPrompt = `You are stateful and meticulous expert software architect. You think silently and write clean code. When the task demands a different kind of thinking, you become that kind of thinker. You solve problems by understanding them completely before acting. You operate inside pi, a resourceful harness with a full toolkit. You read thoroughly, execute safely, edit precisely, write clean code. You plan ahead and verify everything.

You think in systems. Every piece connects to others. Changing one thing affects the whole.

You trace backwards. When output is wrong, follow it back to find where it first went wrong.

You reach for tools without being told:
${toolsList}

Custom tools may be available for your project.

Your guidelines shape how you work:
${guidelinesText}

You read skills when the task demands them.

When you need knowledge, you seek for grounded truth.`;

    // Append project context if present
    if (appendContent) {
      newPrompt += appendContent;
    }

    // Add date and cwd
    newPrompt += `\nCurrent date: ${date}`;
    newPrompt += `\nCurrent working directory: ${cwd}`;

    return { systemPrompt: newPrompt };
  });
}
