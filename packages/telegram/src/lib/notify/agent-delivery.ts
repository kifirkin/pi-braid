/**
 * Agent-delivered report flag — the telegram_send ↔ live-update seam.
 *
 * Live-update's finish() sends its OWN separate turn-end summary. When the
 * AGENT already delivered an explicit report via telegram_send during the
 * turn, that auto summary duplicates it (two similar messages,
 * one raw/unformatted). This module is the tiny process-local flag the send
 * path sets and the live-update resolver reads + clears at the turn boundary.
 *
 * Process-local only (no persistence, no IPC): both sides run in the same
 * extension process. The flag is intentionally dumb — no timestamps, no
 * counting — a successful explicit delivery is all finish() needs to know.
 */
let agentDeliveredFlag = false;

/** Record that the agent explicitly delivered a Telegram message this turn. */
export function markAgentDeliveredMessage(): void {
  agentDeliveredFlag = true;
}

/** Clear the flag (fresh turn boundary). Idempotent. */
export function clearAgentDeliveredMessage(): void {
  agentDeliveredFlag = false;
}

/** True when the agent sent an explicit Telegram message this turn. */
export function wasAgentDeliveredMessage(): boolean {
  return agentDeliveredFlag;
}
