/**
 * Caller-supplied `sections` passthrough for the prompt-builder.
 *
 * pi renders each caller-supplied section (SDK hosts and embedders set
 * `sections` on the prompt options) as its own named block. braid reads those
 * entries directly off the options object, with no rendered-text parsing, and
 * renders each non-empty one into its stable group: the same presentation
 * braid already uses for the native `addendum` (appendSystemPrompt) text. The
 * handler then replaces the options map with its own sections, so pi does not
 * render the caller's entries a second time.
 */
import type { PromptSection } from "./section.js";
import { simpleSection } from "./section.js";

export interface CustomSectionsOptions {
  readonly sections?: Record<string, string>;
}

/**
 * One section per non-empty caller-supplied entry, in insertion order.
 * Empty content is skipped, mirroring pi's own `if (content)` guard.
 */
export function customSectionsFrom(options: CustomSectionsOptions | undefined): PromptSection[] {
  return Object.entries(options?.sections ?? {})
    .filter(([, content]) => content.trim() !== "")
    .map(([name, content]) => simpleSection(name || "custom", content));
}
