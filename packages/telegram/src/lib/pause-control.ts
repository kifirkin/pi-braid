/**
 * Telegram inline-keyboard pause/resume control.
 *
 * The for a button to control the agent through Telegram
 * ("Seems need a button for pause or whatever control this through tg").
 * This module adds:
 *  - an inline keyboard (reply_markup) with ⏸ Pause / ▶ Resume / 📊 Status
 *    buttons (callback_data: "pause" | "resume" | "status");
 *  - callback_query handling: pause → paused=true, resume → paused=false,
 *    status → reply the current state; every tap is answered via
 *    answerCallbackQuery and the keyboard is updated in place via
 *    editMessageText (paused shows ▶ Resume, running shows ⏸ Pause);
 *  - a persisted pause state file (default
 *    `<braidDir>/telegram/pause-state.json`, atomic write-temp-rename) that
 *    survives restarts; the pre-move `~/.pi/agent/telegram-pause-state.json`
 *    stays readable until the first post-move write replaces it (reads prefer
 *    the braid-root file, writes only ever land there);
 *  - `getPauseState()` — the exported read seam for the CONSUMER (the
 *    orchestrator decides how to honor the flag; this module never blocks the
 *    poller or the core loop).
 *
 * Design: the pause flag is a signal for the consumer, not a gate here. The
 * poller keeps polling and delivering; pause/resume/status callbacks are
 * handled entirely within this module (answer + edit) and never a turn.
 *
 * Config follows the pi "settings" philosophy (packages/core braid-settings):
 * the state-file path defaults to the fixed path above and can be overridden
 * via `braid.telegram.pauseStateFile` in `~/.pi/agent/settings.json` — no
 * process.env keys are introduced.
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import {
  defaultPauseStateFile,
  legacyPauseStateFile,
  warnUnderivableRoot,
} from "./state-paths.js";
import type { TelegramClient, TelegramReplyMarkup } from "./telegram-client.js";

export { defaultPauseStateFile, legacyPauseStateFile };

// Callback actions (button callback_data)

export const CALLBACK_PAUSE = "pause";
export const CALLBACK_RESUME = "resume";
export const CALLBACK_STATUS = "status";

/** Control-message body shown while the agent is running. */
export const CONTROL_RUNNING_TEXT =
  "▶ Agent is running — inbound flows normally.";
/** Control-message body shown while the agent is paused. */
export const CONTROL_PAUSED_TEXT = "⏸ Agent is paused — inbound will be held.";

export interface PauseState {
  paused: boolean;
  /** Epoch ms of the last pause/resume transition (0 when never changed). */
  updatedAt: number;
}

/** settings.json (pi-native) — braid.telegram block, mirrors braid-settings.ts. */
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

interface BraidSettings {
  braid?: {
    telegram?: {
      /** Override for the pause-state file path (default: defaultPauseStateFile()). */
      pauseStateFile?: string;
    };
  };
}

/** The `braid.telegram.pauseStateFile` override, or undefined. Never throws. */
function configuredPauseStateFile(): string | undefined {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const parsed = JSON.parse(
        readFileSync(SETTINGS_PATH, "utf8"),
      ) as BraidSettings;
      const override = parsed?.braid?.telegram?.pauseStateFile;
      if (typeof override === "string" && override.trim())
        return override.trim();
    }
  } catch {
    // non-fatal — fall through to the default
  }
  return undefined;
}

/**
 * Write resolution: `braid.telegram.pauseStateFile` when configured, else the
 * braid-root default. Every write goes here — the pre-move agent-dir file is
 * read-only history. Null when no absolute root resolves: the caller refuses
 * to persist instead of writing beside the cwd.
 */
export function resolvePauseStateFile(): string | null {
  return configuredPauseStateFile() ?? defaultPauseStateFile();
}

/**
 * Read resolution: the configured override, else the braid-root file when it
 * exists, else the pre-move agent-dir file when that exists (so a pause set
 * before the relocation keeps holding), else the braid-root path (a miss the
 * caller treats as "not paused"). Null when no absolute root resolves.
 */
export function resolvePauseStateReadFile(): string | null {
  const configured = configuredPauseStateFile();
  if (configured) return configured;
  const current = defaultPauseStateFile();
  if (current !== null && existsSync(current)) return current;
  const legacy = legacyPauseStateFile();
  if (legacy !== null && existsSync(legacy)) return legacy;
  return current;
}

/** Read the pause state; a missing/corrupt file means "not paused" (never throws). */
export async function loadPauseState(
  stateFile: string | null,
): Promise<PauseState> {
  if (stateFile === null) return { paused: false, updatedAt: 0 };
  try {
    const raw = await readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<PauseState>;
    return {
      paused: parsed?.paused === true,
      updatedAt: Number(parsed?.updatedAt) || 0,
    };
  } catch {
    return { paused: false, updatedAt: 0 };
  }
}

/**
 * Persist the pause state ATOMICALLY (write-temp-rename): the JSON is written
 * to `<stateFile>.tmp` first, then renamed over the target, so a crash
 * mid-write can never leave a truncated state file behind.
 */
export async function savePauseState(
  stateFile: string,
  state: PauseState,
): Promise<void> {
  const dir = dirname(stateFile);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // parent may already exist; write will surface real errors
  }
  const tmp = `${stateFile}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, stateFile);
}

/**
 * Exported read seam for the CONSUMER (orchestrator): check the persisted
 * pause flag before processing inbound. `stateFile` defaults to the resolved
 * settings/default path. Never throws.
 */
export async function getPauseState(
  stateFile: string | null = resolvePauseStateReadFile(),
): Promise<PauseState> {
  return loadPauseState(stateFile);
}

/**
 * Build the control keyboard for the given state: running shows ⏸ Pause +
 * 📊 Status; paused shows ▶ Resume + 📊 Status (the action that changes the
 * current state is always the primary button).
 */
export function buildControlKeyboard(paused: boolean): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [
        paused
          ? { text: "▶ Resume", callback_data: CALLBACK_RESUME }
          : { text: "⏸ Pause", callback_data: CALLBACK_PAUSE },
        { text: "📊 Status", callback_data: CALLBACK_STATUS },
      ],
    ],
  };
}

export interface SendControlKeyboardResult {
  ok: boolean;
  messageId?: number;
  error?: string;
}

/**
 * Send the control message (status line + inline keyboard) to a chat. The
 * orchestrator/agent can call this to place the control in a chat; the
 * keyboard is then kept in sync by handlePauseCallbackQuery's edit.
 */
export async function sendControlKeyboard(
  client: Pick<TelegramClient, "sendMessage">,
  token: string,
  chatId: number | string,
  paused: boolean,
): Promise<SendControlKeyboardResult> {
  const text = paused ? CONTROL_PAUSED_TEXT : CONTROL_RUNNING_TEXT;
  const res = await client.sendMessage(token, chatId, text, {
    replyMarkup: buildControlKeyboard(paused),
  });
  return res.ok
    ? { ok: true, messageId: res.messageId }
    : { ok: false, error: res.error };
}

/** Comparable pause-state reader for the placement helper (see PauseControlDeps.getPauseState). */
export type PauseStateReaderLike = () => Promise<PauseState>;

export interface PlaceControlKeyboardDeps {
  client: Pick<TelegramClient, "sendMessage">;
  token: string;
  /**
   * Pause-state reader — defaults to the (unpersisted-default) getPauseState().
   * Injectable so the consumer can reuse its gate's reader (index.ts passes the
   * same readPauseState the poller gate uses: placement and gate always agree).
   */
  getPauseState?: PauseStateReaderLike;
  log?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    ...rest: unknown[]
  ) => void;
}

export interface PlaceControlKeyboardResult {
  ok: boolean;
  /**
   * True when no usable chat id was given (owner chat not known yet — pure
   * first-message bootstrap). NOTHING is sent; the caller retries once the
   * first owner message captures the real chat id. Never true alongside ok:true.
   */
  deferred: boolean;
  messageId?: number;
  error?: string;
}

/**
 * Consumer-side placement helper: ONE call sends the
 * control keyboard to `chatId`, reflecting the CURRENT persisted pause flag —
 * running shows ⏸ Pause, paused shows ▶ Resume. This stays delivery-neutral:
 * NOTHING self-sends on import — the CONSUMER (index.ts) calls this at the
 * poller-start seam. Best-effort: failures are returned in the result, never
 * thrown. When `chatId` is empty/0 the call returns `deferred: true` without
 * sending, so a poller that started before the owner chat was discovered
 * (bootstrap) can place once the first owner message provides a chat id.
 */
export async function placeControlKeyboard(
  chatId: number | string | undefined,
  deps: PlaceControlKeyboardDeps,
): Promise<PlaceControlKeyboardResult> {
  const log = deps.log ?? (() => {});
  if (chatId == null || chatId === "" || chatId === 0) {
    log(
      "debug",
      "telegram: control keyboard deferred — owner chat not known yet",
    );
    return { ok: false, deferred: true };
  }
  const state = deps.getPauseState
    ? await deps.getPauseState()
    : await getPauseState();
  const res = await sendControlKeyboard(
    deps.client,
    deps.token,
    chatId,
    state.paused,
  );
  if (res.ok) {
    log(
      "info",
      `telegram: control keyboard placed in chat ${chatId} (${state.paused ? "paused — ▶ Resume" : "running — ⏸ Pause"}${res.messageId != null ? `, msg ${res.messageId}` : ""})`,
    );
  } else {
    log(
      "warn",
      `telegram: control keyboard placement failed for chat ${chatId}: ${res.error ?? "unknown"}`,
    );
  }
  return { ...res, deferred: false };
}

/** The callback_query shape this handler consumes (subset of Telegram's). */
export interface PauseCallbackQuery {
  id: string;
  from?: { id: number; username?: string; first_name?: string };
  /** The message the button is attached to (absent in inline mode). */
  message?: { message_id: number; chat: { id: number; type?: string } };
  data?: string;
}

export interface PauseControlDeps {
  client: Pick<TelegramClient, "answerCallbackQuery" | "editMessageText">;
  token: string;
  /** Path to the pause-state file (persistence). Null when no absolute braid
   *  root resolves: reads degrade to "not paused", writes are refused. */
  stateFile: string | null;
  log?: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    ...rest: unknown[]
  ) => void;
}

export interface PauseCallbackOutcome {
  ok: boolean;
  action: "pause" | "resume" | "status" | "unknown";
  /** State AFTER the tap (persisted truth). */
  paused: boolean;
  /** answerCallbackQuery succeeded. */
  answered: boolean;
  /** editMessageText (keyboard refresh) succeeded. */
  edited: boolean;
  error?: string;
}

async function answerCallback(
  deps: PauseControlDeps,
  callbackQueryId: string,
  text: string,
): Promise<boolean> {
  const res = await deps.client.answerCallbackQuery(
    deps.token,
    callbackQueryId,
    { text },
  );
  return res.ok;
}

/**
 * Handle one inline-keyboard tap: pause → persist paused=true, resume →
 * persist paused=false, status → no change. Every tap is answered via
 * answerCallbackQuery (toast with the current state) and — when the tap
 * carries a message — the keyboard is updated in place via editMessageText so
 * paused shows ▶ Resume and running shows ⏸ Pause. Idempotent: re-tapping the
 * same action is a no-op on state (still answered + keyboard refreshed).
 * Never throws; API failures are reported in the outcome.
 */
export async function handlePauseCallbackQuery(
  deps: PauseControlDeps,
  callbackQuery: PauseCallbackQuery,
): Promise<PauseCallbackOutcome> {
  const log = deps.log ?? (() => {});
  const data =
    typeof callbackQuery.data === "string" ? callbackQuery.data.trim() : "";
  const stateFile = deps.stateFile;
  // Reads prefer the braid-root file but fall back to the pre-move agent-dir
  // copy while the braid-root file does not exist yet; the writes below always
  // target `stateFile` (the braid-root default or the configured override).
  const readFile =
    stateFile === resolvePauseStateFile()
      ? resolvePauseStateReadFile()
      : stateFile;
  const state = await loadPauseState(readFile);

  // Unknown action: answer with a hint, no state change, no keyboard edit.
  if (
    data !== CALLBACK_PAUSE &&
    data !== CALLBACK_RESUME &&
    data !== CALLBACK_STATUS
  ) {
    const answered = await answerCallback(
      deps,
      callbackQuery.id,
      `Unknown action: ${data || "(empty)"}`,
    );
    return {
      ok: true,
      action: "unknown",
      paused: state.paused,
      answered,
      edited: false,
    };
  }

  if (data === CALLBACK_PAUSE && !state.paused) {
    if (stateFile === null) {
      warnUnderivableRoot("pause-state write refused");
    } else {
      await savePauseState(stateFile, { paused: true, updatedAt: Date.now() });
      log(
        "info",
        `telegram pause: agent paused via callback (${callbackQuery.id})`,
      );
    }
  } else if (data === CALLBACK_RESUME && state.paused) {
    if (stateFile === null) {
      warnUnderivableRoot("pause-state write refused");
    } else {
      await savePauseState(stateFile, { paused: false, updatedAt: Date.now() });
      log(
        "info",
        `telegram pause: agent resumed via callback (${callbackQuery.id})`,
      );
    }
  }
  // Re-read so `paused` reflects the persisted truth (idempotent re-taps).
  const current = await loadPauseState(readFile);

  const statusText = current.paused ? "⏸ Agent paused" : "▶ Agent running";
  const answered = await answerCallback(deps, callbackQuery.id, statusText);

  let edited = false;
  const msg = callbackQuery.message;
  if (msg?.message_id && msg?.chat?.id != null) {
    const res = await deps.client.editMessageText(
      deps.token,
      msg.chat.id,
      msg.message_id,
      current.paused ? CONTROL_PAUSED_TEXT : CONTROL_RUNNING_TEXT,
      { replyMarkup: buildControlKeyboard(current.paused) },
    );
    edited = res.ok;
    if (!res.ok)
      log(
        "warn",
        `telegram pause: keyboard edit failed (${res.error ?? "unknown"})`,
      );
  }

  return { ok: true, action: data, paused: current.paused, answered, edited };
}
