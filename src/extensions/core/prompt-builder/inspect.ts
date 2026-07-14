/**
 * Prompt Inspect Tool — reads the actual system prompt from runtime.
 *
 * Resurrected from the deleted preview.ts (commit 4e1bca57) with a more
 * generic name for future use: suggesting improvements, adjusting the
 * prompt on the fly, and debugging prompt-related issues.
 *
 * Why this exists: the agent can't introspect its own system prompt.
 * When something goes wrong, there's no other way to check if the
 * prompt is the cause. This tool bridges that gap by reading the
 * ACTUAL prompt string that the model receives.
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getInjections } from "../../../lib/utils/injection-tracker.js";

const inspectSchema = Type.Object({
  includeTools: Type.Optional(
    Type.Boolean({
      description:
        "Include tool descriptions. When false, shows a count marker instead. Default: true",
      default: true,
    }),
  ),
  includeSkills: Type.Optional(
    Type.Boolean({
      description:
        "Include skill descriptions. When false, shows a count marker instead. Default: true",
      default: true,
    }),
  ),
  truncate: Type.Optional(
    Type.Number({
      description:
        "Max characters (0 = no limit, default: 5000). Applied after optional tool/skill exclusion.",
      default: 5000,
    }),
  ),
});

function countLines(text: string, pattern: RegExp): number {
  let count = 0;
  const match = text.match(pattern);
  if (match) {
    count = match[0].split("\n").length;
  }
  return count;
}

export function createPromptInspectTool() {
  return {
    name: "prompt_inspect" as const,
    label: "Prompt Inspect",
    promptSnippet: "Show the current system prompt from runtime",
    description:
      "Show the current system prompt from runtime to debug prompt-related issues, " +
      "inspect the assembled content, or suggest improvements. " +
      "Use includeTools/includeSkills to exclude long sections, truncate to limit chars.",
    parameters: inspectSchema,

    execute: async (
      _toolCallId: string,
      params: { includeTools?: boolean; includeSkills?: boolean; truncate?: number },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext | undefined,
    ): Promise<any> => {
      const showTools = params.includeTools ?? true;
      const showSkills = params.includeSkills ?? true;
      const maxLen = params.truncate ?? 5000;

      if (!ctx) {
        return {
          content: [{ type: "text" as const, text: "Prompt inspect requires a valid context." }],
          details: { error: "no_context" },
        };
      }

      // ── Read the actual system prompt from runtime ───────────────────────
      const raw = ctx.getSystemPrompt?.();
      if (!raw) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Could not read system prompt from runtime. " +
                "This may be a compile-time or --no-session invocation.",
            },
          ],
          details: { error: "no_system_prompt" },
        };
      }

      let result = raw;
      let toolsLinesRemoved = 0;
      let skillsLinesRemoved = 0;

      // ── Optionally strip skills block ────────────────────────────────────
      if (!showSkills) {
        const skillsPattern =
          /\n\nThe following skills provide specialized instructions[\s\S]*?<\/available_skills>/;
        const match = result.match(skillsPattern);
        if (match) {
          const linesRemoved = match[0].split("\n").length;
          skillsLinesRemoved = linesRemoved;
          const skillCount = (match[0].match(/<skill>/g) || []).length;
          result = result.replace(
            skillsPattern,
            `\n\n[SKILLS: ${skillCount} skills available — excluded. Use includeSkills=true to show.]`,
          );
        }
      }

      // ── Optionally strip tools section ───────────────────────────────────
      if (!showTools) {
        const toolsPattern =
          /Available tools:[\s\S]*?(?=\n\n# |\n\n## |\n\n\nThe following skills|\n\n\[SKILLS:)/;
        const match = result.match(toolsPattern);
        if (match) {
          toolsLinesRemoved = match[0].split("\n").length;
          const toolCount = (match[0].match(/^- /gm) || []).length;
          result = result.replace(
            toolsPattern,
            `[TOOLS: ${toolCount} tools registered — excluded. Use includeTools=true to show.]`,
          );
        }
      }

      // ── Injections section (separate from system prompt) ─────────────────
      const injections = getInjections();
      const injLines: string[] = [];
      if (injections.length === 0) {
        injLines.push("(no messages tracked this session)");
      } else {
        const bySource = new Map<string, string[]>();
        for (const inj of injections.slice(-20)) {
          const key = inj.source;
          if (!bySource.has(key)) bySource.set(key, []);
          const prefix = inj.display ? "[visible]" : "[hidden]";
          bySource.get(key)!.push(`${prefix} ${inj.content.slice(0, 120)}`);
        }
        for (const [source, msgs] of bySource) {
          injLines.push(`## ${source} (${msgs.length} messages)`);
          for (const m of msgs.slice(-5)) injLines.push(`  ${m}`);
        }
        injLines.push(`\n_total: ${injections.length} injections tracked`);
      }

      // ── Build output ─────────────────────────────────────────────────────
      const infoParts: string[] = [`System Prompt (${raw.length} chars):`];
      if (!showTools) infoParts.push(`  [tools excluded: ${toolsLinesRemoved} lines removed]`);
      if (!showSkills) infoParts.push(`  [skills excluded: ${skillsLinesRemoved} lines removed]`);

      const injectionsSection = `\n\n── INJECTIONS ──\n${injLines.join("\n")}`;
      let body = result;

      // Apply truncation if needed
      if (maxLen > 0 && body.length > maxLen) {
        body =
          body.slice(0, maxLen - 80) +
          `\n...(truncated at ${maxLen} chars, full prompt is ${raw.length} chars)`;
      }

      const output = infoParts.join("\n") + "\n\n" + body + injectionsSection;

      return {
        content: [{ type: "text" as const, text: output }],
        details: {
          promptChars: raw.length,
          toolsExcluded: !showTools,
          skillsExcluded: !showSkills,
          truncated: maxLen > 0 && body.length > raw.length,
          injectionCount: injections.length,
        },
      };
    },
  };
}