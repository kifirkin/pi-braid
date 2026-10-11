/**
 * Live context usage - the tokens that will be sent on the next request.
 *
 * The duck-typed ctx.getContextUsage() estimate walks the agent's in-memory
 * message list and goes stale after a deterministic slide: the session tree
 * changes first and pi rebuilds the request later, so hundreds of dropped
 * entries report the identical number. This module measures the session
 * tree directly: entries before the latest compaction boundary are not
 * sent, so the live estimate walks the branch from that boundary to the
 * leaf.
 *
 * Two numbers per report, never mixed:
 *   live     - what will be sent on the next request (compaction-aware walk,
 *              refined by the last post-compaction assistant usage when one
 *              exists, since provider-reported totals are more accurate than
 *              char/4 estimates);
 *   branch   - the whole-branch sum, labeled "not sent" wherever displayed.
 */

import {
  getConfiguredContextLimitTokens,
  resolveContextLimitTokens,
} from "../config/braid-settings.js";

/** Per-message token estimate mirroring pi-core's estimateTokens (chars/4). */
function estimateMessageTokens(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const m = message as {
    role?: string;
    content?: unknown;
    thinking?: string;
    summary?: string;
    command?: string;
    output?: string;
    arguments?: unknown;
  };
  let chars = 0;
  const content = m.content;
  if (typeof content === "string") {
    chars += content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as { type?: string; text?: string };
      if (b?.type === "text" || b?.type === "thinking") chars += (b.text ?? "").length;
      else if (b?.type === "toolCall") {
        chars += (b as { name?: string; arguments?: unknown }).name?.length ?? 0;
        try {
          chars += JSON.stringify((b as { arguments?: unknown }).arguments ?? {}).length;
        } catch {
          /* non-serializable arguments: estimate as 0 chars */
        }
      }
    }
  }
  if (typeof m.thinking === "string") chars += m.thinking.length;
  if (typeof m.summary === "string") chars += m.summary.length;
  if (typeof m.command === "string") chars += m.command.length;
  if (typeof m.output === "string") chars += m.output.length;
  return Math.ceil(chars / 4);
}

/** Tokens carried by a span of messages - the same per-message chars/4 estimate. */
export function estimateMessagesTokens(messages: readonly unknown[]): number {
  let tokens = 0;
  for (const message of messages) tokens += estimateMessageTokens(message);
  return tokens;
}

/** Tokens carried by one session entry (message, compaction summary, etc.). */
function entryTokens(entry: any): number {
  if (!entry || typeof entry !== "object") return 0;
  if (entry.type === "message") return estimateMessageTokens(entry.message);
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return estimateMessageTokens(entry);
  }
  if (entry.type === "custom" || entry.type === "label" || entry.type === "session") return 0;
  return estimateMessageTokens(entry);
}

/** The resolved context window with an explicit source label. */
export interface ResolvedWindow {
  contextWindow: number;
  /**
   * "configured" = the braid.context.contextLimitTokens cap is the binding
   * bound (it lowers the value, or no provider window is known);
   * "provider" = the model window is the binding bound (the ceiling clamped
   * the cap to it, or no cap is set).
   */
  windowSource: "configured" | "provider";
}

export function resolveWindow(modelWindow?: number | null): ResolvedWindow {
  const provider =
    typeof modelWindow === "number" && Number.isFinite(modelWindow) && modelWindow > 0
      ? modelWindow
      : undefined;
  const configured = getConfiguredContextLimitTokens();
  const override = resolveContextLimitTokens(configured, provider);
  if (override !== undefined) {
    // The label names the BINDING bound, not merely whether a cap exists:
    // when the cap is above the true window the ceiling clamped it and the
    // provider window is what binds.
    const capBinds = configured !== undefined && (provider === undefined || configured <= provider);
    return { contextWindow: override, windowSource: capBinds ? "configured" : "provider" };
  }
  return { contextWindow: provider ?? 200_000, windowSource: "provider" };
}

export interface LiveUsage {
  /** Estimated tokens of the next request payload. */
  tokens: number;
  contextWindow: number;
  percent: number;
  windowSource: "configured" | "provider";
  /** Whole-branch sum - reported separately as "branch total (not sent)". */
  branchTokens: number;
}

/**
 * Measure live usage from the session tree (compaction-aware branch walk).
 *
 * Returns undefined when the session manager is unavailable or yields no
 * branch - callers then fall back to their existing duck-typed usage source.
 */
export function measureLiveUsage(ctx: unknown): LiveUsage | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const sm = (ctx as { sessionManager?: { getBranch?: () => unknown[] } }).sessionManager;
  let branch: unknown[];
  try {
    branch = typeof sm?.getBranch === "function" ? (sm.getBranch() ?? []) : [];
  } catch {
    return undefined;
  }
  if (!Array.isArray(branch)) return undefined;
  // No message entries ⇒ nothing meaningful to measure from the tree (a
  // zero here would read as a healthy empty context). Callers fall back.
  const hasMessages = branch.some((e) => (e as { type?: string })?.type === "message");
  if (!hasMessages) return undefined;

  const modelWindow = (ctx as { model?: { contextWindow?: number } })?.model?.contextWindow;
  const window = resolveWindow(modelWindow);

  // Latest compaction boundary: entries strictly before it are compacted
  // away and are not part of the live payload.
  let boundary = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if ((branch[i] as { type?: string })?.type === "compaction") {
      boundary = i;
      break;
    }
  }

  let branchTokens = 0;
  for (const entry of branch) branchTokens += entryTokens(entry);

  const liveStart = boundary >= 0 ? boundary : 0;
  let liveTokens = 0;
  for (let i = liveStart; i < branch.length; i++) liveTokens += entryTokens(branch[i]);

  // Usage-backed refinement: the last assistant message after the boundary
  // reports its actual request total; only trailing entries need estimating.
  let usageBacked: { usageTokens: number; index: number } | undefined;
  for (let i = branch.length - 1; i > liveStart; i--) {
    const entry = branch[i] as {
      type?: string;
      message?: {
        role?: string;
        usage?: {
          totalTokens?: number;
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
        };
        stopReason?: string;
      };
    };
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entry.message.stopReason === "aborted" || entry.message.stopReason === "error") continue;
    const u = entry.message.usage;
    if (!u) continue;
    const total =
      typeof u.totalTokens === "number" && u.totalTokens > 0
        ? u.totalTokens
        : (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    if (total > 0) {
      usageBacked = { usageTokens: total, index: i };
      break;
    }
  }
  if (usageBacked) {
    let trailing = 0;
    for (let i = usageBacked.index + 1; i < branch.length; i++) trailing += entryTokens(branch[i]);
    liveTokens = usageBacked.usageTokens + trailing;
  }

  return {
    tokens: liveTokens,
    contextWindow: window.contextWindow,
    percent: window.contextWindow > 0 ? (liveTokens / window.contextWindow) * 100 : 0,
    windowSource: window.windowSource,
    branchTokens,
  };
}

/**
 * Token arms as fractions of the resolved window W (fixed table):
 *   soft 0.18W, advisory 0.30W, warning 0.45W,
 *   act min(0.60W, ACT_ARM_TOKEN_CEILING),
 *   backstop 0.90W, escalate 0.85W (distinct value where two arms must
 *   differ; otherwise 0.90W). Percent arms are unchanged absolute values.
 * Only act is clamped: the advisory arms are prose, and escalate/backstop
 * are failure-path arms that keep the values they were measured with.
 */
export interface TokenArms {
  W: number;
  soft: number;
  advisory: number;
  warning: number;
  act: number;
  backstop: number;
  escalate: number;
}

const ARM_FRACTIONS = {
  soft: 0.18,
  advisory: 0.3,
  warning: 0.45,
  act: 0.6,
  escalate: 0.85,
  backstop: 0.9,
};

/**
 * Absolute token ceiling for the acting arm. act is the lever that compacts,
 * so it is the one arm held to an absolute point on large windows: a bare
 * 0.60W would otherwise move linearly with any window raise, away from where
 * it was tuned. 130_000 sits above the act point a 196k window produces
 * (0.60 x 196k = 117_600, so that window is untouched) and below the bare
 * 0.60 x 256k = 153_600, so the clamp sets the acting point once the fraction
 * overshoots it. Advisory arms get no ceiling (prose, not levers); neither do
 * escalate/backstop (failure-path arms measured in place).
 */
const ACT_ARM_TOKEN_CEILING = 130_000;

export function tokenArms(providerWindow?: number | null): TokenArms {
  const w = resolveWindow(providerWindow).contextWindow;
  const r = (f: number) => Math.round(w * f);
  return {
    W: w,
    soft: r(ARM_FRACTIONS.soft),
    advisory: r(ARM_FRACTIONS.advisory),
    warning: r(ARM_FRACTIONS.warning),
    act: Math.min(r(ARM_FRACTIONS.act), ACT_ARM_TOKEN_CEILING),
    escalate: r(ARM_FRACTIONS.escalate),
    backstop: r(ARM_FRACTIONS.backstop),
  };
}

// ── Display ───────────────────────────────────────────────────────────

/**
 * The ONE K-token display formatter: 1000 tokens render as "1K". Whispers
 * and tool output must never disagree about the same state (diverging
 * divisors - 1000 here vs 1024 there - print different totals for the
 * same 160K/128K setting).
 */
export function formatTokensK(tokens: number): string {
  return `${Math.round(tokens / 1000)}K`;
}
