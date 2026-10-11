/**
 * Auto-recall whisper - delivers relevant past episodes as a whisper
 * when the agent is working on something related.
 *
 * This is the core "memory surfaces to agent" loop.
 *
 * Behavior contract:
 *   - AUTO_RECALL_ENABLED: master switch (default true)
 *   - RECALL_COOLDOWN_MS: 120s
 *   - Cross-session episodes: filtered unless similarity > 0.6
 *   - Deduplication: skip if same title + episode IDs as last emission
 *   - Contamination signal: emitted to bus when cross-session episodes
 *     appear (so enforcement can surface the concern)
 *
 * The function is called from tool_result and turn_end handlers when
 * they detect relevant work. It's co-located with three-memory-stores
 * (not moved to lib) because it depends on `MemoryStoresState` shape.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Episode, MemoryStoresState, RichEpisode } from "../types.js";
import { sendTrackedMessage } from "../../../../lib/utils/injection-tracker.js";
import { fenceMemoryContext } from "../../../../lib/utils/memory-fence.js";
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
  currentProject?: string,
): void {
  if (!AUTO_RECALL_ENABLED || episodes.length === 0) return;

  // Filter out cross-session episodes from auto-whisper unless highly relevant (>0.75)
  // Episode doesn't declare _crossSession; RichEpisode does. The cast
  // narrows to RichEpisode for the similarity check.
  let filtered = episodes.filter((ep) => {
    const rich = ep as RichEpisode;
    if (!rich._crossSession) return true;
    return rich.similarity > 0.75;
  });

  // Filter out cross-project episodes from auto-whisper unless highly relevant (>0.6)
  // This parallels the cross-session policy but uses a slightly lower threshold
  // since project boundaries are weaker than session boundaries.
  if (currentProject) {
    filtered = filtered.filter((ep) => {
      if (!ep.project || ep.project === currentProject) return true;
      return ep.similarity > 0.6;
    });
  }

  // Never whisper a placeholder-task episode. Episodes written
  // with the "session_outcome" sentinel (heartbeat fallback when _event.task
  // is absent) carry no actionable signal — skip them at whisper time so
  // already-persisted junk stops surfacing as "[ok] session_outcome".
  filtered = filtered.filter((ep) => ep.task && !/^session_outcome$/i.test(ep.task.trim()));
  if (filtered.length === 0) return;

  const now = Date.now();
  if (now - state.lastRecallTime < RECALL_COOLDOWN_MS) return;
  state.lastRecallTime = now;

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

  const lines: string[] = [title];
  for (const ep of filtered.slice(0, 2) as Episode[]) {
    const icon = ep.outcome === "success" ? "[ok]" : ep.outcome === "failure" ? "[fail]" : "[warn]";
    const _richEp = ep as RichEpisode;
    const crossMark = _richEp._crossSession ? " [CROSS-SESSION]" : "";
    // THREE-MEMORY-STORE RECALL FIX: cross-project episodes that pass the
    // clearly-valuable bar must be LABELED as cross-project, not presented
    // as if they belonged to the current project.
    const projectMark = (ep as RichEpisode & { _crossProject?: boolean })._crossProject
      ? " [CROSS-PROJECT]"
      : "";
    const conf =
      _richEp.memoryConfidence != null
        ? ` (conf ${(_richEp.memoryConfidence * 100).toFixed(0)}%)`
        : "";
    // Whisper truncation fix: render-side caps raised
    // (task 80→120, solution 300→600) with explicit ellipsis on the
    // solution line, plus a retrieval handle so the receiving agent can
    // fetch the full episode via memory recall_get. Mirrors the bounded
    // pattern in memory-agent-bridge/memory-tool.ts. Episode text itself
    // is stored full (write path is clean) — this is render-only.
    const taskTruncated = ep.task.length > 120;
    const solutionTruncated = ep.solution.length > 600;
    lines.push(`  ${icon}${crossMark}${projectMark}${conf} ${ep.task.slice(0, 120)}`);
    lines.push(`    Solution: ${ep.solution.slice(0, 600)}${solutionTruncated ? "…" : ""}`);
    if (taskTruncated || solutionTruncated) {
      lines.push(`    (id: ${ep.id} — memory recall_get for full text)`);
    }
  }

  sendTrackedMessage(
    pi,
    {
      customType: "memory",
      display: true,
      // Recalled episode text is fenced non-user context.
      content: [{ type: "text", text: fenceMemoryContext(lines.join("\n")) }],
    },
    { delivery: "park", deliverAs: "steer" },
    { type: "memory", source: "three-memory-stores/recall" },
  );
}
