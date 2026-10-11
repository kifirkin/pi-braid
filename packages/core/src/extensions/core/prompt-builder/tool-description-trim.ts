/**
 * Tool-description trim — progressive
 * disclosure for third-party npm extensions whose registered tool
 * descriptions are long.
 *
 * MECHANISM NOTE: the registered
 * `description` reaches the model through the API tools channel —
 * wrapToolDefinition copies it by value into the AgentTool that lands in
 * agent.state.tools, and the provider payload carries it verbatim. There is
 * no earlier interception point an extension legitimately has:
 *   - `pi.registerTool` same-name re-registration cannot work: the runner
 *     keeps the FIRST registration per name across extensions (braid loads
 *     before pi-herdr per the settings packages order, so braid would shadow
 *     the real tool's execute; a late registration is silently ignored).
 *   - `pi.getAllTools()` returns copies; no live-definition accessor and no
 *     `refreshTools` is exposed on the extension API.
 *   - `transformContext` sees messages only; `before_agent_start` shapes the
 *     system prompt, which braid's toolsSection already renders as one line
 *     per tool from the tool's own `promptGuidelines[0]`.
 * `before_provider_request` is the official seam: it fires after the
 * provider-specific payload is built and a returned payload replaces the
 * request. This module rewrites ONLY the `description` field of tools whose
 * name matches the trim rules below; names, parameters, and every other
 * field pass through untouched. Input objects are never mutated — changed
 * entries are shallow-copied.
 *
 * Dependency-inversion compatibility: descriptions remain owned by the
 * registering package. The curated strings below only SHORTEN the channel
 * form and point at the herdr-topology SKILL for the deep form
 * (progressive disclosure). The when-gate ("only when the user explicitly
 * mentions Herdr") is load-bearing and preserved in every rewrite.
 *
 * The rewrite is deterministic per tool name, so provider prompt caching is
 * stable across turns after the first trimmed request.
 */

/**
 * Curated tools-channel descriptions, 1-2 lines per tool. Keyed by tool
 * name; currently covers @ogulcancelik/pi-herdr (layout/pane/agent).
 */
export const TRIM_TOOL_DESCRIPTIONS: Record<string, string> = {
  herdr_layout:
    "Create/inspect Herdr terminal topology (workspaces, tabs, panes; layout only, never starts agents or commands). Use only when the user explicitly mentions Herdr. Read pane IDs from results; deep procedures live in the herdr-topology skill.",
  herdr_pane:
    "Raw Herdr terminal pane control: run, read, wait_output, send_text/send_keys, inspect, close. Use only when the user explicitly mentions Herdr; prefer herdr_agent for recognized coding agents. Deep procedures: herdr-topology skill.",
  herdr_agent:
    "Drive a recognized coding agent in an existing Herdr pane: start, prompt, wait, read, send_keys. Use only when the user explicitly mentions Herdr; needs an available shell pane from herdr_layout first. Deep procedures: herdr-topology skill.",
};

/** Third-party family the trim applies to (prefix match for the fallback). */
const TRIMMED_PREFIX = "herdr_";

/** The when-gate is load-bearing. */
const HERDR_GATE = "Use only when the user explicitly mentions Herdr";

/** Skill pointer appended to fallback trims (progressive disclosure home). */
const SKILL_POINTER = "Deep procedures: herdr-topology skill.";

/** Fallback trim applies only to descriptions longer than this. */
const FALLBACK_MAX_CHARS = 240;

/** Cap the description to its leading sentences within maxChars. */
function firstSentences(text: string, maxChars: number): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const sentence of sentences) {
    if (out && (out + " " + sentence).length > maxChars) break;
    out = out ? `${out} ${sentence}` : sentence;
  }
  if (!out) out = text.slice(0, maxChars);
  return out.length > maxChars ? `${out.slice(0, maxChars - 3)}...` : out;
}

/**
 * Resolve the trimmed description for one tool.
 * Returns undefined when the tool must pass through unchanged:
 * curated map miss that is not a herdr_* tool, empty/absent description,
 * or an already-short herdr description (owner's own short form wins).
 */
export function trimToolDescription(name: string, description: string): string | undefined {
  const curated = TRIM_TOOL_DESCRIPTIONS[name];
  if (curated !== undefined) return curated;
  if (!name.startsWith(TRIMMED_PREFIX)) return undefined;
  if (!description) return undefined;
  if (description.length <= FALLBACK_MAX_CHARS) return undefined;
  return `${firstSentences(description, FALLBACK_MAX_CHARS)} ${HERDR_GATE}. ${SKILL_POINTER}`;
}

/**
 * before_provider_request handler body. Rewrites tool descriptions in the
 * provider payload for trimmed tools; returns a new payload when anything
 * changed, undefined otherwise (runner contract: undefined = unchanged).
 * Handles both OpenAI-compat ({type:"function",function:{...}}) and
 * flat ({name, description, input_schema}) tool shapes. Never throws.
 */
export function trimProviderTools(payload: unknown): unknown | undefined {
  try {
    if (typeof payload !== "object" || payload === null) return undefined;
    const tools = (payload as { tools?: unknown }).tools;
    if (!Array.isArray(tools) || tools.length === 0) return undefined;

    let changed = false;
    const newTools = tools.map((tool: unknown) => {
      if (typeof tool !== "object" || tool === null) return tool;
      const entry = tool as Record<string, unknown>;
      const fn =
        typeof entry.function === "object" && entry.function !== null
          ? (entry.function as Record<string, unknown>)
          : undefined;
      const name = fn ? fn.name : entry.name;
      if (typeof name !== "string" || name.length === 0) return tool;
      const description = fn ? fn.description : entry.description;
      if (typeof description !== "string" || description.length === 0) return tool;
      const trimmed = trimToolDescription(name, description);
      if (trimmed === undefined || trimmed === description) return tool;
      changed = true;
      if (fn) return { ...entry, function: { ...fn, description: trimmed } };
      return { ...entry, description: trimmed };
    });

    if (!changed) return undefined;
    return { ...(payload as Record<string, unknown>), tools: newTools };
  } catch {
    // Any anomaly leaves the payload untouched — the request must go out.
    return undefined;
  }
}
