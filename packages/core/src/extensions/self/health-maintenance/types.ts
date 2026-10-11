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
