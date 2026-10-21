/**
 * Braid Settings - unified reader for pi settings.json braid config.
 *
 * The settings.json file mixes pi-native settings with braid config under a
 * top-level `braid` key. This module reads that config safely and provides
 * a single source of truth for all braid-related feature flags.
 */

import { existsSync, readFileSync } from "node:fs";

import { createLogger } from "../core/logger.js";
import {
  USAGE_COMPACT_MEDIUM,
  USAGE_WHISPER_CRITICAL,
  USAGE_WHISPER_WARNING,
} from "../detection/context-thresholds.js";
import {
  MEMORY_WRITE_GATE_DEFAULTS,
  WRITE_GATE_SITES,
  type MemoryWriteGateConfig,
  type MemoryWriteGateMode,
  type WriteGateSite,
} from "../memory/write-quality.js";
import { getSettingsPath } from "./per-tool-settings.js";

const _log = createLogger("braid-settings");

interface BraidConfig {
  suppressNudges?: boolean;
  /**
   * Owner time zone (local-time standard).
   * IANA name — formatLocalTime() renders HH:MM TZ (UTC±X) in this zone.
   * Default: Europe/Moscow (owner TZ, UTC+3).
   *
   * Example: "braid": { "timezone": "Europe/Berlin" }
   */
  timezone?: string;
  /**
   * Enforcement-layer overrides. Schema-validated at read time by the
   * NudgeManager (which owns the NudgeType schema); invalid entries
   * are logged and dropped. Empty object = no overrides (use defaults).
   *
   * Example:
   *   "braid": {
   *     "enforcement": {
   *       "nudgeConfigs": {
   *         "validation": { "baseCooldownMs": 30000 },
   *         "malformed": { "deduplicate": false }
   *       }
   *     }
   *   }
   */
  enforcement?: {
    /**
     * Per-NudgeType config overrides. Keys are NudgeType values
     * (validation, recordFailure, malformed, memory, scratchpad,
     * context, sessionSignals). Values are partial NudgeConfig -
     * only the fields to override.
     */
    nudgeConfigs?: Record<string, unknown>;
    /**
     * Accusation-triggered irreversible-action gate. `mode` is "off"
     * (default, inert), "shadow" (whisper only) or "on" (block).
     */
    overCorrectionGate?: {
      mode?: string;
    };
  };
  /**
   * Orchestrator-layer config. `closeGateWellFormedness` gates the close
   * path's gate evidence at close time: every recorded `{cmd, exit}` row is
   * read as a string (parse, first-token resolution, no top-level
   * decoration) and a completed close's exits must be 0. No gate is re-run.
   *
   * Example:
   *   "braid": { "orchestrator": { "closeGateWellFormedness": "shadow" } }
   */
  orchestrator?: {
    /**
     * "shadow" (default) logs a failing row to the refusal log and lets the
     * close proceed; "enforce" refuses the close naming the row, predicate
     * and cmd; "off" skips the read entirely. An unknown value warns once
     * and falls back to "shadow".
     */
    closeGateWellFormedness?: string;
  };
  /**
   * Skills-layer config. `ranking` picks the tier policy of the `list_skills`
   * relevance ranking: "auto" (default: the deterministic scorer answers, and
   * the utility model is asked only when that answer is ambiguous), "keyword"
   * (never call the model), "model" (always).
   *
   * Example: "braid": { "skills": { "ranking": "keyword" } }
   */
  skills?: {
    /** "auto" | "keyword" | "model" — an unknown value falls back to "auto". */
    ranking?: string;
  };
  /**
   * Memory-layer config. Review-before-write quality gate on durable episode
   * writes: `writeGate` controls the per-site policies (repair/dedupe/reject)
   * and the heartbeat cooldown. Defaults live in
   * `lib/memory/write-quality.ts` (MEMORY_WRITE_GATE_DEFAULTS).
   */
  memory?: {
    /**
     * Write-quality gate on episode writes.
     *   enabled: gate ON by default (no-write for junk); false restores
     *     pre-gate behavior exactly.
     *   cooldownMs: minimum interval between gated heartbeat writes (anti-thrash).
     *   mode: "enforce" (default) applies decisions; "warn" logs them and
     *     writes anyway (staged rollout).
     *   sites: per-writer opt-out for incident rollback; false restores
     *     pre-gate behavior for that site.
     *
     * Example:
     *   "braid": { "memory": { "writeGate": { "enabled": true, "cooldownMs": 1800000, "mode": "warn" } } }
     */
    writeGate?: {
      enabled?: boolean;
      cooldownMs?: number;
      mode?: MemoryWriteGateMode;
      sites?: Partial<Record<WriteGateSite, boolean>>;
    };
  };
  /**
   * Context-layer config. decouples braid's effective context window
   * from provider catalog truth. The catalog keeps the true model context
   * size (packages/providers/** is untouched); this cap tunes the number
   * braid uses for its own computations (usage percent math, density
   * tokenRatio, window fallbacks).
   *
   * Example:
   *   "braid": { "context": { "contextLimitTokens": 262000 } }
   */
  /**
   * Timer-layer config. `maxWakeAttempts` bounds how many times a
   * failed wake fire (provider 401/413/5xx turn) is redelivered before it is
   * dropped with a visible exhausted-notice.
   *
   * Example:
   *   "braid": { "timers": { "maxWakeAttempts": 3 } }
   */
  session?: {
    /**
     * Terminal-error wake breaker: while a session has accumulated
     * `threshold` terminal-class LLM errors since its last clean turn, timer
     * wake fires are demoted to non-waking steers so they stop spending
     * doomed model calls. Which error classes are "terminal" is decided by
     * the enforcement health state, not here. Default { enabled: true,
     * threshold: 3 }.
     *
     * Example:
     *   "braid": { "session": { "terminalBreaker": { "enabled": false } } }
     */
    terminalBreaker?: {
      /** false disables the gate entirely (byte-identical to pre-gate behavior). */
      enabled?: boolean;
      /** Terminal errors before the gate closes. Default 3. */
      threshold?: number;
    };
  };
  timers?: {
    /**
     * Redelivery bound for a failed wake fire. Default 3
     * (MAX_WAKE_ATTEMPTS_DEFAULT). Integer 1..MAX_WAKE_ATTEMPTS_MAX; other
     * values are ignored with a once-per-process warning and treated as
     * unset.
     */
    maxWakeAttempts?: number;
    /**
     * Wake-delivery stall alerting: forwards dead-wake facts (repeated
     * outcome timeouts, exhausted redelivery drops) from the timer's retry
     * queue to the watchdog's wake-delivery condition, which pages the owner
     * out of band (telegram) — one alert per episode, one recovery line.
     * Default { mode: "on", outcomeTimeouts: 2 }.
     */
    wakeAlert?: {
      /** "off" disables the feed entirely (zero behavioral change). */
      mode?: "on" | "off";
      /** Outcome timeouts for ONE fire before the early stall page
       *  (integer 2..WAKE_ALERT_OUTCOME_TIMEOUTS_MAX; 1 would page on every
       *  normal long turn — the flood the 240s window exists to prevent). */
      outcomeTimeouts?: number;
    };
  };
  context?: {
    /**
     * Effective context window in tokens. Precedence (ONE resolver,
     * resolveContextLimitTokens): contextLimitTokens as a CEILING over the
     * model/provider contextWindow - min(cap, provider) when the provider
     * window is known, the cap alone when it is not; the cap never widens a
     * model past its true window. 0/negative/non-number are ignored with a
     * once-per-process warning and treated as unset.
     */
    contextLimitTokens?: number;
    /**
     * Age/size-based offload of stale large toolResults. Deterministic
     * (no LLM): eligible results are flushed losslessly to disk and replaced
     * in the per-request context by a stub. Default OFF — when absent or
     * disabled, zero behavior change. Resolver:
     * resolveStaleToolResultOffloadConfig; defaults in
     * STALE_TOOL_RESULT_OFFLOAD_DEFAULTS.
     *
     * Example:
     *   "braid": { "context": { "staleToolResultOffload": { "enabled": true } } }
     */
    staleToolResultOffload?: StaleToolResultOffloadSettings;
    /**
     * Emergency size-driven offload of the LARGEST toolResults
     * when a context_window (413 payload-too-large) error fires. Deterministic
     * (no LLM): the largest results are flushed losslessly to disk and replaced
     * in the per-request context by a stub, then the send is retried once.
     * This is the health-gate exception: it runs from llm-call's retry path,
     * the compaction context-window handler, and the heartbeat consolidation
     * gate's context_overflow branch — exactly when shrinking is needed and
     * the normal pipeline refuses. Default ON (a 413 loop burns quota; the
     * offload is lossless). Resolver: resolveContextEmergencyOffloadConfig;
     * defaults in CONTEXT_EMERGENCY_OFFLOAD_DEFAULTS.
     *
     * Example:
     *   "braid": { "context": { "contextEmergencyOffload": { "enabled": true } } }
     */
    contextEmergencyOffload?: ContextEmergencyOffloadSettings;
    /**
     * Capture-time cap on toolResult size. When a tool result
     * exceeds maxChars at capture time (tool_result event), the full content
     * is flushed to disk (same offload dir as the stale offloader) and the
     * stored session entry carries a stub + the first 500 chars. Screenshots
     * and base64 blobs never enter context in the first place. Default ON.
     * Resolver: resolveToolResultSizeCapConfig; defaults in
     * TOOL_RESULT_SIZE_CAP_DEFAULTS.
     */
    toolResultSizeCap?: ToolResultSizeCapSettings;
    /**
     * Usage-driven auto-arm of a deterministic slide compaction. When live
     * usage sits at or above armPercent for confirmTicks consecutive
     * heartbeat observations, ONE slide is armed through the same pending
     * queue the context_compress tool uses; it fires at the next turn
     * boundary, never mid-run. Default ON (a session that never gets a
     * manual cleanup still gets relief); set enabled=false to opt out.
     * Resolver: resolveAutoCompactConfig; defaults in
     * AUTO_COMPACT_DEFAULTS.
     *
     * Example:
     *   "braid": { "context": { "contextAutoCompact": { "enabled": false } } }
     */
    contextAutoCompact?: AutoCompactSettings;
  };
}

/** Raw (unvalidated) owner settings for braid.context.contextAutoCompact. */
export interface AutoCompactSettings {
  /** Master gate. Default true — sustained high usage must get relief. */
  enabled?: boolean;
  /** Usage percent at or above which an observation counts (1..100). */
  armPercent?: number;
  /** Consecutive above-threshold observations required before arming. */
  confirmTicks?: number;
}

/** Raw (unvalidated) owner settings for braid.context.contextEmergencyOffload. */
export interface ContextEmergencyOffloadSettings {
  /** Master gate. Default true — a 413 loop burns quota; shrinking must win. */
  enabled?: boolean;
  /** Minimum result size (chars) before a toolResult is eligible. */
  minChars?: number;
  /** Per-run cap on offloaded chars (bounds the rewrite of one context pass). */
  maxCharsPerRun?: number;
  /** Hard recency guard: never touch the last N tool results. */
  keepRecentTurns?: number;
}

/** Raw (unvalidated) owner settings for braid.context.toolResultSizeCap. */
export interface ToolResultSizeCapSettings {
  /** Master gate. Default true — oversized blobs must never enter context. */
  enabled?: boolean;
  /** Size threshold (chars) above which a toolResult is flushed + stubbed. */
  maxChars?: number;
}

/**
 * Raw (unvalidated) owner settings for braid.context.staleToolResultOffload.
 * All fields optional; validation/defaults live in
 * resolveStaleToolResultOffloadConfig.
 */
export interface StaleToolResultOffloadSettings {
  /** Master gate. Default false — the offloader never runs unless opted in. */
  enabled?: boolean;
  /** Minimum result size (chars) before a toolResult is eligible. */
  minChars?: number;
  /** Minimum age (in toolResults-after) before a result is eligible. */
  stalenessTurns?: number;
  /** Hard recency guard: never touch the last N tool results. */
  keepRecentTurns?: number;
  /** Per-LLM-call cap on offloaded chars (prevents mass rewrites in one turn). */
  maxOffloadCharsPerRun?: number;
}

interface Settings {
  braid?: BraidConfig;
  /**
   * pi-core's own retry config (top-level `retry` key, read by
   * settings-manager.getRetrySettings). Braid only READS it — for the
   * wake-retry hold window (getWakeRetryHoldMs) so the hold tracks the
   * actual pi-core retry budget instead of hardcoding one.
   */
  retry?: {
    maxRetries?: number;
    baseDelayMs?: number;
  };
  /**
   * pi-core's own compaction config (top-level `compaction` key, read by
   * settings-manager.getCompactionTokenSetting). Braid only READS it — to
   * detect a reserve that is incoherent with the effective window (see
   * applyCompactionReserveTokens).
   */
  compaction?: {
    reserveTokens?: number;
    modelOverrides?: Record<string, { reserveTokens?: number }>;
  };
}

/** Read and parse settings.json. Not cached - always reads fresh to respect runtime changes. */

/** Warned once per process about an unreadable settings.json. */
let _warnedUnreadableSettings = false;

function readSettings(): Settings {
  let result: Settings = {};
  try {
    if (existsSync(getSettingsPath())) {
      result = JSON.parse(readFileSync(getSettingsPath(), "utf-8")) as Settings;
    }
  } catch (e) {
    // Non-fatal: fall through to empty settings - but never silently: a
    // corrupt file reverts every braid setting (context cap, write gate,
    // timer redelivery bound, offload toggles) and that must be visible.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT" && !_warnedUnreadableSettings) {
      _warnedUnreadableSettings = true;
      _log.warn(
        "Cannot read settings.json - braid settings in it are ignored until " +
          "the file is fixed (using defaults).",
        { error: (e as Error).message },
      );
    }
  }
  return result;
}

/**
 * Whether cognitive nudges (enforcement whispers, heartbeat suggestions,
 * feedback reminders) should be suppressed entirely.
 *
 * Controlled by braid.suppressNudges in settings.json.
 * Default: false - nudges are ENABLED by default.
 *
 * A user who wants to skip Y/n prompts would set that in pi's native settings -
 * this flag only affects braid's own cognitive nudges.
 */
export function areCognitiveNudgesDisabled(): boolean {
  const settings = readSettings();
  if (settings.braid?.suppressNudges !== undefined) {
    return settings.braid.suppressNudges === true;
  }
  // Default: nudges are enabled (safe default - braid's value prop is ON)
  return false;
}

/**
 * Read the raw braid.enforcement.nudgeConfigs block from settings.json.
 *
 * Returns an UNVALIDATED shape. Callers must pass the result through
 * NudgeManager.validateNudgeConfig() (or parseNudgeConfigOverrides())
 * before constructing a NudgeManager - the validation lives next to
 * the NudgeType schema to keep the type knowledge in one place.
 *
 * Returns {} when:
 *   - settings.json doesn't exist
 *   - the braid key isn't present
 *   - the enforcement key isn't present
 *   - nudgeConfigs is missing or not an object
 */
export function getRawNudgeConfigOverrides(): Record<string, unknown> {
  const settings = readSettings();
  const raw = settings.braid?.enforcement?.nudgeConfigs;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

// ── over-correction gate (braid.enforcement.overCorrectionGate) ──────────
// The gate withholds a conservative set of destructive calls while a recent
// accusation or a hot acceptance signal is live (see
// extensions/enforcement/handlers/over-correction-gate.ts). Shipped default:
// off — the gate is inert until an operator opts in.

/** Gate modes: off (inert), shadow (whisper only), on (whisper + block). */
export type OverCorrectionGateMode = "off" | "shadow" | "on";

export interface OverCorrectionGateConfig {
  mode: OverCorrectionGateMode;
}

/** Default mode: off — the shipped default is inert. */
export const OVER_CORRECTION_GATE_DEFAULTS: OverCorrectionGateConfig = { mode: "off" };

/** Warned once per process about an invalid overCorrectionGate.mode. */
let _warnedInvalidOverCorrectionGate = false;

function _warnInvalidOverCorrectionGate(value: unknown): void {
  if (_warnedInvalidOverCorrectionGate) return;
  _warnedInvalidOverCorrectionGate = true;
  _log.warn(
    "Invalid braid.enforcement.overCorrectionGate in settings.json - ignoring and " +
      'using the default (mode "off"). Expected { mode: "off" | "shadow" | "on" }.',
    { value },
  );
}

/**
 * Pure resolver for braid.enforcement.overCorrectionGate. Absent block ⇒
 * mode "off". A non-object block or a mode outside the enum warns once and
 * falls back to "off", so a typo can never enable the gate. Kept pure so
 * the default merge is unit-testable without touching live settings.json.
 */
export function resolveOverCorrectionGate(raw: unknown): OverCorrectionGateConfig {
  if (raw === undefined || raw === null) return { ...OVER_CORRECTION_GATE_DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    _warnInvalidOverCorrectionGate(raw);
    return { ...OVER_CORRECTION_GATE_DEFAULTS };
  }
  const mode = (raw as { mode?: unknown }).mode;
  if (mode === "off" || mode === "shadow" || mode === "on") return { mode };
  _warnInvalidOverCorrectionGate(mode);
  return { ...OVER_CORRECTION_GATE_DEFAULTS };
}

/**
 * Read the effective over-correction gate config from settings.json, fresh
 * on every call (no caching), like the other readers. Default: mode "off".
 */
export function getOverCorrectionGateConfig(): OverCorrectionGateConfig {
  return resolveOverCorrectionGate(readSettings().braid?.enforcement?.overCorrectionGate);
}

// ── close-gate well-formedness (braid.orchestrator.closeGateWellFormedness) ──
// The close path reads every recorded gate evidence row {cmd, exit} against
// four string predicates before the row is stamped (see
// lib/orchestrator/workers.ts). Shipped default: shadow, so a failing row is
// logged and the close proceeds, and a first ship cannot refuse honest closes.

/** Close-gate modes: off (inert), shadow (log only), enforce (refuse). */
export type CloseGateWellFormednessMode = "off" | "shadow" | "enforce";

export interface CloseGateWellFormednessConfig {
  mode: CloseGateWellFormednessMode;
}

/** Default mode: shadow; the validator logs before it is allowed to refuse. */
export const CLOSE_GATE_WELL_FORMEDNESS_DEFAULTS: CloseGateWellFormednessConfig = {
  mode: "shadow",
};

/** Warned once per process about an invalid closeGateWellFormedness value. */
let _warnedInvalidCloseGateWellFormedness = false;

function _warnInvalidCloseGateWellFormedness(value: unknown): void {
  if (_warnedInvalidCloseGateWellFormedness) return;
  _warnedInvalidCloseGateWellFormedness = true;
  _log.warn(
    "Invalid braid.orchestrator.closeGateWellFormedness in settings.json - ignoring " +
      'and using the default (mode "shadow"). Expected "off" | "shadow" | "enforce".',
    { value },
  );
}

/**
 * Pure resolver for braid.orchestrator.closeGateWellFormedness. Absent value
 * ⇒ mode "shadow". A value outside the enum warns once and falls back to
 * "shadow", so a typo can neither silently disarm the validator (off) nor
 * arm it (enforce). Kept pure so the default merge is unit-testable without
 * touching live settings.json.
 */
export function resolveCloseGateWellFormedness(raw: unknown): CloseGateWellFormednessConfig {
  if (raw === undefined || raw === null) return { ...CLOSE_GATE_WELL_FORMEDNESS_DEFAULTS };
  if (raw === "off" || raw === "shadow" || raw === "enforce") return { mode: raw };
  _warnInvalidCloseGateWellFormedness(raw);
  return { ...CLOSE_GATE_WELL_FORMEDNESS_DEFAULTS };
}

/**
 * Read the effective close-gate well-formedness mode from settings.json,
 * fresh on every call (no caching), like the other readers. Default: mode
 * "shadow".
 */
export function getCloseGateWellFormedness(): CloseGateWellFormednessConfig {
  return resolveCloseGateWellFormedness(
    readSettings().braid?.orchestrator?.closeGateWellFormedness,
  );
}

/**
 * Read the braid.memory.writeGate block from settings.json.
 *
 * Returns MEMORY_WRITE_GATE_DEFAULTS (gate ON, mode "enforce") when the block
 * is absent or any field is invalid — junk is not written unless an operator
 * explicitly opts the gate out. Settings-only by design: no env vars
 * (settings-over-env).
 */
export function getMemoryWriteGateConfig(): MemoryWriteGateConfig {
  const settings = readSettings();
  return resolveMemoryWriteGateConfig(
    settings.braid?.memory?.writeGate as RawWriteGateBlock | undefined,
  );
}

/** Raw settings block as read from JSON — every field validated in the resolver. */
interface RawWriteGateBlock {
  enabled?: unknown;
  cooldownMs?: unknown;
  mode?: unknown;
  sites?: unknown;
}

/**
 * Pure resolver for the braid.memory.writeGate block. Absent/partial/invalid
 * fields fall back to MEMORY_WRITE_GATE_DEFAULTS (mode "enforce", sites empty
 * = every site gated). Unknown site keys and non-boolean opt-outs are dropped,
 * so a typo cannot silently disable a writer. Kept pure so the default merge
 * is unit-testable without touching live settings.json.
 */
export function resolveMemoryWriteGateConfig(raw?: RawWriteGateBlock): MemoryWriteGateConfig {
  const enabled =
    typeof raw?.enabled === "boolean" ? raw.enabled : MEMORY_WRITE_GATE_DEFAULTS.enabled;
  const cooldownMs =
    typeof raw?.cooldownMs === "number" && raw.cooldownMs >= 0
      ? raw.cooldownMs
      : MEMORY_WRITE_GATE_DEFAULTS.cooldownMs;
  const mode: MemoryWriteGateMode =
    raw?.mode === "warn" || raw?.mode === "enforce" ? raw.mode : MEMORY_WRITE_GATE_DEFAULTS.mode;
  return { enabled, cooldownMs, mode, sites: normalizeWriteGateSites(raw?.sites) };
}

/** Keep only known site names with boolean values; absent = gated. */
function normalizeWriteGateSites(raw: unknown): Partial<Record<WriteGateSite, boolean>> {
  const sites: Partial<Record<WriteGateSite, boolean>> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return sites;
  for (const site of WRITE_GATE_SITES) {
    const value = (raw as Record<string, unknown>)[site];
    if (typeof value === "boolean") sites[site] = value;
  }
  return sites;
}

/**
 * The owner time zone for all braid-facing time rendering (lib/utils/local-time.ts).
 * braid.timezone in settings.json when set to a non-empty string; otherwise
 * DEFAULT_TIME_ZONE (Europe/Moscow). Never throws; an invalid IANA name is
 * the caller's concern (local-time.ts validates and falls back).
 */
export const DEFAULT_TIME_ZONE = "Europe/Moscow";

export function getOwnerTimeZone(): string {
  const settings = readSettings();
  const tz = settings.braid?.timezone;
  return typeof tz === "string" && tz.trim() ? tz.trim() : DEFAULT_TIME_ZONE;
}

// ── skills ranking (braid.skills.ranking) ──────────────────────────────────

/**
 * Which tier may answer the `list_skills` relevance ranking.
 *
 *   keyword — the deterministic scorer answers (the only implemented value;
 *             the default).
 *   auto    — reserved: the policy wrote down for a model tier that would
 *             answer only on an ambiguous deterministic verdict. Measured and
 *             not kept, so it currently evaluates to the keyword path.
 *   model   — reserved: the model answers whenever a task text exists. Same
 *             status as "auto".
 */
export type SkillsRankingMode = "auto" | "keyword" | "model";

export const SKILLS_RANKING_DEFAULT: SkillsRankingMode = "keyword";

/**
 * Resolve the ranking mode from a raw setting value. Unknown or malformed
 * values fall back to the default rather than guessing: a typo must not turn a
 * cheap catalog read into anything else. Pure.
 */
export function resolveSkillsRankingMode(raw: unknown): SkillsRankingMode {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return value === "keyword" || value === "model" || value === "auto"
    ? (value as SkillsRankingMode)
    : SKILLS_RANKING_DEFAULT;
}

/** Read braid.skills.ranking from settings.json (default: "keyword"). */
export function getSkillsRankingMode(): SkillsRankingMode {
  return resolveSkillsRankingMode(readSettings().braid?.skills?.ranking);
}

// ── stale toolResult offload (braid.context.staleToolResultOffload) ────

/**
 * Sane defaults for the optional staleToolResultOffload params (defined next
 * to the schema per the design contract). Investigation suggests a size
 * floor of ~4k chars and a keep-recent window of ~20 calls; stalenessTurns
 * adds a conservative age policy above the guard; maxOffloadCharsPerRun
 * bounds the per-request rewrite to 64k chars.
 */
export const STALE_TOOL_RESULT_OFFLOAD_DEFAULTS = {
  enabled: false,
  minChars: 4_000,
  stalenessTurns: 40,
  keepRecentTurns: 20,
  maxOffloadCharsPerRun: 65_536,
} as const;

/** The validated, effective staleToolResultOffload config. */
export interface ResolvedStaleToolResultOffloadConfig {
  enabled: boolean;
  minChars: number;
  stalenessTurns: number;
  keepRecentTurns: number;
  maxOffloadCharsPerRun: number;
}

/** Warned once per process about an invalid braid.context.staleToolResultOffload. */
let _warnedInvalidStaleToolResultOffload = false;

function _warnInvalidStaleToolResultOffload(value: unknown): void {
  if (_warnedInvalidStaleToolResultOffload) return;
  _warnedInvalidStaleToolResultOffload = true;
  _log.warn(
    "Invalid braid.context.staleToolResultOffload in settings.json - ignoring " +
      "invalid fields and using defaults (offloader stays OFF unless enabled is true).",
    { value },
  );
}

/**
 * Pure resolver for the braid.context.staleToolResultOffload block.
 * Absent → all defaults (enabled: false). Non-object shape, or any field
 * violating its type/range, falls back to that field's default; the FIRST
 * invalid input also emits a once-per-process warning (mirrors the
 * log-once pattern). Kept pure so the default merge is unit-testable without
 * touching live settings.json.
 */
export function resolveStaleToolResultOffloadConfig(
  raw: unknown,
): ResolvedStaleToolResultOffloadConfig {
  const defaults: ResolvedStaleToolResultOffloadConfig = STALE_TOOL_RESULT_OFFLOAD_DEFAULTS;
  if (raw === undefined) {
    return {
      enabled: defaults.enabled,
      minChars: defaults.minChars,
      stalenessTurns: defaults.stalenessTurns,
      keepRecentTurns: defaults.keepRecentTurns,
      maxOffloadCharsPerRun: defaults.maxOffloadCharsPerRun,
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    _warnInvalidStaleToolResultOffload(raw);
    return {
      enabled: defaults.enabled,
      minChars: defaults.minChars,
      stalenessTurns: defaults.stalenessTurns,
      keepRecentTurns: defaults.keepRecentTurns,
      maxOffloadCharsPerRun: defaults.maxOffloadCharsPerRun,
    };
  }
  const r = raw as StaleToolResultOffloadSettings;
  const d: ResolvedStaleToolResultOffloadConfig = STALE_TOOL_RESULT_OFFLOAD_DEFAULTS;
  let invalid = false;
  let enabled = d.enabled;
  if (typeof r.enabled === "boolean") {
    enabled = r.enabled;
  } else if (r.enabled !== undefined) {
    invalid = true;
  }
  let minChars = d.minChars;
  if (typeof r.minChars === "number" && Number.isFinite(r.minChars) && r.minChars >= 0) {
    minChars = r.minChars;
  } else if (r.minChars !== undefined) {
    invalid = true;
  }
  let stalenessTurns = d.stalenessTurns;
  if (
    typeof r.stalenessTurns === "number" &&
    Number.isInteger(r.stalenessTurns) &&
    r.stalenessTurns >= 1
  ) {
    stalenessTurns = r.stalenessTurns;
  } else if (r.stalenessTurns !== undefined) {
    invalid = true;
  }
  let keepRecentTurns = d.keepRecentTurns;
  if (
    typeof r.keepRecentTurns === "number" &&
    Number.isInteger(r.keepRecentTurns) &&
    r.keepRecentTurns >= 0
  ) {
    keepRecentTurns = r.keepRecentTurns;
  } else if (r.keepRecentTurns !== undefined) {
    invalid = true;
  }
  let maxOffloadCharsPerRun = d.maxOffloadCharsPerRun;
  if (
    typeof r.maxOffloadCharsPerRun === "number" &&
    Number.isFinite(r.maxOffloadCharsPerRun) &&
    r.maxOffloadCharsPerRun >= 1
  ) {
    maxOffloadCharsPerRun = r.maxOffloadCharsPerRun;
  } else if (r.maxOffloadCharsPerRun !== undefined) {
    invalid = true;
  }
  if (invalid) _warnInvalidStaleToolResultOffload(raw);
  return { enabled, minChars, stalenessTurns, keepRecentTurns, maxOffloadCharsPerRun };
}

/**
 * Read the effective staleToolResultOffload config from settings.json, fresh
 * on every call (no caching), like the other readers. Default: all defaults
 * with enabled=false (the offloader is a no-op unless the owner opts in).
 */
export function getStaleToolResultOffloadConfig(): ResolvedStaleToolResultOffloadConfig {
  return resolveStaleToolResultOffloadConfig(readSettings().braid?.context?.staleToolResultOffload);
}

// ── emergency context-window offload (braid.context.contextEmergencyOffload) ──

/**
 * Defaults for the P0-A emergency offloader. The size floor matches the P0-B
 * capture cap (256KB): below that, a 413 is not caused by this class of blob.
 * Per-run budget of 1MB chars covers several oversized results in one pass.
 * keepRecentTurns=1: the immediately-latest toolResult stays visible so the
 * agent keeps the freshest decision evidence; everything older is fair game
 * in an emergency (sendability outranks recency, and the flush is lossless).
 */
export const CONTEXT_EMERGENCY_OFFLOAD_DEFAULTS = {
  enabled: true,
  minChars: 262_144,
  maxCharsPerRun: 1_048_576,
  keepRecentTurns: 1,
} as const;

/** The validated, effective contextEmergencyOffload config. */
export interface ResolvedContextEmergencyOffloadConfig {
  enabled: boolean;
  minChars: number;
  maxCharsPerRun: number;
  keepRecentTurns: number;
}

/** Warned once per process about an invalid braid.context.contextEmergencyOffload. */
let _warnedInvalidContextEmergencyOffload = false;

function _warnInvalidContextEmergencyOffload(value: unknown): void {
  if (_warnedInvalidContextEmergencyOffload) return;
  _warnedInvalidContextEmergencyOffload = true;
  _log.warn(
    "Invalid braid.context.contextEmergencyOffload in settings.json - ignoring " +
      "invalid fields and using defaults (emergency offload stays ON unless " +
      "enabled is explicitly false).",
    { value },
  );
}

/**
 * Pure resolver for the braid.context.contextEmergencyOffload block.
 * Absent → all defaults (enabled: true — the 413 fix must be active by
 * default). Non-object shape, or any field violating its type/range, falls
 * back to that field's default; the FIRST invalid input also emits a
 * once-per-process warning (mirrors the log-once pattern). Kept pure so
 * the default merge is unit-testable without touching live settings.json.
 */
export function resolveContextEmergencyOffloadConfig(
  raw: unknown,
): ResolvedContextEmergencyOffloadConfig {
  const defaults: ResolvedContextEmergencyOffloadConfig = CONTEXT_EMERGENCY_OFFLOAD_DEFAULTS;
  if (raw === undefined) {
    return { ...defaults };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    _warnInvalidContextEmergencyOffload(raw);
    return { ...defaults };
  }
  const r = raw as ContextEmergencyOffloadSettings;
  const d: ResolvedContextEmergencyOffloadConfig = CONTEXT_EMERGENCY_OFFLOAD_DEFAULTS;
  let invalid = false;
  let enabled = d.enabled;
  if (typeof r.enabled === "boolean") {
    enabled = r.enabled;
  } else if (r.enabled !== undefined) {
    invalid = true;
  }
  let minChars = d.minChars;
  if (typeof r.minChars === "number" && Number.isFinite(r.minChars) && r.minChars >= 1) {
    minChars = r.minChars;
  } else if (r.minChars !== undefined) {
    invalid = true;
  }
  let maxCharsPerRun = d.maxCharsPerRun;
  if (
    typeof r.maxCharsPerRun === "number" &&
    Number.isFinite(r.maxCharsPerRun) &&
    r.maxCharsPerRun >= minChars
  ) {
    maxCharsPerRun = r.maxCharsPerRun;
  } else if (r.maxCharsPerRun !== undefined) {
    invalid = true;
  }
  let keepRecentTurns = d.keepRecentTurns;
  if (
    typeof r.keepRecentTurns === "number" &&
    Number.isInteger(r.keepRecentTurns) &&
    r.keepRecentTurns >= 0
  ) {
    keepRecentTurns = r.keepRecentTurns;
  } else if (r.keepRecentTurns !== undefined) {
    invalid = true;
  }
  if (invalid) _warnInvalidContextEmergencyOffload(raw);
  return { enabled, minChars, maxCharsPerRun, keepRecentTurns };
}

/**
 * Read the effective contextEmergencyOffload config from settings.json, fresh
 * on every call (no caching), like the other readers. Default: enabled=true.
 */
export function getContextEmergencyOffloadConfig(): ResolvedContextEmergencyOffloadConfig {
  return resolveContextEmergencyOffloadConfig(
    readSettings().braid?.context?.contextEmergencyOffload,
  );
}

// ── capture-time toolResult size cap (braid.context.toolResultSizeCap) ─

/**
 * Defaults for the P0-B capture cap: 256KB (chars) — a blob over this is a
 * screenshot/base64-class payload that never belongs in context. Default ON:
 * capture-time substitution is lossless (full content flushed to disk first)
 * and strictly cheaper than the 413 loops it prevents.
 */
export const TOOL_RESULT_SIZE_CAP_DEFAULTS = {
  enabled: true,
  maxChars: 262_144,
} as const;

/** The validated, effective toolResultSizeCap config. */
export interface ResolvedToolResultSizeCapConfig {
  enabled: boolean;
  maxChars: number;
}

/** Warned once per process about an invalid braid.context.toolResultSizeCap. */
let _warnedInvalidToolResultSizeCap = false;

function _warnInvalidToolResultSizeCap(value: unknown): void {
  if (_warnedInvalidToolResultSizeCap) return;
  _warnedInvalidToolResultSizeCap = true;
  _log.warn(
    "Invalid braid.context.toolResultSizeCap in settings.json - ignoring " +
      "invalid fields and using defaults (capture cap stays ON unless " +
      "enabled is explicitly false).",
    { value },
  );
}

/**
 * Pure resolver for the braid.context.toolResultSizeCap block.
 * Absent → all defaults (enabled: true). Non-object shape, or any field
 * violating its type/range, falls back to that field's default with a
 * once-per-process warning. Kept pure for unit-testability.
 */
export function resolveToolResultSizeCapConfig(raw: unknown): ResolvedToolResultSizeCapConfig {
  const defaults: ResolvedToolResultSizeCapConfig = TOOL_RESULT_SIZE_CAP_DEFAULTS;
  if (raw === undefined) {
    return { ...defaults };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    _warnInvalidToolResultSizeCap(raw);
    return { ...defaults };
  }
  const r = raw as ToolResultSizeCapSettings;
  const d: ResolvedToolResultSizeCapConfig = TOOL_RESULT_SIZE_CAP_DEFAULTS;
  let invalid = false;
  let enabled = d.enabled;
  if (typeof r.enabled === "boolean") {
    enabled = r.enabled;
  } else if (r.enabled !== undefined) {
    invalid = true;
  }
  let maxChars = d.maxChars;
  if (typeof r.maxChars === "number" && Number.isFinite(r.maxChars) && r.maxChars >= 1) {
    maxChars = r.maxChars;
  } else if (r.maxChars !== undefined) {
    invalid = true;
  }
  if (invalid) _warnInvalidToolResultSizeCap(raw);
  return { enabled, maxChars };
}

/**
 * Read the effective toolResultSizeCap config from settings.json, fresh on
 * every call (no caching), like the other readers. Default: enabled=true.
 */
export function getToolResultSizeCapConfig(): ResolvedToolResultSizeCapConfig {
  return resolveToolResultSizeCapConfig(readSettings().braid?.context?.toolResultSizeCap);
}

// ── usage-driven auto-arm of a slide compaction (braid.context.contextAutoCompact) ─

/**
 * Defaults for the usage-driven auto-arm. Default ON: an armed cleanup that
 * never lands while a run stays alive is the failure mode this exists to
 * close, and the armed action is the deterministic slide (no LLM call, cut
 * bounded by the keep window). confirmTicks=2 makes "crosses and STAYS there"
 * the arming condition — a transient spike never arms.
 */
export const AUTO_COMPACT_DEFAULTS = {
  enabled: true,
  armPercent: 60,
  confirmTicks: 2,
} as const;

/** The validated, effective contextAutoCompact config. */
export interface ResolvedAutoCompactConfig {
  enabled: boolean;
  armPercent: number;
  confirmTicks: number;
}

/** Warned once per process about an invalid braid.context.contextAutoCompact. */
let _warnedInvalidAutoCompact = false;

function _warnInvalidAutoCompact(value: unknown): void {
  if (_warnedInvalidAutoCompact) return;
  _warnedInvalidAutoCompact = true;
  _log.warn(
    "Invalid braid.context.contextAutoCompact in settings.json - ignoring " +
      "invalid fields and using defaults (auto-arm stays ON unless " +
      "enabled is explicitly false).",
    { value },
  );
}

/**
 * Pure resolver for the braid.context.contextAutoCompact block.
 * Absent → all defaults. Non-object shape, or any field violating its
 * type/range (armPercent must be 1..100, confirmTicks an integer >= 1), falls
 * back to that field's default with a once-per-process warning. Kept pure for
 * unit-testability.
 */
export function resolveAutoCompactConfig(raw: unknown): ResolvedAutoCompactConfig {
  const d: ResolvedAutoCompactConfig = AUTO_COMPACT_DEFAULTS;
  if (raw === undefined) {
    return { ...d };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    _warnInvalidAutoCompact(raw);
    return { ...d };
  }
  const r = raw as AutoCompactSettings;
  let invalid = false;
  let enabled = d.enabled;
  if (typeof r.enabled === "boolean") {
    enabled = r.enabled;
  } else if (r.enabled !== undefined) {
    invalid = true;
  }
  let armPercent = d.armPercent;
  if (
    typeof r.armPercent === "number" &&
    Number.isFinite(r.armPercent) &&
    r.armPercent >= 1 &&
    r.armPercent <= 100
  ) {
    armPercent = r.armPercent;
  } else if (r.armPercent !== undefined) {
    invalid = true;
  }
  let confirmTicks = d.confirmTicks;
  if (
    typeof r.confirmTicks === "number" &&
    Number.isInteger(r.confirmTicks) &&
    r.confirmTicks >= 1
  ) {
    confirmTicks = r.confirmTicks;
  } else if (r.confirmTicks !== undefined) {
    invalid = true;
  }
  if (invalid) _warnInvalidAutoCompact(raw);
  return { enabled, armPercent, confirmTicks };
}

/**
 * Read the effective contextAutoCompact config from settings.json, fresh on
 * every call (no caching), like the other readers. Default: enabled=true.
 */
export function getAutoCompactConfig(): ResolvedAutoCompactConfig {
  return resolveAutoCompactConfig(readSettings().braid?.context?.contextAutoCompact);
}

// ── wake-retry redelivery cap (braid.timers.maxWakeAttempts) ─────────

/** Default redelivery bound for a failed wake fire. */
export const MAX_WAKE_ATTEMPTS_DEFAULT = 3;

/** Upper bound for the braid.timers.maxWakeAttempts setting. */
export const MAX_WAKE_ATTEMPTS_MAX = 10;

/** Warned once per process about an invalid braid.timers.maxWakeAttempts. */
let _warnedInvalidMaxWakeAttempts = false;

function _warnInvalidMaxWakeAttempts(value: unknown): void {
  if (_warnedInvalidMaxWakeAttempts) return;
  _warnedInvalidMaxWakeAttempts = true;
  _log.warn(
    "Invalid braid.timers.maxWakeAttempts in settings.json - ignoring and " +
      `using the default (${MAX_WAKE_ATTEMPTS_DEFAULT}). Expected an integer 1..${MAX_WAKE_ATTEMPTS_MAX}.`,
    { value },
  );
}

/**
 * Pure resolver for braid.timers.maxWakeAttempts. Absent →
 * MAX_WAKE_ATTEMPTS_DEFAULT; an integer 1..MAX_WAKE_ATTEMPTS_MAX passes
 * through; anything else warns once and falls back to the default. Kept pure
 * so the validation is unit-testable without touching live settings.json.
 */
export function resolveMaxWakeAttempts(raw: unknown): number {
  if (raw === undefined) return MAX_WAKE_ATTEMPTS_DEFAULT;
  if (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= 1 &&
    raw <= MAX_WAKE_ATTEMPTS_MAX
  ) {
    return raw;
  }
  _warnInvalidMaxWakeAttempts(raw);
  return MAX_WAKE_ATTEMPTS_DEFAULT;
}

/**
 * Read the effective wake-retry redelivery cap from settings.json, fresh on
 * every call (no caching), like the other readers. Default:
 * MAX_WAKE_ATTEMPTS_DEFAULT (3).
 */
export function getMaxWakeAttempts(): number {
  return resolveMaxWakeAttempts(readSettings().braid?.timers?.maxWakeAttempts);
}

// ── terminal-error wake breaker (braid.session.terminalBreaker) ──────────

/** Default terminal-error count before timer wakes stop starting turns. */
export const TERMINAL_BREAKER_DEFAULT_THRESHOLD = 3;
/** Upper bound for a configured threshold (guards a typo'd huge value). */
export const TERMINAL_BREAKER_THRESHOLD_MAX = 20;

export interface TerminalBreakerConfig {
  /** Master gate. Default true. */
  enabled: boolean;
  /** Terminal-class errors before wakes stop waking. Default 3. */
  threshold: number;
}

/** Warned once per process about an invalid terminalBreaker.threshold. */
let _warnedInvalidTerminalBreakerThreshold = false;

/**
 * Pure resolver for braid.session.terminalBreaker. Absent block ⇒ default-on
 * with threshold 3. `enabled: false` ⇒ the gate is off. A threshold that is
 * not an integer 1..TERMINAL_BREAKER_THRESHOLD_MAX warns once and falls back
 * to the default. Kept pure so the validation is unit-testable without
 * touching live settings.json.
 */
export function resolveTerminalBreaker(raw: unknown): TerminalBreakerConfig {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return { enabled: true, threshold: TERMINAL_BREAKER_DEFAULT_THRESHOLD };
  }
  const block = raw as { enabled?: unknown; threshold?: unknown };
  const enabled = block.enabled !== false;
  const threshold = block.threshold;
  if (threshold === undefined) {
    return { enabled, threshold: TERMINAL_BREAKER_DEFAULT_THRESHOLD };
  }
  if (
    typeof threshold === "number" &&
    Number.isInteger(threshold) &&
    threshold >= 1 &&
    threshold <= TERMINAL_BREAKER_THRESHOLD_MAX
  ) {
    return { enabled, threshold };
  }
  if (!_warnedInvalidTerminalBreakerThreshold) {
    _warnedInvalidTerminalBreakerThreshold = true;
    _log.warn(
      "Invalid braid.session.terminalBreaker.threshold in settings.json - ignoring and " +
        `using the default (${TERMINAL_BREAKER_DEFAULT_THRESHOLD}). Expected an integer 1..${TERMINAL_BREAKER_THRESHOLD_MAX}.`,
      { value: threshold },
    );
  }
  return { enabled, threshold: TERMINAL_BREAKER_DEFAULT_THRESHOLD };
}

/**
 * Read the effective terminal-error wake-breaker config from settings.json,
 * fresh on every call (no caching), like the other readers. The wake path
 * reads this once per fire.
 */
export function getTerminalBreakerConfig(): TerminalBreakerConfig {
  return resolveTerminalBreaker(readSettings().braid?.session?.terminalBreaker);
}

// ── wake-delivery stall alert (braid.timers.wakeAlert) ───────────────

/** Default wake-delivery alerting: on, page after 2 outcome timeouts. */
export const WAKE_DELIVERY_ALERT_DEFAULT: WakeDeliveryAlertConfig = {
  mode: "on",
  outcomeTimeouts: 2,
};

/** Upper bound for the outcome-timeout page threshold. */
export const WAKE_ALERT_OUTCOME_TIMEOUTS_MAX = 10;

export interface WakeDeliveryAlertConfig {
  /** "off" disables the timer→watchdog feed entirely. */
  mode: "on" | "off";
  /** Outcome timeouts for ONE fire before the early stall page. */
  outcomeTimeouts: number;
}

/** Warned once per process about an invalid braid.timers.wakeAlert. */
let _warnedInvalidWakeAlert = false;

function _warnInvalidWakeAlert(value: unknown): void {
  if (_warnedInvalidWakeAlert) return;
  _warnedInvalidWakeAlert = true;
  _log.warn(
    "Invalid braid.timers.wakeAlert in settings.json - ignoring it and using " +
      `the defaults (mode ${WAKE_DELIVERY_ALERT_DEFAULT.mode}, outcomeTimeouts ` +
      `${WAKE_DELIVERY_ALERT_DEFAULT.outcomeTimeouts}). Expected { mode: "on" | "off", ` +
      `outcomeTimeouts: integer 2..${WAKE_ALERT_OUTCOME_TIMEOUTS_MAX} }.`,
    { value },
  );
}

/**
 * Pure resolver for braid.timers.wakeAlert. Absent → defaults; mode
 * "on"/"off" passes through; outcomeTimeouts must be an integer 2..MAX (1
 * would page on every normal long turn — the flood the 240s outcome window
 * exists to prevent). An invalid present value warns once and falls back to
 * the default for that field. Kept pure so the validation is unit-testable
 * without touching live settings.json.
 */
export function resolveWakeDeliveryAlertConfig(raw: unknown): WakeDeliveryAlertConfig {
  const cfg: WakeDeliveryAlertConfig = { ...WAKE_DELIVERY_ALERT_DEFAULT };
  if (raw === undefined) return cfg;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    _warnInvalidWakeAlert(raw);
    return cfg;
  }
  const r = raw as Record<string, unknown>;
  if (r.mode === "on" || r.mode === "off") cfg.mode = r.mode;
  else if (r.mode !== undefined) _warnInvalidWakeAlert(raw);
  const t = r.outcomeTimeouts;
  if (
    typeof t === "number" &&
    Number.isInteger(t) &&
    t >= 2 &&
    t <= WAKE_ALERT_OUTCOME_TIMEOUTS_MAX
  ) {
    cfg.outcomeTimeouts = t;
  } else if (t !== undefined) {
    _warnInvalidWakeAlert(raw);
  }
  return cfg;
}

/**
 * Read the effective wake-delivery alert config from settings.json, fresh on
 * every call (no caching), like the other readers. Default: mode "on",
 * outcomeTimeouts 2.
 */
export function getWakeDeliveryAlertConfig(): WakeDeliveryAlertConfig {
  return resolveWakeDeliveryAlertConfig(readSettings().braid?.timers?.wakeAlert);
}

// ── pi-core auto-retry budget (top-level `retry` key) ─────────────────

/** Upper bound for the wake-retry hold window (a hold must stay bounded). */
export const WAKE_RETRY_HOLD_MAX_MS = 300_000;

/**
 * Pure resolver for the wake-retry hold window: pi-core auto-retries a
 * retryable provider failure inside the SAME run with backoff
 * `baseDelayMs * 2^attempt` up to maxRetries (settings-manager
 * .getRetrySettings defaults: 2000ms, 3 retries). The hold window mirrors
 * that budget: baseDelayMs * 2^maxRetries (16s with pi-core defaults),
 * clamped to [0, WAKE_RETRY_HOLD_MAX_MS]. Kept pure for unit-testability.
 */
export function resolveWakeRetryHoldMs(raw?: {
  maxRetries?: number;
  baseDelayMs?: number;
}): number {
  const maxRetries =
    typeof raw?.maxRetries === "number" && Number.isFinite(raw.maxRetries) && raw.maxRetries >= 0
      ? Math.floor(raw.maxRetries)
      : 3;
  const baseDelayMs =
    typeof raw?.baseDelayMs === "number" && Number.isFinite(raw.baseDelayMs) && raw.baseDelayMs >= 0
      ? raw.baseDelayMs
      : 2000;
  const budget = baseDelayMs * 2 ** Math.min(maxRetries, 16);
  return Math.min(Math.max(Math.floor(budget), 0), WAKE_RETRY_HOLD_MAX_MS);
}

/**
 * The effective wake-retry hold window, read fresh on every call (no
 * caching): pi-core's `retry` budget from settings.json, clamped.
 */
export function getWakeRetryHoldMs(): number {
  return resolveWakeRetryHoldMs(readSettings().retry);
}

// ── effective context window (contextLimitTokens) ──────────────────────

/** Warned once per process about an invalid braid.context.contextLimitTokens. */
let _warnedInvalidContextLimitTokens = false;

/**
 * Pure resolver for the effective context window. Precedence:
 *
 *   1. `contextLimitTokens` when it is a positive finite number - a
 *      CEILING, not a blind rewrite: min(cap, provider window) when the
 *      provider window is known positive, the cap alone otherwise.
 *   2. `providerContextWindow` (model/provider truth) when positive finite.
 *   3. undefined — caller applies its own terminal default.
 *
 * The cap can never widen a model past its catalog size: a manual pick
 * whose true window is below the cap keeps that true window. Unset
 * (`undefined`) silently falls through to provider truth; any other
 * non-conforming value (0, negative, non-number, non-finite) is ignored with
 * a once-per-process warning and also falls through. Kept pure so the
 * precedence merge is unit-testable without touching live settings.json.
 */
export function resolveContextLimitTokens(
  raw: unknown,
  providerContextWindow?: number | null,
): number | undefined {
  const provider =
    typeof providerContextWindow === "number" &&
    Number.isFinite(providerContextWindow) &&
    providerContextWindow > 0
      ? providerContextWindow
      : undefined;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return provider !== undefined ? Math.min(raw, provider) : raw;
  }
  if (raw !== undefined && !_warnedInvalidContextLimitTokens) {
    _warnedInvalidContextLimitTokens = true;
    _log.warn(
      "Invalid braid.context.contextLimitTokens in settings.json - ignoring " +
        "and using the provider context window instead.",
      { value: raw },
    );
  }
  return provider;
}

/**
 * The effective context window braid uses for its computations, resolved
 * through the ONE resolver: braid.context.contextLimitTokens override,
 * else the provider/model context window. Returns undefined when neither is
 * known - callers apply their own terminal default (e.g. 200000, 100_000).
 * Reads settings fresh on every call (no caching), like the other readers.
 */
export function getResolvedContextWindow(
  providerContextWindow?: number | null,
): number | undefined {
  return resolveContextLimitTokens(
    readSettings().braid?.context?.contextLimitTokens,
    providerContextWindow,
  );
}

/**
 * The RAW configured window override (braid.context.contextLimitTokens),
 * undefined when unset. Separated from getResolvedContextWindow so callers
 * that must label the window source (configured vs provider) can read the
 * override directly instead of reverse-engineering it from the merged value.
 */
export function getConfiguredContextLimitTokens(): number | undefined {
  const raw = readSettings().braid?.context?.contextLimitTokens;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

// ── plumb the configured window into pi-core (the executed invariant) ──

/** Warned once per process when the configured window could not be applied. */
let _warnedUnapplyableContextWindow = false;

export interface ConfiguredWindowApplyResult {
  /** true = the session model now reports the configured window. */
  applied: boolean;
  /** The window pi-core reports for the session model after the call. */
  contextWindow?: number;
  /** Why nothing changed: unset | no-model | unchanged | frozen. */
  reason?: "unset" | "no-model" | "unchanged" | "frozen";
}

/**
 * Make the session model report the configured window so pi-core's OWN
 * compaction decisions use it. pi-core reads `model.contextWindow` at every
 * window-dependent decision point (threshold compaction in
 * `_compactBeforeNextAssistantResponse` / `_checkCompaction` via
 * `shouldCompact`, overflow detection, usage percent); it never sees braid's
 * setting today, so when `contextLimitTokens < provider window` no automatic
 * actor can fire and the configured cap is enforced by nobody.
 *
 * This is the write side of the ONE resolver: same setting, same validation
 * (`getConfiguredContextLimitTokens`), same ceiling merge. The value written
 * is the resolver's effective window, so the setting can never widen a model
 * past its true window (configured 1M over a 202752 model leaves 202752 in
 * place); only an unknown true window takes the cap alone. When the setting
 * is unset or invalid this is a no-op and pi-core keeps provider-window
 * semantics. The model object is the live `agent.state.model` instance
 * pi-core hands to the extension context, so patching it in place steers
 * every downstream reader; a frozen object (models.json-derived catalogs)
 * degrades to a once-per-process warning and provider semantics rather than
 * throwing mid-run.
 *
 * Idempotent: callers may re-apply on every run start (also re-arms after a
 * model switch, since the newly selected model carries the provider window).
 */
export function applyConfiguredContextWindow(ctx: unknown): ConfiguredWindowApplyResult {
  const configured = getConfiguredContextLimitTokens();
  if (configured === undefined) return { applied: false, reason: "unset" };
  const model = (ctx as { model?: { contextWindow?: number } } | undefined)?.model;
  if (!model || typeof model !== "object") return { applied: false, reason: "no-model" };
  const target = resolveContextLimitTokens(configured, model.contextWindow) ?? configured;
  if (model.contextWindow === target) {
    return { applied: false, reason: "unchanged", contextWindow: target };
  }
  try {
    model.contextWindow = target;
    return { applied: true, contextWindow: target };
  } catch {
    if (!_warnedUnapplyableContextWindow) {
      _warnedUnapplyableContextWindow = true;
      _log.warn(
        "Could not apply braid.context.contextLimitTokens to the session model " +
          "(read-only model object): native threshold compaction keeps using the " +
          "provider window for this model.",
      );
    }
    return { applied: false, reason: "frozen", contextWindow: model.contextWindow };
  }
}

// ── compaction reserve coherence with the configured window ────────────

/**
 * Floor for the derived reserve: pi-core's own shipped default
 * (DEFAULT_COMPACTION_SETTINGS.reserveTokens). The reserve doubles as the
 * budget for the post-compaction summary request (pi-core caps it at 80% of
 * the reserve), so a thinner one starts failing the compaction it exists to
 * fund; the derivation never goes below it.
 */
export const MIN_COMPACTION_RESERVE_TOKENS = 16384;

/** Derived reserve for one window, with the trigger it produces. */
export interface CompactionReserveDerivation {
  /** Window − trigger, floored at MIN_COMPACTION_RESERVE_TOKENS. */
  reserveTokens: number;
  /** contextTokens above which pi-core's shouldCompact() fires. */
  triggerTokens: number;
  /** triggerTokens as a percent of the window (the coherence target). */
  triggerPercent: number;
}

/**
 * Pure resolver for the compaction reserve that puts native threshold
 * compaction at USAGE_WHISPER_CRITICAL of the window: reserve = window −
 * trigger, i.e. the same 75/25 split the usage bands already treat as
 * coherent (compaction at USAGE_WHISPER_CRITICAL, before the archiving band
 * opens at USAGE_COMPACT_MEDIUM). pi-core's shouldCompact() compares raw
 * token counts (contextTokens > contextWindow − reserveTokens), never
 * percents, so a reserve that is not a fixed share of the plumbed window
 * silently re-anchors the trigger — that is the incoherence this derives
 * away.
 *
 * Returns undefined when no reserve can be derived: a non-number, non-finite
 * or non-positive window, or a window so small that even the floor reserve
 * (MIN_COMPACTION_RESERVE_TOKENS) leaves no room to compact into. Kept pure
 * so the split is unit-testable without touching live settings.json.
 */
export function resolveCompactionReserveTokens(
  window: number | null | undefined,
): CompactionReserveDerivation | undefined {
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) {
    return undefined;
  }
  const target = Math.round((window * USAGE_WHISPER_CRITICAL) / 100);
  const reserveTokens = Math.max(window - target, MIN_COMPACTION_RESERVE_TOKENS);
  if (reserveTokens >= window) return undefined;
  const triggerTokens = window - reserveTokens;
  return {
    reserveTokens,
    triggerTokens,
    triggerPercent: (triggerTokens / window) * 100,
  };
}

/**
 * The reserve pi-core would actually use for this model: the per-model
 * `compaction.modelOverrides[provider/id].reserveTokens` first, then
 * `compaction.reserveTokens`, else undefined (pi-core's own default, i.e.
 * MIN_COMPACTION_RESERVE_TOKENS). Reads settings fresh, like the other
 * readers.
 */
export function getConfiguredCompactionReserveTokens(
  provider?: string | null,
  modelId?: string | null,
): number | undefined {
  const compaction = readSettings().compaction;
  if (!compaction || typeof compaction !== "object") return undefined;
  const key = provider && modelId ? `${provider}/${modelId}` : undefined;
  const override = key !== undefined ? compaction.modelOverrides?.[key]?.reserveTokens : undefined;
  const candidate = typeof override === "number" ? override : compaction.reserveTokens;
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
    ? candidate
    : undefined;
}

/** Warned once per process about each compaction-reserve coherence class. */
let _warnedUnderivableCompactionReserve = false;
let _warnedIncoherentCompactionReserve = false;
let _warnedUnreachableCompactionReserve = false;

export interface CompactionReserveApplyResult {
  /** Derived reserve (window − trigger); absent when no derivation exists. */
  reserveTokens?: number;
  /** Token count at which native threshold compaction fires under the derivation. */
  triggerTokens?: number;
  /** triggerTokens as a percent of the window (target: USAGE_WHISPER_CRITICAL). */
  triggerPercent?: number;
  /** Why nothing was applied. */
  reason?: "unset" | "no-derivation" | "window-not-plumbed" | "unreachable" | "unchanged";
}

/**
 * Derive the compaction reserve that makes pi-core's native threshold
 * compaction fire at the SAME share of the window braid's usage bands assume.
 * applyConfiguredContextWindow() gives pi-core the braid window; this pairs
 * with it, because pi-core then decides WHEN to compact from its own
 * independent `compaction.reserveTokens` (a fixed token count, default
 * 16384) - untouched, that count re-anchors the trigger to an arbitrary
 * percent of the plumbed window. The window here is the effective one the
 * plumb writes or keeps (`min(cap, true window)` when the true window is
 * known), never the raw cap, so the two sides cannot size against different
 * windows.
 *
 * The derivation is computed, but it cannot be APPLIED from an extension on
 * pi 1.0.2: ctx.sessionManager is pi-core's session manager and carries no
 * settings object, and the ExtensionAPI's only settings surface,
 * getSettings(), returns a structuredClone of the effective settings - a
 * write would never reach pi-core's compaction reader. The operator-facing
 * warning is therefore the channel: it fires once per process and spells out
 * the value to set.
 *
 * Warnings (each once per process): an incoherent CONFIGURED reserve (its
 * trigger falls outside the USAGE_WHISPER_WARNING..USAGE_COMPACT_MEDIUM band
 * the usage layers work in) and an unappliable reserve - the owner has to set
 * the value by hand.
 */
export function applyCompactionReserveTokens(ctx: unknown): CompactionReserveApplyResult {
  const configured = getConfiguredContextLimitTokens();
  if (configured === undefined) return { reason: "unset" };
  const model = (
    ctx as { model?: { contextWindow?: number; id?: string; provider?: string } } | undefined
  )?.model;
  // Same effective window the plumb writes or keeps (see
  // applyConfiguredContextWindow): min(cap, true window) when the true window
  // is known, the cap alone otherwise. The raw cap would size a reserve
  // against a window pi-core never sees whenever the ceiling binds.
  const window = resolveContextLimitTokens(configured, model?.contextWindow) ?? configured;
  const derivation = resolveCompactionReserveTokens(window);
  if (!derivation) {
    if (!_warnedUnderivableCompactionReserve) {
      _warnedUnderivableCompactionReserve = true;
      _log.warn(
        "braid.context.contextLimitTokens leaves no room for a compaction reserve " +
          "(a 25% reserve does not fit and pi-core's own floor consumes the whole " +
          "window) - native threshold compaction keeps its defaults.",
        { window, floorReserve: MIN_COMPACTION_RESERVE_TOKENS },
      );
    }
    return { reason: "no-derivation" };
  }
  const { reserveTokens, triggerTokens, triggerPercent } = derivation;
  const configuredReserve =
    getConfiguredCompactionReserveTokens(model?.provider, model?.id) ??
    MIN_COMPACTION_RESERVE_TOKENS;
  const configuredTrigger = window - configuredReserve;
  const configuredPercent = (configuredTrigger / window) * 100;
  const belowBand = configuredPercent <= USAGE_WHISPER_WARNING;
  const aboveBand = configuredPercent >= USAGE_COMPACT_MEDIUM;
  if (
    configuredReserve !== reserveTokens &&
    (belowBand || aboveBand) &&
    !_warnedIncoherentCompactionReserve
  ) {
    _warnedIncoherentCompactionReserve = true;
    const where = belowBand
      ? `before the ${USAGE_WHISPER_WARNING}% warning band`
      : `inside the archiving band (${USAGE_COMPACT_MEDIUM}%+), where braid archives instead`;
    _log.warn(
      `Compaction reserve ${configuredReserve} is incoherent with the ${window}-token ` +
        `window: native compaction fires at ${configuredTrigger} tokens ` +
        `(${configuredPercent.toFixed(1)}%), ${where} - the coherent reserve is ` +
        `${reserveTokens} (trigger ${triggerTokens}, ${triggerPercent.toFixed(1)}%).`,
      {
        window,
        configuredReserve,
        configuredTrigger,
        configuredPercent,
        derivedReserve: reserveTokens,
        derivedTrigger: triggerTokens,
      },
    );
  }
  if (model && typeof model === "object" && model.contextWindow !== window) {
    return { reason: "window-not-plumbed", reserveTokens, triggerTokens, triggerPercent };
  }
  if (configuredReserve === reserveTokens) {
    return { reason: "unchanged", reserveTokens, triggerTokens, triggerPercent };
  }
  // No writable settings handle exists to steer: pi-core hands the extension a
  // session manager without settings, and getSettings() returns a copy. The
  // warning is the honest channel - it names the value for the operator once
  // per process.
  if (!_warnedUnreachableCompactionReserve) {
    _warnedUnreachableCompactionReserve = true;
    _log.warn(
      "Native threshold compaction cannot be re-anchored from an extension here: " +
        "pi-core exposes no writable settings handle (ctx.sessionManager carries none; " +
        `pi.getSettings() returns a copy), so the derived reserve ` +
        `${reserveTokens} was not applied to the ${window}-token window (reserve stays ` +
        `${configuredReserve}, trigger ${configuredTrigger}). Set ` +
        `compaction.reserveTokens = ${reserveTokens} in settings.json for a ` +
        `${triggerPercent.toFixed(1)}% trigger.`,
      { window, configuredReserve, derivedReserve: reserveTokens, derivedTrigger: triggerTokens },
    );
  }
  return { reason: "unreachable", reserveTokens, triggerTokens, triggerPercent };
}
