/**
 * Context Heartbeat Telemetry - one append-only JSONL line per heartbeat tick.
 *
 * LIVE scalar telemetry so the metric-before-implementation rule has a
 * continuous baseline: context tokens/percent/window, RSS + heap, session
 * file size, per-class char deltas since the previous tick, whisper
 * (injected custom_message) pressure, and tokens/sec from the last
 * assistant message.
 *
 * Two hooks feed the same sink:
 *   - Hook 1 (turn-paced): heartbeat-scheduler tick → collectAndEmitContextHeartbeat
 *     (ctx available: full field set).
 *   - Hook 2 (wall-clock, idle-inclusive): watchdog engine check() → a cheap
 *     process-global line wired through the engine's optional `telemetryEmit`
 *     dep (the engine itself stays pure and ctx-free; watchdog/index.ts adds
 *     sessionId/session size/health mode at the wiring point).
 *
 * Design constraints (same scalar-only posture as degradation-detector.ts):
 *   - Entries are SCALAR-ONLY. The sink re-checks every value before the
 *     append (numbers/short strings/boolean/null) — a ctx-shaped object must
 *     never reach the file, so `never spread ctx` is enforced at the
 *     boundary, not just at the builders.
 *   - Sink failures are non-fatal (log + continue): telemetry must never
 *     break a heartbeat tick or a watchdog check.
 *   - No LLM calls anywhere. The entries walk is the context-density
 *     evaluator's template (lib/detection/context-density.ts), bounded by
 *     the same shape checks.
 *   - Per-tick state lives in getExtensionState (per-session, no module-level
 *     let — lib/state/AGENTS.md contract).
 *
 * Sink: <braidDir()>/telemetry/context-heartbeat.jsonl, resolved on every
 * call through braid-paths (a module-load constant would pin the sink to the
 * default tree and ignore BRAID_HOME).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../core/logger.js";
import { telemetryDir } from "../config/braid-paths.js";
import { pushRssSample, assessSustainedRssGrowth, RSS_RING_CAP } from "./rss-telemetry.js";
import { getRssBootTelemetry, setRssBootBaseline } from "../state/global-state.js";
import {
  getExtensionState,
  hasExtensionState,
  safeSessionManagerTyped,
} from "../state/extension-state.js";
import { getContextUsage } from "../detection/context-tiers.js";
import { measureLiveUsage } from "../detection/context-usage.js";

const log = createLogger("context-heartbeat");

/** Sink directory (created on first append; see header note). */
export function heartbeatTelemetryDir(): string {
  return telemetryDir();
}

/** Sink file for the heartbeat JSONL (see header note). */
export function contextHeartbeatFilePath(): string {
  return path.join(heartbeatTelemetryDir(), "context-heartbeat.jsonl");
}

/** Strings above this length inside an entry are truncated — bounded lines. */
const MAX_STRING_CHARS = 128;

/** Scalar whitelist at the sink boundary: number (finite), short string,
 *  boolean, null. Everything else (objects, arrays, undefined, NaN, long
 *  strings) is DROPPED — never serialized (the OOM signature). */
function sanitizeScalarValue(val: unknown): number | string | boolean | null | undefined {
  if (val === null) return null;
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  if (typeof val === "string") {
    return val.length <= MAX_STRING_CHARS ? val : val.slice(0, MAX_STRING_CHARS);
  }
  if (typeof val === "boolean") return val;
  return undefined;
}

/**
 * Append one JSONL line to the sink. Scalar-only defense at the boundary;
 * directory created on demand; every failure path returns false without
 * throwing (callers must never break the tick/check on telemetry).
 *
 * @param entry flat record; non-scalar values are silently dropped
 * @param file  optional override (tests); defaults to contextHeartbeatFilePath()
 * @returns true when the line was appended
 */
export function appendContextHeartbeatLine(
  entry: Record<string, unknown>,
  file: string = contextHeartbeatFilePath(),
): boolean {
  try {
    const clean: Record<string, number | string | boolean | null> = {};
    for (const key of Object.keys(entry)) {
      const v = sanitizeScalarValue(entry[key]);
      if (v !== undefined) clean[key] = v;
    }
    try {
      fs.appendFileSync(file, `${JSON.stringify(clean)}\n`, "utf-8");
      return true;
    } catch (err) {
      // ENOENT (first write in a fresh install) → create the dir once, retry.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(clean)}\n`, "utf-8");
        return true;
      }
      throw err;
    }
  } catch (err) {
    log.warn(`[context-heartbeat] sink append failed (non-fatal): ${(err as Error).message}`);
    return false;
  }
}

// ── Per-session telemetry state (getExtensionState — no module-level let) ────

interface ContextHeartbeatTelemetryState {
  /** Previous tick's context tokens (for growth delta). */
  lastContextTokens: number | null;
  /** Previous tick's per-class char totals + whisper count. */
  lastAssistantChars: number;
  lastToolResultChars: number;
  lastUserChars: number;
  lastWhisperChars: number;
  lastWhisperCount: number;
  /** Last assistant message: LLM-call duration + usage (for tps + metrics). */
  lastAssistantDurationMs: number | null;
  lastInputTokens: number | null;
  lastOutputTokens: number | null;
  /** Cache-hit share of the last assistant message, percent 0-100 (cacheRead/(input+cacheRead)). */
  lastCacheHitShare: number | null;
  lastTps: number | null;
  tpsEma: number | null;
  /** Last RSS_RING_CAP process RSS samples (oldest → newest). */
  rssRing: number[];
}

const TELEMETRY_STATE_KEY = "context-heartbeat-telemetry";

function telemetryState(ctx: ExtensionContext): ContextHeartbeatTelemetryState {
  return getExtensionState(ctx, TELEMETRY_STATE_KEY, () => ({
    lastContextTokens: null,
    lastAssistantChars: 0,
    lastToolResultChars: 0,
    lastUserChars: 0,
    lastWhisperChars: 0,
    lastWhisperCount: 0,
    lastAssistantDurationMs: null,
    lastInputTokens: null,
    lastOutputTokens: null,
    lastCacheHitShare: null,
    lastTps: null,
    tpsEma: null,
    rssRing: [],
  }));
}

/** Minimum assistant duration to trust a tok/s sample (avoid div-by-tiny). */
const MIN_TPS_DURATION_MS = 250;
/** EMA weight for the new sample. */
const TPS_EMA_ALPHA = 0.3;

/**
 * Record an assistant message_end (Hook 1 feed). message.timestamp is the
 * stream-start proxy (pi-core message_start ≈ message creation), so
 * duration = now - timestamp ≈ the pure API-call window the investigation's
 * Semantics want (excludes tool execution).
 *
 * Self-state (Refine-2): also captures usage.cacheRead — the cache-hit
 * share (cacheRead/(input+cacheRead), percent) is the session's
 * efficiency signature (94-98% while healthy). n/a (null) when the provider
 * does not report cacheRead.
 */
export function noteAssistantMessageEnd(ctx: ExtensionContext, message: unknown): void {
  try {
    if (!message || typeof message !== "object") return;
    const m = message as {
      role?: string;
      timestamp?: number;
      usage?: { input?: number; output?: number; cacheRead?: number };
    };
    if (m.role !== "assistant") return;
    const s = telemetryState(ctx);
    const now = Date.now();
    if (typeof m.timestamp === "number" && m.timestamp > 0) {
      const durationMs = now - m.timestamp;
      if (durationMs > 0) s.lastAssistantDurationMs = durationMs;
    }
    const usage = m.usage;
    if (usage && typeof usage === "object") {
      s.lastInputTokens = typeof usage.input === "number" ? usage.input : s.lastInputTokens;
      const output = typeof usage.output === "number" ? usage.output : null;
      if (output !== null) s.lastOutputTokens = output;
      // Cache-hit share: cacheRead/(input+cacheRead) — both must be
      // present and the denominator positive; otherwise keep null (n/a).
      const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : null;
      if (cacheRead !== null && s.lastInputTokens !== null && s.lastInputTokens + cacheRead > 0) {
        s.lastCacheHitShare = (cacheRead / (s.lastInputTokens + cacheRead)) * 100;
      }
      const dur = s.lastAssistantDurationMs;
      if (output !== null && output >= 1 && dur !== null && dur >= MIN_TPS_DURATION_MS) {
        const tps = output / (dur / 1000);
        s.lastTps = tps;
        s.tpsEma = s.tpsEma === null ? tps : s.tpsEma * (1 - TPS_EMA_ALPHA) + tps * TPS_EMA_ALPHA;
      }
    }
  } catch {
    // telemetry never fatal
  }
}

// ── Entry walk (context-density.ts template) ────────────────────────────────

interface ClassCharTotals {
  assistantChars: number;
  toolResultChars: number;
  userChars: number;
  whisperChars: number;
  whisperCount: number;
  totalEntries: number;
}

/** Flatten message content (string | content-array) to a char count. */
function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: string; thinking?: string; arguments?: unknown };
    if (typeof p.text === "string") n += p.text.length;
    else if (typeof p.thinking === "string") n += p.thinking.length;
    else if (p.type === "toolCall") {
      try {
        n += JSON.stringify(p.arguments ?? {}).length;
      } catch {
        /* unserializable args: count as 0 */
      }
    }
  }
  return n;
}

/** Walk session entries once (density-evaluator template) and total chars
 *  per source class. Injected whispers are `custom_message` entries. */
function classifyEntries(ctx: ExtensionContext): ClassCharTotals {
  const totals: ClassCharTotals = {
    assistantChars: 0,
    toolResultChars: 0,
    userChars: 0,
    whisperChars: 0,
    whisperCount: 0,
    totalEntries: 0,
  };
  let entries: unknown[];
  try {
    entries =
      (ctx.sessionManager as { getEntries?: () => unknown[] } | undefined)?.getEntries?.() ?? [];
  } catch {
    return totals;
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      type?: string;
      message?: unknown;
      customType?: unknown;
      content?: unknown;
    };
    totals.totalEntries++;
    if (e.type === "message" && e.message && typeof e.message === "object") {
      const msg = e.message as { role?: string; content?: unknown };
      const chars = contentChars(msg.content);
      if (msg.role === "assistant") totals.assistantChars += chars;
      else if (msg.role === "toolResult") totals.toolResultChars += chars;
      else if (msg.role === "user") totals.userChars += chars;
      else if (msg.role === "custom") {
        // Custom messages live in context too (whispers/steer injections).
        totals.whisperChars += chars;
        totals.whisperCount++;
      }
    } else if (e.type === "custom_message") {
      totals.whisperCount++;
      totals.whisperChars += contentChars(e.content);
    }
    // Other entry kinds (compaction, custom, label, …) carry no LLM context mass.
  }
  return totals;
}

export interface ContextHeartbeatOptions {
  turnNumber?: number;
  /** Session health mode (passed in — lib/ may not import from extensions/). */
  healthMode?: string;
  /** Line source tag (Hook 1 "heartbeat", Hook 2 "watchdog"). */
  source?: string;
  /** Sink override (tests); defaults to contextHeartbeatFilePath(). */
  sinkFile?: string;
}

/** The collected sample, so the caller can feed recordTurnMetrics real values. */
export interface ContextHeartbeatSample {
  entry: Record<string, number | string | boolean | null>;
  lastAssistantDurationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  tokensPerSec: number | null;
  tpsEma: number | null;
  assistantCharsDelta: number;
  toolResultCharsDelta: number;
  userCharsDelta: number;
  whisperCharsDelta: number;
  whisperCountDelta: number;
  /** The RSS ring after this tick (oldest → newest, ≤ RSS_RING_CAP). */
  rssRing: number[];
  /** Boot-time RSS baseline (first tick of the process), bytes. */
  rssBaselineBytes: number | null;
  /** Sustained-growth verdict (full ring, all >2x baseline). */
  rssSustainedGrowth: boolean;
}

/**
 * Collect the per-tick context/RSS/session telemetry, append it to the JSONL
 * sink, and return the sample for the degradation-detector feed (D2 fix).
 * Never throws; returns whatever was collectable.
 */
export function collectAndEmitContextHeartbeat(
  ctx: ExtensionContext,
  opts: ContextHeartbeatOptions = {},
): ContextHeartbeatSample {
  const s = telemetryState(ctx);

  // Context usage (pi-core agent-session getContextUsage).
  const usage = getContextUsage(ctx);
  const contextTokens = typeof usage?.tokens === "number" ? usage.tokens : null;
  const contextWindow = typeof usage?.contextWindow === "number" ? usage.contextWindow : null;
  const contextPercent = typeof usage?.percent === "number" ? usage.percent : null;

  let rssBytes: number | null = null;
  let heapUsed: number | null = null;
  try {
    const mem = process.memoryUsage();
    rssBytes = mem.rss;
    heapUsed = mem.heapUsed;
  } catch {
    /* keep nulls */
  }

  // ── RSS ring + boot baseline + debug log ─────────────────────
  // Every heartbeat tick pushes one RSS sample onto the per-session ring
  // (capped at RSS_RING_CAP=24) and sets the PROCESS-GLOBAL boot baseline
  // on the first tick of the boot. Each sample logs at debug so the next
  // OOM is diagnosable from logs, not from a photo of a frozen Mac.
  let rssRing: number[] = [];
  let rssBaselineBytes: number | null = null;
  if (rssBytes !== null && rssBytes > 0) {
    setRssBootBaseline(rssBytes);
    rssRing = pushRssSample(s.rssRing, rssBytes);
    const boot = getRssBootTelemetry();
    rssBaselineBytes = boot?.baselineBytes ?? null;
    log.debug(
      `[context-heartbeat] rss=${(rssBytes / 1048576).toFixed(1)}MB ` +
        `ring=${rssRing.length}/${RSS_RING_CAP} ` +
        `baseline=${rssBaselineBytes !== null ? (rssBaselineBytes / 1048576).toFixed(1) + "MB" : "n/a"} ` +
        `sustainedGrowth=${assessSustainedRssGrowth(rssRing, rssBaselineBytes)}`,
    );
  }

  // Session file size (sessionManager already exposes its path).
  let sessionFileSizeBytes: number | null = null;
  let sessionId: string = "?";
  try {
    const sm = safeSessionManagerTyped(ctx);
    const file = sm?.getSessionFile?.();
    if (file) {
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (st) sessionFileSizeBytes = st.size;
    }
    const sid = (
      sm as unknown as { getSessionId?: () => string | undefined } | undefined
    )?.getSessionId?.();
    if (typeof sid === "string" && sid.length > 0) sessionId = sid;
  } catch {
    /* keep nulls */
  }

  // Model id (bounded string; defensive — model is optional on ctx).
  let model: string;
  try {
    const model_ = (ctx as { model?: { id?: unknown; label?: unknown } }).model;
    const raw =
      typeof model_?.id === "string"
        ? model_.id
        : typeof model_?.label === "string"
          ? model_!.label
          : "";
    model = String(raw).slice(0, MAX_STRING_CHARS);
  } catch {
    model = "";
  }

  // Per-class char totals + deltas since the previous tick.
  const totals = classifyEntries(ctx);
  const assistantCharsDelta = totals.assistantChars - s.lastAssistantChars;
  const toolResultCharsDelta = totals.toolResultChars - s.lastToolResultChars;
  const userCharsDelta = totals.userChars - s.lastUserChars;
  const whisperCharsDelta = totals.whisperChars - s.lastWhisperChars;
  const whisperCountDelta = totals.whisperCount - s.lastWhisperCount;
  const contextTokensDelta =
    contextTokens !== null && s.lastContextTokens !== null
      ? contextTokens - s.lastContextTokens
      : null;

  // Roll the previous-tick state forward.
  s.lastContextTokens = contextTokens;
  s.lastAssistantChars = totals.assistantChars;
  s.lastToolResultChars = totals.toolResultChars;
  s.lastUserChars = totals.userChars;
  s.lastWhisperChars = totals.whisperChars;
  s.lastWhisperCount = totals.whisperCount;

  const entry: Record<string, number | string | boolean | null> = {
    ts: Date.now(),
    source: opts.source ?? "heartbeat",
    sessionId: sessionId.slice(0, MAX_STRING_CHARS),
    model,
    turnNumber: opts.turnNumber ?? null,
    contextTokens,
    contextWindow,
    contextPercent,
    rssBytes,
    heapUsed,
    sessionFileSizeBytes,
    inputTokens: s.lastInputTokens,
    outputTokens: s.lastOutputTokens,
    cacheHitShare: s.lastCacheHitShare !== null ? Math.round(s.lastCacheHitShare * 10) / 10 : null,
    tokensPerSec: s.lastTps !== null ? Math.round(s.lastTps * 10) / 10 : null,
    tpsEma: s.tpsEma !== null ? Math.round(s.tpsEma * 10) / 10 : null,
    contextTokensDelta,
    assistantCharsDelta,
    toolResultCharsDelta,
    userCharsDelta,
    whisperCharsDelta,
    whisperCountTotal: totals.whisperCount,
    whisperCountDelta,
    messageCount: totals.totalEntries,
    healthMode: opts.healthMode ?? null,
  };

  appendContextHeartbeatLine(entry, opts.sinkFile);

  return {
    entry,
    lastAssistantDurationMs: s.lastAssistantDurationMs,
    inputTokens: s.lastInputTokens ?? 0,
    outputTokens: s.lastOutputTokens ?? 0,
    tokensPerSec: s.lastTps,
    tpsEma: s.tpsEma,
    assistantCharsDelta,
    toolResultCharsDelta,
    userCharsDelta,
    whisperCharsDelta,
    whisperCountDelta,
    rssRing,
    rssBaselineBytes,
    rssSustainedGrowth: assessSustainedRssGrowth(rssRing, rssBaselineBytes),
  };
}

// ── self-state sample (Refine-2: every heartbeat self-aware) ────────────

/**
 * The self-state metrics one heartbeat summary line renders.
 * Every field is nullable: an unavailable metric renders "n/a", never zero
 * (zero looks like a healthy reading, n/a says telemetry is
 * missing).
 */
export interface SelfStateSample {
  /** Current context size in tokens (live read, not the last-tick snapshot). */
  contextTokens: number | null;
  /**
   * Where `contextTokens` came from: "measured" (an API response anchors it)
   * or "estimated" (chars-based walk). Null when no reading was available.
   * A telemetry reader that cannot tell the two apart cannot tell a large
   * context from a badly counted one.
   */
  contextTokensSource: "measured" | "estimated" | null;
  /** Cache-hit share, percent 0-100 (last assistant message). */
  cacheHitShare: number | null;
  /** Near-duplicate message count from the context-density evaluator. */
  nearDupCount: number | null;
  /** tok/s trend — the EMA over qualifying assistant messages. */
  tpsEma: number | null;
  /** Total turn-end hygiene ACTs recorded this session (0 when none). */
  hygieneActs: number | null;
}

/**
 * Sample the self-state metrics for the heartbeat self-state line.
 * Reads per-session state keys owned by this module (telemetry) and the
 * context-density evaluator (near-duplicates). Never throws — every read
 * is wrapped; missing state yields null ("n/a" in the rendered line).
 */
export function getSelfStateSample(ctx: ExtensionContext): SelfStateSample {
  const sample: SelfStateSample = {
    contextTokens: null,
    contextTokensSource: null,
    cacheHitShare: null,
    nearDupCount: null,
    tpsEma: null,
    hygieneActs: null,
  };
  try {
    // Context tokens: live read (compaction-aware session-tree measure),
    // not the last-tick snapshot — a summary rendered right after a slide
    // must not report the pre-slide size. Falls back to the duck-typed
    // accessor when the session tree is unavailable.
    const live = measureLiveUsage(ctx);
    if (live) {
      sample.contextTokens = live.tokens;
      sample.contextTokensSource = live.source;
    } else {
      const usage = getContextUsage(ctx);
      if (usage && typeof usage.tokens === "number") {
        sample.contextTokens = usage.tokens;
        sample.contextTokensSource = "estimated";
      }
    }
  } catch {
    /* keep null */
  }
  try {
    const s = telemetryState(ctx);
    sample.cacheHitShare =
      s.lastCacheHitShare !== null ? Math.round(s.lastCacheHitShare * 10) / 10 : null;
    sample.tpsEma = s.tpsEma !== null ? Math.round(s.tpsEma * 10) / 10 : null;
  } catch {
    /* keep nulls */
  }
  try {
    // Near-duplicates: written by context-lifecycle's density evaluator
    // (policy-engine.ts generateDensitySignals) on every before_agent_start.
    // Existence-gated: creating the bucket here would materialize a fake
    // "duplicates: 0" healthy reading — absent state must stay n/a.
    if (hasExtensionState(ctx, "context-density")) {
      const densityState = getExtensionState(ctx, "context-density", () => ({ duplicates: 0 })) as {
        duplicates?: number;
      };
      if (densityState && typeof densityState.duplicates === "number") {
        sample.nearDupCount = densityState.duplicates;
      }
    }
  } catch {
    /* keep null */
  }
  try {
    // Hygiene ACT counters: written by enforcement's turn-end hygiene act.
    // Existence-gated like nearDupCount: absent state stays null ("n/a").
    if (hasExtensionState(ctx, "enforcement")) {
      const enf = getExtensionState(ctx, "enforcement", () => ({})) as {
        contextHygieneActs?: { total?: number };
      };
      const total = enf?.contextHygieneActs?.total;
      if (typeof total === "number") sample.hygieneActs = total;
    }
  } catch {
    /* keep null */
  }
  return sample;
}
