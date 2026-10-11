/**
 * Pi-reference pointer section for the prompt-builder.
 *
 * The pi-reference skill owns pi's topic-to-doc index; the prompt carries
 * only a pointer to it. Inlining the path list would ride every prompt turn
 * and duplicate the skill's catalog.
 *
 * The pointer is static text on purpose: a missing skill or a missing
 * list_skills tool costs the pointer its target, never prompt assembly. The
 * skill's index resolves paths against pi-core's install directory, which the
 * prompt does not carry, so the second line names system_info as the
 * source and keeps the pointer actionable on its own.
 */
import type { PromptSection } from "./section.js";

export const PI_REFERENCE_POINTER = [
  "Pi itself (SDK, extensions, skills, themes, TUI, prompts, keybindings, models, providers, RPC, sessions, settings, CLI, internals): read the pi-reference skill (list_skills) — it carries the docs index and install paths.",
  'Docs paths in that index are relative to pi-core\'s install directory; system_info reports it as "Core".',
].join("\n");

export function piReferenceSection(): PromptSection {
  return {
    name: "pi-docs",
    render: () => PI_REFERENCE_POINTER,
  };
}
