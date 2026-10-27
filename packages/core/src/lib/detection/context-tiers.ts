/**
 * Context-usage → tier nudge resolution + duck-typed extraction.
 *
 *   centralization (). The context-usage→tier nudge cascade
 * (percent tiers soft/advisory/warning/critical/compact → message) and the
 * `getContextUsage()` duck-typed extraction were duplicated across:
 *   - extensions/heartbeat/heartbeat-scheduler/policies.ts
 *   - extensions/enforcement/handlers/register-turn-end-hygiene.ts
 *   - extensions/enforcement/handlers/turn-end-handler.ts
 *   - extensions/core/prompt-builder/context-section.ts
 *   - extensions/memory/context-manager/analysis.ts
 *   - extensions/memory/context-manager/handlers/tools/context-navigate.ts
 *   - extensions/memory/context-lifecycle/helpers.ts
 *
 * Threshold VALUES still live in context-thresholds.ts (the existing
 * single source of truth). This module maps a usage percent onto the
 * tier ladder (tier labels + verbal priority per tier) and owns the ONE
 * duck-typed getContextUsage() accessor. Each site keeps its own
 * default/fallback semantics by applying them to the raw usage object
 * returned here, so behavior is preserved per site.
 *
 * The enforcement nudge message text is byte-identical across the three
 * enforcement cascade sites (verified in by grid-checking every
 * site's cascade over usage/token samples), so the message text lives
 * here in a single copy too. Sites with different copy (heartbeat
 * policies) keep their own messages and only share the tier mapping.
 */

import {
  USAGE_WHISPER_SOFT,
  USAGE_WHISPER_ADVISORY,
  USAGE_WHISPER_WARNING,
  USAGE_WHISPER_CRITICAL,
  USAGE_COMPACT_MEDIUM,
  USAGE_FIRED_RESET_BELOW,
} from "./context-thresholds.js";
import { tokenArms } from "./context-usage.js";
import { getResolvedContextWindow } from "../config/braid-settings.js";

// ═══════════════════════════════════════════════════════════════════════════
// TIER LADDER
// ═══════════════════════════════════════════════════════════════════════════

export type ContextUsageTier = "compact" | "critical" | "warning" | "advisory" | "soft";
export type ContextUsagePriority = "high" | "medium" | "low";

export interface ContextUsageTierInfo {
  tier: ContextUsageTier;
  /** Percent threshold for this tier (from context-thresholds.ts). */
  threshold: number;
  /** Verbal priority used by nudge copy (heartbeat policies ladder). */
  priority: ContextUsagePriority;
}

/**
 * Tier ladder, highest first: compact(80) → critical(75) → warning(65)
 * → advisory(50) → soft(30). Thresholds come from context-thresholds.ts.
 */
export const CONTEXT_USAGE_TIERS: readonly ContextUsageTierInfo[] = [
  { tier: "compact", threshold: USAGE_COMPACT_MEDIUM, priority: "high" },
  { tier: "critical", threshold: USAGE_WHISPER_CRITICAL, priority: "high" },
  { tier: "warning", threshold: USAGE_WHISPER_WARNING, priority: "medium" },
  { tier: "advisory", threshold: USAGE_WHISPER_ADVISORY, priority: "medium" },
  { tier: "soft", threshold: USAGE_WHISPER_SOFT, priority: "low" },
];

/**
 * The highest tier reached by the given usage percent, or null when below
 * soft. Equates to the enforcement cascades' if/else-if order
 * (compact → critical → warning → advisory → soft).
 */
export function contextUsageTier(usagePercent: number): ContextUsageTierInfo | null {
  for (const t of CONTEXT_USAGE_TIERS) {
    if (usagePercent >= t.threshold) return t;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ENFORCEMENT NUDGE MESSAGES (byte-identical across all enforcement sites)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The deadline every whisper states instead of restating its number. The bars
 * live in context-thresholds.ts and the meter in context-usage.ts; a
 * percentage copied into prose is a second copy that drifts from the one
 * owner. What the reader cannot derive from the bar is WHEN the cost lands:
 * the compaction the advice leads to is armed, not immediate.
 */
const SETTLE_DEADLINE = "an armed compaction fires when the run settles";

/**
 * Percent-tier nudge message text (identical at every enforcement site).
 * One sentence names the state and the deadline, then the action. No number
 * is restated: the rung's bar selected this message, and the meter rendered
 * the count where a count belongs (context_inspect, the tool result).
 */
export function contextUsageTierMessage(tier: ContextUsageTier): string {
  switch (tier) {
    case "compact":
      return (
        `Context is at the compaction arm; ${SETTLE_DEADLINE}. ` +
        `Tag with context_navigate(action="tag") and archive with ` +
        `context_compress(action="archive") before starting the next task.`
      );
    case "critical":
      return (
        `Context is above the critical arm; ${SETTLE_DEADLINE}. ` +
        `Tag with context_navigate(action="tag") and archive with ` +
        `context_compress(action="archive") before starting the next task.`
      );
    case "warning":
      return (
        `Context is above the warning arm; ${SETTLE_DEADLINE}. ` +
        `Tag with context_navigate(action="tag") and archive with ` +
        `context_compress(action="archive") before starting the next task.`
      );
    case "advisory":
      return (
        `Context is above the advisory arm; ${SETTLE_DEADLINE}. ` +
        `Archive completed work with context_compress(action="archive") and tag with ` +
        `context_navigate(action="tag") before starting the next task.`
      );
    case "soft":
      return (
        `Context is above the soft arm; ${SETTLE_DEADLINE}. ` +
        `Consider context_inspect(detail="prune") for candidates, or tag with ` +
        `context_navigate(action="tag") before starting the next task.`
      );
  }
}

/**
 * Token-tier nudge message text (identical at every enforcement site).
 * `level` mirrors the tier reached by the token-count check; arms are
 * fractions of the resolved window (0.45W warning, 0.18W soft). The text is
 * the tier's: a rung is a threshold, not a label, and the whisper no longer
 * renders the count that selected it.
 */
export function contextUsageTokenMessage(level: "warning" | "soft"): string {
  return contextUsageTierMessage(level === "warning" ? "warning" : "soft");
}

// ═══════════════════════════════════════════════════════════════════════════
// THE NUDGE LADDER (one scale, both units)
// ═══════════════════════════════════════════════════════════════════════════
// The cascade used to test one unit at a time: the token arms first, the
// percent tiers only when no token arm was reached. A token arm is a fraction
// of the same window the percent tiers measure, so 0.45W sits at 45% of EVERY
// window and the token line won from 45% upward. The advisory (50), warning
// (65), critical (75) and compact (80) tiers were therefore unreachable: an
// agent at 95% read the calm pipeline line an agent at 46% read, in the range
// where escalation is the whole point.
//
// So the arms are ONE ordered ladder, ordered by position on the axis both
// units measure — percent of the resolved window. The rung at the highest
// reached position wins and no rung can shadow a rung above it, whichever
// unit it is written in. Each rung keeps its own unit for the latch: the
// consumer re-arms on a fall back below the rung that fired, measured in that
// rung's unit (a percent bar in another unit re-arms a token arm immediately
// whenever the arm sits above the bar, which is the repeat loop itself).

export type ContextNudgeId =
  | "tokens:soft"
  | "tokens:warning"
  | "percent:soft"
  | "percent:advisory"
  | "percent:warning"
  | "percent:critical"
  | "percent:compact";

export interface ContextNudgeRung {
  /** Stable rung identity — what a latch records to suppress a repeat. */
  id: ContextNudgeId;
  /** Unit the rung is measured in, and the unit the latch re-arms in. */
  unit: "tokens" | "percent";
  /** The rung's threshold in `unit` (a resolved token count, or a percent). */
  threshold: number;
  /** The same threshold as a percent of the resolved window: ladder order. */
  position: number;
}

export interface ContextNudge extends ContextNudgeRung {
  message: string;
}

interface RungSpec extends ContextNudgeRung {
  render: () => string;
}

/**
 * The ladder for one window, weakest position first. Token rungs carry the
 * absolute count in their copy (that is what they are for on a large window);
 * percent rungs carry the percent.
 */
function nudgeRungs(window?: number | null): RungSpec[] {
  const arms = tokenArms(window);
  const positionOf = (tokens: number): number => (arms.W > 0 ? (tokens / arms.W) * 100 : 0);
  const pct = (threshold: number) => ({ unit: "percent" as const, threshold, position: threshold });
  return [
    {
      id: "tokens:soft",
      unit: "tokens",
      threshold: arms.soft,
      position: positionOf(arms.soft),
      render: () => contextUsageTokenMessage("soft"),
    },
    {
      id: "percent:soft",
      ...pct(USAGE_WHISPER_SOFT),
      render: () => contextUsageTierMessage("soft"),
    },
    {
      id: "tokens:warning",
      unit: "tokens",
      threshold: arms.warning,
      position: positionOf(arms.warning),
      render: () => contextUsageTokenMessage("warning"),
    },
    {
      id: "percent:advisory",
      ...pct(USAGE_WHISPER_ADVISORY),
      render: () => contextUsageTierMessage("advisory"),
    },
    {
      id: "percent:warning",
      ...pct(USAGE_WHISPER_WARNING),
      render: () => contextUsageTierMessage("warning"),
    },
    {
      id: "percent:critical",
      ...pct(USAGE_WHISPER_CRITICAL),
      render: () => contextUsageTierMessage("critical"),
    },
    {
      id: "percent:compact",
      ...pct(USAGE_COMPACT_MEDIUM),
      render: () => contextUsageTierMessage("compact"),
    },
  ];
}

/**
 * The strongest rung these numbers reach, or null below the first rung.
 * Highest POSITION wins, not first match: that is what stops a token arm from
 * shadowing a percent tier above it. Equal positions keep the earlier rung
 * (the ladder is built weakest-first), and an equal position is not an
 * escalation.
 */
export function resolveContextNudge(
  usagePercent: number,
  usageTokens: number,
  window?: number | null,
  /**
   * How the number was produced (measured / estimated). Rendered with the
   * message so a reader can tell a large context from a badly counted one;
   * the ladder itself is unchanged, since a rung is a bar, not a label.
   */
  provenance?: string,
): ContextNudge | null {
  let best: RungSpec | null = null;
  for (const rung of nudgeRungs(window)) {
    const reached =
      rung.unit === "tokens" ? usageTokens >= rung.threshold : usagePercent >= rung.threshold;
    if (reached && (best === null || rung.position > best.position)) best = rung;
  }
  if (!best) return null;
  return {
    id: best.id,
    unit: best.unit,
    threshold: best.threshold,
    position: best.position,
    message: provenance ? `${best.render()} (${provenance})` : best.render(),
  };
}

/**
 * One rung by id, resolved against the window in hand: a window change
 * re-derives the rung's bar instead of comparing a live count against a stale
 * one. Unknown or absent ids yield null (a latch armed by something that is
 * not a rung).
 */
export function findContextNudgeRung(
  id: string | null | undefined,
  window?: number | null,
): ContextNudgeRung | null {
  if (!id) return null;
  for (const rung of nudgeRungs(window)) {
    if (rung.id === id)
      return { id: rung.id, unit: rung.unit, threshold: rung.threshold, position: rung.position };
  }
  return null;
}

/**
 * Has usage fallen back below the rung that armed the latch? The comparison is
 * in the rung's own unit: a token rung clears on a token count below its arm,
 * a percent rung on a percent below its threshold. With no recorded rung (the
 * latch was armed by an act that then stood down) the percent reset bar
 * applies, which is the pre-ladder behavior for that path.
 */
export function contextNudgeFellBelow(
  id: string | null | undefined,
  usagePercent: number,
  usageTokens: number,
  window?: number | null,
): boolean {
  const rung = findContextNudgeRung(id, window);
  if (!rung) return usagePercent < USAGE_FIRED_RESET_BELOW;
  return rung.unit === "tokens" ? usageTokens < rung.threshold : usagePercent < rung.threshold;
}

/**
 * Was this rung crossed from below since the previous sample? A nudge is an
 * event: a session that lands above a rung and stays there must not read the
 * same advice every turn, while a rung climbed past is new information. The
 * previous sample is a token count, so a percent rung is tested against it
 * re-expressed as a percent of the window in hand.
 */
export function contextNudgeCrossed(
  rung: ContextNudgeRung,
  prevUsageTokens: number | undefined,
  window?: number | null,
): boolean {
  if (prevUsageTokens === undefined) return true;
  if (rung.unit === "tokens") return prevUsageTokens < rung.threshold;
  const { W } = tokenArms(window);
  if (W <= 0) return true;
  return (prevUsageTokens / W) * 100 < rung.threshold;
}

/**
 * Combined enforcement nudge: the strongest rung reached, its text, or null.
 * Kept as a text accessor for callers that need nothing but the message.
 */
export function contextUsageNudgeMessage(
  usagePercent: number,
  usageTokens: number,
  window?: number | null,
): string | null {
  return resolveContextNudge(usagePercent, usageTokens, window)?.message ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// DUCK-TYPED EXTRACTION (the one accessor every site shares)
// ═══════════════════════════════════════════════════════════════════════════

/** The duck-typed usage shape current sites read. percent may be null (no data). */
export interface ContextUsageLike {
  percent?: number | null;
  tokens?: number;
  contextWindow?: number;
}

/**
 * ONE duck-typed `getContextUsage()` extraction. Mirrors the fallbacks
 * used by every current site: a missing ctx, a non-function accessor, or
 * an accessor that throws all yield undefined. Each caller applies its own
 * defaulting (percent ?? 0, contextWindow ?? 200000, etc.), exactly as the
 * inline sites did — nothing is flattened away here. The one normalization
 * applied here: the reported `contextWindow` is the effective window
 * from the single contextLimitTokens resolver — braid.context.contextLimitTokens
 * overrides the accessor's provider-truth window, and `percent` is recomputed
 * against it when `tokens` is known so the two stay consistent.
 */
export function getContextUsage(ctx: unknown): ContextUsageLike | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const fn = (ctx as { getContextUsage?: () => unknown }).getContextUsage;
  if (typeof fn !== "function") return undefined;
  try {
    const usage = (fn.call(ctx) as ContextUsageLike | undefined) ?? undefined;
    if (!usage) return usage;
    const resolved = getResolvedContextWindow(
      typeof usage.contextWindow === "number" ? usage.contextWindow : undefined,
    );
    if (resolved === undefined || resolved === usage.contextWindow) return usage;
    const percent =
      typeof usage.tokens === "number" && usage.tokens >= 0
        ? (usage.tokens / resolved) * 100
        : usage.percent;
    return { ...usage, contextWindow: resolved, percent };
  } catch {
    return undefined;
  }
}
