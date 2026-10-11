/**
 * LIVE-UPDATE tracked message.
 *
 * The live-update trick: instead of re-sending a new Telegram message for every
 * progress update (which spams the owner's chat), the tracker sends ONE pinned
 * message immediately when the owner's message arrives ("⚙️ Working… received
 * your message"), then EDITS that same message in place as work progresses, and
 * finally edits it to a "✅ Done" state and sends a SEPARATE beautiful
 * markdown summary via the (key-ring-backed) crafting model.
 *
 * Telegram's edit affordance keeps the edited message pinned at its original
 * position — no new-message spam, no reordering. `message_id` + `chat_id` are
 * persisted to a small JSON state file (`.braid/telegram-live-update.json`,
 * mirroring telegram-state.json) so a process reload can resume editing the
 * same message instead of starting over.
 *
 * Design decisions (see docs/live-update.md for the full list):
 *  - default ON via BRAID_TG_LIVE_UPDATE_ENABLED (explicit "0" disables);
 *  - sliding-window rate limit (default 4/min) applies to start/update edits —
 *    finish() is terminal and always attempts its done-edit + final summary;
 *  - start() is idempotent: an existing tracked message (incl. A persisted one
 *    from a prior run) is reused, never a duplicate;
 *  - the tracker is pure-of-network: client calls and clock are injected so
 *    fixture tests run with zero real API calls.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { SlidingWindowLimiter } from "./rate-limit.js";
import { defaultLiveUpdateFilePath } from "../state-paths.js";
import {
  clearAgentDeliveredMessage,
  wasAgentDeliveredMessage,
} from "./agent-delivery.js";
import {
  sendMessageChunks,
  resolveDeliveryFormat,
  TELEGRAM_MAX_TEXT_LENGTH,
  type SendChunksResult,
} from "../format.js";
import type { TelegramClient } from "../telegram-client.js";

// Types

/** Persisted shape: the tracked message that survives restarts. */
export interface LiveUpdateState {
  messageId: number;
  chatId: number | string;
  startedAt: number;
}

export interface LiveUpdateCraftRich {
  (text: string): Promise<{ text: string; crafted: boolean } | null>;
}

export interface LiveUpdateDeps {
  client: Pick<TelegramClient, "sendMessage" | "editMessageText">;
  token: string;
  /**
   * Target chat id, or a resolver (index.ts passes `resolveChatId` so the
   * chat is captured from the first inbound owner message, not at load time).
   */
  chatId: number | string | (() => number | string);
  /** Path to the live-update JSON state file (test-fixture-friendly). */
  stateFile: string;
  /** Clock (injectable for deterministic rate-limit tests). */
  now?(): number;
  /** Max progress edits per window (default 4/min, BRAID_TG_LIVE_UPDATE_MAX_PER_MIN). */
  maxPerWindow?: number;
  windowMs?: number;
  /** Edit/send body cap (Telegram's 4096). */
  maxTextLength?: number;
  log?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    ...rest: unknown[]
  ) => void;
}

export interface LiveUpdateStartOutcome {
  started: boolean;
  /** true when an existing tracked message was reused (no new send). */
  reused: boolean;
  messageId?: number;
  reason?: "rate-limited" | "send-failed" | "no-chat";
  error?: string;
}

export interface LiveUpdateUpdateOutcome {
  updated: boolean;
  reason?: "rate-limited" | "no-tracked-message";
  error?: string;
}

export interface LiveUpdateFinishOutcome {
  completed: boolean;
  doneEdited: boolean;
  /** The separate final summary was delivered. */
  summarySent: boolean;
  /** Number of summary messages sent (split-to-fit; 0 when none). */
  summaryChunks?: number;
  error?: string;
}

export interface LiveUpdateTerminateOutcome {
  terminated: boolean;
  /** The tracked message was edited to the terminal "no report" state. */
  terminalEdited: boolean;
  error?: string;
}

// Defaults

export const DEFAULT_LIVE_UPDATE_MAX_PER_MIN = 4;
export const DEFAULT_LIVE_UPDATE_WINDOW_MS = 60_000;

/** Status line shown in the tracked message immediately on inbound. */
export const TRACKED_START_TEXT = "⚙️ Working… received your message";

/** Status line the tracked message is edited to when the turn completes. */
export const TRACKED_DONE_TEXT = "✅ Done — full report below.";

/** Done-edit variant when the agent ALREADY delivered its own report via
 *  telegram_send during the turn — finish() suppresses its separate summary
 *  (no duplicate message), so the honest pointer is "above", not "below". */
export const TRACKED_DONE_TEXT_REPORT_SENT = "✅ Done — report above.";

/** Status line the tracked message is edited to when a turn ends WITHOUT a
 *  report (abort/error). Honest, distinct from TRACKED_DONE_TEXT. */
export const TRACKED_TERMINAL_TEXT = "⏹️ Turn ended without a report";

/** Live-update state file path (mirrors inbound-poller state-file conventions). */
export function defaultLiveUpdateStateFile(): string {
  return defaultLiveUpdateFilePath();
}

// State persistence (mirrors inbound-poller loadState/saveState)

export async function loadLiveState(
  stateFile: string,
): Promise<LiveUpdateState | undefined> {
  try {
    const raw = await readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<LiveUpdateState>;
    const messageId = Number(parsed?.messageId);
    if (!Number.isInteger(messageId) || messageId <= 0) return undefined;
    const chatId = parsed?.chatId;
    if (chatId == null) return undefined;
    const startedAt = Number(parsed?.startedAt) || 0;
    return { messageId, chatId, startedAt };
  } catch {
    return undefined;
  }
}

export async function saveLiveState(
  stateFile: string,
  state: LiveUpdateState,
): Promise<void> {
  const dir = dirname(stateFile);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // parent may already exist; write will surface real errors
  }
  await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Remove the state file (called after finish — the tracked message is done). */
export async function clearLiveState(stateFile: string): Promise<void> {
  try {
    await writeFile(
      stateFile,
      JSON.stringify({ messageId: 0, chatId: 0, startedAt: 0 }, null, 2) + "\n",
      "utf8",
    );
  } catch {
    // best-effort; stale state is harmless (loadLiveState ignores messageId 0)
  }
}

function clipText(text: string, maxLen: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1).trimEnd() + "…";
}

// Tracker

export interface LiveUpdateTracker {
  /** Send the immediate "Working…" tracked message (or reuse an existing one). */
  start(): Promise<LiveUpdateStartOutcome>;
  /** Edit the tracked message in place (idempotent + rate-limited). */
  update(text: string): Promise<LiveUpdateUpdateOutcome>;
  /**
   * Edit the tracked message to "✅ Done", then deliver a SEPARATE final
   * markdown summary (crafted via `craftRich` when supplied/fit, else the raw
   * `resultText` split-to-fit). Terminal — always attempts its edits.
   */
  finish(opts: {
    resultText: string;
    craftRich?: LiveUpdateCraftRich;
    /** Skip the separate final summary (the agent already delivered its own
     *  report via telegram_send this turn — no duplicate message). The
     *  tracked message is still edited to its done state. */
    suppressSummary?: boolean;
  }): Promise<LiveUpdateFinishOutcome>;
  /**
   * Terminate the tracked message on a terminal non-completed turn (abort /
   * error — there is no report to summarize): edit it to "⏹️ Turn ended
   * without a report" (best-effort) and ALWAYS clear the tracked state + state
   * file so a reload never resurrects a stale "Working…" message. Terminal —
   * non-throwing, mirrors finish()'s always-attempts semantics.
   */
  terminate(): Promise<LiveUpdateTerminateOutcome>;
  /** True while a tracked message is active (in-memory or persisted). */
  isActive(): Promise<boolean>;
  /** Current tracked state (undefined when none). */
  getState(): Promise<LiveUpdateState | undefined>;
  /**
   * ACTIVE-WORK REFCOUNT: the "⚙️ Working…" indicator is gated
   * on real in-flight work, not on a fragile turn_end mapping. Begin()
   * increments — 0→1 pins (or reuses) the tracked message; end() decrements —
   * 1→0 resolves it to the honest terminal state. The indicator completion
   * NEVER depends on the agent calling a finalize tool alone: settle() at an
   * idle/settled boundary force-resolves any still-pinned indicator.
   */
  /** +1 active work unit; on 0→1 pins (or reuses) the tracked Working… message. */
  begin(): Promise<LiveUpdateStartOutcome>;
  /**
   * -1 active work unit; on 1→0 resolves the indicator to the honest terminal
   * state — "done" → ✅ Done + final summary; "no-report" → ⏹.
   */
  end(
    kind: LiveUpdateEndKind,
    opts?: { resultText?: string; craftRich?: LiveUpdateCraftRich },
  ): Promise<LiveUpdateEndOutcome>;
  /** Current active-work counter (synchronous). */
  activeCount(): number;
  /**
   * Never-freeze safety-net. Call at an agent_settled / idle boundary: if the
   * indicator is still pinned while active work is stale/absent (and not
   * marked mayContinue), force the honest terminal state so it ALWAYS resolves
   * — even when the agent ended its turn without calling a finalize path.
   */
  settle(opts?: { mayContinue?: boolean }): Promise<LiveUpdateSettleOutcome>;
}

/** The two honest terminal outcomes a work unit can resolve the indicator to. */
export type LiveUpdateEndKind = "done" | "no-report";

export interface LiveUpdateEndOutcome {
  /** true when this end() resolved the indicator (active counter reached 0). */
  ended: boolean;
  /** Active-work counter after this call. */
  active: number;
  /** Set when ended && the unit was "done": tracked message edited to ✅ Done. */
  doneEdited?: boolean;
  /** Set when ended && the unit was "done": the separate final summary went out. */
  summarySent?: boolean;
  /** Set when ended && the unit was "no-report": the terminal ⏹ edit was made. */
  terminalEdited?: boolean;
  error?: string;
}

export interface LiveUpdateSettleOutcome {
  /** true when the safety-net forced an honest completion (never a freeze). */
  resolved: boolean;
  /** true when the indicator was already resolved (nothing left to force). */
  alreadyResolved: boolean;
  /** Active-work counter (0 after a forced resolve). */
  active: number;
  reason?:
    | "already-resolved"
    | "no-active-work"
    | "might-continue"
    | "resolved";
  doneEdited?: boolean;
  terminalEdited?: boolean;
  error?: string;
}

export function createLiveUpdateTracker(
  deps: LiveUpdateDeps,
): LiveUpdateTracker {
  const limiter = new SlidingWindowLimiter({
    maxPerWindow: deps.maxPerWindow ?? DEFAULT_LIVE_UPDATE_MAX_PER_MIN,
    windowMs: deps.windowMs ?? DEFAULT_LIVE_UPDATE_WINDOW_MS,
  });
  const maxTextLen = deps.maxTextLength ?? TELEGRAM_MAX_TEXT_LENGTH;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const chatIdOf = (): number | string =>
    typeof deps.chatId === "function"
      ? (deps.chatId as () => number | string)()
      : (deps.chatId as number | string);

  // Loaded lazily once per tracker from the state file; mutated in memory and
  // persisted on every change (start sets it, finish clears it).
  let tracked: LiveUpdateState | undefined;
  let loaded = false;

  // Active-work refcount: begin()/end() gate the indicator on
  // real in-flight work; settle() is the never-freeze safety-net. `cycle` is
  // per-pinning-cycle: "none" (no owner work begun), "active" (pinned, units
  // in flight), "resolved" (this cycle already completed honestly).
  // `pendingKind` is the outcome of the most recent end()'d unit — it decides
  // the honest terminal state when the counter reaches 0 (or settle forces);
  // `lastResultText`/`lastCraftRich` carry the latest completed answer into
  // settle()'s forced-completion fallback.
  let active = 0;
  let cycle: "none" | "active" | "resolved" = "none";
  let pendingKind: LiveUpdateEndKind = "done";
  let lastResultText = "";
  let lastCraftRich: LiveUpdateCraftRich | undefined;

  async function ensureLoaded(): Promise<LiveUpdateState | undefined> {
    if (!loaded) {
      loaded = true;
      tracked = await loadLiveState(deps.stateFile);
      if (tracked)
        log(
          "info",
          `live-update: resumed tracked message ${tracked.messageId} in chat ${tracked.chatId}`,
        );
    }
    return tracked;
  }

  function setTracked(messageId: number, startedAt: number): void {
    tracked = { messageId, chatId: chatIdOf(), startedAt };
  }

  async function clearTracked(): Promise<void> {
    tracked = undefined;
    await clearLiveState(deps.stateFile);
  }

  /** Deliver the final summary — crafted markdown when fit, else raw text. */
  async function deliverSummary(
    resultText: string,
    craftRich?: LiveUpdateCraftRich,
  ): Promise<SendChunksResult> {
    const trimmed = resultText.trim();
    if (!trimmed) return { ok: true, sent: 0, total: 0, messageIds: [] };
    const summaryChatId = stateChatId() ?? chatIdOf();
    if (craftRich) {
      try {
        const crafted = await craftRich(trimmed);
        if (crafted?.crafted && crafted.text?.trim()) {
          const body = crafted.text.trim();
          // Resolve the delivery format from the crafted BODY itself:
          // raw HTML tags → HTML mode (Markdown markers neutralized so nothing
          // leaks); balanced Markdown → Markdown; anything else (or unbalanced
          // delimiters) → plain text rather than a Telegram API error. The
          // craft prompt already asks the model to emit the right markup; this
          // guard catches the model drifting to the other format anyway. The
          // detectMarkdown flag opts the no-request body into active Markdown
          // detection.
          const fmt = resolveDeliveryFormat(undefined, body, true);
          if (!fmt.parseMode) {
            log(
              "warn",
              "live-update: crafted summary has no clean format (unbalanced markdown) — delivering plain text",
            );
          }
          return sendMessageChunks(deps.client, {
            token: deps.token,
            chatId: summaryChatId,
            text: fmt.text,
            parseMode: fmt.parseMode,
          });
        }
        log(
          "warn",
          "live-update: rich summary crafting produced no usable text — sending raw result",
        );
      } catch (err) {
        log(
          "warn",
          `live-update: rich summary crafting threw (${err instanceof Error ? err.message : String(err)}) — sending raw result`,
        );
      }
    }
    return sendMessageChunks(deps.client, {
      token: deps.token,
      chatId: summaryChatId,
      text: trimmed,
    });
  }

  /** chat id of the tracked message (persisted state), else undefined. */
  function stateChatId(): number | string | undefined {
    return tracked?.chatId;
  }

  /** Resolve the indicator to the honest terminal state for `kind`, zeroing
   *  the active-work counter. Shared by end() (1→0) and settle() (forced). */
  async function resolveIndicator(kind: LiveUpdateEndKind): Promise<{
    doneEdited: boolean;
    summarySent: boolean;
    terminalEdited: boolean;
    error?: string;
  }> {
    if (kind === "no-report") {
      const out = await tracker.terminate();
      return {
        doneEdited: false,
        summarySent: false,
        terminalEdited: out.terminalEdited,
        error: out.error,
      };
    }
    // Suppress the auto summary when the agent already delivered an explicit
    // report this turn (telegram_send marked the flag). Read-then-clear here —
    // this is the single boundary both end() and settle() resolve through.
    const suppressSummary = wasAgentDeliveredMessage();
    clearAgentDeliveredMessage();
    const out = await tracker.finish({
      resultText: lastResultText,
      craftRich: lastCraftRich,
      suppressSummary,
    });
    return {
      doneEdited: out.doneEdited,
      summarySent: out.summarySent,
      terminalEdited: false,
      error: out.error,
    };
  }

  const tracker: LiveUpdateTracker = {
    async start(): Promise<LiveUpdateStartOutcome> {
      // Fresh work unit → the agent-delivered flag from a prior turn must not
      // leak into it (defensive: the resolver already clears on read).
      clearAgentDeliveredMessage();
      const existing = await ensureLoaded();
      if (existing?.messageId) {
        // Reuse the persisted/active tracked message (no new-message spam).
        await deps.client.editMessageText(
          deps.token,
          existing.chatId,
          existing.messageId,
          clipText(TRACKED_START_TEXT, maxTextLen),
        );
        return { started: true, reused: true, messageId: existing.messageId };
      }
      const chatId = chatIdOf();
      if (!chatId) return { started: false, reused: false, reason: "no-chat" };
      if (!limiter.try(now()))
        return { started: false, reused: false, reason: "rate-limited" };
      const res = await deps.client.sendMessage(
        deps.token,
        chatId,
        TRACKED_START_TEXT,
      );
      if (!res.ok)
        return {
          started: false,
          reused: false,
          reason: "send-failed",
          error: res.error,
        };
      const messageId = res.messageId ?? 0;
      if (messageId > 0) {
        // Only a real message_id is editable — track + persist it. Without one
        // (shouldn't happen for sendMessage, but defensively) the Working…
        // message still went out; finish() falls back to summary-only.
        setTracked(messageId, now());
        try {
          await saveLiveState(deps.stateFile, tracked!);
        } catch (error) {
          log(
            "warn",
            `live-update: failed to persist tracked message: ${String(error)}`,
          );
        }
        log(
          "info",
          `live-update: tracked message ${messageId} started in chat ${chatId}`,
        );
      }
      return {
        started: true,
        reused: false,
        ...(messageId > 0 ? { messageId } : {}),
      };
    },

    async update(text): Promise<LiveUpdateUpdateOutcome> {
      const state = await ensureLoaded();
      if (!state?.messageId)
        return { updated: false, reason: "no-tracked-message" };
      if (!limiter.try(now()))
        return { updated: false, reason: "rate-limited" };
      const res = await deps.client.editMessageText(
        deps.token,
        state.chatId,
        state.messageId,
        clipText(text, maxTextLen),
      );
      return res.ok ? { updated: true } : { updated: false, error: res.error };
    },

    async finish({
      resultText,
      craftRich,
      suppressSummary = false,
    }): Promise<LiveUpdateFinishOutcome> {
      const state = await ensureLoaded();
      let doneEdited = false;
      if (state?.messageId) {
        // Terminal edit first: pin the visited message to its done state.
        const done = await deps.client.editMessageText(
          deps.token,
          state.chatId,
          state.messageId,
          suppressSummary ? TRACKED_DONE_TEXT_REPORT_SENT : TRACKED_DONE_TEXT,
        );
        doneEdited = done.ok;
        if (!done.ok)
          log(
            "warn",
            `live-update: done-edit failed (${done.error ?? "unknown"})`,
          );
      }

      // Then the SEPARATE final summary — SKIPPED when the agent already
      // delivered its own report this turn (the tracked done-edit still pins
      // the conversation; the report above IS the deliverable).
      const summary = suppressSummary
        ? null
        : await deliverSummary(resultText, craftRich);

      // The tracked message served its purpose — clear it (state file too).
      await clearTracked();

      // Honest outcome: a suppressed summary is neither sent nor failed — the
      // suppression itself is the intended terminal state.
      const completed = doneEdited || (summary ? summarySentOk(summary) : true);
      return {
        completed,
        doneEdited,
        summarySent: summary?.ok ?? false,
        summaryChunks: summary?.total ?? 0,
        ...(completed
          ? {}
          : { error: "done-edit and summary send both failed" }),
      };
    },

    async terminate(): Promise<LiveUpdateTerminateOutcome> {
      const state = await ensureLoaded();
      let terminalEdited = false;
      if (state?.messageId) {
        // Terminal edit first: pin the tracked message to "⏹️ Turn ended
        // without a report" (never "✅ Done" — the turn did not complete).
        const done = await deps.client.editMessageText(
          deps.token,
          state.chatId,
          state.messageId,
          TRACKED_TERMINAL_TEXT,
        );
        terminalEdited = done.ok;
        if (!done.ok)
          log(
            "warn",
            `live-update: terminal-edit failed (${done.error ?? "unknown"})`,
          );
      }
      // ALWAYS clear the persisted state — a reload must never resurrect a
      // stale "Working…" message, even when the edit failed or nothing was
      // tracked. Non-throwing (state mutations cannot reject the caller).
      await clearTracked();
      return { terminated: true, terminalEdited };
    },

    async isActive(): Promise<boolean> {
      const state = await ensureLoaded();
      return Boolean(state?.messageId);
    },

    async getState(): Promise<LiveUpdateState | undefined> {
      const state = await ensureLoaded();
      return state ? { ...state } : undefined;
    },

    async begin(): Promise<LiveUpdateStartOutcome> {
      const wasIdle = active === 0;
      active += 1;
      if (wasIdle) {
        // 0→1: (re)pin the Working… indicator and start a fresh cycle.
        cycle = "active";
        pendingKind = "done";
        lastResultText = "";
        lastCraftRich = undefined;
        return tracker.start();
      }
      // Already active — the indicator is pinned for every in-flight unit;
      // just track the extra unit (no duplicate send). Reuse the existing
      // tracked message; if the first pin attempt produced no editable message
      // (send failed), retry the send so a Working… message does go out.
      const existing = await ensureLoaded();
      if (existing?.messageId) {
        return { started: true, reused: true, messageId: existing.messageId };
      }
      return tracker.start();
    },

    async end(
      kind: LiveUpdateEndKind,
      opts?: { resultText?: string; craftRich?: LiveUpdateCraftRich },
    ): Promise<LiveUpdateEndOutcome> {
      if (kind === "done") {
        if (opts?.resultText) lastResultText = opts.resultText;
        if (opts?.craftRich) lastCraftRich = opts.craftRich;
      }
      pendingKind = kind;
      active = Math.max(0, active - 1);
      if (active > 0 || cycle !== "active") return { ended: false, active };
      // 1→0 on an active cycle: resolve to the honest terminal state.
      cycle = "resolved";
      const r = await resolveIndicator(pendingKind);
      return {
        ended: true,
        active,
        doneEdited: r.doneEdited,
        summarySent: r.summarySent,
        terminalEdited: r.terminalEdited,
        error: r.error,
      };
    },

    activeCount(): number {
      return active;
    },

    async settle(opts?: {
      mayContinue?: boolean;
    }): Promise<LiveUpdateSettleOutcome> {
      if (cycle === "resolved") {
        return {
          resolved: false,
          alreadyResolved: true,
          active,
          reason: "already-resolved",
        };
      }
      if (opts?.mayContinue) {
        return {
          resolved: false,
          alreadyResolved: false,
          active,
          reason: "might-continue",
        };
      }
      const state = await ensureLoaded();
      const hasTracked = Boolean(state?.messageId);
      if (cycle !== "active" && !hasTracked && active === 0) {
        return {
          resolved: false,
          alreadyResolved: false,
          active,
          reason: "no-active-work",
        };
      }
      // Safety-net: the run is idle — force the honest completion so the
      // indicator NEVER freezes at "Working…". An in-flight
      // THIS-SESSION cycle settles with its last unit's outcome (✅ Done by
      // default — the run finished); a resurrected stale pinned message (no
      // active work this session) is a turn that ended without a report → ⏹.
      const wasActive = cycle === "active";
      cycle = "resolved";
      active = 0;
      const r = await resolveIndicator(wasActive ? pendingKind : "no-report");
      return {
        resolved: true,
        alreadyResolved: false,
        active,
        reason: "resolved",
        doneEdited: r.doneEdited,
        terminalEdited: r.terminalEdited,
        error: r.error,
      };
    },
  };

  return tracker;
}

function summarySentOk(summary: SendChunksResult): boolean {
  return summary.ok && summary.sent > 0;
}
