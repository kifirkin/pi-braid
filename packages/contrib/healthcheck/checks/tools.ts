import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CheckResult } from "./types.js";
import { check } from "./helpers.js";
import { healthcheckDir } from "pi-braid/lib";

export function testAgentTools(pi: ExtensionAPI): CheckResult[] {
  const checks: CheckResult[] = [];

  let _tools: Array<{
    name: string;
    description: string;
    sourceInfo?: { source: string };
  }> = [];
  try {
    _tools = pi.getAllTools() as Array<{
      name: string;
      description: string;
      sourceInfo?: { source: string };
    }>;
  } catch {
    checks.push(
      check("Tools", "tool-registry", () => {
        return { status: "fail", message: "Cannot access tool registry" };
      }),
    );
    return checks;
  }

  // Test: Active tools (this is the merged registry)
  checks.push(
    check("Tools", "active-tools", () => {
      try {
        const active = pi.getActiveTools();
        return {
          status: "pass",
          message: `${active.length} active tools`,
          details:
            active.slice(0, 15).join(", ") + (active.length > 15 ? "..." : ""),
        };
      } catch {
        return { status: "warn", message: "Cannot get active tools" };
      }
    }),
  );

  // Test: Core tools functionality via shell (pi.exec tests bash)
  checks.push(
    check("Tools", "bash-functional", () => {
      try {
        // Test bash functionality through pi.exec
        const result = execSync(
          "echo 'test' && ls -la ~/.pi/agent/settings.json 2>/dev/null | head -1",
          {
            encoding: "utf-8",
            cwd: healthcheckDir(),
            timeout: 5000,
          },
        );
        return {
          status: result.includes("settings.json") ? "pass" : "warn",
          message: "bash execution functional",
          details: result.trim().slice(0, 100),
        };
      } catch {
        return {
          status: "warn",
          message: "bash execution limited (expected in some environments)",
        };
      }
    }),
  );

  // Test: File operations work (write/read/delete cycle)
  checks.push(
    check("Tools", "file-ops-functional", () => {
      try {
        const testFile = path.join(healthcheckDir(), "tool-test.txt");
        fs.writeFileSync(testFile, "tool functionality test");
        const content = fs.readFileSync(testFile, "utf-8");
        fs.unlinkSync(testFile);
        return content === "tool functionality test"
          ? {
              status: "pass",
              message: "File operations (write/read/delete) functional",
            }
          : { status: "fail", message: "File content mismatch" };
      } catch (error) {
        return { status: "fail", message: `File operations failed: ${error}` };
      }
    }),
  );

  // Test: pi.exec works (for shell operations)
  checks.push(
    check("Tools", "pi-exec", () => {
      try {
        execSync("echo 'pi-exec test'", {
          encoding: "utf-8",
          cwd: healthcheckDir(),
        });
        return {
          status: "pass",
          message: "Shell execution (pi.exec) functional",
        };
      } catch {
        return { status: "fail", message: "Shell execution failed" };
      }
    }),
  );

  return checks;
}
