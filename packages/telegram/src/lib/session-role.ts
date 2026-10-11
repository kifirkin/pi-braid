/**
 * Session role marker: which seat this pi session occupies in the braid
 * topology. The orchestrator seat exports BRAID_SESSION_ROLE=worker into a
 * worker's pane before pi starts; the telegram extension reads it at
 * registration time and keeps the poller-ownership surfaces seat-only —
 * Telegram's getUpdates is a per-bot singleton the orchestrator seat owns,
 * so a worker session never registers the poller control or the pull-inbox
 * tool and never starts the poller (telegram_send stays available).
 */

export const ENV_SESSION_ROLE = "BRAID_SESSION_ROLE";

export type SessionRole = "seat" | "worker";

/**
 * Resolve the role from the given env (defaults to the process env). Only
 * the exact value "worker" selects the worker role; unset, "seat", or any
 * other value keeps the seat default, so deployments without the marker are
 * unchanged.
 */
export function resolveSessionRole(
  env: Record<string, string | undefined> = process.env,
): SessionRole {
  return env[ENV_SESSION_ROLE]?.trim().toLowerCase() === "worker"
    ? "worker"
    : "seat";
}

/** Worker-role predicate the extension factory gates on. */
export function isWorkerRole(): boolean {
  return resolveSessionRole() === "worker";
}
