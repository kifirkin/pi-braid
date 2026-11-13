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
 *  - the tracked message is keyed by CHAT, not by session or process. Every
 *    holder of the same chat shares ONE message and one persisted record, and
 *    the record's refcount decides when the message resolves: two seats on one
 *    chat produce one ack, and the seat that finishes first does not delete a
 *    message the other is still working behind. See `LiveUpdateState.holders`;
 *  - the tracker is pure-of-network: client calls and clock are injected so
 *    fixture tests run with zero real API calls.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SlidingWindowLimiter } from "./rate-limit.js";
import { defaultLiveUpdateFilePath } from "../state-paths.js";
import {
  clearAgentDeliveredMessage,
  wasAgentDeliveredMessage,
} from "./agent-delivery.js";
import {
  sendMessageChunks,
  TELEGRAM_MAX_TEXT_LENGTH,
  type SendChunksResult,
} from "../format.js";
import {
  planOutbound,
  noteOwnerMessage,
  noteRefusal,
  noteTrackedAck,
} from "./outbound.js";
import type { TelegramClient } from "../telegram-client.js";

// Types

/** One holder of a chat's tracked message (a process; a reload keeps its id). */
export interface LiveUpdateHolder {
  /** Work units this holder has in flight (its own active counter). */
  count: number;
  /** Last time the holder touched the record — the staleness reap reads this. */
  seenAt: number;
}

/** Persisted shape: the tracked message that survives restarts. */
export interface LiveUpdateState {
  messageId: number;
  chatId: number | string;
  startedAt: number;
  /** The body last pinned in the message (so a repeated begin() is a no-op). */
  text?: string;
  /**
   * Holders sharing this chat's tracked message, keyed by holder id. The
   * message resolves when the LAST holder drops to zero; a holder that stops
   * touching the record for `LIVE_UPDATE_HOLDER_STALE_MS` is reaped (a crashed
   * process must not pin the owner's chat forever). Absent on a pre-holders
   * record, which reads as "one anonymous holder" until the next write.
   */
  holders?: Record<string, LiveUpdateHolder>;
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
  /**
   * Holder identity for the shared record. Defaults to a process-wide id, so
   * a reload (a new tracker in the same process) inherits the count it was
   * holding instead of leaking it as a stale holder; fixtures pass distinct
   * ids to model two seats in one process.
   */
  holderId?: string;
  /** Age past which a holder stops counting (default 10 min). */
  holderStaleMs?: number;
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
  reason?: "rate-limited" | "send-failed" | "no-chat" | "claimed" | "refused";
  error?: string;
}

export interface LiveUpdateUpdateOutcome {
  updated: boolean;
  reason?: "rate-limited" | "no-tracked-message" | "refused";
  error?: string;
}

export interface LiveUpdateFinishOutcome {
  completed: boolean;
  doneEdited: boolean;
  /** The separate final summary was delivered. */
  summarySent: boolean;
  /** Number of summary messages sent (split-to-fit; 0 when none). */
  summaryChunks?: number;
  /** Another holder still has work in flight: the chat's message stays pinned
   *  and this holder's completion is recorded in the shared refcount only. */
  deferred?: boolean;
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

/**
 * Age past which a holder stops counting toward the shared record. A process
 * that dies mid-turn leaves its count behind; without a bound the message
 * would stay "Working…" in the owner's chat forever. Ten minutes covers a
 * slow turn between two touches of the record (begin, edits, end).
 */
export const LIVE_UPDATE_HOLDER_STALE_MS = 10 * 60_000;

/** A send claim older than this belonged to a process that died mid-send. */
export const LIVE_UPDATE_CLAIM_STALE_MS = 30_000;

/** How long a second holder waits for the first holder's message id. */
export const LIVE_UPDATE_CLAIM_WAIT_MS = 300;
const CLAIM_POLL_MS = 50;

/** Status line shown in the tracked message immediately on inbound. */
export const TRACKED_START_TEXT = "⚙️ Working… received your message";

/**
 * The tracked line when more than one holder shares the chat. One message, a
 * visible count of the work behind it — never a second message per seat.
 */
export function trackedStartText(activeCount: number): string {
  if (!Number.isFinite(activeCount) || activeCount <= 1)
    return TRACKED_START_TEXT;
  return `${TRACKED_START_TEXT} · ${Math.floor(activeCount)} tasks`;
}

/** Status line the tracked message is edited to when the turn completes. */
export const TRACKED_DONE_TEXT = "✅ Done — full report below.";

/** Done-edit variant when the agent ALREADY delivered its own report via
 *  telegram_send during the turn — finish() suppresses its separate summary
 *  (no duplicate message), so the honest pointer is "above", not "below". */
export const TRACKED_DONE_TEXT_REPORT_SENT = "✅ Done — report above.";

/** Status line the tracked message is edited to when a turn ends WITHOUT a
 *  report (abort/error). Honest, distinct from TRACKED_DONE_TEXT. */
export const TRACKED_TERMINAL_TEXT = "⏹️ Turn ended without a report";

/** Live-update state file path (mirrors inbound-poller state-file conventions).
 *  Null when no absolute braid root resolves; the caller refuses the tracker. */
export function defaultLiveUpdateStateFile(): string | null {
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
    const holders = readHolders(parsed?.holders);
    const text = typeof parsed?.text === "string" ? parsed.text : undefined;
    return {
      messageId,
      chatId,
      startedAt,
      ...(text ? { text } : {}),
      ...(holders ? { holders } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Coerce a persisted `holders` map. A malformed row is dropped rather than
 * trusted: a bad count would either pin the message forever or resolve it
 * under a live holder, and both are silent.
 */
function readHolders(
  raw: unknown,
): Record<string, LiveUpdateHolder> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, LiveUpdateHolder> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const row = value as { count?: unknown; seenAt?: unknown };
    const count = Number(row.count);
    const seenAt = Number(row.seenAt);
    if (!Number.isFinite(count) || count <= 0) continue;
    if (!Number.isFinite(seenAt) || seenAt <= 0) continue;
    out[id] = { count: Math.floor(count), seenAt: Math.floor(seenAt) };
  }
  return out;
}

/** Two chat ids address the same chat (ids arrive as number or string). */
export function sameChat(
  a: number | string | undefined,
  b: number | string | undefined,
): boolean {
  if (a === undefined || b === undefined) return false;
  return String(a) === String(b);
}

/** Process-wide holder id: a reload keeps it, a second process does not. */
const HOLDER_ID_KEY = "__braid_tg_live_holder";

export function processHolderId(): string {
  const slot = globalThis as Record<string, unknown>;
  const existing = slot[HOLDER_ID_KEY];
  if (typeof existing === "string" && existing) return existing;
  const id = randomUUID();
  slot[HOLDER_ID_KEY] = id;
  return id;
}

/** Drop holders that stopped touching the record; returns the kept map. */
export function pruneHolders(
  holders: Record<string, LiveUpdateHolder> | undefined,
  nowMs: number,
  staleMs: number = LIVE_UPDATE_HOLDER_STALE_MS,
): { kept: Record<string, LiveUpdateHolder>; dropped: string[] } {
  const kept: Record<string, LiveUpdateHolder> = {};
  const dropped: string[] = [];
  if (!holders) return { kept, dropped };
  for (const [id, row] of Object.entries(holders)) {
    if (nowMs - row.seenAt > staleMs) dropped.push(id);
    else kept[id] = row;
  }
  return { kept, dropped };
}

/** Total in-flight work units behind a chat's tracked message. */
export function totalHeld(
  holders: Record<string, LiveUpdateHolder> | undefined,
): number {
  if (!holders) return 0;
  return Object.values(holders).reduce((sum, row) => sum + row.count, 0);
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
  await writeLiveStateAtomic(stateFile, state);
}

/**
 * Persist one state document ATOMICALLY (write-temp-rename, same rationale as
 * saveInboundQueue and savePauseState). A plain `writeFile` opens with O_TRUNC
 * and writes afterwards, so a reader parsing the file inside that window — or
 * a second saver completing its own truncate-then-write in between — observes
 * a state that was never written: an empty file, or one document followed by
 * the tail of a longer one. The cost is a parse error in the RESUMER (a
 * persisted tracked message is then abandoned as "no tracked message") and in
 * every concurrent reader of the file. The temp name is unique per write: a
 * shared temp made concurrent savers fail each other's rename (ENOENT), while
 * unique temps all land and the last rename wins with a whole snapshot.
 */
async function writeLiveStateAtomic(
  stateFile: string,
  state: LiveUpdateState,
): Promise<void> {
  const tmp = `${stateFile}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, stateFile);
}

/** Remove the state file (called after finish — the tracked message is done). */
export async function clearLiveState(stateFile: string): Promise<void> {
  try {
    await writeLiveStateAtomic(stateFile, {
      messageId: 0,
      chatId: 0,
      startedAt: 0,
    });
  } catch {
    // best-effort; stale state is harmless (loadLiveState ignores messageId 0)
  }
}

function clipText(text: string, maxLen: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1).trimEnd() + "…";
}

// Send claim (the cross-process half of "one message per chat")

/**
 * Claim path beside the state file. `start()` writes it with the exclusive
 * flag before it sends, so two processes that begin in the same instant cannot
 * both send: the loser waits (bounded) for the winner's message id and reuses
 * it. The file is removed after the record is written; a claim left behind by
 * a process that died mid-send is displaced once it is older than
 * `LIVE_UPDATE_CLAIM_STALE_MS`.
 */
export function liveClaimPath(stateFile: string): string {
  return `${stateFile}.claim`;
}

interface SendClaim {
  holderId: string;
  at: number;
}

function readClaim(path: string): SendClaim | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SendClaim>;
    if (typeof parsed?.holderId !== "string" || !parsed.holderId)
      return undefined;
    const at = Number(parsed?.at);
    if (!Number.isFinite(at) || at <= 0) return undefined;
    return { holderId: parsed.holderId, at };
  } catch {
    return undefined;
  }
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
    | "other-holders"
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
  const holderId = deps.holderId ?? processHolderId();
  const staleMs = deps.holderStaleMs ?? LIVE_UPDATE_HOLDER_STALE_MS;

  // This holder's in-flight units. The SHARED record's `holders` map is the
  // authority for "does the chat's message still have work behind it"; this
  // counter only decides what THIS holder writes into it.
  let active = 0;
  let cycle: "none" | "active" | "resolved" = "none";
  let pendingKind: LiveUpdateEndKind = "done";
  let lastResultText = "";
  let lastCraftRich: LiveUpdateCraftRich | undefined;

  /**
   * Fresh read of the shared record. There is no per-instance latch: another
   * holder's write (a second seat pinning the chat's message, a reload's
   * leftover count) must be visible on the next decision, or two processes
   * each send "their" ack and the chat gets two.
   */
  async function readRecord(): Promise<LiveUpdateState | undefined> {
    const state = await loadLiveState(deps.stateFile);
    if (!state) return undefined;
    const { kept, dropped } = pruneHolders(state.holders, now(), staleMs);
    if (dropped.length > 0) {
      log(
        "warn",
        `live-update: reaped ${dropped.length} stale holder(s) on the tracked message`,
      );
    }
    return { ...state, holders: kept };
  }

  async function writeRecord(state: LiveUpdateState): Promise<void> {
    const holders =
      state.holders && Object.keys(state.holders).length > 0
        ? state.holders
        : undefined;
    await saveLiveState(deps.stateFile, {
      messageId: state.messageId,
      chatId: state.chatId,
      startedAt: state.startedAt,
      ...(state.text ? { text: state.text } : {}),
      ...(holders ? { holders } : {}),
    });
  }

  /** Set this holder's count (deleting the row at zero). */
  function setHolder(
    state: LiveUpdateState,
    count: number,
    at: number,
  ): LiveUpdateState {
    const holders = { ...(state.holders ?? {}) };
    if (count > 0) holders[holderId] = { count, seenAt: at };
    else delete holders[holderId];
    return { ...state, holders };
  }

  function claimPath(): string {
    return liveClaimPath(deps.stateFile);
  }

  function tryClaim(at: number): "held" | "busy" {
    const path = claimPath();
    const write = (): boolean => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ holderId, at }), { flag: "wx" });
        return true;
      } catch {
        return false;
      }
    };
    if (write()) return "held";
    const claim = readClaim(path);
    if (claim?.holderId === holderId) return "held";
    const displaced =
      claim === undefined || at - claim.at > LIVE_UPDATE_CLAIM_STALE_MS;
    if (!displaced) return "busy";
    // A claim left by a process that died mid-send (or an unreadable one) is
    // displaced: the record it claimed to write either never landed or is
    // stale, and a permanent claim would wedge every later start().
    try {
      rmSync(path, { force: true });
    } catch {
      return "busy";
    }
    return write() ? "held" : "busy";
  }

  function releaseClaim(): void {
    try {
      rmSync(claimPath(), { force: true });
    } catch {
      // best-effort: a stale claim is displaced by the next holder
    }
  }

  /**
   * Wait (bounded) for another holder's in-flight send to land its message id.
   * The alternative is a second send: the exact duplicate the owner reported.
   */
  async function awaitOtherMessage(
    chatId: number | string,
  ): Promise<LiveUpdateState | undefined> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const doc = await readRecord();
      if (doc?.messageId && sameChat(doc.chatId, chatId)) return doc;
      await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS));
    }
    return undefined;
  }

  /** Plan a tracked body; a refusal is logged and counted, never sent. */
  function planTracked(text: string): string | undefined {
    const planned = planOutbound({
      text: clipText(text, maxTextLen),
      source: "tracked",
    });
    if (!planned.ok) {
      noteRefusal(planned.refusal.rule);
      log("warn", planned.refusal.error);
      return undefined;
    }
    return planned.text;
  }

  async function editTracked(
    state: LiveUpdateState,
    body: string,
  ): Promise<boolean> {
    const res = await deps.client.editMessageText(
      deps.token,
      state.chatId,
      state.messageId,
      body,
    );
    if (!res.ok)
      log("warn", `live-update: edit failed (${res.error ?? "unknown"})`);
    return res.ok;
  }

  /** Re-pin an existing message this chat already owns. */
  async function reuseTracked(
    state: LiveUpdateState,
    count: number,
    at: number,
  ): Promise<LiveUpdateStartOutcome> {
    const next = setHolder(state, count, at);
    await writeRecord(next);
    // The visible count is the number of SEATS sharing the chat, not the
    // number of queued units: one seat with three queued messages is still
    // one worker behind one message, and the owner's complaint was two
    // sessions, not two tasks.
    const seats = Object.keys(next.holders ?? {}).length;
    const body = planTracked(trackedStartText(seats));
    // Re-pin only when the line actually changes: a repeated begin() on the
    // same seat must not edit the message again.
    if (body !== undefined && body !== state.text && limiter.try(at)) {
      const ok = await editTracked(next, body);
      if (ok) await writeRecord({ ...next, text: body });
    }
    return { started: true, reused: true, messageId: next.messageId };
  }

  /** Deliver the final summary — crafted markdown when fit, else raw text. */
  async function deliverSummary(
    state: LiveUpdateState,
    resultText: string,
    craftRich?: LiveUpdateCraftRich,
  ): Promise<SendChunksResult> {
    const trimmed = resultText.trim();
    if (!trimmed) return { ok: true, sent: 0, total: 0, messageIds: [] };
    const summaryChatId = state.chatId ?? chatIdOf();
    const deliver = async (
      text: string,
      detectMarkdown: boolean,
    ): Promise<SendChunksResult> => {
      // A summary is the agent's own deliverable: long-form (`rich`), so the
      // plain cap does not apply, while the HTML check still refuses a body
      // Telegram would reject. Markdown detection is for the CRAFTED body
      // only — the raw fallback keeps the plain transport it always had.
      const planned = planOutbound({
        text,
        rich: true,
        source: "summary",
        ...(detectMarkdown ? { detectMarkdown: true } : {}),
      });
      if (!planned.ok) {
        noteRefusal(planned.refusal.rule);
        log("warn", planned.refusal.error);
        return {
          ok: false,
          sent: 0,
          total: 0,
          messageIds: [],
          error: planned.refusal.error,
        };
      }
      const out = await sendMessageChunks(deps.client, {
        token: deps.token,
        chatId: summaryChatId,
        text: planned.text,
        ...(planned.parseMode ? { parseMode: planned.parseMode } : {}),
      });
      if (out.ok && out.sent > 0) noteOwnerMessage("summary");
      return out;
    };
    if (craftRich) {
      try {
        const crafted = await craftRich(trimmed);
        if (crafted?.crafted && crafted.text?.trim()) {
          return await deliver(crafted.text.trim(), true);
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
    return deliver(trimmed, false);
  }

  /**
   * Resolve the indicator to the honest terminal state for `kind`. Shared by
   * end() (the chat's last unit), finish()/terminate() (direct calls) and
   * settle() (forced). Assumes THIS holder already dropped to zero and no
   * other holder is left.
   */
  async function resolveIndicator(
    kind: LiveUpdateEndKind,
    state: LiveUpdateState | undefined,
  ): Promise<{
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
    if (!state?.messageId) {
      await clearTracked();
      return { doneEdited: false, summarySent: false, terminalEdited: false };
    }
    const doneBody = planTracked(
      suppressSummary ? TRACKED_DONE_TEXT_REPORT_SENT : TRACKED_DONE_TEXT,
    );
    const done =
      doneBody !== undefined ? await editTracked(state, doneBody) : false;
    const summary = suppressSummary
      ? null
      : await deliverSummary(state, lastResultText, lastCraftRich);
    await clearTracked();
    const completed = done || (summary ? summarySentOk(summary) : true);
    return {
      doneEdited: done,
      summarySent: summary?.ok ?? false,
      terminalEdited: false,
      ...(completed ? {} : { error: "done-edit and summary send both failed" }),
    };
  }

  async function clearTracked(): Promise<void> {
    await clearLiveState(deps.stateFile);
  }

  const tracker: LiveUpdateTracker = {
    async start(): Promise<LiveUpdateStartOutcome> {
      // Fresh work unit → the agent-delivered flag from a prior turn must not
      // leak into it (defensive: the resolver already clears on read).
      clearAgentDeliveredMessage();
      const chatId = chatIdOf();
      if (!chatId) return { started: false, reused: false, reason: "no-chat" };
      const at = now();
      const holderCount = Math.max(active, 1);
      const current = await readRecord();
      if (current?.messageId && sameChat(current.chatId, chatId)) {
        return reuseTracked(current, holderCount, at);
      }
      if (current?.messageId) {
        // The persisted message belongs to a DIFFERENT chat. Reusing it would
        // edit another chat's message; the state file is per owner chat, so
        // this record is foreign and is replaced by this chat's own.
        log(
          "warn",
          `live-update: tracked message ${current.messageId} belongs to another chat — starting this chat's own`,
        );
      }
      if (!limiter.try(at))
        return { started: false, reused: false, reason: "rate-limited" };
      if (tryClaim(at) === "busy") {
        const other = await awaitOtherMessage(chatId);
        if (other?.messageId) return reuseTracked(other, holderCount, now());
        return { started: false, reused: false, reason: "claimed" };
      }
      try {
        const body = planTracked(trackedStartText(holderCount));
        if (body === undefined)
          return { started: false, reused: false, reason: "refused" };
        const res = await deps.client.sendMessage(deps.token, chatId, body);
        if (!res.ok)
          return {
            started: false,
            reused: false,
            reason: "send-failed",
            error: res.error,
          };
        noteOwnerMessage("tracked");
        noteTrackedAck();
        const messageId = res.messageId ?? 0;
        if (messageId > 0) {
          // Only a real message_id is editable — track + persist it. Without
          // one (shouldn't happen for sendMessage, but defensively) the
          // Working… message still went out; finish() falls back to
          // summary-only.
          const record: LiveUpdateState = {
            messageId,
            chatId,
            startedAt: at,
            text: body,
            holders: { [holderId]: { count: holderCount, seenAt: at } },
          };
          try {
            await writeRecord(record);
          } catch (error) {
            log(
              "warn",
              `live-update: failed to persist tracked message: ${String(error)}`,
            );
          }
          log(
            "info",
            `live-update: tracked message ${messageId} started in chat ${chatId} (${totalHeld(record.holders)} active)`,
          );
        }
        return {
          started: true,
          reused: false,
          ...(messageId > 0 ? { messageId } : {}),
        };
      } finally {
        releaseClaim();
      }
    },

    async update(text): Promise<LiveUpdateUpdateOutcome> {
      const state = await readRecord();
      if (!state?.messageId)
        return { updated: false, reason: "no-tracked-message" };
      const at = now();
      if (!limiter.try(at)) return { updated: false, reason: "rate-limited" };
      const body = planTracked(text);
      if (body === undefined) return { updated: false, reason: "refused" };
      const ok = await editTracked(state, body);
      // A touch proves this holder is alive; a holder that only ever wrote at
      // begin() would be reaped mid-turn on a long run.
      if (state.holders?.[holderId]) {
        await writeRecord(setHolder(state, state.holders[holderId].count, at));
      }
      return ok ? { updated: true } : { updated: false, error: "edit failed" };
    },

    async finish({
      resultText,
      craftRich,
      suppressSummary = false,
    }): Promise<LiveUpdateFinishOutcome> {
      const state = await readRecord();
      if (!state?.messageId) {
        // Nothing tracked (the pin never landed): there is no message to edit
        // to ✅, but the report the turn produced is still owed to the owner.
        active = 0;
        cycle = "resolved";
        const summary = suppressSummary
          ? null
          : await deliverSummary(
              { messageId: 0, chatId: chatIdOf(), startedAt: now() },
              resultText,
              craftRich,
            );
        await clearTracked();
        return {
          completed: true,
          doneEdited: false,
          summarySent: summary?.ok ?? false,
          summaryChunks: summary?.total ?? 0,
        };
      }
      // This holder is done: drop its count, then let the SHARED record decide
      // whether the chat's message resolves. Another seat still working keeps
      // the message pinned ("Working…"), which is the whole point of keying it
      // by chat.
      const at = now();
      const released = setHolder(state, 0, at);
      await writeRecord(released);
      active = 0;
      cycle = "resolved";
      const total = totalHeld(released.holders);
      if (total > 0) {
        log(
          "info",
          `live-update: this holder is done; ${total} unit(s) still in flight on this chat — message stays pinned`,
        );
        return {
          completed: false,
          doneEdited: false,
          summarySent: false,
          deferred: true,
        };
      }
      const doneBody = planTracked(
        suppressSummary ? TRACKED_DONE_TEXT_REPORT_SENT : TRACKED_DONE_TEXT,
      );
      let doneEdited = false;
      if (doneBody !== undefined)
        doneEdited = await editTracked(state, doneBody);
      const summary = suppressSummary
        ? null
        : await deliverSummary(state, resultText, craftRich);
      await clearTracked();
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
      const state = await readRecord();
      if (!state?.messageId) {
        await clearTracked();
        active = 0;
        return { terminated: true, terminalEdited: false };
      }
      const at = now();
      const released = setHolder(state, 0, at);
      await writeRecord(released);
      active = 0;
      cycle = "resolved";
      const total = totalHeld(released.holders);
      if (total > 0) {
        // A terminal turn on ONE holder is not a terminal turn for the chat:
        // the other seat is still working behind this message.
        return { terminated: false, terminalEdited: false };
      }
      const body = planTracked(TRACKED_TERMINAL_TEXT);
      const terminalEdited =
        body !== undefined ? await editTracked(state, body) : false;
      await clearTracked();
      return { terminated: true, terminalEdited };
    },

    async isActive(): Promise<boolean> {
      const state = await readRecord();
      return Boolean(state?.messageId);
    },

    async getState(): Promise<LiveUpdateState | undefined> {
      const state = await readRecord();
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
      }
      // Both branches go through start(): it registers this holder in the
      // shared record, reuses the chat's message when there is one (editing it
      // to the counted line), and sends only when the chat has none.
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
      if (cycle !== "active") return { ended: false, active };
      const state = await readRecord();
      if (!state?.messageId) {
        // Nothing pinned (the send failed): nothing to resolve.
        cycle = "resolved";
        await clearTracked();
        return { ended: true, active, doneEdited: false, summarySent: false };
      }
      const next = setHolder(state, active, now());
      await writeRecord(next);
      const total = totalHeld(next.holders);
      if (total > 0) {
        // Another holder still has work in flight behind the same message.
        return { ended: false, active };
      }
      cycle = "resolved";
      const r = await resolveIndicator(pendingKind, next);
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
      const state = await readRecord();
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
      // indicator NEVER freezes at "Working…". An in-flight THIS-SESSION
      // cycle settles with its last unit's outcome (✅ Done by default — the
      // run finished); a resurrected stale pinned message (no active work
      // this session) is a turn that ended without a report → ⏹.
      const wasActive = cycle === "active";
      if (state?.messageId) {
        // Drop this holder's count first, then let the SHARED total decide:
        // a chat still held by another seat keeps its message.
        const next = setHolder(state, 0, now());
        await writeRecord(next);
        if (totalHeld(next.holders) > 0) {
          cycle = "resolved";
          active = 0;
          return {
            resolved: false,
            alreadyResolved: false,
            active,
            reason: "other-holders",
          };
        }
      }
      cycle = "resolved";
      active = 0;
      const r = await resolveIndicator(
        wasActive ? pendingKind : "no-report",
        state,
      );
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
