/**
 * Telegram channel caps — the `braid.telegram` block in
 * `~/.pi/agent/settings.json` (same reader pattern as pause-control.ts).
 *
 * Owner messages are LONG by default — plain text sends verbatim up to the
 * cap. Two caps are settings-driven:
 *  - `sendMaxChars`   — default cap for `telegram_send` plain text. Default
 *    4096 = Telegram's per-message text limit; bodies over it go through
 *    `rich: true` (split-to-fit) or an explicit strategy.
 *  - `notifyMaxChars` — craft target + guard for turn-end notifications.
 *    Default 1200: a full readable update, not a 280-char fragment.
 *  - `pollerAutoStart` — which working directories start the inbound poller by
 *    themselves. `true` means everywhere, an array means those cwds only, and
 *    anything else means nowhere: the env var and the tools stay the way in.
 *    Matching is EXACT, never a prefix: a seat at
 *    ~/.pi/agent/braid/orchestrator opts in without every worker worktree
 *    under /private/tmp inheriting the channel with it.
 *
 * Degradation: a missing file, unreadable JSON, or an invalid entry (not a
 * finite number ≥ 1) falls back to the default — a bad setting never breaks a
 * send. The file is re-read on every resolve (no caching), so an edit applies
 * without a restart. Config lives in pi settings, never process.env.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** pi-native settings file. */
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** Fallback send cap: Telegram's per-message text limit. */
export const DEFAULT_SEND_MAX_CHARS = 4096;

/** Fallback notify cap: full readable update, not a tweet-length squeeze. */
export const DEFAULT_NOTIFY_MAX_CHARS = 1200;

interface RawBraidSettings {
  braid?: {
    telegram?: {
      sendMaxChars?: unknown;
      notifyMaxChars?: unknown;
      pollerAutoStart?: unknown;
    };
  };
}

export interface TelegramCaps {
  sendMaxChars: number;
  notifyMaxChars: number;
}

/** Which directories start the poller on their own: everywhere, a list, or nowhere. */
export type PollerAutoStart = boolean | string[];

/** A cap must be a positive finite number; anything else → the default. */
function sanitizeCap(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : fallback;
}

/**
 * Resolve both caps from `settingsPath` (default `~/.pi/agent/settings.json`).
 * Never throws: an unreadable or invalid file yields the defaults.
 */
export function readTelegramCaps(
  settingsPath: string = SETTINGS_PATH,
): TelegramCaps {
  let parsed: RawBraidSettings | undefined;
  try {
    if (existsSync(settingsPath)) {
      parsed = JSON.parse(
        readFileSync(settingsPath, "utf8"),
      ) as RawBraidSettings;
    }
  } catch {
    // non-fatal — fall through to the defaults
  }
  const telegram = parsed?.braid?.telegram;
  return {
    sendMaxChars: sanitizeCap(telegram?.sendMaxChars, DEFAULT_SEND_MAX_CHARS),
    notifyMaxChars: sanitizeCap(
      telegram?.notifyMaxChars,
      DEFAULT_NOTIFY_MAX_CHARS,
    ),
  };
}

/** Normalize a path for the cwd comparison: no trailing slash, no symlink tail. */
function normalizeCwd(path: string): string {
  let out = path.trim();
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * Read `braid.telegram.pollerAutoStart`: `true` (everywhere), an array of
 * absolute cwds (those only), or `false` when absent or malformed. A relative
 * entry, an empty string, or any other type is dropped rather than guessed at,
 * because a mistyped cwd would otherwise start the poller somewhere nobody
 * asked for.
 */
export function readPollerAutoStart(
  settingsPath: string = SETTINGS_PATH,
): PollerAutoStart {
  let parsed: RawBraidSettings | undefined;
  try {
    if (existsSync(settingsPath)) {
      parsed = JSON.parse(
        readFileSync(settingsPath, "utf8"),
      ) as RawBraidSettings;
    }
  } catch {
    return false;
  }
  const raw = parsed?.braid?.telegram?.pollerAutoStart;
  if (raw === true) return true;
  if (!Array.isArray(raw)) return false;
  const cwds = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeCwd(entry))
    .filter((entry) => entry.startsWith("/"));
  return cwds;
}

/**
 * Does this working directory start the poller by itself? Exact match only.
 * A subdirectory of a listed cwd does NOT inherit it: the seat opts in for the
 * directory it runs in, and a worker in a worktree beneath it must not.
 */
export function pollerAutoStartFor(
  cwd: string,
  settingsPath: string = SETTINGS_PATH,
): boolean {
  const setting = readPollerAutoStart(settingsPath);
  if (setting === true) return true;
  if (setting === false) return false;
  const here = normalizeCwd(cwd);
  return setting.includes(here);
}

/** Default cap for `telegram_send` plain text (`braid.telegram.sendMaxChars`). */
export function resolveSendMaxChars(
  settingsPath: string = SETTINGS_PATH,
): number {
  return readTelegramCaps(settingsPath).sendMaxChars;
}

/** Craft target for turn-end notifications (`braid.telegram.notifyMaxChars`). */
export function resolveNotifyMaxChars(
  settingsPath: string = SETTINGS_PATH,
): number {
  return readTelegramCaps(settingsPath).notifyMaxChars;
}
