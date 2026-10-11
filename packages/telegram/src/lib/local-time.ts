/**
 * Local-time rendering for the telegram package — MIRROR of the core
 * formatter.
 *
 * Telegram cannot import pi-braid core (standalone package, no core dep) —
 * the established cross-package pattern is a documented literal mirror with
 * a keep-in-sync test (see watchdog-tunnel.ts: the WATCHDOG_TG_SIGNAL_KEY
 * mirror). This module mirrors packages/core/src/lib/utils/local-time.ts:
 *
 *   formatWhisperClock(ms) -> "17:05 MSK" (whisper header `@ HH:MM TZ`)
 *   formatLocalTime(ms) -> "17:05 MSK (UTC+3)"
 *
 * Owner TZ: `braid.timezone` in ~/.pi/agent/settings.json (same key the
 * core formatter reads — one setting controls both), default Europe/Moscow.
 * Keep the two files in sync; test/local-time.test.mjs pins the parity
 * contract (same inputs → same outputs as the core shapes).
 *
 * All Intl-based (Node >= 22 full ICU). No external deps.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_TIME_ZONE = "Europe/Moscow";

/** settings.json (pi-native) — same path + braid block as pause-control.ts. */
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/**
 * Owner time zone: braid.timezone in ~/.pi/agent/settings.json when set,
 * else Europe/Moscow. Mirrors core's getOwnerTimeZone() so both packages
 * render the SAME zone from the SAME setting. Never throws.
 */
export function ownerTimeZone(): string {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as {
        braid?: { timezone?: unknown };
      };
      const tz = parsed?.braid?.timezone;
      if (typeof tz === "string" && tz.trim()) return tz.trim();
    }
  } catch {
    // non-fatal — fall through to the default
  }
  return DEFAULT_TIME_ZONE;
}

/** Validate an IANA time zone name cheaply (invalid names fall back). */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Abbreviation overrides for well-known FIXED-offset zones — CLDR renders
 * Europe/Moscow as "GMT+3" but the owner format examples specify "MSK".
 * MIRROR of packages/core/src/lib/utils/local-time.ts ZONE_ABBREVIATIONS —
 * keep in sync (parity pinned by test/local-time.test.mjs). Zones not in the
 * map fall back to the ICU short name ("EDT", "GMT+1", ...). Never invent an
 * abbreviation for a DST zone.
 */
const ZONE_ABBREVIATIONS: Record<string, string> = {
  "Europe/Moscow": "MSK",
  "Europe/Kaliningrad": "EET",
  "Europe/Samara": "SAMT",
  "Asia/Yekaterinburg": "YEKT",
  "Asia/Omsk": "OMST",
  "Asia/Novosibirsk": "NOVT",
  "Asia/Krasnoyarsk": "KRAT",
  "Asia/Irkutsk": "IRKT",
  "Asia/Yakutsk": "YAKT",
  "Asia/Vladivostok": "VLAT",
  "Asia/Magadan": "MAGT",
  "Asia/Kamchatka": "PETT",
};

/** The zone's short abbreviation (e.g. "MSK"); ICU short fallback otherwise. */
function zoneAbbreviation(date: Date, timeZone: string): string {
  const known = ZONE_ABBREVIATIONS[timeZone];
  if (known) return known;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(date);
  const name = parts.find((p) => p.type === "timeZoneName")?.value;
  return name && name.length > 0 ? name : "UTC";
}

/** Offset from UTC in minutes at the given instant (DST-safe). */
function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour) % 24,
    Number(map.minute),
    Number(map.second),
  );
  return Math.round((asUTC - date.getTime()) / 60_000);
}

/** Render a minutes offset as "UTC+3" / "UTC-5" / "UTC+5:30" / "UTC+0". */
function formatOffset(minutes: number): string {
  if (minutes === 0) return "UTC+0";
  const sign = minutes > 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m > 0 ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/**
 * Full local-time form (mirror of core formatLocalTime): "HH:MM TZ (UTC±X)".
 *
 * @param ms       epoch milliseconds to render (default: now)
 * @param withDate prepend "YYYY-MM-DD "
 */
export function formatLocalTime(
  ms: number = Date.now(),
  withDate = false,
): string {
  const tz = ownerTimeZone();
  const safeTz = isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
  const date = new Date(ms);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: safeTz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const abbr = zoneAbbreviation(date, safeTz);
  const datePart = withDate
    ? `${new Intl.DateTimeFormat("en-CA", {
        timeZone: safeTz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date)} `
    : "";
  return `${datePart}${time} ${abbr} (${formatOffset(zoneOffsetMinutes(date, safeTz))})`;
}

/**
 * Compact header clock (mirror of core formatWhisperClock): "HH:MM TZ" —
 * the whisper-header form (`@ HH:MM TZ`), a few tokens short.
 *
 * @param ms epoch milliseconds to render (default: now). For inbound TG
 *           messages pass `update.date * 1000` (unix seconds → ms) so the
 *           header shows WHEN the owner actually sent the message.
 */
export function formatWhisperClock(ms: number = Date.now()): string {
  const tz = ownerTimeZone();
  const safeTz = isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
  const date = new Date(ms);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: safeTz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const abbr = zoneAbbreviation(date, safeTz);
  return `${time} ${abbr}`;
}
