/**
 * Resources section for the prompt-builder.
 *
 * Renders a consolidated Resources block showing skill/memory counts.
 * Skill discovery is pulled on demand via the `list_skills` tool — the
 * full catalog (paths, descriptions, sources) is NOT rendered in-prompt
 * to avoid always-on bloat. This applies the "signal not noise" principle:
 * the prompt carries only what serves the current task; skill discovery
 * is pulled, not pushed.
 *
 * Extracted from instance-composition.ts (2026-07-18) to keep the Instance
 * block focused on environment/session metadata.
 */

import type { PromptSection } from "./section.js";

export interface SkillEntry {
  name: string;
  filePath: string;
  baseDir: string;
}

export interface ResourcesContext {
  /** Skills available (from prompt-builder). */
  skillCount: number;
  /** Unique base directories for loaded skills. */
  skillDirs: string[];
  /** Skill entries for line-count rendering. */
  skills: SkillEntry[];
  /** Memory entries (from three-memory-stores). */
  memoryCount: number;
  /** Current working directory for relative path rendering. */
  cwd: string;
}

export function resourcesSection(ctx: ResourcesContext): PromptSection {
  return {
    name: "resources",
    render: async () => renderResources(ctx),
  };
}

async function renderResources(d: ResourcesContext): Promise<string> {
  const lines: string[] = [];

  if (d.skillCount > 0) {
    const mem = d.memoryCount > 0 ? ` | memory: ${d.memoryCount}` : "";
    lines.push(`Resources: ${d.skillCount} skills${mem}`);
    lines.push(
      "Skills: `list_skills` discovers paths and descriptions. Skills are domain knowledge; tools are actions.",
    );
  } else if (d.memoryCount > 0) {
    lines.push(
      `Resources: ${d.memoryCount} memor${d.memoryCount === 1 ? "y" : "ies"}`,
    );
  }

  if (lines.length === 0) return "";

  return lines.join("\n");
}
