/**
 * Proactive Past Insights - extracted from prompt-builder/index.ts.
 *
 * R6: Injects relevant experience from previous sessions into prompt.
 * Uses three-memory-stores (episodes) + session-recall (sessions).
 * Memory confidence threshold: only inject if relevance >= 0.7.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { stat, readdir, readFile } from "node:fs/promises";

/** Async helper: check if a path exists. */
async function asyncExists(p: string): Promise<boolean> {
  return stat(p)
    .then(() => true)
    .catch(() => false);
}

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
/** Derive project identifier from cwd - exported for main prompt builder. */
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
  const memoryDir = MEMORY_DIR;
  if (await asyncExists(memoryDir)) {
    try {
      const episodeFiles = (await readdir(memoryDir)).filter((f) => f.startsWith("episodes"));
      for (const file of episodeFiles.slice(0, 3)) {
        const content = await readFile(join(memoryDir, file), "utf-8");
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

export function formatPastInsightsSection(insights: PastInsight[]): string {
  if (insights.length === 0) return "";

  const hasSignal = (content: string): boolean => {
    const metricsOnly = /^(\[\w+\]\s*)?(session_outcome|outcome):\s*\w+/i;
    if (metricsOnly.test(content.trim())) return false;
    if (content.trim().length < 15) return false;
    return true;
  };

  const filtered = insights.filter((i) => hasSignal(i.content));
  if (filtered.length === 0) return "";

  const lines: string[] = [
    "",
    "## Past Insights",
    "*(Relevant experience from previous sessions)*",
  ];
  for (const insight of filtered) {
    lines.push(`- ${insight.content}`);
  }
  return lines.join("\n");
}
