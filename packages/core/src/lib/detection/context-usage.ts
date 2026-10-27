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

/**
 * Tokens an OUTGOING REQUEST carries: system prompt, tool definitions and
 * messages. The session-tree walk sees only the messages, so anything that
 * compares a request against a window has to start here - the system prompt
 * and the tool schemas never appear in the tree at all.
 */
export function estimatePayloadTokens(parts: {
  systemPrompt?: string;
  messages?: readonly unknown[];
  tools?: unknown;
}): number {
  let tokens = 0;
  if (parts.systemPrompt) tokens += Math.ceil(parts.systemPrompt.length / 4);
  if (parts.messages) tokens += estimateMessagesTokens(parts.messages);
  if (parts.tools !== undefined) {
    try {
      tokens += Math.ceil(JSON.stringify(parts.tools).length / 4);
    } catch {
      /* non-serializable tool definitions: leave them out rather than throw */
    }
  }
  return tokens;
}

// ── Calibration against the provider's own count ──────────────────────
//
// chars/4 is not a tokenizer. It is a guess about a distribution, and the
// distribution moves with the content: prose runs near 4 chars/token, dense
// tool-call JSON and base64 payloads run near 2, and characters the encoder
// spends several tokens on (non-Latin scripts) sit lower still. A single
// divisor therefore cannot be right everywhere, and the guard that reads it
// is wrong by the same factor in the same direction.
//
// Every successful call returns usage. Pairing that count with the estimate
// for the SAME span yields the one number that can correct the guess without
// a tokenizer: the ratio. It is kept as the median of the last few pairs
// because the ratio is content-dependent - a single oversized tool result
// moves one sample, not the level - and applied to the estimated part of the
// live number.

export type UsageSource = "measured" | "estimated";

/** Paired observations kept for the ratio. */
const CALIBRATION_SAMPLES = 8;
/**
 * A pair smaller than this measures nothing: below it the fixed part of the
 * request (system prompt, tool schemas) dominates the measured count, so the
 * ratio would describe the harness rather than the tokenizer's view of content.
 */
const CALIBRATION_MIN_ESTIMATE_TOKENS = 2_000;
/**
 * Clamp. Below 0.5 the estimate would over-count by more than half (a span
 * whose shape changed under the pair, not a tokenizer effect); above 6 the
 * correction exceeds anything a character-count can explain for text, so the
 * pair is not describing the tokenizer either.
 */
const CALIBRATION_MIN_RATIO = 0.5;
const CALIBRATION_MAX_RATIO = 6;

let _calibrationRatios: number[] = [];
let _lastCalibrationKey: string | null = null;
let _calibrationSession: string | null = null;

/**
 * Ratios belong to one session: a new session has its own content mix, and a
 * process that outlives sessions must not apply yesterday's ratio to today's
 * tree. Called from the measure path with whatever session key the context
 * exposes; a context without one leaves the store alone.
 */
function scopeCalibrationToSession(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  if (_calibrationSession === sessionKey) return;
  _calibrationRatios = [];
  _lastCalibrationKey = null;
  _calibrationSession = sessionKey;
}

/**
 * Record one paired observation: the chars/4 estimate for a request span and
 * the provider's own count for that same span. Returns the median ratio after
 * the insert, or null when the pair measures nothing (a span under the harness
 * floor, or a non-positive measured count).
 *
 * `key` dedupes: callers re-measure the same span many times per turn, and the
 * same pair must not weight the median more than once.
 */
export function recordCalibrationSample(
  estimatedTokens: number,
  measuredTokens: number,
  key?: string,
): number | null {
  if (estimatedTokens < CALIBRATION_MIN_ESTIMATE_TOKENS || measuredTokens <= 0) return null;
  if (key && key === _lastCalibrationKey) return calibrationRatio();
  const raw = measuredTokens / estimatedTokens;
  const ratio = Math.min(CALIBRATION_MAX_RATIO, Math.max(CALIBRATION_MIN_RATIO, raw));
  _calibrationRatios.push(ratio);
  if (_calibrationRatios.length > CALIBRATION_SAMPLES) _calibrationRatios.shift();
  _lastCalibrationKey = key ?? null;
  return calibrationRatio();
}

/** Median of the retained ratios; null before the first usable pair. */
export function calibrationRatio(): number | null {
  if (_calibrationRatios.length === 0) return null;
  const sorted = [..._calibrationRatios].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Apply the session's ratio to a chars-based estimate. No ratio (first call of
 * a session) leaves the number as the plain estimate - it never pretends to be
 * measured, and it never invents a correction it has not observed.
 */
export function calibrateEstimate(rawTokens: number): {
  tokens: number;
  ratio: number | null;
  calibrated: boolean;
} {
  const ratio = calibrationRatio();
  if (ratio === null || rawTokens <= 0)
    return { tokens: rawTokens, ratio: null, calibrated: false };
  return { tokens: Math.round(rawTokens * ratio), ratio, calibrated: true };
}

/** Test hook: clear the retained pairs (also clears the dedupe key). */
export function resetCalibrationForTests(): void {
  _calibrationRatios = [];
  _lastCalibrationKey = null;
  _calibrationSession = null;
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
  /**
   * Tokens of the next request payload, calibrated. This is the number guards
   * read: a measured base plus a calibrated estimate of the trailing entries.
   */
  tokens: number;
  /** Where `tokens` came from: an API response, or the chars-based estimate. */
  source: UsageSource;
  /** The uncalibrated chars/4 walk over the same span (never rendered as the total). */
  estimatedTokens: number;
  /** The trailing part that only the estimate covers, after calibration. 0 when measured. */
  estimatedTrailingTokens: number;
  /** The session ratio applied, when one was observed. */
  calibrationRatio?: number;
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
  try {
    scopeCalibrationToSession(
      (
        ctx as { sessionManager?: { getSessionId?: () => string } }
      ).sessionManager?.getSessionId?.(),
    );
  } catch {
    /* no session key: keep the store as it is */
  }

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
  const estimatedTokens = liveTokens;
  let source: UsageSource = "estimated";
  let estimatedTrailingTokens: number;
  let calibrationRatioApplied: number | undefined;

  if (usageBacked) {
    // The provider's count covers exactly the entries from the boundary through
    // the message that carries the usage; pair that count with the walk over
    // the same slice. This is the only place both numbers describe one request.
    let rawUpToUsage = 0;
    for (let i = liveStart; i <= usageBacked.index; i++) rawUpToUsage += entryTokens(branch[i]);
    recordCalibrationSample(
      rawUpToUsage,
      usageBacked.usageTokens,
      `${liveStart}:${usageBacked.index}:${usageBacked.usageTokens}`,
    );

    let trailing = 0;
    for (let i = usageBacked.index + 1; i < branch.length; i++) trailing += entryTokens(branch[i]);
    const calibratedTrailing = calibrateEstimate(trailing);
    liveTokens = usageBacked.usageTokens + calibratedTrailing.tokens;
    source = "measured";
    estimatedTrailingTokens = calibratedTrailing.tokens;
    if (calibratedTrailing.ratio !== null) calibrationRatioApplied = calibratedTrailing.ratio;
  } else {
    const calibrated = calibrateEstimate(liveTokens);
    liveTokens = calibrated.tokens;
    estimatedTrailingTokens = calibrated.tokens;
    if (calibrated.ratio !== null) calibrationRatioApplied = calibrated.ratio;
  }

  return {
    tokens: liveTokens,
    source,
    estimatedTokens,
    estimatedTrailingTokens,
    calibrationRatio: calibrationRatioApplied,
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

/**
 * One label for any rendered usage number, naming its provenance. The word is
 * `measured` only when an API response supplied the anchor; everything else is
 * `estimated`, with the calibration factor shown when one was applied. A
 * trailing estimate behind a measured anchor is named rather than folded in -
 * rounding it away is how the number stops meaning anything.
 */
export function describeUsage(usage: {
  source: UsageSource;
  estimatedTrailingTokens?: number;
  calibrationRatio?: number;
}): string {
  const ratio =
    usage.calibrationRatio !== undefined ? ` x${usage.calibrationRatio.toFixed(2)}` : "";
  if (usage.source === "measured") {
    const trailing = usage.estimatedTrailingTokens ?? 0;
    return trailing > 0
      ? `measured + ${formatTokensK(trailing)} estimated${ratio}`
      : `measured${ratio}`;
  }
  return `estimated${ratio}`;
}

/** `<pct>% <provenance>` - the percent form used wherever a percentage renders. */
export function describeUsagePercent(usage: LiveUsage): string {
  return `${usage.percent.toFixed(1)}% ${describeUsage(usage)}`;
}
