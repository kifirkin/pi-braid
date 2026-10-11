/**
 * PromptSection - canonical primitive for assembling the system prompt.
 *
 * Replaces the mixed patterns of `parts.push`, `lines.push`,
 * `addGuideline`, and inline template literals with a single contract:
 *
 *   1. Every section is a `PromptSection`.
 *   2. Every section renders to a single string (never an array).
 *   3. Sections know their own boundaries and formatting.
 *   4. The main handler composes sections with `composeSections(sections)`.
 *   5. Dedup is opt-in via `linesSection(..., { dedup: true })`.
 *
 * The primitive is intentionally small. Helpers like `linesSection`
 * and `headingSection` are layered on top in the consuming files.
 */

/**
 * A self-contained string rendered into the system prompt.
 * Sections know their own boundaries and produce one string.
 */
export interface PromptSection {
  /** Stable name for logs and tests. */
  readonly name: string;
  /**
   * Render the section. Return "" (or a string that trims to "")
   * to omit the section entirely. May be async.
   */
  render(): string | Promise<string>;
}

/**
 * Compose an ordered list of sections with a section separator.
 * Empty sections (after trim) are dropped. Default separator is the
 * canonical double newline used by the rest of the prompt-builder.
 *
 * If `dedupSet` is provided, sections whose rendered output is already
 * in the set are skipped, and the set is updated with each kept section.
 * This is the canonical primitive for `appendSystemPrompt`-style dedup
 * (where user-provided content may duplicate a static section).
 */
export async function composeSections(
  sections: readonly PromptSection[],
  separator = "\n\n",
  dedupSet?: Set<string>,
): Promise<string> {
  const parts: string[] = [];
  for (const s of sections) {
    const text = (await s.render()).trim();
    if (!text) continue;
    if (dedupSet) {
      if (dedupSet.has(text)) continue;
      dedupSet.add(text);
    }
    parts.push(text);
  }
  return parts.join(separator);
}

/**
 * Compose sections into a `name -> text` map, with the same empty-skip and
 * dedup semantics as `composeSections`. For callers that need the sections
 * kept apart rather than joined: pi's prompt options carry a `sections`
 * record whose entries it wraps and diffs individually, so a change to one
 * entry re-sends that entry alone.
 *
 * A section whose text was already consumed by `dedupSet` is omitted from the
 * map, so the caller can omit it the way `composeSections` would.
 */
export async function composeSectionMap(
  sections: readonly PromptSection[],
  dedupSet?: Set<string>,
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const s of sections) {
    const text = (await s.render()).trim();
    if (!text) continue;
    if (dedupSet) {
      if (dedupSet.has(text)) continue;
      dedupSet.add(text);
    }
    map[s.name] = text;
  }
  return map;
}

// Section builders. Canonical ways to construct a PromptSection; each
// enforces one rule: the section returns a single string. Internal line
// arrangement is the builder's concern; the section as a whole is opaque
// to the top-level handler.

/**
 * A single block of text. Trims the content; emits "" if empty.
 * Use for sections that have no internal structure (identity, footer,
 * interaction style, etc.).
 */
export function simpleSection(name: string, content: string): PromptSection {
  return {
    name,
    render: () => content.trim(),
  };
}

/**
 * A section that joins an ordered list of lines with "\n".
 *
 * - Trims each line and drops empties.
 * - `dedup: true` skips duplicate lines.
 * - Use for guideline lists and other line-shaped sections.
 */
export function linesSection(
  name: string,
  lines: readonly string[],
  opts: { dedup?: boolean } = {},
): PromptSection {
  return {
    name,
    render: () => {
      const seen = opts.dedup ? new Set<string>() : null;
      const out: string[] = [];
      for (const l of lines) {
        const t = l.trim();
        if (!t) continue;
        if (seen) {
          if (seen.has(t)) continue;
          seen.add(t);
        }
        out.push(t);
      }
      return out.join("\n");
    },
  };
}

/**
 * A section with a markdown heading prefix.
 *
 * - Renders to `## ${heading}\n${body}`.
 * - Returns "" if the body (after trim) is empty.
 * - Use for headed sections (project-docs block, etc.).
 */
export function headingSection(name: string, heading: string, body: string): PromptSection {
  return {
    name,
    render: () => {
      const trimmed = body.trim();
      if (!trimmed) return "";
      return `## ${heading}\n${trimmed}`;
    },
  };
}
