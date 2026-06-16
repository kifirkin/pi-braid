/**
 * Auto-recall whisper - delivers relevant past episodes as a whisper
 * when the agent is working on something related.
 *
 * Extracted from index.ts to keep the main extension function focused
 * on event registration. This is the core "memory surfaces to agent"
 * loop.
 *
 * Behavior contract:
 *   - AUTO_RECALL_ENABLED: master switch (default true)
 *   - RECALL_COOLDOWN_MS: 120s (raised from 30s to reduce flooding)
 *   - Cross-session episodes: filtered unless similarity > 0.6
 *   - Deduplication: skip if same title + episode IDs as last emission
 *   - Contamination signal: emitted to bus when cross-session episodes
 *     appear (so enforcement can surface the concern)
 *
 * The function is called from tool_result and turn_end handlers when
 * they detect relevant work. It's co-located with three-memory-stores
 * (not moved to lib/) because it depends on `MemoryStoresState` shape.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Episode, MemoryStoresState, RichEpisode } from "../types.js";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import { emitSignal } from "../../../../lib/reasoning/belief-policy-engine.js";

const AUTO_RECALL_ENABLED = true;
const RECALL_COOLDOWN_MS = 120_000;

// Re-export for the turn_end handler which also gates on these.
export { AUTO_RECALL_ENABLED, RECALL_COOLDOWN_MS };

export function whisperRecall(
  state: MemoryStoresState,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  title: string,
  episodes: Episode[],
): void {
  if (!AUTO_RECALL_ENABLED || episodes.length === 0) return;

  // Filter out cross-session episodes from auto-whisper unless highly relevant (>0.6)
  // Episode doesn't declare _crossSession; RichEpisode does. The cast
  // narrows to RichEpisode for the similarity check.
  const filtered = episodes.filter((ep) => {
    const rich = ep as RichEpisode;
    if (!rich._crossSession) return true;
    return rich.similarity > 0.6;
  });
  if (filtered.length === 0) return;

  const now = Date.now();
  if (now - state.lastRecallTime < RECALL_COOLDOWN_MS) return;
  state.lastRecallTime = now;

  // Deduplicate: skip if same title + episodes as last emission
  const signature = `${title}|${filtered
    .slice(0, 2)
    .map((ep: Episode) => ep.id)
    .join("|")}`;
  if (signature === state.lastEpisodeRecallSignature) return;
  state.lastEpisodeRecallSignature = signature;

  const crossSession = filtered.filter((ep) => (ep as RichEpisode)._crossSession);
  // Only emit contamination signal for repeated cross-session - batch per session
  if (crossSession.length > 0 && state.recentErrors.length < 10) {
    emitSignal(ctx, "memory", "contamination", "warn", false, {
      count: crossSession.length,
      sessionIds: crossSession
        .map((ep) => (ep as RichEpisode & { sessionId?: string }).sessionId)
        .filter(Boolean)
        .slice(0, 3),
    });
  }

  const lines: string[] = [`[recall] ${title}`];
  for (const ep of filtered.slice(0, 2) as Episode[]) {
    const icon = ep.outcome === "success" ? "✅" : ep.outcome === "failure" ? "❌" : "⚠️";
    const _richEp = ep as RichEpisode;
    const crossMark = _richEp._crossSession ? " [CROSS-SESSION]" : "";
    const conf =
      _richEp.memoryConfidence != null
        ? ` (conf ${(_richEp.memoryConfidence * 100).toFixed(0)}%)`
        : "";
    lines.push(`  ${icon}${crossMark}${conf} ${ep.task.slice(0, 80)}`);
    lines.push(`    Solution: ${ep.solution.slice(0, 300)}`);
  }

  sendTrackedMessage(
    pi,
    {
      customType: "memory",
      display: true,
      content: [{ type: "text", text: lines.join("\n") }],
    },
    { deliverAs: "steer", triggerTurn: false },
    { type: "memory", source: "three-memory-stores/recall" },
  );
}
