/**
 * Weakness Miner - clusters failure signatures by similarity to identify
 * systemic weakness patterns.
 *
 * Clustering strategy (inspired by Opik's test-suite-from-traces approach):
 *   1. Group by type: tool-loop, error-burst, turn-failure, etc.
 *   2. Within same type, group by tool name (for tool-loops) or
 *      error message prefix (for errors)
 *   3. A cluster becomes "actionable" when frequency >= 3
 *   4. Severity is computed from frequency, average count, and recency
 *
 * The miner is a pure function: given failure signatures, it returns clusters.
 * No side effects, no state mutation. The caller (heartbeat module) handles
 * persistence and notification.
 */

import { nextId } from "../utils/id.js";
import type {
  FailureSignature,
  WeaknessCluster,
  FailureSignatureType,
  HarnessTargetSurface,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum signatures in a cluster for it to be actionable. */
const MIN_CLUSTER_SIZE = 3;

/** Maximum age of a signature (in turns) to be considered recent. */
const MAX_RECENT_TURNS = 50;

// ── Surface Mapping ──────────────────────────────────────────────────────────

/**
 * Map failure types to the most likely editable surface.
 * This is a heuristic; the actual surface may differ.
 */
function suggestSurface(type: FailureSignatureType): HarnessTargetSurface {
  switch (type) {
    case "tool-loop":
      return "enforcement-signal";
    case "error-burst":
      return "heuristic";
    case "turn-failure":
      return "system-prompt";
    case "degradation":
      return "heuristic";
    case "validation-failure":
      return "tool-description";
  }
}

// ── Label Generation ─────────────────────────────────────────────────────────

/**
 * Generate a human-readable label for a cluster based on its signatures.
 */
function generateLabel(
  type: FailureSignatureType,
  toolName?: string,
  errorPrefix?: string,
): string {
  switch (type) {
    case "tool-loop":
      return `repetitive-${toolName ?? "tool"}-loop`;
    case "error-burst":
      return `error-burst-${errorPrefix ?? "general"}`;
    case "turn-failure":
      return `turn-failure-${toolName ?? "unknown"}`;
    case "degradation":
      return `degradation-${toolName ?? "general"}`;
    case "validation-failure":
      return `validation-failure-chain`;
  }
}

// ── Severity Computation ─────────────────────────────────────────────────────

/**
 * Compute severity (0-1) for a cluster based on:
 * - Frequency (more occurrences = higher severity)
 * - Average count (higher counts per event = higher severity)
 * - Recency (events in recent turns = higher severity)
 */
function computeSeverity(signatures: FailureSignature[], currentTurn: number): number {
  if (signatures.length === 0) return 0;

  const frequency = Math.min(signatures.length / 10, 1); // caps at 10+ entries
  const avgCount = signatures.reduce((sum, s) => sum + s.count, 0) / signatures.length;
  const countFactor = Math.min(avgCount / 10, 1); // caps at 10 avg count
  const recentCount = signatures.filter((s) => currentTurn - s.turn <= MAX_RECENT_TURNS).length;
  const recencyFactor = Math.min(recentCount / signatures.length, 1);

  // Weighted average: frequency (0.4), count (0.3), recency (0.3)
  return Math.min(frequency * 0.4 + countFactor * 0.3 + recencyFactor * 0.3, 1);
}

// ── Clustering ───────────────────────────────────────────────────────────────

/**
 * Group failure signatures by type and tool/error prefix.
 * Returns a map of group key → signatures.
 */
function groupBySimilarity(signatures: FailureSignature[]): Map<string, FailureSignature[]> {
  const groups = new Map<string, FailureSignature[]>();

  for (const sig of signatures) {
    const key = `${sig.type}:${sig.toolName ?? sig.errorPrefix ?? "unknown"}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(sig);
  }

  return groups;
}

// ── Main Mining Function ────────────────────────────────────────────────────

/**
 * Mine weakness clusters from a collection of failure signatures.
 *
 * @param signatures - All collected failure signatures
 * @param currentTurn - Current turn number (for recency computation)
 * @returns Array of weakness clusters, sorted by severity (highest first)
 */
export function mineWeaknesses(
  signatures: FailureSignature[],
  currentTurn: number,
): WeaknessCluster[] {
  if (signatures.length === 0) return [];

  const groups = groupBySimilarity(signatures);
  const clusters: WeaknessCluster[] = [];

  for (const [, groupSignatures] of groups) {
    // Only consider groups with enough signatures
    if (groupSignatures.length < MIN_CLUSTER_SIZE) continue;

    const first = groupSignatures[0];
    const last = groupSignatures[groupSignatures.length - 1];

    const cluster: WeaknessCluster = {
      id: nextId("wcl"),
      label: generateLabel(first.type, first.toolName, first.errorPrefix),
      type: first.type,
      signatures: groupSignatures,
      frequency: groupSignatures.length,
      severity: computeSeverity(groupSignatures, currentTurn),
      suggestedSurface: suggestSurface(first.type),
      firstSeen: first.turn,
      lastSeen: last.turn,
    };

    clusters.push(cluster);
  }

  clusters.sort((a, b) => b.severity - a.severity);

  return clusters;
}

// ── Summary Generation ───────────────────────────────────────────────────────

/**
 * Generate a human-readable summary of weakness clusters for a whisper.
 */
export function summarizeClusters(clusters: WeaknessCluster[]): string {
  if (clusters.length === 0) {
    return "No actionable weaknesses detected.";
  }

  const actionable = clusters.filter((c) => c.severity >= 0.5);
  const lines: string[] = [];

  lines.push(`## Self-Harness: Weakness Analysis`);
  lines.push(`Found ${clusters.length} weakness cluster(s), ${actionable.length} actionable:`);
  lines.push("");

  for (const cluster of clusters) {
    const severityBar = severityToBar(cluster.severity);
    const actionableTag = cluster.severity >= 0.5 ? "⚠️" : "ℹ️";
    lines.push(
      `${actionableTag} **${cluster.label}** ${severityBar} ` +
        `(${cluster.frequency}x, severity ${cluster.severity.toFixed(2)})`,
    );
    lines.push(`   Surface: \`${cluster.suggestedSurface}\``);
    lines.push(`   Span: turns ${cluster.firstSeen}–${cluster.lastSeen}`);
    lines.push("");
  }

  if (actionable.length > 0) {
    lines.push("**Actionable clusters** (severity ≥ 0.5) — suggested target surfaces:");
    for (const cluster of actionable) {
      lines.push(`  - \`${cluster.label}\` → target \`${cluster.suggestedSurface}\``);
    }
  }

  return lines.join("\n");
}

/**
 * Convert a severity value (0-1) to a text bar representation.
 */
function severityToBar(severity: number): string {
  const bars = Math.round(severity * 10);
  return "█".repeat(bars) + "░".repeat(10 - bars);
}
