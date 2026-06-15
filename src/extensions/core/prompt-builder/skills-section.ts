/**
 * Skills section for the prompt-builder.
 *
 * Formats the resolved skill set as a `<available_skills>` block with
 * braid-specific enhancements (`<lines>` and `<sections>` per skill).
 *
 * Mirrors the native pi format (one <skill> entry per resolved skill
 * with name, description, and location) plus braid enhancements: each
 * entry also carries `<lines>` and `<sections>` so the agent can size
 * up a skill before reading the full file. No relevance scoring, no
 * cap, no hidden list - every skill the loader produced is here, so
 * the agent can always `read` any of them on demand. Skills with
 * `disable-model-invocation: true` are excluded, matching native.
 *
 * Cache: the rendered string is cached per-skill-set fingerprint so
 * we don't re-read every SKILL.md on every turn. Invalidated when
 * the set of loaded skills changes (e.g. after /reload or session
 * start) via `resetSkillsSectionCache()`.
 */

import { readFile } from "node:fs/promises";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { PromptSection } from "./section.js";

/** Skill metadata: line count and section headings. */
interface SkillMeta {
  totalLines: number;
  sections: string[];
}

/** Count lines and extract `## / ###` section headings from a SKILL.md. */
async function getSkillMeta(skill: Skill): Promise<SkillMeta> {
  try {
    const content = await readFile(skill.filePath, "utf-8");
    const lines = content.split("\n");
    const sections: string[] = [];
    for (const line of lines) {
      const match = line.match(/^#{2,3}\s+(.+)$/);
      if (match) sections.push(match[1].trim());
    }
    return { totalLines: lines.length, sections: sections.slice(0, 8) };
  } catch {
    return { totalLines: 0, sections: [] };
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Build the `<available_skills>` section. Returns empty string if no skills. */
export async function skillsSection(skills: Skill[]): Promise<PromptSection> {
  return {
    name: "skills",
    render: async () => {
      const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
      if (visibleSkills.length === 0) {
        return "";
      }

      // Sort alphabetically for stable, predictable output. No scoring, no cap.
      const sorted = [...visibleSkills].sort((a, b) => a.name.localeCompare(b.name));

      const lines = [
        "Skills are your first knowledge in context. Read all of the relevant ones with `read` tool before starting a task.",
        "<available_skills>",
      ];

      for (const skill of sorted) {
        const meta = await getSkillMeta(skill);
        lines.push("  <skill>");
        lines.push(`    <name>${escapeXml(skill.name)}</name>`);
        lines.push(`    <description>${escapeXml(skill.description)}</description>`);
        lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
        lines.push(`    <lines>${meta.totalLines}</lines>`);
        if (meta.sections.length > 0) {
          lines.push(`    <sections>${meta.sections.join(" | ")}</sections>`);
        }
        lines.push("  </skill>");
      }

      lines.push("</available_skills>");
      return lines.join("\n");
    },
  };
}

// Cache the rendered string per skill-set fingerprint. Per-session: skills
// discovery is workspace-scoped and may differ across sessions. The cache
// is invalidated by `resetSkillsSectionCache(ctx)` on `RESOURCES_DISCOVER`.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getExtensionState } from "../../../lib/state/extension-state.js";

interface SkillsCacheState {
  fingerprint?: string;
  section?: string;
}

/** Stable, order-independent fingerprint of a skill set. */
export function fingerprintSkills(skills: readonly Skill[]): string {
  return skills
    .map((s) => `${s.name}\u0000${s.filePath}`)
    .sort()
    .join("\n");
}

/** Get the cached section if the fingerprint matches, otherwise render + cache. */
export async function reconstructSkillsSection(
  skills: readonly Skill[],
  ctx: ExtensionContext,
): Promise<string> {
  const fingerprint = fingerprintSkills(skills);
  const cache = getExtensionState<SkillsCacheState>(
    ctx,
    "prompt-builder/skills-cache",
    () => ({ fingerprint: undefined, section: undefined }),
  );
  if (cache.fingerprint === fingerprint && cache.section !== undefined) {
    return cache.section;
  }
  // Render immediately so the cache holds the final string. The fingerprint
  // already captures the input identity; we don't need to re-derive the
  // PromptSection on cache hits.
  const section = await (await skillsSection(skills as Skill[])).render();
  cache.fingerprint = fingerprint;
  cache.section = section;
  return section;
}

/** Invalidate the cache. Called on `RESOURCES_DISCOVER`. */
export function resetSkillsSectionCache(ctx: ExtensionContext): void {
  const cache = getExtensionState<SkillsCacheState>(
    ctx,
    "prompt-builder/skills-cache",
    () => ({ fingerprint: undefined, section: undefined }),
  );
  cache.fingerprint = undefined;
  cache.section = undefined;
}
