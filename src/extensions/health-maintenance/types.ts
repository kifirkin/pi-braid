import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface HealthMaintenanceResult {
  action: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface BenchmarkResult {
  timestamp: number;
  passRate: number;
  totalCases: number;
  passedCases: number;
  failedCases: string[];
}

export type HealthMaintenanceActionType =
  | "status"
  | "health"
  | "check"
  | "commit"
  | "rollback"
  | "config"
  | "reset"
  | "benchmark";
