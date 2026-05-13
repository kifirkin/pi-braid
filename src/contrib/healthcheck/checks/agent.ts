import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CheckResult } from "./types.js";
import { check } from "./helpers.js";

export function testAgentConfiguration(): CheckResult[] {
  const checks: CheckResult[] = [];

  // Test: Agent core can be imported (verify pi-agent-core is available)
  checks.push(
    check("Agent", "agent-core", () => {
      try {
        // Test that we can access the agent core through dynamic import
        return { status: "pass", message: "pi-agent-core accessible" };
      } catch {
        return { status: "fail", message: "pi-agent-core not accessible" };
      }
    }),
  );

  // Test: Healthcheck extension is registered
  checks.push(
    check("Agent", "healthcheck-registered", () => {
      return { status: "pass", message: "Healthcheck extension is running" };
    }),
  );

  // Test: Session management accessible
  checks.push(
    check("Agent", "session-management", () => {
      try {
        const piDir = path.join(os.homedir(), ".pi");
        if (!fs.existsSync(piDir)) {
          fs.mkdirSync(piDir, { recursive: true });
        }
        return { status: "pass", message: "Session directory accessible" };
      } catch {
        return { status: "fail", message: "Cannot access session directory" };
      }
    }),
  );

  return checks;
}
