/**
 * Shared global state utilities for pi-braid.
 *
 * Module-level state shared between extensions that can't use
 * getExtensionState() because they span separate extension contexts.
 *
 * IMPORTANT: These should only be used when module-level state won't work.
 * Prefer getExtensionState() for per-session state. Slots that must be
 * visible across module instances (src-tree vs compiled-dist imports) use
 * globalThis keys instead - see CUSTOM_MODEL_KEYS_KEY below for the
 * cross-bundle hazard.
 */

// globalThis (not a module-level let/const) because the polyfill extension is
// loaded from the TS SOURCE tree (src/extensions/core/polyfill/index.ts →
// src/lib/state/global-state.ts) while contrib's model-resolver imports the
// compiled DIST (dist/lib/state/global-state.js via the pi-braid/lib export).
// That yields TWO module instances of this file in one process; a module-level
// Map would be populated by the src instance and read (empty) by the dist
// instance, so the role setting would read as unset and resolution would fall
// away from it (first-available is where the MiniMax 429 lived). Same
// cross-bundle hazard as KEY_RING_FEEDBACK_KEY above; the slot must also
// survive /reload.
export const CUSTOM_MODEL_KEYS_KEY = "__braid_custom_model_keys";

/**
 * A custom model key value: one model pattern, or an ordered list of them tried
 * in order (the resolver walks the list and the provider layer decides per
 * entry).
 */
export type CustomModelKeyValue = string | string[];

/**
 * Get the shared custom model keys map.
 * polyfill writes to it (/utility-model command).
 * model-resolver reads from it (model resolution).
 */
export function getCustomModelKeys(): Map<string, CustomModelKeyValue> {
  const slot = globalThis as Record<string, unknown>;
  if (!slot[CUSTOM_MODEL_KEYS_KEY]) {
    slot[CUSTOM_MODEL_KEYS_KEY] = new Map<string, CustomModelKeyValue>();
  }
  return slot[CUSTOM_MODEL_KEYS_KEY] as Map<string, CustomModelKeyValue>;
}

/**
 * Read a custom model key (e.g. "utilityModel"): a pattern or an ordered list
 * of them.
 */
export function getCustomModelKey(key: string): CustomModelKeyValue | undefined {
  return getCustomModelKeys().get(key);
}

/**
 * Set a custom model key: one pattern or an ordered list. Used by polyfill for
 * /utility-model.
 */
export function setCustomModelKey(key: string, value: CustomModelKeyValue): void {
  getCustomModelKeys().set(key, value);
}

// The auxiliary role's key. Both the polyfill (which writes it) and the
// resolver (which reads it) address the one merged role: vision analysis falls
// back to its first image-capable entry, so there is no separate vision key.
export const UTILITY_MODEL_KEY = "utilityModel";

export interface RotationState {
  lastRotationTimestamp: number;
  turnsSinceRotation: number;
  rotationCount: number;
  pendingRotation: boolean;
  continuationSummary: string;
  // Nudge deduplication fields
  lastNudgeTimestamp: number;
  lastNudgeTurn: number;
  nudgeCount: number;
  actionTaken: boolean;
  actionTakenAtTurn: number; // turn count when action was taken (for grace period)
  emergencyRotation: boolean;
  // Deep-branch whisper throttle (separate from rotation nudge so a
  // very-deep branch doesn't share a counter with a soon-to-rotate one)
  lastDeepBranchWhisperTimestamp: number;
  lastDeepBranchWhisperTurn: number;
}

function createDefaultRotationState(): RotationState {
  return {
    lastRotationTimestamp: Date.now(),
    turnsSinceRotation: 0,
    rotationCount: 0,
    pendingRotation: false,
    continuationSummary: "",
    lastNudgeTimestamp: 0,
    lastNudgeTurn: 0,
    lastDeepBranchWhisperTimestamp: 0,
    lastDeepBranchWhisperTurn: 0,
    nudgeCount: 0,
    actionTaken: false,
    actionTakenAtTurn: 0,
    emergencyRotation: false,
  };
}

let _rotationState: RotationState | undefined;

/** Get the shared rotation state object. */
export function getRotationState(): RotationState {
  if (!_rotationState) {
    _rotationState = createDefaultRotationState();
  }
  return _rotationState;
}

/**
 * Last-known nudge state from the most recent session.
 * Used by code paths that read nudge state without an ExtensionContext
 * (e.g., a tool result handler that already returned to the agent loop).
 * When a ctx is available, prefer getExtensionState(ctx, "nudge-analytics").
 */
export interface NudgeAnalyticsFallbackState {
  nudgesSent: number;
  nudgesSuppressed: number;
  abVariant: string;
  contextDensity: number;
  wasDegraded: boolean;
}

function createDefaultNudgeAnalyticsFallback(): NudgeAnalyticsFallbackState {
  return {
    nudgesSent: 0,
    nudgesSuppressed: 0,
    abVariant: "control",
    contextDensity: 0,
    wasDegraded: false,
  };
}

let _nudgeAnalyticsFallback: NudgeAnalyticsFallbackState | undefined;

/** Get the shared nudge-analytics fallback object (process-global mirror). */
export function getNudgeAnalyticsFallback(): NudgeAnalyticsFallbackState {
  if (!_nudgeAnalyticsFallback) {
    _nudgeAnalyticsFallback = createDefaultNudgeAnalyticsFallback();
  }
  return _nudgeAnalyticsFallback;
}

/**
 * Process-global singleton instance of CognitiveMemory - named
 * "process-global" to distinguish it from the per-session pattern in
 * `extension-state.ts`. The memory engine maintains in-memory indices that
 * are expensive to rebuild on every session start.
 */
export interface CognitiveMemoryInstance {
  // Opaque type - the actual class lives in lib/memory/index.ts. The
  // getter/setter pattern here lets us declare the slot in global-state
  // without importing the (heavy) class.
  readonly _brand: unique symbol;
}

let _cognitiveMemoryInstance: unknown = null;

/** Set the shared CognitiveMemory instance (called once at first use). */
export function setCognitiveMemoryInstance(instance: unknown): void {
  _cognitiveMemoryInstance = instance;
}

/** Get the shared CognitiveMemory instance (or null if not yet initialized). */
export function getCognitiveMemoryInstance(): unknown {
  return _cognitiveMemoryInstance;
}

//
// pi-ai v0.80 moved `completeSimple` from the top-level export to the
// `/compat` subpath (deprecated); `createModels()` gives a `Models` instance,
// which is the forward-looking API. This slot holds the process-global Models
// instance created by models-init.ts at startup.
//
// Nothing on the auxiliary LLM path reads it: lib/ai/llm-call.ts dispatches
// through the session's ctx.modelRegistry (see the completion-dispatch block
// in that module), which resolves credential, provider headers and transport
// inside pi-core.
//
// Opaque type pattern (same as CognitiveMemoryInstance): the Models type is
// intentionally not imported here — the slot is typed `unknown`.

let _modelsInstance: unknown = null;

/** Set the shared pi-ai Models instance (called once at startup). */
export function setModelsInstance(instance: unknown): void {
  _modelsInstance = instance;
}

/** Get the shared pi-ai Models instance (or null if not yet initialized). */
export function getModelsInstance(): unknown {
  return _modelsInstance;
}

/**
 * Default per-LLM-tier timeout for post-loop classify() calls, consumed by
 * lib/ai/post-loop-classify.ts via getPostLoopTimeoutMs(). The post-loop
 * path runs at session end, when the session model may be busy with
 * finalization. A 10-minute budget per tier (20 min worst-case when both
 * utility and session are tried) is the current tuning: real provider
 * issues surface as real errors, while signal-driven aborts (ESC, session
 * shutdown) remain the normal cancellation path - the timeout is a
 * fallback for orphaned calls, not the cancellation mechanism.
 */
export const DEFAULT_POST_LOOP_TIMEOUT_MS = 600_000;

let _postLoopTimeoutMs: number | undefined;

/**
 * Get the per-LLM-tier timeout for post-loop classify() calls.
 * Defaults to DEFAULT_POST_LOOP_TIMEOUT_MS (600_000). Tunable via
 * setPostLoopTimeoutMs() - typically called from a /command or
 * startup config so the value can be changed without code changes.
 */
export function getPostLoopTimeoutMs(): number {
  if (_postLoopTimeoutMs === undefined) {
    _postLoopTimeoutMs = DEFAULT_POST_LOOP_TIMEOUT_MS;
  }
  return _postLoopTimeoutMs;
}

/** Override the post-loop timeout. Pass a positive number in ms. */
export function setPostLoopTimeoutMs(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`setPostLoopTimeoutMs: value must be a positive finite number, got ${value}`);
  }
  _postLoopTimeoutMs = value;
}

//
// The session-recovery proposal routes every LLM call outcome
// through SessionHealthState. To avoid forcing every call site to pass a
// callback, lib/ai/llm-call.ts exposes a process-wide listener registration.
// The enforcement extension registers listeners at session_start with a
// closure over the current ctx; calls go to whichever listener is currently
// registered.
//
// Single-listener design: only one consumer is expected (the enforcement
// extension). Multi-session / multi-consumer scenarios are a future concern.
//
// Encapsulated in global-state.ts (not module-level let in llm-call.ts) so
// the no-module-level-let contract is satisfied and the listeners can be
// reset between test runs via resetLlmCallListeners().
export type LlmErrorListener = (err: unknown) => void;
export type LlmSuccessListener = () => void;

let _llmErrorListener: LlmErrorListener | null = null;
let _llmSuccessListener: LlmSuccessListener | null = null;

/** Set the current LLM call listeners. Pass `null` to clear a slot. */
export function setLlmCallListeners(listeners: {
  onError?: LlmErrorListener | null;
  onSuccess?: LlmSuccessListener | null;
}): void {
  if (listeners.onError !== undefined) {
    _llmErrorListener = listeners.onError ?? null;
  }
  if (listeners.onSuccess !== undefined) {
    _llmSuccessListener = listeners.onSuccess ?? null;
  }
}

/** Read-only access to the current error listener (for the callLlm() body). */
export function getLlmErrorListener(): LlmErrorListener | null {
  return _llmErrorListener;
}

/** Read-only access to the current success listener (for the callLlm() body). */
export function getLlmSuccessListener(): LlmSuccessListener | null {
  return _llmSuccessListener;
}

/** Clear all listeners. Test helper. */
export function resetLlmCallListeners(): void {
  _llmErrorListener = null;
  _llmSuccessListener = null;
}

// The pi-braid-providers extension owns the API key rings; core's callLlm and
// contrib's vision wrapper make direct LLM calls that never emit message_end,
// so a 429/403 from them must feed back into the ring that owns that
// provider/model to rotate off a dead key (the ring would otherwise serve the
// same dead key forever on those paths). providers publishes its handler into
// this process-global slot at extension load (providers/ring-lifecycle.ts
// publishKeyRingFeedback).
//
// globalThis (not a module-level let) because the two packages cannot import
// each other — providers stays standalone (no pi-core import) and has no
// exports map — and the slot must survive /reload. KEY_RING_FEEDBACK_KEY is
// THE one deliberate cross-package seam; keep the literal in sync with
// packages/providers/ring-lifecycle.ts.
export const KEY_RING_FEEDBACK_KEY = "__braid_key_ring_feedback_handler";

/**
 * Ring-feedback handler invoked on direct LLM-call outcomes. Structurally
 * implemented by providers/ring-lifecycle.ts createKeyRingFeedbackHandler();
 * modelId/providerId are the model that made the call (providers resolves the
 * owning ring from them — no module-global last-writer-wins).
 */
export interface KeyRingFeedbackHandler {
  reportFailure(modelId: string, providerId: string | undefined, errText: string): void;
  reportSuccess(modelId: string, providerId: string | undefined): void;
}

/** Read the ring-feedback handler published by the providers extension. */
export function getKeyRingFeedbackHandler(): KeyRingFeedbackHandler | null {
  const h = (globalThis as Record<string, unknown>)[KEY_RING_FEEDBACK_KEY];
  return h && typeof h === "object" ? (h as KeyRingFeedbackHandler) : null;
}

/** Override/clear the ring-feedback handler. Test + registration helper. */
export function setKeyRingFeedbackHandler(handler: KeyRingFeedbackHandler | null): void {
  (globalThis as Record<string, unknown>)[KEY_RING_FEEDBACK_KEY] = handler ?? null;
}

/** Clear the slot. Test helper. */
export function resetKeyRingFeedbackHandler(): void {
  (globalThis as Record<string, unknown>)[KEY_RING_FEEDBACK_KEY] = null;
}

// The telegram package owns the poller's consecutive getUpdates-failure counter
// and emits tunnel-down/up transitions through a process-global hub; the core
// watchdog subscribes here and surfaces the down/recovery whispers. Same
// deliberate cross-package seam style as KEY_RING_FEEDBACK_KEY — the
// WATCHDOG_TUNNEL_KEY literal AND the hub protocol MUST stay in sync with
// packages/telegram/src/lib/watchdog-tunnel.ts (whichever side runs first
// get-or-creates the hub at the same slot; telegram publishes, core
// subscribes). If the literal or protocol drifts, tunnel signals silently
// stop reaching the watchdog.
export const WATCHDOG_TUNNEL_KEY = "__braid_watchdog_tunnel";

export type WatchdogTunnelStatus = "up" | "down" | "unknown";

/** A tunnel liveness transition (mirrors telegram's WatchdogTunnelStatusEvent). */
export interface WatchdogTunnelEvent {
  status: "up" | "down";
  /** Consecutive getUpdates failures at the transition (0 on "up"). */
  failures: number;
  /** Last getUpdates error text (present on "down"). */
  lastError?: string;
  /** Ready-to-deliver whisper body authored by the telegram component. */
  message: string;
}

/** Hub protocol mirrored verbatim by telegram (watchdog-tunnel.ts). */
export interface WatchdogTunnelHub {
  status: WatchdogTunnelStatus;
  failures: number;
  lastError?: string;
  publish(event: WatchdogTunnelEvent): void;
  subscribe(fn: (event: WatchdogTunnelEvent) => void): () => void;
}

function createWatchdogTunnelHub(): WatchdogTunnelHub {
  const subs = new Set<(event: WatchdogTunnelEvent) => void>();
  let status: WatchdogTunnelStatus = "unknown";
  let failures = 0;
  let lastError: string | undefined;
  const hub: WatchdogTunnelHub = {
    get status(): WatchdogTunnelStatus {
      return status;
    },
    get failures(): number {
      return failures;
    },
    get lastError(): string | undefined {
      return lastError;
    },
    publish(event) {
      status = event.status;
      failures = event.failures;
      if (event.lastError !== undefined) lastError = event.lastError;
      for (const fn of [...subs]) {
        try {
          fn(event);
        } catch {
          // A subscriber must never break the bus — the canary keeps running.
        }
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
  return hub;
}

/** Get-or-create the shared watchdog tunnel hub (see WATCHDOG_TUNNEL_KEY). */
export function getWatchdogTunnelHub(): WatchdogTunnelHub {
  const g = globalThis as Record<string, unknown>;
  const existing = g[WATCHDOG_TUNNEL_KEY] as WatchdogTunnelHub | undefined;
  if (existing && typeof existing?.publish === "function") return existing;
  const hub = createWatchdogTunnelHub();
  g[WATCHDOG_TUNNEL_KEY] = hub;
  return hub;
}

/** Current tunnel status ("unknown" when telegram never published). */
export function getWatchdogTunnelStatus(): WatchdogTunnelStatus {
  return getWatchdogTunnelHub().status;
}

/** Subscribe to tunnel transitions; returns an unsubscribe function. */
export function subscribeWatchdogTunnel(fn: (event: WatchdogTunnelEvent) => void): () => void {
  return getWatchdogTunnelHub().subscribe(fn);
}

// The core watchdog's escalation "keeps the remote canary warm" with an
// optional 1-line compact tg ping when the channel is up. telegram/index.ts
// publishes a plain-text sender here when the channel is enabled; an absent
// slot (telegram not loaded) makes the optional signal a silent no-op. The
// literal MUST stay in sync with packages/telegram/src/index.ts
// WATCHDOG_TG_SIGNAL_KEY.
export const WATCHDOG_TG_SIGNAL_KEY = "__braid_watchdog_tg_signal";

/** Best-effort 1-line tg sender (must never throw). */
export type WatchdogTgSignalSender = (text: string) => boolean | Promise<boolean>;

/** Read the optional tg-signal sender published by the telegram extension. */
export function getWatchdogTgSignalSender(): WatchdogTgSignalSender | null {
  const fn = (globalThis as Record<string, unknown>)[WATCHDOG_TG_SIGNAL_KEY];
  return typeof fn === "function" ? (fn as WatchdogTgSignalSender) : null;
}

// Dead wake delivery is KNOWN first in the timer's wake-retry queue (repeated
// outcome timeouts for one timer id, exhausted redelivery chains) — but the
// episode latch + escalation belong to the watchdog (it owns
// liveness/stall/escalation and already carries the tg-signal alert path).
// Extensions must not import sibling extensions, so the watchdog publishes a
// feed object into a process-global slot at engine build time — the same
// pattern as WATCHDOG_TG_SIGNAL_KEY above — and the timer forwards
// threshold-crossing facts into it lossy-safe (absent slot → no-op).
export const WATCHDOG_WAKE_DELIVERY_FEED_KEY = "__braid_watchdog_wake_delivery_feed";

/** Facts the timer's wake-retry queue forwards to the watchdog engine. */
export interface WatchdogWakeDeliveryFeed {
  /** The outcome window elapsed with no settle for this timer (Nth time for
   *  the same fire — the repeated-timeout stall signal). */
  recordWakeOutcomeTimeout(timerId: string, reason: string, timeouts: number): void;
  /** A wake fire dropped after exhausting its redelivery bound. */
  recordWakeUndelivered(timerId: string, reason: string, attempts: number): void;
  /** A tracked wake resolved as delivered — wakes resumed. */
  recordWakeDelivered(timerId: string): void;
}

/** Publish (or clear with null) the wake-delivery feed. */
export function setWatchdogWakeDeliveryFeed(feed: WatchdogWakeDeliveryFeed | null): void {
  (globalThis as Record<string, unknown>)[WATCHDOG_WAKE_DELIVERY_FEED_KEY] = feed;
}

/** Read the wake-delivery feed published by the watchdog extension. */
export function getWatchdogWakeDeliveryFeed(): WatchdogWakeDeliveryFeed | null {
  const feed = (globalThis as Record<string, unknown>)[WATCHDOG_WAKE_DELIVERY_FEED_KEY];
  return feed && typeof feed === "object" ? (feed as WatchdogWakeDeliveryFeed) : null;
}

// A due timer/wake is a legitimate reason for a session to look quiet: the
// wake is about to start a turn. The fact lives with the scheduler (only it
// knows what is due); the watchdog's stall classifier is the consumer. The
// scheduling layer may not import the watchdog, so — same pattern as the
// wake-delivery feed above — it publishes a plain question into a
// process-global slot and the watchdog asks it before classifying a silent
// turn dead. Absent slot ⇒ not due (a stall must not be suppressed by a
// provider that never loaded).
export const WATCHDOG_WAKE_DUE_PROVIDER_KEY = "__braid_watchdog_wake_due_provider";

/** Answers whether a timer/wake is currently due for the active session. */
export type WatchdogWakeDueProvider = () => boolean;

/** Publish (or clear with null) the wake-due provider. */
export function setWatchdogWakeDueProvider(provider: WatchdogWakeDueProvider | null): void {
  (globalThis as Record<string, unknown>)[WATCHDOG_WAKE_DUE_PROVIDER_KEY] = provider;
}

/** Read the wake-due provider published by the scheduler. */
export function getWatchdogWakeDueProvider(): WatchdogWakeDueProvider | null {
  const fn = (globalThis as Record<string, unknown>)[WATCHDOG_WAKE_DUE_PROVIDER_KEY];
  return typeof fn === "function" ? (fn as WatchdogWakeDueProvider) : null;
}

// Whether a new turn should start against the current session's route is a
// health fact OWNED by the enforcement layer (it sees the classified LLM
// errors); the scheduling wake path is the CONSUMER that must act on it. The
// scheduler's layer may not import an extension sibling, so — same pattern as
// the wake-delivery feed above — the enforcement layer publishes a small
// mechanism-only object into a process-global slot and the scheduler asks it
// one question. Absent slot ⇒ never blocked (a wake must fail open).
//
// Names here carry no provider, status code or error category: the shape is
// only "may a turn start" + "a turn ended cleanly", so a generic layer cannot
// learn a domain fact from it.
export const TURN_START_GATE_KEY = "__braid_turn_start_gate";

export interface TurnStartGate {
  /** Should the scheduler withhold a turn-start for this session now?
   *  `threshold` is the caller's configured bound. */
  isBlocked(ctx: unknown, threshold: number): boolean;
  /** A turn settled without a failure outcome — a real clean turn. */
  noteCleanTurn(ctx: unknown): void;
}

/** Publish (or clear with null) the turn-start gate. */
export function setTurnStartGate(gate: TurnStartGate | null): void {
  (globalThis as Record<string, unknown>)[TURN_START_GATE_KEY] = gate;
}

/** Read the turn-start gate published by the enforcement extension. */
export function getTurnStartGate(): TurnStartGate | null {
  const gate = (globalThis as Record<string, unknown>)[TURN_START_GATE_KEY];
  return gate && typeof gate === "object" ? (gate as TurnStartGate) : null;
}

// The anti-sycophancy detector computes the acceptance (validation-before-
// correction) verdict at message_end; the over-correction gate needs the
// SAME already-computed verdict at tool-call time, from the enforcement
// extension. Extensions must not import each other's handlers, so — same
// pattern as TURN_START_GATE_KEY above — the detector publishes the verdict
// into a process-global slot and the gate reads it lossy-safe. The signal
// carries the producing session and a wall-clock stamp: another session's
// signal and an expired signal both read cold. Absent slot ⇒ no signal.
export const ACCEPTANCE_SIGNAL_KEY = "__braid_acceptance_signal";

export interface AcceptanceSignal {
  /** Epoch ms when the detector computed the verdict. */
  atMs: number;
  /** The detector's VbC score (already computed; not re-derived here). */
  score: number;
  /** Session that produced the verdict; a signal from another session is cold. */
  sessionId?: string;
}

/** Publish (or clear with null) the latest acceptance signal. */
export function setAcceptanceSignal(signal: AcceptanceSignal | null): void {
  (globalThis as Record<string, unknown>)[ACCEPTANCE_SIGNAL_KEY] = signal;
}

/** Read the acceptance signal published by the sycophancy detector. */
export function getAcceptanceSignal(): AcceptanceSignal | null {
  const signal = (globalThis as Record<string, unknown>)[ACCEPTANCE_SIGNAL_KEY];
  if (!signal || typeof signal !== "object") return null;
  const s = signal as AcceptanceSignal;
  if (typeof s.atMs !== "number" || !Number.isFinite(s.atMs)) return null;
  return s;
}

//
// The emergency offloader (context-manager/handlers/context-emergency.ts)
// must be callable from code that lives OUTSIDE the context-manager extension
// tree: llm-call's retry path (lib/ai), the heartbeat consolidation gate, and
// the providers pre-send guard. Those consumers cannot import the extension
// module directly (layering + heavy import chain), so — like KEY_RING_FEEDBACK_
// KEY above — context-manager publishes a runner into a process-global slot
// and consumers read it lossy-safe (absent → no-op).

export const CONTEXT_EMERGENCY_OFFLOAD_RUNNER_KEY = "__braid_context_emergency_offload_runner";

/** What one emergency offload run did (consumers decide on retry). */
export interface ContextEmergencyOffloadResult {
  /** Entries actually stubbed this run (0 = nothing shrank → do NOT retry). */
  offloaded: number;
  /** In-context chars freed by stubbing. */
  charsSaved: number;
  /** Whether the run hit an error and left the context untouched. */
  error?: string;
}

/**
 * Run the emergency size-driven offload against the CURRENT session context.
 * Implemented by context-manager (needs ctx to read session state + settings);
 * reason is a short label for the log line ("llm-retry", "heartbeat-gate",
 * "compaction-413", "pre-send"). Must never throw (publish side wraps).
 */
export type ContextEmergencyOffloadRunner = (
  ctx: unknown,
  reason: string,
) => ContextEmergencyOffloadResult | Promise<ContextEmergencyOffloadResult>;

/** Publish the emergency-offload runner (called by context-manager at load). */
export function setContextEmergencyOffloadRunner(runner: ContextEmergencyOffloadRunner): void {
  (globalThis as Record<string, unknown>)[CONTEXT_EMERGENCY_OFFLOAD_RUNNER_KEY] = runner;
}

/**
 * Read the published emergency-offload runner. Null when context-manager has
 * not loaded (or was reloaded without re-publishing) — callers treat this as
 * "cannot shrink" and proceed with their normal failure path.
 */
export function getContextEmergencyOffloadRunner(): ContextEmergencyOffloadRunner | null {
  const fn = (globalThis as Record<string, unknown>)[CONTEXT_EMERGENCY_OFFLOAD_RUNNER_KEY];
  return typeof fn === "function" ? (fn as ContextEmergencyOffloadRunner) : null;
}

/** Clear the slot. Test helper. */
export function resetContextEmergencyOffloadRunner(): void {
  delete (globalThis as Record<string, unknown>)[CONTEXT_EMERGENCY_OFFLOAD_RUNNER_KEY];
}

/**
 * ExtensionContext provider. Modules under lib/ have no ctx of their own, so
 * the enforcement session-start handler publishes a closure over the CURRENT
 * session's ctx. Consumers: the emergency-offload retry path in llm-call.ts,
 * and the auxiliary LLM path's registry/auth lookup in the same module.
 * Single-session design, same as the LLM call listeners slot above.
 *
 * The name is general because the slot carries the whole context, not one
 * consumer's slice of it: a second consumer must not need a second slot.
 */
export const EXTENSION_CTX_PROVIDER_KEY = "__braid_extension_ctx_provider";

/** Publish the ctx provider (called by enforcement's session-start handler). */
export function setExtensionCtxProvider(provider: () => unknown): void {
  (globalThis as Record<string, unknown>)[EXTENSION_CTX_PROVIDER_KEY] = provider;
}

/** Read the published ctx provider (null when enforcement has not loaded). */
export function getExtensionCtxProvider(): (() => unknown) | null {
  const fn = (globalThis as Record<string, unknown>)[EXTENSION_CTX_PROVIDER_KEY];
  return typeof fn === "function" ? (fn as () => unknown) : null;
}

/** Clear the slot. Test helper. */
export function resetExtensionCtxProvider(): void {
  delete (globalThis as Record<string, unknown>)[EXTENSION_CTX_PROVIDER_KEY];
}

/**
 * Emergency-offload spellings of the accessors above. Same one slot: the
 * context-emergency retry path was built against these names, and a test that
 * publishes through one name must be visible through the other.
 */
export function setContextEmergencyCtxProvider(provider: () => unknown): void {
  setExtensionCtxProvider(provider);
}

/** @see setContextEmergencyCtxProvider */
export function getContextEmergencyCtxProvider(): (() => unknown) | null {
  return getExtensionCtxProvider();
}

/** @see setContextEmergencyCtxProvider */
export function resetContextEmergencyCtxProvider(): void {
  resetExtensionCtxProvider();
}

//
// llm-call.ts dispatches auxiliary calls through the published extension
// context (ctx.modelRegistry). When nothing has published a context it
// degrades to pi-ai's compat transport, which carries the model's credential
// but neither the session id nor configured provider headers. That degradation
// is announced once per process, never per call. globalThis-backed rather than
// a module-level `let`: the extension module tree is re-evaluated on /reload,
// so a module-level flag would be lost and the same degradation announced
// again.
const AUX_DEGRADED_TRANSPORT_WARNED_KEY = "__braid_aux_degraded_transport_warned";

/** True once the auxiliary-call degraded-transport warning has been emitted. */
export function hasWarnedAuxDegradedTransport(): boolean {
  return (globalThis as Record<string, unknown>)[AUX_DEGRADED_TRANSPORT_WARNED_KEY] === true;
}

/** Record that the auxiliary-call degraded-transport warning has been emitted. */
export function markAuxDegradedTransportWarned(): void {
  (globalThis as Record<string, unknown>)[AUX_DEGRADED_TRANSPORT_WARNED_KEY] = true;
}

/** Clear the latch. Test helper. */
export function resetAuxDegradedTransportWarning(): void {
  delete (globalThis as Record<string, unknown>)[AUX_DEGRADED_TRANSPORT_WARNED_KEY];
}

//
// The timer extension factory closes over a
// `poller` and `sessionState` variable, which is correct for the standard
// pi lifecycle (one process per session) but breaks under multi-session-
// per-process. The comment block in timer/index.ts:16-41 promises a
// debug-mode counter that logs a warning if `timerExtension(pi)` is called
// more than once.
//
// The counter lives here (not as a module-level let in timer/index.ts) so
// the no-module-level-let contract is satisfied. The factory call counter
// is process-global by definition (it tracks process-wide extension
// registration), so global-state.ts is the right home.
export interface TimerExtensionFactoryState {
  callCount: number;
}

function createDefaultTimerExtensionFactoryState(): TimerExtensionFactoryState {
  return { callCount: 0 };
}

let _timerExtensionFactoryState: TimerExtensionFactoryState | undefined;

/**
 * Get the shared timer-extension-factory counter.
 *
 * The timer extension increments this on every `timerExtension(pi)` call
 * and logs a warning when the count exceeds 1 (signaling an accidental
 * double-registration that would break the single-process-per-session
 * assumption).
 */
export function getTimerExtensionFactoryState(): TimerExtensionFactoryState {
  if (!_timerExtensionFactoryState) {
    _timerExtensionFactoryState = createDefaultTimerExtensionFactoryState();
  }
  return _timerExtensionFactoryState;
}

// The discoverability handler in enforcement runs on every session_start and
// emits a bundled whisper with prior-session hints. On /reload, the extension
// module IS re-evaluated (so module-level `let` in the handler doesn't persist).
// _This_ module is also in the extension import tree, so a module-level `let`
// here would also be lost on reload. We use `globalThis` instead, which is the
// Node.js process global and survives any module re-evaluation.
//
// Key: process-global (not module-global). A fresh `pi` process starts with
// an empty Set (everything is "new"). Within the same process, the Set persists
// across any number of /reload calls.
//
// Two layers:
//   1. Bundle-text dedup: `_GLOBAL_KEY` (`__braid_discoverability_shown`).
//      Old approach. Fragile: dynamic content changes (openPlans
//      count, goal slice) cause the bundle string to vary, missing the Set.has.
//   2. Per-signal dedup: `_GLOBAL_SIGNAL_KEY` (`__braid_shown_signal_types`).
//      Added. Stable across content variations. Each signal TYPE
//      is a semantic key; content changes don't affect dedup.
//
// The SUPPRESSION TRUTH is now the session branch (`_GLOBAL_BRANCH_SIGNAL_KEY`
// below, rebuilt from `braid_shown_signal` entries at session_start). The
// per-project disk file is a derived write-through index, kept for
// cross-session readers and never consulted for dedup - see the branch-durable
// section below for why (a rewound branch must not inherit a project's history).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { shownSignalsFilePath } from "../config/braid-paths.js";

const _GLOBAL_KEY = "__braid_discoverability_shown";

/**
 * Get the shared discoverability dedup set. Created lazily on first access.
 * The Set is stored in `globalThis` (process-global) so it survives module
 * re-evaluation on /reload.
 */
export function getShownDiscoveryBundles(): Set<string> {
  if (!(globalThis as any)[_GLOBAL_KEY]) {
    (globalThis as any)[_GLOBAL_KEY] = new Set<string>();
  }
  return (globalThis as any)[_GLOBAL_KEY];
}

/** Reset the dedup set. Test helper. */
export function resetShownDiscoveryBundles(): void {
  delete (globalThis as any)[_GLOBAL_KEY];
}

// Bundle-text dedup misses when ANY dynamic content in the bundle changes
// (openPlans count, goal slice, tag list, etc.). Per-signal dedup tracks
// individual signal TYPES (semantic keys), so the same signal type is
// skipped on re-emission even if its content varies.
// Used by register-session-start-discoverability.ts.

const _GLOBAL_SIGNAL_KEY = "__braid_shown_signal_types";

/** Signal type identifiers used by the discoverability handler.
 *  These are the dedup keys — keep them stable across releases. */
export type DiscoverySignalType =
  | "scratchpad_prior"
  | "memory_prior"
  | "sessions_prior"
  | "resume"
  | "tags_prior"
  | "journal_prior"
  | "context_hygiene_tip";

/** Get the shared shown-signal-types set (process-global, survives /reload). */
export function getShownSignals(): Set<DiscoverySignalType> {
  if (!(globalThis as any)[_GLOBAL_SIGNAL_KEY]) {
    (globalThis as any)[_GLOBAL_SIGNAL_KEY] = new Set<DiscoverySignalType>();
  }
  return (globalThis as any)[_GLOBAL_SIGNAL_KEY];
}

/** Reset the shown-signal set. Test helper. */
export function resetShownSignals(): void {
  delete (globalThis as any)[_GLOBAL_SIGNAL_KEY];
}

/** Check if a signal type has been shown in this process. */
export function isSignalShown(t: DiscoverySignalType): boolean {
  return getShownSignals().has(t);
}

/** Mark a signal type as shown in this process. */
export function markSignalShown(t: DiscoverySignalType): void {
  getShownSignals().add(t);
}

// The on-disk file at <braid>/shown-signals.json is a derived index of every
// signal mark this project has ever written. Suppression decisions do NOT
// read it: the ACTIVE BRANCH decides what this session has already shown
// (see the branch-durable section below). The file is kept as a cross-session
// index for readers that ask "has this project ever shown X" - it is written
// through on every mark and can over-report after a rewind by design.
//
// History: this layer was added for session-resume flooding, before the
// branch entries existed. The branch covers resume natively, so the file
// stopped being consulted for dedup; keeping it as an index preserves the
// accumulated project history without letting it override the branch.

const _GLOBAL_PROJECT_SIGNAL_KEY = "__braid_project_shown_signals";

/**
 * Get the per-project shown-signals map from disk.
 * Internal cache keyed by project slug. The on-disk file is a flat JSON
 * object: `{ "<project-slug>": ["signal_type1", ...] }`.
 */
function loadProjectShownSignalsFromDisk(): Record<string, DiscoverySignalType[]> {
  try {
    const file = shownSignalsFilePath();
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // File corrupt or missing — start fresh
  }
  return {};
}

function persistProjectShownSignalsToDisk(data: Record<string, DiscoverySignalType[]>): void {
  try {
    const file = shownSignalsFilePath();
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(data), "utf-8");
  } catch {
    // Non-fatal — persistence is a best-effort optimization
  }
}

/**
 * Get the process-global cache of per-project shown signals (derived index).
 * Lazily loaded from disk on first access.
 * Structure: { "<slug>": Set<signal_type> }
 */
function getProjectShownSignalsCache(): Map<string, Set<DiscoverySignalType>> {
  if (!(globalThis as any)[_GLOBAL_PROJECT_SIGNAL_KEY]) {
    const fromDisk = loadProjectShownSignalsFromDisk();
    const map = new Map<string, Set<DiscoverySignalType>>();
    for (const [slug, types] of Object.entries(fromDisk)) {
      map.set(slug, new Set(types));
    }
    (globalThis as any)[_GLOBAL_PROJECT_SIGNAL_KEY] = map;
  }
  return (globalThis as any)[_GLOBAL_PROJECT_SIGNAL_KEY];
}

// Session-scoped state must follow the active branch: each mark appends a
// durable custom entry (`SHOWN_SIGNAL_ENTRY_TYPE`), and session_start rebuilds
// the shown set from `ctx.sessionManager.getBranch()`. Without this, a signal
// the rewound branch never saw stayed suppressed by the project-level file -
// the file records project history, the branch records this conversation.

/** Custom entry type for durable shown-signal records. Stable across releases. */
export const SHOWN_SIGNAL_ENTRY_TYPE = "braid_shown_signal";

/** Structural appendEntry seam (same shape as compaction-trace's EntryAppender). */
export interface ShownSignalEntryAppender {
  appendEntry<T = unknown>(customType: string, data?: T): void;
}

const _GLOBAL_BRANCH_SIGNAL_KEY = "__braid_branch_shown_signals";

/**
 * Collect shown signals from branch entries into a slug -> types map.
 * Malformed payloads are skipped rather than trusted. Only the ACTIVE branch
 * is passed in (getBranch returns the leaf path), so abandoned-branch entries
 * are never replayed.
 */
export function readShownSignalsFromBranch(
  entries: readonly unknown[],
): Map<string, Set<DiscoverySignalType>> {
  const map = new Map<string, Set<DiscoverySignalType>>();
  for (const raw of entries) {
    const entry = raw as { type?: string; customType?: string; data?: unknown } | null;
    if (entry?.type !== "custom" || entry.customType !== SHOWN_SIGNAL_ENTRY_TYPE) continue;
    const data = entry.data as { slug?: unknown; type?: unknown } | null | undefined;
    if (!data || typeof data !== "object") continue;
    if (typeof data.slug !== "string" || typeof data.type !== "string") continue;
    let set = map.get(data.slug);
    if (!set) {
      set = new Set<DiscoverySignalType>();
      map.set(data.slug, set);
    }
    set.add(data.type as DiscoverySignalType);
  }
  return map;
}

/**
 * Replace the branch-reconstructed shown-signal map. Called at session_start
 * (before the discoverability handler filters its signals); replacement, not
 * merge: the branch is the source of truth.
 */
export function reconstructShownSignalsFromBranch(entries: readonly unknown[]): void {
  (globalThis as any)[_GLOBAL_BRANCH_SIGNAL_KEY] = readShownSignalsFromBranch(entries);
}

function getBranchShownSignals(): Map<string, Set<DiscoverySignalType>> {
  if (!(globalThis as any)[_GLOBAL_BRANCH_SIGNAL_KEY]) {
    (globalThis as any)[_GLOBAL_BRANCH_SIGNAL_KEY] = new Map<string, Set<DiscoverySignalType>>();
  }
  return (globalThis as any)[_GLOBAL_BRANCH_SIGNAL_KEY];
}

/**
 * Check if a signal type has been shown for a project slug ON THE ACTIVE
 * BRANCH. The branch decides: a rewound branch that never saw the signal
 * answers false, so the signal is shown again for that branch.
 */
export function isProjectSignalShown(slug: string, t: DiscoverySignalType): boolean {
  const projectSet = getBranchShownSignals().get(slug);
  return projectSet ? projectSet.has(t) : false;
}

/**
 * Mark a signal type as shown for a project slug: update the branch map (fast
 * path), append the durable entry through the extension API's appendEntry
 * seam, and write through to the derived disk index (cross-session readers;
 * never consulted for suppression). Both side effects are best-effort - the
 * in-memory map already suppresses the current session.
 */
export function markProjectSignalShown(
  slug: string,
  t: DiscoverySignalType,
  appender?: ShownSignalEntryAppender,
): void {
  const map = getBranchShownSignals();
  let projectSet = map.get(slug);
  if (!projectSet) {
    projectSet = new Set<DiscoverySignalType>();
    map.set(slug, projectSet);
  }
  projectSet.add(t);

  if (appender) {
    try {
      appender.appendEntry(SHOWN_SIGNAL_ENTRY_TYPE, {
        slug,
        type: t,
        timestamp: Date.now(),
      });
    } catch {
      // Non-fatal — the in-memory branch map still suppresses this session.
    }
  }

  // Write-through derived index: accumulate into the disk cache and persist.
  const cache = getProjectShownSignalsCache();
  let cacheSet = cache.get(slug);
  if (!cacheSet) {
    cacheSet = new Set<DiscoverySignalType>();
    cache.set(slug, cacheSet);
  }
  cacheSet.add(t);

  const data: Record<string, DiscoverySignalType[]> = {};
  for (const [s, set] of cache) {
    data[s] = Array.from(set);
  }
  persistProjectShownSignalsToDisk(data);
}

//
// The heartbeat tick samples process RSS every tick (context-heartbeat.ts).
// T3 adds a boot-time baseline and an advisory whisper that fires at most
// ONCE PER BOOT when RSS sustains >2x baseline across a full 24-sample ring
// (lib/telemetry/rss-telemetry.ts). Both live here, process-global, because
// they must survive session_start resets: a new session in the same process
// is the same boot — a session-scoped baseline would re-baseline mid-boot
// and the latch would re-arm, violating the "one whisper per boot, no spam"
// contract. (lib/state/AGENTS.md getter pattern; NOT a module-level let
// outside this file.)

interface RssBootTelemetry {
  /** First RSS sample seen in this process (bytes). Set once. */
  baselineBytes: number | null;
  /** Whether the sustained-growth advisory whisper already fired this boot. */
  growthWhisperShown: boolean;
}

let _rssBootTelemetry: RssBootTelemetry | undefined = undefined;

export function getRssBootTelemetry(): RssBootTelemetry | undefined {
  return _rssBootTelemetry;
}

/** Set the boot baseline on the first heartbeat tick. Never overwrites. */
export function setRssBootBaseline(bytes: number): void {
  if (!_rssBootTelemetry) {
    _rssBootTelemetry = { baselineBytes: bytes, growthWhisperShown: false };
  }
}

/** Latch the sustained-growth advisory as delivered (one per boot). */
export function markRssGrowthWhisperShown(): void {
  if (_rssBootTelemetry) {
    _rssBootTelemetry.growthWhisperShown = true;
  } else {
    _rssBootTelemetry = { baselineBytes: 0, growthWhisperShown: true };
  }
}

/** Reset both (test helper only). */
export function resetRssBootTelemetry(): void {
  _rssBootTelemetry = undefined;
}

/** Whether the sustained-growth advisory already fired this boot. */
export function getRssGrowthWhisperShown(): boolean {
  return _rssBootTelemetry?.growthWhisperShown ?? false;
}
