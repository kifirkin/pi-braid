/**
 * TG poller liveness seam — cross-package soft registry (telegram →
 * prompt-builder).
 *
 * The telegram package owns the inbound poller's live running state
 * (packages/telegram/src/index.ts `activePoller` / `isRunning()`) and cannot
 * import pi-braid core (standalone package, no core dep); the prompt-builder
 * needs that state at whisper build time to gate the "TG inbound" reachability
 * row in the awareness catalog. Neither side imports the other, so the state
 * crosses through a process-global slot — the same deliberate seam pattern as
 * the providers key-ring feedback (KEY_RING_FEEDBACK_KEY), the watchdog tunnel
 * hub (WATCHDOG_TUNNEL_KEY), and the watchdog tg-signal sender
 * (WATCHDOG_TG_SIGNAL_KEY).
 *
 * globalThis (not a module-level let): the prompt-builder runs from the TS
 * SOURCE tree while the telegram package loads pi-braid from compiled DIST,
 * giving this file two module instances in one process — the
 * CUSTOM_MODEL_KEYS comment in global-state.ts documents the same hazard. The
 * slot must also survive /reload.
 *
 * What is stored is a PROBE, not a start/stop boolean: the telegram factory
 * publishes `() => Boolean(activePoller?.isRunning())` once at load and every
 * whisper build re-asks the live source of truth. A boolean written on
 * start/stop would go stale exactly in the failure mode (poller dies
 * silently without calling stop; nothing would downgrade the row). The probe
 * also makes reload and the post-reload auto-restart wiring-free: the rebuilt
 * runtime re-publishes over the slot on the next factory run.
 *
 * Absent slot (telegram not loaded, pre-publish build) reads as "unknown" —
 * consumers must hedge, never assert reachability. The reader never throws:
 * a throwing probe degrades to "unknown".
 */

/**
 * Process-global slot key — MUST stay in sync with the local literal in
 * packages/telegram/src/index.ts (TELEGRAM_POLLER_LIVENESS_KEY).
 */
export const TELEGRAM_POLLER_LIVENESS_KEY = "__braid_tg_poller_liveness";

/** Live probe published by the telegram extension. Must never throw. */
export type TelegramPollerLivenessProbe = () => boolean;

/** Publish (or clear, with null) the poller liveness probe. */
export function setTelegramPollerLivenessProbe(probe: TelegramPollerLivenessProbe | null): void {
  (globalThis as Record<string, unknown>)[TELEGRAM_POLLER_LIVENESS_KEY] = probe ?? null;
}

/** Read the published probe (null when telegram has not loaded/published). */
export function getTelegramPollerLivenessProbe(): TelegramPollerLivenessProbe | null {
  const fn = (globalThis as Record<string, unknown>)[TELEGRAM_POLLER_LIVENESS_KEY];
  return typeof fn === "function" ? (fn as TelegramPollerLivenessProbe) : null;
}

/** Poller liveness as known right now. */
export type PollerLiveness = "running" | "stopped" | "unknown";

/**
 * Ask the probe live. "unknown" when the telegram extension has not published
 * a probe (not loaded, pre-publish build) or the probe threw. Consumers treat
 * "unknown" like "stopped": hedge, never assert reachability.
 */
export function readTelegramPollerLiveness(): PollerLiveness {
  const probe = getTelegramPollerLivenessProbe();
  if (!probe) return "unknown";
  try {
    return probe() ? "running" : "stopped";
  } catch {
    return "unknown";
  }
}

/** Clear the slot. Test helper. */
export function resetTelegramPollerLivenessProbe(): void {
  (globalThis as Record<string, unknown>)[TELEGRAM_POLLER_LIVENESS_KEY] = null;
}
