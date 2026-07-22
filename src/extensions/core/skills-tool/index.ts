/**
 * list_skills tool — on-demand skill discovery.
 *
 * The full skill catalog is NOT rendered in-prompt (bloat reduction).
 * Instead, the agent calls this tool to discover skills by name,
 * description, path, and source, then reads the chosen SKILL.md via
 * the `read` tool. Tool output is transient — compact after reading.
 *
 * Populated by prompt-builder's `before_agent_start` via `setCachedSkills()`.
 * The cache lives in this module and is reset each session.
 *
 * Two actions:
 *   list    — paginated catalog (name, filePath, description, source)
 *   suggest — opt-in LLM recommendation (placeholder — use list + read)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../../../lib/core/logger.js";

const log = createLogger("skills-tool");

// ── Module-level skill cache (populated by before_agent_start) ───────────────

interface CachedSkill {
  name: string;
  filePath: string;
  description: string;
  baseDir: string;
  sourceInfo?: { source?: string; package?: string };
}

let cachedSkills: CachedSkill[] = [];

/** Called from prompt-builder's before_agent_start to populate the cache. */
export function setCachedSkills(skills: CachedSkill[]): void {
  cachedSkills = skills;
  log.debug(`Cached ${skills.length} skills for list_skills tool`);
}

/** Format a skill's source provenance for display. */
function formatSource(skill: CachedSkill): string {
  const si = skill.sourceInfo;
  if (!si) return "unknown";
  const src = si.source || "unknown";
  const pkg = si.package;
  if (pkg) return `package:${pkg}`;
  if (src === "user") return "user-global";
  if (src === "project") return "project";
  return src;
}

// ── Extension factory ────────────────────────────────────────────────────────

export default function skillsToolExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "list_skills",
    label: "List Skills",
    description:
      "Discover skills on demand. Returns paginated catalog (name, filePath, description, source). Use `read <filePath>` to load a skill. Output is transient — compact after reading what you need.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("suggest")], {
        description:
          "list = paginated catalog; suggest = LLM-recommended top-N for current project (opt-in, placeholder)",
      }),
      page: Type.Optional(
        Type.Number({
          minimum: 1,
          default: 1,
          description: "Page number for list (1-based)",
        }),
      ),
      pageSize: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 50,
          default: 10,
          description: "Entries per page for list",
        }),
      ),
    }),
    execute: async (_id, params, _signal, _onUpdate, _ctx) => {
      if (params.action === "suggest") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  note: "suggest action not yet implemented — use list + read to discover skills manually",
                  available: cachedSkills.length,
                },
                null,
                2,
              ),
            },
          ],
          details: { available: cachedSkills.length },
        };
      }

      // action = list
      const page = (params.page as number) ?? 1;
      const pageSize = (params.pageSize as number) ?? 10;
      const start = (page - 1) * pageSize;
      const slice = cachedSkills.slice(start, start + pageSize);
      const total = cachedSkills.length;
      const hasMore = start + pageSize < total;

      const skills = slice.map((s) => ({
        name: s.name,
        filePath: s.filePath,
        description: (s.description ?? "").slice(0, 280),
        source: formatSource(s),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ page, pageSize, total, hasMore, skills }, null, 2),
          },
        ],
        details: { total, page, pageSize, hasMore, returned: skills.length },
      };
    },
  });
}