import * as os from "node:os";
import { execSync } from "node:child_process";
import type { CheckResult } from "./types.js";
import { check } from "./helpers.js";

export function testSystemResources(): CheckResult[] {
  const checks: CheckResult[] = [];

  // Test: Free memory
  checks.push(
    check("Resources", "memory", () => {
      const freeMem = os.freemem();
      const totalMem = os.totalmem();
      const percentFree = (freeMem / totalMem) * 100;
      if (percentFree < 5) {
        return {
          status: "warn",
          message: `Low memory: ${percentFree.toFixed(1)}% free (${Math.round(freeMem / 1024 / 1024)}MB)`,
          details: `Total: ${Math.round(totalMem / 1024 / 1024)}MB`,
        };
      }
      return {
        status: "pass",
        message: `Memory OK: ${percentFree.toFixed(1)}% free (${Math.round(freeMem / 1024 / 1024)}MB / ${Math.round(totalMem / 1024 / 1024)}MB)`,
      };
    }),
  );

  // Test: CPU count
  checks.push(
    check("Resources", "cpu", () => {
      const cpus = os.cpus();
      if (cpus.length === 0) {
        return { status: "fail", message: "No CPU info available" };
      }
      return { status: "pass", message: `${cpus.length} cores: ${cpus[0].model}` };
    }),
  );

  // Test: Disk space (for temp dir)
  checks.push(
    check("Resources", "disk", () => {
      try {
        const platform = os.platform();
        let output: string;
        if (platform === "win32") {
          output = execSync("wmic logicaldisk get size,freespace,caption", { encoding: "utf-8" });
        } else {
          output = execSync("df -h /", { encoding: "utf-8" });
        }
        return {
          status: "pass",
          message: "Disk info retrieved",
          details: output.trim().split("\n").slice(0, 2).join(" | "),
        };
      } catch {
        return { status: "warn", message: "Could not check disk space" };
      }
    }),
  );

  return checks;
}
