/**
 * Skills-loading directive, owned by the skills-tool module.
 *
 * The skills-tool module owns the strategy text for using its own tool;
 * prompt-builder imports it and renders it as the "skills-loading" section
 * ONLY when both `read` and `list_skills` are active tools.
 *
 * Current rule: task-start list_skills puts the full catalog (name, path,
 * purpose) in view so the domain-match trigger is decidable; the catalog
 * one-liner is metadata, the SKILL.md path is the knowledge — no skill
 * content is injected into the prompt. The trigger has a mechanical form
 * (a tool call whose family word appears in a skill's name) because the
 * judgment form loses sessions that are inside a skill's domain by
 * construction. Decision logic lives in the prompt, mechanics in tool
 * descriptions (strategy-only contract; each fact in exactly one place).
 *
 * The mechanical trigger's worked examples are derived at assembly time from
 * the live tool and skill names (mechanicalTriggerExamples): a tool's family
 * token paired with an installed visible skill's dash-token. The text never
 * hardcodes a tool or skill name, so it cannot name a pair that does not
 * exist in the running session; when no pair computes, the sentence renders
 * without a parenthetical.
 */

/** Paragraph 1: the discovery rule (pinned verbatim by test-prompt-budget.mjs). */
export const SKILLS_DISCOVERY_RULE = `You discover skills on demand, not in advance: at the start of a task, call list_skills once to see the catalog (name, path, purpose). When the task enters a listed skill's domain, read the WHOLE SKILL.md before acting in that domain; never act from memory of a skill's contents.`;

/** Paragraph 2: the pointer rule (pinned verbatim by test-prompt-budget.mjs). */
export const SKILLS_POINTER_RULE = `Pointer rule: the catalog one-liner is metadata, not content — the SKILL.md path is the knowledge. Mid-task, enter a domain absent from the visible catalog → call list_skills again (catalog is paginated). The prompt already covering the domain is the only reason to skip the read.`;

const MECHANICAL_TRIGGER_LEAD = `Mechanical trigger, no judgment call: about to use a tool family whose word appears in a skill's name`;
const MECHANICAL_TRIGGER_TAIL = `→ read that SKILL.md before the first call in the family.`;

/**
 * Worked examples for the mechanical trigger, derived from the live inputs.
 *
 * A pair exists when a tool's family token (the first underscore-delimited
 * token of the tool name: `herdr_layout` → `herdr`) equals a dash-delimited
 * token of a skill name (`herdr-topology` → `herdr`), case-insensitively.
 * One example renders per distinct family token: the trigger fires per
 * family ("before the first call in the family"), so enumerating every tool
 * in a family would restate one fact; the representative tool is the
 * lexicographically smallest active tool carrying that token. The arrow
 * target keeps the skill's own casing. Sorted by family token, so identical
 * inputs render byte-identical text in any input order, and no tool or skill
 * outside the inputs is ever named.
 */
export function mechanicalTriggerExamples(toolNames: string[], skillNames: string[]): string[] {
  // Family token (lowercased) -> lexicographically smallest active tool name.
  const familyTool = new Map<string, string>();
  for (const tool of toolNames) {
    const family = tool.split("_")[0].toLowerCase();
    const incumbent = familyTool.get(family);
    if (incumbent === undefined || tool < incumbent) familyTool.set(family, tool);
  }
  // Family token (lowercased) -> the matched skill token in the skill's own
  // casing, taken from the lexicographically smallest matching skill name
  // (order-independent when several skills spell the token differently).
  const tokenCasing = new Map<string, { casing: string; skill: string }>();
  for (const skill of skillNames) {
    for (const token of skill.split("-")) {
      if (!token) continue;
      const family = token.toLowerCase();
      if (!familyTool.has(family)) continue;
      const incumbent = tokenCasing.get(family);
      if (incumbent === undefined || skill < incumbent.skill) {
        tokenCasing.set(family, { casing: token, skill });
      }
    }
  }
  return [...tokenCasing.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([family, { casing }]) => `\`${familyTool.get(family)}\` → ${casing}`);
}

/**
 * The full skills-loading text: discovery rule, pointer rule, and the
 * mechanical trigger with only the pairs computed from the given tool and
 * skill names. prompt-builder feeds it the active tool names and the
 * skills-tool module's visible-catalog names.
 */
export function skillsLoadingText(toolNames: string[], skillNames: string[]): string {
  const examples = mechanicalTriggerExamples(toolNames, skillNames);
  const trigger =
    examples.length > 0
      ? `${MECHANICAL_TRIGGER_LEAD} (${examples.join(", ")}) ${MECHANICAL_TRIGGER_TAIL}`
      : `${MECHANICAL_TRIGGER_LEAD} ${MECHANICAL_TRIGGER_TAIL}`;
  return `${SKILLS_DISCOVERY_RULE}\n\n${SKILLS_POINTER_RULE}\n\n${trigger}\n`;
}
