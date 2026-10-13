import * as fs from "node:fs";
import * as path from "node:path";
import { healthcheckDir } from "pi-braid/lib";
import type { CheckResult } from "./types.js";

export function ensureHcDir(): void {
  const dir = healthcheckDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function cleanupHcDir(): void {
  try {
    const dir = healthcheckDir();
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  } catch {
    // Best-effort temp cleanup: stale healthcheck files are retried on the
    // next run, so a failed unlink must never fail the caller.
  }
}

export function check(
  category: string,
  name: string,
  fn: () => {
    status: "pass" | "fail" | "warn" | "skip";
    message: string;
    details?: string;
  },
): CheckResult {
  const start = Date.now();
  try {
    const result = fn();
    return { category, name, ...result, durationMs: Date.now() - start };
  } catch (err) {
    return {
      category,
      name,
      status: "fail",
      message: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}
