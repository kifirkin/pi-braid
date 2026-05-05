/**
 * Prompt Preview Tool — reads the actual system prompt from runtime.
 *
 * No reverse-engineering, no constants reconstruction.
 * Gets the string directly from ctx.getSystemPrompt() and parses it
 * into labelled sections for human-readable access.
 *
 * Why this exists: the agent can't introspect its own system prompt.
 * When something goes wrong, there's no other way to check if the
 * prompt is the cause. This tool bridges that gap by reading the
 * ACTUAL prompt string that the model receives — not a reconstruction
 * that can drift from reality.
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getInjections } from "../../../lib/injection-tracker.js";

const previewSchema = Type.Object({
  section: Type.Optional(
    Type.String({
      description:
        "Which section to show. Options: all, identity, tools, skills, project, " +
        "insights, l1, enforcement, norms, format, metadata, injections. " +
        "Also accepts substring match against any section body.",
      default: "all",
    }),
  ),
  truncate: Type.Optional(
    Type.Number({
      description: "Max characters per section (0 = no limit, default: 2000)",
      default: 2000,
    }),
  ),
});

function truncate(s: string, max: number): string {
  if (max === 0 || s.length <= max) return s;
  // Try to break at a section boundary for cleaner output
  const truncated = s.slice(0, max);
  const lastBreak = truncated.lastIndexOf("\n──");
  if (lastBreak > max / 2) return truncated.slice(0, lastBreak) + "\n...(truncated)";
  return truncated.slice(0, max - 3) + "...";
}

// ── Section detection ────────────────────────────────────────────────────
// These patterns match the start of each section block in the prompt-builder
// output. Each detector identifies a section boundary. Content between one
// detector and the next (or end-of-string) belongs to that section.
// Variables: project context and skills lengths. Fixed: everything else.

const SECTION_DETECTORS: Array<{
  id: string;
  title: string;
  detect: RegExp;
}> = [
  { id: "identity", title: "IDENTITY + NORMS", detect: /^You are Braid/ },
  { id: "tools", title: "AVAILABLE TOOLS", detect: /^Available tools:/ },
  { id: "project", title: "PROJECT CONTEXT", detect: /^# Project Context/m },
  { id: "skills", title: "ACTIVE SKILLS", detect: /^<available_skills>/s },
  { id: "insights", title: "PAST INSIGHTS", detect: /^## Past Insights/ },
  { id: "l1", title: "L1 ENVIRONMENTAL STATE", detect: /^## System State/ },
  { id: "enforcement", title: "ENFORCEMENT SIGNALS", detect: /^## Enforcement State/ },
  { id: "norms", title: "IMPLICIT NORMS + CONTRAST", detect: /^RepE contrast vectors:/ },
  { id: "format", title: "FORMAT GUIDANCE", detect: /^\/\/ Use code blocks/ },
  { id: "style", title: "INTERACTION STYLE", detect: /^Provide concise/ },
  { id: "metadata", title: "METADATA", detect: /^Current time:/ },
];

/**
 * Parse the raw system prompt string into labelled sections.
 *
 * Strategy: split on double-newlines, match each block against detectors,
 * group continuation blocks into the most-recently-detected section.
 *
 * This is NOT fragile reverse-engineering — the detectors match the actual
 * output format of prompt-builder/index.ts. If the format changes, only
 * the detectors need updating.
 */
function parsePromptIntoSections(
  prompt: string,
): Array<{ id: string; title: string; body: string }> {
  const blocks = prompt.split(/\n\n+/).filter((b) => b.trim());
  if (blocks.length === 0) return [];

  const rawSections: Array<{ id: string; title: string; body: string[] }> = [];
  let current: { id: string; title: string; body: string[] } | null = null;

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const firstLine = trimmed.split("\n")[0].trim();
    const matched = SECTION_DETECTORS.find((d) => d.detect.test(firstLine));

    if (matched) {
      if (current) rawSections.push(current);
      current = { id: matched.id, title: matched.title, body: [trimmed] };
    } else if (current) {
      // Continuation of the current section
      current.body.push(trimmed);
    }
    // Blocks before any detector match are leading identity content
  }

  if (current) rawSections.push(current);

  return rawSections.map((s) => ({
    id: s.id,
    title: s.title,
    body: s.body.join("\n\n"),
  }));
}

export function createPromptPreviewTool() {
  return {
    name: "prompt_preview" as const,
    label: "Prompt Preview",
    description:
      "Show the current system prompt structure. " +
      "Reads directly from runtime — no reverse-engineering. " +
      "Use section= to target a specific part, truncate= to limit output length.",
    parameters: previewSchema,

    execute: async (
      _toolCallId: string,
      params: { section?: string; truncate?: number },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext | undefined,
    ): Promise<any> => {
      const target = params.section ?? "all";
      const maxLen = params.truncate ?? 2000;

      if (!ctx) {
        return {
          content: [
            { type: "text" as const, text: "Prompt preview requires a valid context." },
          ],
          details: { error: "no_context" },
        };
      }

      // ── Read the actual system prompt from runtime ───────────────────────
      const systemPrompt = ctx.getSystemPrompt?.();
      if (!systemPrompt) {
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

      // ── Parse into sections ─────────────────────────────────────────────
      const allSections = parsePromptIntoSections(systemPrompt);

      // ── Filter ───────────────────────────────────────────────────────────
      let filtered = allSections;
      if (target !== "all") {
        // Try exact match first
        filtered = allSections.filter((s) => s.id === target);
        // Fallback: substring match against title or body
        if (filtered.length === 0) {
          const lower = target.toLowerCase();
          filtered = allSections.filter(
            (s) =>
              s.title.toLowerCase().includes(lower) ||
              s.body.toLowerCase().includes(lower),
          );
        }
      }

      // ── Injections section (separate from system prompt) ─────────────────
      const includeInjections =
        target === "all" || target === "injections" || target.toLowerCase() === "injection";

      if (includeInjections) {
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
        // Push as extra content, not with sections (it's not in the system prompt)
        const injBody = injLines.join("\n");
        return {
          content: [
            {
              type: "text" as const,
              text: `System Prompt Runtime (${systemPrompt.length} chars, ${allSections.length} sections):\n\n── PROMPT SECTIONS ──\n\n${formatSections(filtered, maxLen)}\n\n── CONTEXT INJECTIONS ──\n${injBody}`,
            },
          ],
          details: {
            section: target,
            sections: allSections.map((s) => s.id),
            promptChars: systemPrompt.length,
            truncated: maxLen > 0 && systemPrompt.length > maxLen,
            injectionCount: injections.length,
          },
        };
      }

      // ── Build output ─────────────────────────────────────────────────────
      if (filtered.length === 0) {
        const availableIds = allSections.map((s) => s.id).join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `No section matched "${target}". Available: ${availableIds}, injections.`,
            },
          ],
          details: {
            error: "unknown_section",
            available: [...allSections.map((s) => s.id), "injections"],
          },
        };
      }

      const body = formatSections(filtered, maxLen);
      const totalChars = body.length;

      return {
        content: [
          {
            type: "text" as const,
            text: `System Prompt Runtime (${systemPrompt.length} chars, ${allSections.length} sections):\n\n${body}`,
          },
        ],
        details: {
          section: target,
          sections: allSections.map((s) => s.id),
          promptChars: systemPrompt.length,
          totalChars,
          truncated: maxLen > 0 && totalChars > maxLen,
        },
      };
    },
  };
}

function formatSections(
  sections: Array<{ id: string; title: string; body: string }>,
  maxLen: number,
): string {
  if (sections.length === 0) return "(no sections)";
  const sectionBudget = maxLen > 0 ? Math.floor(maxLen / sections.length) : 0;
  return sections
    .map((s) => `── ${s.title} ──\n${truncate(s.body, sectionBudget)}`)
    .join("\n\n");
}
