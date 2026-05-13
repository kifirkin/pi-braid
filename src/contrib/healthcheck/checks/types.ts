import type { AgentToolResult } from "@mariozechner/pi-coding-agent";

export interface CheckResult {
  category: string;
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  message: string;
  durationMs: number;
  details?: string;
}

export interface HealthReport {
  timestamp: string;
  overall: "healthy" | "degraded" | "unhealthy";
  checks: CheckResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    warned: number;
    skipped: number;
  };
}
