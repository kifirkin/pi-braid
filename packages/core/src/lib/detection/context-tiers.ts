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
} from "./context-thresholds.js";
import { tokenArms, formatTokensK } from "./context-usage.js";
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

/** Percent-tier nudge message text (identical at every enforcement site). */
export function contextUsageTierMessage(tier: ContextUsageTier, usagePercent: number): string {
  const pct = Math.round(usagePercent);
  switch (tier) {
    case "compact":
      return (
        `Context at ${pct}%. Pipeline: context_navigate(action="tag") -> ` +
        `context_compress(action="archive") -> context_compress(action="slide"). Tag your position first.`
      );
    case "critical":
      return (
        `Context at ${pct}%. Tag with context_navigate(action="tag"), then ` +
        `context_compress(action="archive") to branch with a summary.`
      );
    case "warning":
      return (
        `Context at ${pct}%. Warning — tag with context_navigate(action="tag"), then ` +
        `context_compress(action="archive") to branch with a summary.`
      );
    case "advisory":
      return (
        `Context at ${pct}%. Advisory — consider context_archive for completed tasks. ` +
        `context_navigate(action="tag") to mark your position first.`
      );
    case "soft":
      return (
        `Context at ${pct}%. Soft whisper — consider context_inspect(detail="prune") ` +
        `to see candidates for archival.`
      );
  }
}

/**
 * Token-tier nudge message text (identical at every enforcement site).
 * `level` mirrors the tier reached by the token-count check; arms are
 * fractions of the resolved window (0.45W warning, 0.18W soft).
 */
export function contextUsageTokenMessage(
  level: "warning" | "soft",
  usagePercent: number,
  usageTokens: number,
): string {
  const tokensK = formatTokensK(usageTokens);
  const pct = Math.round(usagePercent);
  if (level === "warning") {
    return (
      `Context at ${tokensK} tokens (${pct}%). ` +
      `Pipeline: context_navigate(action="tag") -> context_compress(action="archive") -> context_compress(action="slide").`
    );
  }
  return (
    `Context at ${tokensK} tokens. ` +
    `Consider context_inspect(detail="prune") to see candidates, or tag position with context_navigate(action="tag").`
  );
}

/**
 * Combined enforcement cascade: token tiers first (0.45W/0.18W — fire earlier
 * for large context windows), then the percent tiers (30/50/65/75/80).
 * Returns null when no tier is reached.
 */
export function contextUsageNudgeMessage(
  usagePercent: number,
  usageTokens: number,
  window?: number | null,
): string | null {
  const arms = tokenArms(window);
  if (usageTokens >= arms.warning) {
    return contextUsageTokenMessage("warning", usagePercent, usageTokens);
  }
  if (usageTokens >= arms.soft) {
    return contextUsageTokenMessage("soft", usagePercent, usageTokens);
  }
  const tier = contextUsageTier(usagePercent);
  if (!tier) return null;
  return contextUsageTierMessage(tier.tier, usagePercent);
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
