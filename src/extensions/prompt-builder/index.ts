/**
 * Prompt Builder - Identity Framing with 1:1 Native Structure Match
 *
 * MINIMAL identity intro only. All native sections preserved exactly.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { formatL1Environment, gatherL1State } from "./l1-environment.js";

// ── L1: Enforcement Signal Surfacing ────────────────────────────────────────
let _enforcementSignals: Record<string, { turn: number; text: string; acted: boolean }> = {};
let _lastSignalTurn = 0;

function formatEnforcementL1(signals: Record<string, { turn: number; text: string; acted: boolean }>): string {
	const keys = Object.keys(signals);
	if (keys.length === 0) return "";

	const lines = ["", "## Enforcement State", "```json"];
	const signalEntries: Record<string, unknown> = {};

	for (const key of keys) {
		const s = signals[key];
		if (_lastSignalTurn - s.turn > 5) continue;
		if (s.acted) continue;

		signalEntries[key] = {
			active: true,
			turn: s.turn,
			hint: s.text.split(" - ")[1] ?? s.text,
		};
	}

	if (Object.keys(signalEntries).length === 0) return "";

	lines.push(JSON.stringify({ signals: signalEntries }, null, 2));
	lines.push("```");

	return lines.join("\n");
}

/** MINIMAL identity intro - just essential difference from native */
// Tools = Knowledge Decompression: framing tools as essential cognition, not optional utilities
const IDENTITY_INTRO = `You are stateful and meticulous expert software architect.

Think silently. Find the correct trajectory. Not the first plausible path.

Your tools are keys to proper solutions - use them to access your full capability.
When facing complex, multi-step, or ambiguous tasks, use think() to plan, explore_paths() for multi-hypothesis analysis, and memory_recall() for similar past solutions.
For simple tasks, write code directly.

**IMPORTANT: You MUST call finalize() to mark task completion.** The session ends when finalize() is called.`

// =========================================================================
// Native section extractors
// =========================================================================

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

function extractContextSection(text: string): { contextSection: string; before: string } | null {
  const marker = "# Project Context";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  const contextSection = text.slice(idx);
  const before = text.slice(0, idx);
  return { contextSection, before };
}

function extractDateCwd(text: string): { dateCwd: string; before: string } | null {
  const marker = "Current date:";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  const dateCwd = text.slice(idx);
  const before = text.slice(0, idx);
  return { dateCwd, before };
}

function extractDocsSection(text: string): { docsSection: string; before: string } | null {
  const marker = "Pi documentation";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  let endIdx = text.indexOf("\n\n#", idx);
  if (endIdx === -1) {
    const skillsIdx = text.indexOf("<available_skills>", idx);
    if (skillsIdx !== -1) endIdx = skillsIdx;
  }

  const docsSection = endIdx !== -1 ? text.slice(idx, endIdx) : text.slice(idx);
  const before = text.slice(0, idx);
  return { docsSection, before };
}

function extractToolsSection(text: string): { toolsSection: string; before: string } | null {
  const marker = "Available tools:";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  let endIdx = text.indexOf("\n\nGuidelines:", idx);
  if (endIdx === -1) {
    const inAdditionIdx = text.indexOf("\n\nIn addition", idx);
    if (inAdditionIdx !== -1) endIdx = inAdditionIdx;
  }

  const toolsSection = endIdx !== -1 ? text.slice(idx, endIdx) : text.slice(idx);
  const before = text.slice(0, idx);
  return { toolsSection, before };
}

export default function promptBuilderExtension(pi: ExtensionAPI) {
  pi.events.on("enforcement_signals", (data: unknown) => {
    const d = data as { turn: number; signals: Record<string, { turn: number; text: string; acted: boolean }> };
    _enforcementSignals = d.signals;
    _lastSignalTurn = d.turn;
  });

  pi.on("session_start", () => {
    _enforcementSignals = {};
    _lastSignalTurn = 0;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const currentPrompt = event.systemPrompt;
    if (!currentPrompt) return;

    try {
      const l1Env = await gatherL1State(pi, ctx);

      const skillsExtracted = extractSkillsSection(currentPrompt);
      const contextExtracted = extractContextSection(currentPrompt);
      const dateCwdExtracted = extractDateCwd(currentPrompt);
      const docsExtracted = extractDocsSection(currentPrompt);
      const toolsExtracted = extractToolsSection(currentPrompt);

      const parts: string[] = [];

      // 1. Identity intro (ONLY difference)
      parts.push(IDENTITY_INTRO);

      // 2. Available tools (native)
      if (toolsExtracted) {
        parts.push("\n\n" + toolsExtracted.toolsSection);
        parts.push("\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.");
      }

      // 3. Guidelines (native only - NO identity guidelines)
      if (toolsExtracted) {
        parts.push("\n\nGuidelines:");
        parts.push("\n- Be concise in your responses");
        parts.push("\n- Show file paths clearly when working with files");
      }

      // 4. Pi documentation (native)
      if (docsExtracted) {
        parts.push("\n\n" + docsExtracted.docsSection);
      }

      // 5. Project Context (native)
      if (contextExtracted) {
        parts.push("\n\n" + contextExtracted.contextSection);
      }

      // 6. Available skills (native)
      if (skillsExtracted) {
        parts.push("\n\n" + skillsExtracted.skillsSection);
      }

      // L1: Environmental State (after native sections)
      const l1State = formatL1Environment(l1Env);
      if (l1State) {
        parts.push(l1State);
      }

      // L1: Enforcement signals
      const l1 = formatEnforcementL1(_enforcementSignals);
      if (l1) {
        parts.push(l1);
      }

      // Date and cwd (native, ALWAYS LAST)
      if (dateCwdExtracted) {
        parts.push("\n\n" + dateCwdExtracted.dateCwd);
      }

      const newPrompt = parts.join("");

      return { systemPrompt: newPrompt };
    } catch {
      return;
    }
  });
}
