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

function escapeAttr(str: string): string {
  // Only escape " to prevent breaking the "-delimited XML attribute.
  // All other XML-unsafe characters (&, <, >) are valid in XML attribute
  // values and are already stripped/replaced by normalizeDescription().
  // We avoid HTML entities entirely — the agent reads this as plain text.
  return str.replace(/"/g, "'");
}

/**
 * Aggressively normalize a skill description for the pointer block.
 * Handles:
 *   - NFKC normalization (decomposes fancy Unicode)
 *   - Unicode dashes (em, en, etc.) -> ASCII `-`
 *   - Smart single/double quotes -> ASCII `'` / `"`
 *   - Special spaces -> regular space
 *   - Unicode ellipsis -> ASCII `...`
 *   - XML-unsafe characters stripped/replaced BEFORE escapeXml runs,
 *     so the agent never sees HTML entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`)
 *   - Arrows kept as Unicode (no ASCII `->` that would produce `&gt;`)
 *   - Truncation beyond SOFT_LIMIT with sentence/word boundary awareness
 *
 * Mirrors pi-core's normalizeForFuzzyMatch patterns plus XML safety.
 */

const MAX_DESC_LEN = 280;
const SOFT_LIMIT = 320;

function normalizeDescription(raw: string): string {
  let s = raw
    .normalize("NFKC")
    // ── Unicode normalization ──────────────────────────────────────
    // Smart quotes
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // Dashes
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    // Special spaces
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
    // Unicode ellipsis -> ASCII ...
    .replace(/[\u2026]/g, "...")
    // ── XML-unsafe character cleanup ───────────────────────────────
    // These would otherwise become &amp; &lt; &gt; &quot; after escapeXml().
    // The agent reads the raw text and shouldn't see HTML entities.
    .replace(/&/g, "and")           // & -> and (never belongs in plain text)
    .replace(/[<>]/g, "")           // strip < > (not useful in descriptions)
    .replace(/"/g, "'")            // " -> ' (safe inside "-delimited attrs)
    // ── Final cleanup ──────────────────────────────────────────────
    // Collapse multiple spaces
    .replace(/  +/g, " ")
    .trim();

  // Soft cap: allow up to SOFT_LIMIT without truncation.
  // Only truncate beyond that, preferring sentence boundaries.
  if (s.length > SOFT_LIMIT) {
    // Try sentence boundary first (within the first MAX_DESC_LEN chars)
    const candidate = s.slice(0, MAX_DESC_LEN + 1);
    const sentenceEnd = Math.max(
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf("! "),
      candidate.lastIndexOf("? "),
    );
    if (sentenceEnd > MAX_DESC_LEN * 0.5) {
      // Cut at sentence boundary — no ellipsis needed, sentence ends naturally
      s = s.slice(0, sentenceEnd + 1);
    } else {
      // Fall back to word boundary
      const lastSpace = candidate.lastIndexOf(" ");
      if (lastSpace > MAX_DESC_LEN * 0.5) {
        s = s.slice(0, lastSpace) + "...";
      } else {
        s = s.slice(0, MAX_DESC_LEN) + "...";
      }
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
          `  <skill name="${escapeAttr(skill.name)}" description="${escapeAttr(normalizeDescription(skill.description))}" location="${escapeAttr(skill.filePath)}" />`,
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
