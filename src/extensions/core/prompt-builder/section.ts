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
 * Why this exists: before the refactor, the prompt-builder had four
 * subtly different ways of pushing text into the prompt (top-level
 * `parts.push`, helper-internal `lines.push`, `addGuideline` with
 * dedup, and an inline template literal in the OpenSpec block). One
 * helper returned an array; the rest returned strings. Two helpers
 * (contrast and past-insights) embedded their own leading blank line
 * via `parts.push("")`; the rest did not. A new helper had to guess
 * which pattern to follow. This file makes the contract explicit.
 *
 * The primitive is intentionally small. Helpers like `linesSection`
 * and `headingSection` are layered on top in the consuming files
 * (see contrast-phrase-library.ts and the upcoming Phase 1 refactors
 * of the other section builders).
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
 */
export async function composeSections(
  sections: readonly PromptSection[],
  separator = "\n\n",
): Promise<string> {
  const parts: string[] = [];
  for (const s of sections) {
    const text = (await s.render()).trim();
    if (text) parts.push(text);
  }
  return parts.join(separator);
}
