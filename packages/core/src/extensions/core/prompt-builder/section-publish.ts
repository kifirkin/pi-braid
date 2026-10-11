/**
 * Publish braid's composed prompt through pi's section seam.
 *
 * braid publishes through the section seam rather than a single opaque
 * `systemPrompt`: one string would re-send the whole head prompt on any
 * change, while named sections are diffed against the transcript, so a change
 * re-sends that section alone.
 *
 * Publishing splits braid's prompt in two:
 *   - the stable group rides `customPrompt`, which pi renders as the untagged
 *     `preamble` and which suppresses pi's native preamble, tools, rules, and
 *     docs;
 *   - the turn-to-turn text rides named `sections` entries, each wrapped in a
 *     tag of its own name.
 *
 * Native sections braid replaces would otherwise reach the model, so they
 * are neutralized here. Caller-supplied
 * section entries are replaced as well: the caller must have read them out
 * first (the handler renders them inside the stable group), because pi renders
 * every `sections` entry verbatim and leaving them in the map would render
 * each one twice.
 */
import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

/**
 * Write braid's sections into the live prompt options. Mutates in place: pi
 * hands the handler a normalized, mutable options object and reads it back
 * after every handler has run.
 */
export function publishPromptSections(
  options: NormalizedBuildSystemPromptOptions,
  stablePrompt: string,
  volatileSections: Record<string, string>,
): void {
  // project_context: braid renders pointer-only project docs, read on demand.
  options.contextFiles = [];
  // skills: list_skills serves discovery; no skill catalog is inlined.
  options.skills = [];
  // addendum: braid re-appends appendSystemPrompt as its own deduped section.
  options.appendSystemPrompt = "";
  options.sections = volatileSections;
  options.customPrompt = stablePrompt;
}
