import { execSync } from "node:child_process";
import type { CheckResult } from "./types.js";
import { check } from "./helpers.js";

export function testBashShell(): CheckResult[] {
  const checks: CheckResult[] = [];

  // Test: echo command
  checks.push(
    check("Shell", "echo", () => {
      const out = execSync("echo healthcheck", { encoding: "utf-8" }).trim();
      if (out !== "healthcheck") {
        return { status: "fail", message: `Echo returned: ${out}` };
      }
      return { status: "pass", message: "Echo OK" };
    }),
  );

  // Test: node runtime (informational - if we're running, node works)
  checks.push(
    check("Shell", "node", () => {
      return {
        status: "pass",
        message: `Node runtime active (v${process.version})`,
      };
    }),
  );

  // Test: git available
  checks.push(
    check("Shell", "git", () => {
      try {
        const out = execSync("git --version", { encoding: "utf-8" }).trim();
        return { status: "pass", message: out };
      } catch {
        return { status: "warn", message: "git not found (non-critical)" };
      }
    }),
  );

  // Test: npx/npm available
  checks.push(
    check("Shell", "npm", () => {
      try {
        const out = execSync("npm --version", { encoding: "utf-8" }).trim();
        return { status: "pass", message: `npm v${out}` };
      } catch {
        return { status: "warn", message: "npm not found" };
      }
    }),
  );

  // Test: grep command (system)
  checks.push(
    check("Shell", "system-grep", () => {
      try {
        execSync("grep --version", { encoding: "utf-8" });
        return { status: "pass", message: "grep available" };
      } catch {
        // BSD grep lacks --version.
        try {
          execSync("echo test | grep test", { encoding: "utf-8" });
          return { status: "pass", message: "grep available (BSD)" };
        } catch {
          return { status: "warn", message: "system grep not available" };
        }
      }
    }),
  );

  return checks;
}
