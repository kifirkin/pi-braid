/**
 * @pi-braid/telegram — bidirectional Telegram channel.
 *
 * Extension factory registering ONE tool (`telegram_send`, outbound) and
 * starting the inbound long-poll injector. Enabled ONLY when
 * `BRAID_TG_BOT_TOKEN` is present (if-has-token guard): with no token the
 * factory returns immediately — no tool is registered, no poller starts, and
 * nothing crashes (debug log only).
 *
 * Live credentials: the TELEGRAM_BOT_TOKEN /
 * TELEGRAM_CHAT_ID / TELEGRAM_ALLOWED_USERS alias names are read as
 * fallbacks to the canonical BRAID_TG_* names (see
 * ENV_ALIASES below) so a later rename is no code change. Voice is
 * config-driven via `braid.telegram.tts` (lib/tts.ts). Ships fully
 * config-driven and unit-testable against fixtures so only live-config
 * values change later.
 *
 * Inbound opt-out: Telegram allows only ONE getUpdates
 * consumer per bot, so every pi instance loading this package would start a
 * long-poll and immediately 409 against the owner's own poller. Set
 * BRAID_TG_POLL_DISABLED (alias TELEGRAM_POLL_DISABLED) to keep the
 * outbound telegram_send tool registered while skipping the inbound poller
 * entirely (no createInboundPoller, no state file, no getUpdates).
 *
 * Inbound injection mechanism (VERIFIED in pi-core source):
 *   pi-core ExtensionAPI exposes `sendUserMessage(content, { deliverAs })`
 *   (dist/core/extensions/types.d.ts:919) which the runtime implements as a
 *   genuine queued user prompt — exactly the agent-zero
 *   `context.communicate(UserMessage(...))` equivalent:
 *     dist/core/agent-session.js:1103 `sendUserMessage()` ->
 *       this.prompt(text, { expandPromptTemplates:false, streamingBehavior:
 *       deliverAs, source:"extension" }) // "Always triggers a turn"
 *   We wire the poller's `onOwnerMessage` to `pi.sendUserMessage(..., {
 *   deliverAs: "steer" })` — while streaming, steer injects the owner
 *   message into the CURRENT turn immediately (agent.steer()); the followUp
 *   mode would queue it as the agent's NEXT task — minutes of inbound lag.
 *
 * Voice: the client implements sendVoiceNote (OGG/Opus) and the tool accepts
 * `voice`/`voiceText`. Delivery routes through the TTS hook populated from
 * `braid.telegram.tts` at boot (edge-tts → ffmpeg ogg/opus by default).
 * `source: "none"` leaves the hook undefined and `voice:true` then returns a
 * clear error (never silently sends text). Text-first delivery.
 *
 * Voice inbound: owner voice notes are received like photos —
 * downloaded to the media dir and delivered with the absolute path — and,
 * when an STT key is configured, transcribed so the receiving agent sees the
 * transcript. Default path is Venice chat/input_audio on the existing
 * AGENT_ZERO_API_KEY (BRAID_TG_STT_MODE=chat, the deployment default); the
 * chat-mode baseUrl defaults from the userland venice catalog — the gateway
 * this key pairs with (absent catalog falls back to Venice direct).
 * BRAID_TG_STT_MODE=transcriptions opts back to the OpenAI-compatible
 * /v1/audio/transcriptions route. Explicit overrides: BRAID_TG_STT_BASE_URL /
 * BRAID_TG_STT_API_KEY / BRAID_TG_STT_MODEL / BRAID_TG_STT_LANGUAGE. Without
 * STT the note still arrives (path + an "unavailable" note) — never dropped.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createTelegramClient,
  type TelegramFetch,
  type TelegramUpdate,
} from "./lib/telegram-client.js";
import {
  createInboundPoller,
  type IncomingOwnerMessage,
  type IncomingReplyContext,
  type InboundPoller,
  type PauseStateReader,
} from "./lib/inbound-poller.js";
import {
  inboundQueueFileFor,
  loadInboundQueue,
  saveInboundQueue,
  type QueuedInboundMessage,
} from "./lib/inbound-queue.js";
import { publishWatchdogTunnel } from "./lib/watchdog-tunnel.js";
import {
  DEFAULT_STT_CHAT_BASE_URL,
  DEFAULT_STT_CHAT_MODEL,
  type SttConfig,
} from "./lib/transcribe.js";
import { resolveSttKeyCandidates } from "./lib/stt-keys.js";
import { normalizeAudioBytes } from "./lib/audio-normalize.js";
import { populateVoiceTts } from "./lib/tts.js";
import { runTelegramSend } from "./lib/tool-logic.js";
import { fetchInbox, formatInboxMessage } from "./lib/telegram-inbox.js";
import { formatWhisperClock } from "./lib/local-time.js";
import {
  createTextCraftHook,
  createRichCraftHook,
  resolveNotifyModel,
  callCraftModel,
} from "./lib/notify/model.js";
import {
  extractFinalText,
  shouldNotifyTurnEnd,
  isTerminalNoReportTurn,
} from "./lib/notify/craft.js";
import {
  createTurnNotifyHandler,
  DEFAULT_NOTIFY_MAX_PER_MIN,
  type NotifyModelCtx,
} from "./lib/notify/turn-notify.js";
import {
  createLiveUpdateTracker,
  defaultLiveUpdateStateFile,
  DEFAULT_LIVE_UPDATE_MAX_PER_MIN,
  type LiveUpdateTracker,
} from "./lib/notify/live-update.js";
import {
  defaultStateFilePath,
  setPathRefusalSink,
  warnUnderivableRoot,
} from "./lib/state-paths.js";
import {
  acquirePollerLock,
  defaultPollerLockPath,
  describeLockHolder,
  releasePollerLock,
  type PollerLockInfo,
} from "./lib/poller-lock.js";
import { isWorkerRole, resolveSessionRole } from "./lib/session-role.js";
import {
  handlePauseCallbackQuery,
  placeControlKeyboard,
  resolvePauseStateFile,
  getPauseState as readPauseState,
  type PauseCallbackQuery,
} from "./lib/pause-control.js";
import { handleDecisionCallbackQuery } from "./lib/decision-buttons.js";
import { readCatalogBaseUrl } from "./lib/venice-catalog-base-url.js";

// Env configuration (mirrors providers' env-key conventions)

export const ENV_TOKEN = "BRAID_TG_BOT_TOKEN";
export const ENV_CHAT_ID = "BRAID_TG_CHAT_ID";
export const ENV_ALLOWED_USERS = "BRAID_TG_ALLOWED_USERS";
export const ENV_STATE_FILE = "BRAID_TG_STATE_FILE";
export const ENV_MEDIA_DIR = "BRAID_TG_MEDIA_DIR";
export const ENV_POLL_INTERVAL_MS = "BRAID_TG_POLL_INTERVAL_MS";
/**
 * Coalescing window (ms) for inbound owner messages: a burst is handed over
 * as ONE user message when the window closes, idle or busy, because the
 * handoff is a steer that reaches the running turn instead of waiting for
 * the next idle boundary. Anchored at the FIRST arrival (never reset by
 * later arrivals), so a lone message is delayed by at most one window; the
 * default is longer than the default poll interval, so a burst split across
 * poll cycles still coalesces. `0` closes the window on the next tick.
 * Tests set it small.
 */
export const ENV_COALESCE_WINDOW_MS = "BRAID_TG_COALESCE_WINDOW_MS";
export const DEFAULT_COALESCE_WINDOW_MS = 2000;
export const ENV_POLL_DISABLED = "BRAID_TG_POLL_DISABLED";
export const ENV_POLL_ENABLED = "BRAID_TG_POLL_ENABLED";
/** Machine-wide poller ownership lock (BRAID_HOME-overridable default). */
export const ENV_POLLER_LOCK_FILE = "BRAID_TG_POLLER_LOCK_FILE";
export const ENV_VERBOSE = "BRAID_TG_VERBOSE";

// session role (poller ownership)
// The marker the orchestrator seat exports into a worker's pane before pi
// starts. Only "worker" changes behavior; unset/seat keeps the default.
export {
  ENV_SESSION_ROLE,
  isWorkerRole,
  resolveSessionRole,
} from "./lib/session-role.js";
// voice inbound STT
export const ENV_STT_BASE_URL = "BRAID_TG_STT_BASE_URL";
export const ENV_STT_API_KEY = "BRAID_TG_STT_API_KEY";
export const ENV_STT_MODEL = "BRAID_TG_STT_MODEL";
export const ENV_STT_LANGUAGE = "BRAID_TG_STT_LANGUAGE";
export const ENV_STT_MODE = "BRAID_TG_STT_MODE";
export const ENV_STT_KEYS = "BRAID_TG_STT_KEYS";
export const ENV_STT_KEYRING_SERVICE = "BRAID_TG_STT_KEYRING_SERVICE";
export const ENV_STT_NORMALIZE = "BRAID_TG_STT_NORMALIZE";

/** STT runtime counters (attempts, successes by candidate index,
 *  normalizations applied, failures by class) — read-only snapshot. */
export { getSttCounters } from "./lib/stt-keys.js";

/** Input for the pure STT baseUrl resolver (testable seam). */
export interface ResolveSttBaseUrlInput {
  /** BRAID_TG_STT_BASE_URL value (undefined when unset). Always wins. */
  env?: string;
  /** readCatalogBaseUrl() result (null when the catalog is absent/invalid). */
  catalogBaseUrl?: string | null;
  /** STT mode; the catalog default applies to "chat" only (default "chat"). */
  mode?: "transcriptions" | "chat";
}

/**
 * Pure STT baseUrl resolution. Precedence: explicit env override > catalog-
 * derived baseUrl (chat mode only) > legacy Venice-direct default. The
 * catalog is consulted for CHAT mode only — it is a chat-completions proxy,
 * not an /audio/transcriptions route. `??`-semantics on env: an empty-string
 * override still wins (an empty string is not the default).
 */
export function resolveSttBaseUrl(input: ResolveSttBaseUrlInput): string {
  if (input.env != null) return input.env;
  if (input.catalogBaseUrl && (input.mode ?? "chat") === "chat") {
    return input.catalogBaseUrl;
  }
  return DEFAULT_STT_CHAT_BASE_URL;
}

// turn-complete auto-notify
export const ENV_NOTIFY_ENABLED = "BRAID_TG_NOTIFY_ENABLED";
export const ENV_NOTIFY_MODEL = "BRAID_TG_NOTIFY_MODEL";
export const ENV_NOTIFY_MAX_PER_MIN = "BRAID_TG_NOTIFY_MAX_PER_MIN";
// live-update tracked message
export const ENV_LIVE_UPDATE_ENABLED = "BRAID_TG_LIVE_UPDATE_ENABLED";
export const ENV_LIVE_UPDATE_MAX_PER_MIN = "BRAID_TG_LIVE_UPDATE_MAX_PER_MIN";
export const ENV_LIVE_UPDATE_STATE_FILE = "BRAID_TG_LIVE_UPDATE_STATE_FILE";

// Watchdog tg-signal seam (cross-package)
// Publish a 1-line plain-text sender for the core watchdog's optional remote
// signal (escalation "keeps the remote canary warm": in-session wake whisper
// +, when tg is up, a compact 1-line tg ping). Core reads the slot at
// escalate time; an absent slot (telegram not loaded) makes the optional
// signal a silent no-op. Same process-global seam pattern as the tunnel hub
// and providers' key-ring feedback — the literal MUST stay in sync with
// packages/core/src/lib/state/global-state.ts WATCHDOG_TG_SIGNAL_KEY.
export const WATCHDOG_TG_SIGNAL_KEY = "__braid_watchdog_tg_signal";

// Provider-outage notify seam (cross-package)
// Publish a plain-text sender for the providers outage watchdog: a provider
// connectivity outage holds the agent loop, so its alert cannot ride the
// in-session whisper path — it goes straight out through the same
// resolveChatId + client.sendMessage route every telegram tool uses. The
// watcher reads the slot at transition time and treats an absent slot (no
// token, or telegram not loaded) as "no owner alert channel"; the literal
// MUST stay in sync with packages/providers/outage-watch.ts
// PROVIDER_OUTAGE_NOTIFY_KEY. The sender returns false on any send failure
// so the watcher can release its cross-process dedupe claim.
export const PROVIDER_OUTAGE_NOTIFY_KEY = "__braid_provider_outage_notify";

// TG poller liveness seam (cross-package)
// Publish a live poller probe for the prompt-builder's awareness whisper: the
// "TG inbound" catalog row must not assert reachability when the poller is
// not running (the poller died silently three times while the row kept
// asserting). Core owns the registry at
// packages/core/src/lib/state/telegram-poller-liveness.ts; the literal is
// mirrored here because this package has no core dep — same seam pattern as
// the tunnel hub and the tg-signal sender above.
export const TELEGRAM_POLLER_LIVENESS_KEY = "__braid_tg_poller_liveness";

/**
 * Owner-side env aliases: TELEGRAM_* and BRAID_TG_* both resolve, BRAID_TG_*
 * first. It wins when set;
 * TELEGRAM_* is read only as a fallback, so deployments using the TELEGRAM_*
 * names keep working unchanged, and a rename to BRAID_TG_* is a no-op. Const
 * names stay BRAID_TG_* (tests reference them).
 */
const ENV_ALIASES: Record<string, string | undefined> = {
  [ENV_TOKEN]: "TELEGRAM_BOT_TOKEN",
  [ENV_CHAT_ID]: "TELEGRAM_CHAT_ID",
  [ENV_ALLOWED_USERS]: "TELEGRAM_ALLOWED_USERS",
  [ENV_STATE_FILE]: "TELEGRAM_STATE_FILE",
  [ENV_MEDIA_DIR]: "TELEGRAM_MEDIA_DIR",
  [ENV_POLL_INTERVAL_MS]: "TELEGRAM_POLL_INTERVAL_MS",
  [ENV_COALESCE_WINDOW_MS]: "TELEGRAM_COALESCE_WINDOW_MS",
  [ENV_POLL_DISABLED]: "TELEGRAM_POLL_DISABLED",
  [ENV_POLL_ENABLED]: "TELEGRAM_POLL_ENABLED",
  [ENV_POLLER_LOCK_FILE]: "TELEGRAM_POLLER_LOCK_FILE",
  [ENV_VERBOSE]: "TELEGRAM_VERBOSE",
  [ENV_STT_BASE_URL]: "TELEGRAM_STT_BASE_URL",
  [ENV_STT_API_KEY]: "TELEGRAM_STT_API_KEY",
  [ENV_STT_MODEL]: "TELEGRAM_STT_MODEL",
  [ENV_STT_LANGUAGE]: "TELEGRAM_STT_LANGUAGE",
  [ENV_STT_MODE]: "TELEGRAM_STT_MODE",
  [ENV_STT_KEYS]: "TELEGRAM_STT_KEYS",
  [ENV_STT_KEYRING_SERVICE]: "TELEGRAM_STT_KEYRING_SERVICE",
  [ENV_STT_NORMALIZE]: "TELEGRAM_STT_NORMALIZE",
  [ENV_NOTIFY_ENABLED]: "TELEGRAM_NOTIFY_ENABLED",
  [ENV_NOTIFY_MODEL]: "TELEGRAM_NOTIFY_MODEL",
  [ENV_NOTIFY_MAX_PER_MIN]: "TELEGRAM_NOTIFY_MAX_PER_MIN",
  [ENV_LIVE_UPDATE_ENABLED]: "TELEGRAM_LIVE_UPDATE_ENABLED",
  [ENV_LIVE_UPDATE_MAX_PER_MIN]: "TELEGRAM_LIVE_UPDATE_MAX_PER_MIN",
  [ENV_LIVE_UPDATE_STATE_FILE]: "TELEGRAM_LIVE_UPDATE_STATE_FILE",
};

/**
 * Lookup one config key: canonical BRAID_TG_* value if set, else the
 * TELEGRAM_* alias (if any). Trimmed; empty counts as unset. Exported so
 * tests can assert which name wins.
 */
export function env(name: string): string | undefined {
  const canonical = process.env[name]?.trim();
  if (canonical) return canonical;
  const alias = ENV_ALIASES[name];
  const fallback = alias ? process.env[alias]?.trim() : undefined;
  return fallback ? fallback : undefined;
}

/** Comma-separated allow-list: numeric ids and/or @usernames. */
function parseAllowedUsers(envValue?: string): Array<number | string> {
  const allowed: Array<number | string> = [];
  const chatId = env(ENV_CHAT_ID);
  if (chatId && /^\d+$/.test(chatId)) allowed.push(Number(chatId));
  for (const entry of (envValue ?? "").split(",")) {
    const s = entry.trim();
    if (!s) continue;
    if (/^\d+$/.test(s)) allowed.push(Number(s));
    else allowed.push(s);
  }
  return allowed;
}

/**
 * TUI-safe log sink — notify-shaped, same signature as pi's `ctx.ui.notify`
 * (`(message, type: "info" | "warning" | "error")`). The factory binds it to
 * the session's `ctx.ui.notify`; in headless/RPC/print runs (or with no sink
 * set) it stays undefined and log() is SILENT — never console.*.
 */
export type TelegramLogSink = (
  message: string,
  type: "info" | "warning" | "error",
) => void;

/** Module-level notify sink (native pi-core pattern — see core's logger.ts). */
let logSink: TelegramLogSink | undefined;

/**
 * Set (or clear) the log sink log() routes through. The extension factory
 * binds this to `ctx.ui.notify` on `session_start` (the factory's ExtensionAPI
 * has no `ui` — only event/command contexts do) and clears it on
 * `session_shutdown`. With NO sink configured — headless/RPC/print modes or
 * before the first session — warn/error are SILENT. Never console.*, so the
 * TUI input field never sees a telegram line.
 */
export function setLogSink(sink: TelegramLogSink | undefined): void {
  logSink = sink;
}

/** Join extra args into the notify message (Errors become their message). */
function logDetail(rest: unknown[]): string {
  if (rest.length === 0) return "";
  return ` ${rest.map((v) => (v instanceof Error ? v.message : String(v))).join(" ")}`;
}

/**
 * Extension logger (TUI-safe).
 *
 * warn+error route through the `setLogSink(ctx.ui.notify)` sink and NEVER
 * console.*: any console write from an extension in the live pi TUI is
 * restored into the owner's INPUT line and corrupts it. With no sink bound
 * (headless/print runs or before the first session_start) they are SILENT.
 * debug+info emit NOTHING by default — same TUI-corruption reason — unless
 * BRAID_TG_VERBOSE=1 (alias TELEGRAM_VERBOSE), which routes them through the
 * sink as info toasts (still never console). inbound-poller.ts throttles the
 * repeating poll failures; this gate closes the remaining
 * stdout path. Exported so tests can pin the default-silent no-console
 * contract.
 */
export function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  ...rest: unknown[]
): void {
  if (level === "debug" || level === "info") {
    if (!env(ENV_VERBOSE)) return; // default: zero output
    logSink?.(`[telegram] ${message}${logDetail(rest)}`, "info");
    return;
  }
  // warn/error: sink only; no sink → silent (never console.*).
  logSink?.(
    `[telegram] ${message}${logDetail(rest)}`,
    level === "warn" ? "warning" : "error",
  );
}

// Inbound formatting (agent-zero prompts/fw.telegram.user_message.md template)

/**
 * The reply reference line, rendered into the envelope header so the owner's
 * "yes, that one" arrives attached to what it answers. An absent reference
 * renders NOTHING: a message that is not a reply keeps exactly the envelope it
 * had, so a missing or malformed reply field can only ever cost the reference.
 */
export function formatReplyLine(reply?: IncomingReplyContext): string {
  if (!reply) return "";
  const target =
    reply.author === "agent"
      ? "your message"
      : reply.author === "owner"
        ? "the owner's message"
        : "an unidentified message";
  const quoted = reply.excerpt ? ` — "${reply.excerpt}"` : "";
  return `\nreplying to ${target} ${reply.messageId}${quoted}`;
}

export function formatInboundMessage(message: IncomingOwnerMessage): string {
  const sender = message.username
    ? `@${message.username}`
    : `id ${message.fromId}`;
  const name = message.firstName ? ` (${message.firstName})` : "";
  // `@ HH:MM TZ` = the update's send time (TelegramUpdate.date via receivedAt,
  // Owner TZ — mirrored core formatter): a stale queued
  // message is distinguishable from a fresh one.
  const sentClock = Number.isFinite(message.receivedAt)
    ? ` @ ${formatWhisperClock(message.receivedAt)}`
    : "";
  // The opening tag line carries nothing after `]`: the provenance line
  // starts on its own line so the envelope header is readable at a glance.
  const header = `[braid-whisper - telegram${sentClock}]\nfrom ${sender}${name} in chat ${message.chatId}/${message.chatType}${formatReplyLine(message.replyTo)}`;
  return `${header}\n\n${message.text.trim()}\n[braid-whisper-end]`;
}

/**
 * One delivery carrying N owner messages, in arrival order. Each part keeps
 * its own "from ... in chat ..." line and send-time clock (`@ HH:MM TZ`), so
 * provenance and ordering survive the coalescing; the header's count makes it
 * legible that this is ONE delivery of N (never N deliveries). A single
 * message returns the plain formatInboundMessage envelope unchanged: a lone
 * message must not look like a batch.
 */
export function formatInboundBatch(messages: IncomingOwnerMessage[]): string {
  if (messages.length === 1) return formatInboundMessage(messages[0]);
  const header = `[braid-whisper - telegram]\n${messages.length} coalesced owner messages`;
  const parts = messages.map((message, index) => {
    const sender = message.username
      ? `@${message.username}`
      : `id ${message.fromId}`;
    const name = message.firstName ? ` (${message.firstName})` : "";
    const sentClock = Number.isFinite(message.receivedAt)
      ? ` @ ${formatWhisperClock(message.receivedAt)}`
      : "";
    const partHeader = `[${index + 1}/${messages.length}${sentClock}] from ${sender}${name} in chat ${message.chatId}/${message.chatType}${formatReplyLine(message.replyTo)}`;
    return `${partHeader}\n\n${message.text.trim()}`;
  });
  return `${header}\n\n${parts.join("\n\n")}\n[braid-whisper-end]`;
}

/** if-has-token guard predicate (exported for tests). */
export function isTelegramEnabled(): boolean {
  return Boolean(env(ENV_TOKEN));
}

/** Injectable dependencies for tests (fixture pattern); defaults match the live runtime. */
export interface TelegramExtensionDeps {
  /** Injectable fetch (tests use a recorded-fixture fake; defaults to globalThis.fetch). */
  fetch?: TelegramFetch;
  /** Live-pid probe for the ownership lock (tests inject; default process.kill(pid, 0)). */
  pidAlive?: (pid: number) => boolean;
}

// Singleton background poller (OFF by default)

/** The single active background poller, if any. At most one per process. */
let activePoller: InboundPoller | undefined;
/** Which extension started it (for diagnostics). */
let pollerStartedBy: string | undefined;
/**
 * Poller intent across agent-session reloads: pi-core emits
 * session_shutdown on EVERY reload (agent-session.js reload() → emit
 * session_shutdown), and the rebuilt runtime re-runs this factory with the
 * default-off branch — so a plain reload would otherwise strand the inbound
 * channel silently. When true, the session_start re-arm restarts the poller
 * with fresh bindings. Explicit disables clear it.
 */
let pollerWanted = false;

/**
 * Why a start attempt did not start: `already-running` (this process's own
 * singleton), `role-forbidden` (worker session — the seat owns the poller),
 * `lock-held` (another LIVE process owns the machine-wide lock; `holder`
 * names it), or `lock-path-underivable` (no absolute braid root, so the
 * ownership lock has no home). Callers render the reason for their own
 * surface.
 */
type PollerStartRefusal =
  | { started: false; reason: "already-running" }
  | { started: false; reason: "role-forbidden" }
  | { started: false; reason: "lock-held"; holder: PollerLockInfo }
  | { started: false; reason: "lock-path-underivable" };
type PollerStartOutcome = { started: true } | PollerStartRefusal;

/** Refusal body call sites append to their own surface-specific prefix. */
function describePollerStartRefusal(outcome: PollerStartRefusal): string {
  if (outcome.reason === "lock-held") {
    return `ownership lock held by ${describeLockHolder(outcome.holder)}`;
  }
  if (outcome.reason === "role-forbidden") {
    return "worker role — the orchestrator seat owns the Telegram poller";
  }
  if (outcome.reason === "lock-path-underivable") {
    return "no absolute braid root for the ownership lock (set BRAID_HOME)";
  }
  return `already running (started by ${pollerStartedBy ?? "unknown"})`;
}

/**
 * Start the singleton background poller. Idempotent — if one is already
 * running this is a no-op. Gates, in order: the per-process singleton, the
 * session role, then the machine-wide ownership lock.
 */
function startSingletonPoller(opts: {
  token: string;
  allowedUsers: Array<number | string>;
  stateFile: string;
  fetchFn: TelegramFetch;
  intervalMs: number;
  mediaDir?: string;
  stt?: SttConfig;
  onOwnerMessage: (msg: IncomingOwnerMessage) => void;
  onCallbackQuery?: (update: TelegramUpdate) => void | Promise<void>;
  /**
   * Pause-gate reader: the poller gates NON-callback
   * Owner delivery on this. Defaults to the real getPauseState() (resolves the
   * same settings/default state file the callback handler uses), so the gate
   * is ON in production whenever the flag is paused — no new config keys.
   */
  getPauseState?: PauseStateReader;
  startedBy: string;
  /**
   * Post-start hook: invoked once AFTER the poller is
   * running. This is the lifecycle seam where the orchestrator (index.ts)
   * places the ⏸/▶️/📊 control keyboard into the owner chat — the factory
   * supplies a closure that reads the pause flag and sendControlKeyboard's, so
   * the keyboard actually appears on every poller start (boot env auto-start,
   * /telegram enable, telegram_poller enable).
   */
  onStart?: () => void;
  /** Live-pid probe for the ownership lock (tests inject; default isPidAlive). */
  pidAlive?: (pid: number) => boolean;
}): PollerStartOutcome {
  if (activePoller?.isRunning()) {
    log(
      "info",
      `telegram poller already running (started by ${pollerStartedBy ?? "unknown"}) — not starting another`,
    );
    return { started: false, reason: "already-running" };
  }
  // Role gate: a worker session never owns the channel — the poller is the
  // orchestrator seat's machine-wide singleton, so every start path stops
  // here in the worker role.
  if (isWorkerRole()) {
    log(
      "info",
      "telegram poller not started: worker role — the orchestrator seat owns the poller",
    );
    return { started: false, reason: "role-forbidden" };
  }
  // Machine-wide ownership lock: refuse while a live foreign pid holds the
  // getUpdates singleton; our own pid (reload cycles) and stale locks (dead
  // pid, unreadable file) are taken over silently. An underivable lock path
  // refuses the start: without the lock two processes could poll the same bot.
  const lockPath = pollerLockFile();
  if (lockPath === null) {
    warnUnderivableRoot("poller lock refused");
    log(
      "warn",
      "telegram poller not started: the ownership lock path cannot be derived " +
        "(BRAID_HOME is unset and no absolute home resolves)",
    );
    return { started: false, reason: "lock-path-underivable" };
  }
  const acquired = acquirePollerLock(
    lockPath,
    {
      pid: process.pid,
      startedAt: Date.now(),
      role: resolveSessionRole(),
      startedBy: opts.startedBy,
    },
    opts.pidAlive,
  );
  if (!acquired.ok) {
    log(
      "warn",
      `telegram poller not started: ${describeLockHolder(acquired.holder)} holds the ownership lock — refusing to steal the getUpdates singleton`,
    );
    return { started: false, reason: "lock-held", holder: acquired.holder };
  }
  activePoller = createInboundPoller({
    token: opts.token,
    allowedUsers: opts.allowedUsers,
    stateFile: opts.stateFile,
    fetchFn: opts.fetchFn,
    mediaDir: opts.mediaDir,
    stt: opts.stt,
    intervalMs: opts.intervalMs,
    bootstrap: true,
    onOwnerMessage: opts.onOwnerMessage,
    onCallbackQuery: opts.onCallbackQuery,
    // Pause gate: real reader by default → inbound is held + acked once per
    // paused period while the flag is paused (callbacks stay ungated).
    getPauseState: opts.getPauseState ?? readPauseState,
    onError: (error) => log("warn", `inbound poll error: ${String(error)}`),
    // Watchdog canary: relay the poller's tunnel liveness transitions into
    // the process-global watchdog hub the core watchdog subscribes to. One
    // emitter (the poller) -> one relay -> one consumer (core watchdog).
    onTunnelStatusChange: (event) => publishWatchdogTunnel(event),
    log,
  });
  activePoller.start();
  pollerStartedBy = opts.startedBy;
  pollerWanted = true;
  log(
    "info",
    `telegram poller started by ${opts.startedBy} (allow-list: ${JSON.stringify(opts.allowedUsers.length)}, state: ${opts.stateFile})`,
  );
  // Post-start seam: the orchestrator places the control keyboard now that the
  // poller is live — deferred to the first owner
  // message when the owner chat is not yet known.
  opts.onStart?.();
  return { started: true };
}

/** Lock file path: explicit env override first, then the braid-home default.
 *  Null when the default root cannot be derived. */
function pollerLockFile(): string | null {
  return env(ENV_POLLER_LOCK_FILE) ?? defaultPollerLockPath();
}

/** Stop the singleton background poller if running. */
function stopSingletonPoller(): boolean {
  if (!activePoller?.isRunning()) return false;
  pollerWanted = false;
  activePoller.stop();
  activePoller = undefined;
  pollerStartedBy = undefined;
  // An explicit disable gives the channel up machine-wide; the reload-path
  // shutdown does NOT release — the session_start re-arm re-acquires our own
  // pid's lock without a window where another process could claim it.
  const lockPath = pollerLockFile();
  if (lockPath !== null) releasePollerLock(lockPath);
  log("info", "telegram poller stopped");
  return true;
}

function isPollerRunning(): boolean {
  return activePoller?.isRunning() ?? false;
}

export default async function telegramExtension(
  pi: ExtensionAPI,
  deps?: TelegramExtensionDeps,
): Promise<void> {
  // The collision gate below needs a live ExtensionContext to ask pi's
  // supported idle question (ctx.isIdle()); the poller callbacks that deliver
  // owner messages have no handler context, so the lifecycle handlers refresh
  // this reference. A replaced session makes the old context throw on access;
  // the gate then treats the session as idle and delivers immediately.
  let liveCtx: ExtensionContext | undefined;

  // TUI notify sink (native pi-core pattern)
  // The factory's ExtensionAPI has no `ui`; the session_start handler is the
  // first context carrying ctx.ui.notify. In RPC/print/headless runs pi hands
  // notify a no-op, so these lines are inert there; cleared on shutdown so no
  // stale reference outlives the session. Gates every log() call whether or
  // not the guard below lets the channel start.
  pi.on("session_start", (_event, ctx) => {
    liveCtx = ctx;
    setLogSink(ctx?.ui?.notify ? ctx.ui.notify.bind(ctx.ui) : undefined);
  });
  pi.on("session_shutdown", (_event, _ctx) => {
    liveCtx = undefined;
    setLogSink(undefined);
  });

  // publish the live poller probe for the awareness whisper's TG row
  // (see TELEGRAM_POLLER_LIVENESS_KEY above). Written before the if-has-token
  // guard so no-token deployments (poller can never start) read "stopped",
  // not "unknown". The probe reads the module-local poller singleton live on
  // every call, so start/stop/silent-death are all captured without per-event
  // wiring; each factory run (including post-reload) re-binds the slot.
  (globalThis as Record<string, unknown>)[TELEGRAM_POLLER_LIVENESS_KEY] = () =>
    Boolean(activePoller?.isRunning());

  // Route a refused braid path through the TUI-safe log (never console.*),
  // exactly like log() itself: silent until a session binds the notify sink.
  setPathRefusalSink((message) => log("warn", message));

  // if-has-token guard
  const token = env(ENV_TOKEN);
  if (!token) {
    log(
      "debug",
      `${ENV_TOKEN} is not set — telegram tools NOT registered (if-has-token guard). Set ${ENV_TOKEN} to enable the Telegram channel.`,
    );
    return;
  }
  log("info", `Telegram channel enabled (${ENV_TOKEN} present)`);

  const chatIdEnv = env(ENV_CHAT_ID);
  const allowedUsers = parseAllowedUsers(env(ENV_ALLOWED_USERS));
  const stateFile = env(ENV_STATE_FILE) ?? defaultStateFilePath();
  // No absolute braid root and no explicit BRAID_TG_STATE_FILE: every inbound
  // surface here needs offset persistence (a poller without it re-delivers,
  // an inbox pull without it duplicates), so the channel refuses to register
  // instead of running with state that cannot be written. Same shape as the
  // token guard above; a pinned deployment is unaffected.
  if (stateFile === null) {
    warnUnderivableRoot("telegram channel refused");
    log(
      "error",
      "telegram channel NOT registered: no braid state file can be derived " +
        "(BRAID_HOME is unset and no absolute home resolves). Set BRAID_HOME " +
        `(or ${ENV_STATE_FILE}) to an absolute path.`,
    );
    return;
  }
  // The delivery hold (see the delivery block below) is a file beside the offset
  // state, so BRAID_TG_STATE_FILE governs both and a deployment or test that
  // redirects the state directory redirects the hold with it — one knob, no
  // second config key to document.
  const inboundQueueFile = inboundQueueFileFor(stateFile);
  const interval = Number(env(ENV_POLL_INTERVAL_MS)) || 1500;
  // Coalescing window (see the collision-aware delivery block below): invalid
  // or negative values fall back to the default; 0 is a legal "next tick".
  const coalesceWindowMs = (() => {
    const parsed = Number(env(ENV_COALESCE_WINDOW_MS));
    return Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : DEFAULT_COALESCE_WINDOW_MS;
  })();
  const fetchImpl = deps?.fetch ?? (globalThis.fetch as TelegramFetch);
  const client = createTelegramClient({ fetch: fetchImpl });

  // Session role (registration-time gate): a worker session keeps
  // telegram_send but never sees the poller-ownership surfaces and never
  // starts the poller — the orchestrator seat owns the getUpdates singleton.
  const workerRole = isWorkerRole();

  // Inline-keyboard pause/resume control
  // The pause flag is a signal for the CONSUMER (the orchestrator reads it via
  // the exported getPauseState()); this handler only persists the flag and
  // keeps the control keyboard in sync — it never blocks the poller or the
  // core loop. Config via settings (braid.telegram.pauseStateFile), not env;
  // the default file lives under the braid root (see lib/state-paths.ts) and
  // reads fall back to the pre-move agent-dir copy.
  const pauseStateFile = resolvePauseStateFile();
  const handleCallbackQuery = async (update: TelegramUpdate): Promise<void> => {
    const cq = update.callback_query;
    if (!cq?.id) return;
    // Decision taps first: a well-formed `dec:` payload is acknowledged and
    // handed to the SAME inbound delivery path as a text message (coalescing,
    // steer handoff; callbacks are not pause-gated, as today). Everything else —
    // pause/resume/status and unknown data — keeps the control handler's path
    // byte-for-byte.
    const decision = await handleDecisionCallbackQuery(
      { client, token, log },
      update,
    );
    if (decision.handled) {
      // Awaited so the hold is persisted before the poller confirms the offset
      // (same durability rule the text path's onOwnerMessage await carries).
      if (decision.delivery) await deliverOwnerMessage(decision.delivery);
      return;
    }
    await handlePauseCallbackQuery(
      { client, token, stateFile: pauseStateFile, log },
      cq as unknown as PauseCallbackQuery,
    );
  };

  // Publish the watchdog tg-signal sender so the core watchdog can push a
  // 1-line remote canary ping on escalations (stall/quota; tunnel-down needs
  // no ping — tg is down). Best-effort: returns false on any failure so the
  // watchdog treats the optional signal as skipped, never fatal.
  (globalThis as Record<string, unknown>)[WATCHDOG_TG_SIGNAL_KEY] = async (
    text: string,
  ): Promise<boolean> => {
    const chatId = resolveChatId();
    if (!chatId) return false;
    try {
      await client.sendMessage(token, chatId, text);
      return true;
    } catch {
      return false;
    }
  };

  // Publish the provider-outage notify sender (same route, same chat
  // resolution). The watcher renders the text; this side only resolves the
  // configured chat and sends. Delivery is read off the client result, so a
  // refused send reports false and the watcher can release its dedupe claim
  // for another process or a later episode.
  (globalThis as Record<string, unknown>)[PROVIDER_OUTAGE_NOTIFY_KEY] = async (
    text: string,
  ): Promise<boolean> => {
    const chatId = resolveChatId();
    if (!chatId) return false;
    const result = await client.sendMessage(token, chatId, text);
    return result.ok === true;
  };

  // voice inbound STT config
  // One config object threaded to both inbound consumers (poller + inbox);
  // absent apiKey means voice notes are still received (delivered as the saved
  // path) but not transcribed.
  // Venice chat/input_audio is the default path on the existing
  // AGENT_ZERO_API_KEY (no new env required); BRAID_TG_STT_MODE=transcriptions
  // opts back to the OpenAI-compatible route. BRAID_TG_STT_API_KEY /
  // BRAID_TG_STT_BASE_URL / BRAID_TG_STT_MODEL stay as explicit overrides for
  // non-Venice providers; the Venice default path requires none of them.
  // Resolve the STT mode first: the Venice AGENT_ZERO_API_KEY fallback below is
  // gated on it. In mode=transcriptions (or any non-Venice baseUrl) with no
  // explicit BRAID_TG_STT_API_KEY, the Venice key would be sent to the
  // OpenAI/foreign endpoint → 401 + credential exposure.
  // Chat-mode baseUrl default: the deployed key is gateway-scoped —
  // Venice DIRECT rejects it (voice STT 401 on every note). Default to the
  // userland venice catalog's gateway baseUrl (readCatalogBaseUrl, mirroring
  // packages/providers/venice-catalog.ts) so the key pairs with the gateway
  // the rest of the deployment already uses; absent catalog → legacy default.
  const sttMode: "transcriptions" | "chat" =
    env(ENV_STT_MODE) === "transcriptions" ? "transcriptions" : "chat";
  // Key pool (failover): explicit key first, then BRAID_TG_STT_KEYS, the
  // macOS keyring (absent item tolerated), then every AGENT_ZERO_API_KEY*
  // env var in stable order. Resolved once at boot; the pool advances past
  // auth/quota/rate failures at call time and the winning key is remembered
  // for the process lifetime (stt-keys.ts). Transcription is bounded to two
  // rounds; the second amplifies quiet audio via ffmpeg when
  // BRAID_TG_STT_NORMALIZE is on (default).
  const sttKeys = await resolveSttKeyCandidates({
    explicit: env(ENV_STT_API_KEY),
    env: process.env as Record<string, string | undefined>,
    keyringService: env(ENV_STT_KEYRING_SERVICE),
    // The AGENT_ZERO_API_KEY* family is Venice-specific: pool it for the chat
    // endpoint only, so transcriptions mode never sends a Venice key to the
    // OpenAI-compatible endpoint (cross-provider key leak).
    includeAgentZeroEnv: sttMode === "chat",
  });
  const stt: SttConfig = {
    baseUrl: resolveSttBaseUrl({
      env: env(ENV_STT_BASE_URL),
      catalogBaseUrl: readCatalogBaseUrl(),
      mode: sttMode,
    }),
    apiKey: sttKeys[0]?.key,
    keys: sttKeys,
    normalize: {
      enabled: env(ENV_STT_NORMALIZE) !== "0",
      normalizeBytes: (bytes) => normalizeAudioBytes(bytes),
    },
    model: env(ENV_STT_MODEL) ?? DEFAULT_STT_CHAT_MODEL,
    language: env(ENV_STT_LANGUAGE),
    mode: sttMode,
  };

  // Outbound target: explicit BRAID_TG_CHAT_ID first; once the owner DMs the
  // bot (first-message bootstrap), capture the real private chat.id so the
  // tool can reply without BRAID_TG_CHAT_ID being set.
  let ownerChatId: number | string | undefined = chatIdEnv;
  const resolveChatId = (): number | string =>
    ownerChatId ?? (allowedUsers[0] as number | string | undefined) ?? 0;

  // Control-keyboard placement
  // The owner must actually SEE the ⏸/▶️/📊 control — placement is wired at the
  // POLLER-START seam: every time the background poller starts (env auto-start
  // at boot, /telegram enable, telegram_poller enable) the persisted pause flag
  // is read and placeControlKeyboard places the control in the owner chat.
  // Delivery-neutral: nothing self-sends on import — THIS factory (the entity
  // that owns the inbound poller) places. When the owner chat is not yet known
  // at start (no BRAID_TG_CHAT_ID and no allow-list — pure first-message
  // bootstrap) placement is DEFERRED and fires once the first owner message
  // captures ownerChatId (deliverOwnerMessage → flushDeferredControlPlacement).
  // Post-resume correctness is already cheap: the callback handler edits the
  // SAME keyboard in place (editMessageText) on every tap, so pause/resume
  // refresh in place — no per-transition re-send/spam.
  let controlPlacement: "idle" | "placed" | "deferred" = "idle";
  // Arrow const (not a hoisted declaration) so `token` stays narrow-typed to
  // `string` inside this closure — the same pattern live-update/turn-notify use.
  const placeControlKeyboardOnce = async (): Promise<void> => {
    if (controlPlacement === "placed") return; // already in the owner chat this boot
    const outcome = await placeControlKeyboard(resolveChatId(), {
      client,
      token,
      // Same reader the poller pause gate uses — placement and gate always agree.
      getPauseState: readPauseState,
      log,
    });
    controlPlacement = outcome.deferred ? "deferred" : "placed";
  };
  function flushDeferredControlPlacement(): void {
    if (controlPlacement !== "deferred") return;
    controlPlacement = "idle"; // one-shot retry now that the owner chat is known
    void placeControlKeyboardOnce();
  }

  // Voice TTS source: resolved once at factory start from `braid.telegram.tts`
  // in ~/.pi/agent/settings.json (config shape and defaults in lib/tts.ts).
  // populateVoiceTts() returns undefined when synthesis is disabled
  // (`source: "none"`), which keeps the voice-refusal path in tool-logic.ts
  // intact — voice:true errors, it never silently sends text.
  const voiceTts = populateVoiceTts();

  // Outbound tool (telegram_send)
  pi.registerTool({
    name: "telegram_send",
    label: "Telegram Send",
    promptSnippet:
      "Send a message (text or voice) to the human owner on Telegram",
    promptGuidelines: [
      "Use telegram_send to notify or ask the human owner. Messages are LONG by default: plain text sends verbatim up to the cap (braid.telegram.sendMaxChars, default 4096 — Telegram's per-message limit); there is no tweet-length rule. Reply with telegram_send when the owner's message arrived inside a [braid-whisper - telegram ...] envelope; human input with no envelope is TUI input — answer that in-session.",
      "`text` is required and must be non-empty; over-cap text without an explicit choice returns an ERROR (nothing sent) — pick rich:true, a shorter text, or an explicit strategy (never a silent truncate).",
      "Set `rich: true` past the cap (or for formatted/split delivery): it bypasses the cap and splits the text to fit Telegram's 4096-char messages, honoring `parse_mode` (HTML or Markdown).",
      'Author the body in the `parse_mode` you pick. `parse_mode:"Markdown"` is Telegram LEGACY Markdown (`*bold*`, `_italic_`, `` `code` ``, `[link](url)`); clean single-line MarkdownV2 pairs (`**bold**`, `__underline__`, `~strike~`, `||spoiler||`) are converted to HTML (`<b>`, `<u>`, `<s>`, `<tg-spoiler>`) and reported as `converted` — runs (`~~x~~`), spaced operators (`x ~ y ~ z`) and pairs that would cross author tags stay literal. HTML (tags: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<tg-spoiler>`, `<a href>`) is the predictable choice for anything nontrivial. Cross-mode markup is sanitized automatically: raw HTML tags never leak into a Markdown message and Markdown markers never show literally in an HTML message.',
      "Pass `options` (1-2 rows, up to 4 buttons per row: {label, value}) to let the owner answer with a tap: the choice arrives as an inbound `[decision] <token> → <label> (<value>)` message. `decisionToken` is the correlation id (generated when omitted, echoed in the result). The owner can always reply in words instead.",
    ],
    description:
      "Send a message to the owner on Telegram (bidirectional channel). " +
      "LENGTH FIRST, before writing the body: messages are LONG by default — plain text sends verbatim up to 4096 chars (braid.telegram.sendMaxChars); there is no tweet-length rule. " +
      "A body over the cap needs rich:true (split-to-fit at 4096/message); `limit` raises/lowers the cap. " +
      'Example (correct): text "Deploy finished, 2 tests failed — rerunning suite B" sends as-is. ' +
      'Example (over cap, no rich/limit, no distillation): a 5000-char plain body errors with "NOTHING was sent". ' +
      'Over the cap with no explicit choice: the crafting model distills to ≤ the cap; unavailable distillation = refused — never a silent truncate. Explicit choice wins: strategy:"truncate" hard-cuts; strategy:"error" refuses. ' +
      'rich:true + parse_mode (HTML | Markdown): `"Markdown"` is Telegram LEGACY Markdown (`*bold*`, `_italic_`, `` `code` ``, `[t](url)`); clean single-line MarkdownV2 pairs (`**bold**`, `__underline__`, `~strike~`, `||spoiler||`) convert to HTML (`<b>`, `<u>`, `<s>`, `<tg-spoiler>`) and are reported as `converted` (runs, spaced operators and tag-crossing pairs stay literal). Cross-mode markup is neutralized; a body with HTML tags auto-selects HTML. ' +
      "voice:true sends a voice note (needs a TTS source); voiceText defaults to text. " +
      "options: 1-2 rows of up to 4 {label,value} buttons attach an inline keyboard; a tap returns to the agent as an inbound `[decision] <token> → <label> (<value>)` message (the owner can always answer in words too); decisionToken is the correlation id, generated when omitted and echoed in the result. " +
      "Returns the delivery result (message_id or error). " +
      (workerRole
        ? "A successful send while the inbound poller is OFF carries a warn field — the orchestrator seat owns the inbound poller; messages are delivered without inbound (owner replies reach the seat session)."
        : "A successful send while the inbound poller is OFF carries a warn field — the owner's replies won't reach the agent until telegram_poller enable."),
    parameters: Type.Object({
      text: Type.String({
        minLength: 1,
        description:
          "Message text to send. Sends verbatim up to the cap (default 4096 = braid.telegram.sendMaxChars); over-cap text without an explicit choice returns an error (nothing sent) — never a silent truncate. Must be non-empty.",
      }),
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          description:
            "Explicit char cap for the plain path (default: braid.telegram.sendMaxChars, 4096). Text ≤ limit sends verbatim; over it, `strategy` applies (default: error, nothing sent). Explicit choice wins.",
        }),
      ),
      strategy: Type.Optional(
        Type.Union([Type.Literal("truncate"), Type.Literal("error")], {
          description:
            'Explicit over-limit handling: "truncate" hard-truncates to the limit with an ellipsis (skips crafting); "error" refuses with an error stating the limit. Default (omitted): craft-then-error — never a silent truncate.',
        }),
      ),
      voice: Type.Optional(
        Type.Boolean({
          description:
            "Send as a Telegram voice note (needs a configured TTS source). Default false (text).",
        }),
      ),
      voiceText: Type.Optional(
        Type.String({
          description:
            "Text to read aloud in the voice note; defaults to `text`.",
        }),
      ),
      rich: Type.Optional(
        Type.Boolean({
          description:
            "Send a long formatted report: bypasses the default cap and splits the text to fit Telegram's 4096-char messages. Default false.",
        }),
      ),
      parse_mode: Type.Optional(
        Type.Union([Type.Literal("HTML"), Type.Literal("Markdown")], {
          description:
            'Format for the delivered text. `"Markdown"` is Telegram LEGACY Markdown (`*bold*`, `_italic_`, `` `code` ``, `[t](url)`); clean single-line MarkdownV2 pairs (`**bold**`, `__underline__`, `~strike~`, `||spoiler||`) are converted to HTML (`<b>`, `<u>`, `<s>`, `<tg-spoiler>`) instead and reported as `converted` — runs (`~~x~~`), spaced operators and pairs that would cross author tags stay literal. HTML is the predictable choice for anything nontrivial. Cross-mode markup is sanitized automatically: nothing from the other format leaks raw. Optional; plain text by default, except a body containing HTML tags auto-selects HTML.',
        }),
      ),
      options: Type.Optional(
        Type.Array(
          Type.Array(
            Type.Object({
              label: Type.String({
                minLength: 1,
                description: "Button text shown to the owner.",
              }),
              value: Type.String({
                minLength: 1,
                description:
                  "Machine-readable choice returned to the agent when the button is tapped.",
              }),
            }),
            { minItems: 1, maxItems: 4 },
          ),
          {
            minItems: 1,
            maxItems: 2,
            description:
              "Decision buttons: 1-2 rows of up to 4 {label, value} buttons, attached to the message as an inline keyboard. A tap returns to the agent as an inbound `[decision] <token> → <label> (<value>)` message. Malformed rows refuse the send (nothing delivered).",
          },
        ),
      ),
      decisionToken: Type.Optional(
        Type.String({
          description:
            "Short correlation id (1-16 chars of A-Za-z0-9_-) for the decision buttons; echoed back on every tap and in the result. Generated when omitted. Only meaningful together with `options`.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const outcome = await runTelegramSend(params as never, {
        client,
        token,
        chatId: resolveChatId(),
        tts: voiceTts,
        // LLM-crafted content distills before any hard cap; the model call
        // is key-ring-backed via ctx.modelRegistry — never the bot token.
        craft: ctx
          ? createTextCraftHook(
              ctx.modelRegistry,
              ctx.model,
              env(ENV_NOTIFY_MODEL),
            )
          : undefined,
        // Poller-liveness guard: a successful
        // send while inbound is dead warns on the outcome so the agent knows
        // replies won't be consumed. BRAID_TG_POLL_DISABLED deployments are
        // deliberately outbound-only — no warning.
        pollerRunning: env(ENV_POLL_DISABLED)
          ? () => true
          : () => Boolean(activePoller?.isRunning()),
        workerRole,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(outcome, null, 2) },
        ],
        details: outcome,
      };
    },
  });

  // turn-complete auto-notify
  // When a turn ends with a completed plain-text answer (no trailing tool
  // call), a distilling model call crafts an owner update up to
  // braid.telegram.notifyMaxChars (default 1200) and sends it through the SAME
  // outbound seam as telegram_send. Opt-in via BRAID_TG_NOTIFY_ENABLED=1
  // (default OFF — no unsolicited messages). The model call is key-ring-backed
  // via ctx.modelRegistry (never the bot token); the cap is only a
  // guard-fallback. Rate-limited (default 4/min).
  const notifyEnabled = Boolean(env(ENV_NOTIFY_ENABLED));
  const notifyMaxPerMin =
    Number(env(ENV_NOTIFY_MAX_PER_MIN)) || DEFAULT_NOTIFY_MAX_PER_MIN;
  const notifyLog = (m: string, t?: "info" | "warning" | "error") =>
    log(t === "warning" ? "warn" : t === "error" ? "error" : "info", m);
  if (notifyEnabled) {
    const notifyHandler = createTurnNotifyHandler({
      callModel: async (prompts, modelCtx: NotifyModelCtx, opts) => {
        const model = resolveNotifyModel(
          modelCtx.registry,
          modelCtx.sessionModel,
          env(ENV_NOTIFY_MODEL),
        );
        if (!model) return { ok: false, error: "no notify model resolvable" };
        return callCraftModel(modelCtx.registry, model, prompts, {
          ...(opts?.maxTokens != null ? { maxTokens: opts.maxTokens } : {}),
        });
      },
      deliver: async (text) => {
        const chatId = resolveChatId();
        if (!chatId) return;
        await client.sendMessage(token, chatId, text);
      },
      maxPerWindow: notifyMaxPerMin,
    });
    pi.on("turn_end", async (event: unknown, ctx: any) => {
      const modelCtx: NotifyModelCtx = {
        registry: ctx?.modelRegistry ?? {},
        sessionModel: ctx?.model,
      };
      await notifyHandler(event, modelCtx, notifyLog);
    });
  }

  // live-update tracked message
  // When enabled, every inbound owner message IMMEDIATELY pins a "Working…"
  // tracked message (edited in place — idempotent, no new-message spam) and,
  // at turn_end with a completed answer, that message is edited to "✅ Done"
  // plus a SEPARATE rich markdown summary is sent (crafted key-ring-backed via
  // ctx.modelRegistry, never the bot token). Default ON — an explicit
  // BRAID_TG_LIVE_UPDATE_ENABLED=0 disables it (no live-update behavior at
  // all). Edit rate-limited (default 4/min). Independent of the turn-complete
  // auto-notify feature above — that stays entirely intact.
  const liveUpdateEnabled = env(ENV_LIVE_UPDATE_ENABLED) !== "0";
  const liveUpdateMaxPerMin =
    Number(env(ENV_LIVE_UPDATE_MAX_PER_MIN)) || DEFAULT_LIVE_UPDATE_MAX_PER_MIN;
  const liveUpdate: LiveUpdateTracker | undefined = (() => {
    if (!liveUpdateEnabled) return undefined;
    const liveStateFile =
      env(ENV_LIVE_UPDATE_STATE_FILE) ?? defaultLiveUpdateStateFile();
    if (liveStateFile === null) {
      warnUnderivableRoot("live-update tracker refused");
      log(
        "warn",
        "telegram live-update disabled: the state file cannot be derived " +
          "(BRAID_HOME is unset and no absolute home resolves)",
      );
      return undefined;
    }
    const tracker = createLiveUpdateTracker({
      client,
      token,
      // Resolve the owner chat at call time (captured from the first
      // inbound owner message; BRAID_TG_CHAT_ID env is only the fallback).
      chatId: resolveChatId,
      stateFile: liveStateFile,
      maxPerWindow: liveUpdateMaxPerMin,
      log,
    });
    log(
      "info",
      `telegram live-update enabled (default-on; ${ENV_LIVE_UPDATE_ENABLED}=0 to disable, max ${liveUpdateMaxPerMin}/min edits, state: ${liveStateFile})`,
    );
    // turn_end lifecycle keyed on the ACTIVE-WORK REFCOUNT: each turn is
    // one unit of work behind the "Working…".
    //  - terminal non-completed turn (abort/error, or no assistant report):
    //    end("no-report") — on 1→0 the indicator is edited to the honest
    //    terminal state ("⏹️ Turn ended without a report") + state cleared;
    //  - completed plain-text answer: end("done") — on 1→0 it is edited to
    //    "✅ Done" and the final rich summary is delivered;
    //  - trailing-tool-call (toolUse) turns: no end() — work continues next
    //    turn, the indicator stays active (never cleared mid-tool).
    // The refcount means a queue of inbound messages counts as N units and
    // the indicator only resolves when the LAST one completes. If this
    // mapping misses (the agent settles without a clean completion — the
    // Freeze), the agent_settled safety-net below forces the
    // honest completion — the indicator NEVER stays at "Working…" forever.
    pi.on("turn_end", async (event: unknown, ctx: any) => {
      if (isTerminalNoReportTurn(event)) {
        await tracker.end("no-report");
        return;
      }
      if (!shouldNotifyTurnEnd(event)) return; // toolUse etc → stays active
      const finalText = extractFinalText(event);
      if (!finalText) return;
      const craftRich = ctx
        ? createRichCraftHook(
            ctx?.modelRegistry ?? {},
            ctx?.model,
            env(ENV_NOTIFY_MODEL),
          )
        : undefined;
      await tracker.end("done", { resultText: finalText, craftRich });
    });
    return tracker;
  })();

  // Inbound delivery: owner messages steer, coalesced
  // pi.sendUserMessage always forwards its deliverAs as prompt()'s
  // streamingBehavior (agent-session.js sendUserMessage). With
  // deliverAs "steer" ONE call shape is correct in both session states: while
  // a run is active pi-core queues the message into the CURRENT run at its
  // next step boundary, and while the session is idle the same call starts a
  // normal turn. This path lets the owner
  // message reach the running turn instead of waiting for the next idle
  // boundary (a busy session would otherwise hold delivery until idle).
  //
  // Batching: a burst is handed over as ONE user message, never one per
  // arrival. Every arrival joins a coalescing window (ENV_COALESCE_WINDOW_MS,
  // default 2000) anchored at the FIRST arrival: a lone message is delayed by
  // at most one window, and because the default window is longer than the
  // default poll interval, a burst split across two poll cycles still lands
  // as one delivery. Later arrivals inside the window join the open batch;
  // they never reset it (a debounce would let a long burst postpone delivery
  // unboundedly). When the window closes, EVERY current-session entry goes
  // out as one sendUserMessage carrying the parts in arrival order. One
  // sendUserMessage per flush starts at most one run, so no activeRun race
  // can form.
  //
  // The array/file below holds arrivals until a flush hands them over and is
  // therefore the fallback when a handoff fails: a steer can still throw (pi
  // refuses prompts while compaction is in progress), and a factory re-run
  // (reload, session replacement) mid-window would otherwise lose an entry
  // the poller's offset has already passed. A thrown handoff re-queues the
  // batch and re-arms the window; the agent_settled flush settles leftovers.
  // The fallback is a FILE, not only this array, because both lifecycle paths
  // take the array away — each re-runs the extension factory, so a fresh
  // closure starts with an empty array while the poller has already persisted
  // its offset past the update:
  //  - a reload re-runs the factory (resource-loader reload() clears the
  //    module cache);
  //  - a session replacement (new/resume/fork) builds a new resource loader
  //    whose reload() re-runs the factory too, so none of this closure
  //    survives into the replacement session.
  // Write-through on every mutation plus a rehydrate at session_start covers
  // both: the entry outlives the factory run, and the session key on the entry
  // is what keeps a rehydrated hold from being delivered into a session it was
  // not accepted for — an entry whose key is still unknown is adopted by the
  // first session that names itself. session_shutdown needs no queue action of
  // its own — the file already holds the entry.
  const pendingInbound: QueuedInboundMessage[] = [];
  // Coalescing window timer: armed when an arrival joins the batch (busy or
  // idle), and re-armed to retry a handoff pi refused. It is
  // unref()ed (a pending window must never keep the process alive) and
  // cleared at session_shutdown; the hold file is the durable half across
  // that boundary, and the next session_start rehydrates into a fresh window.
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;

  /** Arm the window unless one is already pending (later arrivals never reset it). */
  function armCoalesceTimer(): void {
    if (coalesceTimer) return;
    coalesceTimer = setTimeout(() => {
      coalesceTimer = undefined;
      flushPendingInbound();
    }, coalesceWindowMs);
    coalesceTimer.unref?.();
  }

  function clearCoalesceTimer(): void {
    if (!coalesceTimer) return;
    clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
  }

  // `isIdle` is a member of the ExtensionContext (runner.createContext), not
  // of the ExtensionAPI, and a poller callback has no context of its own — so
  // the gate reads the reference cached by the lifecycle handlers. ctx.isIdle()
  // reads the live session state (no active run, no compaction), so a
  // boundary-old context still answers correctly for a later arrival.
  const isPiIdle = (): boolean => {
    try {
      return liveCtx?.isIdle() ?? true;
    } catch {
      // Context from a replaced session: deliver immediately (the pre-fix
      // behavior, and always legal — see the delivery note above).
      return true;
    }
  };

  /**
   * Session the live context belongs to, or undefined when it cannot name one.
   * `sessionManager` is a member of the ExtensionContext (read-only view), so
   * this is the same capture pattern as isIdle above; a context from a replaced
   * session throws on access and answers "unknown".
   */
  function currentSessionId(): string | undefined {
    try {
      return liveCtx?.sessionManager?.getSessionId();
    } catch {
      return undefined;
    }
  }

  /**
   * Write the hold through to disk (best effort). A failed write is reported,
   * not swallowed: the in-memory entry still delivers at the next flush, but
   * it would not survive a reload.
   */
  function persistPendingInbound(): Promise<void> {
    return saveInboundQueue(inboundQueueFile, pendingInbound).catch(
      (error: unknown) => {
        log(
          "warn",
          `telegram inbound: could not persist the inbound hold: ${String(error)}`,
        );
      },
    );
  }

  /**
   * The never-silent half of the contract: an entry that cannot be handed to
   * the session it was accepted for is NAMED — count, update ids and a text
   * preview go to ctx.ui.notify through the log sink, and a durable
   * `telegram_inbound_dropped` session entry keeps the record after the toast
   * is gone.
   */
  function reportDroppedInbound(
    entries: QueuedInboundMessage[],
    currentId: string | undefined,
  ): void {
    if (entries.length === 0) return;
    const acceptedFor = entries[0]?.sessionId;
    const updateIds = entries.map((entry) => entry.message.updateId);
    const preview = entries
      .map((entry) =>
        entry.message.text.trim().replace(/\s+/g, " ").slice(0, 120),
      )
      .filter(Boolean)
      .join(" | ");
    log(
      "warn",
      `telegram inbound: dropped ${entries.length} queued owner message(s) accepted for session ${acceptedFor ?? "(unknown)"} — the current session is ${currentId ?? "(unknown)"} (update id(s) ${updateIds.join(", ")})${preview ? `: ${preview}` : ""}`,
    );
    try {
      pi.appendEntry("telegram_inbound_dropped", {
        count: entries.length,
        acceptedFor: acceptedFor ?? null,
        currentSessionId: currentId ?? null,
        updateIds,
        previews: entries.map((entry) => entry.message.text.slice(0, 400)),
      });
    } catch {
      // The durable half of the report is best effort; the notify above is the
      // visible one. Never let a transcript write break the delivery path.
    }
  }

  /**
   * The session-boundary rule, in one place: an entry accepted for a named
   * session is delivered only to THAT session; an entry accepted while no
   * session could name itself (sessionId undefined) is adopted by the first
   * session that names itself — the current one — and stays for delivery.
   * Adoption stamps the current id onto the entry; returns true when the
   * entry may stay.
   */
  function sessionAdmitsEntry(
    entry: QueuedInboundMessage,
    sessionId: string | undefined,
  ): boolean {
    if (entry.sessionId === undefined) {
      if (sessionId !== undefined) entry.sessionId = sessionId;
      return true;
    }
    return entry.sessionId === sessionId;
  }

  /**
   * Drop (and report) every held entry accepted for a different named
   * session; adopt any entry whose acceptance session is still unknown.
   * Runs at the delivery point, so the session-scope invariant is enforced
   * where the message is handed over, not only where the queue is
   * rehydrated.
   */
  function dropForeignInbound(): void {
    const sessionId = currentSessionId();
    const foreign: QueuedInboundMessage[] = [];
    for (let i = pendingInbound.length - 1; i >= 0; i--) {
      if (!sessionAdmitsEntry(pendingInbound[i], sessionId)) {
        foreign.unshift(...pendingInbound.splice(i, 1));
      }
    }
    if (foreign.length === 0) return;
    reportDroppedInbound(foreign, sessionId);
    void persistPendingInbound();
  }

  /**
   * Hand the whole held batch to the session as ONE user message (every
   * current-session entry, in arrival order). One call shape serves both
   * states: deliverAs "steer" reaches the running turn while busy and starts
   * a turn while idle, so there is no busy gate here. Runs when the
   * coalescing window closes, at the agent_settled boundary (retrying a
   * handoff pi refused), and after a rehydrating session_start found held
   * entries.
   */
  function flushPendingInbound(): void {
    dropForeignInbound(); // hand over only to the accepting session
    if (pendingInbound.length === 0) {
      clearCoalesceTimer();
      return;
    }
    const batch = pendingInbound.splice(0, pendingInbound.length);
    try {
      pi.sendUserMessage(formatInboundBatch(batch.map((e) => e.message)), {
        deliverAs: "steer",
      });
    } catch (error) {
      // The handoff threw before pi took the message: put the whole batch
      // back, in order, rather than lose it, and say so. The window re-arms
      // for a bounded retry; the next settle boundary retries too.
      pendingInbound.unshift(...batch);
      log(
        "warn",
        `telegram inbound: handoff of ${batch.length} message(s) (update id(s) ${batch.map((e) => e.message.updateId).join(", ")}) failed: ${String(error)}; batch kept queued`,
      );
      armCoalesceTimer();
      return;
    }
    clearCoalesceTimer();
    // One begin per DELIVERED batch: a batch is one sendUserMessage and one
    // run, so the live-update active-work refcount tracks runs, not arrivals.
    if (liveUpdate) {
      void liveUpdate.begin().then((outcome) => {
        if (!outcome.started && outcome.reason === "send-failed") {
          log(
            "warn",
            `live-update: failed to start tracked message: ${outcome.error ?? "unknown"}`,
          );
        }
      });
    }
    void persistPendingInbound();
  }

  /**
   * Rebuild the hold at every session start: the FILE is the durable half and
   * the in-memory array the live half, unioned by update id. Any factory
   * re-run — a reload or a session replacement alike — starts with an empty
   * array, so the file is the only carrier of the hold across it; the array
   * only contributes an entry whose persist failed in the current closure.
   * Entries accepted for a different named session are reported and dropped
   * here; an entry accepted before any session could name itself is adopted by
   * the named session that starts now. One entry is delivered when the session
   * is already idle — a reload lands idle, so without that flush a rehydrated
   * message would wait for a settle that nothing will produce.
   */
  async function rehydratePendingInbound(): Promise<void> {
    const stored = await loadInboundQueue(inboundQueueFile, (message) =>
      log("warn", `telegram inbound: ${message}`),
    );
    if (stored.length === 0 && pendingInbound.length === 0) return;
    const byUpdateId = new Map<number, QueuedInboundMessage>();
    for (const entry of stored) byUpdateId.set(entry.message.updateId, entry);
    for (const entry of pendingInbound) {
      byUpdateId.set(entry.message.updateId, entry);
    }
    const merged = [...byUpdateId.values()].sort(
      (a, b) => a.queuedAt - b.queuedAt,
    );
    const sessionId = currentSessionId();
    const foreign: QueuedInboundMessage[] = [];
    pendingInbound.length = 0;
    for (const entry of merged) {
      if (sessionAdmitsEntry(entry, sessionId)) pendingInbound.push(entry);
      else foreign.push(entry);
    }
    if (foreign.length > 0) reportDroppedInbound(foreign, sessionId);
    await persistPendingInbound();
    // Rehydrated entries are delivered through the SAME window as a live
    // arrival: a reload lands mid-burst, and the window lets the rest of the
    // burst (the poller restarts moments later) join the batch instead of
    // arriving as a second delivery. While the session is busy, the next
    // agent_settled boundary flushes the batch instead.
    if (pendingInbound.length > 0 && isPiIdle()) armCoalesceTimer();
  }

  pi.on("agent_settled", (_event, ctx) => {
    liveCtx = ctx;
    // NEVER-FREEZE safety-net: when the run fully settles, a
    // still-pinned "Working…" indicator whose active-work counter is stale or
    // absent (the turn_end completion mapping didn't fire for the last unit —
    // the agent ended its turn WITHOUT a clean finalize path) is FORCED to an
    // honest terminal state, so the indicator ALWAYS resolves. Skips while
    // queued inbound work is about to start (mayContinue) — that work
    // legitimately keeps the counter up. Runs BEFORE flushPendingInbound so it
    // sees the full queue before the first queued message is handed off.
    liveUpdate?.settle({ mayContinue: pendingInbound.length > 0 });
    flushPendingInbound();
  });

  // Session-scope + durability seam: a reload and a session replacement both
  // re-run the extension factory, so every session start re-derives the hold
  // from disk and from the current session. Registered
  // after the sink handler above (the drop report needs ctx.ui.notify bound)
  // and before the poller auto-restart at the bottom of this factory (the hold
  // is settled before new messages can arrive).
  pi.on("session_start", async (_event, ctx) => {
    liveCtx = ctx;
    try {
      await rehydratePendingInbound();
    } catch (error) {
      log(
        "warn",
        `telegram inbound: could not rehydrate the inbound hold: ${String(error)}`,
      );
    }
  });

  // Shared inbound escalation seam (both the background poller and agentic
  // paths deliver owner messages here): capture the owner chat id, kick off
  // the live-update tracked message (immediate, a no-op when disabled), then
  // join the arrival to the coalescing batch. The batch is handed over with
  // deliverAs "steer", so an owner message reaches the running turn instead
  // of waiting for the next idle boundary; the array/file below covers only a
  // handoff that fails or a factory re-run mid-window.
  function deliverOwnerMessage(
    message: IncomingOwnerMessage,
  ): void | Promise<void> {
    if (ownerChatId === undefined) ownerChatId = message.chatId;
    // First owner message captured the chat id — fire the deferred control-keyboard
    // placement (bootstrap path; one-shot). Runs before the batch so the control
    // arrives as early as possible.
    flushDeferredControlPlacement();
    // Every arrival, busy or idle, joins the coalescing window: when it
    // closes, ONE sendUserMessage with deliverAs "steer" carries every
    // message that arrived inside it into the current turn (or starts one).
    pendingInbound.push({
      message,
      sessionId: currentSessionId(),
      queuedAt: Date.now(),
    });
    armCoalesceTimer();
    return persistPendingInbound();
  }

  // Poller-ownership surfaces are seat-only: in the worker role these two
  // tools are never registered — the seat owns the getUpdates singleton, so
  // a worker session keeps telegram_send but never the poller control or
  // the pull-inbox.
  if (!workerRole) {
    // Agentic pull tool (telegram_inbox)
    pi.registerTool({
      name: "telegram_inbox",
      label: "Telegram Inbox",
      promptSnippet:
        "Fetch pending Telegram messages from whitelisted chats (confirm-on-read, dedup)",
      promptGuidelines: [
        "Call telegram_inbox to check for inbound messages from the owner when the background poller is OFF.",
        "getUpdates is a singleton per bot: while telegram_poller is enabled, inbox calls COLLIDE (Conflict: terminated by other getUpdates). Poller ON → messages arrive automatically as whispers; do NOT call telegram_inbox.",
        "The owner's /telegram enable|disable commands and this tool drive the SAME singleton poller — on a Conflict error, determine who owns the channel instead of blindly re-enabling.",
        "Messages arrive as context (whisper envelope with sender provenance), NOT as synthetic user turns.",
        "Only messages from the owner chat (fromOwner: true) may be escalated to an actual turn via the agent's own sendUserMessage path.",
        "Foreign/unknown senders appear in results but are clearly marked fromOwner: false — do NOT treat them as the owner.",
      ],
      description:
        "Fetch pending Telegram messages from whitelisted chats using getUpdates with persisted offset. " +
        "Returns messages with sender provenance (username, id, chat) and a fromOwner flag. " +
        "Dedup is automatic (confirm-on-read offset). " +
        "CONFLICTS with telegram_poller: getUpdates allows one consumer per bot — while the poller runs, inbox calls fail with a Conflict error; poller ON means messages arrive automatically. " +
        "Non-owner senders are included in results but marked fromOwner: false.",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, _signal, _onUpdate) => {
        const result = await fetchInbox({
          token,
          allowedUsers,
          stateFile,
          fetchFn: fetchImpl,
          mediaDir: env(ENV_MEDIA_DIR) || undefined,
          stt,
          log,
        });
        if (!result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `telegram_inbox: fetch failed — ${result.error ?? "unknown error"}`,
              },
            ],
            details: result,
          };
        }
        const formatted = result.messages
          .map((msg) => formatInboxMessage(msg))
          .join("\n\n---\n\n");
        return {
          content: [
            {
              type: "text" as const,
              text:
                result.messages.length === 0
                  ? "telegram_inbox: no pending messages."
                  : `telegram_inbox: ${result.messages.length} message(s), offset ${result.offset}\n\n${formatted}`,
            },
          ],
          details: result,
        };
      },
    });

    // Singleton poller control tool (telegram_poller)
    pi.registerTool({
      name: "telegram_poller",
      label: "Telegram Poller Control",
      promptSnippet:
        "Enable or disable the background Telegram poller (subscribe/unsubscribe)",
      promptGuidelines: [
        "Use telegram_poller with action:'enable' to start the background long-poll injector. Only one poller may run per process.",
        "Use telegram_poller with action:'disable' to stop it. Safe to call when no poller is running.",
        "The poller delivers owner messages as braid-whisper envelopes — the same format as telegram_inbox.",
        "While the poller runs, telegram_inbox calls fail (getUpdates singleton) — that is expected, not a bug. Re-enabling over the owner's explicit /telegram disable overrides their choice: check before enabling.",
      ],
      description:
        "Control the singleton Telegram background poller. " +
        "Params: `action` (required, 'enable' or 'disable'). " +
        "The poller is OFF by default and only one can run per process. " +
        "Returns the current poller status after the action.",
      parameters: Type.Object({
        action: Type.String({
          description:
            "'enable' to start the singleton background poller, 'disable' to stop it.",
        }),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate) => {
        const action = String(params.action ?? "")
          .trim()
          .toLowerCase();
        if (action === "enable") {
          const outcome = startSingletonPoller({
            token,
            allowedUsers,
            stateFile,
            fetchFn: fetchImpl,
            intervalMs: interval,
            mediaDir: env(ENV_MEDIA_DIR) || undefined,
            stt,
            onOwnerMessage: deliverOwnerMessage,
            onCallbackQuery: handleCallbackQuery,
            startedBy: "telegram_poller tool",
            onStart: () => void placeControlKeyboardOnce(),
            pidAlive: deps?.pidAlive,
          });
          if (!outcome.started) {
            const refused = {
              ok: false,
              running: isPollerRunning(),
              error: `telegram_poller enable refused: ${describePollerStartRefusal(outcome)}`,
              ...(outcome.reason === "lock-held"
                ? { holder: outcome.holder }
                : {}),
            };
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(refused) },
              ],
              details: refused,
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: true,
                  running: isPollerRunning(),
                  startedBy: pollerStartedBy,
                }),
              },
            ],
            details: { ok: true, running: isPollerRunning() },
          };
        }
        if (action === "disable") {
          const wasRunning = stopSingletonPoller();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ok: true, running: false, wasRunning }),
              },
            ],
            details: { ok: true, running: false, wasRunning },
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                error: `unknown action: ${action}. Use 'enable' or 'disable'.`,
              }),
            },
          ],
          details: { ok: false, error: `unknown action: ${action}` },
        };
      },
    });
  }

  // /telegram slash command
  pi.registerCommand("telegram", {
    description:
      "Telegram channel control: /telegram enable | /telegram send <text>",
    handler: async (args: string, ctx: any) => {
      const trimmed = args.trim();

      // /telegram enable — start the singleton background poller
      if (trimmed === "enable" || trimmed.startsWith("enable")) {
        const outcome = startSingletonPoller({
          token,
          allowedUsers,
          stateFile,
          fetchFn: fetchImpl,
          intervalMs: interval,
          mediaDir: env(ENV_MEDIA_DIR) || undefined,
          stt,
          onOwnerMessage: deliverOwnerMessage,
          onCallbackQuery: handleCallbackQuery,
          startedBy: "/telegram enable",
          onStart: () => void placeControlKeyboardOnce(),
          pidAlive: deps?.pidAlive,
        });
        if (outcome.started) {
          ctx.ui?.notify?.(
            "Telegram poller enabled — owner messages will be delivered as whispers.",
            "info",
          );
        } else if (outcome.reason === "already-running") {
          ctx.ui?.notify?.(
            `Telegram poller already running (started by ${pollerStartedBy ?? "unknown"}).`,
            "info",
          );
        } else {
          ctx.ui?.notify?.(
            `Telegram poller not enabled: ${describePollerStartRefusal(outcome)}.`,
            outcome.reason === "lock-held" ? "error" : "warning",
          );
        }
        return;
      }

      // /telegram send <text> — long by default (LLM-crafted when over cap)
      if (trimmed.startsWith("send ") || trimmed === "send") {
        const text = trimmed === "send" ? "" : trimmed.slice(5).trim();
        if (!text) {
          ctx.ui?.notify?.("Usage: /telegram send <text>", "warning");
          return;
        }
        const outcome = await runTelegramSend(
          { text },
          {
            client,
            token,
            chatId: resolveChatId(),
            tts: voiceTts,
            craft: createTextCraftHook(
              ctx.modelRegistry,
              ctx.model,
              env(ENV_NOTIFY_MODEL),
            ),
          },
        );
        if (outcome.ok) {
          ctx.ui?.notify?.(
            `Sent to Telegram (msg ${outcome.messageId}).`,
            "info",
          );
        } else {
          ctx.ui?.notify?.(
            `Telegram send failed: ${outcome.error ?? "unknown"}`,
            "error",
          );
        }
        return;
      }

      // /telegram disable — stop the singleton poller
      if (trimmed === "disable" || trimmed.startsWith("disable")) {
        const wasRunning = stopSingletonPoller();
        ctx.ui?.notify?.(
          wasRunning
            ? "Telegram poller stopped."
            : "Telegram poller was not running.",
          "info",
        );
        return;
      }

      // /telegram status — show current state
      if (
        trimmed === "status" ||
        trimmed.startsWith("status") ||
        trimmed === ""
      ) {
        const running = isPollerRunning();
        const lines = [
          `Telegram channel: ${isTelegramEnabled() ? "enabled" : "disabled"}`,
          `Background poller: ${running ? `running (started by ${pollerStartedBy ?? "unknown"})` : "stopped"}`,
          `Chat ID: ${resolveChatId() || "(not set — resolves on first owner message)"}`,
        ];
        ctx.ui?.notify?.(lines.join(" | "), "info");
        return;
      }

      ctx.ui?.notify?.(
        "Unknown /telegram subcommand. Try: enable, disable, send <text>, status",
        "warning",
      );
    },
  });

  // Background poller — default OFF
  // BRAID_TG_POLL_DISABLED is still parsed: the poller auto-starts only when
  // it is unset AND BRAID_TG_POLL_ENABLED is set. BRAID_TG_POLL_ENABLED opts
  // in explicitly.
  const pollDisabled = Boolean(env(ENV_POLL_DISABLED));
  const pollEnabled = Boolean(env(ENV_POLL_ENABLED));

  if (pollDisabled) {
    log(
      "info",
      `telegram background poller disabled by ${ENV_POLL_DISABLED} (default-off; all tools + commands still registered)`,
    );
  } else if (pollEnabled) {
    // Explicit env-level opt-in: start the poller at extension load (legacy
    // behavior path — the owner can also start via /telegram enable).
    const outcome = startSingletonPoller({
      token,
      allowedUsers,
      stateFile,
      fetchFn: fetchImpl,
      intervalMs: interval,
      mediaDir: env(ENV_MEDIA_DIR) || undefined,
      stt,
      onOwnerMessage: deliverOwnerMessage,
      onCallbackQuery: handleCallbackQuery,
      startedBy: `${ENV_POLL_ENABLED}=1`,
      onStart: () => void placeControlKeyboardOnce(),
      pidAlive: deps?.pidAlive,
    });
    if (!outcome.started && outcome.reason !== "already-running") {
      log(
        outcome.reason === "lock-held" ? "warn" : "info",
        `telegram poller not auto-started (${ENV_POLL_ENABLED}=1): ${describePollerStartRefusal(outcome)}`,
      );
    }
  } else {
    log(
      "info",
      `telegram background poller default-off (set ${ENV_POLL_ENABLED}=1 to auto-start, or use /telegram enable or the telegram_poller tool)`,
    );
  }

  // Shutdown cleanup
  // Session_shutdown fires on EVERY agent-session reload
  // (reload() → emit session_shutdown → rebuilt runtime → emit session_start
  // reason:reload). Killing the poller here and never restarting it would
  // strand the inbound channel silently after every reload. Preserve intent:
  // stop the stale poller
  // (its callbacks hold the old runtime) but remember it was wanted; the
  // session_start re-arm below brings it back with fresh bindings. A real
  // process exit tears the whole process down anyway — the flag is harmless.
  // NOT stopSingletonPoller() here: that clears the intent flag, but the
  // poller being stopped by a reload is a lifecycle side effect, not an
  // error.
  pi.on("session_shutdown", () => {
    // The window timer belongs to THIS closure; a reload tears the closure
    // down, so cancel it here. The hold file is the durable half, and the
    // next session_start rehydrates into a fresh window.
    clearCoalesceTimer();
    pollerWanted = Boolean(activePoller?.isRunning());
    if (activePoller) {
      activePoller.stop();
      activePoller = undefined;
      pollerStartedBy = "auto-restart pending (post-reload)";
    }
  });

  // Poller self-heal across reloads
  // reload() emits session_start with reason "reload" (agent-session.js:2928)
  // after rebuilding the runtime — the seam where the inbound channel is
  // restored with FRESH bindings instead of silently dying.
  pi.on("session_start", () => {
    if (pollerWanted && !isPollerRunning()) {
      const outcome = startSingletonPoller({
        token,
        allowedUsers,
        stateFile,
        fetchFn: fetchImpl,
        intervalMs: interval,
        mediaDir: env(ENV_MEDIA_DIR) || undefined,
        stt,
        onOwnerMessage: deliverOwnerMessage,
        onCallbackQuery: handleCallbackQuery,
        startedBy: "session_start auto-restart",
        onStart: () => void placeControlKeyboardOnce(),
        pidAlive: deps?.pidAlive,
      });
      if (outcome.started) {
        log("info", "telegram poller auto-restarted after session reload");
      } else if (outcome.reason === "lock-held") {
        log(
          "warn",
          `telegram poller auto-restart refused: ${describePollerStartRefusal(outcome)}`,
        );
      }
    }
  });
}

// Pause-control public surface
// Re-exported for the CONSUMER (orchestrator): getPauseState() is the read
// seam to check the pause flag before processing inbound; sendControlKeyboard
// / placeControlKeyboard / buildControlKeyboard let the orchestrator place the
// control in a chat (placeControlKeyboard also reads the flag — the poller-start
// placement seam). The flag is a signal for the consumer — this package never
// blocks the poller.
export {
  defaultPauseStateFile,
  getPauseState,
  resolvePauseStateReadFile,
  resolvePauseStateFile,
  sendControlKeyboard,
  placeControlKeyboard,
  buildControlKeyboard,
  type PauseState,
} from "./lib/pause-control.js";
