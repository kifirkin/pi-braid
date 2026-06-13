/**
 * Proactive Past Insights - extracted from prompt-builder/index.ts.
 *
 * R6: Surfaces relevant experience from previous sessions to the agent.
 * Uses three-memory-stores (episodes) + session-recall (sessions).
 * Memory confidence threshold: only inject if relevance >= 0.7.
 *
 * Delivery model: WHISPER. The insights are sent once per session as a
 * `context` custom message (steer, no trigger). The agent sees them in
 * the next turn but they do NOT live in the system prompt - this keeps
 * the prompt lean and the insights transient.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sendTrackedMessage } from "../../lib/utils/injection-tracker.js";
import { asyncExists } from "../../lib/utils/async-fs.js";

export interface PastInsight {
  type: "episode" | "session";
  relevance: number;
  content: string;
  source: string;
  project?: string;
}

const MEMORY_DIR = join(homedir(), ".pi", "memory");

/**
 * Derive a project identifier from a cwd path.
 * Returns the last 2 path components.
 */
export function deriveProjectIdFromCwd(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return cwd || "unknown";
  return parts.slice(-2).join("/");
}

/**
 * Check if an episode is eligible for cross-project injection.
 * HaluMem (2511.03506): Only allow cross-project if recent (< 1h) and high-quality (success).
 */
function isCrossProjectInjectionAllowed(
  epProject: string | undefined,
  currentProject: string,
  timestamp: number,
  outcome: string,
): boolean {
  if (!epProject || epProject === currentProject || epProject === "unknown") return true;
  const ageMs = Date.now() - timestamp;
  return ageMs < 3600000 && outcome === "success";
}

/**
 * Search past sessions and episodes for relevant insights.
 */
export async function searchPastInsights(cwd: string): Promise<PastInsight[]> {
  const projectId = deriveProjectIdFromCwd(cwd);
  const insights: PastInsight[] = [];

  // Search three-memory-stores episodes
  if (await asyncExists(MEMORY_DIR)) {
    try {
      const episodeFiles = (await readdir(MEMORY_DIR)).filter((f) => f.startsWith("episodes"));
      for (const file of episodeFiles.slice(0, 3)) {
        const content = await readFile(join(MEMORY_DIR, file), "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        for (const line of lines.slice(-5)) {
          try {
            const ep = JSON.parse(line);
            if (!ep.task || !ep.outcome) continue;
            if (
              !isCrossProjectInjectionAllowed(
                ep.project,
                projectId,
                ep.timestamp ?? Date.now(),
                ep.outcome,
              )
            ) {
              continue;
            }
            insights.push({
              type: "episode",
              project: ep.project || "unknown",
              relevance: 0.75,
              content: `[${ep.outcome}] ${ep.task}: ${ep.solution || "(see logs)"}`,
              source: `episodes:${ep.id}`,
            });
          } catch {
            /* skip malformed */
          }
        }
      }
    } catch {
      /* skip unavailable */
    }
  }

  // Search recent session summaries
  const sessionDir = join(homedir(), ".pi/agent/sessions");
  if (await asyncExists(sessionDir)) {
    try {
      const sessions = (await readdir(sessionDir))
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse()
        .slice(0, 3);

      for (const session of sessions) {
        const content = await readFile(join(sessionDir, session), "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        for (const line of lines.slice(-3)) {
          try {
            const entry = JSON.parse(line);
            if (
              entry.message &&
              (String(entry.message).includes("finalize") ||
                String(entry.message).includes("completed"))
            ) {
              const task = extractTaskFromEntry(entry as Record<string, unknown>);
              if (task) {
                insights.push({
                  type: "session",
                  project: "unknown",
                  relevance: 0.7,
                  content: `Session: ${task}`,
                  source: `session:${session}`,
                });
              }
            }
          } catch {
            /* skip malformed */
          }
        }
      }
    } catch {
      /* skip unavailable */
    }
  }

  return insights.filter((i) => i.relevance >= 0.7).slice(0, 5);
}

function extractTaskFromEntry(entry: Record<string, unknown>): string | null {
  const msg = String(entry.message || "");
  const patterns = [/told to ([^.]{10,80})/i, /task: ([^.]{10,80})/i, /completed: ([^.]{10,80})/i];
  for (const pattern of patterns) {
    const match = msg.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Filter out insights whose content is just metrics (no actionable signal).
 * Returns "" if no insights have signal, or the rendered section if any do.
 */
function renderInsightsAsSection(insights: PastInsight[]): string {
  if (insights.length === 0) return "";

  const hasSignal = (content: string): boolean => {
    const metricsOnly = /^(\[\w+\]\s*)?(session_outcome|outcome):\s*\w+/i;
    if (metricsOnly.test(content.trim())) return false;
    if (content.trim().length < 15) return false;
    return true;
  };

  const filtered = insights.filter((i) => hasSignal(i.content));
  if (filtered.length === 0) return "";

  // Preserve the leading blank line from the original lines-based impl
  // so the whisper text matches the section format the agent used to see.
  const lines = [
    "",
    "## Past Insights",
    "*(Relevant experience from previous sessions)*",
    ...filtered.map((insight) => `- ${insight.content}`),
  ];
  return lines.join("\n");
}

/**
 * Deliver past insights as a whisper (once per session).
 * Best-effort: any failure (missing dirs, malformed JSON) is swallowed.
 */
export async function deliverPastInsights(
  cwd: string,
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
): Promise<void> {
  let insights: PastInsight[];
  try {
    insights = await searchPastInsights(cwd);
  } catch {
    return;
  }

  const text = renderInsightsAsSection(insights);
  if (!text) return;

  try {
    sendTrackedMessage(
      pi,
      {
        customType: "context",
        display: true,
        content: [{ type: "text" as const, text }],
      },
      { deliverAs: "steer", triggerTurn: false },
      { type: "memory", source: "prompt-builder/insights" },
    );
  } catch {
    // Non-fatal: steer message send is best-effort
  }
}
