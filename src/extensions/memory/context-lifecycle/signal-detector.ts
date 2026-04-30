import { createLogger } from "../../../lib/logger.js";

const log = createLogger("context-lifecycle");
/**
 * Signal Detector - Analyzes session content for semantic signals
 *
 * Reads from SessionManager to detect:
 * - Topic shifts (keyword analysis)
 * - Redundancy (content hashing)
 * - Task boundaries (tool patterns)
 * - Context pressure (usage metrics)
 */

import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type { SemanticSignal, SemanticSignalType } from "./types.js";
import { createSignal } from "./types.js";

// ── Content Analysis ────────────────────────────────────────────────────────

function extractTextContent(entry: SessionEntry): string {
  if (entry.type !== "message") return "";
  const msg = (
    entry as unknown as {
      message?: { content?: string | Array<{ type?: string; text?: string; name?: string }> };
    }
  ).message;
  if (!msg?.content) return "";
  const content = msg.content;

  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "object" && p !== null) {
          if (p.type === "text") return p.text ?? "";
          if (p.type === "toolCall") return `[tool: ${p.name}]`;
        }
        return "";
      })
      .join(" ");
  }
  return "";
}

function hashContent(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// ── Topic Detection ─────────────────────────────────────────────────────────

const TOPIC_KEYWORDS: Record<string, Set<string>> = {
  implementation: new Set(["implement", "write", "create", "add", "build", "code", "function"]),
  debugging: new Set(["bug", "fix", "error", "crash", "debug", "issue", "broken"]),
  refactoring: new Set(["refactor", "rename", "restructure", "clean", "improve"]),
  testing: new Set(["test", "spec", "verify", "assert", "coverage"]),
  exploration: new Set(["explore", "find", "search", "grep", "read", "discover"]),
  documentation: new Set(["doc", "comment", "readme", "explain", "describe"]),
  planning: new Set(["plan", "design", "architecture", "approach", "strategy"]),
  verification: new Set(["verify", "check", "validate", "confirm"]),
};

function detectTopic(text: string): string {
  const lower = text.toLowerCase();
  let bestTopic = "general";
  let bestScore = 0;

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (lower.includes(keyword)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestTopic = topic;
    }
  }

  return bestScore > 0 ? bestTopic : "general";
}

// ── Signal Detector ─────────────────────────────────────────────────────────

export class SignalDetector {
  private lastTopic = "";
  private lastTopicTurn = 0;
  private topicHistory: Array<{ topic: string; turn: number }> = [];
  private recentHashes = new Map<string, number>(); // hash → first seen turn
  private toolSequence: string[] = [];
  private lastTurn = 0;
  private pendingSignals: SemanticSignal[] = [];
  private contextUsage = 0;
  private entryCount = 0;

  /** Update from SessionManager entries */
  update(entries: SessionEntry[], contextUsage = 0): SemanticSignal[] {
    const signals: SemanticSignal[] = [];
    const newEntryCount = entries.length;

    // ── Session navigation detection ──────────────────────────────────
    // If entry count drops sharply vs previous run, the session was
    // restructured (/tree edit, /new, fork). Auto-reset to prevent stale
    // topic/entry tracking from contaminating the new session.
    if (this.entryCount > 0 && newEntryCount < this.entryCount - 2) {
      log.warn(`Session navigation detected: ${this.entryCount} → ${newEntryCount} entries, resetting`);
      this.reset();
    }

    // Detect only new entries
    if (newEntryCount <= this.entryCount) {
      this.contextUsage = contextUsage;
      this.entryCount = newEntryCount;
      signals.push(...this.pendingSignals);
      this.pendingSignals = [];
      return signals;
    }

    const newEntries = entries.slice(this.entryCount);
    this.entryCount = newEntryCount;
    this.contextUsage = contextUsage;

    // Advance turn counter for this batch
    this.lastTurn++;
    const turn = this.lastTurn;
    const allText: string[] = [];
    const hashes: string[] = [];
    const toolCalls: string[] = [];

    for (const entry of newEntries) {
      const text = extractTextContent(entry);
      if (text) {
        allText.push(text);
        hashes.push(hashContent(text));
      }

      // Track tool calls
      if (entry.type === "message") {
        const msg = (
          entry as unknown as {
            message?: {
              role?: string;
              toolName?: string;
              content?: Array<{ type?: string; name?: string }>;
            };
          }
        ).message;
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type === "toolCall" && block?.name) {
              toolCalls.push(block.name);
            }
          }
        }
        if (msg?.role === "toolResult" && msg?.toolName) {
          toolCalls.push(msg.toolName);
        }
      }
    }

    // ── Redundancy detection ─────────────────────────────────────────────
    let redundancyCount = 0;
    for (const h of hashes) {
      if (this.recentHashes.has(h)) {
        redundancyCount++;
      } else {
        // Keep last 100 hashes
        if (this.recentHashes.size >= 100) {
          const oldest = Array.from(this.recentHashes.entries())
            .sort((a, b) => a[1] - b[1])
            .slice(0, 10);
          for (const [k] of oldest) this.recentHashes.delete(k);
        }
        this.recentHashes.set(h, turn);
      }
    }
    if (redundancyCount >= 2) {
      signals.push(createSignal("redundancy_detected", turn, { count: redundancyCount }));
    }

    // ── Topic shift detection ───────────────────────────────────────────
    const combinedText = allText.join(" ");
    const currentTopic = detectTopic(combinedText);
    if (currentTopic !== this.lastTopic && this.lastTopic !== "") {
      signals.push(
        createSignal("topic_shift", turn, {
          from: this.lastTopic,
          to: currentTopic,
        }),
      );
      this.topicHistory.push({ topic: currentTopic, turn });
      if (this.topicHistory.length > 20) {
        this.topicHistory = this.topicHistory.slice(-20);
      }
    }
    this.lastTopic = currentTopic;

    // ── Tool sequence pattern ───────────────────────────────────────────
    // ── Context pressure ───────────────────────────────────────────────
    if (contextUsage >= 85) {
      signals.push(createSignal("context_pressure", turn, { percent: contextUsage }));
    } else if (contextUsage >= 70) {
      signals.push(createSignal("context_pressure", turn, { percent: contextUsage }));
    }

    // ── Task boundary ──────────────────────────────────────────────────
    // Detect task boundaries via tool patterns: explore → implement → verify
    if (this.toolSequence.length >= 3) {
      const last3 = this.toolSequence.slice(-3);
      const hasExplore = ["grep", "read", "bash", "find", "analyze_image"].some((t) =>
        last3.includes(t),
      );
      const hasImplement = ["write", "edit"].some((t) => last3.includes(t));
      const hasVerify = ["bash", "test", "verify"].some((t) => last3.includes(t));

      if (hasExplore && hasImplement && hasVerify) {
        signals.push(createSignal("task_boundary", turn, { pattern: last3 }));
      }
    }

    // Flush pending
    signals.push(...this.pendingSignals);
    this.pendingSignals = [];

    return signals;
  }

  /** Add a manual signal */
  queueSignal(type: SemanticSignalType, data: Record<string, unknown> = {}): void {
    this.pendingSignals.push(createSignal(type, this.lastTurn, data));
  }

  /** Get pending signals */
  getPending(): SemanticSignal[] {
    return [...this.pendingSignals];
  }

  /** Get topic history */
  getTopicHistory(): Array<{ topic: string; turn: number }> {
    return [...this.topicHistory];
  }

  /** Check if session looks like task completion pattern
   * Used by context-lifecycle to suggest finalize when appropriate
   */
  detectCompletionPattern(): boolean {
    // Task boundary detected (explore → implement → verify)
    const hasTaskBoundary = this.topicHistory.length >= 2;

    // Low redundancy = no repeated work
    const lowRedundancy = this.recentHashes.size > 5;

    // Has verification tools (meaning work was validated)
    const hasVerification = this.toolSequence.some((t) =>
      ["bash", "test", "verify", "repl"].includes(t),
    );

    // Diverse tool usage (not stuck in one pattern)
    const uniqueTools = new Set(this.toolSequence.slice(-10)).size;
    const diverseTools = uniqueTools >= 4;

    return hasTaskBoundary && lowRedundancy && hasVerification && diverseTools;
  }

  /** Emit completion candidate signal if pattern detected */
  checkAndEmitCompletionSignal(): void {
    if (this.detectCompletionPattern()) {
      this.pendingSignals.push(
        createSignal("task_completion_candidate", this.lastTurn, {
          topicHistory: this.topicHistory.slice(-3),
          uniqueTools: new Set(this.toolSequence.slice(-10)).size,
        }),
      );
    }
  }

  /** Reset state */
  reset(): void {
    this.lastTopic = "";
    this.lastTopicTurn = 0;
    this.topicHistory = [];
    this.recentHashes.clear();
    this.toolSequence = [];
    this.lastTurn = 0;
    this.pendingSignals = [];
    this.contextUsage = 0;
    this.entryCount = 0;
  }
}
