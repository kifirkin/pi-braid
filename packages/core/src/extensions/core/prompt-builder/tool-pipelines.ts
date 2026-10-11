/**
 * Tool-usage pipelines.
 *
 * Guarded multi-tool usage pipelines, one per task domain. Each pipeline
 * teaches a composition: when to use it, the sequence, the closing outcome.
 * This replaces the cross-reference pattern ("use when conclusions depend
 * on evidence") inside tool descriptions — the pipeline is where "when"
 * lives.
 *
 * Guard semantics: EVERY tool named in `guard` must be active for the
 * pipeline to render. The prompt must never reference a tool that does
 * not exist in the current profile (tool profiles can reduce the active
 * set to ~10 tools). Each pipeline's lines therefore name its guard
 * tools verbatim — pinned by test-tool-pipelines.mjs.
 *
 * Two recipes: research, debugging. Exit lines live in the
 * SELF_MANAGEMENT identity block ("verify before finalize", "recall before
 * non-trivial work").
 *
 * Token budget: each pipeline is ≤ 3 lines; the whole section is gated
 * by tool presence, so reduced profiles render fewer pipelines.
 *
 * Excluded by design: context management pipelines — the session-tree
 * model, tag/checkout/explore pattern, archive>compact rule, and
 * health checks are already taught by `contextNavigationGuidelines` in
 * index.ts. Duplicating them here would violate the guidelines section's
 * dedup contract.
 */

/** One guardable pipeline. */
export interface ToolPipeline {
  /** Domain label — prefixes the first line of the rendered pipeline. */
  label: string;
  /** Every tool in this list must be active for the pipeline to render. */
  guard: string[];
  /** 1-3 lines: when to use it, the sequence, the closing outcome. */
  lines: string[];
}

/**
 * Ordered by task frequency. Keys are stable domain names; ordering is
 * insertion order (string keys in JS objects).
 */
export const TOOL_PIPELINES: Record<string, ToolPipeline> = {
  research: {
    label: "Research",
    guard: ["memory", "fetch_content", "read"],
    lines: [
      "recall first (memory recall_search) so you build on known context, then gather external sources with fetch_content, read them fully, and synthesize → written conclusion with sources cited.",
    ],
  },
  debugging: {
    label: "Debugging",
    guard: ["hypothesize", "explore_paths", "read"],
    lines: [
      "hypothesize the root cause — name a specific, verifiable failure mode ('file X because reason Y'), never vague 'something went wrong'",
      "explore_paths to find matching code (local find/grep/head evidence — not a sub-agent), read it, then fix properly: no monkey patches",
    ],
  },
};

/**
 * Render the pipelines whose guard tools are all active, as flat lines.
 * Each pipeline contributes `label: line[0]` plus its remaining lines.
 * Returns [] when no pipeline's guard is satisfied (caller skips the
 * section entirely).
 */
export function toolPipelineLines(toolNames: readonly string[]): string[] {
  const out: string[] = [];
  for (const pipeline of Object.values(TOOL_PIPELINES)) {
    if (!pipeline.guard.every((t) => toolNames.includes(t))) continue;
    const lines = pipeline.lines.map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    out.push(`${pipeline.label}: ${lines[0]}`);
    out.push(...lines.slice(1));
  }
  return out;
}
