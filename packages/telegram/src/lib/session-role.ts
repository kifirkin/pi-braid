/**
 * Session role marker: which seat this pi session occupies in the braid
 * topology. The orchestrator exports BRAID_SESSION_ROLE=worker into the
 * worker's pane shell before the agent starts; the telegram extension reads it
 * at registration time and returns before registering any surface: a worker
 * reaches the owner through the orchestrator, never through the channel it
 * shares a bot token with. Only the exact value "worker" selects the worker
 * role; unset (or any other value) keeps the seat default, so deployments
 * without the marker are unchanged.
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
