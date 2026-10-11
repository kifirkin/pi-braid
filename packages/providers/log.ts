/**
 * TUI-safe log sink for the pi-braid providers extension.
 *
 * The providers package is standalone (no pi-core dependency), so it cannot
 * import core's `createLogger`. It mirrors the telegram pattern
 * (packages/telegram/src/index.ts `log()`): a module-level notify sink,
 * notify-shaped (same signature as pi's `ctx.ui.notify` — `(message, type:
 * "info" | "warning" | "error")`), bound from a `session_start` handler and
 * cleared on `session_shutdown`. The extension factory's ExtensionAPI has no
 * `ui` — only session/event contexts carry `ctx.ui.notify` — so the sink must
 * be bound from a session handler, never at load time.
 *
 * info/warn/error route through the sink and NEVER console.* — any extension
 * console write in the live pi TUI is restored into the owner's INPUT line
 * and corrupts it. With no sink bound (headless/RPC/print runs, module-load
 * time, or before the first session_start) they are SILENT. info surfaces
 * key-ring rotation / recovery events;
 * debug remains deliberately unsupported so a hot path can never leak a
 * per-cycle line into the TUI.
 */

export type ProvidersLogLevel = "info" | "warn" | "error";

export type ProvidersLogSink = (
  message: string,
  type: "info" | "warning" | "error",
) => void;

/** Module-level notify sink (native pi-core pattern — see core's logger.ts). */
let logSink: ProvidersLogSink | undefined;

/**
 * Set (or clear) the log sink providerLog() routes through. The extension
 * factory binds this to `ctx.ui.notify` on `session_start` and clears it on
 * `session_shutdown`. With NO sink configured — headless/RPC/print modes or
 * before the first session — warn/error are SILENT. Never console.*, so the
 * TUI input field never sees a providers line.
 */
export function setProvidersLogSink(sink: ProvidersLogSink | undefined): void {
  logSink = sink;
}

/**
 * Route a provider diagnostic through the notify sink. `scope` names the
 * logger like core's `createLogger` sources ("providers/key-ring",
 * "providers/ring-lifecycle"). info → notify "info", warn → notify
 * "warning", error → notify "error". With no sink bound this is a silent
 * no-op — never console.*.
 */
export function providerLog(
  level: ProvidersLogLevel,
  scope: string,
  message: string,
): void {
  if (!logSink) return;
  const type =
    level === "error" ? "error" : level === "warn" ? "warning" : "info";
  logSink(`[${scope}] ${message}`, type);
}

// During a realm where the provider key ring is exhausted / 403-flooding,
// message_end + exhaustActiveKey can fire once per turn — each would emit a
// fresh notify warn and flood the TUI. This mirrors the telegram holder's
// createThrottledLogger, but routed through providerLog and
// member-scoped so it never lands on console.*: the FIRST occurrence is loud,
// consecutive repeats within `windowMs` produce NO output at all (zero
// per-call lines), and a still-failing source re-warns once when the window
// elapses. `streak()` exposes the consecutive-error count so a caller can
// emit a single recovery line once the error clears; `reset()` clears the
// state after recovery. State ages out — a burst that sits idle for a full
// window starts loud again. `windowMs` and `now` are injectable so tests can
// shrink the window and advance a fake clock instead of waiting out minutes.

export const THROTTLE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export interface ThrottledLog {
  /**
   * Record one occurrence of a repeating error. Returns true when this
   * occurrence was emitted loud (first, or after the window elapsed); false
   * for a silent repeat inside the window. Callers may gate side-effecting
   * sinks on the return value, but here `occurrence` itself routes through
   * providerLog — silent repeats call nothing.
   */
  occurrence(level: ProvidersLogLevel, scope: string, message: string): boolean;
  /** Consecutive occurrences in the current burst (0 when clean/reset). */
  streak(): number;
  /** Clear the error state after recovery. */
  reset(): void;
}

export function createThrottledLogger(
  windowMs: number = THROTTLE_WINDOW_MS,
  now: () => number = Date.now,
): ThrottledLog {
  let seen = false;
  let lastAt = 0;
  let lastLoudAt = 0;
  let streak = 0;

  return {
    occurrence(level, scope, message) {
      const t = now();
      const burstAgedOut = !seen || t - lastAt >= windowMs;
      const windowSinceLoud = !seen || t - lastLoudAt >= windowMs;
      streak = burstAgedOut ? 1 : streak + 1;
      lastAt = t;
      if (burstAgedOut || windowSinceLoud) {
        seen = true;
        lastLoudAt = t;
        providerLog(level, scope, message);
        return true;
      }
      // Quiet repeat: ZERO log output (16d) — the first loud line stands.
      return false;
    },
    streak() {
      return streak;
    },
    reset() {
      seen = false;
      lastAt = 0;
      lastLoudAt = 0;
      streak = 0;
    },
  };
}
