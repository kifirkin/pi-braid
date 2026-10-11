/**
 * Local-time rendering — the ONE formatter for braid-facing time text.
 *
 * Dynamic quota + daily
 * reset means the agent must KNOW the current local time. Every braid-facing
 * time string renders through here (scattered `toLocaleTimeString()` calls
 * would be server-TZ dependent, abbreviation-less, and inconsistent):
 *
 *   formatLocalTime() -> "17:05 MSK (UTC+3)" (HH:MM TZ (UTC±X))
 *   formatLocalTime(d, { withDate: true })
 *                          -> " 17:05 MSK (UTC+3)" (heartbeat now-line)
 *   formatWhisperClock() -> "17:05 MSK" (whisper headers)
 *
 * The owner time zone defaults to Europe/Moscow and is overridable via
 * braid settings: `braid.timezone` (IANA name) in ~/.pi/agent/settings.json —
 * read through lib/config/braid-settings.ts like every other braid key
 * (settings-over-env). Pane/log timestamps stay UTC (pi-core, untouched).
 *
 * The telegram package cannot import pi-braid core (standalone package, no
 * core dep — see packages/telegram/src/lib/watchdog-tunnel.ts for the
 * established mirror pattern). Its `lib/local-time.ts` mirrors the two
 * exported shapes below; keep the two files in sync (parity is pinned by
 * that package's local-time test).
 *
 * All Intl-based (Node >= 22 full ICU). No external deps.
 */

import { getOwnerTimeZone, DEFAULT_TIME_ZONE } from "../config/braid-settings.js";

/** Re-exported: the documented default (Europe/Moscow) for tests + callers. */
export { DEFAULT_TIME_ZONE };

/**
 * Test-only clock override. null restores Date.now()/new Date(). Same
 * injectable-clock pattern as injection-tracker's _setReprimeClockForTests —
 * fixtures pin a wall-clock instant so format assertions are deterministic
 * across CI time zones and DST boundaries.
 */
let _clockOverride: Date | null = null;

/**
 * Resolve the effective wall-clock instant: the test override when pinned,
 * else now. Exported for tests that need to compute expected values.
 */
export function nowOrOverride(): Date {
  return _clockOverride ?? new Date();
}

/**
 * Pin (or unpin) the clock used by every formatter in this module.
 * Pass null to restore real time. TEST-ONLY.
 */
export function setLocalTimeClockForTests(date: Date | null): void {
  _clockOverride = date;
}

/** The owner time zone (settings braid.timezone, default Europe/Moscow). */
export function ownerTimeZone(): string {
  return getOwnerTimeZone();
}

/** Validate an IANA time zone name cheaply (throws only on invalid names). */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Abbreviation overrides for well-known FIXED-offset zones. CLDR/ICU's
 * "short" metazone renders Europe/Moscow as "GMT+3" (Russia dropped legacy
 * abbreviations from CLDR), but the owner-facing format examples specify
 * "MSK". These zones
 * have been DST-free with a constant offset since 2014, so a static map is
 * correct year-round. Zones NOT in the map fall back to the ICU short name
 * (e.g. "EDT" for America/New_York — real abbreviation; "GMT+1" style for
 * zones without one). Never invent an abbreviation for a DST zone.
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

/**
 * The zone's short abbreviation (e.g. "MSK", "EDT") per Intl; falls back to
 * "GMT+X" style names when the zone has no short abbreviation.
 */
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

/**
 * The zone's offset from UTC in minutes (positive = ahead of UTC) at the
 * given instant. Computed by re-rendering the local wall-clock parts and
 * diffing against the instant — DST-safe.
 */
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

/** Render a minutes offset as "UTC+3" / "UTC-5" / "UTC+5:30" / "UTC+0"→"UTC". */
function formatOffset(minutes: number): string {
  if (minutes === 0) return "UTC+0";
  const sign = minutes > 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m > 0 ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/**
 * The ONE local-time formatter: "HH:MM TZ (UTC±X)" in the owner time
 * zone (braid.timezone setting, default Europe/Moscow).
 *
 * @param date     instant to render (default: now; test clock override wins)
 * @param withDate prepend "YYYY-MM-DD " (heartbeat now-line needs the date
 *                 so a stale clock is detectable across days)
 */
export function formatLocalTime(date: Date = nowOrOverride(), withDate = false): string {
  const tz = ownerTimeZone();
  const safeTz = isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: safeTz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const abbr = zoneAbbreviation(date, safeTz);
  const offset = formatOffset(zoneOffsetMinutes(date, safeTz));
  const datePart = withDate
    ? `${new Intl.DateTimeFormat("en-CA", {
        timeZone: safeTz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date)} `
    : "";
  return `${datePart}${time} ${abbr} (${offset})`;
}

/**
 * Compact header clock (T3): "HH:MM TZ" — the whisper-envelope form. Headers
 * must stay a few tokens short, so no offset suffix here; formatLocalTime
 * carries the full precision where needed.
 */
export function formatWhisperClock(date: Date = nowOrOverride()): string {
  const tz = ownerTimeZone();
  const safeTz = isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: safeTz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${time} ${zoneAbbreviation(date, safeTz)}`;
}
