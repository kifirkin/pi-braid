/**
 * Prompt Inspect Tool — reads the actual system prompt from runtime.
 *
 * For future use: suggesting improvements, adjusting the prompt on the
 * fly, debugging prompt-related issues.
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
      description: "Include tool descriptions; false shows a count marker. Default: true",
      default: true,
    }),
  ),
  includeSkills: Type.Optional(
    Type.Boolean({
      description: "Include skill descriptions; false shows a count marker. Default: true",
      default: true,
    }),
  ),
  truncate: Type.Optional(
    Type.Number({
      description:
        "Max characters (0 = no limit, default 5000); applied after tool/skill exclusion.",
      default: 5000,
    }),
  ),
  match: Type.Optional(
    Type.String({
      description:
        "Show only lines containing this string (case-insensitive), e.g. 'guidelines'; skips truncation.",
    }),
  ),
});

/**
 * Exclude the tools inventory from a composed prompt (includeTools: false).
 *
 * A terminator-lookahead pattern never matches a braid-composed prompt (the
 * block is bounded by the list itself), so the parser pins this shape and
 * its regression test asserts a real exclusion.
 */
export function excludeToolsBlock(prompt: string): {
  text: string;
  linesRemoved: number;
  toolCount: number;
} {
  const pattern = /^Available tools:\n(?:\(none\)\n?|- [^\n]*\n?)+/m;
  const match = prompt.match(pattern);
  if (!match) return { text: prompt, linesRemoved: 0, toolCount: 0 };
  const toolCount = (match[0].match(/^- /gm) || []).length;
  return {
    text: prompt.replace(
      pattern,
      `[TOOLS: ${toolCount} tools registered — excluded. Use includeTools=true to show.]\n`,
    ),
    linesRemoved: match[0].replace(/\n$/, "").split("\n").length,
    toolCount,
  };
}

/**
 * Exclude the skills block from a composed prompt (includeSkills: false).
 *
 * The braid prompt-builder does not render a Resources one-liner
 * (discovery is served by list_skills), so against a live braid prompt this
 * degrades to 0-removed ("absent, never wrong"). Kept as a pure export:
 * pi-native or third-party prompt shapes can still carry a "Resources: N
 * skills" line, and the parser stays pinned by test-prompt-inspect-exclusion.mjs.
 */
export function excludeSkillsBlock(prompt: string): {
  text: string;
  linesRemoved: number;
  skillCount: number;
} {
  const pattern = /^Resources: (\d+) skills[^\n]*$/m;
  const match = prompt.match(pattern);
  if (!match) return { text: prompt, linesRemoved: 0, skillCount: 0 };
  const skillCount = Number(match[1]);
  return {
    text: prompt.replace(
      pattern,
      `[SKILLS: ${skillCount} skills available — excluded. Use includeSkills=true to show.]`,
    ),
    linesRemoved: 1,
    skillCount,
  };
}

export function createPromptInspectTool() {
  return {
    name: "prompt_inspect" as const,
    label: "Prompt Inspect",
    promptSnippet: "Show the current system prompt from runtime",
    description:
      "Show the current system prompt from runtime to debug prompt-related issues, " +
      "inspect the assembled content, or suggest improvements. " +
      "Use includeTools/includeSkills to exclude long sections, truncate to limit chars, " +
      "or match to filter lines by keyword.",
    parameters: inspectSchema,

    execute: async (
      _toolCallId: string,
      params: {
        includeTools?: boolean;
        includeSkills?: boolean;
        truncate?: number;
        match?: string;
      },
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

      if (!showSkills) {
        const excluded = excludeSkillsBlock(result);
        result = excluded.text;
        skillsLinesRemoved = excluded.linesRemoved;
      }

      if (!showTools) {
        const excluded = excludeToolsBlock(result);
        result = excluded.text;
        toolsLinesRemoved = excluded.linesRemoved;
      }

      // Injections are tracked separately from the system prompt.
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

      const infoParts: string[] = [`System Prompt (${raw.length} chars):`];
      if (!showTools) infoParts.push(`  [tools excluded: ${toolsLinesRemoved} lines removed]`);
      if (!showSkills) infoParts.push(`  [skills excluded: ${skillsLinesRemoved} lines removed]`);

      const injectionsSection = `\n\n── INJECTIONS ──\n${injLines.join("\n")}`;
      let body = result;
      let didTruncate = false;

      const matchFilter = params.match;
      if (matchFilter) {
        const lowerFilter = matchFilter.toLowerCase();
        const lines = body.split("\n");
        const matchedLines = lines.filter((l) => l.toLowerCase().includes(lowerFilter));
        if (matchedLines.length > 0) {
          body = matchedLines.join("\n");
        } else {
          body = `(no lines matched "${matchFilter}" in ${lines.length} lines)`;
        }
      } else {
        // Apply truncation only when no match filter is active
        if (maxLen > 0 && body.length > maxLen) {
          didTruncate = true;
          body =
            body.slice(0, maxLen - 80) +
            `\n...(truncated at ${maxLen} chars, full prompt is ${raw.length} chars)`;
        }
      }

      const output = infoParts.join("\n") + "\n\n" + body + injectionsSection;

      return {
        content: [{ type: "text" as const, text: output }],
        details: {
          promptChars: raw.length,
          toolsExcluded: !showTools,
          skillsExcluded: !showSkills,
          truncated: didTruncate,
          injectionCount: injections.length,
        },
      };
    },
  };
}
