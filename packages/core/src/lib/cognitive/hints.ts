/**
 * Consolidated hints pipeline.
 *
 * Loads hints from the consolidated-hints.jsonl file, filters by
 * utility-model relevance, and delivers the relevant ones as
 * per-hint whispers. All work is best-effort: any failure is swallowed
 * because hints are supplemental and should never block the main prompt.
 *
 * Delivery model: WHISPER. Each relevant hint is sent as a separate
 * `hint` custom message (steer, no trigger). The agent sees them in
 * the next turn but they do NOT live in the system prompt.
 *
 * Cross-project deprioritization (matches episodic memory policy in
 * `three-memory-stores`): same-project hints are kept; cross-project
 * hints must score >= 80 to be considered.
 *
 * Heuristic fallback: if the LLM tier is unavailable, a small regex-based
 * filter rejects obviously-generic patterns. Semantic matching is left
 * to the LLM tier - keyword-overlap scoring (Jaccard) produces too many
 * false positives and false negatives, so it is not used.
 */

import { stat, readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { consolidatedHintsFilePath } from "../config/braid-paths.js";
import { sendTrackedMessage } from "../utils/injection-tracker.js";
import { fenceMemoryContext } from "../utils/memory-fence.js";
import { classify } from "../ai/text-classifier.js";
import { CRITICS } from "../ai/critic-registry.js";
import { deriveProjectIdFromCwd } from "../memory/past-insights.js";
import { HINT_MAX_AGE_MS } from "../constants/session-thresholds.js";

/** Async helper: check if a path exists. */
async function asyncExists(p: string): Promise<boolean> {
  return stat(p)
    .then(() => true)
    .catch(() => false);
}

interface ParsedHint {
  task?: string;
  steps?: string[];
  createdAt?: number;
  score?: number;
  project?: string;
  strategy?: string;
}

/**
 * Load and dedup hints from the consolidated-hints file. Same-project
 * hints are preferred; cross-project hints must score >= 80.
 */
async function loadConsolidatedHints(currentProject?: string): Promise<string[]> {
  try {
    if (!(await asyncExists(consolidatedHintsFilePath()))) return [];
    const content = await readFile(consolidatedHintsFilePath(), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return [];

    const now = Date.now();
    const parsed = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((h): h is ParsedHint => h !== null)
      .filter((h) => h.steps && h.steps.length > 0)
      .filter((h) => now - (h.createdAt ?? 0) < HINT_MAX_AGE_MS);

    if (parsed.length === 0) return [];

    const sameProject = currentProject
      ? parsed.filter(
          (h) =>
            !h.project ||
            h.project === currentProject ||
            // Unknown-project hints must score >= 80 to avoid generic noise
            // (e.g. "session_outcome" with generic steps). Same-project hints
            // have no score threshold — they're contextually relevant.
            (h.project === "unknown" && (h.score ?? 0) >= 80),
        )
      : parsed;
    const crossProject = currentProject
      ? parsed.filter(
          (h) =>
            h.project &&
            h.project !== currentProject &&
            h.project !== "unknown" &&
            (h.score ?? 0) >= 80,
        )
      : [];
    const candidates = [...sameProject, ...crossProject];

    const byTask = new Map<string, ParsedHint>();
    for (const h of candidates) {
      const key = h.task ?? "";
      const existing = byTask.get(key);
      if (!existing || (h.createdAt ?? 0) > (existing.createdAt ?? 0)) {
        byTask.set(key, h);
      }
    }
    const deduped = Array.from(byTask.values())
      .filter((h) => h.createdAt != null)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

    // Render the strategy/task description rather than the raw steps (often
    // generic tool names): the task field carries the high-level summary
    // from consolidation.
    return deduped.slice(-3).map((h) => {
      const task = (h.task ?? "").slice(0, 120);
      const strategy = (h.strategy ?? "").slice(0, 200);
      // Prefer the strategy field (richer prose) over the raw steps list
      if (strategy && strategy.length > task.length) {
        return `When working on "${task}": ${strategy}`;
      }
      const steps = (h.steps as string[]).slice(0, 3).join(" -> ");
      return `When working on "${task}": ${steps}`;
    });
  } catch {
    return [];
  }
}

/**
 * Extract the current task from the session - the most recent user message.
 * Returns a short summary, max 500 chars.
 */
function getCurrentTask(ctx: ExtensionContext): string {
  try {
    const sm = ctx.sessionManager;
    if (!sm || typeof sm.getBranch !== "function") return "";
    const branch = sm.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === "message" && entry.message?.role === "user") {
        const content = entry.message.content;
        let text = "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          text = content
            .filter((c: unknown) => {
              if (typeof c !== "object" || c === null) return false;
              return (c as { type?: unknown }).type === "text";
            })
            .map((c: unknown) => {
              if (typeof c !== "object" || c === null) return "";
              return (c as { text?: unknown }).text || "";
            })
            .join(" ");
        }
        return text.trim().slice(0, 500);
      }
    }
  } catch {
    // Non-fatal: empty current task means the relevance check rejects all hints,
    // which is the safe default.
  }
  return "";
}

/**
 * Heuristic fallback (Tier 1 graceful degradation).
 * Only the obviously-generic patterns are rejected here. The semantic
 * matching is left to the LLM tier.
 */
function hintRelevanceFallback(hint: string, _currentTask: string): string {
  if (hint.length < 30) return "no";
  if (/Fix \w+ error:/.test(hint)) return "no";
  if (/Debug.*isolate/.test(hint)) return "no";
  if (/Reproduce.*Locate.*Apply/.test(hint)) return "no";
  return "yes";
}

/**
 * Filter hints by relevance using the utility model.
 * Returns only hints classified as relevant to the current session.
 */
async function filterRelevantHints(hints: string[], ctx: ExtensionContext): Promise<string[]> {
  const currentTask = getCurrentTask(ctx);
  // Empty current task -> reject all hints. Better to surface nothing
  // than to inject a hint that has no task to be relevant to.
  if (!currentTask) return [];

  const results = await Promise.allSettled(
    hints.map((hint) =>
      classify(
        ctx,
        CRITICS.hintRelevance.criteria,
        { hint, currentTask },
        {
          timeoutMs: 60_000,
          // Q9 B-class: prefer-heuristic runs the regex fallback first
          // (fast path for obvious rejections), but if it returns "yes",
          // the utility model verifies — rejecting generic hints that the
          // permissive regex would otherwise let through.
          fallback: () => hintRelevanceFallback(hint, currentTask),
          tierPolicy: "prefer-heuristic",
        },
      ),
    ),
  );

  return hints.filter((_, i) => {
    const r = results[i];
    return r.status === "fulfilled" && r.value.label === "yes";
  });
}

/**
 * Deliver relevant hints as whispers (one whisper per relevant hint).
 * Best-effort: any failure (missing file, LLM timeout, send error) is swallowed.
 *
 * Pass `pi`, `ctx` and the current working directory. The function:
 *  1. Loads hints from the consolidated-hints file.
 *  2. Filters by utility-model relevance against the current task.
 *  3. Sends each relevant hint as a separate `hint` custom message.
 */
export async function deliverRelevantHints(
  cwd: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const projectId = deriveProjectIdFromCwd(cwd);
  const allHints = await loadConsolidatedHints(projectId);
  if (allHints.length === 0) return;

  let relevantHints: string[];
  try {
    relevantHints = await filterRelevantHints(allHints, ctx);
  } catch {
    return;
  }

  for (const hint of relevantHints) {
    try {
      sendTrackedMessage(
        pi,
        {
          customType: "hint",
          display: true,
          // Recalled consolidated hints are fenced non-user context.
          content: [{ type: "text" as const, text: fenceMemoryContext(`[hint] ${hint}`) }],
        },
        { delivery: "park", deliverAs: "steer" },
        { type: "memory", source: "prompt-builder/hint" },
      );
    } catch {
      // Non-fatal: hint delivery is best-effort
    }
  }
}
