import * as fs from "node:fs";
import * as path from "node:path";
import { HEALTHCHECK_DIR } from "../../../../lib/braid-paths.js";
import type { CheckResult } from "./types.js";

export const HC_DIR = HEALTHCHECK_DIR;

export function ensureHcDir(): void {
  if (!fs.existsSync(HC_DIR)) {
    fs.mkdirSync(HC_DIR, { recursive: true });
  }
}

export function cleanupHcDir(): void {
  try {
    if (fs.existsSync(HC_DIR)) {
      const files = fs.readdirSync(HC_DIR);
      for (const f of files) {
        fs.unlinkSync(path.join(HC_DIR, f));
      }
    }
  } catch {}
}

export function check(
  category: string,
  name: string,
  fn: () => { status: "pass" | "fail" | "warn" | "skip"; message: string; details?: string },
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
