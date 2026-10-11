import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CheckResult } from "./types.js";
import { check } from "./helpers.js";

export function testMemoryAndState(): CheckResult[] {
  const checks: CheckResult[] = [];

  // Test: .pi directory exists
  checks.push(
    check("State", "pi-config-dir", () => {
      const piDir = path.join(os.homedir(), ".pi");
      if (!fs.existsSync(piDir)) {
        fs.mkdirSync(piDir, { recursive: true });
      }
      return { status: "pass", message: `~/.pi directory accessible` };
    }),
  );

  // Test: .pi/agent directory
  checks.push(
    check("State", "agent-dir", () => {
      const agentDir = path.join(os.homedir(), ".pi", "agent");
      if (!fs.existsSync(agentDir)) {
        fs.mkdirSync(agentDir, { recursive: true });
      }
      return { status: "pass", message: `~/.pi/agent directory accessible` };
    }),
  );

  // Test: Can write to .pi
  checks.push(
    check("State", "pi-writable", () => {
      const testFile = path.join(os.homedir(), ".pi", ".hc-test");
      fs.writeFileSync(testFile, Date.now().toString());
      fs.unlinkSync(testFile);
      return { status: "pass", message: "~/.pi writable" };
    }),
  );

  return checks;
}
