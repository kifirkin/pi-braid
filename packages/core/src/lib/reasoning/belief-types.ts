/**
 * Belief-policy engine types.
 *
 * Kept in their own module so policy-rules.ts and other sub-modules get
 * the type contracts without pulling in the full engine implementation.
 */

export type SignalSource =
  | "topic-drift"
  | "conflict"
  | "stability"
  | "reasoning"
  | "reflection"
  | "calibration"
  | "tool-use"
  | "sycophancy"
  | "memory";

export type SignalSeverity = "info" | "warn" | "critical" | "error";

export interface SystemSignal {
  id: string;
  source: SignalSource;
  type: string;
  severity: SignalSeverity;
  autoProceed: boolean; // if true, signal should force a turn (auto-finalize, auto-next-step)
  data: Record<string, unknown>;
  timestamp: number;
}

export interface Belief {
  key: string; // e.g., "topic:stable", "reasoning:declining"
  confidence: number; // 0-1
  evidence: string[]; // signal IDs that support this belief
  updatedAt: number;
}

export interface PolicyRecommendation {
  id: string;
  type: string;
  priority: number; // 1-10, higher = more important
  message: string; // Whisper message to agent
  beliefs: string[]; // Beliefs that triggered this
  timestamp: number;
}
