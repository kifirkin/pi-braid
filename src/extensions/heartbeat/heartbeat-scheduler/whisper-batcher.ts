/**
 * Whisper batcher for heartbeat ticks.
 *
 * During a heartbeat tick, multiple cognitive modules may want to
 * whisper to the agent. If we just forward them through ctx.whisper,
 * the agent gets N separate messages -- which is both noisy and
 * expensive (each message becomes a turn boundary in the agent's
 * context).
 *
 * The batcher intercepts the whisper call during the tick, buffers
 * messages grouped by priority, and flushes them as aggregated
 * messages per priority tier. High-priority messages flush first.
 *
 * Extracted from index.ts (was 25 lines inline) for testability and
 * to keep the orchestrator focused on coordination, not formatting.
 */

export interface WhisperBufferEntry {
  message: string;
  priority: string;
}

export type WhisperSendFn = (
  msg: string,
  opts?: { category?: string; priority?: string },
) => void;

/**
 * Flush batched whispers: group by priority tier, concatenate per tier,
 * and send as aggregated messages. This prevents N separate injected
 * messages per heartbeat tick when multiple modules activate.
 */
export function flushWhisperBuffer(
  buffer: WhisperBufferEntry[],
  send: WhisperSendFn | undefined,
): void {
  if (buffer.length === 0 || !send) return;

  // Group by priority
  const groups = new Map<string, string[]>();
  for (const entry of buffer) {
    const p = entry.priority;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p)!.push(entry.message);
  }

  // Flush one message per priority tier
  for (const [priority, messages] of groups) {
    if (messages.length === 1) {
      send(messages[0], { category: "cognitive", priority: priority });
    } else {
      const combined = `[Heartbeat Summary]
${messages.map((m, i) => `${i + 1}. ${m}`).join("\n")}`;
      send(combined, { category: "cognitive", priority: priority });
    }
  }
}
