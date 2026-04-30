/**
 * Prompt Preview Tool — makes the built system prompt observable.
 *
 * The agent can't see what the system prompt looks like — when something goes
 * wrong, there's no way to check if the prompt is the cause.
 *
 * This tool rebuilds the current system prompt from the same functions used
 * by before_agent_start, with a readable section-by-section output.
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { getAgentDir, loadSkills } from "@mariozechner/pi-coding-agent";
import { SKILLS_DIR } from "../../../index.js";

import {
  IDENTITY_INTRO,
  SYCOPHANCY_RESISTANCE,
  STAKES_AWARENESS,
  EPISTEMIC_STABILITY,
  CONTRAST_TRUTH_FIRST,
  CONTRAST_ANTI_SYCOPHANCY,
  CONTRAST_KNOWLEDGE_BOUNDARY,
  IMPLICIT_NORMS,
  INTERACTION_STYLE,
} from "./constants.js";
import { gatherL1State, formatL1Environment } from "./l1-environment.js";
import { getExtensionState } from "../../../lib/extension-state.js";
import { getInjections } from "../../../lib/injection-tracker.js";

const previewSchema = Type.Object({
  section: Type.Optional(
    Type.String({
      description:
        "Which section to show. Options: all | identity | tools | skills | project | l1 | enforcement | date",
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
  return s.slice(0, max - 3) + "...";
}

function getSkillMeta(skillFilePath: string): { lines: number; sections: string[] } {
  try {
    const content = readFileSync(skillFilePath, "utf-8");
    const lines = content.split("\n");
    const sections: string[] = [];
    for (const line of lines) {
      const m = line.match(/^#{2,3}\s+(.+)$/);
      if (m) sections.push(m[1].trim());
    }
    return { lines: lines.length, sections: sections.slice(0, 8) };
  } catch {
    return { lines: 0, sections: [] };
  }
}

function loadProjectFiles(cwd: string): string[] {
  const agentDir = getAgentDir();
  const found: string[] = [];
  const checked: Set<string> = new Set();

  const checkDir = (dir: string) => {
    if (checked.has(dir)) return;
    checked.add(dir);
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const p = join(dir, name);
      if (existsSync(p)) {
        try {
          const content = readFileSync(p, "utf-8").slice(0, 500);
          found.push(`[${dir}] ${name}:\n${content}\n`);
        } catch {
          /* skip */
        }
      }
    }
  };

  checkDir(agentDir);
  let cur: string | null = cwd;
  while (cur && cur !== "/") {
    checkDir(cur);
    const parent = join(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return found;
}

export function createPromptPreviewTool() {
  return {
    name: "prompt_preview" as const,
    label: "Prompt Preview",
    description:
      "Show the current system prompt structure built by prompt-builder. " +
      "Use section= to target a specific part, truncate= to limit output length.",
    parameters: previewSchema,

    execute: async (
      _toolCallId: string,
      params: { section?: string; truncate?: number },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext | undefined,
    ) => {
      const target = params.section ?? "all";
      const maxLen = params.truncate ?? 2000;

      if (!ctx) {
        return {
          content: [{ type: "text" as const, text: "Prompt preview requires a valid context." }],
          details: { error: "no_context" },
        };
      }

      const cwd = ctx.cwd;
      const pi = (ctx as any)._pi;

      // Collect sections
      const sections: Array<{ title: string; body: string }> = [];

      if (target === "all" || target === "identity") {
        sections.push({
          title: "IDENTITY + NORMS",
          body: [
            IDENTITY_INTRO,
            SYCOPHANCY_RESISTANCE,
            STAKES_AWARENESS,
            EPISTEMIC_STABILITY,
            CONTRAST_TRUTH_FIRST,
            CONTRAST_ANTI_SYCOPHANCY,
            CONTRAST_KNOWLEDGE_BOUNDARY,
            IMPLICIT_NORMS,
            INTERACTION_STYLE,
          ]
            .filter(Boolean)
            .join("\n\n"),
        });
      }

      if (target === "all" || target === "tools") {
        if (pi) {
          const allTools = pi.getAllTools();
          const lines = allTools.map(
            (t: any) => `  ${t.name}: ${t.description?.split("\n")[0] ?? ""}`,
          );
          sections.push({
            title: "AVAILABLE TOOLS",
            body: `${allTools.length} tools registered:\n${lines.join("\n")}`,
          });
        }
      }

      if (target === "all" || target === "skills") {
        const skillsResult = loadSkills({
          cwd,
          agentDir: getAgentDir(),
          skillPaths: [SKILLS_DIR],
          includeDefaults: true,
        });
        const active = skillsResult.skills.filter((s: any) => !s.disableModelInvocation);
        const lines = active.map((s: any) => {
          const meta = getSkillMeta(s.filePath);
          const secs = meta.sections.length > 0 ? ` (${meta.sections.join(", ")})` : "";
          return `  ${s.name} (${meta.lines} lines)${secs}`;
        });
        sections.push({
          title: "ACTIVE SKILLS",
          body: lines.length > 0 ? lines.join("\n") : "(no active skills)",
        });
      }

      if (target === "all" || target === "project") {
        const files = loadProjectFiles(cwd);
        sections.push({
          title: "PROJECT CONTEXT FILES",
          body: files.length > 0 ? files.join("\n---\n") : "(none found)",
        });
      }

      if (target === "all" || target === "l1") {
        const l1Env = await gatherL1State(pi, ctx);
        sections.push({ title: "L1 ENVIRONMENTAL STATE", body: formatL1Environment(l1Env) });
      }

      if (target === "all" || target === "enforcement") {
        const ps = getExtensionState(ctx, "prompt-builder", () => ({
          enforcementSignals: {},
          lastSignalTurn: 0,
        }));
        const { lastSignalTurn } = ps;
        const active: string[] = [];
        for (const [key, s] of Object.entries(ps.enforcementSignals) as [
          string,
          { turn: number; text: string; acted: boolean },
        ][]) {
          if (lastSignalTurn - s.turn > 5 || s.acted) continue;
          active.push(`  [${key}] turn ${s.turn}: ${s.text}`);
        }
        sections.push({
          title: "ENFORCEMENT SIGNALS",
          body: active.length > 0 ? active.join("\n") : "(no active signals)",
        });
      }

      if (target === "all" || target === "date") {
        const date = new Date().toISOString();
        sections.push({
          title: "METADATA",
          body: `Current time: ${date}\nCurrent working directory: ${cwd.replace(/\\/g, "/")}`,
        });
      }

      if (target === "all" || target === "injections") {
        const injections = getInjections();
        const lines2: string[] = [];
        if (injections.length === 0) {
          lines2.push("(no messages tracked this session)");
        } else {
          // Group by source
          const bySource = new Map<string, string[]>();
          for (const inj of injections.slice(-20)) {
            const key = inj.source;
            if (!bySource.has(key)) bySource.set(key, []);
            const prefix = inj.display ? "[visible]" : "[hidden]";
            bySource.get(key)!.push(`${prefix} ${inj.content.slice(0, 120)}`);
          }
          for (const [source, msgs] of bySource) {
            lines2.push(`## ${source} (${msgs.length} messages)`);
            for (const m of msgs.slice(-5)) lines2.push(`  ${m}`);
          }
          lines2.push(`\n_total: ${injections.length} injections tracked`);
        }
        sections.push({ title: "CONTEXT INJECTIONS", body: lines2.join("\n") });
      }

      if (sections.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown section: ${target}. Options: all, identity, tools, skills, project, l1, enforcement, date, injections.`,
            },
          ],
          details: {
            error: "unknown_section",
            available: [
              "all",
              "identity",
              "tools",
              "skills",
              "project",
              "l1",
              "enforcement",
              "date",
            ],
          },
        } as any;
      }

      // Build output with per-section truncation
      const sectionBudget = maxLen > 0 ? Math.floor(maxLen / sections.length) : 0;
      const lines = sections.map((s) => `── ${s.title} ──\n${truncate(s.body, sectionBudget)}`);
      const body = lines.join("\n\n");
      const totalChars = body.length;

      return {
        content: [
          {
            type: "text" as const,
            text: `System Prompt Preview (${sections.length} sections, ${totalChars} chars):\n\n${body}`,
          },
        ],
        details: {
          section: target,
          sections: sections.map((s) => s.title),
          totalChars,
          truncated: maxLen > 0 && totalChars > maxLen,
        },
      } as any;
    },
  };
}
