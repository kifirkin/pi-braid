/**
 * Skills section for the prompt-builder.
 *
 * Formats the resolved skill set as a `<available_skills>` block.
 *
 * Each entry carries the discoverability triple (name + description + location)
 * so the agent can pattern-match relevant skills without reading every SKILL.md.
 * Descriptions come from skill frontmatter (already loaded by pi-core) -- no
 * extra file reads for the pointer block. The agent reads the full SKILL.md
 * on demand when a description matches the current task.
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
  // Only escape characters that are REQUIRED for XML attribute safety
  // when the attribute is delimited by double quotes:
  //   &, <, >, "
  // NOTE: ' (single quote) does NOT need escaping inside "-delimited attributes.
  // Removing it avoids confusing &apos; entities in the agent's system prompt.
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Normalize a skill description for safe, compact rendering in the pointer
 * block. Handles:
 *   - Unicode dashes (em, en, etc.) -> ASCII `-`
 *   - Smart single/double quotes -> ASCII `'` / `"`
 *   - Special spaces -> regular space
 *   - Arrows: kept as Unicode (no replacement — `->` and `=>` both contain `>`
 *     which XML-escapes to `&gt;`; Unicode arrows pass through untouched)
 *   - Unicode ellipsis (...) -> ASCII `...`
 *   - Truncates to MAX_DESC_LEN characters (word-boundary aware)
 *
 * Mirrors pi-core's normalizeForFuzzyMatch patterns, plus arrow handling.
 * The result must be safe for XML attribute values after escapeXml().
 */
const MAX_DESC_LEN = 280;

function normalizeDescription(raw: string): string {
  let s = raw
    .normalize("NFKC")
    // Smart quotes
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // Dashes
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    // Special spaces
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
    // Arrows: kept as Unicode. No replacement — `->`/`=>` contain `>`
    // which escapeXml would turn into `&gt;`. Unicode arrows (→, ⇒, etc.)
    // pass through escapeXml untouched since they're not XML-special chars.
    // Note: the regex is commented out, not removed, to preserve the
    // original intent for any future reader.
    // .replace(/[\u2190-\u2199\u21D0-\u21D9\u27A1]/g, "->")
    // Unicode ellipsis -> ASCII three dots
    .replace(/[\u2026]/g, "...")
    // Collapse multiple spaces (from replacements)
    .replace(/  +/g, " ")
    .trim();

  // Truncate at word boundary
  if (s.length > MAX_DESC_LEN) {
    const truncated = s.slice(0, MAX_DESC_LEN);
    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > MAX_DESC_LEN * 0.6) {
      s = truncated.slice(0, lastSpace) + "...";
    } else {
      s = truncated + "...";
    }
  }

  return s;
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
        `Skills (${sorted.length} available): procedural guides for specialized domains. Before starting a task, scan the skills below. If a skill's description matches your current work, \`read <location>\` the full SKILL.md and follow its instructions. Skills are not optional hints -- they contain executable procedures.`,
        "<available_skills>",
      ];

      for (const skill of sorted) {
        lines.push(
          `  <skill name="${escapeXml(skill.name)}" description="${escapeXml(normalizeDescription(skill.description))}" location="${escapeXml(skill.filePath)}" />`,
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
