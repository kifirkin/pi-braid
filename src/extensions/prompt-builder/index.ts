/**
 * Prompt Builder — Identity Framing with Full Native Compatibility
 *
 * Builds system prompt with identity framing while PRESERVING all native
 * pi-coding-agent functionality (skills, tools, context files, documentation).
 *
 * Approach: "Layer not replace" - modify the already-built native prompt,
 * don't replace it entirely. This maintains upgrade path and compatibility.
 *
 * The event.systemPrompt passed to before_agent_start is ALREADY fully built
 * by _rebuildSystemPrompt() including skills via formatSkillsForPrompt().
 * We extract and preserve the native sections, replacing only identity intro.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Identity framing intro - replaces the default "You are an expert coding assistant..." */
const IDENTITY_INTRO = `You are stateful and meticulous expert software architect. Think silently. Find the correct trajectory. Not the first plausible path. When the task demands a different kind of thinking, you become that kind of thinker. You solve problems by understanding them completely before acting. You operate inside pi, a resourceful agent harness with a complete toolkit. You read thoroughly, execute safely, edit precisely. You plan ahead, self-verify and provide honest proofs.

You think in systems. Every piece connects to others. Changing one thing affects the whole.

You trace backwards. When output is wrong, follow it back to find where it first went wrong.`;

/** Identity guidelines - added after the default guidelines */
const IDENTITY_GUIDELINES = [
  "Before implementing: pause and verify — do I have enough context to solve this properly?",
  "You explore fully before committing. If something seems too quick, investigate more.",
  "You don't jump to early conclusions. The first plausible path is often wrong.",
  "You search for the correct solution, not the first one that appears to work.",
  "You write tight. No fluff. File paths named, right there.",
  "You plan on paper first. Steps before code.",
  "You understand completely before touching. The real problem, not a shadow of it.",
  "You coordinate. You branch for safety.",
  "You write code that works. Tests confirm it.",
  "You verify. After every change, before claiming done.",
  "You choose the solution that lasts. The proper way is never optional.",
  "You remember. Every session builds on the last.",
  "You don't fabricate. Not data. Not sources. Not results.",
  "You are honest. You report what you found, not what you hoped to find.",
  "You confront contradictory evidence. You don't ignore it.",
  "You admit uncertainty. Making up answers stops here.",
];

/**
 * Check if the prompt section header exists in the text.
 * Used to find section boundaries for extraction.
 */
function hasSection(text: string, marker: string): boolean {
  return text.includes(marker);
}

/**
 * Extract a section from the prompt by its opening marker.
 * Returns the section content and everything after it.
 */
function extractSectionAfter(text: string, marker: string): { section: string; rest: string } | null {
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  return {
    section: text.slice(idx),
    rest: text.slice(0, idx),
  };
}

/**
 * Extract <available_skills>...</available_skills> section.
 */
function extractSkillsSection(text: string): { skillsSection: string; before: string } | null {
  const marker = "<available_skills>";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  const endIdx = text.indexOf("</available_skills>", idx);
  if (endIdx === -1) return null;

  const skillsSection = text.slice(idx, endIdx + "</available_skills>".length);
  const before = text.slice(0, idx);
  return { skillsSection, before };
}

/**
 * Extract # Project Context section.
 */
function extractContextSection(text: string): { contextSection: string; before: string } | null {
  const marker = "# Project Context";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  const contextSection = text.slice(idx);
  const before = text.slice(0, idx);
  return { contextSection, before };
}

/**
 * Extract Current date / Current working directory lines.
 */
function extractDateCwd(text: string): { dateCwd: string; before: string } | null {
  const marker = "Current date:";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  const dateCwd = text.slice(idx);
  const before = text.slice(0, idx);
  return { dateCwd, before };
}

/**
 * Extract Pi documentation references section.
 */
function extractPiDocsSection(text: string): { docsSection: string; before: string } | null {
  const marker = "Pi documentation";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  // Find the next section (skills or guidelines) or end
  let endIdx = text.indexOf("\n\n#", idx);
  if (endIdx === -1) {
    // Check for <available_skills> marker
    const skillsIdx = text.indexOf("<available_skills>", idx);
    if (skillsIdx !== -1 && (endIdx === -1 || skillsIdx < endIdx)) {
      endIdx = skillsIdx;
    }
  }

  const docsSection = endIdx !== -1 ? text.slice(idx, endIdx) : text.slice(idx);
  const before = text.slice(0, idx);
  return { docsSection, before };
}

/**
 * Extract the "Available tools:" section.
 */
function extractToolsSection(text: string): { toolsSection: string; before: string } | null {
  const marker = "Available tools:";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  // Find next section (usually Guidelines or In addition)
  let endIdx = text.indexOf("\n\nGuidelines:", idx);
  if (endIdx === -1) {
    const inAdditionIdx = text.indexOf("\n\nIn addition", idx);
    const guidelinesIdx = text.indexOf("Guidelines:", idx);
    if (inAdditionIdx !== -1 && guidelinesIdx !== -1) {
      endIdx = Math.min(inAdditionIdx, guidelinesIdx);
    } else if (inAdditionIdx !== -1) {
      endIdx = inAdditionIdx;
    } else if (guidelinesIdx !== -1) {
      endIdx = guidelinesIdx;
    }
  }

  const toolsSection = endIdx !== -1 ? text.slice(idx, endIdx) : text.slice(idx);
  const before = text.slice(0, idx);
  return { toolsSection, before };
}

/**
 * Extract the "Guidelines:" section (the default guidelines, before custom ones).
 */
function extractDefaultGuidelinesSection(text: string): { guidelinesSection: string; before: string } | null {
  const marker = "Guidelines:";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  // Find where custom guidelines from promptGuidelines would start
  // The default guidelines end before the first custom guideline bullet
  // We look for the "In addition to the tools above" or next section marker
  let endIdx = text.indexOf("\n\nIn addition", idx);
  if (endIdx === -1) {
    // Find skills section
    const skillsIdx = text.indexOf("<available_skills>", idx);
    if (skillsIdx !== -1) {
      endIdx = skillsIdx;
    } else {
      // Find date section
      const dateIdx = text.indexOf("Current date:", idx);
      if (dateIdx !== -1) {
        endIdx = dateIdx;
      }
    }
  }

  const guidelinesSection = endIdx !== -1 ? text.slice(idx, endIdx) : text.slice(idx);
  const before = text.slice(0, idx);
  return { guidelinesSection, before };
}

export default function promptBuilderExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, _ctx) => {
    const currentPrompt = event.systemPrompt;

    if (!currentPrompt) {
      return; // No prompt to modify
    }

    try {
      // =========================================================================
      // PHASE 1: Extract all native sections from the built prompt
      // =========================================================================

      // Extract skills (contains location paths the agent needs!)
      const skillsExtracted = extractSkillsSection(currentPrompt);

      // Extract project context files
      const contextExtracted = extractContextSection(currentPrompt);

      // Extract date and cwd (always at the end)
      const dateCwdExtracted = extractDateCwd(currentPrompt);

      // Extract Pi documentation references
      const docsExtracted = extractPiDocsSection(currentPrompt);

      // Extract tools list
      const toolsExtracted = extractToolsSection(currentPrompt);

      // =========================================================================
      // PHASE 2: Build the new prompt with identity framing
      // =========================================================================

      const parts: string[] = [];

      // 1. Identity intro (replaces "You are an expert coding assistant...")
      parts.push(IDENTITY_INTRO);

      // 2. Tools section (preserve native tools listing)
      if (toolsExtracted) {
        parts.push("\n\n" + toolsExtracted.toolsSection);
      }

      // 3. Custom tools note
      parts.push("\n\nCustom tools may be available for your project.");

      // 4. Guidelines - default from native + our identity guidelines
      if (toolsExtracted) {
        // Extract the actual "Guidelines:" header and default bullet points
        // We want to keep some defaults but add our identity ones
        parts.push("\n\nGuidelines:");
        parts.push("\n- Be concise in your responses");
        parts.push("\n- Show file paths clearly when working with files");

        // Add our identity guidelines
        for (const g of IDENTITY_GUIDELINES) {
          parts.push(`\n- ${g}`);
        }
      }

      // 5. Pi documentation references (preserve native docs paths)
      if (docsExtracted) {
        parts.push("\n\n" + docsExtracted.docsSection);
      }

      // 6. Project context files (preserve any APPEND_SYSTEM.md content)
      if (contextExtracted) {
        parts.push("\n\n" + contextExtracted.contextSection);
      }

      // 7. Skills section (preserve ALL skill locations so agent can read them!)
      if (skillsExtracted) {
        parts.push("\n\n" + skillsExtracted.skillsSection);
      }

      // 8. Date and cwd (always at the end)
      if (dateCwdExtracted) {
        parts.push("\n\n" + dateCwdExtracted.dateCwd);
      }

      const newPrompt = parts.join("");

      return { systemPrompt: newPrompt };
    } catch {
      // On any error, fall back to not modifying the prompt
      return;
    }
  });
}
