/**
 * Skills section for the prompt-builder.
 *
 * Formats the resolved skill set as a `<available_skills>` block.
 *
 * Each entry has name, description, and location - mirroring native
 * pi's format. No per-skill file reads, no line counts, no section
 * lists: the agent already knows how to `read` a SKILL.md, and 400
 * lines is cheap to read on demand. Keeping the block terse matters
 * more than embedding metadata the agent will rarely consult.
 *
 * No relevance scoring, no cap, no hidden list - every skill the
 * loader produced is here, so the agent can always `read` any of
 * them on demand. Skills with `disable-model-invocation: true` are
 * excluded, matching native.
 *
 * Cache: the rendered string is cached per-skill-set fingerprint so
 * we don't re-render on every turn. Invalidated when the set of
 * loaded skills changes (e.g. after /reload or session start) via
 * `resetSkillsSectionCache()`.
 */

import type { Skill } from "@earendil-works/pi-coding-agent";
import type { PromptSection } from "./section.js";

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
        `Skills (${sorted.length} available): use \`read <location>\` to inspect a SKILL.md when relevant. Descriptions live in the files, not in this block.`,
        "<available_skills>",
      ];

      for (const skill of sorted) {
        lines.push(
          `  <skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}" />`,
        );
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
