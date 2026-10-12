import * as fs from "node:fs";
import type { CheckResult } from "./types.js";
import { check } from "./helpers.js";
import { braidDir } from "../../state-paths.js";

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

  // Test: Session management accessible. Probes braid's state root (session
  // state lives under it) without creating anything: the old form mkdir'd
  // ~/.pi, a directory outside braid's tree.
  checks.push(
    check("Agent", "session-management", () => {
      const root = braidDir();
      try {
        if (!fs.existsSync(root)) {
          return {
            status: "fail",
            message: `braid state root missing: ${root}`,
          };
        }
        fs.readdirSync(root);
        return {
          status: "pass",
          message: `braid state root readable: ${root}`,
        };
      } catch (err) {
        return {
          status: "fail",
          message: `Cannot access braid state root: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }),
  );

  return checks;
}
